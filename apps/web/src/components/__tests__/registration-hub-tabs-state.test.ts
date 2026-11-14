// B7 T22 — the registration hub's tab state (spec 2026-11-13 §9.1): which
// division settings tabs are open (`?open=`, at most 2, least recently used
// first) and which tab is active (`?tab=settings|registrants|division:<id>`).
//
// Every expected value below comes from the spec's own wording, never from
// the module: the cap is 2 ("up to 2 division ids"), the order is LRU-first,
// the eviction victim is `open[0]` (§9.2 "Evicts open[0] (LRU)"), and the URL
// grammar is §9.1's. The two properties at the bottom check the same rules
// against an independent reference model (last-use timestamps, not list
// surgery): one is a differential of `parseHubTabs` itself over random
// addresses and `openable` sets, and the other starts from the model's own
// reading of a random address and checks after every step of random
// open / activate / close sequences.
//
// Registration is sport-agnostic: no sport sweep applies to tab state.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activate,
  closeDivision,
  hubTabParam,
  hubTabsQuery,
  openDivision,
  parseHubTabs,
  replaceHubTabs,
  type HubTab,
  type HubTabsState,
} from "@/components/registration-hub-tabs-state";
import { buildFilteredHref, clearOneHref } from "@/components/registration-hub-registrant-filters";
import { routes } from "@/lib/routes";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
/** An archived division, or another competition's: never openable. */
const STRANGER = "eeeeeeee-0000-4000-8000-000000000005";
const IDS = [A, B, C, D] as const;
/** `openable` when the viewer can edit: every non-archived division on the Settings tab. */
const ALL: ReadonlySet<string> = new Set(IDS);
/** `openable` for a viewer without `canEdit` (spec §9.1). */
const NONE: ReadonlySet<string> = new Set();

const EMPTY: HubTabsState = { active: "settings", open: [] };

/** The state as a pure function must see it: any write to it throws (ESM is strict mode). */
function frozen(s: HubTabsState): HubTabsState {
  if (typeof s.active !== "string") Object.freeze(s.active);
  Object.freeze(s.open);
  return Object.freeze(s);
}

/** The `{ tab, open }` slice of a real href, read the way Next hands it to the page. */
function tabParamsOf(href: string): { tab?: string; open?: string } {
  const search = new URL(href, "https://seazn.test/o/acme/c/cup/registration").searchParams;
  return { tab: search.get("tab") ?? undefined, open: search.get("open") ?? undefined };
}

/** §9.1's `tab` grammar, written from the spec (not from the module). */
function tabParamFromSpec(active: HubTab): "settings" | "registrants" | `division:${string}` {
  return typeof active === "string" ? active : `division:${active.division}`;
}

