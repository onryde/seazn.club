// B7 T24 (spec 2026-11-13 §9.4) — the registration hub's tab strip: Settings, Registrants, then up to two division tabs,
// each a link with a separate close button, in one scroller that scrolls inside itself and is focusable and named.
//
// Recorded deviation from §9.4: a navigation landmark of links with aria-current, not role="tablist"/"tab" — axe 4.12
// fails a tablist that owns a sibling button (aria-required-children, critical) and a button inside a tab
// (nested-interactive). The strip's header comment carries the reasoning; this file pins the shape that replaced it.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubTabStrip, type HubStripTab } from "@/components/registration-hub-tab-strip";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const section = (key: "settings" | "registrants", active = false): HubStripTab => ({
  key,
  label: key === "settings" ? "Settings" : "Registrants",
  href: `/hub?tab=${key}`,
  active,
});
const division = (id: string, name: string, opts: { dirty?: boolean; active?: boolean; onClose?: () => void } = {}): HubStripTab => ({
  key: id,
  label: name,
  href: `/hub?tab=division:${id}`,
  active: opts.active ?? false,
  division: { id, dirty: opts.dirty ?? false, closeLabel: `Close ${name}`, onClose: opts.onClose ?? vi.fn() },
});

function render(tabs: HubStripTab[], extra: { end?: ReactNode; onFollow?: (key: string) => void } = {}) {
  return renderIsland(RegistrationHubTabStrip, { label: "Registration sections", unsavedLabel: "Unsaved changes", tabs, ...extra });
}
const byTestId = (tree: ReactElement[], id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);
const cls = (e: ReactElement) => String(propsOf(e).className ?? "").split(/\s+/).filter(Boolean);
/** True when `inner` sits somewhere inside `outer`'s children. */
const inside = (outer: ReactElement, inner: ReactElement) => walk(propsOf(outer).children as ReactNode).includes(inner);

describe("RegistrationHubTabStrip — the scroller", () => {
  it("is a named navigation landmark, focusable (it scrolls), scrolling inside itself and never the page", () => {
    const tree = render([section("settings", true), section("registrants")]).tree();
    const nav = tree.find((e) => e.type === "nav")!;
    expect(propsOf(nav)["aria-label"]).toBe("Registration sections");
    // AGENTS.md class 23: a scrolling region owes a tab stop and a name.
    expect(propsOf(nav).tabIndex).toBe(0);
    expect(cls(nav)).toEqual(expect.arrayContaining(["scroll-x", "min-w-0"]));
    // Not a tablist: a sibling close button would be a critical axe failure there.
    expect(tree.some((e) => propsOf(e).role === "tablist" || propsOf(e).role === "tab")).toBe(false);
  });

  it("the trailing slot sits on the tabs row, after the strip", () => {
    const end = <span data-export>Export CSV</span>;
    const tree = render([section("settings"), section("registrants", true)], { end }).tree();
    const row = tree.find((e) => propsOf(e)["data-registration-hub-tabs-row"] !== undefined)!;
    const kids = (propsOf(row).children as ReactNode[]).filter(Boolean) as ReactElement[];
    expect(kids.map((k) => k.type)).toEqual(["nav", "span"]);
  });
});

