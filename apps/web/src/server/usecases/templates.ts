import "server-only";
// Format templates — instantiation (D1a design doc, P4 scope). The wizard's
// "start from a famous format" write path: catalog -> competition +
// divisions + stages in ONE transaction, through the same validation a
// manual create would hit — a template can never bypass config validation
// or an entitlement gate.
//
// Why this does NOT call createCompetition/createDivision/createStages
// directly, even though the design doc's normative order describes it that
// way: each of those usecases opens its OWN `withTenant` (lib/db.ts), which
// is `getClient().begin()` — a brand-new top-level transaction, not a
// nestable one. `withTenant` explicitly forbids nesting (the pool-nesting
// guard in lib/db.ts exists to catch exactly this shape) and, guard aside,
// composing three separately-committed transactions would not roll back
// atomically at all — the opposite of what "partial failure leaves nothing
// behind" requires. Instead this opens ONE `withTenant` and reuses the SAME
// validation PRIMITIVES those usecases call internally (resolveModule +
// configSchema, requireFeature, uniqueSlug/slugify, assertActiveQuota) —
// reusing the validation path without reusing the transaction-owning
// function.
//
// P4 review (2026-08-13) closeout: an earlier draft of this file duplicated
// rather than shared four of those primitives — the divisions/stages quota
// guards were never called at all, `validatePointsRule` was never called at
// all, and the advanced-formats gate was hand-retyped instead of imported.
// All four now route through the exact same shared functions
// createDivision/createStages/createCompetition call — `assertWithinLimit`/
// `getLimit` (lib/entitlements.ts), `validatePointsRule`
// (@seazn/engine/competition), `stageNeedsDoubleElimGate`/
// `stageNeedsAdvancedFormatsGate` (./format-gates.ts), and
// `fireCompetitionCreated`/`fireDivisionCreated` (./competitions,
// ./divisions) — so a manual create and a templated one can never disagree
// about a boundary again.
import { randomUUID } from "node:crypto";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { assertWithinLimit, getLimit, requireFeature } from "@/lib/entitlements";
import { validatePointsRule } from "@seazn/engine/competition";
import { log } from "@/server/logger";
import { resolveModule } from "@/server/engine-db";
import { getDictionary, t } from "@/lib/i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateFromTemplate, FromTemplateResult } from "@/server/api-v1/schemas";
import { slugify, withUniqueSlug, SLUG_CONSTRAINT } from "./slugs";
import {
  assertActiveQuota,
  assertPublicQuota,
  fireCompetitionCreated,
  fireCompetitionMadePublic,
  shouldFireMadePublic,
} from "./competitions";
import { fireDivisionCreated } from "./divisions";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "./format-gates";
import { validateSeedingAgainstShape, type SourceShape } from "./stage-seeding";
import { getTemplate } from "@/server/templates/catalog";
import type { CompetitionTemplate, TemplateStage } from "@/server/templates/schema";

export const TEMPLATE_UNKNOWN_KEY_CODE = "TEMPLATE_UNKNOWN_KEY";
export const TEMPLATE_VERSION_RETIRED_CODE = "TEMPLATE_VERSION_RETIRED";
export const TEMPLATE_INSTANTIATION_FAILED_CODE = "TEMPLATE_INSTANTIATION_FAILED";

/** Effective `stages.config` for a template stage: `groups` sugar first
 *  (a `group` stage's `config.pools.count`), then the declared PointsRule,
 *  then the kind-specific `config` escape hatch spread LAST so it can
 *  override either sugar field if a catalog author ever needs to. */
function effectiveStageConfig(stage: TemplateStage): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (stage.kind === "group" && stage.groups !== undefined) {
    cfg.pools = { count: stage.groups };
  }
  if (stage.points !== undefined) cfg.points = stage.points;
  Object.assign(cfg, stage.config ?? {});
  return cfg;
}

