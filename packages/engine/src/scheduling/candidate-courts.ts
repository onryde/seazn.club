// Candidate courts (P9 pass 2 — venues & courts -> scheduler design doc,
// "Scheduler integration"). Pure, deterministic, zero imports: no Date, no
// random, no DB. ONE function shared by BOTH the build-input assembly
// (apps/web usecases/schedule.ts, feeding `BuildConfig.courts`) and the
// validate path (validateScheduleIn, feeding `VerifyConfig.courts`) — the
// repo's recurring defect is exactly this fork (a placer that filters one
// way and a verifier that filters another), so a second copy is a review
// finding, not a style nit.
//
// Rulings this function encodes (owner, P9 dispatch):
//
//   1. Candidate ORDER = position in the caller's stored `config.courts`
//      array, AFTER filtering, first-wins on a duplicate id. Court ids are
//      OPAQUE — never re-sorted by id, unlike `repairCourts` in
//      repair-domain.ts (which sorts lexicographically because it merges
//      three sources with no shared order to preserve). Preserving the
//      organiser's own array order is what lets the wire index this
//      produces line up with `config.courts`' own position once the
//      filtered list becomes the new `config.courts`.
//   2. Tag semantics: a court qualifies iff its tags are a SUPERSET of
//      `requiredTags` (design doc "Tag semantics" — union of a division's
//      and its stage's `required_court_tags`). Empty required = every
//      (non-archived, configured) court. Tags arrive already normalised
//      (trim/lowercase/dedupe — `usecases/venues.ts`'s `normalizeTags`) by
//      the caller; this function does no case-folding of its own; a
//      mismatched case is a genuine non-match, not a bug.
//   3. Archived: a court whose `archived` flag is set is excluded
//      regardless of tags. The caller is responsible for folding a court's
//      OWN `archived_at` and its parent VENUE's `archived_at` into this one
//      flag before calling in (design doc A3: "archived venues AND archived
//      courts are excluded from candidate sets") — this function has no
//      notion of venues at all.
//   4. A configured id with no matching row in `courts` (e.g. a hard-deleted
//      court still sitting in a stale stored config) is silently excluded,
//      the same as an archived one — there is nothing to place on.
//
// What this function deliberately does NOT do: decide what happens on an
// empty result (that is a 422 at the usecase layer, `NO_MATCHING_COURT`),
// and it never touches `existing` assignments — an assignment already
// sitting on a court this run would now exclude stays exactly as valid as
// it was (ruling 3: archiving must not retroactively invalidate a board).

/** A court's identity for candidate-set purposes — no calendar, no name, no
 *  venue: just what `candidateCourts` needs to decide "may a NEW fixture be
 *  placed here". */
export interface CourtMeta {
  readonly id: string;
  /** Already-normalised lowercase slugs (see module header, ruling 2). */
  readonly tags: readonly string[];
  /** Folds the court's OWN `archived_at` and its venue's — see ruling 3. */
  readonly archived: boolean;
}

export interface CandidateCourts {
  /** Filtered, deduped (first-wins), in the caller's `configuredCourtIds`
   *  order — ruling 1. This becomes the new `config.courts` once a caller
   *  applies it. */
  readonly ids: readonly string[];
  /** `id -> position in {@link ids}` — the wire index once `ids` becomes
   *  `config.courts` (array position IS the solver's court index,
   *  `placement-client.ts`'s own `IndexSpace.courtIndexOf`). Provided so a
   *  caller never has to re-derive this from `ids` by hand. */
  readonly indexOf: ReadonlyMap<string, number>;
}

/**
 * Candidate courts for a stage: the organiser's own configured court ids,
 * filtered to the ones that are non-archived and carry every required tag,
 * in the organiser's own order.
 *
 * @param configuredCourtIds `ScheduleConfig.courts` (or the stage-scoped
 * equivalent) as stored — court ids, opaque, possibly containing a
 * duplicate or an id with no current `courts` row.
 * @param courts every court metadata row the caller could resolve
 * (typically the whole org's courts — filtering to only the ids named in
 * `configuredCourtIds` is this function's job, not the caller's).
 * @param requiredTags the union of a division's and its stage's
 * `required_court_tags`. Empty means "every court qualifies".
 */
export function candidateCourts(
  configuredCourtIds: readonly string[],
  courts: readonly CourtMeta[],
  requiredTags: readonly string[],
): CandidateCourts {
  const metaById = new Map(courts.map((c) => [c.id, c] as const));
  const required = new Set(requiredTags);
  const ids: string[] = [];
  const indexOf = new Map<string, number>();
  for (const id of configuredCourtIds) {
    if (indexOf.has(id)) continue; // duplicate -> first occurrence already decided this id
    const meta = metaById.get(id);
    if (meta === undefined || meta.archived) continue;
    let qualifies = true;
    if (required.size > 0) {
      const tagSet = new Set(meta.tags);
      for (const t of required) {
        if (!tagSet.has(t)) {
          qualifies = false;
          break;
        }
      }
    }
    if (!qualifies) continue;
    indexOf.set(id, ids.length);
    ids.push(id);
  }
  return { ids, indexOf };
}
