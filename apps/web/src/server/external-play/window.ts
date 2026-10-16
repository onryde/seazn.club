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

declare const boardAnchorBrand: unique symbol;

/** The instant a BOARD's window hangs off: its batch's start, `round_opened_at + batch × CHECKIN_BATCH_GAP_MS`. A branded
 *  value that only `boardAnchor` makes, so a raw round stamp (a bare Date) no longer compiles anywhere a window is asked
 *  about. `batch` rides along because batch 0 keeps the T−10 lead (a stamp in the future still reads "before") and a later
 *  batch does not (it opens AT its start, never before the organiser pressed Open). */
export type BoardAnchor = { readonly at: Date; readonly batch: number; readonly [boardAnchorBrand]: true };

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
 *  batch, and a later camera downgrade never reads here. */
export function boardAnchor(roundOpenedAt: Date, rank: number, staggered: boolean): BoardAnchor {
  const batch = staggered ? batchOfRank(rank) : 0;
  return { at: new Date(roundOpenedAt.getTime() + batch * CHECKIN_BATCH_GAP_MS), batch } as BoardAnchor;
}

export type PlayWindow = { emailAt: Date; opensAt: Date; deadline: Date };

/** A board's window: batch 0 opens `WINDOW_OPEN_LEAD_MS` before its anchor, a later batch AT its anchor (the lead would
 *  open it before the organiser pressed Open, and the stagger would not exist); every batch closes `DEADLINE_AFTER_MS`
 *  after its own start, so a batch that opens late loses none of it. */
export function windowFor(anchor: BoardAnchor): PlayWindow {
  const t = anchor.at.getTime();
  return {
    emailAt: new Date(t - EMAIL_LEAD_MS),
    opensAt: new Date(anchor.batch === 0 ? t - WINDOW_OPEN_LEAD_MS : t),
    deadline: new Date(t + DEADLINE_AFTER_MS),
  };
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
