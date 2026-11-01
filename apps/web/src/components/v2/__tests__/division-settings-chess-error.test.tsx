// Owner ruling 2026-10-26: chess divisions take individual players only. A division save the server refuses with
// 422 CHESS_INDIVIDUAL_ONLY (a stale page, or a widened entrants override changed under the organiser) reads in the
// organiser's language: the CODE is localised, the server's English sentence is never shown. Every string this ruling
// added exists in all four locales, each in its own words.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
const net = vi.hoisted(() => ({ refuse: null as Error | null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string) => {
      if (net.refuse && url === "/api/v1/divisions/d1") throw net.refuse;
      return {};
    },
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { CHESS_INDIVIDUAL_ONLY } from "@/lib/chess-individual-only";
import { DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<(typeof LOCALES)[number], Dict>;

// Match Day C2: the match rules' Save moved to the Division rules strip (Fixtures tab); it re-sends the config, entrants
// override included, so the refusal is met there.
const settings = {
  division: {
    id: "d1",
    name: "Blitz Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", entrants: { kinds: ["individual", "team"] } },
    logo_url: null,
    logo_storage_path: null,
    camera_policy: null,
    inherited_camera_policy: "off",
  },
  orgId: "org1",
  variants: [{ key: "classical", name: "Classical" }],
  structureLocked: false,
  lockedFields: [],
  stages: [],
  canEdit: true,
  divisionPathPrefix: "/o/org/c/comp/d/",
  fixturesHref: "/o/org/c/comp/d/div/fixtures",
  embed: null,
  danger: null,
  entrantModel: { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null },
  entrantModelSource: "override",
  autoPosts: false,
  canAutoPost: true,
  showSeeds: true,
  viewerPlan: "community",
  onlineChessOffered: true,
};
const props = stripPropsOf(settings);

beforeEach(() => {
  net.refuse = null;
});

describe("the division rules' Save refused because chess takes individual players only", () => {
  const SERVER_SENTENCE = "Chess divisions take individual players only (server English)";

  it("renders the localised refusal, never the server's English text", async () => {
    net.refuse = new ApiV1Error(SERVER_SENTENCE, 422, CHESS_INDIVIDUAL_ONLY);
    const island = renderIsland(DivisionRulesStrip, props, expandRules);
    const save = island.tree().find((n) => n.type === "button" && textOf(n).trim() === (DICTS.en["rulesStrip.format.save"] as string));
    expect(save, "premise: the save is there").toBeDefined();
    (propsOf(save!).onClick as () => void)();
    const want = DICTS.en["divset.err.chessIndividualOnly"] as string;
    expect(typeof want === "string" && want.length > 0, "premise: the English sentence exists").toBe(true);
    await vi.waitFor(() => expect(island.text()).toContain(want));
    expect(island.text(), "the server's sentence is never shown").not.toContain(SERVER_SENTENCE);
  });

  it("a different refusal is not mistaken for it (control): it falls through to the generic failure", async () => {
    net.refuse = new ApiV1Error("something else", 422, "SOME_OTHER_CODE");
    const island = renderIsland(DivisionRulesStrip, props, expandRules);
    const save = island.tree().find((n) => n.type === "button" && textOf(n).trim() === (DICTS.en["rulesStrip.format.save"] as string));
    (propsOf(save!).onClick as () => void)();
    await vi.waitFor(() => expect(island.text()).toContain("something else"));
    expect(island.text()).not.toContain(DICTS.en["divset.err.chessIndividualOnly"] as string);
  });

  it("every string the ruling added exists in all four locales, each in its own words", () => {
    const KEYS = [
      "reg.settings.entrant.chessOnly",
      "reg.settings.entrant.chessLegacy",
      "divset.entrants.chessOnly",
      "divset.entrants.chessLegacy",
      "divset.err.chessIndividualOnly",
      "import.error.chessIndividualOnly",
      "import.issueCode.chessIndividualOnly",
    ] as const;
    let checked = 0;
    for (const key of KEYS) {
      const words = LOCALES.map((l) => DICTS[l][key]);
      for (const [i, w] of words.entries()) {
        expect(typeof w === "string" && w.trim().length > 0, `${LOCALES[i]} ${key}`).toBe(true);
        checked++;
      }
      expect(new Set(words).size, `${key} is translated, not copied`).toBe(LOCALES.length);
    }
    expect(checked).toBe(KEYS.length * LOCALES.length);
  });
});
