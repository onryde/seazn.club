// Spectator surface W1, Task 11 — ball-by-ball glyph chips for the "this
// over" strip. Glyph strings come straight off the document (schema comment
// on `CricketInningsView.overs[].glyphs` / `CricketView.live.thisOver`):
// "1","4","W","wd","nb+2","·" — this component never re-derives what
// happened on a ball, only how it LOOKS.
//
// Task 8 (spectator dictionary coverage) — `GLYPH_KINDS` is the semantic
// CATEGORY set `classesFor` below distinguishes, not the literal glyph
// strings (those are unbounded: "nb+2", "wd+1", any run count). It is the
// dictionary coverage test's dynamic family for `matchCentre.ball.<kind>` —
// exported here (rather than hand-copied into the test) so the two can never
// drift apart. Order mirrors `classesFor`'s own branches.
export const GLYPH_KINDS = [
  "four",
  "six",
  "wicket",
  "dot",
  "wide",
  "noball",
  "legbye",
  "bye",
  "run",
] as const;
const BASE =
  "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums";

function classesFor(g: string): string {
  if (g === "4" || g === "6") return `${BASE} bg-accent text-accent-ink`;
  if (g === "W") return `${BASE} bg-ink text-canvas`;
  // Review fix round 2 (minor) — `text-ink-muted` (≈4.6:1) replaces
  // `text-zinc-400` (a new primitive, not `live-score.tsx`'s own house
  // style, which this leaves untouched).
  if (g === "·") return `${BASE} bg-zinc-100 text-ink-muted`;
  // Extras — "wd", "nb", "nb+2", "lb", "b" and any wide/no-ball/bye variant —
  // outlined rather than filled, distinct from a plain scoring run.
  if (/^(wd|nb|lb|b)/i.test(g)) return `${BASE} border border-zinc-300 text-zinc-600`;
  return `${BASE} bg-zinc-100 text-zinc-700`; // plain run counts: "0","1","2","3","5"
}

export function Glyph({ g }: { g: string }) {
  return (
    <span data-testid="mc-glyph" className={classesFor(g)}>
      {g}
    </span>
  );
}
