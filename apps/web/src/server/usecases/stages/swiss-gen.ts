import "server-only";
// Swiss pairing: the rounds judgement and refusals, the history fold, the colour
// and round-one draw order, and `swissGen` (shells, Pair next, byes).

import { SWISS_ABANDONED_BOARDS_REASON } from "@/lib/swiss-abandoned-refusal";
import { applyRoundOneColourLot, swissColourLot, swissDrawSeed, swissDrawnFieldOrder, swissRoundOneOrder } from "@/lib/swiss-draw";
import { HttpError } from "@/lib/errors";
import { isChessSport } from "@/lib/chess-individual-only";
import { swissRefusal } from "../swiss-refusal";
import { stageGraphSizeGate } from "@/lib/format-size-gates";
import { knockoutRefusal } from "../knockout-refusal";
import { judgeSwissRounds, swissRoundsGuidance, type SwissRoundsJudgement, type SwissRoundsShrunk } from "@/lib/swiss-rounds";
import { isRootSwissStage } from "@/lib/open-entry-stages";
import { EngineError, type MatchOutcome } from "@seazn/engine/core";
import { pairRound, pairKey, type SwissStanding, type Colour } from "@seazn/engine/scheduling";
import { forfeitShaped, isUnplayedForfeit } from "@seazn/engine/competition";
import { resolveFixtureCfg, resolveModule } from "@/server/engine-db";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { maxRoundPoints } from "@/server/engine-db/swiss-max-round-points";
// L3/#414 pass 3 — not re-exported through the engine-db barrel (index.ts),
// but these two ARE exported from the module itself (pass 2); reuse them
// rather than re-deriving lane/thirdPlace from round/position (never
// arithmetic — see parseExtKey's own comment).
import { rankedStageStandings, stageTablePoints } from "@/server/engine-db/competition";
import { forfeitPlayedFacts, playedFor } from "@/server/engine-db/forfeit-played";
import { isSwissBoardSeated, isSwissByeShellExtKey, latestSeatedSwissRound, nextUnseatedSwissRound, planSwissShells } from "@/lib/swiss-shell";
import { inSwissRoundField, swissFirstRoundIn } from "@/lib/swiss-late-entry";
import { type SwissPairingMode, storedSwissPairing, effectiveSwissPairing, SWISS_PAIRING_ROUND_ONE_ONLY_CODE, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE } from "@/lib/swiss-pairing";
import { byeAward, isOneSidedAwardBye } from "@/lib/fixture-bye";
import { BYE_SLOT_LABEL } from "@/lib/bye-line";
import type { Tx, ActiveEntrant, SwissExistingFixture, SwissGenResult } from "./types";
import { divisionHasStarted } from "./helpers";
import { NO_SWISS_RESHAPE, addSwissReshape, reconcileSwissRoundShells } from "./swiss-reconcile";

/** A board whose result is in (W3 T9 reads it too: a late player's "current round" is the one with a board not in it). */
export const DECIDED: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

/**
 * W3 T11 (SW-H2, RB3-3; rule X-SW-16): a Swiss's round count against the field paired NOW — rulebook-W3-swiss.md §3.1
 * ("n = active field at the time of pairing") and §3.2 ("Above the hard maximum: refused … check runs … again at Start and
 * at every Generate (the field can shrink after creation)"). Refused with SWISS_ROUNDS_ABOVE_MAX `{ rounds, field,
 * hardMax, canFinish }` before any write; the judgement otherwise. `canFinish`: a round is complete, so the Swiss can be
 * finished after it (T13) — the refusal is then resolvable another way, a 409; else it can never succeed as sent, a 422.
 */
export function judgeSwissRoundsAt(rounds: number, fieldSize: number, canFinish: boolean): SwissRoundsJudgement {
  const judgement = judgeSwissRounds(rounds, fieldSize);
  if (judgement.verdict === "refuse") {
    throw swissRefusal(
      "SWISS_ROUNDS_ABOVE_MAX",
      { rounds, field: fieldSize, hardMax: judgement.hardMax, canFinish },
      { resolvable: canFinish },
    );
  }
  return judgement;
}

/**
 * W3 T11 fix round 1 — a Pair's judgement (controller ruling on review m2: never block a pairable round). Within the hard
 * maximum it is the plain judgement (ok or warn). Above it:
 * - before Start, the count as sent can never be played — Start refuses it too — and the organiser can still change it:
 *   refused as sent (422, `canFinish: false`, `judgeSwissRoundsAt`);
 * - in a running Swiss (withdrawals shrank the field), only a round this field cannot reach is refused: `target >
 *   hardMax` (409 when the Swiss can be finished now). A round still within the shrunk field's hard maximum is paired,
 *   and the answer carries the `shrunk` warning: the Swiss can reach at most `hardMax` rounds; finish after that one, or
 *   now. Blocking it would strand a live event over rounds it has not reached; the engine's own no-legal-pairing outcome
 *   (SW-H1) stays the backstop.
 * `finish` (W3 T13, C11 applied to Finish): THE Finish predicate's answer (`swissFinishState`), read by the caller only
 * when a running Swiss's count is above the field's hard maximum — the one case its `canFinish` is sent. Before T13 this
 * was `target > 1` (re-review n1: a round-1 Pair has nothing played to finish with — the predicate's own k = 0 case).
 */
export function judgeSwissPairAt(
  rounds: number,
  fieldSize: number,
  started: boolean,
  target: number,
  finish: { canFinish: boolean; finish?: { after: number; rounds: number } },
): SwissRoundsJudgement | SwissRoundsShrunk {
  const judgement = judgeSwissRounds(rounds, fieldSize);
  if (judgement.verdict !== "refuse") return judgement;
  if (!started) return judgeSwissRoundsAt(rounds, fieldSize, false);
  if (target > judgement.hardMax) {
    throw swissRefusal(
      "SWISS_ROUNDS_ABOVE_MAX",
      { rounds, field: fieldSize, hardMax: judgement.hardMax, ...finish },
      { resolvable: finish.canFinish },
    );
  }
  const { recommended, safeMax, hardMax } = judgement;
  return { verdict: "shrunk", rounds, field: fieldSize, recommended, safeMax, hardMax, canFinish: finish.canFinish };
}

