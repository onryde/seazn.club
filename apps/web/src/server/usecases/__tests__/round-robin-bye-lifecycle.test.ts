// #850 — what happens to a round-robin stage's REST-BYE rows AFTER generation:
// every path the 2026-09-23 review found could leave them wrong, driven
// through the real product functions and read back off the real rows.
//
//   finding 3  — Clear pool entrants → Undo restores the byes AS byes
//   finding 6  — Start with rolling round times never times a bye
//   finding 7  — Generate after the field changes (4→5, 5→6) writes byes that
//                agree with the schedule the stage is left with
//   finding 8  — a withdrawal removes the entrant's FUTURE byes; a round
//                already under way keeps its bye (it happened)
//   finding 10 — a knockout's byes are untouched by the rest-bye paths
//   owner ruling (third round) — a progression-fed league gets its byes when
//                the draw places the entrants, never timed, and loses them
//                when the draw is undone
//
// THE INVARIANT every case checks the same way (`expectByesAgree`): in each
// round of each pool, a rest-bye row names the one ACTIVE entrant of the
// pool's field who is seated in no other row of that round — and exists only
// when exactly one is. It is derived from the rows, never typed, so a case
// cannot pass on the fixture's say-so.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateRoundRobin } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import { isOneSidedAwardBye, isRestBye, isSitOutBye } from "@/lib/fixture-bye";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, deleteEntrant, patchEntrant } from "../entrants";
import {
  completeStage,
  computeSeedProposal,
  confirmSeedProposal,
  addFixture,
  createStages,
  deleteRestByesHeldBy,
  generateStageFixtures,
  getSeedProposal,
} from "../stages";
import { recomputeStandings } from "@/server/engine-db";
import { buildRunSheet } from "@/lib/run-sheet-groups";
import { listDivisionFixtures, patchFixture } from "../fixtures";
import { listDivisionCardStats } from "../card-stats";
import { clearPoolEntrants, redoDivision, undoDivision } from "../history";
import { putScheduleSettings, startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { withdrawEntrantCascade } from "../withdrawal";
import { withdrawRegistrationPublic } from "../registrations";
import { seedRegistration } from "./_registration-fixtures";
import { withTenant } from "@/lib/db";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Row {
  id: string;
  ext_key: string | null;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: { key?: string } | null;
  away_slot_label: { key?: string } | null;
  status: string;
  outcome: unknown;
  scheduled_at: Date | null;
}

async function rowsOf(stageId: string): Promise<Row[]> {
  return sql<Row[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id,
           home_slot_label, away_slot_label, status, outcome, scheduled_at
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

async function activeIds(divisionId: string): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')`;
  return new Set(rows.map((r) => r.id));
}

const seatsOf = (r: Row) => [r.home_entrant_id, r.away_entrant_id].filter((x): x is string => x !== null);
const holderOf = (r: Row) => (r.home_entrant_id ?? r.away_entrant_id)!;

/**
 * THE invariant, derived from the rows: per (pool, round), the rest-bye rows
 * are exactly the one active field entrant seated nowhere else that round (or
 * none when not exactly one). `frozen` names rounds a test has put UNDER WAY,
 * where only the contradiction half is required.
 */
function expectByesAgree(rows: Row[], kind: string, active: Set<string>, frozen: ReadonlySet<number> = new Set()) {
  const rest = rows.filter((r) => isRestBye(r, kind));
  const others = rows.filter((r) => !isRestBye(r, kind));
  const pools = new Set(others.map((r) => r.pool_id ?? ""));
  for (const pool of pools) {
    const inPool = others.filter((r) => (r.pool_id ?? "") === pool);
    const field = new Set(inPool.flatMap(seatsOf).filter((id) => active.has(id)));
    for (const round of new Set(inPool.map((r) => r.round_no))) {
      const seated = new Set(inPool.filter((r) => r.round_no === round).flatMap(seatsOf));
      const byes = rest.filter((b) => (b.pool_id ?? "") === pool && b.round_no === round);
      // Everywhere: no bye holder plays that round.
      for (const b of byes) expect(seated.has(holderOf(b)), `pool ${pool} round ${round}: bye holder also plays`).toBe(false);
      if (frozen.has(round)) continue;
      // Owner ruling (fifth round): only rounds the schedule GENERATED carry a
      // bye. A round of nothing but hand-added matches (`addFixture`'s
      // `adhoc-{n}` key) has none, however many sit it out.
      if (inPool.filter((r) => r.round_no === round).every((r) => /^adhoc-\d+$/.test(r.ext_key ?? ""))) {
        expect(byes, `pool ${pool} round ${round}: a hand-added round has no bye`).toEqual([]);
        continue;
      }
      const sitOuts = [...field].filter((id) => !seated.has(id));
      expect(
        byes.map(holderOf),
        `pool ${pool} round ${round}: sit-outs ${JSON.stringify(sitOuts)}`,
      ).toEqual(sitOuts.length === 1 ? sitOuts : []);
    }
  }
  // Every rest bye is in a round that has matches, untimed, settled, keyed.
  for (const b of rest) {
    expect(others.some((r) => r.round_no === b.round_no && (r.pool_id ?? "") === (b.pool_id ?? ""))).toBe(true);
    expect(b.scheduled_at, "a bye is never timed").toBeNull();
    expect(b.status).toBe("forfeited");
    expect(b.away_slot_label?.key).toBe("bracket.slot.bye");
    expect(b.ext_key).toMatch(/(^|-)rr-r\d+-bye$/);
  }
}

async function seedDivision(auth: AuthCtx, n: number, name = "Open") {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "RR life " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name,
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: n }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  return { divisionId: division.id, entrants: entrants.map((e, i) => ({ id: e.id, seed: i + 1 })) };
}

async function seedStage(auth: AuthCtx, n: number, kind: "league" | "group" | "knockout", config: Record<string, unknown> = {}) {
  const d = await seedDivision(auth, n);
  const [st] = await createStages(auth, d.divisionId, { seq: 1, kind, name: kind, config, progression: null });
  return { ...d, stageId: st!.id };
}

async function play(auth: AuthCtx, fixtureId: string, home = 2, away = 1) {
  await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
  await scoreEvent(auth, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: home, p2Score: away } });
}

