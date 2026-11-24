// Online Chess credits, Step 1b (spec 2026-11-23-online-chess-credits-design.md §8.8; plan Task 12): the competition page flags an online division
// that still owes its package, FOR THE ORGANISER ONLY and only while the club is offered Online Chess. The ledger's own rendering is pinned in
// desk-ssr and division-ledger-unpaid-flag; THIS drives the real async page so the seam is proven through its producer (the unpaid read, the flag,
// the role) and its consumer (the ledger) - a page that forgot to hand `onlineUnpaid` over, or flagged for a viewer, would pass the ledger suites.
// Same scaffold as competition-page-ledger-paging.test.tsx beside it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

const h = vi.hoisted(() => ({
  divisions: [] as { id: string; name: string; slug: string; sport_key: string; logo_storage_path: null; logo_url: null }[],
  phases: {} as Record<string, string>,
  canEdit: true,
  offered: true,
  unpaid: new Set<string>(),
  listCalls: [] as { orgId: string; competitionId: string }[],
  listThrows: false,
  offeredCalls: 0,
  deskFails: false,
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
  getCompetition: async () => ({
    id: "comp-1", org_id: "org-1", name: "Summer League", slug: "summer-league", description: null, starts_on: null, ends_on: null,
    visibility: "private", branding: null, status: "live", created_at: new Date().toISOString(), discoverable: false, discovery: null,
    frozen: false,
  }),
}));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions: async () => h.divisions }));
vi.mock("@/server/usecases/card-stats", () => ({ listDivisionCardStats: async () => new Map(), formatLabel: () => "League" }));
vi.mock("@/server/usecases/competition-desk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/competition-desk")>()),
  getCompetitionDesk: async (): Promise<CompetitionDesk> => {
    if (h.deskFails) throw new Error("desk down");
    return {
      in_play: 0,
      in_play_fixtures: [],
      up_next: null,
      fixtures_today: 0,
      now: "2026-11-07T12:00:00.000Z",
      divisions: new Map(
        h.divisions.map((d) => [
          d.id,
          {
            phase: h.phases[d.id] as "scheduled" | "finished",
            attention: [],
            played: 1, total: 1, unscheduled: 0, in_play: 0, entrants: 4, next: null, needs_draw_stage: null,
            fixture_names: {}, display_tz: "UTC",
          },
        ]),
      ),
    };
  },
}));
vi.mock("@/server/public-site/data", () => ({ resolveLogoUrl: () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([{ trial_used_at: null }]);
  },
}));
vi.mock("@/lib/billing", () => ({ checkoutTrialDays: () => 14 }));
vi.mock("@/server/usecases/external-play/online-chess-flag", () => ({
  onlineChessOffered: async () => {
    h.offeredCalls += 1;
    return h.offered;
  },
}));
vi.mock("@/server/usecases/online-package", () => ({
  listUnpaidOnlineDivisions: async (a: { orgId: string; competitionId: string }) => {
    h.listCalls.push(a);
    if (h.listThrows) throw new Error("boom");
    return h.unpaid;
  },
}));
vi.mock("@/server/logger", () => ({ log: { error: () => undefined, warn: () => undefined, info: () => undefined } }));

import Page from "../page";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import en from "@/dictionaries/en/ui.json";
import { t } from "@/lib/i18n-runtime";

const FLAG = 'data-testid="online-unpaid-flag"';

/** Three divisions: two chess (ids c-owes, c-paid) and one badminton (b-1) that the unpaid set also names, to prove sport is not the page's guess. */
function seed() {
  const mk = (id: string, name: string, sport: string) => ({ id, name, slug: id, sport_key: sport, logo_storage_path: null as null, logo_url: null as null });
  h.divisions = [mk("c-owes", "Chess Owes", "boardgame"), mk("c-paid", "Chess Paid", "boardgame"), mk("b-1", "Badminton", "badminton")];
  h.phases = Object.fromEntries(h.divisions.map((d) => [d.id, "scheduled"]));
}
async function render(): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey={null} paidPlan>
      {el}
    </CompetitionPassProvider>,
  );
}
/** The markup of one row, found by the division's link. */
const rowOf = (html: string, slug: string): string =>
  html.split('data-testid="desk-ledger-row"').slice(1).find((r) => r.includes(`/d/${slug}"`)) ?? "";

beforeEach(() => {
  seed();
  h.canEdit = true;
  h.offered = true;
  h.unpaid = new Set(["c-owes"]);
  h.listCalls.length = 0;
  h.listThrows = false;
  h.offeredCalls = 0;
  h.deskFails = false;
});

describe("the competition page's Online Chess 'Not paid' flag (Step 1b)", () => {
  it("an organiser of an offered club sees the flag on the row that owes, and only that row; the read names this org and this competition", async () => {
    const html = await render();
    expect(rowOf(html, "c-owes"), "premise: the row is on the page").toContain("Chess Owes");
    expect(rowOf(html, "c-owes")).toContain(FLAG);
    expect(rowOf(html, "c-paid")).not.toContain(FLAG);
    expect(rowOf(html, "c-paid"), "premise: the paid row is on the page").toContain("Chess Paid");
    expect(html).toContain(t(en, "onlineChess.flag.text"));
    expect(h.listCalls).toEqual([{ orgId: "org-1", competitionId: "comp-1" }]);
  });

  it("a view-only member never sees it, and the page does not even ask (hidden by role, not by CSS)", async () => {
    h.canEdit = false;
    const html = await render();
    expect(html).not.toContain(FLAG);
    expect(h.listCalls).toEqual([]);
    expect(h.offeredCalls).toBe(0);
  });

  it("a club not offered Online Chess (the flag off) sees none, and the unpaid read is never made", async () => {
    h.offered = false;
    const html = await render();
    expect(html).not.toContain(FLAG);
    expect(h.offeredCalls, "premise: the flag WAS asked").toBe(1);
    expect(h.listCalls).toEqual([]);
  });

  it("a division that is not a chess division is never flagged, whatever the set says (the pair: the chess row beside it is)", async () => {
    h.unpaid = new Set(["c-owes", "b-1"]);
    const html = await render();
    expect(rowOf(html, "b-1"), "premise: the badminton row is on the page").toContain("Badminton");
    expect(rowOf(html, "b-1")).not.toContain(FLAG);
    expect(rowOf(html, "c-owes")).toContain(FLAG);
  });

  it("a competition with no chess division asks neither the flag nor the read (nothing to flag)", async () => {
    h.divisions = h.divisions.filter((d) => d.sport_key !== "boardgame");
    await render();
    expect(h.offeredCalls).toBe(0);
    expect(h.listCalls).toEqual([]);
  });

  it("nothing owed: no flag on any row (the empty set)", async () => {
    h.unpaid = new Set();
    const html = await render();
    expect(html).not.toContain(FLAG);
    expect(h.listCalls).toHaveLength(1);
  });

  it("a competition desk that failed to load still flags the unpaid row (the row is built without a desk and keeps the flag)", async () => {
    h.deskFails = true;
    const html = await render();
    expect(rowOf(html, "c-owes"), "premise: the row is on the page, without its desk").toContain("Chess Owes");
    expect(rowOf(html, "c-owes")).toContain(FLAG);
    expect(rowOf(html, "c-paid")).not.toContain(FLAG);
  });

  it("a read that throws never blanks the page: the list renders, without flags", async () => {
    h.listThrows = true;
    const html = await render();
    expect(html).not.toContain(FLAG);
    expect(rowOf(html, "c-owes")).toContain("Chess Owes");
  });
});
