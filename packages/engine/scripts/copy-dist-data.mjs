// build:dist, step 3 (engine-split 2b Task R1): copy the data files the SHIPPED code reads at runtime from src/ to the same relative
// place under dist/. tsc emits .js and .d.ts only; it never copies JSON that nothing imports.
//
//   src/sports/**/<key>.golden.json         the recorded corpora        -> dist/sports/**/<key>.golden.json
//   src/sport/__fixtures__/bye-deltas.json  the pinned bye deltas       -> dist/sport/__fixtures__/bye-deltas.json
//
// `src/testkit/corpora.ts` finds both by `../sports` and `../sport/__fixtures__` from its own URL, which is right from src/testkit/
// and from dist/testkit/ only because this script keeps the layout. Its list of what is data (this pattern and this fixture) is
// the reader's own; pack-proof/node/corpora.mjs holds the INSTALLED reader's count against the workspace's, so a drift fails there.
//
// Roots are the package directory this script sits in, never the cwd. An empty src (no corpus, or no fixture) is a failed build:
// a tarball whose corpora reader finds nothing would fail a consumer's sweep for the wrong reason, or pass an empty one.
import console from "node:console";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const BYE_DELTAS = join("sport", "__fixtures__", "bye-deltas.json");

const corpora = readdirSync(join(PACKAGE, "src", "sports"), { recursive: true })
  .filter((f) => f.endsWith(".golden.json"))
  .map((f) => join("sports", f))
  .sort();
if (corpora.length === 0) {
  console.error(`copy-dist-data: no *.golden.json under ${join(PACKAGE, "src", "sports")}`);
  process.exit(1);
}
for (const rel of [...corpora, BYE_DELTAS]) {
  mkdirSync(dirname(join(PACKAGE, "dist", rel)), { recursive: true });
  cpSync(join(PACKAGE, "src", rel), join(PACKAGE, "dist", rel));
}
console.log(`copy-dist-data: ${corpora.length} corpora and the bye deltas -> dist/`);
