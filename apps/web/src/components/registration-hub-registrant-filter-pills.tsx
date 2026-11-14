// The faces of the Registrants tab's filter bar (B6 T20 pills, T21 chips) — split
// out of registration-hub-registrant-filters.tsx when T21 added the phone sheet,
// so the bar's own file is the mechanism (form, URL, debounce, sheet state) and
// this one is what each filter LOOKS like.
//
// No "use client" here on purpose: nothing in this file holds state or reads the
// browser. It is imported only by the filters island, so it ships in that client
// bundle, and its plain functions are called as helpers inside that component's
// render (never nested components: the node-env harness renders one component one
// level deep, and a nested one would hide every select below from it).
import type { ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { RegistrantsFilters, DivisionOption } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

/** The five narrowing controls a pill or chip can clear — the form's own field
 *  names, which are also the URL param names. `q` is not here: the search box is
 *  cleared by emptying it, and "Clear all" covers it. */
export const FILTER_NAMES = ["status", "division_id", "kind", "free_agent", "consent_pending"] as const;
export type FilterName = (typeof FILTER_NAMES)[number];

/** One filter, described once: what the pill, the chip and the Filters count all
 *  read, so they cannot disagree about whether a filter is set or what it says. */
export interface FilterSpec {
  name: FilterName;
  control: "select" | "toggle";
  /** The bare label ("Status"). */
  label: string;
  /** Select: the selected option value ("" = unset). Toggle: unused (""). */
  value: string;
  /** What a person reads on the pill/chip: "Status: Confirmed", the bare label for
   *  an unset select, and a toggle's own label always (its state is the checkbox). */
  text: string;
  set: boolean;
  /** The key that remounts the uncontrolled control when ITS OWN filter changes
   *  (see the filters file's header, finding 3): a select's value, a toggle's
   *  tri-state (`null`/`true`/`false` stay three distinct keys). */
  stateKey: string;
}

/** The five filters in the bar's order, from the server-sanitised filters. */
export function describeFilters(dict: Dict, filters: RegistrantsFilters, divisions: DivisionOption[]): FilterSpec[] {
  const select = (name: FilterName, label: string, valueText: string | null, value: string): FilterSpec => ({
    name,
    control: "select",
    label,
    value,
    text: valueText === null ? label : t(dict, "reg.filters.pill", { label, value: valueText }),
    set: valueText !== null,
    stateKey: value,
  });
  const toggle = (name: FilterName, label: string, on: boolean | null): FilterSpec => ({
    name,
    control: "toggle",
    label,
    value: "",
    text: label,
    set: on === true,
    stateKey: String(on),
  });
  // A division id that matches no option (stale link, foreign id) reads as unset
  // — never "Division: undefined".
  const divisionName = filters.divisionId ? (divisions.find((d) => d.id === filters.divisionId)?.name ?? null) : null;
  return [
    select(
      "status",
      t(dict, "reg.hub.registrants.filters.status"),
      filters.status ? t(dict, `reg.hub.registrants.status.${filters.status}`) : null,
      filters.status ?? "",
    ),
    select("division_id", t(dict, "reg.hub.registrants.filters.division"), divisionName, filters.divisionId ?? ""),
    select(
      "kind",
      t(dict, "reg.hub.registrants.filters.kind"),
      filters.kind ? t(dict, `divset.entrants.kind.${filters.kind}`) : null,
      filters.kind ?? "",
    ),
    toggle("free_agent", t(dict, "reg.hub.registrants.filters.freeAgent"), filters.freeAgent),
    toggle("consent_pending", t(dict, "reg.hub.registrants.filters.consentPending"), filters.consentPending),
  ];
}

// ── the three <select>'s options — shared by the pills and the phone sheet ────

export function statusOptionEls(dict: Dict, statusOptions: readonly string[]): ReactNode {
  return (
    <>
      <option value="">{t(dict, "reg.hub.registrants.filters.statusAll")}</option>
      {statusOptions.map((s) => (
        <option key={s} value={s}>
          {t(dict, `reg.hub.registrants.status.${s}`)}
        </option>
      ))}
    </>
  );
}

export function divisionOptionEls(dict: Dict, divisions: DivisionOption[]): ReactNode {
  return (
    <>
      <option value="">{t(dict, "reg.hub.registrants.filters.divisionAll")}</option>
      {divisions.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </>
  );
}

export function kindOptionEls(dict: Dict, kindOptions: readonly string[]): ReactNode {
  return (
    <>
      <option value="">{t(dict, "reg.hub.registrants.filters.kindAll")}</option>
      {kindOptions.map((k) => (
        <option key={k} value={k}>
          {t(dict, `divset.entrants.kind.${k}`)}
        </option>
      ))}
    </>
  );
}

// ── the pill face (md and up) ─────────────────────────────────────────────────

/** One shape for the three select pills and the two toggles (spec §8: every
 *  control 40px at md and up). The pill row only exists from md — below it the
 *  bar is the Filters button and the chips — so there is no 44px variant here.
 *  Unset = white with a violet hairline, the same violet `.input` and
 *  `.btn-ghost` borders use; set = the house `.chip` fill (purple-50,
 *  purple-700) with a stronger hairline. The hairline is an INSET RING, not a
 *  `border`: a border eats 1px a side from the padding box the absolutely
 *  positioned native select fills, so the select (the real tap target) would
 *  measure 38px inside a 40px pill. `max-w-full` + `min-w-0` + the face's
 *  `truncate` keep a 43-character division name inside its row. `text-sm`: the
 *  house small-control size, the same as `.input` and `.btn`. */
const PILL_BASE = "inline-flex h-10 min-w-0 max-w-full items-center rounded-full text-sm ring-1 ring-inset transition";
const PILL_UNSET = "bg-white text-slate-600 ring-purple-200 hover:bg-purple-50";
const PILL_SET = "bg-purple-50 font-medium text-purple-700 ring-purple-300";
/** `purple-400` on white is ~2.8:1; the focus ring must clear 3:1 (WCAG 1.4.11). */
const SELECT_FOCUS = "has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-purple-600";
const TOGGLE_FOCUS = "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-purple-600";

/** What the pills and chips need from the bar: the dictionary, where a "×" goes,
 *  and what a changed control does. */
export interface PillContext {
  dict: Dict;
  /** The full href that clears one filter (action + `clearOneHref`). */
  clearHref: (name: FilterName) => string;
  /** The auto-submit every pill control runs the instant it changes. */
  onChange: (e: { target: { form: HTMLFormElement | null } }) => void;
}

/**
 * A select pill is a real native `<select>` laid over the pill's own face
 * (`absolute inset-0 opacity-0`): the pill reads "Label: Value" (or the bare
 * label) from server truth, the select does the picking, so the GET form, the
 * auto-submit and `select[name=…]` all stay as they were. The face is
 * `pointer-events-none` so every tap lands on the select; the "×" sits above it
 * (`relative z-10`) and is a plain link — it works with no JS.
 *
 * The select's accessible name is the face's FULL text ("Status: Confirmed"), not
 * the bare label: WCAG 2.5.3 wants the name to contain what is drawn. Its `title`
 * is the same text — on the select, because the face takes no pointer events and
 * a tooltip needs one (a 43-character division is clipped at narrow widths).
 */
export function selectPill(ctx: PillContext, spec: FilterSpec, children: ReactNode) {
  return (
    <div
      data-filter-pill={spec.name}
      data-set={spec.set ? "true" : "false"}
      className={`relative ${PILL_BASE} ${spec.set ? PILL_SET : PILL_UNSET} ${SELECT_FOCUS}`}
    >
      <span className="pointer-events-none flex min-w-0 items-center pl-3">
        <span data-pill-text className="truncate">
          {spec.text}
        </span>
        {spec.set ? null : <ChevronDown className="ml-1.5 mr-2.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
      </span>
      <select
        key={`${spec.name}:${spec.stateKey}`}
        name={spec.name}
        aria-label={spec.text}
        title={spec.text}
        defaultValue={spec.value}
        onChange={ctx.onChange}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {children}
      </select>
      {spec.set && (
        <Link
          href={ctx.clearHref(spec.name)}
          data-filter-clear-one={spec.name}
          aria-label={t(ctx.dict, "reg.filters.clearOne", { label: spec.label })}
          className="relative z-10 ml-0.5 grid h-full w-9 shrink-0 place-items-center rounded-r-full text-purple-600 hover:bg-purple-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

/**
 * A toggle pill is a label around a visually-hidden native checkbox: the state IS
 * the checkbox, so the pill restyles itself the instant it is clicked
 * (`has-[:checked]`), before the navigation lands. Still uncontrolled and still
 * keyed on its own filter value (the filters file's header, finding 3). `null`
 * and an explicit `false` both render unchecked — only a real `true` is "set".
 */
export function togglePill(ctx: PillContext, spec: FilterSpec) {
  const name = spec.name;
  return (
    <label
      data-filter-pill={name}
      data-set={spec.set ? "true" : "false"}
      className={`relative cursor-pointer gap-2 px-3 ${PILL_BASE} ${spec.set ? PILL_SET : PILL_UNSET} has-[:checked]:bg-purple-50 has-[:checked]:ring-purple-300 has-[:checked]:font-medium has-[:checked]:text-purple-700 ${TOGGLE_FOCUS}`}
    >
      <input
        key={`${name}:${spec.stateKey}`}
        type="checkbox"
        name={name}
        value="1"
        defaultChecked={spec.set}
        onChange={ctx.onChange}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="grid h-4 w-4 shrink-0 place-items-center rounded border-[1.5px] border-slate-300 bg-white text-white peer-checked:border-purple-600 peer-checked:bg-purple-600 [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100"
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span data-pill-text className="truncate">
        {spec.text}
      </span>
    </label>
  );
}

// ── the chip face (below md) ──────────────────────────────────────────────────

/** A set filter on a phone: the same fill as a set pill, 44px tall (the house
 *  touch height) with a 44px-wide × — the only things on a phone's bar that are
 *  not the search box or the Filters button. */
const CHIP = `inline-flex h-11 min-w-0 max-w-full items-center rounded-full text-sm ${PILL_SET} ring-1 ring-inset`;

/** A removable chip. Unlike a pill, a chip is not a control: it reads the filter
 *  and offers its "×" (a plain link, so it works with no JS). Every one of the
 *  five filters — toggles included — has one, which is what makes this the real
 *  producer of `clearOneHref` for `free_agent` / `consent_pending`. */
export function chip(ctx: PillContext, spec: FilterSpec) {
  return (
    <span key={spec.name} data-filter-chip={spec.name} className={CHIP}>
      <span data-pill-text className="truncate pl-3 pr-1" title={spec.text}>
        {spec.text}
      </span>
      <Link
        href={ctx.clearHref(spec.name)}
        data-chip-clear={spec.name}
        aria-label={t(ctx.dict, "reg.filters.clearOne", { label: spec.label })}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-r-full text-purple-700 hover:bg-purple-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-600"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </Link>
    </span>
  );
}
