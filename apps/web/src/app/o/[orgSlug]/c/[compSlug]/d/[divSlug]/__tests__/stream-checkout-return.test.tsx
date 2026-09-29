// Task 14 fix round 1 — G1: the match-credit checkout returns to THIS page
// (`?tab=fixtures&fixture=…&stream=open&checkout=success&session_id=…`, see
// app/api/billing/relay-checkout/route.ts), and the return render can beat
// Stripe's webhook. The page reconciles the session BEFORE it reads the balance
// it hands the Phone tab, or the club that has just paid is shown the buy card
// again. Same harness as roster-drift-stage-wiring.test.tsx beside it (the async
// server component called directly, its element tree walked — no jsdom here),
// so what is pinned is the page's REAL wiring: which usecase it calls, with
// what, in which order, and what the Phone tab is handed as a result.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
const stagesSpies = vi.hoisted(() => ({
  listStages: vi.fn(),
  getStandings: vi.fn(async () => ({ rows: [] })),
  getSeedProposal: vi.fn(),
  getStageRosterDrift: vi.fn(),
}));

vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/stages", () => stagesSpies);

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
    sport_key: "generic",
    variant_key: "score",
    module_version: "1.0.0",
    config: {},
    tiebreakers: undefined,
    auto_posts: false,
    logo_url: null,
    logo_storage_path: null,
    competition_id: "comp-1",
  })),
  listVariantOptions: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/division-slots", () => ({
  divisionConsumesSlotOnArchive: vi.fn(async () => false),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    frozen: false,
    visibility: "private",
    slug: "comp-one",
  })),
}));
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

const relay = vi.hoisted(() => ({
  reconcile: vi.fn<(orgId: string, sessionId: string) => Promise<boolean>>(async () => true),
  balance: vi.fn<(auth: unknown, orgId: string) => Promise<number>>(async () => 0),
}));
vi.mock("@/server/usecases/stream-credits-checkout", () => ({
  reconcileStreamCreditsCheckout: (orgId: string, sessionId: string) => relay.reconcile(orgId, sessionId),
}));
vi.mock("@/server/usecases/stream-sessions", () => ({
  relayBalance: (auth: unknown, orgId: string) => relay.balance(auth, orgId),
}));

import DivisionPage from "../page";
import { StagesPanel } from "@/components/v2/stages-panel";

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

const PAGE = {
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "UTC" },
};

const render = (sp: Record<string, string>) =>
  DivisionPage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve(sp),
  });

const streamBalanceOf = async (sp: Record<string, string>): Promise<unknown> => {
  const panel = find(await render(sp), StagesPanel);
  expect(panel, "no StagesPanel on the fixtures tab").not.toBeNull();
  return (panel!.props as { stream?: { streamBalance?: unknown } }).stream?.streamBalance;
};

describe("the checkout return reconciles the session BEFORE the Phone tab's balance is read (G1)", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(PAGE);
    stagesSpies.listStages.mockReset().mockResolvedValue([]);
    relay.reconcile.mockClear();
    relay.balance.mockReset();
  });

  it("?checkout=success&session_id=… reconciles THAT session for THIS page's org, then reads the balance — and hands the tab the post-reconcile number", async () => {
    // The balance double answers 0 until the reconcile has run and the purchase's credits after — so the number the tab
    // receives can only be the fresh one if the ORDER is right (an order-blind test would pass on either).
    let reconciled = false;
    relay.reconcile.mockImplementation(async () => { reconciled = true; return true; });
    relay.balance.mockImplementation(async () => (reconciled ? 5 : 0));
    const balance = await streamBalanceOf({
      tab: "fixtures", fixture: "fx-1", stream: "open", checkout: "success", session_id: "cs_test_return_1",
    });
    expect(relay.reconcile).toHaveBeenCalledTimes(1);
    expect(relay.reconcile).toHaveBeenCalledWith(PAGE.auth.orgId, "cs_test_return_1");
    expect(relay.reconcile.mock.invocationCallOrder[0]!).toBeLessThan(relay.balance.mock.invocationCallOrder[0]!);
    expect(balance, "the tab was handed the pre-reconcile balance").toBe(5);
  });

  it("an ordinary visit — no checkout, a cancelled checkout, a success without its session id — makes NO Stripe reconcile", async () => {
    relay.balance.mockResolvedValue(2);
    let checked = 0;
    for (const sp of [
      { tab: "fixtures" } as Record<string, string>,
      { tab: "fixtures", checkout: "cancel", session_id: "cs_test_x" },
      { tab: "fixtures", checkout: "success" },
    ]) {
      // The positive half of the pair: the page still hands the tab the balance it read (G4's seam, witnessed here).
      expect(await streamBalanceOf(sp), JSON.stringify(sp)).toBe(2);
      checked++;
    }
    expect(checked).toBe(3);
    expect(relay.reconcile).not.toHaveBeenCalled();
  });
});
