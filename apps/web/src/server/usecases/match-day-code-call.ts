import "server-only";
// Calling a match to a court through a Match Day code (Task 8e; owner 2026-11-13, reversing the capture S4 design's §1/§3 "a
// code never calls a match to a court" for a code minted with "Call matches to courts"). Umpires at the courts put the next
// match on a free court without the organiser's laptop. Contract: docs/contracts/capture-matchday-call.v1.json.
//
// The desk's rules, never a copy of them: the candidates are the desk's (`candidatesIn`, match-day.ts), and the preview, the call
// and its Undo are the desk's usecases' cores (`previewCallAs`, `callFixtureAs`, `undoCallAs`, match-day-call.ts) with the code as
// the caller — so every hard stop (NOT_CALLABLE, COURT_BUSY, NOT_CANDIDATE_COURT, PLAYER_BUSY, NOT_CALLED, the billing freeze)
// is judged exactly as on the desk. What this module adds is the code's own gate, on the code's own facts, never membership:
//  - its "Call matches to courts" tick (`canCall`): without it the preview, the call and the Undo are 403 MD_NO_CALL, before
//    anything is read. The candidates are a read and need no tick;
//  - its scope, judged at the moment of asking and INSIDE the call's transaction, after the fixture row is locked (`guard`), so a
//    board edit cannot move the match out of scope between the check and the write:
//      the COURT — a venue code's courts are its venue's, a courts code's exactly its list; a whole-competition code reaches any
//      of the organisation's courts, and the desk's own NOT_CANDIDATE_COURT then keeps the match on its division's courts;
//      the MATCH — `inScope` (match-day-code-view.ts), the one predicate the day read lists by and the open and the approvals
//      judge by, at the match's place now. A match outside it is 403 MD_OUT_OF_SCOPE, and so is a court.
// A court or match the organisation does not have (or another organisation's: RLS) is 404, as the approvals' unknown stage is.
//
// Only an md_ bearer resolved by `matchDayCodeOf` reaches these functions: they take the code's row, never an AuthCtx. A call is
// written against the code (`fixture_calls.called_by_code`, `called_by` null), and a call and an Undo each leave one
// `match_day_code_uses` row once they have committed. The token is never in a log line, an error or an answer.
import { withTenant, type Tx } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { DEFAULT_LOCALE, getDictionary } from "@/lib/i18n";
import { CALL_REFUSAL, TBD_ENTRANT } from "@/lib/match-day/call";
import { levelWords } from "@/lib/score/levels";
import { assertUuid } from "@/server/api-v1/auth";
import type {
  CaptureMatchdayCallOk,
  CaptureMatchdayCallPreview,
  CaptureMatchdayCallReason,
  CaptureMatchdayCandidates,
  CaptureMatchdayUndoOk,
} from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { candidatesIn } from "./match-day";
import { callFixtureAs, previewCallAs, undoCallAs, type CallCaller, type CallGuard } from "./match-day-call";
import { codeRowViews, inScope, scopeFixtureOf, type ScopeFixture } from "./match-day-code-view";
import { logMatchDayUse, type MatchDayCodeRow } from "./match-day-codes";

const OUT_OF_SCOPE = (what: "court" | "match"): HttpError =>
  new HttpError(403, `this ${what} is not in this Match Day code's scope`, "MD_OUT_OF_SCOPE");

/** The code's "Call matches to courts" tick, asked before anything is read or written. */
function requireCanCall(code: MatchDayCodeRow): void {
  if (!code.canCall) throw new HttpError(403, "this Match Day code cannot call matches to courts", "MD_NO_CALL");
}

/** The code as a caller of the desk's call usecases: its org, and itself as who called. */
const callerOf = (code: MatchDayCodeRow): CallCaller => ({ orgId: code.orgId, actor: { kind: "match_day_code", codeId: code.id } });

/** The court, if the organisation has it (not archived) — 404 otherwise — and the code's scope covers it — 403 otherwise. */
async function courtInScope(tx: Tx, code: MatchDayCodeRow, courtId: string): Promise<{ id: string; name: string }> {
  const [court] = await tx<{ id: string; name: string; venue_id: string }[]>`
    select id, name, venue_id from courts where id = ${courtId} and archived_at is null`;
  if (!court) throw new HttpError(404, "court not found");
  const scope = code.scope;
  if (scope.kind === "venue" && court.venue_id !== scope.venueId) throw OUT_OF_SCOPE("court");
  if (scope.kind === "courts" && !scope.courtIds.includes(court.id)) throw OUT_OF_SCOPE("court");
  return { id: court.id, name: court.name };
}

/** The match where it is now, as `inScope` judges it — 404 when the organisation has no such match, 403 when the code does not
 *  cover it. */
