// The guarantee behind `hubDict()` — and it is this file, not the prefix list.
//
// A hand-written key list cannot fail when a new key is used: that is the shape
// that let `landing.status.matchDay` ship missing from four locales, and it is
// why `HUB_DICT_PREFIXES` is deliberately not the safety mechanism. The
// mechanism is differential: every tab is rendered TWICE, once with the full
// dictionary and once with the slice, and the markup must be byte-identical.
// Drop a prefix something needs and this fails with the missing copy visible,
// rather than a raw key string quietly rendering on the public page.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { HUB_DICT_KEYS, HUB_DICT_PREFIXES, SERVER_ONLY_KEYS, hubDict } from "@/lib/hub-dict";
import { STATUS_LINE_KEYS } from "@/server/public-site/competition-hub";
import { InfoTab } from "@/components/public-site/matches-hub/info-tab";
import { KnockoutTab } from "@/components/public-site/matches-hub/knockout-tab";
import { MatchesTab } from "@/components/public-site/matches-hub/matches-tab";
import { OverviewTab } from "@/components/public-site/matches-hub/overview-tab";
import { StatsTab } from "@/components/public-site/matches-hub/stats-tab";
import { TableTab } from "@/components/public-site/matches-hub/table-tab";
import { TeamsTab } from "@/components/public-site/matches-hub/teams-tab";
import {
  board,
  calendarFor,
  division,
  hubDoc,
  info,
  knockoutView,
  koRound,
  koSide,
  leader,
  m,
  member,
  suspension,
  tableRow,
  tableView,
  team,
} from "@/components/public-site/__tests__/hub-fixtures";

const full = en as Dict;
const slice = hubDict(full);
const NOW = Date.parse("2026-09-05T12:00:00.000Z");

/** A document that reaches as much copy as one document can: two divisions,
 *  every bucket, tables, leaders, teams and a full info block. */
const doc = hubDoc({
  // A division with prose, a ban and a calendar, and a squad with a suspended
  // and a positioned line — so the Info tab's Divisions section and the Teams
  // tab's squad reach their copy too (division-page parity, 2026-09-16).
  divisions: [
    division("premier", {
      description: "<p>Prose</p>",
      suspensions: [suspension("Arjun Mehta", 2, { entrantName: "Riverside FC" }), suspension("Dev P.", 1)],
      // A stage on its own rules (per-stage rules, T7): the Info tab resolves
      // its `format.` line client-side, so the slice must carry it.
      stageFormatLines: [
        { stageName: "Swiss", line: [{ key: "format.rules.oneGamePointsCap", params: { points: 15, cap: 21 } }] },
        // A multi-clause (tennis) line, so the slice is proved for the
        // `format.sets.`/`format.rules.tennis.` keys too (review round 2).
        {
          stageName: "Finals",
          line: [
            { key: "format.sets.bestOf", params: { n: 3 } },
            { key: "format.rules.tennis.setsTo", params: { games: 4 } },
            { key: "format.rules.tennis.noAd" },
          ],
        },
      ],
    }),
    division("sunday-league"),
  ],
  info: info({ calendars: [calendarFor("premier")] }),
  matches: [
    m("live-1", "live", "2026-09-05T11:00:00.000Z", "premier"),
    m("up-1", "upcoming", "2026-09-06T13:00:00.000Z", "sunday-league"),
    m("done-1", "completed", "2026-09-04T10:00:00.000Z", "premier"),
    m("tbd-1", "upcoming", null, "premier"),
  ],
  tables: [
    tableView("t1", "premier", { rows: [tableRow("e1", 1), tableRow("e2", 2)] }),
    tableView("t2", "sunday-league", { rows: [tableRow("e3", 1)] }),
  ],
  leaders: [board("premier", "runs", [leader("p1", "Arjun Mehta", "/o/c/players/p1")])],
  teams: [
    team("e1", "Riverside FC", null, "#1d6b4f", {
      members: [member("Arjun Mehta", 7, { suspendedRemaining: 2 }), member("Dev P.", null, { position: "WK" })],
    }),
    team("e2", "Summit FC", null, null),
  ],
});

/**
 * The EMPTY arms, rendered alongside the rich document.
 *
 * The rich document alone left `leaders.`, `teams.` and `division.` looking
 * unused — not because the hub does not read them, but because a document with
 * a leaderboard, seeded teams and populated divisions never reaches
 * `leaders.empty`, `teams.seed` or `division.entrantsEmpty`. A slice proved
 * against one shape of document is a slice proved for that shape only, which is
 * the same "one sample is not a parity sweep" rule the engine tests follow.
 */
const bare = hubDoc({
  divisions: [division("premier")],
  matches: [],
  tables: [],
  leaders: [],
  teams: [],
});

