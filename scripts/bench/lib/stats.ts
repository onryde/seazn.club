// stats.ts — B03 T6b. Player-stats BASELINE over the real REST API: three
// routes (`GET /persons/{id}/stats`, `GET /divisions/{id}/stats/players`,
// `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/divisions/
// {divisionSlug}/stats`), driven for real against a freshly seeded
// division, never merely defined (AGENTS.md recurring-failure class 1 —
// see `lib/seed.ts`'s own header comment on `seedOfficialsAndClaims` for
// the exact shape of that mistake this file exists not to repeat).
//
// ---------------------------------------------------------------------------
// What this file does NOT do, and why: real stat VALUES need a fold
// ---------------------------------------------------------------------------
// The T6b brief asked this file to pin three things: the endpoints answer;
// the seeded roster is present in the division player table; the public
// projection is non-empty and names the seeded people. The first is real.
// The second and third are NOT achievable today, and this is a finding, not
// a shortcut this file took:
//
// `divisionPlayerStats`/`personStats`/`publicDivisionStats`
// (`apps/web/src/server/usecases/player-stats.ts:287,354,525`) all read
// EXCLUSIVELY from `player_stat_snapshots`, and that table is deleted and
// rebuilt on every recompute from `score_events` alone
// (`recomputePlayerStats`, same file, lines 55-171): `events` is a plain
// `select ... from score_events se join fixtures f ... where f.division_id
// = $1`, `byFixture` is built ONLY from those rows, and the insert loop at
// lines 162-171 writes exactly one row per person `sumPlayerStats` credits
// from that fold — nothing seeds a zero-stat row from entrant registration
// alone. `_tiny`'s own suite (`lib/suites/tiny.ts`) generates and schedules
// fixtures but posts NO `score_events` — scoring is explicitly out of B03's
// charter ("do not try to score anything here"). So for a freshly seeded,
// unscored `_tiny` division, all three routes genuinely return EMPTY
// rows/divisions arrays today — confirmed by reading the full data path,
// not merely grepped, and independently corroborated by `scripts/smoke.ts`
// itself: its OWN `stats/players` exercise (smoke.ts:16080-16122) posts a
// real `core.start` + `football.goal` BEFORE reading the table, because
// without that fold there is nothing there to read.
//
// This means "the seeded roster is present" and "the public projection is
// non-empty" cannot be pinned as TRUE assertions against a live, unscored
// `_tiny` run without either violating B03's own charter (scoring
// something) or asserting something false. What this file pins instead,
// against the REAL run:
//
//   - all three routes answer 200 (reachability, for real, over HTTP);
//   - every roster person got a real, individually-addressed
//     `GET /persons/{id}/stats?division_id=` read (coverage — proves this
//     driver did not silently skip anyone, the class-6 "absent symptom"
//     failure this repo has hit before);
//   - `divisionPlayerStats`/`publicDivisionStats` never attribute a row to
//     a person OUTSIDE the seeded roster (a real, always-checkable
//     invariant, independent of fold state — catches a cross-division/
//     cross-org leak regardless of whether anything has been scored yet);
//   - `requires_detailed_scoring` reads `false` — itself a DERIVED, pinned
//     value (the field is `hasModel && rows.length === 0 && decided > 0`;
//     `decided` is the count of fixtures with `status = 'decided'`, which
//     `_tiny` never reaches, so this is `false` by construction of what
//     this suite does, not a guessed constant).
//
// The genuinely-valuable "consent reflects what the seed wrote" check
// (`playerStatsBaselineIssues`' name-matching branch below) is real code,
// unit-tested with a crafted fake standing in for a post-fold response —
// but it is INERT against today's live run, because there is nothing in
// `publicDivisionStats.rows` for it to check. It becomes load-bearing the
// moment B05 (or any later task) folds a real score event into `_tiny` —
// recorded here, not hidden, exactly the AGENTS.md class-5 guidance ("a
// false premise is a finding to record, not a blocker").
//
// ---------------------------------------------------------------------------
// Why `visibility` has to be set on THIS run's competition at all
// ---------------------------------------------------------------------------
// `publicDivisionStats`'s own division lookup requires `c.visibility in
// ('public','unlisted')` (player-stats.ts:534-536) — and `CreateCompetition.
// visibility` defaults to `'private'` (schemas.ts:94), which is exactly
// what `seedSuite` sent before this task (no `visibility` key at all). So
// the public route 404s on `_tiny` today for a SECOND, independent reason
// from the emptiness above — nothing to do with consent or scoring. Fixed
// at the bench-runtime layer, never in the pack: `lib/seed.ts`'s
// `SeedSuiteInput.competitionVisibility` (T6b's own extension, same shape
// as T4's `competitionBranding`), threaded from `runTinySuite` only when a
// plan has been provisioned (`input.sql` present) — see that call site's
// own comment for why.
//
// ---------------------------------------------------------------------------
// DI, same shape as every other file in this directory
// ---------------------------------------------------------------------------
// `SeedTransport` (signIn + request) is all this file needs — no new
// transport shape, no `global.fetch` anywhere, including in this file's own
// unit tests.
import { newSession, type Session } from "./http.ts";
import { defaultTransport, type SeedTransport } from "./seed.ts";

