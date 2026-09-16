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
// RELATIVE, with the explicit `.ts` extension, following the reasoning written
// out at `server/api-v1/schemas.ts:24-28`: that module is shared with the
// standalone OpenAPI generator, which runs under bare
// `node --experimental-strip-types` with no tsconfig `paths` resolution, so a
// `@/...` specifier throws ERR_MODULE_NOT_FOUND there while resolving fine
// under tsc, Next and vitest.
//
// Spectator W2 Task 5 — this is the day the comment above used to warn about:
// the OpenAPI generator now imports THIS file (openapi.ts's CompetitionHubDoc
// entry), so the missing extension on this specifier is no longer a
// theoretical gap. Measured: `node --experimental-strip-types
// scripts/openapi-gen.ts` failed with `ERR_MODULE_NOT_FOUND:
// …/public-site/match-centre-schema` before this extension was added.
import { Msg, Side, Person, MatchCentreHeader } from "./match-centre-schema.ts";
// The tab list is DERIVED, and the refinement at the bottom of this file makes
// that a rule the document must satisfy rather than a comment nobody enforces
// — so the derivation itself is imported instead of restated. `matches-hub.ts`
// is pure and imports nothing, so pulling it in costs this module nothing.
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
  "knockout",
  "stats",
  "teams",
  "gallery",
  "info",
]);

/** An active ban, as the Info tab lists it under its division.
 *
 *  Carries WHO — the person and the entrant — so a consumer never has to match
 *  a masked name against a roster to know which member it means (two "Arun
 *  K." on two teams are two people). The Teams card does not match at all: the
 *  builder resolves the tag onto `HubMember.suspendedRemaining` by the internal
 *  person id, which never enters this document. */
export const HubSuspension = z.object({
  /** The person's PUBLIC id — present only where `public_entrants_v` would
   *  publish it (public-name consent plus the player-profile entitlement) and
   *  the division's name policy shows the name in full; null otherwise, and
   *  null for a suspended person who is not on the entrant's current roster.
   *  A person id beside a masked name is a player page one URL away. */
  personId: z.string().nullable(),
  /** Through `resolvePersonDisplayName` (RS008) against the division's policy
   *  — the same string that person carries in their team's squad. */
  name: z.string(),
  /** Null when the ban names no entrant (`suspensions.entrant_id` is
   *  nullable, and `on delete set null`). */
  entrantId: z.string().nullable(),
  /** The entrant's masked display name; null when there is no entrant or it
   *  is not one a spectator can see. */
  entrantName: z.string().nullable(),
  remaining: z.number().int(),
});

/** One squad member on a Teams card, in the division page's own roster order
 *  (`public_entrants_v`: squad number, numberless last, then full name). */
export const HubMember = z.object({
  /** Same rule as `HubSuspension.personId`: public, or null. */
  personId: z.string().nullable(),
  /** Already masked (`maskPublicEntrantNames`). Never blank. */
  name: z.string(),
  squadNumber: z.number().nullable(),
  /** The sport's RAW position key ("GK", "WK") — the division page renders
   *  it raw too. No position dictionary exists in any locale; the engine's
   *  `PositionGroup.name` is English-only. */
  position: z.string().nullable(),
  /** The player page, ONLY where the name is shown in full and the view
   *  published the person's id — a masked name never links. */
  playerHref: z.string().nullable(),
  /** Matches left on this member's ACTIVE ban in this division, or null. */
  suspendedRemaining: z.number().int().nullable(),
});

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
  /** The division's organiser prose as SANITISED HTML — `renderProse`'s
   *  output, never raw Markdown, rendered with `CompetitionProse` exactly as
   *  the division page renders the same column. Null when there is none.
   *
   *  OPTIONAL, with `suspensions` below and `TeamCard.members`/`calendarHref`,
   *  for `byeSides`' reason and a longer window: the hub API answers
   *  `s-maxage=30, stale-while-revalidate=300` (`PUBLIC_CACHE_CONTROL`), so a
   *  spectator's new bundle can poll a document built before these fields
   *  existed for minutes after a deploy. Absent reads as none. */
  description: z.string().nullable().optional(),
  /** Active bans in this division, sorted by name. Empty when none — and
   *  empty, never an error, when the discipline read fails. */
  suspensions: z.array(HubSuspension).optional(),
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
  /** `[home, away]`: true where that side is a BYE — the draw left the slot
   *  empty for good (no entrant, and the stored `bracket.slot.bye` slot label
   *  `stages.ts` writes), as opposed to a slot still waiting on a result. The
   *  card draws a bye's crest as an empty box and a waiting side's as "?".
   *  Optional because a hub document cached before the field existed (Redis
   *  15s, ISR 30s) reaches the client without it — absent reads as "no bye". */
  byeSides: z.tuple([z.boolean(), z.boolean()]).optional(),
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
  /** The entrant's own colour, for `EntityLogo`'s painted tile. Absent until
   *  now, which is why the same club read as a coloured tile on the Teams tab
   *  and a grey one in the standings table one tab away — `entity-logo.tsx`
   *  records that as knowingly deferred. */
  colour: z.string().nullable(),
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

