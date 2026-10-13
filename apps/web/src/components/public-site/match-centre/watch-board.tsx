"use client";
// T16 — the spectators' view-only board (design §3.4 step 3). The pieces are
// the room's own Board, client-only (chessground touches `document`) and
// reached through the licence loader, with `viewOnly`: chessground binds no
// events, so a spectator can neither move nor select. Around it: each side's
// name and clock, and whose move. Nothing here can act on the game, and
// nothing links off to Lichess (D3 — one venue). The panel owns every line
// around the board — the result, a hold, the "not started" line (fix round
// 1, M9: one owner per testid) — so this draws a game, only when there is one.
import dynamic from "next/dynamic";
import type { PublicWatch } from "@/server/external-play/public-view";
import { formatClock, remainingMs } from "../match-room/clock-math";
import type { RoomT } from "../match-room/room-copy";

const Board = dynamic(() => import("../match-room/board"), { ssr: false });

type Colour = "white" | "black";

function Clock({
  colour,
  name,
  ms,
  active,
  t,
}: {
  colour: Colour;
  name: string | null;
  ms: number | null;
  active: boolean;
  t: RoomT;
}) {
  const word = t(`externalPlay.room.colour.${colour}`);
  return (
    <div
      data-testid={`watch-clock-${colour}`}
      data-active={active ? "true" : "false"}
      className={`flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[10px] px-3 py-2 ${
        active ? "bg-[#2e1065] text-white" : "bg-[#f3effc] text-[#2e1065]"
      }`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="min-w-0 truncate text-sm font-semibold">{name ?? word}</span>
        {name !== null ? (
          <span className={`min-w-0 truncate text-xs ${active ? "text-[#ddd3f7]" : "text-[#6b5b8a]"}`}>{word}</span>
        ) : null}
      </div>
      <span className="shrink-0 font-display text-2xl font-semibold tabular-nums md:text-[32px]">{ms === null ? "—" : formatClock(ms)}</span>
    </div>
  );
}

export function WatchBoard({
  watch,
  names,
  nowMs,
  t,
}: {
  watch: PublicWatch;
  /** Who plays each colour, once White's side is on file. */
  names: { white: string; black: string } | null;
  /** The viewer's tick, or null before the first one (first paint). */
  nowMs: number | null;
  t: RoomT;
}) {
  const asOfMs = watch.asOf === null ? null : Date.parse(watch.asOf);
  const clock = (colour: Colour): number | null => {
    const base = colour === "white" ? watch.whiteMs : watch.blackMs;
    if (base === null) return null;
    const running = watch.clockRunning && watch.turn === colour && asOfMs !== null && nowMs !== null;
    return remainingMs({ baseMs: base, asOfMs: asOfMs ?? 0, nowMs: nowMs ?? 0, running });
  };
  const toMove = (colour: Colour) => !watch.over && watch.turn === colour;
  const lastMove: [string, string] | null =
    watch.lastMove === null ? null : [watch.lastMove.slice(0, 2), watch.lastMove.slice(2, 4)];
  const label = watch.over
    ? t("externalPlay.room.board.final")
    : t(watch.turn === "white" ? "externalPlay.room.board.whiteToMove" : "externalPlay.room.board.blackToMove");
  return (
    <div
      data-testid="watch-board"
      data-view-only="true"
      data-ply={watch.ply}
      data-over={watch.over ? "true" : "false"}
      className="mx-auto flex w-full min-w-0 max-w-[560px] flex-col gap-2 lg:mx-0"
    >
      <Clock colour="black" name={names?.black ?? null} ms={clock("black")} active={toMove("black")} t={t} />
      <div className="w-full min-w-0">
        <Board
          fen={watch.fen}
          orientation="white"
          lastMove={lastMove}
          movable={false}
          viewOnly
          syncKey={0}
          onMove={() => {}}
          label={label}
          t={t}
        />
      </div>
      <Clock colour="white" name={names?.white ?? null} ms={clock("white")} active={toMove("white")} t={t} />
    </div>
  );
}
