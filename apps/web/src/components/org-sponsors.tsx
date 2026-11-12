"use client";

// Sponsors tab manager (v10 PROMPT-56, replaces the blob editor). Rows are
// first-class `sponsors` table entries; the list (components/sponsors/sponsor-list.tsx)
// groups them by the tier each shows at now (its own - a deal still waiting to go
// live changes nothing until it does) and gives each its deal's chip and one next
// action (sponsor deals PR 2, Task 14). This island owns the state and every
// write; the list is stateless. "Add a sponsor" and the EDIT form both ask for a
// name, a logo and a link only - the tier and where a sponsor shows come from its
// deal (owner, 2026-11-11: "why showing tier in sponsor edit?"), and the sponsor's
// page shows them read-only. The API still takes both on a PATCH. The sponsor
// page's editor (never the Add form) also has the optional Title poster the public hero
// shows for a Title sponsor, where the plan can place one (`PosterField`), folded behind
// "+ Add a title poster" unless the sponsor has one or is a Title sponsor (`PosterFold`). Tiers above
// partner and per-competition scoping are Pro (`sponsors.tiers`); without it the
// manager is the free un-tiered strip with an upsell note.
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { ImagePlus } from "lucide-react";
import { useViewerTz } from "@/components/client-time";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { SponsorList, dealPrice, groupTierOf, sameOrderBand, type DealWrite } from "@/components/sponsors/sponsor-list";
import { AddDealSheet, type CreateDealBody } from "@/components/sponsors/add-deal-sheet";
import { SMALL_BTN, SponsorSheet, SponsorSheetBody, sponsorDealGroups } from "@/components/sponsors/sponsor-sheet";
import { DealPageBody } from "@/components/sponsors/deal-page";
import { PayLinkBanner } from "@/components/sponsors/pay-link-banner";
import {
  endConfirmBodyKey, endKeepsPayment, invoiceNoticeKey, markPaidRetiresPayLink, payLinkStillOpen, refundConfirmBodyKey, refundPlacementKey,
} from "@/components/sponsors/deal-copy";
import { createDealWrite, sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import type { SponsorWrite } from "@/components/sponsors/save-error";
import { ApiV1Error } from "@/lib/client-v1";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { DealAction, SponsorDeal } from "@/lib/sponsor-deals";
import type { ReportLinkDefaults, ReportLinkSummary } from "@/lib/sponsor-report";
import { POSTER_HEIGHT, POSTER_WIDTH, posterCrop, type PosterCrop } from "@/lib/sponsor-poster";
import { sponsorHref, sponsorsHref } from "@/lib/sponsors-hub";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** What the logo picker takes: the file input's `accept` and the hint under the tile are both read from this one list, so the hint
 *  cannot name a format the picker does not offer (owner, 2026-11-11: "are there will be any particular format of image to be?"). */
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const LOGO_ACCEPT = LOGO_TYPES.join(",");
/** Each accepted type as people say it. A `Record` over the list: a type added to it without a name is a type error. */
const LOGO_FORMAT_NAME: Record<(typeof LOGO_TYPES)[number], string> = { "image/png": "PNG", "image/jpeg": "JPG", "image/webp": "WebP" };
/** The cap in the unit the hint says. The same constant `pickLogo` enforces, so the number in the hint is the number that refuses. */
const LOGO_MAX_MB = MAX_LOGO_BYTES / (1024 * 1024);
/** The accepted formats written the way the page's language writes a list ("PNG, JPG or WebP" / "PNG, JPG ou WebP"): `intlLocaleFor` keeps
 *  English on en-GB, whose list has no serial comma (the owner's sentence), where bare "en" would add one. The logo hint and the poster hint
 *  read it from here, so neither can name a format the picker does not offer. */
function acceptedFormats(locale: string): string {
  return new Intl.ListFormat(intlLocaleFor(locale), { style: "long", type: "disjunction" }).format(
    LOGO_ACCEPT.split(",").map((type) => LOGO_FORMAT_NAME[type as (typeof LOGO_TYPES)[number]]),
  );
}

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
  /** The optional 4:5 poster a Title sponsor shows in the public competition hero (V501); null shows the logo card. */
  poster_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: string;
  dispute_parked?: boolean;
  dispute_lost?: boolean;
  click_count: number;
  /** The sponsor is in the stream's rotation (the On stream tab's tick; the sponsor page's toggle). A live deal sets it (D9). */
  on_stream: boolean;
  /** When the club archived this sponsor (archive spec D8), or null: hidden from every public surface and the stream, its records
   *  kept. Only the Sponsors tab reads archived rows (its "Show archived" switch). */
  archived_at: string | null;
  /** The paid package order that activated this placement, if any. */
  paid_order_id?: string | null;
  /** The deal the row shows (sponsor deals D8: `pickRowDeal` over the sponsor's deals), or null when the sponsor has none - the
   *  WHOLE deal, as the list reads send it: the chip, the sub-line and the row's one action all read it. */
  deal: SponsorDeal | null;
  /** A live deal owns this sponsor's tier, competition, stream and status (D9): the stream box is locked, and the page says why. */
  locked_by_deal: boolean;
  /** A deal waits to go live (draft, awaiting payment or approval, scheduled): it holds the sponsor's status (D9). */
  has_open_deal: boolean;
  /** The billing email the Add deal sheet opens at (D22): the latest of this sponsor's deals that carries one. */
  last_billing_email: string | null;
}

