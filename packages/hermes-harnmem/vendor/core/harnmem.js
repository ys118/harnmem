/**
 * HarnMem facade: the only entry point harness adapters should use.
 * See docs/design/07-adapter-contract.md.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { HARNMEM_API_VERSION } from "./types.js";
import { loadConfig } from "./config.js";
import { detectProject, findProject, registerProject } from "./project.js";
import { Store, sanitizeFilePart, shardKey } from "./store.js";
import { IndexManager } from "./indexer.js";
import { Retriever } from "./retrieval.js";
import { Consolidator } from "./consolidate.js";
import { decideDedupe, supersedeOld } from "./lifecycle.js";
import { buildDigest, runExtraction } from "./extract.js";
import { deployDefaultAssets, loadSynonymGroups } from "./assets.js";
import { dayKey, newMemoryId, parseTimestamp, readTextIfExists, resolveHome, withTimeout, } from "./util.js";
const DEFAULT_SYNONYMS = [
    ["部署", "上线", "发布"],
    ["记忆", "内存", "memory"],
    ["插件", "扩展", "extension", "plugin"],
    ["报错", "错误", "异常", "error"],
    ["配置", "设置", "config"],
    ["重构", "重写", "refactor"],
];
export class HarnMem {
    apiVersion = HARNMEM_API_VERSION;
    config;
    store;
    project;
    index;
    retriever;
    consolidator;
    synonyms = null;
    session;
    constructor(config, store, project) {
        this.config = config;
        this.store = store;
        this.project = project;
        this.index = new IndexManager(store, config);
        this.retriever = new Retriever({
            store,
            index: this.index,
            config,
            getProjectId: () => this.project?.id,
            loadSynonyms: () => this.loadSynonyms(),
        });
        this.consolidator = new Consolidator(store, this.index, config);
        this.session = {
            id: config.sessionId ?? newMemoryId(),
            startedAt: (config.now ?? Date.now)(),
            date: dayKey((config.now ?? Date.now)()),
            modelWrites: 0,
            contextDirty: true,
            pendingReason: null,
            snapshot: null,
            lastAuditSignature: null,
            extractFailures: 0,
            extractSkips: {},
            extracted: false,
        };
    }
    static async open(options) {
        if (!options || typeof options !== "object")
            throw new Error("HarnMem.open requires a config object");
        if (!options.harness)
            throw new Error("HarnMem.open requires config.harness");
        const home = resolveHome(options.home);
        const cwd = options.cwd ?? process.cwd();
        const project = options.project
            ? await resolveExplicitProject(home, options.project, cwd)
            : await detectProject(cwd);
        const config = await loadConfig(home, project.root, { ...options, home });
        config.project = project.id;
        const store = new Store(home);
        await store.init();
        // First run: copy shipped prompts/ and data/ into the home so they are editable.
        deployDefaultAssets(home);
        try {
            await registerProject(home, project, config.harness, (config.now ?? Date.now)());
        }
        catch {
            // registry is advisory; never block opening
        }
        const harnmem = new HarnMem(config, store, project);
        // Usage counters are an overlay file, not part of the memory records.
        harnmem.setUsage(await store.loadUsage());
        return harnmem;
    }
    setUsage(usage) {
        this.index.setUsage(usage);
    }
    now() {
        return (this.config.now ?? Date.now)();
    }
    info() {
        return {
            apiVersion: this.apiVersion,
            home: this.config.home,
            project: this.project.id,
            harness: this.config.harness,
            sessionId: this.session.id,
        };
    }
    // ------------------------------------------------------------------ session
    async sessionStart(input = {}) {
        if (input.sessionId)
            this.session.id = input.sessionId;
        this.config.sessionId = this.session.id;
        if (input.date)
            this.session.date = input.date;
        this.session.startedAt = this.now();
        this.session.contextDirty = true;
        this.session.pendingReason = input.reason ?? 'session_start';
        const block = await this.ensureContext(input.reason ?? "session_start");
        await this.auditInjection(block);
        return block;
    }
    /** Cached, byte-stable context; rebuild only when dirty or the day changed. */
    async ensureContext(reason) {
        const today = dayKey(this.now());
        const dirty = this.session.contextDirty || !this.session.snapshot || this.session.date !== today;
        if (!dirty && this.session.snapshot)
            return this.session.snapshot;
        const effective = reason ?? this.session.pendingReason ?? "session_start";
        const block = await this.retriever.buildContext(effective);
        this.session.snapshot = block;
        this.session.contextDirty = false;
        this.session.pendingReason = null;
        this.session.date = today;
        if (effective === "memory_write" || effective === "manual" || effective === "day_rollover" || effective === "compaction") {
            await this.auditInjection(block);
        }
        return block;
    }
    /** Adapter calls this after the model itself wrote a memory this turn. */
    noteModelWrite() {
        this.session.modelWrites++;
        this.session.contextDirty = true;
        this.session.pendingReason = "memory_write";
    }
    invalidateContext() {
        this.session.contextDirty = true;
    }
    async auditInjection(block) {
        const signature = `${block.ids.join(",")}|${block.text.length}`;
        if (signature === this.session.lastAuditSignature)
            return;
        this.session.lastAuditSignature = signature;
        try {
            await this.store.audit({
                ts: this.now(),
                kind: "inject",
                harness: this.config.harness,
                session: this.session.id,
                ids: block.ids,
                bytes: Buffer.byteLength(block.text, "utf8"),
                tokens: block.tokensEstimate,
                reason: block.reason,
            });
        }
        catch {
            // audit is best effort
        }
    }
    // -------------------------------------------------------------------- write
    async write(input) {
        if (this.config.readOnly)
            throw new Error("HarnMem is read-only");
        const warnings = [];
        const now = this.now();
        const title = (input.title ?? "").trim();
        const description = (input.description ?? "").trim();
        let content = (input.content ?? "").trim();
        if (!title)
            throw new Error("memory_write requires a title");
        if (!description)
            throw new Error("memory_write requires a description");
        if (!content)
            throw new Error("memory_write requires content");
        const maxBody = this.config.governance?.maxBodyBytes ?? 65536;
        const bodyBytes = Buffer.from(content, "utf8");
        if (bodyBytes.byteLength > maxBody) {
            // Cut on a UTF-8 boundary: slicing by UTF-16 code units can keep ~3x
            // the byte budget for CJK text and can split a surrogate pair.
            let cut = bodyBytes.subarray(0, maxBody).toString("utf8");
            if (cut.endsWith("\uFFFD"))
                cut = cut.slice(0, -1);
            content = `${cut}…`;
            warnings.push(`content truncated to ${maxBody} bytes`);
        }
        const scope = resolveScope(input, this.project.id);
        const projectId = scope === "project" ? (input.project ? await this.resolveProjectId(input.project) : this.project.id) : undefined;
        const shard = this.shardFor(scope, projectId);
        const sensitive = input.sensitive ?? looksSensitive(`${title}\n${description}\n${content}`);
        const normalized = {
            ...input,
            scope,
            project: projectId,
            title,
            description,
            content,
            tags: uniqueStrings(input.tags ?? []),
            entities: uniqueStrings(input.entities ?? []),
            sensitive,
        };
        const { records } = await this.store.readShard(shard);
        const decision = decideDedupe(normalized, records, now);
        const links = uniqueStrings([...(input.links ?? []), ...decision.links]).filter((id) => id !== undefined);
        const existingIds = new Set(records.map((record) => record.id));
        const validLinks = links.filter((id) => existingIds.has(id));
        const superseded = [];
        const source = {
            harness: input.source?.harness ?? this.config.harness,
            session: input.source?.session ?? this.session.id,
            turn: input.source?.turn,
            ts: input.source?.ts ?? now,
        };
        if (decision.action === "skip" && decision.target) {
            await this.store.audit({ ts: now, kind: "write", action: "SKIP", id: decision.target.id, duplicateOf: decision.target.id });
            return { id: decision.target.id, action: "SKIP", superseded: [], warnings, record: decision.target };
        }
        if (decision.action === "merge" && decision.target && decision.merged) {
            await this.store.writeRecord(shard, decision.merged);
            await this.store.audit({ ts: now, kind: "write", action: "MERGE", id: decision.target.id, reason: decision.reason });
            this.session.contextDirty = true;
            this.session.pendingReason = 'memory_write';
            this.index.invalidate();
            return { id: decision.target.id, action: "MERGE", superseded: [], warnings, record: decision.merged };
        }
        const id = newMemoryId(now);
        let record = {
            schema: 1,
            id,
            type: input.type ?? "project",
            category: input.category,
            scope,
            project: projectId,
            projectName: scope === "project" ? this.project.name : undefined,
            title: title.slice(0, 200),
            description: description.slice(0, 400),
            content,
            tags: normalized.tags ?? [],
            entities: normalized.entities ?? [],
            importance: clampNumber(input.importance ?? defaultImportance(input.type), 0, 10),
            confidence: clampNumber(input.confidence ?? defaultConfidence(input.type), 0, 1),
            pinned: input.pinned ?? isConstraintType(input.type),
            status: "active",
            created: now,
            updated: now,
            lastUsed: undefined,
            usedCount: 0,
            validFrom: now,
            validTo: null,
            observedAt: parseObservedAt(content) ?? now,
            evidence: Math.max(1, (input.evidence ?? []).length),
            source,
            provenance: [`${this.config.harness}:${this.session.id}`],
            links: validLinks,
            supersedes: uniqueStrings(input.supersedes ?? []),
            supersededBy: null,
            sensitive,
        };
        if (decision.action === "supersede" && decision.target) {
            const old = supersedeOld(decision.target, id, now);
            await this.store.writeRecord(shard, old);
            record = { ...record, supersedes: uniqueStrings([...record.supersedes, old.id]), links: validLinks.filter((l) => l !== old.id) };
            superseded.push(old.id);
        }
        // Explicit `supersedes` from a caller/extraction: only existing ids count,
        // and every still-active target is moved through the bi-temporal supersede
        // path (never deleted). This preserves the old version for history queries.
        const requestedSupersedes = record.supersedes.filter((targetId) => targetId !== id);
        const acceptedSupersedes = [];
        for (const targetId of requestedSupersedes) {
            if (superseded.includes(targetId)) {
                acceptedSupersedes.push(targetId);
                continue;
            }
            const found = await this.store.findRecord(targetId);
            if (!found)
                continue;
            acceptedSupersedes.push(targetId);
            if (found.record.status === "active") {
                await this.store.writeRecord(found.shard, supersedeOld(found.record, id, now));
                superseded.push(targetId);
            }
        }
        record = { ...record, supersedes: uniqueStrings([...record.supersedes.filter((s) => acceptedSupersedes.includes(s)), ...acceptedSupersedes]) };
        await this.store.writeRecord(shard, record);
        await this.store.audit({
            ts: now,
            kind: "write",
            harness: this.config.harness,
            session: this.session.id,
            action: decision.action === "link" ? "LINK" : decision.action === "supersede" ? "SUPERSEDE" : "NEW",
            id: record.id,
            superseded,
            links: validLinks,
        });
        this.session.contextDirty = true;
        this.session.pendingReason = 'memory_write';
        this.index.invalidate();
        return {
            id: record.id,
            action: decision.action === "link" ? "LINK" : decision.action === "supersede" ? "SUPERSEDE" : "NEW",
            superseded,
            warnings,
            record,
        };
    }
    // ------------------------------------------------------------------ import
    async importRecords(records, opts = {}) {
        const result = { ids: [], skipped: 0, superseded: [], warnings: [] };
        if (this.config.readOnly)
            throw new Error("HarnMem is read-only");
        const now = this.now();
        const byShard = new Map();
        for (const input of records) {
            if (!input || !input.title) {
                result.skipped++;
                result.warnings.push("record missing title");
                continue;
            }
            const scope = input.scope ?? (input.type === "user" ? "user" : "project");
            const projectId = scope === "project" ? (input.project ?? this.project.id) : undefined;
            const shard = this.shardFor(scope, projectId);
            const created = parseTimestamp(input.created, now);
            const record = {
                schema: 1,
                id: input.id ?? newMemoryId(created),
                type: input.type ?? "project",
                category: input.category,
                scope,
                project: projectId,
                projectName: input.projectName ?? (scope === "project" ? this.project.name : undefined),
                title: input.title,
                description: input.description ?? "",
                content: input.content ?? "",
                tags: uniqueStrings(input.tags ?? []),
                entities: uniqueStrings(input.entities ?? []),
                importance: clampNumber(input.importance ?? defaultImportance(input.type), 0, 10),
                confidence: clampNumber(input.confidence ?? 0.8, 0, 1),
                pinned: input.pinned ?? false,
                status: input.status ?? "active",
                created,
                updated: parseTimestamp(input.updated, created),
                lastUsed: input.lastUsed,
                usedCount: input.usedCount ?? 0,
                validFrom: parseTimestamp(input.validFrom, created),
                validTo: input.validTo === undefined || input.validTo === null ? null : input.validTo,
                observedAt: input.observedAt ?? created,
                evidence: input.evidence ?? 1,
                source: {
                    harness: input.source?.harness ?? "import",
                    session: input.source?.session,
                    turn: input.source?.turn,
                    ts: parseTimestamp(input.source?.ts, now),
                    migratedFrom: input.source?.migratedFrom,
                },
                provenance: input.provenance ?? [`import:${this.config.harness}`],
                links: uniqueStrings(input.links ?? []),
                supersedes: uniqueStrings(input.supersedes ?? []),
                supersededBy: input.supersededBy ?? null,
                sensitive: input.sensitive,
                extra: input.extra,
            };
            const entry = byShard.get(shardKey(shard)) ?? { shard, records: [] };
            entry.records.push(record);
            byShard.set(shardKey(shard), entry);
            result.ids.push(record.id);
            if (record.status === "superseded" || record.supersededBy)
                result.superseded.push(record.id);
        }
        if (opts.dedupe) {
            // Dedupe mode: replay through write() one by one (slow; opt-in only).
            result.ids = [];
            result.superseded = [];
            for (const entry of byShard.values()) {
                for (const record of entry.records) {
                    const written = await this.write({
                        type: record.type,
                        category: record.category,
                        scope: record.scope,
                        project: record.project,
                        title: record.title,
                        description: record.description,
                        content: record.content,
                        tags: record.tags,
                        entities: record.entities,
                        importance: record.importance,
                        confidence: record.confidence,
                        pinned: record.pinned,
                        sensitive: record.sensitive,
                        source: record.source,
                    });
                    result.ids.push(written.id);
                    result.superseded.push(...written.superseded);
                }
            }
            return result;
        }
        if (!opts.dryRun) {
            for (const entry of byShard.values())
                await this.store.writeRecordsBulk(entry.shard, entry.records);
            // Lazy: per-shard indexes are rebuilt on first query via seq validation.
            this.index.invalidate();
            this.session.contextDirty = true;
            this.session.pendingReason = "memory_write";
            await this.store.audit({ ts: now, kind: "import", count: result.ids.length, shards: [...byShard.keys()] });
        }
        return result;
    }
    // ------------------------------------------------------------------ forget
    async forget(id, opts = {}) {
        const found = await this.store.findRecord(id);
        if (!found)
            return { id, ok: false, mode: opts.hard ? "hard" : "trash" };
        if (opts.hard) {
            await fs.unlink(this.store.recordPath(found.shard, id));
            await this.store.bumpSeq();
            await this.store.audit({ ts: this.now(), kind: "forget", id, mode: "hard" });
        }
        else {
            await this.store.moveToTrash(found.shard, found.record, this.now());
            await this.store.audit({ ts: this.now(), kind: "forget", id, mode: "trash" });
        }
        this.session.contextDirty = true;
        this.session.pendingReason = 'manual';
        this.index.invalidate();
        return { id, ok: true, mode: opts.hard ? "hard" : "trash" };
    }
    async restore(id) {
        let files = [];
        try {
            files = await fs.readdir(this.store.trashDir);
        }
        catch {
            return { id, ok: false };
        }
        const match = files.find((file) => file.endsWith(`-${id}.md`));
        if (!match)
            return { id, ok: false };
        const trashFile = join(this.store.trashDir, match);
        const raw = await readTextIfExists(trashFile);
        if (!raw)
            return { id, ok: false };
        const { parseFrontmatter, recordFromFrontmatter } = await import("./frontmatter.js");
        const parsed = parseFrontmatter(raw);
        const record = recordFromFrontmatter(parsed.data, parsed.body, id, this.now());
        record.status = "active";
        record.updated = this.now();
        const shard = this.shardFor(record.scope, record.project ?? undefined);
        await this.store.writeRecord(shard, record);
        await fs.unlink(trashFile);
        await this.store.audit({ ts: this.now(), kind: "restore", id });
        this.session.contextDirty = true;
        this.session.pendingReason = 'manual';
        this.index.invalidate();
        return { id, ok: true };
    }
    // ---------------------------------------------------------------- read side
    async search(opts) {
        const result = await this.retriever.search(opts);
        await this.autoFlushUsage();
        return result;
    }
    async read(id, opts = {}) {
        return this.retriever.read(id, opts);
    }
    async consolidate(opts = {}) {
        const report = await this.consolidator.run(opts);
        this.session.contextDirty = true;
        this.session.pendingReason = 'manual';
        return report;
    }
    async rebuildIndex() {
        await this.index.rebuildAll();
    }
    async stats() {
        const shards = await this.store.listShards();
        const shardStats = [];
        let totalBytes = 0;
        let duplicateCandidates = 0;
        let orphanTotal = 0;
        let userActive = 0;
        let projectActive = 0;
        let indexStale = false;
        for (const shard of shards) {
            const { records } = await this.store.readShard(shard);
            let bytes = 0;
            for (const record of records)
                bytes += Buffer.byteLength(record.content, "utf8");
            totalBytes += bytes;
            const ids = new Set(records.map((r) => r.id));
            let orphans = 0;
            for (const record of records)
                for (const link of record.links)
                    if (!ids.has(link))
                        orphans++;
            orphanTotal += orphans;
            const active = records.filter((r) => r.status === "active").length;
            if (shard.scope === "user")
                userActive += active;
            else
                projectActive += active;
            const shardSeq = await this.store.getShardSeq(shard.name);
            const stored = (await this.store.loadIndex(shard.name));
            if (!stored || stored.seq !== shardSeq)
                indexStale = true;
            duplicateCandidates += countDuplicateCandidates(records);
            shardStats.push({
                name: shard.name,
                scope: shard.scope,
                total: records.length,
                active,
                superseded: records.filter((r) => r.status === "superseded").length,
                archived: records.filter((r) => r.status === "archived").length,
                pinned: records.filter((r) => r.pinned).length,
                bytes,
            });
        }
        const seq = await this.store.peekSeq();
        const manifest = await this.store.readManifest();
        let indexBuiltAt = 0;
        try {
            for (const file of await fs.readdir(this.store.indexPath)) {
                if (!file.endsWith(".json") || file === "manifest.json")
                    continue;
                const stat = await fs.stat(join(this.store.indexPath, file));
                if (stat.mtimeMs > indexBuiltAt)
                    indexBuiltAt = stat.mtimeMs;
            }
        }
        catch {
            indexBuiltAt = 0;
        }
        const governance = this.config.governance;
        const overBudget = userActive > (governance?.maxUserRecords ?? 500) ||
            projectActive > (governance?.maxProjectRecords ?? 3000);
        let indexSize = 0;
        try {
            for (const file of await fs.readdir(this.store.indexPath)) {
                const stat = await fs.stat(join(this.store.indexPath, file));
                indexSize += stat.size;
            }
        }
        catch {
            indexSize = 0;
        }
        const lastConsolidate = await this.lastAuditTs("consolidate");
        return {
            version: 1,
            home: this.store.home,
            project: this.project.id,
            shards: shardStats,
            index: {
                seq,
                builtAt: indexBuiltAt || (manifest?.builtAt ?? 0),
                stale: indexStale,
                sizeBytes: indexSize,
                overhead: totalBytes === 0 ? 0 : indexSize / totalBytes,
            },
            health: {
                overBudget,
                duplicateCandidates,
                orphans: orphanTotal,
                lastConsolidate,
            },
            extraction: {
                pending: 0,
                failed: this.session.extractFailures,
                skipReasons: { ...this.session.extractSkips },
            },
        };
    }
    async lastAuditTs(kind) {
        const file = join(this.store.stateDir, "audit.jsonl");
        const raw = await readTextIfExists(file);
        if (!raw)
            return null;
        let last = null;
        for (const line of raw.split(/\r?\n/)) {
            if (!line.includes(`"kind":"${kind}"`))
                continue;
            try {
                const parsed = JSON.parse(line);
                if (typeof parsed.ts === "number")
                    last = parsed.ts;
            }
            catch {
                // ignore malformed lines
            }
        }
        return last;
    }
    /**
     * How many messages the newest completed (`status: "done"`) extraction for
     * this session already covered; `null` when none ever completed.
     *
     * This is the durable counterpart of the in-memory `extracted` flag: a
     * restarted process (or a resume catch-up) must not call the model again for
     * a journal prefix that was already extracted, but must still process turns
     * that happened after the last extraction.
     */
    async extractedMessageCount(sessionId) {
        const file = join(this.store.stateDir, "audit.jsonl");
        const raw = await readTextIfExists(file);
        if (!raw)
            return null;
        let covered = null;
        for (const line of raw.split(/\r?\n/)) {
            if (!line)
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.kind !== "extract" || parsed.session !== sessionId)
                    continue;
                if (parsed.status !== "done" || typeof parsed.messages !== "number")
                    continue;
                covered = covered === null ? parsed.messages : Math.max(covered, parsed.messages);
            }
            catch {
                // ignore malformed lines
            }
        }
        return covered;
    }
    /**
     * Persisted session journal for one session id, oldest first (bounded to the
     * last 200 messages). Adapters use it to rehydrate a process-local transcript
     * after a restart: DSH resumes a session in a new process without replaying
     * earlier events, so the digest would otherwise never reach the extraction
     * gates (N2 quit path).
     */
    async readSessionJournal(sessionId = this.session.id) {
        return this.store.readSessionTranscript(this.config.harness, sessionId);
    }
    // ------------------------------------------------------------------ extract
    /**
     * Public extraction entry point. Every attempt — including every skip — is
     * persisted to `state/audit.jsonl` as `kind: "extract"` (ROADMAP N13), so a
     * silent no-op is impossible to miss when debugging an adapter.
     */
    async sessionEnd(input) {
        let result;
        try {
            result = await this.sessionEndRecorded(input);
        }
        catch (error) {
            this.session.extractFailures++;
            result = { status: "failed", added: [], superseded: [], skipped: 0, error: error.message };
        }
        await this.auditExtract(input, result);
        return result;
    }
    async sessionEndRecorded(input) {
        try {
            const messages = (input.messages ?? []).filter((message) => message.text && message.text.trim());
            if (messages.length > 0) {
                await this.store.appendSession({
                    harness: this.config.harness,
                    sessionId: input.sessionId ?? this.session.id,
                    cwd: input.cwd ?? this.config.cwd,
                    messages: messages.slice(-200),
                });
            }
            await this.autoFlushUsage();
            const write = this.config.write;
            if (this.config.readOnly)
                return skip("read_only");
            if (!write?.autoExtract)
                return skip("auto_extract_off");
            if (input.skipExtract)
                return skip("requested");
            // Cross-process idempotency: the audit trail is the durable record of
            // what was already extracted, and it stays authoritative even inside
            // one process — a long-lived caller may run sessionEnd repeatedly as
            // the session grows (checkpoint/compaction), and the newer turns must
            // still be extracted (N2 resume catch-up). The in-memory flag is only
            // a fallback for when the audit has no entry for this session.
            const sessionId = input.sessionId ?? this.session.id;
            const completedThrough = await this.extractedMessageCount(sessionId);
            if (completedThrough !== null) {
                if (messages.length <= completedThrough)
                    return skip("already_extracted");
            }
            else if (this.session.extracted) {
                return skip("already_extracted");
            }
            if (!this.config.llm)
                return { status: "no_llm", added: [], superseded: [], skipped: 0 };
            if (this.session.modelWrites >= (write.skipExtractIfModelWrote ?? 1))
                return skip("model_wrote");
            const realUserMessages = messages.filter((message) => message.role === "user" && message.text.trim().length > 0);
            if (realUserMessages.length < (write.minUserMessages ?? 3))
                return skip("too_few_messages");
            // A digest below the extraction floor is a normal no-op, not a silent
            // `done/added:0`: name the reason so the audit line is self-explanatory.
            if (buildDigest(messages).length < (write.minDigestChars ?? 500))
                return skip("digest_too_small");
            const existing = await this.existingRefs();
            const extracted = await withTimeout(runExtraction(this.config.llm, this.config, {
                messages,
                existing,
                projectName: this.project.name,
                date: this.session.date,
            }), write.llmTimeoutMs ?? 12000, "extraction");
            const added = [];
            const superseded = [];
            let skipped = 0;
            for (const memory of extracted) {
                if ((memory.confidence ?? 0.7) < (write.minConfidence ?? 0)) {
                    skipped++;
                    continue;
                }
                const scope = memory.scope === "user" || memory.type === "user" || memory.type === "feedback" ? (memory.scope ?? (memory.type === "user" ? "user" : "project")) : "project";
                try {
                    const result = await this.write({
                        type: memory.type,
                        scope,
                        title: memory.title,
                        description: memory.description,
                        content: memory.content,
                        category: memory.category,
                        tags: memory.tags,
                        entities: memory.entities,
                        importance: memory.importance,
                        confidence: memory.confidence,
                        links: memory.links,
                        supersedes: memory.supersedes,
                        evidence: memory.evidence,
                        source: { harness: this.config.harness, session: input.sessionId ?? this.session.id, ts: this.now() },
                    });
                    if (result.action === "SKIP")
                        skipped++;
                    else
                        added.push(result.id);
                    superseded.push(...result.superseded);
                }
                catch {
                    skipped++;
                }
            }
            this.session.extracted = true;
            this.session.contextDirty = true;
            this.session.pendingReason = 'memory_write';
            const status = "done";
            return { status, added, superseded, skipped };
        }
        catch (error) {
            this.session.extractFailures++;
            return {
                status: "failed",
                added: [],
                superseded: [],
                skipped: 0,
                error: error.message,
            };
        }
        function skip(reason) {
            return { status: "skipped", added: [], superseded: [], skipped: 0, skipReason: reason };
        }
    }
    /**
     * Persist one `extract` audit line per session-end attempt. Audit writes are
     * advisory: a failure here must never surface as an extraction failure.
     */
    async auditExtract(input, result) {
        const messages = (input.messages ?? []).filter((message) => message.text && message.text.trim());
        try {
            await this.store.audit({
                ts: this.now(),
                kind: "extract",
                harness: this.config.harness,
                session: input.sessionId ?? this.session.id,
                status: result.status,
                ...(result.skipReason ? { reason: result.skipReason } : {}),
                ...(result.error ? { error: result.error } : {}),
                added: result.added.length,
                superseded: result.superseded.length,
                skipped: result.skipped,
                messages: messages.length,
                userMessages: messages.filter((message) => message.role === "user").length,
            });
        }
        catch {
            // audit is advisory
        }
    }
    async existingRefs() {
        const shard = this.shardFor("project", this.project.id);
        const { records } = await this.store.readShard(shard);
        return records
            .filter((record) => record.status === "active")
            .slice(0, 60)
            .map((record) => ({ id: record.id, title: record.title, type: record.type, description: record.description }));
    }
    // ------------------------------------------------------------------- close
    async close() {
        await this.autoFlushUsage();
        await this.retriever.pendingUsageUpdates().clear();
    }
    async autoFlushUsage() {
        const updates = this.retriever.pendingUsageUpdates();
        if (updates.size === 0)
            return;
        try {
            await this.store.saveUsage(updates);
        }
        catch {
            // usage counters are advisory
        }
        finally {
            this.retriever.resetUsage();
        }
    }
    // ------------------------------------------------------------------ helpers
    shardFor(scope, projectId) {
        return scope === "user" ? { scope: "user", name: "user" } : { scope: "project", project: projectId ?? this.project.id, name: projectId ?? this.project.id };
    }
    async resolveProjectId(query) {
        if (query === this.project.id)
            return query;
        const known = await findProject(this.store.home, query);
        return known?.id ?? query;
    }
    loadSynonyms() {
        if (this.synonyms)
            return this.synonyms;
        const map = new Map();
        const addGroup = (group) => {
            const cleaned = uniqueStrings(group);
            if (cleaned.length < 2)
                return;
            for (const item of cleaned) {
                const key = item.toLowerCase();
                const list = map.get(key) ?? [];
                for (const other of cleaned)
                    if (other.toLowerCase() !== key)
                        list.push(other);
                map.set(key, uniqueStrings(list));
            }
        };
        for (const group of DEFAULT_SYNONYMS)
            addGroup(group);
        try {
            // Every data/synonyms.<lang>.txt discovered: the <home> copy of a filename
            // overrides the shipped default of the same name, and all languages merge.
            for (const group of loadSynonymGroups(this.store.home).groups)
                addGroup(group);
        }
        catch {
            // optional data files
        }
        this.synonyms = map;
        return map;
    }
}
function resolveScope(input, currentProject) {
    void currentProject;
    if (input.scope === "user" || input.scope === "project")
        return input.scope;
    return input.type === "user" ? "user" : "project";
}
const SENSITIVE_PATTERNS = [
    /(api[_-]?key|secret|password|passwd|token|credential)\s*[:=]\s*\S{8,}/i,
    /(身份证|护照|银行卡|信用卡)\D{0,6}\d{6,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
function looksSensitive(text) {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}
async function resolveExplicitProject(home, query, cwd) {
    const known = await findProject(home, query);
    if (known) {
        return { id: known.id, slug: known.slug, name: known.name, key: `explicit:${known.id}`, root: known.paths[0] ?? cwd };
    }
    // Unknown query: derive a path-safe identity so a hostile project string
    // cannot escape <home> through shard directory names. The human-readable
    // name keeps the original query; id/slug/key must be file-safe.
    const safe = sanitizeFilePart(query);
    return { id: safe, slug: safe, name: query, key: `explicit:${safe}`, root: cwd };
}
function defaultImportance(type) {
    switch (type) {
        case "user":
            return 8;
        case "feedback":
            return 7;
        case "reference":
            return 5;
        default:
            return 6;
    }
}
function defaultConfidence(type) {
    return type === "user" ? 0.9 : 0.75;
}
function isConstraintType(type) {
    return type === "user";
}
function clampNumber(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
function uniqueStrings(values) {
    return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
function parseObservedAt(content) {
    const match = /(?:Observed|观察日期|日期)[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(content);
    if (!match)
        return null;
    const ts = Date.parse(`${match[1]}T12:00:00Z`);
    return Number.isFinite(ts) ? ts : null;
}
function countDuplicateCandidates(records) {
    let count = 0;
    const active = records.filter((record) => record.status === "active");
    for (let i = 0; i < active.length && i < 200; i++) {
        for (let j = i + 1; j < active.length && j < i + 20; j++) {
            const a = active[i];
            const b = active[j];
            if (!a.description || !b.description)
                continue;
            if (a.title === b.title || a.description === b.description)
                count++;
        }
    }
    return count;
}
//# sourceMappingURL=harnmem.js.map