// B7 T24 (spec 2026-11-13 §9.2) — the hub's tab host: the unsaved-edit rules around opening, closing and Back.
//
// Driven through the hook harness. The division settings pages are opaque here (never rendered): a test plays a page by
// calling the props the host hands it — `onDirtyChange` to report edits, `register` to hand over a save handle — so what
// is under test is exactly the host's side of that seam. The router is a spy; a navigation the host asks for "lands" when
// the test re-renders with the state that address parses to, as the server would send it. Expected addresses come from
// spec §9.2's table (evict the least recently used; push to open or switch, replace to close), not from the host.
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { ConfigDirty } from "@/components/use-config-dirty";
import type { ConfigSaveHandle, ConfigSaveResult } from "@/components/registration-hub-config-panel";
import type { HubTabsState } from "@/components/registration-hub-tabs-state";
import type { SectionId } from "@/components/registration-hub-config-panel-sections";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  search: "",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
  usePathname: () => "/o/riverside/c/summer/registration",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { holdPopState, runPopStateGuard } from "@/components/popstate-guard";
import {
  RegistrationHubTabsHost,
  type HubDivisionConfigContext,
  type OpenDivisionConfig,
} from "@/components/registration-hub-tabs-host";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NAMES: Record<string, string> = { [A]: "Open Singles", [B]: "Doubles", [C]: "Mixed" };
const OPENABLE = [A, B, C].map((id) => ({ id, name: NAMES[id]! }));
const CONFIG: HubDivisionConfigContext = {
  orgTz: "UTC",
  orgSlug: "riverside",
  currency: "usd",
  feePercentPct: 8,
  cardUnsupportedCurrency: null,
};
const configOf = (id: string): OpenDivisionConfig => ({
  division: {
    division_id: id,
    name: NAMES[id]!,
    allowed_kinds: ["individual"],
    category: null,
    age_min: null,
    age_max: null,
    age_cutoff_month: null,
    age_cutoff_day: null,
    eligibility_note: null,
  },
  waitlistedCount: 0,
});

const msg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

type HostProps = Parameters<typeof RegistrationHubTabsHost>[0];
const propsFor = (state: HubTabsState, openable = OPENABLE): HostProps => ({
  state,
  divisions: state.open.map(configOf),
  openable,
  config: state.open.length > 0 ? CONFIG : null,
  orgSlug: "riverside",
  compSlug: "summer",
});

/** The address a navigation asked for, as tab state (`tab` + `open`), plus every other param it kept. */
function landed(href: string): { state: HubTabsState; rest: Record<string, string> } {
  const q = new URL(href, "https://seazn.test").searchParams;
  const tab = q.get("tab") ?? "settings";
  const open = q.get("open")?.split(",") ?? [];
  const rest = Object.fromEntries([...q.entries()].filter(([k]) => k !== "tab" && k !== "open"));
  const active: HubTabsState["active"] = tab.startsWith("division:") ? { division: tab.slice("division:".length) } : (tab as "settings");
  return { state: { active, open }, rest };
}
const lastPush = () => landed(String(nav.push.mock.calls.at(-1)![0]));
const lastReplace = () => landed(String(nav.replace.mock.calls.at(-1)![0]));

