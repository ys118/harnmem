/**
 * Consolidation: mechanical dedupe, lifecycle transitions and capacity
 * enforcement; optional LLM digest writing. Never destructive: removals go to
 * `trash/` and every action is audited.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { contentSimilarity, mergeIntoRecord, recordSimhash, retentionDecision, trashDecision, valueScore, } from "./lifecycle.js";
import { resolvePrompt, DEFAULT_CONSOLIDATE_PROMPT, ensurePromptFiles } from "./extract.js";
import { fillPrompt } from "./assets.js";
import { hamming64, newMemoryId } from "./util.js";
import { governanceOf } from "./config.js";
export class Consolidator {
    store;
    index;
    config;
    constructor(store, index, config) {
        this.store = store;
        this.index = index;
        this.config = config;
    }
    now() {
        return (this.config.now ?? Date.now)();
    }
    async run(opts = {}) {
        const startedAt = this.now();
        const dryRun = Boolean(opts.dryRun);
        const report = {
            runId: newMemoryId(startedAt),
            startedAt,
            finishedAt: startedAt,
            merged: [],
            supersededChainsCompressed: 0,
            archived: [],
            digestsWritten: [],
            skipped: 0,
            llmCalls: 0,
            dryRun,
        };
        await ensurePromptFiles(this.store.home);
        const shards = await this.store.listShards();
        for (const shard of shards) {
            const { records } = await this.store.readShard(shard);
            for (const pair of this.findDuplicates(records)) {
                report.merged.push({ into: pair.keep.id, from: [pair.drop.id] });
                if (dryRun)
                    continue;
                const merged = mergeIntoRecord(pair.keep, pair.drop, this.now());
                merged.links = merged.links.filter((id) => id !== pair.drop.id);
                await this.store.writeRecord(shard, merged);
                await this.store.moveToTrash(shard, pair.drop, this.now());
                await this.store.audit({
                    ts: this.now(),
                    kind: "consolidate",
                    action: "merge",
                    merged: [pair.drop.id],
                    into: pair.keep.id,
                    reason: "near-dup",
                });
            }
            const refreshed = await this.store.readShard(shard);
            for (const record of refreshed.records.filter((r) => r.status === "active")) {
                if (retentionDecision(record, this.now()) !== "archive")
                    continue;
                report.archived.push(record.id);
                if (dryRun)
                    continue;
                await this.store.writeRecord(shard, { ...record, status: "archived", updated: this.now() });
                await this.store.audit({ ts: this.now(), kind: "archive", ids: [record.id], reason: "decayed" });
            }
            for (const record of refreshed.records.filter((r) => r.status === "archived")) {
                if (!trashDecision(record, this.now()))
                    continue;
                if (dryRun) {
                    report.skipped++;
                    continue;
                }
                await this.store.moveToTrash(shard, record, this.now());
                await this.store.audit({ ts: this.now(), kind: "trash", ids: [record.id], reason: "cold-archive" });
            }
            // Supersede chains: compress metadata only (history stays on disk).
            const all = (await this.store.readShard(shard)).records;
            for (const record of all) {
                if (record.supersededBy && record.status === "superseded" && record.validTo === null) {
                    report.supersededChainsCompressed++;
                    if (!dryRun)
                        await this.store.writeRecord(shard, { ...record, validTo: record.updated });
                }
            }
            // Capacity: archive lowest-value active records beyond the per-shard cap.
            const governance = governanceOf(this.config);
            const cap = shard.scope === "user" ? governance.maxUserRecords : governance.maxProjectRecords;
            const active = (await this.store.readShard(shard)).records.filter((r) => r.status === "active");
            if (active.length > cap) {
                const excess = active
                    .filter((r) => !r.pinned)
                    .sort((a, b) => valueScore(a, this.now()) - valueScore(b, this.now()) || a.updated - b.updated)
                    .slice(0, active.length - cap);
                for (const record of excess) {
                    report.archived.push(record.id);
                    if (dryRun)
                        continue;
                    await this.store.writeRecord(shard, { ...record, status: "archived", updated: this.now() });
                    await this.store.audit({ ts: this.now(), kind: "archive", ids: [record.id], reason: "capacity" });
                }
            }
            if (this.config.llm && !dryRun && !opts.mechanicalOnly) {
                const written = await this.writeDigests(shard, this.config.llm, opts.maxLlmCalls ?? 3, report);
                report.digestsWritten.push(...written);
            }
        }
        await this.index.rebuildAll();
        report.finishedAt = this.now();
        return report;
    }
    findDuplicates(records) {
        const active = records.filter((record) => record.status === "active" && !record.sensitive);
        const used = new Set();
        const pairs = [];
        for (let i = 0; i < active.length; i++) {
            const a = active[i];
            if (used.has(a.id))
                continue;
            for (let j = i + 1; j < active.length; j++) {
                const b = active[j];
                if (used.has(b.id))
                    continue;
                if (a.type !== b.type || a.scope !== b.scope)
                    continue;
                if (a.scope === "project" && a.project !== b.project)
                    continue;
                if (hamming64(recordSimhash(a), recordSimhash(b)) > 3)
                    continue;
                if (contentSimilarity(a, b) < 0.82)
                    continue;
                const keep = a.created <= b.created ? a : b;
                const drop = keep === a ? b : a;
                used.add(drop.id);
                pairs.push({ keep, drop });
                break;
            }
        }
        return pairs;
    }
    async writeDigests(shard, llm, maxCalls, report) {
        const { records } = await this.store.readShard(shard);
        const active = records.filter((record) => record.status === "active");
        if (active.length === 0)
            return [];
        const groups = new Map();
        for (const record of active) {
            const key = record.category ?? record.tags[0] ?? record.type;
            const list = groups.get(key) ?? [];
            list.push(record);
            groups.set(key, list);
        }
        const asset = resolvePrompt(this.store.home, "consolidate-digest", DEFAULT_CONSOLIDATE_PROMPT);
        const written = [];
        for (const [topic, group] of [...groups.entries()].slice(0, maxCalls)) {
            const memoriesBlock = group
                .slice(0, 12)
                .map((r) => [
                `### [${r.id}] (${r.type}) valid_from=${new Date(r.validFrom).toISOString().slice(0, 10)}`,
                `title: ${r.title}`,
                `description: ${r.description}`,
                `content:`,
                r.content.slice(0, 800),
            ].join("\n"))
                .join("\n\n");
            const legacyPrompt = [
                `Shard: ${shard.name}`,
                `Topic: ${topic}`,
                "",
                "Existing memory excerpts:",
                group
                    .slice(0, 12)
                    .map((r) => `### ${r.title}\n${r.content.slice(0, 1200)}`)
                    .join("\n\n"),
            ].join("\n");
            const prompt = asset.user
                ? fillPrompt(asset.user, { topic, memories: memoriesBlock })
                : legacyPrompt;
            const request = {
                system: asset.system,
                prompt,
                temperature: 0,
                maxTokens: 2000,
            };
            let parsed;
            try {
                const response = await llm(request);
                report.llmCalls++;
                const start = response.text.indexOf("{");
                const end = response.text.lastIndexOf("}");
                if (start < 0 || end <= start)
                    continue;
                parsed = JSON.parse(response.text.slice(start, end + 1));
            }
            catch {
                continue;
            }
            const digest = parsed.digest;
            if (!digest || !digest.content)
                continue;
            const slug = topic.replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/g, "-").slice(0, 60) || "digest";
            const file = join(this.store.digestDir(shard), `${slugifyFile(slug)}.md`);
            await fs.mkdir(this.store.digestDir(shard), { recursive: true });
            const body = [
                "---",
                "schema: 1",
                `title: ${JSON.stringify(digest.title ?? topic)}`,
                `updated: ${this.now()}`,
                `sources: ${JSON.stringify(digest.sources ?? [])}`,
                "---",
                "",
                `# ${digest.title ?? topic}`,
                "",
                digest.content,
                "",
            ].join("\n");
            await fs.writeFile(file, body, "utf8");
            written.push(file);
            await this.store.audit({
                ts: this.now(),
                kind: "digest",
                shard: shard.name,
                topic,
                sources: digest.sources ?? [],
            });
        }
        return written;
    }
}
function slugifyFile(input) {
    return input.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "digest";
}
//# sourceMappingURL=consolidate.js.map