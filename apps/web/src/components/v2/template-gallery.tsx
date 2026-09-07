"use client";

// Create-competition wizard, step 0 (D1a design doc, P4): a gallery of
// curated format templates + "start blank". Picking a card opens a detail
// sheet (Modal — the same bottom-sheet-under-sm/centered-above pattern the
// rest of the console already uses for "sheet" surfaces) with the full
// division/stage breakdown and a short name+dates form; "Use this template"
// POSTs /api/v1/competitions/from-template and lands on the new competition
// page, exactly like the blank-form wizard already does off its own POST.
// "Start blank" falls through to the EXISTING, unmodified CompetitionWizard.
//
// `templates` arrives as a PROP from the Server Component page, not a direct
// `@/server/templates/catalog` import — that module resolves `StageKind`
// through api-v1/schemas.ts, which (for the OpenAPI generator's sake) pulls
// in `@seazn/engine/scheduling`'s HardConstraint, whose barrel also reaches
// the gRPC placement client (`@grpc/grpc-js`, Node-only: dns/fs/http2/net).
// A plain Server Component never ships that chain to the browser; a "use
// client" file that VALUE-imports it does — caught by e2e, not tsc or
// vitest, which is exactly why the acceptance criteria requires a REAL e2e
// run. `CompetitionTemplate` below stays a TYPE-only import (erased at
// build, zero runtime weight) — only the catalog.ts VALUE import moved.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { Modal } from "@/components/modal";
import { CompetitionWizard } from "@/components/v2/competition-wizard";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import {
  publicDashboardGain,
  PUBLIC_DASHBOARD_FEATURE,
  type PublicDashboardUpgrade,
} from "@/lib/public-dashboard-upgrade";
import { doubleElimFormatReason } from "@/lib/feature-copy";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { routes } from "@/lib/routes";
import { useT } from "@/components/i18n/dict-provider";
import type { CompetitionTemplate, TemplateStage } from "@/server/templates/schema";
import { templateEntrantTotal } from "@/server/templates/summary";

// useT() (not useMsg()) throughout this file, deliberately: every key here
// is resolved off DATA (template.i18n.nameKey, a stage's kind) rather than
// a literal written in the component, so it can never narrow to useMsg()'s
// strict MessageKey union. useT()'s TKey (i18n-runtime.ts: `DictionaryKey |
// (string & {})`) is the SAME "keys may be dynamic" escape hatch
// format-gallery.tsx's familyCopy()/`tf: (key: string) => string` already
// documents for this exact situation.
export type Msg = ReturnType<typeof useT>;

/** Human labels for the stage kinds the catalog uses — P4's original 5
 *  templates plus P7's euro24/t20-super8/league-playoff (D1b). `league` and
 *  `page_playoff` were added here in T4, alongside the progression map
 *  below: league-playoff is the first catalog entry to actually reach
 *  either branch, so before this fix both rendered as their raw kind string
 *  here and in TemplateCard's structure line (both read this map via
 *  stageKindLabel). Falls back to the raw kind string for anything still
 *  missing — belt and suspenders, not currently reachable
 *  (double_elim/stepladder/ladder have no catalog entry), but a missing
 *  label reads better than a blank one if a future template adds one of
 *  those kinds first. */
const STAGE_KIND_KEY: Record<string, string> = {
  knockout: "templates.stageKind.knockout",
  group: "templates.stageKind.group",
  swiss: "templates.stageKind.swiss",
  americano: "templates.stageKind.americano",
  league: "templates.stageKind.league",
  page_playoff: "templates.stageKind.pagePlayoff",
};

function stageKindLabel(msg: Msg, kind: string): string {
  return msg(STAGE_KIND_KEY[kind] ?? kind);
}

/** The Structure section's per-division stage chain (P7/D1b T6). A stage
 *  renders by its OWN name (`i18nNameKey`) when another stage in the SAME
 *  division shares its `kind` — t20-super8's two `group`-kind stages
 *  ("Group Stage" and "Super 8") are indistinguishable by kind label alone
 *  ("Group stage → Group stage → Knockout", the defect this fixes) — and
 *  falls back to the pre-existing generic kind label otherwise. No division
 *  in the pre-P7 catalog repeats a kind, so this renders BYTE-IDENTICAL to
 *  the old kind-label-only chain for all five of those templates (proven in
 *  template-gallery-progression.test.tsx against the real catalog, not just
 *  lookalike fixtures). */