/** The inverse of `effectiveStageConfig` above, read back from a persisted
 *  row: a `.seeding` rule's `SourceShape` (pool KEYS, [] for a non-group
 *  kind). Mirrors stages.ts's module-private `sourceShapeOf`'s
 *  config-derived branch ONLY — never its existing-pools-ROWS branch, which
 *  is unreachable here: nothing in this transaction has generated
 *  fixtures/pools for ANY stage yet (§2's no-fixtures-at-instantiation
 *  ruling — see the comment on `stageResults.push` below), so a sibling
 *  stage can never already own pool rows the way a live, played-in
 *  division's source stage might by the time someone adds a later stage to
 *  it. `validateSeedingAgainstShape` (stage-seeding.ts) is what actually
 *  validates the rule against this shape — this only builds the shape. */
function sourceShapeOfRow(row: { kind: string; config: Record<string, unknown> }): SourceShape {
  if (row.kind !== "group") return { poolKeys: [] };
  const pools = row.config.pools as { count?: unknown } | undefined;
  const count = typeof pools?.count === "number" ? pools.count : 1;
  return { poolKeys: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, count).split("") };
}

export async function createFromTemplate(
  auth: AuthCtx,
  input: CreateFromTemplate,
): Promise<FromTemplateResult> {
  const template = getTemplate(input.template_key);
  if (!template) {
    throw new HttpError(404, `unknown template '${input.template_key}'`, TEMPLATE_UNKNOWN_KEY_CODE);
  }
  if (input.template_version !== undefined && input.template_version !== template.version) {
    throw new HttpError(
      409,
      `template '${input.template_key}' version ${input.template_version} is retired — current is ${template.version}`,
      TEMPLATE_VERSION_RETIRED_CODE,
      { live_version: template.version },
    );
  }
  return instantiateTemplate(auth, template, input);
}

/** The instantiation transaction, split out from createFromTemplate so a
 *  regression test can drive it with a synthetic CompetitionTemplate object
 *  (an entitlement-gated kind, or a deliberately broken division) without
 *  needing that shape to exist in the real catalog. */
