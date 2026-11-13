// B6 T21 — the phone Filters sheet of the organiser registration hub's filter
// bar (spec §8, "Below md"). Below 768 the pill row folds away; what is left is
// the search box, a "Filters" button with a count of what is set, a row of the
// set filters as removable chips, and the sheet the button opens. ≥768 is the
// A3 pill bar (registration-hub-registrant-filters.test.tsx) and must not move.
//
// Driven through `renderIsland` (no DOM in this workspace — `_hook-harness.tsx`):
// the open state is a real `useState`, so a click is a handler call and the
// island re-renders. `walk` stops at a child component's props, and the sheet is
// a `Modal` whose Show/Clear buttons sit in its `footer` prop, so this suite
// expands `footer` too.
//
// What a harness cannot see is covered by the walkthroughs listed in the T21
// report (mobile.spec.ts / registration-hub.spec.ts): focus trap, Escape, focus
// return, the sheet's real tap area. Those come from `components/modal.tsx`,
// which this suite pins as THE dialog (not a hand-rolled one).
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantFilters } from "@/components/registration-hub-registrant-filters";
import { Modal } from "@/components/modal";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { getDictionary, t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { parseRegistrantsQuery } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { DivisionOption, RegistrantsFilters } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), search: "tab=registrants" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const dict = await getDictionary("en", "ui");

const DEFAULT_FILTERS: RegistrantsFilters = {
  status: null,
  divisionId: null,
  kind: null,
  freeAgent: null,
  consentPending: null,
  text: "",
  sort: "newest",
};
// Real UUIDs: the server's parser (`parseRegistrantsQuery`) drops a division_id that
// is not one, so a round trip through it needs ids it will keep.
const DIV1 = "11111111-1111-4111-8111-111111111111";
const DIV2 = "22222222-2222-4222-8222-222222222222";
const DIVISIONS: DivisionOption[] = [
  { id: DIV1, name: "Open Singles" },
  { id: DIV2, name: "Mixed Doubles" },
];
const ACTION = "/o/riverside/c/summer-league/registration";
const STATUS_OPTIONS = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"];
const KIND_OPTIONS = ["team", "individual", "pair"];
const SEARCH_DEBOUNCE_MS = 300;
/** The five narrowing filters, in the order the bar lists them. */
const FIVE = ["status", "division_id", "kind", "free_agent", "consent_pending"] as const;
/** Every param the form itself writes; anything else in a URL is somebody
 *  else's (B7's `open`, a stray `page`) and must ride through untouched. */
const OWNED = new Set(["tab", "q", "sort", ...FIVE]);
// Every filter set, the non-default sort, a search and two params this form
// knows nothing about.
const FULL_QUERY =
  `tab=registrants&status=confirmed&division_id=${DIV1}&kind=team&free_agent=1&consent_pending=1&q=alex&sort=oldest&open=a,b&page=2`;
const FULL_FILTERS: RegistrantsFilters = {
  status: "confirmed",
  divisionId: DIV1,
  kind: "team",
  freeAgent: true,
  consentPending: true,
  text: "alex",
  sort: "oldest",
};

/** Like `walk`, plus a Modal's `footer` — where the Show/Clear buttons live. */
function walkAll(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walkAll(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const p = node.props as { children?: ReactNode; footer?: ReactNode };
  walkAll(p.children, out);
  walkAll(p.footer, out);
  return out;
}

type Props = Parameters<typeof RegistrationHubRegistrantFilters>[0];
function island(filters: RegistrantsFilters = DEFAULT_FILTERS, search = "tab=registrants", d: Dict = dict) {
  nav.search = search;
  const props: Props = {
    dict: d,
    action: ACTION,
    filters,
    divisions: DIVISIONS,
    statusOptions: STATUS_OPTIONS,
    kindOptions: KIND_OPTIONS,
  };
  return renderIsland(RegistrationHubRegistrantFilters, props, walkAll);
}
type Island = ReturnType<typeof island>;
type Tree = ReturnType<Island["tree"]>;

beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.search = "tab=registrants";
});

const byAttr = (tree: Tree, attr: string, value?: string) =>
  tree.find((e) => (value === undefined ? propsOf(e)[attr] !== undefined : propsOf(e)[attr] === value));
const allByAttr = (tree: Tree, attr: string) => tree.filter((e) => propsOf(e)[attr] !== undefined);
const tokens = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/).filter(Boolean);

