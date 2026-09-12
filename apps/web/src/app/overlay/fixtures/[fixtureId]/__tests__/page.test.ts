// Task 5d — closing the delay-compensation seam (AGENTS.md failure class 1,
// recurred 6x before this task; ledger 2026-09-09 owner override of Task 1's
// "leave delayMs to R2"). Before this task `type Query = { style?: string;
// lang?: string }` — no caller could ever set a delay at all.
//
// This proves the REAL page — `OverlayPage`, unmocked — resolves `?delay=`
// via `resolveDelayMs` and threads it into the REAL `<OverlayStage>` element
// it returns, i.e. the producer half of the seam. `overlay-stage-delay.test.tsx`
// (components/overlay/__tests__) proves the consumer half: that same prop
// reaching `presentationNowOffsetMs` and the rendered clock. Together they
// prove the seam end to end without either test calling a hook with a
// hand-written prop.
//
// Same mocking shape as the sibling public fixture page's own page.test.ts
// (`(public)/shared/.../fixtures/[fixtureId]/__tests__/page.test.ts`):
// server-only data reads are mocked, everything pure (`resolveTheme`,
// `getDictionary`, `overlayStartLabel`) stays real.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const publicFixtureSlugs = vi.fn();
const getPublicFixture = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  publicFixtureSlugs: (...a: unknown[]) => publicFixtureSlugs(...a),
  getPublicFixture: (...a: unknown[]) => getPublicFixture(...a),
}));

const hasFeature = vi.fn();
vi.mock("@/lib/entitlements", () => ({
  hasFeature: (...a: unknown[]) => hasFeature(...a),
}));

const loadOverlayLiveData = vi.fn();
vi.mock("@/server/overlay/load", () => ({
  loadOverlayLiveData: (...a: unknown[]) => loadOverlayLiveData(...a),
}));

const side = (id: string, name: string, short: string) => ({
  entrantId: id,
  name,
  short,
  colour: null,
  badgeUrl: null,
});

const baseFixtureData = () => ({
  org: { id: "o1", default_locale: "en" },
  competition: { id: "c1", name: "Southend Premier League 2026" },
  division: { sport_key: "football", name: "Open Division" },
  fixture: { id: "f1", home_entrant_id: "home", away_entrant_id: "away", scheduled_at: null },
  entrantNames: { home: "Home XI", away: "Away XI" },
  realtime: false,
  venueTz: "UTC",
  // stages.name — the slate pill's third segment. Distinct from division.name
  // on purpose so a regression that reverts to the division label fails here.
  stageName: "League",
  matchCentre: {
    header: {
      sides: [side("home", "Home XI", "HOM"), side("away", "Away XI", "AWY")],
    },
    cricket: null,
  },
});

const baseInitial: OverlayLiveData = {
  status: "in_play",
  summary: null,
  outcome: null,
  lastSeq: 1,
  venueTz: "UTC",
};

/** Drives the REAL `OverlayPage` default export with a given raw `?delay=`
 *  value (or `undefined` for the param being absent entirely) and returns
 *  the `<OverlayStage>` element it produces — the page's own top-level
 *  return, so `.props` is exactly what a real request would hand the stage. */
async function renderPage(delay: string | undefined): Promise<ReactElement> {
  publicFixtureSlugs.mockResolvedValue({ orgSlug: "test-org", compSlug: "test-comp", divSlug: "open" });
  getPublicFixture.mockResolvedValue(baseFixtureData());
  hasFeature.mockResolvedValue(true);
  loadOverlayLiveData.mockResolvedValue(baseInitial);
  const { default: OverlayPage } = await import("../page");
  const query = delay === undefined ? {} : { delay };
  return OverlayPage({
    params: Promise.resolve({ fixtureId: "f1" }),
    searchParams: Promise.resolve(query),
  }) as unknown as ReactElement;
}

function delayMsPropOf(el: ReactElement): unknown {
  return (el.props as { delayMs?: unknown }).delayMs;
}

function slateMetaPropOf(el: ReactElement): { competition?: string; stage?: string } | null | undefined {
  return (el.props as { slateMeta?: { competition?: string; stage?: string } | null }).slateMeta;
}

describe("OverlayPage — ?delay= resolves server-side and reaches <OverlayStage>'s delayMs prop (Task 5d)", () => {
  it("absent ?delay= resolves to 0 — the pre-Task-5d behaviour, unchanged", async () => {
    const el = await renderPage(undefined);
    expect(delayMsPropOf(el)).toBe(0);
  });

  it("a valid ?delay=5000 reaches the prop as 5000 — the seam is no longer inert", async () => {
    const el = await renderPage("5000");
    expect(delayMsPropOf(el)).toBe(5000);
  });

  it("junk ?delay=banana falls back to 0 and the page still renders (never throws, never 404s)", async () => {
    const el = await renderPage("banana");
    expect(delayMsPropOf(el)).toBe(0);
  });

  it("an absurd ?delay=99999999 falls back to 0, not the raw out-of-range value", async () => {
    const el = await renderPage("99999999");
    expect(delayMsPropOf(el)).toBe(0);
  });
});

describe("OverlayPage — slateMeta uses stages.name, not division.name", () => {
  it("threads competition.name + stageName onto slateMeta.stage", async () => {
    const el = await renderPage(undefined);
    expect(slateMetaPropOf(el)).toEqual({
      competition: "Southend Premier League 2026",
      stage: "League",
    });
  });

  it("omits stage when stageName is null — never falls back to division.name", async () => {
    publicFixtureSlugs.mockResolvedValue({ orgSlug: "test-org", compSlug: "test-comp", divSlug: "open" });
    getPublicFixture.mockResolvedValue({ ...baseFixtureData(), stageName: null });
    hasFeature.mockResolvedValue(true);
    loadOverlayLiveData.mockResolvedValue(baseInitial);
    const { default: OverlayPage } = await import("../page");
    const el = (await OverlayPage({
      params: Promise.resolve({ fixtureId: "f1" }),
      searchParams: Promise.resolve({}),
    })) as unknown as ReactElement;
    expect(slateMetaPropOf(el)).toEqual({
      competition: "Southend Premier League 2026",
    });
    expect(slateMetaPropOf(el)?.stage).toBeUndefined();
  });
});
