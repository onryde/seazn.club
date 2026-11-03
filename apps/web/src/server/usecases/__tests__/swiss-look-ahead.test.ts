// W3 app-B Task 7 (X-SW-10 the one-round look-ahead; X-SW-11 the final round's topscorer exception; rulebook-W3-swiss.md §3.3
// "Prevention", §3.1; FIDE C.04.3 (1 Feb 2026) Art. 1.8, [C3] Art. 2.1.3; engine 2.0.0 `pairRound`) on Postgres.
//
// The seams, both of which the engine declares and nothing in production sent before this task (AGENTS.md class 1):
//   X-SW-10  `constraints.lookAhead`  - sent on every round but the last of a stage that plays MORE rounds than the safe maximum
//            ⌊n/2⌋ of the field it is paired over (n = `swissFieldForRound`, the field of THAT round). The engine then prefers a
//            seating after which the next round can still be paired, and reports `nextRound`; an "unpairable" or "unknown"
//            verdict rides on the Generate's answer as `swiss_next_round` (with `swiss_paired_round`, the round it follows).
//   X-SW-11  `constraints.finalRoundMaxScore` - sent only with chess colours on, on a stage's last round (rounds > 1),
//            (rounds − 1) × the most one fixture pays one side under the stage's own points rule (`maxRoundPoints`, in the table
//            points the pairing score is measured in), and at most ONCE per stage: an "Add a round" after the final round was
//            paired must not send it a second time.
//
// Every expected value is the test's own: a brute-force oracle for "can the next round still be paired" (rematch-free perfect
// matchings, and with chess colours on the absolute limits of FIDE C.04.3: never three in a row, a colour difference within
// ±2, a board needs an assignment that suits both), and each maximum from the sport's DECLARED rule (`tablePointsRule`) or the
// test's own pinned rule. What the engine was handed is read through a spy on `pairRound`; the seated rows are read back with
// SQL - both, so a spy alone cannot pass.
//
// The two constructions below were FOUND by brute force over seeded histories and are committed as named fixtures with their
// seeds (the way the engine plan found S6). Each is a hand-seeded history written onto the minted shells by SQL and then PLAYED
// through the scorer's own events, so the table points the pairing reads are real:
//   S6                      - six entrants, the first two rounds a 6-cycle: R1 {p0-p1, p2-p3, p4-p5}, R2 {p0-p5, p1-p2, p3-p4}.
//   UNPAIRABLE_NEXT_N8      - chess, eight entrants, four rounds (seed 8078287): round 5 has legal pairings, and every one of
//                             them leaves round 6 without a legal pairing under the colour limits. No rematch-only history of
//                             n = 6..8 does this for a non-last round (searched: 0 in 20 000 random histories each), which is
//                             why this one is a chess history.
//   TOPSCORERS_WW_N6        - chess, six entrants, three rounds (seed 692054): p0 and p1 are topscorers of a four-round Swiss,
//                             both played White in their last two games, and round 4 pairs them against each other.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import type { PointsRule } from "@seazn/engine/competition";
import type { SwissConstraints, SwissHistory, SwissStanding } from "@seazn/engine/scheduling";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stageTablePoints } from "@/server/engine-db/competition";
import { maxRoundPoints } from "@/server/engine-db/swiss-max-round-points";
import { post } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { createStages, generateStageFixtures, unpairSwissRound, type GenerateOutcome } from "../stages";
import { addSwissRound } from "../swiss-rounds-admin";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ─── The rig ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Res = "h" | "a" | "d";
/** A history round as [home index, away index, result]: p0..pn-1 are seeds 1..n; `h` the home side wins, `a` the away side. */
type Played = readonly (readonly (readonly [number, number, Res])[])[];

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
  key: "badminton" | "boardgame" | "football";
  variant: string;
  chess: boolean;
  config: Record<string, unknown>;
  /** Score a board to its result through the scorer's own events: the home side wins, the away side wins, or a draw (chess). */
  result(auth: AuthCtx, b: Board, res: Res): Promise<void>;
}

const BADMINTON: Sport = {
  key: "badminton",
  variant: "bwf",
  chess: false,
  config: {},
  async result(auth, b, res) {
    if (res === "d") throw new Error("badminton has no draw");
    await post(auth, b.id, "core.start");
    for (let i = 0; i < 2; i++) {
      await post(auth, b.id, "badminton.game.summary", res === "h" ? { home: 21, away: 10 } : { home: 10, away: 21 });
    }
  },
};
const CHESS: Sport = {
  key: "boardgame",
  variant: "classical",
  chess: true,
  config: { chess: true },
  async result(auth, b, res) {
    await post(auth, b.id, "core.start");
    await post(auth, b.id, "boardgame.result", {
      winner: res === "d" ? null : res === "h" ? b.home_entrant_id : b.away_entrant_id,
      method: res === "d" ? "agreement" : "resign",
    });
  },
};
/** Football (11-a-side): the winner scores three, so a pinned margin bonus of 2 or more is earned. Not in SPORTS: it is the bonus arm. */
const FOOTBALL: Sport = {
  key: "football",
  variant: "11-a-side",
  chess: false,
  config: {},
  async result(auth, b, res) {
    if (res === "d") throw new Error("this rig plays decisive football only");
    const winner = res === "h" ? b.home_entrant_id : b.away_entrant_id;
    await post(auth, b.id, "core.start");
    for (let i = 0; i < 3; i++) await post(auth, b.id, "football.goal", { by: winner });
    await post(auth, b.id, "football.period", { phase: "HT" });
    await post(auth, b.id, "football.period", { phase: "FT" });
  },
};
const SPORTS: Sport[] = [BADMINTON, CHESS];

