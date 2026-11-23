// A played bracket (blog batch 4: third-place-match, page-playoff-and-stepladder, double-elimination-explained,
// what-is-a-plate). Every match is a box of two seats, the winner's seat filled; a solid line carries a winner to the match it
// feeds, a dashed one carries a loser (a third-place match, a losers' bracket). Every word it shows comes from the model, which
// is the example's golden: the caption is the model's title and states the one fact the picture is for.
//
// The columns are the model's `rounds` (the builder lays them out so every feed comes from an earlier column); this file only
// places the boxes. A match fed by others stands at the mean height of its feeders, an unfed one takes the next free slot of its
// lane, and two matches that would land on the same slot are pushed apart, so no box covers another (`layoutBracket`, pinned by
// a test that checks every golden). Lanes are separate blocks, each headed by its name, so one figure can draw two formats.
//
// A bracket is wider than a phone, so the drawing keeps its natural size and scrolls INSIDE its own box, never the page
// (AGENTS.md class 23): the box is a named, focusable region, so a keyboard user can scroll it and axe's
// scrollable-region-focusable is satisfied. The caption sits outside the box, so the fact is on the screen without a swipe.
import type { BracketFeed, BracketMatchModel, DiagramModel } from "@/blog/examples/types";

type BracketModel = Extract<DiagramModel, { kind: "bracket" }>;

export const BOX_W = 116;
export const ROW_H = 20;
export const BOX_H = ROW_H * 2;
export const LABEL_H = 14;
export const GAP_X = 26;
export const GAP_Y = 12;
export const SLOT = LABEL_H + BOX_H + GAP_Y;
const PAD = 8;
const HEAD_H = 18;
const LEGEND_H = 20;

export interface PlacedMatch {
  key: string;
  match: BracketMatchModel;
  col: number;
  lane: string;
  /** In slots (one slot is a box, its label and the gap under it); a fed match stands at the mean of its feeders. */
  slot: number;
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  side: BracketFeed["side"];
  d: string;
}

export interface BracketLayout {
  boxes: PlacedMatch[];
  edges: PlacedEdge[];
  lanes: { name: string; y: number }[];
  width: number;
  height: number;
  hasLoserEdge: boolean;
}

function fail(why: string): never {
  throw new Error(`blog bracket diagram: ${why}`);
}

