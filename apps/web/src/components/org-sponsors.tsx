"use client";

// Sponsors tab manager (v10 PROMPT-56, replaces the blob editor). Rows are
// first-class `sponsors` table entries grouped by tier. One form captures
// everything — logo included, uploaded on submit — for both add and edit.
// Tiers above partner and per-competition scoping are Pro (`sponsors.tiers`);
// without it the manager is the free un-tiered strip with an upsell note.
import { useId, useRef, useState } from "react";
import Link from "@/components/ui/console-link";
import {
  ArrowDown, ArrowUp, Eye, ImagePlus, MousePointerClick, Pencil, Trash2,
} from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import { sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import type { SponsorDeal } from "@/lib/sponsor-deals";
import type { ReportLinkSummary } from "@/lib/sponsor-report";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The tier list's one authority is lib/sponsor-tiers.ts; re-exported for the console's own importers. */
export { SPONSOR_TIERS, type SponsorTier };

/** Client-safe mirror of the usecase SponsorRow. */
export interface SponsorItem {
  id: string;
  competition_id: string | null;
  name: string;
  url: string | null;
  logo_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: string;
  dispute_parked?: boolean;
  dispute_lost?: boolean;
  click_count: number;
  /** The paid package order that activated this placement, if any. */
  paid_order_id?: string | null;
  /** The deal the row shows (sponsor deals D8), or null when the sponsor has none. */
  deal: { id: string; payment_status: string } | null;
  /** A live deal owns this sponsor's tier, competition, stream and status (D9): the form offers none of them. */
  locked_by_deal: boolean;
  /** A deal waits to go live (draft, awaiting payment or approval, scheduled): it holds the sponsor's status (D9). */
  has_open_deal: boolean;
}

/** What the hub page reads for the Sponsors tab beyond the list (sponsor deals PR 2, Task 13). The sponsor list rows (Task 14),
 *  the sponsor's own page (Task 15), the Add deal sheet (Task 16) and the deal page (Task 17) are its consumers; nothing here
 *  reads it yet. */
export interface SponsorsHubData {
  orgSlug: string;
  /** Every deal of the org, newest first (legacy pre-deals rows included: they are ended deals). */
  deals: SponsorDeal[];
  /** Every package of the org, active first. */
  packages: SponsorPackageRow[];
  /** `sponsors.monetize` on any competition's pass: online invoices are sold on this plan. */
  hasMonetize: boolean;
  /** The org's Stripe account takes charges. */
  chargesEnabled: boolean;
  /** `?sponsor=` after the page checked it is one of this org's sponsors; null shows the list. */
  sponsorId: string | null;
  /** `?deal=` after the page checked it is one of the selected sponsor's deals; null shows the sponsor's page. */
  dealId: string | null;
  /** The selected sponsor's live report links (an editor's page only; empty otherwise). */
  reportLinks: ReportLinkSummary[];
}

interface Draft {
  name: string;
  url: string;
  tier: SponsorTier;
  competition_id: string;
  /** Picked in the form, uploaded on submit. */
  file: File | null;
  /** Object URL preview for the picked file, else the stored logo. */
  preview: string | null;
}
const EMPTY_DRAFT: Draft = {
  name: "", url: "", tier: "partner", competition_id: "", file: null, preview: null,
};

/** Can the club switch this sponsor back on by hand (spec §10.3: "After all of a sponsor's deals have ended: the club may
 *  switch the sponsor back on by hand, as for a sponsor with no deal")? Exactly where the server takes `PATCH { status:
 *  "active" }` (server/usecases/sponsors.ts `patchSponsor`): the sponsor is off (`inactive`; a dispute-parked one is `pending`
 *  and refused), and no live deal (409 sponsor_locked_by_deal) or deal waiting to go live (409 sponsor_has_open_deal) holds
 *  its status. */
export function canShowAgain(s: SponsorItem): boolean {
  return s.status === "inactive" && !s.locked_by_deal && !s.has_open_deal;
}

/** Is a delete certain to be refused? Money history (paid or refunded) on any of a sponsor's deals is a 409
 *  `sponsor_has_deal_history` (server/usecases/sponsors.ts `dealHoldsHistory`). What the row can see of it is its paid order
 *  and the deal it shows; a pre-deals order or a history on an older deal is only known to the server, whose refusal is shown
 *  the same way. So this only decides whether to ASK first - it refuses nothing. */
function deleteIsRefusedForHistory(s: SponsorItem): boolean {
  return Boolean(s.paid_order_id) || s.deal?.payment_status === "paid" || s.deal?.payment_status === "refunded";
}

/** People type bare domains — give the link a scheme before validation. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Basic link check (field is optional): http(s), a dotted hostname, no spaces. */
function isValidSponsorUrl(raw: string): boolean {
  const normalized = normalizeUrl(raw);
  if (!normalized) return true;
  if (/\s/.test(raw.trim())) return false;
  try {
    const u = new URL(normalized);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** The one sponsor form — add and edit share it; logo travels with it.
 *  Hoisted out of OrgSponsors: a nested component definition would remount
 *  (and drop focus) on every parent render. */
export function SponsorForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  hasTiers,
  lockedByDeal,
  competitions,
  onPickLogo,
}: {
  value: Draft;
  onChange: (fn: (prev: Draft) => Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
  hasTiers: boolean;
  /** A live deal sets the tier and the competition (D9): both selects are disabled and the form says why. Name, link and logo
   *  stay editable. Always false on the add form. */
  lockedByDeal: boolean;
  competitions: { id: string; name: string }[];
  onPickLogo: (file: File, set: (fn: (prev: Draft) => Draft) => void) => void;
}) {
  const msg = useMsg();
  // House uploader pattern (org-logo, prose-editor): a real button clicks a
  // ref'd hidden input — label-wrapped file inputs misfire in some browsers.
  const fileRef = useRef<HTMLInputElement>(null);
  // The deal-lock note's id: the disabled selects point at it so the reason is announced with them, not only shown.
  const lockNoteId = useId();
  const urlInvalid = value.url.trim() !== "" && !isValidSponsorUrl(value.url);
  return (
      <div className="flex flex-wrap items-start gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group grid h-20 w-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white text-slate-400 hover:border-purple-400 hover:text-purple-600"
          aria-label={msg("sponsors.logoLabel")}
        >
          {value.preview ? (
            // Preview is an object URL for a picked file or the stored CDN URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.preview} alt="" className="h-full w-full object-contain p-1.5" />
          ) : (
            <span className="grid place-items-center gap-1 text-center">
              <ImagePlus className="mx-auto h-5 w-5" strokeWidth={1.75} />
              <span className="px-1 text-[10px] leading-tight">{msg("sponsors.logoLabel")}</span>
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickLogo(f, onChange);
            e.target.value = "";
          }}
        />
        <div className="min-w-0 flex-1">
          {/* 2-col rows: name+link, then tier+competition; single stack on mobile. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">{msg("settings.org.sponsors.name")}</span>
              <input
                value={value.name}
                onChange={(e) => onChange((prev) => ({ ...prev, name: e.target.value }))}
                maxLength={80}
                className="input w-full"
              />
            </label>
            <label className="block">
              <span className="label">{msg("settings.org.sponsors.link")}</span>
              <input
                value={value.url}
                onChange={(e) => onChange((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://…"
                aria-invalid={urlInvalid || undefined}
                className={`input w-full ${urlInvalid ? "border-red-400" : ""}`}
              />
              {urlInvalid ? (
                <span className="mt-1 block text-xs text-red-500">
                  {msg("sponsors.urlInvalid")}
                </span>
              ) : null}
            </label>
            {hasTiers ? (
              <label className="block">
                <span className="label">{msg("sponsors.tierLabel")}</span>
                <select
                  value={value.tier}
                  disabled={busy || lockedByDeal}
                  aria-describedby={lockedByDeal ? lockNoteId : undefined}
                  onChange={(e) =>
                    onChange((prev) => ({ ...prev, tier: e.target.value as SponsorTier }))
                  }
                  className="input w-full"
                >
                  {SPONSOR_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {msg(TIER_MSG[t])}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {hasTiers ? (
              <label className="block">
                <span className="label">{msg("sponsors.scopeLabel")}</span>
                <select
                  value={value.competition_id}
                  disabled={busy || lockedByDeal}
                  aria-describedby={lockedByDeal ? lockNoteId : undefined}
                  onChange={(e) =>
                    onChange((prev) => ({ ...prev, competition_id: e.target.value }))
                  }
                  className="input w-full"
                >
                  <option value="">{msg("sponsors.scopeAll")}</option>
                  {competitions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {hasTiers && lockedByDeal ? (
              <p id={lockNoteId} className="text-xs text-slate-500 sm:col-span-2" data-testid="sponsor-locked-note">
                {msg("sponsors.deal.lockedNote")}
              </p>
            ) : null}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !value.name.trim() || urlInvalid}
              onClick={onSubmit}
              className="btn btn-primary"
            >
              {busy ? "…" : submitLabel}
            </button>
            {onCancel ? (
              <button type="button" disabled={busy} onClick={onCancel} className="btn">
                {msg("confirm.cancel")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
}

export function OrgSponsors({
  orgId,
  initialSponsors,
  competitions,
  hasTiers,
  billingHref,
  canEdit,
}: {
  orgId: string;
  initialSponsors: SponsorItem[];
  /** `ends_on`: the competition's end date (YYYY-MM-DD) or null; the deal timeline shows it beside "ends with the competition". */
  competitions: { id: string; name: string; ends_on?: string | null }[];
  hasTiers: boolean;
  billingHref: string;
  canEdit: boolean;
  hub: SponsorsHubData;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [sponsors, setSponsors] = useState<SponsorItem[]>(initialSponsors);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function api(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`/api/v1/orgs/${orgId}/sponsors${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      // v1 errors are plain strings OR structured { code, message, issues }.
      error?: string | { code?: string; message?: string };
    };
    if (!res.ok) {
      // Carry the envelope's CODE, not just its sentence: the sentence is server English, the code is what `run` maps to the
      // dictionary (`sponsorSaveErrorKey`).
      const e = typeof data.error === "string" ? { message: data.error } : (data.error ?? {});
      throw new ApiV1Error(e.message ?? msg("settings.saveFailed"), res.status, e.code ?? "UNKNOWN");
    }
    // /api/v1 envelope: { ok, data } — callers want the payload.
    return data.data ?? data;
  }


  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      // A server refusal reads the dictionary's words for its code; an error this component raised itself (a logo that is too
      // big, a failed upload) already carries its own translated sentence.
      setError(
        err instanceof ApiV1Error
          ? msg(sponsorSaveErrorKey(err))
          : err instanceof Error
            ? err.message
            : msg("settings.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const rows = (await api("", { method: "GET" })) as SponsorItem[];
    setSponsors(rows);
  }

  /** Upload a picked logo to storage; returns its public URL. */
  async function uploadLogo(file: File): Promise<string> {
    const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: file.type }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      // handler() envelope: { ok, data } — same unwrap as api().
      data?: { upload_url?: string; public_url?: string };
    };
    // The envelope's `error` is the server's English sentence (or a structured object): never shown, whatever the status.
    if (!res.ok) throw new Error(msg("settings.org.sponsors.uploadNotAllowed"));
    const grant = json.data;
    if (!grant?.upload_url || !grant.public_url) {
      throw new Error(msg("settings.org.sponsors.uploadNotAllowed"));
    }
    const put = await fetch(grant.upload_url, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!put.ok) throw new Error(msg("settings.org.logo.uploadFailed"));
    return grant.public_url;
  }

  function pickLogo(file: File, set: (d: (prev: Draft) => Draft) => void) {
    if (file.size > MAX_LOGO_BYTES) {
      setError(msg("settings.org.sponsors.tooBig"));
      return;
    }
    setError(null);
    const preview = URL.createObjectURL(file);
    set((prev) => ({ ...prev, file, preview }));
  }

  function create() {
    void run(async () => {
      const logo_path = draft.file ? await uploadLogo(draft.file) : null;
      const url = normalizeUrl(draft.url);
      await api("", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(url ? { url } : {}),
          ...(logo_path ? { logo_path } : {}),
          tier: hasTiers ? draft.tier : "partner",
          ...(hasTiers && draft.competition_id ? { competition_id: draft.competition_id } : {}),
        }),
      });
      setDraft(EMPTY_DRAFT);
      await refresh();
    });
  }

  function startEdit(s: SponsorItem) {
    setEditingId(s.id);
    setEdit({
      name: s.name,
      url: s.url ?? "",
      tier: s.tier,
      competition_id: s.competition_id ?? "",
      file: null,
      preview: s.logo_path,
    });
  }

  function saveEdit(s: SponsorItem) {
    void run(async () => {
      // Send only what changed — promoting tier / scoping is the Pro line, and
      // a no-op field must not trip the gate on a downgraded org's legacy row.
      const patch: Record<string, unknown> = {};
      if (edit.name.trim() && edit.name.trim() !== s.name) patch.name = edit.name.trim();
      const url = normalizeUrl(edit.url) || null;
      if (url !== s.url) patch.url = url;
      if (edit.tier !== s.tier) patch.tier = edit.tier;
      if ((edit.competition_id || null) !== s.competition_id) {
        patch.competition_id = edit.competition_id || null;
      }
      if (edit.file) patch.logo_path = await uploadLogo(edit.file);
      if (Object.keys(patch).length > 0) {
        await api(`/${s.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        await refresh();
      }
      setEditingId(null);
    });
  }

  function remove(s: SponsorItem) {
    void (async () => {
      // The server's rule (sponsors.ts `deleteSponsor`, sponsor deals F3): a sponsor's deals go WITH it, unless one holds payment
      // history (paid or refunded, or a pre-deals order) or an open payment link nobody could close - then the delete is a 409 and
      // the sponsor stays. So a sponsor with deals asks first, in words that match; one already known to hold payment history
      // is not asked to confirm a delete that cannot happen (its 409 reads `sponsors.error.hasDealHistory`). The server stays
      // the rule's one owner: this only skips a question, it refuses nothing.
      if (s.deal && !deleteIsRefusedForHistory(s)) {
        const ok = await confirm({
          title: msg("sponsors.deleteDeal.title"),
          body: msg("sponsors.deleteDeal.body", { name: s.name }),
          confirmLabel: msg("sponsors.deleteDeal.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(async () => {
        await api(`/${s.id}`, { method: "DELETE" });
        setSponsors((prev) => prev.filter((row) => row.id !== s.id));
      });
    })();
  }

  /** Show on site again (spec §10.3): the sponsor's own status PATCH, and nothing else in it. The list is re-read whatever the
   *  answer - a refusal means a deal arrived since the page loaded, and the re-read row then offers the control no more. */
  function showAgain(s: SponsorItem) {
    void run(async () => {
      try {
        await api(`/${s.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
      } finally {
        await refresh().catch(() => {});
      }
    });
  }

  /** Swap within the rendered group, persist the global order. */
  function move(id: string, delta: -1 | 1) {
    const row = sponsors.find((s) => s.id === id);
    if (!row) return;
    const group = hasTiers ? sponsors.filter((s) => s.tier === row.tier) : sponsors;
    const gi = group.findIndex((s) => s.id === id);
    const target = gi + delta;
    if (gi < 0 || target < 0 || target >= group.length) return;
    const next = [...sponsors];
    const a = next.indexOf(group[gi]!);
    const b = next.indexOf(group[target]!);
    [next[a], next[b]] = [next[b]!, next[a]!];
    setSponsors(next);
    void run(async () => {
      await api("/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((s) => s.id) }) });
    });
  }

  const compName = (id: string | null) =>
    id ? (competitions.find((c) => c.id === id)?.name ?? "…") : null;

  // Render in tier order; free plans see one flat partner group.
  const grouped: [SponsorTier, SponsorItem[]][] = (hasTiers ? SPONSOR_TIERS : (["partner"] as const))
    .map((tier): [SponsorTier, SponsorItem[]] => [
      tier,
      hasTiers ? sponsors.filter((s) => s.tier === tier) : sponsors,
    ])
    .filter(([, rows]) => rows.length > 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{msg("sponsors.line")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {canEdit ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <p className="text-sm font-semibold text-slate-800">{msg("sponsors.form.title")}</p>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">{msg("sponsors.form.hint")}</p>
          <SponsorForm
            value={draft}
            onChange={(fn) => setDraft(fn)}
            onSubmit={create}
            submitLabel={msg("settings.org.sponsors.add")}
            busy={busy}
            hasTiers={hasTiers}
            lockedByDeal={false}
            competitions={competitions}
            onPickLogo={pickLogo}
          />
          {!hasTiers ? (
            <p className="mt-3 text-xs text-slate-400">
              {msg("sponsors.tiersUpsell")}{" "}
              <Link href={billingHref} className="text-purple-600 underline">
                {msg("settings.upgrade.link")}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {sponsors.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
          {msg("sponsors.empty")}
        </p>
      ) : null}

      {grouped.map(([tier, rows]) => (
        <div key={tier}>
          {hasTiers ? (
            <p className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {msg(TIER_MSG[tier])}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${TIER_BADGE[tier]}`}>
                {rows.length}
              </span>
            </p>
          ) : null}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.map((s, i) => (
              <li key={s.id} className="px-3 py-2.5">
                {editingId === s.id ? (
                  <SponsorForm
                    value={edit}
                    onChange={(fn) => setEdit(fn)}
                    onSubmit={() => saveEdit(s)}
                    onCancel={() => setEditingId(null)}
                    submitLabel={msg("sponsors.save")}
                    busy={busy}
                    hasTiers={hasTiers}
                    lockedByDeal={s.locked_by_deal}
                    competitions={competitions}
                    onPickLogo={pickLogo}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    {s.logo_path ? (
                      // Stored via content-upload — an absolute CDN URL.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.logo_path}
                        alt=""
                        className="h-9 w-9 rounded object-contain ring-1 ring-slate-200"
                      />
                    ) : (
                      <span className="grid h-9 w-9 place-items-center rounded bg-slate-100 text-xs font-semibold text-slate-400">
                        {s.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {s.name}
                        {s.dispute_lost ? (
                          // The activating order was written off by a lost
                          // dispute — the placement stays down; say why.
                          <span className="ml-2 rounded-full bg-rose-200 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-900">
                            {msg("sponsors.lostBadge")}
                          </span>
                        ) : s.dispute_parked ? (
                          // Parked by an open payment dispute — the handler
                          // took it down; it returns if the dispute is won.
                          <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-rose-700">
                            {msg("sponsors.parkedBadge")}
                          </span>
                        ) : s.paid_order_id ? (
                          // Bought through a package — ties the sponsor list
                          // back to the Sell section's orders.
                          <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                            {msg("sponsors.paidBadge")}
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {compName(s.competition_id) ?? msg("sponsors.scopeAll")}
                        {s.url ? ` · ${s.url}` : ""}
                      </p>
                    </div>
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-400"
                      title={msg("sponsors.clicks", { count: s.click_count })}
                      aria-label={msg("sponsors.clicks", { count: s.click_count })}
                    >
                      <MousePointerClick className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {s.click_count}
                    </span>
                    {canEdit && canShowAgain(s) ? (
                      // Off the public pages with nothing holding it there: its last deal ended (or it never had one).
                      <button
                        type="button"
                        data-testid={`sponsor-show-${s.id}`}
                        aria-label={msg("sponsors.showAgainLabel", { name: s.name })}
                        disabled={busy}
                        onClick={() => showAgain(s)}
                        className="btn flex shrink-0 items-center gap-1.5 text-xs"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        {msg("sponsors.showAgain")}
                      </button>
                    ) : null}
                    {canEdit ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={msg("sponsors.edit", { name: s.name })}
                          disabled={busy}
                          onClick={() => startEdit(s)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.moveUp", { name: s.name })}
                          disabled={busy || i === 0}
                          onClick={() => move(s.id, -1)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.moveDown", { name: s.name })}
                          disabled={busy || i === rows.length - 1}
                          onClick={() => move(s.id, 1)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.remove", { name: s.name })}
                          disabled={busy}
                          onClick={() => remove(s)}
                          className="grid h-7 w-7 place-items-center rounded text-red-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