/** The stage kinds a knockout view is published for. Restated from
 *  `BRACKET_KINDS` (`./champion.ts`), which is a `ReadonlySet<string>` and so
 *  cannot seed an enum without losing its literal members;
 *  `competition-hub-schema.test.ts` pins the two equal, in order. */
export const KnockoutKind = z.enum(["knockout", "double_elim", "stepladder", "page_playoff"]);

export const KnockoutRound = z.object({
  /** `${lane ?? "main"}-${roundNo}`, or `third-place` for the bronze match's
   *  own round. When two rail rounds share a lane and `roundNo` — a page
   *  playoff's Qualifier 1 and Eliminator both play round 1 — each takes its
   *  first match's `seq_in_round` as a third part: `main-1-1`, `main-1-2`.
   *  Every other bracket keeps the two-part key, so a consumer must not parse
   *  a round number out of the key by position. Stable across polls, so a
   *  round a spectator picked survives the next document. */
  key: z.string(),
  /** The round's name, pre-resolved in the ORG's locale — the same string
   *  every match in the round already carries as `HubMatch.roundLabel`,
   *  reused by the builder rather than resolved a second time. */
  label: z.string(),
  lane: z.enum(["WB", "LB", "GF"]).nullable(),
  /** `HubMatch.fixtureId`s in `seq_in_round` order. IDS, not copies: the cards
   *  are `matches` rows, and the refinement below refuses an id that names no
   *  match in this document. */
  fixtureIds: z.array(z.string()).min(1),
});

export const KnockoutView = z.object({
  /** `${divisionSlug}-${stageId}`. */
  id: z.string(),
  divisionId: z.string(),
  divisionSlug: z.string(),
  divisionName: z.string(),
  stageId: z.string(),
  stageName: z.string(),
  kind: KnockoutKind,
  /** Bracket order: lane (single or winners, then losers, then grand final),
   *  then round; the third-place round sits immediately before the final
   *  round. `.min(1)` because a bracket stage with no fixtures publishes no
   *  view at all. */
  rounds: z.array(KnockoutRound).min(1),
  /** Whether a one-sided Draw tree can be drawn: a `knockout` stage whose
   *  fixtures the engine's `twoSidedBracket` — the repo's one authority on a
   *  regular single-elimination shape — lays out. */
  drawable: z.boolean(),
  /** The fixture that crowns the stage, from `bracketChampion` (`./champion.ts`)
   *  — the same rule `divisionChampion` crowns with: the latest-round final
   *  that is settled (decided, finalized or forfeited) with a winner, withheld
   *  while an owed grand-final reset is unplayed. Null until then. */
  championFixtureId: z.string().nullable(),
});

