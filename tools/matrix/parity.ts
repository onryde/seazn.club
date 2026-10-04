// CLI: pnpm matrix:parity <http results.json> <browser results.json> [--out parity.md]
// (W1c Task 13). Compares an HTTP run with a browser run, case by case
// (lib/parity.ts). The report goes to --out, or to stdout without it.
// Exit codes, the house codes (W1b final batch F-6, W1c carry e):
//   0  parity: at least one case compared, at least one common check, and no
//      difference;
//   1  a difference (the report is still written), or nothing to compare:
//      compared 0 cases, or 0 common checks, is never parity;
//   2  usage: not exactly two files, an unknown flag, or the runs in the
//      wrong slots (WrongDriver). Nothing is written;
//   3  unreadable input: a missing or unreadable file, bad JSON, results the
//      schema refuses, a case or check id that repeats, or a case id that
//      does not end in its own width. Nothing is written. A crash while the CLI
//      loads is 3 too, through the package script's preload
//      (scripts/lib/crash-exit.ts). Run it only through that script: without the
//      preload, a load crash exits 1, which reads as a verdict (W1b carry e).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { DuplicateId, WidthSuffixMismatch, WrongDriver, compareRuns, headerLine, parityVerdict, renderParity, type ParityReport } from "./lib/parity.ts";
import { redact } from "./lib/redact.ts";
import { parseResults, type AnyRunResults } from "./lib/results.ts";

const USAGE = "usage: parity.ts <http results.json> <browser results.json> [--out parity.md]";

const why = (e: unknown): string => redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** The parsed command line, or the reason it is a usage error. A bare `--` is
 *  dropped: `pnpm run matrix:parity -- a b` hands it to node (pnpm 10). */
function parseCli(argv: readonly string[]): { http: string; browser: string; out: string | undefined } | { usage: string } {
  try {
    const { positionals, values } = parseArgs({ args: argv.filter((a) => a !== "--"), allowPositionals: true, options: { out: { type: "string" } } });
    const [http, browser, ...extra] = positionals;
    if (http === undefined || browser === undefined || extra.length > 0) return { usage: USAGE };
    return { http, browser, out: values.out };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

function read(file: string): AnyRunResults {
  return parseResults(JSON.parse(readFileSync(file, "utf8")));
}

export function main(argv: readonly string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`${cli.usage}\n`);
    return 2;
  }
  let http: AnyRunResults, browser: AnyRunResults;
  try {
    http = read(cli.http);
    browser = read(cli.browser);
  } catch (e) {
    process.stderr.write(`parity: ${why(e)}\n`);
    return 3;
  }
  let report: ParityReport;
  try {
    report = compareRuns(http, browser);
  } catch (e) {
    if (e instanceof WrongDriver) {
      process.stderr.write(`parity: ${why(e)}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof DuplicateId || e instanceof WidthSuffixMismatch) {
      process.stderr.write(`parity: ${why(e)}\n`);
      return 3;
    }
    throw e;
  }
  const verdict = parityVerdict(report);
  const md = redact(renderParity(report, { http: http.runId, browser: browser.runId }));
  if (cli.out === undefined) {
    process.stdout.write(md);
  } else {
    mkdirSync(dirname(cli.out), { recursive: true });
    writeFileSync(cli.out, md);
    process.stdout.write(`parity: ${headerLine(report)} — ${verdict.line} → ${cli.out}\n`);
  }
  return verdict.code;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
