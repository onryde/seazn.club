// Online Chess credits (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6; plan Task 11): the division page hands the Division rules
// strip the facts its "Players, up to" select, price line and format refusal are drawn from (`onlinePackageView`), the checkout return's
// receipt request (`?oc=pay`, with the ladder-only `size` an upgrade named) and the Format dialog the division's online play. Same scaffold
// as online-chess-flag-wiring.test.tsx beside it: no jsdom, the async server component called directly, its returned tree walked, the flag
// asked through the REAL helper with PostHog doubled at its boundary, and `onlinePackageView` (a database read, proved by its own DB suite)
// doubled with what the real read answers.
//
// Mutant table (each run once by hand; results in the commit message):
//   P1 gate         the package read asked on every tab / without the flag / for another sport  -> "asks the package read only where the strip draws it"
//   P2 receipt      `receipt` not parsed from the address, or parsed without `oc=pay`          -> "the checkout return's receipt request"
//   P3 href         `buyMoreHref` dropped or built from another route                            -> "hands the strip the view's facts"
//   P4 failure      the read's throw not caught (a 500 over a courtesy)                          -> "a failing read is logged"
//   P5 format card  `onlinePlay` of the Format dialog not handed down / read from the wrong key  -> "the Format dialog is told whether the division plays online"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tenantRunningPrelude, type TenantOpts } from "@/lib/__tests__/_with-tenant-mock";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const division = vi.hoisted(() => ({ sport_key: "boardgame", onlinePlay: "off" as "off" | "lichess" }));
const fx = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
// The competition's BILLING freeze (an over-quota club is read-only), which turns an organiser's `canEdit` into a non-editable page.
const billing = vi.hoisted(() => ({ frozen: false }));
const flags = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn() }));
// The division's resolved venue zone, as `getScheduleSettings` serves it (the division's own override, else the club's).
const schedule = vi.hoisted(() => ({ tz: "UTC" }));
// Who holds no Lichess link (the online-switch warning): the real page hands DivisionSettings a summary of this list.
const unlinked = vi.hoisted(() => ({ read: vi.fn() }));
const NO_GAPS = { unlinked: [], reconnect: [], empty: [] };
const queue = vi.hoisted(() => ({
  listNeedsOrganiserExternalPlay: vi.fn(),
  listFlaggedExternalPlay: vi.fn(),
  listRunSheetOnlinePlay: vi.fn(),
  listOpenRounds: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => ({
  listStages: vi.fn(async () => []),
  // W2d Task 15: the page reads every stage's table rules (the Tie-breaks section) on the fixtures tab.
  listStagesWithTableRules: vi.fn(async () => []),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  divisionFormatLocked: vi.fn(async () => false),
  getStageRosterDrift: vi.fn(async () => ({ ghosts: [], unplaced: [] })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({ id: "comp-1", frozen: billing.frozen, visibility: "public", slug: "comp-one" })),
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
    config: division.sport_key === "boardgame" ? { variant: "classical", onlinePlay: division.onlinePlay } : {},
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
vi.mock("@/server/usecases/entrants", () => ({
  listEntrants: vi.fn(async () => []),
  listLichessLinkGaps: unlinked.read,
}));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: schedule.tz })),
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
  withTenant: (_orgId: string, fn: (t: unknown) => unknown, opts?: TenantOpts) => tenantRunningPrelude(tx, fn, opts),
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

const pkg = vi.hoisted(() => ({ view: vi.fn() }));
vi.mock("@/server/usecases/online-package", () => ({ onlinePackageView: pkg.view }));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({ reconcileStreamCreditsCheckout: vi.fn(async () => true) }));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";
import { EntrantsPanel } from "@/components/v2/entrants-panel";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";

/** The names of the props whose value is a function: the ones a Server Component cannot hand to a client island. */
function functionProps(props: Record<string, unknown>): string[] {
  return Object.entries(props).filter(([, v]) => typeof v === "function").map(([k]) => k);
}

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
const renderPage = (tab: string, more: Record<string, string | string[]> = {}) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab, ...more }),
  });


