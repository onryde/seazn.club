"use client";

// Competition settings — PATCH /api/v1/competitions/{id}.
//
// The C8 layout (owner 2026-11-11, mock set11c01 C1/C2): the New competition form's two-column card, with the same
// controls — the date fields, the three-way "Who can see this", the "Who will find it" list and the Showcase switch — so
// a competition is edited with what it was created with. Status is a chip beside the title. One Save for the card, and
// the line beside it says what is unsaved.
//
// City and country are no longer asked for here (owner ruling 2026-11-11). Their stored values stay: this form never
// sends them, and the server merges `discovery` key by key (usecases/competitions.ts `mergeDiscovery`), so a save that
// carries only the tagline leaves them where they are.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import Link from "@/components/ui/console-link";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { PlanBadge } from "@/components/plan-badge";
import { Tip } from "@/components/ui/tip";
import { VisibilityShareLink } from "@/components/ui/visibility-picker";
import { VisibilitySegmented } from "@/components/ui/visibility-segmented";
import { useConfirm } from "@/components/ui/confirm-provider";
import { CompetitionReach } from "@/components/v2/competition-reach";
import { ShowcaseOptIn } from "@/components/v2/showcase-optin";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { SaveBar, SettingsSplitCard } from "@/components/v2/shared/settings-split-card";
import { publicBrandColor, publicThemeStyleChain } from "@/lib/public-theme";
import { ProseEditor } from "@/components/prose-editor";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { MessageKey } from "@/lib/messages";
import { publishWouldList } from "@/lib/competition-listing";
import { OpenStagesWarning } from "@/components/v2/open-stages-warning";
import type { OpenStageRow } from "@/lib/open-stages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface CompetitionLite {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visibility: string;
  status: string;
  frozen: boolean;
  discoverable: boolean;
  discovery: Record<string, string | null>;
  branding: unknown;
}

const STATUSES = ["draft", "published", "live", "completed", "archived"];
/** One settings form per page, so a fixed id is unique. */
const DRAFT_UNLISTED_HINT_ID = "compset-draft-unlisted-hint";
const OPEN_STAGES_WARNING_ID = "compset-open-stages-warning";
const SAVE_MESSAGE_ID = "compset-save-message";
/** The violet every public page falls back to without a brand colour (BrandColorPicker's own default). */
const DEFAULT_BRAND = "#7c3aed";

/** The status chip's dot: a hue per stage, always beside the word (never colour alone). */
const STATUS_DOT: Record<string, string> = {
  draft: "bg-slate-400",
  published: "bg-sky-500",
  live: "bg-emerald-500",
  completed: "bg-purple-500",
  archived: "bg-slate-300",
};

type SettingsTab = "general" | "branding" | "archived";

/** What the form holds; also the baseline Discard returns to and "Unsaved" is measured against. */
interface FormState {
  name: string;
  description: string;
  starts_on: string;
  ends_on: string;
  visibility: string;
  status: string;
  discoverable: boolean;
  tagline: string;
  hero_image_path: string;
  brand_primary: string | null;
}

/** Each field's name in the "Unsaved: …" line — the label the organiser sees on that field. Ordered as the page reads. */
const FIELD_LABEL: [keyof FormState, MessageKey][] = [
  ["status", "compset.status"],
  ["name", "compset.name"],
  ["starts_on", "compset.starts"],
  ["ends_on", "compset.ends"],
  ["visibility", "visibility.legend"],
  ["discoverable", "showcase.label"],
  ["description", "compset.description"],
  ["brand_primary", "compset.brandColor"],
  ["tagline", "compset.tagline"],
  ["hero_image_path", "compset.heroUrl"],
];

