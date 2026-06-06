#!/usr/bin/env node
/**
 * Decisive packaging check that bundlers HIDE: import every published sub-path as
 * real Node ESM. Catches the two classic adapter packaging bugs —
 *   - `ol/*` specifiers missing `.js`     → ERR_UNSUPPORTED_DIR_IMPORT
 *   - `import { Map } from "maplibre-gl"`  → "Named export 'Map' not found" (CJS)
 * and proves the peer-free entry (`.`) does NOT pull an engine in.
 *
 * `./leaflet` is browser-only (touches `window` at import), so it is checked under
 * a jsdom shim in the vitest suite instead, not here. Run after `npm run build`.
 */
const subs = ["index", "maplibre", "openlayers", "testing"];
let failed = 0;
for (const sub of subs) {
  try {
    await import(new URL(`../dist/${sub}.js`, import.meta.url));
    console.log(`ok    ./${sub === "index" ? "" : sub}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ./${sub}: ${e.code || e.message}`);
  }
}
if (failed) {
  console.error(`\n${failed} sub-path(s) failed to import as Node ESM.`);
  process.exit(1);
}
console.log("\nAll Node-importable sub-paths load cleanly.");
