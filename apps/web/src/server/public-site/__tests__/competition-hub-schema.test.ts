// Spectator surface W2, Task 1 — the hub document schema, PARSED.
//
// This file exists because a schema nothing ever calls is decoration: until
// something runs `CompetitionHubDoc.parse`, `tabs`' `.min(1)`, `winnerIndex`'s
// literal union and every `.nullable()` in 200-odd lines are unenforced text.
// The wave's own rule is that a seam proven by a fixture on both ends proves
// the fixture — so this drives the REAL schema with a complete document and
// then breaks it, one field at a time, for a reason each case names.
//
// Mutation sweep — each mutant applied to `competition-hub-schema.ts` alone and
// restored; all nine killed, killer named:
//   1 drop `.min(1)` from `tabs` ............... "an empty tab list is refused"
//   2 `winnerIndex` → `z.number().nullable()` .. "a winnerIndex of 2 is refused"
//   3 `tabs` element type → `z.string()` ....... "an unknown tab id is refused"
//   4 `superRefine` never raises its issue ..... all three self-consistency cases
//   5 `superRefine` compares LENGTH only ....... "tabs must match in ORDER"
//   6 refinement counts BOARDS, not leader ROWS  "leader BOARDS with no rows…"
//   7 `name` made `.nullable()` ................ "a required field cannot be null"
//   8 `resultLine` loses `.nullable()` ......... the round-trip case (+2 more)
//   9 `sportName` loses `.nullable()` .......... the round-trip case (+3 more)
import { describe, expect, it } from "vitest";
import { deriveHubTabs } from "@/lib/matches-hub";
import {
  CompetitionHubDoc,
  type CompetitionHubDocT,
} from "@/server/public-site/competition-hub-schema";

/** A COMPLETE, valid hub document: every optional-shaped field populated on one
 *  side and null on the other, so a dropped `.nullable()` or a wrong literal
 *  union has somewhere to fail. Built as a plain object and typed only on the
 *  way out, so the parse is doing real work rather than agreeing with a cast. */
