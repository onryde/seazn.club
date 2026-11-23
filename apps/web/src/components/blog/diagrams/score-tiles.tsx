// The walkover score of every sport at a glance (post "forfeits-and-walkovers-by-sport"): one tile per sport, its name over
// the score a walkover shows there. Every word it shows comes from the model (the example's golden); the caption is the
// model's title, which says what the tiles have in common in words.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): three tiles across fit in 316 units.
import type { DiagramModel } from "@/blog/examples/types";

type TilesModel = Extract<DiagramModel, { kind: "scoreTiles" }>;

const COLS = 3;
const TILE_W = 100;
const TILE_H = 50;
const GAP = 8;

export function ScoreTiles({ model }: { model: TilesModel }) {
  const rows = Math.ceil(model.tiles.length / COLS);
  const width = COLS * TILE_W + (COLS - 1) * GAP;
  const height = rows * TILE_H + (rows - 1) * GAP;
  const titleId = "blog-diagram-score-tiles-title";
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="scoreTiles">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {model.tiles.map((t, i) => {
          const x = (i % COLS) * (TILE_W + GAP);
          const y = Math.floor(i / COLS) * (TILE_H + GAP);
          return (
            <g key={t.sport}>
              <rect x={x} y={y} width={TILE_W} height={TILE_H} rx={8} className="fill-white stroke-slate-300" />
              <text x={x + TILE_W / 2} y={y + 18} textAnchor="middle" className="fill-slate-600 text-[10px] font-semibold">
                {t.sport}
              </text>
              <text x={x + TILE_W / 2} y={y + 38} textAnchor="middle" className="fill-slate-900 text-[16px] font-bold">
                {t.score}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
