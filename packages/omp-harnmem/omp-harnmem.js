// omp extension entry point.
//
// Keep `omp.extensions` in package.json pointing at this file rather than
// "dist/index.js": omp derives the startup "[Extensions]" label for a
// package installed from a local path out of the entry path's trailing
// segments; a "./dist/index.js" entry collapses to the single label "dist",
// while a root-level "<name>.js" entry shows up as "omp-harnmem.js".
// This file contains no logic: it only re-exports the real extension factory.
export { default } from "./dist/index.js";
