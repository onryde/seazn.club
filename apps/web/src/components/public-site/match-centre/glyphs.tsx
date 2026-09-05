// Spectator surface W1, Task 11 — ball-by-ball glyph chips for the "this
// over" strip. Glyph strings come straight off the document (schema comment
// on `CricketInningsView.overs[].glyphs` / `CricketView.live.thisOver`):
// "1","4","W","wd","nb+2","·" — this component never re-derives what
// happened on a ball, only how it LOOKS.
//
// Task 8 (spectator dictionary coverage), review fix round 1 — `GLYPH_KINDS`
// used to be a HAND-TYPED 9-entry array living beside `classesFor`, which the
// review correctly called a drift risk: `classesFor` only ever had 5 real
// branches (boundary covers both "4" and "6"; extras covers the whole
// wd/nb/lb/b-prefixed group under one style; wicket and dot are singletons;
// everything else falls through to one default "run" bucket), so the 9-entry
// list was already an invented finer split, not a mirror. `GLYPH_CLASSES`
// below is now the ONE table both `classesFor` and `GLYPH_KINDS` read — a
// branch cannot exist without a key, and a key cannot exist without a branch.
//
// This family has NO renderer consumer today: `Glyph` renders the raw glyph
// string with no dictionary lookup at all (no `t()`, no `aria-label`). Task 8
// added `matchCentre.ball.<kind>` speculatively, in the same risk category as
// `BUILDER_ONLY_KEYS` in the coverage test — see that test's own comment.
const BASE =
  "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums";

/** One entry per visually-distinct category `classesFor` used to hand-check
 *  in sequence — order matters, since "run" is the catch-all and must stay
 *  last. `test` decides membership; `className` is what `Glyph` renders. */
const GLYPH_CLASSES = {
  boundary: {
    test: (g: string) => g === "4" || g === "6",
    className: `${BASE} bg-accent text-accent-ink`,
  },
  wicket: {
    test: (g: string) => g === "W",
    className: `${BASE} bg-ink text-canvas`,
  },
  // Review fix round 2 (minor) — `text-ink-muted` (≈4.6:1) replaces
  // `text-zinc-400` (a new primitive, not `live-score.tsx`'s own house
  // style, which this leaves untouched).
  dot: {
    test: (g: string) => g === "·",
    className: `${BASE} bg-zinc-100 text-ink-muted`,
  },
  // "wd", "nb", "nb+2", "lb", "b" and any wide/no-ball/bye variant — outlined
  // rather than filled, distinct from a plain scoring run.
  extras: {
    test: (g: string) => /^(wd|nb|lb|b)/i.test(g),
    className: `${BASE} border border-zinc-300 text-zinc-600`,
  },
  // Plain run counts: "0","1","2","3","5" — the catch-all, so its `test`
  // always matches and it MUST stay last in this object's key order.
  run: {
    test: () => true,
    className: `${BASE} bg-zinc-100 text-zinc-700`,
  },
} as const satisfies Record<string, { test: (g: string) => boolean; className: string }>;

/** Insertion order of a plain-string-keyed object is enumeration order in JS
 *  — `run`'s always-true test staying last in `GLYPH_CLASSES` is what keeps
 *  it a fallback rather than swallowing every glyph. */
export const GLYPH_KINDS = Object.keys(GLYPH_CLASSES) as (keyof typeof GLYPH_CLASSES)[];

function classesFor(g: string): string {
  for (const kind of GLYPH_KINDS) {
    if (GLYPH_CLASSES[kind].test(g)) return GLYPH_CLASSES[kind].className;
  }
  // Unreachable — `run`'s test is `() => true` — but keeps this function
  // typed as returning `string`, not `string | undefined`.
  return GLYPH_CLASSES.run.className;
}

export function Glyph({ g }: { g: string }) {
  return (
    <span data-testid="mc-glyph" className={classesFor(g)}>
      {g}
    </span>
  );
}
