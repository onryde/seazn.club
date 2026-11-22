import "server-only";
import { withTenant } from "@/lib/db";
import { assertAdvancingSeat, assertNoLevelSeat, fedSeatOccupant } from "../level-seat";
import { isLegacyForfeitWin } from "../fed-seats";
import { completionEngineStatus } from "../recorded-abandon";
import { EngineError, type MatchOutcome } from "@seazn/engine/core";
import {
  SETTLED_FIXTURE_STATUSES,
  completeBracketStage,
  isBracketStageComplete,
  placementTable,
  type BracketFixture,
  type BracketStage,
  type StandingsRow,
} from "@seazn/engine/competition";
import { attachFeedRefs, engineRoundOf, laneDepthOf } from "../bracket-rounds";
import { bracketRosterOf, drawSeedsOf } from "../bracket-roster";
import { rootBracketOrder } from "../knockout-draw";
import type { FixtureRow, Tx, StageInputs } from "./types";
import { loadStageInputs } from "./stage-inputs";
import { isBracketKind } from "./kinds";
import { writeSnapshot } from "./standings";

/** The double-elimination grand final's and bracket reset's ext_keys (`generateDoubleElim`: `gf`, `gf-reset`). */
const GRAND_FINAL_KEY = "gf";
const BRACKET_RESET_KEY = "gf-reset";

// L3/#414 pass 2 — `ext_key` is the ONE place a bracket fixture's lane
// (WB/LB/GF, double-elim only) and thirdPlace status can be recovered by
// PARSING an id: bracket.ts mints these ids at generation (`wb-r{r}-i{i}`,
// `lb-r{r}-i{i}`, `gf`/`gf-reset`, `${idPrefix}-3p`) and usecases/stages/ writes
// them straight to fixtures.ext_key (PROMPT-09). F1 (2026-08-17) added
// fixtures.lane/fixtures.third_place as a direct, cheaper alternative
// (db/migration/deltas/V368__fixture_round_role.sql) — this function still
// parses ext_key rather than reading those columns because it hasn't been
// migrated to them, not because ext_key remains the only source. Either
// way, never re-derive lane/thirdPlace from round/position: a bracket's
// rounds number sparsely (1,2,3 on a winners' lane, 7-10 on a losers' lane,
// 14 for a grand final — spec 05 §2.3/§2.5), so no arithmetic on `round` can
// recover which lane a fixture belongs to.
export function parseExtKey(extKey: string | null): { bracket?: "WB" | "LB" | "GF"; thirdPlace: boolean } {
  if (extKey === null) return { thirdPlace: false };
  const bracket =
    extKey === "gf" || extKey.startsWith("gf-")
      ? ("GF" as const)
      : extKey.startsWith("wb-")
        ? ("WB" as const)
        : extKey.startsWith("lb-")
          ? ("LB" as const)
          : undefined;
  return { ...(bracket !== undefined ? { bracket } : {}), thirdPlace: extKey.endsWith("-3p") };
}

