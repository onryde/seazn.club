"use client";
// T16 — the public fixture page's watch panel for an online chess board.
//
// The page is ISR — one HTML for every viewer, up to 30 s old — so the server
// hands its own doc (`PublicWatchDoc`) for the first paint, and after
// hydration this island keeps it live: a poll at once and every POLL_MS (GET
// /public/fixtures/{id}/board), and each pushed move relayed from the match
// centre's subscription (live-board-channel). `watch-state` decides which
// answer shows. Spectators watch here; nothing links off to Lichess (D3).
import { useEffect, useReducer, useRef, useState } from "react";
import { useLocale, usePlural, useT } from "@/components/i18n/dict-provider";
import { api } from "@/lib/client";
import type { PublicWatchDoc } from "@/server/external-play/public-view";
import { subscribeBoardPush } from "./live-board-channel";
import { POLL_MS } from "./use-live-fixture";
import { WatchBoard } from "./watch-board";
import {
  WatchDetails,
  WatchMoves,
  WatchNote,
  WatchResult,
  WatchStatus,
  formatWatchTime,
  moveLabel,
  type WatchDetailsFacts,
  type WatchStatusKind,
} from "./watch-parts";
import { holdOf, initialWatch, nextWatch, pollsAgain, startBoard, watchView } from "./watch-state";

export async function fetchPublicBoard(fixtureId: string): Promise<PublicWatchDoc> {
  // Never a browser-cached answer: the route's Cache-Control is for the edge.
  return api<PublicWatchDoc>(`/api/v1/public/fixtures/${encodeURIComponent(fixtureId)}/board`, { cache: "no-store" });
}

type Props = {
  fixtureId: string;
  initial: PublicWatchDoc;
  /** The entrants' display names; White's side picks which plays White. */
  names: { home: string; away: string };
  /** The page's own public facts for Match details (the round's open comes from the doc). */
  details: Omit<WatchDetailsFacts, "roundOpenedAt" | "locale">;
  /** Which entrant plays White as the pairing stands — the names on the start position before a game is on file
   *  (a game's own White wins once there is one); null when it could not be read. */
  pairedWhiteSide: "home" | "away" | null;
  fetchBoard?: (fixtureId: string) => Promise<PublicWatchDoc>;
};

/** Keyed by its fixture, so a navigation to another fixture starts from that
 *  fixture's doc, never the last one's board. */
export function WatchPanel(props: Props) {
  return <WatchPanelInner key={props.fixtureId} {...props} />;
}

