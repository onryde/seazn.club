// `react-hooks/purity`: four components read `Date.now()` in their render
// body. Each of those reads drives something a person watches change over
// time — an override that LAPSES, an invite that EXPIRES, a match day that
// PASSES, the run sheet's NOW line — and each only moved when something
// unrelated happened to re-render the component. The fix reads the clock
// through `useNow` (match-centre/use-now.ts: lazy initial read, interval
// re-read, never during render), so it now advances on its own.
//
// The witness for every site is the same shape: put a deadline 30s ahead,
// render, move the fake clock 2 minutes WITHOUT touching props or state, and
// the screen must have crossed it. A render-time `Date.now()` cannot pass
// that (nothing re-renders), and neither can the tempting lint-only fix
// `useState(() => Date.now())` (it reads once, at mount, and freezes).
//
// Each site is its own component with its own data path, so each gets its own
// case, and each case first proves the thing it watches is on screen before
// the clock moves (a row that never rendered cannot "lapse").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { AdminPlanPanel } from "@/components/admin-plan-panel";
import { OrgTeam } from "@/components/org-team";
import { OfficiatingLane } from "@/components/me/officiating-lane";
import { StagesPanel } from "@/components/v2/stages-panel";
import { RunSheet } from "@/components/v2/desk/run-sheet";
import type { MyOfficiatingAssignment } from "@/server/usecases/me-officiating";

const net = vi.hoisted(() => ({ invites: [] as unknown[] }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn(async (url: string) => (url.endsWith("/invites") ? net.invites : [])),
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: vi.fn(async () => ({})),
}));

/** 12:00Z on 14 October 2026. */
const AT = Date.parse("2026-10-14T12:00:00.000Z");
/** The deadline every site is given: half a minute ahead of the clock. */
const SOON = new Date(AT + 30_000).toISOString();
/** How far the clock moves with nothing else happening. */
const LATER_MS = 120_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(AT);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a clock read during render advances on its own (react-hooks/purity)", () => {
  it("admin plan panel: an override marks itself (lapsed) once its expiry passes", () => {
    const island = renderIsland(AdminPlanPanel, {
      orgId: "org-1",
      orgName: "Test Org",
      plan: {
        plan_key: "community",
        status: "active",
        source: "none" as const,
        trial_end: null,
        comped_until: null,
        current_period_end: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        trial_used_at: null,
        cards: [],
        group_org_count: 1,
        group_other_orgs: [],
      },
      overrides: [
        { feature_key: "stats.player", bool_value: true, int_value: null, expires_at: SOON, reason: null },
      ],
    });
    // Non-vacuous: the override row is on screen, and not yet lapsed.
    expect(island.text()).toContain("stats.player");
    expect(island.text()).not.toContain("(lapsed)");

    vi.advanceTimersByTime(LATER_MS);

    expect(island.text()).toContain("(lapsed)");
  });

  it("org team: an invite drops off the active list once it expires", async () => {
    net.invites = [
      {
        id: "inv-1",
        org_id: "org-1",
        role: "viewer",
        email: "zq-expiring@example.test",
        token: "tok-1",
        expires_at: SOON,
        max_uses: 1,
        used_count: 0,
        revoked: false,
        created_at: new Date(AT - 60_000).toISOString(),
      },
    ];
    const island = renderIsland(OrgTeam, { orgId: "org-1", role: "owner" as const, currentUserId: "u1" });
    await vi.advanceTimersByTimeAsync(0); // the mount effect's load resolves
    expect(island.text()).toContain("zq-expiring@example.test");

    vi.advanceTimersByTime(LATER_MS);

    expect(island.text()).not.toContain("zq-expiring@example.test");
  });

  it("officiating lane: a declined official loses Accept once the match day has passed", () => {
    const assignment: MyOfficiatingAssignment = {
      fixture_id: "fx1",
      fixture_no: 1,
      fixture_official_id: "fo1",
      official_id: "off1",
      org_name: "Riverside Cup",
      org_slug: "riverside",
      competition_name: "Summer",
      competition_slug: "summer",
      competition_visibility: "public",
      division_name: "U11",
      division_slug: "u11",
      sport_key: "football",
      home_name: "Home FC",
      away_name: "Away FC",
      home_slot_label: null,
      away_slot_label: null,
      org_default_locale: "en",
      scheduled_at: SOON,
      venue_tz: null,
      venue_id: null,
      venue_name: null,
      court_id: null,
      court_name: null,
      fixture_status: "scheduled",
      role_key: "referee",
      response: "declined",
      decline_reason: null,
      responded_at: null,
      report_status: null,
    };
    const lane = renderIsland(OfficiatingLane, {
      isOfficial: true,
      assignments: [assignment],
      completed: [],
      blackouts: [],
      pendingClaims: [],
    });
    // The LANE owns the clock (one interval for every card) and hands `now`
    // down; the card is its own stateful component, driven with the props the
    // lane gives it — re-read after the clock moves, the way React would.
    const cardEl = () => {
      const cards = lane
        .tree()
        .filter((e) => typeof e.type === "function" && e.type.name === "AssignmentCard");
      expect(cards).toHaveLength(1);
      return cards[0]!;
    };
    const Card = cardEl().type as (p: unknown) => ReactNode;
    const card = renderIsland(Card, propsOf(cardEl()));
    const accept = () => card.tree().filter((e) => propsOf(e)["data-testid"] === "me-official-accept");
    expect(accept()).toHaveLength(1);

    vi.advanceTimersByTime(LATER_MS);
    card.rerender(propsOf(cardEl()));

    expect(accept()).toHaveLength(0);
  });

  it("stages panel: the run sheet's NOW moves forward with the clock", () => {
    const island = renderIsland(StagesPanel, {
      divisionId: "d1",
      competitionId: "c1",
      orgSlug: "org",
      compSlug: "comp",
      divSlug: "div",
      stages: [{ id: "s1", seq: 1, kind: "league", name: "Spring League", config: {}, progression: null, status: "active" }],
      fixtures: [],
      entrantNames: {},
      activeEntrantIds: [],
      entrantSeeds: {},
      canEdit: true,
      tz: "UTC",
      orgTz: "UTC",
      canExport: false,
      viewerPlan: "community" as const,
    });
    const nowOnSheet = () => {
      const sheets = island.tree().filter((e) => e.type === RunSheet);
      expect(sheets).toHaveLength(1);
      return propsOf(sheets[0]!).nowMs as number;
    };
    expect(nowOnSheet()).toBe(AT);

    vi.advanceTimersByTime(LATER_MS);

    expect(nowOnSheet()).toBeGreaterThan(Date.parse(SOON));
    expect(nowOnSheet()).toBeLessThanOrEqual(AT + LATER_MS);
  });
});
