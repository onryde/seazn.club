// B7 T24 (spec 2026-11-13 §9.2) — the hub's tab host: the unsaved-edit rules around opening, closing and Back.
//
// Driven through the hook harness. The division settings pages are opaque here (never rendered): a test plays a page by
// calling the props the host hands it — `onDirtyChange` to report edits, `register` to hand over a save handle — so what
// is under test is exactly the host's side of that seam. The router is a spy; a navigation the host asks for "lands" when
// the test re-renders with the state that address parses to, as the server would send it. Expected addresses come from
// spec §9.2's table (evict the least recently used; push to open or switch, replace to close), not from the host.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
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
  const handle = (id: string, save: () => Promise<ConfigSaveResult>) => {
    const ref = { current: { save } as ConfigSaveHandle | null };
    (propsOf(pageOf(id)!).register as (id: string, h: typeof ref) => () => void)(id, ref);
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
  return { island, tree, api, pages, pageOf, dirty, handle, dialog, press, toast, stripTabs, close, land };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const listeners = vi.hoisted(() => ({ beforeunload: new Set<(e: unknown) => void>() }));
beforeEach(() => {
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.refresh.mockClear();
  nav.search = "";
  listeners.beforeunload.clear();
  vi.stubGlobal("window", {
    scrollY: 0,
    scrollTo: vi.fn(),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "beforeunload") listeners.beforeunload.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "beforeunload") listeners.beforeunload.delete(fn);
    },
  });
  return () => vi.unstubAllGlobals();
});

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
