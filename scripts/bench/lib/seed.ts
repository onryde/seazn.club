// seed.ts — the HTTP driver. Takes a `SeedPlan` (lib/seed-plan.ts's PURE
// pack -> request-body mapping) and drives it over the real REST API,
// returning the real ids every later bench layer (scheduling, event-import,
// oracles) needs to do its own job. `buildSeedPlan` decides WHAT to send;
// this file decides WHEN and HOW, and turns pack refs into database uuids —
// exactly the split `PackRef`'s own doc comment predicts: "the seeding layer
// resolves it to a UUID and hands back a map" (pack-schema.ts:173-175).
//
// ---------------------------------------------------------------------------
// Testability — an injected transport, never `global.fetch`
// ---------------------------------------------------------------------------
// `lib/env.ts`'s `runPreflight(base, probes)` is this directory's precedent
// for DI over live I/O (its own header comment: "so `runPreflight` itself is
// pure and unit-testable with fakes"; CI's own comment at
// `.github/workflows/ci.yml:167-170` calls this out as the reason the bench
// lib suite is DB-free). `SeedTransport` below is the same shape of split,
// narrowed to exactly the two calls this file makes (`signIn`, `request`) —
// `lib/__tests__/http.test.ts` mocks `global.fetch` to test `request()`
// itself, which is right for THAT file and wrong here: this module never
// needs to know fetch exists, only that something can sign in and make a
// typed call.
//
// ---------------------------------------------------------------------------
// Two things this file does NOT get from `SeedPlan`
// ---------------------------------------------------------------------------
// `SeedPlan` (seed-plan.ts:188-203) carries org/competition/divisions/
// persons/entrants/officialPersonRefs/expectedFixtureCounts — no `venues`
// field and no `streams` field, because `buildSeedPlan` resolves only the
// six create-call bodies it owns; venues and streams are pack-level, not
// plan-level. So `seedSuite` below takes them as separate inputs, straight
// off the (already `PackSchema`-validated) pack: `venues` maps 1:1 onto
// `CreateVenue`/`CreateCourtInput` with no computed fields (nothing to
// "plan" — see `seedVenuesAndCourts`), and `streams` is what `bindStreamFixtures`
// binds against the real `/generate` response. Keeping them as their own
// parameters (rather than re-deriving a `Pack` inside this file, or adding
// them to `seed-plan.ts`, which the brief forbids touching) means a unit
// test builds a bare `SeedPlan` + a bare `PackStream[]` literal — plain
// data, no `PackSchema.parse()` required — instead of a whole valid `Pack`.
//
// ---------------------------------------------------------------------------
// The run tag is THIS layer's parameter, not `seed-plan.ts`'s
// ---------------------------------------------------------------------------
// `seed-plan.ts`'s own header comment (lines 15-21) says so directly:
// `tinyPlan` (lib/suites/tiny.ts:100) resolves `pack.competition.name`
// LITERALLY and `runTinySuite` appends its `runTag` at HTTP-call time
// (lib/suites/tiny.ts:255) — "the existing precedent is that it is not this
// layer's parameter at all, it is the HTTP driver's." `seedSuite` follows
// that precedent for the competition name AND reuses `runTag` to build the
// sign-in email, generalizing tiny.ts's hardcoded `bench-tiny-${runTag}`
// (suites/tiny.ts:229) with `plan.org.slug` in place of the literal "tiny" —
// which is also the ONE place `SeedPlanOrg.slug` gets used. There is no v1
// REST route to set an org's name, slug or timezone at all: sign-in
// auto-provisions a default org named literally "My organization"
// (`apps/web/src/lib/auth.ts:377-391`, `ensureActiveOrg`/`createOrgForUser`),
// there is no `apps/web/src/app/api/v1/orgs/route.ts` (only `orgs/[id]/...`
// subresources — checked, `find apps/web/src/app/api/v1/orgs -maxdepth 1
// -type f` returns nothing), and `schemas.ts` declares no `PatchOrg` /
// `CreateOrg` symbol at all. So `plan.org.name` and `plan.org.timezone` have
// NO reachable surface in this driver and are never sent anywhere — a brief/
// API-shape finding recorded here rather than guessed around (an org PATCH
// this file invented would be product code no route exists to receive).
//
// ---------------------------------------------------------------------------
// Officials + claim invites (B03 T6/T7, split per the B03 review 2026-09-03,
// finding F1(b)) — `seedOfficialsAndClaims` IS called from `seedSuite`;
// `runOfficialsAutoAssign` is NOT
// ---------------------------------------------------------------------------
// `seedOfficialsAndClaims` creates every official, sets every blackout,
// PATCHes every MANUAL assignment, mints every claim invite (the pack's own
// player invites and each official's own `/invite`) — none of that depends
// on scheduling or on an entitlement (every one of those routes is free on
// every plan; see `SeedOfficialsAndClaimsInput`'s own doc comments), so it
// runs from `seedSuite`, before scheduling exists, same as everything else
// `seedSuite` drives.
//
// The AUTO pass does not, and a previous cut of this file got that wrong by
// folding it in here too, gated on a flag: `POST /divisions/{id}/officials/
// auto`'s own `engineInput` filters `where scheduled_at is not null`
// (`usecases/officials.ts:386`) — called from inside `seedSuite`, which
// completes before `runTinySuite`'s own scheduling walk (schedule-settings ->
// schedule/auto -> schedule/apply) even starts, it always proposed zero.
// Structurally dead, not merely untested: no ordering of `autoAssign: true`
// against `seedSuite`'s own internals could ever have reached a scheduled
// fixture. `_tiny.json`'s "off-eli" official (empty `assignments`, the one
// this pack declares specifically to exercise this path) could never be
// reached by any real run — see
// `docs/superpowers/specs/bench-product-value/B03-review-findings-2026-09-03.md`,
// F1(b).
//
// So the auto pass is `runOfficialsAutoAssign` below: a separate export,
// independently unit-tested, that `runTinySuite` calls AFTER its own
// `schedule/apply` succeeds — the only point at which the fixtures the pack's
// auto-needing officials could be proposed onto actually carry a
// `scheduled_at`. It is also the one entitlement-gated step in this whole
// file (`requireFeature(orgId, "officials.auto")`,
// `usecases/officials.ts:429,468`) — `runTinySuite` only calls it once B03
// T7's plan-provisioning probe has derived that the org's provisioned plan
// actually grants `officials.auto` (`lib/plan.ts#chooseGrantingPlanForCapabilities`,
// itself a review fix: the plan choice used to optimise for `cricket.dls`
// alone and hope, F1(a)).
//
// ---------------------------------------------------------------------------
// The blackout "read-back" finding
// ---------------------------------------------------------------------------
// No v1 route reads `official_availability` back out. Checked: `GET
// /officials`, `GET /officials/{id}` (`usecases/officials.ts`'s `COLS`) carry
// no blackout field; `POST /officials/{id}/availability` (G2, bench B03
// product-gaps) itself only ECHOES its own input (`setOfficialBlackout` has
// no `returning` clause) rather than reading persisted state; and
// `listOfficialBlackouts`/`listOfficialsForConsole` are called only from the
// schedule board's RSC page, never from an `/api/v1` route. The ONE place a
// blackout's effect becomes visible over the API is `warn.official_unavailable`
// off `POST /divisions/{id}/schedule/validate` (`usecases/schedule.ts:3372`,
// `requireResourceAuth(..., "read")` — ungated, no plan required) — a real
// read (`validateSchedule`'s own comment: "nothing is written on this path"),
// but one that only fires once the target fixture is actually SCHEDULED onto
// the blackout date, which (see above) `seedSuite` does not yet do. So
// `seedOfficialsAndClaims` calls it anyway and returns whatever it finds —
// correct and provable in a unit test (which fully controls the fake's
// response), honestly empty on a live `_tiny` run until scheduling precedes
// it. Recorded as a finding, not fixed here: fixing it would mean adding a
// v1 GET route for `official_availability`, which is product code.
//
// ---------------------------------------------------------------------------
// Runtime constraints (unchanged from B01/B02/B03): `node
// --experimental-strip-types` — no TS `enum`, no `namespace`, no parameter
// properties. Every relative import carries `.ts`. Nothing here imports from
// `apps/web` — every wire shape below is a hand mirror, cited against the
// real schema/usecase it copies.
import { newSession, request, signIn, type RequestOptions, type Session } from "./http.ts";
import { fixtureKey, type PackStream, type PackVenue } from "./pack-schema.ts";
import type {
  SeedPlan,
  SeedPlanClaimInvite,
  SeedPlanEntrant,
  SeedPlanOfficial,
  SeedPlanPerson,
  SeedPlanRosterMember,
} from "./seed-plan.ts";

