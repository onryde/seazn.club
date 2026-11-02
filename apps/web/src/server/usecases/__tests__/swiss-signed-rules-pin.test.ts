// W3 Task 17 (RB3-12, RB3-18, RB3-19, RB3-21; rules X-SW-20, X-SW-24, X-SW-25, X-SW-27) on Postgres — four §12 close-out
// rows. Three of them hold today and are PINNED here (nothing is changed to make them pass); the fourth (RB3-19, "a
// correction after the bracket started: the bracket stands, the desk warns") gets its desk warning built, and its
// `getSwissCutDrift` reader is proven below.
//
//   X-SW-20  swiss_playoff / swiss_knockout pair round 2 rank-adjacent (the deviation from FIDE's Dutch fold), from the
//            table the division's own cascade produced.
//   X-SW-24  a tied cut line is flagged and picked (SEEDING_TIE_UNRESOLVED) or drawn by visible lots — never a play-off
//            fixture.
//   X-SW-27  a correction after the next round is paired leaves the published pairing and recomputes the table.
//   X-SW-25  a correction after the knockout began leaves every bracket seat; `getSwissCutDrift` names who would now
//            qualify instead of whom.
//
// Sports: the sport-blind pins (X-SW-24/25/27) run badminton (score-keyed) and boardgame (result-keyed, chess), the two
// families T13's own rig sweeps; X-SW-20 is badminton alone, because only a margin-keyed cascade lets a test make the
// table's order DISAGREE with the seed order (a result-keyed sport ties and falls to lots, which cannot tell a fold from
// a rank-adjacent pairing). Each carries its reason inline.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import {
  completeStage,
  confirmSeedProposal,
  createStages,
  generateStageFixtures,
  getStandings,
  listStagesWithTableRules,
} from "../stages";
import { finishSwissNow } from "../swiss-rounds-admin";
import { getSwissCutDrift } from "../swiss-cut-drift";
import { withdrawEntrantCascade } from "../withdrawal";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const SPORTS = [
  { sport: "badminton", variant: "bwf" },
  { sport: "boardgame", variant: "classical" },
] as const;
type Sport = { sport: string; variant: string };
type Kind = "individual" | "pair" | "team";

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  divisionId: string;
  /** The Swiss stage. */
  stageId: string;
  /** The stage the Swiss seeds (swiss_playoff / swiss_knockout), or null for a lone Swiss. */
  koStageId: string | null;
  kind: Kind;
  /** Entrant ids by seed: entrants[0] is P1. */
  entrants: string[];
  nameOf: Map<string, string>;
}

function entrantInput(kind: Kind, name: string, seed: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    seed,
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/**
 * N seeded entrants P1..Pn of the sport's own default kind, Started, and the Swiss of `rounds` whose shells are minted.
 * With a `template`, the stages are the REAL template drafts (`buildTemplateStages`, through `CreateStage` as the API
 * takes them) and the follow-on stage's day-one TBD bracket is drawn; without one, a lone Swiss.
 */
async function pinRig(
  sport: Sport,
  n: number,
  rounds: number,
  opts: { template?: "swiss_knockout" | "swiss_playoff"; q?: number; onCompleteTop?: number } = {},
): Promise<Rig> {
  const owner = (await seedOrg("pro")).auth;
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "T17 " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(owner, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sport.sport,
    variant_key: sport.variant,
    config: {},
  });
  const sportModule = builtinModules.find((m) => m.key === sport.sport)!;
  const kind = (sportModule.entrantModel?.defaultKind ?? "individual") as Kind;
  const made = await createEntrants(owner, division.id, Array.from({ length: n }, (_, i) => entrantInput(kind, `P${i + 1}`, i + 1)));
  let stageId: string;
  let koStageId: string | null = null;
  if (opts.template !== undefined) {
    const drafts = buildTemplateStages(opts.template, { swissRounds: rounds, poolCount: 2, legs: 1, qualified: opts.q ?? 2 });
    expect(drafts[0]!.kind, "premise: the template opens with a Swiss").toBe("swiss");
    const ids: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const input = CreateStage.parse({
        seq: i + 1,
        kind: d.kind,
        name: d.name,
        config: d.kind === "swiss" ? { ...d.config, rounds } : d.config,
        progression: d.progression,
      });
      const [stage] = await createStages(owner, division.id, input);
      ids.push(stage!.id);
    }
    [stageId, koStageId] = [ids[0]!, ids[1]!];
  } else {
    const [stage] = await createStages(owner, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds }, progression: null });
    stageId = stage!.id;
    if (opts.onCompleteTop !== undefined) {
      // The OLDER progression: completion seeds AND draws the knockout (`timing: "on_complete"`), and stores the cut as
      // `config.qualified`.
      const [ko] = await createStages(owner, division.id, {
        seq: 2,
        kind: "knockout",
        name: "KO",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: opts.onCompleteTop }] }],
          placement: "rank_order",
          timing: "on_complete",
        },
      });
      koStageId = ko!.id;
    }
  }
  await startDivision(owner, division.id);
  if (opts.template !== undefined) await generateStageFixtures(owner, koStageId!); // the follow-on stage's day-one TBD bracket
  const rig: Rig = {
    sport,
    auth: owner,
    divisionId: division.id,
    stageId,
    koStageId,
    kind,
    entrants: made.map((e) => e.id),
    nameOf: new Map(made.map((e) => [e.id, e.display_name])),
  };
  if ((await rowsOf(stageId)).length === 0) await pair(rig); // Start mints the first stage; a lone Swiss is that stage
  return rig;
}

