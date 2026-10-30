import { fieldsOf } from "./config.js";
import { DEFAULT_BM25, idf, weightedTerms } from "./text.js";
import { sha256Hex } from "./util.js";
export class ShardIndex {
    name;
    seq;
    docs;
    docLens;
    avgLen;
    docTerms;
    postings;
    constructor(name, seq, docs, docLens, avgLen, docTerms, postings) {
        this.name = name;
        this.seq = seq;
        this.docs = docs;
        this.docLens = docLens;
        this.avgLen = avgLen;
        this.docTerms = docTerms;
        this.postings = postings;
    }
    get byId() {
        return (this._byId ??= new Map(this.docs.map((d, i) => [d.id, i])));
    }
    _byId = null;
    /**
     * Adjacency maps built once per index: outgoing links (`id -> targets`) and
     * incoming links (`target -> sources`). Link diffusion on dense corpora used
     * to scan every doc per lookup (O(N^2) per query); these maps make each
     * neighbor lookup O(degree). Built lazily because most queries never touch
     * links; invalidated naturally by constructing a new ShardIndex.
     */
    adjacency() {
        if (this._adjacency)
            return this._adjacency;
        const out = new Map();
        const incoming = new Map();
        for (const doc of this.docs) {
            const targets = [...new Set(doc.links)];
            out.set(doc.id, targets);
            for (const target of targets) {
                const sources = incoming.get(target);
                if (sources)
                    sources.push(doc.id);
                else
                    incoming.set(target, [doc.id]);
            }
        }
        this._adjacency = { out, incoming };
        return this._adjacency;
    }
    _adjacency = null;
    /** Outgoing links from `id` (deduped, link order). */
    outLinks(id) {
        return this.adjacency().out.get(id) ?? [];
    }
    /** Incoming links to `id` (docs that link to it, doc order). */
    inLinks(id) {
        return this.adjacency().incoming.get(id) ?? [];
    }
    static build(name, records, seq, config, shard) {
        const fields = fieldsOf(config);
        const docs = [];
        const docLens = [];
        const docTerms = [];
        const postings = new Map();
        const ttl = config.retrieval?.ttlDays ?? {};
        records.forEach((record, idx) => {
            const { tf, len } = weightedTerms({
                title: record.title,
                description: record.description,
                tags: record.tags,
                entities: record.entities,
                body: record.content,
            }, fields);
            docs.push({
                id: record.id,
                shard: name,
                scope: record.scope,
                project: record.project,
                title: record.title,
                description: record.description,
                type: record.type,
                tags: record.tags,
                entities: record.entities,
                status: record.status,
                importance: record.importance,
                confidence: record.confidence,
                pinned: record.pinned,
                created: record.created,
                updated: record.updated,
                lastUsed: record.lastUsed ?? 0,
                usedCount: record.usedCount,
                validFrom: record.validFrom,
                validTo: record.validTo,
                links: record.links,
                sourceTrust: trustOf(record.source.harness),
                contentHash: sha256Hex(record.content).slice(0, 16),
                ttlDays: ttl[record.type] ?? 180,
            });
            docLens.push(len);
            docTerms.push([...tf.keys()]);
            for (const [term, value] of tf) {
                let posting = postings.get(term);
                if (!posting) {
                    posting = new Map();
                    postings.set(term, posting);
                }
                posting.set(idx, value);
            }
        });
        const avgLen = docs.length === 0 ? 0 : docLens.reduce((a, b) => a + b, 0) / docLens.length;
        return new ShardIndex(name, seq, docs, docLens, avgLen, docTerms, postings);
    }
    static fromJson(json) {
        const postings = new Map();
        for (const [term, list] of Object.entries(json.postings ?? {})) {
            const map = new Map();
            for (const [idx, w] of list)
                map.set(idx, w);
            postings.set(term, map);
        }
        return new ShardIndex(json.name, json.seq, json.docs, json.docLens, json.avgLen, json.docTerms ?? [], postings);
    }
    toJson(builtAt) {
        const postings = {};
        for (const [term, map] of this.postings) {
            const list = [];
            for (const [idx, w] of map)
                list.push([idx, w]);
            postings[term] = list;
        }
        return {
            version: 1,
            name: this.name,
            seq: this.seq,
            builtAt,
            docs: this.docs,
            docLens: this.docLens,
            avgLen: this.avgLen,
            docTerms: this.docTerms,
            postings,
        };
    }
    /** Number of documents containing a term. */
    df(term) {
        return this.postings.get(term)?.size ?? 0;
    }
    idfOf(term) {
        return idf(this.docs.length, this.df(term));
    }
    /** Raw BM25F score for one doc. */
    score(queryTerms, docIdx, params = DEFAULT_BM25) {
        let score = 0;
        const docLen = this.docLens[docIdx] ?? this.avgLen;
        const norm = params.k1 * (1 - params.b + (params.b * docLen) / (this.avgLen || 1));
        for (const term of queryTerms) {
            const wTf = this.postings.get(term)?.get(docIdx);
            if (!wTf)
                continue;
            score += this.idfOf(term) * ((wTf * (params.k1 + 1)) / (wTf + norm));
        }
        return score;
    }
    /** Ids linked from or to `id` (1-hop, both directions), O(degree). */
    linkNeighbors(id) {
        const out = this.outLinks(id);
        const incoming = this.inLinks(id);
        if (incoming.length === 0)
            return out;
        if (out.length === 0)
            return incoming;
        return [...new Set([...out, ...incoming])];
    }
    /** Docs that link to `id` (sorted for deterministic output). */
    backlinks(id) {
        return [...new Set(this.inLinks(id))].sort();
    }
}
/** Source trust by harness: user speech 1.0, tools 0.8, model inference 0.5. */
export function trustOf(harness) {
    switch (harness) {
        case "user":
            return 1.0;
        case "pi":
        case "dsh":
        case "claude-code":
            return 0.5;
        case "import":
            return 0.7;
        case "tool":
            return 0.8;
        default:
            return 0.5;
    }
}
export class IndexManager {
    store;
    config;
    cache = new Map();
    usage = null;
    constructor(store, config) {
        this.store = store;
        this.config = config;
    }
    setConfig(config) {
        this.config = config;
        this.cache.clear();
    }
    invalidate() {
        this.cache.clear();
    }
    /** Usage counters are merged into doc metadata before ranking (no index rebuild). */
    setUsage(usage) {
        this.usage = usage;
        for (const index of this.cache.values())
            this.applyUsage(index);
    }
    applyUsage(index) {
        if (!this.usage || this.usage.size === 0)
            return index;
        for (const doc of index.docs) {
            const usage = this.usage.get(doc.id);
            if (!usage)
                continue;
            if (usage.lastUsed > doc.lastUsed)
                doc.lastUsed = usage.lastUsed;
            if (usage.usedCount > doc.usedCount)
                doc.usedCount = usage.usedCount;
        }
        return index;
    }
    /** Cached accessor by shard name, with on-disk cache validation via per-shard seq. */
    async get(shard) {
        const current = await this.store.getShardSeq(shard.name);
        const cached = this.cache.get(shard.name);
        if (cached && cached.seq === current)
            return this.applyUsage(cached);
        const raw = (await this.store.loadIndex(shardKeyOf(shard)));
        if (raw && raw.version === 1 && raw.name === shard.name && raw.seq === current) {
            const index = ShardIndex.fromJson(raw);
            this.cache.set(shard.name, index);
            return this.applyUsage(index);
        }
        const { records } = await this.store.readShard(shard);
        const index = ShardIndex.build(shard.name, records, current, this.config, shard);
        this.cache.set(shard.name, index);
        await this.store.saveIndex(shardKeyOf(shard), index.toJson(Date.now()));
        return this.applyUsage(index);
    }
    /** Force rebuild of a shard (writes new index + manifest entry). */
    async rebuild(shard) {
        const { records } = await this.store.readShard(shard);
        const seq = await this.store.getShardSeq(shard.name);
        const index = ShardIndex.build(shard.name, records, seq, this.config, shard);
        this.cache.set(shard.name, index);
        await this.store.saveIndex(shardKeyOf(shard), index.toJson(Date.now()));
        await this.saveManifest();
        return index;
    }
    async rebuildAll() {
        const shards = await this.store.listShards();
        const out = [];
        for (const shard of shards)
            out.push(await this.rebuild(shard));
        await this.store.writeManifest(await this.store.getSeq(), out.map((i) => ({ name: i.name, docs: i.docs.length })));
        return out;
    }
    async saveManifest() {
        const shards = await this.store.listShards();
        await this.store.writeManifest(await this.store.getSeq(), shards.map((s) => ({ name: s.name, scope: s.scope })));
    }
    get size() {
        let n = 0;
        for (const index of this.cache.values())
            n += index.docs.length;
        return n;
    }
}
export function shardKeyOf(shard) {
    return shard.name;
}
//# sourceMappingURL=indexer.js.map