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
import {
  candidateCourts,
  usableWindows,
  type CandidateCourts,
  type CourtCalendar,
  type CourtMeta,
} from "@seazn/engine/scheduling";
import type postgres from "postgres";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
// Same trim/lowercase/dedupe/drop-empties rule the courts path itself uses
// for a court's own `tags` — one copy, imported (D5/P8's `divisions.ts`
// already sets this precedent for the REQUIRED side of this same match).
import { normalizeTags } from "./venues";
// #622 — the ONE role namer (`roundRoleFor` ranks a fixture within its own
// lane and hands the result to the engine's `roundRole`), and the ONE
// serialisation of a role to the key `stage_round_court_tags.round_role`
// stores. Imported rather than re-derived here for the same reason every
// display consumer imports it: a second namer is how four of them drifted
// apart before F1 (see round-role.ts's own header).
import { roundRoleKey } from "@seazn/engine/competition";
import { roundRoleFor } from "@/lib/round-role-label";

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
 *
 * Ordered (`sort, name, id` — `venues.ts`'s own listing convention) so the
 * EMPTY-CONFIGURED-LIST fallback below (`resolveCandidateCourts`) gets a
 * deterministic candidate order rather than whatever a plain table scan
 * happens to return: with an explicit configured list order is the
 * organiser's own array position (ruling 1, candidate-courts.ts) and this
 * row order is unused, but the fallback has no organiser-authored order to
 * preserve, so this is the only order it can offer.
 */
async function orgCourtMetas(tx: Tx): Promise<CourtMeta[]> {
  return tx<CourtMeta[]>`
    select c.id, c.tags,
      (c.archived_at is not null or v.archived_at is not null) as archived
    from courts c
    join venues v on v.id = c.venue_id
    order by v.sort, v.name, c.sort, c.name, c.id`;
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
 * not redundant: `stages.required_court_tags` (V367) still has no write path
 * of its own, so this must not assume a future writer will normalise before
 * this function ever sees the value.
 *
 * VARIADIC as of #622, which added a THIRD scope: a round role's own tags
 * (`stage_round_court_tags`, keyed by `roundRoleKey()` — see V375's header for
 * why a role and not a `round_no`). The three narrow in sequence — division,
 * then stage, then round — and the argument order is irrelevant because the
 * result is a set-union normalised into a sorted-by-construction list. Every
 * pre-#622 two-argument call keeps working unchanged; `null`/`undefined` is
 * accepted and contributes nothing, so a caller with no round row for a
 * fixture passes it straight through rather than branching.
 */
export function unionRequiredCourtTags(
  ...tagLists: readonly (readonly string[] | null | undefined)[]
): string[] {
  return normalizeTags(tagLists.flatMap((t) => [...(t ?? [])]));
}

/**
 * Resolves the candidate court set through the ONE engine filter, then logs
 * `schedule_court_filtered` at the filter point (design doc's pino
 * requirement) — mirrors `capacity-guard.ts`'s `logCapacityAssessed`, fired
 * from the server-side consumer, never from a pure lib.
 *
 * P9 pass 3b-FIX (item 2, owner ruling): an empty `configuredCourtIds` means
 * UNCONSTRAINED, not "no courts" — the same reading `candidateCourts` itself
 * already gives an empty `requiredTags` ("every court qualifies"). A division
 * with no `schedule_settings` row at all (`loadSettings` parses `{}` through
 * `ScheduleConfig`, whose `courts` defaults to `[]` — every board before its
 * first settings PUT) falls back to the org's own courts here rather than
 * resolving to zero candidates and 422ing NO_MATCHING_COURT for an org that
 * has simply never configured anything yet. Deliberately in THIS function,
 * not at each of its three call sites (schedule.ts's build and validate
 * paths, schedule-ai.ts's buildSchedulePack) — the whole point of routing
 * everything through one resolver is that those callers cannot diverge on
 * what "no courts configured" means. The fallback set still goes through
 * `candidateCourts` exactly like an explicit list would: archived courts and
 * ones missing a required tag are excluded the same way, so `NO_MATCHING_COURT`
 * still fires when the org genuinely has no matching court (or none at all).
 */
export async function resolveCandidateCourts(
  tx: Tx,
  divisionId: string,
  configuredCourtIds: readonly string[],
  requiredTags: readonly string[],
): Promise<CandidateCourts> {
  const courts = await orgCourtMetas(tx);
  const effectiveConfigured =
    configuredCourtIds.length > 0 ? configuredCourtIds : courts.map((c) => c.id);
  const result = candidateCourts(effectiveConfigured, courts, requiredTags);
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
 * P9.5 (D5b.5): the court calendars `usableWindows` resolves, for the courts a
 * run actually has in play.
 *
 * The loader lives HERE, usecase-side, because the engine stays pure — it never
 * touches a DB — and because this module is already the one place the build,
 * validate and AI-pack paths agree about courts. A second loader at any of those
 * three call sites would be the same fork this file exists to prevent, one field
 * over: they would diverge on what "this court has no calendar" means.
 *
 * ABSENT MEANS UNRESTRICTED, and that distinction is load-bearing. A court with
 * no `court_hours` rows is simply omitted from the result, which `usableWindows`
 * reads as "open all day" — calendars strictly SUBTRACT (D5 normative step 1),
 * so a court nobody has given hours to must not become unschedulable. A court
 * that HAS hours but none for a given weekday is closed that weekday; that is a
 * declared calendar saying "not Tuesdays", and it is the engine's job to tell
 * the two apart, not this loader's.
 *
 * Scoped to `courtIds` rather than the whole org: unlike `orgCourtMetas` above,
 * which needs every court so an empty configured list can fall back to all of
 * them, this is only ever asked about a candidate set that has already been
 * resolved. `court_exceptions.date` comes back as `string | Date` depending on
 * the driver's type parsing, so it is normalised to a bare `YYYY-MM-DD` here —
 * the engine takes a `Ymd` and does no date parsing of its own.
 */
export async function resolveCourtCalendars(
  tx: Tx,
  courtIds: readonly string[],
): Promise<CourtCalendar[]> {
  if (courtIds.length === 0) return [];
  const ids = [...courtIds];
  const hours = await tx<{ court_id: string; weekday: number; open_min: number; close_min: number }[]>`
    select court_id, weekday, open_min, close_min from court_hours
    where court_id in ${tx(ids)}
    order by court_id, weekday, open_min`;
  const exceptions = await tx<
    {
      court_id: string;
      date: string | Date;
      closed: boolean;
      open_min: number | null;
      close_min: number | null;
    }[]
  >`
    select court_id, date, closed, open_min, close_min from court_exceptions
    where court_id in ${tx(ids)}
    order by court_id, date`;

  const byCourt = new Map<string, { hours: CourtCalendar["hours"]; exceptions: CourtCalendar["exceptions"] }>();
  const slot = (courtId: string) => {
    const existing = byCourt.get(courtId);
    if (existing !== undefined) return existing;
    const fresh = { hours: [] as CourtCalendar["hours"], exceptions: [] as CourtCalendar["exceptions"] };
    byCourt.set(courtId, fresh);
    return fresh;
  };
  for (const h of hours) {
    (slot(h.court_id).hours as { weekday: number; openMin: number; closeMin: number }[]).push({
      weekday: h.weekday,
      openMin: h.open_min,
      closeMin: h.close_min,
    });
  }
  for (const e of exceptions) {
    const date = typeof e.date === "string" ? e.date.slice(0, 10) : e.date.toISOString().slice(0, 10);
    (
      slot(e.court_id).exceptions as {
        date: string;
        closed: boolean;
        openMin?: number;
        closeMin?: number;
      }[]
    ).push({
      date,
      closed: e.closed,
      ...(e.open_min !== null ? { openMin: e.open_min } : {}),
      ...(e.close_min !== null ? { closeMin: e.close_min } : {}),
    });
  }
  // Order follows `courtIds` so the result is deterministic for a caller that
  // logs or snapshots it; a court with neither hours nor exceptions is omitted.
  return ids.flatMap((courtId) => {
    const found = byCourt.get(courtId);
    return found === undefined ? [] : [{ courtId, hours: found.hours, exceptions: found.exceptions }];
  });
}

/**
 * P9 pass 2c: TAG-only qualification, ignoring archived status entirely.
 * The verifier's `court_tag_mismatch` conflict (calendar.ts's
 * `validateAssignments`) needs to answer a narrower question than
 * `resolveCandidateCourts` above does — "does THIS court's own tag set
 * satisfy the requirement", not "is this court usable for a NEW placement"
 * (tags AND non-archived, ruling 3). Reusing the combined answer for the
 * conflict would retroactively red every existing assignment sitting on a
 * since-archived court, which ruling 3 forbids in as many words: "the court
 * is gone" is a stranded-fixture case P10 owns (needs `usableWindows`,
 * which does not exist yet), not this one.
 *
 * So this calls the SAME `candidateCourts` filter `resolveCandidateCourts`
 * calls, with every court's `archived` flag neutralised to `false` first —
 * the tag-superset loop runs completely unchanged; only the archived
 * predicate is defeated. Not a second copy of the tag rule: the same
 * function, different inputs. A second `orgCourtMetas` round trip (this
 * path is a read/report, never a hot loop) beats reshaping
 * `resolveCandidateCourts`'s own return value and disturbing its three
 * existing callers (autoSchedule, validateScheduleIn, schedule-ai.ts's
 * buildSchedulePack) for a question only ONE of them needs to ask.
 *
 * No `configuredCourtIds`/empty-means-unconstrained parameter, unlike
 * `resolveCandidateCourts`: this answers a per-COURT question over the
 * whole org, not "which of the organiser's configured ids survive" — every
 * org court is a candidate for "does it happen to carry the right tags",
 * whether or not it was ever added to a division's `config.courts`.
 */
export async function resolveTagQualifiedCourtIds(
  tx: Tx,
  requiredTags: readonly string[],
): Promise<ReadonlySet<string>> {
  const courts = await orgCourtMetas(tx);
  const tagOnly = courts.map((c) => ({ ...c, archived: false }));
  const result = candidateCourts(
    tagOnly.map((c) => c.id),
    tagOnly,
    requiredTags,
  );
  return new Set(result.ids);
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
/**
 * P9.5, edge matrix row 3: when NO candidate court can host anything for the
 * whole run, refuse with a typed error rather than hand the solver a zero-slot
 * lattice and let it come back "infeasible" with no reason an organiser can act
 * on. P9 set this precedent for the tag filter (`guardNoMatchingCourt` below);
 * opening hours are the same shape of "nothing can ever be placed here", so
 * they share its code — the row calls for "the `NO_MATCHING_COURT` family", and
 * a second code would need its own wire enum entry and four translations to say
 * a thing this one already says.
 *
 * Three deliberate non-firings, each of which would otherwise be a lock-out:
 *
 *   * NO TZ — court hours are day-shaped and there is no local midnight to
 *     resolve a weekday against, so the placer and the verifier both SKIP them.
 *     A guard that fired here would refuse a run neither side constrains.
 *   * A CANDIDATE WITH NO CALENDAR — absent means unrestricted (calendars
 *     strictly SUBTRACT), so one such court makes the run placeable on its own.
 *     This is the guard's most important negative case: firing here would make
 *     every org that has never opened the calendar editor unschedulable.
 *   * SOME DAYS DARK — a multi-day run whose Sunday is closed is not a
 *     zero-slot lattice; the event still runs on the other days. Only a range
 *     with no usable window ANYWHERE refuses.
 */
export function guardNoUsableCourtWindows(
  candidateCourtIds: readonly string[],
  courtCalendars: readonly CourtCalendar[],
  range: { readonly from: string; readonly to: string },
  config: {
    readonly tz?: string;
    readonly sessionWindows?: readonly { from: number; to: number }[];
    readonly blackouts?: readonly { court?: string; from: number; to: number }[];
  },
  context: { divisionId: string },
): void {
  const tz = config.tz;
  if (tz === undefined || courtCalendars.length === 0 || candidateCourtIds.length === 0) return;
  const byCourt = new Map(courtCalendars.map((c) => [c.courtId, c] as const));
  for (const courtId of candidateCourtIds) {
    const calendar = byCourt.get(courtId);
    if (calendar === undefined) return; // no calendar declared -> unrestricted
    const windows = usableWindows(calendar, range, {
      tz,
      sessionWindows: config.sessionWindows,
      blackouts: config.blackouts,
    });
    if (windows.length > 0) return;
  }
  log.info(
    { event: "schedule_no_usable_court_window", divisionId: context.divisionId, from: range.from, to: range.to },
    "schedule_no_usable_court_window",
  );
  throw new HttpError(
    422,
    "No configured court is open during this schedule's dates",
    NO_MATCHING_COURT_CODE,
    { candidateCount: 0, from: range.from, to: range.to },
  );
}

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

/**
 * The PER-FIXTURE sibling of `guardNoMatchingCourt` above (#622 review): that
 * guard only sees the STAGE-WIDE candidate set, so a round-scoped tag that
 * narrows a single fixture's own set to empty — the stage-wide set stays
 * non-empty, since other rounds still have candidates — sailed straight past
 * it and into the solver, which (`build.ts`'s `allowedCourtsFor`) degrades an
 * empty allowed set to "unconstrained" rather than inventing a solver-level
 * meaning for it. That degrade is the documented, deliberate behaviour for a
 * board the solver is merely REPORTING on; it is the wrong behaviour for a
 * fresh SOLVE, which is exactly what `guardNoMatchingCourt`'s own doc comment
 * says about calling it from `validateScheduleIn` — the same reasoning, one
 * scope narrower.
 *
 * A LOCKED fixture is exempt: an organiser's own pin outranks a tag rule
 * (ruling 3, this module's header) and is never filtered by `allowedCourts`
 * (`calendar.ts`'s own doc comment on the field) — the verifier reports it as
 * a non-blocking `court_tag_mismatch` instead of refusing a board that
 * already exists.
 */
export function guardNoMatchingCourtPerFixture(
  fixtures: readonly { id: string; locked?: unknown; allowedCourts?: readonly string[] }[],
  context: { requiredTags: readonly string[]; divisionId: string; [key: string]: unknown },
): void {
  const victim = fixtures.find(
    (f) => f.locked === undefined && f.allowedCourts !== undefined && f.allowedCourts.length === 0,
  );
  if (victim === undefined) return;
  throw new HttpError(
    422,
    "No configured court matches this fixture's round-scoped required tags",
    NO_MATCHING_COURT_CODE,
    { requiredTags: [...context.requiredTags], candidateCount: 0, fixtureId: victim.id },
  );
}

// ---------------------------------------------------------------------------
// #622 — PER-FIXTURE required court tags (division ∪ stage ∪ round role).
//
// Everything above resolves a candidate court set for a SCOPE. That was
// enough while the scopes were division and stage, because both the placer
// (`autoSchedule`, one stage per call) and the AI pack (`buildSchedulePack`,
// keyed by `stage_id`) could resolve once per scope and hand every fixture in
// it the same answer.
//
// Round-scoped tags break that: QF, SF and the final share ONE `stages` row,
// so a stage's fixtures no longer agree about what their candidate set is. The
// resolution unit is therefore the FIXTURE, and this section is the one place
// that computes it — a second copy at any of the three call sites is the
// placer/verifier fork this module's own header opens by warning about.
//
// WHY NOT A UNION, AND WHY NOT AN INTERSECTION. `candidateCourts` reads a
// required-tag list as AND: a qualifying court must carry EVERY tag in it. So
// flattening two rounds' different tags into one list demands a court carry
// the final's tags to host a quarter-final, and taking the union of the two
// resolved COURT sets instead lets a quarter-final court host the final. Both
// are wrong in a direction that produces a confidently invalid board, which is
// why the per-fixture answer is not an optimisation but the only correct one.
// `validateScheduleIn` shipped the court-set union deliberately as the closest
// safe approximation available before this existed (its own comment records
// it); #622 replaces it with the exact answer.
// ---------------------------------------------------------------------------

/** Exactly the fixture columns a role resolution reads — V368's four bracket
 *  position columns plus the round and the stage they are ranked within. */
interface RoleFixtureRow {
  id: string;
  stage_id: string;
  round_no: number;
  lane: "WB" | "LB" | "GF" | null;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
  ext_key: string | null;
}

/**
 * The effective required court tags for EVERY fixture in a division, keyed by
 * fixture id.
 *
 * THREE QUERIES, never one per fixture and never one per stage: the division's
 * fixtures, its stages, and its round rows. A division with 200 fixtures across
 * 6 stages costs the same three round trips as one with 6.
 *
 * A fixture whose effective tag list is empty is still present in the map,
 * with `[]` — "no requirement", which `candidateCourts` reads as "every court
 * qualifies". Absent from the map means the fixture is not in this division at
 * all, which is a different fact and one callers do check for.
 */
export async function requiredCourtTagsByFixture(
  tx: Tx,
  divisionId: string,
  divisionTags: readonly string[],
): Promise<Map<string, string[]>> {
  const [fixtures, stages, roundRows] = await Promise.all([
    tx<RoleFixtureRow[]>`
      select id, stage_id, round_no, lane, is_final, third_place, conditional, ext_key
      from fixtures where division_id = ${divisionId}`,
    tx<{ id: string; kind: string; required_court_tags: string[] }[]>`
      select id, kind, required_court_tags from stages where division_id = ${divisionId}`,
    tx<{ stage_id: string; round_role: string; required_court_tags: string[] }[]>`
      select r.stage_id, r.round_role, r.required_court_tags
      from stage_round_court_tags r
      join stages s on s.id = r.stage_id
      where s.division_id = ${divisionId}`,
  ]);

  const stageById = new Map(stages.map((s) => [s.id, s] as const));
  const roundTagsByStage = new Map<string, Map<string, string[]>>();
  for (const row of roundRows) {
    let perStage = roundTagsByStage.get(row.stage_id);
    if (perStage === undefined) {
      perStage = new Map();
      roundTagsByStage.set(row.stage_id, perStage);
    }
    perStage.set(row.round_role, row.required_court_tags);
  }

  // `laneRoundRank` (inside `roundRoleFor`) ranks a round within its own LANE,
  // across the fixtures it is given — so the list handed to it must be the
  // whole STAGE's fixtures and nothing else. The division's fixtures grouped
  // by stage, once, rather than a `filter` per fixture: the latter is O(n²)
  // and a 200-fixture division hits this on every validate.
  const fixturesByStage = new Map<string, RoleFixtureRow[]>();
  for (const f of fixtures) {
    const rows = fixturesByStage.get(f.stage_id);
    if (rows === undefined) fixturesByStage.set(f.stage_id, [f]);
    else rows.push(f);
  }

  const out = new Map<string, string[]>();
  for (const f of fixtures) {
    const stage = stageById.get(f.stage_id);
    const stageTags = stage?.required_court_tags ?? [];
    const perStageRounds = roundTagsByStage.get(f.stage_id);
    // No round rows for this stage at all — overwhelmingly the common case —
    // so the role never has to be computed. Not merely a fast path: it is
    // what keeps every existing board's resolution byte-identical to its
    // pre-#622 answer, since `roundRoleFor` is only reachable for a stage an
    // organiser has actually written a round rule against.
    if (perStageRounds === undefined || perStageRounds.size === 0) {
      out.set(f.id, unionRequiredCourtTags(divisionTags, stageTags));
      continue;
    }
    const role = roundRoleFor(
      fixturesByStage.get(f.stage_id) ?? [f],
      {
        round_no: f.round_no,
        lane: f.lane,
        is_final: f.is_final,
        third_place: f.third_place,
        conditional: f.conditional,
      },
      stage?.kind ?? "",
      f.ext_key,
    );
    out.set(
      f.id,
      unionRequiredCourtTags(divisionTags, stageTags, perStageRounds.get(roundRoleKey(role))),
    );
  }
  return out;
}

/** A tag list's memo key. Order-independent, and `\u0000`-joined so two lists
 *  cannot collide by concatenation (`["ab"]` vs `["a","b"]`). */
function tagKey(tags: readonly string[]): string {
  return [...tags].sort().join("\u0000");
}

/**
 * `candidateCourtsByFixture` and `tagQualifiedCourtIdsByFixture` below both
 * turn a fixture-id -> tag-list map into a fixture-id -> court-id-list map,
 * MEMOISED ON THE TAG UNION rather than called once per fixture —
 * `resolveCandidateCourts`/`resolveTagQualifiedCourtIds` each re-run the full
 * org court+venue join, and fixtures overwhelmingly share a handful of
 * distinct unions (usually one: the division's own tags), so a 200-fixture
 * division issues one or two `resolve` calls rather than 200. The two
 * exported functions differ only in which single-tag-list resolver they
 * memoise, so this is that memoisation written once rather than hand-copied
 * per resolver — the same duplication `validateScheduleIn` and
 * `buildSchedulePack` each already had to hand-roll per stage before either
 * existed.
 */
async function memoisedByTagUnion(
  tagsByFixture: ReadonlyMap<string, readonly string[]>,
  resolve: (tags: readonly string[]) => Promise<readonly string[]>,
): Promise<Map<string, readonly string[]>> {
  const byUnion = new Map<string, readonly string[]>();
  const out = new Map<string, readonly string[]>();
  for (const [fixtureId, tags] of tagsByFixture) {
    const key = tagKey(tags);
    let ids = byUnion.get(key);
    if (ids === undefined) {
      ids = await resolve(tags);
      byUnion.set(key, ids);
    }
    out.set(fixtureId, ids);
  }
  return out;
}

/** `requiredCourtTagsByFixture` resolved the rest of the way: fixture id -> the
 *  candidate court ids that fixture may be placed on. See `memoisedByTagUnion`
 *  just above for the memoisation this hands off to. */
export async function candidateCourtsByFixture(
  tx: Tx,
  divisionId: string,
  configuredCourtIds: readonly string[],
  tagsByFixture: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, readonly string[]>> {
  return memoisedByTagUnion(
    tagsByFixture,
    async (tags) => (await resolveCandidateCourts(tx, divisionId, configuredCourtIds, tags)).ids,
  );
}

/**
 * The VERIFIER's per-fixture view of the same constraint: fixture id -> the
 * courts whose OWN tags satisfy that fixture's requirement, archived-neutral.
 *
 * The per-fixture sibling of `resolveTagQualifiedCourtIds`, and it calls that
 * function rather than reimplementing it — see its doc comment for why the
 * verifier's question ("does this court's tag set satisfy the requirement")
 * must stay separate from the placer's ("may a NEW fixture be placed here"),
 * and why answering it with the placer's set would retroactively red every
 * board sitting on a since-archived court.
 *
 * Memoised on the tag union exactly as `candidateCourtsByFixture` is (see
 * `memoisedByTagUnion`, above), for the identical reason.
 */
export async function tagQualifiedCourtIdsByFixture(
  tx: Tx,
  tagsByFixture: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, readonly string[]>> {
  return memoisedByTagUnion(tagsByFixture, async (tags) => [
    ...(await resolveTagQualifiedCourtIds(tx, tags)),
  ]);
}
