// Preloaded (node --import) by every matrix CLI's package script — matrix:l3,
// matrix:browser, matrix:render, matrix:catalogue, matrix:single-sport,
// matrix:model, matrix:parity, matrix:lock-check, matrix:merge, matrix:judge,
// matrix:pr-rows, matrix:shards, matrix:summary, matrix:staleness, matrix:sample, matrix:triage, matrix:ledger, matrix:backlog — and by reference:boundary
// (W1b final batch F-6; W1c added browser and parity; W1d added lock-check, merge, judge,
// pr-rows, the three CI helpers, the per-PR sample's driver, the triage and audit-ledger tools, and the per-wave backlog writer). The list is held to package.json by tools/matrix/__tests__/crash-exit.test.ts:
// a script that preloads this file and is not named here reds it.
// Pinned twice: the harness's CLIs by
// tools/matrix/__tests__/crash-exit.test.ts, the gate and the module by
// scripts/__tests__/crash-exit.test.ts. It lives here, not in the harness, for the reason
// main-module.ts does: reference:boundary is a repo gate, not harness code,
// and packages/reference's test spawns it as its package script — so its
// preload must not reach the dev-only tools/ (ruling 56; CL-R4, which lifted
// it out of the harness). Each CLI promises "3 = crash, never
// 1", because 1 reads as a verdict (drift, a ratchet violation, a NEW
// failure). Its main keeps that promise; but a failure to LOAD the CLI — a
// parse error under strip-types, a missing export, a module that throws while
// it evaluates — happens before any CLI code runs, and node exits 1. A preload
// runs first, so it is the one place that can see those: any exception nothing
// caught becomes exit 3. Only a preload: imported into a vitest worker, this
// handler would take over the worker's own crashes. Run each CLI through its
// package script (`pnpm run matrix:l3`, …): a run without this preload exits 1
// on a load failure, and cli-invocation.test.ts refuses any documented
// invocation that skips it (W1b carry e).
import { basename } from "node:path";

process.on("uncaughtException", (e: unknown) => {
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const stack = e instanceof Error && e.stack !== undefined ? `\n${e.stack}` : "";
  process.stderr.write(`${basename(process.argv[1] ?? "cli")}: crashed — nothing caught ${what} (exit 3: a crash, never a verdict)${stack}\n`);
  process.exit(3);
});
