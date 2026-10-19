// Owner staging test 2026-10-19: chess divisions read "Boardgame" because three client islands printed the stored
// sport key and `.chip { capitalize }` dressed it up as a label. The page header is covered beside the page
// (d/[divSlug]/__tests__/division-header-sport-label.test.tsx); this suite is the other two places:
//   - Settings → Format: the group's summary line and, once fixtures exist, the locked note;
//   - Competition settings → Archived divisions: the row's sport chip.
// Every word is read from the dictionary the island reads (per locale), so a rename moves the test with it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import { DivisionSettings } from "@/components/v2/division-settings";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
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

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

function settings(locked: boolean) {
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
    variants: [{ key: "classical", name: "Classical" }],
    locked,
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    entrantModel: INDIVIDUAL_ONLY,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: true,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: false,
  } as Parameters<typeof DivisionSettings>[0]).tree();
}

beforeEach(() => {
  activeDict.current = DICT.en;
});

describe("Settings → Format names the sport and variant as words", () => {
  it("the group summary reads the dictionary's sport and variant words, in every locale — never the keys", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      activeDict.current = DICT[locale];
      const sport = DICT[locale]["sport.boardgame"]!;
      const variant = DICT[locale]["variant.boardgame.classical"]!;
      const groups = settings(false).filter((n) => propsOf(n).title === DICT[locale]["divset.format"]);
      expect(groups, `${locale}: the Format group renders once`).toHaveLength(1);
      const summary = String(propsOf(groups[0]!).summary);
      expect(summary, locale).toBe(`${sport} · ${variant}`);
      expect(summary, `${locale}: no raw key`).not.toContain("boardgame");
      expect(summary, `${locale}: no raw variant key`).not.toContain("classical");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("once fixtures exist the locked note says the same words, and the summary marks the variant locked", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      activeDict.current = DICT[locale];
      const sport = DICT[locale]["sport.boardgame"]!;
      const variant = DICT[locale]["variant.boardgame.classical"]!;
      const tree = settings(true);
      const locked = tree.filter((n) => propsOf(n)["data-testid"] === "format-locked");
      expect(locked, `${locale}: the locked note renders`).toHaveLength(1);
      // textOf joins every string child with a space; collapse runs so `{sport} · {variant}` reads as one line.
      const line = textOf(propsOf(locked[0]!).children as ReactElement).replace(/\s+/g, " ").trim();
      expect(line.startsWith(`${sport} · ${variant}`), `${locale}: "${line}"`).toBe(true);
      const group = tree.find((n) => propsOf(n).title === DICT[locale]["divset.format"])!;
      expect(String(propsOf(group).summary), locale).toBe(
        `${sport} · ${DICT[locale]["divset.variantLocked"]!.replace("{variant}", variant)}`,
      );
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