export function layoutBracket(model: BracketModel): BracketLayout {
  const all: Omit<PlacedMatch, "slot" | "x" | "y">[] = [];
  model.rounds.forEach((round, col) =>
    round.matches.forEach((match, i) => all.push({ key: match.id ?? `c${col}m${i}`, match, col, lane: match.lane ?? "" })),
  );
  if (all.length === 0) fail("the model has no matches");
  const keys = new Set<string>();
  for (const m of all) {
    if (keys.has(m.key)) fail(`two matches are called '${m.key}'`);
    keys.add(m.key);
  }
  const lanes = [...new Set(all.map((m) => m.lane))];
  const multi = lanes.length > 1;
  const placed = new Map<string, PlacedMatch>();
  const laneBase = new Map<string, number>();
  let cursor = 0;
  lanes.forEach((lane, laneIdx) => {
    laneBase.set(lane, cursor);
    const mine = all.filter((m) => m.lane === lane);
    const maxCol = Math.max(...mine.map((m) => m.col));
    let top = cursor;
    for (let col = 0; col <= maxCol; col++) {
      let nextFree = cursor;
      const taken: number[] = [];
      for (const m of mine.filter((x) => x.col === col)) {
        const feeds = [m.match.homeFrom, m.match.awayFrom].filter((f): f is BracketFeed => f !== undefined);
        const sources = feeds.map((f) => {
          const src = placed.get(f.id);
          if (src === undefined) fail(`'${m.key}' is fed by '${f.id}', which is not placed before it (a missing id, or a feed from a later column or lane)`);
          if (src.col >= col && src.lane === lane) fail(`'${m.key}' (column ${col}) is fed by '${f.id}' in column ${src.col}: a feed must come from an earlier column`);
          return src;
        });
        let slot = sources.length > 0 ? sources.reduce((a, s) => a + s.slot, 0) / sources.length : nextFree++;
        // Two matches of a column may not share a slot: push the later one down until it clears every box above it.
        while (taken.some((t) => Math.abs(t - slot) < 1)) slot += 1;
        taken.push(slot);
        top = Math.max(top, slot + 1);
        const laneOffset = multi ? (laneIdx + 1) * HEAD_H : 0;
        placed.set(m.key, { ...m, slot, x: PAD + col * (BOX_W + GAP_X), y: PAD + laneOffset + slot * SLOT });
      }
    }
    cursor = top + (multi ? 0.15 : 0);
  });

  const boxes = [...placed.values()];
  // Every edge is an elbow: out of the source's right side, down (or up) a channel in the gap before the target, into the seat.
  // Edges into the same column each take their own channel, so two lines never share a vertical run and read as one.
  const pending: { from: string; to: string; side: BracketFeed["side"]; x1: number; y1: number; x2: number; y2: number; col: number }[] = [];
  for (const to of boxes) {
    for (const [seat, feed] of [["home", to.match.homeFrom], ["away", to.match.awayFrom]] as const) {
      if (feed === undefined) continue;
      const from = placed.get(feed.id)!;
      pending.push({
        from: from.key,
        to: to.key,
        side: feed.side,
        x1: from.x + BOX_W,
        y1: from.y + LABEL_H + BOX_H / 2,
        x2: to.x,
        y2: to.y + LABEL_H + (seat === "home" ? ROW_H / 2 : ROW_H * 1.5),
        col: to.col,
      });
    }
  }
  const edges: PlacedEdge[] = [];
  for (const col of new Set(pending.map((e) => e.col))) {
    const group = pending.filter((e) => e.col === col).sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2);
    group.forEach((e, k) => {
      const xm = e.x2 - GAP_X + (GAP_X * (k + 1)) / (group.length + 1);
      edges.push({ from: e.from, to: e.to, side: e.side, d: `M ${e.x1} ${e.y1} H ${xm} V ${e.y2} H ${e.x2}` });
    });
  }
  const hasLoserEdge = edges.some((e) => e.side === "loser");
  const maxBottom = Math.max(...boxes.map((b) => b.y + LABEL_H + BOX_H));
  const maxCol = Math.max(...boxes.map((b) => b.col));
  return {
    boxes,
    edges,
    lanes: multi ? lanes.map((name, i) => ({ name, y: PAD + i * HEAD_H + laneBase.get(name)! * SLOT + HEAD_H - 5 })) : [],
    width: PAD * 2 + (maxCol + 1) * BOX_W + maxCol * GAP_X,
    height: maxBottom + PAD + (hasLoserEdge ? LEGEND_H : 0),
    hasLoserEdge,
  };
}

