// CLI: pnpm run matrix:triage --runs <results.json>... --out <dir> [--rekey <results.json> --rekey-map <p-map.json>]
//        [--catalogue <dir>] [--audit <dir>]
// W1d Task 18 (ruling 63, D18): keys every red of the given runs to ONE audit gap id (or a NEW- id) and its design §8
// wave, by the committed rules in catalogue/triage-rules.json read against catalogue/gap-routing.json. Writes
// <dir>/triage.json (the ledger reads it), <dir>/TRIAGE.md (per wave, per gap, the case list) and, with --rekey,
// <dir>/REKEY.md (each case a P-rule keyed, with the gap it now has; a run without --rekey removes the REKEY.md an earlier
// run left in <dir>). One run per layer: L1, L2 and L3 triage together.
// Exit codes, each with one meaning:
//   0  every red is triaged: the files are written (zero reds is a verdict too, and is said);
//   1  a negative signal, the files still written so a reviewer reads them: a red no rule matches, a red two rules
//      match, a rule that routes a gap away from design §8, a rule naming a gap the audit and new-gaps.json do not
//      hold, or (with --rekey) a rule whose `was` names a different P-rule than the map gives the case it keyed, or
//      a re-key that compared no `was` at all (vacuous) — each listed on stdout;
//   2  usage or input error, with a message on stderr and nothing written: a missing --runs or --out, an unknown
//      flag, a run file that is unreadable, not JSON, not a results.json or not a v3 run, two runs of one layer, runs
//      with no case at all, a layer whose run holds none (its neighbours' cases would hide it), a catalogue file (a
//      rule with an empty match among them) or audit directory that is unreadable, or a P-rule map that is
//      unreadable or names a case the --rekey results do not hold;
//   3  a crash while it loads, through `pnpm run matrix:triage` (its preload, scripts/lib/crash-exit.ts). Run it only
//      through that script: without the preload a load crash exits 1.
// An uncaught throw would exit 1 without the preload, so every input failure is caught here. Every line printed and
// every file written passes through redact().
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isMainModule } from "../../scripts/lib/main-module.ts";
import { AUDIT_DIR, readAudit } from "./lib/audit-ledger.ts";
import { EXIT_CODES } from "./lib/exit-codes.ts";
import { mapStrings, redact } from "./lib/redact.ts";
import { parseResults, type AnyRunResults, type CaseResult } from "./lib/results.ts";
import {
  CATALOGUE_DIR, TriageRefused, isClean, loadCatalogue, parseTriage, rekey, renderRekey, renderTriage, triage, triageJson, unkeyedReds, wasChecked, wasConflicts,
  type TriageRun, type TriageRefusalName,
} from "./lib/triage.ts";

const USAGE = "usage: triage.ts --runs <results.json>... --out <dir> [--rekey <results.json> --rekey-map <p-map.json>] [--catalogue <dir>] [--audit <dir>]";
/** Stdout lists at most this many lines per kind of finding: triage.json has every one. */
const SHOWN = 50;

interface Cli { runs: string[]; out: string; rekey: string | null; rekeyMap: string | null; catalogue: string; audit: string }

function parseCli(argv: string[]): Cli | { usage: string } {
  try {
    // pnpm 10 forwards the `--` of `pnpm run matrix:triage -- <flags>`; a bare one is never a run file.
    const { positionals, values } = parseArgs({
      args: argv.filter((a) => a !== "--"),
      allowPositionals: true,
      options: { runs: { type: "string", multiple: true }, out: { type: "string" }, rekey: { type: "string" }, "rekey-map": { type: "string" }, catalogue: { type: "string" }, audit: { type: "string" } },
    });
    // `--runs a b c` leaves b and c as positionals: they are run files too.
    const runs = [...(values.runs ?? []), ...positionals];
    if (runs.length === 0 || values.out === undefined) return { usage: USAGE };
    if ((values.rekey === undefined) !== (values["rekey-map"] === undefined)) return { usage: `--rekey and --rekey-map go together\n${USAGE}` };
    return { runs, out: values.out, rekey: values.rekey ?? null, rekeyMap: values["rekey-map"] ?? null, catalogue: values.catalogue ?? CATALOGUE_DIR, audit: values.audit ?? AUDIT_DIR };
  } catch (e) {
    return { usage: `${e instanceof Error ? e.message : String(e)}\n${USAGE}` };
  }
}

function refusal(name: TriageRefusalName, message: string): TriageRefused {
  return new TriageRefused(name, message);
}

/** A results.json the CLI reads: unreadable, not JSON and not a results.json are each named. */
function readResults(file: string): AnyRunResults {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw refusal("RunUnreadable", `${file}: cannot read — ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw refusal("RunUnreadable", `${file}: not JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parseResults(json);
  } catch (e) {
    const why = e instanceof z.ZodError ? e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") : String(e);
    throw refusal("RunUnreadable", `${file}: not a results.json — ${why}`);
  }
}

function readRun(file: string): TriageRun {
  const r = readResults(file);
  if (r.schemaVersion !== 3) throw refusal("RunNotV3", `${file}: a v${r.schemaVersion} results.json has no layer — the triage reads v3 runs`);
  return { layer: r.layer, runId: r.runId, plan: r.plan, cases: r.cases };
}

