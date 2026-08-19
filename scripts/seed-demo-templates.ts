// Stage templates for the demo seeder, extracted from seed-demo.ts so they
// can be imported by a test (that script calls main() at module scope, so
// importing it would run a seed). The gate that keeps them honest lives in
// scripts/__tests__/seed-demo-templates.test.ts.
// ── stage templates (mirror division-builder) ───────────────────────────────
// F2 (unified progression field): was `qualification` — mirrors
// components/v2/format-templates.ts's own conversion field-for-field.
// `topN: n` collapses onto `rankRange{from:1,to:n}` (owner ruling 4); the
// bare `{take: [...]}` (picks) shape becomes a kind-tagged `picks` TakeRule.
//
// `timing: "setup"` throughout, and groups_ko takes the cross-pool draw
// (F3 ultrareview finding 12). This block said `on_complete` "throughout —
// every one of these templates reproduces today's auto-seed-on-complete
// behaviour unchanged (Decision 1)", which was true until F3 flipped every
// picker template to day-one fixtures. Left alone, the demo org — the org a
// prospective organiser actually clicks through — showed a knockout stuck on
// TBD until the group stage completed, i.e. the OLD product, while the
// shipped template draws the bracket on day one.
//
// groups_ko's hand-rolled `picks` interleave went with it: it hardcoded
// pools "A"/"B" and so qualified NOBODY from a third or later pool (ruling
// 10). Harmless at this file's own pools:{count:2}, but it is a copy of a
// rule that lives in format-templates.ts, and copies of that rule are how
// the original defect survived. Same arithmetic as `buildTemplateStages`
// there — that file is the source of record; this is a standalone node
// script and cannot import through the app's `@/` aliases.
export type StageSpec = {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: Record<string, unknown> | null;
};
export const TEMPLATES: Record<string, (q: number) => StageSpec[]> = {
  league: () => [
    {
      kind: "league",
      name: "League",
      config: { legs: 1 },
      progression: null,
    },
  ],
  league_ko: (q) => [
    {
      kind: "league",
      name: "League",
      config: { legs: 1 },
      progression: null,
    },
    {
      kind: "knockout",
      name: "Finals",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ],
  groups_ko: (q) => {
    const poolCount = 2;
    // Mirrors format-templates.ts's groups_ko build: every pool's top `n`,
    // plus a `bestNth` remainder for the qualifiers that don't divide evenly
    // across pools. `normaliseUnequalPools` because snakeDistribute makes
    // unequal pools whenever entrants don't divide evenly — the common case.
    const n = Math.floor(q / poolCount);
    const r = q - n * poolCount;
    const take: Record<string, unknown>[] = [];
    if (n > 0) take.push({ kind: "topNPerGroup", n });
    if (r > 0) take.push({ kind: "bestNth", nth: n + 1, count: r, normaliseUnequalPools: true });
    return [
      {
        kind: "group",
        name: "Group stage",
        config: { legs: 1, pools: { count: poolCount } },
        progression: null,
      },
      {
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [{ stage: "previous", take }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ];
  },
  swiss: () => [
    {
      kind: "swiss",
      name: "Swiss",
      config: { rounds: 5 },
      progression: null,
    },
  ],
  knockout: () => [{ kind: "knockout", name: "Knockout", config: {}, progression: null }],
  double_elim: () => [
    {
      kind: "double_elim",
      name: "Double elimination",
      config: {},
      progression: null,
    },
  ],
  group_stepladder: (q) => [
    {
      kind: "league",
      name: "League",
      config: { legs: 1 },
      progression: null,
    },
    {
      kind: "stepladder",
      name: "Stepladder finals",
      config: {},
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      },
    },
  ],
  // Jul3/08 formats
  triple_rr: () => [
    {
      kind: "league",
      name: "Triple RR",
      config: { legs: 3 },
      progression: null,
    },
  ],
};
