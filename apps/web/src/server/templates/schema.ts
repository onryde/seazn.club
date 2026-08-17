// Format templates — CompetitionTemplate schema (D1a design doc, P4 scope).
//
// `server-only`. An EARLIER draft of this file claimed "NOT server-only,
// client-safe like format-gallery.tsx" — wrong, caught by e2e (not tsc or
// vitest): `kind` below reuses api-v1/schemas.ts's StageKind, and that
// module VALUE-imports HardConstraint from @seazn/engine/scheduling, whose
// barrel also reaches the gRPC placement client (@grpc/grpc-js — Node-only
// dns/fs/http2/net). Bundling that into a "use client" file breaks the
// browser build. Only the CompetitionTemplate TYPE is client-safe (type-only
// imports are erased before bundling); components/v2/template-gallery.tsx
// imports just that, and receives the actual parsed catalog as a prop from
// its Server Component page instead.
//
// `kind` reuses the API-v1 StageKind enum (schemas.ts), never the engine's
// core StageKind (packages/engine/src/core/types.ts) — the portfolio scout's
// ruling 2: the engine union is missing americano/ladder/page_playoff, so a
// template importing it would type-reject or silently mishandle exactly
// those three kinds. Both sides are re-verified live: the API enum's 9
// values are identical to the `stages_kind_check` CHECK constraint as of
// commit 51f1db9c, so "the wire schema" and "the DB-checked kinds" are one
// and the same set.
//
// `progression` (P7, D4's StageSeeding; unified onto ONE field by F2 —
// QualificationSpecSchema and StageSeedingSchema no longer exist) is
// declared below as an OPTIONAL field on TemplateStage, imported verbatim
// from api-v1/schemas.ts's ProgressionSchema/TakeRuleSchema — never
// redeclared, copied, or forked. Every source is narrowed to
// `stage: "previous"` only (TemplateStageProgression, just below the
// imports): a catalog JSON has no live stage UUIDs for the `{stageId}`
// branch to reference — they only exist once instantiation creates the real
// stage rows. wc32's knockout stage predates this and still carries no
// progression wiring to its group stage (documented in catalog/wc32.json)
// — retrofitting it is out of scope here; the 5 P4 entries' output must
// stay byte-stable.
import "server-only";
import { z } from "zod";
import { StageKind, ProgressionSchema, type ProgressionInput } from "@/server/api-v1/schemas";
import { PointsRule } from "@seazn/engine/competition";

/** ProgressionSchema narrowed to the ONE shape a static catalog entry can
 *  ever express: every `sources[]` entry's `stage` is the literal
 *  `"previous"`. `.refine()`'s type-predicate overload both enforces this at
 *  runtime (a `{stageId}` source throws at parse time) and narrows the
 *  INFERRED type, so a future instantiation usecase reading
 *  `TemplateStage.progression.sources[].stage` sees `"previous"` only —
 *  never has to defensively handle the live-stage-id branch that can't occur
 *  here. This is the `.refine`-style narrowing the P7 dispatch calls for:
 *  constrain the imported schema, don't fork it — `.omit`/`.extend` aren't
 *  options here because the exported `ProgressionSchema` binding is already
 *  the POST-`.refine()` ZodEffects (schemas.ts's own `seeded_map needs a
 *  non-empty map` check), and ZodEffects doesn't carry `.omit`/`.extend` —
 *  only the ZodObject before that refine would have, and schemas.ts doesn't
 *  export it separately. */
export const TemplateStageProgression = ProgressionSchema.refine(
  (p): p is ProgressionInput & { sources: (ProgressionInput["sources"][number] & { stage: "previous" })[] } =>
    p.sources.every((s) => s.stage === "previous"),
  {
    message:
      'template stage progression must use stage: "previous" for every source — a catalog template has no live stage id to reference yet',
    path: ["sources"],
  },
);
export type TemplateStageProgression = z.infer<typeof TemplateStageProgression>;

export const TemplateEntrantKind = z.enum(["team", "pair", "individual"]);
export type TemplateEntrantKind = z.infer<typeof TemplateEntrantKind>;

