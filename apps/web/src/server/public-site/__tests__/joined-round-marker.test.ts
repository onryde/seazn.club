// W5 app PR A, Task 5b (X-CU-10; RB5-L5: no missed round is scored as a loss) - a late entrant's table row reads "Joined round N"
// while any of its catch-up lines (`rr-cu-` / `rr-by-`) is undecided, and goes quiet the moment the last one is decided, the
// stage is rebuilt, or the entrant leaves the field.
//
// Driven through the REAL producer and consumer: the organiser's add (`createEntrants` writes the `roundrobin_late_entry` ledger
// row and the catch-up lines), then the public read path (`loadRrLateJoins` -> `rowFactsFor` -> `rowMarkers`, the very chain the
// hub, the division page, the embed and the live page call) over the stage's stored fixtures and the real standings fold.
//
// differential: today (7c65bb52f7) a league row never carries a marker - `swissRowFactsFor` answers undefined for any stage that
// is not Swiss - so every "reads Joined round 3" assertion is red on it.
//
// Expected values: the joined round is RB5-L5's hand count (rounds 1 and 2 started, so the newcomer joins round 3); the marker's
// words are the en dictionary's; the played count is the number of lines this test decided itself. Never read back from the fold.
//
// Sports: cricket (a team sport whose play is one helper away) carries the lifecycle; badminton repeats the marker's open/close
// edge so a second sport's roster, variant and entrant kind meet the same read.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { StandingsRow } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, getStandings, rebuildStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { DEPARTED_STATUS_CHIPS } from "@/components/public-site/standings-table";
import { rowMarkers } from "../standings-view";
import { swissRowFactsFor } from "../swiss-row-facts";
import { loadRrLateJoins, rowFactsFor, tableRowFacts, type RrLateJoin } from "../table-row-facts";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const EN = en as unknown as Dict;
const msg = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t(EN, key, vars);

type Kind = "individual" | "pair" | "team";
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  kind: Kind;
  sport: string;
  id: Map<string, string>;
  name: Map<string, string>;
}

