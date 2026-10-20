/**
 * In-memory BM25F index over the markdown shards, persisted as rebuildable
 * JSON. The index is a cache: memory files are the SSOT and `doctor --rebuild`
 * can always regenerate it.
 */
import type { HarnMemConfig, MemoryRecord } from "./types.js";
import { fieldsOf } from "./config.js";
import { DEFAULT_BM25, idf, weightedTerms, type Bm25Params, type FieldConfig } from "./text.js";
import type { ShardRef, Store } from "./store.js";
import { sha256Hex } from "./util.js";

export interface DocMeta {
  id: string;
  shard: string;
  scope: string;
  project?: string;
  title: string;
  description: string;
  type: string;
  tags: string[];
  entities: string[];
  status: string;
  importance: number;
  confidence: number;
  pinned: boolean;
  created: number;
  updated: number;
  lastUsed: number;
  usedCount: number;
  validFrom: number;
  validTo: number | null;
  links: string[];
  sourceTrust: number;
  contentHash: string;
  ttlDays: number;
}

export interface ShardIndexJson {
  version: 1;
  name: string;
  seq: number;
  builtAt: number;
  docs: DocMeta[];
  docLens: number[];
  avgLen: number;
  docTerms: string[][];
  postings: Record<string, [number, number][]>;
}

export class ShardIndex {
  constructor(
    readonly name: string,
    readonly seq: number,
    readonly docs: DocMeta[],
    readonly docLens: number[],
    readonly avgLen: number,
    readonly docTerms: string[][],
    readonly postings: Map<string, Map<number, number>>,
  ) {}

  get byId(): Map<string, number> {
    return (this._byId ??= new Map(this.docs.map((d, i) => [d.id, i])));
  }
  private _byId: Map<string, number> | null = null;