const moduleOf = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
/** The sport's DECLARED Swiss rule under its variant: what the engine says a stage of it pays before any save. */
function declaredRule(sport: Sport): PointsRule {
  const m = moduleOf(sport.key);
  return m.tablePointsRule(m.configSchema.parse(m.variants[sport.variant]), "swiss");
}

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Entrant ids in seed order: ids[0] is seed 1. */
  ids: string[];
}

/** `players` entrants seeded 1..n in a `rounds`-round Swiss of `sport`, the division started (which mints every round's shells). */
async function startedSwiss(sport: Sport, opts: { players: number; rounds: number }): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Swiss look-ahead " + randomUUID().slice(0, 6),
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
    Array.from({ length: opts.players }, (_, i) => ({
      kind: (moduleOf(sport.key).entrantModel?.defaultKind ?? "individual") as "individual",
      display_name: `P${i}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: opts.rounds, ...sport.config },
    progression: null,
  });
  await startDivision(auth, division.id);
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    sport,
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    ids: Array.from({ length: opts.players }, (_, i) => byName.get(`P${i}`)!),
  };
}

const boardsOf = (stageId: string, round: number) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} and round_no = ${round} order by seq_in_round`;
const allSeated = (stageId: string) =>
  sql<Board[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome from fixtures
    where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null order by round_no, seq_in_round`;
const playable = (b: Board): boolean => b.home_entrant_id !== null && b.away_entrant_id !== null && b.status === "scheduled";

/** Write `history` onto the minted shells by SQL, then PLAY every board through the scorer's own events: hand-seeded pairs,
 *  real table points. Counted: a history that wrote nothing is a failure. */
async function seedHistory(r: Rig, history: Played): Promise<number> {
  let boards = 0;
  for (const [i, round] of history.entries()) {
    for (const [b, [home, away]] of round.entries()) {
      const done = await sql`
        update fixtures set home_entrant_id = ${r.ids[home]!}, away_entrant_id = ${r.ids[away]!}, status = 'scheduled', outcome = null
        where stage_id = ${r.stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`} returning id`;
      expect(done.length, `rig: shell sw-r${i + 1}-b${b + 1} exists and took its seats`).toBe(1);
      boards++;
    }
  }
  for (const [i, round] of history.entries()) {
    const rows = await boardsOf(r.stageId, i + 1);
    for (const [b, [, , res]] of round.entries()) await r.sport.result(r.auth, rows[b]!, res);
  }
  expect(boards, "rig: the history is not empty").toBeGreaterThan(0);
  expect(boards, "rig: every history board was seated and played").toBe(history.flat().length);
  return boards;
}

/** Decide every playable board of `round`, `how` choosing each result. */
async function decideRound(r: Rig, round: number, how: (b: Board, i: number) => Res = () => "h"): Promise<number> {
  let n = 0;
  for (const b of (await boardsOf(r.stageId, round)).filter(playable)) {
    await r.sport.result(r.auth, b, how(b, n));
    n++;
  }
  return n;
}

interface Call {
  standings: SwissStanding[];
  history: SwissHistory;
  constraints: SwissConstraints | undefined;
}
type Settled = { out: GenerateOutcome; err?: undefined; calls: Call[] } | { out?: undefined; err: { code?: string; status?: number; extra?: unknown }; calls: Call[] };

/** One Pair, read through a spy on the engine's `pairRound`; a refusal is returned, not thrown. */
async function pairSettled(r: Rig, wrap?: (real: (typeof import("@seazn/engine/scheduling"))["pairRound"]) => (...a: Parameters<(typeof import("@seazn/engine/scheduling"))["pairRound"]>) => ReturnType<(typeof import("@seazn/engine/scheduling"))["pairRound"]>): Promise<Settled> {
  const engine = await import("@seazn/engine/scheduling");
  const real = engine.pairRound;
  const spy = vi.spyOn(engine, "pairRound");
  if (wrap !== undefined) spy.mockImplementation(wrap(real));
  try {
    const settled = await generateStageFixtures(r.auth, r.stageId).then(
      (out) => ({ out }),
      (err: unknown) => ({ err: err as { code?: string; status?: number; extra?: unknown } }),
    );
    const calls = spy.mock.calls.map(([standings, history, constraints]) => ({ standings: [...standings], history, constraints }));
    return { ...settled, calls } as Settled;
  } finally {
    spy.mockRestore();
  }
}
/** A Pair that must go through; the engine was called exactly once. */
async function pairOk(r: Rig): Promise<{ out: GenerateOutcome; call: Call }> {
  const s = await pairSettled(r);
  expect(s.err, `the Pair goes through (it answered ${JSON.stringify(s.err ?? null)})`).toBeUndefined();
  expect(s.calls.length, "anti-vacuity: the Pair called the engine once").toBe(1);
  return { out: s.out!, call: s.calls[0]! };
}

// ─── The oracle: can a round still be paired? ───────────────────────────────────────────────────────────────────────

type C = "W" | "B";
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** P-A5 for one entrant: it may take colour `c` iff its sequence with `c` added is within both limits (rulebook §2.3 item 2). */
function mayTake(seq: readonly C[], c: C): boolean {
  const s = [...seq, c];
  const w = s.filter((x) => x === "W").length;
  if (Math.abs(w - (s.length - w)) > 2) return false;
  const n = s.length;
  return !(n >= 3 && s[n - 1] === s[n - 2] && s[n - 2] === s[n - 3]);
}
interface Lay {
  met: ReadonlySet<string>;
  colours: ReadonlyMap<string, readonly C[]>;
}
function layOf(rows: readonly Board[]): Lay {
  const met = new Set<string>();
  const colours = new Map<string, C[]>();
  for (const f of rows) {
    if (f.home_entrant_id === null || f.away_entrant_id === null) continue;
    met.add(pairKey(f.home_entrant_id, f.away_entrant_id));
    colours.set(f.home_entrant_id, [...(colours.get(f.home_entrant_id) ?? []), "W"]);
    colours.set(f.away_entrant_id, [...(colours.get(f.away_entrant_id) ?? []), "B"]);
  }
  return { met, colours };
}
/** The ways a board of `a` v `b` can be coloured: (a home, b home) where each side may take its colour; without chess, one. */
function orientations(a: string, b: string, lay: Lay, chess: boolean): { home: string; away: string }[] {
  if (!chess) return [{ home: a, away: b }];
  const sa = lay.colours.get(a) ?? [];
  const sb = lay.colours.get(b) ?? [];
  const out: { home: string; away: string }[] = [];
  if (mayTake(sa, "W") && mayTake(sb, "B")) out.push({ home: a, away: b });
  if (mayTake(sa, "B") && mayTake(sb, "W")) out.push({ home: b, away: a });
  return out;
}
/** Every legal round over `ids` (an even field): rematch-free perfect matchings, each board in each legal colouring. */
function legalRounds(ids: readonly string[], lay: Lay, chess: boolean): { home: string; away: string }[][] {
  if (ids.length === 0) return [[]];
  const [first, ...rest] = ids as [string, ...string[]];
  const out: { home: string; away: string }[][] = [];
  for (const other of rest) {
    if (lay.met.has(pairKey(first, other))) continue;
    for (const board of orientations(first, other, lay, chess)) {
      for (const tail of legalRounds(rest.filter((x) => x !== other), lay, chess)) out.push([board, ...tail]);
    }
  }
  return out;
}
/** Does a legal round exist at all? (the existence question, without enumerating colourings) */
function roundExists(ids: readonly string[], lay: Lay, chess: boolean): boolean {
  if (ids.length === 0) return true;
  const [first, ...rest] = ids as [string, ...string[]];
  return rest.some(
    (other) =>
      !lay.met.has(pairKey(first, other)) &&
      orientations(first, other, lay, chess).length > 0 &&
      roundExists(rest.filter((x) => x !== other), lay, chess),
  );
}
function after(lay: Lay, round: readonly { home: string; away: string }[]): Lay {
  const met = new Set(lay.met);
  const colours = new Map([...lay.colours].map(([k, v]) => [k, [...v]]));
  for (const { home, away } of round) {
    met.add(pairKey(home, away));
    colours.set(home, [...(colours.get(home) ?? []), "W"]);
    colours.set(away, [...(colours.get(away) ?? []), "B"]);
  }
  return { met, colours };
}
const pairsOf = (rows: readonly Board[]) => rows.filter((f) => f.home_entrant_id && f.away_entrant_id).map((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!)).sort();

// ─── The histories ──────────────────────────────────────────────────────────────────────────────────────────────────

/** S6: the first two rounds of six entrants as a 6-cycle. Each entrant wins one board and loses one, so every score is level and
 *  the fold seats the three diameters {p0-p3, p1-p4, p2-p5}; the 6-cycle's complement is two triangles joined by the diameters,
 *  and the diameters leave exactly those two triangles - no perfect matching for round 4. */
const S6: Played = [
  [[0, 1, "h"], [2, 3, "h"], [4, 5, "h"]],
  [[0, 5, "a"], [1, 2, "h"], [3, 4, "h"]],
];

/** UNPAIRABLE_NEXT_N8, seed 8078287 (see the header): eight chess entrants, four played rounds. */
const UNPAIRABLE_NEXT_N8: Played = [
  [[6, 3, "a"], [4, 1, "h"], [0, 5, "a"], [7, 2, "d"]],
  [[5, 3, "a"], [7, 4, "a"], [2, 1, "h"], [0, 6, "a"]],
  [[3, 4, "a"], [5, 2, "d"], [6, 7, "a"], [1, 0, "d"]],
  [[4, 2, "a"], [7, 5, "h"], [1, 6, "a"], [3, 0, "h"]],
];

/** TOPSCORERS_WW_N6, seed 692054 (see the header): six chess entrants, three played rounds of a four-round Swiss. After them
 *  p0 has 6 (three wins), p1 and p4 have 4: with the final round's maximum 6, over half of it (3) makes all three topscorers.
 *  p0 and p1 each played White in rounds 2 and 3 (an absolute preference for Black), and have not met. */
const TOPSCORERS_WW_N6: Played = [
  [[2, 1, "a"], [3, 4, "a"], [5, 0, "a"]],
  [[4, 2, "h"], [1, 5, "h"], [0, 3, "h"]],
  [[2, 5, "a"], [0, 4, "h"], [1, 3, "a"]],
];

const withoutLookAhead = (c: SwissConstraints | undefined): SwissConstraints => {
  const { lookAhead: _drop, ...rest } = c ?? {};
  void _drop;
  return rest;
};

// ─── X-SW-10 ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.runIf(HAS_DB)("X-SW-10 the look-ahead is sent above the safe maximum, on every round but the last", () => {
  let ran = 0;
  for (const sport of SPORTS) {
    it(`X-SW-10 6 entrants, 5 rounds: round 3 is paired with lookAhead and round 4 stays pairable (${sport.key})`, async () => {
      const r = await startedSwiss(sport, { players: 6, rounds: 5 });
      await seedHistory(r, S6);
      const { out, call } = await pairOk(r);
      expect(call.constraints?.lookAhead, "the engine was asked for the look-ahead").toBe(true);

      const round3 = await boardsOf(r.stageId, 3);
      expect(round3.filter(playable).length, "round 3 is seated: three boards").toBe(3);
      const prior = (await allSeated(r.stageId)).filter((f) => f.round_no <= 2);
      const lay = layOf(prior);
      const seated = round3.map((f) => ({ home: f.home_entrant_id!, away: f.away_entrant_id! }));

      // The oracle: the seated round 3 leaves a legal round 4 (rulebook §3.1).
      expect(roundExists(r.ids, after(lay, seated), sport.chess), "round 4 can still be paired after the seated round 3").toBe(true);

      // differential: without lookAhead the fold seats the three diameters, which leave two triangles - no round 4.
      const engine = await import("@seazn/engine/scheduling");
      const fold = engine.pairRound(call.standings, call.history, withoutLookAhead(call.constraints));
      expect(fold.ok, "premise: the engine without the look-ahead pairs round 3").toBe(true);
      const diameters = [pairKey(r.ids[0]!, r.ids[3]!), pairKey(r.ids[1]!, r.ids[4]!), pairKey(r.ids[2]!, r.ids[5]!)].sort();
      expect(fold.ok ? fold.pairings.map((p) => pairKey(p.home, p.away)).sort() : [], "premise: the plain fold seats the diameters").toEqual(diameters);
      expect(
        roundExists(r.ids, after(lay, fold.ok ? fold.pairings : []), sport.chess),
        "premise: the oracle says the diameters kill round 4",
      ).toBe(false);
      expect(pairsOf(round3), "the seated round 3 is NOT the diameters").not.toEqual(diameters);

      expect(out.swiss_next_round, "round 4 stays pairable: no warning").toBeUndefined();
      expect(out.swiss_paired_round, "and no verdict, so no round to name").toBeUndefined();
      ran++;
    }, 180_000);
  }

  for (const sport of SPORTS) {
    it(`X-SW-10 empty case: 6 entrants, 3 rounds (= the safe maximum) send no lookAhead on any round, and no warning (${sport.key})`, async () => {
      const r = await startedSwiss(sport, { players: 6, rounds: 3 });
      const sent: (boolean | undefined)[] = [];
      for (let round = 1; round <= 3; round++) {
        const { out, call } = await pairOk(r);
        sent.push(call.constraints?.lookAhead);
        expect(out.swiss_next_round, `round ${round}: no warning`).toBeUndefined();
        if (round < 3) await decideRound(r, round);
      }
      expect(sent.length, "anti-vacuity: three rounds were paired").toBe(3);
      expect(sent.every((s) => s !== true), "no round asked for the look-ahead: 3 rounds is not above the safe maximum 3").toBe(true);
      ran++;
    }, 240_000);
  }

  for (const sport of SPORTS) {
    it(`X-SW-10 the last round never asks for a look-ahead, though the count is above the safe maximum (${sport.key})`, async () => {
      // four entrants: safe maximum 2, three rounds declared - above it. Rounds 1 and 2 ask; the last (a full round robin) does not.
      const r = await startedSwiss(sport, { players: 4, rounds: 3 });
      const sent: (boolean | undefined)[] = [];
      for (let round = 1; round <= 3; round++) {
        const s = await pairSettled(r);
        expect(s.calls.length, `round ${round}: the engine was called once`).toBe(1);
        sent.push(s.calls[0]!.constraints?.lookAhead);
        if (round < 3) {
          expect(s.err, `round ${round} pairs`).toBeUndefined();
          await decideRound(r, round);
        }
      }
      expect(sent, "rounds 1 and 2 ask for the look-ahead, round 3 (the last) does not").toEqual([true, true, undefined]);
      ran++;
    }, 240_000);
  }

  it("X-SW-10 a round whose every legal pairing kills the next returns swiss_next_round unpairable, names the round, and still seats it (UNPAIRABLE_NEXT_N8, chess)", async () => {
    // single-sport: the construction is colour-shaped (no rematch-only history of 6-8 players has a non-last round like it).
    const r = await startedSwiss(CHESS, { players: 8, rounds: 6 });
    await seedHistory(r, UNPAIRABLE_NEXT_N8);
    const prior = await allSeated(r.stageId);
    const lay = layOf(prior);

    // The oracle first: round 5 HAS legal pairings, and none of them leaves a legal round 6.
    const legal = legalRounds(r.ids, lay, true);
    expect(legal.length, `premise: round 5 has legal pairings (${legal.length})`).toBeGreaterThan(0);
    const survivors = legal.filter((round) => roundExists(r.ids, after(lay, round), true));
    expect(survivors.length, "premise: no legal round 5 leaves a legal round 6").toBe(0);

    const first = await pairOk(r);
    expect(first.call.constraints?.lookAhead, "round 5 of 6 asks for the look-ahead").toBe(true);
    expect(first.out.swiss_next_round, "the verdict").toBe("unpairable");
    expect(first.out.swiss_paired_round, "names the round it follows").toBe(5);
    const round5 = (await boardsOf(r.stageId, 5)).filter(playable);
    expect(round5.length, "and still seats the round: four boards").toBe(4);
    expect(first.out.created, "created counts the seated boards").toBe(4);
    // the seated round is one of the legal ones (the oracle's), not an invention
    const seatedKeys = round5.map((f) => `${f.home_entrant_id}>${f.away_entrant_id}`).sort();
    expect(legal.some((round) => round.map((b) => `${b.home}>${b.away}`).sort().join() === seatedKeys.join()), "the seated round 5 is a legal round").toBe(true);

    // differential: the same input without the look-ahead carries no verdict at all
    const engine = await import("@seazn/engine/scheduling");
    const silent = engine.pairRound(first.call.standings, first.call.history, withoutLookAhead(first.call.constraints));
    expect(silent.ok && silent.nextRound, "premise: without the look-ahead the engine says nothing about round 6").toBeFalsy();

    // second call: Unpair then Pair says the same
    expect((await unpairSwissRound(r.auth, r.stageId)).round, "rig: Unpair cleared round 5").toBe(5);
    const again = await pairOk(r);
    expect(again.out.swiss_next_round, "a second Pair says the same").toBe("unpairable");
    expect(again.out.swiss_paired_round).toBe(5);

    // the warning told the truth: decide round 5, and Pair next is refused by name
    await decideRound(r, 5);
    const sixth = await pairSettled(r);
    expect(sixth.err?.code, "round 6 is refused: SWISS_NO_LEGAL_PAIRING").toBe("SWISS_NO_LEGAL_PAIRING");
    expect((sixth.err?.extra as { round?: number } | undefined)?.round, "and it is round 6").toBe(6);
    ran++;
  }, 360_000);

  it("X-SW-10 an engine verdict of unknown rides on the answer as swiss_next_round unknown, and a pairable one does not (the engine's own result, passed through)", async () => {
    const r = await startedSwiss(BADMINTON, { players: 6, rounds: 5 });
    await seedHistory(r, S6);
    const s = await pairSettled(r, (real) => (...args) => {
      const res = real(...args);
      return res.ok ? { ...res, nextRound: "unknown" as const } : res;
    });
    expect(s.err, "the Pair goes through").toBeUndefined();
    expect(s.out!.swiss_next_round, "unknown rides on the answer").toBe("unknown");
    expect(s.out!.swiss_paired_round, "with the round it follows").toBe(3);
    expect((await boardsOf(r.stageId, 3)).filter(playable).length, "and the round is seated").toBe(3);
    ran++;
  }, 180_000);

  it("anti-vacuity: every X-SW-10 case ran", () => {
    expect(ran, "S6 x2, empty x2, last round x2, unpairable, unknown").toBe(8);
  });
});

