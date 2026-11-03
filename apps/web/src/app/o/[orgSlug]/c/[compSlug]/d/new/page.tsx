export const dynamic = "force-dynamic";
// The new-division builder (Match Day C9): Who plays / Format / Division rules / Review.
import { redirect } from "next/navigation";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { resolveModule } from "@/server/engine-db";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { pointsLineDict, rulesLineDict } from "@/lib/rules-line";
import { onlineChessOffered } from "@/server/usecases/external-play";
import { stageNeedsAdvancedFormatsGate, stageNeedsDoubleElimGate } from "@/server/usecases/format-gates";
import { STAGE_TEMPLATES, buildTemplateStages } from "@/lib/format-templates";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getCompetition } from "@/server/usecases/competitions";
import { withTenant } from "@/lib/db";
import { hasFeature, orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { archivedSlotsExplainRefusal } from "@/server/usecases/division-slots";
import { DivisionBuilder } from "@/components/v2/division-builder";
import { sportOptionsFrom, type VariantRow } from "@/lib/sport-options";
// P9 scope item 5: org venues+courts feed the Scheduling step's court
// multi-picker.
import { listVenues } from "@/server/usecases/venues";

export default async function NewDivisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/d/new" });
  const { auth, canEdit } = page;
  const id = page.competition.id;
  if (!canEdit) redirect(routes.competition(orgSlug, compSlug));
  const [competition, constraintsAllowed, explainArchivedSlots, venues, planKey, doubleElimAllowed, advancedAllowed, carryAllowed, onlineChess] = await Promise.all([
    getCompetition(auth, id),
    // A multi-venue schedule seed is Pro (doc 12 §5) — gate the list in the
    // wizard rather than letting the settings PUT 402 after create.
    hasFeature(auth.orgId, "scheduling.constraints"),
    // Read UNCONDITIONALLY, before anyone has been refused anything: this page
    // is the only surface that creates a division, so it is the only place the
    // `divisions.per_competition.max` 402 can land, and the refusal happens in
    // a client component after a POST that this server render is already over.
    // Fetching it here costs one count on every wizard load — a second count
    // and a cached entitlement read only when something IS archived — and it
    // keeps the rule on the server; asking for it after the 402 would need a
    // new endpoint exposing the quota predicate to the browser.
    archivedSlotsExplainRefusal(auth, id),
    // P9 scope item 5: the Scheduling step's court multi-picker.
    listVenues(auth),
    orgPlanKey(auth.orgId),
    // The stage writers' own gates (createStages: formats.double_elim, formats.advanced with the competition's event pass,
    // standings.carry_over without), asked here so a format this organisation cannot create is said on the Format step
    // instead of as a 402 after the division already exists.
    hasFeature(auth.orgId, "formats.double_elim", id),
    hasFeature(auth.orgId, "formats.advanced", id),
    hasFeature(auth.orgId, "standings.carry_over"),
    onlineChessOffered(auth),
  ]);
  const locale = await resolveLocale();
  const [uiDict, publicDict] = await Promise.all([getDictionary(locale, "ui"), getDictionary(locale, "public")]);
  // Template → the feature it needs and this organisation lacks. Read off each template's own stage kinds (the knobs do
  // not change the kinds), with the gate predicates createStages uses.
  const templateLocks: Record<string, string> = {};
  for (const tpl of STAGE_TEMPLATES) {
    const kinds = buildTemplateStages(tpl.key, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    if (!doubleElimAllowed && kinds.some((st) => stageNeedsDoubleElimGate(st.kind))) templateLocks[tpl.key] = "formats.double_elim";
    else if (!advancedAllowed && kinds.some((st) => stageNeedsAdvancedFormatsGate(st))) templateLocks[tpl.key] = "formats.advanced";
  }
  const viewerPlan = viewerPlanFrom(planKey);

  // Sport catalog + variant presets (system rows are tenant-readable, org
  // presets scoped by RLS — doc 07).
  const sports = await withTenant(auth.orgId, async (tx) => {
    const sportRows = await tx<{ key: string; name: string; module_version: string }[]>`
      select key, name, module_version from sports order by name`;
    // `config` is the variant's preset: the builder counts cricket's overs in the variant's own over length with it.
    const variantRows = await tx<VariantRow[]>`
      select sport_key, key, name, is_system, config from sport_variants
      order by is_system desc, name`;
    // The entrant model of the module the create will pin (createDivision reads the same `module_version`).
    const versionOf = new Map(sportRows.map((r) => [r.key, r.module_version]));
    return sportOptionsFrom(sportRows, variantRows, (key) => {
      const version = versionOf.get(key);
      if (version === undefined) return undefined;
      try {
        const model = effectiveEntrantModel(resolveModule(key, version).entrantModel ?? null, null);
        return { kinds: model.kinds, defaultKind: model.defaultKind };
      } catch {
        // A sport row with no shipped module: nothing to ask, nothing sent.
        return undefined;
      }
    });
  });

  return (
    <>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">{t(uiDict, "divBuilder.title")}</h1>
        <p className="mb-6 min-w-0 break-words text-sm text-slate-600">{t(uiDict, "divBuilder.in", { competition: competition.name })}</p>
        <DivisionBuilder
          competitionId={id}
          orgSlug={orgSlug}
          compSlug={compSlug}
          sports={sports}
          venues={venues}
          // The window this division's schedule must sit inside. The seed PUT
          // the wizard fires after create is refused outside it (422) and the
          // wizard swallows that refusal, so the pickers carry the bound.
          competitionWindow={{ startsOn: competition.starts_on, endsOn: competition.ends_on }}
          constraintsAllowed={constraintsAllowed}
          archivedSlotsExplainRefusal={explainArchivedSlots}
          viewerPlan={viewerPlan}
          onlineChessOffered={onlineChess}
          ruleDict={rulesLineDict(publicDict)}
          pointsDict={pointsLineDict(publicDict)}
          templateLocks={templateLocks}
          carryAllowed={carryAllowed}
        />
      </main>
    </>
  );
}