/** What the hub page reads for the Sponsors tab beyond the list (sponsor deals PR 2, Task 13). Its readers: the sponsor list
 *  (Task 14, READS `orgSlug` only - a row carries its own deal, so `deals` would be a second authority for it), the sponsor's own
 *  page (Task 15: `sponsorId` picks it, `deals` fill its Deals, `reportLinks` and `reportDefaults` are its Report link), the Add deal
 *  sheet (Task 16: `packages` are its cards, `tiersOrgWide` and `tiersCompetitionIds` decide which scopes place them, `hasMonetize`,
 *  `monetizeOrgWide`, `monetizeCompetitionIds` and `chargesEnabled` decide
 *  whether Online is open FOR THE SCOPE picked, `finishedCompetitionIds` lock the packages that are no longer sold, `deals` feed its
 *  "already has one of these" confirm) and the deal page (Task 17: `dealId` picks it; `dealCreatedByName`, `dealWrittenOffByName` and
 *  `dealCompetitionFinished` are the reads its timeline needs from the server). */
export interface SponsorsHubData {
  orgSlug: string;
  /** The org's timezone (V305; null = UTC): the zone a deal's "Ends on" day was typed in (`createDeal` stores the start of the next day
   *  there), which the deal page reads that day back in. NOT the viewer's. */
  orgTimezone: string | null;
  /** Every deal of the org, newest first (legacy pre-deals rows included: they are ended deals). */
  deals: SponsorDeal[];
  /** Every package of the org, active first. */
  packages: SponsorPackageRow[];
  /** `sponsors.tiers` on the whole organisation (a paid plan), and so on every competition. The server gates placement PER SCOPE
   *  (deal-gates.ts `assertPlacementAllowed`): an Event Pass lifts its own competition and never the whole organisation. */
  tiersOrgWide: boolean;
  /** The competitions an Event Pass lifts `sponsors.tiers` on (empty when `tiersOrgWide`: org-wide covers every competition). */
  tiersCompetitionIds: string[];
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
  /** `?edit=1` (the list's pencil) on an editor's page with a sponsor selected: the sponsor's page opens with its Details editor open. */
  editSponsor: boolean;
  /** `?deal=` after the page checked it is one of the selected sponsor's deals; null shows the sponsor's page. */
  dealId: string | null;
  /** The selected deal's creator, by display name (a removed member or a deleted user reads null); null with no deal selected. */
  dealCreatedByName: string | null;
  /** Who wrote off the selected deal's invoice, by display name, by the same rule (final review m3); null with no deal selected, on a
   *  deal not written off, and for a member who can no longer be named. */
  dealWrittenOffByName: string | null;
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
  /** Picked in the form, uploaded on submit. */
  file: File | null;
  /** Object URL preview for the picked file, else the stored logo. */
  preview: string | null;
}
const EMPTY_DRAFT: Draft = { name: "", url: "", file: null, preview: null };

