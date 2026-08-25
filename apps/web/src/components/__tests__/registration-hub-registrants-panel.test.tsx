// RS005 W2a replaces RS004 W2's placeholder with the real Registrants tab:
// export link + filter bar + table, or one of the two empty states (task 5).
//
// `walk()` never invokes a nested custom component (_hook-harness.tsx's own
// documented limitation) — RegistrationHubRegistrantTable/-Filters/-Empty
// are each proven independently in their own test files, so this file's job
// is proving the PANEL's own decision: which of the three (table / empty /
// empty-filtered) renders, and that each gets the right props — not
// re-proving what's inside them.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";
import { RegistrationHubRegistrantEmpty } from "@/components/registration-hub-registrant-empty";
import { RegistrationHubRegistrantFilters } from "@/components/registration-hub-registrant-filters";
import { RegistrationHubRegistrantTable } from "@/components/registration-hub-registrant-table";
import { getDictionary, t } from "@/lib/i18n";
import type { RegistrantsFilters, DivisionOption, RegistrantDetails } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { RegistrationListRow } from "@/server/usecases/registrations";

const dict = await getDictionary("en", "ui");

const DEFAULT_FILTERS: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  freeAgent: false,
  consentPending: false,
  text: "",
  sort: "newest",
};

const ACTIVE_FILTERS: RegistrantsFilters = { ...DEFAULT_FILTERS, status: "paid" };

const DIVISIONS: DivisionOption[] = [{ id: "div-1", name: "Open Singles" }];

const ROW = { id: "reg-1", display_name: "Alex Smith" } as unknown as RegistrationListRow;

const EMPTY_DETAILS: RegistrantDetails = {
  rosterByRegistration: new Map(),
  siblingsByGroup: new Map(),
  formFieldsByRegistration: new Map(),
};

const BASE_PROPS = {
  divisions: DIVISIONS,
  canEdit: false,
  dict,
  orgTz: "UTC",
  filtersAction: "/o/riverside/c/summer-league/registration",
  clearHref: "/o/riverside/c/summer-league/registration?tab=registrants",
  exportHref: "/api/v1/competitions/comp-1/registrations/export?sort=newest",
  emptyTitle: t(dict, "reg.hub.registrants.title"),
  emptyBody: t(dict, "reg.hub.registrants.body"),
  emptyCtaLabel: t(dict, "reg.hub.registrants.cta"),
  emptyCtaHref: "/o/riverside/c/summer-league/registration?tab=settings",
  details: EMPTY_DETAILS,
};

function render(rows: RegistrationListRow[], filters: RegistrantsFilters) {
  return RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows, filters });
}

describe("no registrations at all — zero rows, no active filter", () => {
  it("renders ONLY the designed empty state, RS004's exact copy — no filter bar, no export link, no table", () => {
    const tree = walk(render([], DEFAULT_FILTERS));
    const empty = tree.find((e) => e.type === RegistrationHubRegistrantEmpty)!;
    expect(empty).toBeTruthy();
    expect(propsOf(empty).variant).toBe("empty");
    expect(propsOf(empty).title).toBe(BASE_PROPS.emptyTitle);
    expect(propsOf(empty).body).toBe(BASE_PROPS.emptyBody);
    expect(propsOf(empty).ctaLabel).toBe(BASE_PROPS.emptyCtaLabel);
    expect(propsOf(empty).ctaHref).toBe(BASE_PROPS.emptyCtaHref);

    expect(tree.find((e) => e.type === RegistrationHubRegistrantFilters)).toBeUndefined();
    expect(tree.find((e) => e.type === RegistrationHubRegistrantTable)).toBeUndefined();
    expect(textOf(render([], DEFAULT_FILTERS))).not.toContain(t(dict, "reg.exportCsv"));
  });

  it("is never a literal TODO placeholder", () => {
    expect(textOf(render([], DEFAULT_FILTERS))).not.toContain("TODO");
  });
});

