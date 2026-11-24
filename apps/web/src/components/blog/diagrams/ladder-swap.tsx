// The ladder swap (post "how-a-ladder-works"): the ladder before a challenge on the left, after it on the right, rung 1 at
// the top. The challenger and the player challenged are marked on both sides; when the challenger won, the two swap rungs
// and nobody else moves. Every word it shows comes from the model (the example's golden): the caption is the model's
// title, which says which side is which.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320).
import type { DiagramModel } from "@/blog/examples/types";

type LadderModel = Extract<DiagramModel, { kind: "ladder" }>;

const ROW = 34;
const TOP = 12;
const COL_W = 116;
const NUM_W = 26;
const GAP = 52;

function after(model: LadderModel): string[] {
  if (!model.swapped) return [...model.rungs];
  return model.rungs.map((p) => (p === model.challenger ? model.target : p === model.target ? model.challenger : p));
}

function Column({ x, rungs, model }: { x: number; rungs: string[]; model: LadderModel }) {
  return (
    <g>
      {rungs.map((p, i) => {
        const y = TOP + i * ROW;
        const role = p === model.challenger ? "challenger" : p === model.target ? "target" : "other";
        return (
          <g key={p}>
            <text x={x + NUM_W - 8} y={y + ROW / 2 + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
              {i + 1}
            </text>
            <rect
              x={x + NUM_W}
              y={y + 3}
              width={COL_W - NUM_W}
              height={ROW - 6}
              rx={6}
              className={role === "challenger" ? "fill-purple-100 stroke-purple-500" : role === "target" ? "fill-amber-100 stroke-amber-500" : "fill-white stroke-slate-300"}
            />
            <text x={x + NUM_W + 10} y={y + ROW / 2 + 4} className="fill-slate-900 text-[12px] font-semibold">
              {p}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export function LadderSwap({ model }: { model: LadderModel }) {
  const n = model.rungs.length;
  const width = COL_W * 2 + GAP;
  const height = TOP * 2 + n * ROW;
  const titleId = "blog-diagram-ladder-title";
  const midY = TOP + (n * ROW) / 2;
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="ladder">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[22rem]">
        <title id={titleId}>{model.title}</title>
        <Column x={0} rungs={model.rungs} model={model} />
        <path d={`M ${COL_W + 10} ${midY} H ${COL_W + GAP - 10}`} className="stroke-slate-400" strokeWidth={2} markerEnd="url(#blog-ladder-arrow)" />
        <defs>
          <marker id="blog-ladder-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-slate-400" />
          </marker>
        </defs>
        <Column x={COL_W + GAP} rungs={after(model)} model={model} />
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