function validDoc(): unknown {
  const header = {
    live: true,
    status: "in_play" as const,
    sides: [
      { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: "#1d4ed8", badgeUrl: null },
      { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: "https://x/q.png" },
    ],
    scoreLines: ["56/6", null],
    subLines: ["(8.0)", null],
    battingIndex: 0,
    statusLine: { key: "matchCentre.chase", params: { runs: 34, balls: 21 } },
    rateLine: "CRR 8.44 · RRR 9.71",
    phase: null,
    strength: null,
    updatedAt: "2026-09-05T12:00:00.000Z",
  };
  return {
    competitionId: "c1",
    orgSlug: "riverside",
    competitionSlug: "autumn-cup",
    name: "Autumn Cup",
    orgName: "Riverside SC",
    branded: true,
    realtime: true,
    locale: "en",
    generatedAt: "2026-09-05T12:00:00.000Z",
    divisions: [
      {
        id: "d1",
        slug: "div-a",
        name: "Division A",
        sportKey: "cricket",
        sportName: "Cricket",
        status: "active",
        tz: "Europe/London",
        entrantCount: 8,
        formatLine: { key: "format.league.rounds", params: { rounds: 7 } },
        variantKey: "t20",
        href: "/riverside/autumn-cup/div-a",
      },
      {
        // the null-side twin: every nullable field on this row is null
        id: "d2",
        slug: "div-b",
        name: "Division B",
        sportKey: "cricket",
        sportName: null,
        status: "setup",
        tz: "Europe/London",
        entrantCount: 0,
        formatLine: null,
        variantKey: "t20",
        href: "/riverside/autumn-cup/div-b",
      },
    ],
    matches: [
      {
        fixtureId: "f1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        sportKey: "cricket",
        stageName: "League",
        roundNo: 3,
        roundLabel: "Semi-final",
        bucket: "live",
        tz: "Europe/London",
        scheduledAt: "2026-09-05T13:00:00.000Z",
        venueName: "Riverside Oval",
        courtName: "Main",
        href: "/riverside/autumn-cup/div-a/fixtures/f1",
        header,
        winnerIndex: 1,
        resultLine: "Queens won by 12 runs",
      },
      {
        fixtureId: "f2",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        sportKey: "cricket",
        stageName: "League",
        roundNo: 4,
        roundLabel: null,
        bucket: "upcoming",
        tz: "Europe/London",
        scheduledAt: null,
        venueName: null,
        courtName: null,
        href: "/riverside/autumn-cup/div-a/fixtures/f2",
        header: { ...header, live: false, status: "scheduled", battingIndex: null },
        winnerIndex: null,
        resultLine: null,
      },
    ],
    tables: [
      {
        id: "t1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        caption: "League table",
        columns: [
          { key: "p", abbr: "P", title: "Played", compact: true },
          { key: "nrr", abbr: "NRR", title: "Net run rate", compact: false },
        ],
        rows: [
          {
            rank: 1,
            entrantId: "e1",
            name: "Blue Blazers",
            badgeUrl: "https://x/b.png",
            cells: ["7", "+1.204"],
            tieBreakText: "ahead on net run rate",
            champion: true,
          },
          {
            rank: null,
            entrantId: "e2",
            name: "Queens",
            badgeUrl: null,
            cells: ["7", "-0.310"],
            tieBreakText: null,
            champion: false,
          },
        ],
        updatedAt: "2026-09-05T12:00:00.000Z",
        fullHref: "/riverside/autumn-cup/div-a?tab=table",
      },
    ],
    leaders: [
      {
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        sportKey: "cricket",
        key: "runs",
        label: "Most runs",
        rows: [
          {
            person: { personId: "p1", name: "A. Khan", masked: false },
            personHref: "/riverside/people/p1",
            entrantName: "Blue Blazers",
            badgeUrl: "https://x/b.png",
            value: "412",
          },
          {
            person: { personId: "p2", name: "Player", masked: true },
            personHref: null,
            entrantName: null,
            badgeUrl: null,
            value: "388",
          },
        ],
      },
    ],
    teams: [
      {
        entrantId: "e1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        name: "Blue Blazers",
        badgeUrl: "https://x/b.png",
        colour: "#1d4ed8",
        seed: 1,
        href: "/riverside/autumn-cup/div-a/teams/e1",
      },
      {
        entrantId: "e2",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        name: "Queens",
        badgeUrl: null,
        colour: null,
        seed: null,
        href: "/riverside/autumn-cup/div-a/teams/e2",
      },
    ],
    info: {
      startsOn: "2026-09-01",
      endsOn: null,
      venues: ["Riverside Oval"],
      registrationOpen: false,
      registerHref: "/riverside/autumn-cup/register",
      calendars: [{ divisionName: "Division A", href: "/riverside/autumn-cup/div-a.ics" }],
      presentHref: "/riverside/autumn-cup/present",
    },
    // 2 matches, 1 table, 2 leader rows, 2 teams — so every derived tab is on.
    tabs: ["overview", "matches", "table", "stats", "teams", "info"],
  };
}

/** Parse and hand back the issues, so a case can name the field AND the reason
 *  rather than asserting only that something somewhere went wrong. */
function issuesOf(doc: unknown): { path: string; code: string }[] {
  const r = CompetitionHubDoc.safeParse(doc);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code }));
}

describe("CompetitionHubDoc — the document really parses", () => {
  it("a complete document round-trips, and the parsed value equals the input", () => {
    const input = validDoc();
    const parsed: CompetitionHubDocT = CompetitionHubDoc.parse(input);
    // Equality is the point: zod strips unknown keys, so a field the schema
    // forgot to declare would show up here as a difference rather than as a
    // silently discarded value.
    expect(parsed).toEqual(input);
  });

  it("the fixture's own tabs agree with deriveHubTabs — the fixture is not lying to the refinement", () => {
    const doc = validDoc() as CompetitionHubDocT;
    expect(doc.tabs).toEqual(
      deriveHubTabs({
        matches: doc.matches.length,
        tables: doc.tables.length,
        leaderRows: doc.leaders.reduce((n, b) => n + b.rows.length, 0),
        teams: doc.teams.length,
      }),
    );
  });
});