// ---------------------------------------------------------------------------
// Transport — narrow, injected, defaulted to the real thing
// ---------------------------------------------------------------------------

/** The subset of `./http.ts` this driver actually calls. A test hands in a
 *  recording fake implementing this same shape; nothing in this file (or in
 *  its tests) ever touches `global.fetch`. */
export interface SeedTransport {
  signIn(base: string, s: Session, email: string): Promise<{ has_org: boolean; org_id: string; redirect: string }>;
  request<T>(base: string, s: Session, path: string, opts?: RequestOptions): Promise<T>;
}

export const defaultTransport: SeedTransport = { signIn, request };

// ---------------------------------------------------------------------------
// The result — pack ref -> real id, everywhere the plan declared a ref
// ---------------------------------------------------------------------------

export interface SeededSuite {
  readonly orgId: string;
  readonly competitionId: string;
  /** Populated only for `venues`/their `courts` the caller actually passed
   *  in — empty maps, never absent, when the pack (like `_tiny` today)
   *  declares none. */
  readonly venueIdByRef: ReadonlyMap<string, string>;
  readonly courtIdByRef: ReadonlyMap<string, string>;
  readonly divisionIdByRef: ReadonlyMap<string, string>;
  readonly stageIdByRef: ReadonlyMap<string, string>;
  readonly personIdByRef: ReadonlyMap<string, string>;
  readonly entrantIdByRef: ReadonlyMap<string, string>;
  /** Keyed by `fixtureKey(divisionRef, extKey)` (pack-schema.ts:1334-1336) —
   *  the SAME composite key `PackStream`'s own cross-field rule uses
   *  (pack-schema.ts:1623), never a hand-rolled second format. */
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  /** Present only when the pack declared officials or claim invites — absent,
   *  not empty, for a pack (like `_tiny` before T6) that declares neither. */
  readonly officialsAndClaims?: SeededOfficialsAndClaims;
}

export interface SeedSuiteInput {
  readonly base: string;
  readonly plan: SeedPlan;
  /** Off the pack directly — `SeedPlan` carries no `venues` field. Defaults
   *  to `[]`, matching `_tiny`'s own "declares no venues" shape. */
  readonly venues?: readonly PackVenue[];
  /** Off the pack directly — `SeedPlan` carries no `streams` field either
   *  (see this file's header comment). */
  readonly streams: readonly PackStream[];
  /** Same run tag `tinyPlan`'s caller mints (`randomUUID().slice(0, 8)` in
   *  `suites/tiny.ts:199`) — this file does not mint its own, so two
   *  concurrent runs against the same pack never collide on identity by
   *  accident. */
  readonly runTag: string;
  readonly transport?: SeedTransport;
  /**
   * T4 EXTENSION (declared here rather than redesigned around, per that
   * task's brief): extra `CreateCompetition.branding` (schemas.ts:95, jsonb,
   * ungated) merged into the competition create-call body below. Not
   * something `SeedPlan` can carry — `buildSeedPlan` is a pure pack->plan
   * mapping and a `--keep` idempotence marker is bench-RUNTIME state, not
   * pack content (seed-plan.ts's own header comment on what stays out of the
   * plan). The marker has to land on THIS create call: `lib/suites/tiny.ts`'s
   * `findExistingSeed` reads it back via `GET /api/v1/competitions`, and the
   * cited authority for where it is written is the CREATE path
   * (`usecases/competitions.ts:202-209`), not a follow-up PATCH. Omitted
   * (server default `{}`) when absent — every existing caller of `seedSuite`
   * is unaffected.
   */
  readonly competitionBranding?: Record<string, unknown>;
  /**
   * B03 T6b EXTENSION, same shape as `competitionBranding` just above: extra
   * `CreateCompetition.visibility` (`schemas.ts:94`, `Visibility.default
   * ("private")`) merged into the competition create-call body. Not
   * something `SeedPlan`/`PackSchema` can carry — visibility is bench-
   * RUNTIME config (whether THIS run wants its public read-model reachable),
   * not pack content, matching `competitionBranding`'s own reasoning. Needed
   * because `GET /api/v1/public/orgs/{orgSlug}/competitions/{slug}/
   * divisions/{divisionSlug}/stats` (`publicDivisionStats`,
   * `usecases/player-stats.ts:525-546`) 404s on ANY competition whose
   * `visibility` is not `'public'`/`'unlisted'` — and every `seedSuite`
   * caller before this task left it at the server default (`'private'`),
   * which the public-stats baseline (`lib/stats.ts`) needs cleared before it
   * can even reach the division lookup, independent of consent or scoring.
   * Omitted (server default `'private'`) when absent — every existing
   * caller of `seedSuite` is unaffected.
   */
  readonly competitionVisibility?: "public" | "unlisted";
}

