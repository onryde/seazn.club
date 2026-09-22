import "server-only";
// Publish EVERY unreleased division of a competition in one action.
//
// The organiser's problem this solves: a competition with eight divisions means
// eight trips to eight division pages to press Publish eight times, and the
// only thing standing between the entrants and the timetable is that errand.
//
// FOUR DECISIONS SHAPE THIS MODULE, and none of them is derivable from the
// code alone:
//
//  1. BEST EFFORT, NOT ATOMIC. Unlike `competition-schedule-apply.ts` — the
//     only other cross-division write in this product — this does NOT run one
//     transaction over every division. Each division publishes through its own
//     `publishSchedule` call, and a division the gate refuses leaves every
//     other division published. That is the right shape here because publishing
//     is INDEPENDENT per division (it moves one division's status and appends
//     one division's ledger event; nothing is shared and nothing half-lands),
//     and because the alternative — one refused division silently withholding
//     seven clean timetables — is the behaviour organisers actually complained
//     about when they did this by hand.
//
//  2. ONE ACKNOWLEDGEMENT FOR THE WHOLE COMPETITION. `acknowledge_warnings`
//     is passed straight through to every division. The organiser is shown the
//     warnings of every division that has them and confirms once.
//
//  3. A FIXTURE-LESS DIVISION IS NEVER A CANDIDATE (owner ruling). Publishing
//     is irreversible in the way that matters: once a division leaves `setup`,
//     `public_fixtures_v` stops redacting it FOREVER, so every fixture added to
//     it afterwards goes public the instant it is placed, with no second
//     publish to consent to. The per-division button makes that an explicit act
//     by the organiser; a BULK button would make it a side effect on divisions
//     they have not built yet. So the candidate set is `status = 'setup'` AND
//     at least one fixture. An empty division is absent from `results`
//     entirely — the same convention a non-`setup` division follows, not a
//     second "skipped" shape for the console to learn.
//
//  4. NO ENTITLEMENT GATE. `applyCompetitionSchedule` charges
//     `scheduling.multi_division` because it takes client-supplied assignments
//     and writes N boards. This takes no board at all: it is a loop over an
//     action the organiser can already perform, for free, N times by hand.
//     Metering the convenience and not the capability would be a toll booth on
//     a road that stays open.
//
// THE GATE IS NOT RE-IMPLEMENTED HERE. `validateScheduleIn` + `assertPublishable`
// keep exactly one authority (`schedule.ts`), reached through the same
// `publishSchedule` the single-division endpoint calls. This module's whole job
// is CHOOSING the divisions and CLASSIFYING the refusals.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PublishCompetitionScheduleRequest, ScheduleConflict } from "@/server/api-v1/schemas";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED, publishSchedule } from "./schedule";

export interface CompetitionPublishDivision {
  division_id: string;
  name: string;
  published: boolean;
  /** Present exactly when the gate refused this division. */
  refusal?: { code: string; blocking: boolean; conflicts: ScheduleConflict[] };
}

export interface CompetitionPublishOut {
  /** Divisions that actually moved `setup → scheduled` on this call. */
  published: number;
  /** Refused with `PUBLISH_UNACKNOWLEDGED` — re-sending with
   *  `acknowledge_warnings: true` publishes these. */
  needs_acknowledgement: number;
  /** Refused with `PUBLISH_BLOCKED` — no flag clears these; the board has to
   *  be fixed. */
  blocked: number;
  results: CompetitionPublishDivision[];
}

/**
 * Split a refusal from `publishSchedule` into the two cases the organiser can
 * act on differently, or return null for anything that is NOT a gate refusal.
 *
 * THE TEST IS THE CODE, NOT THE STATUS. Only the two codes `assertPublishable`
 * raises are verdicts on a board; every other error — 403, 404, 409, a 402 from
 * the entitlement freeze, AND an uncoded 422 — is a fault of the operation, and
 * the caller lets it propagate (see the loop).
 *
 * Reading "422" as "refusal" was wrong, and reachable. The candidate SELECT and
 * each division's publish are separate transactions, so a division that leaves
 * `setup` in the gap — someone presses Start, or the division completes —
 * reaches `publishSchedule` at another status and gets an UNCODED 422
 * ("a completed division cannot publish a schedule", schedule.ts:3648). Folded
 * into a refusal with a `PUBLISH_BLOCKED` fallback it reached the organiser as
 * HTTP 200 carrying a "blocked by conflicts" row with an EMPTY conflict list:
 * a refusal with nothing under it to read and nothing to fix.
 *
 * `blocking` is then exactly "is this `PUBLISH_BLOCKED`", because those are the
 * only two values `code` can hold.
 */