function mount(state: HubTabsState, openable = OPENABLE) {
  const island = renderIsland(RegistrationHubTabsHost, propsFor(state, openable));
  const tree = () => island.tree();
  const api = () => propsOf(tree().find((e) => (propsOf(e).value as { openDivision?: unknown })?.openDivision)!).value as {
    openDivision: (id: string) => void;
  };
  const pages = () => tree().filter((e) => propsOf(e).register !== undefined && propsOf(e).onDirtyChange !== undefined);
  const pageOf = (id: string) => pages().find((e) => propsOf(e).id === id);
  const dirty = (id: string, sections: SectionId[], count = sections.length) =>
    (propsOf(pageOf(id)!).onDirtyChange as (d: ConfigDirty) => void)({ dirty: count > 0, count, sections });
  /** Plays the page's save handle; returns its reveal, so a test can see when the host asks the page to show a refusal. */
  const handle = (id: string, save: () => Promise<ConfigSaveResult>) => {
    const reveal = vi.fn();
    const ref = { current: { save, reveal } as ConfigSaveHandle | null };
    (propsOf(pageOf(id)!).register as (id: string, h: typeof ref) => () => void)(id, ref);
    return reveal;
  };
  const dialog = () => tree().find((e) => propsOf(e).primary !== undefined && propsOf(e).dismiss !== undefined);
  type Action = { label: string; onClick: () => void };
  const press = (which: "primary" | "discard" | "dismiss") => (propsOf(dialog()!)[which] as Action).onClick();
  const toast = () => tree().find((e) => propsOf(e)["data-reg-hub-toast"] !== undefined);
  const stripTabs = () =>
    propsOf(tree().find((e) => propsOf(e).tabs !== undefined && propsOf(e).unsavedLabel !== undefined)!).tabs as {
      key: string;
      division?: { dirty: boolean; onClose: () => void };
    }[];
  const close = (id: string) => stripTabs().find((tab) => tab.key === id)!.division!.onClose();
  const land = (next: HubTabsState, openableNow = openable) => island.rerender(propsFor(next, openableNow));
  /** The division tabs, in strip order. */
  const stripDivisions = () => stripTabs().filter((tab) => tab.division).map((tab) => tab.key);
  /** The always-present live region the toast's words go through. */
  const live = () => tree().filter((e) => propsOf(e).role === "status");
  return { island, tree, api, pages, pageOf, dirty, handle, dialog, press, toast, stripTabs, close, land, stripDivisions, live };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The Modal a dialog element renders (HubDialog is hookless: called as a function, as React would). */
const modalOf = (dialogEl: ReactElement) =>
  propsOf((dialogEl.type as (p: unknown) => ReactElement)(dialogEl.props)) as unknown as { onClose: () => void };

const HUB = "/o/riverside/c/summer/registration";
const ORIGIN = "https://seazn.test";

/** The window's listeners by type: the beforeunload prompt and the capture-phase click guard (G1), each recording whether it
 *  was added in the capture phase — the click guard must run before Next's Link. A popstate goes through the root layout's
 *  guard instead (popstate-guard.tsx), driven here by `pop()`. */
const listeners = vi.hoisted(() => ({
  beforeunload: new Set<(e: unknown) => void>(),
  click: new Set<(e: unknown) => void>(),
  capture: new Map<unknown, boolean>(),
}));
const win = vi.hoisted(() => ({
  pathname: "",
  go: vi.fn(),
  /** The Navigation API's current entry index, or undefined for a browser without it. */
  index: undefined as number | undefined,
}));
beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.search = "";
  win.pathname = HUB;
  win.go.mockClear();
  win.index = undefined;
  for (const set of [listeners.beforeunload, listeners.click]) set.clear();
  listeners.capture.clear();
  // The guard is module state, and an earlier test's host is never unmounted: take back whatever it still holds.
  holdPopState(() => {})();
  const setOf = (type: string) => (type === "beforeunload" ? listeners.beforeunload : type === "click" ? listeners.click : null);
  vi.stubGlobal("window", {
    scrollY: 0,
    scrollTo: vi.fn(),
    location: {
      origin: ORIGIN,
      get pathname() {
        return win.pathname;
      },
    },
    history: { go: win.go },
    get navigation() {
      return win.index === undefined ? undefined : { currentEntry: { index: win.index } };
    },
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => {
      setOf(type)?.add(fn);
      listeners.capture.set(fn, capture === true);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      setOf(type)?.delete(fn);
    },
  });
  return () => vi.unstubAllGlobals();
});