// A decided/walkover bracket fixture's outcome jsonb names its winner/loser
// (spec 03 §3 MatchOutcome), exhaustive over the engine's OUTCOME_KINDS, and —
// W2b (spec §5.3, W2b-R11) — whether the bracket was WALKED OVER there, which
// `bracketRanks` reads to pin an entrant's elimination to this fixture the way
// seating already does (`BracketFixture.walkedOver`, engine stage.ts):
//  - `win` names both directly; a LEGACY forfeit win (pre-W2b chess,
//    `isLegacyForfeitWin`) is a forfeit — walked over, "loser";
//  - `award` names its loser since W2b (`loser`, null for a bye). A row stored
//    before W2b names only the winner, and the loser is whichever side isn't
//    them (testkit/simulation.ts's own derivation). A loser means a forfeit —
//    walked over, "loser"; no loser (a bye, one seat) means neither. A loser
//    who holds NO seat here (owner ruling 116: a winner who withdrew before
//    this tie, its seat dead, `awardSeededByes`) is named for the copy alone:
//    she never sat in it, so it does not eliminate her and ranks her nowhere —
//    the bye it was, where a departed entrant always ranked (never above a
//    field entrant). Named as the loser of a walked-over FINAL, she would
//    otherwise rank runner-up;
//  - `double_walkover` names nobody — walked over, "both" (X-DW-2);
//  - draw/tie/no_result: a bracket fixture holding one is needs_decision (W2a
//    X-BR-2) and seats nobody, so neither side; a level outcome under a SEATING
//    status is the bug shape, asserted by the callers that know the stage kind
//    (level-seat.ts, X-BR-1).
export function bracketWinnerLoser(
  outcome: unknown,
  home: string | null,
  away: string | null,
): { winner?: string; loser?: string; walkedOver?: "loser" | "both" } {
  if (!outcome) return {};
  const o = outcome as MatchOutcome;
  switch (o.kind) {
    case "win":
      return isLegacyForfeitWin(o) ? { winner: o.winner, loser: o.loser, walkedOver: "loser" } : { winner: o.winner, loser: o.loser };
    case "award": {
      const loser = o.loser !== undefined ? o.loser : o.winner === home ? away : home;
      return loser === null || (loser !== home && loser !== away) ? { winner: o.winner } : { winner: o.winner, loser, walkedOver: "loser" };
    }
    case "double_walkover":
      return { walkedOver: "both" };
    case "draw":
    case "tie":
    case "no_result":
      return {};
    default: {
      const unknown: never = o;
      throw new Error(`bracketWinnerLoser: outcome kind ${JSON.stringify((unknown as { kind?: unknown }).kind)} is not an engine OUTCOME_KINDS member`);
    }
  }
}

// Rebuild one DB fixture row into the engine's BracketFixture shape (spec 05
// §1). `isFinal` starts at `!thirdPlace` and is refined true->false by the
// caller once it knows which fixtures have an onward winner_to_fixture feed
// (a second query across the whole stage, not a fact of the row alone) — but
// NEVER the other way. A thirdPlace playoff decides nothing beyond ranks 3/4,
// so its winner never feeds forward either, which means the naive
// "winner_to_fixture is null => isFinal" heuristic marks it isFinal too: with
// a thirdPlace game sharing the true final's round_no (bracket.ts:
// `round: se.rounds - 1`, identical to the final's own `rounds - 1`),
// bracketRanks's `decidedFinals` round-desc sort can then pick either one as
// the grand final depending on array order. thirdPlace status is structural
// (parsed from ext_key, never guessed) and settles it unconditionally: a
// thirdPlace fixture is never the decider, full stop.
function toBracketFixture(
  f: FixtureRow,
  stageKind: string,
  seatsOf: (fixtureId: string) => readonly [string | null, string | null] | null,
  /** The stage's winners'-side round count (`laneDepthOf`): the engine's round is 0-based per lane (C5/C9). */
  laneDepth: number,
): BracketFixture {
  assertNoLevelSeat({ fixtureId: f.id, stageKind, status: f.status, outcome: f.outcome }); // X-BR-1
  // W2b D20: a double walkover seated nobody in the seats it feeds.
  assertAdvancingSeat({ fixtureId: f.id, stageKind, status: f.status, outcome: f.outcome, seatedEntrant: fedSeatOccupant(f, seatsOf) });
  const { bracket, thirdPlace } = parseExtKey(f.ext_key);
  const { winner, loser, walkedOver } = bracketWinnerLoser(f.outcome, f.home_entrant_id, f.away_entrant_id);
  // W4 T12 (X-CH-4): joint winners are a column, not an outcome kind (the engine's kinds are closed): the final reads decided,
  // naming no winner and no loser, and the engine's `jointWinners` flag crowns both seats. The shape is guarded in the
  // engine (`jointWinnersOf`: a final, both seats, decided, no winner/loser/walkover) and in V499's check.
  const joint = f.joint_winners_at !== null;
  return {
    id: f.id,
    round: engineRoundOf(f.round_no, bracket, laneDepth),
    isFinal: !thirdPlace,
    // D-G1: a recorded abandon that decided nobody is in play, never the generator's void (recorded-abandon.ts).
    status: joint ? "decided" : completionEngineStatus(stageKind, f),
    ...(joint ? { jointWinners: true } : {}),
    ...(bracket !== undefined ? { bracket } : {}),
    ...(thirdPlace ? { thirdPlace: true } : {}),
    ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
    ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
    ...(winner !== undefined ? { winner } : {}),
    ...(loser !== undefined ? { loser } : {}),
    ...(walkedOver !== undefined ? { walkedOver } : {}),
  };
}

