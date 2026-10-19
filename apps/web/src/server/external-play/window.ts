import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS, EXTEND_REFUSALS, extensionsLeft, type ExtendRefusal } from "@/lib/checkin-extend";
import type { NeedsReason } from "./types";

/** Spec §8.1 — the only definition of these values. */
export const EMAIL_LEAD_MS = 15 * 60_000;
export const WINDOW_OPEN_LEAD_MS = 10 * 60_000;
export const DEADLINE_AFTER_MS = 10 * 60_000;
export const MATCH_ROOM_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const MINT_CLAIM_STALE_MS = 30_000;

/** The earliest mint claim still LIVE at `now` — T9 is in flight under a claim at or after it. The sweep's
 *  gameMayBeOnFile and the re-open's meeting guard both read a claim's liveness through this one bound. */
export function liveMintClaimSince(now: Date): Date {
  return new Date(now.getTime() - MINT_CLAIM_STALE_MS);
}
export const LICHESS_TIMEOUT_MS = 10_000;

/** Check-in is spread over timed BATCHES (spec §3.2.1): a board's rank among every fixture row of its (stage, round) divides
 *  by the batch size, and each batch starts one gap after the last. Declared once, here; the gap is the only knob (it
 *  STARTS at 120 s and the load re-run may tighten it). */
export const CHECKIN_BATCH_SIZE = 10;
export const CHECKIN_BATCH_GAP_MS = 120_000;

/** The check-in extension (spec §3.2.2): the arbiter adds `CHECKIN_EXTEND_STEP_MS` to ONE board's check-in while it is still open,
 *  at most `CHECKIN_EXTEND_MAX` times (owner, 2026-10-19: +5 minutes a press, three presses). The numbers are declared once, in
 *  the client-safe `lib/checkin-extend.ts` (the screens print them), and re-exported here, where the rules are. The board's
 *  extension is stored on its bridge row (`fixture_external_play.checkin_extra_ms`, a number of ms, not a count of presses, so a
 *  retuned step never moves a deadline a player was told) and enters every reader through the board's anchor (`boardAnchor`). */
export { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS, EXTEND_REFUSALS, extensionsLeft, type ExtendRefusal };

declare const boardAnchorBrand: unique symbol;

/** The instant a BOARD's window hangs off: its batch's start, `round_opened_at + batch × CHECKIN_BATCH_GAP_MS`. A branded
 *  value that only `boardAnchor` makes, so a raw round stamp (a bare Date) no longer compiles anywhere a window is asked
 *  about. `batch` rides along because batch 0 keeps the T−10 lead (a stamp in the future still reads "before") and a later
 *  batch does not (it opens AT its start, never before the organiser pressed Open). `extraMs` is the board's check-in
 *  extension (spec §3.2.2): time added to its DEADLINE, and through the deadline to the line's cap, by `windowFor` and nowhere else. */
export type BoardAnchor = { readonly at: Date; readonly batch: number; readonly extraMs: number; readonly [boardAnchorBrand]: true };

/** The batch a board of zero-based `rank` is in, in a round that staggers. */
export function batchOfRank(rank: number): number {
  if (!Number.isInteger(rank) || rank < 0) throw new RangeError(`a board's rank is a non-negative integer, got ${rank}`);
  return Math.floor(rank / CHECKIN_BATCH_SIZE);
}

/** How many batches a round of `boards` fixture rows runs in when it staggers (never fewer than one). */
export function batchCount(boards: number): number {
  return Math.max(1, Math.ceil(boards / CHECKIN_BATCH_SIZE));
}

/** THE constructor of a board's anchor. `staggered` is the flag the round's open STORED (spec §3.2.1): an `off` round is one
 *  batch, and a later camera downgrade never reads here. `extraMs` is the board's stored check-in extension (spec §3.2.2): 0 for
 *  a board nobody extended, and it MUST be handed through by every production caller (batch-anchor-source-guard.test.ts reads
 *  the call sites), because a reader that leaves it out judges the board by a deadline the players are no longer on. */
export function boardAnchor(roundOpenedAt: Date, rank: number, staggered: boolean, extraMs = 0): BoardAnchor {
  if (!Number.isInteger(extraMs) || extraMs < 0) throw new RangeError(`a board's check-in extension is a non-negative integer of ms, got ${extraMs}`);
  const batch = staggered ? batchOfRank(rank) : 0;
  return { at: new Date(roundOpenedAt.getTime() + batch * CHECKIN_BATCH_GAP_MS), batch, extraMs } as BoardAnchor;
}

export type PlayWindow = { emailAt: Date; opensAt: Date; deadline: Date };

/** A board's window: batch 0 opens `WINDOW_OPEN_LEAD_MS` before its anchor, a later batch AT its anchor (the lead would
 *  open it before the organiser pressed Open, and the stagger would not exist); every batch closes `DEADLINE_AFTER_MS`
 *  after its own start, so a batch that opens late loses none of it - plus the board's own extension (spec §3.2.2), which
 *  moves the deadline and nothing else. */
