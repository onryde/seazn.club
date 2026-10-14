// What .github/workflows/engine-canary.yml runs to publish a canary of @onryde/seazn-engine (engine-split Task 1b-4, D16):
//
//   node packages/engine/pack-proof/canary.mjs version                       the canary version for this workflow run and commit
//   node packages/engine/pack-proof/canary.mjs set-version <version>         write it into packages/engine/package.json (the RUNNER's checkout)
//   node packages/engine/pack-proof/canary.mjs check <tarball> <version>     refuse a tarball that must not be published
//
// Exit 0 done, 1 refused (reason on stderr, nothing on stdout), 2 misuse. Every decision is in canary-lib.mjs, held by
// test/canary.test.ts; this file only wires it to the process, and runs unconditionally (no "is this the main module" test that could
// fail open and leave a publish gate that silently did nothing).
import console from "node:console";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { main } from "./canary-lib.mjs";

process.exitCode = main(process.argv.slice(2), process.env, { out: (line) => console.log(line), err: (line) => console.error(line) }, { manifestFile: fileURLToPath(new URL("../package.json", import.meta.url)) });