/** engine 5.0.0 (`BracketStage.entrants`, `seeds`): the entrants the stage DREW, in the order it was drawn, so the ranks
 *  cover exactly them (each once; a finalist who left is ranked 2nd, so she has to be on it) - W4 app PR B (C1/C12).
 *
 *  A stage drawn from a previous stage's cut stored its draw order as `config.qualified` (departed qualifiers included -
 *  `generate-tx.ts`); that IS the roster. A root stage has no stored list: its draw is rebuilt with the generator's own
 *  `knockoutDrawOrder` over everyone seated. Either way the seat-holders are in (a departed entrant who held a seat is
 *  named by the fixtures), and an entrant parked on this stage by a late arrival (`knockout_waiting_stage_id`) is NOT. One who
 *  never held a seat and is not on the drawn list (withdrew before the draw, or never qualified from a group or league) is
 *  not declared either: she would rank last in a stage she never played in.
 *
 *  `seeds` are the DRAW seeds (position in that order, 1-based) - never a registration seed the draw did not use: a fed
 *  stage's registration seeds are unrelated to its qualification order, and X-SP-4 reads a stepladder rung from them. */
/** The field the stage's newest seed-proposal confirm drew, in seed order, or null: no confirm (a root stage, or an
 *  `on_complete` one, whose draw is `config.qualified`).
 *
 *  Authority: `seed_confirmed.payload.entrants` (stages/seed-proposal.ts) - the FINAL slots, i.e. the computed slate with the
 *  organiser's edits and tie picks applied, which the request carried and no row stores. A confirm written before PR B has no
 *  `entrants`; its `proposal_id` still names the proposal row, whose persisted `computed.qualifiers` (rank = seed) is the slate
 *  before edits - the best lossless record there is (an edited slot reads as the computed entrant, not the edit). */
async function confirmedDraw(tx: Tx, divisionId: string, stageId: string): Promise<string[] | null> {
  const [row] = await tx<{ entrants: unknown; proposal_id: string | null }[]>`
    select payload->'entrants' as entrants, payload->>'proposal_id' as proposal_id from division_events
     where division_id = ${divisionId} and type = 'seed_confirmed' and payload->>'stage_id' = ${stageId}
     order by seq desc limit 1`;
  if (row === undefined) return null;
  if (Array.isArray(row.entrants)) return row.entrants as string[];
  if (row.proposal_id === null) return null;
  const [proposal] = await tx<{ qualifiers: unknown }[]>`
    select computed->'qualifiers' as qualifiers from stage_seed_proposals where id = ${row.proposal_id} and stage_id = ${stageId}`;
  if (!Array.isArray(proposal?.qualifiers)) return null;
  const qs = proposal!.qualifiers as { rank: number; entrantId: string }[];
  return [...new Map([...qs].sort((x, y) => x.rank - y.rank).map((q) => [q.entrantId, q.rank] as const)).keys()];
}

