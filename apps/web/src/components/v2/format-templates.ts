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
//
// F3 Task 6 (i18n): this array used to carry its own English `label`/`help`
// strings. Both render to organisers (division-builder.tsx's picker cards,
// division-settings.tsx's format <select>), so they now live in the
// dictionaries as `format.template.<key>.label` / `.help` (see
// dictionaries/en/ui.json), read via useMsg() at both call sites. The fields
// were REMOVED here rather than kept-and-ignored: a grep of every reader
// (division-builder.tsx, division-settings.tsx, format-templates.test.ts,
// format-catalogue.test.ts) turned up nothing else that touched `.label`/
// `.help` on these objects, so a dead English copy sitting unrendered next
// to the real dictionary source was pure drift risk with no offsetting
// benefit. format-templates.test.ts's dictionary-coverage test is the
// regression net that replaces the old "has a label/help" field check.
import type { TakeRule } from "@seazn/engine/competition";

export type StandingsCarry = "none" | "points" | "full";

export interface StageDraft {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  progression: {
    sources: { stage: "previous"; take: TakeRule[] }[];
    placement: "rank_order" | "snake" | "seeded_map";
    map?: { slot: string; source: string }[];
    timing: "setup" | "on_complete";
    carry?: StandingsCarry;
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
  build: (knobs: TemplateKnobs) => StageDraft[];
}[] = [
  {
    key: "league",
    build: () => [{ kind: "league", name: "League", config: { legs: 1 }, progression: null }],
  },
  {
    key: "league_ko",
    build: ({ qualified: q }) => [
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
    build: ({ qualified: q, poolCount }) => {
      // Cross-pool draw (owner ruling R5): take the top `n` finisher from
      // EVERY pool, plus a `bestNth` remainder for the qualifier count that
      // doesn't divide evenly across pools. topNPerGroup already expands
      // wave-major (every pool's winner, then every pool's runner-up, …).
      //
      // Placement is `rank_order`, NOT `snake` (owner ruling 13, found by
      // review before it shipped — F3 programme index). `snake` is chosen
      // by the TARGET stage's kind, not the source's: t20-super8's `snake`
      // (server/templates/catalog/*.json) is correct because ITS target is
      // a group stage, where reversing alternate wave-major pots
      // distributes strength across pools. This template's target is a
      // KNOCKOUT, which must not reverse — generateSingleElim's
      // seedPositions fold (scheduling/bracket.ts:52-63, used at :156-163)
      // pairs seed i against seed N+1-i, so snake's reversal would put seed
      // N/2+1 (a pool's OWN runner-up) opposite seed N/2 (that same pool's
      // winner) in round 1: every pool replaying its own final. Plain
      // rank_order over the same wave-major pots pairs each pool's winner
      // against a DIFFERENT pool's runner-up instead — see
      // format-templates.test.ts's "round 1 never pairs a group against
      // itself" for the worked example. Replaces the old hand-rolled
      // `picks` interleave, which hardcoded pools "A"/"B" and silently
      // produced zero qualifiers from any pool beyond the second.
      //
      // n === 0 (q < poolCount) collapses to a no-op topNPerGroup(0) — the
      // engine's expandOne loops `wave <= rule.n`, so n=0 contributes zero
      // pots — so it's omitted here, and the whole take becomes
      // bestNth(nth:1, count:q): the best q pool-winners by cross-pool
      // rank, i.e. "topNPerGroup 1" (every pool's winner) truncated to q.
      // Reachable from EITHER the Settings tab's free 2-32 qualified input
      // (division-settings.tsx) OR the builder's own dropdown (qualified 2,
      // pools >= 3, division-builder.tsx) — not the Settings tab alone.
      const n = Math.floor(q / poolCount);
      const r = q - n * poolCount;
      const take: TakeRule[] = [];
      if (n > 0) take.push({ kind: "topNPerGroup", n });
      // normaliseUnequalPools:true (round-4 review, MAJOR — A1): pools are
      // built by snakeDistribute (stages.ts), which produces unequal-sized
      // pools whenever entrants don't divide evenly by poolCount — the
      // common case, not an edge case. Without this flag, bestNth's
      // cross-pool compare throws SEEDING_BESTNTH_UNEQUAL_POOLS the moment
      // pool sizes differ (progression.ts) — silently, at SEEDING time on
      // real rows, long after day-one fixture generation (which runs on
      // SHAPES, never on real row counts) looked healthy. The normalisation
      // itself is already implemented (normalisedRow, progression.ts) — this
      // only had to ask for it. See format-templates.test.ts and
      // progression.test.ts for the end-to-end proof.
      //
      // NOT covered by this flag: nth (= n+1) can still exceed a genuinely
      // SHORT pool's row count (e.g. a pool with fewer than n+1 entrants at
      // all) — rowAtRank looks up rank `nth` on every pool before
      // normalisation ever runs, so that still throws STAGE_NOT_READY
      // regardless of this flag. Deliberately not fixed here — see
      // progression.test.ts's "the sibling hazard" test.
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
  },
  {
    key: "group_stepladder",
    build: ({ qualified: q }) => [
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
    build: () => [
      { kind: "swiss", name: "Swiss", config: { rounds: 5 }, progression: null },
    ],
  },
  {
    // Swiss Playoff. Composes two EXISTING stage kinds — no engine change.
    //
    // The swiss stage asks for `pairing: "rank_adjacent"` (the engine's
    // Hammes preset, scheduling/swiss.ts): after each round the standings are
    // re-ranked by the division's OWN tiebreaker cascade and neighbours meet,
    // rather than the top half folding onto the bottom half.
    //
    // It deliberately declares NO `rounds`: the budget scales with the field
    // (lib/swiss-rounds.ts) and only the generator knows how many entrants
    // actually turned up, so `swissGen` derives it. See buildTemplateStages
    // below for why the rounds knob then leaves this template alone.
    //
    // The finals half is byte-for-byte group_playoffs' — the fixed four-team
    // Page playoff, rankRange(1,4)/rank_order/setup — so the two formats
    // cannot drift onto different playoff draws.
    key: "swiss_playoff",
    build: () => [
      { kind: "swiss", name: "Swiss", config: { pairing: "rank_adjacent" }, progression: null },
      { kind: "page_playoff", name: "Playoffs", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
  {
    key: "knockout",
    build: () => [{ kind: "knockout", name: "Knockout", config: {}, progression: null }],
  },
  {
    key: "double_elim",
    build: () => [
      { kind: "double_elim", name: "Double elimination", config: {}, progression: null },
    ],
  },
  {
    key: "triple_rr",
    build: () => [{ kind: "league", name: "Triple RR", config: { legs: 3 }, progression: null }],
  },
  {
    key: "americano",
    build: () => [
      { kind: "americano", name: "Americano", config: { mode: "americano", courtCount: 2, rounds: 7 }, progression: null },
    ],
  },
  {
    key: "mexicano",
    build: () => [
      { kind: "americano", name: "Mexicano", config: { mode: "mexicano", courtCount: 2, rounds: 7 }, progression: null },
    ],
  },
  {
    key: "ladder",
    build: () => [
      { kind: "ladder", name: "Ladder", config: { challengeRange: 3 }, progression: null },
    ],
  },
  {
    key: "ko_plate",
    build: ({ qualified: q }) => [
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
    build: ({ qualified: q }) => [
      { kind: "knockout", name: "Qualifying", config: {}, progression: null },
      { kind: "knockout", name: "Main draw", config: {}, progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: q }] }],
        placement: "rank_order",
        timing: "setup",
      } },
    ],
  },
];

/** Clamps a knob (poolCount, qualified) into [min,max] — called at both UI
 *  call sites (division-builder.tsx, division-settings.tsx) right before
 *  buildTemplateStages, not on every keystroke. A `<input type="number"
 *  min={2}>`'s HTML `min` does NOT stop a CLEARED field from reading as
 *  `Number("") === 0`: with poolCount:0, groups_ko's `Math.floor(q/poolCount)`
 *  mints `n:Infinity` (serialises over the wire as `n:null` — Infinity has no
 *  JSON form) and `r` becomes `q - Infinity*0 = q - NaN = NaN`, so the
 *  organiser gets a raw schema 422 instead of a knob validation message
 *  (round-4 review, B). `buildTemplateStages` itself stays trusting — its
 *  `TemplateKnobs` type already promises real numbers — this is the guard at
 *  the boundary where untrusted `Number(e.target.value)` input actually
 *  enters. Non-finite (0 from a cleared field, NaN from a bad read) clamps to
 *  `min`, same as any other out-of-range value. */
export function clampKnob(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** True when a one-click template includes at least one progression-bearing stage. */
export function templateHasProgression(templateKey: string): boolean {
  const t = STAGE_TEMPLATES.find((s) => s.key === templateKey);
  if (!t) return false;
  return t.build({ qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 }).some((s) => s.progression !== null);
}

/** Bake the organiser's carry choice onto every progression-bearing stage draft. */
export function applyStandingsCarry(stages: StageDraft[], carry: StandingsCarry): StageDraft[] {
  if (carry === "none") return stages;
  return stages.map((s) =>
    s.progression ? { ...s, progression: { ...s.progression, carry } } : s,
  );
}

/** Template + knob values → the stage specs the API accepts. */
export function buildTemplateStages(templateKey: string, knobs: TemplateKnobs): StageDraft[] {
  const t = STAGE_TEMPLATES.find((s) => s.key === templateKey) ?? STAGE_TEMPLATES[0]!;
  return t.build(knobs).map((d) => {
    const config = { ...d.config };
    // The rounds knob EDITS a template's declared rounds; it does not invent
    // one. `swiss` declares `rounds: 5` and the builder/Settings tab show an
    // input for it, so the knob applies there exactly as it always has.
    // `swiss_playoff` declares none — its budget scales with the field and is
    // derived at generation time — and stamping the knob's default 5 on it
    // would silently pin a 40-entrant event to five rounds with no control
    // anywhere on screen that says so.
    if (d.kind === "swiss" && "rounds" in d.config) config.rounds = knobs.swissRounds;
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
  if (kinds === "swiss+page_playoff") return "swiss_playoff";
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