describe("parseHubTabs — URL to state (spec §9.1 normalisation)", () => {
  it("empty case first: no params and nothing openable is Settings with no division tabs", () => {
    expect(parseHubTabs({}, NONE)).toStrictEqual({ active: "settings", open: [] });
  });

  it("no params with every division openable is still Settings with no division tabs", () => {
    expect(parseHubTabs({}, ALL)).toStrictEqual({ active: "settings", open: [] });
  });

  it("honours settings and registrants, and anything else that is not a division tab falls back to Settings", () => {
    expect(parseHubTabs({ tab: "settings" }, ALL).active).toBe("settings");
    expect(parseHubTabs({ tab: "registrants" }, ALL).active).toBe("registrants");
    for (const tab of ["bogus", "", "Registrants", "division", `Division:${A}`, `${A}`]) {
      expect(parseHubTabs({ tab }, ALL), tab).toStrictEqual({ active: "settings", open: [] });
    }
  });

  it("drops ids that are not openable, empty segments included", () => {
    expect(parseHubTabs({ open: `${A},${STRANGER},,${B}` }, ALL).open).toStrictEqual([A, B]);
    expect(parseHubTabs({ open: "" }, ALL).open).toStrictEqual([]);
    expect(parseHubTabs({ open: ",," }, ALL).open).toStrictEqual([]);
  });

  it("drops duplicates, keeping the LAST mention (the list is least recently used first, so the last mention is the latest use)", () => {
    expect(parseHubTabs({ open: `${A},${B},${A}` }, ALL).open).toStrictEqual([B, A]);
  });

  it("open=a,b,c keeps the last two, [b,c] — not the first two", () => {
    expect(parseHubTabs({ open: `${A},${B},${C}` }, ALL).open).toStrictEqual([B, C]);
  });

  it("drops unknown ids and duplicates BEFORE capping, so a stranger or a repeat never costs a real tab its place", () => {
    // Capping first would keep [B] (from `B,STRANGER`) and [B] (from `B,B`).
    expect(parseHubTabs({ open: `${A},${B},${STRANGER}` }, ALL).open).toStrictEqual([A, B]);
    expect(parseHubTabs({ open: `${A},${B},${B}` }, ALL).open).toStrictEqual([A, B]);
  });

  it("tab=division:x with x not in open appends x, then re-caps to 2 (evicting the least recently used)", () => {
    expect(parseHubTabs({ tab: `division:${C}`, open: A }, ALL)).toStrictEqual({
      active: { division: C },
      open: [A, C],
    });
    expect(parseHubTabs({ tab: `division:${C}`, open: `${A},${B}` }, ALL)).toStrictEqual({
      active: { division: C },
      open: [B, C],
    });
    expect(parseHubTabs({ tab: `division:${C}` }, ALL)).toStrictEqual({ active: { division: C }, open: [C] });
  });

  it("the append runs AFTER the cap: a tab=division:x that the cap dropped from open=x,b,c comes back at the end", () => {
    // Spec order: drop unknown, drop duplicates, keep the last 2, THEN append
    // x and re-cap. Appending first would keep the given order, [b,c] or [x,b].
    expect(parseHubTabs({ tab: `division:${A}`, open: `${A},${B},${C}` }, ALL)).toStrictEqual({
      active: { division: A },
      open: [C, A],
    });
  });

  it("tab=division:x with x already open keeps the order it was given (the append rule is only for an absent x)", () => {
    expect(parseHubTabs({ tab: `division:${A}`, open: `${A},${B}` }, ALL)).toStrictEqual({
      active: { division: A },
      open: [A, B],
    });
  });

  it("an active division that does not survive becomes Settings, and the other tabs stay", () => {
    expect(parseHubTabs({ tab: `division:${STRANGER}`, open: A }, ALL)).toStrictEqual({ active: "settings", open: [A] });
    expect(parseHubTabs({ tab: "division:", open: A }, ALL)).toStrictEqual({ active: "settings", open: [A] });
  });

  it("openable empty (no canEdit) gives no division tabs: a division tab lands on Settings, Registrants stays", () => {
    expect(parseHubTabs({ tab: `division:${A}`, open: `${A},${B}` }, NONE)).toStrictEqual({ active: "settings", open: [] });
    expect(parseHubTabs({ tab: "registrants", open: `${A},${B}` }, NONE)).toStrictEqual({ active: "registrants", open: [] });
  });

  it("guard: Next's array-valued repeated ?open=a&open=b or ?tab=x&tab=y reads as its FIRST value (house rule, data.ts firstOf)", () => {
    // Next's real runtime shape for a repeated key is a string[], which the
    // `{ tab?: string; open?: string }` parameter cannot express; the cast
    // reaches that shape directly. A `.split` on it would crash the page.
    const many = (...values: string[]) => values as unknown as string;
    expect(parseHubTabs({ tab: "registrants", open: many(A, B) }, ALL)).toStrictEqual({ active: "registrants", open: [A] });
    expect(parseHubTabs({ open: many(`${A},${B}`, C) }, ALL)).toStrictEqual({ active: "settings", open: [A, B] });
    expect(parseHubTabs({ tab: many(`division:${A}`, "settings"), open: B }, ALL)).toStrictEqual({
      active: { division: A },
      open: [B, A],
    });
    expect(parseHubTabs({ tab: many("registrants", "settings") }, ALL).active).toBe("registrants");
    // An empty array (should Next ever produce one) is the same as absent.
    expect(parseHubTabs({ tab: many(), open: many() }, ALL)).toStrictEqual({ active: "settings", open: [] });
  });

  it("differential shrink (seed 22013, path 11:0:2:2:3): open given as a one-element array [b] with openable {b} reads as [b]", () => {
    // Shrunk by the differential property below against the pre-ruling
    // module, which read any array as absent and answered open [].
    expect(parseHubTabs({ open: [B] as unknown as string }, new Set([B]))).toStrictEqual({ active: "settings", open: [B] });
  });
});

