// The circle method (post "round-robin-schedule"): the field laid out in two rows, one place held fixed (the first seed, or an empty
// seat when the field is odd) and the others moving round a loop, a column of the picture being a match. Every word it shows comes
// from the model (the example's golden); the caption is the model's title, which says in words what the picture shows.
//
// The loop runs along the top row left to right and back along the bottom row right to left: `rotating[0..cols-2]` fill the top
// row after the fixed place, and the rest fill the bottom row from its right end to its left. A column pairs a top place with the
// one under it, so `rotating[j]` meets `rotating[m-2-j]`, and the last place of the loop meets the fixed one.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): three columns fit in 300 units, and every text is
// 13 units, which a 288px column draws at 12.5px.
import type { DiagramModel } from "@/blog/examples/types";

type WheelModel = Extract<DiagramModel, { kind: "roundRobinWheel" }>;

const WIDTH = 300;
const PAD = 8;
const GAP = 16;
const PILL_H = 34;
const ROWS_GAP = 56;
const TOP = 34;
const FONT = 13;

export function RoundRobinWheel({ model }: { model: WheelModel }) {
  const m = model.rotating.length;
  if (m < 3 || m % 2 === 0) throw new Error(`blog diagram: a round-robin wheel has an odd number (3 or more) of places in its loop, got ${m}`);
  const cols = (m + 1) / 2;
  const pillW = Math.floor((WIDTH - 2 * PAD - (cols - 1) * GAP) / cols);
  const topNames = [model.fixed, ...model.rotating.slice(0, cols - 1)];
  const bottomNames = Array.from({ length: cols }, (_, i) => model.rotating[m - 1 - i]!);
  const x = (i: number) => PAD + i * (pillW + GAP);
  const yTop = TOP;
  const yBottom = TOP + PILL_H + ROWS_GAP;
  const height = yBottom + PILL_H + 30;
  const titleId = "blog-diagram-round-robin-wheel-title";
  const right = x(cols - 1) + pillW;
  const loopTop = yTop - 14;
  const loopBottom = yBottom + PILL_H + 14;
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="roundRobinWheel">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        <defs>
          <marker id="blog-wheel-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-slate-400" />
          </marker>
        </defs>
        {/* The loop the others move along: out along the top, down the right, back along the bottom. */}
        <path
          data-loop=""
          d={`M ${x(1) + pillW / 2} ${loopTop} H ${right + 10} V ${loopBottom} H ${x(0) + pillW / 2}`}
          className="fill-none stroke-slate-400"
          strokeWidth={1.5}
          markerEnd="url(#blog-wheel-arrow)"
        />
        {Array.from({ length: cols }, (_unused, i) => (
          <g key={`m-${i}`} data-match={i}>
            <path d={`M ${x(i) + pillW / 2} ${yTop + PILL_H} V ${yBottom}`} className="stroke-slate-300" strokeWidth={1.5} />
          </g>
        ))}
        {topNames.map((name, i) => (
          <g key={`t-${i}`} data-slot={i === 0 ? "fixed" : `top-${i}`}>
            <rect
              x={x(i)}
              y={yTop}
              width={pillW}
              height={PILL_H}
              rx={8}
              className={i === 0 ? "fill-slate-100 stroke-slate-400" : "fill-white stroke-slate-300"}
              strokeDasharray={i === 0 ? "4 3" : undefined}
            />
            <text x={x(i) + pillW / 2} y={yTop + PILL_H / 2 + 5} textAnchor="middle" fontSize={FONT} className={i === 0 ? "fill-slate-600 italic" : "fill-slate-900 font-semibold"}>
              {name}
            </text>
          </g>
        ))}
        {bottomNames.map((name, i) => (
          <g key={`b-${i}`} data-slot={`bottom-${i}`}>
            <rect x={x(i)} y={yBottom} width={pillW} height={PILL_H} rx={8} className="fill-white stroke-slate-300" />
            <text x={x(i) + pillW / 2} y={yBottom + PILL_H / 2 + 5} textAnchor="middle" fontSize={FONT} className="fill-slate-900 font-semibold">
              {name}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
