import "server-only";
// P9 pass 2b — court identity for the scheduler (design doc "Scheduler
// integration"). This is the ONE place both the build-input assembly
// (`autoSchedule`) and the validate path (`validateScheduleIn`) resolve a
// stage/division's candidate court set through: they call `resolveCandidateCourts`
// below, which itself calls the ONE engine filter,
// `@seazn/engine/scheduling`'s `candidateCourts` — see that function's own
// header (packages/engine/src/scheduling/candidate-courts.ts) for why a
// second, inlined tag-filter loop at either web call site is this
// subsystem's recurring bug (the placer/verifier fork), not a style nit.
import { candidateCourts, type CandidateCourts, type CourtMeta } from "@seazn/engine/scheduling";
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
// Same trim/lowercase/dedupe/drop-empties rule the courts path itself uses
// for a court's own `tags` — one copy, imported (D5/P8's `divisions.ts`
// already sets this precedent for the REQUIRED side of this same match).
import { normalizeTags } from "./venues";

type Tx = postgres.TransactionSql;

export const NO_MATCHING_COURT_CODE = "NO_MATCHING_COURT";

/**
 * Every court this org has configured, archived or not. Deliberately NOT
 * pre-filtered by `archived_at`: `candidateCourts` decides archived-exclusion
 * itself (ruling 3, candidate-courts.ts — a court whose OWN or whose VENUE's
 * `archived_at` is set is excluded regardless of tags), so pre-filtering here
 * would just be a second, silent copy of that rule with no test able to tell
 * the two apart.
 *
 * Takes the CALLER's own open transaction rather than `venues.ts`'s
 * `listVenues(auth, opts)`, which opens its OWN `withTenant` — calling that
 * from inside an already-open transaction is a tracked connection-pool
 * nesting violation (`lib/db.ts`'s `DB_NESTING_GUARD`: production caps the
 * pool at 5 connections, so 5 concurrent requests reaching a nested
 * `withTenant` pin every slot and hang the process permanently, with no
 * queue-wait timeout to recover). `autoSchedule`'s three-phase transaction
 * boundary (`schedule.ts`'s own doc comment on `AutoSchedulePlan`) is exactly
 * the discipline this avoids breaking.
 */
async function orgCourtMetas(tx: Tx): Promise<CourtMeta[]> {
  return tx<CourtMeta[]>`
    select c.id, c.tags,
      (c.archived_at is not null or v.archived_at is not null) as archived
    from courts c
    join venues v on v.id = c.venue_id`;
}

/**
 * D5/P8 ∪ P9 (design doc "Tag semantics"): a court must carry every tag
 * EITHER the division or its stage requires — union, not the intersection of
 * the two rule sets, because a stage's requirement narrows what already
 * applies at the division rather than replacing it. Deduping the RESULT is
 * `candidateCourts`'s own job (it builds a `Set` internally); this only
 * concatenates and normalises.
 *
 * `normalizeTags` runs here even though `divisions.required_court_tags` is
 * already normalised at write (`divisions.ts`'s `patchDivision`) — defensive,
 * not redundant: `stages.required_court_tags` (V367) has NO write path yet
 * (P9 pass 2b only wires the READ side), so this must not assume a future
 * writer will normalise before this function ever sees the value.
 */
export function unionRequiredCourtTags(
  divisionTags: readonly string[],
  stageTags: readonly string[],
): string[] {
  return normalizeTags([...divisionTags, ...stageTags]);
}

/**
 * Resolves the candidate court set through the ONE engine filter, then logs
 * `schedule_court_filtered` at the filter point (design doc's pino
 * requirement) — mirrors `capacity-guard.ts`'s `logCapacityAssessed`, fired
 * from the server-side consumer, never from a pure lib.
 */
export async function resolveCandidateCourts(
  tx: Tx,
  divisionId: string,
  configuredCourtIds: readonly string[],
  requiredTags: readonly string[],
): Promise<CandidateCourts> {
  const courts = await orgCourtMetas(tx);
  const result = candidateCourts(configuredCourtIds, courts, requiredTags);
  log.info(
    {
      event: "schedule_court_filtered",
      candidates: result.ids.length,
      requiredTags: [...requiredTags],
      divisionId,
    },
    "schedule_court_filtered",
  );
  return result;
}

/**
 * Build-time precondition: an empty candidate set makes the solve
 * unwinnable before it starts, so this refuses with a typed 422 BEFORE
 * either solver is reached — same shape as `capacity-guard.ts`'s
 * `guardCapacity`/`CAPACITY_IMPOSSIBLE`.
 *
 * NEVER call this from `validateScheduleIn`: that path reports on a board
 * that may already EXIST, and an existing assignment sitting on a since-
 * archived or since-retagged court must keep validating clean (ruling 3,
 * candidate-courts.ts) — refusing the whole division's report because today's
 * candidate set is empty would retroactively invalidate a board nobody
 * touched, exactly what that ruling exists to prevent. Only a fresh SOLVE has
 * nothing yet placed to protect.
 */
export function guardNoMatchingCourt(
  candidateCourtIds: readonly string[],
  context: { requiredTags: readonly string[]; divisionId: string; [key: string]: unknown },
): void {
  if (candidateCourtIds.length > 0) return;
  throw new HttpError(422, "No configured court matches the required tags", NO_MATCHING_COURT_CODE, {
    requiredTags: [...context.requiredTags],
    candidateCount: 0,
  });
}
