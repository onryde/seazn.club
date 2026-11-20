"use client";
// A board's position and its two clocks, read-only (spec 2026-11-05 §6.3 "board panel"; plan Task 8): the match room's own chessground
// `Board`, mounted `viewOnly` the way the spectators' `WatchBoard` mounts it, with Black's clock above the board and White's below (the
// board is always drawn from White's side, as the room's spectators see it). Nothing here is movable: the organiser watches, never plays.
//
// The Board is a client-only import (`dynamic`, `ssr: false`): chessground reads `window`, so the server renders the clocks and an empty
// box, and the board arrives with the page's scripts. Its labels come from the dictionary provider the `/o/[orgSlug]` layout mounts
// (`useT`), so the Match Day page picks no extra prefix for it.
import dynamic from "next/dynamic";
import { useT } from "@/components/i18n/dict-provider";
import type { ArbiterClock } from "@/lib/arbiter-view";
import type { BoardPosition as PositionData } from "@/lib/match-day/types";
import { formatClock, remainingMs } from "@/components/public-site/match-room/clock-math";

const Board = dynamic(() => import("@/components/public-site/match-room/board"), { ssr: false });

type Colour = "white" | "black";

function Clock({ colour, name, ms, active }: { colour: Colour; name: string; ms: number | null; active: boolean }) {
  const t = useT();
  return (
    <div
      data-testid={`md-board-clock-${colour}`}
      data-active={active ? "true" : "false"}
      className={`flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[10px] px-3 py-2 ${
        active ? "bg-[#2e1065] text-white" : "bg-[#f3effc] text-[#2e1065]"
      }`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{name}</span>
        <span className={`min-w-0 text-xs ${active ? "text-[#ddd3f7]" : "text-[#6b5b8a]"}`}>{t(`externalPlay.room.colour.${colour}`)}</span>
      </div>
      <span data-testid={`md-board-clock-${colour}-time`} className="shrink-0 text-2xl font-semibold tabular-nums">
        {ms === null ? "—" : formatClock(ms)}
      </span>
    </div>
  );
}

/** The side's reading now: its base worked forward by the viewer's clock while it is the side to move and the clock runs, else the base as
 *  last told. `null` for no clock on file at all (a dash, never 0:00). Before the viewer's clock is known (`nowMs` null) nothing runs. */
function readingOf(clock: ArbiterClock | null, colour: Colour, nowMs: number | null): number | null {
  if (clock === null) return null;
  const asOfMs = clock.asOf === null ? null : Date.parse(clock.asOf);
  return remainingMs({
    baseMs: colour === "white" ? clock.whiteMs : clock.blackMs,
    asOfMs: asOfMs ?? 0,
    nowMs: nowMs ?? 0,
    running: clock.running && clock.turn === colour && asOfMs !== null && nowMs !== null,
  });
}

export function BoardPosition({
  position,
  white,
  black,
  clock,
  nowMs,
  label,
}: {
  position: PositionData;
  white: string;
  black: string;
  clock: ArbiterClock | null;
  /** The viewer's clock (null before the first tick): the running side counts down from it. */
  nowMs: number | null;
  /** The board's accessible name ("Board, White to move"): the caller's, who knows whether the game is over. */
  label: string;
}) {
  const t = useT();
  return (
    <div data-testid="md-board-position" data-turn={position.turn} className="mx-auto flex w-full min-w-0 max-w-[560px] flex-col gap-2 lg:mx-0">
      <Clock colour="black" name={black} ms={readingOf(clock, "black", nowMs)} active={clock?.running === true && clock.turn === "black"} />
      <div className="w-full min-w-0">
        <Board fen={position.fen} orientation="white" lastMove={position.lastMove} movable={false} viewOnly syncKey={0} onMove={() => {}} label={label} t={t} />
      </div>
      <Clock colour="white" name={white} ms={readingOf(clock, "white", nowMs)} active={clock?.running === true && clock.turn === "white"} />
    </div>
  );
}