async function matchInScope(tx: Tx, code: MatchDayCodeRow, fixtureId: string): Promise<void> {
  const [row] = await tx<ScopeFixture[]>`
    select d.competition_id, f.court_id, c.venue_id, f.status, f.scheduled_at, f.finished_at, s.status as stage_status,
           f.home_entrant_id, f.away_entrant_id, (d.archived_at is null) as division_live
      from fixtures f
      join divisions d on d.id = f.division_id
      join stages s on s.id = f.stage_id
      left join courts c on c.id = f.court_id
     where f.id = ${fixtureId}`;
  if (!row) throw new HttpError(404, "fixture not found");
  if (!inScope(code, row)) throw OUT_OF_SCOPE("match");
}

/** An Undo through a code reaches a call made by a Match Day code only — never the desk's (the controller's ruling, Task 8e fix
 *  round 1): a call row with no `called_by_code` is the organiser's, refused MD_CALL_REFUSED `not_code_call`. No call row at
 *  all is left to the desk's own NOT_CALLED. Read under the Undo's row lock. */
async function codeMadeTheCall(tx: Tx, fixtureId: string): Promise<void> {
  const [call] = await tx<{ called_by_code: string | null }[]>`select called_by_code from fixture_calls where fixture_id = ${fixtureId}`;
  if (call && call.called_by_code === null) throw refused("not_code_call");
}

/** The code's scope as the call usecases' guard: the match, then (for a call or its preview) the court. */
function scopeGuard(code: MatchDayCodeRow, fixtureId: string, courtId: string | null): CallGuard {
  return async (tx) => {
    await matchInScope(tx, code, fixtureId);
    if (courtId !== null) await courtInScope(tx, code, courtId);
  };
}

const REFUSED_MESSAGE: Record<CaptureMatchdayCallReason, string> = {
  not_candidate_court: "this court is not one of the match's division's courts",
  player_busy: "a player of this match is playing, or called, on another court",
  court_busy: "this court has a match playing or called",
  started: "this match has started, or is over",
  not_ready: "a side of this match is still to be decided",
  not_called: "this match is not called, or has been moved since it was called",
  not_code_call: "this match was called on the web desk: undo it there",
  frozen: "this competition is read-only on its organisation's plan",
};

const refused = (reason: CaptureMatchdayCallReason, extra: Record<string, unknown> = {}): HttpError =>
  new HttpError(409, REFUSED_MESSAGE[reason], "MD_CALL_REFUSED", { reason, ...extra });

const MD_WORD = /^MD_[A-Z_]+$/;

/**
 * The error a call route answers for `e`, a refusal raised by the desk's call usecases, in the call contract's words:
 *  - the billing freeze (402) is MD_CALL_REFUSED `frozen`;
 *  - each desk refusal (lib/match-day/call.ts) is MD_CALL_REFUSED with its reason: PLAYER_BUSY `player_busy` (+ person_name,
 *    court_name), COURT_BUSY `court_busy` (+ court_name; never the other competition's name), NOT_CANDIDATE_COURT
 *    `not_candidate_court` (+ court_name), NOT_CALLABLE `started`, or `not_ready` for a side still to be decided, NOT_CALLED
 *    `not_called`;
 *  - an md_ word (the scope guard's MD_OUT_OF_SCOPE) and a codeless HttpError (404 not found, 400 a malformed id) are unchanged;
 *  - any other coded 4xx keeps its status and loses its word; anything else is a fault, 500, with the error as its cause.
 */
export function mdCallRefusalOf(e: unknown): unknown {
  if (e instanceof PaymentRequiredError) return refused("frozen");
  if (!(e instanceof HttpError) || e.code === undefined || MD_WORD.test(e.code)) return e;
  const extra = e.extra ?? {};
  const named = (k: string): Record<string, unknown> => (k in extra ? { [k]: extra[k] } : {});
  switch (e.code) {
    case CALL_REFUSAL.PLAYER_BUSY:
      return refused("player_busy", { ...named("person_name"), ...named("court_name") });
    case CALL_REFUSAL.COURT_BUSY:
      return refused("court_busy", named("court_name"));
    case CALL_REFUSAL.NOT_CANDIDATE_COURT:
      return refused("not_candidate_court", named("court_name"));
    case CALL_REFUSAL.NOT_CALLABLE:
      return refused(extra.status === TBD_ENTRANT ? "not_ready" : "started");
    case CALL_REFUSAL.NOT_CALLED:
      return refused("not_called");
  }
  if (e.status >= 400 && e.status < 500) {
    log.warn({ upstream: e.code, status: e.status }, "match day call: a refusal with no md_ word, answered by its status");
    return new HttpError(e.status, "this call cannot be made with a Match Day code");
  }
  const fault = new HttpError(500, "this call could not be completed", "INTERNAL");
  fault.cause = e;
  return fault;
}

async function inCallWords<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw mdCallRefusalOf(e);
  }
}

/** A call or an Undo's use row (§3), after it committed, on the pooled client (the use log is sealed): as the approvals do, a
 *  pino line first, and an insert that fails is a warning, never the call's answer — the call has committed. */
