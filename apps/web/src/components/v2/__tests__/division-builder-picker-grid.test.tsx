// Match Day C9 R2 (owner 2026-11-03): the Sport step as icon tiles (mock "Sport A") and the Format grid's Show more tile.
//
// Owner, verbatim: "Show all (10 more) can we show as a grid as we show 5 format and then 6 one as a show more? also in
// step 1, in sport, can we have similar format way of choosing the sport?"; after the mock: "don't change format grid,
// that looks good only. Sport A"; then "yes, keep show more tile and bottom" (Americano and Mexicano at the bottom).
//
// Pinned here, through the builder's real handlers (the hook harness):
//   - Sport is a group named Sport, described by the "can't change" line, a radio tile per listed sport, each with its
//     own drawing; five shown, then a Show more tile as the next cell of the same grid; opened, every sport and Show
//     fewer; the picked sport never folds away (outside the five it is the fifth); the organisation's history leads;
//     generic is last and named "Any other game" there only;
//   - Format: five cards, then Show more as the sixth cell of the cards' grid (not a button under it); the pair formats
//     after every other card in both views, collapsed only as the pick or when fewer than five others are offered.
// Expected values come from the engine registry (`builtinModules`), the format declarations (the templates whose stages
// mint pairs), the owner's words (the popular five) and the dictionaries - never from the builder or its model.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { SportIcon, SPORT_ICON_KEYS } from "@/components/v2/division-builder/sport-icon";
import { STAGE_TEMPLATES, templatesForSport } from "@/lib/format-templates";
import { PAIR_MINTING_STAGE_KINDS } from "@/lib/chess-individual-only-rule";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";
import { byTestId, click, next, pickTemplate, pickedTemplate, selectSport, setName, templateKeys, visibleTemplateKeys } from "./_division-builder-driver";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const UI = uiEn as Record<string, string>;
const plural = (key: string, n: number) => UI[`${key}.${n === 1 ? "one" : "other"}`]!.replace("{count}", String(n));

const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};
const REGISTRY = builtinModules.map((m) => m.key);
const variantRows = builtinModules.flatMap((m) =>
  Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ sport_key: m.key, key, name: key, is_system: true, config })),
);
/** Every registry sport, as the page lists them (`order by name`; here the key stands in for the name). */
const BY_NAME: SportOption[] = sportOptionsFrom(
  [...REGISTRY].sort().map((k) => ({ key: k, name: k })),
  variantRows,
  (key) => {
    const model = modelOf(key);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);
/** The listed sports with `first` listed first: the builder opens on the first listed sport. */
const listedFirst = (first: string): SportOption[] => [BY_NAME.find((s) => s.key === first)!, ...BY_NAME.filter((s) => s.key !== first)];

/** The owner's popular five, in his order (brief 2026-11-03). */
const POPULAR = ["football", "cricket", "badminton", "tennis", "tabletennis"];
/** The partner-rotation formats by the declarations: the templates whose stages mint pairs. */
const MINTING = STAGE_TEMPLATES.filter((t) => t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind))).map((t) => t.key);

function mount(sports: SportOption[], over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
    ...over,
  });
}
type H = ReturnType<typeof mount>;

const isHidden = (e: ReactElement) => /(^|\s)hidden(\s|$)/.test(String(propsOf(e).className));
const sportTiles = (h: H) => h.tree().filter((e) => e.type === "label" && typeof propsOf(e)["data-sport"] === "string");
const visibleSports = (h: H) => sportTiles(h).filter((e) => !isHidden(e)).map((e) => propsOf(e)["data-sport"] as string);
const sportRadio = (tile: ReactElement) => walk(tile).find((e) => e.type === "input" && propsOf(e).type === "radio")!;
const checkedSports = (h: H) => sportTiles(h).filter((t) => propsOf(sportRadio(t)).checked === true).map((t) => propsOf(t)["data-sport"] as string);
/** The grid's own children, in order: every tile, then (when there is one) the Show more tile. */
const cells = (h: H, testId: string): ReactElement[] => {
  const grid = byTestId(h, testId);
  if (!grid) throw new Error(`no ${testId}`);
  const kids = propsOf(grid).children as unknown;
  const flat = (x: unknown): ReactElement[] => (Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" ? [x as ReactElement] : []);
  return flat(kids);
};
const isTile = (e: ReactElement, testId: string) => e.type === "button" && propsOf(e)["data-testid"] === testId;

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockResolvedValue({});
});

