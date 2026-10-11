// T20 — the division page asks the club's online-chess flag (PostHog `online-chess`, fallback off) and hands the
// answer to the two islands that render online-chess START controls: DivisionSettings (`onlineChessOffered` — the
// Online play select and the camera control) and the needs-a-result queue (`resendOffered` — Resend link). The islands'
// own suite (online-chess-flag-controls.test.tsx) proves what each prop hides; this one proves the PAGE passes the
// flag's real answer, asked for this user in this club, and asks nothing for a division that is not chess.
//
// Same scaffold as public-hub-link.test.tsx beside it: no jsdom, the async server component called directly, its
// returned tree walked. The flag is asked through the REAL helper, PostHog doubled at its boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame" }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
const queue = vi.hoisted(() => ({ listNeedsOrganiserExternalPlay: vi.fn() }));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" })),
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
    status: "active",
    sport_key: division.sport_key,
    variant_key: division.sport_key === "boardgame" ? "classical" : "score",
    module_version: "1.0.0",
    config: division.sport_key === "boardgame" ? { variant: "classical" } : {},
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
    entrantModel: null,
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
// The queue's rows are a database read; the flag helper beside it in the same module stays REAL.
vi.mock("@/server/usecases/external-play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/external-play")>();
  return { ...actual, listNeedsOrganiserExternalPlay: queue.listNeedsOrganiserExternalPlay };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});

import DivisionPage from "../page";
import { DivisionSettings } from "@/components/v2/division-settings";
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";

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
const renderPage = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

type FlagState = { label: string; offered: boolean; arm: () => void };
const FLAG_STATES: readonly FlagState[] = [
  { label: "flag ON", offered: true, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(true) },
  { label: "flag OFF", offered: false, arm: () => flags.isServerFeatureEnabled.mockResolvedValue(false) },
  { label: "PostHog throws", offered: false, arm: () => flags.isServerFeatureEnabled.mockRejectedValue(new Error("down")) },
];
function flagIs(s: FlagState): void {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset();
  s.arm();
}
const ROW = {
  fixtureId: "f1",
  fixtureNo: 3,
  homeName: "Ann",
  awayName: "Bo",
  scheduledAt: null,
  lastError: null,
};

beforeEach(() => {
  division.sport_key = "boardgame";
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("division page: the online-chess flag's answer reaches the islands", () => {
  it("Settings tab of a chess division: DivisionSettings gets the flag's answer, asked for this user in this club", async () => {
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const settings = findAll(await renderPage("settings"), DivisionSettings);
      expect(settings, `${s.label}: DivisionSettings mounted once`).toHaveLength(1);
      expect((settings[0]!.props as { onlineChessOffered: unknown }).onlineChessOffered, s.label).toBe(s.offered);
      expect(flags.isServerFeatureEnabled, s.label).toHaveBeenCalledWith("online-chess", "user-1", {
        orgId: "org-1",
        fallback: false,
      });
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("Fixtures tab with a board needing a result: the queue's Resend follows the flag", async () => {
    queue.listNeedsOrganiserExternalPlay.mockResolvedValue([ROW]);
    let checked = 0;
    for (const s of FLAG_STATES) {
      flagIs(s);
      const queues = findAll(await renderPage("fixtures"), ExternalPlayNeedsResultQueue);
      expect(queues, `${s.label}: the queue mounted once`).toHaveLength(1);
      expect((queues[0]!.props as { resendOffered: unknown }).resendOffered, s.label).toBe(s.offered);
      checked++;
    }
    expect(checked).toBe(FLAG_STATES.length);
  });

  it("not chess: DivisionSettings gets false and the flag is never asked", async () => {
    division.sport_key = "generic";
    flagIs(FLAG_STATES[0]!);
    const settings = findAll(await renderPage("settings"), DivisionSettings);
    expect(settings).toHaveLength(1);
    expect((settings[0]!.props as { onlineChessOffered: unknown }).onlineChessOffered).toBe(false);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });

  it("a fixtures tab with an empty queue asks nothing", async () => {
    flagIs(FLAG_STATES[0]!);
    expect(findAll(await renderPage("fixtures"), ExternalPlayNeedsResultQueue)).toHaveLength(0);
    expect(flags.isServerFeatureEnabled).not.toHaveBeenCalled();
  });
});
