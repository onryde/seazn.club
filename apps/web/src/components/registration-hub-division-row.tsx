// Registration hub — Settings tab, one division's row (RS004 W3/W3c, design
// §5). Status pill, window (ORG timezone), capacity meter, fee, entrant
// kind, category/age badges, approval mode, free-agent flag, the public
// register link (or the private-competition notice), and (W3c) the
// Configure button that opens the row-click config panel — wiring only,
// `context.onOpen` is owned by the settings-panel that mounts the panel;
// nothing else here changed shape or style from W3.
import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
import { t, type Dict } from "@/lib/i18n";
import { formatMinor, type Currency } from "@/lib/currency";
import { deriveRegistrationStatus, type RegistrationHubStatus } from "@/components/registration-hub-status";
import {
  formatRegistrationWindow,
  deriveCapacityMeter,
  resolveDivisionCategory,
  deriveAgeBand,
  type DivisionCategoryValue,
} from "@/components/registration-hub-row-derive";

export interface RegistrationHubRowData {
  division_id: string;
  name: string;
  category: DivisionCategoryValue | null;
  age_min: number | null;
  age_max: number | null;
  enabled: boolean;
  /** Null when the division has no `registration_settings` row yet
   *  (never configured) — rendered as a dash, matching the rest of the
   *  app's "not set" convention rather than inventing a placeholder value. */
  entrant_kind: "team" | "individual" | "pair" | null;
  opens_at: string | Date | null;
  closes_at: string | Date | null;
  capacity: number | null;
  fee_cents: number;
  approval: "auto" | "manual" | null;
  allow_free_agents: boolean;
  /** Spots currently held (SPOT_HOLDERS: pending/paid/confirmed) — the
   *  capacity meter's numerator. */
  taken: number;
}

/** Everything the row needs that is NOT per-division — computed once by the
 *  page and shared across every row, so it isn't re-derived per row. */
export interface RegistrationHubRowContext {
  dict: Dict;
  now: Date;
  /** `organizations.timezone` (or DEFAULT_TZ) — the org lane, never a
   *  per-division venue override and never users.timezone/the browser
   *  cookie (decision: a registration window is org-level). */
  orgTz: string;
  currency: Currency;
  /** The SAME public register URL for every row (routes.publicRegister) —
   *  one cart can span divisions, so there is no per-division page. */
  registerHref: string;
  registerQrFileName: string;
  /** competition.visibility !== "private". */
  showRegisterLink: boolean;
  /** W3c: opens the row-click config panel for the given division id. One
   *  shared callback (identity stable across every row), same reasoning as
   *  every other field here — the settings-panel owns which row is open. */
  onOpen: (divisionId: string) => void;
}

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

export function RegistrationHubDivisionRow({
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
      className="card flex flex-col gap-3 p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900">{row.name}</h3>
        <span
          data-registration-hub-status={status}
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
        >
          {t(dict, `reg.hub.row.status.${status}`)}
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

      <p className="text-sm text-slate-500">{windowText}</p>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-600">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100"
          >
            {capacity.percent !== null && (
              <span
                className="block h-full rounded-full bg-purple-500"
                style={{ width: `${capacity.percent}%` }}
              />
            )}
          </span>
          <span>{capacityText}</span>
        </div>
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
  );
}