describe("filters matched nothing — zero rows, an active filter", () => {
  it("renders the OTHER empty state (task 5: not the same as 'no registrations at all')", () => {
    const tree = walk(render([], ACTIVE_FILTERS));
    const empty = tree.find((e) => e.type === RegistrationHubRegistrantEmpty)!;
    expect(empty).toBeTruthy();
    expect(propsOf(empty).variant).toBe("filtered");
    expect(propsOf(empty).title).toBe(t(dict, "reg.hub.registrants.emptyFiltered.title"));
    expect(propsOf(empty).body).toBe(t(dict, "reg.hub.registrants.emptyFiltered.body"));
    // Its cta clears the filters, not the "go to Settings" cta the other state uses.
    expect(propsOf(empty).ctaHref).toBe(BASE_PROPS.clearHref);
    expect(propsOf(empty).ctaLabel).toBe(t(dict, "reg.hub.registrants.filters.clear"));
  });

  it("STILL shows the filter bar — an organiser needs it to adjust or clear the filter that emptied the view", () => {
    const tree = walk(render([], ACTIVE_FILTERS));
    const filters = tree.find((e) => e.type === RegistrationHubRegistrantFilters)!;
    expect(filters).toBeTruthy();
    expect(propsOf(filters).filters).toEqual(ACTIVE_FILTERS);
  });

  it("does not render the table", () => {
    const tree = walk(render([], ACTIVE_FILTERS));
    expect(tree.find((e) => e.type === RegistrationHubRegistrantTable)).toBeUndefined();
  });
});

describe("rows present", () => {
  it("renders the filter bar and the table, not either empty state", () => {
    const tree = walk(render([ROW], DEFAULT_FILTERS));
    expect(tree.find((e) => e.type === RegistrationHubRegistrantFilters)).toBeTruthy();
    const table = tree.find((e) => e.type === RegistrationHubRegistrantTable)!;
    expect(table).toBeTruthy();
    expect(propsOf(table).rows).toEqual([ROW]);
    // RS005 W2b: context grew canEdit + baseHref (the row-expand detail's
    // join-code gate and cart-sibling links) — baseHref reuses clearHref,
    // the SAME filters-cleared URL the "filters matched nothing" empty
    // state's own CTA already points at.
    expect(propsOf(table).context).toEqual({
      dict,
      orgTz: "UTC",
      canEdit: BASE_PROPS.canEdit,
      baseHref: BASE_PROPS.clearHref,
    });
    expect(propsOf(table).details).toBe(EMPTY_DETAILS);
    expect(tree.find((e) => e.type === RegistrationHubRegistrantEmpty)).toBeUndefined();
  });

  it("threads canEdit into the table's context — true for an editor, false for a viewer", () => {
    let tree = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, canEdit: true }));
    let table = tree.find((e) => e.type === RegistrationHubRegistrantTable)!;
    expect((propsOf(table).context as { canEdit: boolean }).canEdit).toBe(true);

    tree = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, canEdit: false }));
    table = tree.find((e) => e.type === RegistrationHubRegistrantTable)!;
    expect((propsOf(table).context as { canEdit: boolean }).canEdit).toBe(false);
  });

  it("passes details straight through to the table, unmodified", () => {
    const details: RegistrantDetails = {
      rosterByRegistration: new Map([["reg-1", []]]),
      siblingsByGroup: new Map(),
      formFieldsByRegistration: new Map(),
    };
    const tree = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, details }));
    const table = tree.find((e) => e.type === RegistrationHubRegistrantTable)!;
    expect(propsOf(table).details).toBe(details);
  });

  it("passes filters straight through to the filter bar, unmodified", () => {
    const tree = walk(render([ROW], ACTIVE_FILTERS));
    const filters = tree.find((e) => e.type === RegistrationHubRegistrantFilters)!;
    expect(propsOf(filters).filters).toEqual(ACTIVE_FILTERS);
  });
});

describe("CSV export link — available to a viewer (owner ruling)", () => {
  it("renders at exportHref with the reg.exportCsv label, regardless of canEdit", () => {
    for (const canEdit of [true, false]) {
      const tree = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, canEdit }));
      const link = tree.find((e) => propsOf(e).href === BASE_PROPS.exportHref)!;
      expect(link).toBeTruthy();
      expect(textOf(link)).toBe(t(dict, "reg.exportCsv"));
    }
  });
});

describe("canEdit threading (W2a has no mutating controls yet — this only proves the prop reaches the DOM for W2b)", () => {
  it("tags the root with data-can-edit reflecting the prop", () => {
    const editorRoot = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, canEdit: true }))[0]!;
    expect(propsOf(editorRoot)["data-can-edit"]).toBe(true);

    const viewerRoot = walk(RegistrationHubRegistrantsPanel({ ...BASE_PROPS, rows: [ROW], filters: DEFAULT_FILTERS, canEdit: false }))[0]!;
    expect(propsOf(viewerRoot)["data-can-edit"]).toBe(false);
  });
});

describe("data hook", () => {
  it("carries its own root data hook for e2e/regression targeting, in every state", () => {
    for (const [rows, filters] of [
      [[], DEFAULT_FILTERS],
      [[], ACTIVE_FILTERS],
      [[ROW], DEFAULT_FILTERS],
    ] as const) {
      const root = walk(render([...rows], filters))[0]!;
      expect(propsOf(root)).toHaveProperty("data-registration-hub-registrants-panel");
    }
  });
});
