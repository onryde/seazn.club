// RS005 W2a — the Registrants tab's filter bar (task 3): a plain
// `<form method="GET">` so the surface needs no JavaScript, stays
// shareable/back-buttonable, and the seven-width e2e matrix can drive it.
// Server-rendered (no "use client"), so this pulls `t`/`getDictionary`
// straight from @/lib/i18n — same as page.tsx and unlike the Settings tab's
// row/panel (which are client components and must use i18n-runtime instead,
// gotcha 6 in the dispatch).
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantFilters } from "@/components/registration-hub-registrant-filters";
import { getDictionary, t } from "@/lib/i18n";
import type { RegistrantsFilters, DivisionOption } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

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

const DIVISIONS: DivisionOption[] = [
  { id: "div-1", name: "Open Singles" },
  { id: "div-2", name: "Mixed Doubles" },
];

const ACTION = "/o/riverside/c/summer-league/registration";
const CLEAR_HREF = "/o/riverside/c/summer-league/registration?tab=registrants";

function render(filters: RegistrantsFilters = DEFAULT_FILTERS) {
  return RegistrationHubRegistrantFilters({
    dict,
    action: ACTION,
    filters,
    divisions: DIVISIONS,
    clearHref: CLEAR_HREF,
  });
}

function form() {
  return walk(render()).find((e) => e.type === "form")!;
}

describe("RegistrationHubRegistrantFilters — the form itself", () => {
  it("is a plain GET form posting to the given action — no client JS", () => {
    const f = form();
    expect(propsOf(f).method).toBe("GET");
    expect(propsOf(f).action).toBe(ACTION);
    expect(propsOf(f).onSubmit).toBeUndefined();
  });

  it("carries a hidden tab=registrants input, so the action's bare path plus the form fields reconstructs ?tab=registrants on submit", () => {
    const hidden = walk(render()).find(
      (e) => e.type === "input" && propsOf(e).type === "hidden" && propsOf(e).name === "tab",
    );
    expect(hidden).toBeTruthy();
    expect(propsOf(hidden!).value).toBe("registrants");
  });
});

describe("status filter", () => {
  it("offers every real status value plus an 'all' option, translated", () => {
    const select = walk(render()).find((e) => e.type === "select" && propsOf(e).name === "status")!;
    const optionValues = walk(select).filter((e) => e.type === "option").map((e) => propsOf(e).value);
    expect(optionValues).toEqual([
      "",
      "pending",
      "paid",
      "confirmed",
      "waitlisted",
      "withdrawn",
      "expired",
      "rejected",
    ]);
    const allOption = walk(select).find((e) => e.type === "option" && propsOf(e).value === "")!;
    expect(textOf(allOption)).toBe(t(dict, "reg.hub.registrants.filters.statusAll"));
    const paidOption = walk(select).find((e) => e.type === "option" && propsOf(e).value === "paid")!;
    expect(textOf(paidOption)).toBe(t(dict, "reg.hub.registrants.status.paid"));
  });

  it("pre-selects the current filter value via defaultValue (uncontrolled — server-rendered)", () => {
    const select = walk(render({ ...DEFAULT_FILTERS, status: "confirmed" })).find(
      (e) => e.type === "select" && propsOf(e).name === "status",
    )!;
    expect(propsOf(select).defaultValue).toBe("confirmed");
  });

  it("defaults to the empty (all) option when no status filter is active", () => {
    const select = walk(render()).find((e) => e.type === "select" && propsOf(e).name === "status")!;
    expect(propsOf(select).defaultValue).toBe("");
  });
});

describe("division filter", () => {
  it("offers one option per division it is given, plus an 'all' option", () => {
    const select = walk(render()).find((e) => e.type === "select" && propsOf(e).name === "division_id")!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["", "div-1", "div-2"]);
    expect(textOf(options[1]!)).toBe("Open Singles");
    expect(textOf(options[2]!)).toBe("Mixed Doubles");
  });

  it("pre-selects the current division filter", () => {
    const select = walk(render({ ...DEFAULT_FILTERS, divisionId: "div-2" })).find(
      (e) => e.type === "select" && propsOf(e).name === "division_id",
    )!;
    expect(propsOf(select).defaultValue).toBe("div-2");
  });
});

describe("kind filter", () => {
  it("offers team/individual/pair plus an 'all' option, using the SAME divset.entrants.kind.* labels the Settings tab already uses", () => {
    const select = walk(render()).find((e) => e.type === "select" && propsOf(e).name === "kind")!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["", "team", "individual", "pair"]);
    const teamOption = options.find((o) => propsOf(o).value === "team")!;
    expect(textOf(teamOption)).toBe(t(dict, "divset.entrants.kind.team"));
  });
});

describe("free_agent / consent_pending checkboxes", () => {
  it("are unchecked and off by default, name/value matching the API's own 1/0 convention", () => {
    const tree = walk(render());
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    expect(propsOf(freeAgent).type).toBe("checkbox");
    expect(propsOf(freeAgent).value).toBe("1");
    expect(propsOf(freeAgent).defaultChecked).toBeFalsy();

    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(consentPending).type).toBe("checkbox");
    expect(propsOf(consentPending).value).toBe("1");
    expect(propsOf(consentPending).defaultChecked).toBeFalsy();
  });

  it("reflect an active filter via defaultChecked", () => {
    const tree = walk(render({ ...DEFAULT_FILTERS, freeAgent: true, consentPending: true }));
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(freeAgent).defaultChecked).toBe(true);
    expect(propsOf(consentPending).defaultChecked).toBe(true);
  });
});

describe("search (q) and sort", () => {
  it("pre-fills the search text via defaultValue", () => {
    const input = walk(render({ ...DEFAULT_FILTERS, text: "Alex" })).find(
      (e) => e.type === "input" && propsOf(e).name === "q",
    )!;
    expect(propsOf(input).defaultValue).toBe("Alex");
    expect(propsOf(input).type).toBe("text");
  });

  it("sort offers newest/oldest and pre-selects the current value", () => {
    const select = walk(render({ ...DEFAULT_FILTERS, sort: "oldest" })).find(
      (e) => e.type === "select" && propsOf(e).name === "sort",
    )!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["newest", "oldest"]);
    expect(propsOf(select).defaultValue).toBe("oldest");
  });
});

describe("submit + clear", () => {
  it("has a submit button", () => {
    const button = walk(render()).find((e) => e.type === "button" && propsOf(e).type === "submit");
    expect(button).toBeTruthy();
  });

  it("shows NO clear-filters link when nothing is active — there is nothing to clear", () => {
    const tree = walk(render(DEFAULT_FILTERS));
    const clearLink = tree.find((e) => propsOf(e).href === CLEAR_HREF);
    expect(clearLink).toBeUndefined();
  });

  it("shows a clear-filters link at clearHref once a filter is active", () => {
    const tree = walk(render({ ...DEFAULT_FILTERS, status: "paid" }));
    const clearLink = tree.find((e) => propsOf(e).href === CLEAR_HREF);
    expect(clearLink).toBeTruthy();
  });
});
