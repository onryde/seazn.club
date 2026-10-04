// A complete, valid competition hub document, shared by the two suites that
// need one: the schema's own parse tests (Task 1) and the cache-validation
// tests for `publicCompetitionHub` (Task 4 fix round 2).
//
// Not a test file — the leading underscore keeps it out of vitest's `*.test.ts`
// glob, matching `tools/bench/lib/__tests__/_*.ts`.
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
        // Division-page parity (2026-09-16): sanitised prose, and a ban that
        // names its person AND its entrant.
        description: "<p>Open to every club in the county.</p>",
        suspensions: [
          { personId: "p1", name: "Arun Kumar", entrantId: "e1", entrantName: "Blue Blazers", remaining: 2 },
        ],
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
        // …and the null side: no prose, and a ban whose person has no public
        // id and whose entrant is gone.
        description: null,
        suspensions: [{ personId: null, name: "Dev P.", entrantId: null, entrantName: null, remaining: 1 }],
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
            qual: {
              status: "win_k",
              label: "Win and in",
              ariaLabel: "Rank 1, Win and in, show details",
              headline: "Win your next match and you're through to Finals.",
              ifYouLose: null,
              whatIf: "If you finish level on points with Queens, net run rate decides.",
              whatIfAssumption: null,
            },
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
            qual: null,
            champion: false,
          },
        ],
        qualification: {
          cutIndex: 1,
          label: "Top 1 go through to Finals · 1 round left",
          legend: { through: "Through", open: "Still open", out: "Out", hint: "Tap a rank for details." },
        },
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
        members: [
          {
            personId: "p1",
            name: "Arun Kumar",
            squadNumber: 7,
            position: "WK",
            playerHref: "/riverside/autumn-cup/players/p1",
            suspendedRemaining: 2,
          },
          { personId: null, name: "Dev P.", squadNumber: null, position: null, playerHref: null, suspendedRemaining: null },
        ],
        calendarHref: "/riverside/autumn-cup/div-a/calendar.ics?entrant=e1",
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
        members: [],
        calendarHref: "/riverside/autumn-cup/div-a/calendar.ics?entrant=e2",
      },
    ],
    // Two views: the first populated (a champion, a single-lane bracket, two
    // rounds), the second its null-side twin (no champion, a lane, one round),
    // so a dropped `.nullable()` on either field has somewhere to fail. Every
    // id they name is a real `matches[].fixtureId` — the refinement demands it.
    knockouts: [
      {
        id: "div-a-ko1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        stageId: "ko1",
        stageName: "Knockout",
        kind: "knockout",
        rounds: [
          { key: "main-1", label: "Semi-final", lane: null, fixtureIds: ["f2"] },
          { key: "main-2", label: "Final", lane: null, fixtureIds: ["f1"] },
        ],
        drawable: true,
        championFixtureId: "f1",
      },
      {
        id: "div-a-de1",
        divisionId: "d1",
        divisionSlug: "div-a",
        divisionName: "Division A",
        stageId: "de1",
        stageName: "Double elimination",
        kind: "double_elim",
        rounds: [{ key: "WB-1", label: "Round 1", lane: "WB", fixtureIds: ["f1", "f2"] }],
        drawable: false,
        championFixtureId: null,
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
    // 2 matches, 1 table, 2 knockouts, 2 leader rows, 2 teams — so every
    // derived tab is on.
    tabs: ["overview", "matches", "table", "knockout", "stats", "teams", "info"],
  };
}
