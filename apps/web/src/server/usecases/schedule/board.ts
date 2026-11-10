import "server-only";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { byeLineSql } from "@/server/engine-db/system-bye-sql";
import { isByeLine, type ByeLineRow } from "@/lib/bye-line";
import { buildCourtDirectory } from "@/lib/court-directory";
import { EngineError } from "@seazn/engine/core";
import type { Tx, FixtureLite } from "./types";

// A fixture the auto pass / board may still move; everything else on the
// timetable is a fixed obstacle (doc 12 §6: decided fixtures are immutable —
// rain-rescheduling touches remaining fixtures only).
export const MOVABLE_STATUS = "scheduled";

// Statuses that still occupy a court (cancelled/abandoned ones do not).
// W2a: a held (`needs_decision`) fixture was played in its slot, so it holds it.
export const OCCUPYING = ["scheduled", "in_play", "decided", "finalized", "forfeited", "needs_decision"];

/** Court-holding statuses the auto pass will NOT re-place: the fixed board of a
 *  part-played competition (a rain-delay repair over a morning that is already
 *  `decided` is the canonical case).
 *
 *  DERIVED, never copied, and derived exactly ONCE — here. A hand-typed list
 *  rots silently the day `OCCUPYING` grows a member, and so does a second
 *  `.filter()` written elsewhere. Both the #350 joint builder
 *  (`competition-schedule-ai/`) and the court-removal guard below import
 *  this one, so there is no way for them to disagree about what "fixed" means. */
export const FIXED_OCCUPYING = OCCUPYING.filter((s) => s !== MOVABLE_STATUS);

/** Whether the board, the solver and an apply may move `f`: `scheduled`,
 *  holding no result, and not a bye line. `played` is history's played
 *  set (`playedFixtureIds`, ./fixture-results-sql.ts). The status alone cannot
 *  say it: a start taken back walks the status to `scheduled` and leaves its
 *  events behind. History refuses to undo any step that touches such a row, so
 *  a move written to one would leave an Undo that nothing can get past (review
 *  3 of #857, N1). A bye is not played: it takes no court and no time — a Swiss
 *  stage's `scheduled` bye shell before Pair (W3 T3, SW-M13, X-SW-29) and a
 *  bracket's bye line before its award (W4 T3, K2, X-SD-5) alike (`isByeLine`,
 *  lib/bye-line.ts, the one bye-line predicate). Every caller passes a
 *  `divisionFixtures` row (`FixtureLite`), which carries the columns it reads. */
export function isMovable(f: { id: string; status: string } & ByeLineRow, played: ReadonlySet<string>): boolean {
  return f.status === MOVABLE_STATUS && !played.has(f.id) && !isByeLine(f);
}

/** A `scheduled` fixture no builder may move all the same: one that holds a
 *  result, or a bye line (`isMovable`). An apply skips it silently, the
 *  way a rain-delay shift does, and counts it — so a stale proposal naming a
 *  bye line writes nothing to it and the rest of the apply lands. */
export function heldInPlace(f: { id: string; status: string } & ByeLineRow, played: ReadonlySet<string>): boolean {
  return f.status === MOVABLE_STATUS && !isMovable(f, played);
}

/** `isMovable`, as SQL: `scheduled`, holding no result, and not a bye line
 *  (`byeLineSql`, the SQL twin of `isByeLine`). For the counts that price, drop
 *  or size a run (competition-schedule-ai/, schedule-ai-preview.ts), so they
 *  count exactly what a builder moves. `on` names the `fixtures` row in the
 *  enclosing query. */
export function movableFixtureSql(tx: Tx, on = "f") {
  return tx`(${tx(on)}.status = ${MOVABLE_STATUS} and not ${fixtureHasResultSql(tx, on)} and not ${byeLineSql(tx, on)})`;
}

/** The English sentence behind a refused board move or pin. Clients say it in
 *  the reader's own language off `PLAYED_REFUSAL_CODE`. */
export const PLAYED_MOVE_MESSAGE = "this match has a result or scoring recorded, so it can't be moved or locked";

// Scope locks (Jul3/03 §4, 22 Jun two-site safety): fixtures matching a
// division's locked_scopes entry are treated exactly like pinned fixtures.
//
// P9 pass-3a-FIX: `courts`/`venues` hold real `courts.id`/`venues.id` values,
// not organiser-typed names — V374's third migration block rewrote every
// stored `locked_scopes` row from names to ids the same way pass 1 rewrote
// `schedule_settings.config.courts`. `scopeLocked` below matches on
// `court_id`/`venue_id` accordingly, never the legacy `court_label`/`venue`
// columns.
export interface LockedScope {
  /** Real `courts.id` values (V374 cutover). */
  courts?: string[];
  /** Real `venues.id` values (V374 cutover). */
  venues?: string[];
  pool_ids?: string[];
}

