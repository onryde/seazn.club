// Reads the recorded corpora and the bye deltas out of the INSTALLED tarball with the testkit's own readers (engine-split 2b Task R1).
//
// `@seazn/engine/testkit` resolves to the packed `dist/testkit/index.js`; `goldenCorpora()` finds `../sports/**/*.golden.json` and
// `byeDeltas()` finds `../sport/__fixtures__/bye-deltas.json` from that module. Both are right from `src/testkit/` in the workspace and
// from `dist/testkit/` here only if `build:dist` copied the JSON (scripts/copy-dist-data.mjs), and this is the run that proves the
// second half. Prints one digest per corpus and one for the bye deltas; run.mjs holds them against the workspace's own read
// (a count of zero is a failure there, and so is a digest that differs).
import { createHash } from "node:crypto";
import { byeDeltas, goldenCorpora } from "@seazn/engine/testkit";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const corpora = Object.fromEntries(goldenCorpora().map((c) => [`${c.sport}/${c.key}`, digest(c.corpus)]));
console.log(`CORPORA_DIGESTS ${JSON.stringify(corpora)}`);
console.log(`BYE_DELTAS_DIGEST ${digest(byeDeltas())}`);
console.log(`corpora: ${Object.keys(corpora).length}`);