interface IdOut {
  id: string;
}

interface GenerateOut {
  // `created`/`existing` (stages.ts:1038-1039) are not surfaced here —
  // nothing in this task's return shape needs the idempotency diff; a later
  // task owns idempotent re-seeding (brief: "do NOT build idempotence").
  fixtures: { id: string; ext_key?: string | null }[];
}

// ---------------------------------------------------------------------------
// The ext_key binding — pure, and the load-bearing part of this file
// ---------------------------------------------------------------------------

/** One fixture out of a real `/generate` response, tagged with the ref of
 *  the DIVISION whose stage produced it (never the LAST division processed —
 *  `seedSuite` tags each fixture inside the per-division closure below, not
 *  through a shared loop variable). */
export interface GeneratedFixtureRef {
  readonly divisionRef: string;
  readonly extKey: string | null | undefined;
  readonly id: string;
}

/**
 * Matches every `PackStream` to the real fixture it names, by
 * `fixtureKey(divisionRef, extKey)` — NEVER by array position (creation
 * order is not guaranteed to match the pack's stream order, and even when it
 * happens to, that agreement proves nothing — see this task's own required
 * test). `ext_key` is unique per division, not globally
 * (`PackStream.divisionRef`'s own doc, pack-schema.ts:621-624), which is
 * exactly why the key is composite: two divisions sharing the same ext_key
 * string must resolve to two different fixtures, not collide.
 *
 * Refuses two ways, each named explicitly rather than silently dropped or
 * silently ignored (AGENTS.md recurring-failure class 6, "an absent symptom
 * can mean suppressed, not safe"):
 *   - a stream whose (divisionRef, ext_key) matched no generated fixture;
 *   - a generated fixture that no stream claimed.
 * A silent mismatch on either side would surface minutes into a live run as
 * a wrong-fixture assertion instead of here, at seed time, with both sides
 * named.
 */
