"use client";

// The Organisation tab's one card (settings C8, owner 2026-11-11, mock set11c01 O1): who the organisation is on the
// left — name, public page, logo, brand colour, defaults — and its About on the right. It replaces four sub-sections
// that each saved on their own (rename, brand colour, About) with one Save, which sends one PATCH carrying only what
// changed (`/api/orgs/{id}`'s `{name?, about?, branding?}` arm).
//
// Two things keep their own controls, and say so by where they sit: the logo uploads the moment a file is picked (an
// upload is not a field), and the defaults (timezone, public language, entry-fee currency) each keep their own Save —
// they write different columns behind different rules (the currency is locked by a connected Stripe account), and
// folding them in would put a refusal for one into the save of all.
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { routes } from "@/lib/routes";
import { publicBrandColor, publicThemeStyleChain } from "@/lib/public-theme";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { ProseEditor } from "@/components/prose-editor";
import { Tip } from "@/components/ui/tip";
import { SaveBar, SettingsSplitCard } from "@/components/v2/shared/settings-split-card";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { useOrigin } from "@/lib/use-client-snapshot";
import type { MessageKey } from "@/lib/messages";

/** The brand colour is a paid control (`dashboard.theme`, V397); the page decides, and words the refusal. */
export type OrgBrandGate = { locked: false } | { locked: true; notice: ReactNode };

interface ProfileState {
  name: string;
  /** null = the default violet (no colour stored). */
  brand: string | null;
  about: string;
}

const FIELD_LABEL: [keyof ProfileState, MessageKey][] = [
  ["name", "settings.org.nameLabel"],
  ["brand", "settings.org.brandColor"],
  ["about", "settings.org.about"],
];

const SAVE_MESSAGE_ID = "org-profile-save-message";

/**
 * The PATCH body for what changed between `baseline` and `form`, or null when nothing did. Only dirty keys ride, so a
 * save of the About alone never re-sends a name (a rename regenerates the slug) or a colour the plan no longer
 * includes. Exported so the request a click sends is pinned without a DOM.
 */
export function profilePatch(
  form: ProfileState,
  baseline: ProfileState,
  brandLocked: boolean,
): { name?: string; about?: string | null; branding?: { colors: { primary: string | null } } } | null {
  const body: { name?: string; about?: string | null; branding?: { colors: { primary: string | null } } } = {};
  if (form.name.trim() !== baseline.name.trim()) body.name = form.name.trim();
  if (!brandLocked && form.brand !== baseline.brand) body.branding = { colors: { primary: form.brand } };
  if (form.about !== baseline.about) body.about = form.about.trim() || null;
  return Object.keys(body).length > 0 ? body : null;
}