function Seat({ x, y, name, tag, won, lost }: { x: number; y: number; name: string | null; tag?: string; won: boolean; lost: boolean }) {
  return (
    <g>
      {won ? <rect x={x + 1} y={y + 1} width={BOX_W - 2} height={ROW_H - 2} rx={4} className="fill-purple-100" /> : null}
      <text x={x + 8} y={y + ROW_H / 2 + 4} className={`text-[12px] ${name === null ? "fill-slate-400 italic" : won ? "fill-slate-900 font-bold" : lost ? "fill-slate-500" : "fill-slate-800"}`}>
        {name ?? "bye"}
      </text>
      {tag !== undefined ? (
        <g>
          <rect x={x + BOX_W - 8 - (tag.length * 5.2 + 10)} y={y + 4} width={tag.length * 5.2 + 10} height={ROW_H - 8} rx={5} className="fill-amber-100 stroke-amber-400" strokeWidth={0.75} />
          <text x={x + BOX_W - 8 - (tag.length * 5.2 + 10) / 2} y={y + ROW_H / 2 + 3} textAnchor="middle" className="fill-amber-900 text-[9px] font-semibold">
            {tag}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export function BracketDiagram({ model }: { model: BracketModel }) {
  const layout = layoutBracket(model);
  const titleId = "blog-diagram-bracket-title";
  const capId = "blog-diagram-bracket-cap";
  // A label is printed once per run of boxes in a column that share it ("Quarter-finals" over four boxes, not four times).
  const labelled = new Set<string>();
  for (const col of new Set(layout.boxes.map((b) => b.col))) {
    let last: string | undefined;
    for (const b of layout.boxes.filter((x) => x.col === col).sort((a, c) => a.y - c.y)) {
      if (b.match.label !== undefined && b.match.label !== last) labelled.add(b.key);
      last = b.match.label;
    }
  }
  return (
    <figure className="my-8" data-testid="blog-diagram" data-diagram="bracket">
      <div
        role="region"
        aria-labelledby={capId}
        tabIndex={0}
        className="mx-auto w-fit max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-500"
      >
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-labelledby={titleId} className="block max-w-none">
          <title id={titleId}>{model.title}</title>
          {layout.lanes.map((l) => (
            <text key={l.name} x={PAD} y={l.y} className="fill-slate-600 text-[11px] font-semibold uppercase tracking-wide">
              {l.name}
            </text>
          ))}
          {layout.edges.map((e, i) => (
            <path key={i} d={e.d} fill="none" strokeWidth={1.5} className={e.side === "loser" ? "stroke-amber-500" : "stroke-slate-400"} strokeDasharray={e.side === "loser" ? "4 3" : undefined} />
          ))}
          {layout.boxes.map((b) => (
            <g key={b.key} data-match={b.key}>
              {labelled.has(b.key) ? (
                <text x={b.x + 2} y={b.y + LABEL_H - 3} className="fill-slate-600 text-[10px] font-semibold" stroke="white" strokeWidth={3} paintOrder="stroke">
                  {b.match.label}
                </text>
              ) : null}
              <rect x={b.x} y={b.y + LABEL_H} width={BOX_W} height={BOX_H} rx={6} className="fill-white stroke-slate-400" />
              <line x1={b.x} x2={b.x + BOX_W} y1={b.y + LABEL_H + ROW_H} y2={b.y + LABEL_H + ROW_H} className="stroke-slate-200" />
              <Seat x={b.x} y={b.y + LABEL_H} name={b.match.home} tag={b.match.home === null ? undefined : b.match.tags?.[b.match.home]} won={b.match.winner !== undefined && b.match.winner === b.match.home} lost={b.match.winner !== undefined && b.match.winner !== b.match.home} />
              <Seat x={b.x} y={b.y + LABEL_H + ROW_H} name={b.match.away} tag={b.match.away === null ? undefined : b.match.tags?.[b.match.away]} won={b.match.winner !== undefined && b.match.winner === b.match.away} lost={b.match.winner !== undefined && b.match.winner !== b.match.away} />
            </g>
          ))}
          {layout.hasLoserEdge ? (
            <g>
              <path d={`M ${PAD} ${layout.height - 10} h 22`} fill="none" strokeWidth={1.5} className="stroke-slate-400" />
              <text x={PAD + 28} y={layout.height - 6} className="fill-slate-600 text-[10px]">
                the winner goes on
              </text>
              <path d={`M ${PAD + 124} ${layout.height - 10} h 22`} fill="none" strokeWidth={1.5} className="stroke-amber-500" strokeDasharray="4 3" />
              <text x={PAD + 152} y={layout.height - 6} className="fill-slate-600 text-[10px]">
                the loser goes here
              </text>
            </g>
          ) : null}
        </svg>
      </div>
      <figcaption id={capId} className="mt-2 text-sm text-slate-600">
        {model.title}
      </figcaption>
    </figure>
  );
}