/** A seeded team, so `teams.seed` is reached at all. */
const seeded = hubDoc({
  divisions: [division("premier")],
  teams: [team("e9", "Lakeside FC", null, null, { seed: 1, divisionSlug: "premier" })],
});

/** Two brackets that between them reach the Knockout tab's copy: one mid-event
 *  (a live round badge, the rounds rail, the "next" sentences, the view
 *  switch) and one won (the champion banner). `useSearchParam` answers null in
 *  a server render, so the Draw's region label is the one `knockout.` string
 *  this document cannot reach — the prefix covers it by construction. */
const koMatch = (
  id: string,
  bucket: "live" | "upcoming" | "completed",
  roundLabel: string,
  [a, b]: [string, string],
  winnerIndex: 0 | 1 | null,
  divisionSlug: string,
) =>
  m(id, bucket, "2026-09-05T10:00:00.000Z", divisionSlug, {
    roundLabel,
    winnerIndex,
    header: { sides: [koSide(a), koSide(b)] },
  });
const knockouts = hubDoc({
  matches: [
    koMatch("k-s1", "completed", "Semi-finals", ["Ana", "Ben"], 0, "premier"),
    koMatch("k-s2", "live", "Semi-finals", ["Cara", "Dev"], null, "premier"),
    koMatch("k-f", "upcoming", "Final", ["Ana", "Dev"], null, "premier"),
    koMatch("p-f", "completed", "Final", ["Eli", "Fay"], 1, "sunday-league"),
  ],
  knockouts: [
    knockoutView("cup", "premier", [
      koRound("main-1", "Semi-finals", ["k-s1", "k-s2"]),
      koRound("main-2", "Final", ["k-f"]),
    ]),
    knockoutView("plate", "sunday-league", [koRound("main-1", "Final", ["p-f"])], {
      championFixtureId: "p-f",
      drawable: false,
    }),
  ],
});

/**
 * Every status sentence a hub card can print, one fixture each (Knockout fix
 * round, P2).
 *
 * `hubHeader` (`competition-hub.ts`) sets `statusLine` only for a called-off
 * fixture — `matchCentre.status.<status>` for a member of `STATUS_LINE_KEYS`,
 * `matchCentre.status.other` for anything else — and `MatchCard` prints it.
 * No document above carried one, so the slice shipped without those keys and
 * a forfeited final printed `matchCentre.status.forfeited` on the public page
 * with this whole suite green. DERIVED from the builder's own set, so a new
 * called-off status the builder learns to emit is a new fixture here.
 *
 * Postponed is not terminal (it sits in Upcoming); the rest are completed. One
 * round holding all six, on a view that cannot be drawn, is the one round the
 * rail can open on — so every card renders.
 */
const CALLED_OFF = [...STATUS_LINE_KEYS, "other"];
const calledOff = hubDoc({
  matches: CALLED_OFF.map((status) =>
    m(`off-${status}`, status === "postponed" ? "upcoming" : "completed", "2026-09-05T10:00:00.000Z", "premier", {
      roundLabel: "Final",
      winnerIndex: status === "forfeited" || status === "walkover" ? 0 : null,
      header: {
        sides: [koSide(`Home ${status}`), koSide(`Away ${status}`)],
        status: "other",
        statusLine: { key: `matchCentre.status.${status}` },
      },
    }),
  ),
  knockouts: [
    knockoutView("off", "premier", [koRound("main-1", "Final", CALLED_OFF.map((status) => `off-${status}`))], {
      drawable: false,
    }),
  ],
});

const TABS: [string, (d: Dict) => string][] = [
  [
    "Overview",
    (d) =>
      renderToStaticMarkup(<OverviewTab doc={doc} dict={d} locale="en" now={NOW} />) +
      renderToStaticMarkup(<OverviewTab doc={bare} dict={d} locale="en" now={NOW} />),
  ],
  [
    "Matches",
    (d) =>
      renderToStaticMarkup(<MatchesTab doc={doc} dict={d} locale="en" now={NOW} />) +
      renderToStaticMarkup(<MatchesTab doc={bare} dict={d} locale="en" now={NOW} />) +
      renderToStaticMarkup(<MatchesTab doc={calledOff} dict={d} locale="en" now={NOW} />),
  ],
  [
    "Table",
    (d) =>
      renderToStaticMarkup(<TableTab doc={doc} dict={d} />) +
      renderToStaticMarkup(<TableTab doc={bare} dict={d} />),
  ],
  [
    "Knockout",
    (d) =>
      renderToStaticMarkup(<KnockoutTab doc={knockouts} dict={d} locale="en" now={NOW} />) +
      renderToStaticMarkup(<KnockoutTab doc={bare} dict={d} locale="en" now={NOW} />) +
      renderToStaticMarkup(<KnockoutTab doc={calledOff} dict={d} locale="en" now={NOW} />),
  ],
  [
    "Stats",
    (d) =>
      renderToStaticMarkup(<StatsTab doc={doc} dict={d} />) +
      renderToStaticMarkup(<StatsTab doc={bare} dict={d} />),
  ],
  [
    "Teams",
    (d) =>
      renderToStaticMarkup(<TeamsTab doc={doc} dict={d} locale="en" />) +
      renderToStaticMarkup(<TeamsTab doc={bare} dict={d} locale="en" />) +
      renderToStaticMarkup(<TeamsTab doc={seeded} dict={d} locale="en" />),
  ],
  [
    "Info",
    (d) =>
      renderToStaticMarkup(<InfoTab doc={doc} dict={d} locale="en" />) +
      renderToStaticMarkup(<InfoTab doc={bare} dict={d} locale="en" />),
  ],
];

