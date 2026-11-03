// SCF (owner pick, Option A, 2026-11-03): More and the Pair next ▾ panel are popovers from `md` - a press elsewhere closes them, Escape closes
// them and puts focus back on the trigger, choosing an item closes More - and are exactly what they were below `md`, where they live in the
// phone sheet's column. `apps/web` vitest has no DOM, so this drives the REAL rail through the hook harness with a fake `document` / `window`
// that records the listeners the rail registers and lets a test fire them: the join between the open state and the dismissal is what a
// static render cannot see. Where the page really sits (the card does not grow, the menu is on top, nothing is clipped) is
// e2e/stage-card-actions.spec.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import type { SwissPairingMenu } from "@/lib/swiss-pairing-menu";
import { StageRail, SwissPairingMenuPanel, type StageRailProps } from "../stage-rail";
import { SwissMoreMenu, type SwissRoundsRail } from "../swiss-rounds-dialog";

const NEUTRAL = {
  counts: { played: 2, inPlay: 0, unplayed: 4 },
  matchCount: 6,
  open: false,
  onToggleOpen: () => {},
  swissHasUnseated: true,
  canUnpairSwiss: false,
};
const swiss = { id: "s1", name: "Swiss", kind: "swiss", seq: 1, status: "active", progression: null, config: { rounds: 5 } } as never;
const ROUND_ONE: SwissPairingMenu = {
  round: 1, choosable: true, defaultPairing: "fold", stored: "rank_adjacent", fieldSize: 10, seedsNumbered: true, unseededDrawn: false, seededAheadOfDraw: false,
};
const LATE = { divisionStatus: "active", roundSeated: true, href: "/o/acme/c/champs/d/open?tab=entrants#add-entrant" };

type Listener = (e: unknown) => void;
const g = globalThis as { window?: unknown; document?: unknown };
const saved = { window: g.window, document: g.document, hadWindow: "window" in g, hadDocument: "document" in g };

/** A browser that is only what the rail reads of one: the listeners it registers on `document`, and whether the viewport is `md` wide. */
function browser(md: boolean) {
  const listeners = new Map<string, Set<Listener>>();
  g.document = {
    addEventListener: (type: string, fn: Listener) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type: string, fn: Listener) => void listeners.get(type)?.delete(fn),
    activeElement: null,
  };
  g.window = { innerWidth: 1280, matchMedia: (q: string) => ({ matches: q.includes("min-width") ? md : !md }) };
  return {
    count: (type: string) => listeners.get(type)?.size ?? 0,
    fire: (type: string, event: object) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
    },
  };
}

afterEach(() => {
  if (saved.hadWindow) g.window = saved.window;
  else delete g.window;
  if (saved.hadDocument) g.document = saved.document;
  else delete g.document;
});

const INSIDE = { inside: true };
const OUTSIDE = { inside: false };