async function bracketRosterAndSeeds(tx: Tx, inputs: StageInputs, stageId: string): Promise<{ entrants: string[]; seeds: Map<string, number> }> {
  const seated = inputs.entrants;
  const stored = (inputs.stage.config as { qualified?: unknown } | null)?.qualified;
  const waiting = new Set(
    (await tx<{ id: string }[]>`select id from entrants where knockout_waiting_stage_id = ${stageId}`).map((r) => r.id),
  );
  let drawn: string[];
  const confirmed = Array.isArray(stored) ? null : await confirmedDraw(tx, inputs.stage.division_id, stageId);
  if (Array.isArray(stored)) {
    drawn = stored as string[];
  } else if (confirmed !== null) {
    // A setup-timed fed stage (stepladder, page playoff, a knockout cut from a table): its draw was published at the seed
    // proposal's confirm, which recorded who it drew. Needed because a seat emptied by a later withdrawal holds no entrant.
    drawn = confirmed;
  } else if (seated.length === 0) {
    drawn = [];
  } else {
    const rows = await tx<{ id: string; seed: number | null }[]>`
      select id, seed from entrants where id in ${tx(seated)} order by seed nulls last, created_at, id`;
    const active = rows.map((r) => ({ id: r.id, seed: r.seed, swiss_first_round: null }));
    drawn = rootBracketOrder(inputs.kind, stageId, active, (inputs.stage.config ?? {}) as Record<string, unknown>);
  }
  const entrants = bracketRosterOf({ drawn, seated, waiting });
  return { entrants, seeds: drawSeedsOf(entrants) };
}

/** A bracket stage's engine shape, read for Complete and for a correction after it (`refreshCompletedBracketPlacement`).
 *
 *  Seeds matter here: bracketRanks's rankRest tiebreak cascade is elimination-round first, seed SECOND (and only then a
 *  stable id fallback) — the exact path a thirdPlace playoff that hasn't been played yet falls back to for ranks 3/4 (see
 *  the "never masquerades" regression test below). Omitting seeds — the same optional-field pattern toTableStage already
 *  uses — would silently degrade that tiebreak to raw entrant-id comparison. */
