// Spectator surface W2 — the competition-hub document schema (design §W2).
// ONE document feeds the competition page's server render, the poll endpoint,
// the division page's slice and every tab. Every number in it is already
// FORMATTED and every name already RESOLVED before it is put here, so the
// client only ever renders: the builder owns the locale, the timezone and the
// sport's vocabulary, and no consumer re-derives any of them.
//
// Same conventions as its W1 sibling `match-centre-schema.ts`, which this file
// builds on: camelCase inside the document even where the wire field carrying
// it is snake_case (the route that serialises the doc owns that, not this
// file), and every user-facing string that is not already resolved travels as
// a `Msg` — a dictionary key plus params, resolved client-side with `t()`.
import { z } from "zod";
import { Msg, Side, Person, MatchCentreHeader } from "./match-centre-schema";
// The tab list is DERIVED, and the refinement at the bottom of this file makes
// that a rule the document must satisfy rather than a comment nobody enforces
// — so the derivation itself is imported instead of restated. `matches-hub.ts`
// is pure and imports nothing, so pulling it in costs this module nothing.
//
// RELATIVE, with the explicit `.ts` extension, matching the reasoning already
// written out at `server/api-v1/schemas.ts:24-28` for its import of this
// file's W1 sibling: that module is shared with the standalone OpenAPI
// generator, which runs under bare `node --experimental-strip-types` with no
// tsconfig `paths` resolution, so a `@/...` specifier throws
// ERR_MODULE_NOT_FOUND there while resolving fine everywhere else. Nothing
// imports THIS file from that script yet; the extension is what keeps that
// from becoming a trap the day something does.
import { deriveHubTabs } from "../../lib/matches-hub.ts";

/** The three lists the Matches hub can show. Restated here as zod because
 *  `lib/matches-hub.ts` — which owns the same vocabulary as a client-safe
 *  VALUE (`MATCH_BUCKETS`) — cannot be the source: every client import of a
 *  `@/server/public-site/*` module in this tree is `import type`, erased at
 *  compile, so a zod value never crosses that boundary. The duplication is
 *  deliberate and `lib/__tests__/matches-hub.test.ts` pins the two equal, so
 *  they cannot drift apart in silence. */
export const MatchBucketSchema = z.enum(["live", "upcoming", "completed"]);
/** Every tab the hub can show, in the order it shows them. Same
 *  two-declarations-one-alarm story as `MatchBucketSchema` above; the
 *  client-safe twin is `HUB_TAB_IDS`. `gallery` is W4's reserved slot — it is
 *  a member of the union so the type is stable when W4 lands, and nothing
 *  emits it yet. */
export const CompetitionHubTabId = z.enum([
  "overview",
  "matches",
  "table",
  "stats",
  "teams",
  "gallery",
  "info",
]);

export const HubDivision = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  sportKey: z.string(),
  sportName: z.string().nullable(),
  /** `DivisionStatus` (`server/api-v1/schemas.ts:60`) — carried as a bare
   *  string, not that enum, so a division whose status vocabulary grows still
   *  parses here rather than failing the whole document. */
  status: z.string(),
  tz: z.string(),
  entrantCount: z.number(),
  /** `describeFormat(cfg)` — a `Msg`, because the format sentence is composed
   *  from the division's own configuration and has to be translated. Null when
   *  the format cannot be described, in which case the renderer falls back to
   *  `variantKey`. */
  formatLine: Msg.nullable(),
  variantKey: z.string(),
  href: z.string(),
});

export const HubMatch = z.object({
  fixtureId: z.string(),
  divisionId: z.string(),
  divisionSlug: z.string(),
  divisionName: z.string(),
  sportKey: z.string(),
  stageName: z.string(),
  roundNo: z.number(),
  /** `roundRoleLabel` — pre-resolved in the ORG's locale by the builder, like
   *  every other already-resolved string in this document. Null when the round
   *  has no role beyond its number. */
  roundLabel: z.string().nullable(),
  bucket: MatchBucketSchema,
  tz: z.string(),
  /** ISO instant, or null when the fixture has no time yet. Day grouping
   *  happens in `tz`, never in the viewer's zone — see `dayKeyInZone`. */
  scheduledAt: z.string().nullable(),
  venueName: z.string().nullable(),
  courtName: z.string().nullable(),
  href: z.string(),
  /** W1's shape, reused whole rather than restated: sides, scoreLines,
   *  subLines, status, statusLine, updatedAt. A hub card and a match-centre
   *  header are the same fact at two sizes, and a second declaration is a
   *  second thing to drift. */
  header: MatchCentreHeader,
  winnerIndex: z.union([z.literal(0), z.literal(1)]).nullable(),
  /** `decidedOutcomeText` — pre-resolved. */
  resultLine: z.string().nullable(),
});

