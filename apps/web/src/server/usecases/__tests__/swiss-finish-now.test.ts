// W3 Task 13 (RB3-20; rule X-SW-26) on Postgres — "Finish the Swiss now": end a running Swiss after round k, the
// latest round whose seated boards are all decided, and seed what follows from the table as it stood after round k.
// Spec 2026-10-31-format-matrix-w3-swiss-design.md §4 ("Round count editable … then only 'Finish now' or 'Add a
// round'"), the recovery SW-H1's refusal will offer ("Finish after N−1", RB3-4), and the controller rulings for T13:
//   - one predicate (`swissFinishState`, the C11 pattern): every `canFinish` the server sends and `finishSwissNow` itself
//     read it, so an offered Finish never leads to a Finish refusal (the counted sweep at the end of this file);
//   - statuses (422 = can never succeed as sent, 409 = resolvable another way): SWISS_FINISH_NOTHING_PLAYED 409 (play a
//     round), SWISS_FINISH_ROUND_UNDECIDED 409 (decide the boards it names), SWISS_OVER 422 (a finished Swiss stays
//     finished) — pinned here as literals, never read off the table under test;
//   - the barrier writer rules (T5/T12 carries): one `swiss_rounds_changed { via: "finish" }`, `source: "organiser"`,
//     under the `division:` lock, the edit watermark untouched;
//   - "started" is T9's one predicate (`swissBoardStartedSql`): a device link never counts, a bye is not a start;
//   - `completeStage` runs AFTER the finish commits, and what it seeds is checked against `rankedStageStandings` read
//     BEFORE the call — derived independently, never from Finish's own answer;
//   - reviewer flag R3: the finish is two steps, so nothing that would leave the stage unable to complete is committed
//     (the completion predicate is read inside the finish's transaction), and a tied cut never strands it.
//
// Sports: every X-SW-26 case runs for badminton (the house racket sport) and boardgame (chess, the swiss_knockout the
// brief names), on the REAL swiss_knockout template drafts. Single-sport cases carry their reason inline.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { byeAward } from "@/lib/fixture-bye";
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { buildTemplateStages } from "@/lib/format-templates";
import type { SwissRefusalCode } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { undoDivision } from "../history";
import { callFixtureToCourt, undoCall } from "../match-day-call";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { completeStage, computeSeedProposal, confirmSeedProposal, createStages, generateStageFixtures, unpairSwissRound, type SwissExistingFixture } from "../stages";
import { addSwissRound, finishSwissNow, judgeSwissFinish, listSwissRoundControls, patchSwissStage } from "../swiss-rounds-admin";
import { createCourt, createVenue } from "../venues";
import { withdrawEntrantCascade } from "../withdrawal";
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

/** The status each refusal this file meets was RULED to answer (the T13 dispatch and the controller's status rule),
 *  typed here — never read off `SWISS_REFUSALS`, the table under test. */
const RULED_STATUS = {
  SWISS_FINISH_NOTHING_PLAYED: 409, // resolvable: play a round
  SWISS_FINISH_ROUND_UNDECIDED: 409, // resolvable: decide the boards it names
  SWISS_OVER: 422, // reused: a finished Swiss stays finished
  SWISS_ROUNDS_CHANGE_NOT_UNDOABLE: 422, // batch-1 re-review: a barrier is a permanent ledger row
  STAGE_NOT_SWISS: 422, // never succeeds on that stage
} as const satisfies Partial<Record<SwissRefusalCode, 409 | 422>>;
const refusal = (code: keyof typeof RULED_STATUS) => ({ status: RULED_STATUS[code], code });

interface Rig {
  sport: Sport;
  auth: AuthCtx;
  competitionId: string;
  divisionId: string;
  stageId: string;
  /** The knockout the Swiss seeds (swiss_knockout), or null for a lone Swiss. */
  koStageId: string | null;
  kind: Kind;
  /** Entrant ids by seed, P1..Pn. */
  entrants: string[];
}

function entrantInput(kind: Kind, name: string, seed?: number) {
  const seats = Math.min(2, entrantKindCap(kind));
  return {
    kind,
    display_name: name,
    ...(seed !== undefined ? { seed } : {}),
    members: Array.from({ length: seats }, (_, i) => ({
      new_person: { full_name: `${name} m${i + 1} ${randomUUID().slice(0, 4)}` },
      is_captain: false,
      roles: [],
    })),
  };
}

/**
 * N seeded entrants of the sport's own default kind, Started, and a Swiss of `rounds` whose shells are minted. With `q`,
 * the stages are the REAL swiss_knockout template drafts (`buildTemplateStages`, through `CreateStage` as the API takes
 * them): a knockout of the top q, `timing: "setup"`, its TBD bracket drawn on day one. Without it, a lone Swiss.
 */