const filtersButton = (tree: Tree) => byAttr(tree, "data-filters-open");
const sheetForm = (tree: Tree) => byAttr(tree, "data-filter-sheet-form");
const modal = (tree: Tree) => tree.find((e) => e.type === Modal);
const badge = (tree: Tree) => byAttr(tree, "data-filters-count");
const chips = (tree: Tree) => allByAttr(tree, "data-filter-chip");
const chipOf = (tree: Tree, name: string) => byAttr(tree, "data-filter-chip", name);
const chipClear = (tree: Tree, name: string) => byAttr(tree, "data-chip-clear", name);

/** What the open handler reads off the main form: the search box's LIVE text. */
function mainForm(q: string) {
  return { elements: [{ name: "tab", value: "registrants" }, { name: "q", value: q }] };
}
function open(isl: Island, typed?: string) {
  const tree = isl.tree();
  // With nothing typed since the page loaded, the search box shows its rendered default.
  const shown = typed ?? String(propsOf(byAttr(tree, "name", "q")!).defaultValue ?? "");
  (propsOf(filtersButton(tree)!).onClick as (e: unknown) => void)({ currentTarget: { form: mainForm(shown) } });
}
function close(isl: Island) {
  (propsOf(modal(isl.tree())!).onClose as () => void)();
}
function clearInSheet(isl: Island) {
  const btn = byAttr(isl.tree(), "data-filter-sheet-clear")!;
  (propsOf(btn).onClick as (e?: unknown) => void)({});
}

/** What the browser would hand `onSubmit` for the sheet's own form: each named
 *  control's current value — its rendered default, unless the test "edited" it.
 *  Built from the REAL rendered sheet, so what a person sees and what is pushed
 *  cannot drift apart in a fixture. */
function sheetElements(tree: Tree, staged: Record<string, string | boolean> = {}) {
  const form = sheetForm(tree);
  if (!form) throw new Error("the sheet is not open");
  const out: { name: string; value: string; type?: string; checked?: boolean }[] = [];
  for (const e of walkAll(form)) {
    const p = propsOf(e);
    if (!(e.type === "input" || e.type === "select") || typeof p.name !== "string") continue;
    if (p.type === "checkbox") {
      out.push({ name: p.name, value: String(p.value), type: "checkbox", checked: p.name in staged ? Boolean(staged[p.name]) : Boolean(p.defaultChecked) });
    } else if (p.type === "hidden") {
      out.push({ name: p.name, value: String(p.value) });
    } else {
      out.push({ name: p.name, value: p.name in staged ? String(staged[p.name]) : String(p.defaultValue ?? "") });
    }
  }
  return out;
}
function show(isl: Island, staged: Record<string, string | boolean> = {}) {
  const tree = isl.tree();
  const form = sheetForm(tree)!;
  const preventDefault = vi.fn();
  (propsOf(form).onSubmit as (e: unknown) => void)({ preventDefault, currentTarget: { elements: sheetElements(tree, staged) } });
  return { preventDefault };
}
/** The last push as a comparable structure. */
function pushed() {
  expect(nav.push).toHaveBeenCalledTimes(1);
  const href = String(nav.push.mock.calls[0]![0]);
  const url = new URL(href, "https://seazn.test");
  return { href, path: url.pathname, params: url.searchParams, search: url.search.slice(1) };
}
const entries = (p: URLSearchParams) => [...p.entries()].sort(([a], [b]) => a.localeCompare(b));

