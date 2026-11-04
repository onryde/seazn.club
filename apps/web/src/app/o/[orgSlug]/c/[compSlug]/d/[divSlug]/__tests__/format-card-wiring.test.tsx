// FMT5 (owner-approved 2026-11-03): the division's format moved from Settings › Format onto the Fixtures tab's Division rules
// card. The card's Format button and chip are only as real as the `format` prop this page hands the stage panel's
// `rulesStrip` (AGENTS.md class 1, the inert seam: a prop the card declares and nothing sends). The button and the dialog are
// proven in components/v2/rules/__tests__/division-format.test.tsx and the lock predicate against a real database in
// server/usecases/__tests__/format-change.test.ts; what neither can see is the PAGE's own call, so this drives the real async
// server component and reads the props on the <StagesPanel> it returns:
//  - `locked` is what `divisionFormatLocked` answered for THIS division under THIS session, and nothing else: a fixture with no
//    result does not lock the format (it locked on the first fixture before FMT5), and the started-stage rule locks
//    (`divisionLockedFields`) do not either;
//  - the offer is the new-division builder's own, over THIS division's entrant kinds;
//  - the estimates count the division's own courts (the schedule's, else the club's live ones, else the builder's opening
//    plan) and its field;
//  - the dialog opens on `?format=open`, and the old Settings › Format addresses land there.
// Was settings-locks-wiring.test.tsx: the structure lock it pinned on <DivisionSettings> left Settings with the format.
// Same scaffold as match-day-link-wiring.test.tsx beside it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { RefusedField } from "@/lib/rule-errors";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "badminton", config: {} as Record<string, unknown> }));
const comp = vi.hoisted(() => ({ frozen: false }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const roster = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const court = vi.hoisted(() => ({ schedule: [] as string[], venues: [] as unknown[] }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
const lockSpy = vi.hoisted(() => ({ divisionLockedFields: vi.fn() }));
const featureSpy = vi.hoisted(() => ({ hasFeature: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);
vi.mock("@/server/usecases/rule-locks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/rule-locks")>()),
  ...lockSpy,
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: comp.frozen, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/i18n", () => ({
  getDictionary: vi.fn(async () => ({})),
  t: (_dict: unknown, key: string) => key,
}));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: "setup",
    sport_key: division.sport_key,
    variant_key: "short",
    module_version: "1.0.0",
    config: division.config,
    tiebreakers: undefined,
    auto_posts: false,
    show_seeds: true,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
    camera_policy: null,
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({ divisionConsumesSlotOnArchive: vi.fn(async () => false) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => fx.rows),
  listFixtureHeadlines: vi.fn(async () => ({})),
}));
vi.mock("@/server/usecases/entrants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/entrants")>();
  return {
    DEPARTED_STATUSES: actual.DEPARTED_STATUSES,
    listEntrants: vi.fn(async () => roster.rows),
    listLichessLinkGaps: vi.fn(async () => ({ unlinked: [], reconnect: [], empty: [] })),
  };
});
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: court.schedule }, tz: "UTC" })),
}));
vi.mock("@/server/usecases/venues", () => ({ listVenues: vi.fn(async () => court.venues) }));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: featureSpy.hasFeature,
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "gbp") }));
vi.mock("@/server/usecases/teams", () => ({ listEntrantLogoUrls: vi.fn(async () => ({})) }));
vi.mock("@/server/engine-db", () => ({
  resolveModule: vi.fn(() => ({
    entrantModel: null,
    positions: { groups: [], roles: [] },
    metrics: [],
    defaultTiebreakers: () => [],
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
// A chess fixtures tab reads the online-play queues; database reads, doubled empty (online chess not offered).
vi.mock("@/server/usecases/external-play", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/external-play")>()),
  listNeedsOrganiserExternalPlay: vi.fn(async () => []),
  listFlaggedExternalPlay: vi.fn(async () => ({ boards: [], ownBoards: 0 })),
  listRunSheetOnlinePlay: vi.fn(async () => ({})),
  listOpenRounds: vi.fn(async () => []),
  onlineChessOffered: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/match-day", () => ({
  competitionFixturesToday: vi.fn(async () => 0),
  findCourtForDivision: vi.fn(async () => null),
}));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";
import { DivisionSettings } from "@/components/v2/division-settings";
import type { DivisionFormatProps } from "@/components/v2/rules/division-format";
import { resolveModule } from "@/server/engine-db";
import { builtinModules } from "@seazn/engine/sports";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";
import { divisionFormatOffer, OPENING_PLAN } from "@/lib/division-builder/model";
import { templatesForSport, buildTemplateStages } from "@/lib/format-templates";
import { templateLocksFor } from "@/server/usecases/format-gates";

function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, type, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (node.type === type) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, type, out);
  return out;
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

/** A generated, unplayed fixture row - the columns the page reads. */
const FIXTURE = {
  id: "fx-1",
  stage_id: "stage-a",
  status: "scheduled",
  scheduled_at: null,
  home_entrant_id: "e-ana",
  away_entrant_id: "e-ben",
  home_slot_label: null,
  away_slot_label: null,
  outcome: null,
  round: 1,
  position: 0,
  fixture_no: 1,
};

const LOCKS: RefusedField[] = [
  { field: "setTo", code: "DIVISION_FORMAT_LOCKED", stageId: "stage-a", stageName: "Pool A" },
];

const render = (query: Record<string, string>) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(query),
  });

async function formatProp(query: Record<string, string> = { tab: "fixtures" }): Promise<DivisionFormatProps | undefined> {
  const panels = findAll(await render(query), StagesPanel);
  expect(panels, "the fixtures tab mounts the stage panel once").toHaveLength(1);
  const strip = (panels[0]!.props as { rulesStrip?: { format?: DivisionFormatProps } }).rulesStrip;
  expect(strip, "premise: the panel is handed the Division rules card").toBeDefined();
  return strip!.format;
}

/** The page's pinned module, with the REAL engine entrant model of the sport (the file's mock declares none). */
async function withEngineModel<T>(sportKey: string, run: () => Promise<T>): Promise<T> {
  const mocked = vi.mocked(resolveModule);
  const base = mocked.getMockImplementation()!;
  const entrantModel = builtinModules.find((m) => m.key === sportKey)!.entrantModel;
  mocked.mockImplementation(((...a: Parameters<typeof resolveModule>) => ({ ...(base as (...x: unknown[]) => object)(...a), entrantModel })) as never);
  try {
    return await run();
  } finally {
    mocked.mockImplementation(base);
  }
}

let venueSeq = 0;
const venue = (courts: { archived: boolean }[], archived = false) => ({
  id: `v-${++venueSeq}`,
  name: "Hall",
  archived_at: archived ? "2026-01-01" : null,
  courts: courts.map((c, i) => ({ id: `c-${venueSeq}-${i}`, name: `Court ${i + 1}`, tags: [], archived_at: c.archived ? "2026-01-01" : null })),
});

beforeEach(() => {
  division.sport_key = "badminton";
  division.config = {};
  comp.frozen = false;
  fx.rows = [];
  roster.rows = [];
  court.schedule = [];
  court.venues = [];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  stagesSpies.listStages.mockReset().mockResolvedValue([]);
  stagesSpies.divisionFormatLocked.mockReset().mockResolvedValue(false);
  lockSpy.divisionLockedFields.mockReset().mockResolvedValue([]);
  featureSpy.hasFeature.mockReset().mockResolvedValue(true);
});

describe("the division page hands the Division rules card its Format button (FMT5)", () => {
  it("locked is what divisionFormatLocked answered, asked once for THIS division under THIS session", async () => {
    stagesSpies.divisionFormatLocked.mockResolvedValue(true);
    const format = await formatProp();
    expect(format?.locked).toBe(true);
    expect(stagesSpies.divisionFormatLocked).toHaveBeenCalledTimes(1);
    expect(stagesSpies.divisionFormatLocked).toHaveBeenCalledWith(PAGE.auth, "div-1");
  });

  it("a fixture with no result does not lock the format, nor does a started-stage rule lock (the pre-FMT5 lock was the first fixture)", async () => {
    fx.rows = [FIXTURE];
    lockSpy.divisionLockedFields.mockResolvedValue(LOCKS);
    const format = await formatProp();
    expect(format, "premise: the card is handed").toBeDefined();
    expect(format!.locked).toBe(false);
  });

  it("the empty case: no stages, no entrants, no courts - the card is handed, unlocked, with the opening plan's courts", async () => {
    const format = await formatProp();
    expect(format).toBeDefined();
    expect(format!.stages).toEqual([]);
    expect(format!.entrants).toBe(0);
    expect(format!.places).toBe(OPENING_PLAN.venues);
    expect(format!.locked).toBe(false);
    expect(format!.canEdit).toBe(true);
    expect(format!.initialOpen).toBe(false);
    expect(format!.divisionId).toBe("div-1");
    expect(format!.sportKey).toBe("badminton");
  });

  it("a reader and a billing-frozen organiser get no Format button, and the lock is never asked", async () => {
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    expect(await formatProp()).toBeUndefined();
    pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
    comp.frozen = true;
    expect(await formatProp()).toBeUndefined();
    expect(stagesSpies.divisionFormatLocked).not.toHaveBeenCalled();
    // The positive pair: the same organiser, unfrozen, is handed it.
    comp.frozen = false;
    expect(await formatProp()).toBeDefined();
  });

  it("only the fixtures tab asks the lock: Settings, Entrants and Standings never do", async () => {
    for (const tab of ["settings", "entrants", "standings"]) await render({ tab });
    expect(stagesSpies.divisionFormatLocked).not.toHaveBeenCalled();
    // The positive pair: the fixtures tab does.
    await render({ tab: "fixtures" });
    expect(stagesSpies.divisionFormatLocked).toHaveBeenCalledTimes(1);
  });

  it("the stored stages reach the card as stored (name, kind, config, progression), in board order", async () => {
    const drafts = buildTemplateStages("league_ko", { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 });
    expect(drafts.length, "premise: a two-stage format").toBe(2);
    stagesSpies.listStages.mockResolvedValue(
      drafts.map((d, i) => ({ id: `s${i}`, seq: i + 1, name: d.name, kind: d.kind, config: d.config ?? null, progression: d.progression ?? null })),
    );
    const format = await formatProp();
    expect(format!.stages).toEqual(drafts.map((d) => ({ name: d.name, kind: d.kind, config: d.config ?? null, progression: d.progression ?? null })));
  });

  it("the estimates count the division's active field, not its withdrawals", async () => {
    roster.rows = [
      { id: "e1", display_name: "A", status: "registered", seed: 1 },
      { id: "e2", display_name: "B", status: "confirmed", seed: 2 },
      { id: "e3", display_name: "C", status: "withdrawn", seed: 3 },
    ];
    expect((await formatProp())!.entrants).toBe(2);
  });

  it("courts: the schedule's own when it has any, else the club's LIVE courts, else the opening plan's", async () => {
    court.venues = [venue([{ archived: false }, { archived: false }, { archived: true }]), venue([{ archived: false }], true)];
    expect((await formatProp())!.places, "two live courts in a live venue").toBe(2);
    court.schedule = ["c-a", "c-b", "c-c"];
    expect((await formatProp())!.places, "the schedule's three win").toBe(3);
    court.schedule = [];
    court.venues = [venue([{ archived: true }])];
    expect((await formatProp())!.places, "only archived courts: the opening plan").toBe(OPENING_PLAN.venues);
  });

  it("the plan locks and the carry gate are the stage writers' own gates, asked of this organisation", async () => {
    featureSpy.hasFeature.mockImplementation(async (_org: string, key: string) => key !== "formats.double_elim" && key !== "standings.carry_over");
    const format = await formatProp();
    expect(format!.templateLocks).toEqual(templateLocksFor({ doubleElim: false, advanced: true }));
    expect(Object.keys(format!.templateLocks).length, "premise: double elim locks something").toBeGreaterThan(0);
    expect(format!.carryAllowed).toBe(false);
    for (const key of ["formats.double_elim", "formats.advanced"]) {
      expect(featureSpy.hasFeature).toHaveBeenCalledWith("org-1", key, "comp-1");
    }
  });

  it("?format=open opens the dialog; nothing else does", async () => {
    expect((await formatProp({ tab: "fixtures", format: "open" }))!.initialOpen).toBe(true);
    expect((await formatProp({ tab: "fixtures", format: "1" }))!.initialOpen).toBe(false);
    expect((await formatProp({ tab: "fixtures" }))!.initialOpen).toBe(false);
  });
});

describe("the Format button's offer is the builder's, over THIS division's entrant kinds", () => {
  it("no override: the sport's engine kinds, and the builder's offer for them (badminton plays americano)", async () => {
    const format = await withEngineModel("badminton", () => formatProp());
    expect(format!.entrantKinds).toEqual(engineEntrantKinds("badminton"));
    const kinds = engineEntrantKinds("badminton");
    expect(format!.offer).toEqual(divisionFormatOffer(templatesForSport("badminton", kinds).map((t) => t.key), kinds));
    expect(format!.offer).toEqual(expect.arrayContaining(["americano", "mexicano", "league"]));
  });

  it("a Pairs-only division is offered no pair-rotation format (americano and mexicano mint pairs from individuals)", async () => {
    division.config = { entrants: { kinds: ["pair"], defaultKind: "pair" } };
    const format = await withEngineModel("badminton", () => formatProp());
    expect(format!.entrantKinds).toEqual(["pair"]);
    expect(format!.offer).not.toContain("americano");
    expect(format!.offer).not.toContain("mexicano");
    expect(format!.offer, "the positive pair: the rest of the offer stands").toContain("league");
  });

  it("chess: individual-only whatever the stored override says, and no pair-rotation format", async () => {
    division.sport_key = "boardgame";
    division.config = { variant: "classical", onlinePlay: "off", entrants: { kinds: ["individual", "team"], defaultKind: "team" } };
    const format = await withEngineModel("boardgame", () => formatProp());
    expect(format!.entrantKinds).toEqual(["individual"]);
    expect(format!.offer).not.toContain("americano");
    expect(format!.offer).toContain("swiss");
  });
});

describe("a stored format stays in the offer, so the division still shows what it is (ported from Settings › Format)", () => {
  const storedAs = (template: string) =>
    stagesSpies.listStages.mockResolvedValue(
      buildTemplateStages(template, { qualified: 4, swissRounds: 5, poolCount: 2, legs: 1 }).map((d, i) => ({
        id: `s${i}`,
        seq: i + 1,
        name: d.name,
        kind: d.kind,
        config: d.config ?? null,
        progression: d.progression ?? null,
      })),
    );

  it("triple round robin (retired 2026-11-01): absent for an empty division, present for one stored as it", async () => {
    const empty = await withEngineModel("badminton", () => formatProp());
    expect(empty!.offer).not.toContain("triple_rr");
    stagesSpies.listStages.mockResolvedValue([{ id: "s0", seq: 1, name: "Triple RR", kind: "league", config: { legs: 3 }, progression: null }]);
    const stored = await withEngineModel("badminton", () => formatProp());
    expect(stored!.offer.filter((k) => k === "triple_rr"), "listed once").toEqual(["triple_rr"]);
  });

  it("chess stored as americano before the individual-only ruling keeps americano; mexicano stays absent", async () => {
    division.sport_key = "boardgame";
    division.config = { variant: "classical", onlinePlay: "off" };
    storedAs("americano");
    const format = await withEngineModel("boardgame", () => formatProp());
    expect(format!.offer).toContain("americano");
    expect(format!.offer).not.toContain("mexicano");
  });
});

describe("the old Settings › Format addresses land on the card with the dialog open (FMT5)", () => {
  const TARGET = "/o/org/c/comp/d/div?tab=fixtures&format=open";
  const redirectOf = async (query: Record<string, string>) => {
    try {
      await render(query);
    } catch (err) {
      return (err as { digest?: string }).digest ?? String(err);
    }
    return null;
  };

  it("?tab=format and ?tab=settings&section=format redirect there, before any read", async () => {
    const queries: Record<string, string>[] = [{ tab: "format" }, { tab: "settings", section: "format" }];
    for (const query of queries) {
      const digest = await redirectOf(query);
      expect(digest, JSON.stringify(query)).toMatch(/^NEXT_REDIRECT;/);
      expect(digest!.split(";")[2], JSON.stringify(query)).toBe(TARGET);
    }
    expect(pageAuth.requireDivisionPage, "the redirect asks nothing first").not.toHaveBeenCalled();
  });

  it("the positive pair: ?tab=settings alone still opens Settings, which no longer carries the format", async () => {
    expect(await redirectOf({ tab: "settings", section: "general" })).toBeNull();
    const settings = findAll(await render({ tab: "settings" }), DivisionSettings);
    expect(settings).toHaveLength(1);
    const keys = Object.keys(settings[0]!.props as object);
    expect(keys, "premise: the props were read").toContain("fixturesHref");
    for (const gone of ["stages", "structureLocked", "lockedFields", "swissField", "entrantKinds"]) {
      expect(keys, `Settings is no longer handed ${gone}`).not.toContain(gone);
    }
  });
});