describe("CompetitionHubDoc — what it REFUSES, and why", () => {
  it("an empty tab list is refused: a hub with no way into it", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), tabs: [] };
    expect(issuesOf(doc)).toContainEqual({ path: "tabs", code: "too_small" });
  });

  it("a winnerIndex of 2 is refused: a fixture has two sides, so the index is 0 or 1", () => {
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, matches: [{ ...doc.matches[0]!, winnerIndex: 2 }, doc.matches[1]!] };
    expect(issuesOf(broken)).toContainEqual({
      path: "matches.0.winnerIndex",
      code: "invalid_union",
    });
  });

  it("an unknown tab id is refused: the tab list is a closed vocabulary", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), tabs: ["overview", "roster", "info"] };
    expect(issuesOf(doc)).toContainEqual({ path: "tabs.1", code: "invalid_value" });
  });

  it("a required field cannot be null: `name` is not nullable", () => {
    const doc = { ...(validDoc() as Record<string, unknown>), name: null };
    expect(issuesOf(doc)).toContainEqual({ path: "name", code: "invalid_type" });
  });

  it("SELF-CONSISTENCY: a Matches tab beside an empty matches array is refused", () => {
    // The invariant the schema's own comment claims. Without the refinement this
    // document parses cleanly and a spectator meets a tab that opens on nothing.
    const doc = validDoc() as CompetitionHubDocT;
    const broken = { ...doc, matches: [], tabs: doc.tabs };
    const issues = issuesOf(broken);
    expect(issues).toContainEqual({ path: "tabs", code: "custom" });
    const r = CompetitionHubDoc.safeParse(broken);
    expect(r.success).toBe(false);
    expect(r.error!.issues.find((i) => i.code === "custom")!.message).toContain(
      "deriveHubTabs()",
    );
  });

  it("SELF-CONSISTENCY: tabs must match in ORDER, not merely in membership", () => {
    // Same set, wrong order. A length-only or set-only comparison passes this;
    // the tab strip is rendered in list order, so order is the contract.
    const doc = validDoc() as CompetitionHubDocT;
    const broken = {
      ...doc,
      tabs: ["overview", "table", "matches", "stats", "teams", "info"],
    };
    expect(issuesOf(broken)).toContainEqual({ path: "tabs", code: "custom" });
  });

  it("SELF-CONSISTENCY: the empty document's own tab list is accepted", () => {
    // The positive pair for the two refusals above — the refinement must not be
    // a gate that refuses everything. A hub with no contents at all carries
    // exactly overview + info, and that parses.
    const doc = validDoc() as CompetitionHubDocT;
    const bare = {
      ...doc,
      matches: [],
      tables: [],
      leaders: [],
      teams: [],
      tabs: ["overview", "info"],
    };
    expect(issuesOf(bare)).toEqual([]);
  });

  it("SELF-CONSISTENCY: leader BOARDS with no rows do not earn a Stats tab", () => {
    // `leaderRows`, not `leaders.length` — a board list that exists but is empty
    // is exactly the case `deriveHubTabs` counts rows for.
    const doc = validDoc() as CompetitionHubDocT;
    const emptyBoards = {
      ...doc,
      leaders: [{ ...doc.leaders[0]!, rows: [] }],
      tabs: ["overview", "matches", "table", "stats", "teams", "info"],
    };
    expect(issuesOf(emptyBoards)).toContainEqual({ path: "tabs", code: "custom" });

    const withoutStats = { ...emptyBoards, tabs: ["overview", "matches", "table", "teams", "info"] };
    expect(issuesOf(withoutStats)).toEqual([]);
  });
});
