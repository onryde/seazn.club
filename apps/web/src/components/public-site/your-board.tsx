"use client";
// "Your board" (T16, controller ruling 2026-10-12): a signed-in player's door from the public fixture page into their
// match room. The page is ISR — one HTML for every viewer — so it renders nothing here; after hydration this island
// asks the lobby route (GET, session only, `private, no-store`) — only when the browser carries the signed-in hint
// (R2) — and only one of the two players gets an answer. Every
// refusal (anonymous 401, a stranger or another club's player 404, a fault) shows nothing. One venue (D3): the door
// leads to OUR room, never to lichess.org.
import { useEffect, useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { LOBBY_STATES, type ExternalPlayLobby } from "@/lib/external-play-lobby";
import { hasSessionHint } from "@/lib/session-hint";

type Get = (url: string, init: RequestInit) => Promise<unknown>;

/** The lobby's answer for this viewer, or null when there is nothing to show. A malformed answer is refused here
 *  rather than rendered: an unknown state has no sentence, and a door that is not our own room is not a door. */
export async function loadYourBoard(fixtureId: string, get: Get = apiV1): Promise<ExternalPlayLobby | null> {
  let body: unknown;
  try {
    body = await get(`/api/v1/fixtures/${encodeURIComponent(fixtureId)}/external-play/lobby`, { cache: "no-store" });
  } catch {
    return null;
  }
  const a = body as Partial<ExternalPlayLobby> | null;
  if (a === null || typeof a !== "object" || !(LOBBY_STATES as readonly unknown[]).includes(a.state)) return null;
  if (a.state === "online_chess_off") return a.roomPath === null ? { state: a.state, roomPath: null } : null;
  if (typeof a.roomPath !== "string" || !a.roomPath.startsWith("/shared/")) return null;
  return a as ExternalPlayLobby;
}

export function YourBoard({ fixtureId }: { fixtureId: string }) {
  // Keyed by the fixture it answers, so a navigation to another fixture never shows the previous one's door.
  const [answer, setAnswer] = useState<{ fixtureId: string; view: ExternalPlayLobby | null } | null>(null);
  useEffect(() => {
    // R2 (T16 fix round 1): no signed-in hint, no request — an anonymous viewer would only be refused (401). The hint
    // has no authority (lib/session-hint.ts); the route still checks the session itself.
    if (!hasSessionHint(document.cookie)) return;
    let live = true;
    void loadYourBoard(fixtureId).then((view) => {
      if (live) setAnswer({ fixtureId, view });
    });
    return () => {
      live = false;
    };
  }, [fixtureId]);
  const view = answer?.fixtureId === fixtureId ? answer.view : null;
  return view === null ? null : <YourBoardCard view={view} />;
}

export function YourBoardCard({ view }: { view: ExternalPlayLobby }) {
  const t = useT();
  return (
    <section
      data-testid="your-board"
      data-state={view.state}
      aria-label={t("externalPlay.yourBoard.title")}
      className="mb-4 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm"
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="m-0 text-sm font-semibold text-ink">{t("externalPlay.yourBoard.title")}</p>
        <p className="m-0 text-sm text-ink-muted">{t(`externalPlay.yourBoard.state.${view.state}`)}</p>
      </div>
      {view.roomPath !== null && (
        <a
          data-testid="your-board-link"
          href={view.roomPath}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink shadow-sm transition hover:opacity-90"
        >
          {t("externalPlay.yourBoard.cta")}
        </a>
      )}
    </section>
  );
}
