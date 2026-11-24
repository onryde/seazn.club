// The competition page once the COMPETITION is finished (owner, Option 1), and once it is ended (completed / archived).
// Drives the real async page the way competition-page-ledger-paging.test.tsx does - the producer (derived competition phase +
// competitions.status) through to the consumer (what renders) - because the rule lives in a server component no unit test reaches:
//   - finished competition: finished divisions listed, no "Show finished" switch, no all-finished card, no Registration entry,
//     no Multi Schedule Board, Open menu + Settings kept, "Add another division" a quiet link (not the primary button);
//   - a LIVE competition keeps the switch, Registration, the board and the primary button;
//   - completed / archived, in BOTH phases: no Add division anywhere (the write answers 409 COMPETITION_ENDED), and - being over - no
//     Registration entry and no Multi Schedule Board either, whatever the derived phase (owner, 2026-11-24), and no "Needs you"
//     attention card (its rows - "Open schedule board" and the rest - ask for work an over competition cannot take).
// Empty case first: a competition with no divisions is not finished.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";

const h = vi.hoisted(() => ({
  divisions: [] as { id: string; name: string; slug: string; sport_key: string; logo_storage_path: null; logo_url: null }[],
  phases: {} as Record<string, string>,
  status: "live",
  canEdit: true,
  frozen: false,
  attention: [] as { kind: string; count: number }[],
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
    visibility: "private", branding: null, status: h.status, created_at: new Date().toISOString(), discoverable: false, discovery: null,
    frozen: h.frozen,
  }),
  openStagesOf: async () => [],
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
          attention: h.attention as never,
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

/** `finished` divisions that are done and `live` that are not, named so the ledger's name sort keeps them apart. */
function seed(finished: number, live: number) {
  const mk = (phase: "scheduled" | "finished", n: number) => ({
    id: `${phase}-${n}`, name: `${phase === "finished" ? "Done" : "Live"} ${n}`, slug: `${phase}-${n}`, sport_key: "badminton",
    logo_storage_path: null as null, logo_url: null as null, phase,
  });
  const all = [
    ...Array.from({ length: live }, (_, i) => mk("scheduled", i + 1)),
    ...Array.from({ length: finished }, (_, i) => mk("finished", i + 1)),
  ];
  h.divisions = all.map((d) => ({ id: d.id, name: d.name, slug: d.slug, sport_key: d.sport_key, logo_storage_path: null, logo_url: null }));
  h.phases = Object.fromEntries(all.map((d) => [d.id, d.phase]));
}

async function render(sp: Record<string, string | string[] | undefined> = {}): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey={null} paidPlan>
      {el}
    </CompetitionPassProvider>,
  );
}
const has = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);
const rows = (html: string) => html.match(/data-testid="desk-ledger-row"/g)?.length ?? 0;
const registrationLinks = (html: string) => html.match(new RegExp(`href="${BASE}/registration"`, "g"))?.length ?? 0;
const addLinks = (html: string) => html.match(new RegExp(`href="${BASE}/d/new"`, "g"))?.length ?? 0;
const ADD_PRIMARY = `+ ${t(en, "action.addDivision")}`;
const ADD_QUIET = t(en, "action.addAnotherDivision");

beforeEach(() => {
  h.status = "live";
  h.canEdit = true;
  h.frozen = false;
  h.attention = [];
  seed(0, 0);
});

describe("empty first: a competition with no divisions is NOT finished", () => {
  it("keeps the Registration entry, the schedule board and a primary add, and prints its own empty state", async () => {
    const html = await render();
    expect(html).toContain(t(en, "card.empty.divisions"));
    expect(has(html, "desk-tool-schedule")).toBe(true);
    expect(registrationLinks(html)).toBe(1);
    expect(html).toContain(ADD_PRIMARY);
    expect(html).not.toContain(ADD_QUIET);
  });
});

