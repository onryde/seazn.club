// Match Day task F1 (owner ruling 10-31 (1)): the page hands the shell the BILLING freeze — the competition page's own fact,
// `getCompetition(…).frozen` — so a frozen competition's Match Day offers no Call and no Undo call and says why. The shell's half
// (the fact reaching every panel) is match-day-ssr.test.tsx's "F1"; the server's refusal is match-day-call.test.ts's. This is the
// seam between them: the page itself is rendered (an async server component, called directly), its reads mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MatchDayView } from "@/lib/match-day/types";

const h = vi.hoisted(() => ({ frozen: false as boolean | undefined, canEdit: true, needs: [] as MatchDayView["needs_you"] }));

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
    needs_you: h.needs,
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
import { needsYouItems } from "@/components/v2/desk/needs-you";
import { MatchDayShell } from "@/components/v2/match-day/match-day-shell";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";
import type { Attention } from "@/lib/division-phase";

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

// Task G5 (final review): a viewer's Match Day page carries no Needs-you rows. The shell already draws none for a view-only reader
// (`needsYou = readOnly ? [] : view.needs_you`), so the markup alone cannot tell the two apart - the rows are in the PAYLOAD, the
// `initial` prop the page hands the client island, which serialises into the HTML of the response. The competition page strips
// them the same way (`desk && canEdit ? needsYouItems(...) : []`). The rows are the desk's own, built by `needsYouItems`.
describe("G5 — a viewer's Match Day payload has no Needs-you rows", () => {
  const ATTENTION: Attention[] = [
    { kind: "no_scorer", count: 1, fixtureIds: ["f-ns"], minutesSinceKickoff: 12 },
    { kind: "unscheduled", count: 2 },
  ];
  const rows = (): MatchDayView["needs_you"] => {
    const desk = {
      divisions: new Map([["d-u14", { attention: ATTENTION, fixture_names: { "f-ns": { home: "Zara Khan", away: "Ella Brooks", fixture_no: 7 } } }]]),
    } as unknown as CompetitionDesk;
    return needsYouItems(en as Dict, desk, [{ id: "d-u14", name: "Girls U14", slug: "girls-u14" }], "riverside", "summer-league", "en");
  };
  /** The element the page returns, and the shell element inside it (its props are what crosses to the client). */
  const shellOf = async () => {
    const tree = (await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) })) as {
      props: { children: { type: unknown; props: { initial: MatchDayView } } };
    };
    const shell = tree.props.children;
    expect(shell.type).toBe(MatchDayShell);
    return shell;
  };
  /** Text only a Needs-you row carries (its division name), read off the rows themselves rather than typed here. */
  const marker = (r: MatchDayView["needs_you"]) => r[0]!.title;

  beforeEach(() => {
    h.frozen = false;
    h.canEdit = true;
    h.needs = [];
  });

  it("EMPTY CASE FIRST: an organiser's payload keeps the desk's rows, and its page draws the button (so a strip that always empties cannot pass)", async () => {
    h.needs = rows();
    expect(h.needs.length).toBeGreaterThan(0);
    const shell = await shellOf();
    expect(shell.props.initial.needs_you).toEqual(h.needs);
    expect(JSON.stringify(shell.props)).toContain(marker(h.needs));
    expect(await render()).toContain('data-testid="md-needs-you-toggle"');
  });

  it("a viewer: no rows in the payload (none in what serialises to the client either), no button in the page", async () => {
    h.canEdit = false;
    h.needs = rows();
    const rowCount = h.needs.length;
    expect(rowCount).toBeGreaterThan(0);
    const shell = await shellOf();
    expect(shell.props.initial.needs_you).toEqual([]);
    expect(JSON.stringify(shell.props)).not.toContain(marker(h.needs));
    expect(JSON.stringify(shell.props)).not.toContain("needs_you\":[{");
    const html = await render();
    expect(html).not.toContain('data-testid="md-needs-you-toggle"');
    expect(html).toContain('data-testid="md-read-only"');
    // The rest of the view is untouched: only the rows are withheld.
    expect(shell.props.initial.competition_id).toBe("comp-1");
  });
});