describe("the Filters button (phone)", () => {
  it("with nothing set: the button is there, reads 'Filters', carries no count, and no chip or Clear all appears", () => {
    const tree = island().tree();
    const button = filtersButton(tree);
    expect(button, "the Filters button").toBeTruthy();
    expect(propsOf(button!).type).toBe("button");
    expect(textOf(button!)).toBe("Filters");
    expect(badge(tree)).toBeUndefined();
    expect(chips(tree)).toHaveLength(0);
    expect(byAttr(tree, "data-chip-clear-all")).toBeUndefined();
  });

  it("each single narrowing filter makes the count 1 — and one chip", () => {
    const cases: Record<string, RegistrantsFilters> = {
      status: { ...DEFAULT_FILTERS, status: "paid" },
      division: { ...DEFAULT_FILTERS, divisionId: DIV1 },
      kind: { ...DEFAULT_FILTERS, kind: "pair" },
      solo: { ...DEFAULT_FILTERS, freeAgent: true },
      consent: { ...DEFAULT_FILTERS, consentPending: true },
    };
    let checked = 0;
    for (const [label, filters] of Object.entries(cases)) {
      const tree = island(filters).tree();
      expect(textOf(badge(tree)!), label).toBe("1");
      expect(chips(tree), label).toHaveLength(1);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("all five set: the count is 5 and equals the chips AND the set pills (one derivation, no drift)", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    expect(textOf(badge(tree)!)).toBe("5");
    expect(chips(tree)).toHaveLength(5);
    const setPills = allByAttr(tree, "data-filter-pill").filter((e) => propsOf(e)["data-set"] === "true");
    expect(setPills).toHaveLength(5);
  });

  it("the count is announced, not just drawn — the button's name carries it", () => {
    const tree = island({ ...DEFAULT_FILTERS, status: "paid", kind: "team" }).tree();
    const button = filtersButton(tree)!;
    expect(textOf(button)).toMatch(/Filters\s*2/);
  });

  it("a search alone is not a filter: no count, no chip — but Clear all appears, there is something to undo", () => {
    const tree = island({ ...DEFAULT_FILTERS, text: "alex" }, "tab=registrants&q=alex").tree();
    expect(badge(tree)).toBeUndefined();
    expect(chips(tree)).toHaveLength(0);
    expect(byAttr(tree, "data-chip-clear-all")).toBeTruthy();
  });

  it("a division id that matches no option reads as unset on the pill, so it is not counted here either", () => {
    const tree = island({ ...DEFAULT_FILTERS, divisionId: "gone" }, "tab=registrants&division_id=gone").tree();
    expect(badge(tree)).toBeUndefined();
    expect(chipOf(tree, "division_id")).toBeUndefined();
  });

  it("an explicit =0 toggle reads as unset on the pill and is not counted", () => {
    const tree = island({ ...DEFAULT_FILTERS, freeAgent: false, consentPending: false }).tree();
    expect(badge(tree)).toBeUndefined();
    expect(chips(tree)).toHaveLength(0);
  });

  it("opens a dialog (aria-haspopup) — the sheet, not a page", () => {
    expect(propsOf(filtersButton(island().tree())!)["aria-haspopup"]).toBe("dialog");
  });
});

describe("the sheet opens and closes without touching the URL", () => {
  it("is closed until the button is pressed", () => {
    const tree = island().tree();
    expect(modal(tree)).toBeUndefined();
    expect(sheetForm(tree)).toBeUndefined();
  });

  it("opening it renders the house Modal titled 'Filters' — and navigates nowhere", () => {
    const isl = island({ ...DEFAULT_FILTERS, status: "paid" }, "tab=registrants&status=paid");
    open(isl);
    const tree = isl.tree();
    const m = modal(tree);
    expect(m, "the Modal").toBeTruthy();
    expect(propsOf(m!).title).toBe("Filters");
    expect(sheetForm(tree)).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("the open state is nowhere in any href the open bar builds", () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl);
    const hrefs = walkAll(isl.tree().map((e) => e)) // flatten: a tree is already a flat list
      .map((e) => propsOf(e).href)
      .filter((h): h is string => typeof h === "string");
    expect(hrefs.length, "anti-vacuity: the bar has links").toBeGreaterThanOrEqual(6);
    for (const h of hrefs) expect(h, h).not.toMatch(/sheet|filters=|modal|dialog/i);
  });

  it("closing it (Escape, the close button, a tap outside) discards staged edits: nothing pushed, and reopening starts from the URL again", () => {
    const isl = island({ ...DEFAULT_FILTERS, status: "paid" }, "tab=registrants&status=paid");
    open(isl);
    // A staged edit lives only in the sheet's DOM; unmounting the sheet drops it.
    close(isl);
    expect(modal(isl.tree())).toBeUndefined();
    expect(nav.push).not.toHaveBeenCalled();
    open(isl);
    const status = walkAll(sheetForm(isl.tree())!).find((e) => e.type === "select" && propsOf(e).name === "status")!;
    expect(propsOf(status).defaultValue).toBe("paid");
  });

  it("a Modal, not a hand-rolled dialog: no second role=dialog or aria-modal in the sheet's tree", () => {
    const isl = island();
    open(isl);
    const tree = isl.tree();
    expect(tree.filter((e) => propsOf(e).role === "dialog" || propsOf(e)["aria-modal"] !== undefined)).toHaveLength(0);
    expect(modal(tree)).toBeTruthy();
  });
});

describe("the sheet holds status, division, kind, solo, consent and sort", () => {
  function sheetNames(filters: RegistrantsFilters = DEFAULT_FILTERS, search = "tab=registrants") {
    const isl = island(filters, search);
    open(isl);
    return { isl, tree: isl.tree(), elements: sheetElements(isl.tree()) };
  }

  it("names exactly: the hidden tab and q, the three selects, both checkboxes and sort", () => {
    const { elements } = sheetNames();
    expect(elements.map((e) => e.name).sort()).toEqual(
      ["tab", "q", "status", "division_id", "kind", "free_agent", "consent_pending", "sort"].sort(),
    );
  });

  it("is pre-filled from the URL's filters: selects, checkboxes and sort", () => {
    const { elements } = sheetNames(FULL_FILTERS, FULL_QUERY);
    const get = (n: string) => elements.find((e) => e.name === n)!;
    expect(get("status").value).toBe("confirmed");
    expect(get("division_id").value).toBe(DIV1);
    expect(get("kind").value).toBe("team");
    expect(get("sort").value).toBe("oldest");
    expect(get("free_agent").checked).toBe(true);
    expect(get("consent_pending").checked).toBe(true);
    expect(get("q").value).toBe("alex");
    expect(get("tab").value).toBe("registrants");
  });

  it("offers the same option sets as the pills", () => {
    const { tree } = sheetNames();
    const opts = (name: string) =>
      walkAll(sheetForm(tree)!)
        .find((e) => e.type === "select" && propsOf(e).name === name)!
        .props as { children?: ReactNode };
    const values = (name: string) => walkAll(opts(name).children).filter((e) => e.type === "option").map((e) => propsOf(e).value);
    expect(values("status")).toEqual(["", ...STATUS_OPTIONS]);
    expect(values("division_id")).toEqual(["", DIV1, DIV2]);
    expect(values("kind")).toEqual(["", ...KIND_OPTIONS]);
    expect(values("sort")).toEqual(["newest", "oldest"]);
  });

  it("every control is named: a visible <label for> per select, a wrapping label per switch", () => {
    const { tree } = sheetNames();
    const form = sheetForm(tree)!;
    const els = walkAll(form);
    const labels = els.filter((e) => e.type === "label");
    let checked = 0;
    for (const sel of els.filter((e) => e.type === "select")) {
      const id = propsOf(sel).id;
      expect(typeof id, String(propsOf(sel).name)).toBe("string");
      const label = labels.find((l) => propsOf(l).htmlFor === id);
      expect(label, `label for ${String(propsOf(sel).name)}`).toBeTruthy();
      expect(textOf(label!).length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(4);
    for (const box of els.filter((e) => e.type === "input" && propsOf(e).type === "checkbox")) {
      const wrapper = labels.find((l) => walkAll(l).includes(box));
      expect(wrapper, `label around ${String(propsOf(box).name)}`).toBeTruthy();
      expect(textOf(wrapper!).length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(6);
  });

  it("no control in the sheet submits or navigates on change — edits are staged until 'Show registrants'", () => {
    const { isl, tree } = sheetNames();
    const requestSubmit = vi.fn(() => show(isl));
    let controls = 0;
    for (const e of walkAll(sheetForm(tree)!)) {
      if (e.type !== "input" && e.type !== "select") continue;
      if (propsOf(e).type === "hidden") continue;
      controls += 1;
      const onChange = propsOf(e).onChange as ((ev: unknown) => void) | undefined;
      expect(onChange, `${String(propsOf(e).name)} has no onChange`).toBeUndefined();
      onChange?.({ target: { form: { requestSubmit } } });
    }
    expect(controls).toBe(6);
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("every control is a touch target: 44px selects, 44px switch rows, 44px footer buttons", () => {
    const { tree } = sheetNames();
    const els = walkAll(sheetForm(tree)!);
    for (const sel of els.filter((e) => e.type === "select")) {
      expect(tokens(sel), String(propsOf(sel).name)).toContain("h-11");
    }
    for (const label of els.filter((e) => e.type === "label" && propsOf(e).htmlFor === undefined)) {
      expect(tokens(label)).toContain("min-h-11");
    }
    for (const attr of ["data-filter-sheet-clear", "data-filter-sheet-show"]) {
      expect(tokens(byAttr(tree, attr)!), attr).toContain("min-h-11");
    }
  });

  it("the footer: Clear all (a button, never a link) and 'Show registrants' bound to the sheet's own form", () => {
    const { tree } = sheetNames();
    const clear = byAttr(tree, "data-filter-sheet-clear")!;
    const showBtn = byAttr(tree, "data-filter-sheet-show")!;
    expect(propsOf(clear).type).toBe("button");
    expect(textOf(clear)).toBe("Clear all");
    expect(propsOf(showBtn).type).toBe("submit");
    expect(textOf(showBtn)).toBe("Show registrants");
    // A submit button outside its <form> reaches it through `form=<id>`.
    const form = sheetForm(tree)!;
    expect(typeof propsOf(form).id).toBe("string");
    expect(propsOf(showBtn).form).toBe(propsOf(form).id);
  });
});

describe("Show registrants applies the staged edits with ONE push", () => {
  it("pushes once, carrying exactly what was staged, closes the sheet and stops the browser's own navigation", () => {
    const isl = island();
    open(isl);
    const { preventDefault } = show(isl, { status: "confirmed", consent_pending: true, sort: "oldest" });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const { path, params } = pushed();
    expect(path).toBe(ACTION);
    expect(entries(params)).toEqual(
      entries(new URLSearchParams("tab=registrants&status=confirmed&consent_pending=1&sort=oldest")),
    );
    expect(modal(isl.tree()), "the sheet closed").toBeUndefined();
  });

  it("drops what is empty — an unset select or unchecked switch never writes `key=`", () => {
    const isl = island();
    open(isl);
    show(isl, { status: "paid" });
    const { search } = pushed();
    expect(search).not.toMatch(/[?&][a-z_]+=(&|$)/);
    for (const name of ["division_id", "kind", "free_agent", "consent_pending", "q"]) {
      expect(new URLSearchParams(search).has(name), name).toBe(false);
    }
  });

  it("unknown params ride through the sheet (B7's `open`, a stray `page`) and a changed filter is never doubled", () => {
    const isl = island(
      { ...DEFAULT_FILTERS, status: "paid", text: "bob" },
      "tab=registrants&status=paid&q=bob&sort=newest&open=a,b&page=2",
    );
    open(isl, "bob");
    show(isl, { status: "confirmed" });
    const { params } = pushed();
    expect(params.get("open")).toBe("a,b");
    expect(params.get("page")).toBe("2");
    expect(params.getAll("status")).toEqual(["confirmed"]);
    expect(params.get("q")).toBe("bob");
    expect(params.get("tab")).toBe("registrants");
  });

  it("only what the form owns can leave: every key in the pushed URL is owned, or was already there", () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl, "alex");
    show(isl, { status: "", free_agent: false });
    const { params } = pushed();
    const before = new URLSearchParams(FULL_QUERY);
    let foreign = 0;
    for (const key of params.keys()) {
      if (!OWNED.has(key)) {
        foreign += 1;
        expect(before.has(key), key).toBe(true);
      }
    }
    expect(foreign, "anti-vacuity: the fixture carries unknown params").toBe(2);
    expect(params.has("status")).toBe(false);
    expect(params.has("free_agent")).toBe(false);
    expect(params.get("division_id")).toBe(DIV1);
  });

  it("apply -> URL -> reload -> same: the pushed URL, parsed the way the server does, re-renders the same chips and sheet", () => {
    const isl = island();
    open(isl);
    show(isl, { status: "confirmed", division_id: DIV2, kind: "pair", free_agent: true, consent_pending: true, sort: "oldest" });
    const { search } = pushed();
    const parsed = parseRegistrantsQuery(Object.fromEntries(new URLSearchParams(search)));
    expect(parsed).toMatchObject({ status: "confirmed", divisionId: DIV2, kind: "pair", freeAgent: true, consentPending: true, sort: "oldest" });

    const reload = island(parsed, search);
    const tree = reload.tree();
    expect(textOf(badge(tree)!)).toBe("5");
    expect(chips(tree).map((c) => propsOf(c)["data-filter-chip"])).toEqual([...FIVE]);
    // ...and a second reload of the same URL is identical.
    expect(JSON.stringify(island(parsed, search).tree())).toBe(JSON.stringify(tree));
    // The reopened sheet shows what was applied.
    open(reload);
    const els = sheetElements(reload.tree());
    expect(els.find((e) => e.name === "division_id")!.value).toBe(DIV2);
    expect(els.find((e) => e.name === "free_agent")!.checked).toBe(true);
    expect(els.find((e) => e.name === "sort")!.value).toBe("oldest");
  });

  it("a second Show after reopening pushes again — the sheet is not a one-shot", () => {
    const isl = island();
    open(isl);
    show(isl, { status: "paid" });
    expect(nav.push).toHaveBeenCalledTimes(1);
    open(isl);
    show(isl, { status: "confirmed" });
    expect(nav.push).toHaveBeenCalledTimes(2);
    expect(new URL(String(nav.push.mock.calls[1]![0]), "https://seazn.test").searchParams.get("status")).toBe("confirmed");
  });
});

describe("Clear all inside the sheet resets what is staged — it does not navigate", () => {
  it("empties every control, remounts them (new keys), and pushes nothing", () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl, "alex");
    const keyOf = (name: string) =>
      walkAll(sheetForm(isl.tree())!).find((e) => (e.type === "select" || e.type === "input") && propsOf(e).name === name)!.key;
    const before = ["status", "division_id", "kind", "free_agent", "consent_pending", "sort"].map(keyOf);
    clearInSheet(isl);
    const els = sheetElements(isl.tree());
    const get = (n: string) => els.find((e) => e.name === n)!;
    expect(get("status").value).toBe("");
    expect(get("division_id").value).toBe("");
    expect(get("kind").value).toBe("");
    expect(get("sort").value).toBe("newest");
    expect(get("free_agent").checked).toBe(false);
    expect(get("consent_pending").checked).toBe(false);
    expect(nav.push).not.toHaveBeenCalled();
    const after = ["status", "division_id", "kind", "free_agent", "consent_pending", "sort"].map(keyOf);
    expect(after.every((k, i) => k !== before[i]), "each control remounts, so a real browser re-reads its default").toBe(true);
    expect(sheetForm(isl.tree()), "the sheet stays open").toBeTruthy();
  });

  it("Show after Clear all pushes the cleared bar — but keeps the search and every unknown param", () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl, "alex");
    clearInSheet(isl);
    show(isl);
    const { params } = pushed();
    for (const name of FIVE) expect(params.has(name), name).toBe(false);
    expect(params.get("q")).toBe("alex");
    expect(params.get("open")).toBe("a,b");
    expect(params.get("page")).toBe("2");
    expect(params.get("tab")).toBe("registrants");
    expect(hasNoActiveFilter(parseRegistrantsQuery(Object.fromEntries(params)))).toBe(true);
  });

  it("closing after Clear all (without Show) leaves the URL's filters in force", () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl);
    clearInSheet(isl);
    close(isl);
    expect(nav.push).not.toHaveBeenCalled();
    open(isl);
    expect(sheetElements(isl.tree()).find((e) => e.name === "status")!.value).toBe("confirmed");
  });
});

