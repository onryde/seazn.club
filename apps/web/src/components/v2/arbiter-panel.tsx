"use client";
// T15 — the arbiter panel (chess design §5.3), built to the owner-approved
// canvas (ArbiterPhone, ArbiterDesktop: https://claude.ai/artifact/JKzKrtjSAPiU3QsFiRkEew).
// The organiser who opens it watches one board at a time, receive-only: ONE
// player's camera at a time (each player has a meeting of their own, D16 §5.6.4)
// with a White/Black switch, never their sound, never seen by them. Beside the
// pane, the board's flags — evidence, never a verdict — and the decision actions.
//
// One DOM, branched at `md` and `lg` (the canvas draws a 1280 desktop and a 320
// phone): below `md` the page is one flex column in the phone's order (the
// round column first, then the waiting list, the board picker, the board, the
// flags, the decision); from `md` the round column is a real column (spec
// 2026-10-24-arbiter-round-column-design.md §5.1) and the board and the decision
// stack in the first track beside it; at `lg` the three columns of the desktop
// artboard. The two groups below `md` are `display: contents`, so their children
// take the phone's order (`order-*`) in the one flex column; the column itself
// (an `aside`, a landmark) is one real box and is placed by name.
//
// `ArbiterScreen` is pure (props in, markup out — the unit suite renders it);
// `ArbiterPanel` is the shell: the decision reducer, the camera join, the
// clock tick and the poll. Every time of day renders only after mount: the
// server's timezone is not the arbiter's.
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { boardIsOver, offersSettle, type ArbiterBoard, type ArbiterFlag, type ArbiterRound } from "@/lib/arbiter-view";
import { extendEdgesOf, watchedWindows } from "@/lib/checkin-extend";
import { viewOfRound } from "@/lib/round-column";
import { formatClock, remainingMs } from "@/components/public-site/match-room/clock-math";
import { RoundColumn, WaitingList, type ColumnPlacement, type RoundColumnData } from "./arbiter/round-column";
import { browserBandPollDeps, startBandPolling } from "./desk/band-poll";
import { useOpenRound, type OpenRoundHandle } from "./desk/use-open-round";
import { useExtendClock } from "./use-extend-clock";
import {
  arbiterDecision,
  decisionRunner,
  initialArbiterDecision,
  type ArbiterDecisionAction,
  type ArbiterDecisionState,
  type SettleChoice,
} from "./arbiter-decision";
import {
  boardExtendOffer,
  extendBoardLabel,
  extendClosesLine,
  extendFailureText,
  extendHelperLine,
  extendRoundLabel,
  extendRoundLines,
  extendWhyLine,
  initialRoundExtend,
  linkedExtendDispatch,
  liveExtendableBoards,
  roundExtendRunner,
  roundExtendUi,
  roundExtendWhy,
  roundWhyLine,
  type RoundExtendState,
} from "./checkin-extend-ui";
import { ArbiterGuardError, joinArbiter, type ArbiterCameras, type ArbiterSeat, type ArbiterTileView } from "./arbiter-camera";
import { arbiterWatchRelease, makeArbiterSerial, type ArbiterJoinAnswer, type ArbiterSide } from "./arbiter-watch";
import {
  boardStateWord,
  BUTTON_QUIET,
  CameraReportCard,
  CARD,
  CHIP_NEUTRAL,
  CLOCK_FACE,
  FlagCard,
  MUTED,
  noticeLapsed,
  noticeSentence,
  settleChoices,
  settleGuidance,
  SETTLE_GUIDANCE_KEY,
  SOFT,
  useFmt,
  type Fmt,
} from "./arbiter-flag-cards";

// ── the view the screen paints ─────────────────────────────────────────────

export type ArbiterSeatVideo = { present: boolean; live: boolean; offSinceMs: number | null; track: MediaStreamTrack | null };

/** What the pane shows. `watching` is the only state with a camera. */
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
  /** This browser left: remote sound could not be refused. */
  | { kind: "fault" }
  /** The viewer plays on this board (C1, D7): never watched by them. The
   *  loader already hides such a board; this is the join route's answer when
   *  a re-seat lands between the two. */
  | { kind: "own" }
  | { kind: "error" };

export type ArbiterScreenProps = {
  round: ArbiterRound | null;
  /** I3: the board `?fixture=` asked for is not here, or is the viewer's own
   *  (the page then loads no round at all). */
  requested: "unavailable" | "own" | null;
  decision: ArbiterDecisionState;
  /** Spec §3.2.2: the round-wide "+5 min" - whether a request is in flight and the answer to the last one. */
  roundExtend: RoundExtendState;
  video: ArbiterVideoView;
  /** Which player's pane is on screen (or being switched to), by colour. The meeting is the SIDE's; the panel maps. */
  shown: ArbiterSeat;
  /** The viewer's clock; null before mount (no time of day is painted). */
  nowMs: number | null;
  slugs: { org: string; comp: string; div: string };
  /** What the page read for the round column: the open-able rounds, the organiser's queue, the venue zone (spec §5). */
  column: RoundColumnData;
  /** C9: the Open / Resend press of the round ON SCREEN, owned by `ArbiterPanel` (one `useOpenRound`) and read by both the check-in
   *  hero in the column and the waiting list, so a Resend on a row and the hero's reinvite are never in flight together. */
  openRound: OpenRoundHandle;
  on: {
    /** Any board of the round: a live one, a finished one, one on hold (the queue's "Review board N" offers all three). */
    select(fixtureId: string): void;
    /** A waiting row's "+5 min": select the board (so its answer lands in the decision area), then extend it. Does nothing at all while a
     *  request is in flight (the row's button is disabled then, too). */
    extendBoard(fixtureId: string): void;
    resync(): void;
    /** "Let the game go on" for the flags on screen, by id (ruling A). */
    goOn(flagIds: readonly string[]): void;
    toggleSettle(): void;
    settle(choice: SettleChoice): void;
    /** "+5 min" on the board on screen (spec §3.2.2). */
    extend(): void;
    /** "+5 min to the round": every board of it whose check-in is open. */
    extendRound(): void;
    override(): void;
    retryVideo(): void;
    /** The White/Black switch (§5.6.4): watch the other player. */
    switchTo(seat: ArbiterSeat): void;
  };
};

/** A camera to watch: the policy asks for one, nobody let the board go
 *  without, and the game is not over. */
export function shouldJoinVideo(b: ArbiterBoard): boolean {
  return b.cameraPolicy !== "off" && !b.videoOverridden && !boardIsOver(b.state);
}

/** The canvas's outage card ("Only during a video outage"): video required,
 *  the board still to be played, not already let go, and the join answered
 *  that the vendor is down. */
export function showsOutageCard(b: ArbiterBoard, video: ArbiterVideoView): boolean {
  return b.cameraPolicy === "required" && b.playable && !b.videoOverridden && video.kind === "unavailable";
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
    }
  }
  return { kind: "error" };
}

/** I2 (arbiter-watch.ts): the participant one open minted, handed back once whenever the pane closes. */
export { arbiterWatchRelease };

/** The side (home/away) that plays this colour: the meeting is the SIDE's, the colour only its label (§5.6.4) - a pairing
 *  card can swap the colours after a player has arrived and the pane then stays on the same meeting. */
