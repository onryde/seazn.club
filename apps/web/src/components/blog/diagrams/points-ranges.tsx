// Clinched or eliminated (post "clinched-or-eliminated"): one bar per team on a shared points axis, from the fewest points the team can
// still finish on to the most, a dot at the points it has now, and the words the table shows for it. Every word and number is the
// model's (the example's golden); the caption is the model's title, which says in words what the picture shows.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): the bars span 292 units, every text is 13 units, which a
// 288px column draws at 12.5px. A bar's colour follows the words: purple for through and win-and-in, a lighter purple for needs help,
// grey for out; the words are always printed, so colour never carries the meaning alone.
import type { DiagramModel } from "@/blog/examples/types";

type RangesModel = Extract<DiagramModel, { kind: "pointsRanges" }>;

const WIDTH = 300;
const PAD = 4;
const ROW_H = 46;
const FONT = 13;
const BAR_Y = 28;
const BAR_H = 10;

export function PointsRanges({ model }: { model: RangesModel }) {
  const n = model.rows.length;
  if (n < 2 || n > 12) throw new Error(`blog diagram: a points-ranges picture draws 2 to 12 teams, got ${n}`);
  if (!(model.axisMax > 0)) throw new Error("blog diagram: a points-ranges picture needs an axis longer than zero");
  for (const row of model.rows) {
    if (!(row.worst <= row.now && row.now <= row.best && row.best <= model.axisMax)) throw new Error(`blog diagram: ${row.team}'s range ${row.worst} to ${row.best} (now ${row.now}) does not fit the axis 0 to ${model.axisMax}`);
  }
  const span = WIDTH - 2 * PAD;
  const at = (points: number) => PAD + (points / model.axisMax) * span;
  const height = PAD + n * ROW_H + PAD;
  const titleId = "blog-diagram-points-ranges-title";
  const tone = (label: string) => (/^(Through|Qualified|Win)/.test(label) ? "fill-purple-600" : /^Needs/.test(label) ? "fill-purple-300" : "fill-slate-300");
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="pointsRanges">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {model.rows.map((row, i) => {
          const y = PAD + i * ROW_H;
          return (
            <g key={`r-${i}`} data-row={i}>
              <text x={PAD} y={y + 17} fontSize={FONT} className="fill-slate-900 font-bold">
                {row.team}
              </text>
              <text x={PAD + 92} y={y + 17} fontSize={FONT} className="fill-slate-500">
                {`${row.worst} to ${row.best}`}
              </text>
              <text x={WIDTH - PAD} y={y + 17} fontSize={FONT} textAnchor="end" className="fill-slate-900 font-semibold">
                {row.label}
              </text>
              <rect x={PAD} y={y + BAR_Y} width={span} height={BAR_H} rx={5} className="fill-slate-100" />
              <rect data-bar="" x={at(row.worst)} y={y + BAR_Y} width={Math.max(at(row.best) - at(row.worst), 2)} height={BAR_H} rx={5} className={tone(row.label)} />
              <circle data-now="" cx={at(row.now)} cy={y + BAR_Y + BAR_H / 2} r={4.5} className="fill-white stroke-slate-900" strokeWidth={1.5} />
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
