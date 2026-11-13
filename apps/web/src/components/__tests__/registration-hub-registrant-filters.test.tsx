// RS005 W2a task 3 / R4 task 1 / R5 task 2 — the Registrants tab's filter
// bar: a `<form method="GET">` that auto-submits itself (R4) rather than
// waiting on a button click. The component is a CLIENT one (auto-submit
// needs `onChange` handlers, the search box needs a debounce timer), so it
// renders through `renderIsland` rather than a bare function call
// (`useRef`/`useEffect` throw "Invalid hook call" outside React — see
// `_hook-harness.tsx`).
//
// R5 task 2: every submit now goes through ONE `onSubmit` handler (native
// Enter-key submission included, not just the onChange->requestSubmit()
// path below) that reads the form's CURRENT fields, drops the empty ones,
// and navigates with `router.push` — before this, a native GET submission
// serialised EVERY named control regardless of value, so changing one
// filter left `&division_id=&kind=&q=` noise in an otherwise-shareable URL.
// `useRouter` throws outside a real Next tree the same way `useConfirm`
// does (see registration-hub-registrant-actions.test.tsx's own header
// comment) — the harness's `useContext` only ever returns a context's
// DEFAULT, and nothing here mounts a provider, so the whole module is
// mocked rather than relying on that fallback.
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubRegistrantFilters,
  buildFilteredHref,
  clearAllHref,
  clearOneHref,
  FILTER_NAMES,
} from "@/components/registration-hub-registrant-filters";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import { getDictionary, t } from "@/lib/i18n";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { parseRegistrantsQuery } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { RegistrantsFilters, DivisionOption } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

