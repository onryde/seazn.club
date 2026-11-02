// Match Day task F1 (owner ruling 10-31 (1)): the page hands the shell the BILLING freeze — the competition page's own fact,
// `getCompetition(…).frozen` — so a frozen competition's Match Day offers no Call and no Undo call and says why. The shell's half
// (the fact reaching every panel) is match-day-ssr.test.tsx's "F1"; the server's refusal is match-day-call.test.ts's. This is the
// seam between them: the page itself is rendered (an async server component, called directly), its reads mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MatchDayView } from "@/lib/match-day/types";

const h = vi.hoisted(() => ({ frozen: false as boolean | undefined, canEdit: true }));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: h.canEdit,
  }),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({ id: "comp-1", name: "Summer League", slug: "summer-league", frozen: h.frozen }),
}));
vi.mock("@/server/usecases/match-day", () => ({
  getMatchDay: async (): Promise<MatchDayView> => ({
    competition_id: "comp-1",
    date: "2026-11-07",
    tz: "Europe/London",
    now: "2026-11-07T11:00:00.000Z",
    courts: [],
    playing_no_court: [],
    needs_you: [],
    results_owed: 0,
    fixtures_today: 0,
    venues_today: [],
  }),
}));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions: async () => [] }));
vi.mock("@/lib/entitlements", () => ({ orgPlanKey: async () => "community" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

import Page from "../page";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";

const render = async () =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) }),
  );

describe("F1 — the Match Day page hands the shell the competition's billing freeze", () => {
  beforeEach(() => {
    h.frozen = false;
    h.canEdit = true;
  });

  it("EMPTY CASE FIRST: not frozen (false, or a row that never says) — no frozen line", async () => {
    expect(await render()).not.toContain('data-testid="md-frozen"');
    h.frozen = undefined;
    expect(await render()).not.toContain('data-testid="md-frozen"');
  });

  it("frozen: the page says why, in the reader's words", async () => {
    h.frozen = true;
    const html = await render();
    expect(html).toContain('data-testid="md-frozen"');
    expect(html).toContain(t(en as Dict, "matchDay.frozen").replace(/'/g, "&#x27;"));
  });
});