async function compOf(divisionId: string): Promise<string> {
  const [d] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${divisionId}`;
  return d!.competition_id;
}

async function addEntrant(auth: AuthCtx, divisionId: string, seed: number) {
  const [e] = await createEntrants(auth, divisionId, [
    { kind: "individual" as const, display_name: `E${seed}`, seed, members: [] },
  ]);
  return e!.id;
}

describe.skipIf(!HAS_DB)("finding 3 — Clear pool entrants, then Undo", () => {
  it("restores the odd pool's byes AS byes (settled, keyed); the stage then completes and a re-Generate adds nothing", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 7, "group", { pools: { count: 2 } });
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    const oddPool = before.find((r) => isRestBye(r, "group"))!.pool_id!;
    const poolBefore = before.filter((r) => r.pool_id === oddPool);
    expect(poolBefore.filter((r) => isRestBye(r, "group"))).toHaveLength(3); // premise: 3-entrant pool

    await clearPoolEntrants(auth, oddPool, true);
    expect((await rowsOf(stageId)).filter((r) => r.pool_id === oddPool)).toEqual([]);
    await undoDivision(auth, divisionId);

    const after = await rowsOf(stageId);
    const shape = (r: Row) => [r.id, r.ext_key, r.round_no, r.home_entrant_id, r.away_entrant_id, r.status, r.outcome, r.away_slot_label];
    expect(after.filter((r) => r.pool_id === oddPool).map(shape).sort()).toEqual(poolBefore.map(shape).sort());
    const byes = after.filter((r) => r.pool_id === oddPool && isRestBye(r, "group"));
    expect(byes).toHaveLength(3);
    expectByesAgree(after, "group", await activeIds(divisionId));

    // A re-Generate recognises every restored row by its key.
    const again = await generateStageFixtures(auth, stageId);
    expect(again.created).toBe(0);
    expect((await rowsOf(stageId)).map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());

    // The stage can complete: every MATCH played, the byes already settled.
    await startDivision(auth, divisionId, {} as never);
    for (const m of after.filter((r) => !isRestBye(r, "group"))) await play(auth, m.id);
    const done = await completeStage(auth, stageId, { publish: false });
    expect(done.completed).toBe(true);
    const [stage] = await sql<{ status: string }[]>`select status from stages where id = ${stageId}`;
    expect(stage!.status).toBe("complete");
  });

  it("Redo of the clear removes the byes again, with the pool's matches", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 7, "group", { pools: { count: 2 } });
    await generateStageFixtures(auth, stageId);
    const oddPool = (await rowsOf(stageId)).find((r) => isRestBye(r, "group"))!.pool_id!;
    await clearPoolEntrants(auth, oddPool, true);
    await undoDivision(auth, divisionId);
    await redoDivision(auth, divisionId);
    expect((await rowsOf(stageId)).filter((r) => r.pool_id === oddPool)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("finding 6 — Start with rolling round times configured", () => {
  it("times every match round by round and never a bye", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    const startAt = "2030-06-01T10:00:00.000Z";
    const roundMinutes = 30;
    await putScheduleSettings(auth, divisionId, {
      tz: "UTC",
      config: {
        startAt,
        matchMinutes: 25,
        gapMinutes: 0,
        courts: [],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
        roundMinutes,
      },
    } as never);
    await generateStageFixtures(auth, stageId);
    await startDivision(auth, divisionId, { acknowledge_warnings: true } as never);
    const rows = await rowsOf(stageId);
    const byes = rows.filter((r) => isRestBye(r, "league"));
    const matches = rows.filter((r) => !isRestBye(r, "league"));
    expect(byes).toHaveLength(5);
    expect(byes.map((b) => b.scheduled_at)).toEqual([null, null, null, null, null]);
    // Round r at startAt + (r−1)·roundMinutes, derived from the settings: the
    // byes did not count as rounds either, so nothing slid a slot later.
    for (const m of matches) {
      expect(m.scheduled_at, `round ${m.round_no}`).not.toBeNull();
      expect(new Date(m.scheduled_at!).toISOString()).toBe(
        new Date(Date.parse(startAt) + (m.round_no - 1) * roundMinutes * 60_000).toISOString(),
      );
    }
    const [ev] = await sql<{ payload: { fixturesScheduled: number } }[]>`
      select payload from division_events where division_id = ${divisionId} and type = 'schedule_published'`;
    expect(ev!.payload.fixturesScheduled).toBe(matches.length);
  });

  it("a round whose matches were already timed by hand is not a round still to time — its untimed bye does not push the rest a slot later", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    const startAt = "2030-06-01T10:00:00.000Z";
    const roundMinutes = 30;
    await putScheduleSettings(auth, divisionId, {
      tz: "UTC",
      config: { startAt, matchMinutes: 25, gapMinutes: 0, courts: [], perEntrantMinRest: 0, blackouts: [], sessionWindows: [], roundMinutes },
    } as never);
    await generateStageFixtures(auth, stageId);
    // The organiser times round 1's two matches by hand, the day before.
    const early = "2030-05-31T10:00:00.000Z";
    for (const m of (await rowsOf(stageId)).filter((r) => r.round_no === 1 && !isRestBye(r, "league"))) {
      await patchFixture(auth, m.id, { scheduled_at: early } as never);
    }
    await startDivision(auth, divisionId, { acknowledge_warnings: true } as never);
    const rows = await rowsOf(stageId);
    // Round 1 keeps its hand-set time; rounds 2–5 take the rolling slots from
    // the FIRST one — round 1's still-untimed bye is no round to slot.
    for (const m of rows.filter((r) => !isRestBye(r, "league"))) {
      const want = m.round_no === 1 ? early : new Date(Date.parse(startAt) + (m.round_no - 2) * roundMinutes * 60_000).toISOString();
      expect(new Date(m.scheduled_at!).toISOString(), `round ${m.round_no}`).toBe(want);
    }
    expect(rows.filter((r) => isRestBye(r, "league")).map((b) => b.scheduled_at)).toEqual([null, null, null, null, null]);
  });
});

describe.skipIf(!HAS_DB)("finding 7 — Generate after the field changes", () => {
  it("4 → 5: every bye names that round's sole sit-out; none plays its round", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 4, "league");
    await generateStageFixtures(auth, stageId);
    expect((await rowsOf(stageId)).filter((r) => isOneSidedAwardBye(r))).toEqual([]); // even: no byes
    await addEntrant(auth, divisionId, 5);
    const out = await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    const byes = rows.filter((r) => isRestBye(r, "league"));
    console.log("4->5 byes:", byes.map((b) => [b.round_no, b.home_entrant_id]));
    // The premise the old code got wrong: the NEW field's engine byes name
    // entrants who still play the old rounds 1–3.
    const five = await sql<{ id: string; seed: number }[]>`select id, seed from entrants where division_id = ${divisionId}`;
    const engine = generateRoundRobin({
      entrants: [...five].sort((a, b) => a.seed - b.seed).map((e) => e.id),
      seeds: new Map(five.map((e) => [e.id, e.seed])),
      config: { legs: 1 },
    });
    const contradicted = engine.rounds.filter(
      (r) => r.bye !== undefined && rows.some((x) => x.round_no === r.roundNo && !isRestBye(x, "league") && seatsOf(x).includes(r.bye!)),
    );
    expect(contradicted.length, "premise: the new field's engine byes clash with the kept rounds").toBeGreaterThan(0);
    expectByesAgree(rows, "league", await activeIds(divisionId));
    expect(byes.length).toBeGreaterThan(0);
    // Counts stay MATCH counts.
    expect(out.created).toBe(rows.filter((r) => !isRestBye(r, "league")).length - 6);
    // The Undo contract: this pass's ledger names only rows that exist — no
    // bye line was written for the new field's `round.bye` and then withdrawn
    // as a clash in the same pass — and it names every bye the pass wrote.
    const [ev] = await sql<{ payload: { fixture_ids: string[] } }[]>`
      select payload from division_events
      where division_id = ${divisionId} and type = 'fixtures_generated' order by seq desc limit 1`;
    const live = new Set(rows.map((r) => r.id));
    expect(ev!.payload.fixture_ids.filter((id) => !live.has(id)), "ledger ids with no row").toEqual([]);
    for (const b of byes) expect(ev!.payload.fixture_ids).toContain(b.id);
  });

  it("a round already PLAYED keeps its bye — unless its holder is seated in that round after all (an ad-hoc match), and then it goes AT ONCE, with the Add match itself", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    await startDivision(auth, divisionId, {} as never);
    const five = await rowsOf(stageId);
    const r2 = five.filter((r) => r.round_no === 2 && !isRestBye(r, "league"));
    for (const m of r2) await play(auth, m.id);
    const r2bye = five.find((r) => r.round_no === 2 && isRestBye(r, "league"))!;
    const opponent = seatsOf(r2[0]!)[0]!;
    // Played round, nothing contradicts its bye: a re-Generate leaves it.
    await generateStageFixtures(auth, stageId);
    expect((await rowsOf(stageId)).some((r) => r.id === r2bye.id), "the played round's bye stays").toBe(true);
    // The organiser adds an ad-hoc round-2 match for the entrant who sat it out.
    // Review round 2, R2-3: the Add match reconciles in its own transaction —
    // read straight after it, with NO Generate in between, the holder is not
    // both resting and playing round 2 (this used to wait for a Generate).
    await addFixture(auth, stageId, { home_entrant_id: holderOf(r2bye), away_entrant_id: opponent, round_no: 2 });
    let rows = await rowsOf(stageId);
    expect(rows.some((r) => r.id === r2bye.id), "a bye whose holder plays its round is gone, played round or not").toBe(false);
    expectByesAgree(rows, "league", await activeIds(divisionId), new Set([2]));
    // …and a later Generate changes nothing about it.
    await generateStageFixtures(auth, stageId);
    rows = await rowsOf(stageId);
    expect(rows.some((r) => r.id === r2bye.id)).toBe(false);
    // Round 2 was under way: nothing ELSE in it was rewritten, and no bye was
    // re-derived for it.
    for (const m of r2) expect(rows.find((r) => r.id === m.id)?.status).toBe("decided");
    expect(rows.filter((r) => r.round_no === 2 && isRestBye(r, "league"))).toEqual([]);
    expectByesAgree(rows, "league", await activeIds(divisionId), new Set([2]));
  });

  it("5 → 6: the old field's byes that now clash are gone; Undo brings the 5-field byes back", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    const fiveRows = await rowsOf(stageId);
    const fiveByes = fiveRows.filter((r) => isRestBye(r, "league")).map((b) => [b.round_no, b.home_entrant_id]);
    expect(fiveByes).toHaveLength(5);
    const sixth = await addEntrant(auth, divisionId, 6);
    await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    expectByesAgree(rows, "league", await activeIds(divisionId));
    expect(rows.some((r) => seatsOf(r).includes(sixth))).toBe(true);

    await undoDivision(auth, divisionId);
    const back = await rowsOf(stageId);
    expect(back.filter((r) => !isRestBye(r, "league")).map((r) => r.id).sort()).toEqual(
      fiveRows.filter((r) => !isRestBye(r, "league")).map((r) => r.id).sort(),
    );
    // The sixth entrant is still active but seated nowhere now: the 5-field's
    // own byes are exactly right again.
    expect(back.filter((r) => isRestBye(r, "league")).map((b) => [b.round_no, b.home_entrant_id])).toEqual(fiveByes);
    expectByesAgree(back, "league", await activeIds(divisionId));
  });
});

describe.skipIf(!HAS_DB)("finding 8 — a withdrawal and the entrant's byes", () => {
  it("removes the bye of a round not yet under way; KEEPS the bye of a round already under way; un-withdrawing restores it", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    await startDivision(auth, divisionId, {} as never);
    const rows = await rowsOf(stageId);
    const byeOf = (round: number) => rows.find((r) => r.round_no === round && isRestBye(r, "league"))!;
    // Round 1 is played in full — under way (finished).
    for (const m of rows.filter((r) => r.round_no === 1 && !isRestBye(r, "league"))) await play(auth, m.id);

    // The round-1 bye holder withdraws: that sit-out HAPPENED, so it stays.
    const early = byeOf(1);
    await withdrawEntrantCascade(auth, holderOf(early));
    let now = await rowsOf(stageId);
    expect(now.find((r) => r.id === early.id), "the under-way round's bye is kept").toMatchObject({
      status: "forfeited",
      home_entrant_id: holderOf(early),
    });

    // The round-3 bye holder withdraws: round 3 has not started, so the row goes.
    const later = byeOf(3);
    await withdrawEntrantCascade(auth, holderOf(later));
    now = await rowsOf(stageId);
    expect(now.some((r) => r.id === later.id), "a future round's bye is removed").toBe(false);
    expect(now.filter((r) => r.round_no === 3 && isRestBye(r, "league"))).toEqual([]);
    // Every other entrant's bye is untouched (positive pair).
    for (const round of [2, 4, 5]) expect(now.some((r) => r.id === byeOf(round).id), `round ${round}`).toBe(true);
    expectByesAgree(now, "league", await activeIds(divisionId), new Set([1]));

    // Both directions: back into the field, the sit-out is theirs again.
    await patchEntrant(auth, holderOf(later), { status: "registered" } as never);
    now = await rowsOf(stageId);
    const restored = now.find((r) => r.round_no === 3 && isRestBye(r, "league"));
    expect(restored?.home_entrant_id).toBe(holderOf(later));
  });

  it("before Start (a plain status flip), every one of their byes goes — nothing is under way", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    const bye = (await rowsOf(stageId)).find((r) => isRestBye(r, "league"))!;
    const out = await withdrawEntrantCascade(auth, holderOf(bye));
    expect(out.policy).toBe("none");
    const now = await rowsOf(stageId);
    expect(now.some((r) => r.id === bye.id)).toBe(false);
    expect(now.filter((r) => isRestBye(r, "league"))).toHaveLength(4);
    expectByesAgree(now, "league", await activeIds(divisionId));
  });
});

describe.skipIf(!HAS_DB)("finding 10 — a knockout's byes are not rest byes", () => {
  it("the generate count still counts a bracket's bye lines, and the entrant-delete cleanup leaves them alone", async () => {
    const { auth } = await seedOrg();
    const { stageId } = await seedStage(auth, 5, "knockout");
    const out = await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    const byes = rows.filter((r) => isOneSidedAwardBye(r));
    expect(byes.length, "premise: a 5-entrant bracket seeds byes").toBeGreaterThan(0);
    expect(byes.some((b) => isRestBye(b, "knockout"))).toBe(false);
    // Pre-#850 count: every row the pass created, byes included.
    expect(out.created).toBe(rows.length);

    const holder = holderOf(byes[0]!);
    const removed = await withTenant(auth.orgId, (tx) => deleteRestByesHeldBy(tx, holder));
    expect(removed).toBe(0);
    await deleteEntrant(auth, holder);
    expect((await rowsOf(stageId)).some((r) => r.id === byes[0]!.id), "the bracket's bye row is not the rest-bye path's").toBe(true);
  });
});

describe.skipIf(!HAS_DB)("owner ruling — a progression-fed (timing: setup) league", () => {
  it("has no bye rows until the draw places the entrants; then one per round, untimed; Undo of the draw takes them away", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, entrants } = await seedDivision(auth, 6);
    const [phase1, finals] = await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "Phase 1", config: {} },
      {
        seq: 2,
        kind: "league",
        name: "Finals pool",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 5 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const { fixtures: p1 } = await generateStageFixtures(auth, phase1!.id);
    await generateStageFixtures(auth, finals!.id);
    let rows = await rowsOf(finals!.id);
    expect(rows.filter((r) => !isRestBye(r, "league"))).toHaveLength(10); // C(5,2) placeholders
    expect(rows.filter((r) => isOneSidedAwardBye(r)), "no draw yet, so nobody sits anything out").toEqual([]);
    // The organiser times the TBD fixtures ahead of the draw.
    await sql`update fixtures set scheduled_at = '2030-07-01T09:00:00Z' where stage_id = ${finals!.id}`;

    await startDivision(auth, divisionId, { acknowledge_warnings: true } as never);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed]));
    for (const f of p1) {
      const homeWins = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
      await play(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    await completeStage(auth, phase1!.id);
    const proposal = await computeSeedProposal(auth, finals!.id);
    expect(proposal.computed.qualifiers).toHaveLength(5);
    await confirmSeedProposal(auth, finals!.id, { proposalId: proposal.id });

    rows = await rowsOf(finals!.id);
    const byes = rows.filter((r) => isRestBye(r, "league"));
    expect(byes).toHaveLength(5);
    expect(new Set(byes.map(holderOf)).size, "each qualifier rests exactly once").toBe(5);
    expectByesAgree(rows, "league", await activeIds(divisionId));

    // Undo the draw's stage generation (the latest reversible edit): its rows
    // go, and so do the byes the draw wrote — no seatless or orphan bye left.
    await undoDivision(auth, divisionId);
    expect(await rowsOf(finals!.id)).toEqual([]);
    // Redo brings the placeholders back, undrawn — and no bye with them.
    await redoDivision(auth, divisionId);
    rows = await rowsOf(finals!.id);
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => isOneSidedAwardBye(r))).toEqual([]);
  });
});

// Owner ruling 2026-09-24 (fourth round) — review round 2, R2-4. In a
// progression-fed league a qualifier who departs BEFORE the draw has each of
// their lines walked over to the opponent by `awardSeededByes`: one seat, the
// award to it, `forfeited` — a rest bye's exact SHAPE, in a league. It is NOT a
// rest bye: it scores as the win it is and keeps its pre-#850 display. The
// probe: a 5-entrant league feeding its top 4 into a second league; seed 2
// withdraws before the draw. Every reader below is a real one, and each has a
// right answer that differs from the shape-only predicate's.
describe.skipIf(!HAS_DB)("owner ruling (fourth round) — a fed league's walkover is not a rest bye", () => {
  it("the walkover rows score as wins, count as played, stay with their holder, and never read 'has a bye'", async () => {
    const { auth } = await seedOrg("pro");
    const { divisionId, entrants } = await seedDivision(auth, 5);
    const [phase1, finals] = await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "Phase 1", config: {} },
      {
        seq: 2,
        kind: "league",
        name: "Top four",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ]);
    const p1 = (await generateStageFixtures(auth, phase1!.id)).fixtures.filter((f) => !isRestBye(f, "league"));
    await generateStageFixtures(auth, finals!.id);
    await startDivision(auth, divisionId, { acknowledge_warnings: true } as never);
    const seedOf = new Map(entrants.map((e) => [e.id, e.seed]));
    for (const f of p1) {
      const homeWins = seedOf.get(f.home_entrant_id!)! < seedOf.get(f.away_entrant_id!)!;
      await play(auth, f.id, homeWins ? 2 : 0, homeWins ? 0 : 2);
    }
    await completeStage(auth, phase1!.id);
    const full = await computeSeedProposal(auth, finals!.id);
    expect(full.computed.qualifiers).toHaveLength(4);
    const departed = full.computed.qualifiers[1]!.entrantId;
    await withdrawEntrantCascade(auth, departed);
    const short = await getSeedProposal(auth, finals!.id);
    expect(short!.computed.qualifiers.map((q) => q.entrantId)).not.toContain(departed);
    await confirmSeedProposal(auth, finals!.id, { proposalId: short!.id });

    const rows = await rowsOf(finals!.id);
    const walkovers = rows.filter((r) => isOneSidedAwardBye(r));
    // The premise: one walkover per round (the departed qualifier's line), in
    // exactly a rest bye's shape — settled, one seat, the award to it.
    expect(walkovers, "premise: the departed seat's lines are walked over").toHaveLength(3);
    for (const w of walkovers) {
      expect(w.status).toBe("forfeited");
      expect(w.ext_key, "a walkover keeps its match key").toMatch(/^rr-r\d+-c\d+$/);
      // …and is no SIT-OUT, so the calendar feed emits it as before #850.
      expect(isSitOutBye(w, "league"), "a walkover is not a sit-out").toBe(false);
    }
    // Not rest byes, and no rest bye was written beside them: every round
    // seats all three remaining qualifiers.
    expect(rows.filter((r) => isRestBye(r, "league"))).toEqual([]);
    expectByesAgree(rows, "league", await activeIds(divisionId));

    // 1. STANDINGS — each walkover is a win at the division's own points.
    const table = await recomputeStandings(auth.orgId, finals!.id);
    for (const w of walkovers) {
      const holder = holderOf(w);
      const r = table.find((x) => x.entrantId === holder);
      const n = walkovers.filter((x) => holderOf(x) === holder).length;
      // Shape-only would read played 0 / points 0 here.
      expect(r, "the walkover holder is on the table").toMatchObject({ played: n, won: n, points: n * GENERIC_CONFIG.points.w });
    }

    // 2. THE DESK CARD — played/total count the walkovers, as before #850
    //    (shape-only dropped them from BOTH counts: 0 of 3).
    const card = (await listDivisionCardStats(auth, (await compOf(divisionId)))).get(divisionId)!;
    const p1Matches = p1.length;
    expect(card.total, "total: phase 1's matches + the finals' six lines").toBe(p1Matches + 6);
    expect(card.played, "played: phase 1 + the three walkovers").toBe(p1Matches + 3);

    // 3. THE RUN SHEET — no walkover reads "X has a bye" (a rest-bye ghost row);
    //    as before #850 a league's one-sided award is off the sheet (R7(c)).
    const sheet = buildRunSheet({
      fixtures: (await listDivisionFixtures(auth, divisionId)).map((f) => ({ ...f, court_name: f.court_name ?? null })) as never,
      stages: [
        { id: phase1!.id, seq: 1, kind: "league" },
        { id: finals!.id, seq: 2, kind: "league" },
      ],
      tz: "UTC",
      nowMs: Date.now(),
    });
    const onSheet = new Set(sheet.flatMap((b) => (b.kind === "bracket" ? [] : b.fixtures.map((f) => f.id))));
    for (const w of walkovers) expect(onSheet.has(w.id), "a walkover is not a rest-bye ghost row").toBe(false);

    // 4. THE ENTRANT-DELETE CLEANUP — never touches a walkover (shape-only
    //    deleted all of a holder's walkovers, and their result with them).
    //    The holder also rested once in the 5-entrant phase 1: that marked
    //    row, and only it, is theirs to lose.
    const holder = holderOf(walkovers[0]!);
    const restedInPhase1 = (await rowsOf(phase1!.id)).filter((r) => isRestBye(r, "league") && holderOf(r) === holder);
    expect(restedInPhase1, "premise: the holder rested once in phase 1").toHaveLength(1);
    expect(await withTenant(auth.orgId, (tx) => deleteRestByesHeldBy(tx, holder))).toBe(1);
    expect((await rowsOf(phase1!.id)).some((r) => r.id === restedInPhase1[0]!.id)).toBe(false);
    expect((await rowsOf(finals!.id)).filter((r) => isOneSidedAwardBye(r)).map((r) => r.id).sort()).toEqual(
      walkovers.map((w) => w.id).sort(),
    );
  });
});

// Review round 2 — R2-1 and R2-3: an organiser's ad-hoc match (`addFixture`,
// the stage card's "Add match") beside the rest-bye rows.
describe.skipIf(!HAS_DB)("review round 2 — Add match beside rest byes", () => {
  // R2-1 (HIGH): the ad-hoc key was `adhoc-{count(*)+1}`. A withdrawal deletes
  // the leaver's future bye rows, the count drops, and the next key is one
  // that already exists: a unique violation on (stage_id, ext_key), then a 500
  // on every retry.
  it("R2-1: Add match → the bye holder withdraws → Add match still succeeds, with a fresh key", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId, entrants } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    await startDivision(auth, divisionId, {} as never);
    const [a, b, c] = entrants.map((e) => e.id);
    const first = await addFixture(auth, stageId, { home_entrant_id: a!, away_entrant_id: b! });

    // The withdrawing entrant holds a bye in a round nobody has started, so
    // the withdrawal deletes a row and the stage's row count drops.
    const before = await rowsOf(stageId);
    const leaver = holderOf(before.find((r) => isRestBye(r, "league") && ![a, b, c].includes(holderOf(r)))!);
    await withdrawEntrantCascade(auth, leaver);
    const after = await rowsOf(stageId);
    expect(after.length, "premise: the withdrawal deleted the leaver's bye row").toBeLessThan(before.length);

    const second = await addFixture(auth, stageId, { home_entrant_id: a!, away_entrant_id: c! });
    const rows = await rowsOf(stageId);
    const adhoc = rows.filter((r) => r.id === first.fixture_id || r.id === second.fixture_id);
    expect(adhoc).toHaveLength(2);
    expect(new Set(adhoc.map((r) => r.ext_key)).size, "two ad-hoc matches, two keys").toBe(2);
    for (const r of adhoc) expect(r.ext_key).toMatch(/^adhoc-\d+$/);
  });

  // R2-3: addFixture takes the division lock but never reconciled, so a match
  // added for a bye holder IN THEIR BYE ROUND left them both resting and
  // playing it until some later Generate. The ONE reconciler now runs in the
  // same transaction: "no bye holder may also play in that round".
  it("R2-3: a match added for the bye holder in their bye round removes that bye at once — nobody rests and plays one round", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    const rows = await rowsOf(stageId);
    const r3bye = rows.find((r) => r.round_no === 3 && isRestBye(r, "league"))!;
    const opponent = seatsOf(rows.find((r) => r.round_no === 3 && !isRestBye(r, "league"))!)[0]!;
    await addFixture(auth, stageId, { home_entrant_id: holderOf(r3bye), away_entrant_id: opponent, round_no: 3 });
    const now = await rowsOf(stageId);
    expect(now.some((r) => r.id === r3bye.id), "the holder now plays round 3").toBe(false);
    expect(now.filter((r) => r.round_no === 3 && isRestBye(r, "league"))).toEqual([]);
    // Positive pair: every OTHER round's bye is untouched.
    for (const b of rows.filter((r) => r.round_no !== 3 && isRestBye(r, "league"))) {
      expect(now.some((r) => r.id === b.id), `round ${b.round_no}`).toBe(true);
    }
    expectByesAgree(now, "league", await activeIds(divisionId));
  });

  // Owner ruling (fifth round): only rounds GENERATED by the round-robin
  // schedule create rest-bye rows; "Add match" never does, even a decider in a
  // new round that exactly one entrant sits out. The case where the answer
  // differs from "exactly one sits out ⇒ a bye": a 3-entrant league.
  it("fifth-round ruling: a 3-entrant league's ad-hoc round-4 decider writes NO bye, though exactly one entrant sits it out — and a later reconcile adds none either", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId, entrants } = await seedStage(auth, 3, "league");
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    const generatedRounds = new Set(before.map((r) => r.round_no));
    const lastRound = Math.max(...generatedRounds);
    expect(before.filter((r) => isRestBye(r, "league")), "premise: one bye per generated round").toHaveLength(generatedRounds.size);

    const [a, b, c] = entrants.map((e) => e.id);
    const decider = await addFixture(auth, stageId, { home_entrant_id: a!, away_entrant_id: b! });
    let now = await rowsOf(stageId);
    const deciderRow = now.find((r) => r.id === decider.fixture_id)!;
    expect(deciderRow.round_no, "premise: the decider opens a NEW round").toBe(lastRound + 1);
    const sitOuts = [a, b, c].filter((id) => !seatsOf(deciderRow).includes(id!));
    expect(sitOuts, "premise: exactly one entrant sits the decider out").toEqual([c]);
    expect(now.filter((r) => r.round_no === deciderRow.round_no).map((r) => r.id), "the new round is the decider alone").toEqual([
      decider.fixture_id,
    ]);
    expect(now.filter((r) => isRestBye(r, "league")).map((r) => r.id).sort(), "the generated rounds' byes are untouched").toEqual(
      before.filter((r) => isRestBye(r, "league")).map((r) => r.id).sort(),
    );
    expectByesAgree(now, "league", await activeIds(divisionId));

    // Reconciling again from another writer (an additive Generate runs the
    // same reconciler) must not add the bye back.
    await generateStageFixtures(auth, stageId);
    now = await rowsOf(stageId);
    expect(now.filter((r) => r.round_no === deciderRow.round_no && isRestBye(r, "league"))).toEqual([]);

    // R2-3 stays: a hand-added match that seats a GENERATED round's bye holder
    // in that round still takes the bye away.
    const r2bye = now.find((r) => r.round_no === 2 && isRestBye(r, "league"))!;
    const r2opp = [a, b, c].find((id) => id !== holderOf(r2bye))!;
    await addFixture(auth, stageId, { home_entrant_id: holderOf(r2bye), away_entrant_id: r2opp, round_no: 2 });
    now = await rowsOf(stageId);
    expect(now.some((r) => r.id === r2bye.id), "round 2's bye holder now plays round 2").toBe(false);
    expectByesAgree(now, "league", await activeIds(divisionId));
  });

  it("fifth-round ruling, group stage: an ad-hoc match in a new round of a 3-entrant pool writes no bye; the pools' generated byes stand", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 6, "group", { pools: { count: 2 } });
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    const pair = before.find((r) => !isRestBye(r, "group") && r.pool_id !== null)!;
    const added = await addFixture(auth, stageId, { home_entrant_id: pair.home_entrant_id!, away_entrant_id: pair.away_entrant_id! });
    const now = await rowsOf(stageId);
    const row = now.find((r) => r.id === added.fixture_id)!;
    expect(row.pool_id, "premise: it lands in the pair's pool").toBe(pair.pool_id);
    expect(Math.max(...before.map((r) => r.round_no)), "premise: it opens a new round").toBeLessThan(row.round_no);
    const pool = new Set(before.filter((r) => r.pool_id === pair.pool_id).flatMap(seatsOf));
    expect(pool.size - seatsOf(row).length, "premise: exactly one of the pool sits it out").toBe(1);
    expect(now.filter((r) => r.round_no === row.round_no).map((r) => r.id)).toEqual([added.fixture_id]);
    expect(now.filter((r) => isRestBye(r, "group")).map((r) => r.id).sort()).toEqual(
      before.filter((r) => isRestBye(r, "group")).map((r) => r.id).sort(),
    );
    expectByesAgree(now, "group", await activeIds(divisionId));
  });

  it("R2-3: a match in a NEW round (the default) writes no bye — three of five sit it out, nobody alone", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId, entrants } = await seedStage(auth, 5, "league");
    await generateStageFixtures(auth, stageId);
    const before = await rowsOf(stageId);
    await addFixture(auth, stageId, { home_entrant_id: entrants[0]!.id, away_entrant_id: entrants[1]!.id });
    const now = await rowsOf(stageId);
    expect(now.filter((r) => isRestBye(r, "league")).map((r) => r.id).sort()).toEqual(
      before.filter((r) => isRestBye(r, "league")).map((r) => r.id).sort(),
    );
    expect(now.filter((r) => r.round_no === 6)).toHaveLength(1);
    expectByesAgree(now, "league", await activeIds(divisionId));
  });
});

// Review round 2 — R2-2: a registration withdrawal (`withdrawCore`, reached
// from the registrant's own cancel link, the /r/[ref] page and the organiser's
// Withdraw) flips `entrants.status` in raw SQL, so `patchEntrant`'s reconcile
// never ran and the leaver's future byes stayed. It now reconciles under the
// division lock with patchEntrant's own policy: a round not under way loses
// the leaver's bye; a round already under way keeps it — the sit-out happened.
describe.skipIf(!HAS_DB)("review round 2 — a registration withdrawal and the entrant's byes", () => {
  it("R2-2: the leaver's future bye goes; an under-way round's bye stays; nobody else's moves", async () => {
    const { auth } = await seedOrg();
    const { divisionId, stageId } = await seedStage(auth, 5, "league");
    const [{ competition_id: compId }] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    await generateStageFixtures(auth, stageId);
    await startDivision(auth, divisionId, {} as never);
    const rows = await rowsOf(stageId);
    const byeOf = (round: number) => rows.find((r) => r.round_no === round && isRestBye(r, "league"))!;
    // Round 1 is played in full — under way.
    for (const m of rows.filter((r) => r.round_no === 1 && !isRestBye(r, "league"))) await play(auth, m.id);

    const withdrawByRegistration = async (entrantId: string) => {
      const { registration, access_token } = await seedRegistration(
        compId,
        divisionId,
        { fee_cents: 0, currency: "gbp", payment_method: "offline" as const },
        { displayName: "Leaver", status: "confirmed" },
      );
      await sql`update registrations set entrant_id = ${entrantId} where id = ${registration.id}`;
      await withdrawRegistrationPublic(registration.id, access_token);
      const [e] = await sql<{ status: string }[]>`select status from entrants where id = ${entrantId}`;
      expect(e!.status, "withdrawCore flipped the entrant").toBe("withdrawn");
    };

    // The round-3 bye holder leaves: round 3 has not started, so the row goes.
    const later = byeOf(3);
    await withdrawByRegistration(holderOf(later));
    let now = await rowsOf(stageId);
    expect(now.some((r) => r.id === later.id), "a future round's bye is removed").toBe(false);
    for (const round of [1, 2, 4, 5]) expect(now.some((r) => r.id === byeOf(round).id), `round ${round}`).toBe(true);

    // The round-1 bye holder leaves: that sit-out HAPPENED, so it stays.
    const early = byeOf(1);
    await withdrawByRegistration(holderOf(early));
    now = await rowsOf(stageId);
    expect(now.find((r) => r.id === early.id), "the under-way round's bye is kept").toMatchObject({
      status: "forfeited",
      home_entrant_id: holderOf(early),
    });
    expectByesAgree(now, "league", await activeIds(divisionId), new Set([1]));
  });
});