export function bindStreamFixtures(
  streams: readonly PackStream[],
  fixtures: readonly GeneratedFixtureRef[],
): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const f of fixtures) {
    // `FixtureRow.ext_key` is typed `string | null | undefined`
    // (apps/web/src/server/usecases/stages.ts:205) ONLY because "dozens of
    // pre-existing tests hand-build a FixtureRow-shaped literal that
    // predates this field" (stages.ts:196-204's own doc comment) — a REAL
    // `/generate` response always sets it (the generator's own stable id;
    // FIXTURE_COLS always selects it). So an actual `null`/`undefined` here
    // is a genuine anomaly, not "no stream could ever name this fixture" —
    // folding it into a map key of the STRING "null" would let two such
    // fixtures collide with each other, or with a pack that (legally, per
    // `PackExtKey`) authored the ext_key text "null". Thrown immediately
    // instead, naming the fixture that broke the contract.
    if (f.extKey === null || f.extKey === undefined) {
      throw new Error(
        `seedSuite: generated fixture "${f.id}" in division "${f.divisionRef}" has no ext_key ` +
          `(${JSON.stringify(f.extKey)}) — a real /generate response always sets one; cannot bind any stream to it`,
      );
    }
    byKey.set(fixtureKey(f.divisionRef, f.extKey), f.id);
  }

  const result = new Map<string, string>();
  const unmatched: string[] = [];
  for (const stream of streams) {
    const key = fixtureKey(stream.divisionRef, stream.fixtureExtKey);
    const id = byKey.get(key);
    if (id === undefined) {
      unmatched.push(`division "${stream.divisionRef}" ext_key "${stream.fixtureExtKey}"`);
      continue;
    }
    result.set(key, id);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `seedSuite: ${unmatched.length} stream(s) matched no generated fixture: ${unmatched.join("; ")}`,
    );
  }

  const unclaimed = [...byKey.entries()].filter(([key]) => !result.has(key));
  if (unclaimed.length > 0) {
    throw new Error(
      `seedSuite: ${unclaimed.length} generated fixture(s) were claimed by no stream: ` +
        unclaimed.map(([key, id]) => `${key} -> fixture ${id}`).join("; "),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// The HTTP driver
// ---------------------------------------------------------------------------

/** Venues, then (per venue) their courts — independent of everything else in
 *  `seedSuite` besides `orgId`/the session, and of each other across venues.
 *  Field-for-field pass-through: `PackVenue`/`PackCourt` already carry
 *  exactly `CreateVenue`'s (`name`, `address`, `sort`) and
 *  `CreateCourtInput`'s (`name`, `sort`, `tags`) fields
 *  (pack-schema.ts:701-732's own doc comment), so there is nothing to
 *  compute here — optional fields are omitted rather than defaulted, since
 *  the server already applies its own default (`CreateVenue.sort` /
 *  `CreateCourtInput.sort` both `.default(0)`, apps/web/src/server/api-v1/
 *  schemas.ts:4519-4522, apps/web/src/server/usecases/venues.ts:116-120) and
 *  restating that default here would be a second copy that could drift. */
async function seedVenuesAndCourts(
  base: string,
  s: Session,
  t: SeedTransport,
  orgId: string,
  venues: readonly PackVenue[],
): Promise<{ venueIdByRef: Map<string, string>; courtIdByRef: Map<string, string> }> {
  const venueIdByRef = new Map<string, string>();
  const courtIdByRef = new Map<string, string>();
  await Promise.all(
    venues.map(async (v) => {
      const venue = await t.request<IdOut>(base, s, `/api/v1/orgs/${orgId}/venues`, {
        method: "POST",
        body: {
          name: v.name,
          ...(v.address === undefined ? {} : { address: v.address }),
          ...(v.sort === undefined ? {} : { sort: v.sort }),
        },
      });
      venueIdByRef.set(v.ref, venue.id);
      await Promise.all(
        v.courts.map(async (c) => {
          const court = await t.request<IdOut>(base, s, `/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, {
            method: "POST",
            body: {
              name: c.name,
              ...(c.sort === undefined ? {} : { sort: c.sort }),
              tags: c.tags,
            },
          });
          courtIdByRef.set(c.ref, court.id);
        }),
      );
    }),
  );
  return { venueIdByRef, courtIdByRef };
}

/** Every player/coach/staff person the plan resolved — `SeedPlan.persons`
 *  already excludes lane "official" (seed-plan.ts:288-300). Independent of
 *  everything but the session, so every person is created concurrently. */
async function seedPersons(
  base: string,
  s: Session,
  t: SeedTransport,
  persons: readonly SeedPlanPerson[],
): Promise<Map<string, string>> {
  const personIdByRef = new Map<string, string>();
  await Promise.all(
    persons.map(async (p) => {
      const person = await t.request<IdOut>(base, s, "/api/v1/persons", {
        method: "POST",
        body: {
          full_name: p.full_name,
          // Explicit, every lane, `"player"` included — `CreatePerson.lane`
          // (PR #706, gap G1) is optional and defaults to 'player' server
          // side, and a bench that relies on that default cannot distinguish
          // a correct default from a forgotten field.
          lane: p.lane,
          ...(p.dob === undefined ? {} : { dob: p.dob }),
          ...(p.gender === undefined ? {} : { gender: p.gender }),
          consent: p.consent,
        },
      });
      personIdByRef.set(p.ref, person.id);
    }),
  );
  return personIdByRef;
}

/** One `EntrantMemberInput` (schemas.ts:365-370), `personRef` resolved to a
 *  real `person_id`. */
function buildMemberBody(
  m: SeedPlanRosterMember,
  personIdByRef: ReadonlyMap<string, string>,
  entrantRef: string,
): Record<string, unknown> {
  const personId = personIdByRef.get(m.personRef);
  if (personId === undefined) {
    // Belt and suspenders, matching seed-plan.ts's `buildRosterMember`
    // comment at the same kind of throw: `buildSeedPlan` already refuses an
    // unknown or "official"-lane person ref at plan-build time
    // (seed-plan.ts:219-247), so a `SeedPlan` built by `buildSeedPlan` can
    // never reach this branch. Kept for a hand-built `SeedPlan` (a test, or
    // a future caller) that bypasses that.
    throw new Error(`entrant "${entrantRef}" rosters person ref "${m.personRef}", which has no resolved id`);
  }
  return {
    person_id: personId,
    ...(m.squad_number === undefined ? {} : { squad_number: m.squad_number }),
    ...(m.default_position_key === undefined ? {} : { default_position_key: m.default_position_key }),
    is_captain: m.is_captain,
    roles: m.roles,
  };
}

/** Entrants, grouped by division into ONE `POST .../entrants` call per
 *  division (array body — same bulk-registration path `tinyPlan` uses,
 *  generalized past its one-division limit). Needs every division AND every
 *  person resolved first: a roster member's `person_id` is real, and
 *  `EntrantMemberInput.person_id` is a mandatory `Uuid` (schemas.ts:365) —
 *  there is no "create now, backfill the roster later" on this path. */
async function seedEntrants(
  base: string,
  s: Session,
  t: SeedTransport,
  entrants: readonly SeedPlanEntrant[],
  divisionIdByRef: ReadonlyMap<string, string>,
  personIdByRef: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const entrantIdByRef = new Map<string, string>();
  const byDivision = new Map<string, SeedPlanEntrant[]>();
  for (const e of entrants) {
    const list = byDivision.get(e.divisionRef) ?? [];
    list.push(e);
    byDivision.set(e.divisionRef, list);
  }
  await Promise.all(
    [...byDivision.entries()].map(async ([divisionRef, list]) => {
      const divisionId = divisionIdByRef.get(divisionRef);
      if (divisionId === undefined) {
        throw new Error(`entrant plan references unknown division ref "${divisionRef}"`);
      }
      const body = list.map((e) => ({
        kind: e.kind,
        display_name: e.display_name,
        ...(e.seed === undefined ? {} : { seed: e.seed }),
        members: e.members.map((m) => buildMemberBody(m, personIdByRef, e.ref)),
      }));
      // `createEntrants` (apps/web/src/server/usecases/entrants.ts:327-...)
      // builds its `rows` result with a plain `for (const input of inputs)`
      // loop, pushing in order — so the response array lines up
      // POSITIONALLY with the request array. Confirmed by reading the
      // usecase, never assumed (AGENTS.md failure class 5: "a grep is not a
      // read"). Still checked for length agreement below rather than
      // zipped blind, so a future change to that ordering fails loudly here
      // instead of mis-binding an entrant to another entrant's id.
      const rows = await t.request<IdOut[]>(base, s, `/api/v1/divisions/${divisionId}/entrants`, {
        method: "POST",
        body,
      });
      if (rows.length !== list.length) {
        throw new Error(
          `division "${divisionRef}": POST .../entrants returned ${rows.length} row(s) for ${list.length} requested entrant(s)`,
        );
      }
      rows.forEach((row, i) => entrantIdByRef.set(list[i].ref, row.id));
    }),
  );
  return entrantIdByRef;
}

/**
 * Drives one `SeedPlan` over the real REST API and returns every real id it
 * minted. Dependency order (see the header comment for what is NOT in
 * `plan`):
 *
 *   1. sign in                                   -> orgId
 *   2. venues+courts, persons, and the competition/division/stage tree —
 *      three chains that share nothing but the session, run concurrently
 *   3. entrants (needs every division AND every person resolved)
 *   4. generate, per stage (needs that stage's division's entrants to
 *      exist — same dependency `runTinySuite` encodes at
 *      suites/tiny.ts:271-281, generalized past one stage), then bind by
 *      ext_key
 */
export async function seedSuite(input: SeedSuiteInput): Promise<SeededSuite> {
  const { base, plan, streams, runTag, competitionBranding, competitionVisibility } = input;
  const venues = input.venues ?? [];
  const t = input.transport ?? defaultTransport;
  const s = newSession();

  const email = `bench-${plan.org.slug}-${runTag}@example.com`;
  const { org_id: orgId } = await t.signIn(base, s, email);

  const venuesWork = seedVenuesAndCourts(base, s, t, orgId, venues);
  const personsWork = seedPersons(base, s, t, plan.persons);

  const competition = await t.request<IdOut>(base, s, "/api/v1/competitions", {
    method: "POST",
    body: {
      // Run tag on the NAME, pack date verbatim — mirrors
      // suites/tiny.ts:251-256 exactly (see this file's header comment).
      name: `${plan.competition.name} ${runTag}`,
      ...(plan.competition.slug === undefined ? {} : { slug: plan.competition.slug }),
      ...(plan.competition.startsOn === undefined ? {} : { starts_on: plan.competition.startsOn }),
      ends_on: plan.competition.endsOn,
      ...(plan.competition.description === undefined ? {} : { description: plan.competition.description }),
      ...(competitionBranding === undefined ? {} : { branding: competitionBranding }),
      ...(competitionVisibility === undefined ? {} : { visibility: competitionVisibility }),
    },
  });

  const divisionIdByRef = new Map<string, string>();
  const stageIdByRef = new Map<string, string>();
  // Which stage REFS belong to which division ref — needed below to know
  // which stages to `/generate` together, and to tag each generated
  // fixture with its OWNING division (never the last one processed: this
  // map is built per-division, inside the same closure that creates that
  // division, so there is no shared loop variable to capture wrong).
  const stageRefsByDivisionRef = new Map<string, readonly string[]>();

  await Promise.all(
    plan.divisions.map(async (d) => {
      const division = await t.request<IdOut>(base, s, `/api/v1/competitions/${competition.id}/divisions`, {
        method: "POST",
        // Spread rather than field-by-field: `tiebreakers` is optional on the
        // plan and `CreateDivision` is NON-strict (`schemas.ts:225-250`), so a
        // key sent as `undefined` is silently DROPPED rather than refused —
        // the same way a division-creation wizard once lost its whole
        // eligibility block (RS007/V380, the comment at `schemas.ts:233`).
        // Omitting the key entirely is the only way to mean "not declared".
        body: {
          name: d.name,
          sport_key: d.sport_key,
          variant_key: d.variant_key,
          config: d.config,
          ...(d.tiebreakers === undefined ? {} : { tiebreakers: d.tiebreakers }),
        },
      });
      divisionIdByRef.set(d.ref, division.id);

      // Always an ARRAY body (even for one stage), so the response is
      // always an array too (`CreateStages`'s union — schemas.ts:824 —
      // otherwise returns a single object for a single-object body, per
      // stages/route.ts:34's `Array.isArray(body) ? rows : rows[0]`).
      const stages = await t.request<IdOut[]>(base, s, `/api/v1/divisions/${division.id}/stages`, {
        method: "POST",
        // `progression` is spread conditionally for the OPPOSITE reason to
        // `tiebreakers` above: `CreateStage` is `.strict()`
        // (`schemas.ts:821`), so an undeclared key is REJECTED outright rather
        // than dropped. Sending `progression: undefined` on a stage that has
        // none would fail the whole create call, not merely lose the field.
        body: d.stages.map((st) => ({
          seq: st.seq,
          kind: st.kind,
          name: st.name,
          config: st.config,
          ...(st.progression === undefined ? {} : { progression: st.progression }),
        })),
      });
      if (stages.length !== d.stages.length) {
        throw new Error(
          `division "${d.ref}": POST .../stages returned ${stages.length} row(s) for ${d.stages.length} requested stage(s)`,
        );
      }
      stages.forEach((row, i) => stageIdByRef.set(d.stages[i].ref, row.id));
      stageRefsByDivisionRef.set(
        d.ref,
        d.stages.map((st) => st.ref),
      );
    }),
  );

  const [{ venueIdByRef, courtIdByRef }, personIdByRef] = await Promise.all([venuesWork, personsWork]);

  const entrantIdByRef = await seedEntrants(base, s, t, plan.entrants, divisionIdByRef, personIdByRef);

  const generated: GeneratedFixtureRef[] = [];
  await Promise.all(
    plan.divisions.map(async (d) => {
      const stageRefs = stageRefsByDivisionRef.get(d.ref) ?? [];
      await Promise.all(
        stageRefs.map(async (stageRef) => {
          const stageId = stageIdByRef.get(stageRef);
          if (stageId === undefined) {
            throw new Error(`stage "${stageRef}" has no resolved id — POST .../stages did not return one`);
          }
          const out = await t.request<GenerateOut>(base, s, `/api/v1/stages/${stageId}/generate`, {
            method: "POST",
          });
          for (const f of out.fixtures) generated.push({ divisionRef: d.ref, extKey: f.ext_key, id: f.id });
        }),
      );
    }),
  );

  const fixtureIdByKey = bindStreamFixtures(streams, generated);

  // ---- officials, their blackouts, their named assignments, and the pack's
  // claim invites. Driven HERE, by the real producer, rather than left for a
  // caller to remember: a seeding step nothing calls is not a seeding step.
  // The AUTO pass is NOT part of this call — see this file's header comment
  // (B03 review F1(b)) and `runOfficialsAutoAssign` below; `runTinySuite`
  // drives that one separately, after ITS OWN scheduling walk. ----
  const officialsAndClaims =
    plan.officials.length > 0 || plan.claimInvites.length > 0
      ? await seedOfficialsAndClaims({
          base,
          officials: plan.officials,
          claimInvites: plan.claimInvites,
          fixtureIdByKey,
          personIdByRef,
          // The first division is the only one this suite schedules
          // (`suites/tiny.ts`), so it is the only one a `schedule/validate`
          // read-back could speak about.
          ...(plan.divisions[0] === undefined
            ? {}
            : { primaryDivisionId: divisionIdByRef.get(plan.divisions[0].ref) }),
          email,
          runTag,
          ...(input.transport === undefined ? {} : { transport: input.transport }),
        })
      : undefined;

  return {
    orgId,
    competitionId: competition.id,
    venueIdByRef,
    courtIdByRef,
    divisionIdByRef,
    stageIdByRef,
    personIdByRef,
    entrantIdByRef,
    fixtureIdByKey,
    ...(officialsAndClaims === undefined ? {} : { officialsAndClaims }),
  };
}

// ---------------------------------------------------------------------------
// Officials + claim invites (B03 T6) — see this file's header comment for
// why this is independent of `seedSuite` rather than folded into it.
// ---------------------------------------------------------------------------

/** `fixtures.officials`'s denormalized read cache
 *  (`usecases/officials.ts`'s `refreshOfficialsCache`), exactly as
 *  `GET /fixtures/{id}` returns it — never the write calls' own echoed
 *  bodies (`PATCH .../officials`'s response is the SAME cache, but reading
 *  it back through `GET /fixtures/{id}` is a distinct call over a distinct
 *  route, which is the point: see this file's header comment on "not merely
 *  that the write returned 201"). */
export interface FixtureOfficialRow {
  readonly official_id: string;
  readonly name: string;
  readonly role: string;
  readonly locked: boolean;
  readonly response: string;
  readonly decline_reason: string | null;
}

interface FixtureOfficialsOut {
  readonly officials: readonly FixtureOfficialRow[];
}

/** `ScheduleConflict`'s wire shape (`schemas.ts`), narrowed to the three
 *  fields this file reads — same minimal-local-type precedent as
 *  `lib/suites/tiny.ts`'s own `ValidateOut`. */
export interface ScheduleConflictRow {
  readonly fixture_id: string;
  readonly code: string;
  readonly blocking: boolean;
}

interface ValidateOfficialsOut {
  readonly conflicts: readonly ScheduleConflictRow[];
}

/** `person_claims` row, as `GET /persons/{id}/claim-invites` (`getOpenClaim`)
 *  returns it — no `secret` (shown once, on mint, never again) and
 *  therefore no way for this driver — or anything downstream of it — to
 *  accept the invite it just read back. `claimed_at`/`revoked_at` being
 *  `null` is itself the proof nothing here accepted it (B03 §5: "the accept
 *  flow is B05's, seeding only mints invites"). */
export interface ClaimInviteReadBack {
  readonly id: string;
  readonly person_id: string;
  readonly email: string;
  readonly expires_at: string;
  readonly claimed_at: string | null;
  readonly revoked_at: string | null;
}

export interface SeedOfficialsAndClaimsInput {
  readonly base: string;
  readonly officials: readonly SeedPlanOfficial[];
  readonly claimInvites: readonly SeedPlanClaimInvite[];
  /** `SeededSuite.fixtureIdByKey` — resolves a manual `PackOfficialAssignment`
   *  (`divisionRef` + `fixtureExtKey`) to the real fixture id it names. */
  readonly fixtureIdByKey: ReadonlyMap<string, string>;
  /** `SeededSuite.personIdByRef` — resolves a `SeedPlanClaimInvite.personRef`
   *  to the real `person_id` `POST /persons/{id}/claim-invites` targets. */
  readonly personIdByRef: ReadonlyMap<string, string>;
  /**
   * The division `POST .../schedule/validate` reads the blackout's effect
   * back from — see this file's header comment ("the blackout read-back
   * finding") on why the PACK itself carries no division for it. Required
   * when the plan declares at least one blackout; a caller with none may
   * omit it, and the step that would need it is skipped rather than throwing
   * on an absent id nothing asked for. NOT used for auto-assignment anymore
   * — see `RunOfficialsAutoAssignInput.primaryDivisionId` below, which takes
   * its own (required) division id, resolved by the caller AFTER scheduling.
   */
  readonly primaryDivisionId?: string;
  /** Same identity `seedSuite` signed in with for this run — this function
   *  signs in AGAIN with it (its own session), the same self-contained
   *  precedent `seedSuite` itself follows (this file's header comment on
   *  "a second magic-link round trip, accepted as the cost of keeping
   *  seedSuite self-contained"). */
  readonly email: string;
  /** `seedSuite`'s own run tag — needed here ONLY to derive a stable,
   *  collision-free email for `POST /officials/{id}/invite` (see
   *  `officialInviteEmail` below). Never used to mint identity the way
   *  `email` above does. */
  readonly runTag: string;
  readonly transport?: SeedTransport;
}

export interface SeededOfficialsAndClaims {
  readonly officialIdByRef: ReadonlyMap<string, string>;
  /** Real `GET /fixtures/{id}` reads, keyed by fixture id — every fixture
   *  this driver assigned an official onto MANUALLY. The auto pass reads its
   *  own touched fixtures back separately — see
   *  `OfficialsAutoAssignResult.fixtureOfficialsById`. */
  readonly fixtureOfficialsById: ReadonlyMap<string, readonly FixtureOfficialRow[]>;
  /** `schedule/validate`'s own conflicts for `primaryDivisionId` — empty
   *  when no blackout was declared, or `primaryDivisionId` was omitted. See
   *  this file's header comment ("the blackout read-back finding"). */
  readonly scheduleConflicts: readonly ScheduleConflictRow[];
  /** Real `GET /persons/{id}/claim-invites` reads, keyed by the pack's own
   *  person ref (never the write calls' own echoed bodies — see
   *  `ClaimInviteReadBack`'s header comment). */
  readonly claimInviteByPersonRef: ReadonlyMap<string, ClaimInviteReadBack>;
  /**
   * B03 T6b: `POST /officials/{id}/invite` minted and read back, keyed by
   * the OFFICIAL's own ref — never `PackOfficial.person` (`personRef`),
   * because the invite's `person_id` is NOT that ref's real id. See
   * `mintOfficialInvites`'s own header comment for why `PackOfficial.person`
   * stays unresolvable even after this call fires: `POST /persons` cannot
   * create a lane="official" row at all (`PersonLane` admits only
   * `"player"|"coach"|"staff"`, `api-v1/schemas.ts:370`), so the pack's own
   * `p-dee`/`p-eli` were never real rows to begin with — the invite mints a
   * BRAND NEW person (`full_name = official.display_name`), disconnected
   * from whichever pack person the author intended. Read back through a
   * DISTINCT `GET /persons/{person_id}/claim-invites` call, same
   * "never the write's own echo" precedent as `claimInviteByPersonRef`
   * above. `claimed_at` staying null on that read is the proof nothing here
   * accepted it (B03 §5: seeding only mints invites). */
  readonly officialClaimInviteByRef: ReadonlyMap<string, ClaimInviteReadBack>;
}

/**
 * The email `POST /officials/{id}/invite` sends its `CreateClaimInvite`
 * body — `PackOfficial` (pack-schema.ts:768-769) carries no email field at
 * all, and pack-schema.ts is off-limits to this task (B03 §T6b brief). Two
 * alternatives were considered and rejected:
 *
 *   - Reusing `PackClaimInvite.email` (`pack.claimInvites[]`): that array is
 *     keyed by a DIFFERENT person ref (`p-ana`/`p-cho` in `_tiny.json`,
 *     both player-lane) — nothing ties an official's ref to an entry there,
 *     and `checkReservations` never requires one to exist.
 *   - Fabricating a "realistic" address from the official's `display_name`:
 *     indistinguishable from real user data and not derived from anything
 *     the pack actually declares.
 *
 * So this derives one the same way `seedSuite`'s own sign-in identity is
 * derived (this file's header comment: "the existing precedent is that
 * [the run tag] is not this layer's parameter at all, it is the HTTP
 * driver's") — from the official's own ref plus the run tag, scoped so two
 * officials in one run, or the same official across two concurrent runs,
 * never collide. `ref` is sanitized because `PackRef`'s alphabet
 * (`[A-Za-z0-9_.:-]`, pack-schema.ts:176-180) admits `:`, which is not a
 * valid email local-part character. */
export function officialInviteEmail(ref: string, runTag: string): string {
  const safeRef = ref.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `bench-official-${safeRef}-${runTag}@example.com`;
}

/** Resolves an official's ref to its real id, or throws naming the ref —
 *  every call site below already created every official first, so this can
 *  only fire on a plan whose `assignments`/`unavailable` name a ref outside
 *  `officials` itself (a hand-built `SeedPlan` bypassing `buildSeedPlan`,
 *  matching the same "belt and suspenders" precedent `seed-plan.ts`'s own
 *  throws follow). */
function requireOfficialId(officialIdByRef: ReadonlyMap<string, string>, ref: string): string {
  const id = officialIdByRef.get(ref);
  if (id === undefined) {
    throw new Error(`official "${ref}" has no resolved id — POST /officials did not return one`);
  }
  return id;
}

/**
 * Drives `plan.officials`/`plan.claimInvites` over the real REST API. See
 * this file's header comment for why the AUTO pass is NOT part of this
 * function (B03 review F1(b)) — that is `runOfficialsAutoAssign`, below,
 * called separately by `runTinySuite` after ITS OWN scheduling walk.
 *
 * Order: create every official -> set every blackout -> manual assignments
 * (grouped per fixture — `PATCH .../officials` REPLACES a fixture's whole
 * officials set, so two manual officials sharing a fixture need ONE call,
 * not two racing writes) -> read back every manually-touched fixture and the
 * blackout's effect -> mint (never accept) every claim invite and read it
 * back.
 */
export async function seedOfficialsAndClaims(
  input: SeedOfficialsAndClaimsInput,
): Promise<SeededOfficialsAndClaims> {
  const { base, officials, claimInvites, fixtureIdByKey, personIdByRef, primaryDivisionId, email, runTag } = input;
  const t = input.transport ?? defaultTransport;
  const s = newSession();
  await t.signIn(base, s, email);

  // ---- officials themselves. `person_id` is deliberately OMITTED — see
  // this module's `SeedPlanOfficial` header comment (seed-plan.ts) on why
  // `PackOfficial.person` cannot be honoured here. ----
  const officialIdByRef = new Map<string, string>();
  await Promise.all(
    officials.map(async (o) => {
      const created = await t.request<IdOut>(base, s, "/api/v1/officials", {
        method: "POST",
        body: {
          display_name: o.display_name,
          role_keys: o.role_keys,
          ...(o.max_per_day === undefined ? {} : { max_per_day: o.max_per_day }),
        },
      });
      officialIdByRef.set(o.ref, created.id);
    }),
  );

  // ---- blackouts ----
  await Promise.all(
    officials.flatMap((o) =>
      o.unavailable.map((u) =>
        t.request(base, s, `/api/v1/officials/${requireOfficialId(officialIdByRef, o.ref)}/availability`, {
          method: "POST",
          body: { date: u.date, ...(u.note === undefined ? {} : { note: u.note }) },
        }),
      ),
    ),
  );

  // ---- manual assignments, grouped per fixture ----
  const manualOfficials = officials.filter((o) => o.assignments.length > 0);

  const manualByFixture = new Map<string, { official_id: string; role_key: string; locked: boolean }[]>();
  for (const o of manualOfficials) {
    const officialId = requireOfficialId(officialIdByRef, o.ref);
    for (const a of o.assignments) {
      const key = fixtureKey(a.divisionRef, a.fixtureExtKey);
      const fixtureId = fixtureIdByKey.get(key);
      if (fixtureId === undefined) {
        throw new Error(
          `official "${o.ref}" is assigned to division "${a.divisionRef}" ext_key "${a.fixtureExtKey}", which ` +
            `matches no generated fixture`,
        );
      }
      const roleKey = a.roleKey ?? o.role_keys[0];
      if (roleKey === undefined) {
        // Unreachable through `buildSeedPlan` — `PackOfficial.roleKeys` is
        // `.min(1)` — kept for the same hand-built-plan reason every other
        // "belt and suspenders" throw in this file exists.
        throw new Error(`official "${o.ref}" declares no role_keys to default an unnamed assignment's role onto`);
      }
      const list = manualByFixture.get(fixtureId) ?? [];
      // `locked: true` — a pack-NAMED assignment is the seed's ground truth
      // ("the final's official == the real final's official", bench design
      // §9 P1); locking it is what keeps a later auto pass from treating it
      // as an obstacle to route AROUND rather than an assignment to leave
      // alone (`usecases/officials.ts`'s own comment on `officials/auto`:
      // "engine call with locked assignments as obstacles").
      list.push({ official_id: officialId, role_key: roleKey, locked: true });
      manualByFixture.set(fixtureId, list);
    }
  }
  await Promise.all(
    [...manualByFixture.entries()].map(([fixtureId, set]) =>
      t.request(base, s, `/api/v1/fixtures/${fixtureId}/officials`, { method: "PATCH", body: { set } }),
    ),
  );

  // ---- read-back: manual assignment. A real `GET /fixtures/{id}` per
  // MANUALLY-touched fixture — never the write calls' own echoed bodies. The
  // auto pass (moved out — see this file's header comment, B03 review
  // F1(b)) reads its own touched fixtures back separately. ----
  const fixtureOfficialsById = new Map<string, readonly FixtureOfficialRow[]>();
  await Promise.all(
    [...manualByFixture.keys()].map(async (fixtureId) => {
      const fixture = await t.request<FixtureOfficialsOut>(base, s, `/api/v1/fixtures/${fixtureId}`);
      fixtureOfficialsById.set(fixtureId, fixture.officials);
    }),
  );

  // ---- read-back: blackout. See this file's header comment — there is no
  // v1 route that reads `official_availability` directly; this is the one
  // place its effect becomes visible over the API. ----
  const hasBlackout = officials.some((o) => o.unavailable.length > 0);
  let scheduleConflicts: readonly ScheduleConflictRow[] = [];
  if (hasBlackout && primaryDivisionId !== undefined) {
    const validated = await t.request<ValidateOfficialsOut>(
      base,
      s,
      `/api/v1/divisions/${primaryDivisionId}/schedule/validate`,
      { method: "POST" },
    );
    scheduleConflicts = validated.conflicts;
  }

  // ---- claim invites (player-lane, `pack.claimInvites[]`): mint, never
  // accept, and read back (`claimed_at` staying null on the READ is the
  // proof, not just the absence of an accept call in this file). ----
  const claimInviteByPersonRef = new Map<string, ClaimInviteReadBack>();
  await Promise.all(
    claimInvites.map(async (c) => {
      const personId = personIdByRef.get(c.personRef);
      if (personId === undefined) {
        throw new Error(`claim invite references person ref "${c.personRef}" with no resolved id`);
      }
      await t.request(base, s, `/api/v1/persons/${personId}/claim-invites`, {
        method: "POST",
        body: { email: c.email },
      });
      const read = await t.request<ClaimInviteReadBack>(base, s, `/api/v1/persons/${personId}/claim-invites`);
      claimInviteByPersonRef.set(c.personRef, read);
    }),
  );

  // ---- B03 T6b: officials' OWN claim invites, `POST
  // /officials/{id}/invite` — the SAME shared person-claim rail as the
  // block above, pointed at the official rather than a pack person (see
  // `officialInviteEmail`'s and `SeededOfficialsAndClaims.
  // officialClaimInviteByRef`'s header comments for why the email is
  // synthesized and why `PackOfficial.person` still cannot be resolved even
  // once this fires). Ungated on every plan (`inviteOfficial`,
  // `usecases/officials.ts:196-230`, carries no `requireFeature` call) —
  // unlike the auto-assign pass (`runOfficialsAutoAssign`, below), this runs
  // for EVERY official the pack declares, unconditionally, matching the
  // player claim-invite block's own unconditional precedent just above.
  // Mint only: never follows `claim_url`, never calls an accept route. ----
  const officialClaimInviteByRef = new Map<string, ClaimInviteReadBack>();
  await Promise.all(
    officials.map(async (o) => {
      const officialId = requireOfficialId(officialIdByRef, o.ref);
      const minted = await t.request<{ person_id: string }>(base, s, `/api/v1/officials/${officialId}/invite`, {
        method: "POST",
        body: { email: officialInviteEmail(o.ref, runTag) },
      });
      // Distinct GET, never the POST's own echoed body — same "not merely
      // 201" precedent as every other read-back in this file.
      const read = await t.request<ClaimInviteReadBack>(
        base,
        s,
        `/api/v1/persons/${minted.person_id}/claim-invites`,
      );
      officialClaimInviteByRef.set(o.ref, read);
    }),
  );

  return {
    officialIdByRef,
    fixtureOfficialsById,
    scheduleConflicts,
    claimInviteByPersonRef,
    officialClaimInviteByRef,
  };
}

// ---------------------------------------------------------------------------
// Officials auto-assignment (B03 T7 / review F1(b)) — a SEPARATE export,
// driven by `runTinySuite` AFTER its own scheduling walk
// ---------------------------------------------------------------------------
// `POST /divisions/{id}/officials/auto`'s own `engineInput` filters `where
// scheduled_at is not null` (`usecases/officials.ts:386`) — this call is only
// ever meaningful once fixtures are actually scheduled, which is exactly why
// it cannot live inside `seedOfficialsAndClaims`/`seedSuite` (both of which
// run BEFORE `runTinySuite`'s own schedule-settings -> schedule/auto ->
// schedule/apply walk). It is also the one entitlement-gated step in this
// whole file (`requireFeature(orgId, "officials.auto")`,
// `usecases/officials.ts:429,468`) — the caller decides whether to invoke
// this at all (`RunOfficialsAutoAssignInput` carries no opt-in flag of its
// own; an empty `autoOfficials` list is this function's own no-op guard, see
// below).

export interface RunOfficialsAutoAssignInput {
  readonly base: string;
  /** Same identity `seedSuite`/`seedOfficialsAndClaims` signed in with for
   *  this run — this function signs in AGAIN with it (its own session), same
   *  self-contained precedent as `seedOfficialsAndClaims` itself. */
  readonly email: string;
  /** The division to propose/apply auto-needing officials against. REQUIRED
   *  (unlike `seedOfficialsAndClaims`'s own `primaryDivisionId`, which may be
   *  omitted): a caller only reaches this function once its own scheduling
   *  walk has already resolved a real division id, so there is no legitimate
   *  case for calling this without one. */
  readonly primaryDivisionId: string;
  /** `plan.officials` filtered to those with EMPTY `assignments`
   *  (pack-schema.ts:768-769's own rule: an official with a named assignment
   *  is manual, locked by `seedOfficialsAndClaims`, and never routed around
   *  by this pass) — the caller filters, not this function, so a caller that
   *  already has the full plan does not need a second copy of that
   *  predicate here. An empty list is a legitimate no-op: no HTTP call is
   *  made at all, not even sign-in. */
  readonly autoOfficials: readonly SeedPlanOfficial[];
  readonly transport?: SeedTransport;
}

export interface OfficialsAutoAssignResult {
  readonly proposedCount: number;
  readonly appliedCount: number;
  /** Real `GET /fixtures/{id}` reads, keyed by fixture id — every fixture
   *  THIS pass assigned an official onto (empty when the proposal itself was
   *  empty). Never the apply call's own echoed body — same "not merely a
   *  successful write" precedent as every other read-back in this file. */
  readonly fixtureOfficialsById: ReadonlyMap<string, readonly FixtureOfficialRow[]>;
}

/**
 * Proposes, then applies, auto-assignment for every official the pack leaves
 * unnamed. Call this AFTER scheduling exists for `primaryDivisionId` — see
 * this section's header comment for why an earlier call always proposes
 * zero, structurally, regardless of what officials the plan declares.
 */
export async function runOfficialsAutoAssign(
  input: RunOfficialsAutoAssignInput,
): Promise<OfficialsAutoAssignResult> {
  const { base, email, primaryDivisionId, autoOfficials } = input;
  if (autoOfficials.length === 0) {
    return { proposedCount: 0, appliedCount: 0, fixtureOfficialsById: new Map() };
  }
  const t = input.transport ?? defaultTransport;
  const s = newSession();
  await t.signIn(base, s, email);

  const roles = [...new Set(autoOfficials.flatMap((o) => o.role_keys))];
  const proposal = await t.request<{
    assignments: readonly { fixtureId: string; officialId: string; roleKey: string; locked?: boolean }[];
  }>(base, s, `/api/v1/divisions/${primaryDivisionId}/officials/auto`, {
    method: "POST",
    body: { policy: { roles } },
  });

  let appliedCount = 0;
  const touchedFixtureIds = new Set<string>();
  if (proposal.assignments.length > 0) {
    await t.request(base, s, `/api/v1/divisions/${primaryDivisionId}/officials/apply`, {
      method: "POST",
      body: {
        assignments: proposal.assignments.map((a) => ({
          fixture_id: a.fixtureId,
          official_id: a.officialId,
          role_key: a.roleKey,
          locked: a.locked ?? false,
        })),
      },
    });
    appliedCount = proposal.assignments.length;
    for (const a of proposal.assignments) touchedFixtureIds.add(a.fixtureId);
  }

  const fixtureOfficialsById = new Map<string, readonly FixtureOfficialRow[]>();
  await Promise.all(
    [...touchedFixtureIds].map(async (fixtureId) => {
      const fixture = await t.request<FixtureOfficialsOut>(base, s, `/api/v1/fixtures/${fixtureId}`);
      fixtureOfficialsById.set(fixtureId, fixture.officials);
    }),
  );

  return { proposedCount: proposal.assignments.length, appliedCount, fixtureOfficialsById };
}
