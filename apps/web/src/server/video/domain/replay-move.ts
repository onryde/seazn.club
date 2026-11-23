// server/video/domain/replay-move.ts — the replay move's decisions, PURE (Seazn-hosted video, Phase 2, Task 24). No database,
// no network, no clock of its own: the caller passes `now`.
//
// One `fixture_video_replays` row is one Cloudflare recording on its way to the replay host. `nextReplayStep` is the state
// machine as a TRANSITION TABLE: state → the step the mover takes next (`STEP_OF`), one entry per state, so a state the schema
// holds and the table does not is a compile error, and a row whose state is neither is refused by name. The mover
// (usecases/seazn-replays.ts) runs the step and writes what it learns; the webhook (Task 27) runs `verifyReplayCopy` too.
//
// The Cloudflare delete is decided in ONE place, `cfDeleteGate`: only once the host's copy passed the check (`verified_at`) and
// SEAZN_CF_DELETE_DELAY_MINUTES have gone by since (owner ruling 2026-11-21, G-D; the 60 is a recommendation). A row with no
// `verified_at` never earns a delete from here, whatever its state.
import {
  SEAZN_CF_DELETE_DELAY_MINUTES, SEAZN_FETCH_STALE_MINUTES, SEAZN_POLL_BACKSTOP_MINUTES, SEAZN_REPLAY_BACKOFF_MAX_MINUTES,
  SEAZN_REPLAY_RETRY_DAYS,
} from "@/server/relay/config";
import type { ReplayState } from "../replay-ports";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** V542's state list, in its own order. */
export const REPLAY_ROW_STATES = ["found", "downloading", "fetching", "encoding", "playable", "failed", "deleted"] as const;
export type ReplayRowState = (typeof REPLAY_ROW_STATES)[number];

/** The facts of one row the decisions read (the columns of `fixture_video_replays`, camel-cased). */
export interface ReplayRow {
  state: ReplayRowState;
  stateAt: Date;
  recordedAt: Date;
  bunnyVideoId: string | null;
  verifiedAt: Date | null;
  cfDeletedAt: Date | null;
  bunnyCleanedAt: Date | null;
  /** The organiser's (or the org deletion's) delete: a deleted row's retry window opens here (re-review N1). */
  deletedAt: Date | null;
  cfDurationSeconds: number | null;
  cfHeight: number | null;
  attempts: number;
}

/** What the mover does next with a row.
 *  - `create_download`: ask Cloudflare for the MP4 (again, until it is ready), then fetch it into the host;
 *  - `refetch`: a `fetching` row lost its answer — back to `downloading`, and the fetch is sent again;
 *  - `poll_state`: read the host's copy (the backstop for its webhook);
 *  - `delete_cf`: delete the Cloudflare copy by the row's own id (only from `playable`, past the gate);
 *  - `retry`: a failed move starts again from `found`;
 *  - `cleanup`: a deleted row's host copy is removed, and its Cloudflare copy deleted when the gate says so (`cf`);
 *  - `wait`: nothing to do before `until`; `settled`: nothing to do ever; `give_up`: a failure past the retry window;
 *  - `refuse`: a row in a shape nothing writes — named, never guessed. */
export type ReplayStep =
  | { kind: "create_download" }
  | { kind: "refetch" }
  | { kind: "poll_state" }
  | { kind: "delete_cf" }
  | { kind: "retry" }
  | { kind: "cleanup"; cf: "delete" | "skip" }
  | { kind: "cleanup"; cf: "wait"; until: Date }
  | { kind: "wait"; until: Date }
  | { kind: "settled" }
  | { kind: "give_up" }
  | { kind: "refuse"; reason: "fetching_holds_video" | "playable_unverified" | "unknown_state" };

/** The Cloudflare delete gate: due only at or after `verified_at + SEAZN_CF_DELETE_DELAY_MINUTES`. Not due before then (`until`
 *  is when it will be), and never without a verification (`until: null`). */
export function cfDeleteGate(row: Pick<ReplayRow, "verifiedAt">, now: Date): { due: true } | { due: false; until: Date | null } {
  if (row.verifiedAt === null) return { due: false, until: null };
  const at = row.verifiedAt.getTime() + SEAZN_CF_DELETE_DELAY_MINUTES * MIN;
  return now.getTime() >= at ? { due: true } : { due: false, until: new Date(at) };
}

