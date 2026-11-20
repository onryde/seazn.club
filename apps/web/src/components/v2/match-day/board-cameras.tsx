"use client";
// Both players' cameras for the board in focus (Match Day online, plan 2026-11-05-match-day-all-in-one.md Task 9; spec §6.1 "Cameras"): two
// tiles, White left by colour (the meeting is the SIDE's, `seatSide` maps the colour), each with the player's name, colour and presence mark
// and, where there is no video, the one word that says why. The joins are the shell's (`useArbiterJoins`, online/arbiter-joins.ts) - this is the
// view of what they answered, so a poll that replaces the board never re-joins anything.
//
// The words, one per state of the tile (`tileView` derives the state from the board's facts and the join's answer; the order is the Arbiter
// Panel's own): "Not checked in" (the side is not watchable: nothing is joined), "Connecting to video…" (joining), "Camera off since HH:MM"
// (present, camera off), "Waiting for capacity" (VIDEO_BUSY: the check-in line has first call on the vendor), "Video closed with the game".
// Chess only: every state here is a state of a player's camera meeting.
//
// Height is the scarce thing on a held board (MD-R33: "Your decision" above the fold at 1280x800 - measured, the whole strip may cost ~40px
// beside a 168-character reason), so a HELD board opens FOLDED to ONE line: each side's colour, presence mark and word, with the "Show video"
// press on the same line (the player's name is the tile's title and its screen-reader text; the board's own title carries both names).
// Every other board opens unfolded: a video box per player, the name and mark under it. Folding is only a view: the joins stay (a fold that
// left the meeting would cost a join to unfold, and the token is kept either way).
import { useId, useState } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { boardIsOver, type ArbiterBoard } from "@/lib/arbiter-view";
import { presenceMark } from "@/lib/match-day/online";
import type { MatchDayBoardRow } from "@/lib/match-day/types";
import { BUTTON_QUIET, type Fmt } from "../arbiter-flag-cards";
import { Mark } from "./board-row";
import { meetingKey, type JoinViews, type MeetingKey } from "./online/arbiter-joins";
import type { ArbiterSide } from "./online/arbiter-watch";
import { SeatVideo, sideWatchable, type ArbiterVideoView } from "./online/arbiter-video";

/** What one tile shows: the board's own facts first (policy, override, over, the side not watchable, the meeting ended), then what the join
 *  answered, and "connecting" while it has not. The order is `ArbiterPanel`'s (arbiter-panel.tsx `video`), so the two never disagree. */
export function tileView(board: Pick<ArbiterBoard, "fixtureId" | "cameraPolicy" | "videoOverridden" | "state" | "sides">, side: ArbiterSide, views: JoinViews): ArbiterVideoView {
  if (board.cameraPolicy === "off") return { kind: "none" };
  if (board.videoOverridden) return { kind: "overridden" };
  if (boardIsOver(board.state)) return { kind: "over" };
  const meeting = board.sides[side];
  if (meeting.state === "none" || (meeting.state === "open" && !sideWatchable(board, side))) return { kind: "notStarted" };
  if (meeting.state === "ended") return { kind: "ended" };
  return views.get(meetingKey(board.fixtureId, side)) ?? { kind: "connecting" };
}

type Tone = "live" | "off" | "wait" | "bad" | "quiet";

/** The word of a tile, with its tone. `f` reads the time of day in the venue's zone (null before mount: "Camera off" alone). */
export function tileWord(view: ArbiterVideoView, f: Fmt): { text: string; tone: Tone } {
  switch (view.kind) {
    case "watching": {
      if (view.tile.live) return { text: f.t("arbiter.tile.live"), tone: "live" };
      if (!view.tile.present) return { text: f.t("arbiter.tile.absent"), tone: "quiet" };
      const since = view.tile.offSinceMs !== null ? f.hm(new Date(view.tile.offSinceMs).toISOString()) : null;
      return { text: since !== null ? f.t("arbiter.tile.offSince", { time: since }) : f.t("arbiter.tile.off"), tone: "off" };
    }
    case "idle":
    case "connecting":
    case "switching":
      return { text: f.t("arbiter.tile.connecting"), tone: "wait" };
    case "notStarted":
      return { text: f.t("arbiter.tile.notCheckedIn"), tone: "wait" };
    case "busy":
      return { text: f.t("arbiter.tile.busy"), tone: "wait" };
    case "none":
      return { text: f.t("arbiter.tile.noCamera"), tone: "quiet" };
    case "overridden":
      return { text: f.t("arbiter.tile.overridden"), tone: "quiet" };
    case "over":
    case "ended":
      return { text: f.t("arbiter.tile.over"), tone: "quiet" };
    case "unavailable":
      return { text: f.t("arbiter.tile.unavailable"), tone: "bad" };
    case "fault":
      return { text: f.t("arbiter.tile.fault"), tone: "bad" };
    case "error":
      return { text: f.t("arbiter.tile.error"), tone: "bad" };
    case "own":
      return { text: f.t("arbiter.tile.own"), tone: "bad" };
  }
}

const WORD_ON_LIGHT: Record<Tone, string> = {
  live: "text-emerald-800",
  off: "text-amber-900",
  wait: "text-slate-700",
  bad: "text-red-800",
  quiet: "text-slate-600",
};

