// Owner staging test 2026-10-19: chess divisions read "Boardgame" because three client islands printed the stored
// sport key and `.chip { capitalize }` dressed it up as a label. The page header is covered beside the page
// (d/[divSlug]/__tests__/division-header-sport-label.test.tsx); this suite is the other two places:
//   - Settings: Settings → Format named them in its summary line and locked note until FMT5 moved the format to the
//     Division rules card; Settings now names neither, and must not leak the raw key anywhere either;
//   - Competition settings → Archived divisions: the row's sport chip.
// Every word is read from the dictionary the island reads (per locale), so a rename moves the test with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { SettingsGroup } from "@/components/v2/settings-group";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { DivisionSettings } from "@/components/v2/division-settings";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/settings",
}));

const { activeDict } = vi.hoisted(() => ({ activeDict: { current: {} as Record<string, string> } }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
    },
  };
});

const DICT = {
  en: enUi as Record<string, string>,
  es: esUi as Record<string, string>,
  fr: frUi as Record<string, string>,
  nl: nlUi as Record<string, string>,
} as const;
const LOCALES = Object.keys(DICT) as (keyof typeof DICT)[];

function settings() {
  return renderIsland(DivisionSettings, {
    division: {
      id: "d1",
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical" },
      logo_url: null,
      logo_storage_path: null,
      camera_policy: null,
      inherited_camera_policy: "off",
    },
    orgId: "org1",
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    autoPosts: false,
    canAutoPost: true,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: false,
  } as Parameters<typeof DivisionSettings>[0]);
}

beforeEach(() => {
  activeDict.current = DICT.en;
});

describe("Settings never prints the stored sport or variant key (FMT5: the Format group that named them is gone)", () => {
  it("in every locale: no raw key in the text, the group titles or their summaries - and no Format group", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      activeDict.current = DICT[locale];
      const island = settings();
      const groups = island.tree().filter((n) => n.type === SettingsGroup);
      expect(groups.length, `${locale}: premise: Settings renders its groups`).toBeGreaterThan(3);
      const surface = [island.text(), ...groups.flatMap((g) => [propsOf(g).title, propsOf(g).summary]).filter((v): v is string => typeof v === "string")].join("\n");
      expect(surface, `${locale}: no raw sport key`).not.toMatch(/\bboardgame\b/i);
      expect(surface, `${locale}: no raw variant key`).not.toMatch(/\bclassical\b/);
      expect(island.tree().some((n) => propsOf(n)["data-testid"] === "format-locked"), `${locale}: no format lock note`).toBe(false);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

describe("Archived divisions: the row's sport chip is the sport's word", () => {
  const ARCHIVED = (sport: string) => [
    { id: "d1", name: "Retired Open", sport_key: sport, archived_at: "2026-01-02T00:00:00.000Z" },
  ];
  const chipOf = (sport: string) => {
    const tree = renderIsland(ArchivedDivisions, {
      divisions: ARCHIVED(sport),
      canEdit: true,
      archivedSlotsExplainRefusal: false,
      viewerPlan: "community",
    }).tree();
    const chips = tree.filter((n) => n.type === "span" && propsOf(n).className === "chip");
    expect(chips, `${sport}: one chip per row`).toHaveLength(1);
    return textOf(propsOf(chips[0]!).children as ReactElement);
  };

  it("chess is the dictionary's word in every locale, not 'boardgame'", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      activeDict.current = DICT[locale];
      expect(chipOf("boardgame"), locale).toBe(DICT[locale]["sport.boardgame"]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("another sport takes the same path, and a sport nobody names falls back to a title-cased key", () => {
    expect(chipOf("generic")).toBe(DICT.en["sport.generic"]);
    expect(chipOf("kabaddi")).toBe("Kabaddi");
  });
});