// ─── X-SW-11 ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.runIf(HAS_DB)("X-SW-11 the final round of a chess Swiss sends the topscorer maximum, once per stage", () => {
  let ran = 0;

  for (const sport of SPORTS) {
    it(`X-SW-11 the final round sends finalRoundMaxScore = (rounds − 1) × the declared win; earlier rounds send none; badminton sends none (${sport.key})`, async () => {
      const rule = declaredRule(sport);
      const rounds = 3;
      const r = await startedSwiss(sport, { players: 4, rounds });
      const sent: (number | undefined)[] = [];
      for (let round = 1; round <= rounds; round++) {
        const s = await pairSettled(r);
        expect(s.calls.length, `round ${round}: the engine was called once`).toBe(1);
        sent.push(s.calls[0]!.constraints?.finalRoundMaxScore);
        if (round < rounds) {
          expect(s.err, `round ${round} pairs`).toBeUndefined();
          await decideRound(r, round);
        }
      }
      // the rule's own win: chess's declared 2 half-points (rulebook-W3-swiss.md §4: 1 point), badminton's 2 - the maximum is in table points
      const want = sport.chess ? (rounds - 1) * rule.win.regulation : undefined;
      expect(sent, "rounds 1 and 2 send none; the last sends the maximum only with chess colours on").toEqual([undefined, undefined, want]);
      if (sport.chess) expect(want, "premise: chess's maximum is 2 rounds x the declared 2").toBe(4);
      ran++;
    }, 240_000);
  }

  it("X-SW-11 a player on a perfect score before the final round IS a topscorer: the spy's standings score equals finalRoundMaxScore (chess)", async () => {
    const r = await startedSwiss(CHESS, { players: 4, rounds: 3 });
    // p0 wins its board in both rounds (round 1's colours are by lot, so "the home side wins" would not do): a perfect score.
    const top = r.ids[0]!;
    const topWins = (b: Board): Res => (b.home_entrant_id === top ? "h" : "a");
    await pairOk(r);
    await decideRound(r, 1, topWins);
    await pairOk(r);
    await decideRound(r, 2, topWins);

    const s = await pairSettled(r);
    expect(s.calls.length, "anti-vacuity: the final round called the engine").toBe(1);
    const call = s.calls[0]!;
    const max = call.constraints?.finalRoundMaxScore;
    expect(max, "the final round sends a maximum").toBeDefined();
    const mine = call.standings.find((x) => x.entrantId === top)!.score;
    expect(mine, "a player who won every round has the table points of (rounds − 1) maximum wins: exactly the maximum").toBe(max);
    expect(mine, "so it is OVER half of it: a topscorer").toBeGreaterThan(max! / 2);
    // differential: the pre-T5 pairing score (+1 a win) put this player (two wins) on 2, which is NOT over half of 4 - so a
    // topscorer line in table points would have been inert without T5's score
    const winsOfTop = 2;
    expect(winsOfTop > max! / 2, "two wins at +1 each is not over half of the maximum").toBe(false);
    ran++;
  }, 240_000);

  it("X-SW-11 the maximum is in the units of the stage's PINNED rule, not the sport's declared one (chess, win 5 / draw 2)", async () => {
    const PINNED: PointsRule = { win: { regulation: 5 }, loss: { regulation: 0 }, draw: 2, shootoutAs: "result", unit: "whole", bonuses: [] };
    const declared = declaredRule(CHESS);
    expect(declared.win.regulation, "premise: the pin is not the sport's declared win").not.toBe(PINNED.win.regulation);
    const r = await startedSwiss(CHESS, { players: 4, rounds: 3 });
    const moved = await sql`
      update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{points}', ${sql.json(PINNED as never)}), '{sources,points}', '"migrated"')
       where id = ${r.stageId} and table_rules_pinned is not null returning id`;
    expect(moved.length, "premise: the started stage holds a pin to rewrite").toBe(1);
    await pairOk(r);
    await decideRound(r, 1, () => "h");
    await pairOk(r);
    await decideRound(r, 2, () => "h");
    const s = await pairSettled(r);
    expect(s.calls.length).toBe(1);
    // differential: the declared rule would say 2 x 2 = 4
    expect(s.calls[0]!.constraints?.finalRoundMaxScore, "(rounds − 1) x the pinned win").toBe(2 * PINNED.win.regulation);
    // and the rule stageTablePoints hands swissGen is that pin (T5 review m1, the seam this maximum rides on)
    const read = await withTenant(r.auth.orgId, (tx) => stageTablePoints(tx, r.stageId));
    expect(read.rule.win.regulation, "the same pinned rule that paid the scores").toBe(5);
    ran++;
  }, 240_000);

  it("X-SW-11 a rule whose win pays nothing sends no maximum rather than an invalid one (the engine refuses a maximum of 0)", async () => {
    const ZERO: PointsRule = { win: { regulation: 0 }, loss: { regulation: 0 }, draw: 0, shootoutAs: "result", unit: "whole", bonuses: [] };
    const r = await startedSwiss(CHESS, { players: 4, rounds: 2 });
    const moved = await sql`
      update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{points}', ${sql.json(ZERO as never)}), '{sources,points}', '"migrated"')
       where id = ${r.stageId} and table_rules_pinned is not null returning id`;
    expect(moved.length, "premise: the started stage holds a pin to rewrite").toBe(1);
    await pairOk(r);
    await decideRound(r, 1, () => "h");
    const s = await pairSettled(r);
    expect(s.err, `the final round pairs (it answered ${JSON.stringify(s.err ?? null)})`).toBeUndefined();
    expect(s.calls.length).toBe(1);
    expect(s.calls[0]!.constraints?.finalRoundMaxScore, "a maximum of 0 is never sent").toBeUndefined();
    ran++;
  }, 240_000);

  for (const sport of SPORTS) {
    it(`X-SW-11 a one-round Swiss pairs and sends no finalRoundMaxScore (rounds − 1 is 0, which the engine refuses) (${sport.key})`, async () => {
      const r = await startedSwiss(sport, { players: 4, rounds: 1 });
      const s = await pairSettled(r);
      expect(s.err, `a one-round Swiss pairs (it answered ${JSON.stringify(s.err ?? null)})`).toBeUndefined();
      expect(s.calls.length, "anti-vacuity: the engine was called").toBe(1);
      expect(s.calls[0]!.constraints?.finalRoundMaxScore, "round 1 of 1 is the final round, and sends no maximum").toBeUndefined();
      expect(s.out!.created, "two boards seated").toBe(2);
      ran++;
    }, 180_000);
  }

  it("X-SW-11 two topscorers with the same absolute colour preference are paired in the final round instead of refused (TOPSCORERS_WW_N6, chess)", async () => {
    const r = await startedSwiss(CHESS, { players: 6, rounds: 4 });
    await seedHistory(r, TOPSCORERS_WW_N6);
    const lay = layOf(await allSeated(r.stageId));
    // the history, from the oracle: p0 and p1 each took White in rounds 2 and 3 - an absolute preference for Black - and have not met
    expect([lay.colours.get(r.ids[0]!)!.slice(-2), lay.colours.get(r.ids[1]!)!.slice(-2)], "their last two games were both White").toEqual([["W", "W"], ["W", "W"]]);
    expect(lay.met.has(pairKey(r.ids[0]!, r.ids[1]!)), "premise: p0 and p1 have not met").toBe(false);

    const s = await pairSettled(r);
    expect(s.err, `the final round pairs (it answered ${JSON.stringify(s.err ?? null)})`).toBeUndefined();
    const call = s.calls[0]!;
    expect(call.constraints?.finalRoundMaxScore, "the maximum: (4 − 1) x the declared 2").toBe(6);
    const score = (i: number) => call.standings.find((x) => x.entrantId === r.ids[i])!.score;
    expect([score(0), score(1), score(4)], "p0, p1 and p4 are over half of 6").toEqual([6, 4, 4]);
    const round4 = await boardsOf(r.stageId, 4);
    const together = round4.find((f) => pairKey(f.home_entrant_id!, f.away_entrant_id!) === pairKey(r.ids[0]!, r.ids[1]!));
    expect(together, "p0 and p1, two topscorers who both need Black, meet in round 4").toBeDefined();

    // differential: without the flag the same input is refused for its colours - what the app did before this task
    const engine = await import("@seazn/engine/scheduling");
    const plain = engine.pairRound(call.standings, call.history, { chess: true });
    expect(plain.ok, "premise: without finalRoundMaxScore the engine refuses").toBe(false);
    expect(plain.ok ? null : plain.reason, "and the reason is the colour limits").toBe("colour");
    ran++;
  }, 240_000);

  it("X-SW-11 at most once per stage: pair the final round, Add a round, pair it - the maximum is not sent a second time, and Unpair then Pair of the SAME final round still sends it", async () => {
    const r = await startedSwiss(CHESS, { players: 6, rounds: 3 });
    const maxOf = (s: Settled) => s.calls[0]?.constraints?.finalRoundMaxScore;
    await pairOk(r);
    await decideRound(r, 1, () => "h");
    await pairOk(r);
    await decideRound(r, 2, () => "a");

    const finalFirst = await pairSettled(r);
    expect(finalFirst.calls.length, "anti-vacuity: round 3 called the engine").toBe(1);
    expect(maxOf(finalFirst), "round 3 of 3 sends the maximum: 2 x the declared 2").toBe(4);
    expect(finalFirst.err, `round 3 pairs (it answered ${JSON.stringify(finalFirst.err ?? null)})`).toBeUndefined();

    // the same final round re-paired: Unpair then Pair sends it again (it is not an EARLIER round)
    expect((await unpairSwissRound(r.auth, r.stageId)).round, "rig: Unpair cleared round 3").toBe(3);
    const finalAgain = await pairSettled(r);
    expect(maxOf(finalAgain), "the same final round, paired again, sends it again").toBe(4);
    expect(finalAgain.err, "and pairs").toBeUndefined();

    // Add a round after the final round was paired: round 4 is the new final round, and an earlier round already had the maximum
    await decideRound(r, 3, () => "h");
    expect((await addSwissRound(r.auth, r.stageId)).rounds, "rig: a fourth round").toBe(4);
    const fourth = await pairSettled(r);
    expect(fourth.calls.length, "anti-vacuity: round 4 called the engine").toBe(1);
    expect(maxOf(fourth), "round 4 sends NO maximum: the stage already used it on round 3").toBeUndefined();
    // it pairs, or refuses its colours by name - never the engine's CONFIG_INVALID
    expect(fourth.err === undefined || fourth.err.code === "SWISS_NO_LEGAL_PAIRING", `round 4 pairs or refuses by name (it answered ${JSON.stringify(fourth.err ?? null)})`).toBe(true);
    ran++;
  }, 420_000);

  it("X-SW-11 a round added BEFORE the final round was paired still gets the maximum on the new final round (the once-per-stage rule is not 'never after an Add')", async () => {
    const r = await startedSwiss(CHESS, { players: 6, rounds: 3 });
    const sent: (number | undefined)[] = [];
    const round = async () => {
      const s = await pairSettled(r);
      expect(s.calls.length).toBe(1);
      expect(s.err, `pairs (it answered ${JSON.stringify(s.err ?? null)})`).toBeUndefined();
      sent.push(s.calls[0]!.constraints?.finalRoundMaxScore);
    };
    await round(); // round 1 of 3
    await decideRound(r, 1, () => "h");
    expect((await addSwissRound(r.auth, r.stageId)).rounds, "rig: a fourth round, added before round 3 was paired").toBe(4);
    await round(); // round 2 of 4
    await decideRound(r, 2, () => "a");
    await round(); // round 3 of 4
    await decideRound(r, 3, () => "h");
    await round(); // round 4 of 4 - the final round, no earlier round had the maximum
    expect(sent, "only the final round of four sends the maximum: 3 x the declared 2").toEqual([undefined, undefined, undefined, 6]);
    ran++;
  }, 420_000);


  const AGREE: { sport: Sport; rule: PointsRule; want: number; wrong: number; label: string }[] = [
    {
      // a set-score map pays a clean sweep its own points, not win.regulation; a margin bonus is not valid on badminton (the sport
      // emits no score, so the engine refuses it at save) - the football case below carries the bonus
      sport: BADMINTON,
      label: "a set-score map",
      rule: { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 0, shootoutAs: "result", unit: "whole", bonuses: [], bySetScore: { "2-0": [7, 0], "2-1": [5, 1] } },
      want: 14, // two 2-0 sweeps at 7 each, typed from the map above
      wrong: 4, // win.regulation alone: 2 x 2
    },
    {
      sport: FOOTBALL,
      label: "a margin bonus",
      rule: { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "whole", bonuses: [{ when: "win_margin_gte", param: 2, points: 1 }] },
      want: 8, // two 3-0 wins at 3 + the bonus 1 each
      wrong: 6, // a formula that forgot the bonus: 2 x 3
    },
  ];
  for (const c of AGREE) {
    it(`X-SW-11 the score and the maximum agree under ${c.label}: a player who won every round holds (rounds − 1) x maxRoundPoints (${c.sport.key})`, async () => {
      // Pins the shared policy: the table pays the swept / bonus win its full points, and the maximum must count the same
      // points - it fails if either side drops or adds the map or the bonus. The rule is pinned onto the started stage.
      const r = await startedSwiss(c.sport, { players: 4, rounds: 3 });
      const moved = await sql`
        update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{points}', ${sql.json(c.rule as never)}), '{sources,points}', '"migrated"')
         where id = ${r.stageId} and table_rules_pinned is not null returning id`;
      expect(moved.length, "premise: the started stage holds a pin to rewrite").toBe(1);
      const top = r.ids[0]!;
      const topWins = (b: Board): Res => (b.home_entrant_id === top ? "h" : "a");
      await pairOk(r);
      await decideRound(r, 1, topWins);
      await pairOk(r);
      await decideRound(r, 2, topWins);

      const read = await withTenant(r.auth.orgId, (tx) => stageTablePoints(tx, r.stageId));
      expect(read.rule, "premise: the rule the table pays with is the pinned one").toMatchObject(c.rule);
      const m = moduleOf(c.sport.key);
      const cfg = m.configSchema.parse(m.variants[c.sport.variant]);
      expect(read.points.get(top), "the table's own points for two such wins, typed from the rule above").toBe(c.want);
      expect(maxRoundPoints(read.rule, m, cfg) * 2, "the maximum for two rounds is the same number").toBe(c.want);
      expect(c.wrong, "differential: the reading that drops it says another number").not.toBe(c.want);
      ran++;
    }, 240_000);
  }

  it("X-SW-11 a late entrant's re-pair of the final round sends the maximum too and records it, so an Added round does not send it again", async () => {
    const r = await startedSwiss(CHESS, { players: 6, rounds: 3 });
    await pairOk(r);
    await decideRound(r, 1, () => "h");
    await pairOk(r);
    await decideRound(r, 2, () => "a");
    const finalRound = await pairSettled(r);
    expect(finalRound.err, "round 3 pairs").toBeUndefined();
    expect(finalRound.calls[0]!.constraints?.finalRoundMaxScore, "round 3 (the final) sends the maximum: 2 x 2").toBe(4);

    // a latecomer joins while round 3 is paired and nothing is played: case (a) re-pairs round 3 through swissGen
    const engine = await import("@seazn/engine/scheduling");
    const spy = vi.spyOn(engine, "pairRound");
    let late: Awaited<ReturnType<typeof createEntrants>>;
    let calls: Parameters<typeof engine.pairRound>[] = [];
    try {
      late = await createEntrants(r.auth, r.divisionId, [{ kind: "individual", display_name: "Late", members: [] }]);
      calls = spy.mock.calls.map((c) => [...c] as Parameters<typeof engine.pairRound>); // read before mockRestore clears them
    } finally {
      spy.mockRestore();
    }
    expect(late[0]!.late_entry, "premise: case (a), round 3").toMatchObject({ case: "a", round: 3 });
    expect(calls.length, "anti-vacuity: the re-pair called the engine").toBe(1);
    expect(calls[0]![2]?.finalRoundMaxScore, "the re-pair of the final round sends the maximum").toBe(4);
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from division_events where division_id = ${r.divisionId} and type = 'swiss_late_entry' order by seq desc limit 1`;
    expect(row!.payload.final_round_max_score, "and the late-entry row records it").toBe(4);

    // round 3 is played, a fourth round is added: the stage has already spent the maximum on round 3
    await decideRound(r, 3, () => "h");
    expect((await addSwissRound(r.auth, r.stageId)).rounds, "rig: a fourth round").toBe(4);
    const fourth = await pairSettled(r);
    expect(fourth.calls.length, "anti-vacuity: round 4 called the engine").toBe(1);
    expect(fourth.calls[0]!.constraints?.finalRoundMaxScore, "round 4 sends none").toBeUndefined();
    expect(fourth.err === undefined || fourth.err.code === "SWISS_NO_LEGAL_PAIRING", `round 4 pairs or refuses by name (it answered ${JSON.stringify(fourth.err ?? null)})`).toBe(true);
    ran++;
  }, 420_000);

  it("X-SW-11 a final round paired with the maximum, Unpaired, and re-paired once an added round made it a middle one has NOT spent it: the new final round gets it", async () => {
    const r = await startedSwiss(CHESS, { players: 6, rounds: 3 });
    await pairOk(r);
    await decideRound(r, 1, () => "h");
    await pairOk(r);
    await decideRound(r, 2, () => "a");
    const first = await pairSettled(r);
    expect(first.calls[0]!.constraints?.finalRoundMaxScore, "round 3 of 3 sends the maximum").toBe(4);
    expect((await unpairSwissRound(r.auth, r.stageId)).round, "rig: Unpair cleared round 3").toBe(3);
    expect((await addSwissRound(r.auth, r.stageId)).rounds, "rig: round 3 is now a middle round of four").toBe(4);

    const middle = await pairSettled(r);
    expect(middle.err, `round 3 of 4 pairs (it answered ${JSON.stringify(middle.err ?? null)})`).toBeUndefined();
    expect(middle.calls[0]!.constraints?.finalRoundMaxScore, "round 3 of 4 is not the final round: none").toBeUndefined();
    await decideRound(r, 3, () => "h");
    const last = await pairSettled(r);
    expect(last.calls.length, "anti-vacuity: round 4 called the engine").toBe(1);
    expect(last.calls[0]!.constraints?.finalRoundMaxScore, "the new final round gets it: round 3's newest pairing did not use it - 3 x the declared 2").toBe(6);
    ran++;
  }, 420_000);

  it("anti-vacuity: every X-SW-11 case ran", () => {
    expect(ran, "final x2, perfect score, pinned, zero rule, one round x2, topscorers, once per stage, add before final, bonus agree x2, late entry, unpaired middle").toBe(14);
  });
});
