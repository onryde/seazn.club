// The phone Filters sheet (B6 T21, spec §8 "Below md"): every filter plus Sort in
// ONE bottom sheet whose edits are STAGED — nothing navigates until "Show
// registrants", which applies them all with a single push. Split out of
// registration-hub-registrant-filters.tsx beside the pills; same rules as that
// file's sibling (no "use client", plain function called as a helper inside the
// island's render, nothing nested).
//
// The dialog is `components/modal.tsx` and nothing hand-rolled: it already owns
// aria-modal, the Tab focus trap, Escape, and returning focus to the trigger, and
// below `sm` it IS the bottom sheet (the `sheet-handle` grabber, `max-h-[85dvh]`
// with a scrolling body). It does NOT lock the page behind it from scrolling —
// no Modal in the app does — so this sheet does not either; the overlay is a
// full-screen fixed layer and the sheet's own body is the only thing that scrolls.
//
// Every control is uncontrolled, exactly like the bar's own: `defaultValue` from
// the URL's filters at the moment the sheet opens, read back out of the DOM by
// the form's submit handler. "Clear all" resets what is STAGED by remounting the
// controls with empty defaults (a new `key`), which a real browser needs since it
// never re-applies `defaultValue` to a node it already has; it does not navigate.
import type { FormEvent, ReactNode } from "react";
import { Modal } from "@/components/modal";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { RegistrantsFilters, DivisionOption } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import { divisionOptionEls, kindOptionEls, statusOptionEls } from "@/components/registration-hub-registrant-filter-pills";

export interface FilterSheetProps {
  dict: Dict;
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  statusOptions: readonly string[];
  kindOptions: readonly string[];
  /** A per-open unique id (`useId`): the Show button sits in the Modal's footer,
   *  outside the form, and reaches it through `form=<id>`; every field's `<label
   *  for>` pairs with `<id>-<name>`. */
  formId: string;
  /** The search box's text when the sheet opened — carried as a hidden field, so
   *  Show applies the filters AND the search in one push. */
  q: string;
  /** True after "Clear all": every control remounts with an empty default. */
  cleared: boolean;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
  onClose: () => void;
}

const FIELD_LABEL = "mb-1 block text-xs font-medium text-slate-500";

export function filterSheet(o: FilterSheetProps) {
  const { dict, filters, divisions, formId, cleared } = o;
  // A cleared sheet remounts every control: a real browser never re-applies
  // `defaultValue` to a node it already holds.
  const keyFor = (name: string) => `${name}:${cleared ? "cleared" : "open"}`;

  function selectField(name: string, label: string, defaultValue: string, children: ReactNode) {
    const id = `${formId}-${name}`;
    return (
      <div>
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
        <select key={keyFor(name)} id={id} name={name} defaultValue={defaultValue} className="input h-11 text-sm">
          {children}
        </select>
      </div>
    );
  }

  // A switch row: the whole 44px row is the tap target, the checkbox itself is
  // visually hidden (`sr-only`) and carries `role="switch"`, the track and thumb
  // are drawn from its `peer-checked` state.
  function switchRow(name: "free_agent" | "consent_pending", label: string, on: boolean) {
    return (
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-purple-200 bg-white px-3 text-sm text-slate-700 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-purple-600">
        <span className="min-w-0">{label}</span>
        <input
          key={keyFor(name)}
          type="checkbox"
          role="switch"
          name={name}
          value="1"
          defaultChecked={on}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="relative h-6 w-10 shrink-0 rounded-full bg-slate-400 transition peer-checked:bg-purple-600 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-4"
        />
      </label>
    );
  }

  return (
    <Modal
      title={t(dict, "reg.filters.sheetTitle")}
      onClose={o.onClose}
      closeSize="lg"
      footer={
        <>
          <button type="button" data-filter-sheet-clear onClick={o.onClear} className="btn min-h-11 px-2 text-purple-700 hover:bg-purple-50">
            {t(dict, "reg.filters.clearAll")}
          </button>
          <button type="submit" form={formId} data-filter-sheet-show className="btn btn-primary min-h-11 flex-1 px-3">
            {t(dict, "reg.filters.show")}
          </button>
        </>
      }
    >
      <form id={formId} data-filter-sheet-form onSubmit={o.onSubmit} className="grid gap-3 p-1">
        <input type="hidden" name="tab" value="registrants" />
        <input type="hidden" name="q" value={o.q} />
        {selectField(
          "status",
          t(dict, "reg.hub.registrants.filters.status"),
          cleared ? "" : (filters.status ?? ""),
          statusOptionEls(dict, o.statusOptions),
        )}
        {selectField(
          "division_id",
          t(dict, "reg.hub.registrants.filters.division"),
          cleared ? "" : (filters.divisionId ?? ""),
          divisionOptionEls(dict, divisions),
        )}
        {selectField(
          "kind",
          t(dict, "reg.hub.registrants.filters.kind"),
          cleared ? "" : (filters.kind ?? ""),
          kindOptionEls(dict, o.kindOptions),
        )}
        {switchRow("free_agent", t(dict, "reg.hub.registrants.filters.freeAgent"), !cleared && filters.freeAgent === true)}
        {switchRow(
          "consent_pending",
          t(dict, "reg.hub.registrants.filters.consentPending"),
          !cleared && filters.consentPending === true,
        )}
        {selectField(
          "sort",
          t(dict, "reg.hub.registrants.filters.sort"),
          cleared ? "newest" : filters.sort,
          <>
            <option value="newest">{t(dict, "reg.hub.registrants.filters.sortNewest")}</option>
            <option value="oldest">{t(dict, "reg.hub.registrants.filters.sortOldest")}</option>
          </>,
        )}
      </form>
    </Modal>
  );
}
