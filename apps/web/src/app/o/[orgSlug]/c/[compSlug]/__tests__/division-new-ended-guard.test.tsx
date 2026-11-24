// /d/new on a completed or archived competition (owner, 2026-11-24): the create wizard used to render and then 409 on submit
// (COMPETITION_ENDED). The page now refuses up front - a redirect to the competition page, like a view-only member - judged by the
// SAME predicate the write uses (`competitionIsEnded`). The live case is the positive pair: the wizard still renders.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ status: "live", canEdit: true, builderRendered: 0 }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: h.canEdit,
  }),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({ id: "comp-1", name: "Summer League", status: h.status, starts_on: null, ends_on: null }),
}));
vi.mock("@/server/engine-db", () => ({ resolveModule: () => ({}) }));
vi.mock("@/server/usecases/external-play", () => ({ onlineChessOffered: async () => false }));
vi.mock("@/server/external-play/camera-policy", () => ({ competitionCameraPolicy: async () => "off" }));
vi.mock("@/server/usecases/format-gates", () => ({ templateLocksForOrg: async () => ({}) }));
vi.mock("@/server/usecases/division-slots", () => ({ archivedSlotsExplainRefusal: async () => false }));
vi.mock("@/server/usecases/venues", () => ({ listVenues: async () => [] }));
vi.mock("@/server/usecases/divisions", () => ({ recentDivisionSports: async () => [] }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/db", () => ({
  withTenant: async (_org: string, fn: (tx: unknown) => unknown) => fn(async () => []),
}));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: async () => false,
  orgPlanKey: async () => "community",
}));
vi.mock("@/components/v2/division-builder", () => ({
  DivisionBuilder: () => {
    h.builderRendered++;
    return null;
  },
}));

import Page from "../d/new/page";

const params = Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" });
const COMP_URL = "/o/riverside/c/summer-league";

async function run(): Promise<string> {
  try {
    const el = await Page({ params });
    // Render the returned tree once so a DivisionBuilder child is actually reached.
    const { renderToStaticMarkup } = await import("react-dom/server");
    renderToStaticMarkup(el);
    return "RENDERED";
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  h.status = "live";
  h.canEdit = true;
  h.builderRendered = 0;
});

describe("/d/new refuses an ended competition up front", () => {
  it.each(["completed", "archived"])("%s: redirects to the competition page and never renders the wizard", async (status) => {
    h.status = status;
    expect(await run()).toBe(`REDIRECT:${COMP_URL}`);
    expect(h.builderRendered).toBe(0);
  });

  it.each(["draft", "published", "live"])("%s: the wizard renders (the positive pair)", async (status) => {
    h.status = status;
    expect(await run()).toBe("RENDERED");
    expect(h.builderRendered).toBe(1);
  });

  it("a view-only member is still redirected, whatever the status", async () => {
    h.canEdit = false;
    expect(await run()).toBe(`REDIRECT:${COMP_URL}`);
    expect(h.builderRendered).toBe(0);
  });
});
