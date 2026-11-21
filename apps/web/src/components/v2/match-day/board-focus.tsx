"use client";
// The board panel (Match Day online, plan 2026-11-05-match-day-all-in-one.md Task 8; spec §6.3 "board panel"; owner rulings MD-R13/R14/R21):
// ONE online board in the focus column of the day - who plays, where the game stands, what is flagged on it, and what the organiser may
// decide. `BoardFocus` (the island) reads the board and keeps the decisions; `BoardPanelView` (pure) draws one answer of it.
//
// What the panel reads. The board's own route (`GET /api/v1/fixtures/{id}/match-day-board`: the board as the round view paints it, every
// open flag in full for an editor's role and stripped to kind and time for anyone else, the position of its game, and why it is held for
// an editor) on mount and whenever `refreshKey` moves. The shell hands it `useDayRefresh`'s `lastOkAt`, which moves on every successful
// day read (the poll, the Refresh button, a tab coming back), so the board's read rides the merged poll and the panel keeps no timer of
// its own. The last answer stays on screen while the next read is out, and when a read fails; a press re-reads the board straight away.
// Until the first answer the panel draws the list's own row (its name and state), never an empty box.
//
// What it lets the reader do (`mayPress`, lib/match-day/online.ts): the decisions that FINISH play - resync, let the game go on, settle,
// let play without video - are every editor's, billing freeze or not (they write or unblock a result, which the freeze exempts: owner O4);
// the one press that STARTS play here, "+5 min" on the board's check-in, needs an editor of an offered club on a competition that is not
// frozen, and the server's 402 on it is worded as the freeze and told to the shell (MD-R30). A reader with neither sees the board, its
// flags and why it is held, and no press. Every handler checks the same rule the view does, so a stale view cannot send what the page
// would not draw.
//
// The decisions began as the retired Arbiter page's and live in `board-decision.tsx` (their reducer is `arbiter-decision.ts`, their runner
// `decisionRunner`, the flag cards `arbiter-flag-cards.tsx`), test ids unchanged. The cameras (Task 9, board-cameras.tsx)
// are the shell's joins (`joins`: what `useArbiterJoins` answered for this board's two meetings) drawn as two tiles at the top of the right
// column, beside the board and not instead of it; below lg, where the panel is one column, a Cameras / Board switch picks which of the two shows.
import { useCallback, useEffect, useId, useMemo, useReducer, useState, type ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { arbiterDecision, decisionRunner, initialArbiterDecision, type ArbiterDecisionState, type SettleChoice } from "../arbiter-decision";
import { BoardCameras, CamerasToggle, anyUnavailable } from "./board-cameras";
import { camerasOffered, defaultCameraMode, type JoinViews, type MeetingKey } from "./online/arbiter-joins";
import { CARD, CHIP_NEUTRAL, FlagCard, MUTED, SOFT, useFmt } from "../arbiter-flag-cards";
import { extendEdgesOf, watchedWindows } from "@/lib/checkin-extend";
import { boardIsOver, type ArbiterFlag } from "@/lib/arbiter-view";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { SEAT_WORD_KEYS, seatWords } from "@/lib/invite-status";
import { mayPress, presenceMark, boardRowWord, type Reader } from "@/lib/match-day/online";
import { boardName, boardWord, earlierRoundChip, presenceText } from "@/lib/match-day/online-copy";
import type { MatchDayBoard, MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";
import { BILLING_FROZEN_CODE } from "@/lib/open-round";
import { routes } from "@/lib/routes";
import { HELD_TITLE_KEYS, heldBody } from "../external-play-held-copy";
import { useExtendClock } from "../use-extend-clock";
import { BoardDecision, OutageCard, outageOffered, type DecisionOn } from "./board-decision";
import { Mark } from "./board-row";
import { BoardPosition } from "./board-position";
import type { MatchDayCtx } from "./court-focus";
import { OnlineFocusFrame } from "./online-focus";
import { WORD_TONE } from "./online-tone";
import { CARD_BOX } from "./round-focus";
import { MatchRoundChip } from "./round-chip";

/** What the audit log records with a video override: a record, not copy - the organiser's reason as Match Day states it. */
export const MATCH_DAY_OVERRIDE_NOTE = "Video unavailable: let this board play without video from Match Day.";

const post = (path: string, body?: unknown) => apiV1(path, { method: "POST", ...(body === undefined ? {} : { json: body }) });

// ---- the answer ------------------------------------------------------------------------------------------------------------------------

/** The vocabulary of a hold's reason, as the client holds it: the held-copy table is total over the server's `NeedsReason` (tsc keeps it
 *  so), and a client component cannot import the server's own list (a `@/server` value drags the Node-only modules into the bundle and
 *  breaks `next build`; tsc and vitest do not see it). */
const HOLD_REASONS: ReadonlySet<string> = new Set(Object.keys(HELD_TITLE_KEYS));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function isPosition(v: unknown): boolean {
  if (v === null) return true;
  if (!isObj(v) || typeof v.fen !== "string") return false;
  if (v.turn !== "white" && v.turn !== "black") return false;
  return v.lastMove === null || (Array.isArray(v.lastMove) && v.lastMove.length === 2 && v.lastMove.every((s) => typeof s === "string"));
}

/** The board route's answer, narrowed. The server's own schema (`MatchDayBoard` in schemas/fixtures.ts) declares the keys the focus ADDS
 *  (`position`, `stage_id`, `round_no`, `hold_reason`) and keeps the rest open; this guard checks those the same way (board-focus.test.tsx
 *  runs both over one table and fails if they part) and then the keys the panel dereferences when it draws (`state`, `flags`, `sides`, the
 *  two names), so a body that is not a board is a failed read, never a half-drawn panel. */
export function isMatchDayBoard(raw: unknown): raw is MatchDayBoard {
  if (!isObj(raw)) return false;
  if (typeof raw.fixtureId !== "string" || typeof raw.stage_id !== "string" || typeof raw.round_no !== "number") return false;
  if (!isPosition(raw.position)) return false;
  if (raw.hold_reason !== null && !(typeof raw.hold_reason === "string" && HOLD_REASONS.has(raw.hold_reason))) return false;
  if (!isObj(raw.state) || typeof raw.state.kind !== "string") return false;
  if (!Array.isArray(raw.flags)) return false;
  if (!isObj(raw.sides) || !isObj(raw.sides.home) || !isObj(raw.sides.away)) return false;
  return isObj(raw.white) && typeof raw.white.name === "string" && isObj(raw.black) && typeof raw.black.name === "string";
}

type Read = { answer: MatchDayBoard | null; failed: boolean };

/** One board's read: on mount and whenever `refreshKey` or `reloadKey` moves. The last answer is kept (state is never reset by a new read),
 *  a read that fails or answers something else only raises `failed`, and an answer that arrives after a newer read began is dropped.
 *  One failure is not a failure: a 404 on a RE-read (an answer is in hand) says the board is gone - a press can take it away, a settle that
 *  voids the game, an organiser deleting the match elsewhere - so the last answer stays and no "could not read" line is raised over a board
 *  that is leaving (and one raised by an earlier failed read is taken down: the board is gone, not unreadable); the day's own read drops the
 *  row and the shell closes the panel. A 404 on the FIRST read has nothing to keep: failed. */
function useBoardRead(fixtureId: string, refreshKey: number | null, reloadKey: number): Read {
  const [read, setRead] = useState<Read>({ answer: null, failed: false });
  useEffect(() => {
    const ctl = new AbortController();
    let current = true;
    const fail = () => setRead((prev) => ({ answer: prev.answer, failed: true }));
    apiV1<unknown>(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/match-day-board`, { signal: ctl.signal })
      .then((raw) => {
        if (!current) return;
        if (isMatchDayBoard(raw) && raw.fixtureId === fixtureId) setRead({ answer: raw, failed: false });
        else fail();
      })
      .catch((e: unknown) => {
        if (!current) return;
        if (e instanceof ApiV1Error && e.status === 404) setRead((prev) => (prev.answer !== null ? { answer: prev.answer, failed: false } : { answer: null, failed: true }));
        else fail();
      });
    return () => {
      current = false;
      ctl.abort();
    };
  }, [fixtureId, refreshKey, reloadKey]);
  return read;
}

// ---- the island ----------------------------------------------------------------------------------------------------------------------------

export type BoardFocusProps = {
  ctx: MatchDayCtx;
  /** The round row the board sits under. */
  round: MatchDayOnlineRound;
  /** The list's own board: what the panel shows until its first read answers. */
  row: MatchDayBoardRow;
  /** The shell's reader for this board (`mayPress`'s input). */
  reader: Reader;
  /** The shell's clock (null before mount); the panel runs its own, finer one for the chess clocks and the check-in window. */
  nowMs: number | null;
  /** `useDayRefresh`'s `lastOkAt`: when it moves, the board is read again. */
  refreshKey: number | null;
  backLabel: string;
  onBack: () => void;
  /** The shell's quiet day read, after a press. It must keep its identity across renders: the runner is built on it. */
  onChanged: () => void;
  /** MD-R30: an answer said the competition is billing-frozen. */
  onFrozen: () => void;
  /** B7 (T9 m5): the panel's own read of THIS board, handed up the moment it changes (null: none yet, or the panel is leaving). The tiles are drawn
   *  from it (`read.answer ?? row`), so the shell's join keys must follow the same board or a tile is drawn for a meeting nobody joined - and one
   *  joined that no tile shows. It must keep its identity across renders (a `useCallback`): the effect that hands the answer up is keyed on it. */
  onAnswer: (fixtureId: string, answer: MatchDayBoard | null) => void;
  /** The shell's joins for this board (`useArbiterJoins`): what each of its two meetings answered, and the tile's "Try again". Absent: no
   *  cameras (the flag is off, or the shell keeps none). Whether this reader sees tiles at all is `camerasOffered`'s, asked here. */
  joins?: { views: JoinViews; retry(key: MeetingKey): void };
  hiddenOnPhone?: boolean;
};

export type CameraMode = "cameras" | "board";

export function BoardFocus(p: BoardFocusProps) {
  const { row, reader, refreshKey, onChanged, onFrozen, onAnswer } = p;
  const id = row.fixtureId;
  const [reloadKey, setReloadKey] = useState(0);
  const read = useBoardRead(id, refreshKey, reloadKey);
  const board = read.answer ?? row;
  // The board the tiles are drawn from is the board the shell joins for: hand the answer up, and take it back when this panel goes (or the answer is replaced).
  useEffect(() => {
    onAnswer(id, read.answer);
    return () => onAnswer(id, null);
  }, [id, read.answer, onAnswer]);

  const [decision, dispatch] = useReducer(arbiterDecision, id, initialArbiterDecision);
  // Below lg the cameras and the chess board share the screen: the organiser's pick, else the default (cameras while there is something to
  // watch, the board otherwise), which follows the board's state until the organiser picks.
  const [pickedMode, setPickedMode] = useState<CameraMode | null>(null);
  const cameraMode = pickedMode ?? defaultCameraMode(board, reader);
  // The cameras' fold (MD-R36: its press is on the state row, the strip is in the rest column, so the state is the panel's): a HELD board opens
  // folded, the decision is what its organiser came for. Read once, from the row the panel was opened on - a poll never refolds or reopens it.
  const [camerasFolded, setCamerasFolded] = useState(() => row.state.kind === "on_hold");
  // A press re-reads the board straight away AND refreshes the day: the panel's own answer must not wait for the day's read to succeed.
  const refresh = useCallback(() => {
    setReloadKey((n) => n + 1);
    onChanged();
  }, [onChanged]);
  const runner = useMemo(() => decisionRunner({ dispatch, post, refresh, overrideNote: MATCH_DAY_OVERRIDE_NOTE }), [refresh]);

  // The chess clocks and the check-in window need a finer clock than the shell's minute: the panel's own, only while one is running.
  const edges = extendEdgesOf(watchedWindows([board.checkin]));
  const ticking = useExtendClock(board.clock?.running === true || edges.length > 0, edges, true);
  const nowMs = ticking ?? p.nowMs;

  // MD-R30: the freeze's own answer, from the one START press this panel has. The finishing decisions are scoring: a 402 on one of them is
  // a plan limit's, not the competition freezing, and the shell is not told.
  const frozenAnswered = decision.notice !== null && decision.notice.kind === "extend_failed" && decision.notice.code === BILLING_FROZEN_CODE;
  useEffect(() => {
    if (frozenAnswered) onFrozen();
  }, [frozenAnswered, onFrozen]);

  const may = { start: mayPress(reader, "start"), finish: mayPress(reader, "finish") };
  const on: DecisionOn & { override(): void } = {
    extend: () => {
      if (may.start) void runner.extend(id, board.boardNo);
    },
    resync: () => {
      if (may.finish) void runner.resync(id);
    },
    goOn: (flagIds) => {
      if (may.finish) void runner.goOn(id, flagIds);
    },
    toggleSettle: () => {
      if (may.finish) dispatch({ type: "toggleSettle" });
    },
    settle: (choice: SettleChoice) => {
      if (may.finish) void runner.settle(id, choice);
    },
    override: () => {
      if (may.finish) void runner.override(id);
    },
  };

  return (
    <BoardPanelView
      ctx={p.ctx}
      round={p.round}
      row={row}
      answer={read.answer}
      readFailed={read.failed}
      reader={reader}
      decision={decision}
      nowMs={nowMs}
      on={on}
      backLabel={p.backLabel}
      onBack={p.onBack}
      hiddenOnPhone={p.hiddenOnPhone}
      joins={p.joins}
      cameraMode={cameraMode}
      onCameraMode={setPickedMode}
      camerasFolded={camerasFolded}
      onCamerasFolded={setCamerasFolded}
    />
  );
}

// ---- the view -----------------------------------------------------------------------------------------------------------------------------

export type BoardPanelViewProps = {
  ctx: MatchDayCtx;
  round: MatchDayOnlineRound;
  row: MatchDayBoardRow;
  /** The board as the last successful read answered it; null before the first. */
  answer: MatchDayBoard | null;
  readFailed: boolean;
  reader: Reader;
  decision: ArbiterDecisionState;
  nowMs: number | null;
  on: DecisionOn & { override(): void };
  backLabel: string;
  onBack: () => void;
  hiddenOnPhone?: boolean;
  /** What the shell's joins answered for this board; undefined = no cameras. */
  joins?: { views: JoinViews; retry(key: MeetingKey): void };
  /** Which of the cameras and the board shows below lg (both show from lg). Only read where both exist. */
  cameraMode: CameraMode;
  onCameraMode(mode: CameraMode): void;
  /** The cameras' strip folded to one line, and the setter its toggle (on the state row) calls. Only read where the cameras are offered. */
  camerasFolded: boolean;
  onCamerasFolded(folded: boolean): void;
};

/** The chip a flag wears for a reader who has no editor's role: the kind and nothing of what it found or whom it names. A kind added to
 *  `ArbiterFlag` fails this table at compile time. */
const SUMMARY_CHIP: Record<ArbiterFlag["kind"], "arbiter.flag.outOfBand.chip" | "arbiter.flag.cameraOff.chipPlain" | "arbiter.flag.connection.chipPlain" | "arbiter.flag.devices.chipPlain"> = {
  out_of_band_play: "arbiter.flag.outOfBand.chip",
  camera_lost: "arbiter.flag.cameraOff.chipPlain",
  camera_connection_problems: "arbiter.flag.connection.chipPlain",
  multiple_devices: "arbiter.flag.devices.chipPlain",
};

const NOTE = `m-0 text-sm leading-[1.5] ${SOFT}`;

export function BoardPanelView(p: BoardPanelViewProps) {
  const { ctx, round, row, answer, reader, decision, nowMs } = p;
  const board: MatchDayBoardRow = answer ?? row;
  const f = useFmt(nowMs, round.tz);
  const decideId = useId();
  const outageId = useId();
  const camerasId = useId();

  const editor = reader.editor;
  const may = { start: mayPress(reader, "start"), finish: mayPress(reader, "finish") };
  const word = boardWord(ctx.dict, ctx.locale, boardRowWord(board));
  const position = answer?.position ?? null;

  // The marks follow the SEAT (`home`/`away`); a board row names White first, so the colour maps through `whiteSide`.
  const blackSide = board.whiteSide === "home" ? "away" : "home";
  const marks = { white: presenceMark(board, board.whiteSide), black: presenceMark(board, blackSide) };

  // The cameras (Task 9): offered to a reader who may watch a board whose division requires them; drawn from what the shell's joins answered.
  const cameras = p.joins !== undefined && camerasOffered(board, reader) ? p.joins : null;
  // The left cell: the position, else why there is none.
  let top: ReactNode;
  if (position !== null) {
    const label = f.t(boardIsOver(board.state) ? "externalPlay.room.board.final" : position.turn === "white" ? "externalPlay.room.board.whiteToMove" : "externalPlay.room.board.blackToMove");
    top = <BoardPosition position={position} white={board.white.name} black={board.black.name} clock={board.clock} nowMs={nowMs} label={label} />;
  } else if (answer !== null) {
    top = (
      <p data-testid="md-board-nogame" className={`${NOTE} ${CARD_BOX}`}>
        {f.t("matchDay.board.noGame")}
      </p>
    );
  } else if (p.readFailed) {
    top = null;
  } else {
    top = (
      <p data-testid="md-board-loading" role="status" className={NOTE}>
        {f.t("matchDay.board.loading")}
      </p>
    );
  }
  const showsPosition = position !== null;
  // The second column exists only for a board to put in it (a position drawn).
  const twoCol = showsPosition;
  // Below lg the cameras and the board share one column, so a switch picks one; from lg both show (cameras at the right column's top).
  const hasSwitch = cameras !== null && showsPosition;
  const hideBoardBelowLg = hasSwitch && p.cameraMode === "cameras";
  const hideCamerasBelowLg = hasSwitch && p.cameraMode === "board";
  // The seats: always while there is no board to name them (the check-in's words belong here), else only to carry a presence mark.
  const showSeats = !showsPosition || marks.white !== null || marks.black !== null;
  // The tiles carry each player's name, colour and presence mark, so the seat cards say nothing the tiles do not - except in a board's check-in,
  // where the seat is also its check-in and invite words. Redundant where the tiles show: from lg always, below lg when the cameras are.
  const seatsRedundant = cameras !== null && board.seats === null;
  const seatsHidden = !seatsRedundant ? "" : hasSwitch && p.cameraMode === "board" ? " lg:hidden" : " hidden";

  // The reason is the ANSWER's once there is one (null = not held, or not an editor's to read): `??` would paint a lifted hold from the list's
  // stale row. The row's reason is what shows only before the first answer.
  const holdReason = answer !== null ? answer.hold_reason : (row.hold_reason ?? null);
  // Why it is held, in the held queue's own words: an editor's fact (MD-R21 - the server sends null to anyone else, and the view asks too).
  // The seat a hold froze (`revokedSeat`) is not on the board's wire, so a seat hold reads in its general words.
  const holdBody = editor && holdReason !== null ? heldBody({ reason: holdReason, revokedSeat: null, whiteName: board.white.name, blackName: board.black.name }) : null;
  // The match's own page: the "Open match" link, and where a board with no online game on file is settled.
  const matchHref = board.fixtureNo !== null ? routes.fixture(ctx.orgSlug, ctx.compSlug, round.division_slug, board.fixtureNo) : null;

  return (
    <OnlineFocusFrame
      testAttrs={{ "data-online": "board", "data-fixture-id": row.fixtureId, "data-state": board.state.kind }}
      title={boardName(ctx.dict, board)}
      backLabel={p.backLabel}
      onBack={p.onBack}
      hiddenOnPhone={p.hiddenOnPhone === true}
      subtitle={
        <>
          <span>{round.division_name}</span>
          <MatchRoundChip round={earlierRoundChip(ctx.dict, row.round_no)} />
          {round.stage_name !== "" && <span>{round.stage_name}</span>}
          {round.round?.timeControl != null && <span>{round.round.timeControl}</span>}
        </>
      }
    >
      {/* MD-R33/R34: from lg the panel is two columns - the board and its clocks on the left (a fluid column, capped at 420px / 42%, so the
          focus at 1024 is not squeezed), everything else on the right, so the decision is above the fold on a held board. Below lg ONE column,
          in the DOM's own order: state, seats, board, why, flags, decision. The grid has three cells: the head (state row, seats) at the right's
          top, the board's cell spanning both rows (the extra height of a tall board lands in the stretchy second row, never between the right's
          blocks), and the rest, which re-sorts with `lg:order-*` into why, decision, outage card, THEN flags (the decision is what the
          organiser came for). With no position there is no left column at all: the notes (loading, no game, read failed) span the width. The
          cameras (Task 9) are the first block of the rest, so they sit at the right column's top from lg and between the board and the reason
          below it; below lg a Cameras / Board switch (in the head) hides whichever of the two is not picked, from lg both show. */}
      <div
        data-testid="md-board-grid"
        className={`grid min-w-0 gap-4${twoCol ? " lg:grid-cols-[minmax(0,min(420px,42%))_1fr] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-y-2" : ""}`}
      >
        <div data-testid="md-board-head" className={`flex min-w-0 flex-col gap-4${twoCol ? " lg:col-start-2 lg:row-start-1" : ""}`}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p data-testid="md-online-state" className={`min-w-0 text-sm font-semibold [overflow-wrap:anywhere] ${WORD_TONE[word.tone]}`}>
              {word.text}
              {word.sub !== null && <span className="ml-2 font-medium text-slate-600">{word.sub}</span>}
            </p>
            {(cameras !== null || matchHref !== null) && (
              <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
                {cameras !== null && (
                  <CamerasToggle
                    folded={p.camerasFolded}
                    onToggle={() => p.onCamerasFolded(!p.camerasFolded)}
                    controlsId={camerasId}
                    f={f}
                    className={hideCamerasBelowLg ? "max-lg:hidden" : ""}
                  />
                )}
                {matchHref !== null && (
                  <Link href={matchHref} data-testid="md-open-pad" className="btn btn-ghost min-h-11 shrink-0 text-sm lg:min-h-0 lg:py-1.5">
                    {f.t("matchDay.focus.openMatch")}
                  </Link>
                )}
              </div>
            )}
          </div>

          {hasSwitch && (
            <div role="group" aria-label={f.t("matchDay.cameras.switch")} data-testid="md-camera-switch" className="grid grid-cols-2 gap-1 rounded-xl bg-[#f3effc] p-1 lg:hidden">
              {(["cameras", "board"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-mode={mode}
                  aria-pressed={p.cameraMode === mode}
                  onClick={() => p.onCameraMode(mode)}
                  className={`min-h-11 cursor-pointer rounded-lg px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed] ${
                    p.cameraMode === mode ? "bg-white text-[#2e1065] shadow-sm" : "text-[#5b21b6]"
                  }`}
                >
                  {f.t(mode === "cameras" ? "matchDay.cameras.viewCameras" : "matchDay.cameras.viewBoard")}
                </button>
              ))}
            </div>
          )}

          {showSeats && (
            <ul data-testid="md-board-seats" className={`m-0 grid min-w-0 list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2${seatsHidden}`}>
              {(["white", "black"] as const).map((colour) => {
                const mark = marks[colour];
                const seat = board.seats?.[colour] ?? null;
                const text = presenceText(ctx.dict, mark);
                return (
                  <li key={colour} data-testid="md-board-seat" data-colour={colour} className={`flex flex-col gap-1 ${CARD_BOX}`}>
                    <span className={`text-xs ${MUTED}`}>{f.t(colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black")}</span>
                    <span className="min-w-0 text-sm font-semibold text-[#2e1065] [overflow-wrap:anywhere]">
                      {board[colour].name}
                      <Mark mark={mark} dict={ctx.dict} />
                      {text !== null && (
                        <span aria-hidden className="text-xs font-medium text-slate-600">
                          {text}
                        </span>
                      )}
                    </span>
                    {seat !== null && (
                      // The check-in's words (a board in its window): here, or not here yet and what each invite did - the waiting list's own words.
                      <span data-testid="md-board-seat-words" className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {seat.here ? (
                          <span data-seat-word="here" className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-900">
                            {f.t("arbiter.column.here")}
                          </span>
                        ) : (
                          <>
                            <span data-seat-word="not_here" className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                              {f.t("arbiter.column.notHereYet")}
                            </span>
                            {seatWords(seat).map((w, i) => (
                              <span key={`${w}:${i}`} data-seat-word={w} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
                                {f.t(SEAT_WORD_KEYS[w])}
                              </span>
                            ))}
                          </>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

        </div>
        <div
          data-testid="md-board-left"
          className={`flex min-w-0 flex-col gap-4 empty:hidden${twoCol ? " lg:col-start-1 lg:row-span-2 lg:row-start-1" : ""}${hideBoardBelowLg ? " max-lg:hidden" : ""}`}
        >
          {top}
          {p.readFailed && (
            <p data-testid="md-board-read-failed" role="status" className={NOTE}>
              {f.t("matchDay.board.readFailed")}
            </p>
          )}

        </div>
        <div data-testid="md-board-rest" className={`flex min-w-0 flex-col gap-4 empty:hidden${twoCol ? " lg:col-start-2 lg:row-start-2 lg:gap-2" : ""}`}>
          {cameras !== null && (
            <div data-testid="md-board-cameras" className={`min-w-0${hideCamerasBelowLg ? " max-lg:hidden" : ""}`}>
              <BoardCameras board={board} views={cameras.views} f={f} dict={ctx.dict} onRetry={cameras.retry} folded={p.camerasFolded} bodyId={camerasId} />
            </div>
          )}

          {holdBody !== null && holdReason !== null && (
            <section data-testid="md-board-hold" data-reason={holdReason} className={`flex flex-col gap-1.5 ${CARD_BOX} border-[#f1c4c0] lg:order-1 lg:gap-1 lg:p-2.5`}>
              <span className="self-start rounded-full bg-[#fde8e6] px-2.5 py-[3px] text-xs font-semibold text-[#7f1d1d]">{f.t(HELD_TITLE_KEYS[holdReason])}</span>
              {/* 13px (the phone's size) from lg up to xl, 14px from xl: the narrowest lg (1024 x 768) is where the 168-character reason (Dutch longest) wraps most and Settle
                  ended 10px below the fold at 14px (fix round 1, B6); the 1280 pins are untouched, the body is 14px there as before. */}
              <p className="m-0 text-[13px] leading-[1.45] lg:max-xl:leading-[1.35] xl:text-sm">{f.t(holdBody.key, holdBody.vars)}</p>
            </section>
          )}

          {(board.flags.length > 0 || board.cameraReport === "pending") && (
            <section data-testid="md-board-flags" className="flex min-w-0 flex-col gap-2.5 lg:order-4">
              <h3 className="m-0 text-[17px] font-semibold text-[#2e1065]">{f.t("arbiter.flags.headingThis")}</h3>
              <p className={`m-0 text-xs leading-[1.45] lg:text-[13px] ${MUTED}`}>{f.t(editor ? "arbiter.flags.lede" : "matchDay.board.flagsViewer")}</p>
              {board.flags.map((flag) => (
                <div key={flag.id} data-testid="md-board-flag" data-kind={flag.kind} className="min-w-0">
                  {editor ? (
                    <FlagCard flag={flag} f={f} />
                  ) : (
                    <article className={`${CARD} border-[#e7e3f3]`}>
                      <span className={CHIP_NEUTRAL}>{f.t(SUMMARY_CHIP[flag.kind])}</span>
                      {f.hm(flag.at) !== null && <span className={`text-xs ${MUTED}`}>{f.t("arbiter.flag.foundAt", { time: f.hm(flag.at)! })}</span>}
                    </article>
                  )}
                </div>
              ))}
              {board.cameraReport === "pending" && (
                <article className={`${CARD} border-[#e7e3f3]`}>
                  <span className={CHIP_NEUTRAL}>{f.t("arbiter.flag.pending.chip")}</span>
                  <p className="m-0 text-[13px] leading-[1.45] lg:text-sm">{f.t("arbiter.flag.pending.body")}</p>
                </article>
              )}
            </section>
          )}

          {/* Draws nothing for a reader with no right to press: every button asks `may`, and the section itself is null when none is offered. */}
          <BoardDecision
            board={board}
            decision={decision}
            roundBusy={false}
            nowMs={nowMs}
            settleHref={matchHref}
            may={may}
            on={p.on}
            f={f}
            headingId={decideId}
            className={`flex flex-col gap-2 ${CARD_BOX} lg:order-2 lg:gap-1.5 lg:p-2.5`}
          />
          {may.finish && outageOffered(board, cameras !== null && anyUnavailable(board, cameras.views)) && (
            <OutageCard
              started={board.cameraReport !== null}
              busy={decision.busy !== null}
              overriding={decision.busy?.kind === "override"}
              onOverride={p.on.override}
              f={f}
              headingId={outageId}
              className="flex min-w-0 flex-col gap-2 rounded-xl border border-[#f5d27a] bg-[#fef3c7] p-3 text-[#713f12] lg:order-3"
            />
          )}
        </div>
      </div>
    </OnlineFocusFrame>
  );
}