async function started(n: number, sport: string, variant: string): Promise<Rig> {
  const kind = (moduleOf(sport).entrantModel?.defaultKind ?? "individual") as Kind;
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "W5 T5b " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "o-" + randomUUID().slice(0, 6), sport_key: sport, variant_key: variant, config: {} });
  const es = await createEntrants(
    auth,
    d.id,
    Array.from({ length: n }, (_, i) => ({ kind, display_name: `P${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Table", config: { legs: 1 }, progression: null });
  await startDivision(auth, d.id);
  return {
    auth,
    divisionId: d.id,
    stageId: stage!.id,
    kind,
    sport,
    id: new Map(es.map((e) => [e.display_name, e.id])),
    name: new Map(es.map((e) => [e.id, e.display_name])),
  };
}

async function addLate(rig: Rig, name: string): Promise<string> {
  const [row] = await createEntrants(rig.auth, rig.divisionId, [{ kind: rig.kind, display_name: name, seed: null, members: [] } as never]);
  rig.id.set(name, row!.id);
  rig.name.set(row!.id, name);
  return row!.id;
}

interface Line {
  id: string;
  round_no: number;
  ext_key: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

const lines = async (stageId: string): Promise<Line[]> => [
  ...(await sql<Line[]>`select id, round_no, ext_key, home_entrant_id, away_entrant_id, status from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`),
];

async function post(auth: AuthCtx, fixtureId: string, type: string, payload: unknown = {}) {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  return scoreEvent(auth, fixtureId, { expected_seq: n, type, payload } as never);
}

async function startRounds(rig: Rig, rounds: number[]): Promise<void> {
  const rows = await lines(rig.stageId);
  for (const r of rounds) await post(rig.auth, rows.find((x) => x.round_no === r)!.id, "core.start");
}

/** Decide one line: a played T20 for cricket (the first side makes 150, the chase falls short in its full quota); a double
 *  walkover elsewhere (a settled line is a settled line: the marker reads the status, not the sport). */
async function decide(rig: Rig, fixtureId: string): Promise<void> {
  await post(rig.auth, fixtureId, "core.start");
  if (rig.sport === "cricket") {
    const cfg = moduleOf("cricket").configSchema.parse(moduleOf("cricket").variants.t20) as { ballsPerInnings: number };
    await post(rig.auth, fixtureId, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: cfg.ballsPerInnings });
    const out = await post(rig.auth, fixtureId, "cricket.innings.summary", { runs: 100, wickets: 6, legalBalls: cfg.ballsPerInnings });
    expect(out.status, "rig: a played match is decided").toBe("decided");
  } else {
    await post(rig.auth, fixtureId, "core.forfeit", { by: "both", reason: "walkover" });
  }
}

const catchUpLinesOf = (rows: readonly Line[], entrantId: string): Line[] =>
  rows.filter((r) => /rr-(?:cu|by)-/.test(r.ext_key ?? "") && (r.home_entrant_id === entrantId || r.away_entrant_id === entrantId));

/** The marker words every row of the stage's table reads, by entrant name - through the same chain the public pages call. */
async function markers(rig: Rig): Promise<Record<string, string[]>> {
  const fixtures = await sql<(Line & { stage_id: string; outcome: unknown })[]>`
    select id, stage_id, round_no, ext_key, home_entrant_id, away_entrant_id, status, outcome from fixtures where division_id = ${rig.divisionId}`;
  const joins = await loadRrLateJoins(rig.divisionId, fixtures);
  const entrants = await sql<{ id: string; status: string }[]>`select id, status from entrants where division_id = ${rig.divisionId}`;
  const statuses = Object.fromEntries(entrants.map((e) => [e.id, e.status]));
  const snap = await getStandings(rig.auth, rig.stageId);
  const rows = snap.rows as StandingsRow[];
  expect(rows.length, "the table has rows to mark").toBeGreaterThan(0);
  const facts = rowFactsFor({ id: rig.stageId, kind: "league" }, fixtures, rows, joins, statuses);
  const out: Record<string, string[]> = {};
  for (const r of rows) out[rig.name.get(r.entrantId)!] = rowMarkers(facts?.[r.entrantId], msg).map((m) => m.text);
  return out;
}

const unmarked = (m: Record<string, string[]>) => Object.entries(m).filter(([, v]) => v.length === 0).map(([k]) => k).sort();

describe.skipIf(!HAS_DB)("W5 T5b: Joined round N on a late entrant's row (X-CU-10, RB5-L5)", () => {
  it("X-CU-10 a late entrant's row reads Joined round 3 while catch-up lines remain", async () => {
    const rig = await started(5, "cricket", "t20");
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const rows = await lines(rig.stageId);
    expect(catchUpLinesOf(rows, late), "premise: five catch-up lines, all undecided").toHaveLength(5);
    const m = await markers(rig);
    // RB5-L5: rounds 1 and 2 were started when she arrived, so she joined round 3.
    expect(m.Late).toEqual(["Joined round 3"]);
    expect(unmarked(m), "nobody else is marked (counted: the five that were there)").toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("X-CU-10 the marker goes when the last catch-up line is decided, and not before", async () => {
    const rig = await started(5, "cricket", "t20");
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const mine = catchUpLinesOf(await lines(rig.stageId), late);
    expect(mine).toHaveLength(5);
    let checked = 0;
    for (const [i, line] of mine.entries()) {
      expect((await markers(rig)).Late, `${i} of 5 decided: still marked`).toEqual(["Joined round 3"]);
      await decide(rig, line.id);
      checked++;
    }
    expect(checked, "every catch-up line was decided in turn").toBe(5);
    expect((await markers(rig)).Late, "the fifth decided: the marker is gone").toEqual([]);
  });

  it("X-CU-10 a missed round is not scored: played and points count only real results (RB5-L5)", async () => {
    const rig = await started(5, "cricket", "t20");
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    const mine = catchUpLinesOf(await lines(rig.stageId), late);
    // Decide two of her five lines. Three rounds are behind her and three lines are still owed: neither is a loss.
    for (const line of mine.slice(0, 2)) await decide(rig, line.id);
    const row = ((await getStandings(rig.auth, rig.stageId)).rows as StandingsRow[]).find((r) => r.entrantId === late)!;
    expect(row.played, "played = the two decided lines, nothing for the rounds she missed").toBe(2);
    expect(row.won + row.drawn + row.lost, "no missed round is booked as a loss").toBe(2);
  });

  it("X-CU-10 the marker goes after Rebuild", async () => {
    // differential: none - the read condition is this task's own (the ledger row outlives the lines; the prefix does not).
    const rig = await started(5, "cricket", "t20");
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    expect((await markers(rig)).Late, "premise: marked before the rebuild").toEqual(["Joined round 3"]);
    // Rebuild refuses a stage holding a result or a scoring event; take the two starts back out so it is allowed (setup, not the path).
    await sql`delete from score_events where fixture_id in (select id from fixtures where stage_id = ${rig.stageId})`;
    await sql`delete from match_states where fixture_id in (select id from fixtures where stage_id = ${rig.stageId})`;
    await sql`update fixtures set status = 'scheduled', config_snapshot = null where stage_id = ${rig.stageId}`;
    await rebuildStageFixtures(rig.auth, rig.stageId);
    const rows = await lines(rig.stageId);
    expect(catchUpLinesOf(rows, late), "the rebuilt table holds no catch-up line").toHaveLength(0);
    expect(rows.length, "premise: six entrants, a full round robin").toBe(15);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${rig.divisionId} and type = 'roundrobin_late_entry'`;
    expect(n, "the ledger row is still there: only the read condition ends the marker").toBe(1);
    expect((await markers(rig)).Late).toEqual([]);
    // The loader's own gate (no catch-up line anywhere: no ledger read) and the read condition each end the marker; neither may be the
    // only thing doing it. Past the gate the ledger row is still there and still says round 3 - so it is the undecided-line check that
    // keeps Rebuild's row quiet.
    const fixtures = await sql<(Line & { stage_id: string })[]>`select id, stage_id, round_no, ext_key, home_entrant_id, away_entrant_id, status from fixtures where division_id = ${rig.divisionId}`;
    expect(await loadRrLateJoins(rig.divisionId, fixtures), "the gate: nothing to catch up, nothing read").toEqual([]);
    const forced = await loadRrLateJoins(rig.divisionId, [{ ext_key: "rr-cu-r6-c1-L1" }]);
    expect(forced).toEqual([{ stageId: rig.stageId, entrantId: late, joinedRound: 3 }]);
    expect(tableRowFacts(fixtures, forced, { [late]: "registered" }), "the read condition: no undecided catch-up line").toEqual({});
  });

  it("X-CU-10 the marker goes when the entrant withdraws", async () => {
    const rig = await started(5, "cricket", "t20");
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    expect((await markers(rig)).Late, "premise: marked").toEqual(["Joined round 3"]);
    await withdrawEntrantCascade(rig.auth, late);
    const [{ status }] = await sql<{ status: string }[]>`select status from entrants where id = ${late}`;
    expect(status, "premise: withdrawn").toBe("withdrawn");
    // Her undecided lines are settled by the cascade, so only the active-entrant check can be what keeps the marker off if one remained.
    await sql`update fixtures set status = 'scheduled' where id = (select id from fixtures where stage_id = ${rig.stageId} and ext_key like '%rr-cu-%' and ${late} in (home_entrant_id, away_entrant_id) limit 1)`;
    const open = catchUpLinesOf(await lines(rig.stageId), late).filter((l) => l.status === "scheduled");
    expect(open.length, "premise: one catch-up line of hers is still undecided").toBeGreaterThan(0);
    expect((await markers(rig)).Late).toEqual([]);
  });

  it("X-CU-10 a second sport: badminton reads the same open and close", async () => {
    // single-sport reason: cricket carries the lifecycle above; badminton is the individual-entrant, set-scored sport.
    const rig = await started(5, "badminton", Object.keys(moduleOf("badminton").variants)[0]!);
    await startRounds(rig, [1, 2]);
    const late = await addLate(rig, "Late");
    expect((await markers(rig)).Late).toEqual(["Joined round 3"]);
    for (const line of catchUpLinesOf(await lines(rig.stageId), late)) await decide(rig, line.id);
    expect((await markers(rig)).Late).toEqual([]);
  });
});