// ---------------------------------------------------------------------------
// Wire shapes — hand mirrors of the usecases cited above, narrowed to the
// fields this file actually reads.
// ---------------------------------------------------------------------------

export interface PersonStatsRead {
  readonly divisions: readonly { division_id: string; division_name: string; stats: Record<string, number> }[];
}

export interface DivisionPlayerStatsRead {
  readonly metrics: readonly { key: string; label: string }[];
  readonly rows: readonly { person_id: string; full_name: string; stats: Record<string, number> }[];
  readonly requires_detailed_scoring: boolean;
}

export interface PublicDivisionStatsRead {
  readonly rows: readonly { name: string; stats: Record<string, number> }[];
}

/** `GET /api/orgs` (`apps/web/src/app/api/v1/../../../orgs/route.ts` — a
 *  SESSION-cookie route, not `/api/v1`, same one `scripts/smoke.ts` itself
 *  uses at `playerAccountsSuite`/l.3735-3739 to learn its own org's slug).
 *  There is no `GET /api/v1/orgs/{id}` at all (checked: no `orgs/[id]/
 *  route.ts` file exists) — this is the only reachable surface that hands
 *  back a signed-in user's own org slug, needed here purely to build the
 *  public route's URL. */
interface OrgMembershipRow {
  readonly id: string;
  readonly slug: string;
}

/** `GET /divisions/{id}` (`getDivision`, `usecases/divisions.ts`'s `COLS`
 *  includes `slug`) — the division's slug is server-generated from `name`
 *  at create time (`seedSuite`'s own division create call sends no `slug`
 *  field), so it has to be read back, never guessed offline. */
interface DivisionSlugRow {
  readonly slug: string;
}

export interface RosterMemberRef {
  /** The pack's own person ref — never sent over the wire, just the join
   *  key this file's caller and its test fixtures both already know. */
  readonly personRef: string;
  readonly personId: string;
  readonly full_name: string;
}

export interface ReadPlayerStatsBaselineInput {
  readonly base: string;
  /** Same identity `seedSuite`/`seedOfficialsAndClaims` signed in with —
   *  this function signs in AGAIN with it, the same self-contained
   *  precedent both of those already follow (`lib/seed.ts`'s header
   *  comment on "a second magic-link round trip, accepted as the cost of
   *  keeping [each driver] self-contained"). */
  readonly email: string;
  readonly orgId: string;
  readonly divisionId: string;
  /** Every roster member this baseline should individually query
   *  `GET /persons/{id}/stats` for — the primary division's registered
   *  players, resolved by the caller from `plan.entrants`/`plan.persons`/
   *  `SeededSuite.personIdByRef` (never re-derived here: this file has no
   *  `SeedPlan` dependency of its own). */
  readonly roster: readonly RosterMemberRef[];
  /** `plan.competition.slug` — required to address the public route at
   *  all. Undefined when the pack declares no explicit slug (mirrors
   *  `lib/suites/tiny.ts`'s own `findExistingSeed`: "there is then nothing
   *  stable to match on"); the public-stats read is skipped entirely in
   *  that case, `publicDivisionStats` stays absent on the result rather
   *  than guessing a server-minted slug this file cannot predict. */
  readonly competitionSlug?: string;
  readonly transport?: SeedTransport;
}

export interface PlayerStatsBaseline {
  readonly orgSlug: string;
  readonly divisionSlug: string;
  readonly personStatsByPersonRef: ReadonlyMap<string, PersonStatsRead>;
  readonly divisionStats: DivisionPlayerStatsRead;
  /** Absent exactly when `competitionSlug` was omitted — see that field's
   *  own doc comment. */
  readonly publicDivisionStats?: PublicDivisionStatsRead;
}

/**
 * Drives the three stats routes for real, over one signed-in session (the
 * public route is hit through the SAME session for simplicity — it needs
 * none, and sending cookies to a public route is harmless). See this
 * file's header comment for what is, and is not, provable against a
 * freshly seeded, unscored division.
 */
