"use client";
// The room's clock faces, ticking (T17B fix 2, D24 split the strip in two, so the ticking moved out of the strip's
// wrapper): one timer, both sides' times in ms from clock-math `clockFaces`, and the report that the side to move's
// clock reached zero — ONE call site, so two bars never report twice. The player's own face is the optimistic guess
// while it applies (clock-math); the zero test reads that same face, so a move dropped in time is never a clock at zero.
import { useEffect } from "react";
import { clockFaces, type OptimisticClock } from "./clock-math";
import type { Colour, RoomGame, RoomSnapshot } from "./room-snapshot";
import { useServerNow } from "./room-time";

export function useClockFaces({
  game,
  snap,
  skewMs,
  optimistic,
  onZero,
}: {
  game: RoomGame;
  snap: Pick<RoomSnapshot, "you" | "result">;
  skewMs: number;
  optimistic: OptimisticClock | null;
  onZero: () => void;
}): Record<Colour, number> {
  const running = game.clockRunning && !game.over;
  const now = useServerNow(skewMs, running ? 100 : null);
  const faces = clockFaces({ game, you: snap.you.colour, optimistic, resultWritten: snap.result !== null, nowMs: now });
  const toMoveLeft = faces[game.turn];
  useEffect(() => {
    if (running && now !== null && toMoveLeft <= 0) onZero();
  }, [running, now, toMoveLeft, onZero]);
  return faces;
}
