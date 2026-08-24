// TEMP(RS004 variants) — Row design B: "Scan line".
//
// One of three design directions under review for the registration hub's
// Settings-tab division row (see registration-hub-variant.ts's header for
// the full scaffold explanation and deletion instructions). Reachable via
// ?variant=b; variant A (registration-hub-division-row.tsx) is the
// untouched control.
//
// Design idea: built for an organiser scrolling a competition with ~20
// divisions, who scans for two things first — which divisions are OPEN,
// and which are NEAR CAPACITY (the RS004 dispatch's own framing) — before
// caring about anything else on the row. So the status pill leads every
// row (proved by a real test: status text precedes the division name in
// reading order), capacity rides on the SAME primary line right after the
// name, and every other fact (window, entrant kind, approval, category/
// age, free agents) drops to one small muted secondary line. Two lines per
// division at rest, versus variant A's five stacked bands — genuinely
// denser, not a colour tweak.
//
// Every derivation, dictionary key and interactive affordance below is
// called EXACTLY as variant A calls it (same pure functions from
// registration-hub-row-derive.ts/registration-hub-status.ts, same t() dict
// keys, the same <CopyLink> instance with the same props) — only the JSX
// shell differs, which is what makes "same data, same behaviour, same
// accessible names" true by construction rather than by a parallel
// re-implementation that could drift from A's.
import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
import { t } from "@/lib/i18n-runtime";
import { formatMinor } from "@/lib/currency";
import { deriveRegistrationStatus, type RegistrationHubStatus } from "@/components/registration-hub-status";
import {
  formatRegistrationWindow,
  deriveCapacityMeter,
  resolveDivisionCategory,
  deriveAgeBand,
} from "@/components/registration-hub-row-derive";
import type { RegistrationHubRowData, RegistrationHubRowContext } from "@/components/registration-hub-division-row";

const STATUS_STYLE: Record<RegistrationHubStatus, string> = {
  open: "bg-green-100 text-green-700",
  scheduled: "bg-amber-100 text-amber-700",
  closed: "bg-slate-100 text-slate-500",
};

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-purple-100 bg-purple-50/60 px-2 py-0.5 text-[11px] font-medium text-purple-700">
      {children}
    </span>
  );
}

export function RegistrationHubDivisionRowB({
  row,
  context,
}: {
  row: RegistrationHubRowData;
  context: RegistrationHubRowContext;
}) {
  const { dict } = context;

  const status = deriveRegistrationStatus(
    { enabled: row.enabled, opens_at: row.opens_at, closes_at: row.closes_at },
    context.now,
  );

  const windowLabel = formatRegistrationWindow(row.opens_at, row.closes_at, context.orgTz);
  const windowText =
    windowLabel.kind === "range"
      ? t(dict, "reg.hub.row.window.range", {
          opens: windowLabel.opens!,
          closes: windowLabel.closes!,
          zone: windowLabel.zone,
        })
      : windowLabel.kind === "opens"
        ? t(dict, "reg.hub.row.window.opens", { opens: windowLabel.opens!, zone: windowLabel.zone })
        : windowLabel.kind === "closes"
          ? t(dict, "reg.hub.row.window.closes", { closes: windowLabel.closes!, zone: windowLabel.zone })
          : t(dict, "reg.hub.row.window.none");

  const capacity = deriveCapacityMeter(row.taken, row.capacity);
  const capacityText =
    capacity.capacity !== null
      ? t(dict, "reg.hub.row.capacity.limited", { count: capacity.count, capacity: capacity.capacity })
      : t(dict, "reg.hub.row.capacity.unlimited", { count: capacity.count });

  const feeText = row.fee_cents === 0 ? t(dict, "reg.hub.row.fee.free") : formatMinor(row.fee_cents, context.currency);

  const category = resolveDivisionCategory(row.category);
  const categoryLabel = t(dict, `reg.hub.row.category.${category}`);

  const ageBand = deriveAgeBand(row.age_min, row.age_max);
  const ageLabel =
    ageBand.kind === "range"
      ? t(dict, "reg.hub.row.ageBand.range", { min: ageBand.min, max: ageBand.max })
      : ageBand.kind === "min"
        ? t(dict, "reg.hub.row.ageBand.min", { min: ageBand.min })
        : ageBand.kind === "max"
          ? t(dict, "reg.hub.row.ageBand.max", { max: ageBand.max })
          : null;

  const entrantKindText = row.entrant_kind ? t(dict, `divset.entrants.kind.${row.entrant_kind}`) : "—";
  const approvalText = row.approval ? t(dict, `reg.hub.row.approval.${row.approval}`) : "—";

  return (
    <div
      data-registration-hub-row
      data-division-id={row.division_id}
      className="card flex flex-col gap-1.5 px-4 py-3"
    >
      {/* Primary scan line: status leads (open/near-capacity is what an
          organiser checks first across 20 rows), then name, then capacity
          on the SAME line, fee, Configure. flex-wrap (never a fixed-column
          grid) so a long name or a narrow viewport reflows a line instead
          of overflowing — no min-width:0 trap, since nothing here is a
          CSS grid item. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          data-registration-hub-status={status}
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}
        >
          {t(dict, `reg.hub.row.status.${status}`)}
        </span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{row.name}</h3>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-slate-600">
          <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-slate-100">
            {capacity.percent !== null && (
              <span
                className="block h-full rounded-full bg-purple-500"
                style={{ width: `${capacity.percent}%` }}
              />
            )}
          </span>
          <span className="tabular-nums">{capacityText}</span>
        </div>
        <span data-feature="registration.paid" className="shrink-0 text-xs font-semibold tabular-nums text-slate-700">
          {feeText}
        </span>
        <button
          type="button"
          data-registration-hub-row-configure
          onClick={() => context.onOpen(row.division_id)}
          aria-label={t(dict, "reg.hub.row.configure", { name: row.name })}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-purple-50 hover:text-purple-700"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      {/* Secondary line: everything else, small and muted — present, never
          dropped, just visually quieter than the scan line above. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{windowText}</span>
        <span>{entrantKindText}</span>
        <span>{approvalText}</span>
        <Chip>{categoryLabel}</Chip>
        {ageLabel && <Chip>{ageLabel}</Chip>}
        {row.allow_free_agents && <Chip>{t(dict, "reg.hub.row.freeAgents")}</Chip>}
      </div>

      <div>
        {context.showRegisterLink ? (
          <CopyLink
            path={context.registerHref}
            qrFileName={context.registerQrFileName}
            label={t(dict, "div.registrations.publicLink.title")}
          />
        ) : (
          <p className="rounded-lg border border-amber-100 bg-amber-50 p-2 text-xs text-amber-800">
            {t(dict, "div.registrations.privateNotice")}
          </p>
        )}
      </div>
    </div>
  );
}