/** Localized status label; unknown values fall back to the raw token. */
function statusLabel(msg: Msg, status: string): string {
  const key = `compset.status.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status : label;
}

/** Nudge shown when the derived status differs from the saved one. */
function statusHint(msg: Msg, status: string): string {
  const key = `compset.statusHint.${status}` as MessageKey;
  const hint = msg(key);
  return hint === key ? msg("compset.statusHint.fallback", { status: statusLabel(msg, status) }) : hint;
}

/**
 * The fields whose value differs from the baseline, in page order. Showcase compares what will be SENT (it is only ever
 * on while public), so leaving Public with the switch already off does not list a change nobody made.
 */
export function unsavedFields(form: FormState, baseline: FormState): (keyof FormState)[] {
  const sent = (f: FormState) => ({ ...f, discoverable: f.visibility === "public" && f.discoverable });
  const a = sent(form);
  const b = sent(baseline);
  return FIELD_LABEL.map(([key]) => key).filter((key) => a[key] !== b[key]);
}

/** A hero image the preview may load: an absolute http(s) URL, nothing else. */
function previewImage(raw: string): string | null {
  const v = raw.trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : null;
}

/** "14–16 Nov 2026" in the reader's language; the dates are calendar days, so formatted in UTC. */
function previewDates(locale: string, starts: string, ends: string): string | null {
  const day = (d: string) => new Date(`${d}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat(intlLocaleFor(locale), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  if (starts && ends && ends >= starts) return fmt.formatRange(day(starts), day(ends));
  if (ends) return fmt.format(day(ends));
  if (starts) return fmt.format(day(starts));
  return null;
}

// Doc 15 §1 consent copy lives in lib/messages ("showcase.*") — shared with
// the create wizard so the two surfaces can never drift.

export function CompetitionSettings({
  competition,
  title,
  orgId,
  canEdit,
  discoveryBranding,
  themeBranding = false,
  orgBranding = null,
  suggestedStatus = null,
  archivedPanel = null,
  archivedCount = 0,
  sharePath = null,
  billingHref,
  hasYouthDivisions = false,
  openStages = [],
  viewerPlan,
}: {
  competition: CompetitionLite;
  /** The page title; the status chip sits beside it, so the heading lives here rather than on the page. */
  title?: string;
  /** Owning org — the description editor uploads images under it. */
  orgId: string;
  canEdit: boolean;
  discoveryBranding: boolean;
  /** Public path for the share-URL row under "Who can see this" (v3/03 §7). */
  sharePath?: string | null;
  /** Where the brand colour's upgrade line links (the org's billing page). */
  billingHref?: string;
  /** Any U-age division in this competition (v3/11 gap 8 interstitial). */
  hasYouthDivisions?: boolean;
  /** Org has dashboard.theme — public pages/noticeboard honor brand color. */
  themeBranding?: boolean;
  /** Org-level branding blob — the color this competition inherits. */
  orgBranding?: unknown;
  /** State-derived nudge, e.g. "live" once matches are underway. */
  suggestedStatus?: string | null;
  /** Rendered under the Archived tab (outside the settings form). */
  archivedPanel?: React.ReactNode;
  /** The Archived tab only shows when there is something to restore. */
  archivedCount?: number;
  /** W4 T21 (X-CH-8): the competition's open stages (`openStagesOf`), listed by the Complete-competition warning. */
  openStages?: OpenStageRow[];
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  // Optional: the youth interstitial is the only thing that asks, and it says so itself if the dialog is missing.
  const confirm = useConfirm({ optional: true });
  const [tab, setTab] = useState<SettingsTab>("general");
  const [baseline, setBaseline] = useState<FormState>(() => ({
    name: competition.name,
    description: competition.description ?? "",
    starts_on: competition.starts_on ?? "",
    ends_on: competition.ends_on ?? "",
    visibility: competition.visibility,
    status: competition.status,
    discoverable: competition.discoverable,
    tagline: competition.discovery.tagline ?? "",
    hero_image_path: competition.discovery.hero_image_path ?? "",
    brand_primary: publicBrandColor(competition.branding),
  }));
  const [form, setFormState] = useState<FormState>(baseline);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  /** Every edit clears the "Saved." note: it described the form before this change. */
  function setForm(next: FormState) {
    setFormState(next);
    setSaved(false);
  }

  const readOnly = !canEdit || competition.frozen;
  const showSuggestion = !readOnly && suggestedStatus && suggestedStatus !== form.status;
  const draftUnlisted = publishWouldList(form);
  // W4 T21 (AN-1, X-CH-8; owner pick R24 4A): completing WARNS, never refuses. The warning follows the form — it shows
  // the moment "completed" is chosen, before Save, and Save is never blocked — and beside a "Set to Completed"
  // suggestion too, since that one-tap button saves without waiting for Save. Only for someone who can change the
  // status: a viewer is not being asked to decide anything.
  const completing = form.status === "completed" || (showSuggestion && suggestedStatus === "completed");
  const showOpenStages = canEdit && openStages.length > 0 && completing;
  const statusDescribedBy =
    [draftUnlisted ? DRAFT_UNLISTED_HINT_ID : null, showOpenStages ? OPEN_STAGES_WARNING_ID : null].filter(Boolean).join(" ") ||
    undefined;

  const dirty = unsavedFields(form, baseline);
  const statusDirty = form.status !== baseline.status;
  const saveMessage =
    dirty.length > 0
      ? msg("settings.saveBar.unsaved", {
          fields: new Intl.ListFormat(intlLocaleFor(locale), { style: "short", type: "unit" }).format(
            dirty.map((key) => msg(FIELD_LABEL.find(([k]) => k === key)![1])),
          ),
        })
      : saved
        ? msg("compset.saved")
        : "";

  async function applyStatus(next: string) {
    setError(null);
    setBusy(true);
    try {
      await apiV1(`/api/v1/competitions/${competition.id}`, {
        method: "PATCH",
        json: { status: next },
      });
      // Saved on its own, so it is the new baseline too: it is not "unsaved" afterwards.
      setFormState((f) => ({ ...f, status: next }));
      setBaseline((b) => ({ ...b, status: next }));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("compset.failedStatus"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * "Who can see this". v3/11 gap 8: leaving Private with a youth division in the competition asks first, because the
   * names of minors become visible. Leaving Public switches Showcase off (consent is given again on the way back).
   */
  async function pickVisibility(next: string) {
    if (next === form.visibility) return;
    if (hasYouthDivisions && form.visibility === "private" && next !== "private") {
      if (!confirm) throw new Error("competition settings: the youth interstitial needs <ConfirmProvider> in the tree");
      const ok = await confirm({
        title: msg("visibility.youth.title"),
        body: msg("visibility.youth.body"),
        confirmLabel: msg("visibility.youth.confirm"),
      });
      if (!ok) return;
    }
    setForm({ ...form, visibility: next, discoverable: next === "public" ? form.discoverable : false });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywallFeature(null);
    setSaved(false);
    // #376: the end date is changeable but not removable — clearing the field
    // and saving would send null, which the schema now refuses. Say so here
    // rather than surface a bare 400, and keep the same order check the wizard
    // and the API do.
    if (!form.ends_on) {
      setError(msg("comp.wizard.endsOn.required"));
      return;
    }
    if (form.starts_on && form.ends_on < form.starts_on) {
      setError(msg("comp.validation.endsBeforeStarts"));
      return;
    }
    setBusy(true);
    try {
      await apiV1(`/api/v1/competitions/${competition.id}`, {
        method: "PATCH",
        json: {
          name: form.name,
          description: form.description.trim() || null,
          starts_on: form.starts_on || null,
          ends_on: form.ends_on,
          visibility: form.visibility,
          status: form.status,
          // Hard-coupled server-side too (doc 15 §1): a non-public visibility
          // always sends discoverable=false so the intent is unambiguous.
          discoverable: form.visibility === "public" ? form.discoverable : false,
          // Only the keys this form edits, and only for an entitled org (the server 402s them otherwise — doc 10 §2:
          // never UI-only). The server merges key by key, so city and country, which this form no longer shows, keep
          // their stored values.
          ...(discoveryBranding
            ? {
                discovery: {
                  tagline: form.tagline.trim() || null,
                  hero_image_path: form.hero_image_path.trim() || null,
                },
              }
            : {}),
          // Brand color override; {} = inherit the org color. Only rides for
          // entitled orgs — the public views ignore it otherwise anyway.
          ...(themeBranding
            ? {
                branding: form.brand_primary
                  ? { colors: { primary: form.brand_primary } }
                  : {},
              }
            : {}),
        },
      });
      setBaseline(form);
      setSaved(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("compset.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  // One form state, one save — tabs only organise the fields, so switching tabs never loses unsaved edits. The
  // Archived panel is a separate surface (its own API calls), so it renders outside the form. Branding is always a
  // tab: what an org's plan does not include is said there, beside the control, rather than by a tab that is missing.
  const tabs: { key: SettingsTab; label: string }[] = [
    { key: "general", label: msg("compset.tab.general") },
    { key: "branding", label: msg("compset.tab.branding") },
    ...(archivedCount > 0
      ? [{ key: "archived" as const, label: msg("compset.tab.archived", { n: archivedCount }) }]
      : []),
  ];
  // A refresh can remove the selected tab (last archived division restored) — fall back to General instead of a blank
  // panel.
  const activeTab: SettingsTab = tabs.some((t) => t.key === tab) ? tab : "general";

  const brandHex = themeBranding ? (form.brand_primary ?? publicBrandColor(orgBranding) ?? DEFAULT_BRAND) : DEFAULT_BRAND;
  const heroUrl = discoveryBranding ? previewImage(form.hero_image_path) : null;
  const tagline = discoveryBranding ? form.tagline.trim() : "";
  const dates = previewDates(locale, form.starts_on, form.ends_on);

  const notices = (
    <>
      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </>
  );
  const footer = canEdit ? (
    <SaveBar
      message={saveMessage}
      messageId={SAVE_MESSAGE_ID}
      canDiscard={dirty.length > 0}
      busy={busy}
      onDiscard={() => {
        setFormState(baseline);
        setError(null);
      }}
      discardLabel={msg("settings.saveBar.discard")}
      saveLabel={msg("compset.save")}
      savingLabel={msg("compset.saving")}
    />
  ) : undefined;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {title && (
          <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        )}
        {/* The status chip: a native select, so the menu, the keyboard and the screen reader are the platform's. Its
            name is the sr-only "Status" (the label's first text, which e2e also anchors on). Dashed while the pick is
            unsaved — Save sends it with the rest. */}
        <label
          className={`relative inline-flex min-w-0 items-center rounded-full border bg-white text-sm font-medium text-slate-800 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 ${
            statusDirty ? "border-dashed border-purple-500" : "border-purple-200"
          }`}
          data-testid="compset-status-chip"
        >
          <span className="sr-only">{msg("compset.status")}</span>
          <span aria-hidden className={`pointer-events-none absolute left-3 h-2 w-2 rounded-full ${STATUS_DOT[form.status] ?? "bg-slate-400"}`} />
          <select
            disabled={!canEdit}
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            aria-describedby={statusDescribedBy}
            className="min-h-11 cursor-pointer appearance-none rounded-full bg-transparent py-1 pl-7 pr-8 capitalize focus:outline-none disabled:cursor-not-allowed sm:min-h-9"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(msg, s)}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 h-4 w-4 text-slate-500" strokeWidth={2} />
        </label>
        {competition.frozen && <span className="badge bg-sky-100 text-sky-700">{msg("compset.readOnly")}</span>}
      </div>

      {/* Owner decision 2026-09-27: a draft is unlisted until published. Said only for a PUBLIC draft — for a private
          one "with the link" is false, and for an unlisted one "until you publish" is. Follows the form, so choosing
          "published" takes it away before the save. It DESCRIBES the status select (outside its <label>, joined by
          aria-describedby) rather than being read as part of its name. */}
      {(draftUnlisted || showSuggestion || showOpenStages) && (
        <div className="mt-2 space-y-2">
          {draftUnlisted && (
            <p
              id={DRAFT_UNLISTED_HINT_ID}
              data-testid="compset-draft-unlisted"
              className="text-xs leading-relaxed text-slate-500"
            >
              {msg("compset.draftUnlisted")}
            </p>
          )}
          {showSuggestion && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-purple-50 px-2.5 py-1.5 text-xs text-purple-800">
              {statusHint(msg, suggestedStatus!)}
              <button
                type="button"
                disabled={busy}
                onClick={() => void applyStatus(suggestedStatus!)}
                className="btn btn-primary min-h-11 px-2 py-0.5 text-xs sm:min-h-0"
              >
                {msg("compset.setTo", { status: statusLabel(msg, suggestedStatus!) })}
              </button>
            </div>
          )}
          {showOpenStages && (
            <OpenStagesWarning id={OPEN_STAGES_WARNING_ID} stages={openStages} canComplete={!readOnly} />
          )}
        </div>
      )}

      <div role="tablist" aria-label={msg("compset.tablistAria")} className="mb-4 mt-4 flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px min-h-11 border-b-2 px-3 py-2 text-sm font-medium transition ${
              activeTab === t.key
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "archived" ? (
        archivedPanel
      ) : activeTab === "general" ? (
        <SettingsSplitCard
          onSubmit={save}
          testId="compset-general"
          left={
            <>
              <label className="block">
                {/* Required, so marked: the asterisk is aria-hidden (the input's own `required` is what assistive
                    tech is told). */}
                <span className="label">
                  {msg("compset.name")}
                  <span aria-hidden="true"> *</span>
                </span>
                <input
                  required
                  maxLength={200}
                  disabled={readOnly}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="input min-h-11"
                />
              </label>

              {/* Side by side from 360px; at 320 they stack, because two native date inputs at ~124px each clip their
                  own text. #376: Ends is still editable but no longer clearable — save() refuses an empty value with
                  the copy the wizard uses (DateTimeField announces `aria-required`, never the native tooltip). */}
              <div className="grid gap-5 min-[360px]:grid-cols-2 [&_input]:min-h-11">
                <DateTimeField
                  kind="date"
                  label={msg("compset.starts")}
                  disabled={readOnly}
                  value={form.starts_on}
                  onChange={(v) => setForm({ ...form, starts_on: v })}
                />
                <DateTimeField
                  kind="date"
                  label={msg("compset.ends")}
                  required
                  requiredMark
                  min={form.starts_on || undefined}
                  disabled={readOnly}
                  value={form.ends_on}
                  onChange={(v) => setForm({ ...form, ends_on: v })}
                />
              </div>

              <div className="space-y-5 border-y border-purple-100 py-5 lg:border-b-0 lg:pb-0">
                <div className="space-y-2.5">
                  <div className="flex items-start gap-1.5">
                    <div className="min-w-0 flex-1">
                      <VisibilitySegmented
                        value={form.visibility}
                        onChange={(next) => void pickVisibility(next)}
                        capped={false}
                        disabled={readOnly}
                      />
                    </div>
                    <Tip id="division.visibility" className="mt-0.5" />
                  </div>
                  <VisibilityShareLink value={form.visibility} sharePath={sharePath} />
                </div>
                <CompetitionReach
                  visibility={form.visibility}
                  discoverable={form.visibility === "public" && form.discoverable}
                  status={form.status}
                />
                <div className="border-t border-dashed border-purple-200 pt-4">
                  <ShowcaseOptIn
                    visibility={form.visibility}
                    checked={form.visibility === "public" && form.discoverable}
                    onChange={(on) => setForm({ ...form, discoverable: on })}
                    capped={false}
                    disabled={readOnly}
                  />
                </div>
              </div>
            </>
          }
          right={
            <>
              <span className="label">{msg("compset.description")}</span>
              {readOnly ? (
                <textarea disabled rows={6} value={form.description} aria-label={msg("compset.description")} className="textarea lg:flex-1" />
              ) : (
                // v3/06 §2: Markdown editor with Write/Preview — Preview is the public renderer with this
                // competition's branding. From `lg` (`fill`) it takes the left column's height.
                <ProseEditor
                  value={form.description}
                  onChange={(md) => setForm({ ...form, description: md })}
                  orgId={orgId}
                  placeholder={msg("compset.descriptionPlaceholder")}
                  showPlaceholder
                  touch
                  fill
                  label={msg("compset.description")}
                  previewStyle={publicThemeStyleChain(competition.branding, orgBranding)}
                />
              )}
            </>
          }
          notices={paywallFeature || error ? notices : undefined}
          footer={footer}
        />
      ) : (
        <SettingsSplitCard
          onSubmit={save}
          testId="compset-branding"
          left={
            <>
              <div>
                <span className="label">{msg("compset.brandColor")}</span>
                {themeBranding ? (
                  <>
                    <p className="mb-2 text-xs text-slate-500">{msg("compset.brandColorDesc")}</p>
                    <BrandColorPicker
                      value={form.brand_primary}
                      onSelect={(hex) => setForm({ ...form, brand_primary: hex })}
                      disabled={readOnly}
                      defaultLabel={msg("compset.sameAsOrg")}
                      defaultHex={publicBrandColor(orgBranding) ?? DEFAULT_BRAND}
                    />
                  </>
                ) : (
                  // `dashboard.theme` (V397), the key the server strips the colour by — never `dashboard.branding`,
                  // which is the badge removal and enterprise-only.
                  <p data-feature="dashboard.theme" className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                    <PlanBadge feature="dashboard.theme" />
                    <span>
                      {msg("settings.upgrade.brandColor")}{" "}
                      {billingHref ? (
                        <Link href={billingHref} className="text-purple-600 underline">
                          {msg("settings.upgrade.link")}
                        </Link>
                      ) : (
                        msg("settings.upgrade.link")
                      )}
                    </span>
                  </p>
                )}
              </div>
              <label className="block">
                <span className="label">
                  {msg("compset.tagline")}{" "}
                  {!discoveryBranding && <span className="text-purple-700">{msg("compset.pro")}</span>}
                </span>
                <input
                  disabled={readOnly || !discoveryBranding}
                  value={form.tagline}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, tagline: e.target.value })}
                  placeholder={discoveryBranding ? msg("compset.taglinePlaceholder") : msg("compset.taglinePlaceholderPro")}
                  aria-describedby="compset-tagline-hint"
                  className="input min-h-11"
                />
                <span id="compset-tagline-hint" className="mt-1 block text-xs text-slate-500">
                  {msg("compset.taglineHint")}
                </span>
              </label>
              <label className="block">
                <span className="label">
                  {msg("compset.heroUrl")}{" "}
                  {!discoveryBranding && <span className="text-purple-700">{msg("compset.pro")}</span>}
                </span>
                <input
                  type="url"
                  inputMode="url"
                  disabled={readOnly || !discoveryBranding}
                  value={form.hero_image_path}
                  onChange={(e) => setForm({ ...form, hero_image_path: e.target.value })}
                  placeholder="https://"
                  className="input min-h-11"
                />
              </label>
            </>
          }
          right={
            // What the three choices on the left produce, seen rather than imagined: the card with the colour, the
            // tagline and the hero applied. Only what this org's plan really shows is drawn.
            <>
              <span className="label">{msg("compset.preview")}</span>
              <div
                data-testid="compset-brand-preview"
                className="overflow-hidden rounded-xl border border-purple-100 bg-white lg:flex-1"
              >
                {heroUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an organiser's own URL, any host
                  <img src={heroUrl} alt="" className="h-32 w-full object-cover sm:h-40" />
                ) : (
                  <div
                    className="h-32 sm:h-40"
                    style={{ background: `linear-gradient(135deg, ${brandHex}, color-mix(in srgb, ${brandHex} 55%, #0f172a))` }}
                  />
                )}
                <div className="space-y-1 p-4">
                  <p className="break-words text-base font-semibold text-slate-900">{form.name || competition.name}</p>
                  {tagline && (
                    <p className="break-words text-sm font-semibold" style={{ color: brandHex }}>
                      {tagline}
                    </p>
                  )}
                  {dates && <p className="text-sm text-slate-600">{dates}</p>}
                </div>
              </div>
            </>
          }
          notices={paywallFeature || error ? notices : undefined}
          footer={footer}
        />
      )}
    </div>
  );
}
