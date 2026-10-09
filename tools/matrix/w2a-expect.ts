// CLI: node --experimental-strip-types --import ./scripts/lib/crash-exit.ts tools/matrix/w2a-expect.ts
//        --expect <expect-77.json> --rekeys <expect-77-rekeys.json> --now <results.json> [--now <results.json>...] [--json-out <path>]
// W2a plan Task 16 Step 3, "the 77 are green" (phase 3 review D-P2): every id in the expectation must be `works`, except the
// cells the re-key file moves to another programme item (W2b, W4), which must still be red for the reason it pins. The runs
// are given in the order they are read: the first that holds a case decides it (the CI artifact before the local run).
// Exit codes, each with one meaning:
//   0  done - a verdict was reached and it is clean: every cell not re-keyed is works, every re-keyed one is works or red
//      for its pinned reason with no failing check beyond its pinned ones (a works one is listed as greened, a stale pin);
//   1  a negative signal, the verdict written: a cell not re-keyed that is not works, or a re-keyed cell that is not red
//      for its pinned reason or fails a check its re-key does not pin - each named on stdout;
//   2  refused, nothing written: usage; unreadable input (the expectation, the re-key file or a results.json); a re-key
//      of an id the expectation does not hold, or twice; a case in no run given (ExpectedAbsent); nothing read (NoCases);
//      a case twice in one run. Each refusal prints its own name (lib/w2a-expect.ts EXPECT_REFUSALS);
//   3  a crash while it loads, through the preload (scripts/lib/crash-exit.ts). Run it only with that preload: without it
//      a load crash exits 1, which reads as a verdict.
// Every line printed, and every string written, passes through redact().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { EXIT_CODES } from "./lib/exit-codes.ts";
import { mapStrings, redact } from "./lib/redact.ts";
import { parseResults } from "./lib/results.ts";
import { ExpectRefused, judgeExpectation, parseExpect, parseRekeys, type Source } from "./lib/w2a-expect.ts";

const USAGE = "usage: w2a-expect.ts --expect <expect-77.json> --rekeys <expect-77-rekeys.json> --now <results.json> [--now <results.json>...] [--json-out <path>]";
/** The most list lines a verdict prints (--json-out has them all). */
const LIST_CAP = 50;
const REASON_CAP = 240;
const clip = (s: string): string => (s.length > REASON_CAP ? `${s.slice(0, REASON_CAP)}...` : s);

function readJson(path: string, name: "ExpectUnreadable" | "RekeysUnreadable" | "RunUnreadable"): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ExpectRefused(name, `${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readSource(path: string): Source {
  const json = readJson(path, "RunUnreadable");
  try {
    const run = parseResults(json);
    return { label: `${run.runId} (${path})`, cases: run.cases };
  } catch (e) {
    if (e instanceof ZodError) throw new ExpectRefused("RunUnreadable", `${path}: not a results.json this harness wrote - ${e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    throw e;
  }
}

export function main(argv: readonly string[]): number {
  let values: { expect?: string; rekeys?: string; now?: string[]; "json-out"?: string };
  try {
    // pnpm 10 forwards the `--` of `pnpm run <script> -- <flags>`; a bare one is never an argument.
    ({ values } = parseArgs({ args: argv.filter((a) => a !== "--"), options: { expect: { type: "string" }, rekeys: { type: "string" }, now: { type: "string", multiple: true }, "json-out": { type: "string" } } }));
  } catch (e) {
    process.stderr.write(`w2a-expect: ${redact(e instanceof Error ? e.message : String(e))}\n${USAGE}\n`);
    return 2;
  }
  if (values.expect === undefined || values.rekeys === undefined || values.now === undefined || values.now.length === 0) {
    process.stderr.write(`w2a-expect: ${USAGE}\n`);
    return 2;
  }
  try {
    const want = parseExpect(readJson(values.expect, "ExpectUnreadable"), values.expect);
    const rekeys = parseRekeys(readJson(values.rekeys, "RekeysUnreadable"), want, values.rekeys);
    const sources = values.now.map(readSource);
    const v = judgeExpectation({ want, rekeys, sources });
    if (values["json-out"] !== undefined) {
      mkdirSync(dirname(values["json-out"]), { recursive: true });
      writeFileSync(values["json-out"], `${JSON.stringify(mapStrings({ version: 1, ...v }, redact), null, 2)}\n`);
    }
    const capped = (lines: string[]): string[] => (lines.length <= LIST_CAP ? lines : [...lines.slice(0, LIST_CAP), `  ... and ${lines.length - LIST_CAP} more (--json-out has every one)`]);
    const lines = [
      `expected ${v.expected}, found ${v.found}: ${v.works} works, ${v.pinnedRed.length} red as pinned, ${v.greened.length} greened; ${v.unexpectedRed.length} unexpected red, ${v.wrongReason.length} wrong reason (${v.read} case(s) read)`,
      ...capped(v.pinnedRed.map((p) => `  red as pinned ${p.caseId}: owned by ${p.now} (${p.wave})`)),
      ...capped(v.greened.map((id) => `  greened ${id}: re-keyed but works - the pin is stale`)),
      ...capped(v.unexpectedRed.map((u) => `  unexpected red ${u.caseId}: ${u.state} - ${clip(u.reason)}`)),
      ...capped(v.wrongReason.map((w) => `  wrong reason ${w.caseId}: pinned "${w.wanted}", it says ${clip(w.got)}`)),
      `exit ${v.exit}: ${EXIT_CODES[v.exit]}`,
    ];
    for (const l of lines) process.stdout.write(`${redact(l)}\n`);
    return v.exit;
  } catch (e) {
    if (e instanceof ExpectRefused) {
      // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair.
      process.stderr.write(`w2a-expect: ${e.name}: ${redact(e.message)}\n`);
      return 2;
    }
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
