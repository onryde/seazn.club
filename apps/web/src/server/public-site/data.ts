import "server-only";
// Public dashboard read model (doc 09, PROMPT-12). Every query goes through
// the consent-filtered public_*_v views ONLY — no auth'd query path exists in
// these pages. Caching is Next's tag-based data cache (unstable_cache; this
// Next version's pre-cacheComponents model, see
// node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md):
// competition/division reads revalidate every 30 s, player reads every 300 s
// (doc 09 §3), and the same service-layer writes that publish realtime fire
// `revalidateTag('division:{id}')` for instant refresh (see usecases/scoring.ts).
import { unstable_cache } from "next/cache";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { hasFeature } from "@/lib/entitlements";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { isoDateTime, sortOrgHomeCompetitions } from "@/lib/public-site";
import { resolveVenueTz } from "@/lib/tz";
import { venueTzRow } from "@/server/venue-tz";
import { buildCourtDirectory } from "@/lib/court-directory";
import { labelPlayerStats, groupCareerStatsBySport, type CareerSportStats } from "@/server/player-stats";
// The DB-touching "matches" counter — NOT the pure module above (same name,
// different file). Shared with personCareerStats/countMatchesByDivision
// (usecases/player-stats.ts) and me.ts's listMyCareerStats, review round 2
// finding 2.
import { countMatchesByDivision } from "@/server/usecases/player-stats";
import { toLocale, type Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { z } from "zod";
import type { StageKind } from "@/server/api-v1/schemas";
import { anyOptedOut, isPersonNameMasked, resolvePersonDisplayName } from "@/lib/name-display";
import { loadMatchCentre } from "./match-centre-load";
import { variantLabel } from "./variant-label";
import type { MatchCentreDocT } from "./match-centre-schema";
import type { PlayerMatchLine, PlayerUpcomingRow } from "./public-player-matches";

/**
 * `{count}`-pluralized org-default-locale copy — the `public-site/data.ts`
 * twin of `lib/i18n-runtime.ts`'s `plural()`, built on `msgFor` instead of a
 * `Dict`+`Locale` pair because this file deliberately never resolves the
 * REQUEST locale (see `statMsg`'s own comment inside getPublicPlayer: reading
 * cookies()/headers() here would opt this ISR route out of static
 * rendering). Same authored-key convention as `plural()`
 * (`"<key>.one"`/`"<key>.other"`, `{count}` always available to interpolate)
 * — en/es/fr/nl are all simple two-category locales for `Intl.PluralRules`,
 * so every key this calls must author both categories.
 */
function pluralStatMsg(locale: Locale, key: string, count: number): string {
  const category = new Intl.PluralRules(locale).select(count);
  return msgFor(locale, `${key}.${category}` as MessageKey, { count });
}

/** timestamptz → ISO string before rows cross into client components. */
const normalizeFixture = <T extends { scheduled_at: unknown }>(f: T): T => ({
  ...f,
  scheduled_at: isoDateTime(f.scheduled_at),
});

/**
 * Final-review fix F1 — the same timestamptz normalisation as
 * {@link normalizeFixture}, for `public_standings_v.updated_at`.
 *
 * `db.ts`'s date-type override only patches OID 1082 (`date`); postgres.js's
 * default handler still owns OID 1184 (`timestamptz`) and parses it to a JS
 * `Date` (`mergeUserTypes` merges by OID). `PublicStandings.updated_at` is
 * declared `string`, and `competition-hub.ts:591` forwards this field
 * unchanged into `TableView.updatedAt` (`z.string()`) — so without this, the
 * declaration is a lie and the hub document fails schema validation. NOT
 * NULL at the schema (`V218__standings_snapshots.sql`), so the non-null
 * assertion matches the column's own constraint rather than assuming it.
 */
const normalizeStandings = (s: PublicStandings): PublicStandings => ({
  ...s,
  updated_at: isoDateTime(s.updated_at)!,
});

/**
 * P9 cutover: `venue_name`/`court_name` DERIVED from `venues`/`courts` via
 * `fixtures.venue_id`/`court_id`. `public_fixtures_v` (db/migration) is a
 * hand-maintained column list that has not been extended with the two id
 * columns, so this queries the base `fixtures` table directly — scoped to
 * exactly the ids the caller already fetched through the view (never a
 * wider row set than the view already authorized) — rather than editing
 * the view. Mirrors the view's own per-row "setup" redaction (`case when
 * d.status = 'setup' then null else f.venue end`, V369) by joining
 * `divisions` itself instead of taking a caller-supplied status — a batch
 * can span more than one division (not true of the two callers in THIS
 * file today, but true of `usecases/public.ts`'s `publicFixture`, which has
 * no division context of its own), and this way nobody can pass the wrong
 * one.
 *
 * `court_name` is resolved through {@link buildCourtDirectory} (P9 pass
 * 3d/4d, `lib/court-directory.ts`) — the SAME "Name (Venue)" disambiguation
 * the schedule board / AI pack / court picker already use (a court name is
 * unique only WITHIN its venue — `courts_venue_name_active_idx` — so two
 * venues may legally each name one "Court 1"). The directory is built
 * ORG-WIDE (every court belonging to the same org(s) as the fixtures in
 * this batch, not just the courts this particular batch happens to
 * reference) so a court's label can never flip depending on which OTHER
 * fixtures were queried alongside it — this is also why
 * `withCourtVenueName`'s single-fixture form still disambiguates correctly
 * with nothing else in its "batch" to compare against. This file reads a
 * SUPERUSER connection (no `current_org_id()` RLS context — unlike
 * `usecases/schedule.ts`'s `courtNamesById`, which can rely on RLS for its
 * org scope), so the `org_id` filter below is a hard tenant-isolation
 * requirement, not an optimization: dropping it would leak every OTHER
 * org's court/venue names into this org's disambiguation. Do not write a
 * second ambiguity rule.
 */
export async function withCourtVenueNames<T extends { id: string }>(
  fixtures: T[],
): Promise<(T & { venue_name: string | null; court_name: string | null })[]> {
  if (fixtures.length === 0) return [];
  const rows = await sql<
    {
      id: string;
      court_id: string | null;
      org_id: string;
      division_status: string;
      venue_name: string | null;
      court_name: string | null;
    }[]
  >`
    select f.id, f.court_id, f.org_id, d.status as division_status,
           ven.name as venue_name, crt.name as court_name
    from fixtures f
    join divisions d     on d.id = f.division_id
    left join courts crt on crt.id = f.court_id
    left join venues ven on ven.id = f.venue_id
    where f.id in ${sql(fixtures.map((f) => f.id))}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Setup-redacted rows contribute nothing worth disambiguating — skip
  // their org rather than pulling it into the directory query for a
  // result that gets nulled back out below anyway.
  const orgIds = [...new Set(rows.filter((r) => r.division_status !== "setup").map((r) => r.org_id))];
  const directoryRows = orgIds.length
    ? await sql<{ id: string; name: string; venue_name: string; tags: string[] }[]>`
        select crt.id, crt.name, ven.name as venue_name, crt.tags
        from courts crt
        join venues ven on ven.id = crt.venue_id
        where crt.org_id in ${sql(orgIds)}
        order by ven.name, crt.name, crt.id`
    : [];
  const directory = buildCourtDirectory(directoryRows);
  return fixtures.map((f) => {
    const r = byId.get(f.id);
    if (!r || r.division_status === "setup") {
      return { ...f, venue_name: null, court_name: null };
    }
    const court_name = r.court_id ? (directory.get(r.court_id)?.label ?? r.court_name ?? null) : null;
    return { ...f, venue_name: r.venue_name, court_name };
  });
}

/** Single-fixture sibling of {@link withCourtVenueNames} — same derivation
 *  and redaction, no array dance at the call site. */
export async function withCourtVenueName<T extends { id: string }>(
  fixture: T,
): Promise<T & { venue_name: string | null; court_name: string | null }> {
  const [withNames] = await withCourtVenueNames([fixture]);
  return withNames!;
}

export const REVALIDATE_FAST = 30; // competition / division / fixture pages
export const REVALIDATE_SLOW = 300; // entrant / player pages

export const divisionTag = (divisionId: string) => `division:${divisionId}`;
export const competitionTag = (competitionId: string) => `competition:${competitionId}`;
export const orgTag = (orgSlug: string) => `org-public:${orgSlug}`;
/** One person's public card entries — at every competition URL, allowed or
 *  refused. Fired by every write to what a card shows about them
 *  (`firePersonRevalidate`); nothing else carries it. */
export const personTag = (personId: string) => `pub-person:${personId}`;

/** Next keeps at most this many tags on one cache entry and drops the rest
 *  with nothing but a console line (`validateTags`, next/dist/lib/constants).
 *  Pinned against Next's own value by the person-writes revalidate suite. */
export const NEXT_CACHE_TAG_MAX_ITEMS = 128;

/** The player card's entry tags: `fixed`, then one division tag per id IN THE
 *  ORDER GIVEN, never more than Next keeps (review r2-m3). Past the cap the
 *  LAST ids are dropped, with a warning: a score in a dropped division then
 *  reaches the card only through the competition tag, which a score makes
 *  stale, not expired, so that card is served stale once. The caller orders the
 *  person's own divisions first, so what is dropped is a division the person
 *  plays no match in. */
export function playerCardTags(
  fixed: string[],
  orderedDivisionIds: string[],
  context: { competitionId: string; personId: string },
): string[] {
  const room = NEXT_CACHE_TAG_MAX_ITEMS - fixed.length;
  if (orderedDivisionIds.length > room) {
    log.warn(
      { ...context, divisions: orderedDivisionIds.length, kept: room },
      "player card: the competition has more divisions than one cache entry can carry tags for; a score in a dropped division serves this card stale once",
    );
  }
  return [...fixed, ...orderedDivisionIds.slice(0, room).map(divisionTag)];
}
/** One shared tag for every discovery surface (doc 15, PROMPT-19). */
export const DISCOVERY_TAG = "discovery";

export type Visibility = "public" | "unlisted";

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
  branded: boolean; // dashboard.branding (enterprise) — removable seazn footer + OG badge
  /** Org brand color blob — emptied in-query without dashboard.theme (V397).
   *  A DIFFERENT key from `branded` above; see loadOrg's note. */
  branding: unknown;
  /** Resolved logo URL — null without the branding entitlement or a logo. */
  logo: string | null;
  /** Org "about" Markdown (v3/06 §2) — render via lib/prose only. */
  about: string | null;
  /** Spectator-facing locale for this org's public pages (v5 i18n §4). Drives
   *  the page language for every visitor, keeping the page ISR-cacheable (it's
   *  a function of the org, not the request). */
  default_locale: string;
  /** Live card intake (Connect charges enabled) — gates the Stripe trust
   *  line in the public footer so cash-only orgs never claim card security. */
  card_payments: boolean;
}

export interface PublicCompetition {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_on: string | null;
  ends_on: string | null;
  branding: Record<string, unknown>;
  status: string;
  visibility: Visibility;
}

export interface PublicDivision {
  id: string;
  competition_id: string;
  name: string;
  slug: string;
  /** Organiser Markdown (v3/06 §2) — render via lib/prose only. */
  description: string | null;
  sport_key: string;
  variant_key: string;
  status: string;
  module_version: string;
  tiebreakers: string[] | null; // override cascade; null = sport default
  sport_name: string | null;
  entrant_count: number;
  /** RS008 review fix #5 — this division's own youth/player_name_display
   *  policy, joined from the base `divisions` table (public_divisions_v does
   *  NOT expose these — appending them to that widely-read view was a wider
   *  blast radius than needed for a two-column, single-query join). Feeds
   *  `maskPublicEntrantNames` below, wherever this division's entrants are
   *  read. Optional so a caller that predates this field (a hand-built test
   *  fixture) still type-checks; every real query that builds a
   *  `PublicDivision` now selects both. */
  youth?: boolean;
  player_name_display?: string | null;
  /** W2 Task 4 — the division's own `divisions.config` jsonb, joined from the
   *  base table for the same reason `youth`/`player_name_display` are:
   *  `public_divisions_v` does not expose it and widening that widely-read
   *  view costs more than a primary-key join. `describeFormat` parses it
   *  through the division's PINNED module's `configSchema` to build the hub's
   *  format sentence ("8 overs", "Best of 5"). `unknown`, not a typed cfg:
   *  the shape is the sport module's and this file resolves no modules.
   *  Optional so a hand-built `PublicDivision` in an existing test still
   *  type-checks — every real query that builds one now selects it. */
  config?: unknown;
  /** T16b fix round 3 — `sport_variants.name` for this division's variant
   *  (this org's own row over the system row), the FALLBACK `variantLabel`
   *  prints only for a variant `VARIANT_LABEL_KEYS` does not name. Optional
   *  for the same hand-built-fixture reason as the fields above. */
  variant_name?: string | null;
}

export interface PublicFixture {
  id: string;
  division_id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null (V360's fixtures.home/away_slot_label, exposed on
   *  public_fixtures_v by V362). */
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  scheduled_at: string | null;
  /** LEGACY, read-only — frozen since the P9 venues/courts cutover (pass
   *  3a). Nothing writes these any more; use `venue_name`/`court_name`
   *  below for display. Kept on the type only because `public_fixtures_v`
   *  (db/migration, a hand-maintained column list) still selects them and
   *  the view's own per-row "setup" redaction targets these columns. */
  venue: string | null;
  court_label: string | null;
  /** P9 cutover: DERIVED from `venues`/`courts` via `fixtures.venue_id`/
   *  `court_id` — resolved by a SEPARATE query in this file (the view above
   *  has not been extended with the two id columns), mirroring the view's
   *  own "setup" redaction so nothing about an unreleased division's court
   *  assignment leaks ahead of `venue`/`court_label` above. Render THESE,
   *  never `venue`/`court_label`. */
  venue_name: string | null;
  court_name: string | null;
  status: string;
  // R3.5/Task G — widened from `{ kind?; winner? }`. The SELECT below (and
  // liveNow's/getPublicDivision's) already reads the whole `outcome` JSONB
  // column — this type was just under-declaring what was already arriving at
  // runtime (the same class of gap this file's own "lane/is_final" comment
  // flags above), so `method`/`loser` reached nobody. `method` is what lets a
  // decided fixture say HOW it was decided (decidedOutcomeText,
  // lib/scoring-vocab.ts); `loser` isn't consumed yet but costs nothing to
  // declare accurately since it is the same MatchOutcome shape either way.
  outcome: { kind?: string; winner?: string; loser?: string; method?: string } | null;
  summary: {
    headline?: string;
    perSide?: { entrantId: string; line: string }[];
    detail?: unknown;
  } | null;
  last_seq: number | null;
  /** F1 (2026-08-17): the engine's bracket-position role, exposed on
   *  public_fixtures_v by V369. `lane` is null for single-lane brackets and
   *  non-bracket stages. postgres.js's `sql<T>` generic is an assertion,
   *  not derived from the query text — every explicit SELECT against this
   *  view that returns `PublicFixture[]` must list these four by hand or
   *  they silently read `undefined` at runtime despite the TS type (the
   *  exact trap `home_slot_label`/`away_slot_label` hit at V362, per
   *  usecases/public.ts's "Fix round 3 (Gap 9)" comment). Optional, not
   *  because a real row can lack one, but because pre-existing tests build
   *  a `PublicFixture` literal by hand that predates these four fields
   *  (e.g. public-site/__tests__/schedule.test.tsx's own `F()` helper) —
   *  same convention ScheduleSolverInfo's later fields already established. */
  lane?: "WB" | "LB" | "GF" | null;
  is_final?: boolean;
  third_place?: boolean;
  conditional?: boolean;
  /** The generator's stable id (`fixtures.ext_key`, e.g. "pp-q1"). `roundRole`
   *  reads it to tell a page playoff's Qualifier 1 from its Eliminator, which
   *  share a round and a match count (fix round 1, M3). NOT a column of
   *  `public_fixtures_v`: `getPublicDivision` selects it as a subquery on the
   *  view row's own id. Optional, same convention as the four fields above. */
  ext_key?: string | null;
  /** The bracket FEED EDGES — which fixture this one's winner/loser walks into,
   *  and into which seat (`fixtures.winner_to_*` / `loser_to_*`, V214).
   *
   *  WHY A PUBLIC SURFACE NEEDS THEM. `publicSlotLabel` turns a STORED
   *  `slot.winner_match` into "Winner of Semi-finals, match 1". A
   *  `timing: "setup"` progression bracket deliberately stores NO label on a
   *  sibling-fed seat (`generateProgressionSetupFixtures` —
   *  `stageOwesDraw`/`awaitsSeedDraw` read "no label ⇒ sibling-fed"), so the
   *  feed edges are the only record of who feeds it. Without them a spectator
   *  read "TBD" on the very match an organiser was shown as
   *  "Winner of R1·1" — the same defect the desk side fixed, one surface over.
   *
   *  NOT columns of `public_fixtures_v`: read as a join on the view row's own
   *  id, exactly as `ext_key` above is, so the VIEW still decides which rows
   *  exist and no visibility rule is bypassed. Optional for the same reason
   *  the four `lane`/`is_final` fields are — hand-built `PublicFixture`
   *  literals in older tests predate them — and, as that comment warns, every
   *  explicit SELECT that returns `PublicFixture[]` must list them by hand or
   *  they read `undefined` at runtime despite the TS type. */
  winner_to_fixture?: string | null;
  winner_to_slot?: number | null;
  loser_to_fixture?: string | null;
  loser_to_slot?: number | null;
  /** The club's own broadcast link (V401). Null unless an organiser saved one,
   *  and null for a `setup` division — the view redacts it alongside the
   *  schedule. Rendered ONLY as an `<a href target="_blank" rel="noopener">`
   *  (R16); never an iframe, never fetched.
   *
   *  Optional, same convention (and reason) as lane/is_final/third_place/
   *  conditional just above: pre-existing tests build a `PublicFixture`
   *  literal by hand (schedule.test.tsx's `F()` helper and its four other
   *  callers) that predates this field — `tsc --noEmit` reds five files if
   *  this is made required, verified by trying it. */
  stream_url?: string | null;
}

export interface PublicStage {
  id: string;
  division_id: string;
  seq: number;
  /** Every stage kind a division can generate, from the API's own `StageKind`
   *  enum (N1e e4). It was a hand-written list of six that missed
   *  `page_playoff`, `americano` and `ladder`: the kind is a database string
   *  with no parse, so runtime was right while every reader needed a cast. */
  kind: z.infer<typeof StageKind>;
  name: string;
  status: string;
  /** V414 — the forecastable qualification cut (null = none: no destination,
   *  or anything short of one clean cut); see `stage_qualification_meta`. */
  qualify_count: number | null;
  /** V414 — the cut counts per pool (`topNPerGroup`), not overall. */
  qualify_per_group: boolean;
  /** V414 — the destination stage the cut feeds, or null with no cut. */
  next_stage_name: string | null;
  /** V414 — a swiss stage's declared round count, else null. */
  swiss_rounds: number | null;
  /** V414 — the stage's own PointsRule jsonb, or null (sport points apply). */
  points_rule: unknown;
  /** V414 (ruling M1) — the organiser pinned ranks on this stage
   *  (`config.rank_overrides`). NOT the same as a row's `rankLocked`, which
   *  the engine also sets on every tie it settles by lots. */
  has_rank_overrides: boolean;
  /** Per-stage match rules (design 2026-09-17 §D3/T7): the stage's own
   *  `config.rules` FRAGMENT — `{bestOf: 1, setTo: 15}`, never a materialised
   *  config; null/absent means the stage plays the division's format. Read off
   *  `stages` by the VIEW row's id (the view keeps the rest of `config`
   *  private), and ONLY this key, so progression and cross-feeds stay
   *  unpublished. The hub's `stageFormatLines` and the division page's stage
   *  chips describe it through `stage-format-lines.ts`. Optional so a
   *  hand-built `PublicStage` in an existing test still type-checks. */
  rules?: unknown;
}

export interface PublicStandings {
  stage_id: string;
  pool_id: string | null;
  rows: StandingsSnapshotRow[];
  updated_at: string;
}

// The engine's StandingsRow as persisted in standings_snapshots (JSON).
export interface StandingsSnapshotRow {
  entrantId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics: Record<string, number>;
  rank?: number;
  rankLocked?: boolean;
  tieBreak?: { key: string; with: string[] };
}

export interface PublicEntrantMember {
  name: string;
  /** Null without photo consent — and null whenever the division's name
   *  policy masks this member (`maskPublicEntrantNames`). */
  photo: string | null;
  /** Null = no player card: no public-name consent, OR the division's name
   *  policy masks this member (`maskPublicEntrantNames` withholds the id, which
   *  is the card's URL — the card would otherwise undo the mask). */
  person_id: string | null;
  squad_number: number | null;
  position: string | null;
}

export interface PublicEntrant {
  id: string;
  division_id: string;
  kind: string;
  display_name: string;
  seed: number | null;
  status: string;
  members: PublicEntrantMember[];
  /** Effective badge block from team_display_v (team → club fallback);
   *  null for individual/pair entrants (v3/03 §5). */
  team_display?: {
    club_id: string | null;
    club_name: string | null;
    logo_path: string | null;
    colors: unknown;
  } | null;
  /** PROMPT-60: the entrant's own crest — wins over team_display.logo_path. */
  badge_url?: string | null;
  /** RS008 review fix #5 — true when ANY current roster member of this
   *  (non-team) entrant has explicitly opted out of a public name. Set by
   *  `maskPublicEntrantNames` alongside its own `display_name` masking;
   *  never present before that function runs. Exposed (rather than kept
   *  purely internal) so `buildPublicDivisionSlides`'s own independent
   *  masking pass (fix #2) gets a REAL, live signal via the `{...data}`
   *  spread the two /present page.tsx files already do — re-masking an
   *  already-masked name is a safe no-op (resolvePersonDisplayName is
   *  idempotent under re-application). */
  opted_out?: boolean;
}

export interface PublicPlayer {
  id: string;
  org_id: string;
  name: string;
  photo: string | null;
}

async function loadOrg(orgSlug: string): Promise<PublicOrg | null> {
  // Branding reads are entitlement-gated in the query, same rule as the
  // public_*_v views. THREE keys, three different things — they were two until
  // V397 (entitlements v18 W2 T17, owner ruling 2026-09-03) split the third
  // out, and the welding was invisible until it cost a customer something:
  //
  //   branding           org LOGO (upload + display)  free on every plan (V310)
  //   dashboard.theme    org ACCENT COLOUR            Pro and above (V397)
  //   dashboard.branding badge removal, ALONE         enterprise only (V396)
  //
  // `branded` is NOT the logo/name gate — it is the "may remove the seazn
  // attribution" perk (the Powered-by footer and the OG-card badge; see
  // PublicOrg.branded and og/post-card.tsx). V310 freed `branding` to
  // every plan, which silently switched the footer off for community orgs and
  // killed the free-tier growth lever until this was re-gated.
  //
  // The colour rode `dashboard.branding` too, until V396 made badge removal
  // enterprise-only — and took Pro's brand colour off its public pages with
  // it, a visible downgrade nobody bought. Four smoke checks caught that and
  // were left RED rather than edited to match the defect. Do not re-weld these:
  // `entitlements-v18-theme.test.ts` asserts the colour and the badge TOGETHER
  // for a Pro org, because either half alone still passes with one key.
  const [row] = await sql<
    (Omit<PublicOrg, "logo"> & { logo_url: string | null; logo_storage_path: string | null })[]
  >`
    select o.id, o.name, o.slug, o.about, o.default_locale,
           o.stripe_charges_enabled as card_payments,
           org_has_feature(o.id, 'dashboard.branding') as branded,
           case when org_has_feature(o.id, 'dashboard.theme')
                then o.branding else '{}'::jsonb end as branding,
           case when org_has_feature(o.id, 'branding') then o.logo_url end as logo_url,
           case when org_has_feature(o.id, 'branding') then o.logo_storage_path end as logo_storage_path
    from organizations o where o.slug = ${orgSlug} limit 1`;
  if (!row) return null;
  const { logo_url, logo_storage_path, ...org } = row;
  return { ...org, logo: resolveLogoUrl(logo_storage_path, logo_url) };
}

/** Storage-path logos live in the public supabase assets bucket. */
export function resolveLogoUrl(
  storagePath: string | null | undefined,
  logoUrl: string | null | undefined,
): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (storagePath && base) return `${base}/storage/v1/object/public/assets/${storagePath}`;
  return logoUrl ?? null;
}

/** A competition as the org home lists it: the public row plus how many of its
 *  public fixtures are in play right now (spectator W2, Task 15). */
export interface PublicOrgCompetition extends PublicCompetition {
  in_play: number;
}

/**
 * The org home's competition list — the ONE query behind both the page's first
 * paint (`getPublicOrg`) and the chip island's poll (`publicOrgLive`,
 * usecases/public.ts), so the two can never disagree about which competitions
 * are listed or what a count means.
 *
 * Listed: `visibility = 'public'` only. `public_competitions_v` admits
 * `unlisted` too; an unlisted competition is readable by link and never listed.
 * Nor is a DRAFT, whatever its visibility (owner decision 2026-09-27 — see
 * `lib/competition-listing.ts`): readable by link, listed once published.
 *
 * `in_play` counts `in_play` fixtures through `public_divisions_v`, and the
 * join is what makes it a PUBLIC count: `public_fixtures_v` filters on the
 * competition's visibility only, so it still returns the fixtures of an
 * ARCHIVED division, which the public pages do not show (V262).
 *
 * Order (owner ruling 2026-09-17): three tiers, each read off the chip its card
 * shows — a match in play ("{count} live now") first, then marked `live` with
 * nothing in play ("On now"), then the rest; within each tier `starts_on`
 * descending (undated last), the newer row breaking a tie. The SQL sorts by
 * date only and `sortOrgHomeCompetitions` (lib/public-site.ts) lifts the
 * tiers, reading the SAME `status` and `in_play` the row carries to the chip,
 * through the chip's own predicates — so the list cannot put a competition
 * above one whose chip is livelier, and there is no second, SQL copy of the
 * rule to drift. The poll (`publicOrgLive`) returns rows in this order, and the
 * island sorts its cards with the same function after every poll, so a
 * competition going live moves up on the same poll that lights its chip.
 */
export async function listOrgHomeCompetitions(orgId: string): Promise<PublicOrgCompetition[]> {
  const byDate = await sql<PublicOrgCompetition[]>`
    select c.id, c.org_id, c.name, c.slug, c.description, c.starts_on, c.ends_on,
           c.branding, c.status, c.visibility,
           (select count(*)::int
              from public_fixtures_v f
              join public_divisions_v d on d.id = f.division_id
             where d.competition_id = c.id and f.status = 'in_play') as in_play
    from public_competitions_v c
    where c.org_id = ${orgId} and c.visibility = 'public' and c.status <> 'draft'
    order by c.starts_on desc nulls last, c.created_at desc`;
  return sortOrgHomeCompetitions(byDate);
}

/** Org landing: the org + its `public` competitions (unlisted stays link-only). */
export async function getPublicOrg(orgSlug: string): Promise<{
  org: PublicOrg;
  competitions: PublicOrgCompetition[];
} | null> {
  return unstable_cache(
    async () => {
      const org = await loadOrg(orgSlug);
      if (!org) return null;
      const competitions = await listOrgHomeCompetitions(org.id);
      return { org, competitions };
    },
    // v2 (spectator W2, Task 15): each competition gained `in_play`. The page
    // reads it for the chip, and a v1 entry would serve the old "Upcoming"
    // on a live competition for a full REVALIDATE_FAST window after deploy —
    // same reason `pub-player` and `pub-hub` retire their keys on a shape change.
    ["pub-org-v2", orgSlug],
    { tags: [orgTag(orgSlug)], revalidate: REVALIDATE_FAST },
  )();
}

/** Competition home: hero + divisions (+ live-now strip). */
export type LiveNowFixture = Omit<PublicFixture, "venue" | "court_label" | "venue_name" | "court_name">;

/** The competition shell: its org, its row, its public divisions and what is in play. */
export interface PublicCompetitionShell {
  org: PublicOrg;
  competition: PublicCompetition;
  divisions: PublicDivision[];
  /** Review wave 3: this query selects no court/venue columns, so the type must
   *  not claim them — it used to, and they read `undefined` at runtime. A
   *  future "Live now" card wanting a location wires it like getPublicDivision
   *  does (see the query's own note), rather than widening this back. */
  liveNow: LiveNowFixture[];
}

/**
 * The shell straight from Postgres — the body `getPublicCompetition` caches.
 * Every public page reads the shell through that cache. The one reader that
 * must not is the Redis hub rebuild (`loadCompetitionHub(…, { uncached: true })`
 * from usecases/public.ts): its lease keeps a pre-write document out of
 * `pub:v1:hub:{id}` only if the build reads the database AFTER the write's
 * DEL, and this machine's data cache may not have heard of that write yet —
 * a peer's tags expire only when `broadcastRevalidate` lands.
 */
export async function readPublicCompetitionShell(
  orgSlug: string,
  compSlug: string,
): Promise<PublicCompetitionShell | null> {
  const org = await loadOrg(orgSlug);
  if (!org) return null;
  const [competition] = await sql<PublicCompetition[]>`
    select id, org_id, name, slug, description, starts_on, ends_on, branding,
           status, visibility
    from public_competitions_v
    where org_id = ${org.id} and slug = ${compSlug} limit 1`;
  if (!competition) return null;
  const divisions = await sql<PublicDivision[]>`
    select d.id, d.competition_id, d.name, d.slug, d.description,
           d.sport_key, d.variant_key,
           d.status, d.module_version, d.tiebreakers, s.name as sport_name,
           -- V412 widened public_entrants_v to publish departed entrants
           -- too (so a withdrawn player keeps her NAME on the board), so
           -- the "who is competing" half of the question is asked here.
           -- Without this clause a competition's headline entrant count
           -- grows every time someone withdraws.
           (select count(*)::int from public_entrants_v e
             where e.division_id = d.id
               and e.status in ('registered','confirmed')) as entrant_count,
           -- RS008 review fix #5: public_divisions_v does not expose
           -- these (see PublicDivision's own doc comment) — a cheap
           -- primary-key join to the base table rather than widening
           -- that view for every other consumer of it.
           dv.youth, dv.player_name_display, dv.config,
           -- T16b fix round 3: the stored format name, the fallback for a
           -- variant the dictionary map does not name (variant-label.ts).
           -- System rows and this org's own only, the org's row first —
           -- the same scoping as getPublicFixture's variant lookup.
           (select v.name from sport_variants v
             where v.sport_key = d.sport_key and v.key = d.variant_key
               and (v.org_id is null or v.org_id = ${org.id})
             order by v.org_id nulls last
             limit 1) as variant_name
    from public_divisions_v d
    left join sports s on s.key = d.sport_key
    join divisions dv on dv.id = d.id
    where d.competition_id = ${competition.id}
    order by d.created_at, d.id`;
  // P9 sweep (pass 3c-4): venue/court_label dropped from this SELECT
  // rather than resolved via withCourtVenueNames like getPublicDivision/
  // getPublicFixture below — verified first (not assumed): the "Live
  // now" strip (competition page) renders only division name and
  // summary.headline, and opengraph-image.tsx's only use of `liveNow` is
  // its `.length`. No consumer reads venue/court_label/venue_name/
  // court_name off a liveNow item, so a frozen read here was genuinely
  // dead, not silently wrong — resolving names nobody renders would just
  // be N wasted queries. NOTE: PublicFixture still declares all four as
  // required `string | null`, so a liveNow item reads `undefined` on
  // them at runtime despite the type — same class of gap the file's own
  // "lane/is_final" comment above already flags for this exact type;
  // widening those four fields to optional would ripple through every
  // other PublicFixture consumer (schedule/bracket views, pass 4), which
  // is out of this fix's blast radius. If a future "Live now" card ever
  // wants to show where a match is being played, wire this the same way
  // getPublicDivision does, not by re-adding venue/court_label.
  // Review wave 3: this query selects none of the four court/venue fields,
  // so the previous `PublicFixture[]` cast declared them present while they
  // read `undefined` at runtime. No consumer touches them today; the cast
  // is narrowed rather than the columns added, because the comment above
  // says deliberately that a "Live now" card wanting a location should be
  // wired like getPublicDivision, not by widening this.
  const liveNow = await sql<LiveNowFixture[]>`
    select f.id, f.division_id, f.stage_id, f.pool_id, f.round_no,
           f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
           f.home_slot_label, f.away_slot_label,
           f.scheduled_at, f.status, f.outcome,
           f.summary, f.last_seq,
           f.lane, f.is_final, f.third_place, f.conditional
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    where d.competition_id = ${competition.id} and f.status = 'in_play'
    order by f.scheduled_at nulls last, f.id limit 12`;
  return { org, competition, divisions, liveNow: liveNow.map(normalizeFixture) };
}

export async function getPublicCompetition(
  orgSlug: string,
  compSlug: string,
): Promise<PublicCompetitionShell | null> {
  const shell = await unstable_cache(
    () => readPublicCompetitionShell(orgSlug, compSlug),
    ["pub-comp", orgSlug, compSlug],
    { tags: [orgTag(orgSlug)], revalidate: REVALIDATE_FAST },
  )();
  if (!shell) return null;
  return shell;
}

/**
 * RS008 review fix #5 — every public surface reading an entrant's own
 * display_name (this division page, its calendar/poster exports, the
 * present/slideshow kiosk, the embeds door) fed straight off
 * `public_entrants_v.display_name` with ZERO masking — not even by youth,
 * the pre-existing safeguarding control every other public display_name
 * site already honours. Mirrors `buildDivisionSlides`/`buildGroupStatusView`'s
 * own local, parallel consent query (never widens `public_entrants_v`
 * itself, which many other, already-correct consumers read unmodified) —
 * a `team`'s own declared name never takes the consent axis, same bypass
 * established everywhere else this session. Exported so `embed-data.ts`,
 * which runs its own separate (structurally identical) entrants query,
 * reuses the SAME masking decision rather than a parallel one.
 *
 * Generic over the caller's own row shape (`getPublicFixture` below only
 * needs `{id, kind, display_name}`, not a full `PublicEntrant`) — every
 * caller gets `opted_out` back too, alongside the masked `display_name`,
 * so a caller building a `PublicEntrant` (this file's own two below) can
 * expose it for `buildPublicDivisionSlides`'s OWN independent masking pass
 * (fix #2) to also see a real signal via the `{...data}` spread.
 */
export async function maskPublicEntrantNames<
  T extends {
    id: string;
    kind: string;
    display_name: string;
    members?: {
      name: string | null;
      person_id?: string | null;
      photo?: string | null;
      squad_number?: number | null;
      position?: string | null;
    }[];
  },
>(entrants: T[], division: { youth?: boolean; player_name_display?: string | null }): Promise<(T & { opted_out: boolean })[]> {
  const nonTeamIds = entrants.filter((e) => e.kind !== "team").map((e) => e.id);
  const consentRows =
    nonTeamIds.length > 0
      ? // Post-merge review fix (2026-08-30, minor): `p.merged_into is null`
        // added for consistency with the fresh-members query below (item 5's
        // own fix) — a tombstoned/merged duplicate's stale consent must not
        // count toward `anyOptedOut`.
        await sql<{ entrant_id: string; consent: { public_name?: boolean } | null }[]>`
          select em.entrant_id, p.consent
          from entrant_members em
          join persons p on p.id = em.person_id
          where em.entrant_id in ${sql(nonTeamIds)} and p.merged_into is null`
      : [];
  const consentsByEntrant = new Map<string, ({ public_name?: boolean } | null)[]>();
  for (const r of consentRows) {
    const list = consentsByEntrant.get(r.entrant_id) ?? [];
    list.push(r.consent);
    consentsByEntrant.set(r.entrant_id, list);
  }

  // Code-review fix (2026-08-30, item 5) — members[].name used to come
  // straight off public_entrants_v's own public_person_name(full_name,
  // consent) column: a SQL-side masking convention with the OPPOSITE default
  // polarity from resolvePersonDisplayName ("absent consent masks" there,
  // vs "absent consent never masks" here) and no youth awareness at all.
  // Re-derived per member instead, off a fresh entrant_members/persons join
  // — the view's own members[].person_id is null for anyone without
  // public-name consent (PublicEntrantMember's own doc comment), so it
  // cannot be used to look a member's consent back up here. Positionally
  // zipped against the view's own members array: this query and the view's
  // internal jsonb_agg both join entrant_members/persons on the same
  // entrant_id, filter the same `merged_into is null`, and order by the same
  // `squad_number nulls last, full_name` — one Postgres instance ordering
  // the same underlying rows the same way twice, so index i always names
  // the same person in both (guarded by a length check below regardless).
  const entrantIdsWithMembers = entrants.filter((e) => (e.members?.length ?? 0) > 0).map((e) => e.id);
  const memberRowsByEntrant = new Map<string, { full_name: string; consent: { public_name?: boolean } | null }[]>();
  if (entrantIdsWithMembers.length > 0) {
    const rows = await sql<
      { entrant_id: string; full_name: string; consent: { public_name?: boolean } | null }[]
    >`
      select em.entrant_id, p.full_name, p.consent
      from entrant_members em
      join persons p on p.id = em.person_id
      where em.entrant_id in ${sql(entrantIdsWithMembers)} and p.merged_into is null
      order by em.entrant_id, em.squad_number nulls last, p.full_name`;
    for (const r of rows) {
      const list = memberRowsByEntrant.get(r.entrant_id) ?? [];
      list.push({ full_name: r.full_name, consent: r.consent });
      memberRowsByEntrant.set(r.entrant_id, list);
    }
  }

  const setting = division.player_name_display ?? null;
  const youth = division.youth ?? false;
  return entrants.map((e) => {
    const optedOut = e.kind !== "team" && anyOptedOut(consentsByEntrant.get(e.id) ?? []);
    const fresh = e.members ? memberRowsByEntrant.get(e.id) : undefined;
    // Privacy hotfix (2026-09-16): a member whose name the policy masks also
    // loses `person_id` and `photo`. This output is what the division page
    // renders AND what the anonymous entrants API serves, and the id is the
    // player card's URL — a masked "Arun K." linked to a card (or an id a
    // client can build that URL from) is the full name one hop away. No public
    // surface shows a masked member's photo, so none is served either.
    const remaskedMembers = !e.members
      ? undefined
      : fresh && fresh.length === e.members.length
        ? e.members.map((m, i) => ({
            ...m,
            name: resolvePersonDisplayName(fresh[i]!.full_name, fresh[i]!.consent, setting, youth),
            ...(isPersonNameMasked(fresh[i]!.consent, setting, youth) ? { person_id: null, photo: null } : {}),
          }))
        : // The roster moved between the view's read and the fresh one (a
          // member joined or left, or the read found none), so index i no
          // longer names the same person in both. The view's own
          // names are consent-gated but carry NO youth axis, so they are never
          // published as they stand: the DIVISION's policy is applied to every
          // member instead (no per-person consent to hand it — the view's
          // name already carries that axis, initials without consent).
          e.members.map((m) =>
            isPersonNameMasked(null, setting, youth)
              ? {
                  ...m,
                  name: m.name === null ? null : resolvePersonDisplayName(m.name, null, setting, youth),
                  person_id: null,
                  photo: null,
                }
              : m,
          );
    return {
      ...e,
      ...(remaskedMembers ? { members: remaskedMembers } : {}),
      opted_out: optedOut,
      display_name:
        e.kind === "team"
          ? e.display_name
          : resolvePersonDisplayName(
              e.display_name,
              optedOut ? { public_name: false } : null,
              setting,
              youth,
            ),
    };
  });
}

/** One squad line's INTERNAL identity — see `readEntrantMemberRefs`. */
export interface EntrantMemberRef {
  personId: string;
  fullName: string;
  consent: { public_name?: boolean } | null;
  squadNumber: number | null;
  /** `entrant_members.default_position_key` — the view's `position`. */
  positionKey: string | null;
}

/**
 * The person behind each line of `public_entrants_v`'s `members`, per entrant,
 * in the view's own order (`squad_number nulls last, full_name`, V350) — the
 * same positional zip `maskPublicEntrantNames` relies on, so index i names the
 * same person in both (callers still guard on length).
 *
 * SERVER-ONLY JOIN KEY. The ids here are every member's, consented or not, and
 * the full names are unmasked: nothing returned may reach a document. It exists
 * so the competition hub can mark a suspended player by PERSON rather than by
 * display name, and it is deliberately NOT folded into
 * `maskPublicEntrantNames`'s output, which the public entrants API
 * (`usecases/public.ts`) serves as-is.
 */
export async function readEntrantMemberRefs(entrantIds: string[]): Promise<Record<string, EntrantMemberRef[]>> {
  if (entrantIds.length === 0) return {};
  const rows = await sql<
    {
      entrant_id: string;
      person_id: string;
      full_name: string;
      consent: { public_name?: boolean } | null;
      squad_number: number | null;
      default_position_key: string | null;
    }[]
  >`
    select em.entrant_id, p.id as person_id, p.full_name, p.consent, em.squad_number, em.default_position_key
    from entrant_members em
    join persons p on p.id = em.person_id
    where em.entrant_id in ${sql(entrantIds)} and p.merged_into is null
    order by em.entrant_id, em.squad_number nulls last, p.full_name`;
  const out: Record<string, EntrantMemberRef[]> = {};
  for (const r of rows) {
    (out[r.entrant_id] ??= []).push({
      personId: r.person_id,
      fullName: r.full_name,
      consent: r.consent,
      squadNumber: r.squad_number,
      positionKey: r.default_position_key,
    });
  }
  return out;
}

/**
 * A division's detail straight from Postgres — the body `getPublicDivision`
 * caches. Same rule as {@link readPublicCompetitionShell}: only the Redis hub
 * rebuild reads it uncached.
 *
 * Four independent lanes (stages → pools, fixtures → court names, standings →
 * zone, entrants → masking) run at once, so a cold read costs three round
 * trips instead of up to ten, and never holds more than four pooled
 * connections (prod runs 12 a machine). `sequential` runs the lanes one after
 * another instead: `readEveryPublicDivision` (read-every-division.ts), which
 * reads EVERY division at once, always passes it, so its demand stays one
 * connection per division rather than four.
 */
export async function readPublicDivisionDetail(
  division: PublicDivision,
  { sequential = false }: { sequential?: boolean } = {},
) {
  const readStagesAndPools = async () => {
    const stages = await sql<PublicStage[]>`
      select id, division_id, seq, kind, name, status,
             qualify_count, qualify_per_group, next_stage_name, swiss_rounds, points_rule,
             has_rank_overrides,
             -- Per-stage match rules (design 2026-09-17 T7): the rules
             -- FRAGMENT only, read off stages by the VIEW row's own id so the
             -- view still decides which rows exist and the rest of config
             -- (progression, cross-feeds) stays private.
             (select x.config->'rules' from stages x where x.id = public_stages_v.id) as rules
      from public_stages_v where division_id = ${division.id} order by seq`;
    const pools = await sql<{ id: string; stage_id: string; key: string; name: string }[]>`
      select p.id, p.stage_id, p.key, p.name
      from public_pools_v p
      join public_stages_v s on s.id = p.stage_id
      where s.division_id = ${division.id} order by p.key`;
    return { stages, pools };
  };
  // `ext_key` is the generator's stable id, which `roundRole` needs to tell a
  // page playoff's Qualifier 1 from its Eliminator (fix round 1, M3). The
  // view does not expose it, so it is read off `fixtures` by the VIEW row's
  // own id: the view still decides which rows exist.
  //
  // The feed edges, by the same rule: not columns of the view. They are what
  // lets a sibling-fed seat with no stored label read "Winner of Semi-finals,
  // match 1" instead of "TBD" (see PublicFixture).
  //
  // One probe of `fixtures` per row, in a LATERAL, where there were five
  // correlated subselects (T4). The `offset 0` fences it, so the planner
  // cannot flatten it into a plain join of the fixtures table.
  //
  // The ORDER BY ends on the stage's seq, then the fixture's id. Rows can tie
  // on (round_no, seq_in_round): round 1 of a league and round 1 of its
  // knockout, or two pools' round 1 inside one group stage. Ordered on those
  // two alone, tied rows came back in whatever order the plan produced (heap
  // order when the planner walks the (division_id, round_no, seq_in_round)
  // index, a sort's order when it scans and sorts), and the hub's stable
  // sortHubMatches showed undated and same-time matches in exactly that order.
  // Measured 2026-09-27, the statement without the last two keys returned one
  // division's ties in two different orders under its own custom and generic
  // plans. The embed read (embed-data.ts) orders the same way.
  // (No backticks in here: this is inside a tagged template.)
  const readFixtures = async () =>
    withCourtVenueNames(
      (
        await sql<PublicFixture[]>`
          select v.id, v.division_id, v.stage_id, v.pool_id, v.round_no, v.seq_in_round,
                 v.home_entrant_id, v.away_entrant_id, v.home_slot_label, v.away_slot_label,
                 v.scheduled_at, v.venue, v.court_label,
                 v.status, v.outcome, v.summary, v.last_seq,
                 v.lane, v.is_final, v.third_place, v.conditional,
                 e.ext_key, e.winner_to_fixture, e.winner_to_slot, e.loser_to_fixture, e.loser_to_slot
          from public_fixtures_v v
          left join lateral (
            select x.ext_key, x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
            from fixtures x where x.id = v.id
            offset 0
          ) e on true
          left join stages st on st.id = v.stage_id
          where v.division_id = ${division.id}
          order by v.round_no, v.seq_in_round, st.seq, v.id`
      ).map(normalizeFixture),
    );
  const readStandingsAndTz = async () => {
    const standings = (
      await sql<PublicStandings[]>`
      select stage_id, pool_id, rows, updated_at
      from public_standings_v where division_id = ${division.id}`
    ).map(normalizeStandings);
    // Venue lane (V305): the division's override, else the org's timezone.
    const [ss] = await sql<{ tz: string }[]>`
      select coalesce(ss.tz, o.timezone, 'UTC') as tz
      from divisions d
      left join schedule_settings ss on ss.division_id = d.id
      left join organizations o on o.id = d.org_id
      where d.id = ${division.id}`;
    return { standings, tz: ss?.tz ?? "UTC" };
  };
  // RS008 review fix #5 — masks a non-team entrant's own display_name by
  // consent (and, unlike before this fix, by youth too). Feeds THIS
  // page's own render, the calendar.ics/poster.pdf exports, and (via the
  // `{...data}` spread in the two /present page.tsx files) the
  // slideshow kiosk's own independent masking pass (fix #2).
  const readEntrants = async () =>
    maskPublicEntrantNames(
      await sql<PublicEntrant[]>`
        select id, division_id, kind, display_name, seed, status, members,
               team_display, badge_url
        from public_entrants_v where division_id = ${division.id}
        order by seed nulls last, display_name`,
      division,
    );

  const [{ stages, pools }, fixtures, { standings, tz }, entrants] = sequential
    ? ([await readStagesAndPools(), await readFixtures(), await readStandingsAndTz(), await readEntrants()] as const)
    : await Promise.all([readStagesAndPools(), readFixtures(), readStandingsAndTz(), readEntrants()]);
  return { stages, pools, fixtures, standings, entrants, tz };
}

/** Division home: schedule + standings + entrants + stage skeleton. */
export async function getPublicDivision(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  /** How a cache MISS reads — see {@link readPublicDivisionDetail}. The cache
   *  entry is the same either way. */
  read: { sequential?: boolean } = {},
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  division: PublicDivision;
  stages: PublicStage[];
  pools: { id: string; stage_id: string; key: string; name: string }[];
  fixtures: PublicFixture[];
  standings: PublicStandings[];
  entrants: PublicEntrant[];
  /** Venue zone for schedule display (V305): division override → org tz → UTC. */
  tz: string;
} | null> {
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const division = shell.divisions.find((d) => d.slug === divSlug);
  if (!division) return null;

  const detail = await unstable_cache(
    () => readPublicDivisionDetail(division, read),
    // v2 (privacy hotfix, 2026-09-16): a member the division's name policy
    // masks now carries no `person_id` and no `photo` (maskPublicEntrantNames).
    // v3 (V414): every stage carries the qualification columns; a v2 entry
    // would hand the standings builder `undefined` for all six.
    // v4 (per-stage format lines, 2026-09-24): every stage carries `rules`; a
    // v3 entry would read as "no stage overrides" and hide every stage line on
    // the hub and the division page until it expired.
    ["pub-div-v4", division.id],
    {
      tags: [divisionTag(division.id), competitionTag(division.competition_id)],
      revalidate: REVALIDATE_FAST,
    },
  )();

  return {
    org: shell.org,
    competition: shell.competition,
    division,
    ...detail,
  };
}

/** Live match page: one fixture + its division/competition context. */
export async function getPublicFixture(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
  fixtureId: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  division: PublicDivision;
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  realtime: boolean;
  /** Task 9 — the match-centre view model, built by the SAME `loadMatchCentre`
   *  the poll endpoint (`GET /api/v1/public/fixtures/{id}`, usecase
   *  `publicFixture`) uses, so the page's first paint and every subsequent
   *  poll (Task 10's client hook) render the exact same document shape. */
  matchCentre: MatchCentreDocT;
  /** Stream overlay Task 0 (owner answer 12) — the VENUE lane's IANA zone
   *  (V305), so a pre-match overlay prints a start time the club's own
   *  audience recognises instead of UTC. A raw zone, never a pre-formatted
   *  label: the label is formatted by the server component that already holds
   *  the locale (`overlayStartLabel`, Task 2), so `?lang=` can re-render it. */
  venueTz: string;
  /** Slate match-card meta (2026-09-12) — `stages.name` for the fixture's
   *  own stage. Already read for match-centre; surfaced so the overlay does
   *  not substitute `division.name` (a different noun on air). Null when the
   *  stage row is missing. */
  stageName: string | null;
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const division = shell.divisions.find((d) => d.slug === divSlug);
  if (!division) return null;

  const detail = await unstable_cache(
    async () => {
      const [fixtureRow] = await sql<PublicFixture[]>`
        select v.id, v.division_id, v.stage_id, v.pool_id, v.round_no, v.seq_in_round,
               v.home_entrant_id, v.away_entrant_id, v.home_slot_label, v.away_slot_label,
               v.scheduled_at, v.venue, v.court_label,
               v.status, v.outcome, v.summary, v.last_seq,
               v.lane, v.is_final, v.third_place, v.conditional, v.stream_url,
               -- The feed edges, listed for the same reason as the three other
               -- reads above: PublicFixture declares them OPTIONAL, so a
               -- select that omits them compiles clean and reads undefined at
               -- runtime. Nothing off this row names a seat today, but the
               -- next caller that tries would get a silent TBD rather than a
               -- type error. One fenced LATERAL probe, as in
               -- readPublicDivisionDetail. (No backticks in here: inside a
               -- tagged template.)
               e.winner_to_fixture, e.winner_to_slot, e.loser_to_fixture, e.loser_to_slot
        from public_fixtures_v v
        left join lateral (
          select x.winner_to_fixture, x.winner_to_slot, x.loser_to_fixture, x.loser_to_slot
          from fixtures x where x.id = v.id
          offset 0
        ) e on true
        where v.id = ${fixtureId} and v.division_id = ${division.id} limit 1`;
      if (!fixtureRow) return null;
      // T4 — everything below needs only the fixture row and none of it needs
      // another, so it reads in four lanes at once; the match centre, which
      // needs all four, follows. Four pooled connections at most, never a tx.
      const [fixture, names, { rt, variantRow }, { tzRow, stageRow }] = await Promise.all([
        withCourtVenueName(normalizeFixture(fixtureRow)),
        (async () => {
          const rawNames = await sql<{ id: string; kind: string; display_name: string }[]>`
            select id, kind, display_name from public_entrants_v
            where division_id = ${division.id}`;
          // RS008 review fix #5 — entrantNames fed the fixture page's own
          // home/away display with ZERO masking, not even by youth.
          return maskPublicEntrantNames(rawNames, division);
        })(),
        (async () => {
          // Competition-scoped: an Event Pass grants realtime for the competition it
          // was bought for, so the org-wide 2-arg overload denies a paid-for fixture.
          // This is the SPECTATOR side of the grant — the organiser's own noticeboard
          // was already comp-scoped, so an org-wide read here meant a buyer saw live
          // scoring work for themselves and for none of their audience, which is the
          // whole point of the feature.
          const [rt] = await sql<{ realtime: boolean }[]>`
            select org_has_feature(${shell.org.id}, 'realtime', ${shell.competition.id})
                   as realtime`;
          // The FORMAT's name, not its key. `formatLabel` fed the header's
          // `metaLine` straight from `division.variant_key`, so the match centre
          // — and, once the share images started carrying that line, a poster a
          // spectator posts to Instagram — read "t20" and "grand-slam" where the
          // catalog has "T20" and "Grand Slam" sitting in `sport_variants.name`.
          //
          // Scoped to system rows and this org's own: variants are org-scoped, and
          // a bare match on (sport_key, key) would happily return ANOTHER org's
          // renamed variant. Between those two rows the org's own is read first.
          //
          // PRECEDENCE on public pages (`variantLabel`, variant-label.ts): the
          // dictionary word wins for every engine-declared variant key, in the
          // org's locale; this row is the fallback only for a key the map does not
          // name (an org's own custom variant), and the raw key after that. So an
          // org RENAME of an engine-declared key (e.g. its own row for `t20`) does
          // NOT show publicly — deliberate (T16b fix round 3: a variant is copy in
          // four locales, a rename is one English string), and pinned by
          // public-fixture-format-label.test.ts. Nothing in the product writes org
          // rows today; an org-variant editor must settle this before it ships.
          const [variantRow] = await sql<{ name: string }[]>`
            select name from sport_variants
            where sport_key = ${division.sport_key} and key = ${division.variant_key}
              and (org_id is null or org_id = ${shell.org.id})
            order by org_id nulls last
            limit 1`;
          return { rt, variantRow };
        })(),
        (async () => {
          // Task 9 — the division's own tz override (V305 venue lane; org
          // timezone is `shell.org`'s own row, read separately since `PublicOrg`
          // does not carry it — see `resolveVenueTz`'s doc comment for why venue
          // tz is never inherited from a personal/browser lane).
          //
          // Review 2026-09-09 (I3): the join itself now lives in `server/venue-tz.ts`,
          // the single authority for WHICH columns the venue lane reads. The raw
          // pair is still needed here (not just the resolved zone) because
          // `loadMatchCentre` takes `orgTz` and `division.tz` separately.
          const tzRow = await venueTzRow(division.id);
          // The view row's own stage_id: the court-name lane adds names to the
          // row, it never moves it to another stage.
          const [stageRow] = await sql<{ name: string }[]>`
            select name from stages where id = ${fixtureRow.stage_id}`;
          return { tzRow, stageRow };
        })(),
      ]);
      const locale = toLocale(shell.org.default_locale);
      const basePath = `/shared/${shell.org.slug}/${shell.competition.slug}/${division.slug}`;
      const matchCentre = await loadMatchCentre(sql, fixture, {
        orgTz: tzRow?.org_tz ?? null,
        division: {
          sportKey: division.sport_key,
          moduleVersion: division.module_version,
          // T16b fix round 3: the dictionary's word for an engine-declared
          // variant, in the org's locale; the catalog name above only for a
          // variant the map does not name, the key after that.
          formatLabel: variantLabel(
            { sportKey: division.sport_key, variantKey: division.variant_key, storedName: variantRow?.name ?? null },
            (key) => msgFor(locale, key),
          ),
          tz: tzRow?.division_tz ?? null,
          youth: division.youth ?? false,
          playerNameDisplay: division.player_name_display ?? null,
        },
        locale,
        hrefs: { division: basePath, competition: `/shared/${shell.org.slug}/${shell.competition.slug}`, calendar: `${basePath}/calendar.ics` },
        stage: stageRow ? { name: stageRow.name, roundLabel: null } : null,
        slotLabelLookup: (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars),
      });
      return {
        fixture,
        entrantNames: Object.fromEntries(names.map((n) => [n.id, n.display_name])),
        realtime: rt?.realtime === true,
        matchCentre,
        // Stream overlay Task 0 — "one zone per fixture", resolved through the
        // TS authority `resolveVenueTz` (lib/tz.ts:44) off the SAME `tzRow`
        // Task 9 already reads above, rather than a second query or a second
        // `coalesce(ss.tz, o.timezone, 'UTC')` SQL mirror. (getPublicDivision
        // splices that mirror inline only because a string helper cannot go
        // into a postgres.js tagged template; here both columns are in hand.)
        //
        // NEVER `pickTimezone` and never the `seazn_tz` cookie: a London-based
        // organiser can run an event in Malaga, and the overlay is watched by
        // an audience in neither.
        venueTz: resolveVenueTz(tzRow?.division_tz, tzRow?.org_tz),
        stageName: stageRow?.name ?? null,
      };
    },
    // v2 (owner decision 2026-09-16): `matchCentre.header.statusLine` for a
    // decided cricket match changed shape (the margin is its own key, not a
    // `{margin}` word). A v1 entry would render "X won" without the margin
    // for a REVALIDATE_FAST window after deploy, so retire the key rather than
    // wait — same reason as `pub-player-v15` below.
    //
    // v2 (privacy hotfix, 2026-09-16): the match centre's lineup `masked` flag
    // is the name policy's decision (readPublicLineups), so a one-word masked
    // name now gets a surrogate id instead of its real one.
    //
    // v3 (merge of the two v2 changes above, 2026-09-17): each branch moved
    // the unversioned key to `-v2` for its own change, so a `-v2` entry
    // written by either one lacks the other's. The merged document retires
    // both rather than serve one for a REVALIDATE_FAST window.
    ["pub-fixture-v3", fixtureId],
    { tags: [divisionTag(division.id)], revalidate: REVALIDATE_FAST },
  )();
  if (!detail) return null;

  return { org: shell.org, competition: shell.competition, division, ...detail };
}

/**
 * org / competition / division slugs for a fixture id.
 *
 * The stream-overlay URL carries only a fixture id, but `getPublicFixture`
 * above is keyed on three slugs (and must stay that way — its cache key and
 * its `divisionTag` are shared with the public match page). This resolves them
 * through the SAME `public_*_v` views `fixtureRealtimeEligible` uses (`:1037`),
 * so a fixture in a private competition is simply not found here, exactly as
 * it is not found there. Null means 404 for the caller — never a partial.
 */
export async function publicFixtureSlugs(
  fixtureId: string,
): Promise<{ orgSlug: string; compSlug: string; divSlug: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const [row] = await sql<{ org_slug: string; comp_slug: string; div_slug: string }[]>`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where f.id = ${fixtureId} limit 1`;
  if (!row) return null;
  return { orgSlug: row.org_slug, compSlug: row.comp_slug, divSlug: row.div_slug };
}

/** PROMPT-65: per-division stat block on the player card. Free at every tier
 *  (locked decision 2026-07-18): visibility is the same consent gate as the
 *  card itself. The leaderboard TABLE (`publicDivisionStats`,
 *  usecases/player-stats.ts) used to be described here as "the Pro surface" —
 *  W3-A (2026-09-06, V399) froze `stats.player` true on every plan, so it is
 *  free by default too now, gated only by the same explicit
 *  `org_entitlement_overrides` deny `divisionPlayerStats`/`personStats`
 *  respect. This profile block's own gate (consent + `dashboard.player_profiles`
 *  below) is separate and unchanged. */
export interface PublicPlayerStats {
  division_name: string;
  division_slug: string;
  sport_key: string;
  metrics: { key: string; label: string; value: number }[];
}

/** S9/#418 — per-sport career rollup on the player card, scoped to THIS
 *  competition only (see getPublicPlayer's own comment on why summing the
 *  snapshot rows it already read cannot leak cross-competition). `meta` is
 *  pre-rendered "N divisions · N variants · N matches" — this page has no
 *  Dict/locale pair to format the raw counts with (see statMsg), so, like
 *  every metric label here, the count line is baked server-side too. */
export interface PublicCareerSport extends CareerSportStats {
  meta: string;
}

/** What `publicPlayerGate` hands a caller that passed it: the context the page
 *  and the player-matches endpoint both build on. */
export interface PublicPlayerGate {
  org: PublicOrg;
  competition: PublicCompetition;
  player: PublicPlayer;
}

/**
 * W2 Task 14 — the player page's REFUSAL, and nothing else: null exactly when
 * `getPublicPlayer` is null, because `getPublicPlayer` is built on it — the two
 * cannot drift. Folds nothing and reads no stats, so a caller that needs only
 * "may this person be shown here" (the player-matches endpoint) does not pay
 * for the page. Three conditions, all evaluated per call:
 *  - the id is a uuid and the competition is public/unlisted
 *    (`getPublicCompetition`, cached on the competition tag);
 *  - the `dashboard.player_profiles` ENTITLEMENT for THIS competition (V307) —
 *    outside any cache on purpose: no entitlement write busts the competition
 *    tag, so a gate inside one would stay frozen at whatever the org held when
 *    it was first cached. No entitlement write fires a tag, so a grant or a
 *    denial reaches the card only as these expire, not immediately:
 *      · the card page — MEASURED (review of W2 round 2, response headers on
 *        a prod build): served `s-maxage=30`, not the route's `revalidate =
 *        300`, because this gate's `getPublicCompetition` read
 *        (`REVALIDATE_FAST`, 30s) lowers the page's revalidate;
 *      · `hasFeature`'s cache — INFERRED from `ENT_TTL_SECONDS` (300s, Redis):
 *        up to 5 more minutes wherever the write that changed the entitlement
 *        does not call `invalidateOrgEntitlements`;
 *      · a CDN in front — INFERRED: its own copy for up to the s-maxage.
 *    So the worst case is INFERRED at about 30s + 300s + 30s — past five
 *    minutes when the write skips the invalidation. MEASURED in a local prod
 *    build with no Redis (spectator W2, 2026-09-17): a denial took ~13s to
 *    refuse the card, and a restore kept serving the refusal for 38s. Owner
 *    ruling 2026-09-17: up to 5 minutes stale after an entitlement change is
 *    accepted, no tag owed — the composite above can exceed that.
 *    The competition id is what makes an Event Pass count for the competition
 *    it paid for, and only that one;
 *  - CONSENT and org scope: the person is in `public_players_v` (granted
 *    `public_name`, rostered in a public competition) for this org.
 */
export async function publicPlayerGate(
  orgSlug: string,
  compSlug: string,
  personId: string,
): Promise<PublicPlayerGate | null> {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  // The competition tag goes on the render BEFORE either refusal below can
  // return. Next adds a cached function's tags to the page entry being
  // rendered whether the function hits or misses, and a REFUSED card is cached
  // too (the page's `notFound()`). Task 14 moved the consent read out of the
  // competition-tagged read below, which left a refusal with the org tag alone
  // (`getPublicCompetition`'s), which no person write fires. The PERSON tag is
  // what a write about this person fires (`firePersonRevalidate`), and it
  // reaches the card at a competition they are not rostered in (the view is
  // org-scoped); the competition tag is what writers scoped to this
  // competition or its divisions fire. So a refused card is reached by exactly
  // what reaches an allowed one. The consent read stays OUT of the cache: this
  // entry holds nothing but the tags.
  await unstable_cache(async () => true, ["pub-player-gate-tag", shell.competition.id, personId], {
    tags: [competitionTag(shell.competition.id), personTag(personId)],
  })();
  if (!(await hasFeature(shell.org.id, "dashboard.player_profiles", shell.competition.id))) {
    return null;
  }
  const [player] = await sql<PublicPlayer[]>`
    select id, org_id, name, photo from public_players_v
    where id = ${personId} and org_id = ${shell.org.id} limit 1`;
  if (!player) return null;
  return { org: shell.org, competition: shell.competition, player };
}

/** One roster division's naming policy, with the person's consent: what `playerCardNameMask` decides from. */
export interface NameMaskPolicy {
  youth: boolean;
  player_name_display: string | null;
  consent: { public_name?: boolean } | null;
}

/**
 * The player card's name-mask DECISION (privacy hotfix 2026-09-16, explained
 * where `getPublicPlayer` applies it): every division the person is rostered in
 * across the ORG is asked, and the first policy under which
 * `isPersonNameMasked` holds wins. Null = the card shows the full name.
 *
 * One decision, two readers: the card masks its name and photo by it, and the
 * Upcoming list (`readPlayerUpcoming`) lists a masked person's own competition
 * only (owner 2026-09-23). Uncached here; the card caches it in its own entry.
 */
export async function playerCardNameMask(personId: string, orgId: string): Promise<NameMaskPolicy | null> {
  const rosterPolicies = await sql<NameMaskPolicy[]>`
    select d.youth, d.player_name_display, p.consent
    from entrant_members em
    join entrants e  on e.id = em.entrant_id
    join divisions d on d.id = e.division_id
    join persons p   on p.id = em.person_id
    where em.person_id = ${personId} and d.org_id = ${orgId}`;
  // Fails CLOSED. `public_players_v` only matches a person with a roster
  // row, so an empty read here means this query could not see it (a
  // database role that RLS filters, or a roster removed between the two
  // reads). With no policy to go on, mask. A read that throws serves no
  // card at all.
  if (rosterPolicies.length === 0) return { youth: false, player_name_display: "first_initial", consent: null };
  return rosterPolicies.find((r) => isPersonNameMasked(r.consent, r.player_name_display, r.youth)) ?? null;
}

/**
 * Player card. Every refusal is `publicPlayerGate`'s, evaluated first and per
 * call, and the card adds none of its own. Two gates, in two places,
 * deliberately:
 *  - consent lives in public_players_v (the view only contains persons who
 *    granted `public_name`), read by the gate;
 *  - the `dashboard.player_profiles` ENTITLEMENT (V307) is checked by the
 *    gate, not the view. The view cannot hold it: its filter sits over `from
 *    persons p` and a person plays in many competitions, so there is no
 *    competition in scope to make the check pass-aware — and an org-wide
 *    check would ignore an Event Pass.
 */
export async function getPublicPlayer(
  orgSlug: string,
  compSlug: string,
  personId: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  player: PublicPlayer;
  memberships: { division_name: string; division_slug: string; entrant_name: string; squad_number: number | null; position: string | null }[];
  stats: PublicPlayerStats[];
  /** S9/#418 — per-sport rollup across every division THIS competition
   *  contributed (never cross-competition, never cross-org: see this
   *  function's own comment on why). */
  career: PublicCareerSport[];
  /** Pre-rendered "Career" section heading — this page has no Dict/locale
   *  pair (see statMsg), so, like `career[].meta`, the copy is baked here. */
  careerLabel: string;
  /** W2 Task 14 — one line per started fixture the person appeared in within
   *  THIS competition, newest first (`readPlayerMatchLines`). Empty → []. */
  matches: PlayerMatchLine[];
  /** W2 Task 14 — ISO instant of the CACHED read behind `matches` (which
   *  fixtures, which side, the result): the page's true freshness. Repeats for
   *  every render served from the same cache entry. */
  generatedAt: string;
} | null> {
  // OUTSIDE the cache on purpose, every condition of it — see `publicPlayerGate`.
  const gate = await publicPlayerGate(orgSlug, compSlug, personId);
  if (!gate) return null;
  const shell = { org: gate.org, competition: gate.competition };
  const { player } = gate;

  // Stat-row copy for spectators. Deliberately NOT resolveLocale(): that reads
  // cookies()/headers() and would opt this ISR route (revalidate = 300) into
  // dynamic rendering. The org's default_locale is the documented
  // spectator-facing locale for exactly this reason.
  const orgLocale = toLocale(shell.org.default_locale);
  const statMsg = (k: Parameters<typeof msgFor>[1]) => msgFor(orgLocale, k);

  // W2 Task 14 — the per-match lines. Imported lazily because the reader
  // takes `maskPublicEntrantNames` from THIS file (one masking decision, never
  // a second): a static import back would be a value-level module cycle, and a
  // `vi.mock` of this module that spreads `importOriginal()` would meet itself
  // half-built.
  const { readPlayerMatchSeeds, completePlayerMatchLines } = await import("./public-player-matches");

  // Final review I1 (owner rule: results are never stale). The entry below
  // bakes each match's result, score line and `lastSeq`, and a score write
  // EXPIRES only the division tag (`fireScoreRevalidate`); the competition tag
  // it merely makes stale, which served the old result for the next loads. So
  // the entry carries the tag of EVERY division in the competition: the
  // matches come from any of them (a lineup can seat the person outside their
  // roster division), and the tags must be known before the read. Read here,
  // uncached, so a division created a moment ago is covered too. Cost: the
  // first card read after a score in the competition rebuilds, as the fixture
  // page already does.
  //
  // In a FIXED order (review r2-m3): the person's own divisions first (a roster
  // or a lineup seats them there), then the rest by id. An entry holds at most
  // 128 tags (`playerCardTags`), so in a competition with more divisions than
  // that, the ones dropped are divisions this person plays no match in.
  const competitionDivisions = await sql<{ id: string }[]>`
    select d.id from divisions d
    where d.competition_id = ${shell.competition.id}
    order by (
      exists (select 1 from entrant_members em join entrants e on e.id = em.entrant_id
              where e.division_id = d.id and em.person_id = ${personId})
      or exists (select 1 from lineups l join fixtures f on f.id = l.fixture_id
                 where f.division_id = d.id and l.person_id = ${personId})
    ) desc, d.id`;

  const detail = await unstable_cache(
    async () => {
      // Only the relational half is held in this entry; the cricket figures are
      // added below, OUTSIDE it (see there). Same org-default locale as `statMsg`.
      // `generatedAt` is taken with it, so it travels in the same entry.
      const generatedAt = new Date().toISOString();
      const matchSeeds = await readPlayerMatchSeeds(sql, {
        personId,
        competitionId: shell.competition.id,
        orgSlug: shell.org.slug,
        compSlug: shell.competition.slug,
        locale: orgLocale,
      });

      // Privacy hotfix (2026-09-16): `public_players_v.name` is the FULL name,
      // gated by public-name consent alone — which RS007 grants every
      // registered player by default. The division's youth/name-display policy
      // is the other axis, and the division page masks by it; this card did
      // not, so a youth player's full name reached the h1, <title>, meta
      // description, and their photo the card. Applied at the data layer, so
      // every consumer of this payload reads the masked name.
      //
      // The consent read itself is `publicPlayerGate`'s, per call and OUTSIDE
      // this entry (W2 Task 14). What this entry holds is the policy DECISION
      // (`nameMask`), applied to the gate's player after the entry resolves
      // (below), so the one decision is cached under this entry's tags, the
      // org tag included.
      //
      // A card is a PERSON, not a division, so every division the person is
      // rostered in across the ORG is asked, and the strictest wins. Not just
      // this competition's: the card resolves the person by org
      // (`publicPlayerGate`), so a youth player's id under any sibling
      // competition's URL would otherwise print the full name. Resolved through
      // the one shared resolver against the masking division's own policy; a
      // masked card carries no photo, because no public surface shows a masked
      // person's.
      //
      // Freshness. A division POLICY change is immediate: this entry carries
      // `orgTag`, and `patchDivision` expires it (`fireOrgRevalidate`) when a
      // division's stored `youth` or `player_name_display` changes. ROSTER
      // writes (entrants.ts, registrations.ts, stages.ts, imports.ts,
      // person-merge.ts) stay bounded: busting the org's whole public tree on
      // every roster edit costs too much, so a new youth roster reaches the
      // card within REVALIDATE_SLOW plus the page's 300s ISR, plus one stale
      // hit. That stale entry predates the roster, so it only shows a name
      // that was already public. Competition visibility is not an input: this
      // query reads every roster in the org, whatever the visibility.
      const strictest = await playerCardNameMask(personId, shell.org.id);
      const nameMask = strictest;

      // Memberships within THIS competition, via the consent-filtered members
      // payload (person_id present only with consent — same gate as the card).
      const membershipRows = await sql<
        {
          division_name: string; division_slug: string; entrant_id: string; kind: string;
          entrant_name: string; squad_number: number | null; position: string | null;
          youth: boolean; player_name_display: string | null;
        }[]
      >`
        select d.name as division_name, d.slug as division_slug,
               e.id as entrant_id, e.kind, e.display_name as entrant_name,
               (m->>'squad_number')::int as squad_number,
               m->>'position' as position,
               dv.youth, dv.player_name_display
        from public_entrants_v e
        join public_divisions_v d on d.id = e.division_id
        join divisions dv on dv.id = d.id
        cross join lateral jsonb_array_elements(e.members) m
        where d.competition_id = ${shell.competition.id}
          and m->>'person_id' = ${personId}
          -- The player card lists the divisions this person IS playing in.
          -- V412 lets the view publish departed entrants, so the filter the
          -- view used to apply is applied here instead.
          and e.status in ('registered','confirmed')`;
      // A non-team entrant's display name IS a person's name — an individual
      // entrant's is this player's own — so it goes through the same entrant
      // mask the division page uses, never straight off the view. Under the
      // division's own policy, or the card's strictest one when the card is
      // masked: "Arun K." above an "— Arun Kumar" membership line would undo it.
      const memberships: {
        division_name: string; division_slug: string; entrant_name: string;
        squad_number: number | null; position: string | null;
      }[] = [];
      for (const r of membershipRows) {
        const [masked] = await maskPublicEntrantNames(
          [{ id: r.entrant_id, kind: r.kind, display_name: r.entrant_name }],
          strictest ?? r,
        );
        memberships.push({
          division_name: r.division_name,
          division_slug: r.division_slug,
          entrant_name: masked!.display_name,
          squad_number: r.squad_number,
          position: r.position,
        });
      }

      // PROMPT-65: per-division totals from player_stat_snapshots, labelled
      // by the sport module's declared playerStats model (never hardcoded).
      // Same consent gate as the card — reaching here means the player is
      // publicly visible; the stats are theirs. Free at every tier.
      const snapshots = await sql<
        {
          division_id: string; division_name: string; division_slug: string;
          sport_key: string; variant_key: string; module_version: string; stats: Record<string, number>;
        }[]
      >`
        select ps.division_id, d.name as division_name, d.slug as division_slug,
               ps.sport_key, d.variant_key, d.module_version, ps.stats
        from player_stat_snapshots ps
        join public_divisions_v d on d.id = ps.division_id
        where ps.person_id = ${personId} and d.competition_id = ${shell.competition.id}
        order by d.name`;
      const stats: PublicPlayerStats[] = [];
      for (const snap of snapshots) {
        // Shared labelling (G6): same module-declared model as the /me view.
        // Locale comes from the ORG DEFAULT, never the request: that is what
        // keeps this page ISR-cacheable (see PublicOrg.default_locale), and it
        // is a function of the org, so it is stable within this cache key.
        const labelled = labelPlayerStats(snap.sport_key, snap.module_version, snap.stats, statMsg);
        if (labelled.length > 0) {
          stats.push({
            division_name: snap.division_name,
            division_slug: snap.division_slug,
            sport_key: snap.sport_key,
            metrics: labelled,
          });
        }
      }

      // S9/#418 — the per-sport career rollup, reusing the SAME snapshot rows
      // the per-division `stats` list above just read (no second query for
      // the rows themselves): `snapshots` is already filtered to
      // `d.competition_id = shell.competition.id`, so this rollup is
      // STRUCTURALLY scoped to this one competition — summing across
      // competitions (or orgs) here would leak a spectator a total the
      // consent gate never agreed to show them. Matches count is the SAME
      // shared countMatchesByDivision personCareerStats/listMyCareerStats
      // use (review round 2 finding 2) — no tenant/user scoping needed here
      // because the caller already restricts divisionIds to exactly the
      // division ids this competition's own snapshots named.
      // A competition-scoped rollup EARNS its place only where it aggregates
      // something. With one division in a sport it restates that sport's own
      // row in the `stats` list above, word for word — so those sports are
      // dropped HERE rather than at the page, which is the only place that
      // holds for a MIXED competition: gating the whole section on "some
      // sport has >1 division" still rendered the single-division sports
      // beside the one that tripped the gate, which is the duplication this
      // rule exists to remove. Dropping them here also means a competition
      // with nothing to aggregate never pays for the query below.
      const divisionsPerSport = new Map<string, Set<string>>();
      for (const s of snapshots) {
        const seen = divisionsPerSport.get(s.sport_key) ?? new Set<string>();
        seen.add(s.division_id);
        divisionsPerSport.set(s.sport_key, seen);
      }
      const aggregating = snapshots.filter(
        (s) => (divisionsPerSport.get(s.sport_key)?.size ?? 0) > 1,
      );
      if (aggregating.length === 0) {
        return {
          nameMask,
          memberships,
          stats,
          career: [],
          careerLabel: statMsg("player.career.title"),
          matchSeeds,
          generatedAt,
        };
      }
      const divisionIds = [...new Set(aggregating.map((s) => s.division_id))];
      const matchesByDivision = await countMatchesByDivision(sql, { by: "person", personId }, divisionIds);
      // This page has no Dict/locale pair to compose its own pluralized copy
      // with (see statMsg's own comment above) — so, like every metric
      // label already in this payload, the "N divisions · N variants · N
      // matches" line is baked into fully-rendered text here rather than
      // shipped as raw numbers for the page to format.
      const career: PublicCareerSport[] = groupCareerStatsBySport(
        aggregating,
        matchesByDivision,
        statMsg,
      ).map((c) => ({
        ...c,
        meta: [
          pluralStatMsg(orgLocale, "career.divisions", c.divisions),
          pluralStatMsg(orgLocale, "career.variants", c.variants),
          pluralStatMsg(orgLocale, "career.matches", c.matches),
        ].join(" · "),
      }));

      return { nameMask, memberships, stats, career, careerLabel: statMsg("player.career.title"), matchSeeds, generatedAt };
    },
    // v16 (W2 Task 14): added `matchSeeds` and `generatedAt` to this cached
    // payload, and moved `player` OUT of it (the consent read is now part of
    // `publicPlayerGate`, evaluated per call). A live v15
    // entry would keep serving without it for a full REVALIDATE_SLOW window
    // after deploy, and the page would read `undefined` where it expects a
    // list — same reason v15 retired v14's key rather than waiting.
    //
    // v16 (privacy hotfix, 2026-09-16): `player.name`, `player.photo` and
    // `memberships[].entrant_name` now follow the division name policy. A live
    // v15 entry would keep serving a youth player's full name and photo for a
    // full REVALIDATE_SLOW window after deploy.
    //
    // v17 (merge of the two v16 changes above, 2026-09-17): each branch
    // moved v15 to `-v16` with a different payload. W2's has `matchSeeds` and
    // `generatedAt` and no `player`; the privacy hotfix's still has `player`
    // and no `nameMask`. The merged payload is neither: a `-v16` entry from
    // either would read `undefined` where the page expects `matchSeeds` or
    // `nameMask`, and a W2 entry carries no mask at all. Retired rather than
    // served for a REVALIDATE_SLOW window.
    //
    // v15 (S9/#418): added the `career` rollup to this cached payload. A live
    // v14 entry would keep serving without it for a full REVALIDATE_SLOW
    // window after deploy — same reason v13 → v14 retired its key instead of
    // waiting (below).
    //
    // v14: stat labels inside this payload are now localized copy, not the
    // engine's English. A live v13 entry would keep serving English for a full
    // REVALIDATE_SLOW window after deploy, so retire the key rather than wait.
    ["pub-player-v17", shell.competition.id, personId],
    // The person tag: a write about THIS person must rebuild this entry at a
    // competition they are not rostered in, which no competition tag reaches.
    // The org tag: a division name-policy change anywhere in the org
    // (`patchDivision`) must rebuild `nameMask` (privacy hotfix).
    // The division tags: a score write expires this entry (final review I1,
    // above).
    {
      tags: playerCardTags(
        [competitionTag(shell.competition.id), personTag(personId), orgTag(shell.org.slug)],
        competitionDivisions.map((d) => d.id),
        { competitionId: shell.competition.id, personId },
      ),
      revalidate: REVALIDATE_SLOW,
    },
  )();

  // The figures half runs HERE, after the entry above has resolved, because it
  // reads a per-fixture `unstable_cache` of its own — and Next skips the cache
  // read of an `unstable_cache` called inside another one's callback. From in
  // there, every miss of this page's entry (every score write in the
  // competition busts it) would re-fold every cricket match the person played.
  const { matchSeeds, nameMask, ...rest } = detail;
  const matches = await completePlayerMatchLines(sql, matchSeeds, { personId, locale: orgLocale });
  // The privacy hotfix's decision, cached above, applied to the gate's
  // per-call player: the masked name, and no photo.
  const shown: PublicPlayer = nameMask
    ? {
        ...player,
        name: resolvePersonDisplayName(player.name, nameMask.consent, nameMask.player_name_display, nameMask.youth),
        photo: null,
      }
    : player;
  return { org: shell.org, competition: shell.competition, player: shown, ...rest, matches };
}

/**
 * Player profile — upcoming matches across the org (spec 2026-09-23). Takes
 * the GATE's result, not loose ids. The type is structural, not branded, so the
 * compiler cannot prove where the value came from: callers must pass the value
 * `publicPlayerGate` (or `getPublicPlayer`, built on it) returned, which keeps
 * every refusal the gate's. The page does, and its test pins that identity.
 * Only fixture data is read (already public on each fixture's own page), never
 * another competition's card, so no other competition's entitlement is asked
 * (spec §4).
 *
 * UNCACHED on purpose (plan D3): a schedule write in ANOTHER competition fires
 * that competition's tags, none of which this card carries, so a tagged entry
 * would serve a moved fixture until its TTL anyway. The page's own ISR
 * (`s-maxage=30`, measured — `publicPlayerGate`'s note) bounds the reads.
 *
 * Imported lazily for the same reason as the Matches reader in
 * `getPublicPlayer`: it takes `maskPublicEntrantNames` from THIS file.
 */
export async function getPublicPlayerUpcoming(
  gate: PublicPlayerGate,
  opts: { now?: Date } = {},
): Promise<PlayerUpcomingRow[]> {
  const { readPlayerUpcoming } = await import("./public-player-matches");
  return readPlayerUpcoming(sql, {
    orgId: gate.org.id,
    orgSlug: gate.org.slug,
    personId: gate.player.id,
    currentCompetitionId: gate.competition.id,
    locale: toLocale(gate.org.default_locale),
    now: opts.now ?? new Date(),
  });
}

/**
 * Realtime entitlement for a public fixture's COMPETITION (token route, doc 09 §4).
 * Uncached-tagless: short TTL via unstable_cache keyed on fixture id.
 *
 * Scoped to the competition, not the org: an Event Pass buys realtime for one
 * competition, and the org-wide overload 403s the token route for a fixture the
 * organiser has paid for. The join already carries the competition id — only the
 * argument was missing.
 */
export async function fixtureRealtimeEligible(fixtureId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return false;
  const [row] = await sql<{ realtime: boolean }[]>`
    select org_has_feature(c.org_id, 'realtime', c.id) as realtime
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    where f.id = ${fixtureId} limit 1`;
  return row?.realtime === true;
}

/**
 * Addendum RT (Task 14b fix round 2; owner decision 2026-09-29): a community org's STREAM OVERLAY gets real-time
 * scores. Answers whether THIS fixture's overlay may have a realtime token without the plan's `realtime`: the fixture
 * is public (the same views as `fixtureRealtimeEligible`, so a private competition never qualifies), it has a stream
 * session in `ACTIVE_STATES` (it is being broadcast — the partial unique index `fixture_stream_sessions_one_active`
 * holds exactly these states), and the org has `streaming.overlay`, read as the overlay page reads it: `hasFeature`,
 * competition-scoped. The caller's declared purpose is the route's to check; this never sees it.
 */
export async function fixtureOverlayRealtimeEligible(fixtureId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return false;
  const [row] = await sql<{ org_id: string; competition_id: string }[]>`
    select c.org_id, c.id as competition_id
    from public_fixtures_v f
    join public_divisions_v d on d.id = f.division_id
    join public_competitions_v c on c.id = d.competition_id
    where f.id = ${fixtureId}
      and exists (select 1 from fixture_stream_sessions s where s.fixture_id = f.id and s.state in ${sql([...ACTIVE_STATES])})
    limit 1`;
  if (!row) return false;
  return hasFeature(row.org_id, "streaming.overlay", row.competition_id);
}

/** Sitemap source: every `public` competition past draft, with its division
 *  slugs — a draft is unlisted until published (`lib/competition-listing.ts`). */
export async function listPublicSitemapEntries(): Promise<
  { orgSlug: string; compSlug: string; divisionSlugs: string[]; updated: string }[]
> {
  const rows = await sql<
    { org_slug: string; comp_slug: string; div_slug: string | null; created_at: string }[]
  >`
    select o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug, c.created_at
    from public_competitions_v c
    join organizations o on o.id = c.org_id
    left join public_divisions_v d on d.competition_id = c.id
    where c.visibility = 'public' and c.status <> 'draft'
    order by o.slug, c.slug`;
  const map = new Map<string, { orgSlug: string; compSlug: string; divisionSlugs: string[]; updated: string }>();
  for (const r of rows) {
    const key = `${r.org_slug}/${r.comp_slug}`;
    const entry = map.get(key) ?? {
      orgSlug: r.org_slug,
      compSlug: r.comp_slug,
      divisionSlugs: [],
      updated: r.created_at,
    };
    if (r.div_slug) entry.divisionSlugs.push(r.div_slug);
    map.set(key, entry);
  }
  return [...map.values()];
}