async function finishRig(
  sport: Sport,
  n: number,
  rounds: number,
  opts: { q?: number; auth?: AuthCtx; onCompleteTop?: number } = {},
): Promise<Rig> {
  const owner = opts.auth ?? (await seedOrg("pro")).auth;
  const comp = await createCompetition(owner, {
    ends_on: "2030-12-31",
    name: "Finish " + randomUUID().slice(0, 6),
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
  if (opts.q !== undefined) {
    const drafts = buildTemplateStages("swiss_knockout", { swissRounds: rounds, poolCount: 2, legs: 1, qualified: opts.q });
    expect(drafts.map((d) => d.kind), "premise: the template is a swiss and a knockout").toEqual(["swiss", "knockout"]);
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
      // The OLDER progression: completion seeds AND draws the knockout (`timing: "on_complete"`).
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
  if (opts.q !== undefined) await generateStageFixtures(owner, koStageId!); // the knockout's day-one TBD bracket
  const rig = { sport, auth: owner, competitionId: comp.id, divisionId: division.id, stageId, koStageId, kind, entrants: made.map((e) => e.id) };
  if ((await rowsOf(stageId)).length === 0) await pair(rig); // Start mints the first stage; a lone Swiss is that stage
  expect(roundsIn(await rowsOf(stageId)), "premise: every round's shells are minted").toEqual(Array.from({ length: rounds }, (_, i) => i + 1));
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
  scheduled_at: Date | null;
  court_id: string | null;
}

const rowsOf = (stageId: string) =>
  sql<Row[]>`
    select id, ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, scheduled_at, court_id
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
const isBye = (f: Row) => /^sw-r\d+-bye$/.test(f.ext_key ?? "");
const roundOf = (rows: readonly Row[], r: number) => rows.filter((f) => f.round_no === r);
const boardsOf = (rows: readonly Row[], r: number) => roundOf(rows, r).filter((f) => !isBye(f));
const roundsIn = (rows: readonly Row[]) => [...new Set(rows.map((f) => f.round_no))].sort((a, b) => a - b);

/** Whether round `upTo + 1` of the field `ids` has ANY legal pairing, proved by brute force from the ledger alone (rulebook
 *  W3 §3.1, P-A1/P-A6): no two players meet twice, and in an odd field the one left out has not had a bye. The premise of
 *  the refused-round test below is this fact, not a claim read from the engine under test. */
function hasLegalNextRound(ids: readonly string[], rows: readonly Row[], upTo: number): boolean {
  const met = new Set<string>();
  const byed = new Set<string>();
  for (const f of rows.filter((x) => x.round_no <= upTo)) {
    if (isBye(f)) {
      if (f.home_entrant_id !== null) byed.add(f.home_entrant_id);
    } else if (f.home_entrant_id !== null && f.away_entrant_id !== null) {
      met.add([f.home_entrant_id, f.away_entrant_id].sort().join("|"));
    }
  }
  const matchable = (left: readonly string[]): boolean => {
    if (left.length === 0) return true;
    const [a, ...rest] = left;
    return rest.some((b, i) => !met.has([a!, b].sort().join("|")) && matchable([...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  if (ids.length % 2 === 0) return matchable(ids);
  return ids.some((out) => !byed.has(out) && matchable(ids.filter((x) => x !== out)));
}

async function stageState(stageId: string): Promise<{ status: string; rounds: unknown }> {
  const [s] = await sql<{ status: string; config: Record<string, unknown> }[]>`select status, config from stages where id = ${stageId}`;
  return { status: s!.status, rounds: s!.config.rounds };
}

/** The ledger's length and the division's own token and watermark: what a refused write must leave alone, and what a
 *  barrier row must move (the token) and must NOT move (the watermark — T5 carry). */
async function ledgerState(divisionId: string) {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from division_events where division_id = ${divisionId}`;
  const [d] = await sql<{ seq: string | number; edit_watermark: string | number | null }[]>`
    select seq, edit_watermark from divisions where id = ${divisionId}`;
  return { events: n, seq: Number(d!.seq), watermark: d!.edit_watermark === null ? null : Number(d!.edit_watermark) };
}

async function roundsRows(divisionId: string) {
  return sql<{ seq: number; payload: Record<string, unknown>; actor_id: string | null }[]>`
    select seq::int as seq, payload, actor_id from division_events
    where division_id = ${divisionId} and type = 'swiss_rounds_changed' order by seq`;
}

/** The scorer's first event: the board has started. */
async function startBoard(rig: Rig, f: Row): Promise<void> {
  await scoreEvent(rig.auth, f.id, { expected_seq: 0, type: "core.start", payload: {} });
}

/** The scorer's quick result: the home side wins, through real scoring events. */
async function homeWins(rig: Rig, f: Row): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${f.id}`;
  let seq = n;
  if (seq === 0) await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "core.start", payload: {} });
  if (rig.sport.sport === "boardgame") {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "boardgame.result", payload: { winner: f.home_entrant_id, method: "resign" } });
  } else {
    await scoreEvent(rig.auth, f.id, { expected_seq: seq++, type: "badminton.game.summary", payload: { home: 21, away: 10 } });
    await scoreEvent(rig.auth, f.id, { expected_seq: seq, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
  }
}

async function playRound(rig: Rig, r: number): Promise<void> {
  const boards = boardsOf(await rowsOf(rig.stageId), r).filter((f) => f.status !== "decided");
  expect(boards.length, `rig: round ${r} has boards to play`).toBeGreaterThan(0);
  for (const f of boards) await homeWins(rig, f);
  const after = boardsOf(await rowsOf(rig.stageId), r);
  expect(after.map((f) => f.status), `rig: round ${r} is decided`).toEqual(after.map(() => "decided"));
}

const pair = (rig: Pick<Rig, "auth" | "stageId">) => generateStageFixtures(rig.auth, rig.stageId);

/** Pair and play rounds 1..k. */
async function playThrough(rig: Rig, k: number): Promise<void> {
  for (let r = 1; r <= k; r++) {
    await pair(rig);
    await playRound(rig, r);
  }
}

/** The stage's ranked table, read with the stage's own ranking (`rankedStageStandings`) — the independent expected
 *  value: what round k left, read BEFORE Finish is called. */
async function standingsNow(rig: Rig) {
  const rows = await withTenant(rig.auth.orgId, (tx) => rankedStageStandings(tx, rig.stageId));
  return [...rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
}

interface Proposal {
  id: string;
  computed: {
    qualifiers: { rank: number; entrantId: string; destinationSlot: string }[];
    ties: { slots: string[]; entrantIds: string[] }[];
  };
}
async function draftProposal(koStageId: string): Promise<Proposal> {
  const [p] = await sql<Proposal[]>`select id, computed from stage_seed_proposals where stage_id = ${koStageId} and status = 'draft'`;
  expect(p, "a draft seed proposal for the knockout").toBeTruthy();
  return p!;
}

/** Confirm the proposal keeping the table's own order at every flagged tie (a pick per tie, as the organiser's "keep
 *  this order" would send it) — a flagged tie is never confirmed silently (SEEDING_TIE_UNRESOLVED). */
async function confirmAsRanked(rig: Rig, p: Proposal): Promise<void> {
  const bySlot = new Map(p.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
  const tiePicks = p.computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((s) => bySlot.get(s)!) }));
  await confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: p.id, tiePicks });
}

/** The knockout's first-round pairs as entrant-id sets, by board. */
async function koRoundOne(koStageId: string): Promise<string[][]> {
  const rows = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select home_entrant_id, away_entrant_id from fixtures where stage_id = ${koStageId}
    and round_no = (select min(round_no) from fixtures where stage_id = ${koStageId}) order by seq_in_round`;
  return rows.map((f) => [f.home_entrant_id, f.away_entrant_id].filter((x): x is string => x !== null).sort());
}

// ---------------------------------------------------------------------------------------------------------------------
// X-SW-26: the plan's five cases, both sports
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("X-SW-26 Finish the Swiss now", () => {
  for (const s of SPORTS) {
    it(`X-SW-26 finishing after round 3 of 5 completes the stage and seeds the knockout from round-3 standings (${s.sport})`, async () => {
      // 6 entrants: §3.2's hard max is 5, so 5 rounds is allowed. A knockout of the top 4 (rank_order: 1 v 4, 2 v 3).
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 3);
      const rowsBefore = await rowsOf(rig.stageId);
      const table = await standingsNow(rig); // the table after round 3, read BEFORE the call
      const top = table.slice(0, 4).map((r) => r.entrantId);
      expect(top, "premise: four ranked").toHaveLength(4);
      const ledger0 = await ledgerState(rig.divisionId);

      const out = await finishSwissNow(rig.auth, rig.stageId);
      // Rounds 4 and 5 go: a field of 6 holds 3 boards a round and no bye (⌊6/2⌋), none of them laid out.
      expect(out).toMatchObject({ finished_after: 3, shells_removed: 6, slots_freed: 0, completed: true });
      expect(out.seed_proposal?.status, "the knockout's draft seed proposal").toBe("draft");
      expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 3 });
      const rowsAfter = await rowsOf(rig.stageId);
      expect(roundsIn(rowsAfter), "rounds 4–5 deleted").toEqual([1, 2, 3]);
      expect(rowsAfter, "rounds 1–3 untouched").toEqual(rowsBefore.filter((f) => f.round_no <= 3));

      // One barrier row, the organiser's, under the division's token; the watermark untouched.
      const barrier = await roundsRows(rig.divisionId);
      expect(barrier.map((r) => r.payload)).toEqual([{ stage_id: rig.stageId, from: 5, to: 3, via: "finish", source: "organiser" }]);
      expect(barrier[0]!.actor_id, "the organiser is the actor").toBe(rig.auth.userId);
      expect(barrier[0]!.seq, "the barrier is the first row this finish wrote").toBe(ledger0.seq + 1);
      expect((await ledgerState(rig.divisionId)).watermark, "the watermark untouched").toBe(ledger0.watermark);

      // Seeded from the table after round 3: the proposal's qualifiers, in rank order, are its top 4.
      const proposal = await draftProposal(rig.koStageId!);
      const qualified = [...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId);
      expect(qualified, "the qualified list is the table read before the call").toEqual(top);
      await confirmAsRanked(rig, proposal);
      // rank_order's 1 v 4 and 2 v 3 (the bracket's standard seeding) — the knockout plays round 3's table.
      expect((await koRoundOne(rig.koStageId!)).sort()).toEqual([[top[0]!, top[3]!].sort(), [top[1]!, top[2]!].sort()].sort());
    }, 300_000);

    it(`X-SW-26 a paired-but-unstarted round 4 is unpaired and dropped (${s.sport})`, async () => {
      // 7 entrants (odd: every round has a bye, hard max 7). Round 4 is paired — its bye AWARDED, a point on the table —
      // and nothing in it started. Finish clears its seats and deletes it with round 5; the bye's point goes with it.
      // W3 (engine 2.0.0, X-SW-3): this was 5 entrants, whose rounds 1-3 corner themselves — in the boardgame run the five
      // have met six of their ten pairs and three of them have had the bye, so round 4 has no rematch-free pairing and Pair
      // is REFUSED (engine 1.x seated a rematch). That refusal has its own test below; here round 4 must be PAIRED, so the
      // field is large enough that three rounds leave a legal fourth.
      const rig = await finishRig(s, 7, 5, { q: 4 });
      await playThrough(rig, 3);
      const after3 = await standingsNow(rig); // the table after round 3, before round 4 is even paired
      expect(hasLegalNextRound(rig.entrants, await rowsOf(rig.stageId), 3), "premise: round 4 has a legal pairing").toBe(true);
      await pair(rig);
      const r4 = roundOf(await rowsOf(rig.stageId), 4);
      const bye = r4.find(isBye)!;
      expect(bye.status, "premise: round 4's bye is awarded").toBe("forfeited");
      const holder = bye.home_entrant_id!;
      const pointsOf = (t: Awaited<ReturnType<typeof standingsNow>>, id: string) => t.find((r) => r.entrantId === id)?.points;
      expect(pointsOf(await standingsNow(rig), holder), "premise: the bye moved the holder's points").not.toBe(pointsOf(after3, holder));
      // A round-5 board laid out (a time is a slot, `holdsSlot`): deleted with its round, and reported, never dropped.
      const laid = boardsOf(await rowsOf(rig.stageId), 5)[0]!;
      await sql`update fixtures set scheduled_at = '2030-06-01T10:00:00Z' where id = ${laid.id}`;

      const out = await finishSwissNow(rig.auth, rig.stageId);
      // Rounds 4 and 5: 3 boards and a bye each (⌊7/2⌋ + 1 = 4 rows).
      expect(out).toMatchObject({ finished_after: 3, shells_removed: 8, slots_freed: 1, completed: true });
      const rows = await rowsOf(rig.stageId);
      expect(roundsIn(rows), "round 4 dropped with round 5").toEqual([1, 2, 3]);
      expect(rows.some((f) => r4.some((g) => g.id === f.id)), "no round-4 row survives").toBe(false);
      // The stage completed on round 3's table: the snapshot it wrote gives the holder no round-4 bye.
      const [snap] = await sql<{ rows: { entrantId: string; points: number; rank: number }[] }[]>`
        select rows from standings_snapshots where stage_id = ${rig.stageId} and pool_id is null`;
      expect(snap?.rows.find((r) => r.entrantId === holder)?.points, "the dropped bye is not counted").toBe(pointsOf(after3, holder));
      const proposal = await draftProposal(rig.koStageId!);
      // W3 (engine 2.0.0, FIDE C.07 art. 16.4.2): the seeding is the top 4 of the FINISHED table, not of `after3` row by row —
      // Finish writes rounds 5 -> 3 and a bye's Buchholz dummy is capped at D x R, so the same three rounds can order TIED rows
      // differently once the total is 3 (the next case rigs exactly that, by hand, so it holds on every run). Here, on a random
      // field where such a pair may or may not exist: the four seeded are the PERSISTED snapshot's top 4 by its stored `rank`
      // (written by Finish, not a second live ranking), in that order, standing on round 3's points — the dropped round-4 bye
      // added a point to nobody.
      const finished = [...snap!.rows].sort((a, b) => a.rank - b.rank);
      expect(finished, "the snapshot holds the whole field, ranked 1..7").toHaveLength(7);
      expect(finished.map((r) => r.rank), "…each rank stored").toEqual([1, 2, 3, 4, 5, 6, 7]);
      const seeded = [...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId);
      expect(seeded, "the seeding is the snapshot's top 4, in its order").toEqual(finished.slice(0, 4).map((r) => r.entrantId));
      expect(
        finished.slice(0, 4).map((r) => r.points),
        "on round 3's points: the dropped bye added none",
      ).toEqual(after3.slice(0, 4).map((r) => r.points));
    }, 300_000);

    it(`X-SW-26 Finish writes rounds 5 -> 3 and the finished table ranks a tie the bye's dummy decides the other way round: the seeding follows the finished order (${s.sport})`, async () => {
      // A hand-derived rig, so the reorder is witnessed on EVERY run (FIDE C.07 art. 16.4.2; rulebook-W3 section 4). FIVE players,
      // three rounds written onto the minted shells ([winner, loser]; the bye holder wins it):
      //   R1 bye p0   p1 beat p2   p3 beat p4
      //   R2 bye p1   p3 beat p0   p4 beat p2
      //   R3 bye p4   p1 beat p0   p3 beat p2
      // Scores (a win = 1): p1 3 (two wins and a bye), p3 3, p4 2, p0 1, p2 0 — p1 and p3 are level on points and only the
      // tie-break separates them. Both sports' Swiss order is points, then Buchholz Cut-1. A bye is an unplayed card: its
      // Buchholz contribution is a dummy at the holder's own score capped at D x R (16.4.2), D a draw = half a win (C.07 7.7:
      // the rule's draw where one can stand, else half the win points), R the stage's rounds. No card here is a voluntary unplayed round, so a cut drops the LOWEST contribution.
      //   p1: opponents p2 = 0 and p0 = 1, and the bye dummy min(3, D x R):
      //       R = 5: min(3, 2.5) = 2.5 -> [0, 1, 2.5], Cut-1 drops 0 -> 3.5      R = 3: min(3, 1.5) = 1.5 -> [0, 1, 1.5] -> 2.5
      //   p3: opponents p4 = 2, p0 = 1, p2 = 0 -> [0, 1, 2], Cut-1 drops 0 -> 3, whatever R is.
      // So under the declared 5 rounds p1 (3.5) ranks above p3 (3); once Finish writes 3 rounds p3 (3) ranks above p1 (2.5).
      // Everyone else is separated by points alone (p4, p0, p2), so no draw of lots is involved.
      const HISTORY: readonly { bye: number; boards: readonly (readonly [number, number])[] }[] = [
        { bye: 0, boards: [[1, 2], [3, 4]] },
        { bye: 1, boards: [[3, 0], [4, 2]] },
        { bye: 4, boards: [[1, 0], [3, 2]] },
      ];
      const rig = await finishRig(s, 5, 5, { q: 4 });
      const e = rig.entrants;
      const idxOf = (id: string) => e.indexOf(id);
      // The boards are SEATED with SQL (the pairer would choose its own) and PLAYED through the real scoring door (`homeWins`:
      // the winner is the home side), because the table folds a board's recorded state, not a stored outcome; the byes are the
      // pairing's own award shape.
      let written = 0;
      for (const [i, round] of HISTORY.entries()) {
        for (const [b, [winner, loser]] of round.boards.entries()) {
          const key = `sw-r${i + 1}-b${b + 1}`;
          const seated = await sql`
            update fixtures set home_entrant_id = ${e[winner]!}, away_entrant_id = ${e[loser]!}
            where stage_id = ${rig.stageId} and ext_key = ${key}
            returning id`;
          expect(seated.length, `rig: shell ${key} exists and took its players`).toBe(1);
          await homeWins(rig, (await rowsOf(rig.stageId)).find((f) => f.ext_key === key)!);
          written++;
        }
        const bye = await sql`
          update fixtures set home_entrant_id = ${e[round.bye]!}, away_entrant_id = null, status = 'forfeited',
            outcome = ${sql.json(byeAward(e[round.bye]!) as never)}
          where stage_id = ${rig.stageId} and ext_key = ${`sw-r${i + 1}-bye`}
          returning id`;
        expect(bye.length, `rig: shell sw-r${i + 1}-bye exists and took the bye`).toBe(1);
        written++;
      }
      expect(written, "rig: three rounds of two boards and a bye written").toBe(9);
      expect(await stageState(rig.stageId), "premise: five rounds are declared").toEqual({ status: "active", rounds: 5 });

      // Before Finish (R = 5): p1 3.5 above p3 3, then p4, p0, p2 on points.
      const before = await standingsNow(rig);
      expect(before.map((r) => idxOf(r.entrantId)), "R = 5: Cut-1 3.5 vs 3 puts p1 above p3").toEqual([1, 3, 4, 0, 2]);
      expect(before[0]!.points, "premise: p1 and p3 are level on points").toBe(before[1]!.points);
      expect(before[1]!.points, "…and ahead of p4").toBeGreaterThan(before[2]!.points);

      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 3, completed: true });

      // After Finish (R = 3): p3 3 above p1 2.5. The PERSISTED snapshot, then the proposal seeded from it.
      const [snap] = await sql<{ rows: { entrantId: string; points: number; rank: number }[] }[]>`
        select rows from standings_snapshots where stage_id = ${rig.stageId} and pool_id is null`;
      const finished = [...snap!.rows].sort((a, b) => a.rank - b.rank);
      expect(finished.map((r) => r.rank), "the snapshot ranks the five 1..5").toEqual([1, 2, 3, 4, 5]);
      expect(finished.map((r) => idxOf(r.entrantId)), "R = 3: Cut-1 3 vs 2.5 puts p3 above p1").toEqual([3, 1, 4, 0, 2]);
      const proposal = await draftProposal(rig.koStageId!);
      const seeded = [...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => idxOf(q.entrantId));
      expect(seeded, "the seeding follows the finished order, not the one read before the call").toEqual([3, 1, 4, 0]);
      expect(proposal.computed.ties, "no tie is left to the organiser: Cut-1 decided it").toEqual([]);
      expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 3 });
    }, 300_000);

    it(`X-SW-26 a started round 4 refuses and names its boards (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 3);
      await pair(rig);
      const r4 = boardsOf(await rowsOf(rig.stageId), 4);
      await startBoard(rig, r4[1]!);
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      // Every undecided board of round 4 is named — the started one and the two not yet started: Finish goes through only
      // once the round is decided (a started board cannot be unpaired), so the list is what the organiser must decide.
      // In the abandoned-board refusal's shape (`{ fixtureId, round, board }`, board = the number within the round).
      const named = r4.map((f) => ({ fixtureId: f.id, round: 4, board: f.seq_in_round }));
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
        ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
        extra: { boards: named },
      });
      expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 5 });

      // The SEQUENCE: one board decided, the others not started — still refused, naming the two still owed.
      await homeWins(rig, r4[1]!);
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
        ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
        extra: { boards: named.filter((b) => b.fixtureId !== r4[1]!.id) },
      });
      // The positive pair: round 4 decided → Finish after round 4 (round 5's 3 shells go).
      await playRound(rig, 4);
      expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 4, shells_removed: 3, completed: true });
    }, 300_000);

    it(`X-SW-26 nothing played refuses (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 5, { q: 4 });
      // The empty case: shells only, no seat anywhere.
      const shells = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject(refusal("SWISS_FINISH_NOTHING_PLAYED"));
      expect(await rowsOf(rig.stageId)).toEqual(shells);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      // Round 1 paired, one board started (and one decided): still no round complete.
      await pair(rig);
      const r1 = boardsOf(await rowsOf(rig.stageId), 1);
      await startBoard(rig, r1[0]!);
      await homeWins(rig, r1[1]!);
      const rows = await rowsOf(rig.stageId);
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject(refusal("SWISS_FINISH_NOTHING_PLAYED"));
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 5 });
      // The positive pair: round 1 decided → it finishes after round 1.
      await playRound(rig, 1);
      expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, completed: true });
    }, 300_000);

    it(`X-SW-26 Undo across a finish refuses SWISS_ROUNDS_CHANGE_NOT_UNDOABLE (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 3);
      await finishSwissNow(rig.auth, rig.stageId);
      const rows = await rowsOf(rig.stageId);
      const ko = await rowsOf(rig.koStageId!);
      const ledger = await ledgerState(rig.divisionId);
      // C12b, re-pinned on the tree: a setup-timing knockout is seeded by a draft proposal, which writes no ledger row,
      // and `stage_completed` is not an Undo step — so the FIRST Undo already targets a row before the barrier.
      await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
      await expect(undoDivision(rig.auth, rig.divisionId), "and again").rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
      expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
      expect(await rowsOf(rig.koStageId!)).toEqual(ko);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
      expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 3 });
    }, 300_000);
  }

  it("X-SW-26 Undo across a finish that drew an on_complete knockout: the first Undo inverts the draw, the next refuses by name (badminton — C12b's other shape; the walk reads the ledger, never the sport)", async () => {
    // C12b: "after a finish, the first Undo targets completeStage's own seeding event" — true for an `on_complete`
    // progression, whose completion seeds AND generates the next stage (a `fixtures_generated` row, an Undo step).
    const rig = await finishRig(SPORTS[0], 6, 5, { onCompleteTop: 4 });
    await playThrough(rig, 2);
    expect(await rowsOf(rig.koStageId!), "premise: an on_complete knockout is not drawn before its source completes").toEqual([]);
    const out = await finishSwissNow(rig.auth, rig.stageId);
    expect(out).toMatchObject({ finished_after: 2, completed: true });
    expect(out.next_stage_fixtures, "premise: completion drew the knockout").toBeGreaterThan(0);
    await undoDivision(rig.auth, rig.divisionId);
    expect(await rowsOf(rig.koStageId!), "the first Undo inverts the knockout's draw").toEqual([]);
    const ledger = await ledgerState(rig.divisionId);
    await expect(undoDivision(rig.auth, rig.divisionId)).rejects.toMatchObject(refusal("SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"));
    expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 2 });
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Sequences (TEST-STRATEGY: a second call, after a withdrawal, after a late entrant, after Add a round, a tied cut)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("X-SW-26 Finish in sequence", () => {
  for (const s of SPORTS) {
    it(`finish twice: the second is SWISS_OVER (422) and writes nothing (${s.sport})`, async () => {
      const rig = await finishRig(s, 4, 3, { q: 2 });
      await playThrough(rig, 1);
      expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, shells_removed: 4, completed: true });
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({ ...refusal("SWISS_OVER"), extra: { canFinish: false } });
      expect(await rowsOf(rig.stageId)).toEqual(rows);
      expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    }, 300_000);

    it(`finish after a late entrant joined: the newcomer's missed rounds count as the rulebook says, and the cut is the table read before (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 2);
      // Between rounds: the newcomer joins round 3 (case (c), ruling 250), then round 3 is played with them in it.
      const [late] = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, "Late")]);
      expect(late!.late_entry, "premise: the late player joins round 3").toMatchObject({ case: "c", round: 3 });
      await pair(rig);
      await playRound(rig, 3);
      const table = await standingsNow(rig);
      expect(table.some((r) => r.entrantId === late!.id), "premise: the newcomer is on the table").toBe(true);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 3, completed: true });
      const proposal = await draftProposal(rig.koStageId!);
      expect([...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId)).toEqual(
        table.slice(0, 4).map((r) => r.entrantId),
      );
    }, 300_000);

    it(`finish after the LEADER withdraws: the Swiss table keeps him, and the cut is that table less the departed — rank 5 backfills his place, a knockout of 4 (T15 Carry A) (${s.sport})`, async () => {
      // Fix round 1 (review m1): the last-placed entrant's withdrawal proved nothing (below the cut either way). The leader
      // leaves between rounds 2 and 3. T13 left this an open question and pinned a dead seat (3 qualifiers); T15 Carry A
      // (controller ruling 2026-11-02) answers it: a withdrawn or disqualified entrant LEAVES a Swiss cut and the next
      // eligible entrant backfills. The Swiss table still carries him, marked departed; only the cut skips him. The plain
      // completion below ("Carry A control … plain completion") reads the same rule — it is the CUT's, not Finish's.
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 2);
      const leader = (await standingsNow(rig))[0]!.entrantId;
      await withdrawEntrantCascade(rig.auth, leader);
      const table = await standingsNow(rig);
      expect(table[0]!.entrantId, "the Swiss table keeps the withdrawn leader in his place").toBe(leader);
      // The independent expected value: the table read before, the departed removed, then the top 4.
      const expected = table.map((r) => r.entrantId).filter((id) => id !== leader).slice(0, 4);
      expect(expected, "premise: rank 5 is the one who backfills").toContain(table[4]!.entrantId);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 2, completed: true });
      const proposal = await draftProposal(rig.koStageId!);
      const qualifiers = [...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank);
      expect(qualifiers.map((q) => q.entrantId), "the table's order less the departed, top 4 — rank 5 backfills").toEqual(expected);
      expect(qualifiers.map((q) => q.rank), "all four seeds are held").toEqual([1, 2, 3, 4]);
    }, 300_000);

    it(`a scorer's take-back of an earlier round's result refuses Finish naming that board (the desk agrees); decided again, Finish goes through (${s.sport})`, async () => {
      // Review I2: the predicate's second arm is reachable in production. Rounds 1–2 decided, then a scorer voids the
      // deciding event of a round-1 board (`core.void`): that board is open again while round 2 stays decided, so k is
      // still 2 — and standings after round 2 cannot become final with a round-1 result missing. Without the arm the desk
      // offered Finish and Finish answered the R3 backstop's STAGE_NOT_READY.
      const rig = await finishRig(s, 4, 3);
      await playThrough(rig, 2);
      const r1 = boardsOf(await rowsOf(rig.stageId), 1)[0]!;
      const [last] = await sql<{ id: string; seq: number }[]>`
        select id, seq from score_events where fixture_id = ${r1.id} order by seq desc limit 1`;
      await scoreEvent(rig.auth, r1.id, { expected_seq: last!.seq, type: "core.void", payload: { event_id: last!.id } });
      const reopened = boardsOf(await rowsOf(rig.stageId), 1).find((f) => f.id === r1.id)!;
      expect(["decided", "finalized", "forfeited"], "premise: the take-back reopened the board").not.toContain(reopened.status);
      expect(boardsOf(await rowsOf(rig.stageId), 2).map((f) => f.status), "premise: round 2 is still decided").toEqual(["decided", "decided"]);

      const desk = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish;
      expect(desk, "the desk does not offer it, and says no round is in progress (a finished round reopened)").toMatchObject({
        canFinish: false,
        refusal: "round_undecided",
        finishedAfter: 2,
        inProgress: false,
      });
      const rows = await rowsOf(rig.stageId);
      const ledger = await ledgerState(rig.divisionId);
      await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
        ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
        extra: { canFinish: false, inProgress: false, boards: [{ fixtureId: r1.id, round: 1, board: r1.seq_in_round }] },
      });
      expect(await rowsOf(rig.stageId), "nothing written: rows").toEqual(rows);
      expect(await ledgerState(rig.divisionId), "nothing written: ledger").toEqual(ledger);
      expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });

      // The positive pair: the scorer decides it again, and the same Finish goes through after round 2.
      const [{ tip }] = await sql<{ tip: number }[]>`select max(seq)::int as tip from score_events where fixture_id = ${r1.id}`;
      if (rig.sport.sport === "boardgame") {
        await scoreEvent(rig.auth, r1.id, { expected_seq: tip, type: "boardgame.result", payload: { winner: r1.home_entrant_id, method: "resign" } });
      } else {
        await scoreEvent(rig.auth, r1.id, { expected_seq: tip, type: "badminton.game.summary", payload: { home: 21, away: 12 } });
      }
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish).toMatchObject({ canFinish: true, finishedAfter: 2 });
      expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 2, completed: true });
      expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1, 2]);
    }, 300_000);

    it(`finish after Add a round: the added round goes with the finish; two barrier rows (${s.sport})`, async () => {
      // 6 × 3 (hard max 5): all three played, Add a round makes it 4 (shells minted), then Finish after round 3.
      const rig = await finishRig(s, 6, 3, { q: 4 });
      await playThrough(rig, 3);
      expect(await addSwissRound(rig.auth, rig.stageId)).toEqual({ rounds: 4, shells_added: 3 });
      const table = await standingsNow(rig);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 3, shells_removed: 3, completed: true });
      expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 3 });
      expect((await roundsRows(rig.divisionId)).map((r) => [r.payload.from, r.payload.to, r.payload.via])).toEqual([
        [3, 4, "add_round"],
        [4, 3, "finish"],
      ]);
      const proposal = await draftProposal(rig.koStageId!);
      expect([...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId)).toEqual(
        table.slice(0, 4).map((r) => r.entrantId),
      );
    }, 300_000);

    it(`finish after a REFUSED round (engine 2.0.0, X-SW-3 / SW-H1): a round with no legal pairing seats nobody — Finish drops its empty boards and asks for none of them (batch-4 ruling 4) (${s.sport})`, async () => {
      // Engine 1.x answered a round with no legal pairing by "succeeding" — seating the bye alone and leaving every board
      // vacant (SW-H1; a stage Paired under 1.x may still hold such a round, which the planted-rows cases of
      // `judgeSwissFinish` below keep pinned). Engine 2.0.0 REFUSES it (SWISS_NO_LEGAL_PAIRING) and writes nothing, so the
      // round is only shells; Finish after round 3 is then the way out, and it must drop those shells without asking for them.
      //
      // The history is the S6 shape (rulebook-W3 §3.1; engine plan Task 4b), written onto the minted shells by SQL so it does not
      // depend on what the pairer chose (a 5-entrant history that corners itself exists, but it moves with the stage's colour
      // lot, which is drawn from the stage's id): SIX players, rounds 1-3 a round-robin quarter, each a home win —
      //   R1 {p0-p1, p2-p3, p4-p5}   R2 {p0-p5, p1-p2, p3-p4}   R3 {p0-p3, p1-p4, p2-p5}
      // — leave two unplayed triangles, so round 4 has no rematch-free perfect matching. That is PROVED below by brute force
      // (`hasLegalNextRound`), not read from the engine, with its pair: after two rounds the same field still pairs.
      const rig = await finishRig(s, 6, 5);
      const S6_HISTORY: readonly (readonly (readonly [number, number])[])[] = [
        [[0, 1], [2, 3], [4, 5]],
        [[0, 5], [1, 2], [3, 4]],
        [[0, 3], [1, 4], [2, 5]],
      ];
      let written = 0;
      for (const [i, round] of S6_HISTORY.entries()) {
        for (const [b, [home, away]] of round.entries()) {
          const outcome = { kind: "win", winner: rig.entrants[home]!, loser: rig.entrants[away]! };
          const done = await sql`
            update fixtures set home_entrant_id = ${rig.entrants[home]!}, away_entrant_id = ${rig.entrants[away]!}, status = 'decided',
              outcome = ${sql.json(outcome as never)}
            where stage_id = ${rig.stageId} and ext_key = ${`sw-r${i + 1}-b${b + 1}`}
            returning id`;
          expect(done.length, `rig: shell sw-r${i + 1}-b${b + 1} exists and took the result`).toBe(1);
          written++;
        }
      }
      expect(written, "rig: three rounds of three boards written").toBe(9);
      expect(hasLegalNextRound(rig.entrants, await rowsOf(rig.stageId), 2), "premise pair: after two rounds round 3 pairs").toBe(true);
      expect(hasLegalNextRound(rig.entrants, await rowsOf(rig.stageId), 3), "premise: after three rounds round 4 has NO legal pairing").toBe(false);

      const asked = await pair(rig).then(
        () => null,
        (e: unknown) => e as { status?: number; code?: string; extra?: unknown },
      );
      expect(asked, "Pair is refused").not.toBeNull();
      expect(asked!.code).toBe("SWISS_NO_LEGAL_PAIRING");
      expect(asked!.status, "409: Finish after round 3 is the way out").toBe(409);
      expect(asked!.extra, "the round, why (every unmet pair is cut off), the field of six, and the recovery: Finish after round 3 goes through").toEqual({
        round: 4,
        reason: "rematch",
        field: 6,
        finishAfter: 3,
        canFinish: true,
      });
      const r4 = roundOf(await rowsOf(rig.stageId), 4);
      expect(r4.length, "round 4's shells are still there").toBeGreaterThan(0);
      expect(r4.filter((f) => f.home_entrant_id !== null || f.away_entrant_id !== null), "the refusal seats nobody: round 4 is empty shells").toEqual([]);

      // The desk offers Finish after round 3 — not "a finished round was reopened", naming boards nobody sits at.
      expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish).toEqual({
        canFinish: true,
        refusal: null,
        finishedAfter: 3,
        inProgress: false,
        completeInstead: false,
      });
      const going = (await rowsOf(rig.stageId)).filter((f) => f.round_no > 3).length;
      expect(going, "rounds 4 and 5 are 3 shells each").toBe(6);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out, "rounds 4 and 5 (shells only) go").toMatchObject({ finished_after: 3, shells_removed: going, completed: true });
      expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1, 2, 3]);
      expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 3 });
    }, 300_000);
  }

  it("finish over a tied cut (reviewer flag R3): the stage completes; the tie is flagged and SEEDING_TIE_UNRESOLVED until picked (badminton — its cascade ends on the seed, so the tie stays unbroken)", async () => {
    // 4 entrants, round 1 won 21-10 21-12 on both boards: the two winners and the two losers are level on every
    // criterion. A knockout of the top 3 cuts between the two losers. RB3-18: a cut-line tie is flagged and picked (or
    // drawn by visible lots), never a play-off game — and Finish must not leave the Swiss half-finished over it.
    const rig = await finishRig(SPORTS[0], 4, 3, { q: 3 });
    await playThrough(rig, 1);
    const table = await standingsNow(rig);
    expect(table.filter((r) => r.tieUnbroken === true).length, "premise: the table ends on unbroken ties").toBeGreaterThan(0);
    const out = await finishSwissNow(rig.auth, rig.stageId);
    expect(out).toMatchObject({ finished_after: 1, completed: true });
    expect(await stageState(rig.stageId)).toEqual({ status: "complete", rounds: 1 });
    const proposal = await draftProposal(rig.koStageId!);
    expect(proposal.computed.ties.length, "the cut's tie is flagged").toBeGreaterThan(0);
    await expect(confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: proposal.id })).rejects.toMatchObject({
      status: 422,
      code: "SEEDING_TIE_UNRESOLVED",
    });
    expect(await stageState(rig.stageId), "the Swiss stays finished").toEqual({ status: "complete", rounds: 1 });
    await confirmAsRanked(rig, proposal);
    expect((await koRoundOne(rig.koStageId!)).flat().sort(), "the pick seats the top 3").toEqual(table.slice(0, 3).map((r) => r.entrantId).sort());
  }, 300_000);

  it("every round decided (the count already at k): the desk hides Finish — Complete is the action (batch-4 ruling m3); the call itself is Complete, with no barrier row and no shell to remove (badminton — the count is arithmetic)", async () => {
    // Every round decided, the stage not yet completed (no auto-progress): Finish is Complete stage, the count unmoved.
    const rig = await finishRig(SPORTS[0], 4, 2, { q: 2 });
    await playThrough(rig, 1);
    // The sequence: one round left to play, Finish is offered; every round decided, it is not.
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "round 2 left: offered").toMatchObject({
      canFinish: true,
      refusal: null,
      finishedAfter: 1,
      completeInstead: false,
    });
    await pair(rig);
    await playRound(rig, 2);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "every round decided: not offered").toEqual({
      canFinish: false,
      refusal: null,
      finishedAfter: 2,
      inProgress: false,
      completeInstead: true,
    });
    const ledger = await ledgerState(rig.divisionId);
    const out = await finishSwissNow(rig.auth, rig.stageId);
    expect(out).toMatchObject({ finished_after: 2, shells_removed: 0, slots_freed: 0, completed: true });
    expect(await roundsRows(rig.divisionId), "the count did not move: no barrier").toEqual([]);
    expect((await ledgerState(rig.divisionId)).watermark).toBe(ledger.watermark);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Guards (badminton — they read rows, the stage and the ledger, never the sport)
