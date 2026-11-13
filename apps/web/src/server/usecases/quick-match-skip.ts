import "server-only";
// "Not played" and "Put back" on a quick match home (plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md
// Task 3; spec docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6). Anyone holding the home
// link may do either (§3, call 3: as for Score and Edit result, the token is the credential, §7.4 of the quick match spec).
//
// A skip is a direct, guarded status write, `scheduled | in_play → cancelled` (plan D1). It writes NO ledger event:
// `cancelled` is a LOCKED status (lib/fixture-status.ts), so the ledger refuses every later append to it, a void included,
// and a scorer's tap racing the skip waits on the same fixture lock and is refused `ALREADY_DECIDED`. A partial score stays
// in `score_events` and `match_states` untouched, as history; the stored table counts decided matches only, so a skip
// changes none of its inputs (plan P4). `fixtures_track_finished` stamps `finished_at` for it.
//
// Put back is the exact inverse (plan D2, the owner's PO ruling 2026-11-13: a mistaken skip costs the guests nothing): the
// status is re-derived from the ledger by the write path's own rule (`foldFixture` + `fixtureStatusFromFold`, the
// `refreeze.ts` precedent), so a match with nothing scored is ready again and a partly scored one is live at its score.
// It is refused once the league is finished (`isQuickMatchFinished` over the league stage's matches, plan D4, the one
// "finished"; plan 5 P14: the league stage, so a League + Knockout's knockout never holds it open): §6 hides Put back then,
// and only a stale tap meets the refusal.
//
// The checks, in this order, the same for both, each answering before the next runs:
//   1. the post limit, per quick match (`qm-skip:<id>`, MUTATION_LIMIT): its 429 carries no code;
//   2. the fixture id's shape: a non-uuid is NOT_FOUND (404) before any query;
//   3. one transaction as the system org. The fixture's advisory lock FIRST, the key `appendEvent` takes (D1), so the read
//      below and the write after it see one status. Then the per-match check (the quick match spec's §7.1 point 3: every
//      quick match shares one org, so RLS alone cannot keep two strangers apart): the fixture by id AND this quick match's
//      competition, none → NOT_FOUND. A knockout match, a match of a bracket, is never skippable (§3: a bracket needs a
//      winner; T1 review G2), judged by the match's own stage (plan 5 P14: a League + Knockout's league matches are):
//      NOT_SKIPPABLE. A bye line is no match: NOT_FOUND.
//   4. Skip: already Not played → `{changed:false}` (D3, a second tap). Otherwise the guarded update; nothing moved (a
//      result, or any other status) → NOT_SKIPPABLE. Put back: not Not played → `{changed:false}` (D3). The league finished
//      → LEAGUE_FINISHED. Otherwise the fold's status.
//
// The pad's half (FR4 m2, `withQuickMatchFinished`): `/state` tells a guest's pad on a Not played match whether its league
// has finished, by the same read Put back refuses on (`leagueFinishedFor`), so the pad stops waiting for a Put back that
// cannot come.
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_ORG_ID } from "@/lib/quick-match-constants";
import { MUTATION_LIMIT, rateLimit } from "@/lib/rate-limit";
import { isBye, type MatchLineRow } from "@/lib/run-sheet-groups";
import { assertUuid } from "@/server/api-v1/auth";
import { fixtureStatusFromFold } from "@/server/engine-db/append-event";
import { foldFixture } from "@/server/engine-db/fold";
import { isQuickMatchFinished, playedOf, type QuickMatchRow } from "./quick-match-home";

const SYSTEM_ORG = QUICK_MATCH_SYSTEM_ORG_ID;

const notFound = (): HttpError => new HttpError(404, "no such match in this quick match", QUICK_MATCH_ERRORS.NOT_FOUND);
const notSkippable = (why: string): HttpError =>
  new HttpError(422, `this match can't be marked Not played: ${why}`, QUICK_MATCH_ERRORS.NOT_SKIPPABLE);

/** The columns the checks read: `isBye`'s own (`MatchLineRow`) and where the match sits. */
interface SkipFixtureRow extends MatchLineRow {
  id: string;
  division_id: string;
  stage_kind: string;
}

/** Steps 1 and 2: the post limit, then the id's shape. */
async function preflight(row: QuickMatchRow, fixtureId: string): Promise<void> {
  await rateLimit(`qm-skip:${row.id}`, MUTATION_LIMIT);
  try {
    assertUuid(fixtureId, "fixture");
  } catch {
    throw notFound();
  }
}

/** The home's own "finished" (`isQuickMatchFinished` over `playedOf`) for the LEAGUE STAGE holding `fixtureId`, in the
 *  caller's transaction. Put back's refusal and the pad's Not played screen (`withQuickMatchFinished`) ask it the same way.
 *  By stage, not by division (plan 5 P14): a plain league is one stage, so the two are the same; a League + Knockout's
 *  league is finished when its own matches are, and the knockout's unplayed lines must not keep Put back open until the
 *  final (D3: Put back is refused once the league is done). A fixture that is gone holds no stage: no match, so not
 *  finished (the predicate's empty case). */
