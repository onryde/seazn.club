// W3 Task 9 — "Add late player" after pairing (spec 2026-10-31-format-matrix-w3-swiss-design.md §4, ruling 250): which
// of the three cases a latecomer takes, as one pure decision the server applies (`server/usecases/swiss-late-entry.ts`).
//
//   (a) nothing in the round has started → the round is RE-PAIRED with the newcomer; every slot keeps its time and
//       court. This is a deliberate deviation from FIDE C.04.2 4.4 (a late entrant joins at the next round), owner
//       ruling 250: an unstarted round costs nobody a game.
//   (b) a board has started and the round has an unused bye → the newcomer plays the bye holder; nothing else moves.
//   (c) otherwise → the round is frozen and the newcomer joins the next round's Pair.
//
// An AUTOMATIC arrival (a paid registration, a waitlist promotion, an import, a reinstatement) only ever takes (c)
// (X-SW-13, ruling 252 items 8 and 11): nothing the organiser did not press moves a published pairing.
//
// Client-safe and import-free: the desk can ask the same question the server answers.

/** One row of the stage as the decision reads it. `started` and `decided` are the server's (spec §4 "started": a score
 *  event, live, or decided other than the bye; an online game counts too. A device link does not — ruling C5, re-ruled
 *  after the T9 review: a printed sheet mints one for every board, and a link that was used wrote a score event). */
export type LateEntryBoard = {
  id: string;
  round: number;
  seq: number;
  extKey: string | null;
  home: string | null;
  away: string | null;
  started: boolean;
  decided: boolean;
  isBye: boolean;
};

export type LateEntryRefusalCode = "SWISS_NO_ROUND_LEFT" | "SWISS_OVER";

export type LateEntryDecision =
  | { kind: "repair"; round: number } // case (a)
  | { kind: "take_bye"; round: number; byeFixtureId: string; holder: string } // case (b)
  | { kind: "next_round"; firstRound: number } // case (c)
  | { kind: "refused"; code: LateEntryRefusalCode }
  | { kind: "noop" }; // already admitted

export interface LateEntryInput {
  boards: readonly LateEntryBoard[];
  /** The stage's declared round count (`config.rounds`). */
  rounds: number;
  /** The Swiss is complete, or a later stage of the division has a started fixture. */
  swissOver: boolean;
  /** Registration, waitlist, import or reinstatement — never an organiser's "Add late player". */
  automatic: boolean;
  /** The entrant already carries a first round for this stage, or a `swiss_late_entry` row: a webhook retry or a double
   *  submit. */
  alreadyAdmitted: boolean;
  /** Whether the newcomer may play this bye holder: the two have not met and the engine's colour rules accept the pair.
   *  Asked by rule 6 only, so an automatic arrival never reaches it. */
  canPlayBye: (holder: string) => boolean;
  newcomer: string;
}

/**
 * THE stage scope of an entrant's first Swiss round (V485; carry from T6): the stamp counts only in the Swiss stage
 * that wrote it (`swiss_first_round_stage_id`). Anywhere else — a second root Swiss stage, a stage made after the
 * stamped one was deleted — the entrant plays from round 1 (null). The server's active-entrant read and the desk's
 * round-1 field both read it, so the two cannot disagree on who a round seats.
 */
export function swissFirstRoundIn(
  entrant: { swiss_first_round?: number | null; swiss_first_round_stage_id?: string | null },
  stageId: string,
): number | null {
  return entrant.swiss_first_round_stage_id === stageId ? (entrant.swiss_first_round ?? null) : null;
}

/**
 * THE round-field predicate (W3 T6 ruling 251; T8 review m8): an entrant whose first Swiss round is `firstRound` (null
 * = from round 1) is in round `target`'s field when that first round is at or before it. `swissFieldForRound`
 * (usecases/stages.ts) and the desk's pairing menu (`swiss-pairing-menu.ts`) both filter through it.
 */
export function inSwissRoundField(firstRound: number | null | undefined, target: number): boolean {
  return (firstRound ?? 1) <= target;
}

/** A row with its seats filled: a board both sides, a bye its holder. */
function seated(b: LateEntryBoard): boolean {
  return b.home !== null && (b.isBye || b.away !== null);
}

/**
 * The plan's rules, in its order (empty case first, R13):
 *  0. admitted already → noop;
 *  1. the Swiss is over → SWISS_OVER;
 *  2. no seated round (no row, or shells only) → round 1;
 *  3. the current round is the latest seated round with an undecided board; none (between rounds) → the next round, or
 *     SWISS_NO_ROUND_LEFT past the last;
 *  4. automatic → (c);
 *  5. no board of the current round started → (a);
 *  6. an unused bye row and a legal pair with its holder → (b);
 *  7. else (c).
 * (c) is the round after the current one, or SWISS_NO_ROUND_LEFT past the last — so (a) and (b) are judged before "no
 * round left" (Decisions to confirm, item 1): the last round, started, with a bye still takes (b).
 */
export function decideSwissLateEntry(input: LateEntryInput): LateEntryDecision {
  if (input.alreadyAdmitted) return { kind: "noop" };
  if (input.swissOver) return { kind: "refused", code: "SWISS_OVER" };

  const nextRound = (r: number): LateEntryDecision =>
    r <= input.rounds ? { kind: "next_round", firstRound: r } : { kind: "refused", code: "SWISS_NO_ROUND_LEFT" };

  const seatedRounds = input.boards.filter(seated).map((b) => b.round);
  if (seatedRounds.length === 0) return { kind: "next_round", firstRound: 1 };

  const latest = Math.max(...seatedRounds);
  const inRound = input.boards.filter((b) => b.round === latest);
  const boardsInRound = inRound.filter((b) => !b.isBye);
  if (!boardsInRound.some((b) => seated(b) && !b.decided)) return nextRound(latest + 1);

  if (input.automatic) return nextRound(latest + 1);

  if (!boardsInRound.some((b) => b.started)) return { kind: "repair", round: latest };

  const bye = inRound.find((b) => b.isBye && b.home !== null);
  if (bye !== undefined && bye.home !== null && input.canPlayBye(bye.home)) {
    return { kind: "take_bye", round: latest, byeFixtureId: bye.id, holder: bye.home };
  }
  return nextRound(latest + 1);
}
