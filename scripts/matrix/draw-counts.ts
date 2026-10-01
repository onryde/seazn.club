// CLI (W1-driving T15 fix round 1, ruling T15-R8 m-2): every case's drawn
// fixtures, read from the env's OWN database after a run, so TRIAGE's P1
// precondition ("the run's DB shows ≥1 drawn fixture") is committed evidence
// instead of an uncommitted probe.
//
//   node --experimental-strip-types --import ./scripts/matrix/lib/crash-exit.ts \
//     scripts/matrix/draw-counts.ts <run dir>... --out <file.json>
//
// Each run dir holds a results.json; its case ids are the cases counted. A
// case's competition is the one the scenario created for it, named
// `Matrix <caseId>` (scenarios/common.ts setUpDivision). A drawn fixture is
// one whose stored outcome kind is "draw"; a BRACKET draw is one on a stage
// of a kind I2 judges — the invariant's own declaration (invariants.ts I2
// stageKinds), never a list typed here.
//
// Refuses (exit 1, nothing written): a case with no competition or with two
// (the name no longer identifies it), and zero cases counted. Like
// seed-org.ts it refuses a database it cannot prove is its own:
// BENCH_EXPECTED_DATA_DIR is mandatory and `show data_directory` must equal it.
// Exit 2 is a usage error, 3 an unreadable results.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { INVARIANTS } from "./lib/invariants.ts";
import { isMainModule } from "./lib/main-module.ts";
import { redact } from "./lib/redact.ts";
import { parseResults } from "./lib/results.ts";
import { DataDirMismatch, requireOwnDataDir } from "./lib/seed-org.ts";

const USAGE = "usage: draw-counts.ts <run dir>... --out <file.json>";

/** One stage of one competition, as the query returns it. */
export interface StageRow { readonly competition: string; readonly competitionId: string; readonly seq: number; readonly kind: string; readonly fixtures: number; readonly drawn: number }

export interface CaseDraws {
  readonly run: string;
  readonly drawn: number;
  readonly bracketDrawn: number;
  readonly stages: readonly { readonly seq: number; readonly kind: string; readonly fixtures: number; readonly drawn: number }[];
}

export interface DrawCounts { readonly checked: number; readonly bracketKinds: readonly string[]; readonly cases: Readonly<Record<string, CaseDraws>> }

export class DrawCountRefused extends Error {
  constructor(why: string) {
    super(`draw-counts: ${why}`);
    this.name = "DrawCountRefused";
  }
}

/** The stage kinds a bracket draw is counted on: I2's own declaration. */
export function bracketKinds(): readonly string[] {
  const i2 = INVARIANTS.find((i) => i.id.startsWith("I2-"));
  if (i2 === undefined || i2.stageKinds === "any" || i2.stageKinds.length === 0) throw new DrawCountRefused("invariants.ts declares no I2 bracket stage kinds — there is no bracket to count draws on");
  return i2.stageKinds;
}

export const competitionName = (caseId: string): string => `Matrix ${caseId}`;

/** Per-case draws from the stage rows. `cases` maps each case id to the run
 *  that drove it. Every case must own exactly one competition. */
export function drawCounts(cases: ReadonlyMap<string, string>, rows: readonly StageRow[], brackets: readonly string[] = bracketKinds()): DrawCounts {
  if (cases.size === 0) throw new DrawCountRefused("zero cases to count — a sweep over nothing is not evidence");
  const out: Record<string, CaseDraws> = {};
  for (const [caseId, run] of cases) {
    const mine = rows.filter((r) => r.competition === competitionName(caseId));
    const ids = new Set(mine.map((r) => r.competitionId));
    if (ids.size !== 1) throw new DrawCountRefused(`${caseId}: ${ids.size} competitions named "${competitionName(caseId)}" — exactly one identifies the case (a fresh env holds one per case)`);
    const stages = [...mine].sort((a, b) => a.seq - b.seq).map((r) => ({ seq: r.seq, kind: r.kind, fixtures: r.fixtures, drawn: r.drawn }));
    out[caseId] = {
      run,
      drawn: stages.reduce((n, s) => n + s.drawn, 0),
      bracketDrawn: stages.filter((s) => brackets.includes(s.kind)).reduce((n, s) => n + s.drawn, 0),
      stages,
    };
  }
  return { checked: cases.size, bracketKinds: [...brackets], cases: out };
}

/** Each run dir's case ids, keyed to the dir; a case in two runs is refused (its competition name would repeat). */
export function casesOf(runs: readonly { readonly dir: string; readonly caseIds: readonly string[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of runs) for (const id of r.caseIds) {
    const prior = out.get(id);
    if (prior !== undefined) throw new DrawCountRefused(`${id} is in ${prior} and ${r.dir} — one env holds one competition per case`);
    out.set(id, r.dir);
  }
  return out;
}

const QUERY = `select c.name as competition, c.id::text as "competitionId", s.seq, s.kind,
    count(f.id)::int as fixtures, (count(f.id) filter (where f.outcome->>'kind' = 'draw'))::int as drawn
  from seazn_club.competitions c
  join seazn_club.divisions d on d.competition_id = c.id
  join seazn_club.stages s on s.division_id = d.id
  left join seazn_club.fixtures f on f.stage_id = s.id
  where c.name = any($1::text[])
  group by c.id, c.name, s.id, s.seq, s.kind`;

export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let dirs: string[], out: string | undefined;
  try {
    const p = parseArgs({ args: argv.filter((a) => a !== "--"), allowPositionals: true, options: { out: { type: "string" } } });
    dirs = p.positionals;
    out = p.values.out;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  if (dirs.length === 0 || out === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let runs: { dir: string; caseIds: string[]; harness: string }[];
  try {
    runs = dirs.map((dir) => {
      const r = parseResults(JSON.parse(readFileSync(join(dir, "results.json"), "utf8")));
      return { dir: r.runId, caseIds: r.cases.map((c) => c.caseId), harness: r.harnessCommit };
    });
  } catch (e) {
    process.stderr.write(`draw-counts: ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}\n`);
    return 3;
  }
  const expected = requireOwnDataDir(env);
  const url = env.DATABASE_URL;
  if (url === undefined || url === "") throw new DrawCountRefused("DATABASE_URL is unset");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const cases = casesOf(runs);
    const [{ data_directory: actual }] = await sql<{ data_directory: string }[]>`show data_directory`;
    if (actual !== expected) throw new DataDirMismatch(expected, actual);
    const rows = await sql.unsafe<StageRow[]>(QUERY, [[...cases.keys()].map(competitionName)]);
    const counts = drawCounts(cases, rows);
    const harness = [...new Set(runs.map((r) => r.harness))];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${redact(JSON.stringify({ script: "scripts/matrix/draw-counts.ts", harness, runs: runs.map((r) => r.dir), ...counts }, null, 2))}\n`);
    const withBracket = Object.values(counts.cases).filter((c) => c.bracketDrawn > 0).length;
    process.stdout.write(`draw-counts: ${counts.checked} case(s) over ${runs.length} run(s); ${withBracket} with ≥1 bracket draw → ${out}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof DrawCountRefused) && !(e instanceof DataDirMismatch)) throw e;
    process.stderr.write(`${redact(e.message)}\n`);
    return 1;
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