/** The transition table: one entry per state. */
const STEP_OF: { readonly [S in ReplayRowState]: (row: ReplayRow, now: Date) => ReplayStep } = {
  found: () => ({ kind: "create_download" }),
  downloading: () => ({ kind: "create_download" }),
  fetching: (row, now) => {
    // The host's id comes back in the fetch's own answer and is written WITH the move to encoding; a fetching row holding one
    // is a write nothing makes.
    if (row.bunnyVideoId !== null) return { kind: "refuse", reason: "fetching_holds_video" };
    const staleAt = row.stateAt.getTime() + SEAZN_FETCH_STALE_MINUTES * MIN;
    return now.getTime() >= staleAt ? { kind: "refetch" } : { kind: "wait", until: new Date(staleAt) };
  },
  encoding: () => ({ kind: "poll_state" }),
  playable: (row, now) => {
    if (row.cfDeletedAt !== null) return { kind: "settled" };
    const gate = cfDeleteGate(row, now);
    if (gate.due) return { kind: "delete_cf" };
    // V542's CHECK makes `playable` imply `verified_at`; a row without one never earns a delete.
    return gate.until === null ? { kind: "refuse", reason: "playable_unverified" } : { kind: "wait", until: gate.until };
  },
  failed: (row, now) => (pastRetryWindow(row, now) ? { kind: "give_up" } : { kind: "retry" }),
  deleted: (row, now) => {
    if (row.bunnyCleanedAt !== null) return { kind: "settled" };
    if (row.cfDeletedAt !== null) return { kind: "cleanup", cf: "skip" };
    const gate = cfDeleteGate(row, now);
    if (gate.due) return { kind: "cleanup", cf: "delete" };
    // Never verified: the Cloudflare copy is left to Cloudflare's own scheduled deletion (Task 13), never deleted from here.
    return gate.until === null ? { kind: "cleanup", cf: "skip" } : { kind: "cleanup", cf: "wait", until: gate.until };
  },
};

export function nextReplayStep(row: ReplayRow, now: Date): ReplayStep {
  const of = (STEP_OF as Partial<Record<string, (r: ReplayRow, n: Date) => ReplayStep>>)[row.state];
  return of ? of(row, now) : { kind: "refuse", reason: "unknown_state" };
}

/** A failed attempt (a provider that threw, or a copy that failed): one more attempt, and the next one waits
 *  min(2^attempts, SEAZN_REPLAY_BACKOFF_MAX_MINUTES) minutes, `attempts` being the count BEFORE this failure. */
export function replayFailure(row: Pick<ReplayRow, "attempts">, now: Date): { attempts: number; nextAttemptAt: Date } {
  const minutes = Math.min(2 ** row.attempts, SEAZN_REPLAY_BACKOFF_MAX_MINUTES);
  return { attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + minutes * MIN) };
}

/** Where a row past every retry is parked: never due again (a date Postgres and every client read plainly). */
export const REPLAY_PARKED_AT = new Date("9999-12-31T00:00:00.000Z");

/** The one retry window (review I2, 2026-11-22): SEAZN_REPLAY_RETRY_DAYS from its anchor, then nothing is retried. Read by
 *  `failed`'s step and by every other state's failure. The anchor is the recording's start — the Cloudflare copy's own life, after
 *  which nothing is left to move — EXCEPT for a deleted row (re-review N1): its cleanup removes a Bunny copy, which has no 30-day
 *  life, and an organiser deletes a replay long after it was recorded, so its retries count from its own delete (`deleted_at`;
 *  `state_at` when no delete time was written). */
export function pastRetryWindow(row: Pick<ReplayRow, "state" | "recordedAt" | "deletedAt" | "stateAt">, now: Date): boolean {
  const anchor = row.state === "deleted" ? (row.deletedAt ?? row.stateAt) : row.recordedAt;
  return now.getTime() - anchor.getTime() >= SEAZN_REPLAY_RETRY_DAYS * DAY;
}

/** The states a failure past the window leaves as they are: a playable row's verified copy is never hidden, and an organiser's
 *  delete is never undone. Every other state is parked as `failed`. */
const KEPT_WHEN_PARKED: ReadonlySet<ReplayRowState> = new Set(["playable", "deleted"]);

/** What a failed step leaves on its row (review I2): inside the retry window, the same state and the backoff; past it, the row is
 *  parked at REPLAY_PARKED_AT — as `failed`, or in its own state when that is playable or deleted — so it is never claimed again,
 *  rather than failing a provider call and logging an error every hour for ever.
 *  EXCEPT a row that would park as `failed` while it still holds a host copy (Task 31b): parked, nothing would ever remove the copy,
 *  so it is due again after the backoff instead, and `failed`'s give_up removes the copy and only then parks it. A playable row's
 *  copy is the product, and a deleted row keeps its own cleanup's window: both park as before. */
export type ReplayFailureOutcome =
  | { kind: "backoff"; state: ReplayRowState; attempts: number; nextAttemptAt: Date }
  | { kind: "give_up"; state: ReplayRowState; attempts: number; nextAttemptAt: Date };