/** What the editor opens with: the sponsor's own name, link and logo (an empty form for no sponsor). */
function draftOf(s: SponsorItem | undefined): Draft {
  return s === undefined ? EMPTY_DRAFT : { name: s.name, url: s.url ?? "", file: null, preview: s.logo_path };
}

/** What the poster field holds while the sponsor page's editor is open (Title-sponsor hero poster, spec §8). Its own state, not a key on
 *  `Draft`: the logo draft stays a name, a link and a logo. `file` is a picked, not yet uploaded, picture and `preview` what the tile shows
 *  (its object URL, else the stored poster). `removed` says the stored poster is to go; it never holds together with a `file` (picking
 *  clears it, Remove clears the file). `crop` is what the 4:5 tile will cut off the PICKED picture, or null when there is no pick or the
 *  browser could not measure it. */
export interface PosterDraft {
  file: File | null;
  preview: string | null;
  removed: boolean;
  crop: PosterCrop | null;
}

/** What the poster field opens with: the sponsor's stored poster previewed, nothing picked, nothing removed (empty for no sponsor). */
export function posterDraftOf(s: Pick<SponsorItem, "poster_path"> | undefined): PosterDraft {
  return { file: null, preview: s?.poster_path ?? null, removed: false, crop: null };
}

/** Is the sponsor in the Title placement, or on its way to it - the one place its poster shows? Its stored tier is where it shows now (a
 *  live deal sets it, D9; a sponsor placed before deals keeps it), and a Title deal that is live or still waiting to go live (the sponsor
 *  page's `current` deals) puts it there or will. An ended deal places nobody, and another sponsor's deal is not this one's. Read from what
 *  the page already holds - the sponsor row and the org's deals - never a fetch of its own. */
export function inTitlePlacement(s: Pick<SponsorItem, "id" | "tier">, deals: readonly SponsorDeal[]): boolean {
  return s.tier === "title" || sponsorDealGroups(deals, s.id).current.some((d) => d.tier === "title");
}

/** What the sponsor page's editor hands its Title poster: the draft, the two writes, and whether the sponsor is in the Title placement
 *  (`inTitlePlacement`), which opens the field from the start. */
export interface PosterFieldWire {
  value: PosterDraft;
  onPick: (file: File) => void | Promise<void>;
  onRemove: () => void;
  titlePlacement: boolean;
}

/** The PATCH body of a save from the sponsor page's editor: only what changed, never the tier or the scope (a deal sets those). `uploaded`
 *  holds the public URL of each picture the save has just uploaded. A poster is removed only when there is one stored to remove (`removed`
 *  with nothing stored sends nothing), and a stored poster that was not touched is not re-sent. Pure: the island does the uploads. */
export function sponsorEditPatch(
  s: Pick<SponsorItem, "name" | "url" | "poster_path">,
  edit: { name: string; url: string },
  poster: PosterDraft,
  uploaded: { logo?: string; poster?: string },
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (edit.name.trim() && edit.name.trim() !== s.name) patch.name = edit.name.trim();
  const url = normalizeUrl(edit.url) || null;
  if (url !== s.url) patch.url = url;
  if (uploaded.logo) patch.logo_path = uploaded.logo;
  // A removed draft has no file (so nothing was uploaded for it): the two arms cannot both apply.
  if (uploaded.poster) patch.poster_path = uploaded.poster;
  else if (poster.removed && s.poster_path !== null) patch.poster_path = null;
  return patch;
}

/** Measure a picked picture against the 4:5 tile (`posterCrop`, spec §11). A browser that cannot decode it (no `createImageBitmap`, or it
 *  rejects) has no answer, and the file is still taken: no warning is better than a refused file. The bitmap is closed either way. */