describe("Sport: a tile per sport, five shown, then Show more (mock Sport A)", () => {
  it("is one group named Sport, described by the 'set at creation' line, a radio tile with its own drawing per listed sport (registry, counts)", () => {
    const h = mount(BY_NAME);
    const group = h.tree().find((e) => e.type === "fieldset" && propsOf(e)["data-testid"] === "division-builder-sport")!;
    expect(group, "the sport tiles sit in a fieldset").toBeDefined();
    const legend = walk(group).find((e) => e.type === "legend")!;
    expect(textOf(legend).trim()).toBe(UI["wizard.sport"]);
    expect(propsOf(group)["aria-describedby"]).toBe("division-builder-sport-fixed");
    const hint = h.tree().find((e) => propsOf(e).id === "division-builder-sport-fixed")!;
    expect(textOf(hint).trim()).toBe(UI["divBuilder.sportFixed"]);
    let checked = 0;
    for (const tile of sportTiles(h)) {
      const key = propsOf(tile)["data-sport"] as string;
      expect(walk(group).includes(tile), `${key} sits in the Sport group`).toBe(true);
      const radio = propsOf(sportRadio(tile));
      expect([radio.name, radio.value], key).toEqual(["division-sport", key]);
      const icon = walk(tile).find((e) => e.type === SportIcon);
      expect(icon && propsOf(icon).sportKey, `${key} draws its own icon`).toBe(key);
      // A 44px target at least (min-h-11 is 44px; the tile is taller).
      expect(String(propsOf(tile).className), key).toMatch(/(^|\s)min-h-(1[1-9]|[2-9]\d)(\s|$)/);
      checked++;
    }
    expect(checked, "one tile per registry sport").toBe(REGISTRY.length);
    expect(checked).toBeGreaterThanOrEqual(10);
    expect(checkedSports(h), "the first listed sport is picked at open").toEqual([BY_NAME[0]!.key]);
  });

  it("generic is the last tile and reads 'Any other game' (the new key), never the catalogue's own name for it", () => {
    const h = mount(BY_NAME);
    const tiles = sportTiles(h);
    const last = tiles.at(-1)!;
    expect(propsOf(last)["data-sport"]).toBe("generic");
    expect(textOf(last).trim()).toBe(UI["divBuilder.sport.generic"]);
    expect(UI["divBuilder.sport.generic"], "a name of its own here").not.toBe(UI["sport.generic"]);
    // Every other tile names its sport by the catalogue's own words.
    for (const t of tiles.slice(0, -1)) expect(textOf(t).trim(), String(propsOf(t)["data-sport"])).toBe(UI[`sport.${propsOf(t)["data-sport"]}`]);
  });

  it("collapsed: the owner's popular five, then the Show more tile as the next cell of the same grid, naming how many more", () => {
    const h = mount(BY_NAME);
    expect(BY_NAME[0]!.key, "premise: the first listed (picked) sport is one of the popular five").toBe("badminton");
    expect(visibleSports(h)).toEqual(POPULAR);
    const grid = cells(h, "division-builder-sports");
    const more = grid.at(-1)!;
    expect(isTile(more, "division-builder-sport-more"), "Show more is the grid's last cell").toBe(true);
    expect(grid.filter((c) => isTile(c, "division-builder-sport-more"))).toHaveLength(1);
    expect(grid.length, "every tile and the Show more tile, in one grid").toBe(REGISTRY.length + 1);
    expect(propsOf(more)["aria-expanded"]).toBe(false);
    expect(textOf(more).trim()).toBe(plural("divBuilder.sport.showMore", REGISTRY.length - 5));
    const cls = String(propsOf(more).className);
    expect(cls).toMatch(/(^|\s)border-dashed(\s|$)/);
    expect(cls, "a 44px target").toMatch(/(^|\s)min-h-(1[1-9]|[2-9]\d)(\s|$)/);
    // Two to a row below md, three from md: one DOM.
    expect(String(propsOf(byTestId(h, "division-builder-sports")!).className)).toMatch(/(^|\s)grid-cols-2(\s|$).*(^|\s)md:grid-cols-3(\s|$)/);
  });

  it("opened: every sport, generic last, the tile says Show fewer; closed again, the five", () => {
    const h = mount(BY_NAME);
    click(h, "division-builder-sport-more");
    expect(visibleSports(h).length).toBe(REGISTRY.length);
    expect(visibleSports(h).at(-1)).toBe("generic");
    const more = byTestId(h, "division-builder-sport-more")!;
    expect(propsOf(more)["aria-expanded"]).toBe(true);
    expect(textOf(more).trim()).toBe(UI["divBuilder.showFewer"]);
    click(h, "division-builder-sport-more");
    expect(visibleSports(h)).toEqual(POPULAR);
  });

  it("the picked sport never folds away: each registry sport opened on, it is shown; outside the five it is the fifth (counts)", () => {
    let pinned = 0;
    for (const k of REGISTRY) {
      const h = mount(listedFirst(k));
      expect(checkedSports(h), k).toEqual([k]);
      const shown = visibleSports(h);
      expect(shown.length, k).toBe(5);
      if (POPULAR.includes(k)) expect(shown, k).toEqual(POPULAR);
      else {
        expect(shown, `${k} takes the fifth slot`).toEqual([...POPULAR.slice(0, 4), k]);
        pinned++;
      }
      expect(textOf(byTestId(h, "division-builder-sport-more")!).trim(), k).toBe(plural("divBuilder.sport.showMore", REGISTRY.length - 5));
    }
    expect(pinned, "every sport outside the popular five").toBe(REGISTRY.length - POPULAR.length);
  });

  it("the sequence: open, tap a sport past the five, close - it stays shown, in the fifth slot; tap a popular one - the five again", () => {
    const h = mount(BY_NAME);
    click(h, "division-builder-sport-more");
    selectSport(h, "hockey");
    click(h, "division-builder-sport-more");
    expect(checkedSports(h)).toEqual(["hockey"]);
    expect(visibleSports(h)).toEqual([...POPULAR.slice(0, 4), "hockey"]);
    selectSport(h, "cricket");
    expect(visibleSports(h)).toEqual(POPULAR);
  });

  it("the organisation's history leads, most recent first; generic stays last however recent", () => {
    const h = mount(BY_NAME, { recentSports: ["carrom", "generic", "volleyball"] });
    expect(visibleSports(h)).toEqual(["carrom", "volleyball", "football", "cricket", "badminton"]);
    click(h, "division-builder-sport-more");
    expect(visibleSports(h).at(-1)).toBe("generic");
    expect(visibleSports(h).slice(5, 7), "the popular ones the history did not name come next").toEqual(["tennis", "tabletennis"]);
  });

  it("one sport listed: its tile alone, and no Show more tile (nothing is folded)", () => {
    const h = mount([BY_NAME.find((s) => s.key === "football")!]);
    expect(visibleSports(h)).toEqual(["football"]);
    expect(byTestId(h, "division-builder-sport-more")).toBeUndefined();
  });
});