export const LeaderRow = z.object({
  person: Person,
  personHref: z.string().nullable(),
  entrantName: z.string().nullable(),
  badgeUrl: z.string().nullable(),
  // NO `colour` here yet, deliberately, and the asymmetry with `TableRow`
  // above is the point: the standings table's colours were one map away (the
  // hub already builds `colours` for the fixture sides), while a leader row's
  // entrant colour is not read at all — `public-leaders.ts` selects
  // `team_display->>'logo_path'` and nothing beside it. Closing this half is a
  // query change in that reader, not a field here, and a required field
  // nothing populates is worse than an absent one.
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
  /** The division page's Entrants tab. The Teams card no longer LINKS here
   *  (it opens in place, 2026-09-16); kept because the redirect that retires
   *  the division page decides where this points, and has not been signed
   *  off. Optional-shaped fields below: see `HubDivision.description`. */
  href: z.string(),
  /** The squad, from the same masked entrant read as `name`. */
  members: z.array(HubMember).optional(),
  /** This entrant's own calendar: the division `.ics` route with its
   *  `?entrant=` filter, which also carries every still-unresolved fixture in
   *  the division (the route's own owner ruling, 2026-08-24). */
  calendarHref: z.string().optional(),
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

/**
 * ⚠️ THIS SCHEMA CARRIES A REFINEMENT (see `.superRefine` at the bottom), and
 * zod 4 forbids three kinds of schema surgery on a refined object. All three
 * throw at RUNTIME, with no compile-time signal at all — measured against this
 * exact schema on zod 4.4.3:
 *
 *     CompetitionHubDoc.pick({ … })     → Error: .pick() cannot be used on
 *     CompetitionHubDoc.omit({ … })     →   object schemas containing
 *     CompetitionHubDoc.partial()       →   refinements
 *
 * `.shape` and `.extend()` are fine — and `.extend()` carries the refinement
 * forward into the extended schema, which is verified rather than assumed.
 *
 * So: to name a SUBSET of this document, derive from the inferred TYPE
 * (`Pick<CompetitionHubDocT, "matches" | "tabs">`), never from the schema
 * object. Tasks 2–17 consume `CompetitionHubDocT`, so this should not bite —
 * but it would bite at request time rather than at build time, which is why it
 * is stated here at the declaration instead of only in the refinement's own
 * comment. The trade was made deliberately: enforcing the tab invariant is
 * worth more than schema-surgery ergonomics.
 */
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
  /** One per bracket stage with fixtures, division order then stage `seq`. */
  knockouts: z.array(KnockoutView),
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
  //
  // ONE CONSEQUENCE, DELIBERATE: demanding exact equality with
  // `deriveHubTabs`'s output makes the reserved `gallery` id UNPARSEABLE. It is
  // a member of `CompetitionHubTabId` so the union is stable, but nothing may
  // emit it while `deriveHubTabs` does not — its widest possible output is
  // [overview, matches, table, knockout, stats, teams, info]. That is correct for W2,
  // which never produces a gallery. **W4 owns lifting it**, and lifting it
  // means extending `HubTabCounts` and `deriveHubTabs` in `lib/matches-hub.ts`
  // so the tab is DERIVED like every other one — not hand-adding it to a
  // document's `tabs` array, which this refinement will refuse. A strict rule
  // W4 must consciously extend is the point; a lax one would let a wrong tab
  // list through for every wave in between.
  const expected = deriveHubTabs({
    matches: doc.matches.length,
    tables: doc.tables.length,
    knockouts: doc.knockouts.length,
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

  // A knockout view carries fixture IDS; its cards are `matches` rows. An id
  // naming no match is a round that renders a hole, and a champion id naming
  // no match is a banner with nobody in it — both self-contradictions only a
  // wrong builder can produce, refused here at the exact round (or view) so
  // the message points at it instead of at "the document".
  const matchIds = new Set(doc.matches.map((m) => m.fixtureId));
  doc.knockouts.forEach((view, i) => {
    view.rounds.forEach((round, j) => {
      const missing = round.fixtureIds.filter((id) => !matchIds.has(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["knockouts", i, "rounds", j, "fixtureIds"],
          message: `knockout round ${round.key} names fixtures that are not in matches: ${missing.join(", ")}`,
        });
      }
    });
    if (view.championFixtureId !== null && !matchIds.has(view.championFixtureId)) {
      ctx.addIssue({
        code: "custom",
        path: ["knockouts", i, "championFixtureId"],
        message: `championFixtureId ${view.championFixtureId} is not in matches`,
      });
    }
  });
});

export type CompetitionHubDocT = z.infer<typeof CompetitionHubDoc>;
export type CompetitionHubTabIdT = z.infer<typeof CompetitionHubTabId>;
export type MatchBucketSchemaT = z.infer<typeof MatchBucketSchema>;
export type HubDivisionT = z.infer<typeof HubDivision>;
export type HubMatchT = z.infer<typeof HubMatch>;
export type TableViewT = z.infer<typeof TableView>;
export type TableRowT = z.infer<typeof TableRow>;
export type TableColumnT = z.infer<typeof TableColumn>;
export type KnockoutKindT = z.infer<typeof KnockoutKind>;
export type KnockoutRoundT = z.infer<typeof KnockoutRound>;
export type KnockoutViewT = z.infer<typeof KnockoutView>;
export type LeaderBoardT = z.infer<typeof LeaderBoard>;
export type LeaderRowT = z.infer<typeof LeaderRow>;
export type TeamCardT = z.infer<typeof TeamCard>;
export type HubMemberT = z.infer<typeof HubMember>;
export type HubSuspensionT = z.infer<typeof HubSuspension>;
export type HubInfoT = z.infer<typeof HubInfo>;

// Re-exported so a W2 consumer building a hub document needs one import, not
// two — these are W1's declarations, unchanged, and `match-centre-schema.ts`
// stays their only definition.
export { Side, Person, Msg };
