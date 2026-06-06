#!/usr/bin/env node
/**
 * Copy this package's *built* output into the sibling drawing libs'
 * `node_modules/@softwarity/draw-adapter`, so they can `import` it locally
 * without publishing to npm. Run after `npm run build` (or use `npm run build:link`).
 *
 * It mimics what `npm pack` + install would ship: only `package.json` + `dist/`
 * (the `files` allow-list), preserving the sub-path exports. Idempotent.
 *
 * Targets: every sibling directory that has a `package.json` and a `node_modules`
 * (defaults to ../sigmet-draw and ../sigwx-draw). Override with CLI args:
 *   node scripts/link-into-siblings.mjs ../sigmet-draw ../other-lib
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const NAME = pkg.name; // "@softwarity/draw-adapter"

const dist = join(root, "dist");
if (!existsSync(dist)) {
  console.error(`✗ ${dist} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const siblings =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((p) => resolve(process.cwd(), p))
    : [resolve(root, "..", "sigmet-draw"), resolve(root, "..", "sigwx-draw")];

let linked = 0;
for (const sib of siblings) {
  if (!existsSync(join(sib, "package.json"))) {
    console.warn(`• skip ${sib} (no package.json)`);
    continue;
  }
  const target = join(sib, "node_modules", NAME);
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: true });
  await cp(dist, join(target, "dist"), { recursive: true });
  await cp(join(root, "package.json"), join(target, "package.json"));
  const readme = join(root, "README.md");
  if (existsSync(readme)) await cp(readme, join(target, "README.md"));
  console.log(`✓ ${NAME} → ${target}`);
  linked++;
}

if (linked === 0) {
  console.error("✗ no sibling targets linked.");
  process.exit(1);
}
console.log(`\nDone — ${linked} sibling(s) linked. Re-run after each \`npm run build\`.`);
