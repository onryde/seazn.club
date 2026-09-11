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
import { HUB_DICT_PREFIXES, SERVER_ONLY_KEYS, hubDict } from "@/lib/hub-dict";
import { InfoTab } from "@/components/public-site/matches-hub/info-tab";
import { MatchesTab } from "@/components/public-site/matches-hub/matches-tab";
import { OverviewTab } from "@/components/public-site/matches-hub/overview-tab";
import { StatsTab } from "@/components/public-site/matches-hub/stats-tab";
import { TableTab } from "@/components/public-site/matches-hub/table-tab";
import { TeamsTab } from "@/components/public-site/matches-hub/teams-tab";
import {
  board,
  division,
  hubDoc,
  leader,
  m,
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
  divisions: [division("premier"), division("sunday-league")],
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
  teams: [team("e1", "Riverside FC", null, "#1d6b4f"), team("e2", "Summit FC", null, null)],
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
      renderToStaticMarkup(<MatchesTab doc={bare} dict={d} locale="en" now={NOW} />),
  ],
  [
    "Table",
    (d) =>
      renderToStaticMarkup(<TableTab doc={doc} dict={d} />) +
      renderToStaticMarkup(<TableTab doc={bare} dict={d} />),
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
      renderToStaticMarkup(<TeamsTab doc={doc} dict={d} />) +
      renderToStaticMarkup(<TeamsTab doc={bare} dict={d} />) +
      renderToStaticMarkup(<TeamsTab doc={seeded} dict={d} />),
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
});
