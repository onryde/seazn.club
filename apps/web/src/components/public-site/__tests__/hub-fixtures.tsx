// Spectator surface W2 — shared factories for the competition-hub CLIENT
// component suites. Task 8 (the Matches tab) is their first consumer; Task 9
// (the Table tab) added `tableView()` and `tableRow()` here rather than
// starting a second copy, and Task 10 (Stats) extends it again with `board()`
// and `leader()`.
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
  type HubMatchT,
  type TableColumnT,
  type TableRowT,
  type TableViewT,
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
 *  scheduled, and that is the shape behind review F2. */
export function division(slug: string): HubDivisionT {
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
  };
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
 *  carries a table, and the two that pass `divisions` explicitly still win. */
function divisionsFor(
  matches: readonly HubMatchT[],
  tables: readonly TableViewT[],
): HubDivisionT[] {
  const seen = new Set<string>();
  const out: HubDivisionT[] = [];
  for (const slug of [...matches.map((x) => x.divisionSlug), ...tables.map((x) => x.divisionSlug)]) {
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
    // What `competition-hub.ts:579` builds: the division's own page, on its
    // standings tab. Carried BY the view, so nothing downstream re-derives it.
    fullHref: `/${ORG}/${COMP}/${divisionSlug}?tab=standings`,
    ...over,
  };
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
    info: {
      startsOn: "2026-09-01",
      endsOn: null,
      venues: ["Riverside Oval"],
      registrationOpen: false,
      registerHref: `/${ORG}/${COMP}/register`,
      calendars: [],
      presentHref: `/${ORG}/${COMP}/present`,
    },
    ...over,
    divisions: over.divisions ?? divisionsFor(matches, tables),
    matches,
    tables,
    leaders,
    teams,
    tabs: deriveHubTabs({
      matches: matches.length,
      tables: tables.length,
      leaderRows: leaders.reduce((n, board) => n + board.rows.length, 0),
      teams: teams.length,
    }),
  };
  return CompetitionHubDoc.parse(doc);
}
