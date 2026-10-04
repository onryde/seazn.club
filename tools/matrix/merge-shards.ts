// CLI: pnpm run matrix:merge --run-id <id> --out <dir> <shardDir>...
// W1d D5: the N shards of one layer (`run.ts --shard k/N`, one run id each) back
// into ONE run — <dir>/results.json and <dir>/MATRIX.md, rendered from that
// results.json and nothing else (R10). Each shard dir holds the shard's
// `results.json` and its `exit.txt` (the exit code the shard's own step wrote:
// a killed command exits 0, so the shard writes it itself). lib/merge.ts refuses,
// by name, every way a shard can be short; nothing is merged around a hole.
// Exit codes, each with one meaning:
//   0  merged: results.json and MATRIX.md written to --out;
//   2  usage or input error, with a message on stderr and nothing written: a
//      missing --run-id, --out or shard dir, an unknown flag, a --run-id that is
//      not already its own slug (run.ts writes <report-dir>/<slug>/, so a caller
//      that names another directory would read nothing), a shard dir that is
//      absent, a results.json that is empty, unreadable or not JSON, or any
//      refusal of lib/merge.ts (ShardMissing, ShardDuplicate, ShardFailed,
//      ShardEmpty, ShardAborted, ShardMismatch, ShardSize, ShardInvalid,
//      CaseCollision, ShardSecret) or of writeResults (a secret-shaped string);
//   3  a crash while it loads, through `pnpm run matrix:merge` (its preload,
//      scripts/lib/crash-exit.ts). Run it only through that script: without the
//      preload a load crash exits 1.
// An uncaught throw would exit 1 without the preload, so every input failure is
// caught here. Every line printed passes through redact().
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { mergeShards, type ShardInput } from "./lib/merge.ts";
import { redact } from "./lib/redact.ts";
import { renderMatrix } from "./lib/render-matrix.ts";
import { writeResults } from "./lib/results.ts";
import { RUN_ID_MAX, slugRunId } from "./lib/run-id.ts";

const USAGE = "usage: merge-shards.ts --run-id <id> --out <dir> <shardDir>...";

/** The base writeResults scrubs: a host no shard's text names, so the scrub is a
 *  no-op. Each shard was already written through writeResults with its OWN run's
 *  base, so its strings carry LOCAL_BASE where that base was; the merge only
 *  needs writeResults' schema parse and secret scan. */
const NO_BASE = "http://merge-shards.invalid";

function parseCli(argv: string[]): { runId: string; out: string; dirs: string[] } | { usage: string } {
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:merge -- <flags>`; a bare one is never a shard dir.
    const { positionals, values } = parseArgs({ args: argv.filter((a) => a !== "--"), allowPositionals: true, options: { "run-id": { type: "string" }, out: { type: "string" } } });
    const id = values["run-id"];
    if (id === undefined || values.out === undefined || positionals.length === 0) return { usage: USAGE };
    // run.ts wrote each shard to <report-dir>/<slugRunId(its id)>/; an id that is not already its own slug
    // would let a caller name one directory and read another.
    if (slugRunId(id) !== id) {
      return { usage: `--run-id ${JSON.stringify(id)} is not its own slug${slugRunId(id) === null ? ` (it must be 1-${RUN_ID_MAX} characters of [a-z0-9-])` : `; run.ts would write ${JSON.stringify(slugRunId(id))} — pass that`}\n${USAGE}` };
    }
    return { runId: id, out: values.out, dirs: positionals };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

function refusal(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** The file's text, or null when it is absent. Any other failure to read it is the caller's refusal. */
function textOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** One shard dir as lib/merge.ts reads it. A missing exit.txt is `exit: null` and a missing results.json is
 *  `results: null` (the merge refuses each by name); an EMPTY or unparseable results.json is refused here. */
function readShard(dir: string): ShardInput {
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw refusal("ShardMissing", `${dir}: no such shard directory`);
  const exit = textOrNull(join(dir, "exit.txt"));
  const text = textOrNull(join(dir, "results.json"));
  if (text === null) return { name: dir, exit, results: null };
  if (text.trim() === "") throw refusal("ShardEmpty", `${dir}: results.json is empty`);
  try {
    return { name: dir, exit, results: JSON.parse(text) as unknown };
  } catch (e) {
    throw refusal("ShardInvalid", `${dir}: results.json is not JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function main(argv: string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`merge-shards: ${redact(cli.usage)}\n`);
    return 2;
  }
  try {
    const inputs = cli.dirs.map(readShard);
    const { merged, checked } = mergeShards(inputs, cli.runId);
    // Render once before writing anything: a case off the run's grid refuses the render, and a refused
    // merge writes nothing (the text written below is the render of what writeResults wrote).
    renderMatrix(merged);
    const { written } = writeResults(cli.out, merged, NO_BASE);
    writeFileSync(join(cli.out, "MATRIX.md"), redact(renderMatrix(written)));
    process.stdout.write(`${redact(`merged ${checked} cases from ${inputs.length} shards → ${cli.out}`)}\n`);
    return 0;
  } catch (e) {
    // The refusal's NAME is ours and is printed as it is: redact() reads `ShardSecret: <dir>:` as a
    // key/value pair and would print `[redacted]` in its place. The message passes through redact().
    process.stderr.write(`merge-shards: ${e instanceof Error ? `${e.name}: ${redact(e.message)}` : redact(String(e))}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
