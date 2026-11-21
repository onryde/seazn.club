"use client";
// The video rules a watched board runs on - the pure answers (what a pane shows, what a join's refusal means, which side is watchable) and the one
// element that draws a received camera. MOVED here from the Arbiter Panel (deleted with the page in Task 10) so
// Match Day's two tiles (board-cameras.tsx) and the join engine read ONE spelling of each rule, never a copy.
//
// Chess only: every rule below is about a board's camera meeting (D16: a meeting PER PLAYER, the arbiter in each one receive-only).
import { useEffect, useRef } from "react";
import { ApiV1Error } from "@/lib/client-v1";
import { boardIsOver, type ArbiterBoard } from "@/lib/arbiter-view";
import { outageOffered } from "../board-decision";
import { ArbiterGuardError, type ArbiterSeat, type ArbiterTileView } from "./arbiter-camera";
import type { ArbiterSide } from "./arbiter-watch";

export type ArbiterSeatVideo = { present: boolean; live: boolean; offSinceMs: number | null; track: MediaStreamTrack | null };

/** What a pane shows. `watching` is the only state with a camera. */
export type ArbiterVideoView =
  | { kind: "idle" }
  | { kind: "connecting" }
  /** A switch is under way: the other meeting is being left and this one joined (§5.6.4, awaited at each step). */
  | { kind: "switching" }
  | { kind: "watching"; tile: ArbiterSeatVideo }
  /** The player whose pane this is has not checked in: there is no meeting for the arbiter to join (it never makes one). */
  | { kind: "notStarted" }
  /** The board plays without cameras (policy off). */
  | { kind: "none" }
  /** An organiser let it play without video (D11). */
  | { kind: "overridden" }
  /** The game is over; the meeting closes with it. */
  | { kind: "over" }
  | { kind: "ended" }
  /** The video vendor is down (503 VIDEO_UNAVAILABLE). */
  | { kind: "unavailable" }
  /** The check-in line has first call on the vendor's budget and the pool is under the join floor (503 VIDEO_BUSY): not a failure, the join is
   *  asked again (arbiter-joins.ts's ladder in Match Day, the panel's own Try again). */
  | { kind: "busy" }
  /** This browser left: remote sound could not be refused. */
  | { kind: "fault" }
  /** The viewer plays on this board (C1, D7): never watched by them. The
   *  loader already hides such a board; this is the join route's answer when
   *  a re-seat lands between the two. */
  | { kind: "own" }
  | { kind: "error" };

/** A camera to watch: the policy asks for one, nobody let the board go
 *  without, and the game is not over. */
export function shouldJoinVideo(b: Pick<ArbiterBoard, "cameraPolicy" | "videoOverridden" | "state">): boolean {
  return b.cameraPolicy !== "off" && !b.videoOverridden && !boardIsOver(b.state);
}

/** The canvas's outage card ("Only during a video outage"): video required,
 *  the board still to be played, not already let go, and the join answered
 *  that the vendor is down. */
export function showsOutageCard(b: ArbiterBoard, video: ArbiterVideoView): boolean {
  return outageOffered(b, video.kind === "unavailable");
}

/** The join route's refusals (and the guard's), as tile states. */
export function arbiterJoinStateFromError(err: unknown): ArbiterVideoView {
  if (err instanceof ArbiterGuardError) return { kind: "fault" };
  if (err instanceof ApiV1Error) {
    switch (err.code) {
      case "VIDEO_UNAVAILABLE":
        return { kind: "unavailable" };
      case "VIDEO_NOT_IN_USE":
        return { kind: "none" };
      case "VIDEO_OVERRIDDEN":
        return { kind: "overridden" };
      case "VIDEO_MEETING_NOT_STARTED":
        return { kind: "notStarted" };
      case "VIDEO_MEETING_ENDED":
        return { kind: "ended" };
      case "ARBITER_PLAYS_THIS_BOARD":
        return { kind: "own" };
      case "FIXTURE_NOT_PLAYABLE":
        return { kind: "over" };
      case "VIDEO_BUSY":
        // Not an error: the check-in line is using the vendor's budget and this join waits its turn (Task 9 of the Match Day plan).
        return { kind: "busy" };
    }
  }
  return { kind: "error" };
}

/** The side (home/away) that plays this colour: the meeting is the SIDE's, the colour only its label (§5.6.4) - a pairing
 *  card can swap the colours after a player has arrived and the pane then stays on the same meeting. */
export function seatSide(board: Pick<ArbiterBoard, "whiteSide">, seat: ArbiterSeat): ArbiterSide {
  return seat === "white" ? board.whiteSide : board.whiteSide === "home" ? "away" : "home";
}

/** The colour a side plays now. */
export function sideSeat(board: Pick<ArbiterBoard, "whiteSide">, side: ArbiterSide): ArbiterSeat {
  return side === board.whiteSide ? "white" : "black";
}

/** Whether a side may be joined from the panel: its meeting is open AND the loader marks it joinable (its player has arrived). The join
 *  key, the tile's notStarted, the switch's refusal and `defaultWatchSide` all read this one rule instead of `state === "open"`. */
export function sideWatchable(board: Pick<ArbiterBoard, "sides">, side: ArbiterSide): boolean {
  const m = board.sides[side];
  return m.state === "open" && m.joinable;
}

/** After a poll hands a new `round`: re-open the current join when its answer was VIDEO_MEETING_NOT_STARTED while the side is still
 *  watchable (the guard behind the loader's monotonic facts: a side it calls joinable is refused only across a flag flip). Pure. */
export function rejoinAfterPoll(view: ArbiterVideoView | null, watchable: boolean): boolean {
  return watchable && view !== null && view.kind === "notStarted";
}

/** "Camera off since HH:MM": the instant THIS browser first saw a present
 *  player's camera off; held while it stays off, cleared when it is back or
 *  the player leaves (absent is its own tile). */
export function nextOffSince(prev: number | null, tile: Pick<ArbiterTileView, "present" | "live">, nowMs: number): number | null {
  if (!tile.present || tile.live) return null;
  return prev ?? nowMs;
}

/** A player's camera, received. Muted and inline: the arbiter never hears a
 *  board (the loader never subscribes audio; this is the second lock). */
export function SeatVideo({ track, label }: { track: MediaStreamTrack | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return <video ref={ref} autoPlay muted playsInline aria-label={label} className="absolute inset-0 h-full w-full object-cover" />;
}
