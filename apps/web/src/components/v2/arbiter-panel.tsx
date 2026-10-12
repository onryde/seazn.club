"use client";
// T15 — the arbiter panel (chess design §5.3), built to the owner-approved
// canvas (ArbiterPhone, ArbiterDesktop: https://claude.ai/artifact/JKzKrtjSAPiU3QsFiRkEew).
// The organiser who opens it watches one board at a time, receive-only: both
// players' cameras, never their sound, never seen by them. Beside the tiles,
// the board's flags — evidence, never a verdict — and the decision actions.
//
// One DOM, branched at `lg` (the canvas draws a 1280 desktop and a 320
// phone): below it the board picker is a <select> and the page is one column
// in the phone's order; at `lg` the three columns of the desktop artboard.
// The two wrappers below `lg` are `display: contents`, so their children
// take the phone's order (`order-*`) in the one flex column.
//
// `ArbiterScreen` is pure (props in, markup out — the unit suite renders it);
// `ArbiterPanel` is the shell: the decision reducer, the camera join, the
// clock tick and the poll. Every time of day renders only after mount: the
// server's timezone is not the arbiter's.
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { useLocale, usePlural, useT } from "@/components/i18n/dict-provider";
import { routes } from "@/lib/routes";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import {
  fullMoveOf,
  timelineSegments,
  type ArbiterBoard,
  type ArbiterFlag,
  type ArbiterRound,
  type CameraOffReport,
} from "@/lib/arbiter-view";
import { formatClock, remainingMs } from "@/components/public-site/match-room/clock-math";
import { formatTimeOfDay } from "@/components/public-site/match-room/room-time";
import { browserBandPollDeps, startBandPolling } from "./desk/band-poll";
import {
  arbiterDecision,
  decisionRunner,
  initialArbiterDecision,
  type ArbiterDecisionAction,
  type ArbiterDecisionState,
  type ArbiterNotice,
  type SettleChoice,
} from "./arbiter-decision";
import { ArbiterGuardError, joinArbiter, type ArbiterCameras, type ArbiterSeat, type ArbiterTileView } from "./arbiter-camera";

// ── the view the screen paints ─────────────────────────────────────────────

export type ArbiterSeatVideo = { present: boolean; live: boolean; offSinceMs: number | null; track: MediaStreamTrack | null };

/** What the two tiles show. `watching` is the only state with cameras. */
export type ArbiterVideoView =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "watching"; white: ArbiterSeatVideo; black: ArbiterSeatVideo }
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
  video: ArbiterVideoView;
  /** The viewer's clock; null before mount (no time of day is painted). */
  nowMs: number | null;
  slugs: { org: string; comp: string; div: string };
  on: {
    select(fixtureId: string): void;
    resync(): void;
    /** "Let the game go on" for the flags on screen, by id (ruling A). */
    goOn(flagIds: readonly string[]): void;
    toggleSettle(): void;
    settle(choice: SettleChoice): void;
    override(): void;
    retryVideo(): void;
  };
};

/** A camera to watch: the policy asks for one, nobody let the board go
 *  without, and the game is not over. */
