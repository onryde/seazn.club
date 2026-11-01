// Match Day C4 (spec 2026-10-31 §12 Phase C) - the division Settings clean-up. Owner, 2026-10-31: "Format" (the stage structure:
// league / swiss / playoff ...) STAYS in Settings with rebuild-stages; "Rules" (match format, points, tie-breaks) LEFT in C2;
// the entrant kinds move to the Entrants tab (`entrant-kinds-settings.tsx`, its own suite); the Advanced overrides JSON is hidden.
//
// What this file pins on the Settings tab itself, for EVERY sport in the registry (counted; zero swept is a failure):
//   - no Match rules, Standings points, Advanced overrides (JSON) or entrant-kind control is rendered, in any state;
//   - the Format group still carries the structure picker and the rebuild button (open), or the locked note;
//   - the pointer that replaced the rules names ONLINE PLAY only where the division's sport offers it (the strip draws that
//     control for a chess division in a club offered online chess - `onlinePlayShown`), in all four locales.
// The static render cannot open a collapsed Group, so the tree is read through the hook harness, which walks a Group's children.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { DivisionRulesStrip } from "@/components/v2/rules/division-rules-strip";
import { rulesLineDict } from "@/lib/rules-line";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { SettingsGroup } from "@/components/v2/settings-group";
import { CHESS_SPORT_KEY } from "@/lib/chess-individual-only";
import { onlinePlayShown } from "@/lib/online-chess";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const EN = enUi as Record<string, string>;
const LOCALES: [string, Record<string, string>][] = [
  ["en", EN],
  ["es", esUi as Record<string, string>],
  ["fr", frUi as Record<string, string>],
  ["nl", nlUi as Record<string, string>],
];

function props(over: Partial<ComponentProps<typeof DivisionSettings>> & { sportKey?: string } = {}): ComponentProps<typeof DivisionSettings> {
  const { sportKey = "football", ...rest } = over;
  return {
    division: {
      id: "d1",
      name: "Open",
      sport_key: sportKey,
      variant_key: "standard",
      config: {},
      logo_url: null,
      logo_storage_path: null,
    },
    orgId: "org1",
    structureLocked: false,
    lockedFields: [],
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered: true,
    ...rest,
  };
}

/** Everything a reader of the tab could read: the strings the tree renders AND every group's title and folded-row summary, which the
 *  group takes as PROPS (a text walk alone would miss the title of the very block this task removed). */
function surfaceOf(island: { tree: () => ReactElement[]; text: () => string }): string {
  const heads = island
    .tree()
    .filter((e) => e.type === SettingsGroup)
    .flatMap((e) => [propsOf(e).title, propsOf(e).summary])
    .filter((v): v is string => typeof v === "string");
  expect(heads.length, "premise: the tab has groups, with titles").toBeGreaterThan(3);
  return `${island.text()}\n${heads.join("\n")}`;
}

const testIds = (tree: ReactElement[]): string[] => tree.map((e) => propsOf(e)["data-testid"]).filter((v): v is string => typeof v === "string");

/** Every phrase the removed blocks drew, in English - read from the dictionary's own values so a copy edit moves this with it. */
const REMOVED_PHRASES = [
  "Match rules",
  "Standings points",
  "Advanced overrides",
  "Save match rules",
  "Save entrant settings",
  "Reset to sport default",
  "Squad numbers",
] as const;

beforeEach(() => vi.clearAllMocks());

