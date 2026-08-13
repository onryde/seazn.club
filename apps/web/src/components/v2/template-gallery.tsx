"use client";

// Create-competition wizard, step 0 (D1a design doc, P4): a gallery of
// curated format templates + "start blank". Picking a card opens a detail
// sheet (Modal — the same bottom-sheet-under-sm/centered-above pattern the
// rest of the console already uses for "sheet" surfaces) with the full
// division/stage breakdown and a short name+dates form; "Use this template"
// POSTs /api/v1/competitions/from-template and lands on the new competition
// page, exactly like the blank-form wizard already does off its own POST.
// "Start blank" falls through to the EXISTING, unmodified CompetitionWizard.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { Modal } from "@/components/modal";
import { CompetitionWizard } from "@/components/v2/competition-wizard";
import { UpgradeGate } from "@/components/upgrade-gate";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { routes } from "@/lib/routes";
import { useT } from "@/components/i18n/dict-provider";
import { TEMPLATE_CATALOG } from "@/server/templates/catalog";
import type { CompetitionTemplate } from "@/server/templates/schema";
import { templateEntrantTotal, templateStageKinds } from "@/server/templates/summary";

// useT() (not useMsg()) throughout this file, deliberately: every key here
// is resolved off DATA (template.i18n.nameKey, a stage's kind) rather than
// a literal written in the component, so it can never narrow to useMsg()'s
// strict MessageKey union. useT()'s TKey (i18n-runtime.ts: `DictionaryKey |
// (string & {})`) is the SAME "keys may be dynamic" escape hatch
// format-gallery.tsx's familyCopy()/`tf: (key: string) => string` already
// documents for this exact situation.
type Msg = ReturnType<typeof useT>;

/** Human labels for the stage kinds the P4 launch catalog actually uses.
 *  Falls back to the raw kind string for anything not in this map — belt and
 *  suspenders, never hit by the current 5 templates (catalog.test.ts already
 *  pins the launch set), but a missing label reads better than a blank one
 *  if a future template adds a kind here first. */
const STAGE_KIND_KEY: Record<string, string> = {
  knockout: "templates.stageKind.knockout",
  group: "templates.stageKind.group",
  swiss: "templates.stageKind.swiss",
  americano: "templates.stageKind.americano",
};

function stageKindLabel(msg: Msg, kind: string): string {
  return msg(STAGE_KIND_KEY[kind] ?? kind);
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

function TemplateDetailSheet({
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
          <button type="button" onClick={onClose} className="btn btn-ghost">
            {msg("comp.wizard.cancel")}
          </button>
          <button
            type="submit"
            form="template-detail-form"
            disabled={busy || !name.trim()}
            data-testid="template-detail-submit"
            className="btn btn-primary"
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

export function TemplateGallery({ orgSlug }: { orgSlug: string }) {
  const msg = useT();
  const [mode, setMode] = useState<"gallery" | "blank">("gallery");
  const [detailKey, setDetailKey] = useState<string | null>(null);

  if (mode === "blank") return <CompetitionWizard orgSlug={orgSlug} />;

  const selected = detailKey ? TEMPLATE_CATALOG.find((t) => t.key === detailKey) ?? null : null;

  return (
    <div className="space-y-5" data-testid="template-gallery">
      <p className="text-sm text-slate-500">{msg("templates.gallery.subtitle")}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATE_CATALOG.map((template) => (
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