interface Row {
  id: string;
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const boardsOf = (rows: readonly Row[], r: number) =>
  rows.filter((f) => f.round_no === r && !isBye(f) && f.home_entrant_id !== null && f.away_entrant_id !== null);

const pair = (rig: Pick<Rig, "auth" | "stageId">) => generateStageFixtures(rig.auth, rig.stageId);

async function tip(fixtureId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  return n;
}

/** Record `winner` as the board's winner through real scoring events. `margin` shapes a score-keyed sport's games so a
 *  test can give every board its own point ratio (a result-keyed sport has no margin and ignores it). */
async function decide(rig: Rig, f: Pick<Row, "id" | "home_entrant_id" | "away_entrant_id">, winner: string, margin = 0): Promise<void> {
  let seq = await tip(f.id);
  if (seq === 0) await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner, method: "resign" } });
    return;
  }
  const homeWon = winner === f.home_entrant_id;
  const loserPoints = Math.min(19, 10 + margin);
  const game = homeWon ? { home: 21, away: loserPoints } : { home: loserPoints, away: 21 };
  await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: game });
  await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: game });
}

/** The lower-numbered entrant (P1 < P2 < …) of a board. */
function lowerOf(rig: Rig, f: Pick<Row, "home_entrant_id" | "away_entrant_id">): string {
  const a = rig.entrants.indexOf(f.home_entrant_id!);
  const b = rig.entrants.indexOf(f.away_entrant_id!);
  return a < b ? f.home_entrant_id! : f.away_entrant_id!;
}

/** Pair round `r` and decide every board for the lower-numbered side. Every board is won by the same scoreline unless
 *  `margins` gives each its own (so a score-keyed cascade can order boards that would otherwise tie). */
async function playRound(rig: Rig, r: number, opts: { margins?: boolean } = {}): Promise<Row[]> {
  await pair(rig);
  const boards = boardsOf(await rowsOf(rig.stageId), r);
  expect(boards.length, `rig: round ${r} has boards`).toBeGreaterThan(0);
  for (const f of boards) await decide(rig, f, lowerOf(rig, f), opts.margins === true ? f.seq_in_round : 0);
  const after = boardsOf(await rowsOf(rig.stageId), r);
  expect(after.map((f) => f.status), `rig: round ${r} is decided`).toEqual(after.map(() => "decided"));
  return after;
}

/** Take back a board's result (a `core.void` of each active result event, newest first) and record `winner` instead —
 *  the organiser's correction, through the real scoring path (`scoreEvent` → `onDecided` → recompute + proposal stale). */
async function correct(rig: Rig, f: Pick<Row, "id" | "home_entrant_id" | "away_entrant_id">, winner: string): Promise<void> {
  const resultTypes = rig.sport.sport === "boardgame" ? ["boardgame.result"] : ["badminton.game.summary"];
  const results = await sql<{ id: string; seq: number }[]>`
    select id, seq from score_events
    where fixture_id = ${f.id} and type in ${sql(resultTypes)}
      and id not in (select (payload ->> 'event_id')::uuid from score_events where fixture_id = ${f.id} and type = 'core.void')
    order by seq desc`;
  expect(results.length, "rig: the board holds a result to take back").toBeGreaterThan(0);
  for (const r of results) {
    await scoreEvent(rig.auth, f.id, { expected_seq: await tip(f.id), type: "core.void", payload: { event_id: r.id } });
  }
  await decide(rig, f, winner);
}

/** The board of the stage between two entrants (either side). */
async function boardBetween(stageId: string, a: string, b: string): Promise<Row> {
  const board = (await rowsOf(stageId)).find(
    (f) => !isBye(f) && [f.home_entrant_id, f.away_entrant_id].sort().join() === [a, b].sort().join(),
  );
  expect(board, "rig: the two meet once").toBeTruthy();
  return board!;
}

/** The ids of the stage's table, in the order the public standings snapshot serves them. */
async function tableOf(rig: Rig): Promise<{ entrantId: string; rank: number | null; points?: number }[]> {
  const snap = await getStandings(rig.auth, rig.stageId);
  return [...(snap.rows as { entrantId: string; rank: number | null; points?: number }[])].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Complete the Swiss and confirm its draft proposal into the follow-on stage, keeping the table's own order at any
 *  flagged tie. */
async function completeAndConfirm(rig: Rig): Promise<void> {
  const done = await completeStage(rig.auth, rig.stageId);
  expect(done.completed, "rig: the Swiss completes").toBe(true);
  expect(done.seed_proposal, "rig: a draft proposal for the follow-on stage").toBeTruthy();
  await confirmDraft(rig);
}

/** Confirm the follow-on stage's draft proposal as ranked (a pick per flagged tie, in the table's own order). */
async function confirmDraft(rig: Rig): Promise<void> {
  const [p] = await sql<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: { slots: string[] }[] } }[]>`
    select id, computed from stage_seed_proposals where stage_id = ${rig.koStageId!} and status = 'draft'`;
  const bySlot = new Map(p!.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
  const tiePicks = p!.computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((s) => bySlot.get(s)!) }));
  await confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: p!.id, tiePicks });
}

