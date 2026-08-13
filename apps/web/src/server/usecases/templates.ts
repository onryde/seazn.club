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
// function. Flagged for review: this is a deliberate deviation from the
// design doc's literal "wraps existing usecases" phrasing, made necessary by
// withTenant's non-reentrant design.
import { randomUUID } from "node:crypto";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { log } from "@/server/logger";
import { resolveModule } from "@/server/engine-db";
import { getDictionary, t } from "@/lib/i18n";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateFromTemplate, FromTemplateResult } from "@/server/api-v1/schemas";
import { slugify, uniqueSlug } from "./slugs";
import { assertActiveQuota, assertPublicQuota } from "./competitions";
import { getTemplate } from "@/server/templates/catalog";
import type { CompetitionTemplate, TemplateStage } from "@/server/templates/schema";

export const TEMPLATE_UNKNOWN_KEY_CODE = "TEMPLATE_UNKNOWN_KEY";
export const TEMPLATE_VERSION_RETIRED_CODE = "TEMPLATE_VERSION_RETIRED";
export const TEMPLATE_INSTANTIATION_FAILED_CODE = "TEMPLATE_INSTANTIATION_FAILED";

function stageNeedsDoubleElimGate(stage: TemplateStage): boolean {
  return stage.kind === "double_elim" || stage.kind === "page_playoff";
}

// Mirrors createStages's `advanced` condition (usecases/stages.ts) exactly —
// duplicated, not shared, for the same reason the module header explains:
// createStages cannot be called from inside this transaction. If that
// condition changes, this one must change with it (flagged for review).
function stageNeedsAdvancedFormatsGate(stage: TemplateStage): boolean {
  const cfg = stage.config as
    | { byes?: unknown; cross_feeds?: unknown; placements?: unknown }
    | undefined;
  return (
    stage.kind === "americano" ||
    stage.kind === "ladder" ||
    cfg?.byes !== undefined ||
    cfg?.cross_feeds !== undefined ||
    cfg?.placements !== undefined
  );
}

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
  // Entitlement gates BEFORE any insert (doc 10 §1 pattern createStages
  // follows) — checked across every division/stage up front so a Community
  // org gets ONE clean 402, never a half-created competition. A template
  // must never become a way to reach a Pro stage kind for free.
  for (const division of template.divisions) {
    for (const stage of division.stages) {
      if (stageNeedsDoubleElimGate(stage)) {
        await requireFeature(auth.orgId, "formats.double_elim");
      }
      if (stageNeedsAdvancedFormatsGate(stage)) {
        await requireFeature(auth.orgId, "formats.advanced");
      }
    }
  }
  // Competition-level quota, same pre-transaction check createCompetition
  // itself runs — a template-created competition is a competition for quota
  // purposes.
  await assertActiveQuota(auth);
  if (input.visibility === "public") await assertPublicQuota(auth);

  const dict = await getDictionary("en", "ui");
  const competitionId = randomUUID();

  const divisions = await withTenant(auth.orgId, async (tx) => {
    const slug = await uniqueSlug(slugify(input.name), async (s) => {
      const [taken] = await tx`select 1 from competitions where slug = ${s}`;
      return !!taken;
    });
    await tx`
      insert into competitions (id, org_id, name, slug, visibility, branding, created_by,
                                 ends_on, starts_on, template_key, template_version)
      values (${competitionId}, ${auth.orgId}, ${input.name}, ${slug}, ${input.visibility ?? "private"},
              '{}', ${auth.userId}, ${input.ends_on}, ${input.starts_on ?? null},
              ${template.key}, ${template.version})`;

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
        const divisionSlug = await uniqueSlug(slugify(divisionName), async (s) => {
          const [taken] = await tx`
            select 1 from divisions where competition_id = ${competitionId} and slug = ${s}`;
          return !!taken;
        });
        const [division] = await tx<{ id: string }[]>`
          insert into divisions (competition_id, name, slug, sport_key, variant_key, config,
                                  module_version, eligibility, tiebreakers)
          values (${competitionId}, ${divisionName}, ${divisionSlug}, ${templateDivision.sportKey},
                  ${templateDivision.variantKey}, ${tx.json(parsedConfig.data as never)},
                  ${sport.module_version}, '[]',
                  ${templateDivision.tiebreakers ? tx.json(templateDivision.tiebreakers as never) : null})
          returning id`;
        const divisionId = division!.id;

        const stageResults: FromTemplateResult["divisions"][number]["stages"] = [];
        for (let si = 0; si < templateDivision.stages.length; si++) {
          stageIndexInProgress = si;
          const templateStage = templateDivision.stages[si]!;
          const stageName = t(dict, templateStage.i18nNameKey);
          const [stage] = await tx<{ id: string }[]>`
            insert into stages (division_id, seq, kind, name, config)
            values (${divisionId}, ${si + 1}, ${templateStage.kind}, ${stageName},
                    ${tx.json(effectiveStageConfig(templateStage) as never)})
            returning id`;
          // No fixtures at instantiation time by design: entrants don't
          // exist yet (design doc §UI — "wizard routes into the entrant-add
          // step with placeholder counts... no fake entrants created"), so
          // generateStageFixtures never runs here.
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
    return divisionResults;
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

  return {
    competitionId,
    divisions,
    templateKey: template.key,
    templateVersion: template.version,
  };
}
