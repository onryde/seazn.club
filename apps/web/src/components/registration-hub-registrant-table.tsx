import type { ReactNode } from "react";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/responsive-table";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { formatMinor, asCurrency } from "@/lib/currency";
import { fmtDateTime } from "@/lib/format";
import { deriveCapacityMeter } from "@/components/registration-hub-row-derive";
import { REGISTRANT_STATUS_STYLE } from "@/components/registration-hub-registrant-derive";
import type { RegistrationListRow } from "@/server/usecases/registrations";

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
}

/**
 * Registration hub — Registrants tab table (RS005 W2a task 4). Columns:
 * name, division, kind (+ roster fill for a team), status (+ waitlist
 * position), payment, submitted-at. Built on the shared
 * ui/responsive-table.tsx (desktop `<table>`, phone stacked cards) rather
 * than a hand-rolled table, so the seven-width no-horizontal-scroll bar is
 * inherited rather than re-derived.
 */
export function RegistrationHubRegistrantTable({
  rows,
  context,
}: {
  rows: RegistrationListRow[];
  context: RegistrationHubRegistrantTableContext;
}) {
  const { dict, orgTz } = context;

  const columns: ResponsiveColumn<RegistrationListRow>[] = [
    { key: "name", header: t(dict, "reg.hub.registrants.table.name"), render: (r) => r.display_name },
    { key: "division", header: t(dict, "reg.hub.registrants.table.division"), render: (r) => r.division_name },
    { key: "kind", header: t(dict, "reg.hub.registrants.table.kind"), render: (r) => renderRegistrantKindCell(r, dict) },
    {
      key: "status",
      header: t(dict, "reg.hub.registrants.table.status"),
      render: (r) => renderRegistrantStatusCell(r, dict),
    },
    {
      key: "payment",
      header: t(dict, "reg.hub.registrants.table.payment"),
      render: (r) => renderRegistrantPaymentCell(r, dict),
    },
    {
      key: "submittedAt",
      header: t(dict, "reg.hub.registrants.table.submittedAt"),
      className: "whitespace-nowrap",
      render: (r) => fmtDateTime(orgTz, r.created_at),
    },
  ];

  return (
    <ResponsiveTable
      aria-label={t(dict, "reg.hub.tab.registrants")}
      columns={columns}
      rows={rows}
      keyOf={(r) => r.id}
      renderCard={(r) => (
        <div
          data-registration-hub-registrant-row
          data-registration-id={r.id}
          className="space-y-1.5"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-slate-900">{r.display_name}</span>
            {renderRegistrantStatusCell(r, dict)}
          </div>
          <div className="text-sm text-slate-600">{r.division_name}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>{renderRegistrantKindCell(r, dict)}</span>
            <span>{renderRegistrantPaymentCell(r, dict)}</span>
            <span>{fmtDateTime(orgTz, r.created_at)}</span>
          </div>
        </div>
      )}
    />
  );
}