async function leagueFinishedFor(tx: Tx, fixtureId: string): Promise<boolean> {
  const matches = await tx<MatchLineRow[]>`
    select status, outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label, ext_key
    from fixtures where stage_id = (select stage_id from fixtures where id = ${fixtureId})`;
  return isQuickMatchFinished(playedOf(matches));
}

/** Step 3, inside the caller's transaction: the lock, then the match as THIS quick match holds it. */
async function lockedMatch(tx: Tx, row: QuickMatchRow, fixtureId: string): Promise<SkipFixtureRow> {
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
  const [f] = await tx<SkipFixtureRow[]>`
    select f.id, f.division_id, s.kind as stage_kind, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id,
           f.home_slot_label, f.away_slot_label, f.ext_key
    from fixtures f
    join divisions d on d.id = f.division_id
    join stages s on s.id = f.stage_id
    where f.id = ${fixtureId} and d.competition_id = ${row.competitionId}`;
  if (!f) throw notFound();
  // By the match's own stage, whatever the quick match's format (plan 5 P14): a League + Knockout's league matches are
  // skippable, its knockout's never are, and a legacy knockout holds no league stage at all.
  if (f.stage_kind !== "league") throw notSkippable("a knockout match needs a winner");
  if (isBye(f)) throw notFound();
  return f;
}

/**
 * Mark a league match Not played. `{changed:false}` when it already is (D3); NOT_SKIPPABLE when it has a result or is in
 * any other status the skip does not take.
 */
export async function skipQuickMatchFixture(row: QuickMatchRow, fixtureId: string): Promise<{ changed: boolean }> {
  await preflight(row, fixtureId);
  return withTenant(SYSTEM_ORG, async (tx) => {
    const f = await lockedMatch(tx, row, fixtureId);
    if (f.status === "cancelled") return { changed: false };
    // THE guard (D1): only an unplayed or in-progress match moves (§6: a finished match cannot be skipped).
    const moved = await tx<{ id: string }[]>`
      update fixtures set status = 'cancelled'
      where id = ${fixtureId} and status in ('scheduled', 'in_play')
      returning id`;
    if (moved.length === 0) throw notSkippable(`it is ${f.status}`);
    return { changed: true };
  });
}

/**
 * Put a Not played match back, exactly as it was before the skip (D2): the status the ledger folds to. `{changed:false,
 * status}` when it is not Not played (D3); LEAGUE_FINISHED once every match is played or Not played.
 */
export async function putBackQuickMatchFixture(
  row: QuickMatchRow,
  fixtureId: string,
): Promise<{ changed: boolean; status: string }> {
  await preflight(row, fixtureId);
  return withTenant(SYSTEM_ORG, async (tx) => {
    const f = await lockedMatch(tx, row, fixtureId);
    if (f.status !== "cancelled") return { changed: false, status: f.status };
    // The home's own count, in this transaction: the league the guest saw finished is the one refused.
    if (await leagueFinishedFor(tx, fixtureId)) {
      throw new HttpError(422, "the league has finished, so a Not played match can't be put back", QUICK_MATCH_ERRORS.LEAGUE_FINISHED);
    }
    const folded = await foldFixture(tx, fixtureId);
    // A skip refuses any match with a result, so a Not played match's ledger never folds to one. Asserted, not assumed: a
    // result here would be put back as a live match with its result hidden.
    if (folded !== null && folded.outcome !== null) {
      throw new Error(`put back: fixture ${fixtureId} is Not played, yet its ledger folds to a result`);
    }
    const status = folded === null ? "scheduled" : fixtureStatusFromFold(folded.outcome, folded.active, f.stage_kind);
    const moved = await tx<{ id: string }[]>`
      update fixtures set status = ${status} where id = ${fixtureId} and status = 'cancelled' returning id`;
    // Under the fixture lock nothing that takes it can move the status between the read and here; a writer that skips the
    // lock could. Refused loudly rather than reported as put back.
    if (moved.length !== 1) throw new Error(`put back: fixture ${fixtureId} left Not played while the lock was held`);
    return { changed: true, status };
  });
}

/**
 * FR4 m2 (whole-branch review m2, controller PO rec 2026-11-13): what `/state` adds for a guest's pad on a Not played match,
 * `quick_match_finished`: whether its league has finished. That pad reads the match again on a clock to see a Put back
 * (FR3); once the league is finished none can come (§6 hides Put back, and a stale one is refused LEAGUE_FINISHED), so the
 * pad stops reading and its line drops the Put back hint. Only a quick match's (the system org's) Not played match carries
 * the key: every other body, an organiser's above all, is handed back as it came (the same object, no query), so its shape
 * and its ETag do not move. Called by the `/state` route and by the scan page for the pad's first paint.
 */
export async function withQuickMatchFinished<S extends { fixture_id: string; status: string }>(
  orgId: string,
  state: S,
): Promise<S | (S & { quick_match_finished: boolean })> {
  if (orgId !== SYSTEM_ORG || state.status !== "cancelled") return state;
  const finished = await withTenant(SYSTEM_ORG, (tx) => leagueFinishedFor(tx, state.fixture_id));
  return { ...state, quick_match_finished: finished };
}
