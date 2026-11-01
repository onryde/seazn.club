// Owner ruling 2026-10-26: chess divisions are individual-only. A chess division saved before the ruling may still
// carry a widened `config.entrants`; the division page must NOT read it for chess, so the entrants panel (add form +
// roster editor) and the Settings tab are handed the sport's own individual-only model - and must keep reading it
// for every other sport. Same scaffold as division-header-sport-label.test.tsx beside it (the async server component
// called directly, its returned tree walked); the expected models come from the engine's own declarations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "es" | "fr" | "nl",
  sport_key: "boardgame",
  variant_key: "classical",
  config: {} as Record<string, unknown>,
  moduleEntrantModel: null as unknown,
  /** Match Day C4: a billing-frozen competition makes the page's `editable` false while `canEdit` stays true. */
  frozen: false,
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: state.frozen, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => state.locale) }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "setup",
    sport_key: state.sport_key,
    variant_key: state.variant_key,
    module_version: "1.0.0",
    config: state.config,
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
    camera_policy: null,
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({ divisionConsumesSlotOnArchive: vi.fn(async () => false) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "UTC" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: state.moduleEntrantModel,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: [],
  })),
}));
vi.mock("@/server/usecases/discipline", () => ({
  getDisciplineRules: vi.fn(async () => null),
  activeSuspensionsByEntrant: vi.fn(async () => new Map()),
  divisionSquad: vi.fn(async () => []),
  listSuspensions: vi.fn(async () => []),
}));
const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});

import DivisionPage from "../page";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const renderPage = (tab = "entrants") =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

