// CLI (W1-driving T16 fix round 1, ruling T16-R4 m-6): the per-case table at
// the end of _INDEX's "Findings routed (W1-driving)" — every product red —
// generated from a TRIAGE.md "Every ❌" table and the committed results.json
// each row is judged on, so a reader can re-run what the doc cites.
//
//   node --experimental-strip-types --import ./scripts/lib/crash-exit.ts \
//     tools/matrix/findings-table.ts <TRIAGE.md> <truth-runs dir> [--out <file.md>]
//
// A row is taken when its final class is "product". Its failing checks are
// read from its judged run's results.json, never from TRIAGE's own column; an
// error red (one that fails no check) shows its error reason, UUIDs elided.
// Rows sort by wave number, then by TRIAGE number. The table goes to --out, or
// to stdout without it; a one-line JSON summary goes to stderr.
//
// Exit codes, the house codes (W1b final batch F-6; one meaning per code across
// every CLI, W1d item 6 / D8, lib/exit-codes.ts):
//   0  the table: at least one product row, every row checked;
//   1  is not used: this CLI judges nothing, it renders. Before W1d a refusal
//      was filed here, under the code a verdict uses;
//   2  refused, nothing written: usage (not exactly two positionals, or an
//      unknown flag); unreadable input (a missing TRIAGE.md or results.json,
//      bad JSON, or results the schema refuses); or a table that would not be
//      what the evidence says (FindingsRefused): a judged-on cell it cannot
//      parse, a run whose harnessCommit differs from TRIAGE's, a case missing
//      from its run or not red there, a red with no failing check and no error
//      reason, a wave that is not W2..W10, or zero product rows;
//   3  a crash while the CLI loads, through the preload
//      (scripts/lib/crash-exit.ts). Run it only through the package script or
//      with that preload: without it, a load crash exits 1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { redact } from "./lib/redact.ts";
import { parseResults } from "./lib/results.ts";

const USAGE = "usage: findings-table.ts <TRIAGE.md> <truth-runs dir> [--out <file.md>]";

/** A refusal: the table would not be what the evidence says. */
export class FindingsRefused extends Error {
  constructor(why: string) {
    super(why);
    this.name = "FindingsRefused";
  }
}

/** One row of TRIAGE's "Every ❌" table, as written. */
export interface TriageRow {
  readonly n: number;
  readonly caseId: string;
  /** The "judged on" cell: `<run dir>[/<sub dir>] @ <harness sha>`, or anything else on a non-product row. */
  readonly judged: string;
  readonly finalClass: string;
  /** The wave cell, e.g. "W2 (T15-R4; T6-R1 had W4)". */
  readonly wave: string;
  readonly rule: string;
  /** The "bracket draws (P1)" cell, e.g. "1 (draw-counts.json)", or "—". */
  readonly draws: string;
}

/** The part of a committed results.json the table reads. */
export interface RunLike {
  readonly harnessCommit: string;
  readonly cases: readonly { readonly caseId: string; readonly state: string; readonly reason: string; readonly checks: readonly { readonly id: string; readonly verdict: string }[] }[];
}

export interface FindingRow {
  readonly n: number;
  readonly caseId: string;
  readonly failing: readonly string[];
  readonly run: string;
  readonly wave: string;
  readonly rule: string;
}

export interface Findings {
  readonly rows: readonly FindingRow[];
  readonly byWave: Readonly<Record<string, number>>;
  /** Distinct results.json files read. */
  readonly files: number;
}

const SECTION = "## Every ❌";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const JUDGED = /^([\w-]+(?:\/[\w-]+)?) @ ([0-9a-f]{9})$/;
/** A wave a product red may route to (design §8: W1x are the harness's own). */
const PRODUCT_WAVE = /^W([2-9]|10)$/;