export function scopeLocked(
  f: Pick<FixtureLite, "court_id" | "venue_id" | "pool_id">,
  scopes: readonly LockedScope[],
): boolean {
  return scopes.some(
    (s) =>
      (s.courts !== undefined && f.court_id !== null && s.courts.includes(f.court_id)) ||
      (s.venues !== undefined && f.venue_id !== null && s.venues.includes(f.venue_id)) ||
      (s.pool_ids !== undefined && f.pool_id !== null && s.pool_ids.includes(f.pool_id)),
  );
}

// Exported for the #350 joint apply: a locked division must abort a joint write
// on exactly the terms it aborts a single-division one.
export async function divisionLockState(
  tx: Tx,
  divisionId: string,
): Promise<{ frozen: boolean; scopes: LockedScope[] }> {
  const [row] = await tx<{ schedule_locked: boolean; locked_scopes: LockedScope[] }[]>`
    select schedule_locked, locked_scopes from divisions where id = ${divisionId}`;
  return { frozen: row?.schedule_locked ?? false, scopes: row?.locked_scopes ?? [] };
}

export const FIXTURE_LITE_COLS = [
  "id", "stage_id", "division_id", "pool_id", "round_no", "seq_in_round", "ext_key",
  "home_entrant_id", "away_entrant_id",
  // W4 T3 (K2): `isByeLine`'s other inputs (see FixtureLite).
  "outcome", "home_slot_label", "away_slot_label",
  // P9 pass 3a: court_id/venue_id are the real identity; court_label/venue
  // ride along read-only, for scopeLocked alone (see FixtureLite's comment).
  "scheduled_at", "court_id", "venue_id", "court_label", "venue", "status", "schedule_locked",
  "winner_to_fixture", "loser_to_fixture",
] as const;