describe("hubTabsQuery — state to URL (spec §9.1 grammar)", () => {
  it("empty case first: Settings with nothing open is just tab=settings, no open param", () => {
    expect(hubTabsQuery(EMPTY)).toStrictEqual({ tab: "settings" });
  });

  it("writes tab=division:<id> and open as a comma list, least recently used first", () => {
    expect(hubTabsQuery({ active: { division: B }, open: [A, B] })).toStrictEqual({
      tab: `division:${B}`,
      open: `${A},${B}`,
    });
    expect(hubTabsQuery({ active: "registrants", open: [C] })).toStrictEqual({ tab: "registrants", open: C });
  });

  it("guard: an id the comma list cannot carry (empty, or holding a comma) is refused, never written into a URL that reads back differently", () => {
    expect(() => hubTabsQuery({ active: "settings", open: [""] })).toThrow(/cannot ride in the URL/);
    expect(() => hubTabsQuery({ active: "settings", open: [A, "x,y"] })).toThrow(/cannot ride in the URL/);
  });
});

describe("hubTabParam — a tab as the route builder's ?tab= value", () => {
  it("is §9.1's grammar for each kind of tab", () => {
    expect(hubTabParam("settings")).toBe("settings");
    expect(hubTabParam("registrants")).toBe("registrants");
    expect(hubTabParam({ division: A })).toBe(`division:${A}`);
  });

  it("is the value hubTabsQuery writes, so a route href and a query agree", () => {
    const s: HubTabsState = { active: { division: B }, open: [A, B] };
    expect(hubTabsQuery(s).tab).toBe(hubTabParam(s.active));
  });
});

describe("replaceHubTabs — the tab state onto a live address, replacing both keys", () => {
  it("empty case first: closing the last tab REMOVES open from the address (a merge would keep it and the tab comes back)", () => {
    const live = new URLSearchParams(`tab=division:${A}&open=${A}&status=paid`);
    const next = replaceHubTabs(live, closeDivision(frozen({ active: { division: A }, open: [A] }), A));
    expect(next.has("open")).toBe(false);
    expect(next.get("tab")).toBe("settings");
    expect(parseHubTabs({ tab: next.get("tab") ?? undefined, open: next.get("open") ?? undefined }, ALL)).toStrictEqual(EMPTY);
  });

  it("keeps every param it does not own, and writes tab and open once each even when the address repeated them", () => {
    const live = new URLSearchParams(`open=${A}&open=${C}&tab=registrants&tab=settings&kind=team&status=paid`);
    const next = replaceHubTabs(live, { active: { division: B }, open: [A, B] });
    expect(next.getAll("tab")).toStrictEqual([`division:${B}`]);
    expect(next.getAll("open")).toStrictEqual([`${A},${B}`]);
    expect(next.get("kind")).toBe("team");
    expect(next.get("status")).toBe("paid");
  });

  it("never writes to the address it was given", () => {
    const live = new URLSearchParams(`tab=registrants&open=${A}&status=paid`);
    const before = live.toString();
    replaceHubTabs(live, EMPTY);
    expect(live.toString()).toBe(before);
  });
});

describe("guard: a state over the cap is refused by name (precondition, spec §9.1 'up to 2')", () => {
  it("every function that takes a state throws on 3 open, naming itself, instead of answering wrongly", () => {
    const over = frozen({ active: { division: C }, open: [A, B, C] });
    expect(() => openDivision(over, D)).toThrow(/^openDivision: a hub tab state holds at most 2 open divisions, got 3/);
    expect(() => activate(over, "settings")).toThrow(/^activate: a hub tab state holds at most 2 open divisions, got 3/);
    expect(() => closeDivision(over, A)).toThrow(/^closeDivision: a hub tab state holds at most 2 open divisions, got 3/);
    expect(() => hubTabsQuery(over)).toThrow(/^hubTabsQuery: a hub tab state holds at most 2 open divisions, got 3/);
    expect(() => replaceHubTabs(new URLSearchParams(), over)).toThrow(/at most 2 open divisions, got 3/);
  });

  it("2 open is within the cap (the boundary is allowed)", () => {
    const full = frozen({ active: { division: B }, open: [A, B] });
    expect(closeDivision(full, A)).toStrictEqual({ active: { division: B }, open: [B] });
  });
});

