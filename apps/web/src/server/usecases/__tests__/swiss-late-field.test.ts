// W3 Task 6 (spec §4 "Scoring for the newcomer", ruling 251; rule rows X-SW-8 and X-SW-12): the Swiss field model. Each
// entrant carries the first Swiss round they play (`entrants.swiss_first_round`; null = from round 1). A Pair of round r
// seats only the entrants whose first round is <= r (`swissFieldForRound`), and the history's implicit-bye inference
// credits — and bye-marks — an entrant for round r only when they were in the field for it. So a latecomer's missed
// rounds score 0 (rulebook §4 late-entry row; FIDE C.04.2 2.4: "late entries score 0 for missed rounds"), and a missed
// round is not a bye, so the latecomer is still bye-eligible (rulebook P-A4: the pairing-allocated bye at most once).
//
// The defect on main: swissGen's implicit-bye loop credits EVERY active entrant unseen in a fully seated round with no
// bye row +1 and marks them byed. A player who arrived after round 2 entered round 3 on 2 points and ineligible for the
// bye: paired into the leaders' group on games they never played.
//
// The latecomer arrives through a real producer. `createEntrants` refuses once the division has started (the roster lock,
// entrants.ts "the entrant list is locked"), so the post-Start door the app has today is the registration confirm
// (`confirmRegistration` -> `materialise`: spec §4's "automatic arrival"). Nothing writes `swiss_first_round` until Task 9
// ("Add late player", and an automatic arrival's case (c)), so these cases stamp it with the one UPDATE that writer
// makes. Everything after the stamp is the product: the active select, the field filter, the history, the engine call.
//
// Expected values come from the rulebook (0 per missed round; one bye at most) and the engine's own declaration
// (`pairRound`, scheduling/swiss.ts: "the lowest-ranked entrant not yet byed" takes the bye), never from swissGen. A
// player's score is read from the recorded results: 1 per win, ½ per draw (FIDE game points; rulebook §4: a bye pays a
// win). The engine's input is read through a spy on `pairRound` (precedent: swiss-history-round-order.test.ts).
//
// Two sports, the same body: badminton (no colours) and boardgame (chess colours on). The brief names both; the field
// model reads no sport field, so the rest of the registry adds nothing here.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { isOneSidedAwardBye } from "@/lib/fixture-bye";
import { isSwissBoardSeated, latestSeatedSwissRound } from "@/lib/swiss-shell";
import type { AuthCtx } from "@/server/api-v1/auth";
import { pairKey, type Colour, type SwissHistory, type SwissStanding } from "@seazn/engine/scheduling";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { confirmRegistration } from "../registrations";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  buildSwissHistory,
  createStages,
  generateStageFixtures,
  swissFieldForRound,
  type ActiveEntrant,
  type SwissExistingFixture,
} from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedRegistration } from "./_registration-fixtures";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ─── The pure parts: the field filter, and the history rule at its boundary ─────────────────────────────────────────

const ent = (id: string, first: number | null, seed: number | null = null): ActiveEntrant => ({ id, seed, swiss_first_round: first });

function row(round: number, seq: number, home: string | null, away: string | null, winner: string | null): SwissExistingFixture {
  return {
    id: `r${round}b${seq}`,
    ext_key: away === null ? `sw-r${round}-bye` : `sw-r${round}-b${seq}`,
    round_no: round,
    seq_in_round: seq,
    status: winner === null ? "scheduled" : "decided",
    home_entrant_id: home,
    away_entrant_id: away,
    outcome: winner === null ? null : { kind: "win", winner },
    scheduled_at: null,
    court_id: null,
    venue_id: null,
    schedule_locked: false,
  };
}

describe("W3 T6 swissFieldForRound: the field of round r is every entrant whose first round is <= r", () => {
  it("drops an entrant whose first round is after the target, keeps null and earlier, and keeps the order", () => {
    const field = [ent("a", null, 1), ent("late4", 4), ent("b", 2, 2), ent("late3", 3)];
    expect(swissFieldForRound(field, 1).map((e) => e.id)).toEqual(["a"]);
    expect(swissFieldForRound(field, 2).map((e) => e.id)).toEqual(["a", "b"]);
    expect(swissFieldForRound(field, 3).map((e) => e.id)).toEqual(["a", "b", "late3"]);
    expect(swissFieldForRound(field, 4).map((e) => e.id)).toEqual(["a", "late4", "b", "late3"]);
  });
  it("the empty case: no entrants is no field", () => {
    expect(swissFieldForRound([], 3)).toEqual([]);
  });
});

