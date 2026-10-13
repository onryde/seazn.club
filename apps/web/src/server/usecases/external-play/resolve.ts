import "server-only";
// T16 — the organiser settles an online board (chess design §3.6, §7): the
// queue's "Settle the result" for a held board, and the arbiter panel's
// "Settle the result now…" for any board still being played.
//
// The result is written through the normal scoring path under the CALLER's
// own authority — a signed-in owner or admin, whom W2a's organiser-only gate
// admits — so the ledger's `recorded_by` names who settled it. That row is
// the audit record (controller ruling 2026-10-12: one authority per fact).
//
// Never gated by the online-chess flag: settling FINISHES play (T20).
//
// What the organiser's choice means on the ledger (FIDE Laws: a player absent
// at the start of play loses by default, Art. 6.7; any other decision of an
// arbiter is an adjudication):
//   - "X wins"  — when the LOSER is a recorded no-show, a default:
//                 `core.forfeit {by: the loser, reason: "walkover"}` with no
//                 Start (RB4; W2b spec §5.2 — the sweep's own no-show shape;
//                 W2b D15 refuses `boardgame.result{method: forfeit}`).
//                 Otherwise an adjudication, `boardgame.result {winner: X,
//                 method: adjudication}` after a Start;
//   - "Draw"    — `boardgame.result {winner: null, method: adjudication}`. In
//                 a bracket the engine opens the tie-break, and the board is
//                 held `tiebreak_owed` by the same rule as a game's draw (R2):
//                 a knockout draw is never decided;
//   - "No result" — VOID (I-3, controller ruling, fix round 2): an abandon,
//                 `core.abandon {reason}` with the hold's reason in plain words
//                 in the club's language — no points to either player, no
//                 absence. Only where BOTH players stayed away (no_show_both,
//                 double_walkover_blocked) is it W2b's double walkover,
//                 `core.forfeit {by: "both", reason: "walkover"}` (W2b spec
//                 §5.2) — offered wherever W2b takes one, a knockout line
//                 that feeds a next match included (fix round 3). Never a Start: before play the board stays unplayed
//                 (ruling 118 reads chess's play from an active Start), after
//                 it the Start stands. The void is offered only in a
//                 league or a group's round-robin (fix round 3): in ANY
//                 knockout it is refused (KNOCKOUT_NEEDS_WINNER) — a knockout
//                 game needs a winner — and in a Swiss (SWISS_NEEDS_RESULT),
//                 whose next round waits on every game decided; nothing is
//                 written. no-result.ts holds every one of these rules;
//   - a board whose tie-break is owed takes a winner only, written as the
//     organiser's settle (`core.settle {method: organiser}`, W2a).
import type { AuthCtx } from "@/server/api-v1/auth";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { toLocale } from "@/lib/i18n-constants";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { getFixtureState } from "../fixtures";
import { EngineError } from "@seazn/engine/core";
import { scoreEvent } from "../scoring";
import { whiteSideOf, type Side } from "./guard";
import { NO_RESULT_REFUSAL, noResultEvent, noResultOffer } from "./no-result";
import { isPlayableFixtureStatus } from "./preflight";
import { foldPhaseOf, holdOwedTiebreak, tiebreakIsPending } from "./result";
import { isSeatedOn } from "./seated";

export const RESOLVE_KINDS = ["home_wins", "away_wins", "draw", "no_result"] as const;
export type ResolveKind = (typeof RESOLVE_KINDS)[number];

/** `finished`: the board has its result. `tiebreak_owed`: the organiser's
 *  draw opened a bracket tie-break — the board stays held for the winner. */
export type ResolveOutcome = { status: "finished" | "tiebreak_owed" };

/** The holds whose colour stayed away (sweep.ts, result.ts NO_SHOW_REASONS):
 *  a win against that colour is a default. Both absent: every loser is one. */
const ABSENT_BY_REASON: Partial<Record<NeedsReason, "white" | "black" | "both">> = {
  no_show_white: "white",
  no_show_black: "black",
  no_show_both: "both",
  double_walkover_blocked: "both",
};

type Board = {
  orgId: string;
  fixtureStatus: string;
  homeEntrantId: string | null;
  awayEntrantId: string | null;
  bridgeStatus: string;
  needsReason: string | null;
  whiteSide: Side | null;
  stageKind: string | null;
  /** The club's default locale: the abandon reason's language (I-3). */
  orgLocale: string | null;
  /** The two feed edges: whether this line feeds a next match (W2b D19, read by `noResultOffer`). */
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
};

function requireOrganiserSession(auth: AuthCtx): string {
  if (auth.via !== "session" || auth.userId === null) {
    throw new HttpError(403, "Settling a board needs a signed-in organiser", "ORGANISER_SESSION_REQUIRED");
  }
  return auth.userId;
}

/** The board as this club holds it. Online play may have been switched off
 *  since the open: the bridge row is what makes it an online board to settle,
 *  so the guard's "online now" is not asked. */