/** Every seat of the follow-on stage, by fixture, in a stable order. */
async function seatsOf(stageId: string): Promise<{ id: string; home: string | null; away: string | null }[]> {
  return sql<{ id: string; home: string | null; away: string | null }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId} order by round_no, seq_in_round, id`;
}

describe.runIf(HAS_DB)("X-SW-20 rank-adjacent from round 2 (RB3-12)", () => {
  // 8 entrants, round 1 won by the lower number on every board, each board by its own margin: the four winners are level
  // on points and wins, and the cascade (set ratio, then point ratio) orders them by margin — which the rig makes DISAGREE
  // with the seed order. Badminton alone, for the reason in the file header.
  for (const template of ["swiss_playoff", "swiss_knockout"] as const) {
    it(`X-SW-20 ${template} pairs round 2 rank-adjacent`, async () => {
      const rig = await pinRig(SPORTS[0], 8, 3, { template, q: 4 });
      await playRound(rig, 1, { margins: true });
      const table = await tableOf(rig);
      expect(new Set(table.map((r) => r.rank)).size, "premise: the cascade orders all eight strictly").toBe(8);
      // The expected pairs, from the TABLE and the rulebook alone: within each score group, neighbours meet (1st-2nd,
      // 3rd-4th). Score groups are read off the table's points, not off the pairing under test.
      const byPoints = new Map<number, string[]>();
      for (const row of table) byPoints.set(row.points ?? -1, [...(byPoints.get(row.points ?? -1) ?? []), row.entrantId]);
      const groups = [...byPoints.values()];
      expect(groups.map((g) => g.length), "premise: two score groups of four after round 1").toEqual([4, 4]);
      const expected = groups
        .flatMap((g) => [[g[0]!, g[1]!], [g[2]!, g[3]!]])
        .map((p) => [...p].sort().join(","))
        .sort();
      expect(expected.length, "pairs expected").toBe(4);

      await pair(rig);
      const round2 = boardsOf(await rowsOf(rig.stageId), 2);
      const actual = round2.map((f) => [f.home_entrant_id!, f.away_entrant_id!].sort().join(",")).sort();
      expect(actual).toEqual(expected);
    }, 300_000);
  }

  it("X-SW-20 control: a plain Swiss (no rank-adjacent config) pairs round 2 differently from the same table, so the pin can tell", async () => {
    const rig = await pinRig(SPORTS[0], 8, 3);
    await playRound(rig, 1, { margins: true });
    const table = await tableOf(rig);
    const byPoints = new Map<number, string[]>();
    for (const row of table) byPoints.set(row.points ?? -1, [...(byPoints.get(row.points ?? -1) ?? []), row.entrantId]);
    const adjacent = [...byPoints.values()]
      .flatMap((g) => [[g[0]!, g[1]!], [g[2]!, g[3]!]])
      .map((p) => [...p].sort().join(","))
      .sort();
    await pair(rig);
    const actual = boardsOf(await rowsOf(rig.stageId), 2)
      .map((f) => [f.home_entrant_id!, f.away_entrant_id!].sort().join(","))
      .sort();
    expect(actual.length).toBe(4);
    expect(actual, "a fold on the same table is not the rank-adjacent pairing").not.toEqual(adjacent);
  }, 300_000);
});

describe.runIf(HAS_DB)("X-SW-24 a tied cut line (RB3-18)", () => {
  /** The last key of the stage's declared tie-break chain, as the API serves it (`GET /divisions/{id}/stages`) — the
   *  sport's own declaration, never typed here. A chain ending in `lots` breaks a level class by a stored drawing; one
   *  ending anywhere else leaves it to the seed. */
  async function chainEnd(rig: Rig): Promise<string | undefined> {
    const stage = (await listStagesWithTableRules(rig.auth, rig.divisionId)).find((st) => st.id === rig.stageId)!;
    return stage.tableRules!.tiebreakers.keys.at(-1);
  }

  for (const s of SPORTS) {
    it(`X-SW-24 a tied cut line refuses SEEDING_TIE_UNRESOLVED and flags the tie (lots draw or seed pick), never a play-off fixture (${s.sport})`, async () => {
      // 4 entrants, one round played, every board won 21-10 21-10 (or by the same result): the two winners and the two
      // losers are level on every score criterion. A knockout of the top 3 cuts between the two losers.
      const rig = await pinRig(s, 4, 3, { template: "swiss_knockout", q: 3 });
      await playRound(rig, 1);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 1, completed: true });
      const fixturesBefore = (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where division_id = ${rig.divisionId}`)[0]!.n;
      const [draft] = await sql<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: { slots: string[]; entrantIds: string[]; reason: string }[] } }[]>`
        select id, computed from stage_seed_proposals where stage_id = ${rig.koStageId!} and status = 'draft'`;
      const end = await chainEnd(rig);
      const ties = draft!.computed.ties;

      // The cut's tie is FLAGGED with the criterion that left it level: the seed for a chain ending there, the visible
      // drawing for a chain ending in lots (and a drawing is STORED, where the table shows who drew what).
      expect(ties.length, "the level classes are flagged").toBeGreaterThan(0);
      expect(ties.map((t) => t.reason), "each tie names the end of the sport's declared chain").toEqual(ties.map(() => (end === "lots" ? "lots" : "seed")));
      const draws = (await sql<{ n: number }[]>`select count(*)::int as n from stage_lots_draws where stage_id = ${rig.stageId}`)[0]!.n;
      if (end === "lots") expect(draws, "the drawing is stored").toBeGreaterThan(0);
      else expect(draws, "a seed-ending chain draws nothing").toBe(0);

      // Never silently confirmed: the refusal names the tied entrants; the organiser's pick (the offered order) seats them.
      await expect(confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: draft!.id })).rejects.toMatchObject({
        status: 422,
        code: "SEEDING_TIE_UNRESOLVED",
        extra: { entrantIds: ties[0]!.entrantIds },
      });
      expect((await seatsOf(rig.koStageId!)).flatMap((x) => [x.home, x.away]).filter((x) => x !== null), "the refusal seated nobody").toEqual([]);
      const bySlot = new Map(draft!.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
      const tiePicks = ties.map((t) => ({ slots: t.slots, order: t.slots.map((x) => bySlot.get(x)!) }));
      await confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: draft!.id, tiePicks });

      const seated = (await seatsOf(rig.koStageId!)).flatMap((x) => [x.home, x.away]).filter((x): x is string => x !== null);
      expect(new Set(seated).size, "the pick seats the top 3").toBe(3);
      // RB3-18: a play-off game is never made. No fixture was added by the refusal, the pick or the draw.
      const fixturesAfter = (await sql<{ n: number }[]>`select count(*)::int as n from fixtures where division_id = ${rig.divisionId}`)[0]!.n;
      expect(fixturesAfter, "no play-off fixture").toBe(fixturesBefore);
    }, 300_000);
  }

  it("X-SW-24 the sweep reaches both ends of the declared chains: one sport ends in the seed, one in lots (anti-vacuity)", async () => {
    const ends: (string | undefined)[] = [];
    for (const s of SPORTS) ends.push(await chainEnd(await pinRig(s, 4, 3, { template: "swiss_knockout", q: 3 })));
    expect(ends.length, "sports checked").toBe(SPORTS.length);
    expect(ends.includes("lots"), "a lots-ending chain is in the sweep").toBe(true);
    expect(ends.some((e) => e !== "lots"), "a non-lots chain is in the sweep").toBe(true);
  }, 300_000);
});