function mount(over: Partial<StageRailProps> = {}) {
  const island = renderIsland(StageRail, {
    stage: swiss, canEdit: true, busy: null, fixtureCount: 10, deletable: false,
    onAct: async () => true, onDelete: () => {}, addingTo: null, onToggleAddMatch: () => {}, adhoc: false,
    ...NEUTRAL, swissPairingMenu: ROUND_ONE, lateEntry: LATE, ...over,
  } as StageRailProps);
  const find = (testid: string) => island.tree().find((e) => propsOf(e)["data-testid"] === testid);
  const byTestid = (testid: string) => {
    const el = find(testid);
    if (!el) throw new Error(`no ${testid} in the rail`);
    return el;
  };
  /** The roots' and toggles' refs are plain props on the elements: give them the little a browser would (what "inside" means, a focus spy). */
  const focused: string[] = [];
  const wire = (testid: string, as: "root" | "toggle") => {
    const el = find(testid);
    if (!el) return; // a rail without that menu (no late-add More, or no Pair next ▾)
    const ref = propsOf(el).ref as { current: unknown };
    ref.current =
      as === "root"
        ? { contains: (n: unknown) => n === INSIDE, getBoundingClientRect: () => ({ left: 700, right: 780 }), closest: () => null }
        : { focus: () => void focused.push(testid) };
  };
  wire("stage-more-root", "root");
  wire("stage-more", "toggle");
  wire("stage-pairing-root", "root");
  wire("stage-pairing-toggle", "toggle");
  return {
    find,
    byTestid,
    focused,
    click: (testid: string) => (propsOf(byTestid(testid)).onClick as (e?: unknown) => void)(),
    moreOpen: () => propsOf(byTestid("stage-more"))["aria-expanded"] === true,
    pairingOpen: () => island.tree().some((e) => e.type === SwissPairingMenuPanel),
    pairingPick: () => {
      const panel = island.tree().find((e) => e.type === SwissPairingMenuPanel);
      return panel ? propsOf(panel).pick : "closed";
    },
    pickRadio: (mode: string) => (propsOf(island.tree().find((e) => e.type === SwissPairingMenuPanel)!).onPick as (m: string) => void)(mode),
  };
}

