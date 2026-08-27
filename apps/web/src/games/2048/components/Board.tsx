// The 4x4 tile grid. Pure function of props -- no hooks, no state of its
// own (same posture as Daily Word's Grid.tsx / _shared's GameFrame) --
// index.tsx computes `anims`/`moveGen` (which cells just spawned or merged,
// and a per-move generation counter to force their animation to replay) and
// this just renders the result. Colours are plain Tailwind, by value --
// the classic 2048 palette; only sizing and the animation keyframes
// themselves live in 2048.css.
import type { Board2048 } from "../engine";

const TILE_COLOR: Record<number, string> = {
  0: "bg-[#cdc1b4]/40",
  2: "bg-[#eee4da] text-[#776e65]",
  4: "bg-[#ede0c8] text-[#776e65]",
  8: "bg-[#f2b179] text-white",
  16: "bg-[#f59563] text-white",
  32: "bg-[#f67c5f] text-white",
  64: "bg-[#f65e3b] text-white",
  128: "bg-[#edcf72] text-white",
  256: "bg-[#edcc61] text-white",
  512: "bg-[#edc850] text-white",
  1024: "bg-[#edc53f] text-white",
  2048: "bg-[#edc22e] text-white",
};

function tileColor(value: number): string {
  return TILE_COLOR[value] ?? "bg-[#3c3a32] text-white"; // beyond 2048, still playable post "keep playing"
}

function fontSizeClass(value: number): string {
  if (value >= 1000) return "text-lg";
  if (value >= 100) return "text-xl";
  return "text-2xl";
}

export function Board({
  board,
  anims,
  moveGen,
}: {
  board: Board2048;
  /** Which cells (keyed "row-col") just spawned or just merged this move --
   * computed by index.tsx from the previous board snapshot. */
  anims: Map<string, "spawn" | "merge">;
  /** Bumped by index.tsx every time the board actually changes; folded into
   * an animated cell's `key` so React remounts (and therefore replays the
   * CSS animation for) only that cell, never the whole grid. */
  moveGen: number;
}) {
  return (
    <div className="board-2048" data-testid="2048-board">
      {board.map((row, r) =>
        row.map((value, c) => {
          const pos = `${r}-${c}`;
          const anim = anims.get(pos);
          const animClass = anim === "spawn" ? "tile-2048-spawn" : anim === "merge" ? "tile-2048-merge" : "";
          return (
            <div
              key={anim ? `${pos}-${moveGen}-${anim}` : pos}
              data-cell={pos}
              data-value={value}
              className={`tile-2048 ${tileColor(value)} ${value ? fontSizeClass(value) : ""} ${animClass}`.trim()}
            >
              {value !== 0 ? value : ""}
            </div>
          );
        }),
      )}
    </div>
  );
}
