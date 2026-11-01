// Match Day B1 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §9): the competition page stops duplicating live
// state. On a match day — the competition has a match today (`CompetitionDesk.fixtures_today`, A2's `countFixturesToday`) — the
// page shows Open Match Day in its header and replaces the Needs-you list with ONE line into Match Day; before the day the list
// stays here. The live strip (`InPlayBand`) and the ledger's "Now:" cell are gone on every day.
//
// The page itself is rendered (an async server component, called directly, like competition-header-trial-promise.test.tsx),
// with its reads mocked and the desk handed in: the page's own decisions are what is under test. The desk's count is pinned
// against a real database in competition-desk.test.ts ("B1: fixtures_today").
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attention, DivisionPhase } from "@/lib/division-phase";
import type { CompetitionDesk, DeskNextFixture } from "@/server/usecases/competition-desk";

const h = vi.hoisted(() => ({ desk: null as CompetitionDesk | null, canEdit: true }));

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
    id: "comp-1",
    org_id: "org-1",
    name: "Summer League",
    slug: "summer-league",
    description: null,
    starts_on: null,
    ends_on: null,
    visibility: "private",
    branding: null,
    status: "live",
    created_at: new Date().toISOString(),
    discoverable: false,
    discovery: null,
    frozen: false,
  }),
}));
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: async () => [
    { id: "d1", name: "Premier", slug: "premier", sport_key: "badminton", logo_storage_path: null, logo_url: null },
  ],
}));
vi.mock("@/server/usecases/card-stats", () => ({
  listDivisionCardStats: async () => new Map(),
  formatLabel: () => "League",
}));
vi.mock("@/server/usecases/competition-desk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/competition-desk")>()),
  getCompetitionDesk: async () => h.desk,
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
import { plural, t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";
import { ATTENTION_SEVERITY } from "@/lib/division-phase";
import { needsYouAt, needsYouHome, needsYouItems } from "@/components/v2/desk/needs-you";
import { needsYouButtonParts } from "@/lib/match-day/view";

const NOW = "2026-11-07T12:00:00.000Z";
const NAMES = [{ id: "d1", name: "Premier", slug: "premier" }];
const MATCH_DAY_HREF = "/o/riverside/c/summer-league/match-day";

function deskWith(o: {
  fixturesToday: number;
  attention?: Attention[];
  phase?: DivisionPhase;
  next?: DeskNextFixture | null;
  inPlay?: number;
}): CompetitionDesk {
  const inPlay = o.inPlay ?? 0;
  return {
    in_play: inPlay,
    in_play_fixtures: Array.from({ length: inPlay }, (_, i) => ({
      id: `f${i + 1}`,
      division_id: "d1",
      division_name: "Premier",
      home: "Ana",
      away: "Ben",
      fixture_no: i + 1,
      event_count: 0,
      headline: null,
      started_at: null,
    })),
    up_next: null,
    fixtures_today: o.fixturesToday,
    now: NOW,
    divisions: new Map([
      [
        "d1",
        {
          phase: o.phase ?? "scheduled",
          attention: o.attention ?? [],
          played: 2,
          total: 6,
          unscheduled: 0,
          in_play: inPlay,
          entrants: 4,
          next: o.next ?? null,
          needs_draw_stage: null,
          fixture_names: {
            f1: { home: "Ana", away: "Ben", fixture_no: 1 },
            f2: { home: "Cal", away: "Dee", fixture_no: 2 },
            f3: { home: "Eve", away: "Fay", fixture_no: 3 },
          },
          display_tz: "UTC",
        },
      ],
    ]),
  };
}

async function render(desk: CompetitionDesk, canEdit = true): Promise<string> {
  h.desk = desk;
  h.canEdit = canEdit;
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey={null} paidPlan>
      {el}
    </CompetitionPassProvider>,
  );
}

/** The opening tag of the element carrying `testid`, or null. */
const tagOf = (html: string, testid: string): string | null =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? null;
const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

beforeEach(() => {
  h.desk = null;
  h.canEdit = true;
});

/** One owed result across three matches, plus one other row: Match Day's header counts this as 1 + 3 = 4 (ruling m1 — every
 *  row that is not an owed result, plus each match owing one). */