function refusalOf(err: unknown): CompetitionPublishDivision["refusal"] | null {
  if (!(err instanceof HttpError) || err.status !== 422) return null;
  const code = err.code;
  if (code !== PUBLISH_BLOCKED && code !== PUBLISH_UNACKNOWLEDGED) return null;
  const raw = (err.extra as { conflicts?: unknown } | undefined)?.conflicts;
  return {
    code,
    blocking: code === PUBLISH_BLOCKED,
    conflicts: Array.isArray(raw) ? (raw as ScheduleConflict[]) : [],
  };
}

/**
 * Publish every division of `competitionId` that is unreleased AND built.
 *
 * "Unreleased" is `status = 'setup'`, and that is a DATA fact, not a taste:
 * `public_fixtures_v` redacts `scheduled_at`, `venue`, `court_label`,
 * `officials` and `stream_url` for exactly that status
 * (`db/migration/deltas/V401__fixture_stream_url.sql:24`). A division at any
 * other status has already released its times, so it is not a candidate and
 * does not appear in `results` at all — publishing it again would be a ledger
 * event about nothing.
 *
 * "Built" is at least one fixture, per decision 3 in the header: an empty
 * division is excluded for the same reason and in the same way — absent from
 * `results`, untouched in the database.
 *
 * Order is by division id so the result is deterministic. Nothing downstream
 * depends on the order, but a best-effort report that shuffles between two
 * identical calls is impossible to diff.
 *
 * Throws 404 when the competition is not visible to `auth`. Anything a
 * division's publish raises that is NOT one of the two gate codes ABORTS the
 * run and propagates unchanged — including an uncoded 422: divisions already
 * published stay published (separate transactions, decision 1 above), and the
 * caller gets the real error instead of a success report with a silent hole in
 * it. `status = 'setup'` was true when the candidate was READ, and a division
 * can leave that status before its turn comes.
 */
export async function publishCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: PublishCompetitionScheduleRequest = {},
): Promise<CompetitionPublishOut> {
  // Read and release. `publishSchedule` opens its own `withTenant`, and calling
  // it from inside this one would take a second pooled connection while the
  // first is still pinned — the deadlock `competition-schedule-apply.ts`'s
  // header warns about, one module over.
  const divisions = await withTenant(auth.orgId, async (tx) => {
    const [competition] = await tx<{ id: string }[]>`
      select id from competitions where id = ${competitionId}`;
    if (!competition) throw new HttpError(404, "competition not found");
    // ONE query. Reading the divisions and then asking "does this one have
    // fixtures?" per division would be N+1 round trips for what one `exists`
    // answers, inside a transaction this function wants to close quickly.
    return tx<{ id: string; name: string }[]>`
      select d.id, d.name from divisions d
      where d.competition_id = ${competitionId} and d.status = 'setup'
        and exists (select 1 from fixtures f where f.division_id = d.id)
      order by d.id`;
  });

  const results: CompetitionPublishDivision[] = [];
  for (const division of divisions) {
    try {
      await publishSchedule(auth, division.id, input);
      results.push({ division_id: division.id, name: division.name, published: true });
    } catch (err) {
      const refusal = refusalOf(err);
      if (!refusal) throw err;
      results.push({
        division_id: division.id,
        name: division.name,
        published: false,
        refusal,
      });
    }
  }

  return {
    published: results.filter((r) => r.published).length,
    needs_acknowledgement: results.filter((r) => r.refusal?.code === PUBLISH_UNACKNOWLEDGED).length,
    blocked: results.filter((r) => r.refusal?.blocking === true).length,
    results,
  };
}