export async function readPlayerStatsBaseline(input: ReadPlayerStatsBaselineInput): Promise<PlayerStatsBaseline> {
  const { base, email, orgId, divisionId, roster, competitionSlug } = input;
  const t = input.transport ?? defaultTransport;
  const s: Session = newSession();
  await t.signIn(base, s, email);

  const orgs = await t.request<OrgMembershipRow[]>(base, s, "/api/orgs");
  const org = orgs.find((o) => o.id === orgId);
  if (org === undefined) {
    throw new Error(
      `readPlayerStatsBaseline: GET /api/orgs returned ${orgs.length} org(s) for this session, none matching "${orgId}"`,
    );
  }

  const division = await t.request<DivisionSlugRow>(base, s, `/api/v1/divisions/${divisionId}`);

  const personStatsByPersonRef = new Map<string, PersonStatsRead>();
  await Promise.all(
    roster.map(async (r) => {
      const read = await t.request<PersonStatsRead>(
        base,
        s,
        `/api/v1/persons/${r.personId}/stats?division_id=${divisionId}`,
      );
      personStatsByPersonRef.set(r.personRef, read);
    }),
  );

  const divisionStats = await t.request<DivisionPlayerStatsRead>(
    base,
    s,
    `/api/v1/divisions/${divisionId}/stats/players`,
  );

  let publicDivisionStats: PublicDivisionStatsRead | undefined;
  if (competitionSlug !== undefined) {
    publicDivisionStats = await t.request<PublicDivisionStatsRead>(
      base,
      s,
      `/api/v1/public/orgs/${org.slug}/competitions/${competitionSlug}/divisions/${division.slug}/stats`,
    );
  }

  return {
    orgSlug: org.slug,
    divisionSlug: division.slug,
    personStatsByPersonRef,
    divisionStats,
    ...(publicDivisionStats === undefined ? {} : { publicDivisionStats }),
  };
}

// ---------------------------------------------------------------------------
// The pure guard — see this file's header comment for which of its checks
// are load-bearing against TODAY's live run and which are inert until a
// later task folds a real score event.
// ---------------------------------------------------------------------------

/**
 * Every issue found, `[]` on a clean baseline. Derives every expectation
 * from `roster` (itself pack-derived by the caller) — never a typed-in
 * count or name, so editing `_tiny.json`'s roster moves this check with it.
 */
export function playerStatsBaselineIssues(
  baseline: PlayerStatsBaseline,
  roster: readonly RosterMemberRef[],
): readonly string[] {
  const issues: string[] = [];
  const rosterIds = new Set(roster.map((r) => r.personId));

  // --- coverage: every roster person got its OWN read, never silently
  // skipped (the class-6 "absent symptom" failure). ---
  for (const r of roster) {
    if (!baseline.personStatsByPersonRef.has(r.personRef)) {
      issues.push(
        `persons/${r.personId}/stats (ref "${r.personRef}"): no read-back recorded — ` +
          `GET /persons/{id}/stats was never called, or its result was dropped`,
      );
    }
  }

  // --- the division leaderboard never attributes a row to a stranger, and
  // never repeats one — true regardless of fold state, so it is a REAL,
  // live-checkable invariant today, not merely "reachable". ---
  const seenDivisionRowIds = new Set<string>();
  for (const row of baseline.divisionStats.rows) {
    if (!rosterIds.has(row.person_id)) {
      issues.push(
        `divisions/.../stats/players: row for person "${row.person_id}" is not in the seeded roster`,
      );
    }
    if (seenDivisionRowIds.has(row.person_id)) {
      issues.push(`divisions/.../stats/players: person "${row.person_id}" appears twice`);
    }
    seenDivisionRowIds.add(row.person_id);
  }

  // --- with zero folded score events (this suite's own charter — see this
  // file's header comment), `requires_detailed_scoring` is DERIVED false,
  // not guessed: the field is `hasModel && rows.length === 0 && decided >
  // 0`, and `decided` (fixtures with status='decided') is 0 by construction
  // of what `_tiny` does. A `true` here means either a stray score event
  // this run did not intend, or the field's own derivation changed under
  // this suite — either way, worth surfacing rather than silently trusting
  // whatever the route answered. ---
  if (baseline.divisionStats.requires_detailed_scoring !== false) {
    issues.push(
      `divisions/.../stats/players: requires_detailed_scoring is ${baseline.divisionStats.requires_detailed_scoring}, ` +
        `expected false for a division this suite never scores`,
    );
  }

  // --- the public projection: real code, INERT today (see header comment)
  // — every row it DOES carry must name a seeded roster person with their
  // FULL name, never initials (`public_person_name`'s opt-in predicate,
  // `db/migration/v2-engine/functions/V229__fn_public_person_name.sql` —
  // `seed-plan.ts` seeds every person `{public_name:true}` for exactly this
  // reason), and it must never carry an unrecognised name. Vacuously true
  // while `rows` is empty (today's real baseline), and becomes load-bearing
  // the moment a fold populates it. ---
  if (baseline.publicDivisionStats !== undefined) {
    const rosterFullNames = new Set(roster.map((r) => r.full_name));
    for (const row of baseline.publicDivisionStats.rows) {
      if (!rosterFullNames.has(row.name)) {
        issues.push(
          `public stats: row named "${row.name}" is neither a seeded roster person's full name nor blank — ` +
            `either an unexpected person, or public_name consent was not honoured (initials instead of the ` +
            `full name every seeded person consents to)`,
        );
      }
    }
  }

  return issues;
}
