// Spectator surface W2 — shared factories for the competition-hub CLIENT
// component suites. Task 8 (the Matches tab) is their first consumer; Task 9
// (the Table tab) added `tableView()` and `tableRow()` here rather than
// starting a second copy, and Task 10 (Stats, Teams and Info) extends it again
// with `board()`, `leader()`, `team()` and `info()`.
//
// NOT a test file, and the name is load-bearing: `apps/web/vitest.config.ts`
// sets no custom `include`, so vitest's default
// `**/*.{test,spec}.?(c|m)[jt]s?(x)` glob applies. A fixtures module named
// `*.test.tsx` with no `it()` in it fails the WHOLE run with "No test suite
// found in file", so this one is deliberately outside that glob — the same
// trick `server/public-site/__tests__/_hub-doc.ts` and
// `scripts/bench/lib/__tests__/_*.ts` use with a leading underscore.
//
// Why not reuse `server/public-site/__tests__/_hub-doc.ts`: that fixture is
// ONE complete document with every nullable populated on one side and null on
// the other, built to make a PARSE do real work. The client suites need the
// opposite — many small documents whose matches vary one axis at a time — so
// this file composes, and hands the result to the real schema on the way out
// so it cannot drift away from a document the product can actually produce.
import {
  CompetitionHubDoc,
  type CompetitionHubDocT,
  type HubDivisionT,
  type HubInfoT,
  type HubMatchT,
  type HubMemberT,
  type HubSuspensionT,
  type KnockoutRoundT,
  type KnockoutViewT,
  type LeaderBoardT,
  type LeaderRowT,
  type TableColumnT,
  type TableRowT,
  type TableViewT,
  type TeamCardT,
} from "@/server/public-site/competition-hub-schema";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import { deriveHubTabs, type MatchBucket } from "@/lib/matches-hub";

const TZ = "Europe/London";
const ORG = "riverside";
const COMP = "autumn-cup";

/** The header shape `match-card.test.tsx`'s own private `hubMatch()` uses,
 *  lifted here so the two suites cannot disagree about what a hub match looks
 *  like. `match-card.test.tsx` is left as it is on purpose: its factory takes
 *  an overrides OBJECT and this one takes positional args, so switching it
 *  over would rewrite ~20 call sites on a merged, reviewed file for no gain. */
