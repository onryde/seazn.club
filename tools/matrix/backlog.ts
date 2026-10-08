// CLI: pnpm run matrix:backlog --triage <triage.json> --sha <baseline commit> --out <backlog.md>
// W1d Task 22 (ruling 62, D19): writes the per-wave backlog section of the programme's _INDEX.md from the committed baseline and
// catalogue (lib/backlog.ts): per numbered wave of design section 8, its gaps with their cases, the audit ids no baseline case drives,
// and the carries the wave owes. --triage is the triage.json that `pnpm run matrix:triage` writes from the committed baseline (a triage
// of any other run, or whose run, case or red counts are not the baseline's, is refused), and --sha is the baseline commit the heading
// names: EXACTLY the commit every layer's results.json records as its harness commit (a longer name of it, the tag's full commit
// among them, is refused as a shorter one is). Exit codes, each with one meaning:
//   0  the section is written;
//   2  usage or input error, with a message on stderr and nothing written: a missing flag, an unknown flag, a sha that is not the
//      baseline's commit, a triage that is unreadable, that its schema refuses or that was not written from the committed baseline,
//      a catalogue, baseline or design file that is unreadable, or an input the section would lie about (a triage with no red, a
//      gap whose cases are not the rows', a ledger with a finding, a wave section 8 has no row for, a NEW gap whose wave no design row
//      backs, a carry with no derivation or whose derivation finds no source), each by its own name;
//   3  a crash while it loads, through `pnpm run matrix:backlog` (its preload, scripts/lib/crash-exit.ts). Run it only through that
//      script: without the preload a load crash exits 1.
// An uncaught throw would exit 1 without the preload, so every input failure is caught here. Every line printed and the section written
// pass through redact().
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { loadBacklogInput, renderBacklog, summaryOf } from "./lib/backlog.ts";
import { EXIT_CODES } from "./lib/exit-codes.ts";
import { redact } from "./lib/redact.ts";

const USAGE = "usage: backlog.ts --triage <triage.json> --sha <baseline commit> --out <backlog.md>";

interface Cli { triage: string; sha: string; out: string }

function parseCli(argv: string[]): Cli | { usage: string } {
  try {
    const { values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: { triage: { type: "string" }, sha: { type: "string" }, out: { type: "string" } },
    });
    if (values.triage === undefined || values.sha === undefined || values.out === undefined) return { usage: USAGE };
    return { triage: values.triage, sha: values.sha, out: values.out };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

export function main(argv: string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`backlog: ${redact(cli.usage)}\n`);
    return 2;
  }
  const say = (line: string): void => { process.stdout.write(`${redact(line)}\n`); };
  try {
    const input = loadBacklogInput({ triage: cli.triage, sha: cli.sha });
    const text = renderBacklog(input);
    mkdirSync(dirname(cli.out), { recursive: true });
    writeFileSync(cli.out, text);
    const n = summaryOf(input);
    say(`backlog: ${n.gaps} gaps, ${n.cases} ❌ cases, ${n.notExercised} not-exercised ids, ${n.waves} waves`);
    say(`exit 0: ${EXIT_CODES[0]}`);
    return 0;
  } catch (e) {
    // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair and would print
    // `[redacted]` in its place. The message passes through redact().
    process.stderr.write(`backlog: ${e instanceof Error ? `${e.name}: ${redact(e.message)}` : redact(String(e))}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