async function loadBoard(auth: AuthCtx, fixtureId: string): Promise<Board> {
  const [row] = await sql<Board[]>`
    select f.org_id as "orgId", f.status as "fixtureStatus",
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId",
           ep.status as "bridgeStatus", ep.needs_reason as "needsReason", ep.white_side as "whiteSide",
           s.kind as "stageKind", o.default_locale as "orgLocale", f.winner_to_fixture, f.loser_to_fixture
      from fixtures f
      join divisions d on d.id = f.division_id
      join organizations o on o.id = f.org_id
      join fixture_external_play ep on ep.fixture_id = f.id
      left join stages s on s.id = f.stage_id
     where f.id = ${fixtureId} and d.sport_key = 'boardgame'`;
  if (!row || row.orgId !== auth.orgId) throw new HttpError(404, "no online board here", "NOT_FOUND");
  return row;
}

/** A board whose fixture was settled through another path while its bridge
 *  row still reads held or in play: the fixture's decision stands, and the
 *  row is closed so the queue and the panel agree with it. */
async function closeBridge(fixtureId: string): Promise<void> {
  await sql`
    update fixture_external_play
       set status = 'finished', needs_reason = null, revoked_seat = null, draw_offer_by = null,
           finished_at = coalesce(finished_at, now()), updated_at = now()
     where fixture_id = ${fixtureId} and status <> 'finished'`;
}

function readReason(raw: string | null): NeedsReason | null {
  if (raw === null) return null;
  const r = NEEDS_REASONS.find((x) => x === raw);
  // V439's CHECK keeps the column inside the vocabulary; a drift is refused
  // loudly rather than settled on a guess.
  if (!r) throw new HttpError(500, `needs_organiser row with unknown reason ${JSON.stringify(raw)}`, "NEEDS_REASON_UNKNOWN");
  return r;
}

/** The idempotency key of ONE organiser decision on this board at this point of its ledger. It names the decision
 *  (T16 fix round 1, M10): keyed on the ledger position alone, two organisers settling at the same moment with
 *  DIFFERENT decisions shared a key, so the loser's write replayed the winner's event and was told its own decision
 *  was recorded. The same decision pressed twice still shares its key, and is recorded once. */
function decisionKey(fixtureId: string, seq: number, kind: ResolveKind): string {
  return `extplay:resolve:${fixtureId}:${seq}:${kind}`;
}

/** The board changed between this settle's read and its write: another writer committed in between (another
 *  organiser's settle, the sweep's result). Its own code (T16 fix round 2, N2): the board need not have its result —
 *  a knockout draw leaves the tie-break owed — so "already has its result" would be wrong. Nothing of this settle is
 *  written; the organiser reloads to see what changed. */
function boardChanged(): HttpError {
  return new HttpError(409, "This board changed while you were deciding — reload to see it", "BOARD_CHANGED");
}

/** A settle's ledger write. A ledger conflict is the board changing under the organiser (`boardChanged`), never a
 *  bare engine error. */
async function settleWrite(auth: AuthCtx, fixtureId: string, input: Parameters<typeof scoreEvent>[2]): Promise<void> {
  try {
    await scoreEvent(auth, fixtureId, input);
  } catch (err) {
    if (err instanceof EngineError && err.code === "SEQ_CONFLICT") throw boardChanged();
    throw err;
  }
}

/**
 * Settle one online board. Refusals, each before anything is written:
 *  - 403 ORGANISER_SESSION_REQUIRED: not a signed-in person;
 *  - 404 NOT_FOUND: not this club's online board;
 *  - 403 ARBITER_PLAYS_THIS_BOARD: the organiser plays on it (T15's seated
 *    predicate) — another organiser must settle it;
 *  - 409 ALREADY_RESOLVED: the board already has its result when this settle reads it;
 *  - 409 ONLINE_GAME_OVER: the online game is over but the fixture is open (a voided result): the scoring pad's;
 *  - 409 BOARD_CHANGED: another writer changed it while this settle was on its way (two organisers at once: one
 *    decision is recorded, the other is told the board changed — its tie-break may now be owed, not settled);
 *  - 409 TIEBREAK_NEEDS_WINNER: a draw or no result for a board whose
 *    tie-break is owed;
 *  - 409 KNOCKOUT_NEEDS_WINNER (I-3): No result in any knockout — every stage kind where a level result is forbidden,
 *    a line that feeds a next match as much as a final. The board stays held;
 *  - 409 SWISS_NEEDS_RESULT (I-3, fix round 3): No result where a void would hold the next round up — a Swiss (and
 *    americano). The board stays held.
 */