export function templateStructureChain(msg: Msg, division: CompetitionTemplate["divisions"][number]): string {
  return division.stages
    .map((stage) => {
      const kindIsAmbiguous = division.stages.filter((s) => s.kind === stage.kind).length > 1;
      return kindIsAmbiguous ? msg(stage.i18nNameKey) : stageKindLabel(msg, stage.kind);
    })
    .join(" → ");
}

// --- Progression map (P7 D1b T4) -------------------------------------------
//
// A stage carrying `.progression` qualifies from an earlier stage in the
// same division (F2 unified this from the old `.seeding` — schema.ts's
// TemplateStage.progression doc comment). This renders that as one line per
// fed stage: what feeds it (every source's `take` rules, ALL of them —
// euro24's knockout stage carries two, top-2-per-group AND the 4 best
// third-placed teams, and rendering only the first would silently
// under-describe exactly the template this feature exists for) and where it
// lands (the stage's own name). A catalog entry's `progression.sources`
// always narrows to exactly one "previous" source (TemplateStageProgression,
// schema.ts) — the flatMap below stays correct if that ever widens. Pure
// functions, exported for direct unit testing — component-ui-i18n memory: no
// jsdom in this workspace, so derivation logic is tested as plain functions
// rather than through a rendered tree wherever it can be pulled out that far.

type TakeRule = NonNullable<TemplateStage["progression"]>["sources"][number]["take"][number];

/** One take rule -> its own translated phrase. Each rule kind is ONE
 *  dictionary key with parameters, never fragments concatenated at the call
 *  site — see ProgressionSchema/TakeRuleSchema (api-v1/schemas.ts) for the
 *  field shapes this switches on. F2 unified TakeRuleSchema onto 5 kinds
 *  (rankRange/topNPerGroup/bestNth/picks/roundLosers); only the 3 below are
 *  reachable from catalog data today (verified: no catalog entry emits
 *  picks/roundLosers — those are picker-only, format-templates.ts, which
 *  never renders through this component) so `rule` no longer narrows to
 *  `never` in the default branch, but the fallback (raw kind string) is
 *  unchanged and still correct if that ever stops being true. */
export function takeRuleText(msg: Msg, rule: TakeRule): string {
  switch (rule.kind) {
    case "topNPerGroup":
      return msg("templates.detail.take.topNPerGroup", { n: rule.n });
    case "bestNth":
      return msg("templates.detail.take.bestNth", { count: rule.count, nth: rule.nth });
    case "rankRange":
      return msg("templates.detail.take.rankRange", { from: rule.from, to: rule.to });
    default:
      return rule.kind;
  }
}

/** Joins 2+ already-translated take-rule phrases into one source
 *  description — its own parameterised key (`{a} and {b}`), not a hardcoded
 *  join word, and folded pairwise so a stage with 3+ take rules (the schema
 *  allows up to 8) still renders all of them, not just the first two. */
function joinTakeTexts(msg: Msg, texts: string[]): string {
  const [first, ...rest] = texts;
  return rest.reduce((acc, text) => msg("templates.detail.take.and", { a: acc, b: text }), first);
}

export type ProgressionLine = { key: string; text: string };

/** Every seeded stage across every division, as a fully-formatted
 *  "{source}: {take} -> {target}" line (P7/D1b T6 adds the leading
 *  "{source}: " — the SOURCE stage's own name — because two seeded stages
 *  that share a take rule and a target kind, like t20-super8's Super 8 and
 *  Knockout both reading "Top 2 per group -> ...", were otherwise
 *  indistinguishable). The empty array (no stage carries `.seeding`) is the
 *  pre-P7 catalog shape, and the caller renders nothing for it. */
export function templateProgressionLines(msg: Msg, template: CompetitionTemplate): ProgressionLine[] {
  const lines: ProgressionLine[] = [];
  for (const division of template.divisions) {
    for (let i = 0; i < division.stages.length; i++) {
      const stage = division.stages[i];
      if (!stage.progression) continue;
      // Every source's `stage` is schema-narrowed to "previous" only
      // (schema.ts's TemplateStageProgression) — always the stage
      // immediately before this one in THIS division's own array, never a
      // different division or a live stage id (a catalog entry has none
      // yet). Guard defensively anyway: nothing stops a future catalog
      // entry from setting `.progression` on a division's first stage even
      // though schema.ts's own comment says that never happens — skip such
      // a line rather than crash the whole sheet on `undefined.i18nNameKey`.
      const sourceStage: TemplateStage | undefined = division.stages[i - 1];
      if (!sourceStage) continue;
      const take = joinTakeTexts(
        msg,
        stage.progression.sources.flatMap((s) => s.take).map((rule) => takeRuleText(msg, rule)),
      );
      const target = msg(stage.i18nNameKey);
      lines.push({
        key: `${division.i18nNameKey}:${stage.i18nNameKey}`,
        text: msg("templates.detail.progression.line", {
          source: msg(sourceStage.i18nNameKey),
          take,
          target,
        }),
      });
    }
  }
  return lines;
}

