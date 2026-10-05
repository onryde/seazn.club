// CLI: pnpm run matrix:ledger --audit <dir> --triage <triage.json> --verdicts <audit-verdicts.json> --out <AUDIT-LEDGER.md>
//        [--routing <gap-routing.json>] [--repo <dir>]
// W1d Task 18 (ruling 63, D22): accounts for every id of the audit files with exactly one of five outcomes — reproduced
// (from the triage), or one of four verdicts (exercised-not-reproduced, not-exercised, verified-by-read,
// verified-by-failing-test) — and writes the ledger. A verdict's wave must be the one design §8 gives its id; a
// verified-by-failing-test verdict's it.fails must be in the named file under --repo (default: this repo); an
// exercised-not-reproduced verdict's cases must be works cases of the triaged runs.
// The ledger names the runs it was built from, on stdout and on its page. Exit codes, each with one meaning:
//   0  every id has exactly one outcome and every verdict checks out: the ledger is written;
//   1  a negative signal, the ledger still written so a reviewer reads the partial (it leads with INCOMPLETE): an id with
//      no outcome or two, a verdict naming no id, a verdict at the wrong wave, a cited case that is not a works case, or
//      a failing test that is not in the repo or never runs (skipped, todo, or under a skip or a condition) — each
//      listed on stdout;
//   2  usage or input error, with a message on stderr and nothing written: a missing flag, an unknown flag, a triage,
//      verdicts or routing file that is unreadable or that its schema refuses, an audit directory with no gap, a triage
//      that is not clean (an untriaged red could be the very gap a verdict calls not-exercised), or a triage that read
//      nothing: no run, no case, or a run of one of L1, L2, L3 missing (an id only that layer could reproduce would read
//      not-exercised);
//   3  a crash while it loads, through `pnpm run matrix:ledger` (its preload, scripts/lib/crash-exit.ts). Run it only
//      through that script: without the preload a load crash exits 1.
// An uncaught throw would exit 1 without the preload, so every input failure is caught here. Every line printed and the
// ledger written pass through redact().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { REPO_ROOT, buildLedger, findingLine, parseVerdicts, readAudit, renderLedger, OUTCOMES } from "./lib/audit-ledger.ts";
import { EXIT_CODES } from "./lib/exit-codes.ts";
import { redact } from "./lib/redact.ts";
import { CATALOGUE_DIR, parseRouting, parseTriage } from "./lib/triage.ts";

const USAGE = "usage: audit-ledger.ts --audit <dir> --triage <triage.json> --verdicts <audit-verdicts.json> --out <AUDIT-LEDGER.md> [--routing <gap-routing.json>] [--repo <dir>]";
/** Stdout lists at most this many findings: the ledger has every one. */
const SHOWN = 50;

interface Cli { audit: string; triage: string; verdicts: string; out: string; routing: string; repo: string }

function parseCli(argv: string[]): Cli | { usage: string } {
  try {
    const { values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      options: { audit: { type: "string" }, triage: { type: "string" }, verdicts: { type: "string" }, out: { type: "string" }, routing: { type: "string" }, repo: { type: "string" } },
    });
    if (values.audit === undefined || values.triage === undefined || values.verdicts === undefined || values.out === undefined) return { usage: USAGE };
    return { audit: values.audit, triage: values.triage, verdicts: values.verdicts, out: values.out, routing: values.routing ?? join(CATALOGUE_DIR, "gap-routing.json"), repo: values.repo ?? REPO_ROOT };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

type InputName = "TriageUnreadable" | "VerdictsUnreadable" | "RoutingUnreadable";

/** A JSON file the ledger reads, parsed by its schema: unreadable, not JSON and schema-refused are each named. */
function readJson<T>(name: InputName, file: string, parse: (json: unknown) => T): T {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const err = new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    err.name = name;
    throw err;
  }
  try {
    return parse(json);
  } catch (e) {
    const why = e instanceof z.ZodError ? e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : String(e);
    const err = new Error(`${file}: the file's schema refuses it — ${why}`);
    err.name = name;
    throw err;
  }
}

/** A repo-relative path's text, or null when the repo has no such file. */
function repoReader(repo: string): (rel: string) => string | null {
  return (rel) => {
    try {
      return readFileSync(join(repo, rel), "utf8");
    } catch (e) {
      if (e instanceof Error && "code" in e && (e.code === "ENOENT" || e.code === "EISDIR" || e.code === "ENOTDIR")) return null;
      throw e;
    }
  };
}

export function main(argv: string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`audit-ledger: ${redact(cli.usage)}\n`);
    return 2;
  }
  const say = (line: string): void => { process.stdout.write(`${redact(line)}\n`); };
  try {
    const audit = readAudit(cli.audit);
    const triage = readJson("TriageUnreadable", cli.triage, parseTriage);
    const verdicts = readJson("VerdictsUnreadable", cli.verdicts, parseVerdicts).verdicts;
    const routing = readJson("RoutingUnreadable", cli.routing, parseRouting);

    const ledger = buildLedger({ gaps: audit.gaps, umbrellas: audit.umbrellas, routing, triage, verdicts, readFile: repoReader(cli.repo) });
    const files = new Set(audit.gaps.map((g) => g.file)).size;
    mkdirSync(dirname(cli.out), { recursive: true });
    writeFileSync(cli.out, redact(renderLedger(ledger, { audit: audit.gaps.length, files, umbrellas: audit.umbrellas.length, checked: triage.checked })));

    say(`${OUTCOMES.map((o) => `${o} ${ledger.counts[o]}`).join(", ")} (${audit.gaps.length} audit ids)`);
    say(`runs: ${ledger.runs.map((r) => `${r.layer} ${r.runId}`).join(", ")}`);
    const lines = ledger.findings.map(findingLine);
    for (const l of lines.slice(0, SHOWN)) say(l);
    if (lines.length > SHOWN) say(`… and ${lines.length - SHOWN} more (the ledger has every one)`);
    const code = lines.length === 0 ? 0 : 1;
    say(`exit ${code}: ${EXIT_CODES[code]}`);
    return code;
  } catch (e) {
    // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair and would
    // print `[redacted]` in its place. The message passes through redact().
    process.stderr.write(`audit-ledger: ${e instanceof Error ? `${e.name}: ${redact(e.message)}` : redact(String(e))}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