export function OrgProfileCard({
  orgId,
  orgSlug,
  initialName,
  initialBranding,
  initialAbout,
  canEdit,
  brandGate,
  logo,
  defaults,
}: {
  orgId: string;
  orgSlug: string;
  initialName: string;
  initialBranding: unknown;
  initialAbout: string | null;
  /** Owner or admin. A viewer sees the name and the public page, read-only, and no Save. */
  canEdit: boolean;
  brandGate: OrgBrandGate;
  /** The logo control (uploads on pick), or the line saying it is switched off. Editors only. */
  logo?: ReactNode;
  /** The organisation defaults, each with its own Save. Editors only. */
  defaults?: ReactNode;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  const origin = useOrigin();
  const [baseline, setBaseline] = useState<ProfileState>(() => ({
    name: initialName,
    brand: publicBrandColor(initialBranding),
    about: initialAbout ?? "",
  }));
  const [form, setFormState] = useState<ProfileState>(baseline);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setForm(next: ProfileState) {
    setFormState(next);
    setSaved(false);
  }

  const publicHref = routes.publicHub(orgSlug);
  const dirty = FIELD_LABEL.filter(([key]) =>
    key === "brand" ? !brandGate.locked && form.brand !== baseline.brand : form[key] !== baseline[key],
  );
  const saveMessage =
    dirty.length > 0
      ? msg("settings.saveBar.unsaved", {
          fields: new Intl.ListFormat(intlLocaleFor(locale), { style: "short", type: "unit" }).format(
            dirty.map(([, label]) => msg(label)),
          ),
        })
      : saved
        ? msg("settings.org.saved")
        : "";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = profilePatch(form, baseline, brandGate.locked);
    if (!body) return;
    setBusy(true);
    try {
      const org = await api<{ slug: string }>(`/api/orgs/${orgId}`, { method: "PATCH", json: body });
      setBaseline({ ...form, name: form.name.trim() });
      setFormState((f) => ({ ...f, name: f.name.trim() }));
      setSaved(true);
      // A rename regenerates the slug (PROMPT-30): move to the new URL; the old one 301s for anyone else holding it.
      if (body.name !== undefined && org.slug && org.slug !== orgSlug) router.replace(routes.orgSettings(org.slug));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const viewLink = (
    <a
      href={publicHref}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={msg("settings.org.viewPageAria")}
      data-testid="org-view-page"
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-purple-700 underline underline-offset-2 hover:text-purple-900 lg:min-h-0"
    >
      {msg("settings.org.viewPage")}
      <ExternalLink aria-hidden className="h-3.5 w-3.5" strokeWidth={2} />
    </a>
  );

  return (
    <SettingsSplitCard
      onSubmit={save}
      testId="org-profile-card"
      size="rail"
      left={
        <>
          {/* `data-tour="org-rename"`: the product tour's step lands here (components/product-tour.tsx). */}
          <div data-tour="org-rename">
            <label className="block">
              <span className="label">
                {msg("settings.org.nameLabel")}
                {canEdit && <span aria-hidden="true"> *</span>}
              </span>
              <input
                required
                maxLength={200}
                disabled={!canEdit}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input min-h-11"
                data-testid="org-name-input"
              />
            </label>
          </div>

          <div>
            <span className="label">{msg("settings.org.publicPage")}</span>
            <p className="truncate rounded-lg bg-purple-50/70 px-3 py-2 font-mono text-xs text-slate-700" data-testid="org-public-url">
              {origin}
              {publicHref}
            </p>
            {viewLink}
          </div>

          {canEdit && (
            <div className="space-y-5 border-t border-purple-100 pt-5">
              {logo && (
                <div>
                  <span className="label">{msg("settings.org.logo")}</span>
                  {logo}
                </div>
              )}
              <div>
                {/* D23: the logo above is free, the colour is Pro — the chip explains the split. */}
                <span className="label flex items-center gap-1">
                  {msg("settings.org.brandColor")}
                  <Tip id="settings.brand-colour" small />
                </span>
                {brandGate.locked ? (
                  brandGate.notice
                ) : (
                  <div data-testid="org-brand-color-picker">
                    <p className="mb-2 text-xs text-slate-500">{msg("settings.org.brand.desc")}</p>
                    <BrandColorPicker value={form.brand} onSelect={(hex) => setForm({ ...form, brand: hex })} disabled={busy} />
                  </div>
                )}
              </div>
            </div>
          )}

          {canEdit && defaults && (
            <div className="space-y-5 border-t border-purple-100 pt-5" data-testid="org-defaults">
              <p className="text-sm font-semibold text-slate-800">{msg("settings.prefs.org")}</p>
              {defaults}
            </div>
          )}
        </>
      }
      right={
        <>
          <span className="label">{msg("settings.org.about")}</span>
          <p className="mb-2 text-xs text-slate-500">{msg("settings.org.about.desc")}</p>
          {canEdit ? (
            <ProseEditor
              value={form.about}
              onChange={(md) => setForm({ ...form, about: md })}
              orgId={orgId}
              placeholder={msg("settings.org.about.placeholder")}
              showPlaceholder
              touch
              fill
              label={msg("settings.org.about")}
              // Not plan-masked, as before C8 (OrgAbout took the raw branding): locked, `form.brand` is the saved colour.
              previewStyle={publicThemeStyleChain({ colors: { primary: form.brand } })}
            />
          ) : (
            <textarea disabled rows={6} value={form.about} aria-label={msg("settings.org.about")} className="textarea lg:flex-1" />
          )}
        </>
      }
      notices={error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : undefined}
      footer={
        canEdit ? (
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
            saveLabel={msg("settings.org.saveChanges")}
            savingLabel={msg("settings.saving")}
          />
        ) : undefined
      }
    />
  );
}
