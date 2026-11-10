import "server-only";
// #350 Multi-division joint AI scheduling — Phase A joint context pack.
//
// buildCompetitionPack unions several divisions of ONE competition into a
// single deterministic pack. It owns no SQL of its own beyond the competition
// lookup: every division's board is assembled by the existing
// buildSchedulePack in schedule-ai.ts, then merged here. That keeps one
// loader, one draft solver and one set of ordering invariants.
//
// Determinism is contractual (see schedule-ai.ts:1-12 — a golden snapshot binds
// two builds of an identically-seeded board to be byte-identical). Every array
// here sorts on stable DOMAIN keys; where a joint sort needs a division
// discriminator it uses the division's NAME and SLUG, never the per-seed UUID.
// Slug matters as more than a tie-break: division order decides the sequential
// draft below, so it decides pack CONTENT, and `createDivision` enforces a
// unique slug but not a unique name.
//
// The three things a joint pack must get right that a per-division pack cannot:
//   * the run's own divisions must not be served to each other as immovable
//     obstacles. buildSchedulePack flattens every sibling division to the
//     anonymous OTHER_DIVISION_LABEL, so they are excluded at the source
//     (`excludeDivisionIds`) rather than filtered out afterwards — a slot-key
//     filter cannot tell "division B's fixture re-served to me" from "excluded
//     division C happens to sit on the same court at the same instant", and
//     deleting the second is deleting a hard constraint with no trace.
//   * courts are matched across divisions by simple string equality — safe
//     since P9: `PackSettings.courts` has carried each division's real,
//     org-wide-unique `courts.id` values since pass 1 (never an
//     organiser-typed label two DIFFERENT physical courts could collide on),
//     so an equal string now IS the same court. The pack names the ids that
//     do not appear in every selected division (`divergentCourts`) for the
//     board to warn on.
//   * the shared-player map is rebuilt over the whole run. A per-division map
//     keeps only persons in >= 2 of ITS OWN entrants, so someone in one entrant
//     of A and one of B is in neither — invisible to a union of the two. H4
//     points the model at that map, so leaving the gap would ask it to avoid a
//     clash it was never shown.
//
// THE DRAFT IS A LEGALITY HINT, NOT A BALANCE HINT. Divisions are drafted in
// sequence, each seeing what the ones before it took, which makes the joint
// draft free of cross-division court clashes but maximally UNBALANCED by
// construction: the first division gets every prime slot and the last gets
// whatever is left (and on a board that does not fit, nothing at all — hence
// `draftPlaced`). That trade is deliberate. Legal-but-unbalanced beats
// balanced-but-clashing for something that is only a starting point, and
// chunked interleaving would put the determinism contract at risk for a hint.
// Fair prime-slot distribution across divisions (the plan's rule J4) is the
// MODEL's job, and JOINT_RULES tells it to rebalance rather than anchor on what
// it was handed.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  FIXED_OCCUPYING,
  MOVABLE_STATUS,
  OCCUPYING,
  movableFixtureSql,
  peopleByEntrant,
  type RoundFields,
} from "../schedule";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { resolvePersonScopes } from "../engine-constraints";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import {
  OTHER_DIVISION_LABEL,
  buildSchedulePack,
  personKeyResolver,
  zonedIso,
  DEFAULT_SESSION_HOURS,
  type PackCourtInfo,
  type PackPerson,
  type PackSettings,
  type SchedulePack,
} from "../schedule-ai";
import { resolveParsed, type RawParsed, type ResolvedParse } from "../schedule-ai-parse";
import { computeParticipants, type Assignment } from "@seazn/engine/scheduling";
import { MS_PER_MIN, cmp, ms } from "./helpers";
import type {
  CompetitionPack,
  CompetitionPackAssignment,
  CompetitionPackDivision,
  CompetitionPackDraftAssignment,
  CompetitionPackFixture,
  CompetitionPackObstacle,
} from "./types";

/** Total movable fixtures across the whole joint pack. Over this the run is
 *  refused before any credit is reserved — the per-division builder keeps its
 *  own 500 cap in schedule-ai.ts, this one is on the SUM. */
export const COMPETITION_MOVABLE_CAP = 500;

const TOO_LARGE = "AI_PLAN_TOO_LARGE";
/** The per-division builder's "nothing in scope" refusal. Never surfaced to a
 *  joint caller — see the build loop's catch. */
const EMPTY_SCOPE = "AI_PLAN_EMPTY_SCOPE";
/** What it becomes instead: a retryable 409, because the only way to reach it
 *  from a joint call is a concurrent change between the gate and the build. */
const SCOPE_CHANGED = "AI_PLAN_SCOPE_CHANGED";

/** One too-large contract for the whole joint call. The per-division builder
 *  refuses >500 with a 422 carrying this same code string, and a joint caller
 *  must never have to tell the two apart. In practice the pre-check subsumes
 *  the per-division case entirely — see the catch in the build loop, which is
 *  a backstop, not live logic. The per-division 422 is left alone for the
 *  per-division callers. */
const tooLarge = (): HttpError =>
  new HttpError(409, "too large — schedule per division", TOO_LARGE);

/** A sub-pack's settings with every person scope moved into the RUN's identity
 *  namespace (#450). Returned by reference when there is nothing to resolve, so
 *  a settings block with no durable rules is byte-identical to what the
 *  sub-pack produced — the joint pack's determinism test compares
 *  `JSON.stringify`, and a rebuilt object is a chance to reorder keys. */