// B6 T20 (A3 pill bar): the component now reads the LIVE query string
// (`useSearchParams`) to build each pill's "×" href — the URL is the state,
// and a clear-one link has to keep every param it does not own (tab, sort,
// and whatever B7 adds), not only the ones this form knows about.
const nav = vi.hoisted(() => ({ push: vi.fn(), search: "tab=registrants" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const dict = await getDictionary("en", "ui");

const DEFAULT_FILTERS: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  // Tri-state (RS005 F3 finding 2): null means unset, distinct from an
  // explicit false. See fetch-registrant-rows.test.ts for the parsing side.
  freeAgent: null,
  consentPending: null,
  text: "",
  sort: "newest",
};

const DIVISIONS: DivisionOption[] = [
  { id: "div-1", name: "Open Singles" },
  { id: "div-2", name: "Mixed Doubles" },
];

const ACTION = "/o/riverside/c/summer-league/registration";
const CLEAR_ALL_HREF = "/o/riverside/c/summer-league/registration?tab=registrants";

// Mirrors the component's own SEARCH_DEBOUNCE_MS (not exported — the
// component's public contract is behaviour, not a tunable constant other
// modules should reach into). 300ms per the R4 dispatch ("~300ms").
const SEARCH_DEBOUNCE_MS = 300;

// Read from the SAME zod enums the server parent
// (registration-hub-registrants-panel.tsx) reads at render time — NOT
// re-imported from @/server/api-v1/schemas here. That module transitively
// reaches the engine's gRPC scheduling client (Node built-ins), which is
// exactly why this became a prop instead of a direct import the moment
// this component turned client-side (R4's auto-submit); a vitest suite
// (environment: "node", no bundler) would never have caught that — only
// `next build` does. Hand-typed literals here, matching the real enum
// values, are enough to prove the render/wiring this file is actually
// responsible for.
const STATUS_OPTIONS = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"];
const KIND_OPTIONS = ["team", "individual", "pair"];

function render(filters: RegistrantsFilters = DEFAULT_FILTERS, search = "tab=registrants") {
  nav.search = search;
  return renderIsland(RegistrationHubRegistrantFilters, {
    dict,
    action: ACTION,
    filters,
    divisions: DIVISIONS,
    statusOptions: STATUS_OPTIONS,
    kindOptions: KIND_OPTIONS,
  }).tree();
}

function form(tree: ReturnType<typeof render>) {
  return tree.find((e) => e.type === "form")!;
}

beforeEach(() => {
  nav.push.mockClear();
  nav.search = "tab=registrants";
});

/** A fake changed-control event, shaped exactly like the one every onChange
 *  handler in this component reads: `e.target.form`. Plain data, no DOM. */
function changeEvent(fakeForm: { requestSubmit: () => void }) {
  return { target: { form: fakeForm as unknown as HTMLFormElement } };
}

describe("RegistrationHubRegistrantFilters — the form itself", () => {
  it("is a GET form posting to the given action — the markup itself degrades to a plain (unfiltered) submission with no JS", () => {
    const f = form(render());
    expect(propsOf(f).method).toBe("GET");
    expect(propsOf(f).action).toBe(ACTION);
  });

  // R5 task 2: submission is now intercepted so the resulting URL can be
  // filtered — see "auto-submit URL filtering" below for what it does with
  // the submission once caught.
  it("intercepts submission via onSubmit rather than letting the browser build the query string itself", () => {
    const f = form(render());
    expect(typeof propsOf(f).onSubmit).toBe("function");
  });

  it("carries a hidden tab=registrants input, so the action's bare path plus the form fields reconstructs ?tab=registrants on submit", () => {
    const hidden = render().find(
      (e) => e.type === "input" && propsOf(e).type === "hidden" && propsOf(e).name === "tab",
    );
    expect(hidden).toBeTruthy();
    expect(propsOf(hidden!).value).toBe("registrants");
  });
});

describe("status filter", () => {
  it("offers every real status value plus an 'all' option, translated", () => {
    const tree = render();
    const select = tree.find((e) => e.type === "select" && propsOf(e).name === "status")!;
    const optionValues = walk(select)
      .filter((e) => e.type === "option")
      .map((e) => propsOf(e).value);
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
  });

  it("pre-selects the current filter value via defaultValue (uncontrolled)", () => {
    const select = render({ ...DEFAULT_FILTERS, status: "confirmed" }).find(
      (e) => e.type === "select" && propsOf(e).name === "status",
    )!;
    expect(propsOf(select).defaultValue).toBe("confirmed");
    // Uncontrolled on purpose (see the file's own header comment) — a
    // `value` prop here would make React fight the DOM for the field on
    // every re-render.
    expect(propsOf(select).value).toBeUndefined();
  });

  it("defaults to the empty (all) option when no status filter is active", () => {
    const select = render().find((e) => e.type === "select" && propsOf(e).name === "status")!;
    expect(propsOf(select).defaultValue).toBe("");
  });

  it("submits the form the instant it changes — no separate Filter click", () => {
    const select = render().find((e) => e.type === "select" && propsOf(e).name === "status")!;
    const requestSubmit = vi.fn();
    (propsOf(select).onChange as (e: unknown) => void)(changeEvent({ requestSubmit }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("division filter", () => {
  it("offers one option per division it is given, plus an 'all' option", () => {
    const tree = render();
    const select = tree.find((e) => e.type === "select" && propsOf(e).name === "division_id")!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["", "div-1", "div-2"]);
    expect(textOf(options[1]!)).toBe("Open Singles");
    expect(textOf(options[2]!)).toBe("Mixed Doubles");
  });

  it("pre-selects the current division filter", () => {
    const select = render({ ...DEFAULT_FILTERS, divisionId: "div-2" }).find(
      (e) => e.type === "select" && propsOf(e).name === "division_id",
    )!;
    expect(propsOf(select).defaultValue).toBe("div-2");
  });

  it("submits on change", () => {
    const select = render().find((e) => e.type === "select" && propsOf(e).name === "division_id")!;
    const requestSubmit = vi.fn();
    (propsOf(select).onChange as (e: unknown) => void)(changeEvent({ requestSubmit }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("kind filter", () => {
  it("offers team/individual/pair plus an 'all' option, using the SAME divset.entrants.kind.* labels the Settings tab already uses", () => {
    const tree = render();
    const select = tree.find((e) => e.type === "select" && propsOf(e).name === "kind")!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["", "team", "individual", "pair"]);
    const teamOption = options.find((o) => propsOf(o).value === "team")!;
    expect(textOf(teamOption)).toBe(t(dict, "divset.entrants.kind.team"));
  });

  it("submits on change", () => {
    const select = render().find((e) => e.type === "select" && propsOf(e).name === "kind")!;
    const requestSubmit = vi.fn();
    (propsOf(select).onChange as (e: unknown) => void)(changeEvent({ requestSubmit }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("sort", () => {
  it("offers newest/oldest and pre-selects the current value", () => {
    const tree = render({ ...DEFAULT_FILTERS, sort: "oldest" });
    const select = tree.find((e) => e.type === "select" && propsOf(e).name === "sort")!;
    const options = walk(select).filter((e) => e.type === "option");
    expect(options.map((o) => propsOf(o).value)).toEqual(["newest", "oldest"]);
    expect(propsOf(select).defaultValue).toBe("oldest");
  });

  it("submits on change", () => {
    const select = render().find((e) => e.type === "select" && propsOf(e).name === "sort")!;
    const requestSubmit = vi.fn();
    (propsOf(select).onChange as (e: unknown) => void)(changeEvent({ requestSubmit }));
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("free_agent / consent_pending checkboxes", () => {
  it("are unchecked and off by default, name/value matching the API's own 1/0 convention", () => {
    const tree = render();
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    expect(propsOf(freeAgent).type).toBe("checkbox");
    expect(propsOf(freeAgent).value).toBe("1");
    expect(propsOf(freeAgent).defaultChecked).toBeFalsy();
    expect(propsOf(freeAgent).checked).toBeUndefined();

    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(consentPending).type).toBe("checkbox");
    expect(propsOf(consentPending).value).toBe("1");
    expect(propsOf(consentPending).defaultChecked).toBeFalsy();
  });

  it("reflect an active filter via defaultChecked", () => {
    const tree = render({ ...DEFAULT_FILTERS, freeAgent: true, consentPending: true });
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(freeAgent).defaultChecked).toBe(true);
    expect(propsOf(consentPending).defaultChecked).toBe(true);
  });

  // RS005 F3 finding 2: the tri-state's explicit-false case must render
  // identically to "unset" (both are an unchecked box — the DIFFERENCE is
  // in what gets sent to the API on submit, not how the box looks), and
  // must not crash/misrender now that `filters.freeAgent` is `boolean |
  // null` rather than a plain boolean.
  it("also reads as unchecked when the filter is explicitly false, not just when unset", () => {
    const tree = render({ ...DEFAULT_FILTERS, freeAgent: false, consentPending: false });
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(freeAgent).defaultChecked).toBe(false);
    expect(propsOf(consentPending).defaultChecked).toBe(false);
  });

  it("each submits on change", () => {
    const tree = render();
    const freeAgent = tree.find((e) => e.type === "input" && propsOf(e).name === "free_agent")!;
    const consentPending = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    const submit1 = vi.fn();
    const submit2 = vi.fn();
    (propsOf(freeAgent).onChange as (e: unknown) => void)(changeEvent({ requestSubmit: submit1 }));
    (propsOf(consentPending).onChange as (e: unknown) => void)(changeEvent({ requestSubmit: submit2 }));
    expect(submit1).toHaveBeenCalledTimes(1);
    expect(submit2).toHaveBeenCalledTimes(1);
  });

  // The renamed wording (owner call, 2026-08-26): the filter used to say
  // "Free agents only" while the row badge/config toggle already said
  // "Solo sign-ups" — three keys of drift in the same dictionary. ES/FR/NL
  // already said "solo" for this exact key (checked via `git blame` on
  // a9d6007896 — the commit that added it originally used inconsistent
  // wording ACROSS locales, not just against English), so only English
  // needed the fix here.
  it("labels the free_agent checkbox with the 'solo sign-ups' wording, not 'free agent'", () => {
    const label = t(dict, "reg.hub.registrants.filters.freeAgent");
    expect(label.toLowerCase()).not.toContain("free agent");
    expect(label.toLowerCase()).toContain("solo sign-ups");
  });
});

describe("search (q)", () => {
  it("pre-fills the search text via defaultValue, uncontrolled (never a `value` prop)", () => {
    const input = render({ ...DEFAULT_FILTERS, text: "Alex" }).find(
      (e) => e.type === "input" && propsOf(e).name === "q",
    )!;
    expect(propsOf(input).defaultValue).toBe("Alex");
    expect(propsOf(input).type).toBe("text");
    // Uncontrolled by design (file header comment): this is what keeps the
    // caret/typed value safe from React while a debounce is pending — an
    // uncontrolled input is never resynced to a stale `value` on re-render
    // because it never HAS a `value` prop to resync to.
    expect(propsOf(input).value).toBeUndefined();
  });

  it("does NOT submit immediately on a keystroke", () => {
    vi.useFakeTimers();
    try {
      const input = render().find((e) => e.type === "input" && propsOf(e).name === "q")!;
      const requestSubmit = vi.fn();
      (propsOf(input).onChange as (e: unknown) => void)(changeEvent({ requestSubmit }));
      expect(requestSubmit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits ~300ms after the last keystroke", () => {
    vi.useFakeTimers();
    try {
      const input = render().find((e) => e.type === "input" && propsOf(e).name === "q")!;
      const requestSubmit = vi.fn();
      const onChange = propsOf(input).onChange as (e: unknown) => void;
      onChange(changeEvent({ requestSubmit }));
      vi.advanceTimersByTime(299);
      expect(requestSubmit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(requestSubmit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a burst of keystrokes only submits ONCE, from the LAST one, not once per keystroke", () => {
    vi.useFakeTimers();
    try {
      const input = render().find((e) => e.type === "input" && propsOf(e).name === "q")!;
      const onChange = propsOf(input).onChange as (e: unknown) => void;
      const submits: string[] = [];
      const fake = (tag: string) => ({ requestSubmit: () => submits.push(tag) });
      onChange(changeEvent(fake("A")));
      vi.advanceTimersByTime(100);
      onChange(changeEvent(fake("Al")));
      vi.advanceTimersByTime(100);
      onChange(changeEvent(fake("Ale")));
      vi.advanceTimersByTime(100);
      onChange(changeEvent(fake("Alex")));
      // Only the LAST keystroke's timer should still be pending — the
      // earlier three were each cancelled by the next change.
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      expect(submits).toEqual(["Alex"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// B6 T20 — the A3 pill bar (mock rfm12a01 §A3, spec §8). Every filter is a
// pill that shows its own value; the URL is the state; "×" clears one filter
// and "Clear all" returns to the bare tab URL. The pills are rendered by plain
// helper calls (not nested components), so this harness — one level deep —
// sees every select/input/link below as a flat tree.
// ---------------------------------------------------------------------------

type Tree = ReturnType<typeof render>;

/** The pill container for one filter — found by its stable data hook. */
function pillOf(tree: Tree, name: string) {
  const el = tree.find((e) => propsOf(e)["data-filter-pill"] === name);
  if (!el) throw new Error(`no pill for ${name}`);
  return el;
}

/** The text a person reads on the pill (the hidden native select's own
 *  option labels are deliberately NOT part of it). */
function pillText(tree: Tree, name: string): string {
  const text = walk(pillOf(tree, name)).find((e) => propsOf(e)["data-pill-text"] !== undefined);
  if (!text) throw new Error(`pill ${name} has no [data-pill-text]`);
  return textOf(text);
}

function clearAllLink(tree: Tree) {
  return tree.find((e) => propsOf(e)["data-filter-clear-all"] !== undefined);
}

function clearOneLink(tree: Tree, name: string) {
  return walk(pillOf(tree, name)).find((e) => propsOf(e)["data-filter-clear-one"] === name);
}

// The URL every "keeps the rest" case below starts from: every filter set,
// the non-default sort, and two params this form knows nothing about (B7's
// `open`, a stray `page`) — a clear link must carry those through untouched.
const FULL_QUERY =
  "tab=registrants&status=confirmed&division_id=div-1&kind=team&free_agent=1&consent_pending=1&q=alex&sort=oldest&open=a,b&page=2";

describe("clearAllHref / clearOneHref — the pure href builders (B6 T20)", () => {
  it("clearAllHref is the bare tab URL: still on Registrants, no filter params (owner 1)", () => {
    expect(clearAllHref()).toBe("?tab=registrants");
  });

  it("names exactly the five narrowing controls a pill can clear", () => {
    expect([...FILTER_NAMES].sort()).toEqual(["consent_pending", "division_id", "free_agent", "kind", "status"]);
  });

  it("clearOneHref drops ONLY that param and keeps tab and every other param, in order", () => {
    let checked = 0;
    for (const name of FILTER_NAMES) {
      const current = new URLSearchParams(FULL_QUERY);
      const expected = [...current.entries()].filter(([k]) => k !== name);
      const href = clearOneHref(current, name);
      expect(href.startsWith("?"), `${name}: query-only href`).toBe(true);
      expect([...new URLSearchParams(href.slice(1)).entries()], name).toEqual(expected);
      expect(new URLSearchParams(href.slice(1)).get("tab"), `${name}: tab kept`).toBe("registrants");
      checked += 1;
    }
    // Anti-vacuity: an empty FILTER_NAMES would make the loop above pass.
    expect(checked).toBe(5);
  });

  it("dropping the only filter leaves the bare tab URL", () => {
    expect(clearOneHref(new URLSearchParams("tab=registrants&status=confirmed"), "status")).toBe("?tab=registrants");
  });

  it("always lands on the Registrants tab, even from a URL that lost its tab param", () => {
    const params = new URLSearchParams(clearOneHref(new URLSearchParams("status=confirmed&sort=oldest"), "status").slice(1));
    expect(params.get("tab")).toBe("registrants");
    expect(params.get("sort")).toBe("oldest");
    expect(params.has("status")).toBe(false);
  });

  it("a repeated param (hand-edited URL) is dropped everywhere, not just its first copy", () => {
    const href = clearOneHref(new URLSearchParams("tab=registrants&status=paid&status=confirmed"), "status");
    expect(href).toBe("?tab=registrants");
  });

  it("does not mutate its input, so a second call gives the same answer", () => {
    const current = new URLSearchParams(FULL_QUERY);
    const first = clearOneHref(current, "status");
    expect(current.toString()).toBe(new URLSearchParams(FULL_QUERY).toString());
    expect(clearOneHref(current, "status")).toBe(first);
  });
});

describe("Clear all (B6 T20)", () => {
  it("is hidden when nothing is set — there is nothing to clear", () => {
    const tree = render(DEFAULT_FILTERS);
    expect(clearAllLink(tree)).toBeUndefined();
    expect(tree.find((e) => propsOf(e).href === CLEAR_ALL_HREF)).toBeUndefined();
  });

  it("is hidden when only the sort differs from the default — sort orders, it never narrows", () => {
    expect(clearAllLink(render({ ...DEFAULT_FILTERS, sort: "oldest" }))).toBeUndefined();
  });

  it("shows for each single narrowing filter, labelled 'Clear all', linking to the bare tab URL", () => {
    const cases: Record<string, RegistrantsFilters> = {
      status: { ...DEFAULT_FILTERS, status: "paid" },
      division: { ...DEFAULT_FILTERS, divisionId: "div-1" },
      kind: { ...DEFAULT_FILTERS, kind: "pair" },
      solo: { ...DEFAULT_FILTERS, freeAgent: true },
      consent: { ...DEFAULT_FILTERS, consentPending: true },
      search: { ...DEFAULT_FILTERS, text: "alex" },
    };
    let checked = 0;
    for (const [label, filters] of Object.entries(cases)) {
      const link = clearAllLink(render(filters));
      expect(link, label).toBeTruthy();
      expect(propsOf(link!).href, label).toBe(CLEAR_ALL_HREF);
      expect(textOf(link!), label).toBe("Clear all");
      checked += 1;
    }
    expect(checked).toBe(6);
  });
});

describe("filter pills (B6 T20)", () => {
  it("an unset pill reads its bare label and offers no ×", () => {
    const tree = render();
    expect(pillText(tree, "status")).toBe("Status");
    expect(pillText(tree, "division_id")).toBe("Division");
    expect(pillText(tree, "kind")).toBe("Entrant kind");
    for (const name of ["status", "division_id", "kind"]) {
      expect(propsOf(pillOf(tree, name))["data-set"], name).toBe("false");
      expect(clearOneLink(tree, name), name).toBeUndefined();
    }
  });

  it("a set status pill reads Status: Confirmed", () => {
    const tree = render({ ...DEFAULT_FILTERS, status: "confirmed" }, "tab=registrants&status=confirmed");
    expect(pillText(tree, "status")).toBe("Status: Confirmed");
    expect(propsOf(pillOf(tree, "status"))["data-set"]).toBe("true");
  });

  it("a set division pill reads the division's NAME, not its id", () => {
    const tree = render({ ...DEFAULT_FILTERS, divisionId: "div-2" }, "tab=registrants&division_id=div-2");
    expect(pillText(tree, "division_id")).toBe("Division: Mixed Doubles");
  });

  it("a set kind pill reads the same kind label the Settings tab uses", () => {
    const tree = render({ ...DEFAULT_FILTERS, kind: "team" }, "tab=registrants&kind=team");
    expect(pillText(tree, "kind")).toBe(`Entrant kind: ${t(dict, "divset.entrants.kind.team")}`);
    expect(pillText(tree, "kind")).toBe("Entrant kind: Team");
  });

  it("a division id that matches no option never prints 'Division: undefined' — it reads as unset", () => {
    const tree = render({ ...DEFAULT_FILTERS, divisionId: "gone" }, "tab=registrants&division_id=gone");
    expect(pillText(tree, "division_id")).toBe("Division");
    expect(pillText(tree, "division_id")).not.toContain("undefined");
  });

  it("each set select pill carries a × that links to the URL without that param and nothing else removed", () => {
    const search = "tab=registrants&status=confirmed&division_id=div-1&kind=team&sort=oldest";
    const tree = render({ ...DEFAULT_FILTERS, status: "confirmed", divisionId: "div-1", kind: "team", sort: "oldest" }, search);
    expect(propsOf(clearOneLink(tree, "status")!).href).toBe(
      `${ACTION}?tab=registrants&division_id=div-1&kind=team&sort=oldest`,
    );
    expect(propsOf(clearOneLink(tree, "division_id")!).href).toBe(
      `${ACTION}?tab=registrants&status=confirmed&kind=team&sort=oldest`,
    );
    expect(propsOf(clearOneLink(tree, "kind")!).href).toBe(
      `${ACTION}?tab=registrants&status=confirmed&division_id=div-1&sort=oldest`,
    );
  });

  it("the × is named for what it clears, so a screen reader hears 'Clear Status'", () => {
    const tree = render({ ...DEFAULT_FILTERS, status: "confirmed", divisionId: "div-2" }, "tab=registrants&status=confirmed&division_id=div-2");
    expect(propsOf(clearOneLink(tree, "status")!)["aria-label"]).toBe("Clear Status");
    expect(propsOf(clearOneLink(tree, "division_id")!)["aria-label"]).toBe("Clear Division");
  });

  it("the × is a real link, not a button — no JS needed to clear a filter", () => {
    const tree = render({ ...DEFAULT_FILTERS, status: "paid" }, "tab=registrants&status=paid");
    expect(tree.find((e) => e.type === "button")).toBeUndefined();
    expect(typeof propsOf(clearOneLink(tree, "status")!).href).toBe("string");
  });

  it("the two toggle pills always read their bare label; their state is the checkbox, not the text", () => {
    for (const filters of [DEFAULT_FILTERS, { ...DEFAULT_FILTERS, freeAgent: true, consentPending: true }]) {
      const tree = render(filters);
      expect(pillText(tree, "free_agent")).toBe("Solo sign-ups only");
      expect(pillText(tree, "consent_pending")).toBe("Consent pending only");
    }
  });
});

describe("every control keeps its name; no control has a stacked visible label (B6 T20)", () => {
  it("every select, the search box and both checkboxes keep their name attribute", () => {
    const tree = render();
    const named = tree
      .filter((e) => ["select", "input"].includes(String(e.type)))
      .map((e) => `${String(e.type)}:${String(propsOf(e).name)}`)
      .sort();
    expect(named).toEqual(
      [
        "input:consent_pending",
        "input:free_agent",
        "input:q",
        "input:tab",
        "select:division_id",
        "select:kind",
        "select:sort",
        "select:status",
      ].sort(),
    );
  });

  it("every select carries an aria-label naming it", () => {
    const tree = render();
    const expected: Record<string, string> = {
      status: "Status",
      division_id: "Division",
      kind: "Entrant kind",
      sort: "Sort",
    };
    let checked = 0;
    for (const [name, label] of Object.entries(expected)) {
      const select = tree.find((e) => e.type === "select" && propsOf(e).name === name)!;
      expect(propsOf(select)["aria-label"], name).toBe(label);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("the search box is named and its placeholder promises name, email AND reference", () => {
    const input = render().find((e) => e.type === "input" && propsOf(e).name === "q")!;
    expect(propsOf(input)["aria-label"]).toBe("Search");
    expect(propsOf(input).placeholder).toBe("Search name, email or reference");
  });

  it("no <label> wraps a select or a text box — the only labels left are the two toggle pills around their checkbox", () => {
    const labels = render().filter((e) => e.type === "label");
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      const inner = walk(label);
      expect(inner.some((e) => e.type === "select")).toBe(false);
      expect(inner.some((e) => e.type === "input" && propsOf(e).type === "text")).toBe(false);
      expect(inner.some((e) => e.type === "input" && propsOf(e).type === "checkbox")).toBe(true);
    }
  });
});

describe("the URL is the state — set, reload, clear (B6 T20)", () => {
  /** What the form's real submit pushes, then what the server makes of it:
   *  the SAME parser page.tsx runs on the pushed URL. */
  function afterSubmit(elements: { name: string; value: string; type?: string; checked?: boolean }[]) {
    const f = form(render());
    nav.push.mockClear();
    (propsOf(f).onSubmit as (e: unknown) => void)({ preventDefault: vi.fn(), currentTarget: { elements } });
    expect(nav.push).toHaveBeenCalledTimes(1);
    const pushed = String(nav.push.mock.calls[0]![0]);
    const url = new URL(pushed, "https://seazn.test");
    return { pushed, search: url.search.slice(1), filters: parseRegistrantsQuery(Object.fromEntries(url.searchParams)) };
  }

  // Listed in the form's own DOM order (hidden tab, search, sort, the three
  // select pills, the two toggles) — that order is what the pushed URL carries.
  const ELEMENTS_STATUS_AND_CONSENT = [
    { name: "tab", value: "registrants" },
    { name: "q", value: "" },
    { name: "sort", value: "newest" },
    { name: "status", value: "confirmed" },
    { name: "division_id", value: "" },
    { name: "kind", value: "" },
    { name: "free_agent", value: "1", type: "checkbox", checked: false },
    { name: "consent_pending", value: "1", type: "checkbox", checked: true },
  ];

  it("a URL carrying status=confirmed&consent_pending=1 renders both pills as set (the refresh case)", () => {
    const filters = parseRegistrantsQuery({ status: "confirmed", consent_pending: "1" });
    const tree = render(filters, "tab=registrants&status=confirmed&consent_pending=1");
    expect(pillText(tree, "status")).toBe("Status: Confirmed");
    expect(propsOf(pillOf(tree, "status"))["data-set"]).toBe("true");
    const consent = tree.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!;
    expect(propsOf(consent).defaultChecked).toBe(true);
    expect(clearAllLink(tree)).toBeTruthy();
  });

  it("set -> push -> parse -> render shows the same filters again, and a second reload is identical", () => {
    const { search, filters } = afterSubmit(ELEMENTS_STATUS_AND_CONSENT);
    expect(filters.status).toBe("confirmed");
    expect(filters.consentPending).toBe(true);
    const first = render(filters, search);
    const second = render(filters, search);
    expect(pillText(first, "status")).toBe("Status: Confirmed");
    expect(propsOf(first.find((e) => e.type === "input" && propsOf(e).name === "consent_pending")!).defaultChecked).toBe(true);
    // The pill ×, built from the pushed URL, keeps what the push carried.
    expect(propsOf(clearOneLink(first, "status")!).href).toBe(`${ACTION}?tab=registrants&sort=newest&consent_pending=1`);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("following a pill's × removes that filter and keeps the other", () => {
    const { search, filters } = afterSubmit(ELEMENTS_STATUS_AND_CONSENT);
    const href = String(propsOf(clearOneLink(render(filters, search), "status")!).href);
    const url = new URL(href, "https://seazn.test");
    const after = parseRegistrantsQuery(Object.fromEntries(url.searchParams));
    expect(after.status).toBeNull();
    expect(after.consentPending).toBe(true);
    const tree = render(after, url.search.slice(1));
    expect(pillText(tree, "status")).toBe("Status");
    expect(clearOneLink(tree, "status")).toBeUndefined();
  });

  it("Clear all lands on a clean URL: no filter params, still on the tab, and the bar then shows nothing set", () => {
    const { search, filters } = afterSubmit(ELEMENTS_STATUS_AND_CONSENT);
    const link = clearAllLink(render(filters, search))!;
    const href = String(propsOf(link).href);
    expect(href).toBe(CLEAR_ALL_HREF);
    const url = new URL(href, "https://seazn.test");
    expect([...url.searchParams.keys()]).toEqual(["tab"]);
    const cleared = parseRegistrantsQuery(Object.fromEntries(url.searchParams));
    expect(hasActiveFilters(cleared)).toBe(false);
    const tree = render(cleared, url.search.slice(1));
    expect(clearAllLink(tree)).toBeUndefined();
    const setPills = tree.filter((e) => propsOf(e)["data-set"] === "true");
    expect(setPills).toHaveLength(0);
    // Anti-vacuity: the cleared tree still HAS pills to be unset.
    expect(tree.filter((e) => propsOf(e)["data-filter-pill"] !== undefined)).toHaveLength(5);
  });
});

// RS005 F3 finding 3: every control is uncontrolled (`defaultValue`/
// `defaultChecked`, deliberately preserved — see the file's own header
// comment), and a REAL browser never re-applies `defaultValue` to an
// existing DOM node on a later render. Without something forcing a
// remount, "Clear filters" (a plain <Link> navigation, not this form's own
// submit) left every widget showing its PRE-clear value, and the next
// change — `handleSubmit` reading LIVE `e.currentTarget.elements` — read
// the stale DOM and silently resurrected the cleared filter. Browser Back
// has the same effect: it delivers a fresh `filters` prop without ever
// going through this form's own onChange/onSubmit path.
//
// This harness has no real DOM (`_hook-harness.tsx`'s own header comment),
// so it structurally cannot reproduce "a stale DOM node persisting across a
// re-render" — there is no persistent node to go stale; `tree()` just
// re-reads whatever the current render's JSX says. What it CAN verify is
// the mechanism that GUARANTEES a real browser resets one: React unmounts
// and remounts an element when its `key` changes between renders — true
// for any element, not only `.map()`-generated siblings (the same
// technique as `<UserProfile key={userId} />`) — so a control keyed on its
// OWN filter value forces the browser to re-read `defaultValue`/
// `defaultChecked` from the fresh props exactly when that value changes,
// regardless of what caused the new render (this form's own submit, Clear,
// or Back/Forward). Scoped per-field (not one key on the whole `<form>`)
// so changing ONE filter does not also tear down and refocus-lose every
// OTHER, unrelated control.
describe("uncontrolled controls key on their OWN filter value, forcing a remount when it changes (RS005 F3 finding 3)", () => {
  function keyOf(tree: ReturnType<typeof render>, name: string) {
    return tree.find((e) => (e.type === "select" || e.type === "input") && propsOf(e).name === name)!.key;
  }

  it("gives every uncontrolled control a real (non-null) key", () => {
    const tree = render();
    for (const name of ["status", "division_id", "kind", "q", "sort", "free_agent", "consent_pending"]) {
      expect(keyOf(tree, name)).not.toBeNull();
    }
  });

  it("changes the status select's key when status changes — forces a remount, resetting a stale DOM value", () => {
    const cleared = keyOf(render(DEFAULT_FILTERS), "status");
    const confirmed = keyOf(render({ ...DEFAULT_FILTERS, status: "confirmed" }), "status");
    expect(cleared).not.toBe(confirmed);
  });

  it("keeps the SAME key across two renders with an unchanged status — no unnecessary remount", () => {
    const k1 = keyOf(render({ ...DEFAULT_FILTERS, status: "confirmed" }), "status");
    const k2 = keyOf(render({ ...DEFAULT_FILTERS, status: "confirmed" }), "status");
    expect(k1).toBe(k2);
  });

  it("does NOT change the status select's key when an unrelated filter (sort) changes — only ITS OWN value forces a remount", () => {
    const k1 = keyOf(render({ ...DEFAULT_FILTERS, status: "confirmed", sort: "newest" }), "status");
    const k2 = keyOf(render({ ...DEFAULT_FILTERS, status: "confirmed", sort: "oldest" }), "status");
    expect(k1).toBe(k2);
  });

  it("gives the division_id select a distinct key per division, and the kind select likewise", () => {
    const a = keyOf(render({ ...DEFAULT_FILTERS, divisionId: "div-1" }), "division_id");
    const b = keyOf(render({ ...DEFAULT_FILTERS, divisionId: "div-2" }), "division_id");
    expect(a).not.toBe(b);

    const team = keyOf(render({ ...DEFAULT_FILTERS, kind: "team" }), "kind");
    const pair = keyOf(render({ ...DEFAULT_FILTERS, kind: "pair" }), "kind");
    expect(team).not.toBe(pair);
  });

  it("gives the sort select a distinct key per value", () => {
    const newest = keyOf(render({ ...DEFAULT_FILTERS, sort: "newest" }), "sort");
    const oldest = keyOf(render({ ...DEFAULT_FILTERS, sort: "oldest" }), "sort");
    expect(newest).not.toBe(oldest);
  });

  it("gives the search input a distinct key per text value — resets it too after Clear/Back, not just the dropdowns", () => {
    const empty = keyOf(render(DEFAULT_FILTERS), "q");
    const alex = keyOf(render({ ...DEFAULT_FILTERS, text: "Alex" }), "q");
    expect(empty).not.toBe(alex);
  });

  it("gives the free_agent checkbox three DISTINCT keys across unset/true/false — the resurrection bug's exact scenario", () => {
    const unset = keyOf(render({ ...DEFAULT_FILTERS, freeAgent: null }), "free_agent");
    const on = keyOf(render({ ...DEFAULT_FILTERS, freeAgent: true }), "free_agent");
    const off = keyOf(render({ ...DEFAULT_FILTERS, freeAgent: false }), "free_agent");
    expect(new Set([unset, on, off]).size).toBe(3);
  });

  it("same three-way distinct keying for consent_pending", () => {
    const unset = keyOf(render({ ...DEFAULT_FILTERS, consentPending: null }), "consent_pending");
    const on = keyOf(render({ ...DEFAULT_FILTERS, consentPending: true }), "consent_pending");
    const off = keyOf(render({ ...DEFAULT_FILTERS, consentPending: false }), "consent_pending");
    expect(new Set([unset, on, off]).size).toBe(3);
  });
});

// R4 task 1: the button is gone — every control submits itself now.
describe("no submit button", () => {
  it("renders no <button> at all", () => {
    const tree = render();
    expect(tree.find((e) => e.type === "button")).toBeUndefined();
  });
});

// B6 T20: "every control is 40 px tall" at md and up (spec §8, owner-approved
// mock A3). Below md the bar keeps today's 44px touch height until T21 folds
// it into a sheet — pinned at the class-list level (this suite has no viewport
// to lay anything out in), the same technique the container-query regression
// in datetime-split-field.test.tsx uses.
describe("responsive layout (B6 T20)", () => {
  it("every control is 40px tall at md and up and keeps the 44px touch height below it", () => {
    const tree = render();
    const controls = [
      tree.find((e) => e.type === "input" && propsOf(e).name === "q")!,
      tree.find((e) => e.type === "select" && propsOf(e).name === "sort")!,
      pillOf(tree, "status"),
      pillOf(tree, "division_id"),
      pillOf(tree, "kind"),
      pillOf(tree, "free_agent"),
      pillOf(tree, "consent_pending"),
    ];
    let checked = 0;
    for (const el of controls) {
      const cls = String(propsOf(el).className);
      expect(cls, cls).toMatch(/(^|\s)md:h-10(\s|$)/);
      expect(cls, cls).toMatch(/(^|\s)h-11(\s|$)/);
      checked += 1;
    }
    expect(checked).toBe(7);
  });

  it("each pill's native select fills the pill, so the whole pill is the tap target", () => {
    const tree = render();
    for (const name of ["status", "division_id", "kind"]) {
      const select = walk(pillOf(tree, name)).find((e) => e.type === "select")!;
      expect(String(propsOf(select).className), name).toMatch(/(^|\s)inset-0(\s|$)/);
    }
  });

  // A mistyped Tailwind variant (`has-[:checkd]:`, `max-md:basi-full`) compiles to
  // NOTHING and no markup test notices — the pill would simply not restyle. So
  // every class the bar can render (read off the real tree in its busiest
  // state, not retyped here) must compile to at least one declaration.
  it("every utility the bar renders is a real Tailwind class — a typo would silently style nothing", async () => {
    const tree = render(
      { ...DEFAULT_FILTERS, status: "confirmed", divisionId: "div-1", kind: "team", freeAgent: true, consentPending: true, text: "x" },
      "tab=registrants&status=confirmed",
    );
    const tokens = new Set<string>();
    for (const el of tree) {
      for (const tok of String(propsOf(el).className ?? "").split(/\s+/)) if (tok) tokens.add(tok);
    }
    // `peer` is a marker class other utilities key off and has no rule of its
    // own; `input` is a globals.css component class (its rule's selector is the
    // grouped `.input, .select, .textarea`, which compileClasses does not match).
    for (const marker of ["peer", "input"]) tokens.delete(marker);
    const compiled = await compileClasses([...tokens]);
    const dead = [...tokens].filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(dead, `classes that compile to nothing: ${dead.join(" ")}`).toEqual([]);
    // Anti-vacuity: the busiest state really does carry the load-bearing variants.
    expect(tokens.size).toBeGreaterThan(40);
    for (const must of ["md:h-10", "has-[:checked]:bg-purple-50", "has-[select:focus-visible]:ring-2", "peer-checked:bg-purple-600"]) {
      expect(tokens.has(must), must).toBe(true);
    }
  });

  it("the five pills share ONE row that wraps rather than scrolling the page sideways", () => {
    const tree = render();
    const status = pillOf(tree, "status");
    // `Children.toArray` re-keys (clones) its elements, so identity is read
    // off the raw children array instead.
    const kidsOf = (e: ReactElement) => [propsOf(e).children].flat(Infinity) as ReactElement[];
    const row = tree.find((e) => kidsOf(e).includes(status))!;
    expect(row, "the pills' parent row").toBeTruthy();
    const cls = String(propsOf(row).className);
    expect(cls).toMatch(/(^|\s)flex-wrap(\s|$)/);
    expect(cls).not.toMatch(/overflow-x/);
    const siblings = kidsOf(row);
    for (const name of ["status", "division_id", "kind", "free_agent", "consent_pending"]) {
      expect(siblings.some((c) => propsOf(c)["data-filter-pill"] === name), name).toBe(true);
    }
  });
});

// RS005 R5 task 2: a filter change used to navigate to
// `?tab=registrants&status=confirmed&division_id=&kind=&q=&sort=newest` —
// every EMPTY control still contributed its key, because a native GET
// submission serialises every named field regardless of value. The tab's
// URL is the shareable/bookmarkable artefact (the entire reason the filters
// are a GET form), so it should carry only what's actually SET.
describe("buildFilteredHref — the pure filtering logic (RS005 R5 task 2)", () => {
  // A plain array stands in for `form.elements` (an HTMLFormControlsCollection)
  // — this suite runs `environment: "node"` with no jsdom (_hook-harness.tsx's
  // own header comment), so a real HTMLFormElement/FormData is never
  // available; buildFilteredHref is written against `ArrayLike<...>`
  // specifically so this plain-array fixture IS what a real form.elements
  // would look like to it, not a stand-in for something richer.
  function el(name: string, value: string, extra: { type?: string; checked?: boolean } = {}) {
    return { name, value, ...extra };
  }

  it("keeps only non-empty fields, in URLSearchParams order", () => {
    const href = buildFilteredHref(ACTION, [
      el("tab", "registrants"),
      el("status", "confirmed"),
      el("division_id", ""),
      el("kind", ""),
      el("q", ""),
      el("sort", "newest"),
    ]);
    expect(href).toBe(`${ACTION}?tab=registrants&status=confirmed&sort=newest`);
  });

  it("drops a filter's key ENTIRELY once cleared back to empty — never an empty `key=`", () => {
    const href = buildFilteredHref(ACTION, [el("tab", "registrants"), el("status", "")]);
    expect(href).not.toContain("status");
    expect(href).not.toContain("status=");
  });

  it("includes a checkbox's value only while checked, mirroring the API's own 1/0 convention", () => {
    const checked = buildFilteredHref(ACTION, [
      el("tab", "registrants"),
      el("free_agent", "1", { type: "checkbox", checked: true }),
    ]);
    expect(checked).toContain("free_agent=1");

    const unchecked = buildFilteredHref(ACTION, [
      el("tab", "registrants"),
      el("free_agent", "1", { type: "checkbox", checked: false }),
    ]);
    expect(unchecked).not.toContain("free_agent");
  });

  it("skips a field with no name at all (defensive — form.elements can include unnamed controls)", () => {
    const href = buildFilteredHref(ACTION, [el("tab", "registrants"), el("", "stray")]);
    expect(href).toBe(`${ACTION}?tab=registrants`);
  });

  it("carries tab=registrants through unchanged when it is the only real value", () => {
    const href = buildFilteredHref(ACTION, [
      el("tab", "registrants"),
      el("status", ""),
      el("division_id", ""),
      el("kind", ""),
      el("q", ""),
      el("sort", ""),
    ]);
    expect(href).toBe(`${ACTION}?tab=registrants`);
  });
});

describe("auto-submit URL filtering — wired through onSubmit (RS005 R5 task 2)", () => {
  // Shaped exactly like the fake `changeEvent()` above: plain data standing
  // in for the one thing the handler actually reads — here, a submit
  // event's `currentTarget.elements`.
  function submitEvent(elements: { name: string; value: string; type?: string; checked?: boolean }[]) {
    return { preventDefault: vi.fn(), currentTarget: { elements } };
  }

  // "Baseline" here means every NARROWING filter is empty — `sort` isn't
  // one of those (hasActiveFilters's own doc comment: "sort is deliberately
  // excluded, it only orders") and its `<select>` has no blank option in
  // this component at all, so it always carries a real value, "newest"
  // included.
  const BASELINE_ELEMENTS = [
    { name: "tab", value: "registrants" },
    { name: "status", value: "" },
    { name: "division_id", value: "" },
    { name: "kind", value: "" },
    { name: "q", value: "" },
    { name: "sort", value: "newest" },
    { name: "free_agent", value: "1", type: "checkbox", checked: false },
    { name: "consent_pending", value: "1", type: "checkbox", checked: false },
  ];

  it("calls preventDefault — the browser's own unfiltered navigation never happens", () => {
    const f = form(render());
    const e = submitEvent(BASELINE_ELEMENTS);
    (propsOf(f).onSubmit as (e: unknown) => void)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("navigates via router.push to a URL carrying only the fields actually set", () => {
    const f = form(render());
    const e = submitEvent([
      { name: "tab", value: "registrants" },
      { name: "status", value: "confirmed" },
      { name: "division_id", value: "" },
      { name: "kind", value: "" },
      { name: "q", value: "" },
      { name: "sort", value: "newest" },
    ]);
    (propsOf(f).onSubmit as (e: unknown) => void)(e);
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledWith(`${ACTION}?tab=registrants&status=confirmed&sort=newest`);
  });

  it("carries only tab=registrants and sort — the noise-free baseline once every NARROWING filter is empty", () => {
    const f = form(render());
    (propsOf(f).onSubmit as (e: unknown) => void)(submitEvent(BASELINE_ELEMENTS));
    expect(nav.push).toHaveBeenCalledWith(`${ACTION}?tab=registrants&sort=newest`);
  });

  it("uses router.push, not replace — a change is still its own back-button stop, same as the native submission it replaces", () => {
    const f = form(render());
    (propsOf(f).onSubmit as (e: unknown) => void)(submitEvent(BASELINE_ELEMENTS));
    expect(nav.push).toHaveBeenCalled();
  });
});
