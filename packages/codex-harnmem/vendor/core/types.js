/**
 * HarnMem public API — frozen contract v1 (see docs/design/07-adapter-contract.md).
 *
 * Harness adapters (pi / dsh / claude / cli) may only depend on this file's
 * exported types and the `HarnMem` facade in `./harnmem.js`. Everything else is
 * internal and may change.
 *
 * Design rules:
 *  - zero runtime dependencies (node: builtins only)
 *  - on-disk format is the SSOT; every index file is rebuildable
 *  - the engine never writes outside `harnmem.home` except for reads
 */
export const HARNMEM_API_VERSION = 1;
//# sourceMappingURL=types.js.map