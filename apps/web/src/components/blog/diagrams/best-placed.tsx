// Best third-placed teams (post "best-third-placed-teams"): one card per group's candidate, best first as the cross-group order ranks
// them, the first `take` marked as through. Each card says the team and its group, what was counted, and what was left out. Every
// word is the model's (the example's golden); the caption is the model's title, which says in words what the picture shows.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): the cards are 292 units wide and every text is 13
// units, which a 288px column draws at 12.5px.
import type { DiagramModel } from "@/blog/examples/types";

type BestModel = Extract<DiagramModel, { kind: "bestPlaced" }>;

const WIDTH = 300;
const PAD = 4;
const GAP = 8;
const LINE_H = 20;
const FONT = 13;
const CARD_H = 4 * LINE_H + 14;

export function BestPlaced({ model }: { model: BestModel }) {
  const n = model.candidates.length;
  if (n < 2 || n > 8) throw new Error(`blog diagram: a best-placed picture draws 2 to 8 cards, got ${n}`);
  if (model.take < 1 || model.take >= n) throw new Error(`blog diagram: ${model.take} through of ${n} cards is no cut`);
  const cardW = WIDTH - 2 * PAD;
  const height = PAD + n * CARD_H + (n - 1) * GAP + PAD;
  const titleId = "blog-diagram-best-placed-title";
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="bestPlaced">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {model.candidates.map((c, i) => {
          const through = i < model.take;
          const y = PAD + i * (CARD_H + GAP);
          return (
            <g key={`c-${i}`} data-card={i} data-through={through ? "yes" : "no"}>
              <rect x={PAD} y={y} width={cardW} height={CARD_H} rx={8} className={through ? "fill-purple-50 stroke-purple-300" : "fill-white stroke-slate-300"} />
              <text x={PAD + 10} y={y + 20} fontSize={FONT} className={through ? "fill-slate-900 font-bold" : "fill-slate-600 font-bold"}>
                {c.team}
              </text>
              <text x={PAD + cardW - 10} y={y + 20} fontSize={FONT} textAnchor="end" className={through ? "fill-purple-700 font-semibold" : "fill-slate-500 font-semibold"}>
                {through ? "Through" : "Out"}
              </text>
              <text x={PAD + 10} y={y + 20 + LINE_H} fontSize={FONT} className="fill-slate-500">
                {c.group}
              </text>
              <text x={PAD + 10} y={y + 20 + 2 * LINE_H} fontSize={FONT} className="fill-slate-900">
                {`${c.counted}`}
              </text>
              <text x={PAD + 10} y={y + 20 + 3 * LINE_H} fontSize={FONT} className="fill-slate-500 italic">
                {c.leftOut}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