describe("W3 T6 buildSwissHistory: an implicit bye is credited only for a round the entrant was in the field for", () => {
  // Rounds 1 and 2 fully seated with NO bye row (the legacy shape the implicit-bye inference exists for); L sat out both.
  const rows = [
    row(1, 1, "A", "B", "A"),
    row(1, 2, "C", "D", "C"),
    row(2, 1, "A", "C", "A"),
    row(2, 2, "B", "D", "B"),
  ];
  const others = [ent("A", null, 1), ent("B", null, 2), ent("C", null, 3), ent("D", null, 4)];
  const historyOf = (first: number | null) => buildSwissHistory(rows, [...others, ent("L", first)], new Map());

  it("X-SW-8 boundary: first round 3 — neither round credited (score 0, still bye-eligible)", () => {
    const h = historyOf(3);
    expect(h.score.get("L")).toBe(0);
    expect(h.byes.has("L")).toBe(false);
  });
  it("X-SW-8 boundary: first round 2 — round 1 not credited, round 2 (in the field, unseen, no bye row) credited", () => {
    const h = historyOf(2);
    expect(h.score.get("L")).toBe(1);
    expect(h.byes.has("L")).toBe(true);
  });
  it("legacy: null — both rounds credited, exactly as before the field model", () => {
    const h = historyOf(null);
    expect(h.score.get("L")).toBe(2);
    expect(h.byes.has("L")).toBe(true);
  });
  it("the seated players' history is the same whatever L's first round", () => {
    const strip = (h: ReturnType<typeof historyOf>) => ({
      score: [...h.score].filter(([id]) => id !== "L").sort(),
      played: [...h.played].sort(),
      colours: [...h.colours].sort(),
      byes: [...h.byes].filter((id) => id !== "L").sort(),
    });
    expect(strip(historyOf(3))).toEqual(strip(historyOf(null)));
    expect(strip(historyOf(null)).played.length, "anti-vacuity: four pairs met").toBe(4);
  });
});

// ─── The DB-backed cases: real rounds, a real arrival, the real Pair ─────────────────────────────────────────────────

interface Board {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string; winner?: string } | null;
}

interface Sport {
  key: "badminton" | "boardgame";
  variant: string;
  config: Record<string, unknown>;
  /** The scorer's quick result: `winner` wins the board. */
  win(auth: AuthCtx, board: Board, winner: string): Promise<void>;
  /** A drawn board, where the sport has one (badminton has none: the better seed wins instead). */
  draw(auth: AuthCtx, board: Board, betterSeed: string): Promise<void>;
}

const SPORTS: Sport[] = [
  {
    key: "badminton",
    variant: "bwf",
    config: {},
    async win(auth, b, winner) {
      const homeWins = winner === b.home_entrant_id;
      await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
      for (const seq of [1, 2]) {
        await scoreEvent(auth, b.id, {
          expected_seq: seq,
          type: "badminton.game.summary",
          payload: homeWins ? { home: 21, away: 10 } : { home: 10, away: 21 },
        });
      }
    },
    async draw(auth, b, betterSeed) {
      await this.win(auth, b, betterSeed);
    },
  },
  {
    key: "boardgame",
    variant: "classical",
    config: { chess: true },
    async win(auth, b, winner) {
      await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(auth, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner, method: "resign" } });
    },
    async draw(auth, b) {
      await scoreEvent(auth, b.id, { expected_seq: 0, type: "core.start", payload: {} });
      await scoreEvent(auth, b.id, { expected_seq: 1, type: "boardgame.result", payload: { winner: null, method: "agreement" } });
    },
  },
];

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** "S1".."S6" and each latecomer's name → entrant id. */
  idOf: Map<string, string>;
  nameOf: (id: string | null | undefined) => string;
}

const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;

