// One-click stage graphs (v8): shared by the division builder and the
// division Settings tab so "format" means the same thing in both places —
// League / Knockout / Groups + Knockout…, i.e. the stage structure.
// Match rules live in match-rules.tsx; this file is only the graph.
//
// F2 (unified progression field): `qualification` is gone — every template
// below emits `progression` (mirrors api-v1/schemas.ts's ProgressionSchema
// field-for-field: sources[].take[]/placement/map?/timing). Collapse (owner
// ruling 4, F2 plan Decision 2): `topN: n` is now `rankRange{from:1,to:n}`;
// `losersOfRound` is now `roundLosers`.
//
// F3 (day-one fixtures, owner ruling R1 — supersedes F2 Decision 1 above):
// every progression-bearing writer here now sets `timing: "setup"`. The
// whole draw, final included, is generated with placeholder
// home/away_slot_label the moment the division is created
// (generateProgressionSetupFixtures, stages.ts) — the picker no longer
// waits for the source stage to complete before a later stage's fixtures
// exist. `stages-panel.tsx`'s ad-hoc AddStageForm and the seed scripts
// still default to "on_complete" (R4 scoped the flip to this file plus
// config/format-gallery.tsx's cannedStages) — this file's templates do not.
//
// `take`'s element type reuses the engine's own TakeRule (rather than a
// hand-rolled `unknown[]`/`{kind:string}[]` restated here) so this file and
// detectTemplate's own parameter type below can't drift apart the way
// api-v1/schemas.ts's zod TakeRuleSchema and this plain-TS shape already
// have to be kept in lockstep by hand (see that file's own comment).
import type { TakeRule } from "@seazn/engine/competition";

export interface StageDraft {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: {
    sources: { stage: "previous"; take: TakeRule[] }[];
    placement: "rank_order" | "snake" | "seeded_map";
    map?: { slot: string; source: string }[];
    timing: "setup" | "on_complete";
  } | null;
}

export interface TemplateKnobs {
  /** How many advance to stage 2 (finals/knockout templates). */
  qualified: number;
  swissRounds: number;
  poolCount: number;
  legs: number;
}

