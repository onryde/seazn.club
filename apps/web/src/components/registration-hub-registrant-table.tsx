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
  row: Pick<RegistrationListRow, "entrant_kind" | "roster_count" | "roster_cap">,
  dict: Dict,
): ReactNode {
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
 *  here, those are mutating actions out of W2a's scope. */
export function renderRegistrantPaymentCell(
  row: Pick<RegistrationListRow, "amount_cents" | "refunded_cents" | "currency">,
  dict: Dict,
): ReactNode {
  const currency = asCurrency(row.currency);
  const amountText = row.amount_cents === 0 ? t(dict, "reg.hub.row.fee.free") : formatMinor(row.amount_cents, currency);
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
      <summary className="marker:content-none flex cursor-pointer list-none items-start justify-between gap-3 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
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
        <ChevronDown
          className="mt-1 h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
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