/**
 * W4 T15 (FX-G14's gate half, QM-2; X-PL-1, X-QM-5): a format the division's field cannot play is refused up front and by name,
 * off the stored stage graph, so an API-built division is gated too. Before this a qualifying draw of three played its whole
 * qualifying stage and only then failed at Complete. Asked at the doors that draw the root: Start, Generate and Rebuild. The field
 * is the division's active entrants, as the generator reads them (`swissActiveEntrants`).
 */
export async function refuseFormatTooSmall(tx: Tx, divisionId: string): Promise<void> {
  const stages = await tx<{ id: string; kind: string; progression: unknown }[]>`
    select id, kind, progression from stages where division_id = ${divisionId} order by seq`;
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from entrants where division_id = ${divisionId} and status in ('registered', 'confirmed')`;
  const gate = stageGraphSizeGate(stages, n);
  if (gate !== null) throw knockoutRefusal(gate.code, { min: gate.min });
}

/**
 * W3 T11 (X-SW-16; rulebook §3.2 "check runs … again at Start"): Start judges every ROOT Swiss of the division
 * (`isRootSwissStage` — a Swiss fed by an earlier stage has no field until that stage ends, and its own Generate judges it)
 * against the field its next Pair would seat: the active roster at that round (`swissFieldForRound` over the per-stage
 * stamps), so a withdrawal after the shells were minted is caught here, before the division opens. Refused as sent (a
 * 422, `canFinish: false`: nothing is played before Start). A field under 2 is left to the Generate's own refusal, and a
 * Swiss with every round seated has nothing left to pair. Reads only — the caller runs it before its first write.
 */
export async function refuseSwissRoundsAboveMaxAtStart(tx: Tx, divisionId: string): Promise<void> {
  const stages = await tx<{ id: string; kind: string; progression: unknown; config: Record<string, unknown> }[]>`
    select id, kind, progression, config from stages where division_id = ${divisionId} and kind = 'swiss' order by seq`;
  for (const stage of stages.filter(isRootSwissStage)) {
    const rounds = stage.config.rounds;
    if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
      throw new EngineError("CONFIG_INVALID", "swiss stage requires config.rounds >= 1", { stageId: stage.id });
    }
    const existing = await tx<{ round_no: number; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown; ext_key: string | null }[]>`
      select round_no, home_entrant_id, away_entrant_id, outcome, ext_key from fixtures where stage_id = ${stage.id}`;
    const target = existing.length === 0 ? 1 : nextUnseatedSwissRound(existing);
    if (target === null) continue;
    const field = swissFieldForRound(await swissActiveEntrants(tx, divisionId, stage.id), target);
    if (field.length < 2) continue;
    judgeSwissRoundsAt(rounds, field.length, false);
  }
}

/**
 * W3 T6 (spec §4 "Scoring for the newcomer", ruling 251; rule X-SW-12): the field of Swiss round `target` — every entrant
 * whose first Swiss round is at or before it (null = from round 1). A latecomer given round 4 (case (c)) is not seated by
 * a Pair of round 3, nor by its re-Pair after an Undo. The order is kept: it is the seeding order the standings rank by.
 */
export function swissFieldForRound(entrants: ActiveEntrant[], target: number): ActiveEntrant[] {
  return entrants.filter((e) => inSwissRoundField(e.swiss_first_round, target));
}

/**
 * W3 T9 (V487; carry from T6): the division's active entrants as a Swiss stage reads them — `generateStageFixturesTx`'s
 * active select, with each first round scoped to `stageId` (`swissFirstRoundIn`: a stamp written by another Swiss stage
 * counts as from round 1 here). Late entry (`swiss-late-entry.ts`) re-pairs a round over the same list.
 */
export async function swissActiveEntrants(tx: Tx, divisionId: string, stageId: string): Promise<ActiveEntrant[]> {
  const rows = await tx<{ id: string; seed: number | null; swiss_first_round: number | null; swiss_first_round_stage_id: string | null }[]>`
    select id, seed, swiss_first_round, swiss_first_round_stage_id from entrants
    where division_id = ${divisionId} and status in ('registered', 'confirmed')
    order by seed nulls last, created_at, id`;
  return rows.map((e) => ({ id: e.id, seed: e.seed, swiss_first_round: swissFirstRoundIn(e, stageId) }));
}

/** Review m4: a Swiss round's field (`swissFieldForRound`) under 2 is refused exactly as generateStageFixturesTx refuses a
 *  roster under 2 — the same code, message and data, so every reader of that refusal reads this one too. Nothing is
 *  written first: both callers in `swissGen` throw before any reconcile or mint. */
export function refuseSwissFieldUnderTwo(stageId: string, fieldSize: number): void {
  if (fieldSize < 2) {
    throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", { stageId, entrants: fieldSize });
  }
}

/** The round history `pairRound` is handed (scheduling `SwissHistory`), in the shape `swissGen` builds it. It holds no SCORE:
 *  W3 app-B T5 (X-SW-19) moved the pairing score to the stage's own table points (`stageTablePoints`), so the history is
 *  who has met, in which colours, and who may no longer take the bye - never a second count of the points. */
export interface SwissHistoryState {
  /** `pairKey`s of every pair that has met. */
  played: Set<string>;
  /** Each player's colours in round order; a game nobody played holds none. */
  colours: Map<string, Colour[]>;
  /** Who may no longer take the pairing-allocated bye (P-A4). */
  byes: Set<string>;
}

/**
 * The history loop of `swissGen` (its award loop plus its implicit-bye loop), extracted by W3 T6 UNCHANGED except for one
 * rule: the implicit-bye loop bye-marks an entrant for round r only when r is at or after their first Swiss round. For a
 * stage where every first round is null it is the inline loop it replaced, row for row (colours and byes) — proven over
 * real seeded rows against a verbatim copy of that loop (swiss-late-field.test.ts). `swissGen` calls it; Task 7 changes its
 * `played` rule, keys the P-A4 bye bar on the same "unplayed" reading, and takes every forfeit out of colours as the
 * engine does (a pre-W2b chess win by forfeit included); Task 9 reads it for case (b)'s colours.
 *
 * W3 app-B T5 (X-SW-19) took the SCORE out of it: the loop used to add +1 per win, award or bye (and for every implicit
 * bye) and +½ per draw, a second authority for a number the published table pays by the stage's points rule - an IIHF
 * overtime win and a regulation win were both +1. The pairing score is the table's points now (`stageTablePoints`), so
 * the loops keep their other jobs: `played`, `colours`, `byes`, and which entrants sat each round (`inRound`). A legacy
 * implicit bye (no row, first round null) is therefore worth what the table gives it, 0, and still bars the bye (P-A4).
 *
 * `existing` is the stage's rows in ANY order: the colours are a sequence, so the function sorts its own copy into round
 * order (round_no, seq_in_round) rather than trusting its caller's ORDER BY. That precondition is enforced here, not stated
 * (review m1; T3 found a physical-order read handing a later-updated round back after a later round).
 * `entrants` is the field being paired (`swissFieldForRound`). `playedFacts` is fixture id → was anything played, for
 * every two-seated forfeit-decided row (`forfeitPlayedFacts` under the division's module): W3 T7's `played` rule and the
 * P-A4 bye bar read it, and a forfeit-decided row it does not cover is refused (`playedFor`), never guessed.
 */
export function buildSwissHistory(
  existing: readonly SwissExistingFixture[],
  entrants: readonly ActiveEntrant[],
  playedFacts: ReadonlyMap<string, boolean>,
): SwissHistoryState {
  // Round order is this function's own invariant (review m1): a copy, so the caller's array is untouched.
  const rows = [...existing].sort((a, b) => a.round_no - b.round_no || a.seq_in_round - b.seq_in_round);
  const played = new Set<string>();
  const colours = new Map<string, Colour[]>();
  const byes = new Set<string>();
  const inRound = new Map<number, Set<string>>();
  for (const f of rows) {
    const o = f.outcome as { kind?: string; winner?: string } | null;
    // Only a system bye — one seat, won by the seated side — is a bye. Every
    // sport kernel ALSO emits `{kind: "award"}` for a real two-sided walkover
    // or retirement, and that is a board, not a bye: it falls through, so both
    // sides sat the round (no implicit bye for the absent loser) and the winner
    // scores below. Case 3 of the 2026-09-24 Saturday probe: reading every
    // award as a bye re-paired A v H in round 2 on a phantom point for H.
    if (isOneSidedAwardBye(f) && o?.winner) {
      const forRound = inRound.get(f.round_no) ?? new Set<string>();
      forRound.add(o.winner);
      inRound.set(f.round_no, forRound);
      byes.add(o.winner);
      continue;
    }
    if (!f.home_entrant_id || !f.away_entrant_id) continue;
    // W3 T7 (X-SW-15; rulebook P-A2, FIDE C.04.2 3.5; RB3-2): a pair whose match was NOT PLAYED has not met, so the two
    // may be paired again — a double walkover, and a forfeit the engine's one rule calls unplayed (`isUnplayedForfeit`:
    // a walkover whatever its ledger reads, so a chess no-show after the Start too; any other reason only while nothing
    // was played, so a retirement after play is a meeting). Everything else seated is a meeting, as before.
    const unplayed =
      o?.kind === "double_walkover" || (o != null && isUnplayedForfeit(o as MatchOutcome, playedFor(f, playedFacts)));
    if (!unplayed) played.add(pairKey(f.home_entrant_id, f.away_entrant_id));
    const forRound = inRound.get(f.round_no) ?? new Set<string>();
    forRound.add(f.home_entrant_id).add(f.away_entrant_id);
    inRound.set(f.round_no, forRound);
    // A forfeit takes no colour, before or after play — as the engine reads it: boardgame's `colorOf` skips
    // `state.forfeited`, which every `core.forfeit` sets (W2b BG-WO-1/2, a retirement after play included) and so does
    // the pre-W2b `boardgame.result{forfeit}` (`decideResult`), whose stored row is a `win`, not an award. Loop R M-8:
    // a double walkover is a forfeit too. Rulebook R14 ("a retirement's colour counts") disagrees for a retirement;
    // that is the owner's call, and until then pairing colours stay the engine's, so they cannot drift from its
    // "Games as White/Black" and its colour tie-breaks.
    if (o?.kind !== "double_walkover" && !(o != null && forfeitShaped(o as MatchOutcome))) {
      (colours.get(f.home_entrant_id) ?? colours.set(f.home_entrant_id, []).get(f.home_entrant_id)!).push("W");
      (colours.get(f.away_entrant_id) ?? colours.set(f.away_entrant_id, []).get(f.away_entrant_id)!).push("B");
    }
    // FIDE C.04.1(d) (owner-approved 2026-09-24; rulebook P-A4): a player who has scored "a (forfeit) win due to an
    // opponent not appearing" may not later receive the pairing-allocated bye. `byes` feeds ONLY `pairRound`'s bye
    // pick, so this is eligibility and nothing else — no bye score (the win's points are the table's). Keyed on the same
    // `unplayed` as `played` above: a win WITHOUT play bars the bye (a walkover, a forfeit before play, a pre-W2b chess
    // win by forfeit with nothing played), while a retirement, withdrawal or disqualification won after play is a
    // played game and bars nothing.
    if (unplayed && o?.winner) byes.add(o.winner);
  }
  const latestSeated = latestSeatedSwissRound(rows);
  for (let r = 1; r <= (latestSeated ?? 0); r++) {
    const inRoundR = rows.filter((f) => f.round_no === r);
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
    // This round already carries an explicit bye row, so the award loop above
    // has marked whoever sat out; inferring a second one here would
    // double-mark. (C1: this used to fire for a two-sided forfeit as well,
    // which silently suppressed the implicit-bye inference for that round.)
    if (inRoundR.some((f) => isOneSidedAwardBye(f))) continue;
    const seen = inRound.get(r) ?? new Set();
    for (const e of entrants) {
      // W3 T6 (ruling 251; rulebook §4 late-entry row, FIDE C.04.2 2.4): a round before the entrant's first Swiss round
      // is a MISSED round — 0 points, and not a bye, so they stay bye-eligible (P-A4) — never an implicit bye. Null is
      // from round 1, so an entrant enrolled before Start is bye-marked exactly as before. W3 app-B T5 (X-SW-19): the
      // implicit bye no longer scores - the table gives a round with no row 0, and the pairing score is the table's.
      if (!seen.has(e.id) && (e.swiss_first_round ?? 1) <= r) {
        byes.add(e.id);
      }
    }
  }
  return { played, colours, byes };
}

/** W3 app-B T7 (X-SW-11, engine T4c re-review): whether an EARLIER round of this stage was paired with `finalRoundMaxScore`.
 *  The engine's topscorer exception is the stage's final round only; an "Add a round" after that round was paired would
 *  make a new last round, and paired under the exception again a non-topscorer can be barred from both colours (the
 *  engine's M3 guard throws CONFIG_INVALID). So the exception is sent at most once per stage.
 *
 *  The source is the ledger: every pass that sent it records `final_round_max_score` on its pairing row (`fixtures_generated`,
 *  a Redo's step row included, or a late-entry re-pair, `swiss_late_entry`). A round's NEWEST pairing row decides whether
 *  that round used it - so a final round paired with it, Unpaired, and re-paired once an added round made it a middle one
 *  has NOT spent it - and only a round before `target` counts: re-pairing the same final round (Unpair then Pair) is the
 *  same use, not a second one. An undone step is still a row, the direction that errs safe (the exception withheld means a
 *  refusal by name, never a throw). */
async function swissFinalMaxSentEarlier(tx: Tx, stageId: string, divisionId: string, target: number): Promise<boolean> {
  const rows = await tx<{ round: number; sent: boolean }[]>`
    select distinct on (payload->>'round') (payload->>'round')::int as round, payload ? 'final_round_max_score' as sent
      from division_events
     where division_id = ${divisionId} and payload->>'stage_id' = ${stageId} and payload ? 'round'
       and (type = 'fixtures_generated' or (type = 'swiss_late_entry' and payload->>'case' = 'a'))
     order by payload->>'round', seq desc`;
  return rows.some((r) => r.sent && r.round < target);
}

/** Review m7: round 1's drawn order for a later round. Round 1's field is the entrants round 1 SEATED, not today's active
 *  list: a withdrawal since would shrink the shuffle and reorder everyone. Null when round 1 drew nobody (every entrant
 *  seeded) or seats no one — and (ruling, fix round 1b) when round 1 was NOT paired by the draw: a stage live at deploy
 *  paired its round 1 in registration order, so its later rounds keep that order.
 *
 *  The source is round 1's newest pairing row on the ledger: its Pair (`fixtures_generated`, round 1; a Redo's step row
 *  included) or an "Add late player" that re-paired round 1 (`swiss_late_entry`, case (a), round 1 — it re-draws the
 *  field with the newcomer in it). W3 T9 (T8 review n1): that row records the drawn order itself (`draw_order`), which
 *  is read as written — a seed edited after Start, or a late player the bye seated in round 1 (case (b), never drawn),
 *  cannot reshuffle it. A row from before T9 carries only the marker `draw_seed` (never a date: every Pair of a drawn
 *  round 1 since T8 records it, and no Pair before T8 did); for it the order is re-derived as round 1's Pair drew it —
 *  the stage's seed over round 1's seated field, in the active select's `seed nulls last, created_at, id`. */
async function swissRoundOneDrawOrder(
  tx: Tx,
  stageId: string,
  divisionId: string,
  existing: readonly SwissExistingFixture[],
): Promise<string[] | null> {
  const seated = new Set(
    existing
      .filter((f) => f.round_no === 1)
      .flatMap((f) => [f.home_entrant_id, f.away_entrant_id])
      .filter((id): id is string => id !== null),
  );
  if (seated.size === 0) return null;
  const [roundOnePair] = await tx<{ drawn: boolean; order: unknown }[]>`
    select payload ? 'draw_seed' as drawn, payload->'draw_order' as order from division_events
     where division_id = ${divisionId} and payload->>'stage_id' = ${stageId} and payload->>'round' = '1'
       and (type = 'fixtures_generated' or (type = 'swiss_late_entry' and payload->>'case' = 'a'))
     order by seq desc limit 1`;
  const stored = roundOnePair?.order;
  if (Array.isArray(stored) && stored.length > 0 && stored.every((id) => typeof id === "string")) return stored as string[];
  if (roundOnePair?.drawn !== true) return null;
  const roundOne = await tx<{ id: string; seed: number | null }[]>`
    select id, seed from entrants where id in ${tx([...seated])} order by seed nulls last, created_at, id`;
  return roundOne.some((e) => e.seed === null) ? swissRoundOneOrder(swissDrawSeed(stageId), roundOne) : null;
}

/** UI5 fix round 1 (controller ruling I1; owner 2026-11-03: chess colours are always on in a chess Swiss): whether a Pair
 *  balances chess colours — THE one read, for `swissGen` and the late-entry bye check (`swiss-late-entry.ts`) alike.
 *  - Stored on → on (any sport, as it always was).
 *  - Any sport but chess → as stored (off).
 *  - A chess Swiss whose round 1 seats nobody yet → on, whatever is stored: a stage the old desk switch stored off pairs
 *    in colour from its first Pair. Read-side only: the stored value is never rewritten (no data migration).
 *  - A chess Swiss whose round 1 is paired keeps what round 1 was paired with: on when round 1's newest pairing row (its
 *    Pair, or an "Add late player" that re-paired it — the rows `swissRoundOneDrawOrder` reads) drew the colour lot, so
 *    a stage first paired under this rule stays coloured; otherwise the stored off — a stage already under way when the
 *    rule shipped does not change colours mid-event. */
export async function swissPairsInColour(
  tx: Tx,
  divisionId: string,
  stage: { id: string; config: Record<string, unknown> },
  sportKey: string,
  existing: readonly Pick<SwissExistingFixture, "round_no" | "home_entrant_id" | "away_entrant_id">[],
): Promise<boolean> {
  if (stage.config.chess === true) return true;
  if (!isChessSport(sportKey)) return false;
  const roundOnePaired = existing.some((f) => f.round_no === 1 && (f.home_entrant_id !== null || f.away_entrant_id !== null));
  if (!roundOnePaired) return true;
  const [roundOnePair] = await tx<{ coloured: boolean }[]>`
    select payload ? 'colour_lot' as coloured from division_events
     where division_id = ${divisionId} and payload->>'stage_id' = ${stage.id} and payload->>'round' = '1'
       and (type = 'fixtures_generated' or (type = 'swiss_late_entry' and payload->>'case' = 'a'))
     order by seq desc limit 1`;
  return roundOnePair?.coloured === true;
}

/** Whether a Pair in `pairing` mode ranks the stage's table (`rankedStageStandings`), which stores any lots draw a tie in
 *  that table needs: a rank-adjacent round once a seated board is decided. The ONE authority, read by `swissGen` and by
 *  the Match Day preview (`previewSwissNextRound`), which commits that draw before its rolled-back Pair so the approve
 *  pairs over the very draw the preview showed. */
export function swissPairRanksTable(pairing: SwissPairingMode, existing: readonly SwissExistingFixture[]): boolean {
  return pairing === "rank_adjacent" && existing.some((f) => isSwissBoardSeated(f) && DECIDED.has(f.status));
}

// Swiss shell fixtures (2026-09-18 programme): first Generate mints empty rows for
// every round the organiser declared in `config.rounds`; Pair next (a later
// Generate when shells already exist) seats one round at a time onto those
// shells. The organiser-set round budget is the only authority — nothing here
// derives or persists `rounds` from field size.
//
// W3 T6 (spec §4, ruling 251): `entrants` is the whole active list; each round
// is paired, sized and scored over its own field (`swissFieldForRound`), so a
// latecomer whose first round is later is not seated before it.
export async function swissGen(
  tx: Tx,
  stageId: string,
  divisionId: string,
  cfg: Record<string, unknown>,
  entrants: ActiveEntrant[],
  existing: SwissExistingFixture[],
  /** A round-1-only pairing override from the Generate body. Every refusal of
   *  it below runs before this function's first write. */
  override?: SwissPairingMode,
): Promise<SwissGenResult> {
  const rounds = cfg.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1) {
    throw new EngineError("CONFIG_INVALID", "swiss stage requires config.rounds >= 1", { stageId });
  }

  if (existing.length === 0) {
    // This press only mints empty shells and seats nobody, so an override
    // could not take effect — refuse it rather than swallow it.
    if (override !== undefined) {
      throw new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE);
    }
    // Minted at round 1's field; every later round is resized to its own field when its Pair reaches it.
    const mintField = swissFieldForRound(entrants, 1);
    refuseSwissFieldUnderTwo(stageId, mintField.length);
    // W3 T11 (X-SW-16): the mint is a Generate — nothing is played yet, so nothing can be finished.
    const swissRounds = judgeSwissRoundsAt(rounds, mintField.length, false);
    return {
      gen: planSwissShells(rounds, mintField.length).map((shell) => ({
        extKey: shell.extKey,
        roundNo: shell.roundNo,
        seqInRound: shell.seqInRound,
        home: null,
        away: null,
      })),
      seatedCount: 0,
      reshaped: NO_SWISS_RESHAPE,
      pairing: null,
      defaultPairing: null,
      round: null,
      seatedIds: [],
      drawSeed: null,
      drawOrder: null,
      colourLot: null,
      swissRounds,
      nextRound: null,
      finalRoundMaxScore: null,
    };
  }

  const target = nextUnseatedSwissRound(existing);
  if (target === null) {
    if (override !== undefined) {
      throw new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE);
    }
    return {
      gen: [],
      seatedCount: 0,
      reshaped: NO_SWISS_RESHAPE,
      pairing: null,
      defaultPairing: null,
      round: null,
      seatedIds: [],
      drawSeed: null,
      drawOrder: null,
      colourLot: null,
      swissRounds: null,
      nextRound: null,
      finalRoundMaxScore: null,
    };
  }

  // The round NUMBER, never "a decided board exists": on an odd field the bye
  // is minted `forfeited` with its award at seat time, and an ad-hoc fixture
  // can sit at `maxRound + 1` fully seated — either would read as "round 1 is
  // over" while round 1 is still the one being paired.
  if (override !== undefined && target !== 1) {
    throw new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE);
  }

  if (target > 1) {
    const seatedPrev = existing.filter(
      (f) =>
        f.round_no === target - 1 &&
        isSwissBoardSeated({
          home_entrant_id: f.home_entrant_id,
          away_entrant_id: f.away_entrant_id,
          outcome: f.outcome,
        }),
    );
    const undecided = seatedPrev.filter((f) => !DECIDED.has(f.status));
    if (undecided.length > 0) {
      // W2c P-7 / X-AB-5: an abandoned board holds the round until the organiser settles it (it is deliberately NOT in
      // DECIDED), and the refusal names it so the organiser knows which board to settle.
      const abandoned = undecided
        .filter((f) => f.status === "abandoned")
        .sort((x, y) => x.seq_in_round - y.seq_in_round)
        .map((f) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round }));
      const named = abandoned.map((b) => `round ${b.round} board ${b.board}`).join(", ");
      throw new EngineError(
        "STAGE_NOT_READY",
        abandoned.length === 0
          ? "current swiss round has undecided fixtures"
          : `current swiss round has undecided fixtures - settle the abandoned ${abandoned.length === 1 ? "board" : "boards"} first: ${named}`,
        // `reason` rides with the boards so the wire (api-v1/http.ts) and the desk (generatePreconditionMessage) can
        // name them in the reader's language; a refusal with no abandoned board keeps the bare shape.
        { stageId, ...(abandoned.length === 0 ? {} : { reason: SWISS_ABANDONED_BOARDS_REASON, abandoned }) },
      );
    }
  }

  // Round 1 pairs top-vs-bottom unless overridden: before any result the only
  // rank is the seed, so rank-adjacent would pair seed 1 with seed 2 (spec
  // 2026-09-22). `effectiveSwissPairing` is the one authority, shared with the
  // desk. `cascadeRank` below keys off the EFFECTIVE mode through `rankAdjacent`.
  const stored = storedSwissPairing(cfg);
  const defaultPairing = effectiveSwissPairing({ stored, round: target });
  const pairing = effectiveSwissPairing({ override, stored, round: target });
  const rankAdjacent = pairing === "rank_adjacent";
  // W3 T6 (X-SW-12): this round's field — a latecomer whose first round is later is neither seated, sized for, nor
  // scored here. Everything below that reads the field reads THIS list.
  const field = swissFieldForRound(entrants, target);
  // Review m4: the roster passed generateStageFixturesTx's `< 2` guard, but this round's field can be smaller (withdrawals
  // plus latecomers whose first round is later). Refused here, before the reconcile below would size the round to 0 or 1
  // and delete its unseated shells.
  refuseSwissFieldUnderTwo(stageId, field.length);
  // W3 T11 (X-SW-16): this round's field against the round count, before any write — withdrawals since the last Generate
  // can have shrunk it under the rounds. Fix round 1 (ruling on review m2): a running Swiss refuses only a round its
  // field cannot reach; see `judgeSwissPairAt`.
  const started = await divisionHasStarted(tx, divisionId);
  // W3 T13: THE Finish predicate, read only when its answer is sent (a running Swiss above the field's hard maximum).
  // Imported lazily: swiss-rounds-admin.ts imports this module.
  let finish: Parameters<typeof judgeSwissPairAt>[4] = { canFinish: false };
  if (started && judgeSwissRounds(rounds, field.length).verdict === "refuse") {
    const admin = await import("../swiss-rounds-admin");
    finish = admin.swissFinishDetails(await admin.swissFinishStateOf(tx, stageId));
  }
  const swissRounds = judgeSwissPairAt(rounds, field.length, started, target, finish);
  // The division's pinned module: the bye's frozen cfg below, and what "played" means for a forfeit (ruling 118).
  const [division] = await tx<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${divisionId}`;
  if (!division) throw new EngineError("CONFIG_INVALID", "swiss: division missing", { stageId, divisionId });
  const sportModule = resolveModule(division.sport_key, division.module_version);
  // W3 T7 (X-SW-15): each two-seated forfeit's "was anything played", from its ledger, read in THIS transaction (a
  // history step's Redo runs here too) — one query for the stage, and none when no board was decided by a forfeit.
  const playedFacts = await forfeitPlayedFacts(
    tx,
    existing.filter((f) => f.home_entrant_id !== null && f.away_entrant_id !== null),
    sportModule,
  );
  const { played, colours, byes } = buildSwissHistory(existing, field, playedFacts);
  // W3 app-B T5 (SW-M11; X-SW-19; RB3-9): the pairing score IS the stage's table points - the same inputs and the same
  // engine fold the published table is read from (`stageTablePoints`), so the score groups, the table and the tie-breaks read
  // one number (rulebook §5, last paragraph). Not a count of this loop's own (+1 a win, +½ a draw): that parted from the
  // table on an IIHF overtime win (3 / 2 / 1 / 0), chess's half-points (2 / 1), a `bySetScore` map and a pinned or custom
  // rule. An entrant the table does not list yet scores 0. Read-only: the call stores no lots draw (points do not depend on
  // the order a tie is broken in), and it runs under the division lock this Generate holds.
  // `rule` is the very points rule that paid those scores (the pin once the stage started): the final-round maximum below
  // (app-B T7) is measured under it, so the topscorer line and the scores it is compared with are in one unit.
  const { points, rule } = await stageTablePoints(tx, stageId);
  const score = new Map(field.map((e) => [e.id, points.get(e.id) ?? 0]));

  const cascadeRank = new Map<string, number>();
  if (swissPairRanksTable(pairing, existing)) {
    const rows = await rankedStageStandings(tx, stageId);
    for (const [i, row] of rows.entries()) {
      cascadeRank.set(row.entrantId, row.rank ?? i + 1);
    }
  }
  // W3 T8 (X-SW-22; SW-L6, REC RB3-16): an unseeded entrant's pairing number is its place in the stage's seeded random
  // draw, not registration order (the active select's `created_at, id`, an accident of who signed up when). Seeded
  // entrants keep their seed order ahead of it (`seedRank`). The seed is the stage's own id, so every Pair of round 1 —
  // Unpair then Pair, an Undo then Redo through the step path — draws the same order, and it rides on the ledger row
  // (`draw_seed`). A field with nobody unseeded is not drawn.
  // Review m7 (ruling: persist the drawn order): FIDE fixes pairing numbers from the initial ranking, so every LATER
  // round ranks a tie inside a score group by round 1's draw too, re-derived each Pair from the seed and round 1's field
  // (`swissRoundOneDrawOrder`; no column). A latecomer was never drawn and follows the drawn field in arrival order.
  const drawOrder =
    target === 1
      ? field.some((e) => e.seed === null)
        ? swissRoundOneOrder(swissDrawSeed(stageId), field)
        : null
      : await swissRoundOneDrawOrder(tx, stageId, divisionId, existing);
  const drawSeed = target === 1 && drawOrder !== null ? swissDrawSeed(stageId) : null;
  const ranked = drawOrder === null ? field : swissDrawnFieldOrder(drawOrder, field);
  const seedRank = (e: ActiveEntrant, i: number): number => e.seed ?? 1000 + i;
  const standings: SwissStanding[] = ranked.map((e, i) => ({
    entrantId: e.id,
    score: score.get(e.id) ?? 0,
    rank: cascadeRank.get(e.id) ?? cascadeRank.size + seedRank(e, i),
  }));
  const chess = await swissPairsInColour(tx, divisionId, { id: stageId, config: cfg }, division.sport_key, existing);
  // W3 app-B T7 (X-SW-10; rulebook-W3-swiss.md §3.3 "Prevention", RB3-4): above the safe maximum ⌊n/2⌋ of THIS round's field a
  // round can seat boards that leave the next one with no legal pairing. The engine then prefers a seating after which the
  // next round can still be paired, and reports whether it is (`nextRound`). Never on the last round: no next round to protect,
  // and set there it would move boards and warn for a round that never comes (engine `SwissConstraints.lookAhead`).
  const lookAhead = target < rounds && rounds > swissRoundsGuidance(field.length).safeMax;
  // W3 app-B T7 (X-SW-11; RB3-10; FIDE C.04.3 Art. 1.8): the final round's topscorer line - (rounds − 1) × the most ONE fixture
  // pays one side under this stage's own points rule, in the table points the score above is measured in. The maximum goes
  // through the engine's `payout` (`maxRoundPoints`), never a hand formula, so a bonus the table pays is counted. Three
  // guards, each load-bearing:
  //  - chess colours on: outside chess there is no colour limit to lift;
  //  - `rounds > 1`: a one-round Swiss would send (1 − 1) × win = 0, which the engine refuses (CONFIG_INVALID);
  //  - ONCE per stage: "Add a round" after the final round was paired makes a NEW last round, and an exemption used on two
  //    rounds can bar a non-topscorer from both colours - the engine's own M3 guard throws CONFIG_INVALID. Read from the
  //    ledger (`swissFinalMaxSentEarlier`), the way round 1's draw order is.
  // A maximum of 0 (a pinned rule whose win pays nothing) is never sent either: the engine refuses it, and nobody could be
  // a topscorer of a table that pays nothing.
  let finalMax: number | undefined;
  if (chess && target === rounds && rounds > 1 && !(await swissFinalMaxSentEarlier(tx, stageId, divisionId, target))) {
    const most = maxRoundPoints(rule, sportModule, liveCfg(division.config, { kind: "swiss", config: cfg }, sportModule));
    if (most > 0) finalMax = (rounds - 1) * most;
  }
  const paired = pairRound(
    standings,
    { played, colours, byes },
    {
      chess,
      ...(rankAdjacent ? { pairing: "rank_adjacent" as const } : {}),
      ...(lookAhead ? { lookAhead: true } : {}),
      ...(finalMax !== undefined ? { finalRoundMaxScore: finalMax } : {}),
    },
  );
  // W3 app-B T1 (X-SW-3; rulebook-W3 §3.1, P-A1/P-A6; engine 2.0.0): a round with no legal pairing is REFUSED, not seated
  // empty. Engine 1.x answered with an empty round, so Pair next read "up to date" for a round that could not be played.
  // This throws BEFORE the reshape and the seats. The one write above it is a rank_adjacent round's lots draw
  // (`rankedStageStandings` stores any draw its ranking makes, `persistLotsDraws`); the whole Generate is one transaction,
  // so the throw rolls that draw back with the rest and the press — shells, events, seats, draws — stays as it was (final
  // review m3). Keep the refusal inside that transaction: caught, or moved outside it, it would leave the draw stored.
  // `field_too_small` cannot reach here: `refuseSwissFieldUnderTwo` above refuses a round's field under two first
  // (STAGE_NOT_READY), so the reason is one of the four a field of two or more can have. The status is the table's: 409
  // when Finish is the way out (`swissFinishDetails` — the same predicate every `canFinish` the server sends reads), else
  // 422.
  // W3 app-B T4 (SW-H1 on the desk): the body carries the recovery the desk offers — `canFinish`, THE Finish predicate's
  // answer (the same one `swissFinishDetails` reads for every other emitter, so an offered Finish always goes through), and
  // `finishAfter` k, READ FROM THE SAME STATE `finishSwissNow` ends the Swiss at (`state.finishedAfter`: the latest round
  // whose seated boards are all decided), so "Finish after round k" names the round the Finish route will actually keep.
  // Not `target - 1`: that is only the same number while the round before this one is the latest decided (the
  // STAGE_NOT_READY check above guards that round), and a second authority for k is a number that can drift from the route's.
  // The five fields are copied BY NAME: the engine's `SwissRefusal` object is never spread into the body, so nothing it
  // carries (entrant ids, history) can reach the wire.
  if (!paired.ok) {
    const admin = await import("../swiss-rounds-admin");
    const finishState = await admin.swissFinishStateOf(tx, stageId);
    const finishNow = admin.swissFinishDetails(finishState);
    throw swissRefusal(
      "SWISS_NO_LEGAL_PAIRING",
      { round: target, reason: paired.reason, field: paired.field, finishAfter: finishState.finishedAfter, canFinish: finishNow.canFinish },
      { resolvable: finishNow.canFinish },
    );
  }
  // W3 T8 (BG-SW-1; SW-H3, REC RB3-10): with chess colours on, round 1's colours are by lot (FIDE C.04.3 A3 5.1): board
  // 1's upper player takes the lot's colour and the boards alternate. Swapped HERE, before the seats are written, so the
  // stored fixtures carry it (home = White) and round 2's colour history reads it. Whether colours are on is
  // `swissPairsInColour` (UI5 fix round 1, ruling I1): a chess Swiss not yet paired is always coloured.
  // A round 1 always holds a board: `refuseSwissFieldUnderTwo` (above) refuses THIS round's field — the T6-narrowed one,
  // not the roster — under two (STAGE_NOT_READY) before this runs, and two or more with no history always pair.
  const colourLot = target === 1 && chess ? swissColourLot(swissDrawSeed(stageId)) : null;
  if (colourLot !== null) {
    // The lot's premise: the engine hands round 1 over with the upper player at home (scheduling/swiss.ts: neutral
    // colours put the upper board on White). If it ever does not, the lot would colour the wrong player — refuse, by
    // name, before anything is written.
    const place = new Map(
      [...standings]
        .sort((a, b) => b.score - a.score || a.rank - b.rank || (a.entrantId < b.entrantId ? -1 : 1))
        .map((s, i) => [s.entrantId, i]),
    );
    const lowerHome = paired.pairings.findIndex((p) => place.get(p.home)! > place.get(p.away)!);
    if (lowerHome !== -1) {
      throw new EngineError(
        "CONFIG_INVALID",
        `swiss round 1: board ${lowerHome + 1} came back with the lower-ranked player at home, so the colour lot cannot be applied`,
        { stageId, board: lowerHome + 1 },
      );
    }
  }
  const round = colourLot === null ? paired : { ...paired, pairings: applyRoundOneColourLot(paired.pairings, colourLot) };

  // The shells were minted for the field as it was; a withdrawal (or, before
  // Start, an enrolment or a deletion) since then has resized it. Bring the
  // rounds that need it into line before anyone is seated — see
  // reconcileSwissRoundShells for the per-round guards and the reconcile-vs-
  // recreate reasoning.
  //
  // SCOPE turns on whether the division has STARTED (owner ruling 2026-09-22,
  // closing the half of Open question 1 the design doc left open). Before
  // Start an organiser lays out courts and times for EVERY round up front, so
  // every unseated round has to match the current field: one still minted for
  // the old field has no board to hang a new player on and cannot be scheduled
  // at all. That was the production defect — round 1 re-paired correctly after
  // Unpair → Pair next while rounds 2 and 3 kept the old field's shells.
  // After Start the scope stays LAZY, only the round being paired: there is no
  // reason to widen a destructive write mid-event, and a later round's shell
  // count is cosmetic until its own Pair reaches it.
  const eager = !(await divisionHasStarted(tx, divisionId));
  // The asymmetry that keeps the wider scope from widening the REFUSAL surface.
  // The reconcile has THREE guards — seated, `swissRoundHasPlayedResult`, and
  // the canonical `fixtureEvidenceSql` — and every one of them fires on a later
  // round just as readily as on the target. `target` gets `"refuse"`: it is the
  // round the organiser pressed Pair next on. The rounds the eager pass sweeps
  // up get `"skip"`, so one of them being unreshapeable leaves it stale instead
  // of aborting the Generate and taking round 1's pairing with it. See
  // `SwissReconcileBlockedPolicy` for the full reasoning.
  //
  // This is also what absorbed the ad-hoc case: `addFixture` used to put a
  // swiss fixture at `maxRound + 1` seated on both sides (Task 2.3), so a
  // 3-round stage could hold a fully seated round 4. W3 refuses that now
  // (SWISS_ADHOC_REFUSED), but a LEGACY row of that shape still trips the
  // seated guard and is skipped, rather than needing a filter of its own here
  // — one mechanism, so neither can quietly cover for the other.
  const laterRounds = eager
    ? [...new Set(existing.map((f) => f.round_no))].filter((r) => r > target).sort((a, b) => a - b)
    : [];
  const targetReconcile = await reconcileSwissRoundShells(
    tx,
    stageId,
    divisionId,
    target,
    existing,
    field.length,
    "refuse",
  );
  // Summed across every round this pass touched, so the organiser is told what
  // the whole press did rather than what its last round did. A round that
  // early-returned or was skipped contributes zeroes, which is what keeps the
  // ordinary Pair silent.
  let reshaped = targetReconcile.delta;
  for (const roundNo of laterRounds) {
    const later = await reconcileSwissRoundShells(
      tx,
      stageId,
      divisionId,
      roundNo,
      existing,
      // Each later round to ITS field (W3 T6): a latecomer whose first round is still ahead counts there, not here.
      swissFieldForRound(entrants, roundNo).length,
      "skip",
    );
    reshaped = addSwissReshape(reshaped, later.delta);
  }
  const roundShells = targetReconcile.shells;
  const boardShells = roundShells.filter((f) => !isSwissByeShellExtKey(f.ext_key));
  const byeShell = roundShells.find((f) => isSwissByeShellExtKey(f.ext_key));

  let seatedCount = 0;
  const seatedIds: string[] = [];
  for (let i = 0; i < round.pairings.length; i++) {
    const p = round.pairings[i]!;
    const shell = boardShells[i];
    if (!shell) {
      throw new EngineError("CONFIG_INVALID", "swiss shell count mismatch for pairing", { stageId, target });
    }
    const seated = await tx<{ id: string }[]>`
      update fixtures set
        home_entrant_id = ${p.home},
        away_entrant_id = ${p.away},
        status = 'scheduled',
        outcome = null,
        home_slot_label = null,
        away_slot_label = null
      where id = ${shell.id}
      returning id`;
    for (const row of seated) seatedIds.push(row.id);
    seatedCount++;
  }
  if (round.bye !== undefined) {
    if (!byeShell) {
      throw new EngineError("CONFIG_INVALID", "swiss bye shell missing for pairing", { stageId, target });
    }
    // W3 T3 (SW-M7, X-SW-5; RB3-7(a)'s app half): the bye's value is frozen at AWARD. The cfg is exactly what
    // append-event.ts freezes at a match's first event — `resolveFixtureCfg` over the division, this stage and the
    // shell's own override, at the division's pinned module — the division read above (W3 T7 hoisted it to serve the
    // played facts too), under the `division:` lock the caller holds, which every format save takes before its
    // `division-config:` one, so no save lands between that read and this write. Like append-event, a null cfg
    // freezes nothing. The snapshot is not PLAY: `systemByeSql` exempts it in `fixtureEvidenceSql` and `playedSql`,
    // so Unpair, Rebuild, Undo and the format locks read the bye as before.
    // And a bye is not played, so it takes no slot (SW-M13, X-SW-29): time, court, venue and pin go (`holdsSlot`).
    const [shellCfg] = await tx<{ rules_override: unknown }[]>`select rules_override from fixtures where id = ${byeShell.id}`;
    // "stored": the form append-event.ts freezes (fixture-cfg.ts), never the fold's defaults-filled one.
    const frozen = resolveFixtureCfg(
      { config_snapshot: null, rules_override: shellCfg?.rules_override ?? null },
      division.config,
      { kind: "swiss", config: cfg },
      sportModule,
      "stored",
    );
    const seated = await tx<{ id: string }[]>`
      update fixtures set
        home_entrant_id = ${round.bye},
        away_entrant_id = null,
        status = 'forfeited',
        outcome = ${tx.json(byeAward(round.bye) as never)},
        home_slot_label = null,
        away_slot_label = ${tx.json(BYE_SLOT_LABEL as never)},
        config_snapshot = ${frozen == null ? null : tx.json(frozen as never)},
        config_snapshot_at = ${frozen == null ? null : tx`now()`},
        scheduled_at = null,
        court_id = null,
        venue_id = null,
        schedule_locked = false
      where id = ${byeShell.id}
      returning id`;
    for (const row of seated) seatedIds.push(row.id);
    seatedCount++;
  }

  return {
    gen: [],
    seatedCount,
    reshaped,
    pairing,
    defaultPairing,
    round: target,
    seatedIds,
    drawSeed,
    drawOrder: target === 1 ? drawOrder : null,
    colourLot,
    swissRounds,
    nextRound: lookAhead ? (paired.nextRound ?? null) : null,
    finalRoundMaxScore: finalMax ?? null,
  };
}