// W4 Task 2 (K4, X-LE-9) — THE "this match has started" predicate, `fixtureStartedSql` and `stageHasStarted`
// (usecases/fixture-started-sql.ts): one row per arm and one per exemption, each read through the real writer that
// produces the state (scoring, Match Day's call and Undo call, the board's move, the generator's bye, Swiss Pair).
//
// Expected answers are the RULES', never the code's: W3 spec §4 "started" and owner ruling 257 — a result or any
// recorded evidence starts a match; so does a Match Day call that still holds (the match on the court and at the time the
// call put it); a decided line starts it unless it is a bye. NOT a start: a call Undo call deleted, a call a board edit
// has moved, a bye (a system bye of any format, a Swiss bye shell), a device link (T9 re-ruling I1).
//
// Pre-flight ruling D1: `swissBoardStartedSql` is now a re-export of this predicate, so no row here asks it the same
// question twice (a re-export cannot disagree with itself). What the re-export DOES change for every Swiss caller — the
// bye exemption grows from the Swiss shell to any system bye — has its own differential at the end, read through a Swiss
// consumer (`listSwissRoundControls`'s `started`), red on main.
//
// One sport: the predicate reads no sport column (generic for the result rows; the bye rows are the generator's own).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { systemByeSql } from "@/server/engine-db/system-bye-sql";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { fixtureCalledSql, fixtureStartedSql, stageHasStarted } from "../fixture-started-sql";
import { swissByeShellSql } from "../fixture-results-sql";
import { callFixtureToCourt, LIVE_CALL_ALIASES, undoCall } from "../match-day-call";
import { moveFixture } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures } from "../stages";
import { listSwissRoundControls } from "../swiss-rounds-admin";
import { createCourt, createVenue } from "../venues";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

interface Fx {
  id: string;
  round_no: number;
  seq_in_round: number;
  ext_key: string | null;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; reason?: string; winner?: string } | null;
}