describe("StageRail - More floats from md: outside press, Escape and choosing an item put it away", () => {
  it("at md: a press outside closes it and leaves focus where it was; a press inside, on the trigger or on padding, does not", () => {
    const b = browser(true);
    const rail = mount();
    expect(rail.moreOpen(), "premise: closed").toBe(false);
    expect(b.count("pointerdown"), "no listener while closed").toBe(0);
    rail.click("stage-more");
    expect(rail.moreOpen(), "the press opened it").toBe(true);
    expect(b.count("pointerdown"), "listening while open").toBe(1);

    b.fire("pointerdown", { target: INSIDE });
    expect(rail.moreOpen(), "a press inside the root is not an outside press").toBe(true);
    b.fire("pointerdown", { target: OUTSIDE });
    expect(rail.moreOpen(), "a press outside closed it").toBe(false);
    expect(rail.focused, "an outside press leaves focus alone").toEqual([]);
    expect(b.count("pointerdown"), "and stops listening").toBe(0);
    expect(propsOf(rail.byTestid("stage-more-menu")).hidden, "hidden, not unmounted").toBe(true);
  });

  it("at md: Escape closes it and focus returns to More; an Escape another handler already spent leaves it open", () => {
    const b = browser(true);
    const rail = mount();
    rail.click("stage-more");
    b.fire("keydown", { key: "Enter" });
    expect(rail.moreOpen(), "another key does nothing").toBe(true);
    b.fire("keydown", { key: "Escape", defaultPrevented: true });
    expect(rail.moreOpen(), "an Escape someone else spent").toBe(true);
    b.fire("keydown", { key: "Escape", defaultPrevented: false });
    expect(rail.moreOpen()).toBe(false);
    expect(rail.focused, "focus is back on the trigger").toEqual(["stage-more"]);
  });

  it("at md: focus moving on out of the menu (Tab) closes it like a press elsewhere; focus inside it does not (review m9)", () => {
    const b = browser(true);
    const rail = mount();
    rail.click("stage-more");
    expect(b.count("focusin"), "listening while open").toBe(1);
    b.fire("focusin", { target: INSIDE });
    expect(rail.moreOpen(), "focus inside the root (its trigger, its items)").toBe(true);
    b.fire("focusin", { target: OUTSIDE });
    expect(rail.moreOpen(), "focus left it").toBe(false);
    expect(rail.focused, "and focus stays where the user put it").toEqual([]);
    expect(b.count("focusin"), "and stops listening").toBe(0);
  });

  it("at md: choosing an item closes it and puts focus on More; a press on padding does not (what counts as an item is pinned in stage-popover.test.ts)", () => {
    browser(true);
    const rail = mount();
    rail.click("stage-more");
    const menu = propsOf(rail.byTestid("stage-more-menu")).onClick as (e: object) => void;
    const target = (closest: object | null) => ({ target: { closest: () => closest } });
    menu(target(null));
    expect(rail.moreOpen(), "a press on text or padding is not an item").toBe(true);
    menu(target({}));
    expect(rail.moreOpen(), "an item closed it").toBe(false);
    expect(rail.focused).toEqual(["stage-more"]);
  });

  it("below md nothing is dismissed by a press, Escape or an item - the menu is part of the phone sheet and behaves as it did", () => {
    const b = browser(false);
    const rail = mount();
    rail.click("stage-more");
    expect(rail.moreOpen(), "premise: it opened").toBe(true);
    b.fire("pointerdown", { target: OUTSIDE });
    b.fire("focusin", { target: OUTSIDE });
    b.fire("keydown", { key: "Escape", defaultPrevented: false });
    expect(rail.moreOpen(), "no outside press, no focus-leaves, no Escape below md").toBe(true);
    const menu = propsOf(rail.byTestid("stage-more-menu")).onClick as (e: object) => void;
    menu({ target: { closest: () => ({}) } });
    expect(rail.moreOpen(), "an item does not fold it below md").toBe(true);
    expect(rail.focused).toEqual([]);
  });

  it("the fed Swiss's own More (no Add late player) floats and dismisses the same way: it asks its owner to toggle, only while open", () => {
    const b = browser(true);
    const rail = {
      control: {
        started: true, rounds: 3, chess: false, field: 6,
        addRound: { canAddRound: true, refusal: null, field: 6, hardMax: 5 },
        finish: { canFinish: true, refusal: null, finishedAfter: 2, inProgress: false, completeInstead: false },
      },
      fixtures: [], onSave: async () => null, onAddRound: async () => null, onFinish: async () => null,
    } as unknown as SwissRoundsRail;
    let toggled = 0;
    const island = renderIsland(SwissMoreMenu, { stageId: "s1", busy: null, rail, open: true, onToggle: () => void toggled++, onFinishOpen: () => {} });
    const find = (testid: string) => island.tree().find((e) => propsOf(e)["data-testid"] === testid)!;
    expect(find("stage-more-menu"), "premise: the menu rendered, both items inside").toBeDefined();
    (propsOf(find("stage-more-root")).ref as { current: unknown }).current = { contains: (n: unknown) => n === INSIDE, getBoundingClientRect: () => ({ left: 700, right: 780 }), closest: () => null };
    const focused: string[] = [];
    (propsOf(find("stage-more")).ref as { current: unknown }).current = { focus: () => void focused.push("more") };

    b.fire("pointerdown", { target: INSIDE });
    expect(toggled, "inside: nothing").toBe(0);
    b.fire("pointerdown", { target: OUTSIDE });
    expect(toggled, "outside: asked to close").toBe(1);
    b.fire("keydown", { key: "Escape", defaultPrevented: false });
    expect(toggled).toBe(2);
    expect(focused, "Escape puts focus on More").toEqual(["more"]);
    b.fire("focusin", { target: INSIDE });
    expect(toggled, "focus inside: nothing").toBe(2);
    b.fire("focusin", { target: OUTSIDE });
    expect(toggled, "focus leaving: asked to close").toBe(3);
    expect(focused, "and focus is left where it went").toEqual(["more"]);
    (propsOf(find("stage-more-menu")).onClick as (e: object) => void)({ target: { closest: () => ({}) } });
    expect(toggled, "an item asks it to close").toBe(4);
    expect(focused).toEqual(["more", "more"]);

    // Closed: no listener at all (a stray press must never be able to ask a closed menu to toggle - that would OPEN it).
    const fresh = browser(true);
    const closed = renderIsland(SwissMoreMenu, { stageId: "s1", busy: null, rail, open: false, onToggle: () => void toggled++, onFinishOpen: () => {} });
    expect(closed.tree().length, "premise: rendered").toBeGreaterThan(0);
    expect(fresh.count("pointerdown"), "closed: no pointer listener").toBe(0);
    expect(fresh.count("keydown"), "closed: no key listener").toBe(0);
    expect(fresh.count("focusin"), "closed: no focus listener").toBe(0);
  });
});

