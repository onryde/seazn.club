// A complete, valid competition hub document, shared by the two suites that
// need one: the schema's own parse tests (Task 1) and the cache-validation
// tests for `publicCompetitionHub` (Task 4 fix round 2).
//
// Not a test file — the leading underscore keeps it out of vitest's `*.test.ts`
// glob, matching `scripts/bench/lib/__tests__/_*.ts`.
//
// It lives here rather than being copied into the second suite because a
// second hand-maintained copy drifts: the copy that is not next to the schema
// stops being valid the first time a required field is added, and the suite
// that owns it starts asserting against a document the product can no longer
// produce.

/** A COMPLETE, valid hub document: every optional-shaped field populated on one
 *  side and null on the other, so a dropped `.nullable()` or a wrong literal
 *  union has somewhere to fail. Built as a plain object and typed only on the
 *  way out, so the parse is doing real work rather than agreeing with a cast. */
export function validHubDoc(): unknown {
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
    pillNote: null,
    metaLine: null,
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
            colour: "#1d4ed8",
            cells: ["7", "+1.204"],
            tieBreakText: "ahead on net run rate",
            champion: true,
          },
          {
            rank: null,
            entrantId: "e2",
            name: "Queens",
            badgeUrl: null,
            colour: null,
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