/** TRIAGE's "Every ❌" rows. Its case cell escapes `|` as `\|` inside backticks. */
export function triageRows(md: string): TriageRow[] {
  const at = md.indexOf(SECTION);
  if (at < 0) throw new FindingsRefused(`TRIAGE has no "${SECTION}" section`);
  return md.slice(at).split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => {
    const c = l.split(" | ");
    return {
      n: Number((c[0] ?? "").slice(2)),
      caseId: (c[1] ?? "").replace(/`/g, "").replace(/\\\|/g, "|"),
      judged: c[4] ?? "",
      finalClass: c[5] ?? "",
      wave: c[6] ?? "",
      rule: c[7] ?? "",
      draws: (c[8] ?? "").replace(/\s*\|\s*$/, "").trim(),
    };
  });
}

/** The rule column, shortened as the doc prints it. */
export function shortRule(rule: string): string {
  if (!rule.startsWith("coverage table")) return (rule.split(/[:(—]/)[0] ?? "").trim();
  return "table: " + rule.replace(/^coverage table \(predicted\): /, "").replace(/ \[now failing:.*$/, "")
    .replace(/mexicano-pair-entrants-counted-as-players \((self-pair|duplicate)\)/g, "$1")
    .replace(/r4-withdrawn-player-kept-playing/, "kept-playing").replace(/mexicano-stalled-on-non-decided/, "mexicano stall");
}

/** Every product row, its failing checks read from the run it is judged on. */
export function findings(rows: readonly TriageRow[], load: (run: string) => RunLike): Findings {
  const runs = new Map<string, RunLike>();
  const out: FindingRow[] = [];
  for (const r of rows) {
    if (r.finalClass !== "product") continue;
    const m = JUDGED.exec(r.judged);
    if (m === null) throw new FindingsRefused(`row ${r.n}: judged-on not parsed: ${r.judged}`);
    const [, run, sha] = m as unknown as [string, string, string];
    const wave = r.wave.split(" ")[0] ?? "";
    if (!PRODUCT_WAVE.test(wave)) throw new FindingsRefused(`row ${r.n}: wave '${wave}' is not a product wave (one a product red routes to, PRODUCT_WAVE)`);
    let res = runs.get(run);
    if (res === undefined) { res = load(run); runs.set(run, res); }
    if (res.harnessCommit !== sha) throw new FindingsRefused(`row ${r.n}: ${run} ran at ${res.harnessCommit}, TRIAGE says ${sha}`);
    const kase = res.cases.find((k) => k.caseId === r.caseId);
    if (kase === undefined) throw new FindingsRefused(`row ${r.n}: ${r.caseId} is not in ${run}`);
    if (kase.state !== "red") throw new FindingsRefused(`row ${r.n}: ${r.caseId} is ${kase.state} on ${run}, TRIAGE says product`);
    let failing = kase.checks.filter((k) => k.verdict === "fail").map((k) => k.id);
    if (failing.length === 0) {
      // An error red fails no check: its reason is the product's refusal.
      if (!kase.reason.startsWith("error: ")) throw new FindingsRefused(`row ${r.n}: ${r.caseId} is red on ${run} with no failing check and no error reason`);
      failing = [`error red — ${kase.reason.replace(/^error: /, "").replace(UUID, "<id>")}`];
    }
    out.push({ n: r.n, caseId: r.caseId, failing, run, wave, rule: shortRule(r.rule) });
  }
  if (out.length === 0) throw new FindingsRefused(`no product row among ${rows.length} TRIAGE row(s) — the table would be empty`);
  const num = (w: string): number => Number(w.slice(1));
  out.sort((a, b) => num(a.wave) - num(b.wave) || a.n - b.n);
  const byWave: Record<string, number> = {};
  for (const r of out) byWave[r.wave] = (byWave[r.wave] ?? 0) + 1;
  return { rows: out, byWave, files: runs.size };
}

const esc = (s: string): string => s.replace(/\|/g, "\\|");

export function renderFindings(rows: readonly FindingRow[]): string {
  return [
    "| wave | TRIAGE # | case | failing checks (on the run it is judged on) | judged on | rule |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.wave} | ${r.n} | \`${esc(r.caseId)}\` | ${r.failing.join(", ")} | \`${r.run}\` | ${esc(r.rule)} |`),
  ].join("\n") + "\n";
}

const why = (e: unknown): string => redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Unreadable input: exit 2 like a refusal (D8) — the two are told apart by the name on stderr. */
class Unreadable extends Error {
  constructor(why: string) {
    super(why);
    this.name = "Unreadable";
  }
}

function parseCli(argv: readonly string[]): { triage: string; truthRuns: string; out: string | undefined } | { usage: string } {
  try {
    const { positionals, values } = parseArgs({ args: argv.filter((a) => a !== "--"), allowPositionals: true, options: { out: { type: "string" } } });
    const [triage, truthRuns, ...extra] = positionals;
    if (triage === undefined || truthRuns === undefined || extra.length > 0) return { usage: USAGE };
    return { triage, truthRuns, out: values.out };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

export function main(argv: readonly string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) { process.stderr.write(`${cli.usage}\n`); return 2; }
  let md: string;
  try { md = readFileSync(cli.triage, "utf8"); } catch (e) { process.stderr.write(`findings-table: ${why(e)}\n`); return 2; }
  const load = (run: string): RunLike => {
    const file = join(cli.truthRuns, run, "results.json");
    try { return parseResults(JSON.parse(readFileSync(file, "utf8"))); } catch (e) { throw new Unreadable(`${file}: ${why(e)}`); }
  };
  let f: Findings;
  try {
    f = findings(triageRows(md), load);
  } catch (e) {
    process.stderr.write(`findings-table: ${why(e)}\n`);
    if (e instanceof Unreadable || e instanceof FindingsRefused) return 2;
    throw e;
  }
  const table = renderFindings(f.rows);
  if (cli.out === undefined) process.stdout.write(table);
  else { mkdirSync(dirname(cli.out), { recursive: true }); writeFileSync(cli.out, table); }
  process.stderr.write(`${JSON.stringify({ productRows: f.rows.length, byWave: f.byWave, files: f.files })}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
