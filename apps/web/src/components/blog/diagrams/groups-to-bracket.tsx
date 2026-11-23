// Groups into a knockout (post "groups-into-knockout"): the groups side by side, each listing its teams in finishing order with the ones
// that go through marked, and below them the bracket's first round as match cards. Every word it shows comes from the model (the
// example's golden); the caption is the model's title, which says in words what the picture shows. A place with no team in the model
// (`null`) is an empty line in the draw and reads "Straight through".
//
// Sized by its viewBox and scaled to the column (no horizontal scroll at 320): three groups fit in 300 units, every text is 13 units,
// which a 288px column draws at 12.5px.
import type { DiagramModel } from "@/blog/examples/types";

type GroupsModel = Extract<DiagramModel, { kind: "groupsToBracket" }>;

const WIDTH = 300;
const PAD = 4;
const GAP = 8;
const LINE_H = 24;
const HEAD_H = 28;
const FONT = 13;
const ARROW_H = 26;

export function GroupsToBracket({ model }: { model: GroupsModel }) {
  const cols = model.groups.length;
  if (cols < 2 || cols > 4) throw new Error(`blog diagram: a groups-to-bracket picture draws 2 to 4 groups, got ${cols}`);
  const groupW = Math.floor((WIDTH - 2 * PAD - (cols - 1) * GAP) / cols);
  const groupRows = Math.max(...model.groups.map((g) => g.entrants.length));
  const groupsH = HEAD_H + groupRows * LINE_H + 6;
  const cardW = Math.floor((WIDTH - 2 * PAD - GAP) / 2);
  const cardH = 2 * LINE_H + 6;
  const titleId = "blog-diagram-groups-to-bracket-title";
  const groupsTop = PAD;
  const roundsTop = groupsTop + groupsH + ARROW_H;
  const roundHeight = (matches: number) => HEAD_H + Math.ceil(matches / 2) * (cardH + GAP);
  const rounds = model.bracket.map((round, r) => ({ round, top: roundsTop + model.bracket.slice(0, r).reduce((sum, earlier) => sum + roundHeight(earlier.matches.length), 0) }));
  const height = roundsTop + model.bracket.reduce((sum, round) => sum + roundHeight(round.matches.length), 0) + PAD;
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="groupsToBracket">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-labelledby={titleId} className="mx-auto block h-auto w-full max-w-[26rem]">
        <title id={titleId}>{model.title}</title>
        {model.groups.map((g, i) => {
          const x = PAD + i * (groupW + GAP);
          return (
            <g key={`g-${i}`} data-group={i}>
              <rect x={x} y={groupsTop} width={groupW} height={groupsH} rx={8} className="fill-white stroke-slate-300" />
              <text x={x + 8} y={groupsTop + 19} fontSize={FONT} className="fill-slate-500 font-semibold">
                {g.name}
              </text>
              {g.entrants.map((name, k) => {
                const through = k < g.advancing;
                const ty = groupsTop + HEAD_H + k * LINE_H;
                return (
                  <g key={`e-${k}`} data-through={through ? "yes" : "no"}>
                    {through ? <rect x={x + 3} y={ty} width={groupW - 6} height={LINE_H - 2} rx={5} className="fill-purple-100" /> : null}
                    <text x={x + 8} y={ty + 16} fontSize={FONT} className={through ? "fill-slate-900 font-bold" : "fill-slate-500"}>
                      {name}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
        <path data-arrow="" d={`M ${WIDTH / 2} ${groupsTop + groupsH + 4} V ${groupsTop + groupsH + ARROW_H - 6} m -5 -6 l 5 6 l 5 -6`} className="fill-none stroke-slate-400" strokeWidth={1.5} />
        {rounds.map(({ round, top }, r) => (
          <g key={`r-${r}`} data-round={r}>
            <text x={PAD} y={top + 19} fontSize={FONT} className="fill-slate-500 font-semibold">
              {round.name}
            </text>
            {round.matches.map((m, k) => {
              const x = PAD + (k % 2) * (cardW + GAP);
              const cy = top + HEAD_H + Math.floor(k / 2) * (cardH + GAP);
              return (
                <g key={`m-${k}`} data-match={k}>
                  <rect x={x} y={cy} width={cardW} height={cardH} rx={8} className="fill-white stroke-slate-300" />
                  <path d={`M ${x} ${cy + LINE_H + 3} H ${x + cardW}`} className="stroke-slate-200" />
                  {[m.home, m.away].map((side, s) => (
                    <text key={`s-${s}`} x={x + 8} y={cy + s * LINE_H + 19} fontSize={FONT} className={side === null ? "fill-slate-400 italic" : "fill-slate-900 font-semibold"}>
                      {side ?? "Straight through"}
                    </text>
                  ))}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <figcaption className="mt-2 text-sm text-slate-600">{model.title}</figcaption>
    </figure>
  );
}