describe("a FINISHED competition (every division finished, nothing dated ahead)", () => {
  beforeEach(() => seed(3, 0));

  it("lists the finished divisions by default, with no Show-finished switch and no all-finished card", async () => {
    const html = await render();
    expect(rows(html)).toBe(3);
    expect(html.match(/data-testid="desk-ledger-row" data-phase="finished"/g)?.length).toBe(3);
    expect(has(html, "desk-ledger-finished-toggle")).toBe(false);
    expect(has(html, "desk-ledger-all-finished")).toBe(false);
    expect(html).not.toContain(t(en, "desk.ledger.showFinished", { n: 3 }));
  });

  it("?finished=0 / ?finished=1 change nothing: the URL no longer decides", async () => {
    for (const finished of ["0", "1"]) {
      const html = await render({ finished });
      expect(rows(html), finished).toBe(3);
      expect(has(html, "desk-ledger-finished-toggle"), finished).toBe(false);
    }
  });

  it("hides Registration and the Multi Schedule Board, on desktop and in the phone More fold, and keeps Open + Settings", async () => {
    const html = await render();
    expect(has(html, "desk-tool-schedule")).toBe(false);
    expect(registrationLinks(html)).toBe(0);
    expect(html).not.toContain(`href="${BASE}/schedule"`);
    // What stays (the positive pair of every negative above): the Open menu, Settings (desktop link + More row), the More fold.
    expect(has(html, "desk-open-menu")).toBe(true);
    expect(html.match(new RegExp(`href="${BASE}/settings"`, "g"))?.length).toBe(2);
    expect(has(html, "desk-tools-more")).toBe(true);
  });

  it("demotes Add division to a quiet 'Add another division' link: one link, not the primary button", async () => {
    const html = await render();
    expect(html).not.toContain(ADD_PRIMARY);
    expect(html).toContain(ADD_QUIET);
    expect(addLinks(html)).toBe(1);
    const tag = html.match(/<a [^>]*data-testid="desk-add-division"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain(`href="${BASE}/d/new"`);
    expect(tag).not.toContain("btn-primary");
    expect(html).toContain('data-variant="quiet"');
  });

  it("a mixed finished/live competition is NOT finished: the switch, the board, Registration and the primary button all stay", async () => {
    seed(2, 1);
    const html = await render();
    expect(has(html, "desk-ledger-finished-toggle")).toBe(true);
    expect(rows(html)).toBe(1);
    expect(has(html, "desk-tool-schedule")).toBe(true);
    expect(registrationLinks(html)).toBe(1);
    expect(html).toContain(ADD_PRIMARY);
    expect(html).not.toContain(ADD_QUIET);
  });
});

describe("a LIVE competition keeps today's toggle behaviour", () => {
  it("hides finished by default, offers the switch with its count, and ?finished=1 shows them", async () => {
    seed(2, 6);
    const hidden = await render();
    expect(rows(hidden)).toBe(5);
    expect(hidden).toContain(t(en, "desk.ledger.showFinished", { n: 2 }));
    expect(has(await render({ finished: "1" }), "desk-ledger-finished-toggle")).toBe(true);
  });
});

describe("a completed or archived competition offers no Add division, in both phases", () => {
  it.each(["completed", "archived"])("%s: finished phase - neither the quiet link nor any /d/new link", async (status) => {
    h.status = status;
    seed(3, 0);
    const html = await render();
    expect(rows(html)).toBe(3); // the page rendered in the state under test, not an error shell
    expect(addLinks(html), status).toBe(0);
    expect(html).not.toContain(ADD_QUIET);
    expect(has(html, "desk-add-division")).toBe(false);
    expect(has(html, "desk-tool-schedule"), `${status}: no schedule board`).toBe(false);
    expect(registrationLinks(html), `${status}: no Registration`).toBe(0);
  });

  it.each(["completed", "archived"])("%s: live phase (a division still scheduled) - no primary button either", async (status) => {
    h.status = status;
    seed(1, 2);
    const html = await render();
    expect(rows(html)).toBeGreaterThan(0);
    expect(addLinks(html), status).toBe(0);
    expect(html).not.toContain(ADD_PRIMARY);
    // An ended competition is over whatever its phase says: Registration and the Multi Schedule Board go too (owner, 2026-11-24)...
    expect(has(html, "desk-tool-schedule"), `${status}: no schedule board`).toBe(false);
    expect(html).not.toContain(`href="${BASE}/schedule"`);
    expect(registrationLinks(html), `${status}: no Registration`).toBe(0);
    // ...and the rest of the header stays: the Open menu and Settings.
    expect(has(html, "desk-open-menu"), `${status}: Open stays`).toBe(true);
    expect(html.match(new RegExp(`href="${BASE}/settings"`, "g"))?.length, `${status}: Settings stays`).toBe(2);
  });

  it.each(["completed", "archived"])("%s with no divisions: the empty state's own 'Add a division' CTA is gone too", async (status) => {
    h.status = status;
    seed(0, 0);
    const html = await render();
    expect(html).toContain(t(en, "card.empty.divisions"));
    expect(addLinks(html), status).toBe(0);
    expect(html).not.toContain(t(en, "card.empty.divisions.cta"));
    expect(has(html, "desk-tool-schedule"), `${status}: no schedule board`).toBe(false);
    expect(registrationLinks(html), `${status}: no Registration`).toBe(0);
  });

  it("the positive pair: draft / published / live still offer it (primary on a live phase, quiet on a finished one), with Registration and the board", async () => {
    for (const status of ["draft", "published", "live"]) {
      h.status = status;
      seed(0, 2);
      const live = await render();
      expect(addLinks(live), `${status} live`).toBe(1);
      expect(registrationLinks(live), `${status}: Registration`).toBe(1);
      expect(has(live, "desk-tool-schedule"), `${status}: board`).toBe(true);
      seed(2, 0);
      expect(addLinks(await render()), `${status} finished`).toBe(1);
    }
  });

  it("a view-only member is offered none, finished or not", async () => {
    h.canEdit = false;
    seed(2, 0);
    expect(addLinks(await render())).toBe(0);
    seed(0, 2);
    expect(addLinks(await render())).toBe(0);
  });
});

// The "Needs you" card (desk-needs-you) is for a competition that can still be acted on. Completed / archived: gone, at every width (one DOM -
// there is no phone twin to check separately), whatever the phase. The positive pair is the same desk on a live status.
describe("the Needs-you card on an ended competition", () => {
  const UNSCHEDULED = [{ kind: "unscheduled", count: 2 }];
  const card = (html: string) => has(html, "desk-needs-you");

  it("the positive pair first: a desk with unscheduled fixtures on a draft / published / live competition shows the card, with its rows", async () => {
    let judged = 0;
    for (const status of ["draft", "published", "live"]) {
      h.status = status;
      h.attention = UNSCHEDULED;
      seed(0, 2);
      const html = await render();
      expect(card(html), `${status}: the card shows`).toBe(true);
      expect(html.match(/data-attention="unscheduled"/g)?.length, `${status}: one row per division with the gap`).toBe(2);
      expect(html).toContain(t(en, "desk.needsYou.unscheduled.action"));
      judged++;
    }
    expect(judged).toBe(3);
  });

  it.each(["completed", "archived"])("%s: the card and its rows are gone in the live phase, the finished phase, and with no divisions", async (status) => {
    h.status = status;
    h.attention = UNSCHEDULED;
    let judged = 0;
    for (const [fin, live] of [[0, 2], [2, 0], [1, 2], [0, 0]] as const) {
      seed(fin, live);
      const html = await render();
      expect(has(html, "desk-open-menu"), `${status} ${fin}/${live}: the page rendered, not an error shell`).toBe(true);
      expect(card(html), `${status} ${fin}/${live}`).toBe(false);
      expect(html, `${status} ${fin}/${live}: no row`).not.toContain('data-attention="unscheduled"');
      expect(html, `${status} ${fin}/${live}: no action`).not.toContain(t(en, "desk.needsYou.unscheduled.action"));
      judged++;
    }
    expect(judged).toBe(4);
  });
});
