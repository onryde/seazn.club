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
import { builtinModules } from "@seazn/engine/sports";
import { entrantKindCap } from "@seazn/engine/sport";
import { buildTemplateStages } from "@/lib/format-templates";
import type { SwissRefusalCode } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { rankedStageStandings } from "@/server/engine-db/competition";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { undoDivision } from "../history";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { confirmSeedProposal, createStages, generateStageFixtures } from "../stages";
import { addSwissRound, finishSwissNow, listSwissRoundControls, patchSwissStage } from "../swiss-rounds-admin";
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
      // 5 entrants (odd: every round has a bye, hard max 5). Round 4 is paired — its bye AWARDED, a point on the table —
      // and nothing in it started. Finish clears its seats and deletes it with round 5; the bye's point goes with it.
      const rig = await finishRig(s, 5, 5, { q: 4 });
      await playThrough(rig, 3);
      const after3 = await standingsNow(rig); // the table after round 3, before round 4 is even paired
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
      // Rounds 4 and 5: 2 boards and a bye each (⌊5/2⌋ + 1).
      expect(out).toMatchObject({ finished_after: 3, shells_removed: 6, slots_freed: 1, completed: true });
      const rows = await rowsOf(rig.stageId);
      expect(roundsIn(rows), "round 4 dropped with round 5").toEqual([1, 2, 3]);
      expect(rows.some((f) => r4.some((g) => g.id === f.id)), "no round-4 row survives").toBe(false);
      // The stage completed on round 3's table: the snapshot it wrote gives the holder no round-4 bye.
      const [snap] = await sql<{ rows: { entrantId: string; points: number }[] }[]>`
        select rows from standings_snapshots where stage_id = ${rig.stageId} and pool_id is null`;
      expect(snap?.rows.find((r) => r.entrantId === holder)?.points, "the dropped bye is not counted").toBe(pointsOf(after3, holder));
      const proposal = await draftProposal(rig.koStageId!);
      expect([...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId)).toEqual(
        after3.slice(0, 4).map((r) => r.entrantId),
      );
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

    it(`finish after a withdrawal: the withdrawn entrant is not seeded; the cut is the table read before (${s.sport})`, async () => {
      const rig = await finishRig(s, 6, 5, { q: 4 });
      await playThrough(rig, 2);
      // The last-placed entrant leaves between rounds (the field shrinks to 5: rounds 3–5 reshape at their Pair).
      const last = (await standingsNow(rig)).at(-1)!.entrantId;
      await withdrawEntrantCascade(rig.auth, last);
      const table = await standingsNow(rig);
      const top = table.slice(0, 4).map((r) => r.entrantId);
      expect(top, "premise: the withdrawn entrant is below the cut").not.toContain(last);
      const out = await finishSwissNow(rig.auth, rig.stageId);
      expect(out).toMatchObject({ finished_after: 2, completed: true });
      const proposal = await draftProposal(rig.koStageId!);
      const qualified = [...proposal.computed.qualifiers].sort((a, b) => a.rank - b.rank).map((q) => q.entrantId);
      expect(qualified).toEqual(top);
      expect(qualified).not.toContain(last);
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

  it("a round count already at k: Finish completes with no barrier row and no shell to remove (badminton — the count is arithmetic)", async () => {
    // Every round decided, the stage not yet completed (no auto-progress): Finish is Complete stage, the count unmoved.
    const rig = await finishRig(SPORTS[0], 4, 2, { q: 2 });
    await playThrough(rig, 2);
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

  it("R3 backstop: a finish the stage could not complete on is refused before anything commits (a planted vacant board in round k); nothing written", async () => {
    // Planted: a played round never holds a vacant board (every Pair seats its whole round). Finish reads the completion
    // predicate (`completeStageIfReady`'s own) inside its transaction, so it never commits rounds := k on a stage that
    // `completeStage` would then leave open — the half-finished Swiss reviewer flag R3 names.
    const rig = await finishRig(BADMINTON, 4, 3);
    await playThrough(rig, 1);
    await sql`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round, ext_key, status)
      values (${rig.stageId}, ${rig.divisionId}, 1, 9, 'sw-r1-b9', 'scheduled')`;
    const rows = await rowsOf(rig.stageId);
    const ledger = await ledgerState(rig.divisionId);
    await expect(finishSwissNow(rig.auth, rig.stageId)).rejects.toMatchObject({ code: "STAGE_NOT_READY" });
    expect(await rowsOf(rig.stageId)).toEqual(rows);
    expect(await ledgerState(rig.divisionId)).toEqual(ledger);
    expect(await stageState(rig.stageId)).toEqual({ status: "active", rounds: 3 });
  });

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
});

// ---------------------------------------------------------------------------------------------------------------------
// C11 for Finish: one canFinish predicate — every place that offers the button agrees with what the button does
// ---------------------------------------------------------------------------------------------------------------------

type Probe = { source: string; canFinish: unknown };

/** Every `canFinish` the server would send in the rig's current state, read without writing: the desk's read, the
 *  rounds lock (a PATCH after the first start is refused, so it writes nothing), Add a round only when it is refused
 *  (at the hard max), and a late player's refusal only when the last round leaves none (refused, rolled back). */
async function emitters(rig: Rig, opts: { atHardMax: boolean; lastRoundLeft: boolean }): Promise<Probe[]> {
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
    expect(locked.code, "rig: the PATCH is refused as locked").toBe("SWISS_ROUNDS_LOCKED");
    out.push({ source: "SWISS_ROUNDS_LOCKED", canFinish: locked.extra?.canFinish });
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
    const states: { name: string; build: () => Promise<Rig>; atHardMax: boolean; lastRoundLeft: boolean; expected: boolean }[] = [
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
      { name: "every round decided, not completed (no round left for a late player)", atHardMax: true, lastRoundLeft: true, expected: true, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 3);
        return rig;
      } },
      { name: "complete", atHardMax: false, lastRoundLeft: false, expected: false, build: async () => {
        const rig = await finishRig(SPORTS[0], 4, 3, { auth });
        await playThrough(rig, 1);
        await finishSwissNow(rig.auth, rig.stageId);
        return rig;
      } },
    ];
    let checked = 0;
    let offered = 0;
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
      } else {
        expect(finish.ok, `${state.name}: not offered → Finish is refused (${JSON.stringify(finish)})`).toBe(false);
        expect(["SWISS_FINISH_NOTHING_PLAYED", "SWISS_FINISH_ROUND_UNDECIDED", "SWISS_OVER"], state.name).toContain(
          (finish as { code?: string }).code,
        );
      }
      checked++;
    }
    expect(checked, "anti-vacuity: states").toBe(states.length);
    expect(offered, "both answers reached").toBe(3);
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