describe("SportIcon: the house line, one drawing per registry sport", () => {
  it("every registry sport is drawn, aria-hidden, in the format glyphs' stroke and box, none alike (counts)", () => {
    const seen = new Set<string>();
    let checked = 0;
    for (const k of REGISTRY) {
      const html = renderToStaticMarkup(<SportIcon sportKey={k} />);
      expect(html, k).toContain(`data-sport-icon="${k}"`);
      expect(html, k).toContain('aria-hidden="true"');
      expect(html, k).toContain('viewBox="0 0 28 28"');
      expect(html, k).toContain('stroke-width="1.5"');
      expect(html, k).toContain('stroke-linecap="round"');
      expect(html, k).toMatch(/class="stroke-current/);
      // No colour of its own, no text, no picture: the line takes the tile's colour.
      expect(html, k).not.toMatch(/(fill|stroke)="#|<text|<image|emoji/);
      seen.add(html.replace(/ data-sport-icon="[^"]*"/, ""));
      checked++;
    }
    expect(checked).toBe(REGISTRY.length);
    expect(seen.size, "no two sports share a drawing").toBe(REGISTRY.length);
    expect([...SPORT_ICON_KEYS].sort(), "drawn: exactly the registry").toEqual([...REGISTRY].sort());
  });

  it("a key it does not draw (a sport row with no module, a name Object.prototype owns) draws the catch-all, never throws", () => {
    let checked = 0;
    for (const k of ["padel", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(renderToStaticMarkup(<SportIcon sportKey={k} />), k).toContain('data-sport-icon="generic"');
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("Format: five cards, then Show more as the sixth cell of the cards' grid", () => {
  const toFormat = (h: H) => {
    setName(h, "Open");
    next(h);
  };

  it("every sport, collapsed: five visible, the Show more tile the grid's last cell naming the rest; opened, every card and Show fewer (counts)", () => {
    let checked = 0;
    for (const k of REGISTRY) {
      const h = mount(listedFirst(k));
      toFormat(h);
      const offer = templatesForSport(k, modelOf(k).kinds).map((t) => t.key);
      expect([...templateKeys(h)].sort(), k).toEqual([...offer].sort());
      expect(visibleTemplateKeys(h).length, k).toBe(Math.min(5, offer.length));
      const grid = cells(h, "division-builder-templates");
      const last = grid.at(-1)!;
      expect(isTile(last, "division-builder-show-all"), `${k}: Show more is the grid's last cell, not a button under it`).toBe(true);
      expect(String(propsOf(last).className), k).toMatch(/(^|\s)border-dashed(\s|$)/);
      expect(textOf(last).trim(), k).toBe(UI["divBuilder.showAll"]!.replace("{count}", String(offer.length - 5)));
      expect(propsOf(last)["aria-expanded"], k).toBe(false);
      click(h, "division-builder-show-all");
      expect(visibleTemplateKeys(h).length, k).toBe(offer.length);
      const opened = cells(h, "division-builder-templates").at(-1)!;
      expect(isTile(opened, "division-builder-show-all"), k).toBe(true);
      expect(textOf(opened).trim(), k).toBe(UI["divBuilder.showFewer"]);
      checked++;
    }
    expect(checked).toBe(REGISTRY.length);
  });

  it("Americano and Mexicano come after every other card in the grid, for every sport that offers them (counts)", () => {
    expect([...MINTING].sort(), "premise: the declarations' pair formats are the owner's two").toEqual(["americano", "mexicano"]);
    let offering = 0;
    for (const k of REGISTRY) {
      const h = mount(listedFirst(k));
      toFormat(h);
      const keys = templateKeys(h);
      const first = keys.findIndex((x) => MINTING.includes(x));
      if (first < 0) continue;
      expect(keys.slice(first).every((x) => MINTING.includes(x)), `${k}: ${keys.join(",")}`).toBe(true);
      offering++;
    }
    expect(offering, "some sport offers the pair formats").toBeGreaterThan(0);
  });

  it("collapsed, a pair format shows only as the pick: badminton opens on its top suggestion; another picked, they fold away", () => {
    const h = mount(listedFirst("badminton"));
    toFormat(h);
    const offer = templateKeys(h);
    expect(offer.filter((x) => !MINTING.includes(x)).length, "premise: badminton offers five others or more").toBeGreaterThanOrEqual(5);
    const opening = pickedTemplate(h)!;
    const shown = visibleTemplateKeys(h);
    for (const p of MINTING) expect(shown.includes(p), `${p} collapsed (opening pick ${opening})`).toBe(p === opening);
    if (MINTING.includes(opening)) expect(shown.at(-1), "the picked pair format takes the fifth slot").toBe(opening);
    pickTemplate(h, offer.find((x) => !MINTING.includes(x))!);
    for (const p of MINTING) expect(visibleTemplateKeys(h), p).not.toContain(p);
    // Picked, each is shown collapsed, in the fifth slot.
    for (const p of MINTING) {
      pickTemplate(h, p);
      expect(visibleTemplateKeys(h).at(-1), p).toBe(p);
      expect(visibleTemplateKeys(h).length, p).toBe(5);
    }
  });
});
