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
import { hasFeature } from "@/lib/entitlements";
import { isoDateTime } from "@/lib/public-site";
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
import { anyOptedOut, resolvePersonDisplayName } from "@/lib/name-display";
import { loadMatchCentre } from "./match-centre-load";
import type { MatchCentreDocT } from "./match-centre-schema";

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
}

export interface PublicStage {
  id: string;
  division_id: string;
  seq: number;
  kind: "league" | "group" | "swiss" | "knockout" | "double_elim" | "stepladder";
  name: string;
  status: string;
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
  photo: string | null;
  person_id: string | null; // null = no public-name consent, no player card
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

/** Org landing: the org + its `public` competitions (unlisted stays link-only). */
export async function getPublicOrg(orgSlug: string): Promise<{
  org: PublicOrg;
  competitions: PublicCompetition[];
} | null> {
  return unstable_cache(
    async () => {
      const org = await loadOrg(orgSlug);
      if (!org) return null;
      const competitions = await sql<PublicCompetition[]>`
        select id, org_id, name, slug, description, starts_on, ends_on, branding,
               status, visibility
        from public_competitions_v
        where org_id = ${org.id} and visibility = 'public'
        order by starts_on desc nulls last, created_at desc`;
      return { org, competitions };
    },
    ["pub-org", orgSlug],
    { tags: [orgTag(orgSlug)], revalidate: REVALIDATE_FAST },
  )();
}

/** Competition home: hero + divisions (+ live-now strip). */
export type LiveNowFixture = Omit<PublicFixture, "venue" | "court_label" | "venue_name" | "court_name">;

export async function getPublicCompetition(
  orgSlug: string,
  compSlug: string,
): Promise<{
  org: PublicOrg;
  competition: PublicCompetition;
  divisions: PublicDivision[];
  /** Review wave 3: this query selects no court/venue columns, so the type must
   *  not claim them — it used to, and they read `undefined` at runtime. A
   *  future "Live now" card wanting a location wires it like getPublicDivision
   *  does (see the query's own note), rather than widening this back. */
  liveNow: LiveNowFixture[];
} | null> {
  const shell = await unstable_cache(
    async () => {
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
               (select count(*)::int from public_entrants_v e
                 where e.division_id = d.id) as entrant_count,
               -- RS008 review fix #5: public_divisions_v does not expose
               -- these (see PublicDivision's own doc comment) — a cheap
               -- primary-key join to the base table rather than widening
               -- that view for every other consumer of it.
               dv.youth, dv.player_name_display, dv.config
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
        order by f.scheduled_at nulls last limit 12`;
      return { org, competition, divisions, liveNow: liveNow.map(normalizeFixture) };
    },
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

  return entrants.map((e) => {
    const optedOut = e.kind !== "team" && anyOptedOut(consentsByEntrant.get(e.id) ?? []);
    const fresh = e.members ? memberRowsByEntrant.get(e.id) : undefined;
    const remaskedMembers =
      e.members && fresh && fresh.length === e.members.length
        ? e.members.map((m, i) => ({
            ...m,
            name: resolvePersonDisplayName(
              fresh[i]!.full_name,
              fresh[i]!.consent,
              division.player_name_display ?? null,
              division.youth ?? false,
            ),
          }))
        : undefined;
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
              division.player_name_display ?? null,
              division.youth ?? false,
            ),
    };
  });
}

/** Division home: schedule + standings + entrants + stage skeleton. */
export async function getPublicDivision(
  orgSlug: string,
  compSlug: string,
  divSlug: string,
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
    async () => {
      const stages = await sql<PublicStage[]>`
        select id, division_id, seq, kind, name, status
        from public_stages_v where division_id = ${division.id} order by seq`;
      const pools = await sql<{ id: string; stage_id: string; key: string; name: string }[]>`
        select p.id, p.stage_id, p.key, p.name
        from public_pools_v p
        join public_stages_v s on s.id = p.stage_id
        where s.division_id = ${division.id} order by p.key`;
      const rawFixtures = await sql<PublicFixture[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
               scheduled_at, venue, court_label,
               status, outcome, summary, last_seq,
               lane, is_final, third_place, conditional
        from public_fixtures_v where division_id = ${division.id}
        order by round_no, seq_in_round`.then((rows) => rows.map(normalizeFixture));
      const fixtures = await withCourtVenueNames(rawFixtures);
      const standings = await sql<PublicStandings[]>`
        select stage_id, pool_id, rows, updated_at
        from public_standings_v where division_id = ${division.id}`;
      const rawEntrants = await sql<PublicEntrant[]>`
        select id, division_id, kind, display_name, seed, status, members,
               team_display, badge_url
        from public_entrants_v where division_id = ${division.id}
        order by seed nulls last, display_name`;
      // RS008 review fix #5 — masks a non-team entrant's own display_name by
      // consent (and, unlike before this fix, by youth too). Feeds THIS
      // page's own render, the calendar.ics/poster.pdf exports, and (via the
      // `{...data}` spread in the two /present page.tsx files) the
      // slideshow kiosk's own independent masking pass (fix #2).
      const entrants = await maskPublicEntrantNames(rawEntrants, division);
      // Venue lane (V305): the division's override, else the org's timezone.
      const [ss] = await sql<{ tz: string }[]>`
        select coalesce(ss.tz, o.timezone, 'UTC') as tz
        from divisions d
        left join schedule_settings ss on ss.division_id = d.id
        left join organizations o on o.id = d.org_id
        where d.id = ${division.id}`;
      return { stages, pools, fixtures, standings, entrants, tz: ss?.tz ?? "UTC" };
    },
    ["pub-div", division.id],
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
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(fixtureId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;
  const division = shell.divisions.find((d) => d.slug === divSlug);
  if (!division) return null;

  const detail = await unstable_cache(
    async () => {
      const [fixtureRow] = await sql<PublicFixture[]>`
        select id, division_id, stage_id, pool_id, round_no, seq_in_round,
               home_entrant_id, away_entrant_id, home_slot_label, away_slot_label,
               scheduled_at, venue, court_label,
               status, outcome, summary, last_seq,
               lane, is_final, third_place, conditional
        from public_fixtures_v
        where id = ${fixtureId} and division_id = ${division.id} limit 1`;
      if (!fixtureRow) return null;
      const fixture = await withCourtVenueName(normalizeFixture(fixtureRow));
      const rawNames = await sql<{ id: string; kind: string; display_name: string }[]>`
        select id, kind, display_name from public_entrants_v
        where division_id = ${division.id}`;
      // RS008 review fix #5 — entrantNames fed the fixture page's own
      // home/away display with ZERO masking, not even by youth.
      const names = await maskPublicEntrantNames(rawNames, division);
      // Competition-scoped: an Event Pass grants realtime for the competition it
      // was bought for, so the org-wide 2-arg overload denies a paid-for fixture.
      // This is the SPECTATOR side of the grant — the organiser's own noticeboard
      // was already comp-scoped, so an org-wide read here meant a buyer saw live
      // scoring work for themselves and for none of their audience, which is the
      // whole point of the feature.
      const [rt] = await sql<{ realtime: boolean }[]>`
        select org_has_feature(${shell.org.id}, 'realtime', ${shell.competition.id})
               as realtime`;
      // Task 9 — the division's own tz override (V305 venue lane; org
      // timezone is `shell.org`'s own row, read separately below since
      // `PublicOrg` does not carry it — see `resolveVenueTz`'s doc comment
      // for why venue tz is never inherited from a personal/browser lane).
      const [tzRow] = await sql<{ division_tz: string | null; org_tz: string | null }[]>`
        select ss.tz as division_tz, o.timezone as org_tz
        from divisions d
        left join schedule_settings ss on ss.division_id = d.id
        left join organizations o on o.id = d.org_id
        where d.id = ${division.id}`;
      const [stageRow] = await sql<{ name: string }[]>`
        select name from stages where id = ${fixture.stage_id}`;
      const locale = toLocale(shell.org.default_locale);
      const basePath = `/shared/${shell.org.slug}/${shell.competition.slug}/${division.slug}`;
      const matchCentre = await loadMatchCentre(sql, fixture, {
        orgTz: tzRow?.org_tz ?? null,
        division: {
          sportKey: division.sport_key,
          moduleVersion: division.module_version,
          formatLabel: division.variant_key,
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
      };
    },
    ["pub-fixture", fixtureId],
    { tags: [divisionTag(division.id)], revalidate: REVALIDATE_FAST },
  )();
  if (!detail) return null;

  return { org: shell.org, competition: shell.competition, division, ...detail };
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

/**
 * Player card. Two gates, in two places, deliberately:
 *  - consent lives in public_players_v (the view only contains persons who
 *    granted `public_name`);
 *  - the `dashboard.player_profiles` ENTITLEMENT lives here (V307). The view
 *    cannot hold it: its filter sits over `from persons p` and a person plays
 *    in many competitions, so there is no competition in scope to make the
 *    check pass-aware — and an org-wide check would ignore an Event Pass.
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
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  const shell = await getPublicCompetition(orgSlug, compSlug);
  if (!shell) return null;

  // OUTSIDE the cache on purpose. The closure below is keyed on
  // `competition:{id}`, and no entitlement write busts that tag — a gate placed
  // inside it would be frozen at whatever the org held when the page was first
  // cached, so a lapsed org would keep serving player cards for a full
  // REVALIDATE_SLOW window. Evaluated per request, `hasFeature`'s own 5-minute
  // cache is the only staleness, which is the bound we accept everywhere else.
  // The competition id is what makes an Event Pass count for the competition it
  // paid for, and only that one.
  if (!(await hasFeature(shell.org.id, "dashboard.player_profiles", shell.competition.id))) {
    return null;
  }

  // Stat-row copy for spectators. Deliberately NOT resolveLocale(): that reads
  // cookies()/headers() and would opt this ISR route (revalidate = 300) into
  // dynamic rendering. The org's default_locale is the documented
  // spectator-facing locale for exactly this reason.
  const orgLocale = toLocale(shell.org.default_locale);
  const statMsg = (k: Parameters<typeof msgFor>[1]) => msgFor(orgLocale, k);

  const detail = await unstable_cache(
    async () => {
      const [player] = await sql<PublicPlayer[]>`
        select id, org_id, name, photo from public_players_v
        where id = ${personId} and org_id = ${shell.org.id} limit 1`;
      if (!player) return null;
      // Memberships within THIS competition, via the consent-filtered members
      // payload (person_id present only with consent — same gate as the card).
      const memberships = await sql<
        { division_name: string; division_slug: string; entrant_name: string; squad_number: number | null; position: string | null }[]
      >`
        select d.name as division_name, d.slug as division_slug,
               e.display_name as entrant_name,
               (m->>'squad_number')::int as squad_number,
               m->>'position' as position
        from public_entrants_v e
        join public_divisions_v d on d.id = e.division_id
        cross join lateral jsonb_array_elements(e.members) m
        where d.competition_id = ${shell.competition.id}
          and m->>'person_id' = ${personId}`;

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
        return { player, memberships, stats, career: [], careerLabel: statMsg("player.career.title") };
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

      return { player, memberships, stats, career, careerLabel: statMsg("player.career.title") };
    },
    // v15 (S9/#418): added the `career` rollup to this cached payload. A live
    // v14 entry would keep serving without it for a full REVALIDATE_SLOW
    // window after deploy — same reason v13 → v14 retired its key instead of
    // waiting (below).
    //
    // v14: stat labels inside this payload are now localized copy, not the
    // engine's English. A live v13 entry would keep serving English for a full
    // REVALIDATE_SLOW window after deploy, so retire the key rather than wait.
    ["pub-player-v15", shell.competition.id, personId],
    { tags: [competitionTag(shell.competition.id)], revalidate: REVALIDATE_SLOW },
  )();
  if (!detail) return null;

  return { org: shell.org, competition: shell.competition, ...detail };
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

/** Sitemap source: every `public` competition with its division slugs. */
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
    where c.visibility = 'public'
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