async function fixturesOf(stageId: string): Promise<Fx[]> {
  return sql<Fx[]>`
    select id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, outcome
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** The predicate's answer on each row, read over the fixtures row aliased `f` (the alias every caller uses). */
async function startedOf(ids: readonly string[]): Promise<Map<string, boolean>> {
  const rows = await sql<{ id: string; started: boolean }[]>`
    select f.id, ${fixtureStartedSql(sql as never, "f")} as started from fixtures f where f.id in ${sql(ids)}`;
  return new Map(rows.map((r) => [r.id, r.started]));
}

/** The two bye shapes on a row, for the premises below. */
async function byeShapesOf(id: string): Promise<{ system: boolean; shell: boolean }> {
  const [r] = await sql<{ system: boolean; shell: boolean }[]>`
    select ${systemByeSql(sql, "f")} as system, ${swissByeShellSql(sql, "f")} as shell from fixtures f where f.id = ${id}`;
  return r!;
}

async function division(auth: AuthCtx, sport: { sport_key: string; variant_key: string; config: Record<string, unknown> }) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Started " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  return createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), ...sport });
}

async function entrants(auth: AuthCtx, divisionId: string, n: number): Promise<string[]> {
  const made = await createEntrants(
    auth,
    divisionId,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  return made.map((e) => e.id);
}

const GENERIC = { sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG };

async function append(auth: AuthCtx, fixtureId: string, expectedSeq: number, type: string, payload: unknown) {
  return scoreEvent(auth, fixtureId, { expected_seq: expectedSeq, type, payload });
}

describe.skipIf(!HAS_DB)("X-LE-9 fixtureStartedSql: one row per arm and per exemption", () => {
  it("the empty case first: a stage with no fixtures has not started", async () => {
    const { auth } = await seedOrg();
    const div = await division(auth, GENERIC);
    await entrants(auth, div.id, 4);
    const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "L", config: {}, progression: null });
    expect(await fixturesOf(stage!.id), "premise: nothing generated").toEqual([]);
    expect(await sql.begin((tx) => stageHasStarted(tx as never, stage!.id))).toBe(false);
  });

  it("X-LE-9 a result, evidence, a decided line and a live call start a match; an untouched line, an undone or moved call and a device link do not", async () => {
    const { auth } = await seedOrg();
    const div = await division(auth, GENERIC);
    await entrants(auth, div.id, 6);
    const [stage] = await createStages(auth, div.id, { seq: 1, kind: "league", name: "L", config: {}, progression: null });
    await generateStageFixtures(auth, stage!.id);
    await sql`update divisions set status = 'active' where id = ${div.id}`;
    const all = await fixturesOf(stage!.id);
    expect(await sql.begin((tx) => stageHasStarted(tx as never, stage!.id)), "premise: a fresh board has not started").toBe(false);

    // Round one's three lines share no entrant, so each can be called without its players being busy elsewhere.
    const r1 = all.filter((f) => f.round_no === 1);
    const rest = all.filter((f) => f.round_no !== 1);
    expect([r1.length, rest.length >= 6], "premise: three disjoint round-one lines and six more").toEqual([3, true]);
    const [calledLive, calledUndone, calledMoved] = r1 as [Fx, Fx, Fx];
    const [untouched, noted, inPlay, decided, linked, walkedOver] = rest as [Fx, Fx, Fx, Fx, Fx, Fx];

    const venue = await createVenue(auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
    const courts = [];
    for (const name of ["Court 1", "Court 2", "Court 3", "Court 4"]) {
      courts.push((await createCourt(auth, venue.id, { name, sort: courts.length, tags: [] })).id);
    }
    await callFixtureToCourt(auth, calledLive.id, courts[0]!);
    await callFixtureToCourt(auth, calledUndone.id, courts[1]!);
    await undoCall(auth, calledUndone.id);
    await callFixtureToCourt(auth, calledMoved.id, courts[2]!);
    await moveFixture(auth, calledMoved.id, { court_id: courts[3]!, venue_id: venue.id });

    await append(auth, noted.id, 0, "core.note", { text: "coin toss done" });
    await append(auth, inPlay.id, 0, "core.start", {});
    await append(auth, decided.id, 0, "core.start", {});
    await append(auth, decided.id, 1, "generic.result", { p1Score: 2, p2Score: 0 });
    await sql`
      insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
      values (${auth.orgId}, ${linked.id}, ${"w4t2-" + randomUUID()}, null, ${auth.userId}, null)`;
    // An import's two-sided walkover: settled, no event behind it (the decided arm's own case, ruling 257's predicate).
    await sql`
      update fixtures set status = 'forfeited',
             outcome = ${sql.json({ kind: "award", winner: walkedOver.home_entrant_id, loser: walkedOver.away_entrant_id, reason: "withdrew" } as never)}
       where id = ${walkedOver.id}`;

    const after = new Map((await fixturesOf(stage!.id)).map((f) => [f.id, f]));
    expect(after.get(noted.id)!.status, "premise: a note leaves the line scheduled").toBe("scheduled");
    expect(after.get(inPlay.id)!.status).toBe("in_play");
    expect(after.get(decided.id)!.status).toBe("decided");
    for (const f of [calledLive, calledUndone, calledMoved]) expect(after.get(f.id)!.status, "premise: a call writes no status").toBe("scheduled");
    const calls = await sql<{ fixture_id: string }[]>`select fixture_id from fixture_calls where fixture_id in ${sql(r1.map((f) => f.id))}`;
    expect(calls.map((c) => c.fixture_id).sort(), "premise: Undo call deleted its row; the moved call's row stays").toEqual(
      [calledLive.id, calledMoved.id].sort(),
    );

    const want: [string, Fx, boolean][] = [
      ["an untouched seated line", untouched, false],
      ["a score event (a note: still scheduled)", noted, true],
      ["in play", inPlay, true],
      ["decided", decided, true],
      ["a two-sided walkover with no event", walkedOver, true],
      ["a live Match Day call", calledLive, true],
      ["a call Undo call deleted", calledUndone, false],
      ["a call whose match the board moved to another court", calledMoved, false],
      ["a device link only", linked, false],
    ];
    const got = await startedOf(want.map(([, f]) => f.id));
    let checked = 0;
    for (const [label, f, started] of want) {
      expect(got.get(f.id), label).toBe(started);
      checked++;
    }
    expect(checked, "anti-vacuity: every row asked").toBe(want.length);
    expect(await sql.begin((tx) => stageHasStarted(tx as never, stage!.id)), "the stage has started").toBe(true);
  });

  it("X-LE-9 a system bye (a knockout's structural bye) and a Swiss bye shell are not a start — each exempt on its own", async () => {
    const { auth } = await seedOrg();
    // A knockout of three: the generator awards its one structural bye (W2b C-5).
    const koDiv = await division(auth, GENERIC);
    await entrants(auth, koDiv.id, 3);
    const [ko] = await createStages(auth, koDiv.id, { seq: 1, kind: "knockout", name: "Cup", config: {}, progression: null });
    await generateStageFixtures(auth, ko!.id);
    const koByes = (await fixturesOf(ko!.id)).filter((f) => f.status === "forfeited");
    expect(koByes.length, "premise: one structural bye").toBe(1);
    const koBye = koByes[0]!;
    expect(await byeShapesOf(koBye.id), "premise: a system bye, not a Swiss shell").toEqual({ system: true, shell: false });

    // A Swiss of three, paired: round one's bye shell is awarded at Pair.
    const swDiv = await division(auth, { sport_key: "badminton", variant_key: "bwf", config: {} });
    await entrants(auth, swDiv.id, 3);
    const [sw] = await createStages(auth, swDiv.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await generateStageFixtures(auth, sw!.id); // mint the shells
    await generateStageFixtures(auth, sw!.id); // Pair round one
    const shell = (await fixturesOf(sw!.id)).find((f) => f.ext_key === "sw-r1-bye")!;
    expect([shell.status, shell.outcome?.reason], "premise: the bye awarded at Pair").toEqual(["forfeited", "bye"]);
    expect(await byeShapesOf(shell.id), "premise: both bye shapes").toEqual({ system: true, shell: true });
    // A bye stored before W2b carries no reason (fed-seats.ts `isCascadeWalkover`): only the shell exemption sees it.
    const legacy = (await fixturesOf(sw!.id)).find((f) => f.ext_key === "sw-r2-bye")!;
    await sql`
      update fixtures set status = 'forfeited', home_entrant_id = ${shell.home_entrant_id}, away_entrant_id = null,
             outcome = ${sql.json({ kind: "award", winner: shell.home_entrant_id } as never)}
       where id = ${legacy.id}`;
    expect(await byeShapesOf(legacy.id), "premise: a Swiss shell that is not a system bye").toEqual({ system: false, shell: true });

    const want: [string, string, boolean][] = [
      ["a knockout's system bye", koBye.id, false],
      ["a Swiss bye shell awarded at Pair", shell.id, false],
      ["a reasonless (pre-W2b) Swiss bye shell", legacy.id, false],
    ];
    const got = await startedOf(want.map(([, id]) => id));
    let checked = 0;
    for (const [label, id, started] of want) {
      expect(got.get(id), label).toBe(started);
      checked++;
    }
    expect(checked, "anti-vacuity: every bye asked").toBe(want.length);
    expect(await sql.begin((tx) => stageHasStarted(tx as never, ko!.id)), "a knockout whose only settled line is its bye").toBe(false);
    expect(await sql.begin((tx) => stageHasStarted(tx as never, sw!.id)), "a paired Swiss nobody has played").toBe(false);
  });

  it("refuses the two aliases liveCallSql owns, by name, through the predicate and its call arm; the callers' alias and the default build", () => {
    const owned = Object.values(LIVE_CALL_ALIASES);
    expect(owned, "anti-vacuity: the call row's alias and its fixture's").toHaveLength(2);
    let checked = 0;
    for (const build of [fixtureStartedSql, fixtureCalledSql]) {
      for (const alias of owned) {
        expect(() => build(sql as never, alias), `${build.name}(${alias})`).toThrow(/liveCallSql/);
        checked++;
      }
      expect(() => build(sql as never, "f")).not.toThrow();
      expect(() => build(sql as never)).not.toThrow();
    }
    expect(checked, "anti-vacuity: both builders, both aliases").toBe(4);
  });
});

// D1's Swiss differential. `swissBoardStartedSql` exempted only the Swiss bye shell from its decided arm; the one predicate
// exempts any system bye. On a Swiss stage that difference is a board row holding a system bye under a board's ext key
// (`sw-r1-b1`, not `sw-rN-bye`) — a shape only an import or raw SQL writes, which is the point: it is the one row on which
// the Swiss callers' answer moves. Before: started (rounds locked). After: not started — nobody played a bye. The two-seated
// award on the same row is the positive pair: decided, other than the bye, still a start.
describe.skipIf(!HAS_DB)("X-LE-9 the Swiss callers read the widened bye exemption", () => {
  it("a Swiss board whose only decided row is a non-shell system bye has not started; a two-seated award on it has", async () => {
    const { auth } = await seedOrg();
    const div = await division(auth, { sport_key: "badminton", variant_key: "bwf", config: {} });
    const ids = await entrants(auth, div.id, 4);
    const [sw] = await createStages(auth, div.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await generateStageFixtures(auth, sw!.id); // mint the shells only: nobody seated, nothing played
    const board = (await fixturesOf(sw!.id)).find((f) => f.ext_key === "sw-r1-b1")!;
    const started = async () => (await listSwissRoundControls(auth, div.id))[sw!.id]!.started;
    expect(await started(), "premise: a minted Swiss has not started").toBe(false);

    await sql`
      update fixtures set status = 'forfeited', home_entrant_id = ${ids[0]!}, away_entrant_id = null,
             outcome = ${sql.json({ kind: "award", winner: ids[0]!, loser: null, reason: "bye" } as never)}
       where id = ${board.id}`;
    expect(await byeShapesOf(board.id), "premise: a system bye on a board row, not a shell").toEqual({ system: true, shell: false });
    expect(await started(), "a bye alone is not a start").toBe(false);

    await sql`
      update fixtures set away_entrant_id = ${ids[1]!},
             outcome = ${sql.json({ kind: "award", winner: ids[0]!, loser: ids[1]!, reason: "withdrew" } as never)}
       where id = ${board.id}`;
    expect(await byeShapesOf(board.id), "premise: no bye any more").toEqual({ system: false, shell: false });
    expect(await started(), "a decided board other than the bye is a start").toBe(true);
  });
});
