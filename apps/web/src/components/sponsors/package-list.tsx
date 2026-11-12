"use client";

// The Packages tab as a price list (sponsor deals PR 2, Task 18; spec §6.4, mockup screen 4). It replaces the transitional "Packages and
// orders" console (components/sponsor-packages.tsx, deleted here): a package is a price on the club's list - name, price, tier, where it
// applies, whether it puts the sponsor on the stream, and how many sponsors hold an open deal on it. Selling one is not done here any
// more: a deal is added from a sponsor (Add deal, `add-deal-sheet.tsx`), and the deals themselves live on the Sponsors tab.
//
// Offered to every editor on every plan: a package is a PLACEMENT, so only its tier (anything but Partner) and a one-competition scope
// are gated (`placementNeedsTiers`, the one predicate the server enforces: usecases/sponsors.ts `createSponsorPackage`). What is
// gated on this page is therefore drawn as disabled options with the reason beside them, never as a missing page. Selling a package
// online (`sponsors.monetize`) is asked when a deal is made, so this page only says where the money goes or what it needs.
//
// Stateful in exactly one place - this island owns the list, the sheet's draft and the writes - and everything it draws is a stateless
// child (`PackageCard`, `PackageCreateSheet`), so a test can step into them (components/sponsors/__tests__/package-list.test.tsx).
import { useState } from "react";
import { Plus } from "lucide-react";
import Link from "@/components/ui/console-link";
import { Modal } from "@/components/modal";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { priceLabel } from "@/components/sponsors/deal-copy";
import { sponsorSaveErrorKey } from "@/components/sponsors/save-error";
import { slimSwitch } from "@/components/sponsors/slim-switch";
import { TierLegend } from "@/components/sponsors/tier-legend";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import { apiV1 } from "@/lib/client-v1";
import { placementNeedsTiers } from "@/lib/sponsor-deal-policy";
import { SPONSOR_TIERS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { SponsorPackageRow } from "@/server/usecases/sponsors";

const CURRENCIES = ["gbp", "eur", "usd"] as const;
const LOCK_LINK = "inline-flex items-center font-medium text-purple-700 underline max-md:min-h-11";

/** What the create sheet holds while it is open. Text stays text (the price is parsed once, on save). */
export interface PackageDraft {
  name: string;
  price: string;
  currency: string;
  tier: SponsorTier;
  /** "" is the whole organisation - any competition, the deal picks. */
  competition_id: string;
  includes_on_stream: boolean;
}

const EMPTY_DRAFT: PackageDraft = { name: "", price: "", currency: "gbp", tier: "partner", competition_id: "", includes_on_stream: false };

/** A typed price as whole minor units, or null when it is not money: digits with at most two decimals (a comma is the decimal mark in
 *  three of the four languages), above zero. Exact - the digits are read, never multiplied as a float (19.99 * 100 is 1998.99999...) -
 *  and a third decimal is refused, not rounded to a price nobody typed. */
export function parsePriceCents(text: string): number | null {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// --- a card ---------------------------------------------------------------------------------------------------------------------------

export interface PackageCardProps {
  pkg: SponsorPackageRow;
  competitions: readonly { id: string; name: string }[];
  /** The package's competition has finished: the deal would end within the hour (§8a), so it is not sold. */
  finished: boolean;
  canEdit: boolean;
  busy: boolean;
  onRetire: (pkg: SponsorPackageRow) => void;
}

const CHIP = "rounded-full px-2 py-0.5 text-[11px] font-medium";

export function PackageCard({ pkg, competitions, finished, canEdit, busy, onRetire }: PackageCardProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const scope =
    pkg.competition_id === null
      ? msg("sponsors.dealSheet.packageScopeAny")
      : (competitions.find((c) => c.id === pkg.competition_id)?.name ?? msg("sponsors.dealSheet.scopeUnknown"));
  const chips = pkg.includes_on_stream || !pkg.active || finished;
  return (
    <article
      data-testid="package-card"
      data-package-id={pkg.id}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 p-4 ${pkg.active ? "bg-white" : "bg-slate-50"}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p data-testid="package-name" className="min-w-0 break-words text-sm font-semibold text-slate-900">
            {pkg.name}
          </p>
          <p data-testid="package-scope" className="mt-0.5 min-w-0 break-words text-xs text-slate-500">
            {scope}
          </p>
        </div>
        <span data-testid="package-tier" className={`shrink-0 ${CHIP} ${TIER_BADGE[pkg.tier]}`}>
          {msg(TIER_MSG[pkg.tier])}
        </span>
      </div>
      {/* The price is the one loud thing on a price list. */}
      <p data-testid="package-price" className={`text-2xl font-semibold tabular-nums tracking-tight ${pkg.active ? "text-slate-900" : "text-slate-500"}`}>
        {priceLabel(locale, pkg.price_cents, pkg.currency)}
      </p>
      {chips ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {pkg.includes_on_stream ? (
            <span data-testid="package-on-stream" className={`${CHIP} bg-purple-100 text-purple-800`}>
              {msg("sponsors.sheet.onStream")}
            </span>
          ) : null}
          {!pkg.active ? (
            <span data-testid="package-retired" className={`${CHIP} bg-slate-200 text-slate-600`}>
              {msg("sponsors.pkg.retired")}
            </span>
          ) : null}
          {finished ? (
            // The competition is over, so a deal on it would end within the hour: the package is not sold.
            <span data-testid="package-finished" className={`${CHIP} bg-slate-100 text-slate-600`}>
              {msg("sponsors.pkg.competitionFinished")}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-100 pt-3">
        <p data-testid="package-used-by" className="min-w-0 text-xs text-slate-500">
          {pkg.used_by > 0 ? plural("sponsors.pkg.usedBy", pkg.used_by) : msg("sponsors.pkg.notUsed")}
        </p>
        {canEdit && pkg.active ? (
          <button
            type="button"
            data-testid="package-retire"
            aria-label={msg("sponsors.pkg.retire", { name: pkg.name })}
            disabled={busy}
            onClick={() => onRetire(pkg)}
            className="btn btn-ghost px-3 py-1.5 text-xs max-md:min-h-11"
          >
            {msg("sponsors.pkg.retireShort")}
          </button>
        ) : null}
      </div>
    </article>
  );
}

// --- the create sheet ----------------------------------------------------------------------------------------------------------------

/** The plan places tiers FOR THIS SCOPE (null is the whole organisation): org-wide covers every scope, an Event Pass only its own
 *  competition - the server's per-scope gate, so an Event Pass holder is not offered what the 402 would refuse. */
const packageTiersFor = (orgWide: boolean, competitionIds: readonly string[], competitionId: string | null) =>
  orgWide || (competitionId !== null && competitionIds.includes(competitionId));

export interface PackageCreateSheetProps {
  draft: PackageDraft;
  onChange: (next: PackageDraft) => void;
  onSubmit: () => void;
  onClose: () => void;
  competitions: readonly { id: string; name: string }[];
  /** An affordance that follows the server's per-scope gate (usecases/sponsors.ts `createSponsorPackage`): `sponsors.tiers` is on for the
   *  whole organisation (a paid plan), and so for every competition ... */
  tiersOrgWide: boolean;
  /** ... or only for the competitions an Event Pass lifts it on (a pass never lifts the whole organisation). */
  tiersCompetitionIds: readonly string[];
  busy: boolean;
  canSave: boolean;
  error: string | null;
  billingHref: string;
}

export function PackageCreateSheet({ draft, onChange, onSubmit, onClose, competitions, tiersOrgWide, tiersCompetitionIds, busy, canSave, error, billingHref }: PackageCreateSheetProps) {
  const msg = useMsg();
  const priceInvalid = draft.price.trim() !== "" && parsePriceCents(draft.price) === null;
  const scope = draft.competition_id === "" ? null : draft.competition_id;
  const locked = (tier: SponsorTier, competitionId: string | null) => !packageTiersFor(tiersOrgWide, tiersCompetitionIds, competitionId) && placementNeedsTiers(tier, competitionId);
  return (
    <Modal
      title={msg("sponsors.pkg.create")}
      closeSize="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" data-testid="package-create-cancel" onClick={onClose} className="btn btn-ghost max-md:min-h-11">
            {msg("confirm.cancel")}
          </button>
          <button
            type="button"
            data-testid="package-create-submit"
            disabled={!canSave || busy}
            onClick={onSubmit}
            className="btn btn-primary min-w-0 whitespace-normal text-center leading-tight max-md:min-h-11 max-md:flex-1"
          >
            {busy ? "…" : msg("sponsors.pkg.create")}
          </button>
        </>
      }
    >
      <div data-testid="package-create-sheet" className="min-w-0 space-y-4 text-slate-700">
        <label className="block min-w-0">
          <span className="label">{msg("sponsors.pkg.name")}</span>
          <input
            data-testid="package-create-name"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            maxLength={120}
            className="input w-full"
          />
        </label>
        <div className="grid min-w-0 grid-cols-2 gap-3">
          <label className="block min-w-0">
            <span className="label">{msg("sponsors.pkg.price")}</span>
            <input
              data-testid="package-create-price"
              value={draft.price}
              onChange={(e) => onChange({ ...draft, price: e.target.value })}
              inputMode="decimal"
              placeholder="250"
              aria-invalid={priceInvalid || undefined}
              className={`input w-full ${priceInvalid ? "border-red-400" : ""}`}
            />
          </label>
          <label className="block min-w-0">
            <span className="label">{msg("sponsors.pkg.currency")}</span>
            <select
              data-testid="package-create-currency"
              value={draft.currency}
              onChange={(e) => onChange({ ...draft, currency: e.target.value })}
              className="input w-full"
            >
              {CURRENCIES.map((cur) => (
                <option key={cur} value={cur}>
                  {cur.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="label">{msg("sponsors.tierLabel")}</span>
            <select
              data-testid="package-create-tier"
              value={draft.tier}
              onChange={(e) => onChange({ ...draft, tier: e.target.value as SponsorTier })}
              className="input w-full"
            >
              {SPONSOR_TIERS.map((tier) => (
                <option key={tier} value={tier} disabled={locked(tier, scope)}>
                  {msg(TIER_MSG[tier])}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="label">{msg("sponsors.scopeLabel")}</span>
            <select
              data-testid="package-create-scope"
              value={draft.competition_id}
              onChange={(e) => onChange({ ...draft, competition_id: e.target.value })}
              className="input w-full"
            >
              <option value="" disabled={locked(draft.tier, null)}>
                {msg("sponsors.dealSheet.packageScopeAny")}
              </option>
              {competitions.map((c) => (
                <option key={c.id} value={c.id} disabled={locked(draft.tier, c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!tiersOrgWide ? (
          <p data-testid="package-create-tiers-hint" className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-slate-600">
            <span>{msg("sponsors.pkg.tiersHint")}</span>
            <Link data-testid="package-create-upgrade" href={billingHref} className={LOCK_LINK}>
              {msg("sponsors.dealSheet.upgrade")}
            </Link>
          </p>
        ) : null}
        <label className="flex min-w-0 items-start gap-3 rounded-xl border border-slate-200 p-3 max-md:min-h-11">
          <input
            type="checkbox"
            data-testid="package-create-on-stream"
            checked={draft.includes_on_stream}
            onChange={(e) => onChange({ ...draft, includes_on_stream: e.target.checked })}
            className="mt-0.5 h-4 w-4 shrink-0 accent-purple-600"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-800">{msg("sponsors.pkg.onStream")}</span>
            <span className="block text-xs text-slate-500">{msg("sponsors.pkg.onStreamHint")}</span>
          </span>
        </label>
        {error ? (
          <p role="alert" data-testid="package-create-error" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

// --- the list ---------------------------------------------------------------------------------------------------------------------------

export interface PackageListProps {
  orgId: string;
  /** The packages as the server listed them: active first, newest first. */
  initialPackages: SponsorPackageRow[];
  competitions: readonly { id: string; name: string }[];
  /** `sponsors.tiers` on the whole organisation, and on the competitions an Event Pass lifts it on (`PackageCreateSheetProps`). */
  tiersOrgWide: boolean;
  tiersCompetitionIds: readonly string[];
  /** Online invoices are on for this plan somewhere (an affordance): only the closing note reads it. */
  hasMonetize: boolean;
  billingHref: string;
  /** Competitions that have finished: a package for one of them is not sold. */
  finishedCompetitionIds: readonly string[];
  canEdit: boolean;
}

export function PackageList({ orgId, initialPackages, competitions, tiersOrgWide, tiersCompetitionIds, hasMonetize, billingHref, finishedCompetitionIds, canEdit }: PackageListProps) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [packages, setPackages] = useState<SponsorPackageRow[]>(initialPackages);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PackageDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Retired packages are records, not prices on the list: hidden unless the club asks (owner, 2026-11-11: "show retire switch? otherwise
  // hide retired"). Active first, then retired, whatever order `packages` is in - a local retire leaves the card where it was until the
  // re-read, and the server's own order must not be what keeps the retired ones last.
  const [showRetired, setShowRetired] = useState(false);
  const activePackages = packages.filter((p) => p.active);
  const retiredPackages = packages.filter((p) => !p.active);
  const shownPackages = showRetired ? [...activePackages, ...retiredPackages] : activePackages;

  const priceCents = parsePriceCents(draft.price);
  // The same placement answer the server enforces: a plan without tiers cannot save a package that needs them, however the draft got there.
  const draftScope = draft.competition_id === "" ? null : draft.competition_id;
  const placementOk = packageTiersFor(tiersOrgWide, tiersCompetitionIds, draftScope) || !placementNeedsTiers(draft.tier, draftScope);
  const canSave = draft.name.trim() !== "" && priceCents !== null && placementOk;

  /** Re-read the list from the server: its order, and each package's `used_by`. A failed re-read keeps what the write already showed. */
  async function reload() {
    setPackages(await apiV1<SponsorPackageRow[]>(`/api/v1/orgs/${orgId}/sponsor-packages`));
  }

  function openSheet() {
    setDraft(EMPTY_DRAFT);
    setSheetError(null);
    setNotice(null);
    setListError(null);
    setOpen(true);
  }
  function closeSheet() {
    setOpen(false);
    setDraft(EMPTY_DRAFT);
    setSheetError(null);
  }

  async function createPackage() {
    // `disabled` keeps a browser from calling this; the guard is here because a handler must not rely on its button.
    if (busy || !canSave || priceCents === null) return;
    setBusy(true);
    setSheetError(null);
    try {
      const created = await apiV1<SponsorPackageRow>(`/api/v1/orgs/${orgId}/sponsor-packages`, {
        method: "POST",
        json: {
          name: draft.name.trim(),
          price_cents: priceCents,
          currency: draft.currency,
          tier: draft.tier,
          ...(draft.competition_id !== "" ? { competition_id: draft.competition_id } : {}),
          includes_on_stream: draft.includes_on_stream,
        },
      });
      setPackages((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
      closeSheet();
      setNotice(msg("sponsors.pkg.created", { name: created.name }));
      await reload().catch(() => {});
    } catch (err) {
      setSheetError(msg(sponsorSaveErrorKey(err, "create_package")));
    } finally {
      setBusy(false);
    }
  }

  function retirePackage(pkg: SponsorPackageRow) {
    void (async () => {
      const ok = await confirm({
        title: msg("sponsors.pkg.retireConfirm.title"),
        body: msg("sponsors.pkg.retireConfirm.body", { name: pkg.name }),
        confirmLabel: msg("sponsors.pkg.retireConfirm.label"),
      });
      if (!ok) return;
      setBusy(true);
      setListError(null);
      setNotice(null);
      try {
        const retired = await apiV1<SponsorPackageRow>(`/api/v1/orgs/${orgId}/sponsor-packages/${pkg.id}`, { method: "DELETE" });
        setPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, ...retired, active: false } : p)));
        setNotice(msg("sponsors.pkg.retiredDone", { name: pkg.name }));
        await reload().catch(() => {});
      } catch (err) {
        setListError(msg(sponsorSaveErrorKey(err, "retire_package")));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div data-testid="sponsor-package-list" className="min-w-0 space-y-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 max-w-prose text-sm text-slate-500">{msg("sponsors.pkg.hint")}</p>
        {canEdit ? (
          <button type="button" data-testid="sponsor-pkg-create" onClick={openSheet} className="btn btn-primary max-md:min-h-11 max-md:w-full">
            <Plus className="h-4 w-4" aria-hidden />
            {msg("sponsors.pkg.create")}
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" data-testid="package-notice" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}
      {listError ? (
        <p role="alert" data-testid="package-list-error" className="text-sm text-red-600">
          {listError}
        </p>
      ) : null}
      {/* Only while something is retired: with none there is nothing to show, so no control. The house slim switch (the On stream
          tab's), named for what it controls with the count in it; its words do not change with its state (`aria-checked` says where it
          is). The label toggles it too, so the words are part of the tap, not only the 44px track. A view filter, not an edit: a viewer has it. */}
      {retiredPackages.length > 0 ? (
        <div data-testid="package-retired-filter" data-retired-count={retiredPackages.length} className="flex min-w-0 items-center justify-end gap-1">
          <label id="package-retired-switch-label" htmlFor="package-retired-switch" className="min-w-0 text-sm text-slate-700">
            {msg("sponsors.pkg.showRetired", { count: retiredPackages.length })}
          </label>
          {slimSwitch({
            id: "package-retired-switch",
            checked: showRetired,
            onToggle: () => setShowRetired((on) => !on),
            labelledBy: "package-retired-switch-label",
            testId: "package-retired-switch",
          })}
        </div>
      ) : null}
      {packages.length === 0 ? (
        <p data-testid="package-empty" className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
          {msg("sponsors.pkg.empty")}
        </p>
      ) : shownPackages.length === 0 ? (
        // Every package is retired and the switch is off: the list is not empty, so it must not say "no packages yet" - and the switch
        // above is the way to them.
        <p data-testid="package-all-retired" className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
          {msg("sponsors.pkg.allRetired")}
        </p>
      ) : (
        // The cards sit directly in the grid: a wrapper between a grid and its card would end the equal-height stretch.
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shownPackages.map((pkg) => (
            <PackageCard
              key={pkg.id}
              pkg={pkg}
              competitions={competitions}
              finished={pkg.competition_id !== null && finishedCompetitionIds.includes(pkg.competition_id)}
              canEdit={canEdit}
              busy={busy}
              onRetire={retirePackage}
            />
          ))}
        </div>
      )}
      {/* What a tier is, under the price list: it explains the cards above, and an empty list needs it most (owner, 2026-11-11). A fold at
          every width, open only while the list is empty; an editor on a plan without tiers gets the billing link on its plan line. */}
      <TierLegend tiersOrgWide={tiersOrgWide} billingHref={billingHref} canEdit={canEdit} startOpen={packages.length === 0} />
      <p data-testid="package-online-note" className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-slate-500">
        {hasMonetize ? (
          <span>{msg("sponsors.pkg.onlineNote")}</span>
        ) : (
          <>
            <span>{msg("sponsors.pkg.onlineLocked")}</span>
            <Link data-testid="package-online-upgrade" href={billingHref} className={LOCK_LINK}>
              {msg("sponsors.dealSheet.upgrade")}
            </Link>
          </>
        )}
      </p>
      {open ? (
        <PackageCreateSheet
          draft={draft}
          onChange={setDraft}
          onSubmit={() => void createPackage()}
          onClose={closeSheet}
          competitions={competitions}
          tiersOrgWide={tiersOrgWide}
          tiersCompetitionIds={tiersCompetitionIds}
          busy={busy}
          canSave={canSave}
          error={sheetError}
          billingHref={billingHref}
        />
      ) : null}
    </div>
  );
}