describe("Settings has no rules, points, JSON overrides or entrant kinds - every sport, every state", () => {
  it("swept over the registry x editor/viewer x structure open/locked: none of it is drawn, the Format group is", () => {
    let checked = 0;
    for (const m of builtinModules) {
      for (const canEdit of [true, false]) {
        for (const structureLocked of [false, true]) {
          const island = renderIsland(DivisionSettings, props({ sportKey: m.key, canEdit, structureLocked }));
          const text = surfaceOf(island);
          const ids = testIds(island.tree());
          const where = `${m.key} canEdit=${canEdit} locked=${structureLocked}`;
          for (const phrase of REMOVED_PHRASES) expect(text, `${where}: no "${phrase}"`).not.toContain(phrase);
          expect(text, `${where}: no entrant-kind words`).not.toContain(EN["divset.entrants.kinds"]);
          expect(ids.filter((id) => /^entrants-|rules-(format|points|tiebreaks)|division-rules-panel|advanced|override/i.test(id)), `${where}: no moved or removed test id`).toEqual([]);
          const kindChips = island.tree().filter((e) => propsOf(e)["data-kind"] !== undefined);
          expect(kindChips, `${where}: no entrant-kind chip`).toHaveLength(0);
          // The positive pair: Format stays, with its rebuild.
          expect(text, `${where}: the Format group`).toContain(EN["divset.format"]);
          if (structureLocked) {
            expect(ids, `${where}: the locked note`).toContain("format-locked");
            expect(ids, `${where}: no rebuild once fixtures exist`).not.toContain("apply-structure");
          } else if (canEdit) {
            expect(ids, `${where}: the structure picker`).toContain("format-template");
            expect(ids, `${where}: the rebuild button`).toContain("apply-structure");
          }
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: renders swept").toBe(builtinModules.length * 4);
    expect(builtinModules.length, "premise: the registry is not empty").toBeGreaterThan(1);
  });

  it("the other groups survive the clean-up (the positive pair for the removals)", () => {
    const text = surfaceOf(renderIsland(DivisionSettings, props()));
    for (const key of ["divset.general", "divset.format", "divset.requiredTags.title", "divset.news.title", "divset.publicPage.title", "divset.sharing", "divset.danger"]) {
      expect(text, key).toContain(EN[key]);
    }
  });
});

describe("the pointer to Division rules names online play only where the division's sport offers it", () => {
  const rulesMovedText = (tree: ReactElement[]): string => {
    const el = tree.find((e) => propsOf(e)["data-testid"] === "division-rules-moved");
    expect(el, "premise: the pointer is on the page").toBeDefined();
    return textOf(el!);
  };

  it("football (and every sport but chess): the pointer does not say online play; chess in a club offered online chess: it does", () => {
    let checked = 0;
    for (const m of builtinModules) {
      for (const offered of [true, false]) {
        const text = rulesMovedText(renderIsland(DivisionSettings, props({ sportKey: m.key, onlineChessOffered: offered })).tree());
        const named = text.toLowerCase().includes(EN["divset.onlinePlay.label"]!.toLowerCase());
        // The expected answer is the strip's own predicate (one authority), which this suite also pins to the sport registry below.
        expect(named, `${m.key} offered=${offered}`).toBe(m.key === CHESS_SPORT_KEY && offered);
        expect(text, `${m.key} offered=${offered}: still links to the strip`).toContain(EN["divset.rulesMovedLink"]);
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * 2);
  });

  it("the pointer names online play exactly when the Division rules strip draws the Online play control - read off both rendered surfaces (counted)", () => {
    const stripDrawsOnline = (sportKey: string, offered: boolean): boolean => {
      const m = builtinModules.find((x) => x.key === sportKey)!;
      const markup = renderToStaticMarkup(
        <DictProvider dict={enUi as Dict} locale="en">
          <DivisionRulesStrip
            divisionId="d1"
            sportKey={sportKey}
            variantKey={Object.keys(m.variants)[0] ?? null}
            divisionConfig={{}}
            divisionTiebreakers={null}
            tableKinds={["league"]}
            canEdit
            ruleDict={rulesLineDict(enPublic as Dict)}
            variants={[]}
            lockedFields={[]}
            onlineChessOffered={offered}
            initialOpen={["format"]}
          />
        </DictProvider>,
      );
      return markup.includes('data-testid="division-online-play"');
    };
    let checked = 0;
    let drawn = 0;
    for (const m of builtinModules) {
      for (const offered of [true, false]) {
        const strip = stripDrawsOnline(m.key, offered);
        const pointer = rulesMovedText(renderIsland(DivisionSettings, props({ sportKey: m.key, onlineChessOffered: offered })).tree());
        expect(pointer.toLowerCase().includes(EN["divset.onlinePlay.label"]!.toLowerCase()), `${m.key} offered=${offered}: pointer vs strip`).toBe(strip);
        if (strip) drawn++;
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * 2);
    expect(drawn, "premise: the strip draws the control for exactly one case").toBe(1);
  });

  it("onlinePlayShown is true for exactly chess while the club is offered it, over the whole registry (counted)", () => {
    let checked = 0;
    let shown = 0;
    for (const m of builtinModules) {
      for (const offered of [true, false]) {
        const want = m.key === CHESS_SPORT_KEY && offered;
        expect(onlinePlayShown(m.key, offered), `${m.key} offered=${offered}`).toBe(want);
        if (want) shown++;
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.length * 2);
    expect(shown, "premise: exactly one sport shows online play, once").toBe(1);
  });

  it("both sentences exist in every locale, in the locale's own words; only the online one names online play (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const plain = dict["divset.rulesMoved"];
      const online = dict["divset.rulesMovedOnline"];
      expect(typeof plain === "string" && plain.length > 0, `${loc}: plain sentence`).toBe(true);
      expect(typeof online === "string" && online.length > 0, `${loc}: online sentence`).toBe(true);
      const word = dict["divset.onlinePlay.label"]!.toLowerCase();
      expect(online!.toLowerCase(), `${loc}: names online play`).toContain(word);
      expect(plain!.toLowerCase(), `${loc}: plain does not`).not.toContain(word);
      expect(plain, `${loc}: the two differ`).not.toBe(online);
      if (loc !== "en") {
        expect(plain, `${loc}: translated`).not.toBe(EN["divset.rulesMoved"]);
        expect(online, `${loc}: translated`).not.toBe(EN["divset.rulesMovedOnline"]);
      }
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the orphaned copy is gone from every locale", () => {
  it("the keys whose last reader left Settings are deleted in en/es/fr/nl (counted)", () => {
    const GONE = ["divset.saveRules", "divset.matchRules", "divset.advanced", "divset.invalidJson", "divset.rulesNote", "divset.entrants.title"];
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      for (const key of GONE) {
        expect(Object.hasOwn(dict, key), `${loc}: ${key}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(GONE.length * LOCALES.length);
  });
});