export function seatSide(board: Pick<ArbiterBoard, "whiteSide">, seat: ArbiterSeat): ArbiterSide {
  return seat === "white" ? board.whiteSide : board.whiteSide === "home" ? "away" : "home";
}

/** The colour a side plays now. */
export function sideSeat(board: Pick<ArbiterBoard, "whiteSide">, side: ArbiterSide): ArbiterSeat {
  return side === board.whiteSide ? "white" : "black";
}

/** The side a board opens on when the arbiter has not chosen: White's, unless only the other has a room open. Read once
 *  and then held (the panel pins it), so a player arriving later never moves the pane under the arbiter's eyes. */
export function defaultWatchSide(board: Pick<ArbiterBoard, "whiteSide" | "sides">): ArbiterSide {
  const white = board.whiteSide;
  const other: ArbiterSide = white === "home" ? "away" : "home";
  return board.sides[white].state !== "open" && board.sides[other].state === "open" ? other : white;
}

/** "Camera off since HH:MM": the instant THIS browser first saw a present
 *  player's camera off; held while it stays off, cleared when it is back or
 *  the player leaves (absent is its own tile). */
export function nextOffSince(prev: number | null, tile: Pick<ArbiterTileView, "present" | "live">, nowMs: number): number | null {
  if (!tile.present || tile.live) return null;
  return prev ?? nowMs;
}

// ── the screen ─────────────────────────────────────────────────────────────

const INK = "text-[#2e1065]";

function names(b: ArbiterBoard, f: Fmt): string {
  return `${b.white.name} ${f.t("arbiter.vs")} ${b.black.name}`;
}

function flagCount(b: ArbiterBoard, f: Fmt): string | null {
  return b.flags.length > 0 ? f.plural("arbiter.flagCount", b.flags.length) : null;
}

