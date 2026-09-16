import type { NeedsReason } from "./types";

/** Spec §8.1 — the only definition of these values. */
export const EMAIL_LEAD_MS = 15 * 60_000;
export const WINDOW_OPEN_LEAD_MS = 10 * 60_000;
export const DEADLINE_AFTER_MS = 20 * 60_000;
export const MATCH_ROOM_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const MINT_CLAIM_STALE_MS = 30_000;
export const LICHESS_TIMEOUT_MS = 10_000;
export const ROOM_REREAD_MS = 15_000;

export type PlayWindow = { emailAt: Date; opensAt: Date; deadline: Date };

export function windowFor(scheduledAt: Date): PlayWindow {
  const t = scheduledAt.getTime();
  return {
    emailAt: new Date(t - EMAIL_LEAD_MS),
    opensAt: new Date(t - WINDOW_OPEN_LEAD_MS),
    deadline: new Date(t + DEADLINE_AFTER_MS),
  };
}

export type RoomPhase = "before" | "open" | "closed";

export function roomPhase(now: Date, scheduledAt: Date): RoomPhase {
  const w = windowFor(scheduledAt);
  if (now.getTime() < w.opensAt.getTime()) return "before";
  if (now.getTime() < w.deadline.getTime()) return "open";
  return "closed";
}

/** A check-in counts only inside the fixture's CURRENT window (spec §7.2). */
export function checkInCounts(checkedInAt: Date | null, scheduledAt: Date): boolean {
  if (checkedInAt === null) return false;
  return roomPhase(checkedInAt, scheduledAt) === "open";
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
