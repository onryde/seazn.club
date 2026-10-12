// Game over (canvas "GameOver"): the clocks muted, the final board, a dark
// result card — "You won" / "Checkmate · 1–0" / "The result is on the
// fixture." — then Back to fixture and Standings.
//
// The result comes from OUR record (boardgame.result via the room usecase),
// never from the board: a game Lichess says is over but that reconcile has
// not yet written shows "Game over" and that the result is on its way.
import Link from "next/link";
import { BoardgameMethod } from "@seazn/engine/sports/boardgame";
import type { RoomResult, RoomSnapshot } from "./room-snapshot";
import type { RoomT } from "./room-copy";

const METHODS: ReadonlySet<string> = new Set(BoardgameMethod.options);

export function resultHeadline(result: RoomResult | null, t: RoomT): string {
  if (result === null) return t("externalPlay.room.over.title");
  if (result.outcome === "won") return t("externalPlay.room.over.won");
  if (result.outcome === "lost") return t("externalPlay.room.over.lost");
  // A double forfeit is the engine's no_result: nobody played (review I7).
  if (result.outcome === "no_result") return t("externalPlay.room.over.noResult");
  return t("externalPlay.room.over.draw");
}

/** "Checkmate · 1–0"; the score alone when no (known) method was recorded. */
export function resultLine(result: RoomResult, t: RoomT): string {
  return result.method !== null && METHODS.has(result.method)
    ? `${t(`method.${result.method}`)} · ${result.score}`
    : result.score;
}

export function GameOver({
  snap,
  clocks,
  board,
  t,
}: {
  snap: Pick<RoomSnapshot, "result" | "links">;
  clocks: React.ReactNode;
  board: React.ReactNode;
  t: RoomT;
}) {
  const r = snap.result;
  return (
    <div data-testid="room-over" className="flex min-w-0 flex-col gap-3 md:mx-auto md:w-full md:max-w-[560px]">
      {clocks}
      {board}
      <section
        data-testid="room-result"
        data-outcome={r?.outcome ?? "pending"}
        className="flex flex-col gap-1 rounded-xl bg-[#2e1065] px-4 py-3.5 text-white"
      >
        <span className="font-display text-[30px] font-bold uppercase tracking-[0.02em]">{resultHeadline(r, t)}</span>
        {r !== null ? <span className="text-sm text-[#ddd3f7]">{resultLine(r, t)}</span> : null}
        <span className="text-xs text-[#c9bdf0]">{t(r !== null ? "externalPlay.room.over.onFixture" : "externalPlay.room.over.pending")}</span>
      </section>
      <div className="grid grid-cols-2 gap-2">
        <Link
          href={snap.links.fixture}
          data-testid="room-back-to-fixture"
          className="flex min-h-11 items-center justify-center rounded-[10px] bg-[#7c3aed] text-[15px] font-semibold text-white no-underline"
        >
          {t("externalPlay.room.backToFixture")}
        </Link>
        <Link
          href={snap.links.standings}
          data-testid="room-standings"
          className="flex min-h-11 items-center justify-center rounded-[10px] border border-[#c9bdf0] bg-white text-[15px] font-semibold text-[#2e1065] no-underline"
        >
          {t("externalPlay.room.standings")}
        </Link>
      </div>
    </div>
  );
}