export const STAGE_TEMPLATES: {
  key: string;
  label: string;
  help: string;
  build: (q: number) => StageDraft[];
}[] = [
  {
    key: "league",
    label: "League",
    help: "Single round robin, table decides.",
    build: () => [{ kind: "league", name: "League", config: { legs: 1 }, progression: null }],
  },
  {
    key: "league_ko",
    label: "League + Finals",
    help: "Round robin, then top N knockout.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { kind: "knockout", name: "Finals", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
  {
    key: "groups_ko",
    label: "Groups + Knockout",
    help: "Two pools, top of each cross over.",
    build: (q) => [
      {
        kind: "group",
        name: "Group stage",
        config: { legs: 1, pools: { count: 2 } },
        progression: null,
      },
      {
        kind: "knockout",
        name: "Knockout",
        config: {},
        progression: {
          sources: [
            {
              stage: "previous",
              take: [
                {
                  kind: "picks",
                  picks: Array.from({ length: q }, (_, i) => ({
                    pool: i % 2 === 0 ? "A" : "B",
                    rank: Math.floor(i / 2) + 1,
                  })),
                },
              ],
            },
          ],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  },
  {
    key: "group_stepladder",
    label: "Group + Stepladder",
    help: "Round robin, then a stepladder final — lowest seed climbs.",
    build: (q) => [
      { kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { kind: "stepladder", name: "Stepladder finals", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
  {
    key: "group_playoffs",
    label: "Group + Playoffs (IPL style)",
    help: "Round robin, then Qualifier 1, Eliminator, Qualifier 2 and the Final — the top two get a second life.",
    build: () => [
      { kind: "league", name: "League", config: { legs: 1 }, progression: null },
      { kind: "page_playoff", name: "Playoffs", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
  {
    key: "swiss",
    label: "Swiss",
    help: "Score-group pairings, fixed rounds.",
    build: () => [
      { kind: "swiss", name: "Swiss", config: { rounds: 5 }, progression: null },
    ],
  },
  {
    key: "knockout",
    label: "Knockout",
    help: "Single elimination bracket.",
    build: () => [{ kind: "knockout", name: "Knockout", config: {}, progression: null }],
  },
  {
    key: "double_elim",
    label: "Double elimination",
    help: "Losers bracket + grand final (Pro).",
    build: () => [
      { kind: "double_elim", name: "Double elimination", config: {}, progression: null },
    ],
  },
  {
    key: "triple_rr",
    label: "Triple round robin",
    help: "Everyone plays everyone three times.",
    build: () => [{ kind: "league", name: "Triple RR", config: { legs: 3 }, progression: null }],
  },
  {
    key: "americano",
    label: "Americano (padel)",
    help: "Individuals rotate partners each round; personal points (Pro).",
    build: () => [
      { kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 7 }, progression: null },
    ],
  },
  {
    key: "mexicano",
    label: "Mexicano (padel)",
    help: "Re-rank each round: 1+4 vs 2+3 from live points (Pro).",
    build: () => [
      { kind: "americano", name: "Mexicano", config: { mode: "mexicano", courtCount: 2, rounds: 7 }, progression: null },
    ],
  },
  {
    key: "ladder",
    label: "Ladder",
    help: "Open standings; players challenge upward over a long window (Pro).",
    build: () => [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, progression: null },
    ],
  },
  {
    key: "ko_plate",
    label: "Knockout + Plate",
    help: "Main knockout draw; round-1 losers play a plate bracket for a second chance.",
    build: (q) => [
      { kind: "knockout", name: "Main draw", config: {}, progression: null },
      {
        kind: "knockout",
        name: "Plate",
        config: {},
        progression: {
          sources: [{ stage: "previous", take: [{ kind: "roundLosers", round: 1, count: q }] }],
          placement: "rank_order",
          timing: "setup",
        },
      },
    ],
  },
  {
    key: "qualifying_main",
    label: "Qualifying + Main draw",
    help: "A smaller knockout decides who advances into the main knockout draw.",
    build: (q) => [
      { kind: "knockout", name: "Qualifying", config: {}, progression: null },
      { kind: "knockout", name: "Main draw", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
];

/** Template + knob values → the stage specs the API accepts. */
export function buildTemplateStages(templateKey: string, knobs: TemplateKnobs): StageDraft[] {
  const t = STAGE_TEMPLATES.find((s) => s.key === templateKey) ?? STAGE_TEMPLATES[0]!;
  return t.build(knobs.qualified).map((d) => {
    const config = { ...d.config };
    if (d.kind === "swiss") config.rounds = knobs.swissRounds;
    if (d.kind === "league" || d.kind === "group") config.legs = knobs.legs;
    if (d.kind === "group") config.pools = { count: knobs.poolCount };
    return { ...d, config };
  });
}

/** Best-effort reverse map: existing stages → template key (null = custom). */
export function detectTemplate(
  stages: {
    kind: string;
    config?: Record<string, unknown> | null;
    // Reuses StageDraft's own progression shape rather than a second
    // hand-rolled partial (was `{ sources: { take: { kind: string }[] }[] }`)
    // — that partial drifting one level behind StageDraft's real shape (no
    // `stage`, then no `placement`/`timing`) is what made every
    // buildTemplateStages() round-trip below fail to typecheck.
    progression?: StageDraft["progression"];
  }[],
): string | null {
  const kinds = stages.map((s) => s.kind).join("+");
  if (kinds === "league") {
    const legs = (stages[0]?.config as { legs?: number } | undefined)?.legs ?? 1;
    return legs >= 3 ? "triple_rr" : "league";
  }
  if (kinds === "league+knockout") return "league_ko";
  if (kinds === "group+knockout") return "groups_ko";
  if (kinds === "league+stepladder") return "group_stepladder";
  if (kinds === "league+page_playoff") return "group_playoffs";
  if (kinds === "swiss") return "swiss";
  if (kinds === "knockout") return "knockout";
  if (kinds === "double_elim") return "double_elim";
  if (kinds === "knockout+knockout") {
    // Same kind sequence, disambiguated by the second stage's progression
    // take-rule kind — roundLosers (KO+Plate) vs rankRange (Qualifying+Main
    // draw). F2: was losersOfRound/topN key-presence on `.qualification`.
    const take = stages[1]?.progression?.sources[0]?.take ?? [];
    if (take.some((t) => t.kind === "roundLosers")) return "ko_plate";
    if (take.some((t) => t.kind === "rankRange")) return "qualifying_main";
    return null;
  }
  if (kinds === "americano") {
    const mode = (stages[0]?.config as { mode?: string } | undefined)?.mode;
    return mode === "mexicano" ? "mexicano" : "americano";
  }
  if (kinds === "ladder") return "ladder";
  return null;
}
