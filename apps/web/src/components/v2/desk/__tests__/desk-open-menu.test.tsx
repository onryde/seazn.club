// Match Day C5 (owner request 2026-11-01): the competition page's Slideshow, View Public Page and QR tools fold into ONE "Open"
// button with a drop-down. This pins the menu itself — what the page's own render test (competition-page-match-day.test.tsx,
// "C5") cannot reach, because that one is a static render and the menu's behaviour lives in state.
//
// Two harnesses on purpose. `renderToStaticMarkup` is the SERVER's view (the closed menu's items must already be in the markup,
// inside the `role="menu"` panel, carrying their href and target). `renderIsland` supplies React's hook dispatcher so the
// trigger can be clicked and the document listeners fired the way a browser would — there is no DOM in this vitest.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DeskOpenMenu, type DeskOpenItem } from "../desk-open-menu";
import { routes } from "@/lib/routes";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";

const PUBLIC_PATH = routes.shared("riverside", "summer-league");
const ITEMS: DeskOpenItem[] = [
  {
    id: "slideshow",
    label: t(en, "action.slideshow"),
    ariaLabel: t(en, "aria.slideshowNewTab"),
    href: routes.slideshowCompetition("comp-1"),
    newTab: true,
    arrow: true,
  },
  {
    id: "public",
    label: t(en, "action.viewPublic"),
    ariaLabel: t(en, "aria.viewPublicNewTab"),
    href: PUBLIC_PATH,
    newTab: true,
    arrow: true,
  },
  {
    id: "qr",
    label: t(en, "action.qr"),
    ariaLabel: t(en, "aria.qrPoster"),
    href: `${PUBLIC_PATH}/poster.pdf`,
    newTab: true,
    plainAnchor: true,
  },
];
// The off-day door (owner addition 2026-11-01): the console's own page, so same tab, no arrow, and its words are its name.
const MATCH_DAY: DeskOpenItem = {
  id: "matchday",
  label: t(en, "desk.tools.matchDay"),
  href: routes.competitionMatchDay("riverside", "summer-league"),
  newTab: false,
};
const LABEL = t(en, "desk.tools.open");

const markup = (items: DeskOpenItem[] = ITEMS) => renderToStaticMarkup(<DeskOpenMenu label={LABEL} items={items} />);

/** The opening tag of the first element whose tag carries `needle`. */
const tagWith = (html: string, needle: string): string | null =>
  html.match(new RegExp(`<[a-z]+[^>]*${needle}[^>]*>`))?.[0] ?? null;

/** The markup between the `role="menu"` panel's opening tag and its closing tag. The panel holds only anchors, so the first
 *  `</div>` after it is its own. */
function panelOf(html: string): string {
  const open = html.search(/<div[^>]*role="menu"/);
  if (open < 0) throw new Error("no role=menu panel rendered");
  return html.slice(open, html.indexOf("</div>", open) + "</div>".length);
}
const attr = (tag: string | null, name: string): string | null => tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;