export async function readBracketStage(
  tx: Tx,
  inputs: StageInputs,
  stageId: string,
): Promise<{ bracketStage: BracketStage; bracketFixtures: BracketFixture[] }> {
  const roster = await bracketRosterAndSeeds(tx, inputs, stageId);
  const bracketStage: BracketStage = {
    id: stageId,
    kind: inputs.kind as BracketStage["kind"],
    entrants: roster.entrants,
    ...(roster.seeds.size > 0 ? { seeds: roster.seeds } : {}),
  };
  const seats = new Map(inputs.fixtures.map((f) => [f.id, [f.home_entrant_id, f.away_entrant_id] as const]));
  const laneDepth = laneDepthOf(inputs.fixtures.map((f) => ({ lane: parseExtKey(f.ext_key).bracket, roundNo: f.round_no })));
  const bracketFixtures: BracketFixture[] = inputs.fixtures.map((f) => toBracketFixture(f, inputs.kind, (id) => seats.get(id) ?? null, laneDepth));
  // Refine: only fixtures with no onward winner feed are finals (a
  // fixture whose winner feeds nowhere is the bracket's deciding game).
  const feeders = await tx<{ id: string }[]>`
    select id from fixtures where stage_id = ${stageId} and winner_to_fixture is not null
  `;
  const feederIds = new Set(feeders.map((r) => r.id));
  const rowOf = new Map(inputs.fixtures.map((f) => [f.id, f]));
  // C2/C17 (double elimination): the grand final feeds the bracket reset, but it is a FINAL all the same - the winners'
  // champion's win there decides the title and the reset is then never played (spec 05 §2.4). Keyed on the grand final's own
  // ext_key, never on `winner_to_fixture`, which is exactly what made it a feeder.
  for (const bf of bracketFixtures) if (feederIds.has(bf.id) && rowOf.get(bf.id)!.ext_key !== GRAND_FINAL_KEY) bf.isFinal = false;
  // engine 5.0.0 (`resolveDeadSeats`): which fixture's winner or loser fills each seat. Without it a seat emptied by a
  // withdrawal cannot be attributed, so the walkover over it names no loser and the departed entrant ranks nowhere.
  const feedEdges = await tx<
    { id: string; winner_to_fixture: string | null; winner_to_slot: number | null; loser_to_fixture: string | null; loser_to_slot: number | null }[]
  >`select id, winner_to_fixture, winner_to_slot, loser_to_fixture, loser_to_slot from fixtures where stage_id = ${stageId}`;
  const byFixture = new Map(bracketFixtures.map((bf) => [bf.id, bf]));
  attachFeedRefs(byFixture, feedEdges);
  // R-1: a THIRD-PLACE line that holds nobody and whose every feeder is already settled can never be
  // filled or played - and the app owes no result for it (`undecidedBracketFixtures`: a bye line). Engine 5.0.0 holds
  // completion for every unsettled fixture (X-CH-7), so it is read as the void it is, or the stage would wait on it
  // forever. A voided third place shares 3rd (never a seed split).
  for (const bf of bracketFixtures) {
    const row = rowOf.get(bf.id)!;
    if (bf.thirdPlace !== true || bf.status !== "scheduled" || row.outcome !== null || row.home_entrant_id !== null || row.away_entrant_id !== null) continue;
    const feeders = [bf.homeFrom, bf.awayFrom].filter((r): r is NonNullable<typeof r> => r !== undefined);
    if (feeders.length > 0 && feeders.every((r) => SETTLED_FIXTURE_STATUSES.has(byFixture.get(r.fixtureId)!.status))) bf.status = "void";
  }
  // C2/C17: a bracket reset the grand final did not trigger can never be played - the winners' champion (the grand final's
  // HOME entrant, as `undecidedBracketFixtures` reads it) won, so the title is decided. It reads as the void it is, keyed on
  // the reset's ext_key (a row written before the `conditional` flag holds conditional=false). Owed - the other side won the
  // grand final - or not yet knowable (the grand final still open): it stays what it is, and holds completion.
  const grandFinal = bracketFixtures.find((bf) => rowOf.get(bf.id)!.ext_key === GRAND_FINAL_KEY);
  if (grandFinal !== undefined && SETTLED_FIXTURE_STATUSES.has(grandFinal.status) && grandFinal.winner !== undefined && grandFinal.winner === rowOf.get(grandFinal.id)!.home_entrant_id) {
    for (const bf of bracketFixtures) {
      const row = rowOf.get(bf.id)!;
      if (row.ext_key === BRACKET_RESET_KEY && row.outcome === null && bf.status === "scheduled") bf.status = "void";
    }
  }
  return { bracketStage, bracketFixtures };
}

/** D-G1: entrants still in the field who neither lost a settled line nor won a final. `bracketRanks` would rank them LAST:
 *  an unbeaten field entrant who won no final means the deciding game decided nobody. */
export function unbeatenWithNoTitle(inputs: StageInputs, bracketFixtures: readonly BracketFixture[]): string[] {
  const lost = new Set<string>();
  const finalWinners = new Set<string>();
  for (const bf of bracketFixtures) {
    if (!SETTLED_FIXTURE_STATUSES.has(bf.status)) continue;
    if (bf.loser !== undefined) lost.add(bf.loser);
    // PF-5 (X-DW-2): both entrants of a double walkover are out, beaten by absence.
    if (bf.walkedOver === "both") for (const id of [bf.home, bf.away]) if (id !== undefined) lost.add(id);
    if (bf.isFinal === true && bf.winner !== undefined) finalWinners.add(bf.winner);
    // W4 T12 (X-CH-4): a final ruled joint crowns BOTH seats - otherwise the unbeaten pair would read as "decided nobody".
    if (bf.isFinal === true && bf.jointWinners === true) for (const id of [bf.home, bf.away]) if (id !== undefined) finalWinners.add(id);
  }
  return inputs.entrants.filter((id) => inputs.field.has(id) && !lost.has(id) && !finalWinners.has(id));
}

