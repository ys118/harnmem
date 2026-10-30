import { defineConfig } from "tsdown";

/**
 * Bundle the pi extension into a self-contained dist:
 * - `@harnmem/core` is a devDependency, so tsdown inlines it (the published
 *   plugin has zero runtime dependency on core — immune to whatever package
 *   resolution semantics pi's extension loader uses, cf. pi 1.4.0 require
 *   semantics vs the core exports issue).
 * - pi host modules stay external: pi's loader maps them to its own copies.
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
    neverBundle: [/@earendil-works\//, /^typebox$/],
  },
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