/** A left click on a link, as the window's capture listener sees it. */
function linkClick(href: string, opts: { target?: string; download?: boolean; button?: number; key?: "meta" | "ctrl" | "shift" | "alt"; prevented?: boolean } = {}) {
  const anchor = {
    href: new URL(href, ORIGIN).href,
    getAttribute: (name: string) => (name === "target" ? (opts.target ?? null) : null),
    hasAttribute: (name: string) => name === "download" && opts.download === true,
  };
  return {
    defaultPrevented: opts.prevented === true,
    button: opts.button ?? 0,
    metaKey: opts.key === "meta",
    ctrlKey: opts.key === "ctrl",
    shiftKey: opts.key === "shift",
    altKey: opts.key === "alt",
    target: { closest: (selector: string) => (selector === "a[href]" ? anchor : null) },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}
const fire = (set: Set<(e: unknown) => void>, event: unknown) => {
  for (const fn of [...set]) fn(event);
  return event;
};
/** A popstate, as the root layout's listener hands it to the guard the hub holds. */
const pop = () => {
  const event = { stopImmediatePropagation: vi.fn() };
  runPopStateGuard(event as unknown as PopStateEvent);
  return event;
};

describe("RegistrationHubTabsHost — mounting", () => {
  it("one settings page per open division, keyed by id, only the active one shown; Settings has none (empty case)", () => {
    expect(mount({ active: "settings", open: [] }).pages()).toHaveLength(0);
    const host = mount({ active: { division: B }, open: [A, B] });
    const pages = host.pages();
    expect(pages.map((p) => [p.key, propsOf(p).active])).toEqual([
      [A, false],
      [B, true],
    ]);
  });

  it("refuses, by name, an open division tab with no config context for its page", () => {
    expect(() =>
      renderIsland(RegistrationHubTabsHost, { ...propsFor({ active: { division: A }, open: [A] }), config: null }),
    ).toThrow(/no config context/);
  });
});

describe("RegistrationHubTabsHost — opening a third division (spec §9.2)", () => {
  it("clean LRU: pushes the swap at once, says what it closed, and Reopen opens that one again (evicting the next LRU)", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.api().openDivision(C);
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(lastPush().state).toEqual({ active: { division: C }, open: [B, C] });
    expect(host.dialog()).toBeUndefined();
    expect(textOf(host.toast()!)).toContain(msg("reg.hub.evicted", { name: NAMES[A]! }));
    host.land({ active: { division: C }, open: [B, C] });
    const reopen = host.tree().find((e) => propsOf(e)["data-reg-hub-reopen"] !== undefined)!;
    expect(textOf(reopen)).toBe(msg("reg.hub.reopen"));
    (propsOf(reopen).onClick as () => void)();
    expect(lastPush().state).toEqual({ active: { division: A }, open: [C, A] });
  });

  it("opening one that is already open only activates it: no eviction, no toast", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.api().openDivision(A);
    expect(lastPush().state).toEqual({ active: { division: A }, open: [B, A] });
    expect(host.toast()).toBeUndefined();
  });

  it("dirty LRU: asks first and navigates nowhere; Cancel keeps every tab", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(A, ["capacity"]);
    host.api().openDivision(C);
    expect(nav.push).not.toHaveBeenCalled();
    const d = propsOf(host.dialog()!);
    expect(d.title).toBe(msg("reg.hub.evict.title", { name: NAMES[A]! }));
    expect(d.body).toBe(msg("reg.hub.evict.body", { name: NAMES[A]!, next: NAMES[C]! }));
    host.press("dismiss");
    expect(host.dialog()).toBeUndefined();
    expect(nav.push).not.toHaveBeenCalled();
    expect(host.pages().map((p) => p.key)).toEqual([A, B]);
  });

  it("positive pair: a dirty tab that is NOT the one evicted does not ask", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(B, ["capacity"]);
    host.api().openDivision(C);
    expect(host.dialog()).toBeUndefined();
    expect(lastPush().state).toEqual({ active: { division: C }, open: [B, C] });
  });

  it("Discard and open swaps, and the discarded tab's unsaved state goes with it", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(A, ["capacity"]);
    expect(listeners.beforeunload.size).toBe(1);
    host.api().openDivision(C);
    host.press("discard");
    expect(lastPush().state).toEqual({ active: { division: C }, open: [B, C] });
    host.land({ active: { division: C }, open: [B, C] });
    expect(host.pages().map((p) => p.key)).toEqual([B, C]);
    // Nothing unsaved is left, so a reload no longer asks.
    expect(listeners.beforeunload.size).toBe(0);
  });

  it("Save and open swaps only once the save succeeds; a save that does not go through shows the failing tab instead", async () => {
    let checked = 0;
    for (const outcome of ["success", "refused", "put-failed", "patch-failed", "both-failed"] as const) {
      nav.push.mockClear();
      const host = mount({ active: "settings", open: [A, B] });
      host.dirty(A, ["money"]);
      let release!: (r: ConfigSaveResult) => void;
      host.handle(A, () => new Promise((r) => (release = r)));
      host.api().openDivision(C);
      host.press("primary");
      // In flight: nothing has moved, and the dialog's buttons are held.
      expect(nav.push, outcome).not.toHaveBeenCalled();
      expect(propsOf(host.dialog()!).busy).toBe(true);
      // So is its own way out (Esc, its ×): a save in flight cannot be walked away from (fix round 1 m4).
      modalOf(host.dialog()!).onClose();
      expect(host.dialog(), outcome).toBeDefined();
      expect(propsOf(host.dialog()!).busy, outcome).toBe(true);
      release(outcome);
      await flush();
      expect(nav.push, outcome).toHaveBeenCalledTimes(1);
      expect(lastPush().state, outcome).toEqual(
        outcome === "success" ? { active: { division: C }, open: [B, C] } : { active: { division: A }, open: [B, A] },
      );
      expect(host.dialog(), outcome).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(5);
  });
});