export function WatchPanelInner({ fixtureId, initial, names, details, pairedWhiteSide, fetchBoard = fetchPublicBoard }: Props) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const [model, dispatch] = useReducer(nextWatch, initial, initialWatch);
  const modelRef = useRef(model);
  const fetchRef = useRef(fetchBoard);
  const pollNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    modelRef.current = model;
    fetchRef.current = fetchBoard;
  });

  // Pushed moves. A pushed board says neither which entrant plays White nor the
  // move list; when the panel lacks either, the poll is asked at once.
  useEffect(
    () =>
      subscribeBoardPush(fixtureId, (push) => {
        const w = modelRef.current.play?.watch ?? null;
        const unknownSide = (w?.whiteSide ?? null) === null;
        const listBehind = push.ply > (w?.moves.length ?? 0);
        dispatch({ kind: "push", push, at: new Date().toISOString() });
        if (unknownSide || listBehind) pollNow.current?.();
      }),
    [fixtureId],
  );

  const polling = pollsAgain(model);
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const tick = async () => {
      try {
        const doc = await fetchRef.current(fixtureId);
        if (live) dispatch({ kind: "poll", doc });
      } catch {
        // A failed poll keeps the board on screen; the next one tries again.
      }
    };
    pollNow.current = () => void tick();
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      pollNow.current = null;
      clearInterval(id);
    };
  }, [fixtureId, polling]);

  // The running clock's tick; null until the first one, so the first paint
  // matches the server's.
  const running = model.play?.watch?.clockRunning === true;
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  const view = watchView(model);
  const hold = holdOf(model);
  const play = model.play;
  // A board whenever a game with a move is on file and the view is about the game (live, held, finished): a
  // knockout draw keeps its final position on the board (canvas WatchStates B), and so does any other hold. From the
  // round's open until the first move, the start position (owner ruling 2026-10-13, option B) — in the same place,
  // so the first move changes the pieces and the line above them, and nothing else.
  const watch = play?.watch ?? null;
  const gameBoard = watch !== null && watch.ply > 0 && (view === "live" || view === "held" || view === "finished") ? watch : null;
  const initialMs = details.clock === null ? null : details.clock.limitSeconds * 1000;
  const board = gameBoard ?? (view === "not_started" ? startBoard(watch, pairedWhiteSide, initialMs) : null);
  const status: WatchStatusKind | null =
    view === "not_started" ? "waiting" : view === "live" && board !== null && !board.over ? board.turn : null;
  const side = board?.whiteSide ?? null;
  const boardNames =
    side === null ? null : side === "home" ? { white: names.home, black: names.away } : { white: names.away, black: names.home };
  const note =
    view === "not_opened" ? (
      <WatchNote kind={view} t={t} />
    ) : hold !== null ? (
      <WatchNote kind={hold} t={t} />
    ) : null;
  const facts: WatchDetailsFacts = { ...details, roundOpenedAt: model.roundOpenedAt, locale };
  const finished = view === "finished";
  const result = play?.result ?? null;
  const lastSan = board === null ? null : (board.moves[board.ply - 1] ?? null);
  return (
    <section
      data-testid="watch-panel"
      data-state={view}
      {...(hold !== null ? { "data-hold": hold } : {})}
      data-polling={polling ? "true" : "false"}
      aria-label={t(finished ? "externalPlay.watch.finalTitle" : "externalPlay.watch.title")}
      className="mb-4 flex min-w-0 flex-col gap-3 rounded-xl border border-[#e7e3f3] bg-white p-3 shadow-sm md:p-4"
    >
      {finished ? <WatchResult result={result} names={names} ply={watch?.ply ?? 0} t={t} /> : null}
      <div className={`grid min-w-0 gap-4 ${board !== null ? "lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)] lg:gap-6" : ""}`}>
        {board !== null ? (
          <div className="flex min-w-0 flex-col gap-3">
            {status !== null ? <WatchStatus kind={status} t={t} /> : null}
            <WatchBoard watch={board} names={boardNames} nowMs={nowMs} t={t} />
            {finished && lastSan !== null ? (
              <p data-testid="watch-final-line" className="m-0 text-[13px] text-[#4a3a6b]">
                {t("externalPlay.watch.finalLine", { move: moveLabel(board.ply, lastSan) })}
              </p>
            ) : null}
            {note}
          </div>
        ) : null}
        <aside className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h2 className="m-0 min-w-0 truncate text-lg font-semibold text-[#2e1065]">
              {t(finished ? "externalPlay.watch.finalTitle" : "externalPlay.watch.title")}
            </h2>
            {board !== null ? (
              <span className="shrink-0 rounded-full bg-[#f3effc] px-2.5 py-1 text-xs font-semibold text-[#4a3a6b]">
                {t("externalPlay.watch.viewOnly")}
              </span>
            ) : null}
          </div>
          {view === "live" || view === "not_started" ? (
            <p className="m-0 text-sm leading-relaxed text-[#4a3a6b]">{t("externalPlay.watch.intro")}</p>
          ) : null}
          {finished ? (
            <p data-testid="watch-recorded" className="m-0 text-xs leading-relaxed text-[#6b5b8a]">
              {result?.recordedAt
                ? t("externalPlay.watch.result.recordedAt", { time: formatWatchTime(result.recordedAt, details.timeZone, locale, false) })
                : t(play?.decided ? "externalPlay.watch.result.noRecord" : "externalPlay.watch.result.toConfirm")}
            </p>
          ) : null}
          {board === null ? note : null}
          {board !== null ? <WatchMoves moves={board.moves} t={t} /> : null}
          <WatchDetails facts={facts} t={t} plural={plural} />
        </aside>
      </div>
    </section>
  );
}
