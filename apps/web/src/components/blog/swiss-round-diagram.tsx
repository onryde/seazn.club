// The Swiss round grid (design: "Pictures and diagrams"): one round of a Swiss as the example's own result has it. Each board is a
// card with its two players, the points each takes into the round, the colours in chess and the result; a board that pairs two
// different scores (a float) is outlined and tagged "float" (never by colour alone); a bye and a player the round did not seat are
// strips under the boards. Pure drawing of a `swissRound` model: nothing here decides who plays whom.
//
// Sized by its viewBox, so it scales to the column and never scrolls the page. `role="img"` plus a <title>; the <figcaption>
// repeats the key fact in text (the model's `title`), which is what a screen reader and the copy-truth sweep read.
//
// TEXT SIZE. The drawing scales with its box, so a font size here is a size in viewBox units. The blog column is 288px wide at a
// 320px screen (16px gutters) and the viewBox is 300 units wide, so a unit is 0.96px there and the smallest text below, 13 units,
// is 12.5px: the house small-text size (Tailwind `text-xs`, 12px) or more. On a desktop the figure is capped at 24rem, so the text
// grows to about 17px at most. `swiss-round-diagram.test.tsx` measures every text at the 320 column.
import type { DiagramModel } from "@/blog/examples/types";

type SwissRound = Extract<DiagramModel, { kind: "swissRound" }>;

const W = 300;
const GUTTER = 30;
const CARD_X = GUTTER;
const CARD_W = W - GUTTER - 4;
const HEAD_H = 22;
const BOARD_H = 62;
const GAP = 8;
const BYE_H = 32;
const OUT_H = 48;
/** Where the points-in column ends and where the result column ends (right-aligned text). */
const POINTS_X = 206;
const RESULT_X = W - 8;

function Chip({ x, y, white }: { x: number; y: number; white: boolean }) {
  return <rect x={x} y={y} width={10} height={10} rx={2} className={white ? "fill-white stroke-slate-500" : "fill-slate-800 stroke-slate-800"} strokeWidth={1.2} />;
}

export function SwissRoundDiagram({ model }: { model: SwissRound }) {
  const hasColours = model.pairings.some((p) => p.firstWhite !== undefined);
  const strips: { key: string; kind: "bye" | "out"; text: string; why?: string }[] = [
    ...model.byes.map((b) => ({ key: `bye-${b}`, kind: "bye" as const, text: `Bye: ${b}` })),
    ...(model.notSeated ?? []).map((n) => ({ key: `out-${n.name}`, kind: "out" as const, text: n.name, why: n.why })),
  ];
  const heightOf = (s: { kind: "bye" | "out" }) => (s.kind === "bye" ? BYE_H : OUT_H);
  const boardsH = model.pairings.length * (BOARD_H + GAP);
  const stripsH = strips.reduce((sum, s) => sum + heightOf(s) + GAP, 0);
  const H = HEAD_H + boardsH + stripsH + 2;
  const id = `swiss-round-${model.round}`;
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="swissRound">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-title`} className="block h-auto w-full max-w-[24rem]" fontFamily="inherit">
        <title id={`${id}-title`}>{model.title}</title>
        <g className="fill-slate-500" fontSize={13}>
          <text x={2} y={15}>
            Board
          </text>
          <text x={POINTS_X} y={15} textAnchor="end">
            Points in
          </text>
          <text x={RESULT_X} y={15} textAnchor="end">
            Result
          </text>
        </g>
        {model.pairings.map((p, i) => {
          const y = HEAD_H + i * (BOARD_H + GAP);
          return (
            <g key={p.board} data-board={p.board}>
              <text x={15} y={y + 27} textAnchor="middle" fontSize={15} fontWeight={600} className="fill-slate-700">
                {p.board}
              </text>
              {p.float ? (
                <text x={15} y={y + 47} textAnchor="middle" fontSize={13} fontWeight={600} className="fill-purple-700">
                  float
                </text>
              ) : null}
              <rect x={CARD_X} y={y} width={CARD_W} height={BOARD_H} rx={8} className={p.float ? "fill-purple-50 stroke-purple-500" : "fill-white stroke-slate-300"} strokeWidth={p.float ? 1.6 : 1} />
              {hasColours && p.firstWhite !== undefined ? <Chip x={CARD_X + 10} y={y + 15} white={p.firstWhite} /> : null}
              <text x={CARD_X + (hasColours ? 28 : 12)} y={y + 26} fontSize={14} fontWeight={600} className="fill-slate-900">
                {p.first}
              </text>
              <text x={POINTS_X} y={y + 26} textAnchor="end" fontSize={14} className="fill-slate-700">
                {p.firstScore ?? ""}
              </text>
              {hasColours && p.firstWhite !== undefined ? <Chip x={CARD_X + 10} y={y + 40} white={!p.firstWhite} /> : null}
              <text x={CARD_X + (hasColours ? 28 : 12)} y={y + 51} fontSize={14} fontWeight={600} className="fill-slate-900">
                {p.second ?? "No opponent"}
              </text>
              <text x={POINTS_X} y={y + 51} textAnchor="end" fontSize={14} className="fill-slate-700">
                {p.secondScore ?? ""}
              </text>
              {p.result !== undefined ? (
                <text x={RESULT_X} y={y + 39} textAnchor="end" fontSize={14} fontWeight={600} className="fill-slate-900">
                  {p.result}
                </text>
              ) : null}
            </g>
          );
        })}
        {strips.map((s, i) => {
          const y = HEAD_H + boardsH + strips.slice(0, i).reduce((sum, t) => sum + heightOf(t) + GAP, 0);
          return (
            <g key={s.key} data-strip={s.kind}>
              <rect x={CARD_X} y={y} width={CARD_W} height={heightOf(s)} rx={8} className={s.kind === "bye" ? "fill-slate-50 stroke-slate-400" : "fill-slate-100 stroke-slate-300"} strokeWidth={1} strokeDasharray={s.kind === "bye" ? undefined : "4 3"} />
              <text x={CARD_X + 12} y={y + 21} fontSize={14} fontWeight={600} className="fill-slate-800">
                {s.text}
              </text>
              {s.why !== undefined ? (
                <text x={CARD_X + 12} y={y + 39} fontSize={13} className="fill-slate-600">
                  {s.why}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1.5 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