describe("RegistrationHubTabsHost — the close button (spec §9.2)", () => {
  it("clean: closes at once by REPLACING the address; closing the tab on screen lands on Settings", () => {
    const host = mount({ active: { division: B }, open: [A, B] });
    host.close(B);
    expect(nav.push).not.toHaveBeenCalled();
    expect(lastReplace().state).toEqual({ active: "settings", open: [A] });
    host.close(A);
    expect(lastReplace().state).toEqual({ active: { division: B }, open: [B] });
  });

  it("dirty: asks, naming the count and the sections; Keep editing changes nothing", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity", "money"], 3);
    host.close(A);
    expect(nav.replace).not.toHaveBeenCalled();
    const d = propsOf(host.dialog()!);
    expect(d.title).toBe(msg("reg.hub.close.title", { name: NAMES[A]! }));
    const sections = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format([
      msg("reg.settings.capacity"),
      msg("reg.settings.money"),
    ]);
    expect(d.body).toBe(msg("reg.hub.close.body.other", { count: 3, sections }));
    host.press("dismiss");
    expect(host.dialog()).toBeUndefined();
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("dirty, one change: the body says so in the singular", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["form"], 1);
    host.close(A);
    expect(propsOf(host.dialog()!).body).toBe(msg("reg.hub.close.body.one", { count: 1, sections: msg("reg.settings.signupForm") }));
  });

  it("dirty, Discard: closes (replace)", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    host.close(A);
    host.press("discard");
    expect(lastReplace().state).toEqual({ active: "settings", open: [] });
  });

  it("dirty, Save and close: closes only once the save succeeds; otherwise the tab stays, on screen", async () => {
    let checked = 0;
    for (const outcome of ["success", "refused", "put-failed"] as const) {
      nav.replace.mockClear();
      nav.push.mockClear();
      const host = mount({ active: "registrants", open: [A] });
      host.dirty(A, ["capacity"]);
      host.handle(A, async () => outcome);
      host.close(A);
      host.press("primary");
      await flush();
      if (outcome === "success") {
        expect(lastReplace().state).toEqual({ active: "registrants", open: [] });
        expect(nav.push).not.toHaveBeenCalled();
      } else {
        expect(nav.replace, outcome).not.toHaveBeenCalled();
        expect(lastPush().state, outcome).toEqual({ active: { division: A }, open: [A] });
      }
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("every navigation keeps the params the tabs do not own (a Registrants filter)", () => {
    nav.search = "tab=registrants&open=" + A + "&status=paid&q=ann";
    const host = mount({ active: "registrants", open: [A] });
    host.close(A);
    expect(lastReplace().rest).toEqual({ status: "paid", q: "ann" });
  });
});

describe("RegistrationHubTabsHost — Back off a dirty tab (spec §9.2, Review Focus 4)", () => {
  it("keeps the dirty page mounted, puts it back in the address and asks the close question — once", async () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    // Back: the previous address had no division tab.
    host.land({ active: "settings", open: [] });
    expect(host.pageOf(A), "the page and its edits are still there").toBeDefined();
    expect(propsOf(host.pageOf(A)!).active).toBe(false);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(lastReplace().state).toEqual({ active: { division: A }, open: [A] });
    // Without moving the page: the replace is a correction of the address, not a navigation the viewer made (fix round 1 m4).
    expect(nav.replace.mock.calls.at(-1)![1]).toEqual({ scroll: false });
    expect(propsOf(host.dialog()!).title).toBe(msg("reg.hub.close.title", { name: NAMES[A]! }));
    // The replace lands; nothing is sent again.
    host.land({ active: { division: A }, open: [A] });
    host.land({ active: { division: A }, open: [A] });
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(propsOf(host.pageOf(A)!).active).toBe(true);
  });

  it("empty case: Back off a CLEAN tab just closes it — nothing held, nothing asked, no replace", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.land({ active: "settings", open: [] });
    expect(host.pageOf(A)).toBeUndefined();
    expect(host.dialog()).toBeUndefined();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("a division that is no longer openable (archived, edit rights gone) is let go: no tab, no replace, no loop", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    expect(listeners.beforeunload.size).toBe(1);
    const withoutA = OPENABLE.filter((d) => d.id !== A);
    host.land({ active: "settings", open: [] }, withoutA);
    host.land({ active: "settings", open: [] }, withoutA);
    expect(host.pageOf(A)).toBeUndefined();
    expect(host.dialog()).toBeUndefined();
    expect(nav.replace).not.toHaveBeenCalled();
    // Its unsaved state went with it: nothing left to warn about on reload.
    expect(listeners.beforeunload.size).toBe(0);
  });

  it("putting it back never evicts the OTHER dirty tab: the address keeps both dirty pages", () => {
    const host = mount({ active: { division: A }, open: [B, A] });
    host.dirty(A, ["capacity"]);
    host.dirty(B, ["money"]);
    // Back to an address holding B and C: A drops, and re-adding it would evict B (least recently used).
    host.land({ active: { division: C }, open: [B, C] });
    expect(lastReplace().state).toEqual({ active: { division: A }, open: [B, A] });
  });
});

describe("RegistrationHubTabsHost — reload or close with unsaved edits (spec §9.2)", () => {
  it("asks only while something is unsaved, and the handler asks the browser for its prompt", () => {
    const host = mount({ active: { division: A }, open: [A, B] });
    expect(listeners.beforeunload.size).toBe(0);
    host.dirty(A, ["capacity"]);
    expect(listeners.beforeunload.size).toBe(1);
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    for (const fn of listeners.beforeunload) fn(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe("");
    // A second dirty tab does not add a second prompt; both clean again removes it.
    host.dirty(B, ["money"]);
    expect(listeners.beforeunload.size).toBe(1);
    host.dirty(A, []);
    expect(listeners.beforeunload.size).toBe(1);
    host.dirty(B, []);
    expect(listeners.beforeunload.size).toBe(0);
  });
});

describe("RegistrationHubTabsHost — after a save", () => {
  it("says Saved and fetches the Settings rows again; the dot is the page's dirty report, cleared with it", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    expect(host.stripTabs().find((tab) => tab.key === A)!.division!.dirty).toBe(true);
    (propsOf(host.pageOf(A)!).onSaved as () => void)();
    host.dirty(A, []);
    expect(textOf(host.toast()!)).toContain(msg("reg.hub.saved"));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(host.stripTabs().find((tab) => tab.key === A)!.division!.dirty).toBe(false);
  });
});

