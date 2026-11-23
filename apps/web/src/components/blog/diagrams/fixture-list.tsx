// Withdrawal in a league and joining a league late (posts "withdrawal-in-a-league" and "joining-a-league-late"): the matches of one team,
// listed by round, in one or more cases. Each case has a heading, a two-part verdict, and one line per match: its round, the opponent
// and what became of the match. Every word is the model's (the example's golden); the caption is the model's title, which says in words
// what the picture shows. A dot beside each line is coloured by what became of the match, and the words say the same, so colour never
// carries the meaning alone.
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): every text is 13 units, which a 288px column draws at
// 12.5px; the round, the opponent and the fate each have their own column so no line runs into the next.
import type { DiagramModel } from "@/blog/examples/types";

type ListModel = Extract<DiagramModel, { kind: "fixtureList" }>;

const WIDTH = 300;
const PAD = 4;
const FONT = 13;
const LINE_H = 24;
const HEAD_H = 56;
const GAP = 18;
const DOT_X = PAD + 6;
const ROUND_X = PAD + 18;
const OPPONENT_X = 86;

const DOT: Record<ListModel["scenes"][number]["lines"][number]["tone"], string> = {
  keep: "fill-purple-600",
  award: "fill-purple-300",
  drop: "fill-slate-300",
  new: "fill-amber-500",
};

export function FixtureList({ model }: { model: ListModel }) {
  if (model.scenes.length < 1 || model.scenes.length > 3) throw new Error(`blog diagram: a fixture list draws 1 to 3 cases, got ${model.scenes.length}`);
  for (const s of model.scenes) {
    if (s.lines.length < 1 || s.lines.length > 10) throw new Error(`blog diagram: a case lists 1 to 10 matches, got ${s.lines.length}`);
  }
  const blockH = (lines: number) => HEAD_H + lines * LINE_H;
  const height = PAD + model.scenes.reduce((n, s) => n + blockH(s.lines.length) + GAP, 0) - GAP + PAD;
  const titleId = "blog-diagram-fixture-list-title";
  const tops = model.scenes.map((_, i) => PAD + model.scenes.slice(0, i).reduce((n, s) => n + blockH(s.lines.length) + GAP, 0));
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="fixtureList">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {model.scenes.map((scene, i) => {
          const top = tops[i]!;
          return (
            <g key={`s-${i}`} data-scene={i}>
              <text x={PAD} y={top + 15} fontSize={FONT} className="fill-slate-900 font-bold">
                {scene.heading}
              </text>
              <text x={PAD} y={top + 33} fontSize={FONT} className="fill-slate-700">
                {scene.lead}
              </text>
              <text x={PAD} y={top + 49} fontSize={FONT} className="fill-slate-700">
                {scene.effect}
              </text>
              {scene.lines.map((line, j) => {
                const ly = top + HEAD_H + j * LINE_H;
                return (
                  <g key={`l-${j}`} data-line={j}>
                    <circle cx={DOT_X} cy={ly + 10} r={4} className={DOT[line.tone]} />
                    <text x={ROUND_X} y={ly + 15} fontSize={FONT} className="fill-slate-500">
                      {line.round}
                    </text>
                    <text x={OPPONENT_X} y={ly + 15} fontSize={FONT} className="fill-slate-900 font-semibold">
                      {line.opponent}
                    </text>
                    <text x={WIDTH - PAD} y={ly + 15} fontSize={FONT} textAnchor="end" className="fill-slate-900">
                      {line.fate}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
