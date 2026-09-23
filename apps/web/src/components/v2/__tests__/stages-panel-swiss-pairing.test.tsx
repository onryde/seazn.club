import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { StagesPanel } from "@/components/v2/stages-panel";
import { StageRail } from "@/components/v2/desk/stage-rail";
import { ApiV1Error } from "@/lib/client-v1";
import { SWISS_PAIRING_ROUND_ONE_ONLY_CODE } from "@/lib/swiss-pairing";

const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// Swiss round-1 pairing (spec 2026-09-22-swiss-round-one-pairing, "UI"): the
// PANEL is what decides whether the rail gets a menu at all. `stage-rail.test`
// pins the rail given a menu, and `swiss-pairing-menu.test` pins the
// derivation; this file pins the seam between them — that StagesPanel really
// computes the menu from its own stage/fixtures and hands it down (an inert
// seam passes both of those other files).
//
// Markup only (vitest is node): the OPEN menu is not reachable from here.

const swissStage = (config: Record<string, unknown> = { rounds: 2 }, status = "active") => ({
  id: "s1",
  seq: 1,
  kind: "swiss",
  name: "Swiss",
  config,
  progression: null,
  status,
});

/** Two rounds of four boards for an 8-entrant field; `seated` rounds carry
 *  both seats, the rest are the empty shells a first Generate mints. */
const fixtures = (seatedRounds: number[] = []) =>
  Array.from({ length: 8 }, (_, i) => {
    const round = Math.floor(i / 4) + 1;
    const seated = seatedRounds.includes(round);
    return {
      id: `f${i + 1}`,
      stage_id: "s1",
      pool_id: null,
      round_no: round,
      seq_in_round: (i % 4) + 1,
      fixture_no: i + 1,
      home_entrant_id: seated ? `e${(i % 4) + 1}` : null,
      away_entrant_id: seated ? `e${(i % 4) + 5}` : null,
      scheduled_at: null,
      venue: null,
      court_label: null,
      court_id: null,
      court_name: null,
      status: "scheduled",
      outcome: null,
      ext_key: `sw-r${round}-b${(i % 4) + 1}`,
    };
  });

const ids = Array.from({ length: 8 }, (_, i) => `e${i + 1}`);
const props = {
  divisionId: "d1",
  competitionId: "c1",
  orgSlug: "org",
  compSlug: "comp",
  divSlug: "div",
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
  entrantNames: Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
  activeEntrantIds: ids,
  entrantSeeds: Object.fromEntries(ids.map((id, i) => [id, i + 1])),
  canEdit: true,
};

const TOGGLE = 'data-testid="stage-pairing-toggle"';

describe("StagesPanel — hands the Pair next split button its menu", () => {
  it("a Swiss stage with round 1 waiting gets the toggle, beside Pair next", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures()} />,
    );
    expect(html).toContain(">Pair next round</button>");
    expect(html).toContain(TOGGLE);
    expect(html).toContain('aria-controls="pairing-menu-s1"');
  });

  it("round 2 waiting still gets it (the menu opens read-only there)", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1])} />,
    );
    expect(html).toContain(">Pair next round</button>");
    expect(html).toContain(TOGGLE);
  });

  // Review ruling R3 — no round waiting ⇒ no menu. Positive pair first: the
  // rail must still be rendering its buttons, or the absence proves nothing.
  it("every round seated ⇒ no toggle", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} stages={[swissStage()]} fixtures={fixtures([1, 2])} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).not.toContain(TOGGLE);
  });

  it("no shells yet (first Generate) ⇒ no toggle — the server refuses a pick there", () => {
    const html = renderToStaticMarkup(<StagesPanel {...props} stages={[swissStage()]} fixtures={[]} />);
    expect(html).toContain(">Generate fixtures</button>");
    expect(html).not.toContain(TOGGLE);
  });

  it("a non-Swiss stage never gets one, even with unseated rows", () => {
    const league = { ...swissStage(), kind: "league", name: "League" };
    const html = renderToStaticMarkup(<StagesPanel {...props} stages={[league]} fixtures={fixtures()} />);
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).not.toContain(TOGGLE);
  });

  it("a viewer who cannot edit sees no rail, so no toggle", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...props} canEdit={false} stages={[swissStage()]} fixtures={fixtures()} />,
    );
    expect(html).not.toContain('data-testid="stage-generate"');
    expect(html).not.toContain(TOGGLE);
  });
});

// Review M2 (Task 4): the rail clears the organiser's round-1 pick only when a
// press LANDS, and it learns that from what `onAct` resolves to. This pins the
// panel's half of that contract through the real `act()`: the StageRail
// element's own `onAct` (the one production hands down), with only the
// network mocked. A panel that went back to `void act(...)`, or an `act()` that
// reported a refused press as landed, would hand the rail a lie — the pick
// would vanish on a failure, or survive a success into the next press.
describe("StagesPanel — tells the rail whether a press landed (review M2)", () => {
  type OnAct = (stageId: string, action: "generate", opts?: { pairing?: "fold" | "rank_adjacent" }) => Promise<boolean>;

  function railOnAct(): OnAct {
    const island = renderIsland(StagesPanel, { ...props, stages: [swissStage()], fixtures: fixtures() });
    const rails = island.tree().filter((el) => el.type === StageRail);
    expect(rails).toHaveLength(1);
    return propsOf(rails[0]!).onAct as OnAct;
  }

  function generateAnswers(answer: () => Promise<unknown>) {
    apiV1Mock.mockReset();
    apiV1Mock.mockImplementation((path: string) =>
      path.endsWith("/generate") ? answer() : Promise.resolve({}),
    );
  }

  const generateBodies = () =>
    apiV1Mock.mock.calls
      .filter(([path]) => String(path).endsWith("/generate"))
      .map(([, init]) => (init as { json?: unknown }).json);

  it("resolves true when generate lands — and sent the pick it was given", async () => {
    generateAnswers(() => Promise.resolve({ created: 4, existing: 4 }));
    await expect(railOnAct()("s1", "generate", { pairing: "rank_adjacent" })).resolves.toBe(true);
    expect(generateBodies()).toEqual([{ pairing: "rank_adjacent" }]);
  });

  it.each([
    ["a refused pick (422)", () => new ApiV1Error("wire", 422, SWISS_PAIRING_ROUND_ONE_ONLY_CODE, {})],
    ["a server error (500)", () => new ApiV1Error("boom", 500, "INTERNAL", {})],
    ["a paywall (402)", () => new ApiV1Error("pay", 402, "PAYMENT_REQUIRED", { feature_key: "x" })],
    ["a dropped connection", () => new TypeError("Failed to fetch")],
  ])("resolves false when generate does not land: %s", async (_label, failure) => {
    generateAnswers(() => Promise.reject(failure()));
    await expect(railOnAct()("s1", "generate", { pairing: "rank_adjacent" })).resolves.toBe(false);
    expect(generateBodies()).toEqual([{ pairing: "rank_adjacent" }]);
  });
});
