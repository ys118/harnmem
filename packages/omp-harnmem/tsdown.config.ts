import { defineConfig } from "tsdown";

/**
 * Bundle the omp extension into a self-contained dist:
 * - `@harnmem/core` is a devDependency, so tsdown inlines it (the published
 *   plugin has zero runtime dependency on core).
 * - `@oh-my-pi/*` host modules stay external: omp's plugin loader rewrites
 *   those specifiers onto its own bundled copies before evaluation
 *   (legacy-pi-compat.ts), so the literal import specifiers must survive
 *   in dist/*.js.
 * - `src/config.ts` is a second entry so `dist/config.js` keeps existing for
 *   test/config.test.mjs (it only imports node builtins, so it bundles clean).
 */
export default defineConfig({
  entry: ["src/index.ts", "src/config.ts"],
  format: "esm",
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  deps: {
    neverBundle: [/^@oh-my-pi\//],
  },
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
