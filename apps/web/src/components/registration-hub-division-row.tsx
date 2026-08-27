// Registration hub — Settings tab, one division's row (RS004 W3/W3c/W4,
// design §5, "Scan line" treatment). Status pill, window (ORG timezone),
// capacity meter, fee, entrant kind, category/age badges, approval mode,
// free-agent flag, the public register link (or the private-competition
// notice), and the Configure button that opens the row-click config panel
// — wiring only, `context.onOpen` is owned by the settings-panel that
// mounts the panel.
//
// Built for an organiser scrolling a competition with ~20 divisions, who
// scans for two things first — which divisions are OPEN, and which are
// NEAR CAPACITY — before caring about anything else on the row. So the
// status pill leads every row (proved by a test: status text precedes the
// division name in reading order), capacity rides on the SAME primary
// line right after the name, and every other fact (window, entrant kind,
// approval, category/age, free agents) drops to one small muted secondary
// line. Two lines per division at rest.
import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
// `@/lib/i18n` is `server-only`, and this module is pulled into the client
// bundle by registration-hub-settings-panel.tsx ("use client"). Importing it
// here builds fine under tsc and vitest and fails only in `next build`
// ("'server-only' cannot be imported from a Client Component module"), which
// is how it got this far. `t` and the `Dict` type have server-free homes.
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
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
  /** Registrations in `waitlisted` status (RS005 F4) — carried through to
   *  the row-click config panel's Money section, which warns an organiser
   *  editing the fee that promoting any of these re-prices them at the
   *  LIVE fee. Not read by this row card itself. */
  waitlisted: number;
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
  /** RS005 W2a follow-up. The hub used to 404 anyone who could not edit
   *  (RS004 ruling 2), so every reader of this row was an owner or admin and
   *  Configure could render unconditionally. The owner reversed that on
   *  2026-08-25 — viewers now get the hub read-only — which left a viewer
   *  looking at a Configure button that opens a panel whose every save 403s.
   *
   *  The control is ABSENT rather than disabled, per the same ruling: the API
   *  refuses a viewer regardless, so a greyed button would only advertise a
   *  capability they do not have. */
  canEdit: boolean;
}

const STATUS_STYLE: Record<RegistrationHubStatus, string> = {
  open: "bg-green-100 text-green-700",
  scheduled: "bg-amber-100 text-amber-700",
  closed: "bg-slate-100 text-slate-500",
};

// Exported (not a private closure) so a test can identify a rendered badge
// by element TYPE — _hook-harness.tsx's walk() never invokes a child
// component (it only reads the static `.props.children` already authored on
// it), so the outer `<Chip>` element in the tree carries no `className` of
// its own; that lives on the `<span>` INSIDE Chip's own render output,
// which walk() never reaches without calling Chip(props) directly.
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-purple-100 bg-purple-50/60 px-2 py-0.5 text-[11px] font-medium text-purple-700">
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

  // Finding 2: resolveDivisionCategory maps null -> "open" so OTHER
  // derivations never have to special-case "no restriction set" — but that
  // same "open" is also the status pill's own vocabulary ("Open now").
  // Rendering a badge for it read as "Closed … Open" on a closed division:
  // two unrelated facts (status, category) colliding on the same word.
  // Null/open carries no restriction to announce, so no badge; only an
  // explicit mens/womens/mixed restriction is worth one.
  const category = resolveDivisionCategory(row.category);
  const categoryLabel = category === "open" ? null : t(dict, `reg.hub.row.category.${category}`);

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

  // Finding 3: a closed division's public register link would only ever
  // refuse the visitor, so Copy/Open/QR controls for it are dead weight at
  // best and misleading at worst. A SCHEDULED division still gets them — an
  // organiser needs the link before the window opens, to share it in
  // advance. The private-competition gate applies on top, unconditionally
  // on status: a private competition always shows the notice, never the
  // link, exactly as before this fix.
  const showLinkControls = context.showRegisterLink && status !== "closed";

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
        {context.canEdit && (
          <button
            type="button"
            data-registration-hub-row-configure
            onClick={() => context.onOpen(row.division_id)}
            aria-label={t(dict, "reg.hub.row.configure", { name: row.name })}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-purple-50 hover:text-purple-700"
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>

      {/* Secondary line: everything else, small and muted — present, never
          dropped, just visually quieter than the scan line above. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{windowText}</span>
        <span>{entrantKindText}</span>
        <span>{approvalText}</span>
        {categoryLabel && <Chip>{categoryLabel}</Chip>}
        {ageLabel && <Chip>{ageLabel}</Chip>}
        {row.allow_free_agents && <Chip>{t(dict, "reg.hub.row.freeAgents")}</Chip>}
      </div>

      {!context.showRegisterLink && (
        <div>
          <p className="rounded-lg border border-amber-100 bg-amber-50 p-2 text-xs text-amber-800">
            {t(dict, "div.registrations.privateNotice")}
          </p>
        </div>
      )}
      {showLinkControls && (
        <CopyLink
          path={context.registerHref}
          qrFileName={context.registerQrFileName}
          label={t(dict, "div.registrations.publicLink.title")}
        />
      )}
    </div>
  );
}
