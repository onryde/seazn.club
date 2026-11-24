// The Multi Schedule Board's empty state ("no divisions yet, add one") offered "Add a division" to anyone who could edit an
// unfrozen competition - including a COMPLETED or ARCHIVED one, where the write answers 409 COMPETITION_ENDED. It reads the same rule as
// the competition page's header and /d/new (`deskChrome`, i.e. `competitionIsEnded`), so the link is never a form that can only fail.
// Drives the real async page. Empty case first: with no divisions the page is this empty state; the positive pair is the live case.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ status: "live", canEdit: true, frozen: false }));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1", userId: "user-1", role: "owner" },
    canEdit: h.canEdit,
    org: { id: "org-1", slug: "riverside", name: "Riverside CC", role: "owner", timezone: "Europe/London" },
    competition: { id: "comp-1", slug: "summer-league" },
  }),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({ id: "comp-1", name: "Summer League", status: h.status, frozen: h.frozen, starts_on: null, ends_on: null }),
}));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions: async () => [] }));
vi.mock("@/server/usecases/stages", () => ({ listStages: async () => [] }));
vi.mock("@/server/usecases/fixtures", () => ({ listDivisionFixturesForBoard: async () => [] }));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: async () => [] }));
vi.mock("@/server/usecases/schedule", () => ({ getScheduleSettings: async () => ({ config: { courts: [] }, tz: "Europe/London" }) }));
vi.mock("@/server/usecases/venues", () => ({ listVenues: async () => [] }));
vi.mock("@/server/usecases/scorer-sheets", () => ({ listSheetDays: async () => [] }));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  hasFeature: async () => true,
  orgPlanKey: async () => "pro",
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/db", () => ({ withTenant: async (_org: string, fn: (tx: unknown) => unknown) => fn(async () => []) }));

import Page from "../page";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";

const NEW_DIVISION = `href="/o/riverside/c/summer-league/d/new"`;

async function render(): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  h.status = "live";
  h.canEdit = true;
  h.frozen = false;
});

describe("the board's empty state offers 'Add a division' only where a division can be added", () => {
  it("the positive pair: an editor of a live, unfrozen competition gets the link (and the empty-state sentence)", async () => {
    const html = await render();
    expect(html).toContain(t(en, "comp.schedule.empty"));
    expect(html).toContain(NEW_DIVISION);
    expect(html).toContain(t(en, "card.empty.divisions.cta"));
  });

  it.each(["draft", "published"])("%s still offers it", async (status) => {
    h.status = status;
    expect(await render()).toContain(NEW_DIVISION);
  });

  it.each(["completed", "archived"])("%s: the empty-state sentence stays, the link to a form that can only 409 is gone", async (status) => {
    h.status = status;
    const html = await render();
    expect(html, "rendered in the state under test").toContain(t(en, "comp.schedule.empty"));
    expect(html).not.toContain(NEW_DIVISION);
    expect(html).not.toContain(t(en, "card.empty.divisions.cta"));
  });

  it("a view-only member and a frozen competition are offered none (unchanged)", async () => {
    h.canEdit = false;
    expect(await render()).not.toContain(NEW_DIVISION);
    h.canEdit = true;
    h.frozen = true;
    expect(await render()).not.toContain(NEW_DIVISION);
  });
});
