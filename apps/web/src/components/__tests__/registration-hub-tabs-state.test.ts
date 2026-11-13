// B7 T22 — the registration hub's tab state (spec 2026-11-13 §9.1): which
// division settings tabs are open (`?open=`, at most 2, least recently used
// first) and which tab is active (`?tab=settings|registrants|division:<id>`).
//
// Every expected value below comes from the spec's own wording, never from
// the module: the cap is 2 ("up to 2 division ids"), the order is LRU-first,
// the eviction victim is `open[0]` (§9.2 "Evicts open[0] (LRU)"), and the URL
// grammar is §9.1's. The model test at the bottom checks the same rules after
// every step of random open / activate / close sequences against an
// independent reference model (last-use timestamps, not list surgery).
//
// Registration is sport-agnostic: no sport sweep applies to tab state.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activate,
  closeDivision,
  hubTabsQuery,
  openDivision,
  parseHubTabs,
  type HubTab,
  type HubTabsState,
} from "@/components/registration-hub-tabs-state";
import { buildFilteredHref, clearOneHref } from "@/components/registration-hub-registrant-filters";
import { routes } from "@/lib/routes";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
/** A division of this competition with no registration settings, or another competition's. */
const STRANGER = "eeeeeeee-0000-4000-8000-000000000005";
const IDS = [A, B, C, D] as const;
/** `openable` when the viewer can edit: every division with registration settings. */
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

  it("guard: Next's array-valued repeated ?open=a&open=b or ?tab=x&tab=y reads as absent instead of throwing", () => {
    // Next's real runtime shape for a repeated key is a string[], which the
    // `{ tab?: string; open?: string }` parameter cannot express; the cast
    // reaches that shape directly. A `.split` on it would crash the page.
    const repeated = [A, B] as unknown as string;
    expect(parseHubTabs({ tab: "registrants", open: repeated }, ALL)).toStrictEqual({ active: "registrants", open: [] });
    expect(parseHubTabs({ tab: [`division:${A}`, "settings"] as unknown as string, open: A }, ALL)).toStrictEqual({
      active: "settings",
      open: [A],
    });
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

describe("the URL seams the tab state crosses", () => {
  it("routes.competitionRegistration writes tab=division:<id> and open=<a>,<b>; an empty open writes nothing", () => {
    expect(routes.competitionRegistration("acme", "cup", `division:${B}`, undefined, [A, B])).toBe(
      `/o/acme/c/cup/registration?tab=division:${B}&open=${A},${B}`,
    );
    expect(routes.competitionRegistration("acme", "cup", "settings", undefined, [])).toBe(
      "/o/acme/c/cup/registration?tab=settings",
    );
    // Every existing call shape is unchanged.
    expect(routes.competitionRegistration("acme", "cup")).toBe("/o/acme/c/cup/registration");
    expect(routes.competitionRegistration("acme", "cup", "registrants", A)).toBe(
      `/o/acme/c/cup/registration?tab=registrants&division_id=${A}`,
    );
    // @ts-expect-error — `tab` is §9.1's grammar now, not any string.
    routes.competitionRegistration("acme", "cup", "bogus");
  });

  it("a route href read back the way Next hands it to the page parses to the state it was built from", () => {
    const s: HubTabsState = { active: { division: B }, open: [A, B] };
    const href = routes.competitionRegistration("acme", "cup", tabParamFromSpec(s.active), undefined, s.open);
    expect(parseHubTabs(tabParamsOf(href), ALL)).toStrictEqual(s);
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
/** Where a session starts: any address an organiser could land on, hand-edited ones included. */
const rawArb = fc.record(
  {
    tab: fc.constantFrom(
      "settings",
      "registrants",
      "bogus",
      "division:",
      `division:${STRANGER}`,
      ...IDS.map((id) => `division:${id}`),
    ),
    open: fc.array(fc.constantFrom(...IDS, STRANGER, ""), { maxLength: 6 }).map((ids) => ids.join(",")),
  },
  { requiredKeys: [] },
);

/** The reference model: open tabs as last-use timestamps (spec §9.1 "least
 *  recently used first"; cap 2), a different data structure from the
 *  module's list on purpose. */
class LruModel {
  private clock = 0;
  private readonly used = new Map<string, number>();
  active: HubTab;
  constructor(start: HubTabsState) {
    this.active = start.active;
    for (const id of start.open) this.used.set(id, ++this.clock);
  }
  get open(): string[] {
    return [...this.used.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  }
  apply(cmd: Cmd): string | null {
    if (cmd.k === "open") {
      this.used.set(cmd.id, ++this.clock);
      this.active = { division: cmd.id };
      if (this.used.size <= 2) return null;
      const lru = this.open[0];
      this.used.delete(lru);
      return lru;
    }
    if (cmd.k === "activate") {
      if (typeof cmd.tab === "string") this.active = cmd.tab;
      else if (this.used.has(cmd.tab.division)) {
        this.used.set(cmd.tab.division, ++this.clock);
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

describe("model test: random open / activate / close sequences over 4 divisions", () => {
  it("after EVERY step: ≤ 2 open, no duplicates, an active division is open, the URL round-trips, and the state matches the LRU model", () => {
    const tally = { runs: 0, steps: 0, evictions: 0, activeCloses: 0, refusedActivates: 0, urlAppends: 0 };

    function checkStep(s: HubTabsState, model: LruModel): void {
      expect(s.open.length).toBeLessThanOrEqual(2);
      expect(new Set(s.open).size).toBe(s.open.length);
      if (typeof s.active !== "string") expect(s.open).toContain(s.active.division);
      expect(parseHubTabs(hubTabsQuery(s), ALL)).toStrictEqual(s);
      const href = routes.competitionRegistration("acme", "cup", tabParamFromSpec(s.active), undefined, s.open);
      expect(parseHubTabs(tabParamsOf(href), ALL)).toStrictEqual(s);
      expect(s).toStrictEqual({ active: model.active, open: model.open });
      tally.steps += 1;
    }

    fc.assert(
      fc.property(rawArb, fc.array(cmdArb, { maxLength: 24 }), (raw, cmds) => {
        tally.runs += 1;
        let s = parseHubTabs(raw, ALL);
        const requested = raw.tab?.startsWith("division:") ? raw.tab.slice("division:".length) : null;
        if (requested && ALL.has(requested) && !raw.open?.split(",").includes(requested)) tally.urlAppends += 1;
        const model = new LruModel(s);
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