const OWED_AND_UNSCHEDULED: Attention[] = [
  { kind: "unscheduled", count: 2 },
  { kind: "result_missing", count: 3, fixtureIds: ["f1", "f2", "f3"] },
];
const LIVE_NEXT: DeskNextFixture = { home: "Ana", away: "Ben", scheduled_at: null, in_play: true };

describe("the competition page on a match day (B1)", () => {
  it("shows no Needs-you list, one line into Match Day carrying Match Day's own count, and Open Match Day", async () => {
    const desk = deskWith({ fixturesToday: 4, attention: OWED_AND_UNSCHEDULED, phase: "match_day", next: LIVE_NEXT, inPlay: 1 });
    const html = await render(desk);

    expect(html).not.toContain('data-testid="desk-needs-you"');
    expect(countOf(html, "data-attention=\""), "no Needs-you row on this page").toBe(0);

    const line = tagOf(html, "desk-needs-you-in-match-day");
    expect(line, "the one line into Match Day").not.toBeNull();
    expect(line).toContain(`href="${MATCH_DAY_HREF}"`);
    expect(html).toContain(plural(en, "desk.needsYou.inMatchDay", 4, "en"));
    expect(plural(en, "desk.needsYou.inMatchDay", 4, "en")).toBe("4 things need you, in Match Day");
    // The same number Match Day's own header button opens with, for the same rows.
    const items = needsYouItems(en, desk, NAMES, "riverside", "summer-league", "en");
    expect(needsYouButtonParts(en, { needs_you: items, results_owed: 3 }, "en")[0]).toBe(plural(en, "matchDay.needsYou.count", 4, "en"));

    const open = tagOf(html, "desk-tool-match-day");
    expect(open, "Open Match Day in the header").not.toBeNull();
    expect(open).toContain(`href="${MATCH_DAY_HREF}"`);
    expect(html).toContain(t(en, "desk.tools.openMatchDay"));
  });

  it("carries no live duplicate: no in-play strip, no ledger 'Now:' cell, and the division pill reads In play", async () => {
    const html = await render(deskWith({ fixturesToday: 1, phase: "match_day", next: LIVE_NEXT, inPlay: 1 }));
    // Positive pair first: the ledger row really rendered, with its phase pill.
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-pill="match_day"');
    expect(t(en, "desk.phase.match_day")).toBe("In play");
    expect(html).toContain(">In play<");
    expect(html).not.toContain("desk-in-play-band");
    expect(html).not.toContain("Now:");
    // The live fixture's names were only ever on the page through the strip and the Now cell.
    expect(html).not.toContain("Ana v Ben");
  });

  it("a match day with nothing to do: Open Match Day, and no line at all (a zero is not information)", async () => {
    const html = await render(deskWith({ fixturesToday: 2 }));
    expect(tagOf(html, "desk-tool-match-day")).not.toBeNull();
    expect(html).not.toContain("desk-needs-you-in-match-day");
    expect(html).not.toContain('data-testid="desk-needs-you"');
  });

  it("a viewer is offered no door into Match Day (it is organisers' only) and, as before, no list", async () => {
    const html = await render(deskWith({ fixturesToday: 4, attention: OWED_AND_UNSCHEDULED }), false);
    expect(html).toContain('data-testid="desk-ledger-row"'); // positive pair: the page rendered
    expect(html).not.toContain("desk-tool-match-day");
    expect(html).not.toContain("desk-needs-you-in-match-day");
    expect(html).not.toContain('data-testid="desk-needs-you"');
  });

  it("one primary on a phone: Open Match Day leads filled on a match day, the schedule board does the day before", async () => {
    const filled = "max-md:bg-purple-600";
    const onDay = await render(deskWith({ fixturesToday: 1 }));
    expect(tagOf(onDay, "desk-tool-match-day")).toContain(filled);
    expect(tagOf(onDay, "desk-tool-match-day")).toContain("max-md:order-first");
    expect(tagOf(onDay, "desk-tool-schedule")).not.toContain(filled);
    expect(countOf(onDay, filled), "exactly one filled phone control").toBe(1);

    const before = await render(deskWith({ fixturesToday: 0 }));
    expect(tagOf(before, "desk-tool-match-day")).toBeNull();
    expect(tagOf(before, "desk-tool-schedule")).toContain(filled);
    expect(countOf(before, filled), "exactly one filled phone control").toBe(1);
  });
});