describe("RegistrationHubTabsHost — fix round 1", () => {
  it("m4: a dialog that is not busy closes on its own way out (Esc, ×) like Cancel — the positive pair of the busy guard", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(A, ["capacity"]);
    host.api().openDivision(C);
    modalOf(host.dialog()!).onClose();
    expect(host.dialog()).toBeUndefined();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("m4: opening a division the Settings tab does not offer is a wiring fault, refused by name", () => {
    const host = mount({ active: "settings", open: [] }, OPENABLE.filter((d) => d.id !== C));
    expect(() => host.api().openDivision(C)).toThrow(/not one the Settings tab can open/);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("m4: the toast leaves on its own — Saved after 4s, a closed-to-make-room one (with Reopen) after 10s", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const host = mount({ active: "settings", open: [A, B] });
      host.api().openDivision(C);
      expect(host.toast()).toBeDefined();
      vi.advanceTimersByTime(9_999);
      expect(host.toast(), "an evicted toast stays 10s").toBeDefined();
      vi.advanceTimersByTime(1);
      expect(host.toast()).toBeUndefined();

      host.land({ active: { division: C }, open: [B, C] });
      (propsOf(host.pageOf(C)!).onSaved as () => void)();
      expect(textOf(host.toast()!)).toContain(msg("reg.hub.saved"));
      vi.advanceTimersByTime(3_999);
      expect(host.toast(), "Saved stays 4s").toBeDefined();
      vi.advanceTimersByTime(1);
      expect(host.toast()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("m2: the strip shows the division tabs in the order they were opened; activating one moves the address, not the tab", () => {
    const host = mount({ active: { division: B }, open: [A, B] });
    expect(host.stripDivisions()).toEqual([A, B]);
    // A is clicked: the address puts it last (B is now the least recently used) — the strip keeps it where it was.
    host.land({ active: { division: A }, open: [B, A] });
    expect(host.stripDivisions()).toEqual([A, B]);
    // C opens: B, the least recently used, makes room; C joins at the end.
    host.api().openDivision(C);
    expect(lastPush().state).toEqual({ active: { division: C }, open: [A, C] });
    host.land({ active: { division: C }, open: [A, C] });
    expect(host.stripDivisions()).toEqual([A, C]);
    host.land({ active: { division: A }, open: [C, A] });
    expect(host.stripDivisions()).toEqual([A, C]);
    // A close takes it out; the next one opened goes last.
    host.land({ active: { division: C }, open: [C] });
    expect(host.stripDivisions()).toEqual([C]);
    host.land({ active: { division: B }, open: [C, B] });
    expect(host.stripDivisions()).toEqual([C, B]);
  });

  it("m2: a first render (a reload) has only the address to go on, so it shows the address's order — the recorded limit", () => {
    expect(mount({ active: { division: A }, open: [B, A] }).stripDivisions()).toEqual([B, A]);
    expect(mount({ active: "settings", open: [] }).stripDivisions()).toEqual([]);
  });

  it("m2: a tab held back after Back keeps its place in the strip when the host puts it back", () => {
    const host = mount({ active: { division: A }, open: [A, B] });
    host.dirty(A, ["capacity"]);
    host.land({ active: { division: B }, open: [B] });
    expect(lastReplace().state).toEqual({ active: { division: A }, open: [B, A] });
    host.land({ active: { division: A }, open: [B, A] });
    expect(host.stripDivisions()).toEqual([A, B]);
  });

  it("m3: Keep editing on a tab that is not on screen brings it on screen (push); on the tab on screen it moves nothing", () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(A, ["capacity"]);
    host.close(A);
    host.press("dismiss");
    expect(host.dialog()).toBeUndefined();
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(lastPush().state).toEqual({ active: { division: A }, open: [B, A] });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("m1: a failed Save and open lands on the failing tab and has ITS page reveal the refusal — once it is on screen", async () => {
    const host = mount({ active: "settings", open: [A, B] });
    host.dirty(A, ["schedule"]);
    const reveal = host.handle(A, async () => "refused");
    const other = host.handle(B, async () => "success");
    host.api().openDivision(C);
    host.press("primary");
    await flush();
    expect(lastPush().state).toEqual({ active: { division: A }, open: [B, A] });
    expect(host.dialog()).toBeUndefined();
    // Still hidden behind Settings until the push lands: a reveal now would scroll to nothing.
    expect(reveal).not.toHaveBeenCalled();
    host.land({ active: { division: A }, open: [B, A] });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    // Once: later renders of the same tab do not scroll the page back to it.
    host.land({ active: { division: B }, open: [A, B] });
    host.land({ active: { division: A }, open: [B, A] });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("m1: a failed Save and close on the tab on screen reveals as the dialog goes (no navigation); a success reveals nothing", async () => {
    let checked = 0;
    for (const outcome of ["refused", "put-failed", "success"] as const) {
      nav.push.mockClear();
      const host = mount({ active: { division: A }, open: [A] });
      host.dirty(A, ["capacity"]);
      const reveal = host.handle(A, async () => outcome);
      host.close(A);
      host.press("primary");
      await flush();
      expect(host.dialog(), outcome).toBeUndefined();
      expect(nav.push, outcome).not.toHaveBeenCalled();
      expect(reveal, outcome).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("m7: the toast's words go through a live region that is always in the document; the toast itself is not a second one", () => {
    const host = mount({ active: "settings", open: [A, B] });
    expect(host.live()).toHaveLength(1);
    expect(textOf(host.live()[0]!)).toBe("");
    host.api().openDivision(C);
    expect(host.live()).toHaveLength(1);
    expect(textOf(host.live()[0]!)).toBe(msg("reg.hub.evicted", { name: NAMES[A]! }));
    expect(propsOf(host.toast()!).role).toBeUndefined();
    (propsOf(host.tree().find((e) => propsOf(e)["aria-label"] === msg("reg.hub.toast.dismiss"))!).onClick as () => void)();
    expect(host.toast()).toBeUndefined();
    expect(host.live()).toHaveLength(1);
    expect(textOf(host.live()[0]!)).toBe("");
  });
});

describe("RegistrationHubTabsHost — the dialogs' buttons", () => {
  it("stack below sm; from sm they share a row that wraps whole buttons, never a label inside one", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    host.close(A);
    const modal = modalOf(host.dialog()!) as unknown as { footer: import("react").ReactElement };
    const footer = propsOf(modal.footer);
    expect(String(footer.className).split(/\s+/)).toEqual(expect.arrayContaining(["flex-col", "sm:flex-row-reverse", "sm:flex-wrap"]));
    const buttons = walk(modal.footer).filter((e) => propsOf(e)["data-reg-hub-dialog-action"] !== undefined);
    expect(buttons.map((b) => propsOf(b)["data-reg-hub-dialog-action"])).toEqual(["save", "discard", "dismiss"]);
    for (const b of buttons) expect(String(propsOf(b).className).split(/\s+/), String(propsOf(b)["data-reg-hub-dialog-action"])).toContain("sm:whitespace-nowrap");
  });
});

// Final fix round (sign-off capture, 1280): the leave labels needed 402px of the default dialog's 400px row, so "Keep editing" wrapped
// alone onto a second row. Every hub question opens in the wide dialog, whose row holds the widest set (nl leave, 491px) in every locale
// - measured in Chromium per locale and per dialog at 640, 768 and 1280 (final-fix-report.md); the 1280 leave row is pinned in the
// browser by registration-hub-division-tabs.spec.ts. All three ask in the same width, so the questions stay alike.
describe("RegistrationHubTabsHost — every unsaved-edit question opens in the wide dialog (final fix round)", () => {
  it("close, evict and leave each pass size lg to the Modal", () => {
    let checked = 0;
    const close = mount({ active: { division: A }, open: [A] });
    close.dirty(A, ["capacity"]);
    close.close(A);
    expect((modalOf(close.dialog()!) as unknown as { size?: string }).size, "close").toBe("lg");
    checked++;

    const evict = mount({ active: "settings", open: [A, B] });
    evict.dirty(A, ["capacity"]);
    evict.api().openDivision(C);
    expect((modalOf(evict.dialog()!) as unknown as { size?: string }).size, "evict").toBe("lg");
    checked++;
    expect(checked).toBe(2);
  });
});

describe("RegistrationHubTabsHost — leaving the hub with unsaved edits (fix round 1 G1)", () => {
  const COMP = "/o/riverside/c/summer";

  it("empty case: nothing unsaved, nothing guarded — no click listener, and a Back out goes through", () => {
    const host = mount({ active: { division: A }, open: [A] });
    win.pathname = COMP;
    expect(listeners.click.size).toBe(0);
    expect(pop().stopImmediatePropagation).not.toHaveBeenCalled();
    win.pathname = HUB;
    host.dirty(A, ["capacity"]);
    expect(listeners.click.size).toBe(1);
    // In the capture phase, so it runs before Next's Link (bubble phase).
    for (const fn of listeners.click) expect(listeners.capture.get(fn)).toBe(true);
    // Clean again: both guards stand down.
    host.dirty(A, []);
    expect(listeners.click.size).toBe(0);
    win.pathname = COMP;
    expect(pop().stopImmediatePropagation).not.toHaveBeenCalled();
    expect(win.go).not.toHaveBeenCalled();
    expect(host.dialog()).toBeUndefined();
  });

  it("a link out of the hub is held and asks, naming the tabs; Keep editing stays", () => {
    const host = mount({ active: { division: A }, open: [A, B] });
    host.dirty(A, ["capacity"]);
    host.dirty(B, ["money"]);
    const event = fire(listeners.click, linkClick(COMP)) as ReturnType<typeof linkClick>;
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // T24 re-review n2: preventDefault ONLY. The click must still reach the link's own handlers - an account-menu item closes its
    // menu in its onClick, and Next's Link runs that onClick before it sees defaultPrevented and stands down.
    expect(event.stopPropagation).not.toHaveBeenCalled();
    const d = propsOf(host.dialog()!);
    expect(d.title).toBe(msg("reg.hub.leave.title"));
    const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format([NAMES[A]!, NAMES[B]!]);
    expect(d.body).toBe(msg("reg.hub.leave.body.other", { count: 2, names }));
    host.press("dismiss");
    expect(host.dialog()).toBeUndefined();
    expect(nav.push).not.toHaveBeenCalled();
    expect(host.pageOf(A)).toBeDefined();
  });

  it("final fix round: the leave question - the one whose row wrapped at 1280 - opens in the wide dialog too", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    fire(listeners.click, linkClick(COMP));
    expect(propsOf(host.dialog()!).title, "premise: the leave question").toBe(msg("reg.hub.leave.title"));
    expect((modalOf(host.dialog()!) as unknown as { size?: string }).size).toBe("lg");
  });

  it("one unsaved tab: the body is singular; Discard and leave goes where the link pointed, and the reload prompt stands down", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    fire(listeners.click, linkClick(`${COMP}?tab=fixtures#top`));
    expect(propsOf(host.dialog()!).body).toBe(msg("reg.hub.leave.body.one", { count: 1, names: NAMES[A]! }));
    host.press("discard");
    expect(nav.push).toHaveBeenCalledWith(`${COMP}?tab=fixtures#top`);
    expect(host.dialog()).toBeUndefined();
    // Leaving now: a hard navigation the router may still make must not raise the browser's prompt on top.
    const unload = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    fire(listeners.beforeunload, unload);
    expect(unload.preventDefault).not.toHaveBeenCalled();
    // And a second click on the way out is not asked about again.
    const again = fire(listeners.click, linkClick(COMP)) as ReturnType<typeof linkClick>;
    expect(again.preventDefault).not.toHaveBeenCalled();
  });

  it("Save and leave saves every unsaved tab, then goes; a save that does not go through stays, on the failing tab", async () => {
    let checked = 0;
    for (const failing of [null, B] as const) {
      nav.push.mockClear();
      const host = mount({ active: { division: A }, open: [A, B] });
      host.dirty(A, ["capacity"]);
      host.dirty(B, ["money"]);
      const saved: string[] = [];
      host.handle(A, async () => (saved.push(A), "success"));
      host.handle(B, async () => (saved.push(B), failing === B ? "put-failed" : "success"));
      fire(listeners.click, linkClick(COMP));
      host.press("primary");
      expect(propsOf(host.dialog()!).busy).toBe(true);
      await flush();
      await flush();
      expect(saved, String(failing)).toEqual([A, B]);
      expect(host.dialog()).toBeUndefined();
      if (failing === null) {
        expect(nav.push).toHaveBeenCalledWith(COMP);
      } else {
        expect(nav.push).not.toHaveBeenCalledWith(COMP);
        expect(lastPush().state).toEqual({ active: { division: B }, open: [A, B] });
      }
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("clicks that do not leave the hub, or are not a plain click on a link, go through untouched", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    const passes: [string, ReturnType<typeof linkClick>][] = [
      ["another tab of the hub", linkClick(`${HUB}?tab=registrants&open=${A}`)],
      ["Export CSV (an API download)", linkClick("/api/v1/competitions/x/registrations.csv")],
      ["a new window", linkClick(COMP, { target: "_blank" })],
      ["a download", linkClick(COMP, { download: true })],
      ["another site", linkClick("https://example.com/")],
      ["a middle click", linkClick(COMP, { button: 1 })],
      ["cmd-click", linkClick(COMP, { key: "meta" })],
      ["ctrl-click", linkClick(COMP, { key: "ctrl" })],
      ["shift-click", linkClick(COMP, { key: "shift" })],
      ["alt-click", linkClick(COMP, { key: "alt" })],
      ["already handled", linkClick(COMP, { prevented: true })],
    ];
    const notALink = { ...linkClick(COMP), target: { closest: () => null } };
    let checked = 0;
    for (const [why, event] of [...passes, ["not a link", notALink] as const]) {
      fire(listeners.click, event);
      expect(event.preventDefault, why).not.toHaveBeenCalled();
      expect(event.stopPropagation, why).not.toHaveBeenCalled();
      expect(host.dialog(), why).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(12);
    // The positive pair, in the same state: a plain click on the same kind of link, leaving, is held.
    expect((fire(listeners.click, linkClick(COMP)) as ReturnType<typeof linkClick>).preventDefault).toHaveBeenCalled();
  });

  it("Back past the hub is held: the address is put back, the router never sees it, and Discard goes back after all", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    win.pathname = COMP;
    const back = pop();
    expect(back.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    // No Navigation API here: one step back is assumed, and one step forward undoes it.
    expect(win.go).toHaveBeenCalledWith(1);
    expect(propsOf(host.dialog()!).title).toBe(msg("reg.hub.leave.title"));
    // The forward step lands on the hub again: swallowed too, so the router does not navigate to where it already is.
    win.pathname = HUB;
    const restored = pop();
    expect(restored.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(host.dialog()).toBeDefined();
    host.press("discard");
    expect(win.go).toHaveBeenLastCalledWith(-1);
    // That traversal is the viewer's: through to the router.
    win.pathname = COMP;
    expect((pop()).stopImmediatePropagation).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("with the Navigation API, a jump of several entries (or Forward) is undone and redone by exactly that many", () => {
    win.index = 5;
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    win.pathname = "/o/riverside";
    win.index = 2;
    pop();
    expect(win.go).toHaveBeenCalledWith(3);
    win.pathname = HUB;
    win.index = 5;
    pop();
    host.press("dismiss");
    expect(host.dialog()).toBeUndefined();
    // Forward, two entries on: put back by two.
    win.pathname = "/o/riverside/c/summer/fixtures";
    win.index = 7;
    pop();
    expect(win.go).toHaveBeenLastCalledWith(-2);
  });

  // T24 re-review n1: a held navigation used to REPLACE whatever dialog was open - a busy one too - re-enabling its buttons, so a
  // second choice could navigate twice once the first save settled. A busy dialog now stays as it is: the Back is put back and a
  // link is held, and only the first choice runs.
  it("n1: while a dialog is busy, Back is put back and a link is held, the busy dialog stays, and only the first leave runs", async () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    let settle: (r: ConfigSaveResult) => void = () => {};
    host.handle(A, () => new Promise<ConfigSaveResult>((r) => (settle = r)));
    fire(listeners.click, linkClick(COMP));
    host.press("primary");
    expect(propsOf(host.dialog()!).busy).toBe(true);

    win.pathname = "/o/riverside";
    const back = pop();
    expect(back.stopImmediatePropagation, "the Back is still held").toHaveBeenCalledTimes(1);
    expect(win.go, "and put back").toHaveBeenCalledWith(1);
    expect(propsOf(host.dialog()!).busy, "the busy dialog was not replaced").toBe(true);
    win.pathname = HUB;
    pop(); // the put-back lands: swallowed
    const link = fire(listeners.click, linkClick("/o/riverside")) as ReturnType<typeof linkClick>;
    expect(link.preventDefault, "a link is still held").toHaveBeenCalledTimes(1);
    expect(propsOf(host.dialog()!).busy).toBe(true);

    settle("success");
    await flush();
    await flush();
    expect(nav.push.mock.calls, "the first choice's destination, once").toEqual([[COMP]]);
    expect(win.go, "no second traversal").toHaveBeenCalledTimes(1);
  });

  it("n1: a busy close dialog is not turned into the leave question by a Back past the hub", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    host.handle(A, () => new Promise<ConfigSaveResult>(() => {}));
    host.close(A);
    host.press("primary");
    const before = propsOf(host.dialog()!);
    expect(before.busy).toBe(true);
    expect(before.title).toBe(msg("reg.hub.close.title", { name: NAMES[A]! }));
    win.pathname = COMP;
    pop();
    const after = propsOf(host.dialog()!);
    expect(after.title, "still the close question").toBe(msg("reg.hub.close.title", { name: NAMES[A]! }));
    expect(after.busy).toBe(true);
    // The positive pair: with no dialog open, the same Back asks the leave question.
    expect(msg("reg.hub.leave.title")).not.toBe(after.title);
  });

  // n1, the in-hub path (found by the e2e): a Back INSIDE the hub that drops the dirty tab holds it back and asks the close
  // question - which used to replace a busy leave dialog the same way. The tab is still held and put back; the busy dialog stays.
  it("n1: a Back inside the hub that drops the dirty tab while Save and leave is busy keeps the busy dialog; the tab is put back", async () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    let settle: (r: ConfigSaveResult) => void = () => {};
    host.handle(A, () => new Promise<ConfigSaveResult>((r) => (settle = r)));
    fire(listeners.click, linkClick(COMP));
    host.press("primary");
    const before = propsOf(host.dialog()!);
    expect(before.busy).toBe(true);
    expect(before.title).toBe(msg("reg.hub.leave.title"));

    host.land({ active: "settings", open: [] });
    expect(host.pageOf(A), "held back, edits intact").toBeDefined();
    expect(lastReplace().state, "and put back in the address").toEqual({ active: { division: A }, open: [A] });
    const after = propsOf(host.dialog()!);
    expect(after.title, "still the leave question, not the close one").toBe(msg("reg.hub.leave.title"));
    expect(after.busy, "still busy").toBe(true);

    settle("success");
    await flush();
    await flush();
    expect(nav.push.mock.calls, "the chosen leave runs, once").toEqual([[COMP]]);
  });

  it("n1 positive pair: with no dialog open, the same Back inside the hub asks the close question", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    expect(host.dialog()).toBeUndefined();
    host.land({ active: "settings", open: [] });
    const asked = propsOf(host.dialog()!);
    expect(asked.title).toBe(msg("reg.hub.close.title", { name: NAMES[A]! }));
    expect(asked.busy).toBe(false);
  });

  // T24 re-review n4: `leaving` is reset when the guard re-arms. It matters only when a chosen leave leaves the hub MOUNTED (a
  // router that did not navigate away): after Save and leave the pages are clean, so the guard stands down; a new edit must arm it
  // again rather than let the next link out through unasked.
  it("n4: after a Save and leave that left the hub mounted, a new edit arms the guard again", async () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    host.handle(A, async () => "success");
    fire(listeners.click, linkClick(COMP));
    host.press("primary");
    await flush();
    await flush();
    expect(nav.push).toHaveBeenCalledWith(COMP);
    // The page reports clean after its save; the router (mocked) kept the hub mounted.
    host.dirty(A, []);
    expect(listeners.click.size, "nothing unsaved: no guard").toBe(0);
    host.dirty(A, ["money"]);
    const again = fire(listeners.click, linkClick(COMP)) as ReturnType<typeof linkClick>;
    expect(again.preventDefault, "the new edit is guarded").toHaveBeenCalledTimes(1);
    expect(propsOf(host.dialog()!).title).toBe(msg("reg.hub.leave.title"));
  });

  it("Back and Forward inside the hub are the hub's own (the held-tab rules above): not intercepted", () => {
    const host = mount({ active: { division: A }, open: [A] });
    host.dirty(A, ["capacity"]);
    const inside = pop();
    expect(inside.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(win.go).not.toHaveBeenCalled();
    expect(host.dialog()).toBeUndefined();
  });
});