describe("StageRail - the Pair next ▾ panel floats from md", () => {
  it("at md: a press outside closes it BUT KEEPS THE PICK; Escape closes it and focus returns to the ▾; a pick does not close it", () => {
    const b = browser(true);
    const rail = mount({ lateEntry: undefined });
    expect(rail.pairingOpen(), "premise: closed").toBe(false);
    rail.click("stage-pairing-toggle");
    expect(rail.pairingOpen(), "the ▾ opened it").toBe(true);
    rail.pickRadio("rank_adjacent");
    expect(rail.pairingOpen(), "choosing a radio does not close it (it is a choice Pair next then uses)").toBe(true);
    expect(rail.pairingPick()).toBe("rank_adjacent");

    b.fire("pointerdown", { target: INSIDE });
    expect(rail.pairingOpen(), "a press inside the split button + panel is not outside").toBe(true);
    b.fire("pointerdown", { target: OUTSIDE });
    expect(rail.pairingOpen(), "a press outside closed it").toBe(false);
    expect(rail.focused, "an outside press leaves focus alone").toEqual([]);

    rail.click("stage-pairing-toggle");
    b.fire("focusin", { target: INSIDE });
    expect(rail.pairingOpen(), "focus inside the split button + panel").toBe(true);
    b.fire("focusin", { target: OUTSIDE });
    expect(rail.pairingOpen(), "Tab on to the next control closed it (review m9: no two menus open at once)").toBe(false);
    expect(rail.pairingPick(), "closed").toBe("closed");

    rail.click("stage-pairing-toggle");
    expect(rail.pairingPick(), "reopened as it was left: the pick survived the close").toBe("rank_adjacent");
    b.fire("keydown", { key: "Escape", defaultPrevented: true });
    expect(rail.pairingOpen(), "an Escape the panel itself spent is not spent twice").toBe(true);
    b.fire("keydown", { key: "Escape", defaultPrevented: false });
    expect(rail.pairingOpen()).toBe(false);
    expect(rail.focused, "focus is back on the ▾").toEqual(["stage-pairing-toggle"]);
  });

  it("below md a press elsewhere and Escape leave the panel as it was (the phone sheet owns Escape there)", () => {
    const b = browser(false);
    const rail = mount({ lateEntry: undefined });
    rail.click("stage-pairing-toggle");
    b.fire("pointerdown", { target: OUTSIDE });
    b.fire("keydown", { key: "Escape", defaultPrevented: false });
    expect(rail.pairingOpen()).toBe(true);
    expect(rail.focused).toEqual([]);
  });

  it("the panel hangs from the left of the split button, or from its right when it has no room (`align`), from md only", () => {
    const menu = ROUND_ONE;
    const classOf = (align?: "start" | "end") => {
      const html = renderToStaticMarkup(
        <SwissPairingMenuPanel stageId="s1" menu={menu} pick={null} onPick={() => {}} onClose={() => {}} {...(align ? { align } : {})} />,
      );
      return /^<div class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
    };
    for (const [align, side, other] of [[undefined, "md:left-0", "md:right-0"], ["start", "md:left-0", "md:right-0"], ["end", "md:right-0", "md:left-0"]] as const) {
      const c = classOf(align);
      expect(c, `${align ?? "default"}: a popover from md`).toEqual(expect.arrayContaining(["md:absolute", "md:top-full", "md:z-30", side]));
      expect(c, `${align ?? "default"}: only one side`).not.toContain(other);
      expect(c, `${align ?? "default"}: no longer claims the row's whole line`).not.toContain("md:basis-full");
    }
  });
});
