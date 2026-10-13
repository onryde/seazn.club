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
import { useT } from "@/components/i18n/dict-provider";
import { api } from "@/lib/client";
import type { PublicWatchDoc } from "@/server/external-play/public-view";
import { subscribeBoardPush } from "./live-board-channel";
import { POLL_MS } from "./use-live-fixture";
import { WatchBoard } from "./watch-board";
import { initialWatch, nextWatch, pollsAgain, watchView, type WatchView } from "./watch-state";

export async function fetchPublicBoard(fixtureId: string): Promise<PublicWatchDoc> {
  // Never a browser-cached answer: the route's Cache-Control is for the edge.
  return api<PublicWatchDoc>(`/api/v1/public/fixtures/${encodeURIComponent(fixtureId)}/board`, { cache: "no-store" });
}

const OPEN_FIXTURE: ReadonlySet<string> = new Set(["scheduled", "in_play", "needs_decision"]);

/** Does the page show the panel? Always while the fixture is open; once it is
 *  decided or cancelled, only when there is a game to show — a board settled
 *  without one would otherwise read "not started" under its result. */
export function showWatchPanel(fixtureStatus: string, doc: PublicWatchDoc): boolean {
  return OPEN_FIXTURE.has(fixtureStatus) || (doc.externalPlay?.watch ?? null) !== null;
}

const LINE: Record<Exclude<WatchView, "board">, string> = {
  not_opened: "externalPlay.watch.notOpened",
  not_started: "externalPlay.watch.notStarted",
  held: "externalPlay.needsOrganiser",
};

type Props = {
  fixtureId: string;
  initial: PublicWatchDoc;
  /** The entrants' display names; White's side picks which plays White. */
  names: { home: string; away: string };
  fetchBoard?: (fixtureId: string) => Promise<PublicWatchDoc>;
};

/** Keyed by its fixture, so a navigation to another fixture starts from that
 *  fixture's doc, never the last one's board. */
export function WatchPanel(props: Props) {
  return <WatchPanelInner key={props.fixtureId} {...props} />;
}

export function WatchPanelInner({ fixtureId, initial, names, fetchBoard = fetchPublicBoard }: Props) {
  const t = useT();
  const [model, dispatch] = useReducer(nextWatch, initial, initialWatch);
  const modelRef = useRef(model);
  const fetchRef = useRef(fetchBoard);
  const pollNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    modelRef.current = model;
    fetchRef.current = fetchBoard;
  });

  // Pushed moves. A pushed board does not say which entrant plays White; when
  // the panel does not know yet, the poll is asked at once.
  useEffect(
    () =>
      subscribeBoardPush(fixtureId, (push) => {
        const unknownSide = (modelRef.current.play?.watch?.whiteSide ?? null) === null;
        dispatch({ kind: "push", push, at: new Date().toISOString() });
        if (unknownSide) pollNow.current?.();
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
  const watch = model.play?.watch ?? null;
  const side = watch?.whiteSide ?? null;
  const boardNames =
    side === null ? null : side === "home" ? { white: names.home, black: names.away } : { white: names.away, black: names.home };
  return (
    <section
      data-testid="watch-panel"
      data-state={view}
      aria-label={t("externalPlay.watch.title")}
      className="mb-4 min-w-0 rounded-xl border border-[#e7e3f3] bg-white p-3 shadow-sm md:p-4"
    >
      <h2 className="m-0 min-w-0 truncate text-sm font-semibold text-[#2e1065]">{t("externalPlay.watch.title")}</h2>
      {view === "board" ? (
        <WatchBoard watch={watch} names={boardNames} nowMs={nowMs} t={t} />
      ) : (
        <p data-testid={`watch-${view.replace("_", "-")}`} className="m-0 mt-1 text-sm text-[#4a3a6b]">
          {t(LINE[view])}
        </p>
      )}
    </section>
  );
}
