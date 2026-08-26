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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubRegistrantFilters,
  buildFilteredHref,
} from "@/components/registration-hub-registrant-filters";
import { getDictionary, t } from "@/lib/i18n";
import type { RegistrantsFilters, DivisionOption } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
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
const CLEAR_HREF = "/o/riverside/c/summer-league/registration?tab=registrants";

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

function render(filters: RegistrantsFilters = DEFAULT_FILTERS) {
  return renderIsland(RegistrationHubRegistrantFilters, {
    dict,
    action: ACTION,
    filters,
    divisions: DIVISIONS,
    clearHref: CLEAR_HREF,
    statusOptions: STATUS_OPTIONS,
    kindOptions: KIND_OPTIONS,
  }).tree();
}

function form(tree: ReturnType<typeof render>) {
  return tree.find((e) => e.type === "form")!;
}

beforeEach(() => {
  nav.push.mockClear();
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

describe("clear", () => {
  it("shows NO clear-filters link when nothing is active — there is nothing to clear", () => {
    const tree = render(DEFAULT_FILTERS);
    const clearLink = tree.find((e) => propsOf(e).href === CLEAR_HREF);
    expect(clearLink).toBeUndefined();
  });

  it("shows a clear-filters link at clearHref once a filter is active", () => {
    const tree = render({ ...DEFAULT_FILTERS, status: "paid" });
    const clearLink = tree.find((e) => propsOf(e).href === CLEAR_HREF);
    expect(clearLink).toBeTruthy();
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

// R4 task 1: "the bar should read as one row of controls at desktop and
// stack cleanly on a phone" — pinned at the class-list level (this suite
// has no viewport to actually lay anything out in), same technique the
// container-query regression in datetime-split-field.test.tsx uses.
describe("responsive layout", () => {
  it("stacks in one column below `sm` and becomes a wrapping row at `sm` and up", () => {
    const f = form(render());
    const cls = String(propsOf(f).className);
    expect(cls).toContain("flex-col");
    expect(cls).toContain("sm:flex-row");
    expect(cls).toContain("sm:flex-wrap");
  });

  it("groups the two checkboxes in their own wrapping container, matching the dropdowns' height in row mode", () => {
    const tree = render();
    const groupDiv = tree.find(
      (e) => e.type === "div" && String(propsOf(e).className ?? "").includes("sm:min-h-11"),
    )!;
    expect(groupDiv).toBeTruthy();
    expect(String(propsOf(groupDiv).className)).toContain("flex-wrap");
    // Both checkboxes are inside it — not just some other unrelated div.
    const kids = walk(groupDiv);
    expect(kids.some((e) => e.type === "input" && propsOf(e).name === "free_agent")).toBe(true);
    expect(kids.some((e) => e.type === "input" && propsOf(e).name === "consent_pending")).toBe(true);
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
