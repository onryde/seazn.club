// Owner ruling 2026-11-01 (Match Day D1, legs Option A): the "Triple round robin" template is no longer offered — not by
// the division builder's picker for any sport, not by the Settings format select for a division that is not already one.
// The server keeps legs up to 8 (Jul3/08), and a division STORED as a triple round robin keeps showing what it is, picked,
// and a format save keeps its legs as they are: hidden from the offer, never clamped.
//
// Expected values come from the ruling (the retired key is `triple_rr`; chess also loses americano and mexicano, owner
// ruling 2026-10-26) and the en dictionary, never from templatesForSport. Every registered sport is swept.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { DivisionSettings } from "@/components/v2/division-settings";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockResolvedValue({});
});

const RETIRED = "triple_rr";
const CHESS = "boardgame";
const REFUSED_FOR_CHESS = ["americano", "mexicano"];
const en = enUi as Record<string, string>;
const RETIRED_LABEL = en[`format.template.${RETIRED}.label`]!;

/** The builder's format picker card grid, as division-builder-chess-formats.test.tsx bounds it. */
function builderGrid(sportKey: string): string {
  const sport: SportOption = { key: sportKey, name: sportKey, variants: [{ key: "v", name: "V", system: true }] };
  const html = renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <DivisionBuilder competitionId="c1" orgSlug="org" compSlug="comp" sports={[sport]} viewerPlan="community" />
    </DictProvider>,
  );
  const start = html.indexOf('class="grid gap-2 sm:grid-cols-3"');
  const end = html.indexOf('class="grid gap-4 sm:grid-cols-3"', start);
  if (start === -1 || end === -1) throw new Error("could not locate the format picker's card grid");
  return html.slice(start, end);
}

describe("the division builder offers no Triple round robin, for any sport (owner ruling 2026-11-01)", () => {
  it("premise: the label the sweep looks for is the template's, and no other card's label contains it", () => {
    expect(RETIRED_LABEL).toBe("Triple round robin");
    const others = STAGE_TEMPLATES.filter((t) => t.key !== RETIRED).map((t) => en[`format.template.${t.key}.label`]!);
    expect(others.filter((l) => l.includes(RETIRED_LABEL))).toEqual([]);
  });

  it("every registered sport: the card is absent and every other card the sport is offered renders (counts)", () => {
    let swept = 0;
    let cardsSeen = 0;
    for (const m of builtinModules) {
      const grid = builderGrid(m.key);
      expect(grid, m.key).not.toContain(RETIRED_LABEL);
      const refused = m.key === CHESS ? REFUSED_FOR_CHESS : [];
      const cards = grid.split('name="template"').length - 1;
      expect(cards, m.key).toBe(STAGE_TEMPLATES.length - 1 - refused.length);
      cardsSeen += cards;
      swept++;
    }
    expect(swept).toBe(builtinModules.length);
    expect(swept).toBeGreaterThanOrEqual(11);
    expect(cardsSeen).toBeGreaterThan(0);
  });
});

type StageProp = Parameters<typeof DivisionSettings>[0]["stages"][number];

function mountSettings(stages: StageProp[]) {
  return renderIsland(DivisionSettings, {
    division: {
      id: "d1",
      name: "Open",
      sport_key: "badminton",
      variant_key: "bwf",
      config: {},
      logo_url: null,
      logo_storage_path: null,
    },
    orgId: "org1",
    structureLocked: false,
    lockedFields: [],
    stages,
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: createElement("div"),
    danger: createElement("div"),
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: true,
  });
}
type Settings = ReturnType<typeof mountSettings>;

function formatSelect(h: Settings): ReactElement {
  const select = h.tree().find((e) => propsOf(e)["data-testid"] === "format-template");
  if (!select) throw new Error("no Settings format select");
  return select;
}
const optionKeys = (h: Settings) =>
  walk(propsOf(formatSelect(h)).children as ReactElement).filter((e) => e.type === "option").map((e) => String(propsOf(e).value));

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A division stored as a triple round robin, as the template wrote it before the ruling. */
const STORED_TRIPLE: StageProp[] = [{ kind: "league", name: "Triple RR", config: { legs: 3 }, progression: null }];

describe("Settings: the format select offers no Triple round robin, except to a division that already is one", () => {
  it("empty case: a division with no stages yet is not offered it", () => {
    const h = mountSettings([]);
    const keys = optionKeys(h);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain(RETIRED);
  });

  it("a stored league at Once is not offered it either", () => {
    const h = mountSettings([{ kind: "league", name: "League", config: { legs: 1 }, progression: null }]);
    expect(propsOf(formatSelect(h)).value).toBe("league");
    expect(optionKeys(h)).not.toContain(RETIRED);
  });

  it("a stored triple round robin still shows what it is, picked, and a format save keeps its 3 legs (never clamped)", async () => {
    const h = mountSettings(STORED_TRIPLE);
    expect(propsOf(formatSelect(h)).value).toBe(RETIRED);
    expect(optionKeys(h).filter((k) => k === RETIRED), "listed once").toEqual([RETIRED]);

    const apply = h.tree().find((e) => propsOf(e)["data-testid"] === "apply-structure");
    (propsOf(apply!).onClick as () => void)();
    await flush();
    const puts = apiV1Mock.mock.calls.filter(([url]) => /\/divisions\/d1\/stages$/.test(String(url)));
    type Sent = { kind: string; config: { legs?: number } }[];
    const json = (puts.at(-1)?.[1] as { json: Sent | { stages: Sent } } | undefined)?.json;
    const sent = Array.isArray(json) ? json : json?.stages;
    expect(sent?.map((s) => [s.kind, s.config.legs])).toEqual([["league", 3]]);
  });
});
