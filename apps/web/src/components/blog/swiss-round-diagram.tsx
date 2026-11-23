// The Swiss round grid (design: "Pictures and diagrams"): one round of a Swiss as the example's own result has it. Each board is a
// card with its two players, the points each takes into the round, the colours in chess and the result; a board that pairs two
// different scores (a float) is outlined and tagged "float" (never by colour alone); a bye and a player the round did not seat are
// strips under the boards. Pure drawing of a `swissRound` model: nothing here decides who plays whom.
//
// Sized by its viewBox, so it scales to the column and never scrolls the page. `role="img"` plus a <title>; the <figcaption>
// repeats the key fact in text (the model's `title`), which is what a screen reader and the copy-truth sweep read.
import type { DiagramModel } from "@/blog/examples/types";

type SwissRound = Extract<DiagramModel, { kind: "swissRound" }>;

const W = 360;
const GUTTER = 34;
const CARD_X = GUTTER;
const CARD_W = W - GUTTER - 4;
const HEAD_H = 20;
const BOARD_H = 56;
const GAP = 8;
const STRIP_H = 30;

function Chip({ x, y, white }: { x: number; y: number; white: boolean }) {
  return <rect x={x} y={y} width={10} height={10} rx={2} className={white ? "fill-white stroke-slate-500" : "fill-slate-800 stroke-slate-800"} strokeWidth={1.2} />;
}

export function SwissRoundDiagram({ model }: { model: SwissRound }) {
  const hasColours = model.pairings.some((p) => p.firstWhite !== undefined);
  const strips: { key: string; kind: "bye" | "out"; text: string }[] = [
    ...model.byes.map((b) => ({ key: `bye-${b}`, kind: "bye" as const, text: `Bye: ${b}` })),
    ...(model.notSeated ?? []).map((n) => ({ key: `out-${n.name}`, kind: "out" as const, text: `${n.name}: ${n.why}` })),
  ];
  const boardsH = model.pairings.length * (BOARD_H + GAP);
  const H = HEAD_H + boardsH + strips.length * (STRIP_H + GAP) + 2;
  const id = `swiss-round-${model.round}`;
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="swissRound">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-title`} className="block h-auto w-full max-w-[44rem]" fontFamily="inherit">
        <title id={`${id}-title`}>{model.title}</title>
        <g className="fill-slate-500" fontSize={10}>
          <text x={4} y={13}>
            Board
          </text>
          <text x={266} y={13} textAnchor="end">
            Points in
          </text>
          <text x={W - 8} y={13} textAnchor="end">
            Result
          </text>
        </g>
        {model.pairings.map((p, i) => {
          const y = HEAD_H + i * (BOARD_H + GAP);
          return (
            <g key={p.board} data-board={p.board}>
              <text x={14} y={y + 24} textAnchor="middle" fontSize={14} fontWeight={600} className="fill-slate-700">
                {p.board}
              </text>
              {p.float ? (
                <text x={14} y={y + 42} textAnchor="middle" fontSize={9} fontWeight={600} className="fill-purple-700">
                  float
                </text>
              ) : null}
              <rect x={CARD_X} y={y} width={CARD_W} height={BOARD_H} rx={8} className={p.float ? "fill-purple-50 stroke-purple-500" : "fill-white stroke-slate-300"} strokeWidth={p.float ? 1.6 : 1} />
              {hasColours && p.firstWhite !== undefined ? <Chip x={CARD_X + 10} y={y + 13} white={p.firstWhite} /> : null}
              <text x={CARD_X + (hasColours ? 28 : 12)} y={y + 22} fontSize={13} fontWeight={600} className="fill-slate-900">
                {p.first}
              </text>
              <text x={266} y={y + 22} textAnchor="end" fontSize={13} className="fill-slate-700">
                {p.firstScore ?? ""}
              </text>
              {hasColours && p.firstWhite !== undefined ? <Chip x={CARD_X + 10} y={y + 35} white={!p.firstWhite} /> : null}
              <text x={CARD_X + (hasColours ? 28 : 12)} y={y + 44} fontSize={13} fontWeight={600} className="fill-slate-900">
                {p.second ?? "No opponent"}
              </text>
              <text x={266} y={y + 44} textAnchor="end" fontSize={13} className="fill-slate-700">
                {p.secondScore ?? ""}
              </text>
              {p.result !== undefined ? (
                <text x={W - 8} y={y + 33} textAnchor="end" fontSize={13} fontWeight={600} className="fill-slate-900">
                  {p.result}
                </text>
              ) : null}
            </g>
          );
        })}
        {strips.map((s, i) => {
          const y = HEAD_H + boardsH + i * (STRIP_H + GAP);
          return (
            <g key={s.key} data-strip={s.kind}>
              <rect x={CARD_X} y={y} width={CARD_W} height={STRIP_H} rx={8} className={s.kind === "bye" ? "fill-slate-50 stroke-slate-400" : "fill-slate-100 stroke-slate-300"} strokeWidth={1} strokeDasharray={s.kind === "bye" ? undefined : "4 3"} />
              <text x={CARD_X + 12} y={y + 19} fontSize={12} className={s.kind === "bye" ? "fill-slate-800" : "fill-slate-600"} fontWeight={s.kind === "bye" ? 600 : 400}>
                {s.text}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1.5 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