/** Catalog i18n keys only — dictionary keys, never literal English strings
 *  (ruling 4: templates carry i18n keys, precedent apps/web/src/config/
 *  format-gallery.tsx + dictionaries/en/ui.json's flat `format.*` keys). */
export const TemplateI18n = z.object({
  nameKey: z.string().min(1),
  descriptionKey: z.string().min(1),
});

export const ScheduleDefaults = z.object({
  matchMinutes: z.number().int().positive(),
  gapMinutes: z.number().int().min(0),
  sessionWindows: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  /** Hints only (v1 non-goal: no venue references) — valid with or without
   *  the venue model landing later (D5). */
  suggestedCourtTags: z.array(z.string()).optional(),
});

export const TemplateStage = z.object({
  i18nNameKey: z.string().min(1),
  kind: StageKind,
  /** Documentation-only in P4 (bracket/box size shown in the wizard's detail
   *  sheet) — no code path reads it into `stages.config`; the DB derives
   *  bracket size from the real entrant count at fixture-generation time. */
  size: z.number().int().positive().optional(),
  /** Sugar for a `group` stage's `config.pools.count` — kept separate from
   *  `config` below because it is common enough to want typed and validated
   *  (1..26, the same POOL_KEYS bound stages.ts's poolCount() enforces). */
  groups: z.number().int().min(1).max(26).optional(),
  /** Same PointsRule the create-stages usecase validates `config.points`
   *  against (@seazn/engine/competition) — reused, not restated. */
  points: PointsRule.optional(),
  /** Kind-specific extra config merged verbatim into the stage's `config`
   *  (e.g. swiss `rounds`, americano `mode`/`courtCount`/`rounds`) — the
   *  same escape hatch CreateStage.config already is. `groups` above is
   *  applied first, so an explicit `config.pools` here can still override
   *  the sugar. */
  config: z.record(z.string(), z.unknown()).optional(),
  scheduleDefaults: ScheduleDefaults.optional(),
  /** Cross-stage progression wiring (P7, D4's StageSeeding; unified onto one
   *  field by F2) for a stage that qualifies from an EARLIER stage in the
   *  same division — euro24's R16 (best-thirds), t20-super8's Super 8 and
   *  SF/F (a two-link chain), league-playoff's page_playoff. Absent on a
   *  stage nothing feeds (the division's first stage) or on a stage that
   *  just advances winners within its own bracket (QF/SF/F rounds inside one
   *  `knockout` stage are NOT separate TemplateStages, so they need no
   *  progression of their own). See TemplateStageProgression above for why
   *  every source's `stage` is narrowed to `"previous"`. */
  progression: TemplateStageProgression.optional(),
});
export type TemplateStage = z.infer<typeof TemplateStage>;

export const TemplateDivision = z.object({
  i18nNameKey: z.string().min(1),
  sportKey: z.string().min(1),
  variantKey: z.string().min(1),
  /** Merged over the variant preset through the SAME validation path
   *  createDivision uses (sportModule.configSchema) — a template failing
   *  validation is a catalog bug and must fail the unit gate. */
  cfgOverrides: z.record(z.string(), z.unknown()).optional(),
  tiebreakers: z.array(z.string()).optional(),
  /** Display-only guidance for the wizard gallery/detail sheet (placeholder
   *  entrant count + kind) — never written to any row; entrant kind is
   *  chosen per-entrant at entrant-creation time, not fixed at the division
   *  level (CreateDivision carries no entrantKind field either). */
  entrantKind: TemplateEntrantKind,
  entrantCount: z.number().int().positive(),
  stages: z.array(TemplateStage).min(1),
});
export type TemplateDivision = z.infer<typeof TemplateDivision>;

export const CompetitionTemplate = z.object({
  key: z.string().min(1),
  /** Bumps on ANY content change; instantiation stamps it onto
   *  competitions.template_version (catalog governance: no runtime
   *  multi-version — the catalog file holds current version per key). */
  version: z.number().int().positive(),
  i18n: TemplateI18n,
  divisions: z.array(TemplateDivision).min(1),
});
export type CompetitionTemplate = z.infer<typeof CompetitionTemplate>;