describe("openDivision — 'Open settings' on a division row (spec §9.2)", () => {
  it("empty case first: opening from nothing adds the tab and activates it, evicting nothing", () => {
    expect(openDivision(frozen({ ...EMPTY, open: [] }), A)).toStrictEqual({
      state: { active: { division: A }, open: [A] },
      evicted: null,
    });
  });

  it("a second division joins at the end (most recently used), evicting nothing", () => {
    expect(openDivision(frozen({ active: { division: A }, open: [A] }), B)).toStrictEqual({
      state: { active: { division: B }, open: [A, B] },
      evicted: null,
    });
  });

  it("a third division with 2 open evicts open[0] (the LRU) and reports it", () => {
    expect(openDivision(frozen({ active: { division: B }, open: [A, B] }), C)).toStrictEqual({
      state: { active: { division: C }, open: [B, C] },
      evicted: A,
    });
  });

  it("the LRU is open[0] even when it is the ACTIVE tab: activation order, not the active flag, decides", () => {
    // Reached by parsing `tab=division:A&open=A,B` (the URL's order is kept).
    expect(openDivision(frozen({ active: { division: A }, open: [A, B] }), C)).toStrictEqual({
      state: { active: { division: C }, open: [B, C] },
      evicted: A,
    });
  });

  it("Reopen after an eviction runs openDivision again and so evicts the next LRU (sequence)", () => {
    const first = openDivision(frozen({ active: { division: B }, open: [A, B] }), C);
    expect(first.evicted).toBe(A);
    const reopened = openDivision(frozen(first.state), A);
    expect(reopened).toStrictEqual({ state: { active: { division: A }, open: [C, A] }, evicted: B });
  });

  it("opening an already-open id is a no-op on open apart from moving it to the end, and activates it", () => {
    expect(openDivision(frozen({ active: "settings", open: [A, B] }), A)).toStrictEqual({
      state: { active: { division: A }, open: [B, A] },
      evicted: null,
    });
    expect(openDivision(frozen({ active: "registrants", open: [A, B] }), B)).toStrictEqual({
      state: { active: { division: B }, open: [A, B] },
      evicted: null,
    });
  });

  it("second call: opening the same division twice is the same state, and the second evicts nothing", () => {
    const once = openDivision(frozen({ active: { division: B }, open: [A, B] }), C);
    const twice = openDivision(frozen(once.state), C);
    expect(twice).toStrictEqual({ state: once.state, evicted: null });
  });
});

describe("activate — switching tabs (spec §9.1, §9.2)", () => {
  it("empty case first: Settings or Registrants with nothing open leaves open empty", () => {
    expect(activate(frozen({ ...EMPTY, open: [] }), "registrants")).toStrictEqual({ active: "registrants", open: [] });
    expect(activate(frozen({ active: "registrants", open: [] }), "settings")).toStrictEqual(EMPTY);
  });

  it("Settings or Registrants never reorders the open division tabs", () => {
    expect(activate(frozen({ active: { division: B }, open: [A, B] }), "registrants")).toStrictEqual({
      active: "registrants",
      open: [A, B],
    });
  });

  it("an activated division moves to the end of open (it is now the most recently used)", () => {
    expect(activate(frozen({ active: "settings", open: [A, B] }), { division: A })).toStrictEqual({
      active: { division: A },
      open: [B, A],
    });
  });

  it("refusal: activating a division that is not open changes nothing (it has no tab; opening is openDivision's job, which reports evictions)", () => {
    const s = frozen({ active: "registrants", open: [A, B] });
    expect(activate(s, { division: C })).toStrictEqual({ active: "registrants", open: [A, B] });
    expect(activate(frozen({ ...EMPTY, open: [] }), { division: A })).toStrictEqual(EMPTY);
  });
});

describe("closeDivision — × on a tab (spec §9.2)", () => {
  it("empty case first: closing with nothing open is the same empty state", () => {
    expect(closeDivision(frozen({ ...EMPTY, open: [] }), A)).toStrictEqual(EMPTY);
  });

  it("closing the active tab falls back to Settings", () => {
    expect(closeDivision(frozen({ active: { division: B }, open: [A, B] }), B)).toStrictEqual({
      active: "settings",
      open: [A],
    });
  });

  it("closing the only tab while it is active leaves Settings with nothing open", () => {
    expect(closeDivision(frozen({ active: { division: A }, open: [A] }), A)).toStrictEqual(EMPTY);
  });

  it("closing an inactive tab keeps the active one, division or Registrants", () => {
    expect(closeDivision(frozen({ active: { division: B }, open: [A, B] }), A)).toStrictEqual({
      active: { division: B },
      open: [B],
    });
    expect(closeDivision(frozen({ active: "registrants", open: [A, B] }), B)).toStrictEqual({
      active: "registrants",
      open: [A],
    });
  });

  it("second call: closing an id that is not open changes nothing", () => {
    const once = closeDivision(frozen({ active: { division: B }, open: [A, B] }), B);
    expect(closeDivision(frozen(once), B)).toStrictEqual(once);
  });
});