async function logUse(code: MatchDayCodeRow, kind: "call" | "undo_call", fixtureId: string): Promise<void> {
  log.info({ codeId: code.id, fixtureId, kind }, "match_day_code_call");
  try {
    await logMatchDayUse(code.id, { kind, fixtureId });
  } catch (e) {
    const pg = (e as { code?: unknown }).code;
    log.warn({ codeId: code.id, fixtureId, kind, pg: typeof pg === "string" ? pg : undefined }, "match day call: its use row was not written");
  }
}

/**
 * The matches that could start on `courtId` now (the desk's free-court panel, `candidatesIn`), limited to the code's scope: the
 * court must be in it, and only matches the code's day read could list are offered (a whole-competition code's no-court
 * matches among them; a venue or courts code never offers a match from a court it does not cover). Ranked as the desk ranks
 * them, each as the day read's row plus where it waits, its planned time and a busy player. Needs no tick.
 */
export async function candidatesForCode(code: MatchDayCodeRow, courtId: string, now: Date): Promise<CaptureMatchdayCandidates> {
  assertUuid(courtId, "court");
  const dict = await getDictionary(DEFAULT_LOCALE, "ui");
  const words = levelWords(await getDictionary(DEFAULT_LOCALE, "public"));
  return withTenant(code.orgId, async (tx) => {
    const court = await courtInScope(tx, code, courtId);
    const ranked = await candidatesIn(tx, code.competitionId, courtId, now, dict, {
      keep: (row, board) => inScope(code, scopeFixtureOf(code, board, row)),
    });
    const rowView = await codeRowViews(tx, ranked.map((r) => r.row), dict, words);
    return {
      court_id: court.id,
      court_name: court.name,
      candidates: ranked.map(({ candidate: c, row }) => ({
        match: rowView(row),
        source: c.source,
        from_court_name: c.from_court_name,
        called: c.source === "other_court" && c.fixture.called_at !== null,
        planned_at: c.planned_at,
        waiting_minutes: c.waiting_minutes,
        behind_minutes: c.behind_minutes,
        blocked: c.blocked,
      })),
    };
  });
}

/** The knock-on of calling the match onto the court now (`previewCallAs`): the desk's shifts and warnings, nothing written.
 *  Needs the tick; the match and the court must be in scope. Round codes in English, as the day read's. */
export async function previewCallForCode(
  code: MatchDayCodeRow,
  fixtureId: string,
  courtId: string,
  now: Date,
): Promise<CaptureMatchdayCallPreview> {
  requireCanCall(code);
  assertUuid(fixtureId, "fixture");
  assertUuid(courtId, "court");
  const preview = await inCallWords(() =>
    previewCallAs(callerOf(code), fixtureId, courtId, now, { guard: scopeGuard(code, fixtureId, courtId), locale: DEFAULT_LOCALE }),
  );
  return {
    shifts: preview.shifts.map((s) => ({
      fixture_id: s.fixture_id,
      label: s.label,
      round_label: s.round.code,
      planned_at: s.planned_at,
      estimated_at: s.estimated_at,
    })),
    warnings: preview.warnings,
  };
}

/** Call the match onto the court now (`callFixtureAs`), written against the code. Needs the tick; both in scope. */
export async function callForCode(code: MatchDayCodeRow, fixtureId: string, courtId: string, now: Date): Promise<CaptureMatchdayCallOk> {
  requireCanCall(code);
  assertUuid(fixtureId, "fixture");
  assertUuid(courtId, "court");
  const got = await inCallWords(() => callFixtureAs(callerOf(code), fixtureId, courtId, now, { guard: scopeGuard(code, fixtureId, courtId) }));
  await logUse(code, "call", fixtureId);
  return got;
}

/**
 * Undo call (`undoCallAs`): the match goes back to where it was before it was called. Needs the tick; the match in scope where it
 * is now (on the called court); and only a call a Match Day code made — any code's, never the desk's (`not_code_call`).
 *
 * The slot it goes back to is NOT judged against the code's scope (the controller's ruling, Task 8e fix round 1): Undo puts back
 * what was there before the call, the organiser's own plan, so a match a Hall A code called over from Hall B goes back to Hall B,
 * a court the code does not cover. That restores a plan; it never places a match anywhere new.
 */
export async function undoCallForCode(code: MatchDayCodeRow, fixtureId: string): Promise<CaptureMatchdayUndoOk> {
  requireCanCall(code);
  assertUuid(fixtureId, "fixture");
  const scope = scopeGuard(code, fixtureId, null);
  const guard: CallGuard = async (tx) => {
    await scope(tx);
    await codeMadeTheCall(tx, fixtureId);
  };
  const got = await inCallWords(() => undoCallAs(callerOf(code), fixtureId, { guard }));
  await logUse(code, "undo_call", fixtureId);
  return got;
}