export function windowFor(anchor: BoardAnchor): PlayWindow {
  const t = anchor.at.getTime();
  return {
    emailAt: new Date(t - EMAIL_LEAD_MS),
    opensAt: new Date(anchor.batch === 0 ? t - WINDOW_OPEN_LEAD_MS : t),
    deadline: new Date(t + DEADLINE_AFTER_MS + anchor.extraMs),
  };
}

/** Spec §5.7.8: how long past a board's deadline the check-in line can still protect a player the platform's call budget is
 *  holding. ONE cap for the three things it covers - line admission, the no-show skip and the create - and nothing is uncapped. */
export const LINE_DEADLINE_GRACE_MS = 5 * 60_000;

/** The board's cap: its deadline plus the line's grace. After it the window is closed to everyone, protected or not. */
export function boardCap(anchor: BoardAnchor): Date {
  return new Date(windowFor(anchor).deadline.getTime() + LINE_DEADLINE_GRACE_MS);
}

export type RoomPhase = "before" | "open" | "closed";

export function roomPhase(now: Date, anchor: BoardAnchor): RoomPhase {
  const w = windowFor(anchor);
  if (now.getTime() < w.opensAt.getTime()) return "before";
  if (now.getTime() < w.deadline.getTime()) return "open";
  return "closed";
}

/** A check-in counts only inside the board's CURRENT window (spec §7.2). */
export function checkInCounts(checkedInAt: Date | null, anchor: BoardAnchor): boolean {
  if (checkedInAt === null) return false;
  return roomPhase(checkedInAt, anchor) === "open";
}

/** Is a game on file - or possibly on file - behind a board's bridge row at `now`? A recorded challenge, a sent create (T9's
 *  marker) or a LIVE mint claim (T9 in flight, before its marker): the same three facts as `gameEvidenceOn` (video/realtimekit.ts,
 *  the SQL form the re-open and ensureMeeting keep), so the check-in extension refuses on exactly the boards a re-pair would. */
export function bridgeGameOnFile(
  b: { status: string; challengeId: string | null; createSentAt: Date | null; mintClaimedAt: Date | null },
  now: Date,
): boolean {
  if (b.challengeId !== null || b.createSentAt !== null) return true;
  return b.status === "pending" && b.mintClaimedAt !== null && b.mintClaimedAt.getTime() >= liveMintClaimSince(now).getTime();
}

/** THE rule for "may this board's check-in be extended now?", pure so the door, the arbiter's board list and the round's count
 *  of extendable boards all ask the same function. The board's check-in must be OPEN - between its opening and its (extended)
 *  deadline - with no game on file (`gameOnFile`: a challenge, a create marker or a live mint claim: the repo's `gameEvidenceOn`),
 *  the board still to be played (`playable`: not finished, cancelled, voided or withdrawn) and under the cap. The reasons are
 *  judged in a fixed order, the board's own state first: an over board is over whatever the clock says, a game on file is a
 *  game whatever the window says, and a capped board that has also closed is `closed` (nothing more to be done) and not `cap_reached`.
 *  `anchor` carries the board's CURRENT extension; `extensions` is its count of presses. */
export function extendRefusal(a: {
  now: Date;
  anchor: BoardAnchor;
  extensions: number;
  playable: boolean;
  gameOnFile: boolean;
}): ExtendRefusal | null {
  if (!Number.isInteger(a.extensions) || a.extensions < 0) throw new RangeError(`a board's count of extensions is a non-negative integer, got ${a.extensions}`);
  if (!a.playable) return "not_playable";
  if (a.gameOnFile) return "game_started";
  const phase = roomPhase(a.now, a.anchor);
  if (phase === "closed") return "closed";
  if (phase === "before") return "not_open";
  if (a.extensions >= CHECKIN_EXTEND_MAX) return "cap_reached";
  return null;
}

export const LICHESS_NOT_STARTED: ReadonlySet<string> = new Set(["created"]);
export const LICHESS_ABORTED: ReadonlySet<string> = new Set(["aborted", "noStart", "unknownFinish"]);

/** Spec §9. Check-ins decide first; only with both present does Lichess speak. */
export function deadlineReason(input: {
  whiteCheckedIn: boolean;
  blackCheckedIn: boolean;
  lichessStatus: string | null;
}): NeedsReason | null {
  if (!input.whiteCheckedIn && !input.blackCheckedIn) return "no_show_both";
  if (!input.blackCheckedIn) return "no_show_black";
  if (!input.whiteCheckedIn) return "no_show_white";
  if (input.lichessStatus === null || LICHESS_NOT_STARTED.has(input.lichessStatus)) return "not_started";
  if (LICHESS_ABORTED.has(input.lichessStatus)) return "aborted";
  return null;
}