export function replayFailureOutcome(
  row: Pick<ReplayRow, "state" | "attempts" | "recordedAt" | "deletedAt" | "stateAt" | "bunnyVideoId">, now: Date,
): ReplayFailureOutcome {
  const f = replayFailure(row, now);
  if (!pastRetryWindow(row, now)) return { kind: "backoff", state: row.state, ...f };
  const state = KEPT_WHEN_PARKED.has(row.state) ? row.state : "failed";
  const copyToRemove = state === "failed" && row.bunnyVideoId !== null;
  return { kind: "give_up", state, attempts: f.attempts, nextAttemptAt: copyToRemove ? f.nextAttemptAt : REPLAY_PARKED_AT };
}

/** The title a copy is stored under on the replay host (the plan's form, `seazn:{sessionId}:{cfVideoId}`). Nothing searches the
 *  host by it: the webhook (Task 27) reads it back, through `parseReplayCopyTitle`, only for a copy no row holds, to tell a stray copy
 *  of ours from another video in the library. One authority for both directions. */
export function replayCopyTitle(sessionId: string, cfVideoId: string): string {
  return `seazn:${sessionId}:${cfVideoId}`;
}
const COPY_TITLE = /^seazn:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([^\s:]+)$/i;
/** The session and the recording a title of `replayCopyTitle`'s form names; null for any other title (or none). */
export function parseReplayCopyTitle(title: string | null): { sessionId: string; cfVideoId: string } | null {
  const m = title === null ? null : COPY_TITLE.exec(title);
  return m ? { sessionId: m[1]!, cfVideoId: m[2]! } : null;
}

/** The renditions the host makes, smallest first; it never makes one above 720 (B2). */
const RUNGS = [240, 360, 480, 720] as const;
/** The rung a clean copy must list: the largest one not above the source's height. Null for a source with no height or under
 *  240 px, which no copy can satisfy. */
export function requiredRung(cfHeight: number | null): number | null {
  if (cfHeight === null) return null;
  let best: number | null = null;
  for (const rung of RUNGS) if (rung <= cfHeight) best = rung;
  return best;
}

/** How far, in seconds, the copy's length may be from the Cloudflare recording's (recommendation 2026-11-21). */
const LENGTH_TOLERANCE_SECONDS = 2;
export type VerifyFailure = "state" | "length" | "rendition";
/** "Clean and good" (recommendation 2026-11-21, G-C): the copy passes only when the host reports it playable, its length is
 *  within ±2 s of the Cloudflare recording's duration, and it lists the required rung (720, or the source's own rung when lower).
 *  A null on either side of a comparison fails it. The reason is the first check that fails, in that order. */
export function verifyReplayCopy(
  row: Pick<ReplayRow, "cfDurationSeconds" | "cfHeight">,
  copy: { state: ReplayState; lengthSeconds: number | null; heights: readonly number[] },
): { ok: true } | { ok: false; reason: VerifyFailure } {
  if (copy.state !== "playable") return { ok: false, reason: "state" };
  if (row.cfDurationSeconds === null || copy.lengthSeconds === null || Math.abs(copy.lengthSeconds - row.cfDurationSeconds) > LENGTH_TOLERANCE_SECONDS) {
    return { ok: false, reason: "length" };
  }
  const rung = requiredRung(row.cfHeight);
  if (rung === null || !copy.heights.includes(rung)) return { ok: false, reason: "rendition" };
  return { ok: true };
}

/** What one poll of an `encoding` copy means:
 *  - `processing`: poll again SEAZN_POLL_BACKSTOP_MINUTES later;
 *  - `verified`: the copy passed — `playable` now, the Cloudflare delete due SEAZN_CF_DELETE_DELAY_MINUTES later;
 *  - `failed`: the host gave up on it, or it is playable but not clean — the failed path (the guid is removed);
 *  - `lost`: the host holds no such copy — back to `found`. */
export type PollOutcome =
  | { kind: "processing"; nextAttemptAt: Date }
  | { kind: "verified"; verifiedAt: Date; lengthSeconds: number | null; nextAttemptAt: Date }
  | { kind: "failed"; reason: VerifyFailure | "host_failed" }
  | { kind: "lost" };

export function pollOutcome(
  row: Pick<ReplayRow, "cfDurationSeconds" | "cfHeight">,
  copy: { state: ReplayState; lengthSeconds: number | null; heights: readonly number[] },
  now: Date,
): PollOutcome {
  switch (copy.state) {
    case "processing": return { kind: "processing", nextAttemptAt: new Date(now.getTime() + SEAZN_POLL_BACKSTOP_MINUTES * MIN) };
    case "failed": return { kind: "failed", reason: "host_failed" };
    case "absent": return { kind: "lost" };
    case "playable": {
      const check = verifyReplayCopy(row, copy);
      if (!check.ok) return { kind: "failed", reason: check.reason };
      return { kind: "verified", verifiedAt: now, lengthSeconds: copy.lengthSeconds, nextAttemptAt: new Date(now.getTime() + SEAZN_CF_DELETE_DELAY_MINUTES * MIN) };
    }
  }
}