// The route builder's own exact strings live in lib/__tests__/routes.test.ts;
// these are the seams: what one side writes, the other reads back.
describe("the URL seams the tab state crosses", () => {
  it("a route href read back the way Next hands it to the page parses to the state it was built from", () => {
    const s: HubTabsState = { active: { division: B }, open: [A, B] };
    const href = routes.competitionRegistration("acme", "cup", hubTabParam(s.active), undefined, s.open);
    expect(parseHubTabs(tabParamsOf(href), ALL)).toStrictEqual(s);
    // With the Registrants division filter riding alongside, too.
    const filtered = routes.competitionRegistration("acme", "cup", "registrants", C, [A, B]);
    expect(parseHubTabs(tabParamsOf(filtered), ALL)).toStrictEqual({ active: "registrants", open: [A, B] });
  });

  it("hubTabsQuery through a real URLSearchParams (which percent-encodes ':' and ',') parses back to the same state", () => {
    const s: HubTabsState = { active: { division: A }, open: [B, A] };
    const href = `/o/acme/c/cup/registration?${new URLSearchParams(hubTabsQuery(s)).toString()}`;
    expect(href).toContain("%2C");
    expect(parseHubTabs(tabParamsOf(href), ALL)).toStrictEqual(s);
  });

  it("a filter submit and a chip × keep the open tabs (T20/T21 carry-over); the filter form owns tab, so it reads as Registrants", () => {
    const action = routes.competitionRegistration("acme", "cup");
    const formFields = [
      { name: "tab", value: "registrants", type: "hidden" },
      { name: "status", value: "confirmed" },
      { name: "q", value: "" },
    ];
    const cases = [
      new URLSearchParams(`tab=registrants&open=${A},${B}&status=pending`),
      // Encoded, the way a URLSearchParams-built href (hubTabsQuery) arrives.
      new URLSearchParams(new URLSearchParams({ tab: "registrants", open: `${A},${B}`, kind: "team" }).toString()),
      // A stale division tab in the address: the form's own hidden tab wins.
      new URLSearchParams(`tab=division:${B}&open=${A},${B}&status=pending`),
    ];
    let checked = 0;
    for (const current of cases) {
      const submitted = buildFilteredHref(action, formFields, current);
      const cleared = `${action}${clearOneHref(current, "status")}`;
      for (const href of [submitted, cleared]) {
        expect(parseHubTabs(tabParamsOf(href), ALL), href).toStrictEqual({ active: "registrants", open: [A, B] });
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });
});

// ── Model test (TEST-STRATEGY rule 10) ─────────────────────────────────────

type Cmd =
  | { k: "open"; id: string }
  | { k: "activate"; tab: HubTab }
  | { k: "close"; id: string };

const idArb = fc.constantFrom(...IDS);
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 3, arbitrary: idArb.map((id) => ({ k: "open" as const, id })) },
  {
    weight: 2,
    arbitrary: fc
      .oneof(
        fc.constantFrom<HubTab>("settings", "registrants"),
        idArb.map((id): HubTab => ({ division: id })),
      )
      .map((tab) => ({ k: "activate" as const, tab })),
  },
  { weight: 2, arbitrary: idArb.map((id) => ({ k: "close" as const, id })) },
);
/** A query param the way Next hands it to a page: one string, or a string[] when the key repeats. */
type RawValue = string | string[];
type RawParams = { tab?: RawValue; open?: RawValue };