/**
 * Turns a `/api/v1/competitions/from-template` failure into paywall state —
 * pure, so the decision can be tested directly (no jsdom in this workspace;
 * TemplateDetailSheet's real submit() is an async click handler this file
 * can't drive without one, same reasoning as templateProgressionLines
 * above). Returns `null` for anything that isn't a 402, exactly like the
 * inline check this replaces.
 *
 * Bug fix 2026-08-18: `formats.double_elim` gates both a real
 * double-elimination bracket AND a Page playoff (format-gates.ts's
 * stageNeedsDoubleElimGate — untouched by this fix, the shared entitlement
 * is correct on purpose). The server's 402 only carries the feature KEY, not
 * which of the two kinds actually triggered it, so the generic
 * featureReason("formats.double_elim") text always named
 * double-elimination — wrong for "League + Playoffs" (catalog key
 * league-playoff), whose only gated stage is page_playoff. This component
 * already has the full template, including every stage's kind, so it
 * re-derives the answer locally rather than widening the 402 wire shape
 * (PaymentRequiredError/requireFeature) that ~20 other call sites share for
 * one display string. Every OTHER feature key's `reason` stays undefined,
 * unchanged from before — <UpgradeGate> falls back to its own
 * featureReason(feature) exactly as it always has.
 */
export function paywallFromError(
  err: unknown,
  template: CompetitionTemplate,
): { feature: string; reason?: string } | null {
  if (!(err instanceof ApiV1Error) || err.code !== "PAYMENT_REQUIRED") return null;
  const feature = String(err.extra.feature_key ?? "");
  if (feature !== "formats.double_elim") return { feature };
  const gatedStage = template.divisions
    .flatMap((division) => division.stages)
    .find((stage) => stage.kind === "double_elim" || stage.kind === "page_playoff");
  return { feature, reason: doubleElimFormatReason(gatedStage?.kind ?? "double_elim") };
}

export function TemplateCard({
  template,
  msg,
  onSelect,
}: {
  template: CompetitionTemplate;
  msg: Msg;
  onSelect: () => void;
}) {
  // Reuses templateStructureChain — the SAME per-division composition
  // helper TemplateDetailSheet's Structure line uses below — one call per
  // division, joined, rather than a second kind-vs-own-name disambiguation
  // implementation. Every catalog template today has exactly one division,
  // so this is byte-identical to calling it once; a future multi-division
  // template gets the same disambiguation automatically instead of drifting.
  const structure = template.divisions.map((division) => templateStructureChain(msg, division)).join(" → ");
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`template-card-${template.key}`}
      className="card flex flex-col items-start gap-2 p-5 text-left transition hover:border-purple-300 hover:shadow-md"
    >
      <span className="text-base font-semibold text-purple-900">{msg(template.i18n.nameKey)}</span>
      <span className="text-sm text-slate-500">{msg(template.i18n.descriptionKey)}</span>
      <span className="mt-1 text-xs font-medium text-purple-600">
        {structure} · {msg("templates.gallery.entrantCount", { count: templateEntrantTotal(template) })}
      </span>
      <span className="text-xs font-medium text-purple-500 underline underline-offset-2">
        {msg("templates.gallery.cta")}
      </span>
    </button>
  );
}

