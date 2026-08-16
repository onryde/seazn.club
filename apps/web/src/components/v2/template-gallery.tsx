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
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { routes } from "@/lib/routes";
import { useT } from "@/components/i18n/dict-provider";
import type { CompetitionTemplate, TemplateStage } from "@/server/templates/schema";
import { templateEntrantTotal, templateStageKinds } from "@/server/templates/summary";

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

// --- Progression map (P7 D1b T4) -------------------------------------------
//
// A stage carrying `.seeding` qualifies from an earlier stage in the same
// division (schema.ts's TemplateStage.seeding doc comment). This renders
// that as one line per seeded stage: what feeds it (its `seeding.take`
// rules, ALL of them — euro24's knockout stage carries two, top-2-per-group
// AND the 4 best third-placed teams, and rendering only the first would
// silently under-describe exactly the template this feature exists for) and
// where it lands (the stage's own name). Pure functions, exported for direct
// unit testing — component-ui-i18n memory: no jsdom in this workspace, so
// derivation logic is tested as plain functions rather than through a
// rendered tree wherever it can be pulled out that far.

type TakeRule = NonNullable<TemplateStage["seeding"]>["take"][number];

/** One `seeding.take` rule -> its own translated phrase. Each rule kind is
 *  ONE dictionary key with parameters, never fragments concatenated at the
 *  call site — see StageSeedingSchema/TakeRuleSchema (api-v1/schemas.ts) for
 *  the field shapes this switches on. */
export function takeRuleText(msg: Msg, rule: TakeRule): string {
  switch (rule.kind) {
    case "topNPerGroup":
      return msg("templates.detail.take.topNPerGroup", { n: rule.n });
    case "bestNth":
      return msg("templates.detail.take.bestNth", { count: rule.count, nth: rule.nth });
    case "rankRange":
      return msg("templates.detail.take.rankRange", { from: rule.from, to: rule.to });
    default:
      // Belt and suspenders, same spirit as stageKindLabel's fallback above
      // — no TakeRule variant reaches this today (TakeRuleSchema is exactly
      // the 3 cases above), `rule` narrows to `never` here.
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
 *  "{source} -> {target}" line. The empty array (no stage carries
 *  `.seeding`) is the pre-P7 catalog shape, and the caller renders nothing
 *  for it — the sheet's markup for those templates is unchanged by this. */
export function templateProgressionLines(msg: Msg, template: CompetitionTemplate): ProgressionLine[] {
  const lines: ProgressionLine[] = [];
  for (const division of template.divisions) {
    for (const stage of division.stages) {
      if (!stage.seeding) continue;
      const source = joinTakeTexts(
        msg,
        stage.seeding.take.map((rule) => takeRuleText(msg, rule)),
      );
      const target = msg(stage.i18nNameKey);
      lines.push({
        key: `${division.i18nNameKey}:${stage.i18nNameKey}`,
        text: msg("templates.detail.progression.line", { source, target }),
      });
    }
  }
  return lines;
}

function TemplateCard({
  template,
  msg,
  onSelect,
}: {
  template: CompetitionTemplate;
  msg: Msg;
  onSelect: () => void;
}) {
  const structure = templateStageKinds(template).map((k) => stageKindLabel(msg, k)).join(" → ");
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
}: {
  orgSlug: string;
  template: CompetitionTemplate;
  onClose: () => void;
}) {
  const msg = useT();
  const router = useRouter();
  const [name, setName] = useState(msg(template.i18n.nameKey));
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<{ feature: string; reason?: string } | null>(null);
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
      const created = await apiV1<{ slug: string }>("/api/v1/competitions/from-template", {
        method: "POST",
        json: {
          template_key: template.key,
          template_version: template.version,
          name,
          starts_on: startsOn || null,
          ends_on: endsOn,
        },
      });
      router.push(routes.competition(orgSlug, created.slug));
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall({
          feature: String(err.extra.feature_key ?? ""),
          reason: typeof err.extra.reason === "string" ? err.extra.reason : undefined,
        });
      } else {
        setError(err instanceof Error ? err.message : msg("comp.wizard.failed"));
      }
    } finally {
      setBusy(false);
    }
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
                {division.stages.map((s) => stageKindLabel(msg, s.kind)).join(" → ")}
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

        {paywall && <UpgradeGate feature={paywall.feature} />}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}

export function TemplateGallery({
  orgSlug,
  templates,
}: {
  orgSlug: string;
  /** The catalog, passed down from the Server Component page — see the
   *  module header for why this can't be a direct catalog.ts import here. */
  templates: CompetitionTemplate[];
}) {
  const msg = useT();
  const [mode, setMode] = useState<"gallery" | "blank">("gallery");
  const [detailKey, setDetailKey] = useState<string | null>(null);

  if (mode === "blank") return <CompetitionWizard orgSlug={orgSlug} />;

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
        <TemplateDetailSheet orgSlug={orgSlug} template={selected} onClose={() => setDetailKey(null)} />
      )}
    </div>
  );
}