function hasNoActiveFilter(f: RegistrantsFilters) {
  return f.status === null && f.divisionId === null && f.kind === null && !f.freeAgent && !f.consentPending;
}

describe("the search box and the sheet share one URL", () => {
  /** What a keystroke in the search box hands the debounced submit. */
  function type(isl: Island, text: string, requestSubmit: () => void) {
    const input = byAttr(isl.tree(), "name", "q")!;
    (propsOf(input).onChange as (e: unknown) => void)({ target: { form: { requestSubmit }, value: text } });
  }

  it("text typed in the search box rides into the sheet's push", () => {
    const isl = island();
    open(isl, "carol");
    expect(sheetElements(isl.tree()).find((e) => e.name === "q")!.value).toBe("carol");
    show(isl, { status: "paid" });
    expect(pushed().params.get("q")).toBe("carol");
  });

  it("falls back to the URL's own search text when the search box cannot be read", () => {
    const isl = island({ ...DEFAULT_FILTERS, text: "dave" }, "tab=registrants&q=dave");
    const button = filtersButton(isl.tree())!;
    (propsOf(button).onClick as (e: unknown) => void)({ currentTarget: { form: null } });
    expect(sheetElements(isl.tree()).find((e) => e.name === "q")!.value).toBe("dave");
  });

  it("Show cancels a still-pending search debounce — otherwise it would fire after the push and overwrite the sheet's filters with the old ones", () => {
    vi.useFakeTimers();
    try {
      const isl = island();
      const requestSubmit = vi.fn();
      type(isl, "er", requestSubmit);
      open(isl, "er");
      show(isl, { status: "paid" });
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
      expect(requestSubmit, "the stale debounce must not fire").not.toHaveBeenCalled();
      expect(nav.push).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the sheet without Show leaves the pending debounce alone — the typed text still gets searched", () => {
    vi.useFakeTimers();
    try {
      const isl = island();
      const requestSubmit = vi.fn();
      type(isl, "er", requestSubmit);
      open(isl, "er");
      close(isl);
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      expect(requestSubmit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the removable chips (phone) — the real producer of every pill's × href", () => {
  it("one chip per set filter, reading exactly what its pill reads", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    const text = (name: string) => textOf(walkAll(chipOf(tree, name)!).find((e) => propsOf(e)["data-pill-text"] !== undefined)!);
    expect(text("status")).toBe("Status: Confirmed");
    expect(text("division_id")).toBe("Division: Open Singles");
    expect(text("kind")).toBe("Entrant kind: Team");
    expect(text("free_agent")).toBe("Solo sign-ups");
    expect(text("consent_pending")).toBe("Consent pending");
  });

  it("each chip's × drops ONLY its own param — toggles included — and keeps tab, search, sort and the unknown params", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    let checked = 0;
    for (const name of FIVE) {
      const link = chipClear(tree, name);
      expect(link, name).toBeTruthy();
      const href = String(propsOf(link!).href);
      expect(href.startsWith(`${ACTION}?`), name).toBe(true);
      const got = new URLSearchParams(href.slice(ACTION.length + 1));
      const expected = [...new URLSearchParams(FULL_QUERY).entries()].filter(([k]) => k !== name);
      expect([...got.entries()], name).toEqual(expected);
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("following a toggle's × re-renders that toggle unset and leaves the other set", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    const href = String(propsOf(chipClear(tree, "free_agent")!).href);
    const url = new URL(href, "https://seazn.test");
    const after = parseRegistrantsQuery(Object.fromEntries(url.searchParams));
    expect(after.freeAgent).toBeNull();
    expect(after.consentPending).toBe(true);
    const next = island(after, url.search.slice(1)).tree();
    expect(chipOf(next, "free_agent")).toBeUndefined();
    expect(chipOf(next, "consent_pending")).toBeTruthy();
    expect(textOf(badge(next)!)).toBe("4");
  });

  it("a × is named for what it clears and is a real link", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    expect(propsOf(chipClear(tree, "status")!)["aria-label"]).toBe("Clear Status");
    expect(propsOf(chipClear(tree, "free_agent")!)["aria-label"]).toBe("Clear Solo sign-ups");
    expect(propsOf(chipClear(tree, "consent_pending")!)["aria-label"]).toBe("Clear Consent pending");
    for (const name of FIVE) expect(typeof propsOf(chipClear(tree, name)!).href).toBe("string");
  });

  it("the phone Clear all links to the bare tab and shows only while something narrows", () => {
    expect(byAttr(island().tree(), "data-chip-clear-all")).toBeUndefined();
    const link = byAttr(island(FULL_FILTERS, FULL_QUERY).tree(), "data-chip-clear-all")!;
    expect(propsOf(link).href).toBe(`${ACTION}?tab=registrants`);
    expect(textOf(link)).toBe("Clear all");
  });

  it("chip and × are touch targets: 44px tall, 44px wide ×", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    for (const name of FIVE) {
      expect(tokens(chipOf(tree, name)!), name).toContain("h-11");
      expect(tokens(chipClear(tree, name)!), name).toContain("w-11");
    }
    expect(tokens(byAttr(tree, "data-chip-clear-all")!)).toContain("h-11");
  });
});

describe("one DOM, two faces: what shows below md and what shows from md", () => {
  // `/\bmd:hidden\b/` also matches inside `max-md:hidden` (AGENTS.md), so every
  // check here compares whole class TOKENS.
  const phoneRow = (tree: Tree) => byAttr(tree, "data-filter-phone-row")!;
  const pillRow = (tree: Tree) => byAttr(tree, "data-filter-pill-row")!;

  it("the pill row folds away below md; the phone row (Filters button + chips) exists only below it", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    expect(tokens(pillRow(tree))).toContain("max-md:hidden");
    expect(tokens(pillRow(tree))).not.toContain("md:hidden");
    expect(tokens(phoneRow(tree))).toContain("md:hidden");
    expect(tokens(phoneRow(tree))).not.toContain("max-md:hidden");
  });

  it("the Filters button, every chip and the phone Clear all live inside the md:hidden row — and no pill does", () => {
    const tree = island(FULL_FILTERS, FULL_QUERY).tree();
    const inPhone = walkAll(phoneRow(tree));
    expect(inPhone).toContain(filtersButton(tree));
    expect(chips(tree).every((c) => inPhone.includes(c))).toBe(true);
    expect(inPhone).toContain(byAttr(tree, "data-chip-clear-all")!);
    expect(inPhone.some((e) => propsOf(e)["data-filter-pill"] !== undefined)).toBe(false);
    const inPills = walkAll(pillRow(tree));
    expect(allByAttr(tree, "data-filter-pill").every((p) => inPills.includes(p))).toBe(true);
    expect(inPills).not.toContain(filtersButton(tree));
  });

  it("the standalone sort select is md and up only (below it, sort lives in the sheet); the search box shows at every width", () => {
    const tree = island().tree();
    const sort = tree.find((e) => e.type === "select" && propsOf(e).name === "sort")!;
    expect(tokens(sort)).toContain("max-md:hidden");
    const search = tree.find((e) => e.type === "input" && propsOf(e).name === "q")!;
    expect(tokens(search)).not.toContain("max-md:hidden");
    expect(tokens(search)).not.toContain("md:hidden");
  });

  // The sheet's own classes, in its busiest state, must each compile: a mistyped
  // variant (`peer-chekced:`, `after:translate-x-4` spelled wrong) styles nothing
  // and no markup test notices.
  it("every utility the phone bar and the open sheet render is a real Tailwind class", async () => {
    const isl = island(FULL_FILTERS, FULL_QUERY);
    open(isl, "alex");
    const names = new Set<string>();
    for (const el of isl.tree()) for (const tok of tokens(el)) names.add(tok);
    for (const marker of ["peer", "input", "btn", "btn-primary", "btn-ghost"]) names.delete(marker);
    const compiled = await compileClasses([...names]);
    const dead = [...names].filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(dead, `classes that compile to nothing: ${dead.join(" ")}`).toEqual([]);
    expect(names.size, "anti-vacuity").toBeGreaterThan(60);
    for (const must of ["md:hidden", "max-md:hidden", "peer-checked:bg-purple-600", "min-h-11"]) {
      expect(names.has(must), must).toBe(true);
    }
  });
});

describe("copy: the new keys exist in all four locales and the toggle labels are trimmed to the mock", () => {
  it("reg.filters.open / show / sheetTitle resolve in en, es, fr and nl", async () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = await getDictionary(locale, "ui");
      for (const key of ["reg.filters.open", "reg.filters.show", "reg.filters.sheetTitle"] as const) {
        const text = t(d, key);
        expect(text, `${locale} ${key}`).not.toBe(key);
        expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it("English: 'Solo sign-ups' and 'Consent pending' — the trailing 'only' is gone, here and everywhere the toggles read", async () => {
    expect(t(dict, "reg.hub.registrants.filters.freeAgent")).toBe("Solo sign-ups");
    expect(t(dict, "reg.hub.registrants.filters.consentPending")).toBe("Consent pending");
    expect(t(dict, "reg.filters.open")).toBe("Filters");
    expect(t(dict, "reg.filters.show")).toBe("Show registrants");
    expect(t(dict, "reg.filters.sheetTitle")).toBe("Filters");
  });

  it("every locale's toggle label is shorter than the pre-trim French one that clipped at 320 (34 characters)", async () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = await getDictionary(locale, "ui");
      for (const key of ["reg.hub.registrants.filters.freeAgent", "reg.hub.registrants.filters.consentPending"] as const) {
        expect(t(d, key).length, `${locale} ${key}`).toBeLessThan(34);
        checked += 1;
      }
    }
    expect(checked).toBe(8);
  });
});