  /**
   * Adjacency maps built once per index: outgoing links (`id -> targets`) and
   * incoming links (`target -> sources`). Link diffusion on dense corpora used
   * to scan every doc per lookup (O(N^2) per query); these maps make each
   * neighbor lookup O(degree). Built lazily because most queries never touch
   * links; invalidated naturally by constructing a new ShardIndex.
   */
  private adjacency(): { out: Map<string, string[]>; incoming: Map<string, string[]> } {
    if (this._adjacency) return this._adjacency;
    const out = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const doc of this.docs) {
      const targets = [...new Set(doc.links)];
      out.set(doc.id, targets);
      for (const target of targets) {
        const sources = incoming.get(target);
        if (sources) sources.push(doc.id);
        else incoming.set(target, [doc.id]);
      }
    }
    this._adjacency = { out, incoming };
    return this._adjacency;
  }
  private _adjacency: { out: Map<string, string[]>; incoming: Map<string, string[]> } | null = null;

  /** Outgoing links from `id` (deduped, link order). */
  outLinks(id: string): string[] {
    return this.adjacency().out.get(id) ?? [];
  }

  /** Incoming links to `id` (docs that link to it, doc order). */
  inLinks(id: string): string[] {
    return this.adjacency().incoming.get(id) ?? [];
  }

  static build(name: string, records: MemoryRecord[], seq: number, config: HarnMemConfig, shard: ShardRef): ShardIndex {
    const fields = fieldsOf(config);
    const docs: DocMeta[] = [];
    const docLens: number[] = [];
    const docTerms: string[][] = [];
    const postings = new Map<string, Map<number, number>>();
    const ttl = config.retrieval?.ttlDays ?? {};
    records.forEach((record, idx) => {
      const { tf, len } = weightedTerms(
        {
          title: record.title,
          description: record.description,
          tags: record.tags,
          entities: record.entities,
          body: record.content,
        },
        fields,
      );
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
        ttlDays: (ttl as Record<string, number>)[record.type] ?? 180,
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

  static fromJson(json: ShardIndexJson): ShardIndex {
    const postings = new Map<string, Map<number, number>>();
    for (const [term, list] of Object.entries(json.postings ?? {})) {
      const map = new Map<number, number>();
      for (const [idx, w] of list) map.set(idx, w);
      postings.set(term, map);
    }
    return new ShardIndex(json.name, json.seq, json.docs, json.docLens, json.avgLen, json.docTerms ?? [], postings);
  }

  toJson(builtAt: number): ShardIndexJson {
    const postings: Record<string, [number, number][]> = {};
    for (const [term, map] of this.postings) {
      const list: [number, number][] = [];
      for (const [idx, w] of map) list.push([idx, w]);
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
  df(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  idfOf(term: string): number {
    return idf(this.docs.length, this.df(term));
  }

  /** Raw BM25F score for one doc. */
  score(queryTerms: string[], docIdx: number, params: Bm25Params = DEFAULT_BM25): number {
    let score = 0;
    const docLen = this.docLens[docIdx] ?? this.avgLen;
    const norm = params.k1 * (1 - params.b + (params.b * docLen) / (this.avgLen || 1));
    for (const term of queryTerms) {
      const wTf = this.postings.get(term)?.get(docIdx);
      if (!wTf) continue;
      score += this.idfOf(term) * ((wTf * (params.k1 + 1)) / (wTf + norm));
    }
    return score;
  }

  /** Ids linked from or to `id` (1-hop, both directions), O(degree). */
  linkNeighbors(id: string): string[] {
    const out = this.outLinks(id);
    const incoming = this.inLinks(id);
    if (incoming.length === 0) return out;
    if (out.length === 0) return incoming;
    return [...new Set([...out, ...incoming])];
  }

  /** Docs that link to `id` (sorted for deterministic output). */
  backlinks(id: string): string[] {
    return [...new Set(this.inLinks(id))].sort();
  }
}

/** Source trust by harness: user speech 1.0, tools 0.8, model inference 0.5. */
export function trustOf(harness: string | undefined): number {
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
  private cache = new Map<string, ShardIndex>();
  private usage: Map<string, { lastUsed: number; usedCount: number }> | null = null;

  constructor(
    private readonly store: Store,
    private config: HarnMemConfig,
  ) {}

  setConfig(config: HarnMemConfig): void {
    this.config = config;
    this.cache.clear();
  }

  invalidate(): void {
    this.cache.clear();
  }

  /** Usage counters are merged into doc metadata before ranking (no index rebuild). */
  setUsage(usage: Map<string, { lastUsed: number; usedCount: number }>): void {
    this.usage = usage;
    for (const index of this.cache.values()) this.applyUsage(index);
  }

  private applyUsage(index: ShardIndex): ShardIndex {
    if (!this.usage || this.usage.size === 0) return index;
    for (const doc of index.docs) {
      const usage = this.usage.get(doc.id);
      if (!usage) continue;
      if (usage.lastUsed > doc.lastUsed) doc.lastUsed = usage.lastUsed;
      if (usage.usedCount > doc.usedCount) doc.usedCount = usage.usedCount;
    }
    return index;
  }

  /** Cached accessor by shard name, with on-disk cache validation via per-shard seq. */
  async get(shard: ShardRef): Promise<ShardIndex> {
    const current = await this.store.getShardSeq(shard.name);
    const cached = this.cache.get(shard.name);
    if (cached && cached.seq === current) return this.applyUsage(cached);
    const raw = (await this.store.loadIndex(shardKeyOf(shard))) as ShardIndexJson | null;
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
  async rebuild(shard: ShardRef): Promise<ShardIndex> {
    const { records } = await this.store.readShard(shard);
    const seq = await this.store.getShardSeq(shard.name);
    const index = ShardIndex.build(shard.name, records, seq, this.config, shard);
    this.cache.set(shard.name, index);
    await this.store.saveIndex(shardKeyOf(shard), index.toJson(Date.now()));
    await this.saveManifest();
    return index;
  }

  async rebuildAll(): Promise<ShardIndex[]> {
    const shards = await this.store.listShards();
    const out: ShardIndex[] = [];
    for (const shard of shards) out.push(await this.rebuild(shard));
    await this.store.writeManifest(await this.store.getSeq(), out.map((i) => ({ name: i.name, docs: i.docs.length })));
    return out;
  }

  private async saveManifest(): Promise<void> {
    const shards = await this.store.listShards();
    await this.store.writeManifest(
      await this.store.getSeq(),
      shards.map((s) => ({ name: s.name, scope: s.scope })),
    );
  }

  get size(): number {
    let n = 0;
    for (const index of this.cache.values()) n += index.docs.length;
    return n;
  }
}

export function shardKeyOf(shard: ShardRef): string {
  return shard.name;
}