const tabTokenArb = fc.constantFrom(
  "settings",
  "registrants",
  "bogus",
  "division:",
  `division:${STRANGER}`,
  ...IDS.map((id) => `division:${id}`),
);
const openListArb = fc.array(fc.constantFrom(...IDS, STRANGER, ""), { maxLength: 6 }).map((ids) => ids.join(","));
/** Where a session starts: any address an organiser could land on, hand-edited and repeated keys included. */
const rawArb: fc.Arbitrary<RawParams> = fc.record(
  {
    tab: fc.oneof({ weight: 4, arbitrary: tabTokenArb }, { weight: 1, arbitrary: fc.array(tabTokenArb, { maxLength: 3 }) }),
    open: fc.oneof({ weight: 4, arbitrary: openListArb }, { weight: 1, arbitrary: fc.array(openListArb, { maxLength: 3 }) }),
  },
  { requiredKeys: [] },
);
/** The page passes Next's searchParams straight in; the parameter type cannot say string[]. */
const asParams = (raw: RawParams) => raw as { tab?: string; open?: string };

/** The reference model: open tabs as last-use timestamps (spec §9.1 "least
 *  recently used first"; cap 2), a different data structure from the
 *  module's list on purpose. */
class LruModel {
  private clock = 0;
  private readonly used = new Map<string, number>();
  active: HubTab = "settings";

  /** The spec's reading of an address, done as an LRU: every openable id in
   *  the open list is USED in order (so a repeat moves to the end and the cap
   *  keeps the latest 2), then a requested division tab that is not open by
   *  then is used too. A repeated key reads as its first value (house rule). */
  static fromRaw(raw: RawParams, openable: ReadonlySet<string>): LruModel {
    const first = (v: RawValue | undefined) => (Array.isArray(v) ? v[0] : v);
    const model = new LruModel();
    const open = first(raw.open);
    for (const id of open === undefined ? [] : open.split(",")) if (openable.has(id)) model.use(id);
    const tab = first(raw.tab);
    if (tab?.startsWith("division:")) {
      const id = tab.slice("division:".length);
      if (openable.has(id) && !model.open.includes(id)) model.use(id);
      model.active = model.open.includes(id) ? { division: id } : "settings";
    } else {
      model.active = tab === "registrants" ? "registrants" : "settings";
    }
    return model;
  }