export function ArbiterScreen(p: ArbiterScreenProps) {
  const f = useFmt(p.nowMs, p.column.tz);
  const back = routes.division(p.slugs.org, p.slugs.comp, p.slugs.div, "fixtures");
  const ids = { flags: useId(), decide: useId(), outage: useId(), board: useId(), boards: useId(), switch: useId() };
  const roundLine = p.round ? f.t("arbiter.roundLine", { stage: p.round.stageName, round: p.round.roundNo }) : null;
  const board = p.round?.boards.find((b) => b.fixtureId === p.decision.boardId) ?? null;
  // C13: the round's "+5 min" bar. Built once per path, never twice: with no round there is none.
  const roundBar = (variant: RoundBarVariant) =>
    p.round === null ? null : (
      <RoundExtend variant={variant} round={p.round} state={p.roundExtend} requestBusy={p.decision.busy !== null} nowMs={p.nowMs} onExtend={p.on.extendRound} f={f} />
    );
  // The column, with the bar it places by phase. `grid` on the board grid, `solo` on the paths with no grid (spec §5.1).
  const column = (placement: ColumnPlacement) => (
    <RoundColumn
      round={p.round}
      requested={p.requested}
      data={p.column}
      nowMs={p.nowMs}
      slugs={p.slugs}
      openRound={p.openRound}
      on={{ select: p.on.select, extendBoard: p.on.extendBoard }}
      roundExtend={roundBar("inline")}
      placement={placement}
    />
  );

  return (
    <div className={`min-w-0 bg-[#fdfcf8] ${INK}`}>
      <header className="flex h-[52px] min-w-0 items-center gap-1 border-b border-[#e7e3f3] pr-4 pl-1 lg:h-auto lg:min-h-16 lg:gap-4 lg:px-8 lg:py-2.5">
        <Link
          href={back}
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 text-sm text-[#2e1065] no-underline lg:justify-start lg:text-[#5b21b6]"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="max-lg:sr-only">{f.t("arbiter.back")}</span>
        </Link>
        <span aria-hidden="true" className="hidden h-6 w-px bg-[#e7e3f3] lg:block" />
        {/* T17B fix 2 (D4): on a desktop the watch-only line is the title's second row, never a third column beside
            it — beside it, it fought the round line for the row's width (and could run off the edge). */}
        <div className="flex min-w-0 flex-col lg:gap-0.5">
          <div className="flex min-w-0 flex-col lg:flex-row lg:items-center lg:gap-4">
            {roundLine && <span className={`truncate text-xs lg:text-sm ${MUTED}`}>{roundLine}</span>}
            <h1 className="m-0 text-[15px] font-semibold lg:text-base">{f.t("arbiter.title")}</h1>
          </div>
          {p.round && <p className={`m-0 hidden text-[13px] leading-[1.45] lg:block ${MUTED}`}>{f.t("arbiter.watchOnly")}</p>}
        </div>
      </header>

      {p.requested === null && p.round !== null && <RoundNotes round={p.round} slugs={p.slugs} f={f} />}
      {/* C13: exactly ONE round bar per page, placed by path. Check-in: the hero's. Playing, and the no-boards path: the status block's.
          Both are handed to the column below. Only the I3 branch of the chain below has no column, so only there does the bar keep the
          top of the page. */}
      {p.requested !== null ? (
        <RequestedNotice body={f.t(p.requested === "own" ? "arbiter.requested.own" : "arbiter.requested.unavailable")} slugs={p.slugs} f={f} />
      ) : p.round === null ? (
        <EmptyNotice title={f.t("arbiter.empty.title")} body={f.t("arbiter.empty.body")}>
          {column("solo")}
        </EmptyNotice>
      ) : p.round.boards.length === 0 && p.round.ownBoards > 0 ? (
        // C1 (D7): every board of the round is one the viewer plays on.
        <EmptyNotice title={null} body={f.t("arbiter.ownRound")}>
          {column("solo")}
        </EmptyNotice>
      ) : p.round.boards.length === 0 ? (
        <EmptyNotice title={null} body={f.t("arbiter.emptyBoards")}>
          {column("solo")}
        </EmptyNotice>
      ) : board === null ? (
        // I3: the board asked for (or on screen) is not in this round — said
        // so, never another board opened in its place. The one path with a round and no column, so the round's bar stays on top.
        <>
          {roundBar("bar")}
          <RequestedNotice body={f.t("arbiter.requested.unavailable")} slugs={p.slugs} f={f} />
        </>
      ) : (
        <main className="mx-auto flex w-full min-w-0 max-w-[1232px] flex-col gap-3 px-4 pt-3 pb-6 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:grid-rows-[auto_1fr] md:items-start md:gap-4 lg:grid-cols-[248px_minmax(0,1fr)_320px] lg:grid-rows-[auto_1fr] lg:gap-6 lg:p-6">
          <nav aria-labelledby={ids.boards} className="hidden min-w-0 flex-col gap-1.5 lg:col-start-1 lg:row-start-1 lg:row-span-2 lg:flex">
            <h2 id={ids.boards} className={`m-0 mb-1 text-xs font-semibold tracking-[0.06em] uppercase ${MUTED}`}>
              {f.t("arbiter.boardsHeading")}
            </h2>
            {p.round.boards.map((b) => {
              const pressed = b.fixtureId === board.fixtureId;
              const label = [f.t("arbiter.boardNo", { n: b.boardNo }), boardStateWord(b.state, f), flagCount(b, f)].filter(Boolean).join(" · ");
              return (
                <button
                  key={b.fixtureId}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => p.on.select(b.fixtureId)}
                  className={`flex min-h-14 min-w-0 cursor-pointer flex-col gap-0.5 rounded-[10px] text-left ${
                    pressed
                      ? "border-2 border-[#7c3aed] bg-[#f3effc] px-[11px] py-[7px]"
                      : `border bg-white px-3 py-2 ${b.state.kind === "on_hold" ? "border-[#f1c4c0]" : "border-[#e7e3f3]"}`
                  } ${INK}`}
                >
                  <span className="text-[13px] font-semibold">{label}</span>
                  <span className={`max-w-full min-w-0 truncate text-xs ${SOFT}`}>{names(b, f)}</span>
                </button>
              );
            })}
          </nav>

          {/* The track (Task 16 D4): ONE box from md to lg, the first grid track's flex column, holding the board group and the decision
              group so their children sort against each other - the decision above the waiting list. Below md and from lg it is `contents`
              and owns nothing. */}
          <div className="min-w-0 contents md:max-lg:col-start-1 md:max-lg:row-start-1 md:max-lg:flex md:max-lg:flex-col md:max-lg:gap-3">
            {/* The board group: the picker (below lg), the watch-only line, the heading, the camera, other reports and the waiting list. It is
                `contents` until lg (its children are the page's flex items below md, the track's from md), and at lg the middle track over
                both rows. */}
            <div
              data-testid="arbiter-board-group"
              className="min-w-0 contents lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:flex lg:flex-col lg:gap-3.5"
            >
              <label className={`flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold lg:hidden ${SOFT}`}>
                {f.t("arbiter.boardPicker")}
                <select
                  value={board.fixtureId}
                  onChange={(e) => p.on.select(e.target.value)}
                  className={`min-h-11 w-full min-w-0 rounded-[10px] border border-[#c9bdf0] bg-white px-3 text-[15px] font-normal ${INK}`}
                >
                  {p.round.boards.map((b) => (
                    <option key={b.fixtureId} value={b.fixtureId}>
                      {[f.t("arbiter.boardNo", { n: b.boardNo }), names(b, f), flagCount(b, f)].filter(Boolean).join(" · ")}
                    </option>
                  ))}
                </select>
              </label>
              <p className={`m-0 text-xs leading-[1.45] lg:hidden ${MUTED}`}>{f.t("arbiter.watchOnly")}</p>
              <div className="order-1 flex min-w-0 items-center justify-between gap-2 lg:items-baseline lg:gap-3">
                <h2 id={ids.board} className="m-0 min-w-0 text-xl font-semibold max-lg:sr-only">
                  {f.t("arbiter.boardNo", { n: board.boardNo })} · {board.white.name} <span className={`font-medium ${MUTED}`}>{f.t("arbiter.vs")}</span>{" "}
                  {board.black.name}
                </h2>
                <BoardStatus board={board} f={f} />
                {p.round.timeControl && <span className={`text-[13px] lg:hidden ${SOFT}`}>{p.round.timeControl}</span>}
              </div>
              <div className="order-2 flex min-w-0 flex-col gap-3 lg:gap-3.5">
                <Tile seat={p.shown} board={board} video={p.video} f={f} />
                <PlayerSwitch board={board} shown={p.shown} video={p.video} nowMs={p.nowMs} baseId={ids.switch} onSwitch={p.on.switchTo} f={f} />
                {/* The completed switch, and each refusal, said to assistive technology (§5.6.4). */}
                <p role="status" className="sr-only">
                  {statusSentence(p.video, board, p.shown, f)}
                </p>
              </div>
              {(p.video.kind === "fault" || p.video.kind === "error") && (
                <button type="button" onClick={p.on.retryVideo} className={`order-2 self-start ${BUTTON_QUIET}`}>
                  {f.t("arbiter.tile.retry")}
                </button>
              )}
              <OtherReports round={p.round} board={board} f={f} />
              {/* The seats that are not here: sorted by its own `order` classes (round-column.tsx), first of the page on a phone and under
                  the camera from md. Renders nothing at all outside a check-in with someone to wait for. */}
              <WaitingList
                boards={p.round.boards}
                view={viewOfRound(p.column.views, p.round)}
                openRound={p.openRound}
                nowMs={p.nowMs}
                requestBusy={p.decision.busy !== null || p.roundExtend.busy}
                on={{ select: p.on.select, extendBoard: p.on.extendBoard }}
              />
            </div>

            {/* The decision group: the flags, the decision and the outage card. `contents` until lg (the phone's flex column, then the track's:
                from md to lg their orders 5 to 7 put them after the camera and other reports and before the waiting list's 8), and at lg the
                right track's second row, under the column. */}
            <div
              data-testid="arbiter-decision-group"
              className="min-w-0 contents lg:col-start-3 lg:row-start-2 lg:flex lg:flex-col lg:gap-3.5"
            >
              <section aria-labelledby={ids.flags} className="order-3 flex min-w-0 flex-col gap-2.5 border-t border-[#e7e3f3] pt-3 md:max-lg:order-5 lg:border-t-0 lg:pt-0">
                <h2 id={ids.flags} className="m-0 text-[17px] font-semibold">
                  <span className="lg:hidden">{f.t("arbiter.flags.headingThis")}</span>
                  <span className="max-lg:hidden">{f.t("arbiter.flags.headingBoard", { n: board.boardNo })}</span>
                </h2>
                <p className={`m-0 text-xs leading-[1.45] lg:text-[13px] ${MUTED}`}>{f.t("arbiter.flags.lede")}</p>
                {board.flags.map((flag) => (
                  <FlagCard key={flag.id} flag={flag} f={f} />
                ))}
                {board.cameraReport === "pending" && (
                  <article className={`${CARD} border-[#e7e3f3]`}>
                    <span className={CHIP_NEUTRAL}>{f.t("arbiter.flag.pending.chip")}</span>
                    <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{f.t("arbiter.flag.pending.body")}</p>
                  </article>
                )}
                {board.flags.length === 0 && board.cameraReport !== "pending" && (
                  <p className={`m-0 text-[13px] ${SOFT}`}>{f.t("arbiter.flags.none")}</p>
                )}
              </section>
              <Decision board={board} decision={p.decision} roundBusy={p.roundExtend.busy} nowMs={p.nowMs} slugs={p.slugs} on={p.on} f={f} headingId={ids.decide} />
              {showsOutageCard(board, p.video) && (
                <section aria-labelledby={ids.outage} className="order-6 flex min-w-0 flex-col gap-2 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12] md:max-lg:order-7">
                  <span className="text-[11px] font-semibold tracking-[0.06em] uppercase">{f.t("arbiter.outage.eyebrow")}</span>
                  <h2 id={ids.outage} className="m-0 text-[15px] font-semibold">
                    {f.t("arbiter.outage.title")}
                  </h2>
                  <p className="m-0 text-[13px] leading-[1.45]">{f.t("arbiter.outage.body")}</p>
                  <button
                    type="button"
                    onClick={p.on.override}
                    disabled={p.decision.busy !== null}
                    aria-busy={p.decision.busy?.kind === "override" || undefined}
                    className="min-h-11 cursor-pointer rounded-[10px] bg-[#713f12] px-3 text-[15px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {f.t("arbiter.outage.cta")}
                  </button>
                </section>
              )}
            </div>
          </div>

          {/* The round column: last in the DOM, placed by name (round-column.tsx), the first thing on a phone and the second track from
              md. Never inside either group: a landmark is not `display: contents`. */}
          {column("grid")}
        </main>
      )}
    </div>
  );
}

