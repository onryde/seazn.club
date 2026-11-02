// W3 T10 CI fix (run 41328392447): the Entrants tab of a CHESS division with a running root Swiss crashed ("Something
// went wrong", digest 1442062766) on `permission denied for table stage_round_opens` (42501). The page read the
// division's opened online rounds — the late-entry notice's `openOnlineRounds` — through `withTenant` (role app_user),
// and `stage_round_opens` is SEALED: forced RLS, no policy, no app_user grant (V451; pinned against the database by
// online-chess-video-schema.test.ts "sealed tables"). round-open.ts says its readers must be handed the privileged
// `sql` client, as competition-desk.ts and open-round-view.ts do. Badminton never reached the read (the sport gate),
// which is why only the boardgame half of X-SW-12 went red.
//
// The mock below plays the database's part from that pinned premise: handed anything but the privileged client, the
// reader is refused exactly as Postgres refuses it. Same scaffold as chess-individual-only-wiring.test.tsx beside it
// (the async server component called directly, its returned tree walked).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const db = vi.hoisted(() => {
  const tenantTx = Object.assign(() => Promise.resolve([]), { tenant: true });
  const privileged = Object.assign(() => Promise.resolve([]), { privileged: true });
  return { tenantTx, privileged };
});
const state = vi.hoisted(() => ({
  sport_key: "boardgame",
  divisionStatus: "active",
  stages: [] as Record<string, unknown>[],
}));
const roundOpen = vi.hoisted(() => ({
  roundOpensOfDivisions: vi.fn(async (client: unknown, divisionIds: readonly string[]) => {
    if (client !== db.privileged) {
      throw Object.assign(new Error("permission denied for table stage_round_opens"), { code: "42501" });
    }
    return new Map(
      divisionIds.length === 0
        ? []
        : [["st-1:2", { id: "open-1", roundOpenedAt: new Date(0), openedBy: null, staggered: false }] as const],
    );
  }),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => state.stages),
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: false, visibility: "public", slug: "comp-one" })),
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1",
    name: "Division One",
    status: state.divisionStatus,
    sport_key: state.sport_key,
    variant_key: null,
    module_version: "1.0.0",
    config: {},
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
  orgPlanKey: vi.fn(async () => "pro"),
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
vi.mock("@/lib/db", () => ({
  sql: db.privileged,
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(db.tenantTx),
  statementCount: () => 0,
}));
vi.mock("@/server/usecases/stream-sessions", () => ({ openStreamStates: async () => ({}) }));
vi.mock("@/server/external-play/camera-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/camera-policy")>();
  return { ...actual, competitionCameraPolicy: vi.fn(async () => "off") };
});
vi.mock("@/server/external-play/round-open", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/external-play/round-open")>();
  return { ...actual, roundOpensOfDivisions: roundOpen.roundOpensOfDivisions };
});

import DivisionPage from "../page";
import { EntrantsPanel } from "@/components/v2/entrants-panel";

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

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

/** The `swissLateEntry` prop the page handed the one EntrantsPanel on the Entrants tab. */
async function lateEntryProp(): Promise<{ openOnlineRounds: string[] } | null> {
  const tree = await DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "entrants" }),
  });
  const panels = findAll(tree, (el) => el.type === EntrantsPanel);
  expect(panels, "exactly one entrants panel").toHaveLength(1);
  return (panels[0]!.props as { swissLateEntry: { openOnlineRounds: string[] } | null }).swissLateEntry;
}

/** A root Swiss (no progression, no `qualified`): the stage a late player joins. */
const swiss = (status: string) => ({ id: "st-1", seq: 1, kind: "swiss", name: "Swiss", progression: null, config: { rounds: 3 }, status });

beforeEach(() => {
  state.sport_key = "boardgame";
  state.divisionStatus = "active";
  state.stages = [swiss("active")];
  roundOpen.roundOpensOfDivisions.mockClear();
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
});

describe("division page, Entrants tab of a running root Swiss: the opened online rounds are read with the privileged client", () => {
  it("premise: the stand-in refuses a tenant transaction the way Postgres does (42501), and answers the privileged client", async () => {
    await expect(roundOpen.roundOpensOfDivisions(db.tenantTx, ["div-1"])).rejects.toMatchObject({ code: "42501" });
    expect([...(await roundOpen.roundOpensOfDivisions(db.privileged, ["div-1"])).keys()]).toEqual(["st-1:2"]);
    roundOpen.roundOpensOfDivisions.mockClear();
  });

  it("a chess division: the page renders, and the notice is handed this division's opened rounds", async () => {
    expect(await lateEntryProp()).toEqual({ openOnlineRounds: ["st-1:2"] });
    expect(roundOpen.roundOpensOfDivisions).toHaveBeenCalledTimes(1);
    expect(roundOpen.roundOpensOfDivisions).toHaveBeenCalledWith(db.privileged, ["div-1"]);
  });

  it("a second render reads again (no memo across requests), still with the privileged client", async () => {
    await lateEntryProp();
    await lateEntryProp();
    expect(roundOpen.roundOpensOfDivisions.mock.calls.map(([client]) => client === db.privileged)).toEqual([true, true]);
  });

  it("a sport with no online play (badminton): late entry on, no read, no opened rounds", async () => {
    state.sport_key = "badminton";
    expect(await lateEntryProp()).toEqual({ openOnlineRounds: [] });
    expect(roundOpen.roundOpensOfDivisions).not.toHaveBeenCalled();
  });

  it("a finished Swiss (and a division not yet started): no late entry, so nothing is read", async () => {
    state.stages = [swiss("complete")];
    expect(await lateEntryProp()).toBeNull();
    state.stages = [swiss("pending")];
    state.divisionStatus = "setup";
    expect(await lateEntryProp()).toBeNull();
    expect(roundOpen.roundOpensOfDivisions).not.toHaveBeenCalled();
  });
});
