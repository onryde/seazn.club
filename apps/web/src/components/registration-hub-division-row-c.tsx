// TEMP(RS004 variants) — Row design C: "Capacity-forward card".
//
// One of three design directions under review for the registration hub's
// Settings-tab division row (see registration-hub-variant.ts's header for
// the full scaffold explanation and deletion instructions). Reachable via
// ?variant=c; variant A (registration-hub-division-row.tsx) is the
// untouched control.
//
// Design idea: the brief's own second suggested direction — status and
// capacity foregrounded, everything else secondary. Where variant B
// (registration-hub-division-row-b.tsx) optimises for scanning MANY rows
// quickly, this one optimises for judging ONE division's fullness at a
// glance: a stat block (status pill + a large headline capacity figure)
// leads the card, the division name drops to a smaller secondary heading,
// and a full-width bar under the name carries the signature move — its
// COLOUR escalates as the division nears capacity (purple -> amber at 80%
// -> rose at/over 100%), so "which are near capacity" (the brief's own
// framing) is answered by colour, not just a number an organiser has to
// read and compare. Presentation-only: the same deriveCapacityMeter output
// variant A and B use, just re-coloured by its own percent.
//
// Every derivation, dictionary key and interactive affordance below is
// called exactly as variant A calls it — only the JSX shell (and the tone
// helper below) differs, so "same data, same behaviour, same accessible
// names" holds by construction.
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

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-purple-100 bg-purple-50/60 px-2.5 py-0.5 text-xs font-medium text-purple-700">
      {children}
    </span>
  );
}

/** The signature move of this variant: the capacity bar's own colour
 *  escalates as a division nears its cap, rather than staying a flat
 *  purple regardless of fill level (variant A/B's bar). Thresholds are a
 *  design call, not a derived value — 80% "near capacity" (amber) and
 *  100%+ "at/over capacity, likely waitlisting" (rose) are the two states
 *  an organiser most needs to notice at a glance. `percent` is already
 *  clamped to [0,100] by deriveCapacityMeter, so ">= 100" means "at or
 *  over the cap", never a stray value above 100. */
function capacityTone(percent: number): string {
  if (percent >= 100) return "bg-rose-500";
  if (percent >= 80) return "bg-amber-500";
  return "bg-purple-500";
}

export function RegistrationHubDivisionRowC({
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
  const headlineStat = capacity.percent !== null ? `${capacity.percent}%` : String(capacity.count);

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
      className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-start"
    >
      {/* Stat block: status + headline capacity figure, foregrounded.
          Row on mobile (compact height), column at sm+ (its own lane). */}
      <div className="flex shrink-0 flex-row items-center gap-4 sm:w-32 sm:flex-col sm:items-start sm:gap-2">
        <span
          data-registration-hub-status={status}
          className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLE[status]}`}
        >
          {t(dict, `reg.hub.row.status.${status}`)}
        </span>
        <div className="flex flex-col">
          <span className="text-3xl leading-none font-bold tabular-nums text-purple-700">{headlineStat}</span>
          <span className="mt-1 text-[11px] font-medium tracking-wide text-slate-400 uppercase">{capacityText}</span>
        </div>
      </div>

      {/* Main column: name (now secondary — smaller than the stat block),
          the colour-coded capacity bar, then everything else. */}
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-800">{row.name}</h3>
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

        <span aria-hidden className="block h-2 w-full overflow-hidden rounded-full bg-slate-100">
          {capacity.percent !== null && (
            <span
              className={`block h-full rounded-full ${capacityTone(capacity.percent)}`}
              style={{ width: `${capacity.percent}%` }}
            />
          )}
        </span>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
          <span>{windowText}</span>
          <span data-feature="registration.paid" className="font-medium text-slate-700">
            {feeText}
          </span>
          <span>{entrantKindText}</span>
          <span>{approvalText}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge>{categoryLabel}</Badge>
          {ageLabel && <Badge>{ageLabel}</Badge>}
          {row.allow_free_agents && <Badge>{t(dict, "reg.hub.row.freeAgents")}</Badge>}
        </div>

        <div>
          {context.showRegisterLink ? (
            <CopyLink
              path={context.registerHref}
              qrFileName={context.registerQrFileName}
              label={t(dict, "div.registrations.publicLink.title")}
            />
          ) : (
            <p className="rounded-lg border border-amber-100 bg-amber-50 p-2.5 text-xs text-amber-800">
              {t(dict, "div.registrations.privateNotice")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