function baseHeader(bucket: MatchBucket, overrides: Partial<MatchCentreHeaderT> = {}): MatchCentreHeaderT {
  return {
    live: bucket === "live",
    // Coherent with the bucket by default, so a fixture cannot quietly assert
    // a live card whose header says `scheduled`. `bucketFixture` maps exactly
    // these three the other way.
    status: bucket === "live" ? "in_play" : bucket === "completed" ? "decided" : "scheduled",
    sides: [
      { entrantId: "e1", name: "Blue Blazers", short: "BLZ", colour: null, badgeUrl: null },
      { entrantId: "e2", name: "Queens", short: "QNS", colour: null, badgeUrl: null },
    ],
    scoreLines: [null, null],
    subLines: [null, null],
    battingIndex: null,
    statusLine: null,
    rateLine: null,
    phase: null,
    strength: null,
    pillNote: null,
    metaLine: null,
    updatedAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * One hub match. Positional in the four things a Matches-tab test actually
 * varies — id, bucket, kick-off instant, division — because that is what makes
 * a document readable at the call site:
 *
 *   m("l1", "live", "2026-09-05T11:00:00Z", "t8")
 */
export function m(
  fixtureId: string,
  bucket: MatchBucket,
  scheduledAt: string | null,
  divisionSlug: string,
  over: Partial<Omit<HubMatchT, "header">> & { header?: Partial<MatchCentreHeaderT> } = {},
): HubMatchT {
  const { header: headerOver, ...rest } = over;
  return {
    fixtureId,
    divisionId: `d-${divisionSlug}`,
    divisionSlug,
    divisionName: titleCase(divisionSlug),
    sportKey: "cricket",
    stageName: "League",
    roundNo: 1,
    roundLabel: null,
    bucket,
    tz: TZ,
    scheduledAt,
    venueName: "Riverside Oval",
    courtName: null,
    href: `/${ORG}/${COMP}/${divisionSlug}/fixtures/${fixtureId}`,
    header: baseHeader(bucket, headerOver),
    winnerIndex: null,
    resultLine: null,
    ...rest,
  };
}

/** "sunday" → "Sunday", "sunday-league" → "Sunday League". Division chips and
 *  the Table tab's headings render the NAME, and a standings row renders the
 *  entrant's, so an assertion about a label has something to read.
 *
 *  Task 9 renamed this from `divisionName`: `tableRow` derives an entrant name
 *  the same way, and one helper called by two kinds of caller beats a second
 *  copy of the same five lines under a second name. */
function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Exported so a test can hand `hubDoc` a division that NO fixture belongs to
 *  — the hub document carries every division, including ones drawn but never
 *  scheduled, and that is the shape behind review F2.
 *
 *  `over` was added by Task 10 for ONE axis it could not otherwise vary: the
 *  Info tab formats the competition's calendar DATES in UTC, and this file's
 *  default `tz` is Europe/London, which is UTC+1 in September and therefore
 *  renders the same day whether the zone is right or wrong. A division in a
 *  zone BEHIND UTC is what makes that assertion differential. */
export function division(slug: string, over: Partial<HubDivisionT> = {}): HubDivisionT {
  return {
    id: `d-${slug}`,
    slug,
    name: titleCase(slug),
    sportKey: "cricket",
    sportName: "Cricket",
    status: "active",
    tz: TZ,
    entrantCount: 8,
    formatLine: null,
    variantKey: "t20",
    href: `/${ORG}/${COMP}/${slug}`,
    // What the builder emits for a division with no prose and no bans
    // (division-page parity, 2026-09-16). A test that needs the OLD shape —
    // a cached document from before these fields — deletes them.
    description: null,
    suspensions: [],
    ...over,
  };
}

/** One active ban in a division's list. Name and count are the two things an
 *  Info-tab test varies; the rest defaults to a ban with no public person and
 *  no known team. */
export function suspension(name: string, remaining: number, over: Partial<HubSuspensionT> = {}): HubSuspensionT {
  return { personId: null, name, entrantId: null, entrantName: null, remaining, ...over };
}

/** Every distinct division the given matches and tables belong to, in
 *  first-appearance order. A hub document whose `matches` name a division its
 *  `divisions` array does not carry is not one the builder can produce, so
 *  deriving beats hand-listing them beside the matches at every call site.
 *
 *  Task 9 widened this to `tables` as well, for the same reason it existed for
 *  `matches`: a document with standings and no fixtures is an ordinary
 *  competition (a season whose results were entered in bulk), and deriving its
 *  `divisions` from the matches alone published one with a table for a
 *  division it did not list. Task 8's documents are unaffected — none of them
 *  carries a table, and the two that pass `divisions` explicitly still win.
 *
 *  Task 10 widened it once more, to `leaders` and `teams`, for the third and
 *  fourth time the same reason applies — and that task is also where review
 *  F2's booking comes due, because `InfoTab` is the first component to read
 *  `doc.divisions` alongside another list (it joins `info.calendars` to a
 *  division by href). `stats-teams-info-tabs.test.tsx` now asserts the
 *  derivation directly, so reverting any of the four axes reds.
 *
 *  It is a FIDELITY CONVENTION, not something the schema enforces, and review
 *  F2 is right that this file's "the real schema refuses a drifted fixture"
 *  claim does not extend to it: `CompetitionHubDoc`'s only `superRefine`
 *  checks `tabs`, nothing cross-checks a table's `divisionSlug` against
 *  `divisions`, and `use-live-competition.test.tsx` parses a document with
 *  `divisions: []` beside a table today. The witness above is a test in one
 *  suite, not a rule of the schema. */
function divisionsFor(
  matches: readonly HubMatchT[],
  tables: readonly TableViewT[],
  leaders: readonly LeaderBoardT[],
  teams: readonly TeamCardT[],
): HubDivisionT[] {
  const seen = new Set<string>();
  const out: HubDivisionT[] = [];
  for (const slug of [
    ...matches.map((x) => x.divisionSlug),
    ...tables.map((x) => x.divisionSlug),
    ...leaders.map((x) => x.divisionSlug),
    ...teams.map((x) => x.divisionSlug),
  ]) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(division(slug));
  }
  return out;
}

/** The four columns every standings table in this file carries unless a test
 *  says otherwise: the compact set the phone shows unfolded. Column FOLDING is
 *  `StandingsTableView`'s own behaviour and `standings-table-view.test.tsx`
 *  owns it — a Table-tab test that varied it would be asserting the wrong
 *  component's contract. */
export const COMPACT_COLUMNS: readonly TableColumnT[] = [
  { key: "played", abbr: "P", title: "Played", compact: true },
  { key: "won", abbr: "W", title: "Won", compact: true },
  { key: "lost", abbr: "L", title: "Lost", compact: true },
  { key: "points", abbr: "Pts", title: "Points", compact: true },
];

/**
 * One standings row. Positional in the three things a Table-tab test varies —
 * entrant, rank, and (through `over`) whether this is the crowned row:
 *
 *   tableRow("blue-blazers", 1, { champion: true })
 *
 * `name` is derived from the id so an assertion about a rendered name has
 * something to read; pass it explicitly when the exact string matters.
 */
export function tableRow(
  entrantId: string,
  rank: number | null,
  over: Partial<TableRowT> = {},
): TableRowT {
  return {
    rank,
    entrantId,
    name: titleCase(entrantId),
    badgeUrl: null,
    colour: null,
    // One string per column of `COMPACT_COLUMNS`, in the same order — the
    // view's `cells[i]` IS `columns[i]` and `StandingsTableView` renders them
    // by position, never by key.
    cells: ["2", "2", "0", "6"],
    tieBreakText: null,
    champion: false,
    ...over,
  };
}

/**
 * One table view. Positional in its id and its division, because those are the
 * two axes the Table tab is ABOUT — a division may publish an overall table
 * and one per pool, so the id is not the division's:
 *
 *   tableView("t8-league", "t8", { caption: "League" })
 *
 * `divisionId` is derived from the slug the same way `m()` and `division()`
 * derive theirs, so the same division named across matches, tables and the
 * `divisions` array is ONE division in every list of the document.
 */
export function tableView(
  id: string,
  divisionSlug: string,
  over: Partial<Omit<TableViewT, "id" | "divisionSlug">> = {},
): TableViewT {
  return {
    id,
    divisionId: `d-${divisionSlug}`,
    divisionSlug,
    divisionName: titleCase(divisionSlug),
    caption: "League",
    columns: [...COMPACT_COLUMNS],
    rows: [tableRow("alpha", 1), tableRow("beta", 2)],
    updatedAt: "2026-09-05T12:00:00.000Z",
    // The division's own page, on its standings tab — carried BY the view, so
    // nothing downstream re-derives it.
    //
    // NOT byte-identical to what the builder emits, and the first version of
    // this comment claimed it was (review F4). `competition-hub.ts:584` builds
    // `${divHref}?tab=standings` where `divHref` is `${base}/${d.slug}` and
    // `base` is `/shared/${org}/${comp}` (`:372`, `:440`) — so production
    // hrefs carry a `/shared` prefix these fixtures do not. That is this
    // file's inherited convention rather than Task 9's invention (`m()` and
    // `division()` above, and `server/public-site/__tests__/_hub-doc.ts`, all
    // drop it), so it is left alone here rather than diverged from in one
    // factory. The consequence is bounded and worth stating: an exact-href
    // assertion against this fixture round-trips a fixture literal, not a
    // production URL. It still separates one view's href from another's, which
    // is what those assertions are for.
    fullHref: `/${ORG}/${COMP}/${divisionSlug}?tab=standings`,
    ...over,
  };
}

/**
 * One side of a fixture, for the knockout suites that need two DIFFERENT names
 * on every card (the default header's "Blue Blazers" v "Queens" would make every
 * "goes through" sentence indistinguishable from every other).
 *
 * `entrantId: null` builds a side with NOBODY in it yet — `hubSides`
 * (`competition-hub.ts`) emits exactly that as `entrantId: ""` with the slot
 * sentence as the name, which is how a renderer tells "Winner of QF 3" from a
 * real entrant.
 */
export function koSide(
  name: string,
  entrantId: string | null = name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
): MatchCentreHeaderT["sides"][number] {
  return { entrantId: entrantId ?? "", name, short: "", colour: null, badgeUrl: null };
}

/** One knockout round: its stable key, its pre-resolved label, and the fixture
 *  ids it holds in `seq_in_round` order. */
export function koRound(
  key: string,
  label: string,
  fixtureIds: string[],
  lane: KnockoutRoundT["lane"] = null,
): KnockoutRoundT {
  return { key, label, lane, fixtureIds };
}

/**
 * One knockout view. Positional in the three things the Knockout tab is ABOUT
 * — which stage, which division, and its rounds:
 *
 *   knockoutView("cup", "premier", [koRound("main-1", "Final", ["f1"])])
 *
 * `id` is `${divisionSlug}-${stageId}`, the builder's own shape (plan R3), and
 * `drawable` defaults to TRUE because a regular single-elimination draw is the
 * shape the tab is built for; a test of the non-drawable arm says so.
 */
export function knockoutView(
  stageId: string,
  divisionSlug: string,
  rounds: KnockoutRoundT[],
  over: Partial<Omit<KnockoutViewT, "stageId" | "divisionSlug" | "rounds">> = {},
): KnockoutViewT {
  return {
    id: `${divisionSlug}-${stageId}`,
    divisionId: `d-${divisionSlug}`,
    divisionSlug,
    divisionName: titleCase(divisionSlug),
    stageId,
    stageName: "Cup",
    kind: "knockout",
    rounds,
    drawable: true,
    championFixtureId: null,
    ...over,
  };
}

/**
 * One leader-board row. Positional in the three things a Stats-tab test varies
 * — who, what they are called, and whether they have a player page:
 *
 *   leader("p1", "Arjun Mehta", "/riverside/autumn-cup/players/p1")
 *   leader("p2", "B. R.", null, { masked: true })
 *
 * `masked` is lifted out of `person` and offered at the top level, because the
 * two axes a test varies (the link, and the consent fold) then read on one
 * line. NOTE the two are INDEPENDENT here on purpose: `buildLeaderBoards`
 * never emits `masked: true` with a non-null `personHref`
 * (`leaders.ts:224` — `row.publicProfile && !row.masked`), but the SCHEMA
 * permits it, and `StatsTab` carries its own guard for exactly that reason. A
 * factory that forced `personHref` to null under `masked` would make that
 * guard untestable.
 */
export function leader(
  personId: string,
  name: string,
  personHref: string | null,
  over: Partial<Omit<LeaderRowT, "person">> & { masked?: boolean } = {},
): LeaderRowT {
  const { masked = false, ...rest } = over;
  return {
    person: { personId, name, masked },
    personHref,
    entrantName: "Blue Blazers",
    badgeUrl: null,
    value: "42",
    ...rest,
  };
}

/**
 * One leader board. Positional in the two axes the Stats tab is ABOUT — which
 * division it belongs to, and which counter it ranks:
 *
 *   board("t8", "runs", [leader("p1", "Arjun Mehta", null)])
 *
 * `label` defaults to the stat key title-cased, standing in for what
 * `playerStatLabel` resolves in production — the document carries a
 * pre-resolved string, so the tab renders it and never looks a key up.
 */
export function board(
  divisionSlug: string,
  key: string,
  rows: readonly LeaderRowT[],
  over: Partial<Omit<LeaderBoardT, "divisionSlug" | "key" | "rows">> = {},
): LeaderBoardT {
  return {
    divisionId: `d-${divisionSlug}`,
    divisionSlug,
    divisionName: titleCase(divisionSlug),
    sportKey: "cricket",
    label: titleCase(key),
    ...over,
    key,
    rows: [...rows],
  };
}

/**
 * One team card. Positional in the four things a Teams-tab test varies — who,
 * their name, their badge and their colour, because the crest is a two-armed
 * decision on the last two:
 *
 *   team("e1", "Southend Blue Blazers", "https://x/b.png", null)
 *   team("e2", "Rochford Ramblers CC", null, "#123456")
 *
 * `href` follows this file's inherited convention and DROPS the `/shared`
 * prefix production carries — the same caveat `tableView()` writes up below
 * its own `fullHref`. `competition-hub.ts:608` emits
 * `${base}/${d.slug}?tab=entrants` with `base = /shared/${org}/${comp}`.
 */
export function team(
  entrantId: string,
  name: string,
  badgeUrl: string | null,
  colour: string | null,
  over: Partial<Omit<TeamCardT, "entrantId" | "name" | "badgeUrl" | "colour">> = {},
): TeamCardT {
  const divisionSlug = over.divisionSlug ?? "sunday-league";
  return {
    entrantId,
    divisionId: `d-${divisionSlug}`,
    divisionSlug,
    divisionName: titleCase(divisionSlug),
    name,
    badgeUrl,
    colour,
    seed: null,
    href: `/${ORG}/${COMP}/${divisionSlug}?tab=entrants`,
    // The builder's squad and calendar (division-page parity, 2026-09-16):
    // an empty squad, and the division's .ics filtered to this entrant.
    members: [],
    calendarHref: `/${ORG}/${COMP}/${divisionSlug}/calendar.ics?entrant=${entrantId}`,
    ...over,
  };
}

/** One squad line. Positional in the two things every row has — a name and
 *  (maybe) a number; everything else is an override. */
export function member(name: string, squadNumber: number | null, over: Partial<HubMemberT> = {}): HubMemberT {
  return { personId: null, name, squadNumber, position: null, playerHref: null, suspendedRemaining: null, ...over };
}

/**
 * The competition's Info block. Every field has a default, so a test names
 * only the axis it varies.
 *
 * `calendars` is deliberately NOT derived from `divisions`: the Info tab joins
 * the two by href precisely because nothing in the document guarantees they
 * are index-aligned, and a factory that built one from the other would make
 * that join unwitnessable.
 */
export function info(over: Partial<HubInfoT> = {}): HubInfoT {
  return {
    startsOn: "2026-09-01",
    endsOn: null,
    venues: ["Riverside Oval"],
    registrationOpen: false,
    registerHref: `/${ORG}/${COMP}/register`,
    calendars: [],
    presentHref: `/${ORG}/${COMP}/present`,
    ...over,
  };
}

/** The `.ics` href the builder hangs off a division's own page
 *  (`competition-hub.ts:663-666`), so a test can build a calendar entry that
 *  really does belong to a given division rather than hand-typing the join
 *  the component is being asked to make. */
export function calendarFor(slug: string): { divisionName: string; href: string } {
  return { divisionName: titleCase(slug), href: `${division(slug).href}/calendar.ics` };
}

/**
 * A valid competition hub document.
 *
 * `tabs` is NEVER an override and is never hand-written: `CompetitionHubDoc`
 * carries a `superRefine` that refuses any `tabs` list which is not
 * `deriveHubTabs()`'s own output for that document's contents, so a
 * hand-written one would be rejected by the parse below.
 *
 * `divisions` defaults to the set the given matches and tables belong to; pass
 * it explicitly for the case a division exists with no fixtures.
 *
 * The result goes through the REAL schema on the way out, so a fixture that
 * drifts from the document the builder can produce fails here rather than
 * passing a component test against a shape production never sends.
 */
export function hubDoc(
  over: Partial<Omit<CompetitionHubDocT, "tabs">> = {},
): CompetitionHubDocT {
  const matches = over.matches ?? [];
  const tables = over.tables ?? [];
  const knockouts = over.knockouts ?? [];
  const leaders = over.leaders ?? [];
  const teams = over.teams ?? [];
  const doc = {
    competitionId: "c1",
    orgSlug: ORG,
    competitionSlug: COMP,
    name: "Autumn Cup",
    orgName: "Riverside SC",
    branded: false,
    realtime: true,
    locale: "en",
    generatedAt: "2026-09-05T12:00:00.000Z",
    // ONE default, in `info()` above, rather than a second copy here: Task 10
    // varies this block a field at a time and two literals for one shape is
    // how the two drift.
    info: info(),
    ...over,
    divisions: over.divisions ?? divisionsFor(matches, tables, leaders, teams),
    matches,
    tables,
    knockouts,
    leaders,
    teams,
    tabs: deriveHubTabs({
      matches: matches.length,
      tables: tables.length,
      knockouts: knockouts.length,
      leaderRows: leaders.reduce((n, board) => n + board.rows.length, 0),
      teams: teams.length,
    }),
  };
  return CompetitionHubDoc.parse(doc);
}