  get open(): string[] {
    return [...this.used.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  }

  /** Marks `id` as the latest use; past the cap the least recently used goes, and is returned. */
  private use(id: string): string | null {
    this.used.set(id, ++this.clock);
    if (this.used.size <= 2) return null;
    const lru = this.open[0];
    this.used.delete(lru);
    return lru;
  }

  apply(cmd: Cmd): string | null {
    if (cmd.k === "open") {
      this.active = { division: cmd.id };
      return this.use(cmd.id);
    }
    if (cmd.k === "activate") {
      if (typeof cmd.tab === "string") this.active = cmd.tab;
      else if (this.used.has(cmd.tab.division)) {
        this.use(cmd.tab.division);
        this.active = { division: cmd.tab.division };
      }
      return null;
    }
    this.used.delete(cmd.id);
    if (typeof this.active !== "string" && this.active.division === cmd.id) this.active = "settings";
    return null;
  }
}

const MODEL_SEED = 220_13;
const MODEL_RUNS = 400;
const DIFF_RUNS = 600;

describe("differential: parseHubTabs against the LRU model's reading of the same address", () => {
  it("agrees on every random address and every openable set (empty included), repeated keys and strangers included", () => {
    const tally = { checked: 0, emptyOpenable: 0, repeatedKeys: 0, capped: 0, appended: 0, divisionActive: 0 };
    fc.assert(
      fc.property(rawArb, fc.subarray<string>([...IDS]), (raw, openableIds) => {
        const openable: ReadonlySet<string> = new Set(openableIds);
        const model = LruModel.fromRaw(raw, openable);
        expect(parseHubTabs(asParams(raw), openable)).toStrictEqual({ active: model.active, open: model.open });
        tally.checked += 1;
        if (openable.size === 0) tally.emptyOpenable += 1;
        if (Array.isArray(raw.tab) || Array.isArray(raw.open)) tally.repeatedKeys += 1;
        const firstOpen = Array.isArray(raw.open) ? raw.open[0] : raw.open;
        const kept = new Set((firstOpen ?? "").split(",").filter((id) => openable.has(id)));
        if (kept.size > 2) tally.capped += 1;
        if (typeof model.active !== "string") {
          tally.divisionActive += 1;
          if (!kept.has(model.active.division)) tally.appended += 1;
        }
      }),
      { seed: MODEL_SEED, numRuns: DIFF_RUNS },
    );
    // Anti-vacuity: 0 checked is a failure, and so is a run that never reached
    // an empty openable set, a repeated key, the cap, an appended division
    // tab, or a division tab at all.
    console.info(`[T22 differential] ${tally.checked} addresses checked`, tally);
    expect(tally.checked).toBe(DIFF_RUNS);
    for (const [branch, count] of Object.entries(tally)) expect(count, branch).toBeGreaterThan(0);
  });
});

describe("model test: random open / activate / close sequences over 4 divisions", () => {
  it("after EVERY step: ≤ 2 open, no duplicates, an active division is open, the URL round-trips, and the state matches the LRU model", () => {
    const tally = { runs: 0, steps: 0, evictions: 0, activeCloses: 0, refusedActivates: 0, urlAppends: 0 };
    /** A live address holding stale tab state and a filter: replacing must drop the former and keep the latter. */
    const stale = new URLSearchParams(`tab=division:${D}&open=${A},${B},${C}&status=paid`);

    function checkStep(s: HubTabsState, model: LruModel): void {
      expect(s.open.length).toBeLessThanOrEqual(2);
      expect(new Set(s.open).size).toBe(s.open.length);
      if (typeof s.active !== "string") expect(s.open).toContain(s.active.division);
      expect(s).toStrictEqual({ active: model.active, open: model.open });
      expect(parseHubTabs(hubTabsQuery(s), ALL)).toStrictEqual(s);
      expect(hubTabParam(s.active)).toBe(tabParamFromSpec(s.active));
      const href = routes.competitionRegistration("acme", "cup", tabParamFromSpec(s.active), undefined, s.open);
      expect(parseHubTabs(tabParamsOf(href), ALL)).toStrictEqual(s);
      const replaced = replaceHubTabs(stale, s);
      expect(parseHubTabs(tabParamsOf(`?${replaced.toString()}`), ALL)).toStrictEqual(s);
      expect(replaced.get("status")).toBe("paid");
      tally.steps += 1;
    }

    fc.assert(
      fc.property(rawArb, fc.array(cmdArb, { maxLength: 24 }), (raw, cmds) => {
        tally.runs += 1;
        // The start state is the MODEL's reading of the address, checked
        // against the module's — never the module's reading fed to the model.
        const model = LruModel.fromRaw(raw, ALL);
        let s = parseHubTabs(asParams(raw), ALL);
        const rawTab = Array.isArray(raw.tab) ? raw.tab[0] : raw.tab;
        const rawOpen = Array.isArray(raw.open) ? raw.open[0] : raw.open;
        const requested = rawTab?.startsWith("division:") ? rawTab.slice("division:".length) : null;
        if (requested && ALL.has(requested) && !rawOpen?.split(",").includes(requested)) tally.urlAppends += 1;
        checkStep(s, model);
        for (const cmd of cmds) {
          const before = frozen(s);
          const expectedEvicted = model.apply(cmd);
          if (cmd.k === "open") {
            const { state, evicted } = openDivision(before, cmd.id);
            expect(evicted).toBe(expectedEvicted);
            if (evicted !== null) tally.evictions += 1;
            s = state;
          } else if (cmd.k === "activate") {
            if (typeof cmd.tab !== "string" && !before.open.includes(cmd.tab.division)) tally.refusedActivates += 1;
            s = activate(before, cmd.tab);
          } else {
            if (typeof before.active !== "string" && before.active.division === cmd.id) tally.activeCloses += 1;
            s = closeDivision(before, cmd.id);
          }
          checkStep(s, model);
        }
      }),
      { seed: MODEL_SEED, numRuns: MODEL_RUNS },
    );

    // Anti-vacuity: the property reports what it checked, and 0 is a failure —
    // as is a run that never reached an eviction, a refused activate, a close
    // of the active tab, or a URL that had to append its own division.
    console.info(`[T22 model] ${tally.steps} steps checked over ${tally.runs} runs`, tally);
    expect(tally.runs).toBe(MODEL_RUNS);
    expect(tally.steps).toBeGreaterThan(MODEL_RUNS);
    expect(tally.evictions).toBeGreaterThan(0);
    expect(tally.refusedActivates).toBeGreaterThan(0);
    expect(tally.activeCloses).toBeGreaterThan(0);
    expect(tally.urlAppends).toBeGreaterThan(0);
  });
});
