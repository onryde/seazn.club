// T15 — the division page's way into the arbiter panel: a link on the
// fixtures tab, for the organiser, only where there is something to watch —
// a chess division that plays online and has fixtures. Every other cell of
// that table renders no link (and the panel itself 404s there; the arbiter
// page's own suite). Same scaffold as online-chess-flag-wiring.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame", config: { variant: "classical", onlinePlay: "lichess" } as Record<string, unknown> }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
const queue = vi.hoisted(() => ({
  listNeedsOrganiserExternalPlay: vi.fn(),
  listFlaggedExternalPlay: vi.fn(),
  listRunSheetOnlinePlay: vi.fn(),
}));

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
    config: division.config,
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
  listDivisionFixtures: vi.fn(async () => fx.rows),
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
// The queue's and the run sheet's reads are database reads; the flag helper beside them stays REAL.
vi.mock("@/server/usecases/external-play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/external-play")>();
  return { ...actual, ...queue };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: flags.isServerFeatureEnabled };
});

import DivisionPage from "../page";
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";

function findAll(node: ReactNode, pred: (el: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child as ReactNode, pred, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  if (pred(node)) out.push(node);
  findAll((node.props as { children?: ReactNode }).children, pred, out);
  return out;
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};
const FIXTURE = {
  id: "f1",
  stage_id: "st-1",
  status: "scheduled",
  scheduled_at: null,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  home_slot_label: null,
  away_slot_label: null,
  outcome: null,
  round_no: 1,
  seq_in_round: 1,
};
const ARBITER = routes.divisionArbiter("org", "comp", "div");
const renderPage = (tab: string) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });
const arbiterLinks = async (tab: string) =>
  findAll(await renderPage(tab), (el) => el.type === Link && (el.props as { href?: unknown }).href === ARBITER);

beforeEach(() => {
  division.sport_key = "boardgame";
  division.config = { variant: "classical", onlinePlay: "lichess" };
  fx.rows = [FIXTURE];
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
});

describe("division page: the arbiter panel link", () => {
  it("fixtures tab, organiser, online chess division with fixtures: ONE link, its copy", async () => {
    const links = await arbiterLinks("fixtures");
    expect(links).toHaveLength(1);
    // The page's `t` is the key in this scaffold: the copy's own keys.
    expect((links[0]!.props as { children?: unknown }).children).toBe("arbiter.entry.link");
  });

  it("every other cell renders no link", async () => {
    const cells: [string, () => void, string][] = [
      ["a viewer", () => pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false }), "fixtures"],
      ["over the board", () => (division.config = { variant: "classical" }), "fixtures"],
      ["another sport", () => (division.sport_key = "generic"), "fixtures"],
      ["no fixtures yet", () => (fx.rows = []), "fixtures"],
      ["the entrants tab", () => undefined, "entrants"],
      ["the standings tab", () => undefined, "standings"],
    ];
    let checked = 0;
    for (const [label, arm, tab] of cells) {
      division.sport_key = "boardgame";
      division.config = { variant: "classical", onlinePlay: "lichess" };
      fx.rows = [FIXTURE];
      pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
      arm();
      expect(await arbiterLinks(tab), label).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(6);
  });
});
