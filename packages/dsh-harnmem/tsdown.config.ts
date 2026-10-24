import { defineConfig } from 'tsdown'

/**
 * Baseline modules provided by the DSH web runtime's module loader.
 * They must stay `require()` calls: the loader resolves them from the
 * `window.__ModuleLoader__` table, never from our bundle.
 */
const BASELINE = (id: string): boolean =>
  id === 'react' || id.startsWith('react/')
  || id === '@deepseek-ai/cordis' || id.startsWith('@deepseek-ai/cordis/')
  || id === '@deepseek-ai/dsh-client-store' || id.startsWith('@deepseek-ai/dsh-client-store/')
  || id === '@deepseek-ai/dsh-client-ui-slots' || id.startsWith('@deepseek-ai/dsh-client-ui-slots/')
  || id === '@deepseek-ai/dsh-client-ui-primitives'
  || id.startsWith('@deepseek-ai/dsh-client-ui-primitives/')

/**
 * Browser half only: the DSH web frontend loads plugin clients as a CJS
 * closure factory (`window.__ModuleLoader__.load({ id, factory })`).
 * The official client preset is not published, so the wrapper is written out
 * by hand, mirroring `dsh-auto-memory`'s proven build.
 *
 * The host half keeps building through `tsc -p tsconfig.json`; this config
 * only owns `dist/client.js` (hence `clean: false`).
 */
export default defineConfig({
  name: 'dsh-harnmem/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: './tsconfig.client.json',
  dts: false,
  clean: false,
  deps: {
    neverBundle: BASELINE,
    alwaysBundle: (id: string) => !BASELINE(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: (chunk: { isEntry: boolean; fileName: string }) =>
      `window.__ModuleLoader__.load({ id: "dsh-harnmem", ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  outExtensions: () => ({ js: '.js' }),
})