describe("DeskOpenMenu, as the server sends it (C5)", () => {
  it("is ONE button named Open, closed, announcing a menu — and the three tools are inside the menu, in order", () => {
    const html = markup();
    const trigger = tagWith(html, 'data-testid="desk-open-menu-toggle"');
    expect(trigger, "the Open button").not.toBeNull();
    expect(trigger).toMatch(/^<button /);
    expect(attr(trigger, "aria-haspopup")).toBe("menu");
    expect(attr(trigger, "aria-expanded")).toBe("false");
    expect(html).toMatch(new RegExp(`data-testid="desk-open-menu-toggle"[^>]*>\\s*<span>${LABEL}</span>`));
    expect(LABEL, "the shipped English word").toBe("Open");
    // The trigger and the panel are paired: aria-controls names the panel.
    const panel = tagWith(html, 'role="menu"');
    expect(panel).not.toBeNull();
    expect(attr(trigger, "aria-controls")).toBe(attr(panel, "id"));
    expect(attr(trigger, "aria-controls"), "an id to point at").toBeTruthy();
    // Closed: the panel is folded away (still in the DOM, so a test can tell folded from never-rendered).
    expect(panel).toMatch(/\shidden(=""|\s|>)/);

    const inside = panelOf(html);
    const hrefs = [...inside.matchAll(/<a [^>]*>/g)].map((m) => attr(m[0], "href"));
    expect(hrefs, "the three tools, in the owner's order").toEqual(ITEMS.map((i) => i.href));
    // Anti-vacuity: the whole markup has exactly those three anchors and no others outside the panel.
    expect([...html.matchAll(/<a /g)].length).toBe(ITEMS.length);
    expect([...inside.matchAll(/role="menuitem"/g)].length).toBe(ITEMS.length);
  });

  it("each tool keeps its href, its new-tab target, its accessible name, its icon and its arrow", () => {
    const inside = panelOf(markup());
    const anchors = [...inside.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(anchors.length).toBe(ITEMS.length);
    const ICON_CLASS = { matchday: "lucide-radio", slideshow: "lucide-monitor-play", public: "lucide-globe", qr: "lucide-printer" } as const;
    anchors.forEach((a, i) => {
      const item = ITEMS[i]!;
      expect(attr(a, "href"), `${item.id} href`).toBe(item.href);
      expect(attr(a, "target"), `${item.id} opens in a new tab`).toBe("_blank");
      expect(attr(a, "role"), `${item.id} is a menu item`).toBe("menuitem");
      expect(attr(a, "aria-label"), `${item.id} keeps its accessible name`).toBe(item.ariaLabel);
      expect(a, `${item.id} keeps its icon`).toContain(ICON_CLASS[item.id]);
      const visible = a.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
      // Slideshow and View Public Page carry the arrow; QR has never had one.
      expect(visible, `${item.id} visible text`).toBe(item.arrow ? `${item.label} ↗` : item.label);
    });
    // The two "dictionary says" facts the arrows hang on: labels are the existing keys, not new strings.
    expect(ITEMS.map((i) => i.label)).toEqual(["Slideshow", "View Public Page", "QR"]);
  });

  it("an item that is not a new-tab link (Match Day) has no target, no arrow and no aria-label — and still leads the menu when handed first", () => {
    const inside = panelOf(markup([MATCH_DAY, ...ITEMS]));
    const anchors = [...inside.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(anchors.length).toBe(ITEMS.length + 1);
    const [first, ...rest] = anchors as [string, ...string[]];
    expect(attr(first, "href")).toBe(MATCH_DAY.href);
    expect(attr(first, "target"), "same tab").toBeNull();
    expect(first, "not a new-tab window, so no new-tab mark in its tag").not.toMatch(/\starget=/);
    expect(attr(first, "aria-label"), "its visible words are its name").toBeNull();
    expect(attr(first, "role")).toBe("menuitem");
    expect(first).toContain("lucide-radio");
    expect(first.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim()).toBe("Match Day");
    expect(first).not.toContain("↗");
    // The rest are unchanged behind it, still new-tab.
    rest.forEach((a) => expect(attr(a, "target")).toBe("_blank"));
  });

  it("every item is a 44px row, so a menu opened with a finger is not a groomed shrink", () => {
    const inside = panelOf(markup());
    const anchors = [...inside.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBe(ITEMS.length);
    for (const a of anchors) expect(attr(a, "class")).toMatch(/(^|\s)min-h-11(\s|$)/);
    // And the Match Day row is the same height as the rest.
    const withDoor = [...panelOf(markup([MATCH_DAY, ...ITEMS])).matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(withDoor.length).toBe(ITEMS.length + 1);
    for (const a of withDoor) expect(attr(a, "class")).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("with nothing to open there is no button at all (the empty case)", () => {
    const html = markup([]);
    expect(html).toBe("");
    expect(html).not.toContain("desk-open-menu");
  });

  it("with ONE tool visible (a private competition has no public page or QR) it is still the Open button holding that one tool", () => {
    const html = markup([ITEMS[0]!]);
    expect(html).toContain('data-testid="desk-open-menu-toggle"');
    const hrefs = [...panelOf(html).matchAll(/<a [^>]*>/g)].map((m) => attr(m[0], "href"));
    expect(hrefs).toEqual([ITEMS[0]!.href]);
  });

  it("passes panelClassName to the panel (after the base classes), and the trigger clears the 44px floor below md", () => {
    const html = renderToStaticMarkup(<DeskOpenMenu label={LABEL} items={ITEMS} panelClassName="max-md:inset-x-0 max-md:w-auto" />);
    const panel = tagWith(html, 'role="menu"');
    expect(panel).not.toBeNull();
    expect(attr(panel, "class")).toMatch(/(^|\s)absolute(\s|$)/); // the base classes are still there
    expect(attr(panel, "class")).toMatch(/(^|\s)max-md:inset-x-0(\s|$)/);
    expect(attr(panel, "class")).toMatch(/(^|\s)max-md:w-auto(\s|$)/);
    expect(attr(tagWith(html, 'data-testid="desk-open-menu-toggle"'), "class"), "a phone tap target").toMatch(/(^|\s)max-md:min-h-11(\s|$)/);
    // Without the prop the panel carries nothing extra (no stray "undefined").
    expect(attr(tagWith(markup(), 'role="menu"'), "class")).not.toMatch(/undefined|inset-x-0/);
  });

  it("passes the caller's className to the wrapper (the page uses it to keep the phone on its own More fold)", () => {
    const html = renderToStaticMarkup(<DeskOpenMenu label={LABEL} items={ITEMS} className="max-md:hidden" />);
    expect(tagWith(html, 'data-testid="desk-open-menu"')).toContain("max-md:hidden");
  });
});

// --- behaviour, through the hook harness -------------------------------------------------------------------------------

type Listener = (e: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const adds: string[] = [];
const removes: string[] = [];

beforeEach(() => {
  listeners.clear();
  adds.length = 0;
  removes.length = 0;
  vi.stubGlobal("document", {
    addEventListener: (type: string, fn: Listener) => {
      adds.push(type);
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      removes.push(type);
      listeners.get(type)?.delete(fn);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const fire = (type: string, e: unknown) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(e));

function mount() {
  const island = renderIsland(DeskOpenMenu, { label: LABEL, items: ITEMS });
  const find = (pred: (el: ReactElement) => boolean) => island.tree().find(pred);
  const trigger = () => {
    const el = find((e) => propsOf(e)["data-testid"] === "desk-open-menu-toggle");
    if (!el) throw new Error("no Open button rendered — the island did not mount");
    return el;
  };
  const panel = () => {
    const el = find((e) => propsOf(e).role === "menu");
    if (!el) throw new Error("no menu panel rendered");
    return el;
  };
  const root = () => {
    const el = find((e) => propsOf(e)["data-testid"] === "desk-open-menu");
    if (!el) throw new Error("no root rendered");
    return el;
  };
  const expanded = () => propsOf(trigger())["aria-expanded"];
  const hidden = () => propsOf(panel()).hidden;
  // The refs a browser would fill in: the root (for the outside-click test) and the trigger (for the focus return).
  const focus = vi.fn();
  const inside = new Set<unknown>();
  (propsOf(root()).ref as { current: unknown }).current = { contains: (n: unknown) => inside.has(n) };
  (propsOf(trigger()).ref as { current: unknown }).current = { focus };
  const click = () => (propsOf(trigger()).onClick as () => void)();
  return { island, trigger, panel, expanded, hidden, focus, inside, click, find };
}

describe("DeskOpenMenu, driven like a person (C5)", () => {
  it("opens on click and closes on a second click, flipping aria-expanded and the panel together", () => {
    const m = mount();
    expect(m.expanded()).toBe(false);
    expect(m.hidden()).toBe(true);
    m.click();
    expect(m.expanded(), "open").toBe(true);
    expect(m.hidden(), "the panel is shown when expanded says so").toBe(false);
    m.click();
    expect(m.expanded(), "closed again").toBe(false);
    expect(m.hidden()).toBe(true);
  });

  it("Escape closes the open menu AND hands focus back to the Open button", () => {
    const m = mount();
    m.click();
    expect(m.expanded()).toBe(true);
    expect([...(listeners.get("keydown") ?? [])].length, "the key listener is registered while open").toBe(1);
    fire("keydown", { key: "ArrowDown" });
    expect(m.expanded(), "another key does nothing").toBe(true);
    expect(m.focus).not.toHaveBeenCalled();
    fire("keydown", { key: "Escape" });
    expect(m.expanded(), "Escape closed it").toBe(false);
    expect(m.focus, "focus returned to the trigger").toHaveBeenCalledTimes(1);
  });

  it("a press outside closes it; a press inside does not", () => {
    const m = mount();
    const itemInside = { name: "a link in the menu" };
    m.inside.add(itemInside);
    m.click();
    fire("pointerdown", { target: itemInside });
    expect(m.expanded(), "a press inside the control leaves it open").toBe(true);
    fire("pointerdown", { target: { name: "the page behind" } });
    expect(m.expanded(), "a press outside closed it").toBe(false);
  });

  it("choosing a tool closes the menu", () => {
    const m = mount();
    m.click();
    const links = m.island.tree().filter((e) => propsOf(e).role === "menuitem");
    expect(links.length, "the three tools are rendered as menu items").toBe(ITEMS.length);
    (propsOf(links[0]!).onClick as () => void)();
    expect(m.expanded()).toBe(false);
  });

  it("listens to the document only while open, and lets go of every listener it took", () => {
    const m = mount();
    expect(adds, "closed: no listeners at all").toEqual([]);
    m.click();
    expect([...adds].sort()).toEqual(["keydown", "pointerdown"]);
    m.click();
    expect([...removes].sort(), "closing removes exactly what opening added").toEqual(["keydown", "pointerdown"]);
    expect([...listeners.values()].every((s) => s.size === 0)).toBe(true);
    // The sequence, not just the first open: a second open registers again.
    m.click();
    expect(adds.length).toBe(4);
  });

  it("renders real elements: the harness found a trigger and three menu items (anti-vacuity)", () => {
    const m = mount();
    expect(isValidElement(m.trigger())).toBe(true);
    expect(m.island.tree().filter((e) => propsOf(e).role === "menuitem").length).toBe(ITEMS.length);
  });
});