const allRows = (stageId: string) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} order by round_no, seq_in_round`;

/** Six individuals S1..S6 seeded 1..6, a 4-round Swiss, started (which mints the shells). */
async function startedSwiss(sport: Sport): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss late " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.key,
    variant_key: sport.variant,
    config: {},
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 4, ...sport.config },
    progression: null,
  });
  await startDivision(auth, division.id);
  const idOf = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    sport,
    auth,
    competitionId: comp.id,
    divisionId: division.id,
    stageId: stage!.id,
    idOf,
    nameOf: (id) => {
      if (!id) return "-";
      for (const [name, v] of idOf) if (v === id) return name;
      return id;
    },
  };
}

/** Each entrant's seed; a latecomer has none and ranks after every seed. */
async function seeds(divisionId: string): Promise<Map<string, number>> {
  const rows = await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${divisionId}`;
  return new Map(rows.map((r) => [r.id, r.seed ?? Number.POSITIVE_INFINITY]));
}

/** Decide every two-seated, still-open board of `round`: the better seed wins (or draws, where `draws` names the seq). */
async function decideRound(r: Rig, round: number, draws: ReadonlySet<number> = new Set()): Promise<number> {
  const seedOf = await seeds(r.divisionId);
  let decided = 0;
  for (const b of await boardsOf(r.stageId, round)) {
    if (b.home_entrant_id === null || b.away_entrant_id === null || b.status !== "scheduled") continue;
    const better = seedOf.get(b.home_entrant_id)! < seedOf.get(b.away_entrant_id)! ? b.home_entrant_id : b.away_entrant_id;
    if (draws.has(b.seq_in_round)) await r.sport.draw(r.auth, b, better);
    else await r.sport.win(r.auth, b, better);
    decided++;
  }
  return decided;
}

/** Pair the next round, reading what the engine was handed. */
async function pairSpied(r: Rig): Promise<{ standings: SwissStanding[]; history: SwissHistory }> {
  const engine = await import("@seazn/engine/scheduling");
  const spy = vi.spyOn(engine, "pairRound");
  try {
    await generateStageFixtures(r.auth, r.stageId);
    expect(spy.mock.calls.length, "anti-vacuity: the Pair called the engine once").toBe(1);
    const [standings, history] = spy.mock.calls[0]!;
    return { standings: [...standings], history };
  } finally {
    spy.mockRestore();
  }
}

/** Rounds 1 and 2 paired and played (six players: no bye row in either round). */
async function twoRoundsPlayed(sport: Sport): Promise<Rig> {
  const r = await startedSwiss(sport);
  for (const round of [1, 2]) {
    await generateStageFixtures(r.auth, r.stageId);
    expect(await decideRound(r, round), `rig: round ${round} seats and decides three boards`).toBe(3);
  }
  const rows = await allRows(r.stageId);
  expect(rows.filter((f) => f.round_no <= 2 && isOneSidedAwardBye(f)).length, "rig: rounds 1 and 2 hold no bye row").toBe(0);
  return r;
}

/** A player arrives after Start through the registration confirm, and (Task 9's write) is given a first Swiss round. */
async function arrive(r: Rig, name: string, firstRound: number | null): Promise<string> {
  const { registration } = await seedRegistration(
    r.competitionId,
    r.divisionId,
    { fee_cents: 0, currency: "eur", payment_method: "offline" },
    { displayName: name },
  );
  const confirmed = await confirmRegistration(r.auth, registration.id);
  const id = confirmed.entrant_id;
  expect(id, `rig: confirming ${name}'s registration created an entrant`).toBeTruthy();
  const [row] = await sql<{ status: string; seed: number | null }[]>`select status, seed from entrants where id = ${id!}`;
  expect(row, `rig: ${name} is in the active field, unseeded`).toEqual({ status: "confirmed", seed: null });
  if (firstRound !== null) await sql`update entrants set swiss_first_round = ${firstRound} where id = ${id!}`;
  r.idOf.set(name, id!);
  return id!;
}

/** Each player's score from the recorded results (FIDE game points: 1 per win, ½ per draw; a bye pays a win). */
async function recordedScores(stageId: string): Promise<Map<string, number>> {
  const score = new Map<string, number>();
  const add = (id: string, n: number) => score.set(id, (score.get(id) ?? 0) + n);
  for (const f of await allRows(stageId)) {
    if (f.outcome?.kind === "win" || f.outcome?.kind === "award") {
      if (f.outcome.winner) add(f.outcome.winner, 1);
    } else if (f.outcome?.kind === "draw") {
      add(f.home_entrant_id!, 0.5);
      add(f.away_entrant_id!, 0.5);
    }
    for (const id of [f.home_entrant_id, f.away_entrant_id]) if (id) add(id, 0);
  }
  return score;
}