// ---------------------------------------------------------------------------------------------------------------------

describe.runIf(HAS_DB)("finishSwissNow guards", () => {
  const BADMINTON = SPORTS[0];

  it("STAGE_NOT_SWISS (422) for a league stage; an unknown stage or another organisation's is 404; nothing written", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "League " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    const [league] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    const before = await ledgerState(division.id);
    await expect(finishSwissNow(auth, league!.id)).rejects.toMatchObject(refusal("STAGE_NOT_SWISS"));
    expect(await ledgerState(division.id)).toEqual(before);
    const rig = await finishRig(BADMINTON, 4, 2);
    const { auth: stranger } = await seedOrg("pro");
    await expect(finishSwissNow(stranger, rig.stageId)).rejects.toMatchObject({ status: 404 });
    await expect(finishSwissNow(rig.auth, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it("a frozen timetable refuses Finish SCHEDULE_LOCKED (422), as Add a round and Unpair; nothing written", async () => {
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    await sql`update divisions set schedule_locked = true where id = ${rig.divisionId}`;
    const rows = await rowsOf(rig.stageId);
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({ status: 422, code: "SCHEDULE_LOCKED" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });
  });

  it("a removed shell carrying its own format refuses by name (FIXTURE_HAS_OWN_FORMAT); nothing written", async () => {
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3)[0]!;
    await sql`update fixtures set rules_override = '{"bestOf": 1}'::jsonb where id = ${r3.id}`;
    const rows = await rowsOf(rig.stageId);
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({ code: "FIXTURE_HAS_OWN_FORMAT" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });
  });

  it("a shell past k carrying recorded data refuses (the started read covers every row past k), naming it; nothing written", async () => {
    // Planted: an unseated shell never holds evidence (nobody can score it). "Started" reads every row Finish would
    // delete, so a shell is never deleted with data on it.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3)[0]!;
    await sql`update fixtures set config_snapshot = '{}'::jsonb where id = ${r3.id}`;
    const rows = await rowsOf(rig.stageId);
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
      ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
      extra: { boards: [{ fixtureId: r3.id, round: 3, board: r3.seq_in_round }] },
    });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
  });

  it("a vacant row in a round ≤ k is part of the verdict (review m4): refused ROUND_UNDECIDED naming it, the desk agreeing; nothing written", async () => {
    // Planted: a played round never holds a vacant board (every Pair seats its whole round). The completion predicate
    // (`isTableStageComplete`) counts it as unsettled, so the Finish predicate does too — the backstop stays a backstop,
    // never a second authority the desk cannot read.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    const [vacant] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, ext_key, status)
      values (${rig.stageId}, ${rig.divisionId}, 1, 9, 'sw-r1-b9', 'scheduled') returning id`;
    const rows = await rowsOf(rig.stageId);
    const ledger = await ledgerState(rig.divisionId);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish).toMatchObject({ canFinish: false, refusal: "round_undecided" });
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
      ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
      extra: { inProgress: false, boards: [{ fixtureId: vacant!.id, round: 1, board: 9 }] },
    });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });
  });

  it("R3 backstop: a finish the stage could not complete on is refused before anything commits (a planted round ≤ k with no rows at all); nothing written", async () => {
    // Planted: Start mints every round's shells and Finish deletes only past k, so a round ≤ k is never empty. A round
    // with no rows has no row for the Finish predicate to read; the completion predicate (`completeStageIfReady`'s own,
    // read inside the finish's transaction) refuses it, so rounds := k is never committed on a stage `completeStage`
    // would then leave open — the half-finished Swiss reviewer flag R3 names.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 2);
    await sql`delete from fixtures where stage_id = ${rig.stageId} and round_no = 1`;
    const rows = await rowsOf(rig.stageId);
    const ledger = await ledgerState(rig.divisionId);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "premise: the predicate reads no row to refuse").toMatchObject({
      canFinish: true,
      finishedAfter: 2,
    });
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });
  });

  it("a withdrawal with the next round paired: the walkover is a start (T9), so that round stays — refused naming its other boards; played, Finish goes through", async () => {
    // Review m1 / probe P2. Rounds 1–2 decided, round 3 paired, then a player withdraws: the cascade walks their round-3
    // board over (forfeited), and a decided board is T9's start. Round 3 cannot be unpaired, so the organiser decides it.
    const rig = await finishRig(BADMINTON, 6, 3, { q: 4 });
    await playThrough(rig, 2);
    await pair(rig);
    const leaver = (await standingsNow(rig))[0]!.entrantId;
    await withdrawEntrantCascade(rig.auth, leaver);
    const r3 = boardsOf(await rowsOf(rig.stageId), 3);
    const walked = r3.filter((f) => f.home_entrant_id === leaver || f.away_entrant_id === leaver);
    expect(walked.map((f) => f.status), "premise: the leaver's board walked over").toEqual(["forfeited"]);
    const open = r3.filter((f) => !walked.includes(f));
    expect(open.length, "premise: the round's other boards are open").toBe(2);
    // Review m7: the desk's row says the round is in progress (its hint is the round-in-progress one, not the reopened one).
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "the desk agrees").toMatchObject({
      canFinish: false,
      refusal: "round_undecided",
      finishedAfter: 2,
      inProgress: true,
    });
    const rows = await rowsOf(rig.stageId);
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
      ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
      extra: { inProgress: true, boards: open.map((f) => ({ fixtureId: f.id, round: 3, board: f.seq_in_round })) },
    });
    expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
    for (const f of open) await homeWins(rig, f);
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 3, shells_removed: 0, completed: true });
  }, 300_000);

  it("Carry A control (T15) — a plain completion, no Finish: a withdrawn leader keeps his place in the table and the cut backfills his seat from rank 5, as Finish's does", async () => {
    // Review m1, first step: is the cut Finish's or the cut's? Reproduced without Finish — the same rule (T15 Carry A:
    // a departed entrant leaves a Swiss cut and the next eligible entrant backfills).
    // Badminton only: the cut reads the ranked table, never the sport.
    const rig = await finishRig(BADMINTON, 6, 3, { q: 4 });
    await playThrough(rig, 2);
    const leader = (await standingsNow(rig))[0]!.entrantId;
    await withdrawEntrantCascade(rig.auth, leader);
    await pair(rig);
    for (const f of boardsOf(await rowsOf(rig.stageId), 3).filter((x) => x.home_entrant_id && x.away_entrant_id && x.status === "scheduled")) {
      await homeWins(rig, f);
    }
    const table = await standingsNow(rig);
    const top = table.slice(0, 4).map((r) => r.entrantId);
    expect(top, "premise: the withdrawn leader is still above the cut after round 3").toContain(leader);
    const expected = table.map((r) => r.entrantId).filter((id) => id !== leader).slice(0, 4);
    expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
    const qualifiers = [...(await draftProposal(rig.koStageId!)).computed.qualifiers].sort((a, b) => a.rank - b.rank);
    expect(qualifiers.map((q) => q.entrantId), "the table's order less the departed, top 4 — rank 5 backfills").toEqual(expected);
    expect(qualifiers).toHaveLength(4);
  }, 300_000);

  it("a later stage under way is SWISS_OVER (422) — its knockout has started (ruling 250's definition, T9's)", async () => {
    const rig = await finishRig(BADMINTON, 4, 2);
    await playThrough(rig, 1);
    const [koStage] = await sql<{ id: string }[]>`
      insert into stages (division_id, seq, kind, name, config) values (${rig.divisionId}, 2, 'knockout', 'KO', '{}') returning id`;
    await sql`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status)
      values (${koStage!.id}, ${rig.divisionId}, 1, 1, ${rig.entrants[0]!}, ${rig.entrants[1]!}, 'in_play')`;
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject(refusal("SWISS_OVER"));
    // The positive pair: that later fixture not started (scheduled) is no start, and Finish goes through.
    await sql`update fixtures set status = 'scheduled' where stage_id = ${koStage!.id}`;
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1 });
  });

  it("a device link on a paired round is not a start (T9 re-ruling I1): the round is unpaired and dropped", async () => {
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    await pair(rig);
    const r2 = boardsOf(await rowsOf(rig.stageId), 2)[0]!;
    await sql`
      insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
      values (${rig.auth.orgId}, ${r2.id}, ${"t13-" + randomUUID()}, null, ${rig.auth.userId}, null)`;
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, completed: true });
    expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1]);
  });

  it("a Match Day call on a paired round IS a start (ruling 257): that round stays — Finish refuses naming its boards; Undo call and the round is unpaired and dropped", async () => {
    // The sibling of the device-link case above, and its opposite: a link carries no mark, but a call writes the court and
    // the time Match Day shows as "Called". Finish reads the one predicate (`swissBoardStartedSql`), so the called round
    // cannot be unpaired — nobody's court is taken from under them.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    await pair(rig);
    const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
    const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const r2 = boardsOf(await rowsOf(rig.stageId), 2);
    expect(r2.length, "premise: round 2 is paired with two boards").toBe(2);
    await callFixtureToCourt(rig.auth, r2[0]!.id, court.id);
    const rows = await rowsOf(rig.stageId);
    expect(rows.find((f) => f.id === r2[0]!.id)!.status, "premise: the call wrote no status").toBe("scheduled");
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "the desk agrees").toMatchObject({
      canFinish: false,
      refusal: "round_undecided",
      finishedAfter: 1,
      inProgress: true,
    });
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({
      ...refusal("SWISS_FINISH_ROUND_UNDECIDED"),
      extra: { inProgress: true, boards: r2.map((f) => ({ fixtureId: f.id, round: 2, board: f.seq_in_round })) },
    });
    expect(await rowsOf(rig.stageId), "nothing written").toEqual(rows);
    // The positive pair: the call undone, the round is unstarted again and Finish unpairs it.
    await undoCall(rig.auth, r2[0]!.id);
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, completed: true });
    expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1]);
  });

  it("Unpair ends the call (ruling 257, review fix): a called round that is Unpaired is unstarted again — Finish offers and takes the stage as for an uncalled round", async () => {
    // The empty boards cannot stay called: a call left on one would keep the round "started" and Finish would name the
    // empty boards as undecided. The positive pair is the case above (the call undone by hand) and the device-link one.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    await pair(rig);
    const venue = await createVenue(rig.auth, { name: "Hall " + randomUUID().slice(0, 4), sort: 0 });
    const court = await createCourt(rig.auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const r2 = boardsOf(await rowsOf(rig.stageId), 2);
    await callFixtureToCourt(rig.auth, r2[0]!.id, court.id);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "premise: the call blocks Finish").toMatchObject({
      canFinish: false,
      refusal: "round_undecided",
    });

    expect(await unpairSwissRound(rig.auth, rig.stageId)).toMatchObject({ cleared: 2, round: 2 });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixture_calls where fixture_id in ${sql(r2.map((f) => f.id))}`;
    expect(n, "no call stands on an emptied board").toBe(0);
    expect((await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!.finish, "the desk offers Finish again").toMatchObject({
      canFinish: true,
      refusal: null,
      finishedAfter: 1,
    });
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, completed: true });
    expect(roundsIn(await rowsOf(rig.stageId))).toEqual([1]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// W3 T15 Carry A (controller ruling 2026-11-02): a withdrawn or disqualified entrant LEAVES the knockout cut when a
// Swiss stage completes — through Finish or through a normal Complete — and the next eligible entrant backfills. The
// Swiss TABLE keeps her (marked departed); only the cut skips her. Every expected value is the table read with the
// stage's own ranking, the ineligible entrants removed, then the top N — never the proposal's own answer.
// ---------------------------------------------------------------------------------------------------------------------

type Table = Awaited<ReturnType<typeof standingsNow>>;
const idsOf = (t: Table) => t.map((r) => r.entrantId);
/** The expected cut: the table's order with the ineligible removed, then the top `n`. */
const cutLess = (t: Table, gone: readonly string[], n: number) => idsOf(t).filter((id) => !gone.includes(id)).slice(0, n);
/** A draw of four seeded in rank order meets 1 v 4 and 2 v 3 (unordered pairs, boards in any order). */
const fourDraw = (seeds: readonly string[]) => [[seeds[0]!, seeds[3]!].sort(), [seeds[1]!, seeds[2]!].sort()].sort();
const qualifierIds = (p: Proposal) => [...p.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId);

describe.runIf(HAS_DB)("T15 Carry A: a departed entrant leaves the Swiss cut; the next eligible entrant backfills", () => {
  for (const s of SPORTS) {
    it(`a withdrawal after the last round, before Complete: the cut skips her, rank 5 backfills, and the knockout draws over the backfilled seeds (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 3, { q: 4 });
      await playThrough(rig, 3);
      expect((await stageState(rig.stageId)).status, "premise: every round decided, the stage not yet completed").toBe("active");
      const table = await standingsNow(rig);
      const leaving = table[1]!.entrantId;
      await withdrawEntrantCascade(rig.auth, leaving);
      expect(idsOf(await standingsNow(rig)), "the Swiss table keeps her, in her place").toEqual(idsOf(table));
      const expected = cutLess(table, [leaving], 4);
      expect(expected, "premise: rank 5 backfills").toContain(table[4]!.entrantId);
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      const proposal = await draftProposal(rig.koStageId!);
      expect(qualifierIds(proposal)).toEqual(expected);
      await confirmAsRanked(rig, proposal);
      expect((await koRoundOne(rig.koStageId!)).sort(), "the knockout seats the backfilled cut, 1 v 4 and 2 v 3").toEqual(fourDraw(expected));
    }, 300_000);

    it(`a DQ mid-Swiss: her round-3 board walks over, and at completion the cut skips her though the table still ranks her inside it (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 3, { q: 4 });
      await playThrough(rig, 2);
      await pair(rig);
      const dq = (await standingsNow(rig))[0]!.entrantId;
      const board = boardsOf(await rowsOf(rig.stageId), 3).find((f) => f.home_entrant_id === dq || f.away_entrant_id === dq);
      expect(board, "premise: the leader is seated in round 3").toBeTruthy();
      await patchEntrant(rig.auth, dq, { status: "disqualified" });
      expect((await rowsOf(rig.stageId)).find((f) => f.id === board!.id)!.status, "her round-3 board walked over (X-SW-23)").toBe("forfeited");
      for (const f of boardsOf(await rowsOf(rig.stageId), 3).filter((x) => x.status === "scheduled")) await homeWins(rig, f);
      const table = await standingsNow(rig);
      expect(idsOf(table).slice(0, 4), "premise: the table still ranks her inside the cut").toContain(dq);
      const expected = cutLess(table, [dq], 4);
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      expect(qualifierIds(await draftProposal(rig.koStageId!))).toEqual(expected);
    }, 300_000);

    it(`two ineligible entrants inside the cut (one withdrawn, one disqualified): both are skipped, ranks 5 and 6 backfill (${s.sport})`, async () => {
      const rig = await finishRig(s, 8, 3, { q: 4 });
      await playThrough(rig, 3);
      const table = await standingsNow(rig);
      const [withdrawn, disqualified] = [table[0]!.entrantId, table[2]!.entrantId];
      await withdrawEntrantCascade(rig.auth, withdrawn);
      await patchEntrant(rig.auth, disqualified, { status: "disqualified" });
      const expected = cutLess(table, [withdrawn, disqualified], 4);
      expect(expected, "premise: ranks 5 and 6 backfill").toEqual([table[1]!, table[3]!, table[4]!, table[5]!].map((r) => r.entrantId));
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      expect(qualifierIds(await draftProposal(rig.koStageId!))).toEqual(expected);
    }, 300_000);

    it(`an ineligible entrant exactly at the cut boundary (rank 4): rank 5 takes the fourth seat (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 3, { q: 4 });
      await playThrough(rig, 3);
      const table = await standingsNow(rig);
      const boundary = table[3]!.entrantId;
      await withdrawEntrantCascade(rig.auth, boundary);
      const expected = cutLess(table, [boundary], 4);
      expect(expected[3], "premise: rank 5 is the fourth qualifier").toBe(table[4]!.entrantId);
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      expect(qualifierIds(await draftProposal(rig.koStageId!))).toEqual(expected);
    }, 300_000);

    it(`the on_complete knockout: config.qualified is the table less the departed, and the drawn bracket seats the backfill with no walkover (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 3, { onCompleteTop: 4 });
      await playThrough(rig, 3);
      const table = await standingsNow(rig);
      const leaving = table[0]!.entrantId;
      await withdrawEntrantCascade(rig.auth, leaving);
      const expected = cutLess(table, [leaving], 4);
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      const [ko] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${rig.koStageId!}`;
      expect(ko!.config.qualified, "the seeded list skips her; rank 5 is in").toEqual(expected);
      expect((await koRoundOne(rig.koStageId!)).sort(), "1 v 4 and 2 v 3 over the backfilled list").toEqual(fourDraw(expected));
      const koRows = await sql<{ status: string }[]>`select status from fixtures where stage_id = ${rig.koStageId!} and round_no = 1`;
      expect(koRows.map((f) => f.status), "no departed qualifier is walked over: every first-round line is open").toEqual(koRows.map(() => "scheduled"));
    }, 300_000);

    // Review I3 (controller ruling, fix round 1): departed entrants move to the BOTTOM of the cut order, never out of it.
    // When fewer eligible entrants remain than the cut, the cut still seeds N — the eligible first, then the departed in
    // table order — and a departed qualifier's seat resolves as it always has. Before, the cut DROPPED her row, the engine
    // refused a table shorter than the cut (STAGE_NOT_READY), and completion's on_complete branch swallowed that as
    // "another source is not ready": the stage completed and seeded nobody, silently. Five players, two leave, cut of 4.
    const shortfall = (table: Table, gone: readonly string[]) =>
      [...cutLess(table, gone, table.length), ...idsOf(table).filter((id) => gone.includes(id))].slice(0, 4);

    it(`a shortfall on the on_complete knockout (3 eligible under a cut of 4): config.qualified still seeds 4 — the eligible three, then the first departed — and her line walks over to seed 1 (${s.sport})`, async () => {
      const rig = await finishRig(s, 5, 3, { onCompleteTop: 4 });
      await playThrough(rig, 3);
      const table = await standingsNow(rig);
      const gone = [table[0]!.entrantId, table[2]!.entrantId];
      await withdrawEntrantCascade(rig.auth, gone[0]!);
      await patchEntrant(rig.auth, gone[1]!, { status: "disqualified" });
      const expected = shortfall(table, gone);
      expect(expected.filter((id) => gone.includes(id)), "premise: the cut reaches exactly one departed entrant, the higher-ranked").toEqual([gone[0]]);
      expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
      const [ko] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${rig.koStageId!}`;
      expect(ko!.config.qualified, "four seeds, never none: the eligible three in table order, then her").toEqual(expected);
      expect((await koRoundOne(rig.koStageId!)).sort(), "1 v 4 and 2 v 3, her seat held").toEqual(fourDraw(expected));
      // Her line: the F14 rule (owner ruling 2026-09-21) — a qualifier who departed before the draw keeps her seat and her
      // pairing is a walkover for the side that remains. The other line is open.
      const koRows = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null; status: string; outcome: unknown }[]>`
        select home_entrant_id, away_entrant_id, status, outcome from fixtures where stage_id = ${rig.koStageId!} and round_no = 1`;
      const hers = koRows.filter((f) => f.home_entrant_id === gone[0] || f.away_entrant_id === gone[0]);
      expect(hers, "premise: she is seated on one line").toHaveLength(1);
      expect(hers[0]).toMatchObject({ status: "forfeited", outcome: { kind: "award", winner: expected[0], loser: gone[0], reason: "withdrew" } });
      expect(koRows.filter((f) => f !== hers[0]).map((f) => f.status)).toEqual(["scheduled"]);
    }, 300_000);

    it(`a shortfall at Finish (3 eligible under a cut of 4): Finish completes, the proposal offers the eligible three, and the departed qualifier's fourth seat stays empty (${s.sport})`, async () => {
      const rig = await finishRig(s, 5, 3, { q: 4 });
      await playThrough(rig, 2);
      const leaving = await standingsNow(rig);
      const gone = [leaving[0]!.entrantId, leaving[2]!.entrantId];
      await withdrawEntrantCascade(rig.auth, gone[0]!);
      await patchEntrant(rig.auth, gone[1]!, { status: "disqualified" });
      const table = await standingsNow(rig);
      expect(idsOf(table), "the Swiss table keeps them both, in their places").toEqual(idsOf(leaving));
      const expected = shortfall(table, gone);
      expect(expected[3], "premise: the fourth seat is a departed entrant's").toBe(gone[0]);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out, "Finish completes — no STAGE_COMPLETED_SEEDING_FAILED").toMatchObject({ finished_after: 2, completed: true });
      const proposal = await draftProposal(rig.koStageId!);
      // The setup proposal never offers a departed qualifier (her seat is vacant, nobody promoted into it): the three.
      expect(qualifierIds(proposal), "the eligible three, in table order").toEqual(expected.slice(0, 3));
      await confirmAsRanked(rig, proposal);
      expect((await koRoundOne(rig.koStageId!)).sort(), "seed 1 alone on the vacant seat's line, 2 v 3").toEqual(
        [[expected[0]!], [expected[1]!, expected[2]!].sort()].sort(),
      );
    }, 300_000);
  }

  it("a tie at the cut boundary AFTER the backfill takes the SEEDING_TIE_UNRESOLVED path, never a silent pick (badminton — its cascade ends on the seed, so a level class stays unbroken, as the R3 tied-cut test above)", async () => {
    // 6 entrants, round 1 won 21-10 21-12 on every board: three winners level, three losers level. A knockout of 3 cuts
    // exactly under the winners — no boundary tie. One winner withdraws: the cut now takes the two winners left and ONE
    // of the three level losers, so the tie is at the boundary only because of the backfill.
    const rig = await finishRig(SPORTS[0], 6, 3, { q: 3 });
    await playThrough(rig, 1);
    const table = await standingsNow(rig);
    expect(table.map((r) => r.won), "premise: three winners, three losers").toEqual([1, 1, 1, 0, 0, 0]);
    expect(table.every((r) => r.tieUnbroken === true), "premise: both classes are unbroken ties").toBe(true);
    const leaving = table[0]!.entrantId;
    const losers = idsOf(table).slice(3);
    await withdrawEntrantCascade(rig.auth, leaving);
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 1, completed: true });
    const proposal = await draftProposal(rig.koStageId!);
    expect(qualifierIds(proposal), "the two winners left, then the first level loser — the engine's provisional pick").toEqual(cutLess(table, [leaving], 3));
    const boundary = proposal.computed.ties.find((t) => t.entrantIds.some((id) => losers.includes(id)));
    expect(boundary, "the boundary tie is flagged").toBeTruthy();
    expect([...boundary!.entrantIds].sort(), "…naming the three level losers").toEqual([...losers].sort());
    expect(proposal.computed.ties.flatMap((t) => t.entrantIds), "the departed winner is in no tie").not.toContain(leaving);
    // Picking every tie but the boundary one is refused by name: never a silent pick.
    const bySlot = new Map(proposal.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
    const pick = (t: { slots: string[] }) => ({ slots: t.slots, order: t.slots.map((x) => bySlot.get(x)!) });
    const others = proposal.computed.ties.filter((t) => t !== boundary).map(pick);
    await expect(confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: proposal.id, tiePicks: others })).rejects.toMatchObject({
      status: 422,
      code: "SEEDING_TIE_UNRESOLVED",
      extra: { slots: boundary!.slots },
    });
    // The organiser picks the LAST level loser for the boundary seat: that pick, not the engine's, is seated.
    const chosen = losers[2]!;
    await confirmSeedProposal(rig.auth, rig.koStageId!, {
      proposalId: proposal.id,
      tiePicks: [...others, { slots: boundary!.slots, order: [chosen] }],
    });
    const seated = (await koRoundOne(rig.koStageId!)).flat();
    expect(seated, "the picked loser is seated").toContain(chosen);
    expect(seated.filter((id) => losers.includes(id)), "exactly one loser takes the boundary seat").toEqual([chosen]);
    expect(seated).not.toContain(leaving);
  }, 300_000);

  it("in sequence: a departure written AFTER the draft (no refresh) stales it — 409, recompute and the backfill is offered; reinstated, the draft offers her again (badminton — the hash and the refresh read entrant status, never the sport)", async () => {
    const rig = await finishRig(SPORTS[0], 6, 3, { q: 4 });
    await playThrough(rig, 3);
    const table = await standingsNow(rig);
    expect(await completeStage(rig.auth, rig.stageId, { publish: false })).toMatchObject({ completed: true });
    const draft = await draftProposal(rig.koStageId!);
    expect(qualifierIds(draft), "premise: the full table's top 4").toEqual(idsOf(table).slice(0, 4));
    // A legacy departure: the status written with no patch, so no draft refresh ran.
    const leaving = table[2]!.entrantId;
    await sql`update entrants set status = 'withdrawn' where id = ${leaving}`;
    const bySlot = new Map(draft.computed.qualifiers.map((q) => [q.destinationSlot, q.entrantId]));
    const tiePicks = draft.computed.ties.map((t) => ({ slots: t.slots, order: t.slots.map((x) => bySlot.get(x)!) }));
    // Resolvable another way (recompute), so 409 — the cut it was computed over has changed.
    await expect(confirmSeedProposal(rig.auth, rig.koStageId!, { proposalId: draft.id, tiePicks })).rejects.toMatchObject({
      status: 409,
      code: "SEEDING_PROPOSAL_STALE",
    });
    const recomputed = await computeSeedProposal(rig.auth, rig.koStageId!);
    expect([...recomputed.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId), "recomputed: rank 5 backfills").toEqual(cutLess(table, [leaving], 4));
    // Reinstated through the patch: the refresh recomputes, and she holds her place again.
    await patchEntrant(rig.auth, leaving, { status: "confirmed" });
    expect(qualifierIds(await draftProposal(rig.koStageId!)), "reinstated: the full table's top 4 again").toEqual(idsOf(table).slice(0, 4));
  }, 300_000);

  it("Swiss only: a LEAGUE cut keeps today's rule — a withdrawn leader's seat is dead and nobody backfills (badminton — the scope guard reads the source stage kind, never the sport)", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "League cut " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    const kind = (builtinModules.find((m) => m.key === "badminton")!.entrantModel?.defaultKind ?? "individual") as Kind;
    await createEntrants(auth, division.id, Array.from({ length: 5 }, (_, i) => entrantInput(kind, `L${i + 1}`, i + 1)));
    const [league] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
    const [ko] = await createStages(auth, division.id, {
      seq: 2,
      kind: "knockout",
      name: "KO",
      config: {},
      progression: { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" },
    });
    await startDivision(auth, division.id);
    if ((await rowsOf(league!.id)).length === 0) await generateStageFixtures(auth, league!.id);
    await generateStageFixtures(auth, ko!.id);
    const rig: Rig = { sport: SPORTS[0], auth, competitionId: comp.id, divisionId: division.id, stageId: league!.id, koStageId: ko!.id, kind, entrants: [] };
    const open = (await rowsOf(league!.id)).filter((f) => f.home_entrant_id && f.away_entrant_id && f.status === "scheduled");
    expect(open.length, "premise: a round robin of five").toBe(10);
    for (const f of open) await homeWins(rig, f);
    const table = await standingsNow(rig);
    const leader = table[0]!.entrantId;
    await withdrawEntrantCascade(auth, leader);
    expect(await completeStage(auth, league!.id, { publish: false })).toMatchObject({ completed: true });
    const qualifiers = [...(await draftProposal(ko!.id)).computed.qualifiers].sort((a, b) => a.rank - b.rank);
    expect(qualifiers.map((q) => q.entrantId), "the top 4 less the departed — rank 5 is NOT promoted").toEqual(idsOf(table).slice(1, 4));
    expect(qualifiers.map((q) => q.rank), "seed 1's place is dead").toEqual([2, 3, 4]);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// C11 for Finish: one canFinish predicate — every place that offers the button agrees with what the button does
// ---------------------------------------------------------------------------------------------------------------------

type Probe = { source: string; canFinish: unknown };

/** Every `canFinish` the server would send in the rig's current state, read without writing: the desk's read, the
 *  rounds lock (a PATCH after the first start is refused, so it writes nothing), Add a round only when it is refused
 *  (at the hard max), and a late player's refusal only when the last round leaves none (refused, rolled back). */
async function emitters(rig: Rig, opts: { atHardMax: boolean; lastRoundLeft: boolean; over?: true }): Promise<Probe[]> {
  const out: Probe[] = [];
  const control = (await listSwissRoundControls(rig.auth, rig.divisionId))[rig.stageId]!;
  out.push({ source: "desk", canFinish: control.finish.canFinish });
  if (control.started) {
    const locked = await patchSwissStage(rig.auth, rig.stageId, { rounds: 1 }).then(
      () => {
        throw new Error("rig: the rounds PATCH went through after the first start");
      },
      (e: { code?: string; extra?: { canFinish?: unknown } }) => e,
    );
    // Batch-4 ruling m1: a finished Swiss's PATCH is SWISS_OVER (422, it can never succeed), not the 409 LOCKED.
    expect(locked.code, "rig: the PATCH is refused as locked, or over once finished").toBe(opts.over ? "SWISS_OVER" : "SWISS_ROUNDS_LOCKED");
    out.push({ source: `PATCH ${locked.code}`, canFinish: locked.extra?.canFinish });
  }
  if (opts.atHardMax) {
    const above = await addSwissRound(rig.auth, rig.stageId).then(
      () => {
        throw new Error("rig: Add a round went through at the hard max");
      },
      (e: { code?: string; extra?: { canFinish?: unknown } }) => e,
    );
    if (above.code === "SWISS_ROUNDS_ABOVE_MAX") out.push({ source: "add-round SWISS_ROUNDS_ABOVE_MAX", canFinish: above.extra?.canFinish });
  }
  if (opts.lastRoundLeft) {
    const late = await createEntrants(rig.auth, rig.divisionId, [entrantInput(rig.kind, "Probe")]).then(
      () => {
        throw new Error("rig: the late player was admitted");
      },
      (e: { code?: string; extra?: { canFinish?: unknown } }) => e,
    );
    if (late.code === "SWISS_NO_ROUND_LEFT") out.push({ source: "SWISS_NO_ROUND_LEFT", canFinish: late.extra?.canFinish });
  }
  return out;
}

describe.runIf(HAS_DB)("C11 for Finish: an offered Finish never leads to a Finish refusal", () => {
  it("every canFinish emitter agrees with finishSwissNow across the Swiss's states (badminton — the predicate reads rows, never the sport)", async () => {
    const { auth } = await seedOrg("pro");
    // Each state is a fresh rig (a Finish ends the stage); n = 4 is at the hard max on 3 rounds (§3.2: n − 1).
    // `completeInstead` (batch-4 ruling m3): every round decided — nothing offers Finish, Complete is the action, and the
    // call itself goes through as Complete would. `over`: the PATCH answers SWISS_OVER there, not LOCKED (ruling m1).
    const states: {
      name: string;
      build: () => Promise<Rig>;
      atHardMax: boolean;
      lastRoundLeft: boolean;
      expected: boolean;
      completeInstead?: true;
      over?: true;
    }[] = [
      { name: "round 1 paired, nothing started", atHardMax: true, lastRoundLeft: false, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await pair(rig);
        return rig;
      } },
      { name: "round 1 started", atHardMax: true, lastRoundLeft: false, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await pair(rig);
        await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 1)[0]!);
        return rig;
      } },
      { name: "round 1 decided, round 2 shells", atHardMax: true, lastRoundLeft: false, expected: true, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        return rig;
      } },
      { name: "round 1 decided, round 2 paired and unstarted", atHardMax: true, lastRoundLeft: false, expected: true, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        await pair(rig);
        return rig;
      } },
      { name: "round 2 started", atHardMax: true, lastRoundLeft: false, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        await pair(rig);
        await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 2)[0]!);
        return rig;
      } },
      { name: "round 2 half decided, the rest unstarted", atHardMax: true, lastRoundLeft: false, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        await pair(rig);
        await homeWins(rig, boardsOf(await rowsOf(rig.stageId), 2)[0]!);
        return rig;
      } },
      { name: "the last round started (no round left for a late player)", atHardMax: true, lastRoundLeft: true, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 2);
        await pair(rig);
        await startBoard(rig, boardsOf(await rowsOf(rig.stageId), 3)[0]!);
        return rig;
      } },
      { name: "every round decided, not completed (no round left for a late player)", atHardMax: true, lastRoundLeft: true, expected: false, completeInstead: true, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 3);
        return rig;
      } },
      { name: "complete", atHardMax: false, lastRoundLeft: false, expected: false, over: true, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        await finishSwissNow(rig.auth, rig.stageId);
        return rig;
      } },
    ];
    let checked = 0;
    let offered = 0;
    let completeInstead = 0;
    let probes = 0;
    for (const state of states) {
      const rig = await state.build();
      const seen = await emitters(rig, state);
      expect(seen.length, `${state.name}: emitters read`).toBeGreaterThan(0);
      probes += seen.length;
      // Every emitter answers the same, and that answer is the state's (the rulebook's: k ≥ 1 and nothing past k started).
      expect(seen, `${state.name}: every emitter`).toEqual(seen.map((p) => ({ source: p.source, canFinish: state.expected })));
      const finish = await finishSwissNow(rig.auth, rig.stageId).then(
        (r) => ({ ok: true as const, finishedAfter: r.finished_after }),
        (e: { code?: string }) => ({ ok: false as const, code: e.code }),
      );
      if (state.expected) {
        expect(finish, `${state.name}: offered → Finish goes through`).toMatchObject({ ok: true });
        offered++;
      } else if (state.completeInstead) {
        // Not offered, and harmless: the call is Complete — it ends the Swiss after its last round, removing nothing.
        expect(finish, `${state.name}: not offered, the call is Complete`).toEqual({ ok: true, finishedAfter: 3 });
        completeInstead++;
      } else {
        expect(finish.ok, `${state.name}: not offered → Finish is refused (${JSON.stringify(finish)})`).toBe(false);
        expect(["SWISS_FINISH_NOTHING_PLAYED", "SWISS_FINISH_ROUND_UNDECIDED", "SWISS_OVER"], state.name).toContain(
          (finish as { code?: string }).code,
        );
      }
      checked++;
    }
    expect(checked, "anti-vacuity: states").toBe(states.length);
    expect(offered, "both answers reached").toBe(2);
    expect(completeInstead, "the Complete-instead state was reached").toBe(1);
    expect(probes, "anti-vacuity: emitter reads").toBeGreaterThanOrEqual(states.length * 2);
  }, 600_000);

  it("a Pair refused for a shrunk field (T11's 409) offers Finish exactly when it goes through (badminton — the bound is arithmetic on the field)", async () => {
    // 6 × 5 (hard max 5); rounds 1 and 2 played; two withdraw → a field of 4 (hard max 3). Round 3 is within it (paired
    // with the shrunk warning, canFinish true: finish after round 2 now); round 4 is not (409 canFinish true).
    const rig = await finishRig(SPORTS[0], 6, 5);
    await playThrough(rig, 2);
    const table = await standingsNow(rig);
    for (const r of table.slice(-2)) await withdrawEntrantCascade(rig.auth, r.entrantId);
    const warned = await pair(rig);
    expect(warned.swiss_rounds, "round 3 pairs with the shrunk warning").toMatchObject({ verdict: "shrunk", hardMax: 3, canFinish: true });
    await playRound(rig, 3);
    const err = await pair(rig).then(
      () => null,
      (e: { status?: number; code?: string; extra?: { canFinish?: unknown } }) => e,
    );
    expect(err, "round 4 is refused").toMatchObject({ status: 409, code: "SWISS_ROUNDS_ABOVE_MAX", extra: { canFinish: true } });
    expect(await finishSwissNow(rig.auth, rig.stageId)).toMatchObject({ finished_after: 3, completed: true });
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The pure verdict (review I2): `judgeSwissFinish` over rows and a started set — no database, so each arm has a cheap
// killer. Expected values are the rule's own words (k = the latest round whose seated boards are all decided; refused
// over → nothing played → a board kept undecided), written as literals per case, never read off the function.
// ---------------------------------------------------------------------------------------------------------------------

describe("judgeSwissFinish — the Finish verdict over rows (pure)", () => {
  type Spec = { round: number; board: number; status?: string; seated?: boolean; bye?: boolean; started?: boolean };
  const fixture = (r: Spec): SwissExistingFixture => ({
    id: `r${r.round}b${r.board}`,
    ext_key: r.bye ? `sw-r${r.round}-bye` : `sw-r${r.round}-b${r.board}`,
    round_no: r.round,
    seq_in_round: r.board,
    status: r.status ?? "scheduled",
    home_entrant_id: r.seated === false ? null : `h${r.round}${r.board}`,
    away_entrant_id: r.seated === false ? null : `a${r.round}${r.board}`,
    outcome: null,
    scheduled_at: null,
    court_id: null,
    venue_id: null,
    schedule_locked: false,
  });
  const decided = (round: number, board: number): Spec => ({ round, board, status: "decided", started: true });
  const shell = (round: number, board: number): Spec => ({ round, board, seated: false });
  const judge = (specs: Spec[], over = false, rounds = 3) =>
    judgeSwissFinish(specs.map(fixture), new Set(specs.filter((r) => r.started).map((r) => `r${r.round}b${r.board}`)), over, rounds);
  const named = (...ids: [number, number][]) => ids.map(([round, board]) => ({ fixtureId: `r${round}b${board}`, round, board }));

  const cases: { name: string; rows: Spec[]; over?: boolean; rounds?: number; expected: Partial<ReturnType<typeof judgeSwissFinish>> }[] = [
    {
      // Batch-4 ruling 4 (SW-H1, engine 1.x): Pair "succeeded" seating only the bye; both boards are vacant. That round
      // was never played, so it is not decided: k stays 3 and Finish drops it, never asking for its empty boards. (Engine
      // 2.0.0 refuses such a round instead, so a new stage never reaches it — but a stage Paired under 1.x may still hold
      // one, so the PLANTED rows stay: the judge reads stored rows, whoever wrote them.)
      name: "a round whose only seated row is the bye (empty success): not decided — Finish after round 3 drops it",
      rows: [
        decided(1, 1), decided(1, 2), decided(2, 1), decided(2, 2), decided(3, 1), decided(3, 2),
        { round: 4, board: 3, status: "decided", bye: true }, shell(4, 1), shell(4, 2), shell(5, 1), shell(5, 2),
      ],
      rounds: 5,
      expected: { finishedAfter: 3, refusal: null, canFinish: true, inProgress: false, completeInstead: false, boards: [] },
    },
    {
      // …and a bye beside a decided board still counts: the round was played (the bye is the odd one out).
      name: "…a decided round holding a bye beside its boards counts as decided",
      rows: [decided(1, 1), decided(1, 2), { round: 1, board: 3, status: "decided", bye: true }, shell(2, 1), shell(2, 2)],
      rounds: 2,
      expected: { finishedAfter: 1, refusal: null, canFinish: true, completeInstead: false, boards: [] },
    },
    {
      // Batch-4 ruling m3: every round decided, nothing past k — Finish would only Complete, so it is not offered.
      name: "every round decided: Complete instead — not offered, though nothing refuses it",
      rows: [decided(1, 1), decided(1, 2), decided(2, 1), decided(2, 2), decided(3, 1), decided(3, 2)],
      rounds: 3,
      expected: { finishedAfter: 3, refusal: null, canFinish: false, completeInstead: true, inProgress: false, boards: [] },
    },
    {
      // …the count above the rows (a planted shape): Finish would still move the count, so it is not Complete.
      name: "…every row decided but the count is above them: Finish still moves the count, so it is offered",
      rows: [decided(1, 1), decided(1, 2), decided(2, 1), decided(2, 2)],
      rounds: 3,
      expected: { finishedAfter: 2, refusal: null, canFinish: true, completeInstead: false },
    },
    {
      name: "a take-back reopened a round-1 board after round 2 was decided (I2): k stays 2, refused naming it, not in progress",
      rows: [{ round: 1, board: 1, status: "in_play", started: true }, decided(1, 2), decided(2, 1), decided(2, 2), shell(3, 1), shell(3, 2)],
      expected: { finishedAfter: 2, refusal: "round_undecided", canFinish: false, inProgress: false, boards: named([1, 1]) },
    },
    {
      name: "…the positive pair: decided again, Finish after round 2",
      rows: [decided(1, 1), decided(1, 2), decided(2, 1), decided(2, 2), shell(3, 1), shell(3, 2)],
      expected: { finishedAfter: 2, refusal: null, canFinish: true, inProgress: false, boards: [] },
    },
    {
      name: "a vacant row in round 1 ≤ k (m4): refused naming it",
      rows: [decided(1, 1), decided(1, 2), shell(1, 3), shell(2, 1), shell(2, 2)],
      expected: { finishedAfter: 1, refusal: "round_undecided", canFinish: false, inProgress: false, boards: named([1, 3]) },
    },
    {
      name: "a started board past k: that round stays — refused naming its undecided boards, in progress",
      rows: [decided(1, 1), decided(1, 2), { round: 2, board: 1, status: "in_play", started: true }, { round: 2, board: 2 }, shell(3, 1)],
      expected: { finishedAfter: 1, refusal: "round_undecided", canFinish: false, inProgress: true, boards: named([2, 1], [2, 2]) },
    },
    {
      name: "both: a reopened round-1 board and a started round 3 — every board kept undecided is named, in progress",
      rows: [{ round: 1, board: 1, status: "in_play", started: true }, decided(1, 2), decided(2, 1), decided(2, 2), { round: 3, board: 1, status: "in_play", started: true }, { round: 3, board: 2 }],
      expected: { finishedAfter: 2, refusal: "round_undecided", canFinish: false, inProgress: true, boards: named([1, 1], [3, 1], [3, 2]) },
    },
    {
      name: "a paired round past k that nothing has started is dropped: Finish after round 1",
      rows: [decided(1, 1), decided(1, 2), { round: 2, board: 1 }, { round: 2, board: 2 }, { round: 2, board: 3, bye: true, seated: false }],
      expected: { finishedAfter: 1, refusal: null, canFinish: true, inProgress: false, boards: [] },
    },
    {
      name: "no round complete: nothing played",
      rows: [{ round: 1, board: 1, status: "in_play", started: true }, { round: 1, board: 2 }, shell(2, 1)],
      expected: { finishedAfter: 0, refusal: "nothing_played", canFinish: false, boards: [] },
    },
    {
      name: "over outranks everything",
      rows: [decided(1, 1), decided(1, 2)],
      over: true,
      expected: { refusal: "over", canFinish: false },
    },
  ];

  it("each case answers as the rule says, and both answers are reached", () => {
    const answers = new Set<boolean>();
    let checked = 0;
    for (const c of cases) {
      const got = judge(c.rows, c.over, c.rounds);
      expect(got, c.name).toMatchObject(c.expected);
      answers.add(got.canFinish);
      checked++;
    }
    expect(checked, "anti-vacuity: every case was judged").toBe(cases.length);
    expect(checked).toBeGreaterThanOrEqual(12);
    expect([...answers].sort(), "anti-vacuity: both canFinish answers reached").toEqual([false, true]);
  });
});
