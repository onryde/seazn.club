// Spectator surface W2 — shared factories for the competition-hub CLIENT
// component suites. Task 8 (the Matches tab) is their first consumer; Tasks
// 9-10 (the Table and Stats tabs) will EXTEND this file with `team()`,
// `board()` and `leader()` rather than starting a second copy.
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
    divisionName: divisionName(divisionSlug),
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

/** "sunday" → "Sunday", "sunday-league" → "Sunday League". Division chips
 *  render the NAME, so a test asserting a chip's label has something to read. */
function divisionName(slug: string): string {
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
    name: divisionName(slug),
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

/** Every distinct division the given matches belong to, in first-appearance
 *  order. A hub document whose `matches` name a division its `divisions` array
 *  does not carry is not one the builder can produce, so deriving beats
 *  hand-listing them beside the matches at every call site. */
function divisionsFor(matches: readonly HubMatchT[]): HubDivisionT[] {
  const seen = new Set<string>();
  const out: HubDivisionT[] = [];
  for (const match of matches) {
    if (seen.has(match.divisionSlug)) continue;
    seen.add(match.divisionSlug);
    out.push(division(match.divisionSlug));
  }
  return out;
}

/**
 * A valid competition hub document.
 *
 * `tabs` is NEVER an override and is never hand-written: `CompetitionHubDoc`
 * carries a `superRefine` that refuses any `tabs` list which is not
 * `deriveHubTabs()`'s own output for that document's contents, so a
 * hand-written one would be rejected by the parse below.
 *
 * `divisions` defaults to the set the given matches belong to; pass it
 * explicitly for the case a division exists with no fixtures.
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
    divisions: over.divisions ?? divisionsFor(matches),
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