describe("RegistrationHubTabStrip — section tabs", () => {
  it("Settings and Registrants are links with their testids; aria-current marks the one on screen and only it", () => {
    let checked = 0;
    for (const active of ["settings", "registrants"] as const) {
      const tree = render([section("settings", active === "settings"), section("registrants", active === "registrants")]).tree();
      for (const key of ["settings", "registrants"] as const) {
        const [link] = byTestId(tree, `reg-hub-tab-${key}`);
        expect(propsOf(link!).href).toBe(`/hub?tab=${key}`);
        expect(propsOf(link!)["aria-current"], `${active}: ${key}`).toBe(key === active ? "page" : undefined);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  it("empty case: with no division open there is no division tab, no close button and no separator", () => {
    const tree = render([section("settings", true), section("registrants")]).tree();
    expect(byTestId(tree, "reg-hub-tab-division")).toHaveLength(0);
    expect(byTestId(tree, "reg-hub-tab-close")).toHaveLength(0);
    expect(tree.some((e) => e.type === "span" && propsOf(e)["aria-hidden"] && cls(e).includes("w-px"))).toBe(false);
  });
});

describe("RegistrationHubTabStrip — division tabs", () => {
  it("each is a link with its division id and a SEPARATE close button (a sibling, never inside the link) named for it", () => {
    const closeA = vi.fn();
    const tree = render([section("settings"), section("registrants"), division(A, "Open Singles", { onClose: closeA }), division(B, "Doubles", { active: true })]).tree();
    const links = byTestId(tree, "reg-hub-tab-division");
    const closes = byTestId(tree, "reg-hub-tab-close");
    expect(links.map((l) => propsOf(l)["data-division-id"])).toEqual([A, B]);
    expect(closes.map((c) => propsOf(c)["data-division-id"])).toEqual([A, B]);
    expect(closes.map((c) => propsOf(c)["aria-label"])).toEqual(["Close Open Singles", "Close Doubles"]);
    for (let i = 0; i < 2; i++) {
      expect(closes[i]!.type).toBe("button");
      expect(inside(links[i]!, closes[i]!), "the close button is not inside the link").toBe(false);
    }
    expect(links.map((l) => propsOf(l)["aria-current"])).toEqual([undefined, "page"]);
    (propsOf(closes[0]!).onClick as () => void)();
    expect(closeA).toHaveBeenCalledTimes(1);
  });

  it("the close button is a 44×44 target", () => {
    const [close] = byTestId(render([division(A, "Open Singles")]).tree(), "reg-hub-tab-close");
    expect(cls(close!)).toEqual(expect.arrayContaining(["h-11", "w-11", "shrink-0"]));
  });

  it("shows a dirty dot, named, only on a tab with unsaved edits", () => {
    const tree = render([division(A, "Clean"), division(B, "Edited", { dirty: true })]).tree();
    const links = byTestId(tree, "reg-hub-tab-division");
    const dotIn = (link: ReactElement) => walk(propsOf(link).children as ReactNode).filter((e) => propsOf(e)["data-reg-hub-tab-dirty"] !== undefined);
    expect(dotIn(links[0]!)).toHaveLength(0);
    const [dot] = dotIn(links[1]!);
    expect(propsOf(dot!).role).toBe("img");
    expect(propsOf(dot!)["aria-label"]).toBe("Unsaved changes");
  });

  it("a long name truncates at 12rem, with min-w-0 on every box from the name up to the row", () => {
    const name = "Under-14 Girls Doubles — Saturday Morning Session";
    const tree = render([division(A, name, { active: true })]).tree();
    const label = tree.find((e) => e.type === "span" && textOf(e) === name)!;
    expect(cls(label)).toEqual(expect.arrayContaining(["truncate", "min-w-0", "max-w-[12rem]"]));
    // The chain: link, its group, the nav, the row (AGENTS.md: truncate needs min-w-0 on the whole ancestor chain).
    const [link] = byTestId(tree, "reg-hub-tab-division");
    const group = tree.find((e) => propsOf(e)["data-reg-hub-tab-group"] !== undefined)!;
    const nav = tree.find((e) => e.type === "nav")!;
    const row = tree.find((e) => propsOf(e)["data-registration-hub-tabs-row"] !== undefined)!;
    let checked = 0;
    for (const [what, el] of [["link", link!], ["group", group], ["nav", nav], ["row", row]] as const) {
      expect(cls(el), what).toContain("min-w-0");
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(inside(group, link!) && inside(nav, group) && inside(row, nav)).toBe(true);
  });

  it("following a tab tells the host which one, before the link navigates", () => {
    const onFollow = vi.fn();
    const tree = render([section("settings", true), section("registrants"), division(A, "Open Singles")], { onFollow }).tree();
    (propsOf(byTestId(tree, "reg-hub-tab-registrants")[0]!).onClick as () => void)();
    (propsOf(byTestId(tree, "reg-hub-tab-division")[0]!).onClick as () => void)();
    expect(onFollow.mock.calls).toEqual([["registrants"], [A]]);
  });
});

// The row wraps the trailing slot under the strip below md and sits beside it from md up — all Tailwind variants, and a
// mistyped one compiles to nothing and moves nothing (moved here from the page's test when the strip became a component).
describe("RegistrationHubTabStrip — every class is real Tailwind", () => {
  it("no class on the strip compiles to nothing", async () => {
    const tree = render([section("settings"), section("registrants"), division(A, "Open Singles", { dirty: true, active: true }), division(B, "Doubles")]).tree();
    const tokens = new Set<string>();
    for (const el of tree) for (const tok of cls(el)) tokens.add(tok);
    // `scroll-x` / `scroll-x-fade` are globals.css component classes.
    for (const component of ["scroll-x", "scroll-x-fade"]) tokens.delete(component);
    expect(tokens.size).toBeGreaterThan(10);
    const compiled = await compileClasses([...tokens]);
    const dead = [...tokens].filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(dead, `classes that compile to nothing: ${dead.join(" ")}`).toEqual([]);
    for (const must of ["max-md:basis-full", "md:flex-nowrap", "md:border-b", "max-w-[12rem]"]) {
      expect(tokens.has(must), must).toBe(true);
    }
  });
});