function withResolvedPersonScopes(
  s: PackSettings,
  keyOf: (personId: string) => string,
): PackSettings {
  if (s.constraints === null || s.constraints.hard === undefined) return s;
  return {
    ...s,
    constraints: { ...s.constraints, hard: resolvePersonScopes(s.constraints.hard, keyOf) },
  };
}

/**
 * The shape `personKeyResolver` (schedule-ai.ts) renders a same-name grouping in.
 *
 * Every source pack ran that resolver over ITS OWN division's persons, so it
 * raised an assumption for any pair that was already same-named inside one
 * division. The joint resolver below runs over the whole run's person set, so
 * its buckets are supersets of theirs and its message is the accurate one ("3
 * person records", not two divisions each claiming two). Carrying both would
 * hand the organiser two contradictory counts for one human, so the
 * per-division ones are dropped here and identity is reported once, jointly.
 *
 * If the resolver's wording ever drifts from this pattern the only symptom is a
 * duplicated identity line — the joint pack's participants are unaffected. The
 * "one identity assumption for a within-division pair" test pins it.
 */
const IDENTITY_ASSUMPTION =
  /^'.*' matches \d+ person records by name — treated as one player for scheduling only; no records were merged$/;

export interface BuildCompetitionPackOptions {
  mode: "generate" | "refine" | "repair";
  instruction: string;
  /** The instant this run is happening, epoch ms. REQUIRED and always injected
   *  (#397): forwarded verbatim to every per-division `buildSchedulePack`, so
   *  the divisions of one run cannot disagree about what "today" is. */
  now: number;
  /** Stage-1 output (#398), or null. Resolved here rather than inside each
   *  per-division sub-pack: one run is one reading of "till Friday", and the
   *  feasibility bump must see the JOINT fixture count or it would extend a
   *  window per division on partial counts. */
  raw?: RawParsed | null;
  /** A compile was attempted and produced nothing — distinct from `raw: null`,
   *  which also covers "no instruction given". See BuildPackOptions in
   *  schedule-ai.ts. */
  parseFailed?: boolean;
  /** W5 (#400): the stored resolution of a confirmed preview, which wins over
   *  `raw`. The joint twin of {@link BuildPackOptions.resolved} — and it is
   *  deliberately NOT forwarded to the per-division sub-packs, which resolve
   *  nothing (only the joint resolve below reads it). */
  resolved?: ResolvedParse | null;
  prior?: { instruction: string; assignments: CompetitionPackAssignment[] };
}

/**
 * Build the joint Phase A context pack for several divisions of one competition.
 *
 * @returns the pack plus the union of every division's movable fixture ids —
 *   the set the joint verifier rejects out-of-set assignments against.
 *
 * Throws 404 (unknown competition, or a division that is not in it) and
 * 409 AI_PLAN_TOO_LARGE when the run is too big — the summed movable count
 * exceeding {@link COMPETITION_MOVABLE_CAP}, which subsumes a single division
 * being over the per-division cap, so a joint call has exactly one too-large
 * contract and one status. The minimum-two-divisions rule is a caller gate (it
 * exists to stop discount arbitrage, not to protect the pack), so it is
 * enforced by aiPlanForCompetition, not here.
 */
