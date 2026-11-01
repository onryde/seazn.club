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

const h = vi.hoisted(() => ({ desk: null as CompetitionDesk | null, canEdit: true, visibility: "private" as "private" | "public" }));

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
    visibility: h.visibility,
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
import { routes } from "@/lib/routes";
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

async function render(desk: CompetitionDesk | null, canEdit = true, visibility: "private" | "public" = "private"): Promise<string> {
  h.desk = desk;
  h.canEdit = canEdit;
  h.visibility = visibility;
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
  h.visibility = "private";
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

  it("carries no live duplicate: no in-play strip, no ledger 'Now:' cell, and the division pill reads Today", async () => {
    const html = await render(deskWith({ fixturesToday: 1, phase: "match_day", next: LIVE_NEXT, inPlay: 1 }));
    // Positive pair first: the ledger row really rendered, with its phase pill.
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html).toContain('data-pill="match_day"');
    // Owner ruling Q2 (2026-10-31, task B4): the match_day pill reads "Today" — "In play" read as a live count beside "N in play".
    expect(t(en, "desk.phase.match_day")).toBe("Today");
    expect(html).toContain(">Today<");
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

  // B4 (owner ruling Q1b, 2026-10-31): a view-only member opens Match Day read-only, so the door is theirs too — as a
  // SECONDARY action, never the filled one: a viewer runs nothing, and the schedule board keeps the one fill it has the day
  // before. Still no list (a viewer is never shown Needs you) and no line into Match Day's list.
  it("a viewer is offered Match Day as a secondary door — not filled, not first — and, as before, no list", async () => {
    const filled = "max-md:bg-purple-600";
    const html = await render(deskWith({ fixturesToday: 4, attention: OWED_AND_UNSCHEDULED }), false);
    expect(html).toContain('data-testid="desk-ledger-row"'); // positive pair: the page rendered
    const door = tagOf(html, "desk-tool-match-day");
    expect(door).not.toBeNull();
    expect(door).toContain(`href="${routes.competitionMatchDay("riverside", "summer-league")}"`);
    expect(door).toMatch(/[\s"]btn-ghost[\s"]/);
    expect(door).not.toMatch(/[\s"]btn-primary[\s"]/);
    expect(door).not.toContain(filled);
    expect(door).not.toContain("max-md:order-first");
    expect(tagOf(html, "desk-tool-schedule")).toContain(filled);
    expect(countOf(html, filled), "exactly one filled phone control").toBe(1);
    expect(html).not.toContain("desk-needs-you-in-match-day");
    expect(html).not.toContain('data-testid="desk-needs-you"');
    // Not on a day with no matches, for a viewer either.
    expect(tagOf(await render(deskWith({ fixturesToday: 0 }), false), "desk-tool-match-day")).toBeNull();
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

// Match Day C5 (owner request 2026-11-01): Slideshow, View Public Page and QR fold into ONE "Open" button with a drop-down. The
// menu's own behaviour is pinned in desk-open-menu.test.tsx; this is the PAGE's decisions — which tools go in it, in what order,
// who sees which, that nothing else in the row changed, and that the phone fold (More) still carries the same destinations.
//
// Owner addition (same day): when it is NOT a match day the menu also leads with a "Match Day" item — the door the filled Open
// Match Day button is on the day. The button and the item are one door in two shapes, never both.
/** The whole element carrying `testid`, tags and all (the same tag nested is counted, so a wrapper div closes on ITS </div>). */
function subtreeOf(html: string, testid: string): string | null {
  const open = new RegExp(`<([a-z]+)[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1]!;
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "g");
  re.lastIndex = open.index;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open.index, re.lastIndex);
  }
  throw new Error(`unbalanced <${tag}> under ${testid}`);
}
const anchorsIn = (markup: string): string[] => [...markup.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
const attrOf = (tag: string, name: string): string | null => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const hrefsIn = (markup: string): string[] => anchorsIn(markup).map((a) => attrOf(a, "href") ?? "");
/** The menu panel's own markup (the trigger is excluded). */
const panelOf = (menu: string): string => menu.slice(menu.search(/<div[^>]*role="menu"/));

describe("the competition page's Open menu (C5)", () => {
  const SLIDESHOW = routes.slideshowCompetition("comp-1");
  const PUBLIC = routes.shared("riverside", "summer-league");
  const QR = `${PUBLIC}/poster.pdf`;
  const SETTINGS = routes.competitionSettings("riverside", "summer-league");
  const REGISTRATION = routes.competitionRegistration("riverside", "summer-league");
  const SCHEDULE = routes.competitionSchedule("riverside", "summer-league");
  const MATCH_DAY = routes.competitionMatchDay("riverside", "summer-league");

  it("on a match day: ONE Open menu holds Slideshow, View Public Page and QR in that order, each keeping its href and its new tab", async () => {
    const html = await render(deskWith({ fixturesToday: 2 }), true, "public");
    expect(html).toContain('data-testid="desk-ledger-row"'); // positive pair: the page rendered
    const menu = subtreeOf(html, "desk-open-menu");
    expect(menu, "the Open menu").not.toBeNull();
    expect(countOf(html, 'data-testid="desk-open-menu"'), "one Open control, not one per tool").toBe(1);

    const trigger = tagOf(menu!, "desk-open-menu-toggle");
    expect(trigger).not.toBeNull();
    expect(attrOf(trigger!, "aria-haspopup")).toBe("menu");
    expect(attrOf(trigger!, "aria-expanded")).toBe("false");
    expect(menu).toContain(`<span>${t(en, "desk.tools.open")}</span>`);

    const panel = panelOf(menu!);
    const links = anchorsIn(panel);
    expect(links.map((a) => attrOf(a, "href")), "Slideshow, View Public Page, QR").toEqual([SLIDESHOW, PUBLIC, QR]);
    expect(links.map((a) => attrOf(a, "data-testid"))).toEqual(["desk-open-item-slideshow", "desk-open-item-public", "desk-open-item-qr"]);
    for (const a of links) {
      expect(attrOf(a, "target"), `${attrOf(a, "href")} opens in a new tab`).toBe("_blank");
      expect(attrOf(a, "role")).toBe("menuitem");
    }
    expect(links.map((a) => attrOf(a, "aria-label"))).toEqual([
      t(en, "aria.slideshowNewTab"),
      t(en, "aria.viewPublicNewTab"),
      t(en, "aria.qrPoster"),
    ]);
    const visible = [...panel.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, ""));
    expect(visible).toEqual([`${t(en, "action.slideshow")} ↗`, `${t(en, "action.viewPublic")} ↗`, t(en, "action.qr")]);
  });

  it("leaves NO top-level Slideshow / public-page / QR button in the row — only the Open menu and the phone's More fold hold them", async () => {
    const html = await render(deskWith({ fixturesToday: 0 }), true, "public");
    const row = subtreeOf(html, "desk-tool-row");
    expect(row, "the tool row").not.toBeNull();
    // Strip the two places they are ALLOWED to live; whatever is left is the row's own top-level controls.
    const rest = row!.replace(subtreeOf(row!, "desk-open-menu")!, "").replace(subtreeOf(row!, "desk-tools-more")!, "");
    expect(rest.length, "something was actually stripped").toBeLessThan(row!.length);
    const topLevel = hrefsIn(rest);
    for (const gone of [SLIDESHOW, PUBLIC, QR]) expect(topLevel, `${gone} must not be a top-level control`).not.toContain(gone);
    // Positive pair: the controls that did NOT move are still top-level and untouched.
    expect(topLevel).toEqual(expect.arrayContaining([SCHEDULE, REGISTRATION, SETTINGS]));
    expect(topLevel.length, "the row's other top-level links: schedule board, registration, settings").toBe(3);
    expect(rest).not.toContain("↗");
  });

  it("Open leads the row where Slideshow sat: after the Match Day door, before the schedule board, registration and settings", async () => {
    const html = await render(deskWith({ fixturesToday: 2 }), true, "public"); // a match day: the door is in the row too
    const row = subtreeOf(html, "desk-tool-row")!;
    const at = (needle: string) => {
      const i = row.indexOf(needle);
      expect(i, `${needle} is in the row`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at('data-testid="desk-tool-match-day"'),
      at('data-testid="desk-open-menu"'),
      at('data-testid="desk-tool-schedule"'),
      at(`href="${REGISTRATION}"`),
      at(`href="${SETTINGS}"`), // the first one is the desktop link; the phone fold comes after it
    ];
    expect(order, "source order: Match Day door, Open, schedule board, registration, settings").toEqual([...order].sort((a, b) => a - b));
  });

  it("is desktop-only: below md the row keeps its own More fold, so the same links are not offered twice on a phone", async () => {
    const html = await render(deskWith({ fixturesToday: 2 }), true, "public");
    const open = tagOf(html, "desk-open-menu");
    expect(open, "the Open menu rendered").not.toBeNull();
    expect(open, "hidden below md").toMatch(/\smax-md:hidden[\s"]/);
    const more = subtreeOf(html, "desk-tools-more")!;
    expect(tagOf(html, "desk-tools-more")).toMatch(/\smd:hidden[\s"]/);
    // The phone fold is unchanged on a match day: the three destinations and Settings, as before. The door is the row's own
    // filled button then, first on a phone — so the fold does not list it.
    expect(hrefsIn(more)).toEqual([SLIDESHOW, PUBLIC, QR, SETTINGS]);
    expect(more).not.toContain(MATCH_DAY);
  });

  // The owner's off-day door must exist on a phone too, where the Open menu does not: the fold leads with it, same tab.
  it("off the day the phone's More fold LEADS with Match Day too (same tab, no ↗), since Open is not on a phone", async () => {
    const html = await render(deskWith({ fixturesToday: 0 }), true, "public");
    const more = subtreeOf(html, "desk-tools-more")!;
    const links = anchorsIn(more);
    expect(links.map((a) => attrOf(a, "href"))).toEqual([MATCH_DAY, SLIDESHOW, PUBLIC, QR, SETTINGS]);
    expect(attrOf(links[0]!, "target"), "same tab").toBeNull();
    expect(links.slice(1).map((a) => attrOf(a, "target")), "the rest keep their targets: three new tabs, then Settings in place").toEqual([
      "_blank",
      "_blank",
      "_blank",
      null,
    ]);
    expect(more.replace(/<[^>]+>/g, "|")).toContain(t(en, "desk.tools.matchDay"));
  });

  // Each tool is gated exactly as it was: the public page and its QR need a non-private competition; nothing is gated on
  // canEdit (a view-only member sees the whole row). Slideshow is always there, so the menu is never empty on this page — the
  // empty case is the component's own (desk-open-menu.test.tsx) and is reached here only through the page's data.
  it.each([
    { visibility: "public" as const, canEdit: true, want: [SLIDESHOW, PUBLIC, QR] },
    { visibility: "public" as const, canEdit: false, want: [SLIDESHOW, PUBLIC, QR] },
    { visibility: "private" as const, canEdit: true, want: [SLIDESHOW] },
    { visibility: "private" as const, canEdit: false, want: [SLIDESHOW] },
  ])("a match day, $visibility competition, canEdit=$canEdit: the menu offers $want.length tool(s)", async ({ visibility, canEdit, want }) => {
    const html = await render(deskWith({ fixturesToday: 1 }), canEdit, visibility);
    expect(html).toContain('data-testid="desk-ledger-row"');
    const menu = subtreeOf(html, "desk-open-menu");
    expect(menu, "Open is there whenever any tool is").not.toBeNull();
    expect(hrefsIn(menu!)).toEqual(want);
  });

  it("carries the words in every locale (new keys, not English in three dictionaries)", async () => {
    const dicts = await Promise.all(
      ["en", "es", "fr", "nl"].map(async (l) => [l, (await import(`@/dictionaries/${l}/ui.json`)).default as Record<string, string>] as const),
    );
    expect(dicts.length).toBe(4);
    for (const key of ["desk.tools.open", "desk.tools.matchDay"]) {
      for (const [l, d] of dicts) expect(d[key], `${l} has ${key}`).toBeTruthy();
      // Four words, not one copied four times.
      expect(new Set(dicts.map(([, d]) => d[key])).size, `${key} is translated`).toBe(4);
    }
  });
});

// The owner's addition: off a match day the Open menu LEADS with "Match Day"; on the day that door is the filled button instead.
describe("the Match Day door, off the day and on it (C5 addition)", () => {
  const MATCH_DAY = routes.competitionMatchDay("riverside", "summer-league");
  const menuOf = (html: string): string => {
    const menu = subtreeOf(html, "desk-open-menu");
    if (menu === null) throw new Error("no Open menu rendered");
    return menu;
  };
  const itemOf = (menu: string) => menu.match(/<a [^>]*data-testid="desk-open-item-matchday"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? null;

  it("not a match day: the menu's FIRST item is Match Day — same tab, no ↗ — and the filled button is absent", async () => {
    const html = await render(deskWith({ fixturesToday: 0 }), true, "public");
    expect(html).toContain('data-testid="desk-ledger-row"');
    expect(html, "no button").not.toContain('data-testid="desk-tool-match-day"');
    const menu = menuOf(html);
    const links = [...menu.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    const first = links[0]!;
    expect(first.match(/\shref="([^"]*)"/)?.[1], "Match Day leads").toBe(MATCH_DAY);
    expect(first).toContain('data-testid="desk-open-item-matchday"');
    expect(first, "same tab").not.toMatch(/\starget=/);
    const item = itemOf(menu)!;
    expect(item.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim()).toBe(t(en, "desk.tools.matchDay"));
    expect(item).not.toContain("↗");
    expect(links.length, "Match Day + the three tools").toBe(4);
    expect(links.slice(1).map((a) => a.match(/\shref="([^"]*)"/)?.[1])).toEqual([
      routes.slideshowCompetition("comp-1"),
      routes.shared("riverside", "summer-league"),
      `${routes.shared("riverside", "summer-league")}/poster.pdf`,
    ]);
  });

  it("a match day: the filled button is there and the menu has NO Match Day item", async () => {
    const html = await render(deskWith({ fixturesToday: 3 }), true, "public");
    expect(html).toContain('data-testid="desk-ledger-row"');
    const button = tagOf(html, "desk-tool-match-day");
    expect(button, "the button").not.toBeNull();
    expect(button).toContain(`href="${MATCH_DAY}"`);
    const menu = menuOf(html);
    expect(itemOf(menu)).toBeNull();
    expect(menu).not.toContain(MATCH_DAY);
    expect(menu).not.toContain("desk-open-item-matchday");
  });

  // The door is offered to the same people as the button: B4 (owner ruling Q1b) lets a view-only member open Match Day
  // read-only, so a viewer gets the item off the day exactly as they get the button on it. EVERY combination, and exactly one
  // of the two shapes in each — "never both" and "never neither" are the same sweep.
  it("the button and the menu item are one door: exactly one shows, for every (desk, role, visibility) — the day, the day before, and a desk that failed to load", async () => {
    const desks: { name: string; desk: CompetitionDesk | null; onDay: boolean }[] = [
      { name: "fixtures today = 0", desk: deskWith({ fixturesToday: 0 }), onDay: false },
      { name: "fixtures today = 1", desk: deskWith({ fixturesToday: 1 }), onDay: true },
      { name: "fixtures today = 5, a match in play", desk: deskWith({ fixturesToday: 5, phase: "match_day", next: LIVE_NEXT, inPlay: 1 }), onDay: true },
      { name: "desk failed to load", desk: null, onDay: false },
    ];
    let checked = 0;
    for (const { name, desk, onDay } of desks) {
      for (const canEdit of [true, false]) {
        for (const visibility of ["public", "private"] as const) {
          const label = `${name}, canEdit=${canEdit}, ${visibility}`;
          const html = await render(desk, canEdit, visibility);
          expect(html, `${label}: the page rendered`).toContain('data-testid="desk-ledger-row"');
          const button = tagOf(html, "desk-tool-match-day") !== null;
          const item = itemOf(menuOf(html)) !== null;
          // The phone has no Open menu: the same door is the first row of its More fold.
          const foldDoor = hrefsIn(subtreeOf(html, "desk-tools-more")!).includes(MATCH_DAY);
          expect(foldDoor, `${label}: the phone fold carries the door exactly when the menu does`).toBe(item);
          expect(button, `${label}: the filled button shows exactly on a match day`).toBe(onDay);
          expect(item, `${label}: the menu item shows exactly when it is NOT a match day`).toBe(!onDay);
          expect(button !== item, `${label}: one door, never both and never neither`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity: 4 desks x 2 roles x 2 visibilities").toBe(16);
  });
});