describe("the competition page the day before (B1)", () => {
  it("keeps the full Needs-you list, with no line into Match Day and no Open Match Day", async () => {
    const html = await render(deskWith({ fixturesToday: 0, attention: OWED_AND_UNSCHEDULED }));
    expect(html).toContain('data-testid="desk-needs-you"');
    expect(countOf(html, 'data-attention="unscheduled"')).toBe(1);
    expect(countOf(html, 'data-attention="result_missing"')).toBe(1);
    expect(html).not.toContain("desk-needs-you-in-match-day");
    expect(html).not.toContain("desk-tool-match-day");
  });
});

/** A sample of every Attention kind, as the desk builds it. A mapped type, so a new kind fails to compile until it has one. */
const SAMPLE: { [K in Attention["kind"]]: Extract<Attention, { kind: K }> } = {
  needs_draw: { kind: "needs_draw", stageName: "Finals", door: "compute" },
  needs_fixtures: { kind: "needs_fixtures", stageName: "Finals" },
  needs_decision: { kind: "needs_decision", count: 1, fixtureIds: ["f1"] },
  no_scorer: { kind: "no_scorer", count: 1, fixtureIds: ["f1"], minutesSinceKickoff: 5 },
  not_recording: { kind: "not_recording", count: 1, fixtureIds: ["f1"], minutesSinceKickoff: 40 },
  unscheduled: { kind: "unscheduled", count: 3 },
  result_missing: { kind: "result_missing", count: 2, fixtureIds: ["f1", "f2"] },
  registrations_waiting: { kind: "registrations_waiting", count: 2 },
  bans_waiting: { kind: "bans_waiting", count: 1 },
};

const SIDES = [
  { label: "the day before (no match today)", fixturesToday: 0, home: "competition" },
  { label: "a match day", fixturesToday: 3, home: "match_day" },
] as const;

describe("Needs you lives in one place at a time (spec §9)", () => {
  it("every Attention kind has exactly one home on each side of the day boundary — never zero, never two", async () => {
    const kinds = Object.keys(ATTENTION_SEVERITY) as Attention["kind"][];
    // The sample table covers the declaration of kinds, both ways.
    expect(Object.keys(SAMPLE).sort()).toEqual([...kinds].sort());
    let checked = 0;
    for (const kind of kinds) {
      for (const side of SIDES) {
        const desk = deskWith({ fixturesToday: side.fixturesToday, attention: [SAMPLE[kind]] });
        const items = needsYouItems(en, desk, NAMES, "riverside", "summer-league", "en");
        expect(items.filter((i) => i.kind === kind), `premise: the desk builds a ${kind} row`).toHaveLength(1);
        const html = await render(desk);
        const onPage = countOf(html, `data-attention="${kind}"`);
        // Match Day's list is `needsYouAt("match_day", …)` over the same rows (getMatchDay; real-DB pinned in
        // competition-desk.test.ts, and driven in e2e/match-day.spec.ts).
        const inMatchDay = needsYouAt("match_day", side.fixturesToday, items).filter((i) => i.kind === kind).length;
        expect({ onPage, inMatchDay }, `${kind}, ${side.label}`).toEqual(
          side.home === "competition" ? { onPage: 1, inMatchDay: 0 } : { onPage: 0, inMatchDay: 1 },
        );
        if (side.home === "match_day") {
          expect(tagOf(html, "desk-needs-you-in-match-day"), `${kind}: the line points at its home`).not.toBeNull();
        }
        checked++;
      }
    }
    expect(checked, "kind × side pairs checked").toBe(kinds.length * SIDES.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("needsYouHome: the one rule, and what it refuses", () => {
  it("no match today is the competition page's; any match today is Match Day's", () => {
    // The empty case first (desk _RULES: a phase rule set states its empty case first).
    expect(needsYouHome(0)).toBe("competition");
    expect(needsYouHome(1)).toBe("match_day");
    expect(needsYouHome(40)).toBe("match_day");
  });
  it("a count that is not one is a broken read, refused — never silently placed on either surface", () => {
    let checked = 0;
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => needsYouHome(bad), String(bad)).toThrow(RangeError);
      expect(() => needsYouAt("competition", bad, []), String(bad)).toThrow(RangeError);
      checked++;
    }
    expect(checked).toBe(4);
  });
});
