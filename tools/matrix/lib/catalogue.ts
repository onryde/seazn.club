// The frozen row list of the format × sport matrix (design §3; R11 — changing
// it is a reviewed diff, never a runtime draw). Rows are the 16 builder
// templates in offered-matrix order, then the 5 API-only shapes. Columns are
// the engine's own registry order (builtinModules), which is the order the
// offered matrix was written in.
//
// Stage bodies are built by the PRODUCT's buildTemplateStages (R15: the
// builder's own output goes through the real API), with the builder's clamp,
// carry and seq steps restated (division-builder.tsx:384-392, 443-447). The
// API-only rows are derived from product authorities too (apiOnlyStages).
import { builtinModules } from "@seazn/engine/sports";
import {
  STAGE_TEMPLATES,
  applyStandingsCarry,
  buildTemplateStages,
  clampKnob,
  type StageDraft,
  type TemplateKnobs,
} from "../../../apps/web/src/lib/format-templates.ts";

export const TEMPLATE_ROW_KEYS = [
  "league", "triple_rr", "league_ko", "groups_ko", "group_stepladder", "group_playoffs",
  "swiss", "swiss_playoff", "swiss_knockout", "knockout", "ko_plate", "qualifying_main",
  "double_elim", "americano", "mexicano", "ladder",
] as const;

export const API_ONLY_ROWS = [
  "group_only", "group_group_ko", "knockout_third_place", "page_playoff_only", "stepladder_only",
] as const;

export type TemplateRowKey = (typeof TEMPLATE_ROW_KEYS)[number];
export type ApiOnlyRowKey = (typeof API_ONLY_ROWS)[number];
export type RowKey = TemplateRowKey | ApiOnlyRowKey;

export const ROW_KEYS: readonly RowKey[] = [...TEMPLATE_ROW_KEYS, ...API_ONLY_ROWS];

export const SPORT_KEYS: readonly string[] = builtinModules.map((m) => m.key);

export function cellId(row: RowKey, sport: string): string {
  return `${row}|${sport}`;
}

/** division-builder.tsx:289-292 — pinned by catalogue.test.ts. */
export const BUILDER_DEFAULT_KNOBS: Readonly<TemplateKnobs> = Object.freeze({
  qualified: 4,
  swissRounds: 5,
  poolCount: 2,
  legs: 1,
});

/** The builder's clampKnob bounds (division-builder.tsx:386, 388) — pinned by
 *  catalogue.test.ts. */
export const BUILDER_KNOB_BOUNDS: Readonly<Record<"qualified" | "poolCount", Readonly<{ min: number; max: number }>>> = Object.freeze({
  qualified: Object.freeze({ min: 2, max: 32 }),
  poolCount: Object.freeze({ min: 2, max: 8 }),
});

/** division-builder.tsx:56-61 — pinned by catalogue.test.ts. */
export const BUILDER_PREFERRED_VARIANT: Readonly<Record<string, string>> = Object.freeze({
  cricket: "t20",
  tennis: "tour",
  icehockey: "iihf",
  hockey: "fih-outdoor",
});

/** pickVariant (division-builder.tsx:63-67): the preferred key when the DB offers
 *  it, else the first listed. The list order is a DB fact
 *  (`order by is_system desc, name`, d/new/page.tsx:51-55), so the caller passes it. */
export function builderDefaultVariant(sport: string, variantsInBuilderOrder: readonly string[]): string {
  const first = variantsInBuilderOrder[0];
  if (first === undefined) throw new Error(`catalogue: sport '${sport}' has no system variants`);
  const preferred = BUILDER_PREFERRED_VARIANT[sport.toLowerCase()];
  if (preferred !== undefined && variantsInBuilderOrder.includes(preferred)) return preferred;
  return first;
}

export class UnknownRow extends Error {
  readonly row: string;
  constructor(row: string) {
    super(`catalogue: unknown row '${row}' — refusing to let buildTemplateStages fall back to league`);
    this.name = "UnknownRow";
    this.row = row;
  }
}