export async function resolveExternalPlay(auth: AuthCtx, fixtureId: string, kind: ResolveKind): Promise<ResolveOutcome> {
  if (!(RESOLVE_KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(422, `not a way to settle a board: ${JSON.stringify(kind)}`, "RESOLVE_KIND_UNKNOWN");
  }
  const actorUserId = requireOrganiserSession(auth);
  const b = await loadBoard(auth, fixtureId);
  if (await isSeatedOn(actorUserId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must settle it", "ARBITER_PLAYS_THIS_BOARD");
  }
  if (!isPlayableFixtureStatus(b.fixtureStatus)) {
    await closeBridge(fixtureId);
    throw new HttpError(409, "This board already has its result", "ALREADY_RESOLVED");
  }
  // The online game is over while the fixture is open again: its result was voided on the pad (or a level result
  // entered there waits for its tie-break). The bridge cannot reopen a game Lichess ended, and the board has no result
  // to be "already" settled — the pad is where it is decided (T16 fix round 3, N4).
  if (b.bridgeStatus === "finished") {
    throw new HttpError(409, "This board's online game is over — record its result on the scoring pad", "ONLINE_GAME_OVER");
  }
  if (b.homeEntrantId === null || b.awayEntrantId === null) {
    // An online board is paired by construction (guard.ts); a seat emptied
    // since is not one to give a result to.
    throw new HttpError(409, "This board has no opponent to settle against", "FIXTURE_NOT_PLAYABLE");
  }
  const reason = readReason(b.needsReason);

  const fs = await getFixtureState(auth, fixtureId);
  const winnerOf = (k: ResolveKind) => (k === "home_wins" ? b.homeEntrantId : k === "away_wins" ? b.awayEntrantId : null);

  // A tie-break owed (a bracket draw on file): the organiser picks who goes
  // through — W2a's settle, never a second game result.
  if (tiebreakIsPending(fs)) {
    const winner = winnerOf(kind);
    if (winner === null) {
      throw new HttpError(409, "A drawn knockout game needs a winner to go through", "TIEBREAK_NEEDS_WINNER");
    }
    await settleWrite(auth, fixtureId, {
      expected_seq: fs.last_seq,
      type: "core.settle",
      payload: { winner, method: "organiser" },
      idempotency_key: decisionKey(fixtureId, fs.last_seq, kind),
    });
    await closeBridge(fixtureId);
    return { status: "finished" };
  }

  if (kind === "no_result") {
    const offer = noResultOffer({ stageKind: b.stageKind, reason, edges: b });
    if (offer.kind === "refused") {
      const refusal = NO_RESULT_REFUSAL[offer.why];
      throw new HttpError(409, refusal.message, refusal.code);
    }
    // I-3: VOID (an abandon), or — both players absent — the double walkover; either whether or not play is recorded
    // (W2b admits an abandon and a chess walkover before the game and after the Start, ruling 118). So no Start is
    // written for it: a board nobody played stays unplayed, and one with a Start keeps it.
    const event = noResultEvent(reason, toLocale(b.orgLocale));
    await settleWrite(auth, fixtureId, {
      expected_seq: fs.last_seq,
      type: event.type,
      payload: event.payload,
      idempotency_key: decisionKey(fixtureId, fs.last_seq, kind),
    });
    await closeBridge(fixtureId);
    return { status: "finished" };
  }

  if (kind === "home_wins" || kind === "away_wins") {
    const absent = reason === null ? undefined : ABSENT_BY_REASON[reason];
    const loserSide: Side = kind === "home_wins" ? "away" : "home";
    let loserAbsent = absent === "both";
    if (absent === "white" || absent === "black") {
      const whiteSide = b.whiteSide ?? (await whiteSideOf({ fixtureId, orgId: b.orgId }));
      loserAbsent = (loserSide === whiteSide) === (absent === "white");
    }
    if (loserAbsent) {
      // RB4: a default is a walkover by the absent loser — the sweep's own no-show write (spec §3.6) — admitted
      // before the game and, for chess, after the Start (ruling 118). No Start is written for it.
      await settleWrite(auth, fixtureId, {
        expected_seq: fs.last_seq,
        type: "core.forfeit",
        payload: { by: loserSide === "home" ? b.homeEntrantId : b.awayEntrantId, reason: "walkover" },
        idempotency_key: decisionKey(fixtureId, fs.last_seq, kind),
      });
      await closeBridge(fixtureId);
      return { status: "finished" };
    }
  }
  const payload = { winner: winnerOf(kind), method: "adjudication" as const };

  // boardgame refuses a result before the game starts (decideResult): start
  // the fold first, as T12's writer does.
  let seq = fs.last_seq;
  const phase = foldPhaseOf(fs.state);
  if (phase === "pre") {
    await settleWrite(auth, fixtureId, { expected_seq: seq, type: "core.start", payload: {} });
    seq += 1;
  } else if (phase !== "live") {
    // A playable fixture's fold is pre, live or a pending tie-break (answered
    // above): anything else is a writer that committed in between.
    throw boardChanged();
  }
  await settleWrite(auth, fixtureId, {
    expected_seq: seq,
    type: "boardgame.result",
    payload,
    idempotency_key: decisionKey(fixtureId, seq, kind),
  });

  if (kind === "draw" && (await holdOwedTiebreak(fixtureId, auth, "the organiser recorded a draw in a bracket: the tie-break is owed"))) {
    return { status: "tiebreak_owed" };
  }
  await closeBridge(fixtureId);
  return { status: "finished" };
}