function findAll(node: ReactNode, match: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (match(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, match, out);
  return out;
}

import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { CHESS_SPORT_KEY } from "@/lib/chess-individual-only";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { EntrantKindsSettings } from "@/components/v2/entrant-kinds-settings";
import { DivisionSettings } from "@/components/v2/division-settings";

/** The entrant model the page handed to the one component of this type on this tab. */
async function modelOn(tab: "entrants" | "settings", type: unknown): Promise<{ kinds: string[]; defaultKind: string }> {
  const found = findAll(await renderPage(tab), (el) => el.type === type);
  expect(found, `exactly one ${tab} component`).toHaveLength(1);
  return (found[0]!.props as { entrantModel: { kinds: string[]; defaultKind: string } }).entrantModel;
}

// A division config whose override widens the kinds to everything and makes team the default.
const WIDENED = { entrants: { kinds: ["team", "pair", "individual"], defaultKind: "team" } };

beforeEach(() => {
  state.locale = "en";
  state.sport_key = "boardgame";
  state.variant_key = "classical";
  state.config = {};
  state.moduleEntrantModel = null;
  state.frozen = false;
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
});

describe("division page: chess ignores a legacy widened entrants override", () => {
  it("a chess division with a widened override is handed individual-only, by both components that hold the entrant model on the Entrants tab", async () => {
    const chess = builtinModules.find((m) => m.key === CHESS_SPORT_KEY)!;
    state.sport_key = CHESS_SPORT_KEY;
    state.config = WIDENED;
    state.moduleEntrantModel = chess.entrantModel ?? null;
    const want = effectiveEntrantModel(chess.entrantModel ?? null);
    expect(want.kinds, "premise: the engine declares chess individual-only").toEqual(["individual"]);
    // Match Day C4: the entrant kinds moved from the Settings tab to the top of the Entrants tab; the roster panel and the kinds
    // block read the one clamped model.
    for (const type of [EntrantsPanel, EntrantKindsSettings]) {
      const got = await modelOn("entrants", type);
      expect(got.kinds, String(type.name)).toEqual(want.kinds);
      expect(got.defaultKind, String(type.name)).toBe(want.defaultKind);
    }
  });

  it("every OTHER sport still reads the override: the same config widens its model (swept over the registry)", async () => {
    let checked = 0;
    for (const m of builtinModules.filter((x) => x.key !== CHESS_SPORT_KEY)) {
      state.sport_key = m.key;
      state.config = WIDENED;
      state.moduleEntrantModel = m.entrantModel ?? null;
      const want = effectiveEntrantModel(m.entrantModel ?? null, WIDENED);
      expect(want.kinds, `premise: the override widens ${m.key}`).toContain("team");
      const got = await modelOn("entrants", EntrantsPanel);
      expect(got.kinds, m.key).toEqual(want.kinds);
      expect(got.defaultKind, m.key).toBe("team");
      checked++;
    }
    expect(checked).toBe(builtinModules.length - 1);
    expect(checked).toBeGreaterThan(1);
  });
});


// Match Day C4 (owner, 2026-10-31): the entrant kinds live at the top of the Entrants tab, for the organiser only, and are gone from
// Settings. The page is the seam: it decides who sees the block and hands it the division's STORED config (the save is a wholesale
// config PATCH, and Reset / the legacy-chess line read the stored `entrants` key off it). Driven through the real page, both
// directions: the editor gets it, the viewer does not, and the Settings tab no longer asks for an entrant model at all.
describe("division page: the entrant kinds block (Match Day C4)", () => {
  const FOOTBALL_STORED = { variant: "standard", entrants: { kinds: ["individual", "team"], defaultKind: "team" } };

  it("an organiser's Entrants tab mounts the block once, above the roster, with this division's id, sport, stored config and model", async () => {
    state.sport_key = "football";
    state.config = FOOTBALL_STORED;
    state.moduleEntrantModel = (builtinModules.find((m) => m.key === "football")!).entrantModel ?? null;
    const tree = await renderPage("entrants");
    const kinds = findAll(tree, (el) => el.type === EntrantKindsSettings);
    expect(kinds, "exactly one kinds block").toHaveLength(1);
    const p = kinds[0]!.props as { divisionId: string; sportKey: string; config: unknown; canEdit: boolean; entrantModel: { kinds: string[]; defaultKind: string } };
    expect(p.divisionId).toBe("div-1");
    expect(p.sportKey).toBe("football");
    expect(p.config, "the STORED config, entrants override included").toEqual(FOOTBALL_STORED);
    expect(p.canEdit).toBe(true);
    expect(p.entrantModel).toEqual(effectiveEntrantModel((builtinModules.find((m) => m.key === "football")!).entrantModel ?? null, FOOTBALL_STORED));
    // Above the roster: in document order, the kinds block comes before the roster panel.
    const order = findAll(tree, (el) => el.type === EntrantKindsSettings || el.type === EntrantsPanel).map((el) => el.type);
    expect(order).toEqual([EntrantKindsSettings, EntrantsPanel]);
  });

  it("a viewer's Entrants tab has no kinds block (the roster panel is still there: the positive pair)", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    const tree = await renderPage("entrants");
    expect(findAll(tree, (el) => el.type === EntrantKindsSettings)).toHaveLength(0);
    expect(findAll(tree, (el) => el.type === EntrantsPanel), "premise: the Entrants tab rendered").toHaveLength(1);
  });

  it("a billing-frozen organiser still sees the block, read-only (canEdit false), as Settings showed it", async () => {
    state.frozen = true;
    const tree = await renderPage("entrants");
    const kinds = findAll(tree, (el) => el.type === EntrantKindsSettings);
    expect(kinds).toHaveLength(1);
    expect((kinds[0]!.props as { canEdit: boolean }).canEdit).toBe(false);
  });

  it("the kinds block is on the Entrants tab only: not on Fixtures or Settings, and Settings is no longer handed an entrant model", async () => {
    state.sport_key = "football"; // the chess fixtures tab asks the arbiter and external-play reads, which this scaffold does not mock
    state.moduleEntrantModel = (builtinModules.find((m) => m.key === "football")!).entrantModel ?? null;
    for (const tab of ["fixtures", "settings"]) {
      const tree = await renderPage(tab);
      expect(findAll(tree, (el) => el.type === EntrantKindsSettings), `${tab}: no kinds block`).toHaveLength(0);
    }
    const settings = findAll(await renderPage("settings"), (el) => el.type === DivisionSettings);
    expect(settings, "premise: Settings rendered").toHaveLength(1);
    const keys = Object.keys(settings[0]!.props as object);
    expect(keys, "premise: the props were read").toContain("structureLocked");
    expect(keys).not.toContain("entrantModel");
    expect(keys).not.toContain("entrantModelSource");
  });

  it("every sport in the registry gets the block on its Entrants tab, handed its own sport key (counted)", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      state.sport_key = m.key;
      state.config = {};
      state.moduleEntrantModel = m.entrantModel ?? null;
      const kinds = findAll(await renderPage("entrants"), (el) => el.type === EntrantKindsSettings);
      expect(kinds, m.key).toHaveLength(1);
      expect((kinds[0]!.props as { sportKey: string }).sportKey, m.key).toBe(m.key);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(1);
  });
});