/** Round `round`'s row seating `id`, if any. */
const seatOf = (rows: Board[], round: number, id: string) =>
  rows.find((f) => f.round_no === round && (f.home_entrant_id === id || f.away_entrant_id === id));

for (const sport of SPORTS) {
  describe.runIf(HAS_DB)(`W3 T6 X-SW-8 a Swiss latecomer's missed rounds score 0 (${sport.key})`, () => {
    it(`X-SW-8 an entrant created after round 2 was seated scores 0, not +2, in round 3's score groups (${sport.key})`, async () => {
      const r = await twoRoundsPlayed(sport);
      const before = await recordedScores(r.stageId);
      const twoPoint = [...before].filter(([, s]) => s === 2).map(([id]) => id);
      expect(twoPoint.length, "witness: round 3 has a 2-point group to be wrongly paired into").toBeGreaterThan(0);
      const late = await arrive(r, "Late", 3);

      const { standings } = await pairSpied(r);
      const mine = standings.find((s) => s.entrantId === late);
      expect(mine, "the latecomer is in round 3's field").toBeDefined();
      // Rulebook §4 late-entry row / FIDE C.04.2 2.4: 0 for each missed round.
      expect(mine!.score, "the latecomer enters round 3 on 0 points").toBe(0);

      const seat = seatOf(await allRows(r.stageId), 3, late);
      expect(seat, "the latecomer is seated in round 3").toBeDefined();
      const opponent = seat!.home_entrant_id === late ? seat!.away_entrant_id : seat!.home_entrant_id;
      if (opponent !== null) {
        expect(twoPoint, `the latecomer never meets the 2-point group (met ${r.nameOf(opponent)})`).not.toContain(opponent);
        expect(before.get(opponent), `the latecomer is paired inside the 0-point group (met ${r.nameOf(opponent)})`).toBe(0);
      } else {
        expect(isOneSidedAwardBye(seat!), "or the latecomer's seat is round 3's bye").toBe(true);
      }
    }, 120_000);

    it(`X-SW-8 a missed round is not a bye: the latecomer is still bye-eligible (${sport.key})`, async () => {
      const r = await twoRoundsPlayed(sport);
      const late = await arrive(r, "Late", 3);
      const { standings, history } = await pairSpied(r);
      // P-A4: one pairing-allocated bye at most — and a missed round is not one.
      expect(history.byes?.has(late), "the engine is not told the latecomer has had a bye").toBe(false);
      // The engine's declared rule takes it from there: the bye goes to the lowest-ranked entrant not yet byed. The
      // latecomer is on the lowest score and, unseeded, ranked below every seed — premises checked, so the only way they
      // miss the bye is being marked as having had one.
      const mine = standings.find((s) => s.entrantId === late)!;
      expect(standings.length, "premise: seven players, so round 3 has a bye").toBe(7);
      expect(Math.min(...standings.map((s) => s.score)), "premise: the latecomer's score is the field's lowest").toBe(mine.score);
      expect(Math.max(...standings.map((s) => s.rank)), "premise: and their rank the field's last").toBe(mine.rank);
      const bye = (await boardsOf(r.stageId, 3)).find((f) => isOneSidedAwardBye(f));
      expect(r.nameOf(bye?.home_entrant_id), "the latecomer holds round 3's bye").toBe("Late");
    }, 120_000);

    it(`X-SW-8 sequence: after a withdrawal, a second latecomer — each scores 0 and is bye-eligible (${sport.key})`, async () => {
      const r = await twoRoundsPlayed(sport);
      await withdrawEntrantCascade(r.auth, r.idOf.get("S6")!);
      const before = await recordedScores(r.stageId);
      const twoPoint = new Set([...before].filter(([, s]) => s === 2).map(([id]) => id));
      const first = await arrive(r, "Late1", 3);
      const second = await arrive(r, "Late2", 3);

      const { standings, history } = await pairSpied(r);
      expect(standings.length, "five left after the withdrawal, plus two latecomers").toBe(7);
      for (const id of [first, second]) {
        expect(standings.find((s) => s.entrantId === id)?.score, `${r.nameOf(id)} enters round 3 on 0 points`).toBe(0);
        expect(history.byes?.has(id), `${r.nameOf(id)} is still bye-eligible`).toBe(false);
      }
      const rows = await allRows(r.stageId);
      for (const id of [first, second]) {
        const seat = seatOf(rows, 3, id);
        expect(seat, `${r.nameOf(id)} is seated in round 3`).toBeDefined();
        const opponent = seat!.home_entrant_id === id ? seat!.away_entrant_id : seat!.home_entrant_id;
        expect(opponent !== null && twoPoint.has(opponent), `${r.nameOf(id)} never meets the 2-point group`).toBe(false);
      }
      expect(twoPoint.size, "witness: there is a 2-point group").toBeGreaterThan(0);
    }, 120_000);

    it(`entrants with swiss_first_round null behave exactly as today: the implicit byes are credited (${sport.key})`, async () => {
      const r = await twoRoundsPlayed(sport);
      const late = await arrive(r, "Late", null);
      const rows = await allRows(r.stageId);
      // Today's rule (owner value: live rounds keep their pairings): one implicit bye — a win's point, and the bye spent
      // — for every fully seated round with no bye row that the entrant sat out.
      const implicit = [1, 2].filter((round) => !rows.some((f) => f.round_no === round && isOneSidedAwardBye(f))).length;
      expect(implicit, "rig: rounds 1 and 2 are both such rounds").toBe(2);
      const { standings, history } = await pairSpied(r);
      expect(standings.find((s) => s.entrantId === late)?.score, "credited one point per implicit bye").toBe(implicit);
      expect(history.byes?.has(late), "and marked as having had the bye").toBe(true);
      const bye = (await boardsOf(r.stageId, 3)).find((f) => isOneSidedAwardBye(f));
      expect(bye, "round 3 has a bye").toBeDefined();
      expect(bye!.home_entrant_id, "which the byed latecomer does not get").not.toBe(late);
    }, 120_000);
  });

  describe.runIf(HAS_DB)(`W3 T6 X-SW-12 a latecomer is not seated before their first round (${sport.key})`, () => {
    it(`X-SW-12 an entrant whose first round is 4 is not seated in round 3, after an Undo of its Pair (${sport.key})`, async () => {
      const r = await twoRoundsPlayed(sport);
      await generateStageFixtures(r.auth, r.stageId); // Pair round 3: six players
      // An automatic arrival while round 3 stands takes case (c) — from the next round — and writes no undo barrier
      // (spec §4 rule 11), so the organiser can still Undo the Pair of round 3.
      const late = await arrive(r, "Late", 4);
      await undoDivision(r.auth, r.divisionId);
      const undone = (await boardsOf(r.stageId, 3)).filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null);
      expect(undone.length, "premise (T5): the Undo put round 3 back on its shells").toBe(0);

      const { standings } = await pairSpied(r); // Pair round 3 again
      expect(standings.map((s) => s.entrantId), "round 3's field is the six who were there").not.toContain(late);
      expect(standings.length).toBe(6);
      const round3 = await boardsOf(r.stageId, 3);
      expect(round3.filter((f) => f.home_entrant_id === late || f.away_entrant_id === late), "the latecomer holds no round-3 row").toEqual([]);
      expect(round3.some((f) => isOneSidedAwardBye(f) || /-bye$/.test(f.ext_key ?? "")), "an even field of six: no bye row").toBe(false);
      expect(round3.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null).length, "three boards seated").toBe(3);

      // The positive pair: round 4 is their first, so they are seated there — on 0 points for the three they missed.
      expect(await decideRound(r, 3), "rig: round 3 decided").toBe(3);
      const next = await pairSpied(r);
      expect(next.standings.find((s) => s.entrantId === late)?.score, "the latecomer enters round 4 on 0 points").toBe(0);
      expect(seatOf(await allRows(r.stageId), 4, late), "the latecomer is seated in round 4").toBeDefined();
    }, 120_000);
  });

  describe.runIf(HAS_DB)(`W3 T6 X-SW-12 before Start, each round is sized to its own field (${sport.key})`, () => {
    it(`X-SW-12 a first round of 2: round 1 is minted and paired without them, every later round with them (${sport.key})`, async () => {
      // Five players, the fifth given first round 2 before the first Generate. Expected shapes (rulebook §3.1): n players
      // pair as ⌊n/2⌋ boards, plus a bye when n is odd — round 1's field is 4 (two boards, no bye), round 2's and
      // round 3's is 5 (two boards and a bye). Before Start the Pair resizes every unseated round (owner ruling
      // 2026-09-22), so this is where a later round's field is read.
      const { auth } = await seedOrg("pro");
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Swiss field " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
      const division = await createDivision(auth, comp.id, {
        name: "Open",
        slug: "open-" + randomUUID().slice(0, 6),
        sport_key: sport.key,
        variant_key: sport.variant,
        config: {},
      });
      const players = await createEntrants(
        auth,
        division.id,
        Array.from({ length: 5 }, (_, i) => ({ kind: "individual" as const, display_name: `S${i + 1}`, seed: i + 1, members: [] })),
      );
      const fifth = players[4]!.id;
      await sql`update entrants set swiss_first_round = 2 where id = ${fifth}`;
      const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3, ...sport.config }, progression: null });
      const shape = async (round: number) => {
        const rows = await boardsOf(stage!.id, round);
        return { boards: rows.filter((f) => !/-bye$/.test(f.ext_key ?? "")).length, bye: rows.filter((f) => /-bye$/.test(f.ext_key ?? "")).length };
      };

      await generateStageFixtures(auth, stage!.id); // the mint
      expect(await shape(1), "minted at round 1's field: two boards, no bye").toEqual({ boards: 2, bye: 0 });

      await generateStageFixtures(auth, stage!.id); // Pair round 1, before Start
      const round1 = await boardsOf(stage!.id, 1);
      expect(round1.filter((f) => f.home_entrant_id === fifth || f.away_entrant_id === fifth), "the fifth is on no round-1 row").toEqual([]);
      expect(round1.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null).length, "the other four on two boards").toBe(2);
      for (const round of [2, 3]) {
        expect(await shape(round), `round ${round} is sized to its field of five: two boards and a bye`).toEqual({ boards: 2, bye: 1 });
      }
    }, 120_000);
  });

  describe.runIf(HAS_DB)(`W3 T6 buildSwissHistory is the pre-T6 history loop, unchanged for a legacy stage (${sport.key})`, () => {
    it(`over real rows — walkover, double walkover, draws, implicit byes, a bye row, a withdrawal — the two agree (${sport.key})`, async () => {
      const r = await startedSwiss(sport);
      const checked: string[] = [];
      const compare = async (label: string) => {
        const existing = await sql<SwissExistingFixture[]>`
          select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
                 scheduled_at, court_id, venue_id, schedule_locked
          from fixtures where stage_id = ${r.stageId}
          order by round_no, seq_in_round`;
        const entrants = await sql<ActiveEntrant[]>`
          select id, seed, swiss_first_round from entrants
          where division_id = ${r.divisionId} and status in ('registered', 'confirmed')
          order by seed nulls last, created_at, id`;
        expect(entrants.every((e) => e.swiss_first_round === null), `${label}: a legacy stage (every first round null)`).toBe(true);
        const want = legacySwissHistory(existing, entrants);
        const got = buildSwissHistory(existing, entrants, new Map());
        expect(flat(got), `${label}: identical {score, played, colours, byes}`).toEqual(flat(want));
        checked.push(label);
        return want;
      };

      // Round 1: a one-sided walkover, a double walkover, and a played board (a draw where the sport has one).
      await generateStageFixtures(r.auth, r.stageId);
      const r1 = (await boardsOf(r.stageId, 1)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
      expect(r1.length, "rig: round 1 seats three boards").toBe(3);
      await scoreEvent(r.auth, r1[0]!.id, { expected_seq: 0, type: "core.forfeit", payload: { by: r1[0]!.away_entrant_id, reason: "walkover" } });
      await scoreEvent(r.auth, r1[1]!.id, { expected_seq: 0, type: "core.forfeit", payload: { by: "both", reason: "walkover" } });
      await decideRound(r, 1, new Set([3]));
      // Round 2 played; a latecomer with no first round then sits out rounds 1 and 2 (the implicit-bye inference).
      await generateStageFixtures(r.auth, r.stageId);
      expect(await decideRound(r, 2, new Set([1])), "rig: round 2 decided").toBe(3);
      await arrive(r, "Late", null);
      const a = await compare("after round 2, a latecomer unseen in two bye-less rounds");
      // Round 3: seven players, so a bye row; then a withdrawal (a departed player's results stay in the rows).
      await generateStageFixtures(r.auth, r.stageId);
      await decideRound(r, 3);
      const b = await compare("after round 3, with a bye row");
      await withdrawEntrantCascade(r.auth, r.idOf.get("S6")!);
      await compare("after a withdrawal");

      // Anti-vacuity: the comparisons ran over every shape they claim to.
      expect(checked.length, "three comparisons").toBe(3);
      expect(a.played.size, "pairs met").toBeGreaterThan(0);
      expect(a.byes.has(r.idOf.get("Late")!), "the implicit bye was inferred, so that path was compared").toBe(true);
      expect([...a.colours.values()].flat().length, "colours recorded").toBeGreaterThan(0);
      expect(b.byes.size, "byes: the walkover winner, the latecomer, round 3's bye").toBeGreaterThanOrEqual(3);
      const rows = await allRows(r.stageId);
      expect(rows.some((f) => f.outcome?.kind === "double_walkover"), "a double walkover was compared").toBe(true);
      expect(rows.some((f) => f.outcome?.kind === "award" && f.away_entrant_id !== null), "a two-sided walkover was compared").toBe(true);
      expect(rows.some((f) => isOneSidedAwardBye(f)), "a bye row was compared").toBe(true);
      if (sport.key === "boardgame") expect(rows.some((f) => f.outcome?.kind === "draw"), "a draw was compared").toBe(true);
    }, 180_000);
  });
}