export const TableColumn = z.object({
  key: z.string(),
  abbr: z.string(),
  title: z.string(),
  /** Shown in the narrow (phone) rendering of the table. */
  compact: z.boolean(),
});
export const TableRow = z.object({
  rank: z.number().nullable(),
  entrantId: z.string(),
  name: z.string(),
  badgeUrl: z.string().nullable(),
  /** One formatted string per `TableColumn`, in the same order. Strings, not
   *  numbers: the builder has already applied the locale's number format. */
  cells: z.array(z.string()),
  tieBreakText: z.string().nullable(),
  champion: z.boolean(),
});
export const TableView = z.object({
  id: z.string(),
  divisionId: z.string(),
  divisionSlug: z.string(),
  divisionName: z.string(),
  caption: z.string(),
  columns: z.array(TableColumn),
  rows: z.array(TableRow),
  updatedAt: z.string(),
  fullHref: z.string(),
});

export const LeaderRow = z.object({
  person: Person,
  personHref: z.string().nullable(),
  entrantName: z.string().nullable(),
  badgeUrl: z.string().nullable(),
  /** The formatted value ("412", "8.44"), not the number. */
  value: z.string(),
});
export const LeaderBoard = z.object({
  divisionId: z.string(),
  divisionSlug: z.string(),
  divisionName: z.string(),
  sportKey: z.string(),
  key: z.string(),
  label: z.string(),
  rows: z.array(LeaderRow),
});

export const TeamCard = z.object({
  entrantId: z.string(),
  divisionId: z.string(),
  divisionSlug: z.string(),
  divisionName: z.string(),
  name: z.string(),
  badgeUrl: z.string().nullable(),
  colour: z.string().nullable(),
  seed: z.number().nullable(),
  href: z.string(),
});

export const HubInfo = z.object({
  /** Calendar dates (YYYY-MM-DD), not instants: a competition starts on a day,
   *  not at a moment. */
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  venues: z.array(z.string()),
  registrationOpen: z.boolean(),
  registerHref: z.string(),
  calendars: z.array(z.object({ divisionName: z.string(), href: z.string() })),
  presentHref: z.string(),
});

export const CompetitionHubDoc = z.object({
  competitionId: z.string(),
  orgSlug: z.string(),
  competitionSlug: z.string(),
  name: z.string(),
  orgName: z.string(),
  branded: z.boolean(),
  /** Whether this competition's page polls for updates at all. */
  realtime: z.boolean(),
  /** The locale the builder resolved every pre-resolved string in. */
  locale: z.string(),
  generatedAt: z.string(),
  divisions: z.array(HubDivision),
  matches: z.array(HubMatch),
  tables: z.array(TableView),
  leaders: z.array(LeaderBoard),
  teams: z.array(TeamCard),
  info: HubInfo,
  /** Derived by `deriveHubTabs`, never hand-assembled — enforced by the
   *  refinement below, not merely asserted here. `.min(1)` because Overview
   *  and Info always exist, so an empty tab list would render a hub with no
   *  way into it. */
  tabs: z.array(CompetitionHubTabId).min(1),
}).superRefine((doc, ctx) => {
  // A document that offers a Matches tab beside an empty `matches` array is
  // self-contradictory, and a spectator meets it as a tab that opens on
  // nothing. `deriveHubTabs` is the ONLY thing that may produce this list, so
  // the check is simply "did it". That makes the invariant hold at the seam
  // rather than in whichever builder happens to be written next, and it is a
  // self-consistency check: it cannot fire unless a builder is wrong.
  //
  // Safe to read the fields unguarded — zod 4 skips an object-level refinement
  // entirely when any field failed with `invalid_type` (measured), so `doc`
  // here always has every field at the right type. A field that failed a CHECK
  // (`tabs` failing `.min(1)`, say) does still reach this, which is why the
  // empty-tabs case reports two issues rather than one.
  const expected = deriveHubTabs({
    matches: doc.matches.length,
    tables: doc.tables.length,
    leaderRows: doc.leaders.reduce((n, board) => n + board.rows.length, 0),
    teams: doc.teams.length,
  });
  const same =
    doc.tabs.length === expected.length && doc.tabs.every((t, i) => t === expected[i]);
  if (!same) {
    ctx.addIssue({
      code: "custom",
      path: ["tabs"],
      message:
        `tabs must be deriveHubTabs()'s output for this document's own contents — ` +
        `expected [${expected.join(", ")}], got [${doc.tabs.join(", ")}]`,
    });
  }
});

export type CompetitionHubDocT = z.infer<typeof CompetitionHubDoc>;
export type CompetitionHubTabIdT = z.infer<typeof CompetitionHubTabId>;
export type MatchBucketSchemaT = z.infer<typeof MatchBucketSchema>;
export type HubDivisionT = z.infer<typeof HubDivision>;
export type HubMatchT = z.infer<typeof HubMatch>;
export type TableViewT = z.infer<typeof TableView>;
export type TableRowT = z.infer<typeof TableRow>;
export type TableColumnT = z.infer<typeof TableColumn>;
export type LeaderBoardT = z.infer<typeof LeaderBoard>;
export type LeaderRowT = z.infer<typeof LeaderRow>;
export type TeamCardT = z.infer<typeof TeamCard>;
export type HubInfoT = z.infer<typeof HubInfo>;

// Re-exported so a W2 consumer building a hub document needs one import, not
// two — these are W1's declarations, unchanged, and `match-centre-schema.ts`
// stays their only definition.
export { Side, Person, Msg };