describe.runIf(HAS_DB)("X-SW-27 a correction after the next round is paired (RB3-21)", () => {
  for (const s of SPORTS) {
    it(`X-SW-27 correcting a round-1 result after round 2 is paired leaves round 2's seats and recomputes standings (${s.sport})`, async () => {
      const rig = await pinRig(s, 4, 3);
      const round1 = await playRound(rig, 1);
      await pair(rig); // round 2 is paired: published
      const round2 = boardsOf(await rowsOf(rig.stageId), 2);
      expect(round2.length, "premise: round 2 is seated").toBeGreaterThan(0);
      const seatsBefore = round2.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]);
      const before = await tableOf(rig);

      // Flip a round-1 board: the loser (the higher number) wins instead.
      const board = round1[0]!;
      const loser = board.home_entrant_id === lowerOf(rig, board) ? board.away_entrant_id! : board.home_entrant_id!;
      const winnerBefore = lowerOf(rig, board);
      await correct(rig, board, loser);

      const round2After = boardsOf(await rowsOf(rig.stageId), 2);
      expect(round2After.map((f) => [f.id, f.home_entrant_id, f.away_entrant_id]), "the published pairing stands").toEqual(seatsBefore);
      const after = await tableOf(rig);
      const rankOf = (t: typeof before, id: string) => t.find((r) => r.entrantId === id)!.rank!;
      // The rulebook: one win beats none, so the corrected winner now ranks above the corrected loser — and before the
      // correction the order was the other way round.
      expect(rankOf(before, winnerBefore), "premise: before, the first winner led the first loser").toBeLessThan(rankOf(before, loser));
      expect(rankOf(after, loser), "after: the corrected winner leads").toBeLessThan(rankOf(after, winnerBefore));
    }, 300_000);
  }
});

/** 4 entrants, a full round robin won by the lower number, a knockout of the top 3 (a bye for P1, then P2 v P3), the
 *  Swiss completed, the bracket confirmed and its first real line DECIDED: the knockout has begun. The cut is
 *  P1, P2, P3; P4 is out. */
async function startedBracket(s: Sport, opts: { begun?: boolean } = {}): Promise<Rig> {
  const rig = await pinRig(s, 4, 3, { template: "swiss_knockout", q: 3 });
  for (let r = 1; r <= 3; r++) await playRound(rig, r);
  await completeAndConfirm(rig);
  const bracket = (await rowsOf(rig.koStageId!)).filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
  expect(bracket.length, "premise: the bracket holds one real line (the semi-final)").toBe(1);
  if (opts.begun !== false) await decide(rig, bracket[0]!, lowerOf(rig, bracket[0]!));
  return rig;
}


describe.runIf(HAS_DB)("X-SW-25 a correction after the knockout began (RB3-19)", () => {
  for (const s of SPORTS) {
    it(`X-SW-25 a correction that flips the cut after the knockout started leaves every bracket seat unchanged (${s.sport})`, async () => {
      const rig = await startedBracket(s);
      const [p1, p2, p3, p4] = rig.entrants as [string, string, string, string];
      const seatsBefore = await seatsOf(rig.koStageId!);
      expect(seatsBefore.flatMap((x) => [x.home, x.away]).filter((x) => x !== null).length, "premise: seats are filled").toBeGreaterThan(2);

      // P4 beats P3: P3 drops out of the top 3 (P1 3 wins, P2 2, P4 1 — P3 none).
      await correct(rig, await boardBetween(rig.stageId, p3, p4), p4);
      const top3 = (await tableOf(rig)).slice(0, 3).map((r) => r.entrantId);
      expect(top3.sort(), "premise: the correction moved the cut").toEqual([p1, p2, p4].sort());
      expect(await seatsOf(rig.koStageId!), "the bracket stands: no seat moved").toEqual(seatsBefore);
    }, 300_000);
  }
});