export async function instantiateTemplate(
  auth: AuthCtx,
  template: CompetitionTemplate,
  input: {
    name: string;
    starts_on?: string | null;
    ends_on: string;
    visibility?: "private" | "unlisted" | "public";
  },
): Promise<FromTemplateResult> {
  // Generated up front (not `returning id` inside the transaction) so it can
  // be threaded into the entitlement checks below, BEFORE the row exists —
  // see the requireFeature calls' own comment for why that is still correct.
  const competitionId = randomUUID();

  // Entitlement gates BEFORE any insert (doc 10 §1 pattern createStages
  // follows) — checked across every division/stage up front so a Community
  // org gets ONE clean 402, never a half-created competition. A template
  // must never become a way to reach a Pro stage kind for free.
  //
  // The competition id IS passed, even though the row does not exist yet:
  // pass-scoping-guard.test.ts sweeps every requireFeature/hasFeature/
  // getLimit/withinLimit call against a "lifted" (Event-Pass-overridable)
  // key and fails any enforcement-layer call that drops the competition id
  // — the exact bug class that made `branding`/`realtime` Event Pass grants
  // invisible. An Event Pass is always bought FOR an existing competition
  // (competition_passes.competition_id is a real FK), so no pass can
  // reference this id before the insert below commits; passing it now
  // resolves zero passes today (correct — none can exist yet) and is wired
  // correctly for good, rather than omitted and silently unfixable later.
  //
  // `stageNeedsDoubleElimGate`/`stageNeedsAdvancedFormatsGate` are the SAME
  // shared predicates createStages (usecases/stages.ts) gates on — imported
  // from usecases/format-gates.ts, not a local retype (P4 review finding 5:
  // an earlier draft hand-duplicated this exact condition, "byte-identical
  // today, locked by no test").
  for (const division of template.divisions) {
    for (const stage of division.stages) {
      if (stageNeedsDoubleElimGate(stage.kind)) {
        await requireFeature(auth.orgId, "formats.double_elim", competitionId);
      }
      if (stageNeedsAdvancedFormatsGate({ kind: stage.kind, config: stage.config })) {
        await requireFeature(auth.orgId, "formats.advanced", competitionId);
      }
    }
  }
  // Doc 10 §1 quota caps — `divisions.per_competition.max` and
  // `stages.per_division.max` — checked up front against the template's
  // STATIC shape, exactly like the entitlement gates above and for the same
  // reason: a template must never become a way to smuggle a competition over
  // a paid-tier cap "for free" (P4 review finding 2: an earlier draft never
  // called either guard, and got away with it purely because no catalog
  // entry happens to exceed Community's ceiling today).
  //
  // A live-row COUNT the way createDivision/createStages do it (count
  // existing rows inside their OWN transaction, doc 10 §2 rule 1) is not
  // needed here: `competitionId` is a freshly generated id with no row yet,
  // so there is no possible concurrent writer that could also be adding
  // divisions/stages to it — the only writer is this function, and every
  // division/stage it will ever insert is already known up front from the
  // (static, in-memory) template. Checking the template's total shape
  // against the resolved cap is therefore equivalent to the incremental
  // in-tx count check for a brand-new competition, and strictly stronger:
  // refused here, NOTHING is ever inserted, rather than rolling back a
  // partially-written transaction.
  //
  // `assertWithinLimit`/`getLimit` are the exact same exported primitives
  // createDivision/restoreDivision (usecases/divisions.ts) and createStages
  // (usecases/stages.ts) call — reused, not restated, so a manual create and
  // a templated one can never disagree about where the boundary is.
  const divisionCap = await getLimit(auth.orgId, "divisions.per_competition.max", competitionId);
  assertWithinLimit(divisionCap, "divisions.per_competition.max", template.divisions.length);
  const stageCap = await getLimit(auth.orgId, "stages.per_division.max");
  for (const division of template.divisions) {
    assertWithinLimit(stageCap, "stages.per_division.max", division.stages.length);
  }
  // Competition-level quota, same pre-transaction check createCompetition
  // itself runs — a template-created competition is a competition for quota
  // purposes.
  await assertActiveQuota(auth);
  if (input.visibility === "public") await assertPublicQuota(auth);

  const dict = await getDictionary("en", "ui");

  const { slug, divisions } = await withTenant(auth.orgId, async (tx) => {
    const slug = await withUniqueSlug(
      tx,
      {
        base: slugify(input.name),
        constraint: SLUG_CONSTRAINT.competitions,
        taken: async (s) => {
          const [taken] = await tx`select 1 from competitions where slug = ${s}`;
          return !!taken;
        },
      },
      async (candidate, q) => {
        await q`
          insert into competitions (id, org_id, name, slug, visibility, branding, created_by,
                                     ends_on, starts_on, template_key, template_version)
          values (${competitionId}, ${auth.orgId}, ${input.name}, ${candidate}, ${input.visibility ?? "private"},
                  '{}', ${auth.userId}, ${input.ends_on}, ${input.starts_on ?? null},
                  ${template.key}, ${template.version})`;
        return candidate;
      },
    );

    const divisionResults: FromTemplateResult["divisions"] = [];
    for (let di = 0; di < template.divisions.length; di++) {
      const templateDivision = template.divisions[di]!;
      let stageIndexInProgress: number | null = null;
      try {
        // Same validation path createDivision uses: resolve the pinned sport
        // module version, merge overrides over the system variant preset,
        // then validate the snapshot through the module's own configSchema
        // — an invalid config never reaches the DB (doc 08 §3).
        const [sport] = await tx<{ module_version: string }[]>`
          select module_version from sports where key = ${templateDivision.sportKey}`;
        if (!sport) throw new Error(`unknown sport '${templateDivision.sportKey}'`);
        const [variant] = await tx<{ config: Record<string, unknown> }[]>`
          select config from sport_variants
          where sport_key = ${templateDivision.sportKey} and key = ${templateDivision.variantKey}
          order by org_id nulls last limit 1`;
        if (!variant) {
          throw new Error(
            `unknown variant '${templateDivision.variantKey}' for ${templateDivision.sportKey}`,
          );
        }
        const sportModule = resolveModule(templateDivision.sportKey, sport.module_version);
        const merged = { ...variant.config, ...(templateDivision.cfgOverrides ?? {}) };
        const parsedConfig = sportModule.configSchema.safeParse(merged);
        if (!parsedConfig.success) {
          throw new Error(`invalid ${templateDivision.sportKey} config: ${parsedConfig.error.message}`);
        }

        const divisionName = t(dict, templateDivision.i18nNameKey);
        const division = await withUniqueSlug(
          tx,
          {
            base: slugify(divisionName),
            constraint: SLUG_CONSTRAINT.divisions,
            taken: async (s) => {
              const [taken] = await tx`
                select 1 from divisions where competition_id = ${competitionId} and slug = ${s}`;
              return !!taken;
            },
          },
          async (divisionSlug, q) => {
            const [row] = await q<{ id: string }[]>`
              insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                                      module_version, eligibility, tiebreakers)
              values (${competitionId}, ${divisionName}, ${divisionSlug}, ${templateDivision.sportKey},
                      ${templateDivision.variantKey}, ${q.json(parsedConfig.data as never)},
                      ${sport.module_version}, '[]',
                      ${templateDivision.tiebreakers ? q.json(templateDivision.tiebreakers as never) : null})
              returning id`;
            return row!;
          },
        );
        const divisionId = division.id;

        const stageResults: FromTemplateResult["divisions"][number]["stages"] = [];
        for (let si = 0; si < templateDivision.stages.length; si++) {
          stageIndexInProgress = si;
          const templateStage = templateDivision.stages[si]!;
          // Same validation createStages runs on config.points (stages.ts,
          // @seazn/engine/competition's validatePointsRule): a rule naming a
          // metric the sport doesn't emit must never reach play (P4 review
          // finding 3 — an earlier draft wrote `stage.points` straight into
          // `stages.config.points` unchecked). Thrown inside this try block,
          // so it's caught below and rolls back the whole transaction like
          // any other catalog defect.
          if (templateStage.points !== undefined) {
            validatePointsRule(templateStage.points, sportModule.metrics);
          }
          // D4a (P5, T3): `.seeding.source` is narrowed to the literal
          // "previous" for every template stage (TemplateStageSeeding, T1)
          // — a catalog JSON has no live stage UUID for the `{stageId}`
          // branch. "previous" means "the stage immediately before this one
          // in the SAME division" (stages.ts's resolveSeedingSource,
          // :1313-1317 — run later, at save/generate time, by P5's own
          // code; NOT resolved here), so a stage at this division's index 0
          // can never have one: there is no earlier stage, now or ever (a
          // stage's position is fixed once instantiation writes it). Caught
          // here rather than left to surface downstream at proposal/
          // generate time — the same "a catalog bug 422s now, not later"
          // contract this function already applies to sport/variant/config/
          // points above.
          if (templateStage.seeding !== undefined) {
            if (si === 0) {
              throw new Error("seeding.source is 'previous' but this is the division's first stage");
            }
            // Shape-aware validation (reviewer follow-up on the T3 commit):
            // a `.take`/`.map` that disagrees with the source stage's REAL
            // shape must 422 HERE, not persist silently and only surface
            // downstream at generate time (generateSeededStageFixtures) —
            // the exact "at save time" contract createStages/replaceStages
            // already give a manually-built stage graph
            // (stages.ts's validateStageSeeding), via the SAME shared
            // function (stage-seeding.ts's validateSeedingAgainstShape) so
            // the two callers can never drift apart. `source` is always
            // "previous" for a template stage (TemplateStageSeeding, T1) —
            // always the immediately-preceding stage in THIS loop, already
            // inserted into `stageResults` a moment ago, in this same
            // transaction.
            const [sourceRow] = await tx<{ kind: string; config: Record<string, unknown> }[]>`
              select kind, config from stages where id = ${stageResults[si - 1]!.id}`;
            validateSeedingAgainstShape(sourceShapeOfRow(sourceRow!), templateStage.seeding);
          }
          const stageName = t(dict, templateStage.i18nNameKey);
          const [stage] = await tx<{ id: string }[]>`
            insert into stages (division_id, seq, kind, name, config, seeding)
            values (${divisionId}, ${si + 1}, ${templateStage.kind}, ${stageName},
                    ${tx.json(effectiveStageConfig(templateStage) as never)},
                    ${templateStage.seeding ? tx.json(templateStage.seeding as never) : null})
            returning id`;
          // Seeding rules ARE persisted here (T3, D4a/P5's StageSeeding) —
          // the row above carries `templateStage.seeding` verbatim, same
          // column/shape/serialisation `createStages` uses
          // (usecases/stages.ts). Fixtures are still NOT generated at
          // instantiation time, by design: entrants don't exist yet (design
          // doc §UI — "wizard routes into the entrant-add step with
          // placeholder counts... no fake entrants created"), so
          // generateStageFixtures never runs here — a `.seeding` stage's
          // TBD fixtures come later from the existing Generate action
          // (stages.ts's generateSeededStageFixtures, which already handles
          // `.seeding` stages). This split matters, not just defers work: a
          // fixture row anywhere in the division trips replaceStages'/
          // patchDivision's FORMAT_LOCKED guard (stages.ts :276-281,
          // divisions.ts :563) — generating eagerly here would freeze the
          // division's format/variant before a single entrant exists.
          stageResults.push({ id: stage!.id, fixtureCount: 0 });
        }
        divisionResults.push({ id: divisionId, stages: stageResults });
      } catch (err) {
        // A template failing here is a CATALOG bug, not a user error — locate
        // it (design doc's error table: 422 template.instantiation_failed
        // {divisionIndex, stageIndex, cause}) and let it abort the
        // transaction (throwing inside a withTenant callback rolls back
        // everything committed so far in it, including the competition
        // insert above — no orphan competition survives a broken division).
        const cause = err instanceof Error ? err.message : String(err);
        throw new HttpError(
          422,
          `template '${template.key}' failed to instantiate: ${cause}`,
          TEMPLATE_INSTANTIATION_FAILED_CODE,
          { divisionIndex: di, stageIndex: stageIndexInProgress, cause },
        );
      }
    }
    return { slug, divisions: divisionResults };
  });

  log.info(
    {
      event: "competition_from_template",
      key: template.key,
      version: template.version,
      competitionId,
      orgId: auth.orgId,
    },
    "competition_from_template",
  );
  // Activation funnel (feature 1): a template-instantiated competition/
  // division is a competition/division for this funnel too — fired after
  // the transaction commits, mirroring createCompetition/createDivision's
  // own placement (never inside the tx: analytics must not count a write
  // that could still roll back). P4 review finding 1 — an earlier draft
  // called neither emitter, so this path was invisible to the funnel.
  await fireCompetitionCreated(auth, input.visibility ?? "private");
  // P4 review follow-up (2026-08-13): finding 1's first fix stopped at
  // COMPETITION_CREATED and missed that createCompetition ALSO fires
  // COMPETITION_MADE_PUBLIC when a competition is created directly public
  // (shouldFireMadePublic(undefined, visibility) — see competitions.ts).
  // CreateFromTemplate.visibility accepts "public" exactly like
  // CreateCompetition's does, so a template instantiated public must
  // complete the SAME milestone. Reuses the exact predicate + emitter
  // createCompetition calls, imported, not restated.
  if (shouldFireMadePublic(undefined, input.visibility ?? "private")) {
    await fireCompetitionMadePublic(auth, competitionId);
  }
  for (const templateDivision of template.divisions) {
    await fireDivisionCreated(auth, templateDivision.sportKey, competitionId);
  }

  return {
    competitionId,
    slug,
    divisions,
    templateKey: template.key,
    templateVersion: template.version,
  };
}