/** A tile whose press is "Try again": the guard left the meeting, or the join broke in a way a poll will not mend. */
const retryable = (view: ArbiterVideoView): boolean => view.kind === "error" || view.kind === "fault";

/** Whether the vendor is down for either tile: the one condition of "let this board play without video" (the outage card). */
export function anyUnavailable(board: Pick<ArbiterBoard, "fixtureId" | "cameraPolicy" | "videoOverridden" | "state" | "sides">, views: JoinViews): boolean {
  return (["home", "away"] as const).some((side) => tileView(board, side, views).kind === "unavailable");
}

export function BoardCameras({
  board,
  views,
  f,
  dict,
  onRetry,
}: {
  board: MatchDayBoardRow;
  views: JoinViews;
  f: Fmt;
  dict: Dict;
  /** "Try again" on a tile whose join failed. */
  onRetry(key: MeetingKey): void;
}) {
  const bodyId = useId();
  // A held board opens folded: the decision is what its organiser came for. The state is the panel's own, so a poll never refolds it.
  const [folded, setFolded] = useState(() => board.state.kind === "on_hold");
  const blackSide: ArbiterSide = board.whiteSide === "home" ? "away" : "home";
  // White first, so White is the left tile: the meeting is the SIDE's, the colour only says which side that is now (a pairing card can swap it).
  const seats = [
    { colour: "white" as const, side: board.whiteSide },
    { colour: "black" as const, side: blackSide },
  ];

  const colourWord = (colour: "white" | "black") => f.t(colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black");

  // Folded, the section is one wrapping row and the body drops out of the box tree (`contents`), so the two tiles and the toggle are siblings in
  // that row; the toggle keeps ONE place in the tree either way, so folding never moves focus off it.
  return (
    <section
      data-testid="md-cameras"
      data-folded={folded ? "true" : "false"}
      role="group"
      aria-label={f.t("matchDay.cameras.group")}
      className={folded ? "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" : "flex min-w-0 flex-col gap-1.5"}
    >
      <div id={bodyId} className={folded ? "contents" : "grid min-w-0 gap-2 sm:grid-cols-2"}>
        {seats.map(({ colour, side }) => {
          const view = tileView(board, side, views);
          const word = tileWord(view, f);
          const player = board[colour];
          const mark = presenceMark(board, side);
          const live = view.kind === "watching" && view.tile.live;
          const camOff = view.kind === "watching" && view.tile.present && !view.tile.live;
          const key = meetingKey(board.fixtureId, side);
          const caption = (
            <span className="flex min-w-0 items-center text-sm font-semibold text-[#2e1065]">
              <span className="min-w-0 truncate" title={player.name}>
                {player.name}
              </span>
              <Mark mark={mark} dict={dict} />
              <span className="shrink-0 whitespace-pre text-xs font-medium text-slate-600"> · {colourWord(colour)}</span>
            </span>
          );
          return (
            <figure
              key={colour}
              data-testid="md-camera-tile"
              data-colour={colour}
              data-side={side}
              data-view={view.kind}
              title={folded ? player.name : undefined}
              className={folded ? "m-0 flex min-w-0 items-center gap-1.5 text-xs leading-5" : "m-0 flex min-w-0 flex-col gap-1"}
            >
              {folded ? (
                <>
                  <span className="shrink-0 font-semibold text-[#2e1065]">
                    <span className="sr-only">{player.name} · </span>
                    {colourWord(colour)}
                  </span>
                  <Mark mark={mark} dict={dict} />
                  <span data-testid="md-camera-word" aria-live="polite" className={`min-w-0 [overflow-wrap:anywhere] ${WORD_ON_LIGHT[word.tone]}`}>
                    {word.text}
                  </span>
                </>
              ) : (
                <>
                  <div
                    aria-busy={view.kind === "connecting" || undefined}
                    className={`relative flex aspect-video w-full min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg bg-[#1b1230] ${camOff ? "border-2 border-[#f5d27a]" : ""}`}
                  >
                    {live ? (
                      <SeatVideo track={view.kind === "watching" ? view.tile.track : null} label={f.t("arbiter.tile.videoAria", { name: player.name })} />
                    ) : (
                      <span data-testid="md-camera-word" aria-live="polite" className="min-w-0 px-2 text-center text-xs font-semibold text-white [overflow-wrap:anywhere] lg:text-[13px]">
                        {word.text}
                      </span>
                    )}
                  </div>
                  {caption}
                </>
              )}
              {retryable(view) && (
                <button type="button" data-testid="md-camera-retry" onClick={() => onRetry(key)} className={`self-start ${BUTTON_QUIET}`}>
                  {f.t("arbiter.tile.retry")}
                </button>
              )}
            </figure>
          );
        })}
      </div>
      <button
        type="button"
        data-testid="md-cameras-toggle"
        aria-expanded={!folded}
        aria-controls={bodyId}
        onClick={() => setFolded((v) => !v)}
        className={`rounded-md px-1 text-xs font-semibold text-[#5b21b6] underline underline-offset-2 max-lg:min-h-11 max-lg:py-2.5 lg:py-0.5 ${folded ? "self-center" : "self-start"}`}
      >
        {f.t(folded ? "matchDay.cameras.show" : "matchDay.cameras.hide")}
      </button>
    </section>
  );
}