/** The P-rule map: { "<caseId>": "P1" }, a non-empty string for each. */
function readMap(file: string): Record<string, string> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw refusal("RekeyMapUnreadable", `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = z.record(z.string().min(1), z.string().min(1)).safeParse(json);
  if (!parsed.success) throw refusal("RekeyMapUnreadable", `${file}: a P-rule map is one object of { "<case id>": "<P-rule>" }, each value a non-empty string`);
  return parsed.data;
}

/** A red's reason can run to hundreds of characters; stdout keeps its head and triage.json's cases hold the rest. */
const REASON_SHOWN = 160;
const short = (reason: string): string => (reason.length <= REASON_SHOWN ? reason : `${reason.slice(0, REASON_SHOWN)}…`);

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The stdout lines of one kind of finding, capped. */
function capped(lines: readonly string[]): string[] {
  return lines.length <= SHOWN ? [...lines] : [...lines.slice(0, SHOWN), `… and ${lines.length - SHOWN} more (triage.json has every one)`];
}

export function main(argv: string[]): number {
  const cli = parseCli(argv);
  if ("usage" in cli) {
    process.stderr.write(`triage: ${redact(cli.usage)}\n`);
    return 2;
  }
  const say = (line: string): void => { process.stdout.write(`${redact(line)}\n`); };
  try {
    const catalogue = loadCatalogue(cli.catalogue);
    const audit = readAudit(cli.audit);
    const ledger = [...audit.gaps, ...audit.umbrellas];
    const titles = new Map<string, string>([...ledger.map((g) => [g.id, g.title] as const), ...catalogue.newGaps.gaps.map((g) => [g.id, g.title] as const)]);
    const runs = cli.runs.map(readRun);
    const keyed = cli.rekey === null ? null : readResults(cli.rekey);
    const pMap = cli.rekeyMap === null ? null : readMap(cli.rekeyMap);

    const result = triage(runs, catalogue.rules, catalogue.routing, ledger, catalogue.newGaps);
    const rekeyed = keyed === null || pMap === null ? null : { rows: rekey(keyed, pMap, result), unkeyed: unkeyedReds(keyed, pMap) };

    // Everything is judged before anything is written: a refusal leaves no directory behind.
    const json = parseTriage(triageJson(result, runs, titles));
    mkdirSync(cli.out, { recursive: true });
    writeFileSync(join(cli.out, "triage.json"), `${JSON.stringify(mapStrings(json, redact), null, 2)}\n`);
    writeFileSync(join(cli.out, "TRIAGE.md"), redact(renderTriage(result, titles)));
    // REKEY.md belongs to the run that wrote it: a run that does not re-key leaves none from an earlier run beside its files.
    if (rekeyed === null) rmSync(join(cli.out, "REKEY.md"), { force: true });
    else writeFileSync(join(cli.out, "REKEY.md"), redact(renderRekey(rekeyed.rows, result, rekeyed.unkeyed)));

    const at = new Map<string, CaseResult>(runs.flatMap((r) => r.cases.map((c) => [c.caseId, c] as const)));
    say(`${plural(result.scanned, "case")} in ${plural(runs.length, "run")}; ${result.checked} reds checked: ${result.rows.length} triaged, ${result.untriaged.length} untriaged, ${result.ambiguous.length} ambiguous, ${result.misrouted.length} misrouted, ${result.unknownGap.length} unknown`);
    for (const l of capped(result.untriaged.map((id) => `untriaged ${id} (${at.get(id)?.layer ?? "?"}) — ${short(at.get(id)?.reason ?? "")}`))) say(l);
    for (const l of capped(result.ambiguous.map((a) => `ambiguous ${a.caseId} — ${a.rules.join(", ")}`))) say(l);
    for (const l of capped(result.misrouted.map((m) => `misrouted ${m.rule}: ${m.gap} ${m.routed === null ? "has no route in design §8" : `is ${m.routed} in design §8`}, the rule says ${m.wave}`))) say(l);
    for (const l of capped(result.unknownGap.map((u) => `unknown gap ${u.rule}: ${u.gap} is in neither the audit ledger nor new-gaps.json`))) say(l);
    const conflicts = rekeyed === null ? [] : wasConflicts(rekeyed.rows);
    if (rekeyed !== null) {
      const re = rekeyed.rows.filter((r) => r.now !== null).length;
      say(`rekey: ${plural(rekeyed.rows.length, "mapped case")}, ${re} re-keyed, ${rekeyed.rows.length - re} with no gap in the triage; ${rekeyed.unkeyed.length} reds the map does not key; was checked on ${plural(wasChecked(rekeyed.rows), "mapped case")}, ${conflicts.length} disagree`);
    }
    for (const l of capped(conflicts.map((x) => `was conflict ${x.caseId}: the map says ${x.was}, rule ${x.rule} says ${x.ruleWas}`))) say(l);
    // N3: a re-key that compared no `was` with the map proves nothing, and "0 disagree" over zero comparisons read as a pass.
    const vacuous = rekeyed !== null && wasChecked(rekeyed.rows) === 0;
    if (vacuous) say("rekey checked no `was`: no rule that keyed a mapped case names a P-rule, so a re-key that compared nothing proves nothing (vacuous)");
    const code = isClean(result) && conflicts.length === 0 && !vacuous ? 0 : 1;
    say(`exit ${code}: ${EXIT_CODES[code]}`);
    return code;
  } catch (e) {
    // The refusal's NAME is ours and is printed as it is: redact() reads `Name: <path>:` as a key/value pair and would
    // print `[redacted]` in its place. The message passes through redact().
    process.stderr.write(`triage: ${e instanceof Error ? `${e.name}: ${redact(e.message)}` : redact(String(e))}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