export function shouldJoinVideo(b: ArbiterBoard): boolean {
  return b.cameraPolicy !== "off" && !b.videoOverridden && b.state.kind !== "result";
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

/** I2: the participant one open of a board minted on the server. The panel
 *  hands it back when the board closes — a switch, the panel going away —
 *  and when the tab goes away (`release`, on pagehide: `keepalive`, so the
 *  request outlives the page), ONCE. A mint that lands after the board closed
 *  (the POST raced the switch) is handed back at once. A send that fails is
 *  dropped: the sweep removes whatever the browser could not. */
export function arbiterWatchRelease(fixtureId: string, send: (url: string, init: RequestInit) => Promise<unknown>) {
  let participantId: string | null = null;
  let closed = false;
  const release = () => {
    if (participantId === null) return;
    const url = `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter/${encodeURIComponent(participantId)}`;
    participantId = null;
    void send(url, { method: "DELETE", keepalive: true }).catch(() => undefined);
  };
  return {
    minted(id: string) {
      participantId = id;
      if (closed) release();
    },
    close() {
      closed = true;
      release();
    },
    release,
  };
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
const MUTED = "text-[#6b5b8a]";
const SOFT = "text-[#4a3a6b]";
const CLOCK_FACE = "[font-family:var(--font-barlow,var(--font-geist-sans))] font-semibold tabular-nums";
const BUTTON_QUIET =
  "min-h-11 rounded-[10px] border border-[#c9bdf0] bg-white px-3 text-[15px] font-semibold text-[#2e1065] disabled:cursor-not-allowed disabled:opacity-60";
const CHIP = "self-start rounded-full px-2.5 py-[3px] text-xs font-semibold";
const CHIP_AMBER = `${CHIP} bg-[#fef3c7] text-[#713f12]`;
const CHIP_NEUTRAL = `${CHIP} bg-[#f3effc] text-[#4a3a6b]`;
const CARD = "flex flex-col gap-1.5 rounded-xl border bg-white p-3";

type Fmt = {
  t: ReturnType<typeof useT>;
  plural: ReturnType<typeof usePlural>;
  locale: string;
  mounted: boolean;
  /** "19:42", or null before mount. */
  hm(iso: string): string | null;
  /** "19:31:05", or null before mount. */
  hms(iso: string): string | null;
  duration(seconds: number): string;
  list(items: string[]): string;
};

function useFmt(nowMs: number | null): Fmt {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const mounted = nowMs !== null;
  return useMemo<Fmt>(() => {
    const hmsFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    return {
      t,
      plural,
      locale,
      mounted,
      hm: (iso) => (mounted ? formatTimeOfDay(iso, locale) : null),
      hms: (iso) => (mounted ? hmsFmt.format(new Date(iso)) : null),
      duration: (raw) => {
        const s = Math.max(0, Math.round(raw));
        if (s < 60) return t("arbiter.duration.sec", { sec: s });
        const min = Math.floor(s / 60);
        const sec = s % 60;
        return sec === 0 ? t("arbiter.duration.min", { min }) : t("arbiter.duration.minSec", { min, sec });
      },
      list: (items) => new Intl.ListFormat(locale, { type: "conjunction" }).format(items),
    };
  }, [t, plural, locale, mounted]);
}

function boardStateWord(b: ArbiterBoard, f: Fmt): string {
  switch (b.state.kind) {
    case "live":
      return f.t("arbiter.state.live");
    case "checking_in":
      return f.t("arbiter.state.checkingIn");
    case "starting":
      return f.t("arbiter.state.starting");
    case "on_hold":
      return f.t("arbiter.state.onHold");
    case "result":
      return b.state.score ?? f.t("arbiter.state.over");
  }
}

function names(b: ArbiterBoard, f: Fmt): string {
  return `${b.white.name} ${f.t("arbiter.vs")} ${b.black.name}`;
}

function flagCount(b: ArbiterBoard, f: Fmt): string | null {
  return b.flags.length > 0 ? f.plural("arbiter.flagCount", b.flags.length) : null;
}

export function ArbiterScreen(p: ArbiterScreenProps) {
  const f = useFmt(p.nowMs);
  const back = routes.division(p.slugs.org, p.slugs.comp, p.slugs.div, "fixtures");
  const ids = { flags: useId(), decide: useId(), outage: useId(), board: useId(), boards: useId() };
  const roundLine = p.round ? f.t("arbiter.roundLine", { stage: p.round.stageName, round: p.round.roundNo }) : null;
  const board = p.round?.boards.find((b) => b.fixtureId === p.decision.boardId) ?? null;

  return (
    <div className={`min-w-0 bg-[#fdfcf8] ${INK}`}>
      <header className="flex h-[52px] min-w-0 items-center gap-1 border-b border-[#e7e3f3] pr-4 pl-1 lg:h-16 lg:gap-4 lg:px-8">
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
        <div className="flex min-w-0 flex-col lg:flex-row lg:items-center lg:gap-4">
          {roundLine && <span className={`truncate text-xs lg:text-sm ${MUTED}`}>{roundLine}</span>}
          <h1 className="m-0 text-[15px] font-semibold lg:text-base">{f.t("arbiter.title")}</h1>
        </div>
        {p.round && <p className={`m-0 ml-auto hidden text-[13px] lg:block ${MUTED}`}>{f.t("arbiter.watchOnly")}</p>}
      </header>

      {p.requested === null && p.round !== null && <RoundNotes round={p.round} slugs={p.slugs} f={f} />}

      {p.requested !== null ? (
        <RequestedNotice body={f.t(p.requested === "own" ? "arbiter.requested.own" : "arbiter.requested.unavailable")} slugs={p.slugs} f={f} />
      ) : p.round === null ? (
        <EmptyNotice title={f.t("arbiter.empty.title")} body={f.t("arbiter.empty.body")} />
      ) : p.round.boards.length === 0 && p.round.ownBoards > 0 ? (
        // C1 (D7): every board of the round is one the viewer plays on.
        <EmptyNotice title={null} body={f.t("arbiter.ownRound")} />
      ) : p.round.boards.length === 0 ? (
        <EmptyNotice title={null} body={f.t("arbiter.emptyBoards")} />
      ) : board === null ? (
        // I3: the board asked for (or on screen) is not in this round — said
        // so, never another board opened in its place.
        <RequestedNotice body={f.t("arbiter.requested.unavailable")} slugs={p.slugs} f={f} />
      ) : (
        <main className="mx-auto flex w-full min-w-0 max-w-[1232px] flex-col gap-3 px-4 pt-3 pb-6 lg:grid lg:grid-cols-[248px_minmax(0,1fr)_320px] lg:items-start lg:gap-6 lg:p-6">
          <nav aria-labelledby={ids.boards} className="hidden min-w-0 flex-col gap-1.5 lg:flex">
            <h2 id={ids.boards} className={`m-0 mb-1 text-xs font-semibold tracking-[0.06em] uppercase ${MUTED}`}>
              {f.t("arbiter.boardsHeading")}
            </h2>
            {p.round.boards.map((b) => {
              const pressed = b.fixtureId === board.fixtureId;
              const label = [f.t("arbiter.boardNo", { n: b.boardNo }), boardStateWord(b, f), flagCount(b, f)].filter(Boolean).join(" · ");
              return (
                <button
                  key={b.fixtureId}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => p.on.select(b.fixtureId)}
                  className={`flex min-h-14 min-w-0 flex-col gap-0.5 rounded-[10px] text-left ${
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

          {/* centre column (desktop) */}
          <div className="contents min-w-0 lg:flex lg:flex-col lg:gap-3.5">
            <div className="order-1 flex min-w-0 items-center justify-between gap-2 lg:items-baseline lg:gap-3">
              <h2 id={ids.board} className="m-0 min-w-0 text-xl font-semibold max-lg:sr-only">
                {f.t("arbiter.boardNo", { n: board.boardNo })} · {board.white.name} <span className={`font-medium ${MUTED}`}>{f.t("arbiter.vs")}</span>{" "}
                {board.black.name}
              </h2>
              <BoardStatus board={board} f={f} />
              {p.round.timeControl && <span className={`text-[13px] lg:hidden ${SOFT}`}>{p.round.timeControl}</span>}
            </div>
            <div className="order-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:gap-4">
              {(["white", "black"] as const).map((seat) => (
                <Tile key={seat} seat={seat} board={board} video={p.video} nowMs={p.nowMs} f={f} />
              ))}
            </div>
            {(p.video.kind === "fault" || p.video.kind === "error") && (
              <button type="button" onClick={p.on.retryVideo} className={`order-2 self-start ${BUTTON_QUIET}`}>
                {f.t("arbiter.tile.retry")}
              </button>
            )}
            <OtherReports round={p.round} board={board} f={f} />
          </div>

          {/* right column (desktop) */}
          <div className="contents min-w-0 lg:flex lg:flex-col lg:gap-3.5">
            <section aria-labelledby={ids.flags} className="order-3 flex min-w-0 flex-col gap-2.5 border-t border-[#e7e3f3] pt-3 lg:border-t-0 lg:pt-0">
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
            <Decision board={board} decision={p.decision} slugs={p.slugs} on={p.on} f={f} headingId={ids.decide} />
            {showsOutageCard(board, p.video) && (
              <section aria-labelledby={ids.outage} className="order-6 flex min-w-0 flex-col gap-2 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12]">
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
                  className="min-h-11 rounded-[10px] bg-[#713f12] px-3 text-[15px] font-semibold text-white disabled:opacity-60"
                >
                  {f.t("arbiter.outage.cta")}
                </button>
              </section>
            )}
          </div>
        </main>
      )}
    </div>
  );
}

function EmptyNotice({ title, body }: { title: string | null; body: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[1232px] flex-col gap-2 px-4 py-6 lg:p-6">
      {title && <h2 className="m-0 text-[17px] font-semibold">{title}</h2>}
      <p className={`m-0 max-w-prose text-sm leading-[1.5] ${SOFT}`}>{body}</p>
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

function Tile({ seat, board, video, nowMs, f }: { seat: ArbiterSeat; board: ArbiterBoard; video: ArbiterVideoView; nowMs: number | null; f: Fmt }) {
  const player = board[seat];
  const colour = f.t(seat === "white" ? "arbiter.colour.white" : "arbiter.colour.black");
  const clock = seatClock(board, seat, nowMs);
  const v = video.kind === "watching" ? video[seat] : null;
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
          ? f.t(tileSentenceKey(video))
          : f.t("arbiter.tile.absent");
    body = (
      <>
        {amber && <CameraOffIcon />}
        <span className="px-3 text-center text-sm font-semibold text-white lg:text-[15px]">{sentence}</span>
      </>
    );
  }
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5 lg:gap-2">
      <div
        className={`relative flex aspect-video w-full min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-[#1b1230] lg:aspect-auto lg:h-[216px] lg:gap-2.5 ${
          amber ? "border-2 border-[#f5d27a]" : ""
        }`}
      >
        {body}
      </div>
      <figcaption className="flex min-w-0 items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 flex-col">
          {/* The colour never truncates with a long name: on a phone it is
              the only word saying which tile is White. */}
          <span className="flex min-w-0 font-semibold lg:text-[15px]">
            <span className="min-w-0 truncate">{player.name}</span>
            <span className="shrink-0 whitespace-pre lg:hidden"> · {colour}</span>
          </span>
          <span className={`hidden text-[13px] lg:block ${MUTED}`}>{colour}</span>
        </span>
        {clock !== null && <span className={`shrink-0 text-[22px] lg:text-[30px] ${CLOCK_FACE}`}>{clock}</span>}
      </figcaption>
    </figure>
  );
}

function tileSentenceKey(video: Exclude<ArbiterVideoView, { kind: "watching" }>): string {
  switch (video.kind) {
    case "idle":
    case "connecting":
      return "arbiter.tile.connecting";
    case "none":
      return "arbiter.tile.noCamera";
    case "overridden":
      return "arbiter.tile.overridden";
    case "over":
    case "ended":
      return "arbiter.tile.over";
    case "unavailable":
      return "arbiter.tile.unavailable";
    case "fault":
      return "arbiter.tile.fault";
    case "error":
      return "arbiter.tile.error";
    case "own":
      return "arbiter.tile.own";
  }
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

function FlagCard({ flag, f }: { flag: ArbiterFlag; f: Fmt }) {
  const someone = (n: string | null) => n ?? f.t("arbiter.flag.aPlayer");
  switch (flag.kind) {
    case "out_of_band_play": {
      const found = f.hm(flag.at);
      let sentence: string;
      if (flag.plies === null) sentence = f.t("arbiter.flag.outOfBand.unread");
      else {
        const count = flag.plies.to - flag.plies.from + 1;
        const from = fullMoveOf(flag.plies.from);
        const to = fullMoveOf(flag.plies.to);
        sentence =
          from === to
            ? f.plural("arbiter.flag.outOfBand.single", count, { move: from })
            : f.plural("arbiter.flag.outOfBand.range", count, { from, to });
      }
      return (
        <article className={`${CARD} border-[#f5d27a]`}>
          <span className={CHIP_AMBER}>{f.t("arbiter.flag.outOfBand.chip")}</span>
          <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{sentence}</p>
          {found && <span className={`text-xs ${MUTED}`}>{f.t("arbiter.flag.foundAt", { time: found })}</span>}
        </article>
      );
    }
    case "camera_lost":
      return <CameraReportCard flag={flag} f={f} />;
    case "camera_connection_problems":
      return (
        <article className={`${CARD} border-[#e7e3f3]`}>
          <span className={CHIP_NEUTRAL}>
            {flag.seconds === null
              ? f.t("arbiter.flag.connection.chipPlain")
              : f.t("externalPlay.flag.cameraConnectionProblems", { duration: f.duration(flag.seconds) })}
          </span>
          <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">
            {flag.stamps === null
              ? f.t("arbiter.flag.connection.unread", { name: someone(flag.personName) })
              : f.plural("arbiter.flag.connection.body", flag.stamps, { name: someone(flag.personName) })}
          </p>
        </article>
      );
  }
}

function CameraReportCard({ flag, f }: { flag: Extract<ArbiterFlag, { kind: "camera_lost" }>; f: Fmt }) {
  const name = flag.personName ?? f.t("arbiter.flag.aPlayer");
  const r: CameraOffReport | null = flag.report;
  if (r === null) {
    return (
      <article className={`${CARD} border-[#f5d27a]`}>
        <span className={CHIP_AMBER}>{f.t("arbiter.flag.cameraOff.chipPlain")}</span>
        <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{f.t("arbiter.flag.cameraOff.unread", { name })}</p>
      </article>
    );
  }
  const spans = r.intervals.map((iv) => {
    const from = f.hms(iv.from);
    const to = f.hms(iv.to);
    return from && to ? f.t("arbiter.flag.cameraOff.span", { from, to }) : null;
  });
  const allTimed = spans.every((s): s is string => s !== null);
  const agree = r.intervals.every((iv) => iv.confirmedByEvents);
  const segments = timelineSegments({ windowFrom: flag.windowFrom, windowSeconds: r.windowSeconds, intervals: r.intervals });
  const start = flag.windowFrom ? f.hm(flag.windowFrom) : null;
  const end = flag.windowFrom ? f.hm(new Date(Date.parse(flag.windowFrom) + r.windowSeconds * 1000).toISOString()) : null;
  const sessions = f.plural("arbiter.flag.cameraOff.sessions", r.sessions);
  return (
    <article className={`${CARD} gap-2 border-[#f5d27a] p-3 lg:p-3.5`}>
      <span className={CHIP_AMBER}>{f.t("arbiter.flag.cameraOff.chip", { off: f.duration(r.offSeconds), window: f.duration(r.windowSeconds) })}</span>
      <p className="m-0 text-[13px] leading-[1.5] lg:text-sm">
        {allTimed && <>{f.t("arbiter.flag.cameraOff.spans", { name, spans: f.list(spans as string[]) })} </>}
        {agree && <>{f.t("arbiter.flag.cameraOff.agree")} </>}
        {f.plural("arbiter.flag.cameraOff.connections", r.connections, { sessions })}
      </p>
      {segments.length > 0 && (
        <div aria-hidden="true" className="relative h-2.5 overflow-hidden rounded-[5px] bg-[#dcfce7] lg:h-3 lg:rounded-md">
          {segments.map((s, i) => (
            <span key={i} className="absolute top-0 bottom-0 bg-[#b45309]" style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }} />
          ))}
        </div>
      )}
      {start && end && (
        <div className={`flex justify-between text-[11px] lg:text-xs ${MUTED}`}>
          <span>
            <span className="lg:hidden">{f.t("arbiter.flag.timeline.start", { time: start })}</span>
            <span className="max-lg:hidden">{f.t("arbiter.flag.timeline.firstMove", { time: start })}</span>
          </span>
          <span>
            <span className="lg:hidden">{f.t("arbiter.flag.timeline.end", { time: end })}</span>
            <span className="max-lg:hidden">{f.t("arbiter.flag.timeline.gameOver", { time: end })}</span>
          </span>
        </div>
      )}
    </article>
  );
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

function noticeSentence(n: ArbiterNotice, f: Fmt): string {
  switch (n.kind) {
    case "resynced":
      return n.adopted === 0 ? f.t("arbiter.notice.resyncedNone") : f.plural("arbiter.notice.resynced", n.adopted);
    case "resync_nothing":
      return f.t("arbiter.notice.resyncNothing");
    case "resync_failed":
      return f.t("arbiter.notice.resyncFailed");
    case "went_on":
      return n.stillOpen === 0 ? f.t("arbiter.notice.wentOn") : f.plural("arbiter.notice.wentOnNew", n.stillOpen);
    case "go_on_failed":
      return n.code === "ARBITER_PLAYS_THIS_BOARD" ? f.t("arbiter.notice.goOnOwnBoard") : f.t("arbiter.notice.failed");
    case "settled":
      return n.status === "tiebreak_owed" ? f.t("arbiter.notice.settledTiebreak") : f.t("arbiter.notice.settled");
    case "settle_failed":
      return n.code === "ALREADY_RESOLVED"
        ? f.t("arbiter.notice.alreadyResolved")
        : n.code === "TIEBREAK_NEEDS_WINNER"
          ? f.t("arbiter.notice.needsWinner")
          : n.code === "ARBITER_PLAYS_THIS_BOARD"
            ? f.t("arbiter.notice.settleOwnBoard")
            : f.t("arbiter.notice.failed");
    case "overridden":
      return f.t("arbiter.notice.overridden");
    case "override_failed":
      return n.code === "FIXTURE_NOT_PLAYABLE"
        ? f.t("arbiter.notice.notPlayable")
        : n.code === "VIDEO_NOT_REQUIRED"
          ? f.t("arbiter.notice.notRequired")
          : n.code === "ARBITER_PLAYS_THIS_BOARD"
            ? f.t("arbiter.notice.ownBoard")
            : f.t("arbiter.notice.failed");
  }
}

/** The settle buttons, by colour as the panel names the players; the server
 *  settles by side. A drawn knockout game takes a winner only (spec §3.6). */
function settleChoices(board: ArbiterBoard, f: Fmt): { choice: SettleChoice; label: string }[] {
  const white: SettleChoice = board.whiteSide === "home" ? "home_wins" : "away_wins";
  const black: SettleChoice = board.whiteSide === "home" ? "away_wins" : "home_wins";
  if (board.tiebreakOwed) {
    return [
      { choice: white, label: f.t("externalPlay.settle.goesThrough", { name: board.white.name }) },
      { choice: black, label: f.t("externalPlay.settle.goesThrough", { name: board.black.name }) },
    ];
  }
  return [
    { choice: white, label: f.t("externalPlay.settle.wins", { name: board.white.name }) },
    { choice: black, label: f.t("externalPlay.settle.wins", { name: board.black.name }) },
    { choice: "draw", label: f.t("externalPlay.resolve.draw") },
    { choice: "no_result", label: f.t("externalPlay.resolve.noResult") },
  ];
}

function Decision({
  board,
  decision,
  slugs,
  on,
  f,
  headingId,
}: {
  board: ArbiterBoard;
  decision: ArbiterDecisionState;
  slugs: ArbiterScreenProps["slugs"];
  on: ArbiterScreenProps["on"];
  f: Fmt;
  headingId: string;
}) {
  const settlePanel = useId();
  const over = board.state.kind === "result";
  const canResync = board.canResync;
  const canGoOn = !over && board.flags.length > 0;
  // Settled here when an online game is on file (a bridge row); a board
  // nobody reached has none, and keeps T15's way to its match page.
  const canSettle = !over && (board.canSettle || board.fixtureNo !== null);
  // The reducer owns "a notice belongs to the board on screen" (R4: a switch
  // clears it, an answer for the board left behind shows nothing).
  const notice = decision.notice;
  if (!canResync && !canGoOn && !canSettle && notice === null) return null;
  const busy = decision.busy !== null;
  return (
    <section aria-labelledby={headingId} className="order-5 flex min-w-0 flex-col gap-2 border-t border-[#e7e3f3] pt-3 lg:pt-3.5">
      <h2 id={headingId} className="m-0 text-[17px] font-semibold">
        <span className="lg:hidden">{f.t("arbiter.decide.headingBoard", { n: board.boardNo })}</span>
        <span className="max-lg:hidden">{f.t("arbiter.decide.heading")}</span>
      </h2>
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
          {f.t("arbiter.decide.goOn")}
        </button>
      )}
      {canSettle && (
        <>
          <button
            type="button"
            onClick={on.toggleSettle}
            aria-expanded={decision.settleOpen}
            aria-controls={settlePanel}
            className="min-h-11 rounded-[10px] bg-[#7c3aed] px-3 text-[15px] font-semibold text-white"
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
                {settleChoices(board, f).map((c) => (
                  <button
                    key={c.choice}
                    type="button"
                    data-settle={c.choice}
                    onClick={() => on.settle(c.choice)}
                    disabled={busy}
                    aria-busy={decision.busy?.kind === "settle" || undefined}
                    className={`${BUTTON_QUIET} min-w-0 truncate`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
      <p role="status" className={`m-0 min-h-0 text-[13px] leading-[1.45] ${SOFT}`}>
        {notice ? noticeSentence(notice, f) : null}
      </p>
    </section>
  );
}

// ── the shell ──────────────────────────────────────────────────────────────

/** What the panel writes to the audit log with a video override (D11): a
 *  record, not copy — the organiser's reason as the arbiter panel states it. */
export const ARBITER_OVERRIDE_NOTE = "Video unavailable: let this board play without video from the arbiter panel.";

export function ArbiterPanel({
  round,
  requested,
  slugs,
  initialFixtureId,
}: {
  round: ArbiterRound | null;
  requested: ArbiterScreenProps["requested"];
  slugs: ArbiterScreenProps["slugs"];
  initialFixtureId: string | null;
}) {
  const router = useRouter();
  // I3: the board asked for, EXACTLY — absent from the round, the screen
  // says so rather than opening another. With nothing asked for, the first.
  const firstBoard = initialFixtureId ?? round?.boards[0]?.fixtureId ?? null;
  const [decision, dispatch] = useReducer(arbiterDecision, firstBoard, initialArbiterDecision);
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

  // The viewer's clock: null on the server and the first client render.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setNowMs(Date.now());
    const first = setTimeout(read, 0);
    const id = setInterval(read, 500);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // The round's boards move without us (moves, results, flags): the desk's
  // own poll, paused while the tab is hidden.
  const live = round?.boards.some((b) => b.state.kind !== "result") ?? false;
  useEffect(() => startBandPolling(live, () => router.refresh(), browserBandPollDeps()), [live, router]);

  // The camera join: one meeting at a time, for the board on screen. The
  // answer is stored WITH the key it answers, so a board switch reads as
  // "connecting" until its own answer lands — no state is set in the
  // effect's body, only in the callbacks it subscribes.
  const [attempt, setAttempt] = useState(0);
  const [join, setJoin] = useState<{ key: string; view: ArbiterVideoView } | null>(null);
  const joinKey = board && shouldJoinVideo(board) ? `${board.fixtureId}#${attempt}` : null;
  useEffect(() => {
    if (joinKey === null) return;
    const fixtureId = joinKey.slice(0, joinKey.indexOf("#"));
    let cancelled = false;
    let mine: ArbiterCameras | null = null;
    // I2: whatever happens to the meeting below, the participant the POST
    // minted is handed back when this board closes or the tab goes away.
    const watch = arbiterWatchRelease(fixtureId, (url, init) => apiV1(url, init));
    window.addEventListener("pagehide", watch.release);
    const answer = (view: ArbiterVideoView) => {
      if (!cancelled) setJoin({ key: joinKey, view });
    };
    const observe = () => {
      const c = mine;
      if (c === null || cancelled) return;
      const now = Date.now();
      setJoin((prev) => {
        // The guard left the meeting: the fault stands until a retry.
        if (prev?.key === joinKey && prev.view.kind === "fault") return prev;
        const was = prev?.key === joinKey && prev.view.kind === "watching" ? prev.view : null;
        const seat = (s: ArbiterSeat): ArbiterSeatVideo => {
          const tile = c.tile(s);
          return { ...tile, offSinceMs: nextOffSince(was?.[s].offSinceMs ?? null, tile, now) };
        };
        return { key: joinKey, view: { kind: "watching", white: seat("white"), black: seat("black") } };
      });
    };
    void (async () => {
      try {
        const seats = await apiV1<{ authToken: string; participantId: string; white: string[]; black: string[] }>(
          `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/arbiter`,
          { method: "POST" },
        );
        watch.minted(seats.participantId);
        if (cancelled) return;
        const joined = await joinArbiter(seats);
        if (cancelled) {
          void joined.leave().catch(() => undefined);
          return;
        }
        mine = joined;
        joined.onChange(observe);
        joined.onFault(() => answer({ kind: "fault" }));
        observe();
      } catch (err) {
        answer(arbiterJoinStateFromError(err));
      }
    })();
    return () => {
      cancelled = true;
      if (mine !== null) void mine.leave().catch(() => undefined);
      window.removeEventListener("pagehide", watch.release);
      watch.close();
    };
  }, [joinKey]);

  const video: ArbiterVideoView =
    board === null
      ? { kind: "idle" }
      : board.cameraPolicy === "off"
        ? { kind: "none" }
        : board.videoOverridden
          ? { kind: "overridden" }
          : board.state.kind === "result"
            ? { kind: "over" }
            : join !== null && join.key === joinKey
              ? join.view
              : { kind: "connecting" };

  const runner = useMemo(
    () =>
      decisionRunner({
        dispatch: (a: ArbiterDecisionAction) => dispatch(a),
        post: (path, body) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) }),
        refresh: () => router.refresh(),
        overrideNote: ARBITER_OVERRIDE_NOTE,
      }),
    [router],
  );

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
      video={video}
      nowMs={nowMs}
      slugs={slugs}
      on={{
        select,
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
        retryVideo: () => setAttempt((n) => n + 1),
      }}
    />
  );
}
