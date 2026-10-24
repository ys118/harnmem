/** Public surface of @harnmem/core. Harness adapters should import from here only. */
export { HarnMem, type SessionStartInput } from "./harnmem.js";
export type {
  BudgetConfig,
  ConsolidateOptions,
  ConsolidationReport,
  ContextBlock,
  ContextReason,
  HarnMemConfig,
  ExtractResult,
  ExtractStatus,
  ForgetResult,
  GovernanceConfig,
  HarnessId,
  ImportOptions,
  ImportRecord,
  ImportResult,
  LlmFn,
  LlmRequest,
  LlmResponse,
  MemoryCategory,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryType,
  ReadOptions,
  ReadResult,
  RestoreResult,
  RetrievalConfig,
  SearchHit,
  SearchOptions,
  SearchResult,
  ScoreParts,
  SessionEndInput,
  Stats,
  TranscriptMessage,
  WriteAction,
  WriteConfig,
  WriteInput,
  WriteResult,
} from "./types.js";
export { HARNMEM_API_VERSION } from "./types.js";
export { resolveHome, estimateTokens, newMemoryId } from "./util.js";
export {
  deployDefaultAssets,
  findAssetRoot,
  listSynonymFiles,
  loadPromptAsset,
  loadSynonymGroups,
  parsePromptAsset,
  parseSynonymTable,
  readAssetRaw,
} from "./assets.js";
export type { PromptAsset } from "./assets.js";
export type { ProjectInfo } from "./project.js";
export {
  renderHotContextSync,
  type SyncHotContextOptions,
  type SyncHotContextResult,
} from "./hot-context.js";
export { layoutHotContext, renderContextText, CONTEXT_HEADER, CONTEXT_FOOTER } from "./retrieval.js";
export type { HotContextLayout, HotContextOptions, HotDigest } from "./retrieval.js";
export { MemoryInspector, openInspector } from "./inspect.js";
export type {
  InspectContext,
  InspectContextOptions,
  InspectFileError,
  InspectIndexOptions,
  InspectIndexStatus,
  InspectIndexText,
  InspectIssue,
  InspectList,
  InspectListOptions,
  InspectMemory,
  InspectOverview,
  InspectOverviewOptions,
  InspectProject,
  InspectReadOptions,
  InspectRow,
  InspectShard,
  MemoryInspectorOptions,
} from "./inspect.js";
export {
  DEFAULT_SUGGEST_PROMPT,
  buildSuggestCorpus,
  buildSuggestPrompt,
  cleanTerm,
  harvestTerms,
  parseSuggestionGroups,
  suggestFromResponse,
  suggestSynonyms,
  validateSuggestions,
} from "./suggest.js";
export type {
  HarvestedTerm,
  SuggestMessage,
  SuggestOptions,
  SuggestPrompt,
  SuggestProposal,
  SuggestRecord,
  SuggestRejection,
  SuggestRunResult,
} from "./suggest.js";