export async function divisionFixtures(tx: Tx, divisionId: string): Promise<FixtureLite[]> {
  return tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id = ${divisionId} and status in ${tx(OCCUPYING)}
    order by round_no, seq_in_round, id`;
}

/** id -> name for every court this org has configured (P9 pass 3a). The
 *  DERIVED, read-only name a response carries beside a `court_id` — see the
 *  dispatch ruling on `ScheduleAssignment`/`ScheduleConflictDetail`.
 *  Deliberately NOT filtered to non-archived: an archived court can still
 *  carry a real, already-placed fixture (ruling 3, candidate-courts.ts) or a
 *  historical conflict, and both must still render a name, not a bare uuid.
 *  Relies on `withTenant`'s RLS context for org scoping — the same
 *  convention `court-candidates.ts`'s `orgCourtMetas` already uses. */
export async function courtNamesById(tx: Tx): Promise<Map<string, string>> {
  // P9 review wave 2: VENUE-QUALIFIED, not the bare `courts.name`. A court name
  // is unique only WITHIN its venue (`courts_venue_name_active_idx` is scoped
  // per venue), so two venues may legally each name one "Court 1" — and every
  // consumer of this map was then showing them identically. That is not only a
  // display defect: `officials-ai.ts` prices a run on the count of DISTINCT
  // court values in its pack, so two same-named courts collapsed into one and
  // the credit rung came out under the run the organiser actually got.
  //
  // `buildCourtDirectory` is the one implementation of that rule (the board,
  // the picker and the AI pack already go through it) and it also settles the
  // residual ties — including an archived and an active court sharing a venue
  // AND a name, which the partial index permits once a name is freed.
  const rows = await tx<{ id: string; name: string; venue_name: string; tags: string[] }[]>`
    select c.id, c.name, v.name as venue_name, c.tags
    from courts c
    join venues v on v.id = c.venue_id
    order by v.sort, v.name, c.sort, c.name, c.id`;
  return new Map([...buildCourtDirectory(rows)].map(([id, info]) => [id, info.label]));
}

/** id -> name for every venue this org has configured (P9 pass 3a) — the
 *  `venue_id` sibling of {@link courtNamesById}, same reasoning throughout. */
export async function venueNamesById(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; name: string }[]>`select id, name from venues`;
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** id -> venue_id for every court this org has configured (P9 review #5) —
 *  the SERVER-SIDE source of truth for which venue a court belongs to, so a
 *  fixture's `venue_id` can be DERIVED from its `court_id` rather than
 *  trusted from client input (see `applySchedule`/`moveFixture`'s writes). A
 *  supplied `venue_id` must never be able to disagree with the court's own
 *  venue. Deliberately NOT filtered to non-archived — same reasoning as
 *  `courtNamesById`: an archived court can still carry an already-placed
 *  fixture, and its venue_id must still resolve. Relies on `withTenant`'s
 *  RLS context for org scoping, same convention as `courtNamesById`/
 *  `venueNamesById`. */
/** court id -> its venue id. The venue a fixture sits in is DERIVED from the
 *  court it is on, never taken from the client: `courts.venue_id` and the
 *  composite FK already guarantee the two agree, so a supplied `venue_id`
 *  could only ever disagree. Exported for the JOINT apply path
 *  (competition-schedule-apply.ts), which must resolve it identically. */
export async function courtVenueIds(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx<{ id: string; venue_id: string }[]>`select id, venue_id from courts`;
  return new Map(rows.map((r) => [r.id, r.venue_id]));
}

// person ids per entrant, for cross-division overlap warnings (doc 06 §4.3).
export async function peopleByEntrant(tx: Tx, entrantIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (entrantIds.length === 0) return map;
  const rows = await tx<{ entrant_id: string; person_id: string }[]>`
    select entrant_id, person_id from entrant_members where entrant_id in ${tx(entrantIds)}`;
  for (const r of rows) {
    (map.get(r.entrant_id) ?? map.set(r.entrant_id, []).get(r.entrant_id)!).push(r.person_id);
  }
  return map;
}

// D4a (P5): a TBD/seeded fixture's null side(s) contribute NO people here, so
// crossPersonClash structurally skips a not-yet-filled slot — there is no
// person to clash on until confirm fills it (design: "Person-level
// constraints (crossPersonClash) skip TBD slots until filled — recorded
// limitation, re-validate on fill"). confirmSeedProposal (stages/seed-proposal.ts)
// re-runs validateSchedule straight after its fillSlot commit so a clash that
// only becomes REAL once real entrants land surfaces as a warning then, not
// silently forever — this function needs no change for that, since it
// already reads whatever fixtures.*_entrant_id holds at call time.
//
// De-duplicated: a person who is a member of BOTH entrants (a roster mistake,
// or one player entered in two teams) is still one person at this fixture.
// Listed twice, the placement service refuses the whole request
// (INVALID_REQUEST "person_indices repeats a person") and the WHOLE board falls
// back to greedy; and every per-person tally (`entityKeysFor`'s universal
// scopes) would count that one fixture twice for them.
//
// Exported for Match Day (match-day-call.ts, and its read model): a call's hard
// stop is person-level — a doubles partner on another court — and must resolve
// a fixture's people exactly as the scheduler does, never a second way.
export function peopleOf(
  f: Pick<FixtureLite, "home_entrant_id" | "away_entrant_id">,
  people: Map<string, string[]>,
): string[] {
  return [
    ...new Set([
      ...(f.home_entrant_id ? (people.get(f.home_entrant_id) ?? []) : []),
      ...(f.away_entrant_id ? (people.get(f.away_entrant_id) ?? []) : []),
    ]),
  ];
}

/**
 * Fixtures the caller may not move this run: `schedule_locked`, or caught by
 * a `scopeLocked` scope lock, and currently placed (`scheduled_at` AND
 * `court_id` both set — a lock with nothing to anchor to has nothing to
 * pin). THE ONE PREDICATE, per ruling R5 for what a "frozen" card is: there
 * is no per-fixture published flag, so "the cards an entrant has already
 * been told about" is approximated by the cards the organiser pinned.
 *
 * SHARED, not duplicated. `pinnedIds` (the anchor the solver sees, every
 * mode) and `frozen` (POLISH's freeze set) used to be two hand-maintained
 * copies of this exact test — see the comment on `pinnedIds` above for how
 * they had already diverged (#pins-in-build). They are now the SAME `Set`,
 * built by one call to this function and reused, which also retires a
 * standing KNOWN GAP this function used to carry: `buildSchedule` anchors a
 * `frozen` id with no matching `locked` entry to greedy's own re-placement
 * rather than to where the card actually sits (`build.ts` Task 6/7). Because
 * `frozen` is now always a subset of `pinnedIds` by construction, every id it
 * names has a `locked` anchor too — that gap can no longer arise from this
 * call site.
 *
 * `ignoreLocks` (from `AutoScheduleRequest.ignore_locks`) is the one explicit
 * way to suppress every lock for this run. `only_unlocked` has no say over
 * this predicate at all — see `pinnedIds`.
 */
export function lockedFixtureIds(
  movable: readonly FixtureLite[],
  scopes: readonly LockedScope[],
  ignoreLocks: boolean,
): Set<string> {
  if (ignoreLocks) return new Set();
  return new Set(
    movable
      .filter(
        (f) =>
          (f.schedule_locked || scopeLocked(f, scopes)) &&
          f.scheduled_at !== null &&
          f.court_id !== null,
      )
      .map((f) => f.id),
  );
}

/** Optimistic-concurrency guard (v3/11 gap 10): schedule writes may carry the
 *  division seq the client rendered from; a stale token means another admin
 *  edited the board since — 409 with the current seq so the client resyncs. */
// Exported for the #350 joint apply, which asserts it once per division inside
// ONE transaction: a stale token on any division must abort every division's
// write, and that only holds if both sides raise the identical SEQ_CONFLICT.
export async function assertFreshSeq(
  tx: Tx,
  divisionId: string,
  expectedSeq: number | undefined,
): Promise<void> {
  if (expectedSeq === undefined) return;
  const [row] = await tx<{ seq: string | number }[]>`
    select seq from divisions where id = ${divisionId}`;
  const actual = Number(row?.seq ?? 0);
  if (expectedSeq !== actual) {
    throw new EngineError("SEQ_CONFLICT", "schedule changed since you loaded it", {
      actualSeq: actual,
    });
  }
}