/** A notice with nothing to watch, and the round column beside it: from md `main` is two tracks (the notice, the column); below md
 *  the column leads (it carries the press that fixes the notice). `children` is the column. */
function EmptyNotice({ title, body, children }: { title: string | null; body: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full min-w-0 max-w-[1232px] flex-col gap-3 px-4 py-6 md:grid md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:gap-4 lg:gap-6 lg:p-6">
      <div className="flex min-w-0 flex-col gap-2 md:col-start-1 md:row-start-1">
        {title && <h2 className="m-0 text-[17px] font-semibold">{title}</h2>}
        <p className={`m-0 max-w-prose text-sm leading-[1.5] ${SOFT}`}>{body}</p>
      </div>
      {children}
    </main>
  );
}

/** Re-review 1. N1: a `?fixture=` (a deep link, or a reload after a pick)
 *  keeps its board's round; when that round is not the division's most
 *  recently opened one, say so and offer the current round — the board stays
 *  on screen. N3: boards left out because the viewer plays on them (C1) get
 *  one line, so skipped board numbers are explained; when EVERY board is
 *  theirs the "you're playing" state says it instead. Nothing at all when
 *  neither holds. */
function RoundNotes({ round, slugs, f }: { round: ArbiterRound; slugs: ArbiterScreenProps["slugs"]; f: Fmt }) {
  const older = !round.current;
  const hidden = round.boards.length > 0 && round.ownBoards > 0;
  if (!older && !hidden) return null;
  return (
    <div data-arbiter-notes="" className="mx-auto flex w-full max-w-[1232px] min-w-0 flex-col items-start gap-2 px-4 pt-3 lg:px-6 lg:pt-5">
      {older && (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-x-4 rounded-[10px] border border-[#e7e3f3] bg-[#f3effc] px-3 py-1">
          <p className={`m-0 min-w-0 text-sm leading-[1.5] ${INK}`}>{f.t("arbiter.olderRound")}</p>
          <Link
            href={routes.divisionArbiter(slugs.org, slugs.comp, slugs.div)}
            className="flex min-h-11 items-center text-sm font-semibold text-[#5b21b6] underline underline-offset-2"
          >
            {f.t("arbiter.requested.current")}
          </Link>
        </div>
      )}
      {hidden && <p className={`m-0 min-w-0 text-[13px] leading-[1.45] ${MUTED}`}>{f.plural("arbiter.ownHidden", round.ownBoards)}</p>}
    </div>
  );
}

/** Where the bar is drawn. `bar` is the top of the page (the I3 path, the one with no column to hold it); `inline` is a block inside the
 *  column (the check-in hero, the playing status), whose own card already pads and bounds it. */
type RoundBarVariant = "bar" | "inline";
const ROUND_BAR_BOX: Record<RoundBarVariant, string> = {
  bar: "mx-auto flex w-full max-w-[1232px] min-w-0 flex-col items-start gap-1.5 px-4 pt-3 lg:px-6 lg:pt-5",
  inline: "flex w-full min-w-0 flex-col items-start gap-1.5",
};
// `inline` is the round card's button, side by side with the round's press (round-column.tsx): both fill the card and are capped at the
// same width below md, so the two read as one pair of buttons rather than one stretched and one label-wide (Task 16 D5).
const ROUND_BAR_BUTTON: Record<RoundBarVariant, string> = { bar: "w-full lg:w-auto", inline: "w-full max-md:max-w-sm" };

/** Spec §3.2.2: "+5 min to the round" at the top of the panel - one press gives every board of the round whose check-in is open
 *  five more minutes, and the answer says how many and why the rest were left alone. Offered while at least one board would
 *  accept it - the server's own reading of each board (`checkin.refusal`), re-asked of the TICKING clock (owner, 2026-10-19: +5 only
 *  inside the check-in window, to the millisecond) - and, once pressed, for as long as its answer is on screen. */
function RoundExtend({
  variant,
  round,
  state,
  requestBusy,
  nowMs,
  onExtend,
  f,
}: {
  variant: RoundBarVariant;
  round: ArbiterRound;
  state: RoundExtendState;
  requestBusy: boolean;
  nowMs: number | null;
  onExtend: () => void;
  f: Fmt;
}) {
  const lines =
    state.notice === null ? [] : state.notice.kind === "answered" ? extendRoundLines(state.notice.result, f) : [extendFailureText(state.notice.code, f)];
  const reach = liveExtendableBoards(round.boards, nowMs, round.extendableBoards);
  const offered = reach > 0 || state.busy;
  // Where the button is not offered, the reason stands in its place (owner, 2026-10-19), never a bar that silently vanishes: the one
  // cause every board gives, or "No board can be extended right now" when they differ. Nothing for a round that lists no boards.
  const why = offered ? null : roundExtendWhy(round.boards, nowMs);
  if (!offered && lines.length === 0 && why === null) return null;
  return (
    <div data-testid="arbiter-extend-round" className={ROUND_BAR_BOX[variant]}>
      {offered && (
        <>
          <button
            type="button"
            data-testid="arbiter-extend-round-cta"
            onClick={onExtend}
            disabled={state.busy || requestBusy}
            aria-busy={state.busy || undefined}
            className={`${BUTTON_QUIET} ${ROUND_BAR_BUTTON[variant]}`}
          >
            {state.busy ? f.t("externalPlay.checkinExtend.busy") : extendRoundLabel(f)}
          </button>
          <p data-testid="arbiter-extend-round-helper" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendHelperLine(f)}
            {reach > 0 && <> {f.plural("externalPlay.checkinExtend.roundHint", reach)}</>}
          </p>
        </>
      )}
      {why !== null && (
        <p data-testid="arbiter-extend-round-why" data-why={why.code} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
          {roundWhyLine(why, f)}
        </p>
      )}
      <div role="status" data-testid="arbiter-extend-round-notice" className={`flex min-w-0 flex-col gap-0.5 text-[13px] leading-[1.45] ${SOFT}`}>
        {lines.map((line, i) => (
          <p key={i} className="m-0">
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function RequestedNotice({ body, slugs, f }: { body: string; slugs: ArbiterScreenProps["slugs"]; f: Fmt }) {
  return (
    <main className="mx-auto flex w-full max-w-[1232px] flex-col items-start gap-3 px-4 py-6 lg:p-6">
      <p className={`m-0 max-w-prose text-sm leading-[1.5] ${SOFT}`}>{body}</p>
      <Link
        href={routes.divisionArbiter(slugs.org, slugs.comp, slugs.div)}
        className="flex min-h-11 items-center text-sm font-semibold text-[#5b21b6] underline underline-offset-2"
      >
        {f.t("arbiter.requested.current")}
      </Link>
    </main>
  );
}

function BoardStatus({ board, f }: { board: ArbiterBoard; f: Fmt }) {
  if (board.state.kind === "live") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-[#b42318] lg:text-sm">
        <span aria-hidden="true" className="size-2 rounded-full bg-[#b42318]" />
        {f.t("arbiter.status.live", { move: board.state.moveNo })}
      </span>
    );
  }
  const word =
    board.state.kind === "checking_in"
      ? f.t("arbiter.status.checkingIn")
      : board.state.kind === "starting"
        ? f.t("arbiter.status.starting")
        : board.state.kind === "on_hold"
          ? f.t("arbiter.status.onHold")
          : board.state.kind === "cancelled"
            ? f.t("arbiter.status.cancelled")
            : board.state.noResult
              ? f.t("arbiter.status.noResult")
              : board.state.score !== null
                ? f.t("arbiter.status.result", { score: board.state.score })
                : f.t("arbiter.status.over");
  return <span className={`shrink-0 text-[13px] font-semibold lg:text-sm ${SOFT}`}>{word}</span>;
}

function seatClock(board: ArbiterBoard, seat: ArbiterSeat, nowMs: number | null): string | null {
  const c = board.clock;
  if (c === null) return null;
  const baseMs = seat === "white" ? c.whiteMs : c.blackMs;
  const asOfMs = c.asOf ? Date.parse(c.asOf) : NaN;
  const running = c.running && c.turn === seat && nowMs !== null && Number.isFinite(asOfMs);
  return formatClock(remainingMs({ baseMs, asOfMs: Number.isFinite(asOfMs) ? asOfMs : 0, nowMs: nowMs ?? 0, running }));
}

const colourWord = (seat: ArbiterSeat, f: Fmt) => f.t(seat === "white" ? "arbiter.colour.white" : "arbiter.colour.black");

/** The sentence a pane says when it has no camera to show (or, for `switching`, while it is getting one). */
function paneSentence(video: Exclude<ArbiterVideoView, { kind: "watching" }>, name: string, seat: ArbiterSeat, f: Fmt): string {
  switch (video.kind) {
    case "idle":
    case "connecting":
      return f.t("arbiter.tile.connecting");
    case "switching":
      return f.t("arbiter.switch.switching", { colour: colourWord(seat, f) });
    case "notStarted":
      return f.t("arbiter.tile.notStarted", { name });
    case "none":
      return f.t("arbiter.tile.noCamera");
    case "overridden":
      return f.t("arbiter.tile.overridden");
    case "over":
    case "ended":
      return f.t("arbiter.tile.over");
    case "unavailable":
      return f.t("arbiter.tile.unavailable");
    case "fault":
      return f.t("arbiter.tile.fault");
    case "error":
      return f.t("arbiter.tile.error");
    case "own":
      return f.t("arbiter.tile.own");
  }
}

/** What the live region says: the pane that is now showing, or why it is not. */
function statusSentence(video: ArbiterVideoView, board: ArbiterBoard, seat: ArbiterSeat, f: Fmt): string {
  const name = board[seat].name;
  return video.kind === "watching"
    ? f.t("arbiter.switch.watching", { colour: colourWord(seat, f), name })
    : paneSentence(video, name, seat, f);
}

/** The one pane: the camera of the player whose meeting the arbiter is in (name and colour under it). */
function Tile({ seat, board, video, f }: { seat: ArbiterSeat; board: ArbiterBoard; video: ArbiterVideoView; f: Fmt }) {
  const player = board[seat];
  const colour = colourWord(seat, f);
  const v = video.kind === "watching" ? video.tile : null;
  const live = v !== null && v.live;
  const amber = v !== null && !v.live;
  let body: ReactNode;
  if (live) {
    body = (
      <>
        <SeatVideo track={v.track} label={f.t("arbiter.tile.videoAria", { name: player.name })} />
        <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-md bg-[rgba(27,18,48,0.7)] px-2 py-[3px] text-xs text-white lg:top-2.5 lg:left-2.5">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-[#4ade80]" />
          {f.t("arbiter.tile.live")}
        </span>
      </>
    );
  } else {
    const since = v?.present && v.offSinceMs !== null ? f.hm(new Date(v.offSinceMs).toISOString()) : null;
    const sentence =
      v !== null
        ? v.present
          ? since
            ? f.t("arbiter.tile.offSince", { time: since })
            : f.t("arbiter.tile.off")
          : f.t("arbiter.tile.absent")
        : video.kind !== "watching"
          ? paneSentence(video, player.name, seat, f)
          : f.t("arbiter.tile.absent");
    body = (
      <>
        {amber && <CameraOffIcon />}
        <span className="px-3 text-center text-sm font-semibold text-white lg:text-[15px]">{sentence}</span>
      </>
    );
  }
  return (
    <figure className="m-0 flex min-w-0 max-w-[640px] flex-col gap-1.5 lg:gap-2">
      <div
        aria-busy={video.kind === "switching" || video.kind === "connecting" || undefined}
        className={`relative flex aspect-video w-full min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-[#1b1230] lg:gap-2.5 ${
          amber ? "border-2 border-[#f5d27a]" : ""
        }`}
      >
        {body}
      </div>
      <figcaption className="flex min-w-0 text-sm font-semibold lg:text-[15px]">
        {/* The colour never truncates with a long name: it is the word saying which player this pane is. */}
        <span className="min-w-0 truncate">{player.name}</span>
        <span className="shrink-0 whitespace-pre"> · {colour}</span>
      </figcaption>
    </figure>
  );
}

/** The White/Black switch (§5.6.4): watch the other player. Both players are always listed with their clocks (a camera
 *  pane shows one at a time, a game is two clocks). Where there is a camera to watch each is a toggle button whose
 *  accessible name says the colour AND the player; a side whose room is not open is `aria-disabled` and says why in
 *  words - it stays focusable, so the reason is reachable from the keyboard. Where there is none (no camera on the
 *  board, let go, over) the same rows are plain text. */
function PlayerSwitch({
  board,
  shown,
  video,
  nowMs,
  baseId,
  onSwitch,
  f,
}: {
  board: ArbiterBoard;
  shown: ArbiterSeat;
  video: ArbiterVideoView;
  nowMs: number | null;
  baseId: string;
  onSwitch: (seat: ArbiterSeat) => void;
  f: Fmt;
}) {
  const interactive = shouldJoinVideo(board);
  return (
    <div
      data-arbiter-switch=""
      role={interactive ? "group" : undefined}
      aria-label={interactive ? f.t("arbiter.switch.group") : undefined}
      className="grid max-w-[640px] min-w-0 grid-cols-2 gap-2 lg:gap-3">
      {(["white", "black"] as const).map((seat) => {
        const player = board[seat];
        const clock = seatClock(board, seat, nowMs);
        const sideState = board.sides[seatSide(board, seat)].state;
        const unavailable = interactive && sideState !== "open";
        const pressed = seat === shown;
        const reasonId = `${baseId}-${seat}`;
        const inner = (
          <>
            <span className="flex min-w-0 text-[13px] font-semibold lg:text-sm">
              <span className="shrink-0 whitespace-pre">{colourWord(seat, f)} · </span>
              <span className="min-w-0 truncate">{player.name}</span>
            </span>
            {clock !== null && <span className={`text-xl lg:text-[26px] ${CLOCK_FACE}`}>{clock}</span>}
            {unavailable && (
              <span id={reasonId} className={`text-xs ${MUTED}`}>
                {f.t(sideState === "ended" ? "arbiter.switch.ended" : "arbiter.switch.none")}
              </span>
            )}
          </>
        );
        const base = "flex min-h-14 min-w-0 flex-col justify-center gap-0.5 rounded-[10px] px-3 py-1.5 text-left";
        if (!interactive) {
          return (
            <div key={seat} className={`${base} border border-[#e7e3f3] bg-white ${INK}`}>
              {inner}
            </div>
          );
        }
        return (
          <button
            key={seat}
            type="button"
            aria-pressed={pressed}
            aria-disabled={unavailable || undefined}
            aria-describedby={unavailable ? reasonId : undefined}
            aria-busy={pressed && video.kind === "switching" ? true : undefined}
            onClick={() => {
              if (!unavailable && !pressed) onSwitch(seat);
            }}
            className={`${base} cursor-pointer aria-disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed] ${
              pressed
                ? "border-2 border-[#7c3aed] bg-[#f3effc] px-[11px] py-[5px]"
                : unavailable
                  ? "border border-dashed border-[#c9bdf0] bg-[#faf8ff]"
                  : "border border-[#e7e3f3] bg-white"
            } ${INK}`}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

function CameraOffIcon() {
  return (
    <svg className="size-9 lg:size-10" viewBox="0 0 24 24" fill="none" stroke="#f5d27a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h12v10H3z" />
      <path d="M15 10l6-3v10l-6-3" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

/** A player's camera, received. Muted and inline: the arbiter never hears a
 *  board (the loader never subscribes audio; this is the second lock). */
function SeatVideo({ track, label }: { track: MediaStreamTrack | null; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);
  return <video ref={ref} autoPlay muted playsInline aria-label={label} className="absolute inset-0 h-full w-full object-cover" />;
}

/** The canvas's "Board 2 · camera report": another board's camera report,
 *  so the arbiter sees it without leaving the board on screen. */
function OtherReports({ round, board, f }: { round: ArbiterRound; board: ArbiterBoard; f: Fmt }) {
  const others = round.boards
    .filter((b) => b.fixtureId !== board.fixtureId)
    .map((b) => ({ b, reports: b.flags.filter((x): x is Extract<ArbiterFlag, { kind: "camera_lost" }> => x.kind === "camera_lost") }))
    .filter((o) => o.reports.length > 0);
  if (others.length === 0) return null;
  return (
    <div className="order-4 flex min-w-0 flex-col gap-3 lg:border-t lg:border-[#e7e3f3] lg:pt-3.5">
      {others.map(({ b, reports }) => (
        <section key={b.fixtureId} className="flex min-w-0 flex-col gap-2">
          <h2 className="m-0 text-[15px] font-semibold">{f.t("arbiter.otherReport.heading", { n: b.boardNo })}</h2>
          {reports.map((r) => (
            <CameraReportCard key={r.id} flag={r} f={f} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Decision({
  board,
  decision,
  roundBusy,
  nowMs,
  slugs,
  on,
  f,
  headingId,
}: {
  board: ArbiterBoard;
  decision: ArbiterDecisionState;
  /** The round-wide "+5 min" is in flight: one request at a time across the panel. */
  roundBusy: boolean;
  /** The viewer's ticking clock (null before it is known): the "+5 min" is offered inside the check-in window and nowhere else. */
  nowMs: number | null;
  slugs: ArbiterScreenProps["slugs"];
  on: ArbiterScreenProps["on"];
  f: Fmt;
  headingId: string;
}) {
  const settlePanel = useId();
  const over = boardIsOver(board.state);
  const canResync = board.canResync;
  // R4 (T16 fix round 1): an open flag is closable whether or not the game is over — job 5 raises camera flags AFTER
  // the game, so a finished board is the usual home of one. Over, the words are the queue's: the game cannot go on.
  const canGoOn = board.flags.length > 0;
  // Settled here when an online game is on file (a bridge row); a board
  // nobody reached has none, and keeps T15's way to its match page.
  const canSettle = offersSettle(board);
  // The reducer owns "a notice belongs to the board on screen" (R4: a switch
  // clears it, an answer for the board left behind shows nothing).
  // An "extended" answer that names a closing time the ticking clock has reached stops showing (`noticeLapsed`).
  const notice = decision.notice !== null && !noticeLapsed(decision.notice, board.checkin?.deadlineAt ?? null, nowMs) ? decision.notice : null;
  // Spec §3.2.2: offered only on what the server's own reading of the board said it would accept, re-asked of the ticking clock: the
  // snapshot is up to a poll old, and "+5 min" exists only between the board's opening and its deadline (owner, 2026-10-19). Where it
  // is not offered, a short reason stands in its place (never a button that silently vanishes).
  const offer = boardExtendOffer(board.checkin, nowMs);
  const extend = offer !== null && offer.offered ? board.checkin : null;
  const why = offer !== null && offer.refusal !== null ? extendWhyLine(offer.refusal, f) : null;
  if (!canResync && !canGoOn && !canSettle && extend === null && why === null && notice === null) return null;
  const busy = decision.busy !== null || roundBusy;
  const guidance = settleGuidance(board);
  return (
    <section aria-labelledby={headingId} data-testid="arbiter-decision" className="order-5 flex min-w-0 flex-col gap-2 border-t border-[#e7e3f3] pt-3 md:max-lg:order-6 lg:pt-3.5">
      <h2 id={headingId} className="m-0 text-[17px] font-semibold">
        <span className="lg:hidden">{f.t("arbiter.decide.headingBoard", { n: board.boardNo })}</span>
        <span className="max-lg:hidden">{f.t("arbiter.decide.heading")}</span>
      </h2>
      {extend !== null && (
        <>
          <button
            type="button"
            data-testid="arbiter-extend-board"
            onClick={on.extend}
            disabled={busy}
            aria-busy={decision.busy?.kind === "extend" || undefined}
            className={BUTTON_QUIET}
          >
            {decision.busy?.kind === "extend" ? f.t("externalPlay.checkinExtend.busy") : extendBoardLabel(extend.extensionsLeft, f)}
          </button>
          <p data-testid="arbiter-extend-closes" data-deadline-at={extend.deadlineAt} className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendClosesLine(extend.deadlineAt, f)}
          </p>
          <p data-testid="arbiter-extend-helper" className={`m-0 text-xs leading-[1.45] ${MUTED}`}>
            {extendHelperLine(f)}
          </p>
        </>
      )}
      {why !== null && offer !== null && (
        <p data-testid="arbiter-extend-why" data-why={offer.refusal} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
          {why}
        </p>
      )}
      {canResync && (
        <button type="button" onClick={on.resync} disabled={busy} aria-busy={decision.busy?.kind === "resync" || undefined} className={BUTTON_QUIET}>
          {f.t("arbiter.decide.resync")}
        </button>
      )}
      {canGoOn && (
        <button
          type="button"
          onClick={() => on.goOn(board.flags.map((x) => x.id))}
          disabled={busy}
          aria-busy={decision.busy?.kind === "goOn" || undefined}
          className={BUTTON_QUIET}
        >
          {over ? f.t("externalPlay.queue.markReviewed") : f.t("arbiter.decide.goOn")}
        </button>
      )}
      {canSettle && (
        <>
          <button
            type="button"
            onClick={on.toggleSettle}
            aria-expanded={decision.settleOpen}
            aria-controls={settlePanel}
            className="min-h-11 cursor-pointer rounded-[10px] bg-[#7c3aed] px-3 text-[15px] font-semibold text-white"
          >
            {f.t("arbiter.decide.settle")}
          </button>
          {decision.settleOpen && !board.canSettle && board.fixtureNo !== null && (
            <div id={settlePanel} className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-[#e7e3f3] bg-white p-3 text-sm">
              <p className={`m-0 leading-[1.45] ${SOFT}`}>{f.t("arbiter.decide.settleElsewhere")}</p>
              <Link href={routes.fixture(slugs.org, slugs.comp, slugs.div, board.fixtureNo)} className="min-h-11 content-center font-semibold text-[#5b21b6]">
                {f.t("arbiter.decide.settleLink", { n: board.boardNo })}
              </Link>
            </div>
          )}
          {decision.settleOpen && board.canSettle && (
            <fieldset
              id={settlePanel}
              data-testid="arbiter-settle"
              className="m-0 flex min-w-0 flex-col gap-2 rounded-[10px] border border-[#e7e3f3] bg-white p-3 text-sm"
            >
              <legend className="float-left mb-0.5 w-full p-0 text-[15px] font-semibold">
                {board.tiebreakOwed ? f.t("externalPlay.settle.pickLegend") : f.t("externalPlay.settle.legend")}
              </legend>
              <p className={`m-0 leading-[1.45] ${SOFT}`}>
                {board.tiebreakOwed ? f.t("arbiter.decide.tiebreakBody") : f.t("arbiter.decide.settleBody")}
              </p>
              <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                {settleChoices(
                  { whiteSide: board.whiteSide, whiteName: board.white.name, blackName: board.black.name, tiebreakOwed: board.tiebreakOwed, noResultOffer: board.noResultOffer },
                  f,
                ).map((c, _i, all) => {
                  // M-5: the side column is narrow, so no label is ever cut — each wraps, and each takes a row of its
                  // own (a winner's name in full, then its verb) except Draw and No result, the one pair that shares a
                  // row. A Draw with no No result beside it spans too, never left half-width alone.
                  const sharesRow = (c.choice === "draw" || c.choice === "no_result") && all.some((x) => x.choice === "no_result");
                  return (
                    <button
                      key={c.choice}
                      type="button"
                      data-settle={c.choice}
                      onClick={() => on.settle(c.choice)}
                      disabled={busy}
                      aria-busy={decision.busy?.kind === "settle" || undefined}
                      className={`${BUTTON_QUIET} min-w-0 break-words py-2${sharesRow ? "" : " min-[360px]:col-span-2"}`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {guidance !== null && (
                <p data-testid="arbiter-settle-guidance" data-why={guidance} className={`m-0 text-[13px] leading-[1.45] ${SOFT}`}>
                  {f.t(SETTLE_GUIDANCE_KEY[guidance])}
                </p>
              )}
            </fieldset>
          )}
        </>
      )}
      <p role="status" className={`m-0 min-h-0 text-[13px] leading-[1.45] ${SOFT}`}>
        {notice ? noticeSentence(notice, f, over, board.checkin?.deadlineAt ?? null) : null}
      </p>
    </section>
  );
}

// ── the shell ──────────────────────────────────────────────────────────────

/** What the panel writes to the audit log with a video override (D11): a
 *  record, not copy — the organiser's reason as the arbiter panel states it. */
export const ARBITER_OVERRIDE_NOTE = "Video unavailable: let this board play without video from the arbiter panel.";

/** The one chain every pane's open and close is queued on (arbiter-watch.ts): module-level, so even a remount of the
 *  panel hands the old participant back before the new one is joined. */
const browserSerial = makeArbiterSerial({
  join: (fixtureId, side) =>
    apiV1<ArbiterJoinAnswer>(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter`, { method: "POST", json: { side } }),
  connect: joinArbiter,
  send: (url, init) => apiV1(url, init),
});

/** True when the last answer on screen belongs to the OTHER side of the same board: a switch is in flight, not a first
 *  connect or a retry. */
export function switchingFrom(lastKey: string | null, fixtureId: string, side: ArbiterSide | null): boolean {
  if (lastKey === null || side === null) return false;
  const m = /^(.+):(home|away)#\d+$/.exec(lastKey);
  return m !== null && m[1] === fixtureId && m[2] !== side;
}

export function ArbiterPanel({
  round,
  requested,
  slugs,
  initialFixtureId,
  column,
}: {
  round: ArbiterRound | null;
  requested: ArbiterScreenProps["requested"];
  slugs: ArbiterScreenProps["slugs"];
  initialFixtureId: string | null;
  /** The round column's data, read server-side by the page. Required: a panel handed nothing would paint an empty column that
   *  looks like "no round is paired" when the page simply forgot to read one. */
  column: RoundColumnData;
}) {
  const router = useRouter();
  // I3: the board asked for, EXACTLY — absent from the round, the screen
  // says so rather than opening another. With nothing asked for, the first.
  const firstBoard = initialFixtureId ?? round?.boards[0]?.fixtureId ?? null;
  const [decision, dispatch] = useReducer(arbiterDecision, firstBoard, initialArbiterDecision);
  const [roundExtend, dispatchRound] = useReducer(roundExtendUi, undefined, initialRoundExtend);
  // A navigation that lands on this same panel (the notice's "current round"
  // link, back/forward) brings a new target with the SAME instance: follow
  // it, adjusting during render (React's "previous props" pattern). A board
  // picked here already matches its own URL, so a refresh moves nothing.
  const [target, setTarget] = useState(firstBoard);
  if (target !== firstBoard) {
    setTarget(firstBoard);
    if (firstBoard !== null && firstBoard !== decision.boardId) dispatch({ type: "select", boardId: firstBoard });
  }
  const board = round?.boards.find((b) => b.fixtureId === decision.boardId) ?? null;
  // The round's "+5 min" answer is about the round it was given for: a different round on screen (a newer open lands, back/forward)
  // starts clean - the same previous-props pattern as the target above.
  const roundKey = round === null ? null : `${round.stageId}:${round.roundNo}`;
  const [seenRound, setSeenRound] = useState(roundKey);
  if (seenRound !== roundKey) {
    setSeenRound(roundKey);
    dispatchRound({ type: "clear" });
  }

  // The viewer's clock: null on the server and the first client render. It ticks every 500 ms (the player clocks run on it) and
  // lands exactly on each board's check-in opening and deadline, where the "+5 min" arrives and leaves (owner, 2026-10-19).
  const nowMs = useExtendClock(true, extendEdgesOf(watchedWindows(round?.boards.map((b) => b.checkin) ?? [])), true);

  // The round's boards move without us (moves, results, flags): the desk's
  // own poll, paused while the tab is hidden.
  const live = round?.boards.some((b) => !boardIsOver(b.state)) ?? false;
  useEffect(() => startBandPolling(live, () => router.refresh(), browserBandPollDeps()), [live, router]);

  // Which player's meeting the arbiter is in, per board: the arbiter's own choice, else the board's default read ONCE
  // and held - a player arriving later never moves the pane under the arbiter's eyes. The meeting is the SIDE's; the
  // colour is only its label, so a pairing card swapping the colours changes the label and nothing else (§5.6.4).
  const [chosen, setChosen] = useState<Record<string, ArbiterSide>>({});
  const side: ArbiterSide | null = board ? (chosen[board.fixtureId] ?? defaultWatchSide(board)) : null;
  if (board && side && chosen[board.fixtureId] === undefined) setChosen((c) => ({ ...c, [board.fixtureId]: side }));
  const shown: ArbiterSeat = board && side ? sideSeat(board, side) : "white";

  // The camera join: one meeting at a time - the board's, and in it the one player's. The answer is stored WITH the key
  // it answers, so a switch reads as "switching" until its own answer lands - no state is set in the effect's body, only
  // in the callbacks it subscribes. The key carries the side, so a side switch re-runs the effect; the order of a switch
  // (leave, then DELETE answered, then the next join) is the serial chain's, not the effect cleanup's, which React does
  // not await (arbiter-watch.ts). A side whose room is not open is not joined at all: nothing to watch, and the arbiter
  // never makes a room - the poll opens the join the moment the player arrives.
  const [attempt, setAttempt] = useState(0);
  const [join, setJoin] = useState<{ key: string; view: ArbiterVideoView } | null>(null);
  const sideState = board && side ? board.sides[side].state : null;
  const joinKey = board && side && shouldJoinVideo(board) && sideState === "open" ? `${board.fixtureId}:${side}#${attempt}` : null;
  useEffect(() => {
    if (joinKey === null) return;
    const [, fixtureId, joinSide] = /^(.+):(home|away)#\d+$/.exec(joinKey)!;
    let cancelled = false;
    const answer = (view: ArbiterVideoView) => {
      if (!cancelled) setJoin({ key: joinKey, view });
    };
    const observe = (c: ArbiterCameras) => () => {
      if (cancelled) return;
      const now = Date.now();
      setJoin((prev) => {
        // The guard left the meeting: the fault stands until a retry.
        if (prev?.key === joinKey && prev.view.kind === "fault") return prev;
        const was = prev?.key === joinKey && prev.view.kind === "watching" ? prev.view.tile : null;
        const tile = c.tile();
        return { key: joinKey, view: { kind: "watching", tile: { ...tile, offSinceMs: nextOffSince(was?.offSinceMs ?? null, tile, now) } } };
      });
    };
    const open = browserSerial.open(fixtureId!, joinSide as ArbiterSide, {
      onCameras: (c) => {
        if (cancelled) return;
        c.onChange(observe(c));
        c.onFault(() => answer({ kind: "fault" }));
        observe(c)();
      },
      onError: (err) => answer(arbiterJoinStateFromError(err)),
    });
    // I2: the tab going away hands the participant back at once (keepalive); the pane closing queues leave-then-DELETE.
    window.addEventListener("pagehide", open.release);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", open.release);
      open.close();
    };
  }, [joinKey]);

  const video: ArbiterVideoView =
    board === null
      ? { kind: "idle" }
      : board.cameraPolicy === "off"
        ? { kind: "none" }
        : board.videoOverridden
          ? { kind: "overridden" }
          : boardIsOver(board.state)
            ? { kind: "over" }
            : sideState === "none"
              ? { kind: "notStarted" }
              : sideState === "ended"
                ? { kind: "ended" }
                : join !== null && join.key === joinKey
                  ? join.view
                  : { kind: switchingFrom(join?.key ?? null, board.fixtureId, side) ? "switching" : "connecting" };

  // Any extend action starting clears the OTHER extend answer too (spec §3.2.2): a round answer's counts and a board's time are no
  // longer about what is on screen once the other has moved the deadlines. (`dispatch` and `dispatchRound` are stable.)
  const linked = useMemo(() => linkedExtendDispatch<ArbiterDecisionAction>(dispatch, dispatchRound), [dispatch, dispatchRound]);

  const runner = useMemo(
    () =>
      decisionRunner({
        dispatch: linked.forBoard,
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
        overrideNote: ARBITER_OVERRIDE_NOTE,
      }),
    [router, linked],
  );

  const roundRunner = useMemo(
    () =>
      roundExtendRunner({
        dispatch: linked.forRound,
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
      }),
    [router, linked],
  );

  // C9: ONE handle for the round on screen, shared by the hero (inside the column) and the waiting list. Two calls would be two
  // reducers: a resend started from a row would not disable the hero's. It resets by itself on a new round (use-open-round.ts).
  const openRound = useOpenRound(round === null ? null : viewOfRound(column.views, round));

  const select = useCallback(
    (fixtureId: string) => {
      dispatch({ type: "select", boardId: fixtureId });
      try {
        window.history.replaceState(window.history.state, "", routes.divisionArbiter(slugs.org, slugs.comp, slugs.div, fixtureId));
      } catch {
        // A blocked history write leaves the URL behind; the panel is right.
      }
    },
    [slugs],
  );

  return (
    <ArbiterScreen
      round={round}
      requested={requested}
      decision={decision}
      roundExtend={roundExtend}
      video={video}
      shown={shown}
      nowMs={nowMs}
      slugs={slugs}
      column={column}
      openRound={openRound}
      on={{
        select,
        // A waiting row's "+5 min": the board becomes the one on screen (its answer lands in the decision area, which is about the
        // board on screen), then the extend goes. An id not in this round, or any request in flight, does nothing at all.
        extendBoard: (fixtureId) => {
          const target = round?.boards.find((b) => b.fixtureId === fixtureId);
          if (!target) return;
          // One request at a time, and the pane stays put: `select` ignores `busy`, so moving to this board while another request is out
          // would leave that request's answer on a deselected board, where the reducer clears the busy flag and shows nothing. The same
          // rule as the panel's own +5 (disabled while a decision or the round's +5 is in flight), and the row's button says so too.
          if (decision.busy !== null) return;
          if (roundExtend.busy) return;
          select(fixtureId);
          void runner.extend(target.fixtureId, target.boardNo);
        },
        resync: () => {
          if (decision.boardId) void runner.resync(decision.boardId);
        },
        goOn: (flagIds) => {
          if (decision.boardId) void runner.goOn(decision.boardId, flagIds);
        },
        toggleSettle: () => dispatch({ type: "toggleSettle" }),
        settle: (choice) => {
          if (decision.boardId) void runner.settle(decision.boardId, choice);
        },
        override: () => {
          if (decision.boardId) void runner.override(decision.boardId);
        },
        extend: () => {
          if (board) void runner.extend(board.fixtureId, board.boardNo);
        },
        extendRound: () => {
          if (round) void roundRunner.extend(round.stageId, round.roundNo);
        },
        retryVideo: () => setAttempt((n) => n + 1),
        switchTo: (seat) => {
          if (board) setChosen((c) => ({ ...c, [board.fixtureId]: seatSide(board, seat) }));
        },
      }}
    />
  );
}
