"use client";

// Sponsors tab manager (v10 PROMPT-56, replaces the blob editor). Rows are
// first-class `sponsors` table entries; the list (components/sponsors/sponsor-list.tsx)
// groups them by their deal's tier and gives each its deal's chip and one next
// action (sponsor deals PR 2, Task 14). This island owns the state and every
// write; the list is stateless. "Add a sponsor" asks for a name, a logo and a
// link only - the tier and where a sponsor shows come from its deal - while the
// EDIT form still places a sponsor with no deal by hand. Tiers above partner and
// per-competition scoping are Pro (`sponsors.tiers`); without it the manager is
// the free un-tiered strip with an upsell note.
import { useId, useRef, useState } from "react";
import Link from "@/components/ui/console-link";
import { ImagePlus } from "lucide-react";
import { useViewerTz } from "@/components/client-time";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TIER_MSG } from "@/components/sponsors/tier-labels";
import { SponsorList, dealPrice, groupTierOf, sameOrderBand, type DealWrite } from "@/components/sponsors/sponsor-list";
import { AddDealSheet, type CreateDealBody } from "@/components/sponsors/add-deal-sheet";
import { SponsorSheet, SponsorSheetBody } from "@/components/sponsors/sponsor-sheet";
import { DealPageBody } from "@/components/sponsors/deal-page";
import { PayLinkBanner } from "@/components/sponsors/pay-link-banner";
import {
  endConfirmBodyKey, endKeepsPayment, markPaidRetiresPayLink, payLinkStillOpen, refundConfirmBodyKey, refundPlacementKey,
} from "@/components/sponsors/deal-copy";
import { createDealWrite, sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import type { SponsorWrite } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import type { DealAction, SponsorDeal } from "@/lib/sponsor-deals";
import type { ReportLinkDefaults, ReportLinkSummary } from "@/lib/sponsor-report";
import { sponsorHref, sponsorsHref } from "@/lib/sponsors-hub";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** The tier list's one authority is lib/sponsor-tiers.ts; re-exported for the console's own importers. */
export { SPONSOR_TIERS, type SponsorTier };
/** Where "Show on site again" is offered (`canShowAgain`) is declared beside the list; the sponsor's page draws the button (Task 15).
 *  Re-exported for its importers. */
export { canShowAgain } from "@/components/sponsors/sponsor-list";

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
  /** The sponsor is in the stream's rotation (the On stream tab's tick; the sponsor page's toggle). A live deal sets it (D9). */
  on_stream: boolean;
  /** The paid package order that activated this placement, if any. */
  paid_order_id?: string | null;
  /** The deal the row shows (sponsor deals D8: `pickRowDeal` over the sponsor's deals), or null when the sponsor has none - the
   *  WHOLE deal, as the list reads send it: the chip, the sub-line and the row's one action all read it. */
  deal: SponsorDeal | null;
  /** A live deal owns this sponsor's tier, competition, stream and status (D9): the form offers none of them. */
  locked_by_deal: boolean;
  /** A deal waits to go live (draft, awaiting payment or approval, scheduled): it holds the sponsor's status (D9). */
  has_open_deal: boolean;
  /** The billing email the Add deal sheet opens at (D22): the latest of this sponsor's deals that carries one. */
  last_billing_email: string | null;
}

/** What the hub page reads for the Sponsors tab beyond the list (sponsor deals PR 2, Task 13). Its readers: the sponsor list
 *  (Task 14, READS `orgSlug` only - a row carries its own deal, so `deals` would be a second authority for it), the sponsor's own
 *  page (Task 15: `sponsorId` picks it, `deals` fill its Deals, `reportLinks` and `reportDefaults` are its Report link), the Add deal
 *  sheet (Task 16: `packages` are its cards, `hasMonetize`, `monetizeOrgWide`, `monetizeCompetitionIds` and `chargesEnabled` decide
 *  whether Online is open FOR THE SCOPE picked, `finishedCompetitionIds` lock the packages that are no longer sold, `deals` feed its
 *  "already has one of these" confirm) and the deal page (Task 17: `dealId` picks it; `dealCreatedByName` and `dealCompetitionFinished`
 *  are the two reads its timeline needs from the server). */