type History = { score: Map<string, number>; played: Set<string>; colours: Map<string, Colour[]>; byes: Set<string> };

/** A comparable, order-free view: every map and set as a sorted list. */
const flat = (h: History) => ({
  score: [...h.score].sort(([a], [b]) => a.localeCompare(b)),
  played: [...h.played].sort(),
  colours: [...h.colours].sort(([a], [b]) => a.localeCompare(b)),
  byes: [...h.byes].sort(),
});

/**
 * The ORACLE: swissGen's history loop as it stood before Task 6 (stages.ts at 3ca1a13890, `swissGen`, from
 * `const score = …` through the implicit-bye loop), copied verbatim except that it returns its four collections. It is
 * the "unchanged" in "extracted unchanged except for this task's rule": for a stage where every first round is null the
 * extracted function must agree with it on every row the product writes.
 */
function legacySwissHistory(existing: SwissExistingFixture[], entrants: { id: string }[]): History {
  const score = new Map<string, number>(entrants.map((e) => [e.id, 0]));
  const played = new Set<string>();
  const colours = new Map<string, Colour[]>();
  const byes = new Set<string>();
  const inRound = new Map<number, Set<string>>();
  for (const f of existing) {
    const o = f.outcome as { kind?: string; winner?: string } | null;
    if (isOneSidedAwardBye(f) && o?.winner) {
      const forRound = inRound.get(f.round_no) ?? new Set<string>();
      forRound.add(o.winner);
      inRound.set(f.round_no, forRound);
      byes.add(o.winner);
      score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
      continue;
    }
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    played.add(pairKey(f.home_entrant_id, f.away_entrant_id));
    const forRound = inRound.get(f.round_no) ?? new Set<string>();
    forRound.add(f.home_entrant_id).add(f.away_entrant_id);
    inRound.set(f.round_no, forRound);
    if (o?.kind !== "award" && o?.kind !== "double_walkover") {
      (colours.get(f.home_entrant_id) ?? colours.set(f.home_entrant_id, []).get(f.home_entrant_id)!).push("W");
      (colours.get(f.away_entrant_id) ?? colours.set(f.away_entrant_id, []).get(f.away_entrant_id)!).push("B");
    }
    if (o?.kind === "award" && o.winner) byes.add(o.winner);
    if ((o?.kind === "win" || o?.kind === "award") && o.winner) score.set(o.winner, (score.get(o.winner) ?? 0) + 1);
    else if (o?.kind === "draw" || o?.kind === "tie") {
      score.set(f.home_entrant_id, (score.get(f.home_entrant_id) ?? 0) + 0.5);
      score.set(f.away_entrant_id, (score.get(f.away_entrant_id) ?? 0) + 0.5);
    }
  }
  const latestSeated = latestSeatedSwissRound(existing);
  for (let r = 1; r <= (latestSeated ?? 0); r++) {
    const inRoundR = existing.filter((f) => f.round_no === r);
    if (
      !inRoundR.every((f) =>
        isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
      )
    ) {
      continue;
    }
    if (inRoundR.some((f) => isOneSidedAwardBye(f))) continue;
    const seen = inRound.get(r) ?? new Set();
    for (const e of entrants) {
      if (!seen.has(e.id)) {
        byes.add(e.id);
        score.set(e.id, (score.get(e.id) ?? 0) + 1);
      }
    }
  }
  return { score, played, colours, byes };
}