async function measurePoster(file: File): Promise<PosterCrop | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return posterCrop(bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** The route each deal write POSTs. Send and Resend invoice are one route: the server sends a draft's first invoice and re-sends an
 *  open one's the same way (ensureDealCheckout). */
const DEAL_ROUTE: Record<DealAction, string> = {
  send_invoice: "send-invoice",
  resend_invoice: "send-invoice",
  mark_paid: "mark-paid",
  write_off: "write-off",
  approve: "approve",
  refund: "refund",
  end_now: "end",
};

/** Is a delete certain to be refused? History on any of a sponsor's deals - money paid or refunded, or an invoice number (every
 *  online and offline deal gets one when it is made, paid or not: sponsor invoices, Task 20) - is a 409 `sponsor_has_deal_history`
 *  (server/usecases/sponsors.ts `dealHoldsHistory`). What the row can see of it is its paid order and the deal it shows; a pre-deals
 *  order or a history on an older deal is only known to the server, whose refusal is shown the same way. So this only decides
 *  whether to ASK first - it refuses nothing. */
function deleteIsRefusedForHistory(s: SponsorItem): boolean {
  return (
    Boolean(s.paid_order_id) ||
    s.deal?.payment_status === "paid" ||
    s.deal?.payment_status === "refunded" ||
    s.deal?.invoice_number != null
  );
}

/** The dictionary key for a refused logo upload grant, from the route's STATUS (batch H review m6): the picker offers PNG, JPG and WebP,
 *  and the route's own answers are 400 (validation: a type outside its list), 415 (unsupported type) and 401 / 403 (not allowed to
 *  upload at all). 413 is the size cap (the route does not send it itself; a proxy or the bucket does), read as the 2 MB limit. */
export function logoUploadRefusalKey(status: number): "settings.org.sponsors.uploadTypeNotAllowed" | "settings.org.sponsors.tooBig" | "settings.org.sponsors.uploadNotAllowed" {
  if (status === 400 || status === 415 || status === 422) return "settings.org.sponsors.uploadTypeNotAllowed";
  if (status === 413) return "settings.org.sponsors.tooBig";
  return "settings.org.sponsors.uploadNotAllowed";
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

/** The one sponsor form — add and edit share it; logo travels with it. A sponsor is a name, a link and a logo here: its tier and
 *  where it shows come from its deals (spec §6.1; owner, 2026-11-11), so the form has no control for either, on any plan.
 *  Hoisted out of OrgSponsors: a nested component definition would remount
 *  (and drop focus) on every parent render. */
export function SponsorForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  onPickLogo,
  poster,
  compact = false,
}: {
  value: Draft;
  onChange: (fn: (prev: Draft) => Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
  onPickLogo: (file: File, set: (fn: (prev: Draft) => Draft) => void) => void;
  /** The optional Title poster (Title-sponsor hero poster): given only to the sponsor page's editor, and only when the plan can place a
   *  Title sponsor. The Add form never has it (a poster belongs to a sponsor that exists), so it is a prop and not a mode of the form. */
  poster?: PosterFieldWire;
  /** Name and link one above the other, whatever the viewport: for the sponsor page's side panel, where `sm:` (a VIEWPORT query) would put
   *  the two side by side in a 360px panel. The add box leaves it off. */
  compact?: boolean;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  // House uploader pattern (org-logo, prose-editor): a real button clicks a
  // ref'd hidden input — label-wrapped file inputs misfire in some browsers, so
  // the Logo label names the input with `htmlFor` and never wraps it.
  const fileRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const inputId = useId();
  const formats = acceptedFormats(locale);
  const urlInvalid = value.url.trim() !== "" && !isValidSponsorUrl(value.url);
  return (
    <div className="grid min-w-0 gap-3">
      {/* The logo, named (owner, 2026-11-11, option B: "what two image upload?"): its own label - a real <label> for its file input -
          and one hint that says where it shows, then what the picker takes, the way the Title poster's hint does. */}
      <div className="flex min-w-0 items-start gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group grid h-20 w-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white text-slate-400 hover:border-purple-400 hover:text-purple-600"
          aria-label={msg("sponsors.logoLabel")}
          aria-describedby={hintId}
        >
          {value.preview ? (
            // Preview is an object URL for a picked file or the stored CDN URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.preview} alt="" className="h-full w-full object-contain p-1.5" />
          ) : (
            // An icon, no word: the button's name is its aria-label, and what it takes is the hint beside it (owner, 2026-11-11).
            <ImagePlus className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
        <input
          ref={fileRef}
          id={inputId}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickLogo(f, onChange);
            e.target.value = "";
          }}
        />
        <div className="min-w-0 flex-1 pt-0.5">
          <label htmlFor={inputId} className="label">
            {msg("sponsors.logoLabel")}
          </label>
          {/* Where it shows, then what the tile takes - never typed twice: the formats are the input's `accept`, the size is the cap
              `pickLogo` refuses at. One text node, so the tile's description is one paragraph. */}
          <p id={hintId} className="text-xs text-slate-500">
            {`${msg("sponsors.logoWhere")} ${msg("sponsors.logoHint", { formats, mb: LOGO_MAX_MB })}`}
          </p>
        </div>
      </div>
      {/* Name and link side by side from sm; a single stack on mobile (and always, when compact). */}
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
      </div>
      {poster ? <PosterFold {...poster} /> : null}
      <div className="flex items-center gap-2">
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
  );
}

/** The Title poster, folded away until it is wanted (owner, 2026-11-11, option B): most sponsors are never a Title sponsor, so the field
 *  waits behind "+ Add a title poster" unless there is a reason to show it - a poster stored or picked (or one being removed), or the sponsor
 *  is in, or on its way to, the Title placement. A tap opens it and hands focus to its tile; once open it stays open for this editor (no
 *  fold-back: after Remove the empty tile is there to pick again). One DOM at every width; the toggle is 44px tall at every width. */
export function PosterFold({ value, onPick, onRemove, titlePlacement }: PosterFieldWire) {
  const msg = useMsg();
  const nameId = useId();
  const subId = useId();
  const [opened, setOpened] = useState(false);
  const startsOpen = value.preview !== null || value.file !== null || value.removed || titlePlacement;
  if (opened || startsOpen) return <PosterField value={value} onPick={onPick} onRemove={onRemove} focusOnMount={opened} />;
  return (
    <button
      type="button"
      data-testid="sponsor-poster-toggle"
      aria-expanded="false"
      aria-labelledby={nameId}
      aria-describedby={subId}
      onClick={() => setOpened(true)}
      className="group grid min-h-11 min-w-0 cursor-pointer content-center justify-items-start gap-0.5 rounded-lg py-1 text-left"
    >
      <span id={nameId} className="text-sm font-medium text-purple-700 underline-offset-2 group-hover:underline">
        {msg("sponsors.poster.add")}
      </span>
      <span id={subId} className="text-xs text-slate-500">
        {msg("sponsors.poster.addHint")}
      </span>
    </button>
  );
}

/** The optional Poster field of the sponsor page's editor (spec §8): a dashed 4:5 tile that IS the crop (the public panel draws the same
 *  `object-cover` box), the hint beside it, Remove, and a warning when the picture would lose more than a quarter. Like the logo tile it is
 *  an icon with an accessible name, and one hint says what it takes - the formats are the input's `accept`, the size the cap `pickPoster`
 *  refuses at, the recommended size the poster's own constants - so the hint cannot say something the picker does not do. Stateless but for
 *  the ids and the ref: the draft and every write are OrgSponsors'. Hoisted out of SponsorForm for the same reason SponsorForm is out of
 *  OrgSponsors. */
export function PosterField({
  value,
  onPick,
  onRemove,
  focusOnMount = false,
}: {
  value: PosterDraft;
  onPick: (file: File) => void | Promise<void>;
  onRemove: () => void;
  /** The field was just unfolded by a tap (`PosterFold`): its tile takes focus as it mounts. Never on a field open from the start. */
  focusOnMount?: boolean;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const fileRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const hintId = useId();
  const crop = value.crop;
  const sizes = { width: POSTER_WIDTH, height: POSTER_HEIGHT };
  return (
    <div data-testid="sponsor-poster-field" role="group" aria-labelledby={labelId} className="min-w-0">
      <span id={labelId} className="label">
        {msg("sponsors.poster.label")}
      </span>
      <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-3">
        <button
          type="button"
          data-testid="sponsor-poster-tile"
          // Mount-only (React focuses an autoFocus element when it is inserted, never on a re-render), so it cannot pull focus back later.
          autoFocus={focusOnMount}
          onClick={() => fileRef.current?.click()}
          className="group grid aspect-[4/5] w-24 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white text-slate-400 hover:border-purple-400 hover:text-purple-600"
          aria-label={msg("sponsors.sheet.poster")}
          aria-describedby={hintId}
        >
          {value.preview ? (
            // The picked file's object URL or the stored CDN URL, cropped exactly as the public poster panel crops it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
        <input
          ref={fileRef}
          data-testid="sponsor-poster-input"
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = "";
          }}
        />
        <div className="grid min-w-0 flex-1 basis-40 justify-items-start gap-2">
          <p id={hintId} data-testid="sponsor-poster-hint" className="min-w-0 text-xs text-slate-500">
            {msg("sponsors.poster.hint", { formats: acceptedFormats(locale), mb: LOGO_MAX_MB, ...sizes })}
          </p>
          {/* Always mounted, so a screen reader hears the warning arrive; empty it takes no room. */}
          <div role="status" className="min-w-0 empty:hidden">
            {crop !== null && crop.warn && crop.side !== null ? (
              <p data-testid="sponsor-poster-crop" className="min-w-0 text-xs text-amber-800">
                {msg(crop.side === "width" ? "sponsors.poster.cropWidth" : "sponsors.poster.cropHeight", { percent: crop.percent, ...sizes })}
              </p>
            ) : null}
          </div>
          {value.preview ? (
            <button type="button" data-testid="sponsor-poster-remove" onClick={onRemove} className={SMALL_BTN}>
              {msg("sponsors.poster.remove")}
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
  const router = useRouter();
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
  // The sponsor page opens with its editor open when the URL says so (`?edit=1`: the list's pencil, the one way in from the list). The
  // island stays mounted across that client navigation, so the URL's answer is compared by identity in render (never an effect, and
  // not just as the initial state, which would miss every pencil after the first).
  const editParamId = hub.editSponsor ? hub.sponsorId : null;
  const [editingId, setEditingId] = useState<string | null>(editParamId);
  const [edit, setEdit] = useState<Draft>(draftOf(initialSponsors.find((s) => s.id === editParamId)));
  // The poster has its own draft (the logo's stays a name, a link and a logo). `posterSeq` numbers the picks: a measuring that finishes
  // after a newer pick or after Remove is stale and is dropped (`pickPoster`). `posterOwner` is the sponsor the editor is open for (the
  // URL's `?edit=` answer): a pick that was started for one sponsor never lands in another's draft. It is a ref read AFTER the measuring,
  // set by an effect, so a pick made the moment the page hydrates is not mistaken for a stale one (a counter bumped on mount ate it).
  // That hydration window cannot be witnessed in the node harness (it runs effects synchronously): the owner comparison itself is pinned.
  const [poster, setPoster] = useState<PosterDraft>(posterDraftOf(initialSponsors.find((s) => s.id === editParamId)));
  const posterSeq = useRef(0);
  const posterOwner = useRef(editParamId);
  useEffect(() => {
    posterOwner.current = editParamId;
  }, [editParamId]);
  const [seenEditParamId, setSeenEditParamId] = useState(editParamId);
  /** The row whose ⋯ is open below md (one at a time). */
  const [moreOpenId, setMoreOpenId] = useState<string | null>(null);
  if (seenEditParamId !== editParamId) {
    setSeenEditParamId(editParamId);
    setEditingId(editParamId);
    setEdit(draftOf(sponsors.find((s) => s.id === editParamId)));
    setPoster(posterDraftOf(sponsors.find((s) => s.id === editParamId)));
    // The row's tray belongs to the list; the pencil took the reader off it, and a tray left open would still be open on the way back.
    setMoreOpenId(null);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What a write that changes nothing on screen says it did (Resend invoice: the chip stays "Awaiting payment"). */
  const [notice, setNotice] = useState<string | null>(null);
  /** The invoice link the last send, resend or online Add deal answered with (`invoice_url`: the link the email carries, never a
   *  Checkout url), and its deal: shown only while that deal can still be paid (`payLinkStillOpen`), so End now, Mark as paid or a
   *  payment takes it down with the deal. */
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

  /** Upload a picked logo or poster to storage; returns its public URL. `kind` says whose words a file over the storage's cap (413) gets:
   *  the logo's "Sponsor logos can be up to 2 MB" is untrue of a poster, so a poster says its own (`sponsors.poster.tooBig`). */
  async function uploadLogo(file: File, kind: "logo" | "poster" = "logo"): Promise<string> {
    const tooBig = () => (kind === "poster" ? msg("sponsors.poster.tooBig", { mb: LOGO_MAX_MB }) : msg("settings.org.sponsors.tooBig"));
    const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: file.type }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      // handler() envelope: { ok, data } — same unwrap as api().
      data?: { upload_url?: string; public_url?: string };
    };
    // The envelope's `error` is the server's English sentence (or a structured object): never shown, whatever the status. The STATUS
    // says which words are true (batch H review m6): a type the route will not take (400 validation, 415 or 422) is a different fix
    // from "not allowed to upload at all" (401, 403), and a file over the cap (413) is the size limit - never the generic refusal.
    if (!res.ok) throw new Error(res.status === 413 ? tooBig() : msg(logoUploadRefusalKey(res.status)));
    const grant = json.data;
    if (!grant?.upload_url || !grant.public_url) {
      throw new Error(msg("settings.org.sponsors.uploadNotAllowed"));
    }
    const put = await fetch(grant.upload_url, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!put.ok) throw new Error(put.status === 413 ? tooBig() : msg("settings.org.logo.uploadFailed"));
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

  /** Pick a poster for the open editor: over the cap it is refused at once (the same cap as the logo, in the poster's words and with the
   *  draft left as it was); otherwise it is measured against the 4:5 tile and taken, with the crop it would take (null when the browser
   *  cannot measure it). The preview exists only once the pick is taken, so a dropped pick leaves no object URL behind. */
  async function pickPoster(file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setError(msg("sponsors.poster.tooBig", { mb: LOGO_MAX_MB }));
      return;
    }
    setError(null);
    const seq = ++posterSeq.current;
    const owner = posterOwner.current;
    const crop = await measurePoster(file);
    if (seq !== posterSeq.current || owner !== posterOwner.current) return;
    setPoster({ file, preview: URL.createObjectURL(file), removed: false, crop });
  }

  /** Remove the poster: forget a pick, and mark a stored poster to go (the save sends the null). */
  function removePoster() {
    posterSeq.current += 1;
    setPoster({ file: null, preview: null, removed: true, crop: null });
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

  /** The editor is done (saved or cancelled): the pencil's `?edit=1` has served its purpose, so the URL goes back to the plain sponsor
   *  page - a reload, Back or a copied link is the read-only page, and the next pencil is a fresh arrival. Only when the flag is in the
   *  URL: an editor the page's own Edit button opened has nothing to clear, and a replace to the same URL is a needless round trip. */
  function leaveEditUrl() {
    if (editParamId !== null) router.replace(sponsorHref(hub.orgSlug, editParamId));
  }

  /** The sponsor page's own Edit button (the list's pencil is a link: it arrives here through `?edit=1`). */
  function startEdit(s: SponsorItem) {
    setEditingId(s.id);
    setEdit(draftOf(s));
    setPoster(posterDraftOf(s));
    posterSeq.current += 1;
  }

  function saveEdit(s: SponsorItem) {
    void run(async () => {
      // Send only what changed (`sponsorEditPatch`). The editor is a name, a link, a logo and (where the plan can place a Title sponsor) a
      // poster: the sponsor's tier and scope are its deals' to set (the API still takes them, for callers that are not this screen), so a
      // save from here never carries either.
      const uploaded: { logo?: string; poster?: string } = {};
      if (edit.file) uploaded.logo = await uploadLogo(edit.file);
      if (poster.file) uploaded.poster = await uploadLogo(poster.file, "poster");
      const patch = sponsorEditPatch(s, edit, poster, uploaded);
      if (Object.keys(patch).length > 0) {
        await api(`/${s.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        await refresh();
      }
      setEditingId(null);
      leaveEditUrl();
    });
  }

  function remove(s: SponsorItem) {
    void (async () => {
      // The server's rule (sponsors.ts `deleteSponsor`, sponsor deals F3 and F10): a sponsor's deals go WITH it, unless one holds
      // history (money paid or refunded, an invoice number, or a pre-deals order) or an open payment link nobody could close - then
      // the delete is a 409 and the sponsor stays. So a sponsor with deals asks first, in words that match; one already known to hold
      // history is not asked to confirm a delete that cannot happen (its 409 reads `sponsors.error.hasDealHistory`). The server
      // stays the rule's one owner: this only skips a question, it refuses nothing.
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
          // An ended deal still due (Task 23 carry 1) does not follow its go-live rule: it stays ended, and its invoice reads Paid.
          body: [
            msg(deal.deal_status === "ended" ? "sponsors.deal.markPaid.bodyEnded" : "sponsors.deal.markPaid.body"),
            ...(markPaidRetiresPayLink(deal) ? [msg("sponsors.deal.confirm.markPaid.payLink", { name })] : []),
          ].join(" "),
          confirmLabel: msg("sponsors.deal.action.markPaid"),
          tone: "default",
        });
        if (!ok) return;
      }
      if (action === "write_off") {
        // Task 23 carry 4: waiving what is still due is final, so it asks first, in the words the invoice will then say.
        const amount = dealPrice(deal, locale);
        const ok = await confirm({
          title: msg("sponsors.deal.confirm.writeOff.title", { amount, name }),
          body: msg("sponsors.deal.confirm.writeOff.body", { name }),
          confirmLabel: msg("sponsors.deal.confirm.writeOff.label", { amount }),
          tone: "danger",
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
              | { deal?: SponsorDeal; invoice_url?: string | null }
              | null;
            if (action === "resend_invoice" || action === "send_invoice") {
              // The answer carries the invoice link beside the deal (F11); the deal itself carries no url.
              setPayLink(answer?.invoice_url ? { deal: answer.deal ?? deal, url: answer.invoice_url } : null);
              // By the deal BEFORE the send: an offline deal's first send is offered as Resend, and replaces nothing (m3).
              setNotice(msg(invoiceNoticeKey(deal), { name }));
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
        | { deal?: SponsorDeal; invoice_url?: string | null }
        | null;
      // F11: the invoice link rides beside the deal in the create's answer. An online create that did not send (a Stripe refusal) is
      // handled below; a create that sends no invoice has none.
      setPayLink(made?.deal && made.invoice_url ? { deal: made.deal, url: made.invoice_url } : null);
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

  /** Swap within the rendered group (the tier each sponsor shows at now, `groupTierOf`, as the list draws it), persist the global order. */
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
            hasTiers={hasTiers}
            canEdit={canEdit}
            busy={busy}
            tz={tz}
            orgTz={hub.orgTimezone ?? "UTC"}
            competitions={competitions}
            createdBy={hub.dealCreatedByName}
            writtenOffBy={hub.dealWrittenOffByName}
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
                onCancel={() => {
                  setEditingId(null);
                  leaveEditUrl();
                }}
                submitLabel={msg("sponsors.save")}
                busy={busy}
                onPickLogo={pickLogo}
                poster={
                  hasTiers
                    ? { value: poster, onPick: pickPoster, onRemove: removePoster, titlePlacement: inTitlePlacement(selected, deals) }
                    : undefined
                }
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
          moreOpenId={moreOpenId}
          onToggleMore={(id) => setMoreOpenId((open) => (open === id ? null : id))}
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
          tiersOrgWide={hub.tiersOrgWide}
          tiersCompetitionIds={hub.tiersCompetitionIds}
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