const VIEW = {
  planCap: 64,
  held: 3,
  rounds: 5,
  cameras: false,
  balance: 11,
  stored: { size: 16, paid: null, frozen: false },
  stageKinds: ["swiss"],
};
type Strip = { onlinePackage?: Record<string, unknown>; format?: { onlinePlay?: unknown } };
const stripOf = (tree: ReactNode): Strip => {
  const panels = findAll(tree, StagesPanel);
  expect(panels, "the fixtures tab mounts one StagesPanel").toHaveLength(1);
  return (panels[0]!.props as { rulesStrip: Strip }).rulesStrip;
};
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
const offered = () => flagIs(FLAG_STATES[0]!);

beforeEach(() => {
  division.sport_key = "boardgame";
  division.onlinePlay = "off";
  billing.frozen = false;
  schedule.tz = "UTC";
  fx.rows = [];
  pkg.view.mockReset().mockResolvedValue(VIEW);
  pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
  queue.listOpenRounds.mockReset().mockResolvedValue([]);
  queue.listNeedsOrganiserExternalPlay.mockReset().mockResolvedValue([]);
  queue.listFlaggedExternalPlay.mockReset().mockResolvedValue({ boards: [], ownBoards: 0 });
  queue.listRunSheetOnlinePlay.mockReset().mockResolvedValue({});
  unlinked.read.mockReset().mockResolvedValue(NO_GAPS);
  forgetOnlineChessFlagCache();
  flags.isServerFeatureEnabled.mockReset().mockRejectedValue(new Error("flag asked while the override was on"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("division page: the Online Chess package facts reach the Division rules strip", () => {
  it("hands the strip the view's facts, the credits address and no receipt on an ordinary visit; asks the read for THIS division", async () => {
    offered();
    const strip = stripOf(await renderPage("fixtures"));
    expect(pkg.view).toHaveBeenCalledTimes(1);
    expect(pkg.view).toHaveBeenCalledWith({ orgId: "org-1", competitionId: "comp-1", divisionId: "div-1" });
    expect(strip.onlinePackage).toEqual({ ...VIEW, buyMoreHref: routes.creditsStream("org"), receipt: null, buy: { orgId: "org-1", currency: "gbp" } });
    expect(routes.creditsStream("org"), "premise: the Streaming side of the credits page").toBe("/o/org/settings/credits?kind=stream");
    expect(functionProps(strip.onlinePackage!), "the strip is a client island: no function crosses").toEqual([]);
  });

  it("asks the package read only where the strip draws the online play control: the flag, a chess division, the fixtures tab, an editor", async () => {
    let checked = 0;
    // flag off / PostHog down: not offered
    for (const s of FLAG_STATES.filter((x) => !x.offered)) {
      flagIs(s);
      pkg.view.mockClear();
      expect(stripOf(await renderPage("fixtures")).onlinePackage, s.label).toBeUndefined();
      expect(pkg.view, s.label).not.toHaveBeenCalled();
      checked++;
    }
    // another sport: no online play control
    offered();
    division.sport_key = "generic";
    pkg.view.mockClear();
    expect(stripOf(await renderPage("fixtures")).onlinePackage, "generic").toBeUndefined();
    expect(pkg.view, "generic").not.toHaveBeenCalled();
    checked++;
    division.sport_key = "boardgame";
    // another tab: Settings asks the flag (its camera control) but draws no strip
    for (const tab of ["settings", "standings", "entrants"]) {
      pkg.view.mockClear();
      await renderPage(tab);
      expect(pkg.view, tab).not.toHaveBeenCalled();
      checked++;
    }
    // a viewer who cannot edit
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    pkg.view.mockClear();
    await renderPage("fixtures");
    expect(pkg.view, "viewer").not.toHaveBeenCalled();
    checked++;
    expect(checked).toBe(7);
    // the positive pair: the same page for an organiser on chess with the flag on does read it
    pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
    await renderPage("fixtures");
    expect(pkg.view).toHaveBeenCalledTimes(1);
  });

  it("a failing read is logged and the strip renders without the select - never a 500 over a courtesy", async () => {
    offered();
    const err = new Error("read failed");
    pkg.view.mockRejectedValue(err);
    const spy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    const strip = stripOf(await renderPage("fixtures"));
    expect(strip.onlinePackage).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ err, divisionId: "div-1" }), expect.stringContaining("online chess package"));
  });
});

const SESSION = "cs_test_a1B2c3";
describe("division page: the checkout return's receipt request (?oc=pay) - the route's own address, through the page", () => {
  /** The query of a URL built exactly as the relay-checkout route builds the division return (route.ts `returnTo: "division"`),
   *  the way Next hands it to a page: decoded, one string a key. */
  const tailOf = (size?: number) => {
    // Stripe replaces the `{CHECKOUT_SESSION_ID}` template the route writes with the session's id: that id is the arrival's key.
    const url = `http://x/o/org/c/comp/d/div?tab=fixtures&oc=pay&checkout=success&session_id={CHECKOUT_SESSION_ID}${size === undefined ? "" : `&size=${size}`}`.replace("{CHECKOUT_SESSION_ID}", SESSION);
    return Object.fromEntries(new URL(url).searchParams) as Record<string, string>;
  };
  const receiptFor = async (more: Record<string, string | string[]>) => {
    pkg.view.mockClear();
    const { tab, ...rest } = more;
    return stripOf(await renderPage(typeof tab === "string" ? tab : "fixtures", rest)).onlinePackage?.receipt;
  };

  it("oc=pay opens it on the stored size; a ladder size names the upgrade's target; each ladder size once", async () => {
    offered();
    expect(await receiptFor(tailOf())).toEqual({ size: null, key: SESSION });
    let checked = 0;
    for (const size of [16, 32, 64, 128, 256]) {
      expect(await receiptFor(tailOf(size)), `size ${size}`).toEqual({ size, key: SESSION });
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(5);
  });

  it("anything but a clean oc=pay opens nothing, and a size off the ladder is dropped (the receipt still opens, on the stored size)", async () => {
    offered();
    expect(await receiptFor({ tab: "fixtures" }), "a plain visit").toBeNull();
    expect(await receiptFor({ tab: "fixtures", checkout: "success", session_id: "cs_1" }), "a settings-style return").toBeNull();
    expect(await receiptFor({ tab: "fixtures", oc: "paid" }), "another oc value").toBeNull();
    expect(await receiptFor({ tab: "fixtures", oc: ["pay", "pay"] }), "two oc values").toBeNull();
    for (const size of ["48", "0", "-16", "16.5", "0x10", "1e2", "16 ", "", "4096", "abc"]) {
      expect(await receiptFor({ ...tailOf(), size }), `size ${JSON.stringify(size)}`).toEqual({ size: null, key: SESSION });
    }
    expect(await receiptFor({ ...tailOf(), size: ["16", "32"] }), "two sizes").toEqual({ size: null, key: SESSION });
  });
});

describe("division page: the Format dialog is told whether the division plays online", () => {
  it("online play on: true; off: false - the dialog greys the formats Online Chess does not run for the first", async () => {
    offered();
    let checked = 0;
    for (const [onlinePlay, expected] of [["lichess", true], ["off", false]] as const) {
      division.onlinePlay = onlinePlay;
      expect(stripOf(await renderPage("fixtures")).format?.onlinePlay, onlinePlay).toBe(expected);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// Online Chess credits (plan Task 12): the entrants tab's "size is full" refusal offers the way out, a link to the Fixtures tab where the size
// select and the pay line are. The page is what knows the address, and who may follow it: an organiser (not a view-only member, not a club whose
// billing is frozen, which is read-only there too).
describe("division page: the entrants tab's Change size address", () => {
  const entrantsPanelOf = async (): Promise<Record<string, unknown>> => {
    const panels = findAll(await renderPage("entrants"), EntrantsPanel);
    expect(panels, "the entrants tab mounts one EntrantsPanel").toHaveLength(1);
    return panels[0]!.props as Record<string, unknown>;
  };

  it("an organiser is handed this division's Fixtures tab address", async () => {
    offered();
    expect((await entrantsPanelOf()).changeSizeHref).toBe(routes.division("org", "comp", "div", "fixtures"));
    expect(routes.division("org", "comp", "div", "fixtures"), "premise: the tab that holds the size select").toBe("/o/org/c/comp/d/div?tab=fixtures");
  });

  it("a view-only member and a billing-frozen club are handed none (the pair: the organiser above is)", async () => {
    offered();
    pageAuth.requireDivisionPage.mockResolvedValue({ ...PAGE, canEdit: false });
    expect((await entrantsPanelOf()).changeSizeHref, "view-only").toBeNull();
    pageAuth.requireDivisionPage.mockResolvedValue(PAGE);
    billing.frozen = true;
    expect((await entrantsPanelOf()).changeSizeHref, "billing frozen").toBeNull();
  });
});