export function TemplateDetailSheet({
  orgSlug,
  template,
  onClose,
  publicDashboardUpgrade,
  viewerPlan,
}: {
  orgSlug: string;
  template: CompetitionTemplate;
  onClose: () => void;
  /** What the next plan up hosts for `dashboard.public.max` — see the blank
   *  wizard's own prop for why this is required and handed down rather than
   *  read here. */
  publicDashboardUpgrade: PublicDashboardUpgrade | null;
  viewerPlan: ViewerPlan;
}) {
  const msg = useT();
  const router = useRouter();
  const [name, setName] = useState(msg(template.i18n.nameKey));
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<{ feature: string; reason?: string } | null>(null);
  // Set when the public-dashboard cap turned this create private (T20). NOT an
  // error — the competition exists — so it replaces the form with a note and a
  // way onward, exactly as the blank wizard does, instead of redirecting into a
  // competition whose public link 404s.
  const [degraded, setDegraded] = useState<
    { name: string; slug: string; limit: number | null } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const progressionLines = templateProgressionLines(msg, template);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywall(null);
    // Same client-side guard as the blank wizard, and the same reason: the
    // end date is mandatory server-side, so skipping this would surface a
    // bare 400 "Invalid input" instead of a localized message.
    if (!endsOn) {
      setError(msg("comp.wizard.endsOn.required"));
      return;
    }
    if (startsOn && endsOn < startsOn) {
      setError(msg("comp.validation.endsBeforeStarts"));
      return;
    }
    setBusy(true);
    try {
      // The response shape is spelled out inline rather than imported from
      // `@/server/api-v1/schemas`: this is a "use client" file, and a VALUE
      // import of that module drags the gRPC placement client into the browser
      // bundle (see the module header). Only the two fields this component
      // acts on are named.
      const created = await apiV1<{
        slug: string;
        visibility: string;
        public_quota_degraded?: { feature_key: string; limit: number | null };
      }>("/api/v1/competitions/from-template", {
        method: "POST",
        json: {
          template_key: template.key,
          template_version: template.version,
          name,
          starts_on: startsOn || null,
          ends_on: endsOn,
        },
      });
      // ONE signal, the explicit one. Diffing `visibility` against the request
      // would be a second guard covering for the first, and two guards covering
      // for each other are each untested.
      if (created.public_quota_degraded) {
        setDegraded({
          name: name.trim(),
          slug: created.slug,
          limit: created.public_quota_degraded.limit,
        });
        return;
      }
      router.push(routes.competition(orgSlug, created.slug));
    } catch (err) {
      const nextPaywall = paywallFromError(err, template);
      if (nextPaywall) {
        setPaywall(nextPaywall);
      } else {
        setError(err instanceof Error ? err.message : msg("comp.wizard.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  // The create SUCCEEDED — so the "Use this template" button goes with the
  // form, for the same reason the blank wizard drops its own: leaving an armed
  // create button under a competition that already exists is how the same event
  // gets created twice.
  if (degraded) {
    // What the next plan up hosts, or null when there is nothing honest to say
    // (lib/public-dashboard-upgrade.ts).
    const capsGain = publicDashboardGain(degraded.limit, publicDashboardUpgrade);
    return (
      <Modal
        title={msg("comp.wizard.publicDegraded.title")}
        onClose={onClose}
        size="lg"
        footer={
          <button
            type="button"
            data-testid="template-degraded-continue"
            onClick={() => router.push(routes.competition(orgSlug, degraded.slug))}
            className="btn btn-primary min-h-11"
          >
            {msg("comp.wizard.publicDegraded.continue")}
          </button>
        }
      >
        {/* Same testid and the same three `comp.wizard.publicDegraded.*` keys
            (title/body/continue) the blank wizard renders — one message,
            already translated into all four locales, not a second copy of it
            written for the majority path. */}
        <div className="space-y-4" data-testid="public-quota-degraded">
          <p className="text-sm leading-relaxed text-slate-600">
            {msg("comp.wizard.publicDegraded.body", { name: degraded.name })}
          </p>
          {/* Same two `…publicDegraded.caps*` keys the blank wizard renders,
              for the same reason: the organiser is one tap from a paywall and
              nothing here was telling them how big the gap is. */}
          {degraded.limit !== null && (
            <p className="text-sm font-medium text-slate-700" data-testid="public-quota-caps">
              {capsGain !== null && publicDashboardUpgrade
                ? msg("comp.wizard.publicDegraded.caps", {
                    limit: degraded.limit,
                    plan: publicDashboardUpgrade.plan,
                    upgrade: capsGain,
                  })
                : msg("comp.wizard.publicDegraded.capsOwn", { limit: degraded.limit })}
            </p>
          )}
          <UpgradeGate feature={PUBLIC_DASHBOARD_FEATURE} viewerPlan={viewerPlan} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={msg(template.i18n.nameKey)}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {/* `min-h-11` = 44px, the phone touch-target floor this repo asserts
              on (components/v2/confirm-dialog.tsx carries the same note). The
              bare `.btn` is `py-2 text-sm`, which measures 38px — under the
              floor at every width, not just phones. Caught by mobile.spec.ts's
              "portfolio panels" test, which measures these two buttons. */}
          <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
            {msg("comp.wizard.cancel")}
          </button>
          <button
            type="submit"
            form="template-detail-form"
            disabled={busy || !name.trim()}
            data-testid="template-detail-submit"
            className="btn btn-primary min-h-11"
          >
            {busy ? msg("comp.wizard.creating") : msg("templates.detail.useTemplate")}
          </button>
        </>
      }
    >
      <form id="template-detail-form" onSubmit={submit} className="space-y-4">
        {/* Form fields lead, prose follows (owner ruling, 320px scroll-fold
            fix): at 320x568 the required Ends-on field sat below the modal's
            internal scroll fold on EVERY template, pre-P7 (reproduced on
            box-league) and worsened by PROGRESSION below. A mobile organiser
            now sees what they must fill in without scrolling, and scrolls
            only for the explanatory copy underneath. Pure reorder — every
            block below is unchanged, only their sequence moved. */}
        <label className="block">
          <span className="label">{msg("comp.wizard.name.label")}</span>
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <DateTimeField
            kind="date"
            label={msg("comp.wizard.startsOn")}
            value={startsOn}
            onChange={setStartsOn}
          />
          <DateTimeField
            kind="date"
            label={`${msg("comp.wizard.endsOn")} *`}
            required
            min={startsOn || undefined}
            value={endsOn}
            onChange={setEndsOn}
          />
        </div>

        <p>{msg(template.i18n.descriptionKey)}</p>

        <div>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            {msg("templates.detail.structureTitle")}
          </h4>
          <ul className="space-y-1 text-sm text-slate-600" data-testid="template-detail-structure">
            {template.divisions.map((division) => (
              <li key={division.i18nNameKey}>
                <span className="font-medium text-slate-700">{msg(division.i18nNameKey)}</span>
                {" — "}
                {templateStructureChain(msg, division)}
                {" · "}
                {msg("templates.gallery.entrantCount", { count: division.entrantCount })}
              </li>
            ))}
          </ul>
        </div>

        {progressionLines.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {msg("templates.detail.progressionTitle")}
            </h4>
            {/* `overflow-x-auto` is the sheet's own scroll boundary if a
                long/untranslatable line ever can't wrap — never the page
                (standing UI rule). Lines wrap normally by default (same as
                the Structure list above it), so this is a safety net rather
                than the common case. */}
            <ul
              className="space-y-1 overflow-x-auto text-sm text-slate-600"
              data-testid="template-detail-progression"
            >
              {progressionLines.map((line) => (
                <li key={line.key}>{line.text}</li>
              ))}
            </ul>
          </div>
        )}

        {paywall && (
          <UpgradeGate feature={paywall.feature} reason={paywall.reason} viewerPlan={viewerPlan} />
        )}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}

export function TemplateGallery({
  orgSlug,
  templates,
  publicDashboardUpgrade,
  viewerPlan,
}: {
  orgSlug: string;
  /** The catalog, passed down from the Server Component page — see the
   *  module header for why this can't be a direct catalog.ts import here. */
  templates: CompetitionTemplate[];
  /** `dashboard.public.max` on the next plan up, read from `plan_entitlements`
   *  by the page. Handed to BOTH create paths — the template sheet and the
   *  blank wizard degrade identically, and a figure that reached only one of
   *  them would be worse than none at all. */
  publicDashboardUpgrade: PublicDashboardUpgrade | null;
  viewerPlan: ViewerPlan;
}) {
  const msg = useT();
  const [mode, setMode] = useState<"gallery" | "blank">("gallery");
  const [detailKey, setDetailKey] = useState<string | null>(null);

  if (mode === "blank")
    return (
      <CompetitionWizard
        orgSlug={orgSlug}
        publicDashboardUpgrade={publicDashboardUpgrade}
        viewerPlan={viewerPlan}
      />
    );

  const selected = detailKey ? templates.find((t) => t.key === detailKey) ?? null : null;

  return (
    <div className="space-y-5" data-testid="template-gallery">
      <p className="text-sm text-slate-500">{msg("templates.gallery.subtitle")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((template) => (
          <TemplateCard
            key={template.key}
            template={template}
            msg={msg}
            onSelect={() => setDetailKey(template.key)}
          />
        ))}
        <button
          type="button"
          onClick={() => setMode("blank")}
          data-testid="template-start-blank"
          className="card flex flex-col items-start gap-2 border-dashed border-slate-300 p-5 text-left transition hover:border-purple-300 hover:bg-purple-50/40"
        >
          <span className="text-base font-semibold text-slate-700">
            {msg("templates.gallery.startBlank.title")}
          </span>
          <span className="text-sm text-slate-500">{msg("templates.gallery.startBlank.desc")}</span>
        </button>
      </div>
      {selected && (
        <TemplateDetailSheet
          orgSlug={orgSlug}
          template={selected}
          onClose={() => setDetailKey(null)}
          publicDashboardUpgrade={publicDashboardUpgrade}
          viewerPlan={viewerPlan}
        />
      )}
    </div>
  );
}
