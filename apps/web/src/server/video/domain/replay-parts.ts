// server/video/domain/replay-parts.ts — which of a fixture's recordings a viewer is offered, as which player, under which part
// number (Seazn-hosted video, Phase 2, Task 25). PURE: no database, no network, no clock of its own (the caller passes `now`).
//
// A fixture's recordings come from two places, merged by the Cloudflare video id: the recordings the Seazn pass LOCKED
// (`seazn_locked_videos`, Task 13: the interim replay of Task 14 signs these on Cloudflare) and the rows the replay move keeps
// (`fixture_video_replays`, Task 24: one per recording on its way to the replay host). One recording is at most ONE part:
//   * a row the organiser removed (state `deleted`, or `deleted_at` set) is no part at all, the interim included;
//   * a `playable` row is an `embed` part (the replay host's player) under its STORED part number, whether or not a locked row
//     exists, and only when the reader may see it (`listedVideo`: the public view's video id, or the organiser's own row's). A
//     playable row the reader may not see is no part: it never falls back to Cloudflare, whose copy the move deletes;
//   * a row still on its way (`found`, `downloading`, `fetching`, `encoding`) or `failed` keeps the interim `hls` part under its
//     STORED part number, when the recording is locked (only a locked uid is ever signed: Task 13's C3/C6);
//   * a locked recording discovery has not listed yet is an `hls` part under the number `partNumbers` gives it; once its programme
//     input is fully discovered (`replays_discovered_at`) and it still has no row, discovery finished without it (Cloudflare failed
//     it: there is nothing to move or play), and it is no part, its number kept unused.
// NUMBERING (`partNumbers`, the ONE authority: discovery stores exactly the number this gives, review I1): in recording order, a row's
// stored number stands; a recording with no row takes the running highest + 1 (stored or given, removed rows and parts the bound
// leaves out included), skipping any number a row of the fixture already holds. With no row at all this is Task 14's numbering
// exactly. Storing a recording's row under the number it was given moves no other number, so a part keeps its number through
// discovery whatever discovery skips (an errored recording, an input whose listing failed) or lists first (a later session).
// The 30-day bound (DELETE_RECORDING_AFTER_DAYS from the session's start: Cloudflare's own delete) applies to `hls` parts ONLY. A
// replay-host copy is not Cloudflare's and is not deleted with it. A part's number is given before the bound leaves it out, so a
// part keeps its number and a gap is left (Task 14's rule).
//
// ORDER: the caller passes the recordings in recording order (Task 14's rule: the session's created_at and id, then when the
// recording began, then when it was locked, then its id); the parts keep that order. Numbers may have gaps; they never move.
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";

const DAY_MS = 86_400_000;

/** One recording of the fixture: locked, listed by discovery, or both. */
export interface ReplayEntry {
  cfVideoId: string;
  sessionId: string;
  /** When the recording's session began: Cloudflare's delete counts from it. */
  sessionCreatedAt: Date;
  /** The Seazn pass locked it (`seazn_locked_videos`): its Cloudflare copy may be signed. */
  locked: boolean;
  /** Its programme input is fully discovered (`replays_discovered_at` set): a recording still without a row then never gets one. */
  inputDiscovered: boolean;
  /** Its `fixture_video_replays` row; null until discovery lists it. */
  row: {
    partNo: number;
    state: string;
    /** State `deleted`, or `deleted_at` set. */
    removed: boolean;
    /** The replay host's video id when the READER may play it (the public view's row, or the organiser's own playable row); else null. */
    listedVideo: string | null;
  } | null;
}

export type ReplayPart =
  | { partNo: number; player: "hls"; cfVideoId: string; sessionId: string }
  | { partNo: number; player: "embed"; bunnyVideoId: string; cfVideoId: string; sessionId: string };

/** What each V542 row state makes of its recording: the replay host's player, the interim recording, or nothing. One entry per state
 *  (the test holds the keys to replay-move.ts's REPLAY_ROW_STATES), so a state the schema gains and this table lacks is refused. */
export const PART_OF_STATE = {
  found: "hls", downloading: "hls", fetching: "hls", encoding: "hls", failed: "hls", playable: "embed", deleted: "none",
} as const satisfies Record<string, "hls" | "embed" | "none">;

/** A row state this table does not know: the schema gained one this module was not taught. Named, never guessed. */
export class UnknownReplayRowState extends Error {
  override readonly name = "UnknownReplayRowState";
  constructor(state: string) { super(`replay parts: a fixture_video_replays row is in state ${JSON.stringify(state)}, which PART_OF_STATE does not know`); }
}
/** A recording that is neither locked nor listed: the merge (a full join of the two) cannot make one. Named, never guessed. */
export class UnlistedUnlockedRecording extends Error {
  override readonly name = "UnlistedUnlockedRecording";
  constructor() { super("replay parts: a recording with no locked row and no replay row reached the merge"); }
}

const partOf = (state: string): "hls" | "embed" | "none" => {
  if (!Object.hasOwn(PART_OF_STATE, state)) throw new UnknownReplayRowState(state);
  return PART_OF_STATE[state as keyof typeof PART_OF_STATE];
};

/** Each recording's part number, by index, in the entries' (recording) order: a stored number stands; a recording with none takes
 *  the running highest + 1, skipping a number any row of the fixture holds. The ONE numbering rule: the merge reads it, and discovery
 *  stores exactly what it gives (see the header). */
export function partNumbers(entries: readonly { stored: number | null }[]): number[] {
  const held = new Set<number>();
  for (const e of entries) if (e.stored !== null) held.add(e.stored);
  let high = 0;
  return entries.map((e) => {
    if (e.stored !== null) {
      high = Math.max(high, e.stored);
      return e.stored;
    }
    let n = high + 1;
    while (held.has(n)) n++;   // a row stored out of order (written before this rule) is never shared
    high = n;
    return n;
  });
}

/** The parts a reader is offered, in the entries' (recording) order. See the header for the rules. */
export function replayParts(entries: readonly ReplayEntry[], now: Date): ReplayPart[] {
  const numbers = partNumbers(entries.map((e) => ({ stored: e.row === null ? null : e.row.partNo })));
  const cutoff = now.getTime() - DELETE_RECORDING_AFTER_DAYS * DAY_MS;
  const onCloudflare = (e: ReplayEntry) => e.locked && e.sessionCreatedAt.getTime() > cutoff;
  const parts: ReplayPart[] = [];
  for (const [i, e] of entries.entries()) {
    const ids = { cfVideoId: e.cfVideoId, sessionId: e.sessionId };
    if (e.row === null) {
      if (!e.locked) throw new UnlistedUnlockedRecording();
      // Numbered BEFORE the bound or the finished discovery leaves it out: a part keeps its number, a gap is left.
      if (!e.inputDiscovered && onCloudflare(e)) parts.push({ partNo: numbers[i]!, player: "hls", ...ids });
      continue;
    }
    const kind = partOf(e.row.state);
    if (e.row.removed || kind === "none") continue;
    if (kind === "embed") {
      if (e.row.listedVideo !== null) parts.push({ partNo: e.row.partNo, player: "embed", bunnyVideoId: e.row.listedVideo, ...ids });
      continue;
    }
    if (onCloudflare(e)) parts.push({ partNo: e.row.partNo, player: "hls", ...ids });
  }
  return parts;
}
