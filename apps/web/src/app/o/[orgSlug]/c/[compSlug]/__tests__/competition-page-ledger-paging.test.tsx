// Match Day B2 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §9, owner request): the divisions list shows five at a
// time and hides finished divisions until asked, the page and the switch living in the URL (`?dpage=`, `?finished=1`). The ledger's
// own paging is pinned in desk-ssr.test.tsx; THIS drives the real page - an async server component, called directly with the
// `searchParams` Next hands it - so the seam is proven through its producer (the URL) and its consumer (the ledger), not by a
// fixture on both ends: a page that forgot to read the query would render every division on every URL and pass the ledger suite.
// Same scaffold as competition-page-match-day.test.tsx beside it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

const h = vi.hoisted(() => ({
  divisions: [] as { id: string; name: string; slug: string; sport_key: string; logo_storage_path: null; logo_url: null }[],
  phases: {} as Record<string, string>,
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: true,
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
  getCompetitionDesk: async (): Promise<CompetitionDesk> => ({
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
  }),
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

import Page from "../page";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";

const BASE = "/o/riverside/c/summer-league";
const LIVE = 6;
const DONE = 2;

/** LIVE divisions that are not finished and DONE that are, named so the ledger's name sort keeps them apart: "Live 1..", "Zed 1..". */
function seed(live = LIVE, done = DONE) {
  const mk = (name: string, phase: "scheduled" | "finished", n: number) => ({
    division: {
      id: `${phase}-${n}`, name: `${name} ${n}`, slug: `${name.toLowerCase()}-${n}`, sport_key: "badminton",
      logo_storage_path: null as null, logo_url: null as null,
    },
    phase,
  });
  const all = [
    ...Array.from({ length: live }, (_, i) => mk("Live", "scheduled", i + 1)),
    ...Array.from({ length: done }, (_, i) => mk("Zed", "finished", i + 1)),
  ];
  h.divisions = all.map((d) => d.division);
  h.phases = Object.fromEntries(all.map((d) => [d.division.id, d.phase]));
}

async function render(sp: Record<string, string | string[] | undefined> = {}): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey={null} paidPlan>
      {el}
    </CompetitionPassProvider>,
  );
}
const rows = (html: string) => html.match(/data-testid="desk-ledger-row"/g)?.length ?? 0;
const finishedRows = (html: string) => html.match(/data-testid="desk-ledger-row" data-phase="finished"/g)?.length ?? 0;
const hrefOf = (html: string, testId: string) => {
  const m = html.match(new RegExp(`<a [^>]*href="([^"]*)"[^>]*data-testid="${testId}"|<a [^>]*data-testid="${testId}"[^>]*href="([^"]*)"`));
  return m ? (m[1] ?? m[2]) : null;
};

beforeEach(() => seed());

describe("the competition page's divisions list reads its page and filter from the URL (B2)", () => {
  // The empty case first: a competition with no divisions keeps its own empty state - no ledger, no pager, no toggle.
  it("no divisions: the page's empty state, not an empty ledger", async () => {
    seed(0, 0);
    const html = await render();
    expect(html).toContain(t(en, "card.empty.divisions"));
    for (const id of ["desk-ledger", "desk-ledger-pager", "desk-ledger-finished-toggle"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });

  it("the bare URL: the first five that are not finished, a pager of two, a toggle counting the finished", async () => {
    const html = await render();
    expect(rows(html)).toBe(5);
    expect(finishedRows(html)).toBe(0);
    expect(html).toContain('data-pages="2"');
    expect(html).toContain('data-page="1"');
    expect(html).toContain(t(en, "desk.ledger.showFinished", { n: DONE }));
    expect(hrefOf(html, "desk-ledger-next")).toBe(`${BASE}?dpage=2`);
    // The heading still counts every division - the toggle is what explains the difference.
    expect(html).toContain(`${t(en, "comp.detail.divisions")} · ${LIVE + DONE}`);
  });

  it("?dpage=2 is the second page; ?dpage=99 and nonsense are the last and the first", async () => {
    const second = await render({ dpage: "2" });
    expect(rows(second)).toBe(LIVE - 5);
    expect(second).toContain('data-page="2"');
    expect(hrefOf(second, "desk-ledger-prev")).toBe(BASE);
    expect(rows(await render({ dpage: "99" }))).toBe(LIVE - 5);
    for (const dpage of ["abc", "0", "-1"]) {
      expect(rows(await render({ dpage })), dpage).toBe(5);
    }
  });

  it("?finished=1 shows them: eight rows over two pages, the finished ones last, and the toggle says Hide", async () => {
    const first = await render({ finished: "1" });
    expect(rows(first)).toBe(5);
    expect(first).toContain(t(en, "desk.ledger.hideFinished", { n: DONE }));
    expect(hrefOf(first, "desk-ledger-finished-toggle")).toBe(BASE);
    const second = await render({ finished: "1", dpage: "2" });
    expect(rows(second)).toBe(LIVE + DONE - 5);
    expect(finishedRows(second)).toBe(DONE);
    // ...and paging from here keeps the filter.
    expect(hrefOf(first, "desk-ledger-next")).toBe(`${BASE}?dpage=2&amp;finished=1`);
  });

  it("any other query param is carried through the pager and the toggle", async () => {
    const html = await render({ upgraded: "1", finished: "1" });
    expect(hrefOf(html, "desk-ledger-next")).toBe(`${BASE}?upgraded=1&amp;dpage=2&amp;finished=1`);
    expect(hrefOf(html, "desk-ledger-finished-toggle")).toBe(`${BASE}?upgraded=1`);
  });

  it("every division finished: hidden by default with the way out, shown on ?finished=1", async () => {
    seed(0, 3);
    const hidden = await render();
    expect(rows(hidden)).toBe(0);
    expect(hidden).toContain('data-testid="desk-ledger-all-finished"');
    expect(hrefOf(hidden, "desk-ledger-finished-toggle")).toBe(`${BASE}?finished=1`);
    const shown = await render({ finished: "1" });
    expect(rows(shown)).toBe(3);
    expect(finishedRows(shown)).toBe(3);
  });
});