describe("hubDict", () => {
  it.each(TABS)("%s renders identically from the slice and from the full dictionary", (_n, render) => {
    expect(render(slice)).toBe(render(full));
  });

  it("is a real narrowing — it drops most of the dictionary, and specifically the key that found this", () => {
    const fullKeys = Object.keys(full).length;
    const sliceKeys = Object.keys(slice).length;
    // A slice that kept everything would pass every assertion above while
    // fixing nothing, so the saving is asserted rather than assumed.
    expect(sliceKeys).toBeLessThan(fullKeys / 2);

    // `scripts/smoke.ts:13611` asserts a free org's page does not contain
    // "Presented by". True of the markup — an un-tiered strip has no title row
    // — and false of the BODY, because the string arrived as serialised
    // dictionary data. `SponsorsBoard` is a SERVER component handed in as a
    // slot, so none of its three keys has any business crossing the boundary.
    for (const key of SERVER_ONLY_KEYS) {
      expect(Object.hasOwn(slice, key), key).toBe(false);
      expect(Object.hasOwn(full, key), key).toBe(true);
    }
  });

  it("keeps every key it keeps VERBATIM — a narrowing, never a rewrite", () => {
    for (const key of Object.keys(slice)) {
      expect(slice[key], key).toBe((full as Record<string, unknown>)[key]);
    }
  });

  it("every prefix earns its place — dropping any one of them changes a render", () => {
    // The list is not the guarantee, but a prefix nobody needs is dead weight
    // that will be copied forward by the next reader. Each is proved load-
    // bearing, which is the same standard the mutation sweeps hold code to.
    const unused: string[] = [];
    for (const prefix of HUB_DICT_PREFIXES) {
      const without: Record<string, unknown> = {};
      for (const k of Object.keys(slice)) if (!k.startsWith(prefix)) without[k] = slice[k];
      const changed = TABS.some(([, render]) => render(without) !== render(full));
      if (!changed) unused.push(prefix);
    }
    expect(unused, "prefixes no tab reads").toEqual([]);
  });

  it("the called-off document really prints all six status sentences, and none of them raw (anti-vacuity for the renders above)", () => {
    // Without this, a fixture that stopped reaching a card (a round the rail
    // does not open, a result line outranking the status) would make the
    // identical-markup test pass on a render that never asked for the key.
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    const h = renderToStaticMarkup(<KnockoutTab doc={calledOff} dict={slice} locale="en" now={NOW} />);
    for (const status of CALLED_OFF) {
      const sentence = (full as Record<string, string>)[`matchCentre.status.${status}`];
      expect(sentence, status).toBeTruthy();
      expect(h, status).toContain(`data-testid="mh-match-status" class="shrink-0 font-medium text-ink">${esc(sentence!)}<`);
    }
    expect(h).not.toContain("matchCentre.");
  });

  it("carries EXACTLY the status keys the builder can emit — not the whole `matchCentre.` family", () => {
    // The slice exists to keep the page small; `matchCentre.` is the match
    // centre's whole vocabulary. What crosses is derived from the same set
    // `hubHeader` keys its status line off, plus its catch-all.
    const emitted = CALLED_OFF.map((status) => `matchCentre.status.${status}`).sort();
    expect([...HUB_DICT_KEYS].sort()).toEqual(emitted);
    expect(Object.keys(slice).filter((k) => k.startsWith("matchCentre.")).sort()).toEqual(emitted);
  });

  it("every exact key earns its place — dropping any one of them changes a render", () => {
    const unused: string[] = [];
    for (const key of HUB_DICT_KEYS) {
      const without: Record<string, unknown> = { ...slice };
      delete without[key];
      if (!TABS.some(([, render]) => render(without) !== render(full))) unused.push(key);
    }
    expect(unused, "exact keys no tab reads").toEqual([]);
  });
});