/** W4 T14 (X-QM-4): is this bracket decided right now? A stage's `status` never goes back from `complete` (nothing reopens
 *  one), so a completed knockout whose final an organiser has voided still READS complete while it holds no result. Its
 *  stored ranks are then the OLD ones, and a proposal read from them would seat a cut nobody can vouch for: the seeding path
 *  asks this as well as the status (stage-seeding.ts `sourcesToTables`). */
export async function bracketStageIsDecided(tx: Tx, stageId: string): Promise<boolean> {
  const inputs = await loadStageInputs(tx, stageId);
  if (!isBracketKind(inputs.kind)) throw new Error(`bracketStageIsDecided: stage ${stageId} is a ${inputs.kind}, not a bracket`);
  const { bracketStage, bracketFixtures } = await readBracketStage(tx, inputs, stageId);
  return isBracketStageComplete(bracketStage, bracketFixtures);
}

/**
 * W4 T14 (FX-G16, X-QM-4): a correction inside a COMPLETED knockout rewrites its stored ranks. A table stage re-folds on
 * every decision (`recomputeStandings`, usecases/scoring.ts); a bracket wrote its placement snapshot once, at completion,
 * and `completeStageIfReady` is a no-op from then on — so a corrected result moved the bracket and never the ranks every
 * reader of the stage takes (the seed proposal, the lucky-loser cut, the public final placings).
 *
 * Writes only when the bracket is decided again (mid-correction its old ranks stand until the replay ends, and the seeding
 * path refuses to read them, `bracketStageIsDecided`) and only when the ranks moved. The same computation as Complete's, and
 * the same D-G1 refusal: never a snapshot with a champion last. Knockout only — the kinds W4 owns; `stage_completed` in the
 * division's events stays what it was, the fact of that completion. Returns whether the stored ranks moved.
 */
export async function refreshCompletedBracketPlacement(orgId: string, stageId: string): Promise<boolean> {
  return withTenant(orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${stageId}`;
    if (!stage) throw new EngineError("STAGE_NOT_READY", `stage ${stageId} not found`, { stageId });
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    return refreshCompletedBracketPlacementTx(tx, stageId);
  });
}

/** `refreshCompletedBracketPlacement` inside a caller's transaction, which already holds the division's advisory lock
 *  (B5a T11: a Reinstate that reverses a vacant title rewrites the snapshot in the SAME transaction as the reversal). */
export async function refreshCompletedBracketPlacementTx(tx: Tx, stageId: string): Promise<boolean> {
  const inputs = await loadStageInputs(tx, stageId);
  if (inputs.stage.status !== "complete" || inputs.kind !== "knockout") return false;
  const { bracketStage, bracketFixtures } = await readBracketStage(tx, inputs, stageId);
  if (!isBracketStageComplete(bracketStage, bracketFixtures)) return false;
  if (unbeatenWithNoTitle(inputs, bracketFixtures).length > 0) return false;
  const rows = placementTable(completeBracketStage(bracketStage, bracketFixtures).finalRanks).rows;
  const [stored] = await tx<{ rows: readonly StandingsRow[] }[]>`
    select rows from standings_snapshots where stage_id = ${stageId} and pool_id is null`;
  const ranksOf = (list: readonly StandingsRow[]) => JSON.stringify(list.map((r) => [r.entrantId, r.rank]));
  if (stored !== undefined && ranksOf(stored.rows) === ranksOf(rows)) return false;
  await writeSnapshot(tx, stageId, null, rows, inputs.division.seq, "roster");
  return true;
}
