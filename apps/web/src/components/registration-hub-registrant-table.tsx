import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { formatMinor, asCurrency } from "@/lib/currency";
import { fmtDateTime } from "@/lib/format";
import { deriveCapacityMeter } from "@/components/registration-hub-row-derive";
import { REGISTRANT_STATUS_STYLE, registrantRowAnchor } from "@/components/registration-hub-registrant-derive";
import type { RegistrationFormField } from "@/server/api-v1/schemas";
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type {
  RegistrantDetails,
  RegistrantRosterPlayer,
  RegistrantCartSibling,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import { RegistrationHubRegistrantDetail } from "@/components/registration-hub-registrant-detail";

/**
 * The kind cell (task 4): the entrant-kind label, reusing the SAME
 * `divset.entrants.kind.*` keys the Settings tab's division rows already
 * use. A team ALSO shows its roster fill — `deriveCapacityMeter` is the
 * SAME helper the Settings tab's division-capacity meter uses
 * (registration-hub-row-derive.ts), reused here for a different count
 * (roster players, not division registrants) so the "capacity<=0 treated as
 * unlimited" defensive normalisation stays in one place.
 *
 * Treatment for `roster_cap === null` (a sport with no `lineup` config,
 * i.e. genuinely unlimited): "{count}/∞" — compact enough for a table
 * cell, and the ∞ symbol needs no translation of its own (only the
 * surrounding template does, so a locale can still adjust punctuation).
 * Individual/pair entries show no fill number at all: roster composition
 * is a TEAM concept — an individual/pair sport's own `lineup.size` is a
 * capacity fact about the SPORT, not something worth a fill count next to
 * a single named entrant.
 */
export function renderRegistrantKindCell(
  row: Pick<
    RegistrationListRow,
    "entrant_kind" | "roster_count" | "roster_cap" | "free_agent" | "assigned_team_name"
  >,
  dict: Dict,
): ReactNode {
  // RS009 — a solo sign-up is stored with the DIVISION's entrant_kind, which
  // on these divisions is 'team'. Rendered through the branch below it
  // therefore read "Team · 1/23": it called one person a team, and drew a
  // roster meter for a roster they do not have (the 1 is their own player
  // row, and the 22 "empty places" are the receiving team's, not theirs).
  //
  // Found by looking at the shipped table, not by a test — every assertion
  // in this file was about entrant_kind, which was correct.
  if (row.free_agent) {
    return (
      <span className="flex flex-col">
        <span>{t(dict, "reg.hub.registrants.table.soloSignUp")}</span>
        <span className="text-xs text-slate-500">
          {row.assigned_team_name
            ? t(dict, "reg.hub.registrants.table.soloAssigned", { team: row.assigned_team_name })
            : t(dict, "reg.hub.registrants.table.soloWaiting")}
        </span>
      </span>
    );
  }

  const label = t(dict, `divset.entrants.kind.${row.entrant_kind}`);
  if (row.entrant_kind !== "team") return <span>{label}</span>;

  const meter = deriveCapacityMeter(row.roster_count, row.roster_cap);
  const fillText =
    meter.capacity !== null
      ? t(dict, "reg.hub.registrants.table.rosterFill", { count: meter.count, cap: meter.capacity })
      : t(dict, "reg.hub.registrants.table.rosterFillUnlimited", { count: meter.count });
  return (
    <span className="flex flex-col">
      <span>{label}</span>
      <span data-registration-hub-registrant-roster-fill className="text-xs tabular-nums text-slate-500">
        {fillText}
      </span>
    </span>
  );
}

/**
 * The status cell (task 4): a pill (REGISTRANT_STATUS_STYLE, keyed against
 * the real status union). RULING (task 4, implemented as stated): there is
 * NO separate waitlist section — one table, one row renderer, for every
 * status including waitlisted. `waitlist_position` renders in its own
 * spot in THIS same cell rather than a second table/section; a "waitlist"
 * status filter (registration-hub-registrant-filters.tsx) is how an
 * organiser scopes to the queue instead. A second renderer for "the
 * waitlisted subset" is exactly what this session deleted
 * waitlist-queue.tsx to avoid re-introducing.
 */
export function renderRegistrantStatusCell(
  row: Pick<RegistrationListRow, "status" | "waitlist_position">,
  dict: Dict,
): ReactNode {
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span
        data-registration-hub-registrant-status={row.status}
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${REGISTRANT_STATUS_STYLE[row.status]}`}
      >
        {t(dict, `reg.hub.registrants.status.${row.status}`)}
      </span>
      {row.status === "waitlisted" && row.waitlist_position !== null && (
        <span className="text-xs tabular-nums text-slate-500">
          {t(dict, "reg.hub.registrants.table.waitlistPosition", { position: row.waitlist_position })}
        </span>
      )}
    </span>
  );
}

/** The payment cell: the entry's own fee (`row.fee_cents === 0` reuses the
 *  Settings row's existing "Free" copy — same concept, same key), plus a
 *  refund note when this entry has actually been refunded anything. Scoped
 *  deliberately narrow for a READ surface: no mark-paid/refund CONTROLS
 *  here, those are mutating actions out of W2a's scope.
 *
 *  RS005 F2 finding 2: a WAITLISTED entry's `amount_cents` is forced to 0 at
 *  submit regardless of the division's real fee (registration-submit.ts:542
 *  — they are never charged at submit, only on promotion) — reading that as
 *  "Free" told an organiser a fee-bearing division's waitlisted entrant
 *  owed nothing. Checked before the amount_cents branch: this row alone
 *  cannot say what the division's LIVE fee actually is, so this says only
 *  what's actually known — nothing has been charged yet. Reuses
 *  `deriveRegistrantPaymentState`'s own "waitlisted" copy
 *  (registration-hub-registrant-derive.ts) rather than minting a second
 *  string with the same meaning. */
export function renderRegistrantPaymentCell(
  row: Pick<RegistrationListRow, "amount_cents" | "refunded_cents" | "currency" | "status">,
  dict: Dict,
): ReactNode {
  const currency = asCurrency(row.currency);
  const amountText =
    row.status === "waitlisted"
      ? t(dict, "reg.hub.registrants.detail.paymentState.waitlisted")
      : row.amount_cents === 0
        ? t(dict, "reg.hub.row.fee.free")
        : formatMinor(row.amount_cents, currency);
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{amountText}</span>
      {row.refunded_cents > 0 && (
        <span className="text-xs tabular-nums text-amber-700">
          {t(dict, "reg.hub.registrants.table.refunded", { amount: formatMinor(row.refunded_cents, currency) })}
        </span>
      )}
    </span>
  );
}

export interface RegistrationHubRegistrantTableContext {
  dict: Dict;
  /** organizations.timezone (or DEFAULT_TZ) — the SAME org-level tz the
   *  Settings tab's window column renders in, never browser/server-local. */
  orgTz: string;
  /** RS005 W2b: gates the row-expand detail's mutating controls (today,
   *  only the join-code copy) — ABSENT for a viewer, never disabled (owner
   *  ruling, 2026-08-25). */
  canEdit: boolean;
  /** The Registrants tab's own URL with NO filters — a cart-sibling link
   *  (registration-hub-registrant-detail.tsx) needs this rather than the
   *  current (possibly filtered) URL, or a sibling excluded by the active
   *  filter would link nowhere. Same value as the panel's own `clearHref`. */
  baseHref: string;
}

/**
 * RS005 W2c: the column template shared by the ≥sm header row
 * (RegistrationHubRegistrantTable, below) and every row's own aligned-
 * columns block (RegistrationHubRegistrantRow, below) — ONE exported
 * constant, so the two can never drift out of alignment with each other:
 * a header whose tracks don't EXACTLY match a row's own tracks looks
 * broken even a few px off. 6 tracks: name, division, kind, status,
 * payment, submitted-at. The expand chevron is deliberately NOT a 7th
 * track here — it's a fixed-width flex sibling of this grid in both the
 * header and every row, so this template only ever has to describe the
 * six real data columns.
 *
 * `sm` (640px — Tailwind's unchanged default; globals.css's `@theme
 * inline` adds `--breakpoint-xs` but never redefines `sm`) is the SAME
 * breakpoint `ui/responsive-table.tsx` already split desktop/mobile on
 * before this row format existed (its `hidden sm:block` / `sm:hidden`
 * pair), so reusing it keeps this table's transition unsurprising. It
 * also lands strictly between the widest "phone" e2e project (430) and
 * the narrowest "tablet" one (768), so the seven-width matrix never lands
 * ON the transition itself.
 *
 * `minmax(0, Nfr)` on every track, never a bare `Nfr`: a bare fr track's
 * implicit minimum is `auto` (its content's own intrinsic width), which
 * is the classic CSS grid trap — a long team name would refuse to shrink
 * below its own width and blow the row (and the page) out horizontally.
 * `minmax(0, …)` removes that floor; pairing it with `min-w-0` on every
 * cell (both below) is the other half of the same trap — the track can
 * shrink, but the cell's own box also has to be told it's allowed to.
 */
export const REGISTRANT_GRID_COLS =
  "sm:grid sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.3fr)] sm:items-center sm:gap-x-4";

/** Muted caps label shared by every ≥sm header cell — same register as
 *  registration-hub-registrant-detail.tsx's own SECTION_HEADING, minus
 *  the bottom margin that only made sense stacked above its own section. */
const REGISTRANT_HEADER_CELL = "truncate text-xs font-semibold uppercase tracking-wide text-slate-400";

/**
 * Registration hub — Registrants tab, ONE row (RS005 W2a task 4 + W2b task
 * 1/2). A native `<details>/<summary>` disclosure — no `onToggle` handler,
 * matching W2a's zero-client-JS surface: RS004's own `Disclosure`
 * (registration-hub-config-panel.tsx) once hand-typed that handler's event
 * shape wrong in a way `tsc` could not catch, and the fix there was a real
 * DOM event type, not removing the handler — but THIS row has no need for
 * one at all (nothing forces it open/closed programmatically), so the
 * simplest fix that cannot reproduce that bug is to have no handler.
 *
 * The `<summary>` is the SAME scan line W2a's table cell/mobile-card
 * rendered (name + status pill, then division/kind/payment/submitted-at) —
 * reusing the exact cell-content functions below keeps that identical
 * regardless of which breakpoint is looking at it, now unified into ONE
 * markup path rather than a separate desktop-`<table>`/mobile-card split
 * (ui/responsive-table.tsx cannot host a `<details>` per row: a `<tr>`'s
 * content model only accepts `<td>/<th>` children, so an expand-in-place
 * design forces this row OUT of real `<table>` markup, the same way the
 * Settings tab's own per-division row already is — registration-hub-
 * division-row.tsx is a `<div>` card, not a `<tr>`, for the same reason).
 *
 * RS005 W2c: the `<summary>` now renders BOTH a phone-card block (`sm:hidden`
 * — the original treatment, untouched, just newly scoped below `sm`) and an
 * aligned-columns block (`hidden sm:grid`, REGISTRANT_GRID_COLS) that only
 * exists at `sm` and up, toggled by plain CSS visibility rather than by
 * conditional rendering — the same "duplicate content, let `hidden`/
 * `sm:hidden` pick one" technique `ui/responsive-table.tsx` already used for
 * its desktop `<table>` vs. phone `<ul>` split, just folded into one
 * `<summary>` instead of two top-level siblings (the `<details>` constraint
 * this file's own header explains). `display:none` removes a block from the
 * accessibility tree entirely, so this never double-announces a row to a
 * screen reader — exactly one of the two blocks exists in the a11y tree at
 * any given viewport.
 */
export function RegistrationHubRegistrantRow({
  row,
  context,
  roster,
  siblings,
  formFields,
}: {
  row: RegistrationListRow;
  context: RegistrationHubRegistrantTableContext;
  roster: RegistrantRosterPlayer[];
  siblings: RegistrantCartSibling[];
  formFields: RegistrationFormField[];
}) {
  const { dict, orgTz, canEdit, baseHref } = context;

  return (
    <details
      id={registrantRowAnchor(row.id)}
      data-registration-hub-registrant-row
      data-registration-id={row.id}
      className="card group overflow-hidden p-0"
    >
      {/* list-none + both marker rules: same treatment as config-panel.tsx's
          Disclosure — a native disclosure triangle otherwise shows via TWO
          different mechanisms depending on engine, alongside the chevron. */}
      <summary className="marker:content-none flex cursor-pointer list-none items-start justify-between gap-3 p-4 sm:items-center [&::-webkit-details-marker]:hidden">
        {/* Below sm: the original stacked card, untouched but for the new
            sm:hidden — every phone-width behaviour this earned stays
            exactly as proven. */}
        <span data-registration-hub-registrant-card className="flex min-w-0 flex-1 flex-col gap-1 sm:hidden">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-slate-900">{row.display_name}</span>
            {renderRegistrantStatusCell(row, dict)}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{row.division_name}</span>
            <span>{renderRegistrantKindCell(row, dict)}</span>
            <span>{renderRegistrantPaymentCell(row, dict)}</span>
            <span className="whitespace-nowrap">{fmtDateTime(orgTz, row.created_at)}</span>
          </span>
        </span>

        {/* ≥sm: the SAME six facts as aligned columns under the table's
            header row (RegistrationHubRegistrantTable, below), sharing
            REGISTRANT_GRID_COLS so the two can't drift apart. min-w-0 on
            every cell — see REGISTRANT_GRID_COLS's own comment for the
            trap this guards against. Only the name cell truncates (single
            line, ellipsis); the rest wrap within their own column rather
            than force the row wider. */}
        <span data-registration-hub-registrant-grid className={`hidden min-w-0 flex-1 ${REGISTRANT_GRID_COLS}`}>
          <span
            data-registration-hub-registrant-name-cell
            className="min-w-0 truncate text-sm font-medium text-slate-900"
          >
            {row.display_name}
          </span>
          <span className="min-w-0 text-sm text-slate-700">{row.division_name}</span>
          <span className="min-w-0 text-sm text-slate-700">{renderRegistrantKindCell(row, dict)}</span>
          <span className="min-w-0 text-sm text-slate-700">{renderRegistrantStatusCell(row, dict)}</span>
          <span className="min-w-0 text-sm text-slate-700">{renderRegistrantPaymentCell(row, dict)}</span>
          <span className="min-w-0 text-sm text-slate-700">{fmtDateTime(orgTz, row.created_at)}</span>
        </span>

        <ChevronDown
          className="mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180 sm:mt-0"
          strokeWidth={1.75}
          aria-hidden
        />
      </summary>
      <div className="border-t border-purple-100 p-4">
        <RegistrationHubRegistrantDetail
          row={row}
          dict={dict}
          orgTz={orgTz}
          canEdit={canEdit}
          roster={roster}
          siblings={siblings}
          formFields={formFields}
          baseHref={baseHref}
        />
      </div>
    </details>
  );
}

/**
 * Registration hub — Registrants tab, the row list (RS005 W2a task 4, W2b
 * task 1). One `RegistrationHubRegistrantRow` per registration — the per-row
 * roster/siblings/formFields slices are resolved HERE, once, off the
 * batched maps `fetchRegistrantDetails` built (task 3: 2 queries for the
 * whole page, never one per row) — `RegistrationHubRegistrantRow` itself
 * never touches a Map. Cart siblings are SELF-EXCLUDED here (the map is
 * self-inclusive by construction — see fetchRegistrantDetails) so the row
 * never has to filter its own id back out of its own props.
 */
export function RegistrationHubRegistrantTable({
  rows,
  context,
  details,
}: {
  rows: RegistrationListRow[];
  context: RegistrationHubRegistrantTableContext;
  details: RegistrantDetails;
}) {
  return (
    <div data-registration-hub-registrant-table aria-label={t(context.dict, "reg.hub.tab.registrants")} className="space-y-2">
      {/* ≥sm only (W2c task 2): column labels for the grid every row lays
          out below. `aria-hidden` — not merely visual-only via CSS —
          because this is a plain <div>, not a real ARIA table (the rows
          are <details> disclosures, never role="row"s inside a
          role="table"; giving only the header real table roles without
          the rows to match would be half an ARIA table, arguably more
          confusing than none), and every fact it labels already lives in
          each row's own rendered text either way. Hiding it outright is
          what stops a screen reader from announcing an unlabelled run of
          column names that corresponds to nothing else in the a11y tree —
          never announced as a data row, per the brief, because it is
          never announced at all. */}
      <div
        aria-hidden
        data-registration-hub-registrant-table-header
        className="hidden items-center gap-3 border-b border-purple-100 px-4 py-2 sm:flex"
      >
        <span className={`min-w-0 flex-1 ${REGISTRANT_GRID_COLS}`}>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.name")}</span>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.division")}</span>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.kind")}</span>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.status")}</span>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.payment")}</span>
          <span className={REGISTRANT_HEADER_CELL}>{t(context.dict, "reg.hub.registrants.table.submittedAt")}</span>
        </span>
        {/* Fixed-width spacer matching the chevron's own h-4 w-4 footprint
            (every row's own trailing flex sibling, outside the grid) — so
            the header's six columns end at the SAME right edge every
            row's six columns do. */}
        <span className="h-4 w-4 shrink-0" />
      </div>
      {rows.map((row) => (
        <RegistrationHubRegistrantRow
          key={row.id}
          row={row}
          context={context}
          roster={details.rosterByRegistration.get(row.id) ?? []}
          siblings={(details.siblingsByGroup.get(row.group_id) ?? []).filter((s) => s.id !== row.id)}
          formFields={details.formFieldsByRegistration.get(row.id) ?? []}
        />
      ))}
    </div>
  );
}