/** A row whose stage bodies a later wave builds. No row throws it since W1b
 *  Task 3 derived the five API-only rows; run.ts still reads it as ⏳. */
export class RowBuildDeferred extends Error {
  readonly row: string;
  readonly wave: string;
  constructor(row: string, wave: string) {
    super(`catalogue: row '${row}' is API-only; its stage bodies are built in ${wave}`);
    this.name = "RowBuildDeferred";
    this.row = row;
    this.wave = wave;
  }
}

export interface StagePostBody extends StageDraft {
  seq: number;
}

/** The builder's own bodies for a template row (division-builder.tsx:383-392):
 *  clamp → buildTemplateStages → carry "none". Seq is added by stagesForRow. */
export function builderStages(row: TemplateRowKey, knobs: TemplateKnobs = BUILDER_DEFAULT_KNOBS): StageDraft[] {
  // The catalogue could name a key the product has since dropped; the product
  // would then silently build a league. Refuse instead.
  if (!STAGE_TEMPLATES.some((t) => t.key === row)) throw new UnknownRow(row);
  const clamped: TemplateKnobs = {
    ...knobs,
    qualified: clampKnob(knobs.qualified, BUILDER_KNOB_BOUNDS.qualified.min, BUILDER_KNOB_BOUNDS.qualified.max),
    poolCount: clampKnob(knobs.poolCount, BUILDER_KNOB_BOUNDS.poolCount.min, BUILDER_KNOB_BOUNDS.poolCount.max),
  };
  return applyStandingsCarry(buildTemplateStages(row, clamped), "none");
}

/** apps/web/src/server/templates/catalog/t20-super8.json — the product's one
 *  group → group → knockout shape. Pinned field by field by catalogue.test.ts. */
export const SUPER8 = Object.freeze({ firstPools: 4, secondPools: 2, take: 2 } as const);

const feed = (placement: "snake" | "rank_order"): NonNullable<StageDraft["progression"]> => ({
  sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: SUPER8.take }] }],
  placement,
  timing: "setup",
});

/** The five shapes the builder does not offer, each built from a product
 *  authority: the builder's own stage bodies, the t20-super8 catalog template
 *  (pool counts and both feeds), and the knockout generate's
 *  `cfg.thirdPlace` read (usecases/stages.ts generate()). */
function apiOnlyStages(row: ApiOnlyRowKey, knobs: TemplateKnobs): StageDraft[] {
  switch (row) {
    case "group_only":
      return [builderStages("groups_ko", knobs)[0]];
    case "group_group_ko": {
      const group = builderStages("groups_ko", knobs)[0];
      return [
        { ...group, config: { ...group.config, pools: { count: SUPER8.firstPools } } },
        { ...group, name: "Second group stage", config: { ...group.config, pools: { count: SUPER8.secondPools } }, progression: feed("snake") },
        { kind: "knockout", name: "Knockout", config: {}, progression: feed("rank_order") },
      ];
    }
    case "knockout_third_place": {
      const ko = builderStages("knockout", knobs)[0];
      return [{ ...ko, config: { ...ko.config, thirdPlace: true } }];
    }
    case "page_playoff_only":
      return [{ ...builderStages("group_playoffs", knobs)[1], progression: null }];
    case "stepladder_only":
      return [{ ...builderStages("group_stepladder", knobs)[1], progression: null }];
    default:
      // tsc proves exhaustiveness, but run.ts executes under strip-types: an
      // API_ONLY_ROWS key with no case would return undefined and crash later.
      throw new UnknownRow(row);
  }
}

export function stagesForRow(row: string, knobs: TemplateKnobs = BUILDER_DEFAULT_KNOBS): StagePostBody[] {
  let drafts: StageDraft[];
  if ((API_ONLY_ROWS as readonly string[]).includes(row)) drafts = apiOnlyStages(row as ApiOnlyRowKey, knobs);
  else if ((TEMPLATE_ROW_KEYS as readonly string[]).includes(row)) drafts = builderStages(row as TemplateRowKey, knobs);
  else throw new UnknownRow(row);
  return drafts.map((s, i) => ({ ...s, seq: i + 1 }));
}
