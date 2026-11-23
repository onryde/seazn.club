// The americano partner grid (post "how-americano-works"): one square for every pair of players, holding the round(s) in
// which those two played on the SAME side. An empty square is a pair that never partnered, two numbers a pair that
// partnered twice, so the whole rotation's coverage reads at a glance. Every word it shows comes from the model (the
// example's golden): the caption is the model's title, which says how to read the grid.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): eight players fit in 320 units.
import type { DiagramModel } from "@/blog/examples/types";

type PartnerGridModel = Extract<DiagramModel, { kind: "partnerGrid" }>;

const CELL = 34;
const LABEL = 40;

/** round numbers per unordered pair, keyed "a|b" in player order. */
function partnerRounds(model: PartnerGridModel): Map<string, number[]> {
  const index = new Map(model.players.map((p, i) => [p, i]));
  const out = new Map<string, number[]>();
  model.rounds.forEach((round, r) => {
    for (const [a, b] of round.pairs) {
      const [x, y] = [index.get(a)!, index.get(b)!].sort((m, n) => m - n);
      const key = `${model.players[x!]}|${model.players[y!]}`;
      out.set(key, [...(out.get(key) ?? []), r + 1]);
    }
  });
  return out;
}

export function AmericanoPartnerGrid({ model }: { model: PartnerGridModel }) {
  const n = model.players.length;
  const rounds = partnerRounds(model);
  const width = LABEL + (n - 1) * CELL;
  const height = LABEL + (n - 1) * CELL;
  const titleId = "blog-diagram-partner-grid-title";
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="partnerGrid">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {/* column heads: players 2..n; row heads: players 1..n-1 (a triangle, each pair once) */}
        {model.players.slice(1).map((p, j) => (
          <text key={`c-${p}`} x={LABEL + j * CELL + CELL / 2} y={LABEL - 10} textAnchor="middle" className="fill-slate-600 text-[11px] font-semibold">
            {p}
          </text>
        ))}
        {model.players.slice(0, -1).map((p, i) => (
          <text key={`r-${p}`} x={LABEL - 6} y={LABEL + i * CELL + CELL / 2 + 4} textAnchor="end" className="fill-slate-600 text-[11px] font-semibold">
            {p}
          </text>
        ))}
        {model.players.slice(0, -1).flatMap((a, i) =>
          model.players.slice(i + 1).map((b, k) => {
            const j = i + k; // column index: player i+1+k sits in column i+k
            const met = rounds.get(`${a}|${b}`) ?? [];
            const x = LABEL + j * CELL;
            const y = LABEL + i * CELL;
            return (
              <g key={`${a}-${b}`}>
                <rect
                  x={x + 1}
                  y={y + 1}
                  width={CELL - 2}
                  height={CELL - 2}
                  rx={5}
                  className={met.length === 0 ? "fill-white stroke-slate-300" : met.length === 1 ? "fill-purple-100 stroke-purple-300" : "fill-amber-100 stroke-amber-400"}
                  strokeDasharray={met.length === 0 ? "3 3" : undefined}
                />
                {met.length > 0 ? (
                  <text x={x + CELL / 2} y={y + CELL / 2 + 4} textAnchor="middle" className="fill-slate-900 text-[11px] font-semibold">
                    {met.join("·")}
                  </text>
                ) : null}
              </g>
            );
          }),
        )}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