describe("X-CU-10 tableRowFacts (pure): the empty case first, then every edge of the read condition", () => {
  const fx = (over: Partial<{ id: string; round_no: number; ext_key: string | null; home: string | null; away: string | null; status: string }> = {}) => ({
    stage_id: "s1",
    round_no: over.round_no ?? 6,
    ext_key: over.ext_key === undefined ? "rr-cu-r6-c1-L1" : over.ext_key,
    home_entrant_id: over.home === undefined ? "late" : over.home,
    away_entrant_id: over.away === undefined ? "p1" : over.away,
    outcome: null,
    status: over.status ?? "scheduled",
  });
  const join = (over: Partial<RrLateJoin> = {}): RrLateJoin => ({ stageId: "s1", entrantId: "late", joinedRound: 3, ...over });
  const field = { late: "registered", p1: "registered" };

  it("nothing to read marks nobody: no fixtures, no joins, no entrants", () => {
    expect(tableRowFacts([], [], {})).toEqual({});
    expect(tableRowFacts([fx()], [], field), "catch-up lines but no ledger row: nothing says which round she joined").toEqual({});
    expect(tableRowFacts([], [join()], field), "a ledger row but no line left").toEqual({});
  });

  it("a marked entrant carries the joined round and the catch-up flag; the byes are left to the round bar's Sits out", () => {
    expect(tableRowFacts([fx()], [join()], field)).toEqual({ late: { byeRounds: [], joinedRound: 3, catchUp: true } });
  });

  it("the three open statuses keep it, every settled one drops it (counted)", () => {
    const open = ["scheduled", "in_play", "needs_decision"];
    const settled = ["decided", "finalized", "abandoned", "forfeited", "cancelled"];
    for (const s of open) expect(Object.keys(tableRowFacts([fx({ status: s })], [join()], field)), s).toEqual(["late"]);
    for (const s of settled) expect(tableRowFacts([fx({ status: s })], [join()], field), s).toEqual({});
    expect(open.length + settled.length, "every fixture status is classified").toBe(8);
  });

  it("only the entrant's OWN undecided catch-up lines count: an ordinary line, another stage, or another entrant's line does not", () => {
    expect(tableRowFacts([fx({ ext_key: "rr-r6-c1-L1" })], [join()], field), "a generated line is not a catch-up line").toEqual({});
    expect(tableRowFacts([fx({ home: "p1", away: "p2" })], [join()], field), "not hers").toEqual({});
    expect(tableRowFacts([{ ...fx(), stage_id: "s2" }], [join()], field), "another stage's line").toEqual({});
    expect(tableRowFacts([fx()], [join({ stageId: "s2" })], field), "another stage's ledger row").toEqual({});
    expect(Object.keys(tableRowFacts([fx({ ext_key: "p1-rr-by-r3-c2-L1", home: "p1", away: "late" })], [join()], field)), "a bye-slot line in a pool counts").toEqual(["late"]);
  });

  it("a departed entrant is never marked, for every departed status (counted)", () => {
    const departed = Object.keys(DEPARTED_STATUS_CHIPS);
    expect(departed.length, "the table's own vocabulary names departures").toBeGreaterThan(0);
    for (const s of departed) expect(tableRowFacts([fx()], [join()], { ...field, late: s }), s).toEqual({});
  });

  it("joined round 1 is no late join: nothing had started, so nothing was missed", () => {
    expect(tableRowFacts([fx()], [join({ joinedRound: 1 })], field)).toEqual({});
  });

  it("the words: Joined round N with its own title; a Swiss row's markers are untouched (pin)", () => {
    const [m] = rowMarkers({ byeRounds: [], joinedRound: 3, catchUp: true }, msg);
    expect(m).toMatchObject({ kind: "late", text: "Joined round 3" });
    expect(m!.title).toContain("round 3");
    const swiss = rowMarkers({ byeRounds: [2], joinedRound: 3 }, msg);
    expect(swiss.map((x) => x.text)).toEqual(["From R3", "Bye R2"]);
  });

  it("rowFactsFor: a Swiss stage answers exactly swissRowFactsFor; a table stage never reads the Swiss path", () => {
    const rows = [{ entrantId: "late" }, { entrantId: "p1" }];
    const f = [fx()];
    expect(rowFactsFor({ id: "s1", kind: "swiss" }, f, rows, [join()], field)).toEqual(swissRowFactsFor({ id: "s1", kind: "swiss" }, f, rows));
    expect(rowFactsFor({ id: "s1", kind: "league" }, f, rows, [join()], field)).toEqual({ late: { byeRounds: [], joinedRound: 3, catchUp: true } });
    expect(rowFactsFor({ id: "s1", kind: "group" }, f, rows, [join()], field)).toEqual({ late: { byeRounds: [], joinedRound: 3, catchUp: true } });
    expect(rowFactsFor({ id: "s1", kind: "knockout" }, f, rows, [join()], field), "a bracket has no table row to mark").toBeUndefined();
  });
});