export async function buildCompetitionPack(
  auth: AuthCtx,
  competitionId: string,
  divisionIds: string[],
  opts: BuildCompetitionPackOptions,
): Promise<{
  pack: CompetitionPack;
  movableIds: Set<string>;
  /** P9 pass 3d — the joint twin of `BuildPackOptions`' return (schedule-
   *  ai.ts). Merged from every division's own `buildSchedulePack` call:
   *  each already queries the WHOLE org's courts, so the maps are identical
   *  in practice, but merging (rather than taking `built[0]`) costs nothing
   *  and does not assume that. */
  courtDirectory: Record<string, PackCourtInfo>;
}> {
  const requested = [...new Set(divisionIds)];
  if (requested.length === 0) {
    throw new HttpError(400, "no divisions selected", "AI_PLAN_NO_DIVISIONS");
  }

  const {
    competition,
    divisionRows,
    movableCount,
    fixedRows,
    entrantPeople,
    personNameById,
  } = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; name: string }[]>`
      select id, name from competitions where id = ${competitionId}`;
    if (!row) throw new HttpError(404, "competition not found");
    const divisionRows = await tx<{ id: string; name: string; slug: string }[]>`
      select id, name, slug from divisions
      where competition_id = ${competitionId} and id in ${tx(requested)}`;
    // Cheap cap pre-check: without it 20 divisions × 500 fixtures are greedily
    // solved before the refusal. This counts UN-SCOPED movable fixtures, which
    // is exact for every mode this builder uses (it never passes a repair
    // `scope`); the post-union check below stays the authoritative one.
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures f
      where f.division_id in ${tx(requested)} and ${movableFixtureSql(tx)}`;
    // The run's own FIXED board — court-holding fixtures that this run is not
    // re-placing. Excluding the run from the sibling sweep (so obstacle
    // attribution is sound) also took these out of every division's greedy
    // view, and feeding each built division's obstacles forward only closes the
    // gap one way: the division built FIRST would still never see a later one's
    // immovable fixtures and could draft on top of them.
    //
    // Loaded ONCE here, in the pre-pass that already runs, and handed to every
    // division — so the compensation is symmetric. Movable fixtures are
    // deliberately excluded: their current placements are exactly what is being
    // re-planned, and constraining against them would pin the schedule to where
    // it already is.
    // P9 pass 3b: `court_id`, not the legacy `court_label` — the latter is
    // frozen and null on every fixture scheduled since the cutover, which
    // silently dropped every real fixed placement from the run's own
    // "already occupying a court" set (every OTHER division's greedy draft
    // would then double-book straight through it).
    const fixedRows = await tx<
      {
        id: string;
        division_id: string;
        scheduled_at: string | Date;
        court_id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        round_no: number;
        seq_in_round: number;
        ext_key: string | null;
        config: unknown;
      }[]
    >`
      select f.id, f.division_id, f.scheduled_at, f.court_id,
             f.home_entrant_id, f.away_entrant_id, f.round_no, f.seq_in_round, f.ext_key,
             s.config
      from fixtures f
      left join schedule_settings s on s.division_id = f.division_id
      where f.division_id in ${tx(requested)}
        and (f.status in ${tx(FIXED_OCCUPYING)}
             -- A scheduled fixture that holds a result is fixed too: no
             -- builder may move it (isMovable, schedule.ts).
             or (f.status = ${MOVABLE_STATUS} and ${fixtureHasResultSql(tx)}))
        and f.scheduled_at is not null
        and f.court_id is not null`;
    // …and the run's PEOPLE, entrant by entrant, over every entrant named on any
    // of its fixtures.
    //
    // Two consumers, one map, loaded once here because both need it before the
    // per-division build loop starts:
    //
    //  * `fixedOccupancy` below. `slotFixtures` rejects any placement
    //    overlapping someone already committed in `existing` — unconditionally
    //    now, not only under `crossPersonClash: "hard"`, because the write gate
    //    refuses an introduced person overlap whatever that setting says. So an
    //    empty people list silently disables that block and lets a draft
    //    double-book a person against a fixture nobody can move, which the
    //    organiser then cannot apply.
    //  * the #396 identity guard and participant recursion. Deliberately the
    //    FULL entrant→persons map and not the pack's `people` display list: that
    //    one keeps only persons rostered into 2+ entrants, which is exactly the
    //    person a TBD slot inherits by recursion and nobody else.
    const entrantRows = await tx<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select distinct home_entrant_id, away_entrant_id from fixtures
      where division_id in ${tx(requested)} and status in ${tx(OCCUPYING)}`;
    const entrantPeople = await peopleByEntrant(
      tx,
      [...new Set(entrantRows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]))].filter(
        (e): e is string => e !== null,
      ),
    );
    // Person NAMES for the same-name guard. Names never leave this function —
    // they resolve identity and render assumptions, and are never written back.
    const personIdsInPlay = [...new Set([...entrantPeople.values()].flat())];
    const personNameById = new Map<string, string>();
    if (personIdsInPlay.length > 0) {
      const nameRows = await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where id in ${tx(personIdsInPlay)}`;
      for (const r of nameRows) personNameById.set(r.id, r.full_name);
    }
    return {
      competition: row,
      divisionRows,
      movableCount: count?.n ?? 0,
      fixedRows,
      entrantPeople,
      personNameById,
    };
  });

  const nameById = new Map(divisionRows.map((d) => [d.id, d.name]));
  const slugById = new Map(divisionRows.map((d) => [d.id, d.slug]));
  for (const id of requested) {
    if (!nameById.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
  }
  if (movableCount > COMPETITION_MOVABLE_CAP) throw tooLarge();

  // Build (and therefore emit) in a stable DOMAIN order: name, then SLUG. Slug
  // is not a cosmetic tie-break — the sequential draft below means this order
  // decides every later division's greedy result, so a UUID tie-break would
  // make two identically-seeded boards with same-named divisions produce
  // different packs. `createDivision` enforces a unique slug, not a unique name.
  const order = [...requested].sort(
    (a, b) => cmp(nameById.get(a)!, nameById.get(b)!) || cmp(slugById.get(a)!, slugById.get(b)!),
  );

  // Division discriminator for every joint sort: name (human-meaningful
  // grouping) then slug (unique and stable). Never the UUID.
  const byDivision = (a: string, b: string): number =>
    cmp(nameById.get(a) ?? "", nameById.get(b) ?? "") ||
    cmp(slugById.get(a) ?? "", slugById.get(b) ?? "");

  // -------------------------------------------------------------------------
  // #396 identity, resolved ONCE over the whole run, before anything reads a
  // person id.
  //
  // This is the case the per-division resolver structurally cannot see: one
  // human entered in two DIFFERENT divisions of the same competition under two
  // separate `persons` rows. Inside either division each row stands alone, so
  // neither pack collapses anything; only the joint person set has both. The
  // resolver itself is IMPORTED from schedule-ai.ts rather than reimplemented —
  // a second notion of "same person" here would diverge silently, and the
  // synthetic `name:<normalised>` key has to be byte-identical on both sides or
  // it groups nothing.
  //
  // Over-constrain the schedule, never the database: the key never leaves the
  // server (`toJointModelPayload` strips `participants`), nothing writes it, and
  // no `persons` row is touched.
  const identity = personKeyResolver(personNameById);
  const guardedPeople = new Map<string, string[]>(
    [...entrantPeople].map(([entrantId, ids]) => [entrantId, [...new Set(ids.map(identity.keyOf))]]),
  );
  // A synthetic key has no row in `personNameById`, so it would otherwise sort
  // under the empty name; sort it on the normalised name it carries. Person ids
  // are per-seed UUIDs and the joint pack's byte-identical test redacts UUIDs to
  // FIRST-SEEN placeholders, so a UUID-ordered array breaks it.
  const personSortKey = (p: string): string =>
    p.startsWith("name:") ? `${p.slice(5)}|${p}` : `${personNameById.get(p) ?? ""}|${p}`;

  // The run's fixed board as engine assignments — every division gets all of it
  // (minus its own, which buildSchedulePack already supplies internally), so the
  // compensation is symmetric rather than one-directional. Sorted on stable
  // domain keys like everything else here; the byte-identical test is the guard.
  const fixedMinutes = new Map<string, number>();
  for (const r of fixedRows) {
    if (!fixedMinutes.has(r.division_id)) {
      fixedMinutes.set(r.division_id, ScheduleConfig.parse(r.config ?? {}).matchMinutes);
    }
  }
  const fixedOccupancy: Assignment[] = [...fixedRows]
    .sort(
      (a, b) =>
        byDivision(a.division_id, b.division_id) ||
        a.round_no - b.round_no ||
        a.seq_in_round - b.seq_in_round ||
        cmp(a.ext_key ?? "", b.ext_key ?? ""),
    )
    .map((r) => {
      const startAt = new Date(r.scheduled_at).getTime();
      return {
        fixtureId: r.id,
        court: r.court_id,
        startAt,
        endAt: startAt + (fixedMinutes.get(r.division_id) ?? 0) * MS_PER_MIN,
        entrants: [r.home_entrant_id, r.away_entrant_id].filter((e): e is string => e !== null),
        // Unlike the drafts below, these rows come from this module's own SQL,
        // so the person data IS available — and it is load-bearing: it is what
        // makes `slotFixtures` reject a draft that would commit someone already
        // playing in another division's fixed fixture. No longer conditional on
        // `crossPersonClash`: the placer avoids what the write gate blocks.
        //
        // BOTH the raw id and its guarded key, deliberately. This list is handed
        // to a per-division greedy pass whose own fixtures carry that division's
        // OWN person keys, and a division that collapsed nothing internally
        // compares raw ids. Emitting only the guarded key would make a raw id on
        // the other side stop matching — silently DELETING a constraint that
        // exists today rather than adding one. Emitting both can only ever add.
        // (These assignments are placer input only: the joint verifier rebuilds
        // obstacles through `toJointObstacleAssignments`, so this cannot double
        // a conflict report.)
        //
        // No `poolId` (#446). This list is PLACER input: `slotFixtures` reads
        // `existing` for court, times, entrants and people and never for a
        // group id — it resolves `restByGroup`/`startWindows` off the
        // `SchedulableFixture` being placed. `divisionId` below predates that
        // read and is kept for the draft-accumulation bookkeeping; adding a
        // pool would mean widening this module's SQL for a field nothing reads.
        people: [
          ...new Set(
            [
              ...(r.home_entrant_id !== null ? entrantPeople.get(r.home_entrant_id) ?? [] : []),
              ...(r.away_entrant_id !== null ? entrantPeople.get(r.away_entrant_id) ?? [] : []),
            ].flatMap((p) => [p, identity.keyOf(p)]),
          ),
        ],
        divisionId: r.division_id,
      };
    });

  // Sequential accumulation. Each division's greedy draft sees the run's whole
  // fixed board plus the slots the divisions BEFORE it drafted, so the joint
  // draft is free of cross-division court clashes rather than N
  // independently-legal boards stacked on top of each other. See the module
  // header on why this is a legality hint only.
  const built: {
    id: string;
    pack: SchedulePack;
    movableIds: Set<string>;
    courtDirectory: Record<string, PackCourtInfo>;
  }[] = [];
  const drafted: Assignment[] = [];
  /** #396 participants, accumulated division by division as each one is built —
   *  the feed-forward below needs the division's map before the next division
   *  drafts, so it cannot wait for the union. Serialised into the pack in the
   *  joint movable order further down. */
  const participantsByFixture = new Map<string, string[]>();
  for (const id of order) {
    const prior = opts.prior
      ? {
          instruction: opts.prior.instruction,
          assignments: opts.prior.assignments
            .filter((a) => a.division_id === id)
            .map((a) => ({
              fixture_id: a.fixture_id,
              scheduled_at: a.scheduled_at,
              court_label: a.court_label,
            })),
        }
      : undefined;
    let one: { pack: SchedulePack; movableIds: Set<string>; courtDirectory: Record<string, PackCourtInfo> };
    try {
      one = await buildSchedulePack(auth, id, {
        mode: opts.mode,
        instruction: opts.instruction,
        // ONE clock across the whole run (#397): the same injected instant
        // reaches every division, so their windows and "today" agree.
        now: opts.now,
        ...(prior !== undefined ? { prior } : {}),
        // This division's own fixed fixtures arrive internally as
        // obstacleAssignments, so only the rest of the run's are added here.
        extraExisting: [...fixedOccupancy.filter((a) => a.divisionId !== id), ...drafted],
        // The rest of the run is not fixed court occupancy — it is being
        // re-planned in this same pass. Excluding it here is what makes every
        // surviving OTHER_DIVISION_LABEL obstacle provably from outside the run.
        excludeDivisionIds: order,
      });
    } catch (err) {
      // UNREACHABLE BY CONSTRUCTION — kept as a backstop, not live logic.
      //
      // The per-division builder refuses >500 movable with a 422 carrying this
      // same code, and inside a joint call that must read as the joint 409. But
      // the pre-check above always fires first: it counts `movableFixtureSql`
      // (scheduled, holding no result) over exactly these divisions, and a
      // division's own `movable` is a subset of that count (the same
      // predicate — the pack filters by `isMovable`, its twin — the same
      // divisions, and this builder never passes a repair `scope`). So
      // `movable.length > 500` implies `movableCount > 500`, and the pre-check
      // has already thrown. Delete the pre-check and this becomes live again —
      // which is what makes it worth keeping. It is also only unreachable
      // WITHIN ONE SNAPSHOT: the pre-check and buildSchedulePack read in
      // different transactions, so fixtures inserted between them can push a
      // division over 500 after the pre-check has passed — a second reason to
      // keep the backstop, not a reason to trust the pre-check less.
      if (err instanceof HttpError && (err.code === TOO_LARGE || err.message === TOO_LARGE)) {
        throw tooLarge();
      }
      // The OTHER per-division refusal that must never reach a joint caller
      // (ruling R6): in `repair` mode buildSchedulePack 422s AI_PLAN_EMPTY_SCOPE
      // when a division has nothing movable. The orchestrator drops such
      // divisions before ever getting here — but its gate query and this build
      // run in different transactions, so a concurrent unschedule/finalize can
      // empty a division in between. That is a transient race, not a request
      // defect: re-running picks up the new state and drops the division. So it
      // becomes a retryable 409 rather than a per-division 422 the joint caller
      // has no way to act on. Before any credit is reserved either way.
      if (err instanceof HttpError && (err.code === EMPTY_SCOPE || err.message === EMPTY_SCOPE)) {
        throw new HttpError(
          409,
          "a division's schedule changed while planning — please retry",
          SCOPE_CHANGED,
        );
      }
      throw err;
    }
    built.push({ id, pack: one.pack, movableIds: one.movableIds, courtDirectory: one.courtDirectory });

    // #396: who could stand in each of this division's fixtures — the advancers
    // behind a null slot included — resolved against the WHOLE run's identity
    // and its whole entrant→persons map, not the division's own.
    //
    // `pack.fixtures.movable` already carries the bye-stripped `feeds.after`
    // (schedule-ai.ts strips them and records the assumption), so the recursion
    // never walks into a feeder the model cannot see. Feeds are within-division,
    // so computing per division is the same answer as computing over the union.
    for (const [fixtureId, ids] of Object.entries(
      computeParticipants(one.pack.fixtures.movable, guardedPeople, { sortKey: personSortKey }),
    )) {
      participantsByFixture.set(fixtureId, ids);
    }

    // Feed the slots this division just drafted forward to the next ones. Its
    // fixed fixtures are already in `fixedOccupancy`, which every division sees.
    //
    // entrants ride along because they are free (they are on the fixture),
    // though they can never clash across divisions — an entrant belongs to
    // exactly one division. `people` is the participants map: it used to be
    // empty, because a per-division pack's `people` keeps only persons in 2+ of
    // ITS OWN entrants and so could not supply cross-division person data even
    // in principle. The joint participants map can — it is built above from the
    // run's full entrant→persons map — so the greedy draft now refuses to
    // double-book a human across two divisions, including into a TBD bracket
    // slot they can still advance to.
    //
    // RESIDUAL, by design: a division's OWN greedy pass still keys its own
    // fixtures on that division's person ids (buildSchedulePack owns that), so a
    // cross-division SAME-NAME pair is collapsed for the pack and the verifier
    // but not inside one division's placement search. The draft is a legality
    // hint; the verifier is the verdict, and it sees the collapse.
    const minutes = one.pack.settings.matchMinutes;
    const fixtureById = new Map(one.pack.fixtures.movable.map((f) => [f.id, f]));
    for (const a of one.pack.draft) {
      // #397: an unplaced draft row carries no time. It takes no court slot, so
      // it contributes nothing to the feed-forward occupancy the next division
      // sees — skipping it is the honest reading, not a dropped constraint.
      if (a.scheduled_at === null) continue;
      const startAt = ms(a.scheduled_at);
      const f = fixtureById.get(a.fixture_id);
      drafted.push({
        fixtureId: a.fixture_id,
        court: a.court_label,
        startAt,
        endAt: startAt + minutes * MS_PER_MIN,
        entrants: [f?.home ?? null, f?.away ?? null].filter((e): e is string => e !== null),
        // BOTH keyings, exactly as `fixedOccupancy` above emits raw AND guarded,
        // and for the same reason: a later division's greedy pass keys its own
        // fixtures on ITS OWN person map, which is raw wherever that division
        // collapsed nothing internally. Handing on only the run-wide key makes
        // a raw id on the other side stop matching — deleting a constraint that
        // fired before #396 instead of adding one.
        //
        // Not `flatMap(p => [p, identity.keyOf(p)])` here: these ids are ALREADY
        // run-guarded, so `keyOf` is the identity on them and the raw ids are
        // unrecoverable from this list. The division's own `pack.participants`
        // is where they survive, so the two maps are unioned. Both describe the
        // same humans in different keyings, so the union can only ever add.
        people: [
          ...new Set([
            ...(one.pack.participants[a.fixture_id] ?? []),
            ...(participantsByFixture.get(a.fixture_id) ?? []),
          ]),
        ],
      });
    }
  }

  // The joint cap is on the SUM and is checked after the union — the caller
  // reserves credit only once this has passed.
  const movableIds = new Set(built.flatMap((b) => [...b.movableIds]));
  if (movableIds.size > COMPETITION_MOVABLE_CAP) throw tooLarge();

  const divisions: CompetitionPackDivision[] = built.map((b) => ({
    id: b.pack.division.id,
    name: b.pack.division.name,
    sport: b.pack.division.sport,
    tz: b.pack.division.tz,
    // #450: re-resolved through the RUN-WIDE identity, not left as the sub-pack
    // produced it. `buildSchedulePack` already collapsed each division's rules
    // with that division's own resolver, but the case this module exists for is
    // the one a per-division resolver structurally cannot see: one human under
    // two `persons` rows in two DIFFERENT divisions. The joint verifier compares
    // these rules against `participants`, which ARE run-guarded (built from
    // `guardedPeople` above), so a rule left holding a raw uuid binds nothing on
    // exactly the boards this path was built for.
    //
    // Safe to apply twice: `keyOf` is a lookup on raw person ids, so a
    // `name:<normalised>` key the sub-pack already produced is not in the map
    // and passes through untouched.
    settings: withResolvedPersonScopes(b.pack.settings, identity.keyOf),
    movableIds: b.pack.fixtures.movable.map((f) => f.id),
    // PLACED, not present: since #397 a draft row can carry `scheduled_at:
    // null` (an epoch sentinel the pack refused to pass off as a time), and
    // counting it would report a division as fully drafted when nothing on it
    // has a slot — the exact opposite of what J5 tells the model to do.
    draftPlaced: b.pack.draft.filter((a) => a.scheduled_at !== null).length,
  }));

  // The calendar anchor (#397). Taken FROM the sub-packs rather than recomputed,
  // so the single-division and joint builders cannot drift: every division of
  // one competition sits in one organisation, and each was handed the same
  // injected `now`, so their `tz` and `clock` are identical by construction.
  //
  // The window is the UNION of the per-division windows — widest start, widest
  // end. A run is one set of days; taking the intersection would ask a division
  // that legitimately starts later to fit inside another division's day.
  const orgTz = built[0]!.pack.tz;
  const clock = built[0]!.pack.clock;
  const window: { start: string; end: string } = {
    start: built.reduce(
      (acc, b) => (Date.parse(b.pack.window.start) < Date.parse(acc) ? b.pack.window.start : acc),
      built[0]!.pack.window.start,
    ),
    end: built.reduce(
      (acc, b) => (Date.parse(b.pack.window.end) > Date.parse(acc) ? b.pack.window.end : acc),
      built[0]!.pack.window.end,
    ),
  };

  // Courts: `b.pack.settings.courts` is each division's OWN already-filtered
  // candidate set (buildSchedulePack's own resolveCandidateCourts call), so
  // an id equal across divisions IS the same physical court.
  const courtSets = built.map((b) => new Set(b.pack.settings.courts));
  // P9: court ids are UUIDs minted per org, so sorting them lexicographically
  // orders the list differently for two identically-seeded competitions — the
  // same defect `byDivision` above already calls out ("Never the UUID"). Order
  // by FIRST APPEARANCE across divisions instead: `built` is already in
  // division name/slug order and each division's `settings.courts` is its own
  // organiser-authored candidate order, so this is structural and reproduces
  // across seeds.
  const courtOrder = new Map<string, number>();
  for (const b of built) {
    for (const id of b.pack.settings.courts) {
      if (!courtOrder.has(id)) courtOrder.set(id, courtOrder.size);
    }
  }
  const courtRank = (id: string | null): number =>
    id === null ? Number.MAX_SAFE_INTEGER : (courtOrder.get(id) ?? Number.MAX_SAFE_INTEGER - 1);
  const courts = [...new Set(built.flatMap((b) => b.pack.settings.courts))].sort(
    (a, b) => courtRank(a) - courtRank(b),
  );
  const divergentCourts = courts.filter((c) => !courtSets.every((s) => s.has(c)));

  // P9 pass 3d: merge every division's own courtDirectory (id -> {label,
  // venue, tags}) into one joint map — each already queried the WHOLE org's
  // courts (schedule-ai.ts's buildSchedulePack), so in practice these are
  // identical, but a plain merge costs nothing and does not lean on that.
  const courtDirectory: Record<string, PackCourtInfo> = Object.assign(
    {},
    ...built.map((b) => b.courtDirectory),
  );

  const movable: CompetitionPackFixture[] = built
    .flatMap((b) => b.pack.fixtures.movable.map((f) => ({ ...f, division_id: b.id })))
    .sort(
      (a, b) =>
        byDivision(a.division_id, b.division_id) ||
        a.round - b.round ||
        a.seq - b.seq ||
        cmp(a.ext_key ?? "", b.ext_key ?? "") ||
        cmp(a.home ?? "", b.home ?? "") ||
        cmp(a.away ?? "", b.away ?? ""),
    );

  // Keys inserted in the pack's OWN movable order, so `participants` and
  // `fixtures.movable` agree and the object's serialised key order is a domain
  // order rather than a per-seed one (the byte-identical test compares
  // `JSON.stringify`, where key insertion order is load-bearing).
  const participants: Record<string, string[]> = {};
  for (const f of movable) participants[f.id] = participantsByFixture.get(f.id) ?? [];

  // #449: the pool UUID per movable fixture, unioned from the source packs (each
  // built its own map off `fixtures.pool_id`). Same insertion order as
  // `participants`, and for the same byte-identical reason.
  const poolIdBySourceFixture = new Map(
    built.flatMap((b) => Object.entries(b.pack.poolIds)),
  );
  const poolIds: Record<string, string> = {};
  for (const f of movable) {
    const id = poolIdBySourceFixture.get(f.id);
    if (id !== undefined) poolIds[f.id] = id;
  }

  // C1 gap B: the joint twins of `poolIds` just above, unioned the same way.
  // `stageIds` is total (each source pack's own map is total over ITS
  // movable set, since `fixtures.stage_id` is NOT NULL). `roundNos` stays
  // PARTIAL — each source pack already gated its own entries on that
  // division's own `roundRobinStageIds` (`buildSchedulePack`'s hoisted
  // `roundRobin`), so unioning the already-gated maps preserves the gate
  // rather than re-deriving (and potentially un-gating) it here.
  const stageIdBySourceFixture = new Map(
    built.flatMap((b) => Object.entries(b.pack.stageIds)),
  );
  const roundNoBySourceFixture = new Map(
    built.flatMap((b) => Object.entries(b.pack.roundNos)),
  );
  const roundRulesBySourceFixture = new Map(
    built.flatMap((b) => Object.entries(b.pack.roundRules ?? {})),
  );
  const stageIds: Record<string, string> = {};
  const roundNos: Record<string, number> = {};
  const roundRules: Record<string, RoundFields> = {};
  for (const f of movable) {
    const stageId = stageIdBySourceFixture.get(f.id);
    if (stageId !== undefined) stageIds[f.id] = stageId;
    const roundNo = roundNoBySourceFixture.get(f.id);
    if (roundNo !== undefined) roundNos[f.id] = roundNo;
    const rules = roundRulesBySourceFixture.get(f.id);
    if (rules !== undefined) roundRules[f.id] = rules;
  }

  // Bye-strip assumptions come from the source packs, in the emitted division
  // order. Identity is reported once, jointly — see IDENTITY_ASSUMPTION.
  const assumptions = [
    ...built.flatMap((b) => b.pack.assumptions).filter((a) => !IDENTITY_ASSUMPTION.test(a)),
    ...identity.assumptions,
  ];

  // #398: the compiled instruction, resolved once for the whole run against the
  // joint movable count. A window the organiser stated in words REPLACES the
  // union above — the union is the right default for windows we inferred, but
  // it would quietly widen the one window they actually asked for.
  const resolved =
    opts.resolved ??
    resolveParsed(opts.raw ?? null, clock, orgTz, {
      fixtureCount: movable.length,
      // Tells "no instruction" apart from "an instruction we could not read" —
      // the joint path needs it as much as the single-division one, or a whole
      // competition is scheduled ignoring a brief nobody is told was dropped.
      parseFailed: opts.parseFailed === true,
      // P9 pass 3d: name -> id over the JOINT candidate set (`courts`, the
      // union just above) — the single-division twin of this call
      // (schedule-ai.ts) narrows to one division's candidates for the same
      // reason: an instruction naming a court excluded from every selected
      // division must defer, not compile against a court `pack.courts`
      // does not carry.
      courts: new Map(courts.map((id) => [courtDirectory[id]?.label ?? id, id] as const)),
    });
  if (resolved.windowMs !== null) {
    window.start = zonedIso(resolved.windowMs.from, orgTz);
    window.end = zonedIso(resolved.windowMs.to, orgTz);
  }
  assumptions.push(...resolved.assumptions);

  // -------------------------------------------------------------------------
  // Obstacles.
  //
  // Each source pack's obstacle list is now (its own fixed fixtures, labelled
  // with the division) + (only the divisions OUTSIDE this run, flattened to the
  // anonymous OTHER_DIVISION_LABEL) — the run itself was excluded at the source
  // via `excludeDivisionIds`. So the label is a sound classifier: an
  // OTHER_DIVISION_LABEL entry is provably from outside the run and
  // `division_id: null` is a fact, not an inference.
  //
  // That is why there is no slot-key filter here any more. One could not tell
  // "division B's fixture re-served to me" from "excluded division C sits on the
  // same court at the same instant", and dropping the second silently deletes a
  // hard constraint — obstacles are what the joint verifier reads, so nothing
  // downstream could recover it.
  //
  // Foreign obstacles still arrive once per source pack, each rendered in THAT
  // division's timezone; re-render them in one canonical zone (the first
  // division in the emitted order) so the same excluded placement is one entry
  // with one spelling however many selected divisions reported it.
  // -------------------------------------------------------------------------
  // #397: ONE organisation clock (design §2.1). The old rule — canonicalTz =
  // divisions[0].tz — made the pack's zone depend on how the divisions happened
  // to sort, so adding a division re-rendered every foreign obstacle. Ruling R8
  // is superseded; J6 was rewritten to match.
  const canonicalTz = orgTz;
  const collected: CompetitionPackObstacle[] = [];
  for (const b of built) {
    for (const o of b.pack.fixtures.obstacles) {
      if (o.label !== OTHER_DIVISION_LABEL) {
        collected.push({ ...o, division_id: b.id });
        continue;
      }
      collected.push({
        court: o.court,
        from: zonedIso(ms(o.from), canonicalTz),
        to: zonedIso(ms(o.to), canonicalTz),
        label: o.label,
        division_id: null,
      });
    }
  }
  // Dedupe carries the division identity: without it, two selected divisions'
  // own immovable fixtures sharing a court and span collapse into one entry
  // tagged with whichever built first, hiding a real fixture from both the model
  // and the verifier. Foreign entries all key on the same null, so the
  // duplicate-report collapse they need still happens.
  const seenObstacle = new Set<string>();
  const obstacles = collected
    .filter((o) => {
      const key = `${o.division_id ?? ""}|${o.court}|${ms(o.from)}|${ms(o.to)}`;
      if (seenObstacle.has(key)) return false;
      seenObstacle.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        // #14 sibling fix: was `cmp(a.court, b.court)` — a raw court uuid,
        // freshly minted per seed, so that sort was a fresh permutation on
        // every reseed (identical defect to the single-division path's own
        // `courtOrderKey` fix, schedule-ai.ts). `courtRank` (defined above,
        // already used for `draft` ordering for the exact same reason) is
        // the joint-scope structural order instead: reproducible across two
        // identically-seeded competitions.
        courtRank(a.court) - courtRank(b.court) ||
        ms(a.from) - ms(b.from) ||
        ms(a.to) - ms(b.to) ||
        cmp(a.label, b.label),
    );

  // Instants, not strings: divisions may sit in different zones, so a
  // lexicographic compare over mixed-offset ISO is not chronological.
  //
  // #397: an unplaced row carries no instant at all, and sorts first as one
  // stable block ahead of every placed card. Two unplaced rows are EQUAL on
  // time and must fall through to the court — subtracting two -Infinity
  // sentinels returns NaN, which only reaches the same place because NaN is
  // falsy, and reads as though it returned 0.
  const byJointTime = (
    a: CompetitionPackDraftAssignment,
    b: CompetitionPackDraftAssignment,
  ): number => {
    if (a.scheduled_at === null || b.scheduled_at === null) {
      return (a.scheduled_at === null ? 0 : 1) - (b.scheduled_at === null ? 0 : 1);
    }
    return ms(a.scheduled_at) - ms(b.scheduled_at);
  };
  const byJointAssignment = (
    a: CompetitionPackDraftAssignment,
    b: CompetitionPackDraftAssignment,
  ): number =>
    byJointTime(a, b) ||
    // P9: `court_label` carries a court UUID now; ranking by the structural
    // court order keeps two identically-seeded competitions byte-identical.
    courtRank(a.court_label) - courtRank(b.court_label) ||
    byDivision(a.division_id, b.division_id) ||
    cmp(a.fixture_id, b.fixture_id);

  const draft: CompetitionPackDraftAssignment[] = built
    .flatMap((b) => b.pack.draft.map((a) => ({ ...a, division_id: b.id })))
    .sort(byJointAssignment);

  const entrants = built.flatMap((b) =>
    b.pack.entrants.map((e) => ({ ...e, division_id: b.id })),
  );

  // Shared players, derived from the RUN's whole entrant set — deliberately NOT
  // a union of the per-division maps.
  //
  // Each source pack keeps only persons rostered into >= 2 of its OWN entrants
  // (schedule-ai.ts:540-543), because within one division those are the only ones
  // that can create a cross-entrant clash. Across a joint run that bar is wrong:
  // a person in ONE entrant of A and ONE of B clears it in neither division and
  // is therefore in no source map, while H4 sends the model to this very map to
  // avoid entrant overlaps. The model would then be asked to avoid a clash the
  // pack never showed it.
  //
  // Applying the same >= 2 rule to the joint entrant set fixes that at the
  // source. It is a strict superset of the union: every within-division sharer
  // still qualifies, and the cross-division ones now do too. Nothing downstream
  // changes semantics — person_overlap stays the warn it is single-division
  // (calendar.ts:102) — the model simply gets the data it needs to comply.
  const entrantNameById = new Map(entrants.map((e) => [e.id, e.name]));
  const byEntrantName = (a: string, b: string): number =>
    cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
  const entrantNameKey = (ids: readonly string[]): string =>
    ids.map((e) => entrantNameById.get(e) ?? e).join("|");
  const membersByEntrant = await withTenant(auth.orgId, (tx) =>
    peopleByEntrant(
      tx,
      entrants.map((e) => e.id),
    ),
  );
  const entrantsByPerson = new Map<string, Set<string>>();
  for (const [entrantId, personIds] of membersByEntrant) {
    for (const p of personIds) {
      (entrantsByPerson.get(p) ?? entrantsByPerson.set(p, new Set()).get(p)!).add(entrantId);
    }
  }
  // peopleByEntrant's rows carry no ORDER BY, so nothing here may lean on
  // insertion order the way the old first-seen merge did. Both the entrant_ids
  // array and the people array sort on the entrant NAME — the invariant at
  // schedule-ai.ts:517-523, mirroring its own people sort at :544-548.
  const people: PackPerson[] = [...entrantsByPerson.entries()]
    .filter(([, ents]) => ents.size >= 2)
    .map(([person_id, ents]) => ({ person_id, entrant_ids: [...ents].sort(byEntrantName) }))
    .sort(
      (a, b) =>
        cmp(entrantNameKey(a.entrant_ids), entrantNameKey(b.entrant_ids)) ||
        cmp(a.person_id, b.person_id),
    );

  // Each source pack already normalised its slice of the prior proposal into
  // its own timezone; re-tag and re-sort rather than re-deriving.
  const prior = opts.prior
    ? {
        instruction: opts.prior.instruction,
        assignments: built
          .flatMap((b) => (b.pack.prior?.assignments ?? []).map((a) => ({ ...a, division_id: b.id })))
          .sort(byJointAssignment),
      }
    : null;

  const pack: CompetitionPack = {
    mode: opts.mode,
    competition: { id: competition.id, name: competition.name },
    tz: orgTz,
    clock,
    window,
    sessionHours: { ...DEFAULT_SESSION_HOURS },
    divisions,
    courts,
    divergentCourts,
    entrants,
    people,
    participants,
    poolIds,
    stageIds,
    roundNos,
    // Absent, not `{}`, when no division has a Swiss stage: a league/bracket run's pack is byte-identical to before.
    ...(Object.keys(roundRules).length > 0 ? { roundRules } : {}),
    assumptions,
    parsed: { hard: resolved.hard, soft: resolved.soft, unparsed: resolved.unparsed },
    fixtures: { movable, obstacles },
    draft,
    instruction: opts.instruction,
    prior,
  };

  return { pack, movableIds, courtDirectory };
}
