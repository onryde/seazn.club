// A walkover in a bracket (posts "withdrawal-in-a-knockout" and "double-walkover"): rounds left to right, each match a box
// with its two sides and one short result line, the next round's match joined to the two that feed it. A side that left or
// did not turn up is struck through; the player who goes through is marked and bold. Every word it shows comes from the
// model (the example's golden); the caption is the model's title, which says what happened in words.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): two columns fit in 316 units.
import type { DiagramModel } from "@/blog/examples/types";

type BracketModel = Extract<DiagramModel, { kind: "walkoverBracket" }>;

const BOX_W = 132;
const ROW_H = 24;
const RESULT_H = 20;
const BOX_H = ROW_H * 2 + RESULT_H;
const GAP_Y = 18;
const GAP_X = 44;
const HEAD = 22;
const PAD = 4;

/** The vertical centre of every match, round by round: round one stacked, a later match centred between its two feeders. */
function centres(model: BracketModel): number[][] {
  const out: number[][] = [];
  model.rounds.forEach((round, r) => {
    if (r === 0) {
      out.push(round.matches.map((_, i) => HEAD + PAD + i * (BOX_H + GAP_Y) + BOX_H / 2));
      return;
    }
    const prev = out[r - 1]!;
    const ratio = prev.length / round.matches.length;
    out.push(
      round.matches.map((_, j) => {
        const feeders = ratio >= 2 ? [prev[j * 2]!, prev[j * 2 + 1] ?? prev[j * 2]!] : [prev[j] ?? prev[0]!];
        return feeders.reduce((a, b) => a + b, 0) / feeders.length;
      }),
    );
  });
  return out;
}

export function WalkoverBracket({ model }: { model: BracketModel }) {
  const mid = centres(model);
  const rowsInFirst = model.rounds[0]!.matches.length;
  const width = PAD * 2 + model.rounds.length * BOX_W + (model.rounds.length - 1) * GAP_X;
  const height = HEAD + PAD * 2 + rowsInFirst * BOX_H + (rowsInFirst - 1) * GAP_Y;
  const titleId = "blog-diagram-walkover-bracket-title";
  const x = (r: number) => PAD + r * (BOX_W + GAP_X);
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="walkoverBracket">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[24rem]">
        <title id={titleId}>{model.title}</title>
        {model.rounds.map((round, r) => (
          <text key={`h-${round.name}`} x={x(r)} y={HEAD - 8} className="fill-slate-500 text-[11px] font-semibold">
            {round.name}
          </text>
        ))}
        {model.rounds.slice(1).flatMap((round, k) => {
          const r = k + 1;
          return round.matches.flatMap((_, j) => {
            const prev = mid[r - 1]!;
            const ratio = prev.length / round.matches.length;
            const feeders = ratio >= 2 ? [j * 2, j * 2 + 1].filter((i) => i < prev.length) : [j].filter((i) => i < prev.length);
            const xm = x(r) - GAP_X / 2;
            return feeders.map((f) => (
              <path
                key={`c-${r}-${j}-${f}`}
                d={`M ${x(r - 1) + BOX_W} ${prev[f]} H ${xm} V ${mid[r]![j]} H ${x(r)}`}
                className="fill-none stroke-slate-300"
                strokeWidth={1.5}
              />
            ));
          });
        })}
        {model.rounds.flatMap((round, r) =>
          round.matches.map((m, i) => {
            const top = mid[r]![i]! - BOX_H / 2;
            return (
              <g key={`m-${r}-${i}`}>
                <rect x={x(r)} y={top} width={BOX_W} height={BOX_H} rx={6} className="fill-white stroke-slate-300" />
                {m.sides.map((side, s) => {
                  const struck = (m.struck ?? []).includes(side);
                  const won = m.winner === side;
                  const y = top + s * ROW_H;
                  return (
                    <g key={`s-${s}`}>
                      {won ? <rect x={x(r) + 1} y={y + 1} width={BOX_W - 2} height={ROW_H - 1} rx={5} className="fill-purple-100" /> : null}
                      <text
                        x={x(r) + 10}
                        y={y + ROW_H / 2 + 4}
                        className={`text-[12px] ${struck ? "fill-slate-400 line-through" : won ? "fill-slate-900 font-bold" : "fill-slate-900 font-semibold"}`}
                      >
                        {side}
                      </text>
                    </g>
                  );
                })}
                <path d={`M ${x(r)} ${top + ROW_H * 2} H ${x(r) + BOX_W}`} className="stroke-slate-200" />
                <text x={x(r) + 10} y={top + ROW_H * 2 + RESULT_H / 2 + 4} className="fill-slate-600 text-[10px]">
                  {m.result}
                </text>
              </g>
            );
          }),
        )}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
