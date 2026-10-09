import "server-only";
// The seat (spec §5.2, §3.2). A player is seated only when the MEETING
// reports them present in a live session — never on anything the client
// sends. The POC gated check-in on a client-supplied camera boolean; that is
// forgeable and is on the do-not-copy list (§10). There is no parameter here
// a browser could set.
//
// D12: the window hangs off `stage_round_opens.opened_at` (read through
// round-open.ts, the one reader of the stamp), not `fixtures.scheduled_at`.
// "The window has not started" is its OWN refusal (`round_not_open`), not
// `window_closed`: the room says different things about the two.
import { roomPhase } from "@/server/external-play/window";
import { roundOpenFor } from "@/server/external-play/round-open";
import { sql } from "@/lib/db";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import {
  addParticipant,
  ensureMeeting,
  hasLiveVideoPublisher,
  type ParticipantToken,
} from "@/server/external-play/video/realtimekit";
import { loadOnlinePlayFixture, loadSides, type SidePlayer } from "./guard";

export type SeatResult =
  | { seated: true; participant: ParticipantToken | null }
  | {
      seated: false;
      reason: "window_closed" | "not_a_player" | "round_not_open" | "fixture_not_playable";
    };

/** Test seam only — T9 and the room pass no deps. */
export type PreflightDeps = {
  now?: Date;
  video?: {
    ensureMeeting: typeof ensureMeeting;
    addParticipant: typeof addParticipant;
    hasLiveVideoPublisher: typeof hasLiveVideoPublisher;
  };
};

/** Controller ruling Q2 (2026-10-09): a board is playable only while it is
 *  `scheduled` or `in_play`. A withdrawal leaves it `abandoned` (league
 *  expunge, measured) or walked over, and `loadOnlinePlayFixture` still loads
 *  those settled-open statuses because spectator and room views must — so the
 *  SEAT refuses them here, and T9 reuses this when a create leaves the queue. */
export function isPlayableFixtureStatus(status: string): boolean {
  return status === "scheduled" || status === "in_play";
}

export async function seatPlayer(
  a: { fixtureId: string; personId: string },
  deps: PreflightDeps = {},
): Promise<SeatResult> {
  const now = deps.now ?? new Date();

  const f = await loadOnlinePlayFixture(a.fixtureId);
  // A fixture we do not serve and a caller who is not one of the two players
  // collapse to the SAME answer, so a probe cannot learn which check failed
  // (the same rule readMatchRoom follows, room.ts).
  if (!f) return { seated: false, reason: "not_a_player" };

  const { home, away } = await loadSides(f);
  const player: SidePlayer | undefined = [home, away].find((s) => s.personId === a.personId);
  // An empty side has `personId: null`; a null smuggled in as the caller's id
  // would otherwise "match" it.
  if (!player || player.personId === null) return { seated: false, reason: "not_a_player" };

  // Only now, to a confirmed player: a withdrawn or walked-over board.
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return { seated: false, reason: "fixture_not_playable" };

  const open = await roundOpenFor(sql, a.fixtureId);
  if (!open) return { seated: false, reason: "round_not_open" };
  const phase = roomPhase(now, open.roundOpenedAt);
  // "before" is a stamp more than T−10 in the future: the window has not
  // started, which is the round_not_open story, never "closed".
  if (phase === "before") return { seated: false, reason: "round_not_open" };
  if (phase === "closed") return { seated: false, reason: "window_closed" };

  const policy = await fixtureCameraPolicy(a.fixtureId);
  if (policy === "off") {
    // No meeting is created. Zero video spend (spec §5.1).
    return { seated: true, participant: null };
  }
  void deps.video;
  throw new Error("unimplemented: optional/required land in the next commit");
}