export interface SponsorsHubData {
  orgSlug: string;
  /** Every deal of the org, newest first (legacy pre-deals rows included: they are ended deals). */
  deals: SponsorDeal[];
  /** Every package of the org, active first. */
  packages: SponsorPackageRow[];
  /** `sponsors.monetize` on any competition's pass: online invoices are sold on this plan (somewhere). */
  hasMonetize: boolean;
  /** ...and on the whole organisation (a paid plan). The server gates online selling PER SCOPE (deal-gates.ts): an Event Pass lifts
   *  its own competition and never the whole organisation, so the sheet cannot ask the any-pass flag alone. */
  monetizeOrgWide: boolean;
  /** The competitions an Event Pass lifts online selling on (empty when `monetizeOrgWide`: org-wide covers every competition). */
  monetizeCompetitionIds: string[];
  /** The org's Stripe account takes charges. */
  chargesEnabled: boolean;
  /** The competitions of the org's active packages that have finished: a package for one is not sold (409 competition_finished). */
  finishedCompetitionIds: string[];
  /** `?sponsor=` after the page checked it is one of this org's sponsors; null shows the list. */
  sponsorId: string | null;
  /** `?deal=` after the page checked it is one of the selected sponsor's deals; null shows the sponsor's page. */
  dealId: string | null;
  /** The selected deal's creator, by display name (a removed member or a deleted user reads null); null with no deal selected. */
  dealCreatedByName: string | null;
  /** The selected deal's competition has finished, by the desk's derived phase (never a date); false with no deal selected. */
  dealCompetitionFinished: boolean;
  /** The selected sponsor's live report links (an editor's page only; empty otherwise). */
  reportLinks: ReportLinkSummary[];
  /** The Report link's opening dates (this year), read for an editor's page only; null for a viewer, whose page has no such section. */
  reportDefaults: ReportLinkDefaults | null;
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

/** The route each deal write POSTs. Send and Resend invoice are one route: the server sends a draft's first invoice and re-sends an
 *  open one's the same way (ensureDealCheckout). */
const DEAL_ROUTE: Record<DealAction, string> = {
  send_invoice: "send-invoice",
  resend_invoice: "send-invoice",
  mark_paid: "mark-paid",
  approve: "approve",
  refund: "refund",
  end_now: "end",
};

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
  showPlacement,
  lockedByDeal,
  competitions,
  onPickLogo,
  compact = false,
}: {
  value: Draft;
  onChange: (fn: (prev: Draft) => Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
  hasTiers: boolean;
  /** Offer the tier and competition at all (only on a plan with tiers). Off on the ADD form: a new sponsor is a name, a logo and a
   *  link, and its tier and where it shows come from its first deal (spec §6.1). On when EDITING, where a sponsor with no deal is
   *  placed by hand. */
  showPlacement: boolean;
  /** A live deal sets the tier and the competition (D9): both selects are disabled and the form says why. Name, link and logo
   *  stay editable. Always false on the add form. */
  lockedByDeal: boolean;
  competitions: { id: string; name: string }[];
  onPickLogo: (file: File, set: (fn: (prev: Draft) => Draft) => void) => void;
  /** One column of fields under the logo, whatever the viewport: for the sponsor page's side panel, where `sm:` (a VIEWPORT query)
   *  would put two fields side by side in a 360px panel. The list's inline editor and the add box leave it off. */
  compact?: boolean;
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
        <div className={compact ? "w-full min-w-0" : "min-w-0 flex-1"}>
          {/* 2-col rows: name+link, then tier+competition; single stack on mobile (and always, when compact). */}
          <div className={`grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}>
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
            {showPlacement && hasTiers ? (
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
            {showPlacement && hasTiers ? (
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
            {showPlacement && hasTiers && lockedByDeal ? (
              <p id={lockNoteId} className={`text-xs text-slate-500 ${compact ? "" : "sm:col-span-2"}`} data-testid="sponsor-locked-note">
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
  hub,
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
  const locale = useLocaleOrDefault();
  const tz = useViewerTz();
  const [sponsors, setSponsors] = useState<SponsorItem[]>(initialSponsors);
  // The org's deals, for the sponsor page and the confirms that name what a deal's end does to the others. The server's list is the
  // truth: a new arrival from the page (a navigation, a `router.refresh()`) replaces what a write here last read - compared by
  // identity, in render, never an effect.
  const [deals, setDeals] = useState<SponsorDeal[]>(hub.deals);
  const [seenHubDeals, setSeenHubDeals] = useState(hub.deals);
  if (seenHubDeals !== hub.deals) {
    setSeenHubDeals(hub.deals);
    setDeals(hub.deals);
  }
  const [addDealFor, setAddDealFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY_DRAFT);
  /** The row whose ⋯ is open below md (one at a time). */
  const [moreOpenId, setMoreOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What a write that changes nothing on screen says it did (Resend invoice: the chip stays "Awaiting payment"). */
  const [notice, setNotice] = useState<string | null>(null);
  /** The pay link the last send, resend or online Add deal answered with, and the deal it pays: shown only while that deal can still
   *  be paid (`payLinkStillOpen`), so End now, Mark as paid or a payment takes it down with the deal. */
  const [payLink, setPayLink] = useState<{ deal: SponsorDeal; url: string } | null>(null);

  /** A call on the org's v1 API (`path` after `/orgs/{id}`); the envelope's payload back. */
  async function v1(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`/api/v1/orgs/${orgId}${path}`, {
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

  /** A call on the org's sponsors (`/sponsors{path}`). */
  const api = (path: string, init: RequestInit) => v1(`/sponsors${path}`, init);

  /** Run a write: busy while it runs, a refusal shown in the dictionary's words (`write` names the one whose refusal means
   *  something of its own, `SAVE_ERROR_BY_WRITE`). */
  async function run(fn: () => Promise<void>, write?: SponsorWrite) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      // A server refusal reads the dictionary's words for its code; an error this component raised itself (a logo that is too
      // big, a failed upload) already carries its own translated sentence.
      setError(
        err instanceof ApiV1Error
          ? msg(sponsorSaveErrorKey(err, write))
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

  /** Re-read the org's deals (`GET /sponsor-deals`, newest first). Only while a sponsor's page is open: the list reads each row's
   *  own deal and never `deals`, so a list-only session has nothing to keep fresh. */
  async function refreshDeals() {
    setDeals((await v1("/sponsor-deals", { method: "GET" })) as SponsorDeal[]);
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
      // A new sponsor is a name, a logo and a link: its tier and where it shows come from its first deal (spec §6.1), so it
      // starts a partner for the whole organisation - the server's own defaults, said out loud.
      await api("", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(url ? { url } : {}),
          ...(logo_path ? { logo_path } : {}),
          tier: "partner",
        }),
      });
      setDraft(EMPTY_DRAFT);
      await refresh();
    });
  }

  function startEdit(s: SponsorItem) {
    // The ⋯ tray belongs to the row's controls; the editor replaces them, and a tray left open would still be open on Cancel.
    setMoreOpenId(null);
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

  /** A deal's write (Tasks 6 and 7's routes). The list is re-read whatever the answer - the chip, the action and the group all
   *  follow the deal, and a refusal means it moved under the tap - and, while a sponsor's page is open (or a pay link is on show, which
   *  follows its deal), so are the deals. Sending or resending an invoice changes nothing a row shows, so it says it was sent, and
   *  keeps the pay link it answered with. Three writes ask first, each with words about its own consequence: Mark as paid (house
   *  precedent: the registrant hub's mark paid) is the club's attestation that money arrived outside the app, and it moves the deal on
   *  by its go-live rule - often live - with no undo (on an online deal whose invoice went out it also retires the pay link); End now
   *  ends the deal and, on a deal the sponsor has paid, says the money stays and Refund is the separate step (it never moves money);
   *  Refund (the deal page's) asks about the money - back to the card through Stripe, or recorded for the club to pay back by hand -
   *  then what the public pages do, then that it is final. Approve stays one tap (End now reverses a live deal); sending an invoice is
   *  harmless. `name` is the sponsor's current name. */
  function runDealAction(deal: SponsorDeal, name: string, action: DealAction) {
    void (async () => {
      if (action === "mark_paid") {
        const ok = await confirm({
          title: msg("sponsors.deal.markPaid.title", { amount: dealPrice(deal, locale), name }),
          body: [msg("sponsors.deal.markPaid.body"), ...(markPaidRetiresPayLink(deal) ? [msg("sponsors.deal.confirm.markPaid.payLink", { name })] : [])].join(" "),
          confirmLabel: msg("sponsors.deal.action.markPaid"),
          tone: "default",
        });
        if (!ok) return;
      }
      if (action === "end_now") {
        const ok = await confirm({
          title: msg("sponsors.deal.confirm.end.title"),
          body: [
            msg(endConfirmBodyKey(deals, deal), { name }),
            ...(endKeepsPayment(deal) ? [msg("sponsors.deal.confirm.end.paidKept", { amount: dealPrice(deal, locale), name })] : []),
          ].join(" "),
          confirmLabel: msg("sponsors.deal.confirm.end.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      if (action === "refund") {
        const amount = dealPrice(deal, locale);
        const ok = await confirm({
          title: msg("sponsors.deal.confirm.refund.title"),
          // What happens to the money, then to the public pages (by the deal's state), then that it is final.
          body: [
            msg(refundConfirmBodyKey(deal), { amount, name }),
            msg(refundPlacementKey(deals, deal), { name }),
            msg("sponsors.deal.confirm.refund.irreversible"),
          ].join(" "),
          confirmLabel: msg("sponsors.deal.confirm.refund.label", { amount }),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(
        async () => {
          try {
            const answer = (await v1(`/sponsor-deals/${deal.id}/${DEAL_ROUTE[action]}`, { method: "POST" })) as
              | { deal?: SponsorDeal; checkout_url?: string | null }
              | null;
            if (action === "resend_invoice" || action === "send_invoice") {
              // The answer carries the pay link beside the deal (F11); the deal itself carries no url.
              setPayLink(answer?.checkout_url ? { deal: answer.deal ?? deal, url: answer.checkout_url } : null);
              setNotice(msg(action === "resend_invoice" ? "sponsors.deal.notice.invoiceResent" : "sponsors.deal.notice.invoiceSent", { name }));
            }
          } finally {
            await refresh().catch(() => {});
            if (hub.sponsorId !== null || payLink !== null) await refreshDeals().catch(() => {});
          }
        },
        action === "resend_invoice" || action === "send_invoice" ? "resend_invoice" : undefined,
      );
    })();
  }

  /** The Add deal sheet's write: POST the deal, then re-read what it changed (the list and the deals, whatever the answer - a refusal
   *  can mean a deal moved meanwhile). A refusal is the SHEET's to show, with its choices kept. The exception is a Stripe refusal of an
   *  ONLINE create: it can mean a deal was saved without its invoice, so the sheet closes (a second tap would make a second deal) and
   *  the page says it, over the re-read list. A Stripe refusal of a create that sends no invoice (it ends the current deal, and
   *  Stripe failed closing that deal's pay link before anything was written) saved NOTHING: it stays the sheet's, choices kept.
   *  Resolving closes the sheet. */
  async function createDeal(s: SponsorItem, body: CreateDealBody): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const made = (await v1(`/sponsors/${s.id}/deals`, { method: "POST", body: JSON.stringify(body) })) as
        | { deal?: SponsorDeal; checkout_url?: string | null }
        | null;
      // F11: the pay link rides beside the deal in the create's answer. An online create that did not make one (a Stripe refusal) is
      // handled below; a create that sends no invoice has none.
      setPayLink(made?.deal && made.checkout_url ? { deal: made.deal, url: made.checkout_url } : null);
      setNotice(msg(body.payment_method === "online" ? "sponsors.deal.notice.invoiceSent" : "sponsors.dealSheet.notice.saved", { name: s.name }));
    } catch (err) {
      if (!(err instanceof ApiV1Error) || err.code !== "stripe_unavailable" || body.payment_method !== "online") throw err;
      setError(msg(sponsorSaveErrorKey(
            err,
            // `queued`: the sponsor's live deal stays live, so an immediate deal waits behind it (and then offers Resend, not Send).
            createDealWrite({ method: body.payment_method, endCurrent: body.end_current, rule: body.go_live, queued: s.locked_by_deal && !body.end_current }),
          )));
    } finally {
      await Promise.all([refresh(), refreshDeals()].map((read) => read.catch(() => {})));
    }
  }

  /** A row's one write: the deal the row shows is the one acted on. `rowNextAction(null)` is Add deal, a link: no write is offered
   *  for a sponsor with no deal. */
  function dealAction(s: SponsorItem, action: DealWrite) {
    if (s.deal === null) return;
    runDealAction(s.deal, s.name, action);
  }

  /** The sponsor page's On stream toggle (the On stream tab's tick, same PATCH). A live deal owns the flag (D9), so a locked sponsor
   *  is never sent: the control is disabled for it, and this is the same rule for a call that gets past it. The list is re-read
   *  whatever the answer - a refusal means a deal went live since the page loaded. */
  function toggleStream(s: SponsorItem, next: boolean) {
    if (s.locked_by_deal) return;
    void run(async () => {
      try {
        await api(`/${s.id}`, { method: "PATCH", body: JSON.stringify({ on_stream: next }) });
      } finally {
        await refresh().catch(() => {});
      }
    });
  }

  /** Swap within the rendered group (the deal's tier, as the list draws it), persist the global order. */
  function move(id: string, delta: -1 | 1) {
    const row = sponsors.find((s) => s.id === id);
    if (!row) return;
    const group = hasTiers ? sponsors.filter((s) => groupTierOf(s) === groupTierOf(row)) : sponsors;
    const gi = group.findIndex((s) => s.id === id);
    const target = gi + delta;
    if (gi < 0 || target < 0 || target >= group.length) return;
    // The server orders by the STORED tier then display_order: a neighbour of another stored tier (a partner with a gold deal,
    // beside a native gold) has no order to swap with, and the swap would snap back on the next read. The arrows are disabled
    // there too; this is the same rule for a call that gets past them.
    if (!sameOrderBand(group[target]!, row)) return;
    const next = [...sponsors];
    const a = next.indexOf(group[gi]!);
    const b = next.indexOf(group[target]!);
    [next[a], next[b]] = [next[b]!, next[a]!];
    setSponsors(next);
    void run(async () => {
      await api("/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((s) => s.id) }) });
    });
  }

  // The sponsor whose page is open (`?sponsor=`, checked by the page to be one of this org's). Read from the live list, so a write
  // that changes the sponsor (a stream toggle, an edit, Show on site again) shows on its page. A sponsor the list no longer holds
  // (deleted since the page loaded) is no selection: the list shows.
  const selected = hub.sponsorId === null ? undefined : sponsors.find((s) => s.id === hub.sponsorId);
  // The deal whose page is open (`?deal=`, checked by the page to be one of the selected sponsor's). Read from the live deals, so a
  // write shows on its page. A deal the sponsor does not hold (a stranger's id, one this list no longer has) is no selection: the
  // sponsor's page shows.
  const selectedDeal =
    selected === undefined || hub.dealId === null ? undefined : deals.find((d) => d.id === hub.dealId && d.sponsor_id === selected.id);
  const sheetOpen = selected !== undefined;
  // The pay link, only while its deal can still be paid; each page shows the one that is its own.
  const openPayLink = payLink !== null && payLinkStillOpen(deals, payLink.deal) ? payLink : null;
  // The sponsor the Add deal sheet is open for - from either the list's row or the sponsor's page. A sponsor the list no longer holds
  // (deleted since) opens nothing.
  const addDealSponsor = addDealFor === null ? undefined : sponsors.find((s) => s.id === addDealFor);
  // The sponsor's editor is the page's while its page is open; the list behind a side panel must not draw a second one.
  const listEditingId = selected !== undefined && editingId === selected.id ? null : editingId;

  return (
    <div className="space-y-5">
      {/* A deal's own page, when one is selected (it sits on its sponsor's page: back and close lead there): the page body below md
          (the list is hidden then), a side panel from md. */}
      {selected && selectedDeal ? (
        <SponsorSheet
          title={msg("sponsors.deal.title")}
          backText={selected.name}
          backLabel={msg("sponsors.deal.backLabel", { name: selected.name })}
          closeHref={sponsorHref(hub.orgSlug, selected.id)}
          suspended={false}
        >
          <DealPageBody
            deal={selectedDeal}
            sponsorName={selected.name}
            orgId={orgId}
            canEdit={canEdit}
            busy={busy}
            tz={tz}
            competitions={competitions}
            createdBy={hub.dealCreatedByName}
            competitionFinished={hub.dealCompetitionFinished}
            payLink={openPayLink?.deal.id === selectedDeal.id ? openPayLink.url : null}
            error={error}
            notice={notice}
            onAction={(deal, action) => runDealAction(deal, selected.name, action)}
          />
        </SponsorSheet>
      ) : null}
      {/* The sponsor's page, when one is selected: the page body below md (the list is hidden then), a side panel from md. */}
      {selected && !selectedDeal ? (
        <SponsorSheet
          title={msg("sponsors.sheet.title")}
          backText={msg("sponsors.sheet.back")}
          backLabel={msg("sponsors.sheet.backLabel")}
          closeHref={sponsorsHref(hub.orgSlug, "sponsors")}
          suspended={addDealFor !== null}
        >
          <SponsorSheetBody
            sponsor={selected}
            deals={deals}
            orgId={orgId}
            orgSlug={hub.orgSlug}
            hasTiers={hasTiers}
            canEdit={canEdit}
            busy={busy}
            tz={tz}
            competitions={competitions}
            editing={editingId === selected.id}
            renderEditor={() => (
              <SponsorForm
                value={edit}
                onChange={(fn) => setEdit(fn)}
                onSubmit={() => saveEdit(selected)}
                onCancel={() => setEditingId(null)}
                submitLabel={msg("sponsors.save")}
                busy={busy}
                hasTiers={hasTiers}
                // A live deal owns the tier and the competition (D9, F28): the page shows them as the deal's and offers no control.
                showPlacement={!selected.locked_by_deal}
                lockedByDeal={false}
                competitions={competitions}
                onPickLogo={pickLogo}
                compact
              />
            )}
            onEdit={() => startEdit(selected)}
            onToggleStream={(next) => toggleStream(selected, next)}
            onShowAgain={() => showAgain(selected)}
            onAddDeal={() => setAddDealFor(selected.id)}
            onDealAction={(deal, action) => runDealAction(deal, selected.name, action)}
            error={error}
            notice={notice}
            payLink={openPayLink?.deal.sponsor_id === selected.id ? openPayLink.url : null}
            reportLinks={hub.reportLinks}
            reportDefaults={hub.reportDefaults}
          />
        </SponsorSheet>
      ) : null}

      <div data-testid="sponsors-list-view" className={`space-y-5 ${sheetOpen ? "max-md:hidden" : ""}`}>
        <p className="text-sm text-slate-500">{msg("sponsors.line")}</p>
        {/* With a sponsor's page open the page shows its own error and notice (a side panel's backdrop would cover these). */}
        {!sheetOpen && error && <p className="text-sm text-red-600">{error}</p>}
        {/* Always mounted: a live region that appears WITH its text is not reliably announced, so only the text changes. Empty, it is
            screen-reader-only (out of the layout, still in the accessibility tree). */}
        {!sheetOpen && (
          <p role="status" data-testid="sponsor-notice" className="text-sm text-emerald-700 empty:sr-only">
            {notice}
          </p>
        )}
        {!sheetOpen && openPayLink !== null ? <PayLinkBanner url={openPayLink.url} /> : null}

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
              showPlacement={false}
              lockedByDeal={false}
              competitions={competitions}
              onPickLogo={pickLogo}
            />
            {!hasTiers ? (
              <p className="mt-3 text-xs text-slate-500">
                {msg("sponsors.tiersUpsell")}{" "}
                <Link href={billingHref} className="text-purple-600 underline">
                  {msg("settings.upgrade.link")}
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}

        <SponsorList
          sponsors={sponsors}
          hasTiers={hasTiers}
          canEdit={canEdit}
          busy={busy}
          orgSlug={hub.orgSlug}
          tz={tz}
          competitions={competitions}
          editingId={listEditingId}
          renderEditor={(s) => (
            <SponsorForm
              value={edit}
              onChange={(fn) => setEdit(fn)}
              onSubmit={() => saveEdit(s)}
              onCancel={() => setEditingId(null)}
              submitLabel={msg("sponsors.save")}
              busy={busy}
              hasTiers={hasTiers}
              showPlacement
              lockedByDeal={s.locked_by_deal}
              competitions={competitions}
              onPickLogo={pickLogo}
            />
          )}
          moreOpenId={moreOpenId}
          onToggleMore={(id) => setMoreOpenId((open) => (open === id ? null : id))}
          onEdit={startEdit}
          onMove={move}
          onRemove={remove}
          onAction={dealAction}
          onAddDeal={(s) => setAddDealFor(s.id)}
        />
      </div>

      {addDealSponsor ? (
        <AddDealSheet
          sponsor={addDealSponsor}
          deals={deals}
          packages={hub.packages}
          competitions={competitions}
          hasTiers={hasTiers}
          hasMonetize={hub.hasMonetize}
          monetizeOrgWide={hub.monetizeOrgWide}
          monetizeCompetitionIds={hub.monetizeCompetitionIds}
          chargesEnabled={hub.chargesEnabled}
          finishedCompetitionIds={hub.finishedCompetitionIds}
          orgSlug={hub.orgSlug}
          onCreate={(body) => createDeal(addDealSponsor, body)}
          onClose={() => setAddDealFor(null)}
        />
      ) : null}
    </div>
  );
}