describe.runIf(HAS_DB)("X-SW-25 getSwissCutDrift (RB3-19)", () => {
  /** P4 beats P3: P3 drops out of the top 3 (P1 3 wins, P2 2, P4 1, P3 none). */
  const flipCut = async (rig: Rig) => {
    const [, , p3, p4] = rig.entrants as [string, string, string, string];
    await correct(rig, await boardBetween(rig.stageId, p3, p4), p4);
  };

  for (const s of SPORTS) {
    it(`X-SW-25 getSwissCutDrift names who is in and out after a cut-flipping correction (${s.sport})`, async () => {
      const rig = await startedBracket(s);
      const [, , p3, p4] = rig.entrants as [string, string, string, string];
      expect(await getSwissCutDrift(rig.auth, rig.stageId), "no drift before any correction: the bracket was seeded from this table").toBeNull();
      await flipCut(rig);
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: [p3], in: [p4] });
    }, 300_000);

    it(`X-SW-25 getSwissCutDrift returns null when the correction does not change the top q (${s.sport})`, async () => {
      const rig = await startedBracket(s);
      const [, p2, p3] = rig.entrants as [string, string, string, string];
      // P3 beats P2: P2 and P3 swap places INSIDE the top 3 (P1 3 wins, P3 2, P2 1) — the cut is the same three.
      await correct(rig, await boardBetween(rig.stageId, p2, p3), p3);
      const top3 = (await tableOf(rig)).slice(0, 3).map((r) => r.entrantId);
      expect(top3[1], "premise: the correction reordered the table").toBe(p3);
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
    }, 300_000);
  }

  it("X-SW-25 getSwissCutDrift is null until the knockout has begun: a seated bracket whose only result is its generated bye (badminton)", async () => {
    // Badminton only: the "begun" predicate (`fixtureHasResultSql`) and the bye shell read the same columns for every sport; the per-sport flip is the pair above.
    const rig = await startedBracket(SPORTS[0], { begun: false });
    await flipCut(rig);
    const [, , p3, p4] = rig.entrants as [string, string, string, string];
    expect((await tableOf(rig)).slice(0, 3).map((r) => r.entrantId), "premise: the cut moved").toContain(p4);
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "the bye is no start").toBeNull();
    // ...and the moment a real line is played, the same standings warn (the sequence, not just the state).
    const semi = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await decide(rig, semi, lowerOf(rig, semi));
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: [p3], in: [p4] });
  }, 300_000);

  it("X-SW-25 getSwissCutDrift: a Swiss that has not completed, and a stage that is not a Swiss, have no cut to drift from (badminton)", async () => {
    // Badminton only: the status and kind guards read stage columns, with no sport input.
    const rig = await pinRig(SPORTS[0], 4, 3, { template: "swiss_knockout", q: 3 });
    await playRound(rig, 1);
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "a running Swiss").toBeNull();
    expect(await getSwissCutDrift(rig.auth, rig.koStageId!), "the knockout is not a Swiss").toBeNull();
    await expect(getSwissCutDrift(rig.auth, randomUUID())).rejects.toMatchObject({ status: 404 });
    const { auth: stranger } = await seedOrg("pro");
    await expect(getSwissCutDrift(stranger, rig.stageId), "another organisation's stage").rejects.toMatchObject({ status: 404 });
  }, 300_000);

  it("X-SW-25 getSwissCutDrift: only a COMPLETE Swiss, with a stage that draws from it, has a cut to drift from — each guard alone (badminton)", async () => {
    // Badminton only: each guard reads a stage column, with no sport input; the per-sport flip is the pair above.
    // A flipped cut under a begun knockout (so the only thing standing between the table and a warning is the guard
    // under test). Each guard is flipped on its own and restored before the next, so neither covers for the other.
    const rig = await startedBracket(SPORTS[0]);
    await flipCut(rig);
    const [, , p3, p4] = rig.entrants as [string, string, string, string];
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "premise: the flipped cut warns").toEqual({ out: [p3], in: [p4] });

    await sql`update stages set status = 'active' where id = ${rig.stageId}`;
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "a Swiss still running").toBeNull();
    await sql`update stages set status = 'complete' where id = ${rig.stageId}`;

    await sql`update stages set kind = 'league' where id = ${rig.stageId}`;
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "a stage that is not a Swiss").toBeNull();
    await sql`update stages set kind = 'swiss' where id = ${rig.stageId}`;

    const [ko] = await sql<{ progression: unknown }[]>`select progression from stages where id = ${rig.koStageId!}`;
    await sql`update stages set progression = null where id = ${rig.koStageId!}`;
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "a next stage that draws from nothing").toBeNull();
    await sql`update stages set progression = ${sql.json(ko!.progression as never)} where id = ${rig.koStageId!}`;

    expect(await getSwissCutDrift(rig.auth, rig.stageId), "all three restored: the warning is back").toEqual({ out: [p3], in: [p4] });
  }, 300_000);

  it("X-SW-25 getSwissCutDrift: two entrants moving at once are both named, each list in table order (badminton)", async () => {
    // Badminton only: the set arithmetic and the table order are sport-blind; the per-sport flip is the pair above.
    // A knockout of the top 2 (a lone Final, begun by deciding it). P3 and P4 each beat P1 and P2, and P3 beats P4: the
    // table is P3, P4, P1, P2 — the cut was P1, P2.
    const rig = await pinRig(SPORTS[0], 4, 3, { template: "swiss_knockout", q: 2 });
    for (let r = 1; r <= 3; r++) await playRound(rig, r);
    await completeAndConfirm(rig);
    const [p1, p2, p3, p4] = rig.entrants as [string, string, string, string];
    const final = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await decide(rig, final, lowerOf(rig, final));
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "no drift yet").toBeNull();
    for (const [loser, winner] of [[p1, p3], [p2, p3], [p1, p4], [p2, p4]] as const) {
      await correct(rig, await boardBetween(rig.stageId, loser, winner), winner);
    }
    expect((await tableOf(rig)).slice(0, 2).map((r) => r.entrantId), "premise: P3 and P4 now hold the cut").toEqual([p3, p4]);
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: [p1, p2], in: [p3, p4] });
  }, 300_000);

  it("X-SW-25 getSwissCutDrift reads an on_complete knockout's frozen config.qualified, and a setup bracket's confirmed proposal (no config.qualified at all) (badminton)", async () => {
    // Badminton only: which column holds the frozen cut depends on the next stage's timing, never on the sport.
    // The brief names `config.qualified` as the frozen cut. It is, for `timing: "on_complete"` only (it holds the TABLE's
    // cut: `resolveProgression` over the completed tables, no organiser step in between). A `timing: "setup"` bracket
    // (swiss_knockout, swiss_playoff — the shapes RB3-19 is about) is filled by the confirmed proposal and never writes
    // it: its frozen cut is that proposal's `computed.qualifiers` (the table's cut when it was seeded, which a confirm
    // leaves untouched — an organiser's pick or edit changes the SEATS, never `computed`). Both are pinned, so neither
    // reader can be deleted without a red.
    const setup = await startedBracket(SPORTS[0]);
    const [, setupKo] = await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${setup.koStageId!}`.then((r) => [null, r[0]!] as const);
    expect(setupKo.config.qualified, "premise: a setup bracket stores no config.qualified").toBeUndefined();

    const rig = await pinRig(SPORTS[0], 4, 3, { onCompleteTop: 3 });
    for (let r = 1; r <= 3; r++) await playRound(rig, r);
    await completeStage(rig.auth, rig.stageId);
    const [p1, p2, p3, p4] = rig.entrants as [string, string, string, string];
    const [ko] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${rig.koStageId!}`;
    expect(ko!.config.qualified, "premise: on_complete froze the cut").toEqual([p1, p2, p3]);
    const semi = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await decide(rig, semi, lowerOf(rig, semi));
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "no drift yet").toBeNull();
    await correct(rig, await boardBetween(rig.stageId, p3, p4), p4);
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: [p3], in: [p4] });
    // The stored list is the frozen cut when there is one, not the seats or the proposal: a stored cut of P1, P2, P4
    // against today's top 3 (P1, P2, P4 after the flip) is no drift, though the seats and the proposal still name P3.
    await sql`update stages set config = jsonb_set(config, '{qualified}', ${sql.json([p1, p2, p4])}) where id = ${rig.koStageId!}`;
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "config.qualified wins over the seats and the proposal").toBeNull();
  }, 300_000);

  it("X-SW-25 getSwissCutDrift: a frozen cut naming someone the Swiss table does not rank ignores them (badminton)", async () => {
    // Badminton only: the intersection with the ranked entrants is sport-blind.
    // A stage fed by several sources can seat entrants the Swiss never ranked; they are not the Swiss cut's to drift.
    const rig = await pinRig(SPORTS[0], 4, 3, { onCompleteTop: 3 });
    for (let r = 1; r <= 3; r++) await playRound(rig, r);
    await completeStage(rig.auth, rig.stageId);
    const stranger = randomUUID();
    await sql`update stages set config = jsonb_set(config, '{qualified}', config -> 'qualified' || ${sql.json([stranger])}) where id = ${rig.koStageId!}`;
    const semi = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    await decide(rig, semi, lowerOf(rig, semi));
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
  }, 300_000);

  for (const s of SPORTS) {
    it(`X-SW-25 getSwissCutDrift: a departed entrant ranked inside the top q is no drift — the cut backfilled her place, and so does the reader (${s.sport})`, async () => {
      // T15 Carry A: a withdrawn or disqualified entrant LEAVES a Swiss cut and the next eligible entrant backfills. 6
      // entrants, the leader withdraws between rounds 2 and 3, Finish ends the Swiss after round 2: the cut is the table
      // less the departed, top 4 — rank 5 takes her place. The drift's "today's top q" must be read the same way.
      const rig = await pinRig(s, 6, 5, { template: "swiss_knockout", q: 4 });
      await playRound(rig, 1);
      await playRound(rig, 2);
      const leader = (await tableOf(rig))[0]!.entrantId;
      await withdrawEntrantCascade(rig.auth, leader);
      const raw = (await withTenant(rig.auth.orgId, (tx) => rankedStageStandings(tx, rig.stageId))).map((r) => r);
      const rawTop4 = [...raw].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 4).map((r) => r.entrantId);
      expect(rawTop4, "premise: the departed leader still ranks inside the raw top 4").toContain(leader);
      await finishSwissNow(rig.auth, rig.stageId);
      await confirmDraft(rig);
      const seated = new Set((await seatsOf(rig.koStageId!)).flatMap((x) => [x.home, x.away]).filter((x): x is string => x !== null));
      expect(seated.size, "premise: a knockout of 4").toBe(4);
      expect(seated.has(leader), "premise: the cut skipped the departed leader").toBe(false);
      const semi = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
      await decide(rig, semi, lowerOf(rig, semi));
      // A reader that took the raw top 4 would call the departed leader "in" and her backfill "out".
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
    }, 300_000);
  }

  it("X-SW-25 getSwissCutDrift: an entrant who withdraws AFTER the bracket was seeded is no drift on her own (badminton)", async () => {
    // Badminton only: the departed filter is a status read; the per-sport departed-in-top-q case is the test above.
    const rig = await startedBracket(SPORTS[0]);
    const [, , p3] = rig.entrants as [string, string, string, string];
    await withdrawEntrantCascade(rig.auth, p3); // seated P3 leaves; her semi is already decided
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
  }, 300_000);

  /** 4 entrants, a Top 3 knockout, ONE round played (the lower number wins each board) and the Swiss finished: the two
   *  winners are level, the two losers are level, and the cut falls between the losers. Answers the draft proposal split
   *  into who the TABLE puts in the cut and the tied entrant it leaves out. Every value comes off the proposal's own flags,
   *  never typed. */
  async function tiedCutRig(s: Sport) {
    const rig = await pinRig(s, 4, 3, { template: "swiss_knockout", q: 3 });
    await playRound(rig, 1);
    await finishSwissNow(rig.auth, rig.stageId);
    const [draft] = await sql<{ id: string; computed: { qualifiers: { entrantId: string; destinationSlot: string }[]; ties: { slots: string[]; entrantIds: string[] }[] } }[]>`
      select id, computed from stage_seed_proposals where stage_id = ${rig.koStageId!} and status = 'draft'`;
    const tableCut = draft!.computed.qualifiers.map((q) => q.entrantId);
    const bySlot = new Map(draft!.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
    const cutTie = draft!.computed.ties.find((t) => t.entrantIds.some((id) => !tableCut.includes(id)));
    expect(cutTie, "premise: a flagged tie straddles the cut").toBeTruthy();
    const inId = cutTie!.entrantIds.find((id) => tableCut.includes(id));
    const outId = cutTie!.entrantIds.find((id) => !tableCut.includes(id));
    expect(inId, "premise: the tie holds one the table puts in").toBeTruthy();
    expect(outId, "premise: ...and one it leaves out").toBeTruthy();
    const offered = (t: { slots: string[] }) => ({ slots: t.slots, order: t.slots.map((x) => bySlot.get(x)!) });
    /** The organiser seats the tied entrant the table left out, in the other's place. */
    const swapped = (slots: string[]) => slots.map((x) => (bySlot.get(x) === inId ? outId! : bySlot.get(x)!));
    return { rig, draft: draft!, tableCut, cutTie: cutTie!, ties: draft!.computed.ties, inId: inId!, outId: outId!, offered, swapped };
  }
  const seatedIds = async (stageId: string) =>
    new Set((await seatsOf(stageId)).flatMap((x) => [x.home, x.away]).filter((x): x is string => x !== null));
  const beginKnockout = async (rig: Rig) => {
    const line = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    expect(line, "premise: the bracket holds a real line").toBeTruthy();
    await decide(rig, line, lowerOf(rig, line));
  };

  for (const s of SPORTS) {
    it(`X-SW-25 getSwissCutDrift: an organiser's tie pick is not a correction — null once the knockout has begun; a correction that then flips the cut names who is in and out, and correcting back clears it (${s.sport})`, async () => {
      const { rig, draft, tableCut, cutTie, ties, inId, outId, offered, swapped } = await tiedCutRig(s);
      // The pick: the entrant the table left out takes the tied seat. Every other flagged tie takes the offered order.
      const tiePicks = ties.map((t) => (t === cutTie ? { slots: t.slots, order: swapped(t.slots) } : offered(t)));
      await confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: draft.id, tiePicks });
      const seated = await seatedIds(rig.koStageId!);
      expect(seated.has(outId), "premise: the pick seated the entrant the table left out").toBe(true);
      expect(seated.has(inId), "premise: ...and unseated the one it put in").toBe(false);
      await beginKnockout(rig);
      // A pick is not a correction: the seats differ from the table's cut and no result was touched.
      expect(await getSwissCutDrift(rig.auth, rig.stageId), "the seats differ from the table by the organiser's own choice").toBeNull();

      // Now a real correction: the left-out entrant (seated by the pick) beats the one who beat her. She holds three points,
      // so she is in today's top 3 whichever way the new level pair at the cut falls, and she was not in the frozen cut.
      const board = (await rowsOf(rig.stageId)).find((f) => !isBye(f) && (f.home_entrant_id === outId || f.away_entrant_id === outId))!;
      const original = lowerOf(rig, board);
      expect(original, "premise: she lost this board").not.toBe(outId);
      await correct(rig, board, outId);
      const top3 = (await tableOf(rig)).slice(0, 3).map((r) => r.entrantId);
      expect(top3, "premise: the correction put her in the table's top 3").toContain(outId);
      const gone = tableCut.filter((id) => !top3.includes(id));
      expect(gone, "premise: exactly one of the frozen cut is displaced").toHaveLength(1);
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: gone, in: [outId] });

      // Corrected back: the table is the cut it was seeded from, and the warning clears (the sequence, not just the state).
      await correct(rig, board, original);
      expect(await getSwissCutDrift(rig.auth, rig.stageId), "corrected back").toBeNull();
    }, 300_000);

    it(`X-SW-25 getSwissCutDrift: an edits[] override that seats a non-qualifier is no drift without a correction (${s.sport})`, async () => {
      const { rig, draft, cutTie, ties, offered, swapped } = await tiedCutRig(s);
      const edits = cutTie.slots.map((slot, i) => ({ destinationSlot: slot, entrantId: swapped(cutTie.slots)[i]! }));
      const tiePicks = ties.filter((t) => t !== cutTie).map(offered);
      await confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: draft.id, edits, tiePicks });
      expect((await seatedIds(rig.koStageId!)).has(edits.find((e) => !draft.computed.qualifiers.some((q) => q.entrantId === e.entrantId))!.entrantId), "premise: the override seated a non-qualifier").toBe(true);
      await beginKnockout(rig);
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
    }, 300_000);

    it(`X-SW-25 getSwissCutDrift: a lone completed Swiss with no stage after it has no cut to drift from — null, not a crash (${s.sport})`, async () => {
      // The most common shape: a Swiss on its own. The division page asks this for EVERY complete Swiss on the Fixtures tab,
      // so a throw here would take the whole tab down.
      const rig = await pinRig(s, 4, 3);
      await playRound(rig, 1);
      expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ completed: true });
      expect(rig.koStageId, "premise: no stage follows").toBeNull();
      expect(await getSwissCutDrift(rig.auth, rig.stageId)).toBeNull();
    }, 300_000);
  }

  it("X-SW-25 getSwissCutDrift: a BEGUN bracket with no recorded cut is an invariant breach, thrown by name — an unbegun one is still null (badminton)", async () => {
    // Badminton only: the recorded cut is a stage/proposal row, with no sport input.
    // Unbegun first (the path order): a seated, unplayed bracket whose proposal is gone reaches no throw — it answers null
    // through the knockout-started check, before any cut is read.
    const unbegun = await startedBracket(SPORTS[0], { begun: false });
    await sql`delete from stage_seed_proposals where stage_id = ${unbegun.koStageId!}`;
    expect(await getSwissCutDrift(unbegun.auth, unbegun.stageId), "unbegun, no proposal: null, not a throw").toBeNull();

    // Begun, with the cut flipped so the warning is the answer when a cut IS recorded (the positive pair).
    const rig = await startedBracket(SPORTS[0]);
    await flipCut(rig);
    const [, , p3, p4] = rig.entrants as [string, string, string, string];
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "premise: with the proposal, the flip warns").toEqual({ out: [p3], in: [p4] });
    const [saved] = await sql<{ id: string; status: string; computed: unknown }[]>`
      select id, status, computed from stage_seed_proposals where stage_id = ${rig.koStageId!} and status = 'confirmed'`;
    expect(saved, "premise: one confirmed proposal").toBeTruthy();
    const breach = { message: expect.stringContaining(`stage ${rig.koStageId!}`) };

    // Each way the recorded cut can be missing, one at a time, restored before the next.
    await sql`update stage_seed_proposals set status = 'stale' where id = ${saved!.id}`;
    await expect(getSwissCutDrift(rig.auth, rig.stageId), "the proposal is stale, not confirmed").rejects.toMatchObject(breach);
    await sql`update stage_seed_proposals set status = 'confirmed' where id = ${saved!.id}`;

    await sql`update stage_seed_proposals set computed = computed - 'qualifiers' where id = ${saved!.id}`;
    await expect(getSwissCutDrift(rig.auth, rig.stageId), "a confirmed proposal without a qualifiers array").rejects.toMatchObject(breach);
    await sql`update stage_seed_proposals set computed = ${sql.json(saved!.computed as never)} where id = ${saved!.id}`;

    await sql`delete from stage_seed_proposals where id = ${saved!.id}`;
    await expect(getSwissCutDrift(rig.auth, rig.stageId), "no proposal at all").rejects.toMatchObject(breach);
    await expect(getSwissCutDrift(rig.auth, rig.stageId)).rejects.toMatchObject({ message: expect.stringContaining(`Swiss ${rig.stageId}`) });
  }, 300_000);

  it("X-SW-25 getSwissCutDrift: a knockout whose only result is taken back has still begun — the warning stays (badminton)", async () => {
    // Badminton only: the evidence predicate is sport-blind; only the result event type below is the sport's.
    // `fixtureHasResultSql` is monotonic: a recorded event is evidence for good (fixture-results-sql.ts: "a start taken back
    // leaves `scheduled` behind, and its events"), so voiding the knockout's result does not un-begin the bracket.
    const rig = await startedBracket(SPORTS[0]);
    await flipCut(rig);
    const [, , p3, p4] = rig.entrants as [string, string, string, string];
    expect(await getSwissCutDrift(rig.auth, rig.stageId), "premise: warned").toEqual({ out: [p3], in: [p4] });
    const semi = (await rowsOf(rig.koStageId!)).find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null)!;
    const results = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${semi.id} and type = 'badminton.game.summary' order by seq desc`;
    expect(results.length, "premise: the semi holds results to take back").toBeGreaterThan(0);
    for (const r of results) await scoreEvent(rig.auth, semi.id, { expected_seq: await tip(semi.id), type: "core.void", payload: { event_id: r.id } });
    const [row] = await sql<{ status: string }[]>`select status from fixtures where id = ${semi.id}`;
    expect(row!.status, "premise: the semi no longer holds a decided result").not.toBe("decided");
    expect(await getSwissCutDrift(rig.auth, rig.stageId)).toEqual({ out: [p3], in: [p4] });
  }, 300_000);
});
