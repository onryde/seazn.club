import "server-only";
// Fixtures written outside bulk generation: ladder challenges and ad-hoc single
// fixtures.

import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { swissRefusal } from "../swiss-refusal";
import type { AuthCtx } from "@/server/api-v1/auth";
import { afterScheduleWrite, courtVenueIds, divisionLockState } from "../schedule";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
// #8 sibling fix: reuse the SAME not-found codes `venues.ts` already
// throws for a bad court_id/venue_id, instead of minting new ones, so
// addFixture's error is indistinguishable from every other "not a real
// court/venue in this org" 404 in the product.
import { VENUE_NOT_FOUND_CODE, COURT_NOT_FOUND_CODE } from "../venues";
import { departedEntrantIds } from "./helpers";

// ---------------------------------------------------------------------------
// Ladder challenges (Jul3/08 §6): no pre-generated fixtures — players issue
// challenges within range; the result reorders the ladder (scoring hook).
// ---------------------------------------------------------------------------

/** The reach a ladder stage gets when its `config` does not name one. The
 *  ONE place this default lives: a test that types `3` into its own table
 *  goes on asserting yesterday's rule after this moves, so tests derive
 *  their distances from here instead. (The `challengeRange: 3` literals in
 *  the format templates are those templates' own declared config, not this
 *  fallback.) */
export const DEFAULT_LADDER_CHALLENGE_RANGE = 3;

export async function issueChallenge(
  auth: AuthCtx,
  stageId: string,
  input: { challenger_id: string; opponent_id: string },
): Promise<{ fixture_id: string; ladder_order: string[] }> {
  const [ladderComp] = await sql<{ competition_id: string }[]>`
    select d.competition_id from stages s
    join divisions d on d.id = s.division_id
    where s.id = ${stageId}`;
  await requireFeature(auth.orgId, "formats.advanced", ladderComp?.competition_id);
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { division_id: string; kind: string; config: Record<string, unknown>; competition_id: string }[]
    >`
      select s.division_id, s.kind, s.config, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "ladder") throw new HttpError(422, "challenges only exist on ladder stages");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // A frozen division refuses a challenge. A ladder has no pre-generated
    // timetable — its fixtures are created on demand, one per challenge — but
    // a challenge still INSERTS a fixture onto the division's board, and on
    // first use also writes `stage.config.ladder_order`. Both happen below,
    // under this lock; both are board writes, and the freeze binds board
    // writes wherever they come from.
    //
    // AFTER the 404 and the ladder-kind 422 (an unknown stage still 404s —
    // `divisionLockState` reads a missing row as UNFROZEN), and after the
    // advisory lock, matching every other refusing site.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }

    // ladder order initialises from seed order on first use
    let order = stage.config.ladder_order as string[] | undefined;
    if (!Array.isArray(order) || order.length === 0) {
      const entrants = await tx<{ id: string }[]>`
        select id from entrants
        where division_id = ${stage.division_id} and status in ('registered','confirmed')
        order by seed nulls last, created_at, id`;
      order = entrants.map((e) => e.id);
      // Server-side merge (design §T2): `stage.config` was read before the
      // advisory lock, so anything written while this transaction waited must
      // not be spread back over.
      await tx`update stages set config = config || ${tx.json({ ladder_order: order } as never)}
               where id = ${stageId}`;
    }
    const ci = order.indexOf(input.challenger_id);
    const oi = order.indexOf(input.opponent_id);
    // Every refusal below carries a LADDER_* wire code. The console renders
    // `err.message` — the server's own English — unless it recognises the
    // code, and there is no server-side i18n in this repo, so a refusal
    // without a code is an English sentence in all four locales. The codes
    // and their copy live in lib/ladder-error.ts + dictionaries/*/errors.json.
    if (ci < 0 || oi < 0) {
      throw new HttpError(422, "both players must be on the ladder", "LADDER_ENTRANT_FOREIGN");
    }
    // Presence on the ladder is not eligibility. `ladder_order` is written
    // ONCE, from the live field, and never pruned afterwards; a withdrawal
    // is a status flip that leaves her row and her rung in place, so the
    // check above waves a departed player through in EITHER role.
    //
    // Filtered here, at read time, rather than pruned from `config` when she
    // withdraws: a pruned array cannot be un-pruned, and an entrant CAN be
    // un-withdrawn (patchEntrant) — `ladder_order` only initialises while it
    // is empty, so she would never be re-seated and would silently lose the
    // rung she earned. Read-time filtering also cannot leave stale config
    // behind, and needs no matching hook on the un-withdraw path.
    //
    // BOTH sides, checked together: she can be the challenger or the
    // opponent, and a guard that looks at one is half a fix.
    const departed = await departedEntrantIds(tx, stage.division_id);
    if (departed.has(input.challenger_id) || departed.has(input.opponent_id)) {
      throw new HttpError(
        422,
        "a player who has withdrawn from this division can neither issue nor receive a challenge",
        "LADDER_ENTRANT_WITHDRAWN",
      );
    }
    // RAW indices, and provably the same answer as live ones would give: a
    // filter preserves relative order, so for two players who are BOTH on
    // the live ladder — which the guard immediately above has just
    // guaranteed — `oi < ci` holds in the filtered array exactly when it
    // holds in the stored one. Kept raw because it is the array already in
    // hand, and noted here so the next reader does not "fix" it: computing
    // it live would also be WRONG if the departed guard ever moved below,
    // since a departed player is absent from the live array and would index
    // -1 rather than compare.
    if (oi >= ci) {
      throw new HttpError(422, "you can only challenge upward", "LADDER_CHALLENGE_NOT_UPWARD");
    }
    const range =
      typeof stage.config.challengeRange === "number"
        ? stage.config.challengeRange
        : DEFAULT_LADDER_CHALLENGE_RANGE;
    // REACH IS MEASURED IN LIVE RUNGS (owner ruling, 2026-09-21, finding F7).
    // `ladder_order` still CONTAINS the departed — read-time filtering, never
    // a prune, for every reason the block above gives — so counting its
    // positions made a withdrawn player between two actives eat one of the
    // challenger's places. Reach is a COMPETITIVE-DISTANCE rule, and someone
    // who has left is not competitive distance, she is a hole: counting her
    // silently SHORTENED everyone's reach whenever somebody above them
    // withdrew, a rule change nobody announced and nobody could see (the
    // published ladder still lists her, with a "withdrawn" badge). The live
    // reading keeps the ladder the same size for the people still climbing.
    //
    // The accepted cost runs the other way: a burst of withdrawals lets a
    // challenger reach further than she could yesterday. That one is visible
    // and explicable — "three people above you left" — which is why the
    // owner took it over the invisible failure.
    //
    // Only the RANGE check reads the live array. The foreign check above
    // stays raw (presence on the ladder AT ALL is its question, and a
    // departed player must fail the guard that owns her reason, with its own
    // code and its own four-locale sentence, rather than be misreported as
    // somebody else's player), and the upward check stays raw because
    // filtering cannot reorder what it keeps.
    //
    // Safe to index without a not-found branch: the departed guard above has
    // already thrown for either player being gone, so both are present here.
    // If that guard ever moves below this point, these lookups return -1 and
    // the refusal a customer gets changes — the precedence case in
    // ladder-reach-counts-live-rungs.test.ts is what stops that silently.
    const liveOrder = order.filter((id) => !departed.has(id));
    const liveCi = liveOrder.indexOf(input.challenger_id);
    const liveOi = liveOrder.indexOf(input.opponent_id);
    if (liveCi - liveOi > range) {
      // `range` rides in `extra`, not only in the English prose: the copy in
      // every locale names the number, and a client cannot parse it back out
      // of a sentence it does not speak. What the ruling moved is what
      // counts as a place, not how many — so `extra` is unchanged.
      throw new HttpError(
        422,
        `challenges reach at most ${range} places up the ladder, counting only players still in the field`,
        "LADDER_CHALLENGE_OUT_OF_RANGE",
        { range },
      );
    }
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    const [fixture] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, ext_key, status)
      values (${stageId}, ${stage.division_id}, ${n + 1}, 1,
              ${input.challenger_id}, ${input.opponent_id}, ${"ch-" + String(n + 1)}, 'scheduled')
      returning id`;
    if (stage.config.ladder_order === undefined) stage.config.ladder_order = order;
    return {
      out: { fixture_id: fixture!.id, ladder_order: order },
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
    };
  });
  // R10e (found): a challenge puts a fixture on the division's board, so the
  // hub drops in one DEL after the commit and the division push follows it.
  // The fixture is new: no fixture key to drop, nobody watching its centre.
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return write.out;
}

// ---------------------------------------------------------------------------
// Ad-hoc single fixture (PROMPT-66): a replay, a friendly, a manual
// tie-breaker or a missing match, added to an already-running stage. League /
// group standings fold every fixture, so the added match is a real result;
// bracket kinds have no slot for a loose fixture and reject it.
//
// W3 RB3-15 A (spec §8 Q1, ruling 252; #846 SW-M3/M4/M5): Swiss is refused by
// name. Its rounds are paired by the system, and a loose board made phantom
// byes and broke the round shells. Legacy `adhoc-N` rows already on a Swiss
// stage stay live (carried-forward.ts C7, swiss-shell.ts read them).
// `stages-panel.tsx` keeps the same set for the desk's Add match trigger.
// ---------------------------------------------------------------------------

const ADHOC_STAGE_KINDS = new Set(["league", "group"]);

export async function addFixture(
  auth: AuthCtx,
  stageId: string,
  input: {
    home_entrant_id: string;
    away_entrant_id: string;
    round_no?: number;
    scheduled_at?: string | null;
    // P9 pass 3c-2: this writer was the one cutover pass 3a missed — it still
    // accepted and inserted the free-text `venue` column. Real venue/court by
    // id, matching every other fixture-touching writer (moveFixture et al.).
    venue_id?: string | null;
    court_id?: string | null;
  },
): Promise<{ fixture_id: string }> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; kind: string; status: string; competition_id: string }[]>`
      select s.division_id, s.kind, s.status, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind === "ladder") {
      throw new HttpError(422, "ladder matches are created with challenges, not ad-hoc fixtures");
    }
    if (stage.kind === "americano") {
      throw new HttpError(422, "americano matches are generated round by round — generate another round instead");
    }
    // X-SW-21: before the generic bracket refusal, so the organiser reads why
    // and where friendlies go instead of "no slot in the tree".
    if (stage.kind === "swiss") throw swissRefusal("SWISS_ADHOC_REFUSED");
    if (!ADHOC_STAGE_KINDS.has(stage.kind)) {
      throw new HttpError(422, "can't add a loose fixture to a bracket — it has no slot in the tree");
    }
    if (stage.status === "complete") {
      throw new HttpError(422, "this stage is complete — a completed table doesn't take new matches");
    }
    if (input.home_entrant_id === input.away_entrant_id) {
      throw new HttpError(422, "an entrant cannot play itself");
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // An ad-hoc fixture carries client-supplied `scheduled_at` and `court_id`
    // straight into the board — a timetable write by another name, and one a
    // frozen division refuses on the same terms as `moveFixture`, which is the
    // path the board's own drag uses to write those two columns.
    //
    // AFTER the existence check and the advisory lock, matching every other
    // site; an unknown stage id still 404s.
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const entrants = await tx<{ id: string }[]>`
      select id from entrants
      where division_id = ${stage.division_id}
        and id in (${input.home_entrant_id}, ${input.away_entrant_id})`;
    if (entrants.length !== 2) {
      throw new HttpError(422, "both entrants must belong to this stage's division");
    }
    // #14 sibling fix: `court_id`/`venue_id` are FK-restricted but the FK is
    // `deferrable initially deferred` (V367) — an id that isn't a real court/
    // venue of this org would otherwise only fail at COMMIT time, as a raw
    // Postgres foreign_key_violation (500), not a clean 4xx. `tx` is already
    // RLS-scoped to this org, so existence here IS the ownership check —
    // same pattern venues.ts's own writers use for the same tables.
    if (input.court_id) {
      const [court] = await tx<{ id: string }[]>`select id from courts where id = ${input.court_id}`;
      if (!court) throw new HttpError(404, "court not found", COURT_NOT_FOUND_CODE);
    }
    if (input.venue_id) {
      const [venue] = await tx<{ id: string }[]>`select id from venues where id = ${input.venue_id}`;
      if (!venue) throw new HttpError(404, "venue not found", VENUE_NOT_FOUND_CODE);
    }
    // Group stages: the match must land in the entrants' pool so the right
    // table folds it. Inferred from the stage's existing fixtures — no
    // separate pool-membership lookup exists or is needed.
    let poolId: string | null = null;
    if (stage.kind === "group") {
      const pools = await tx<{ pool_id: string | null }[]>`
        select distinct pool_id from fixtures
        where stage_id = ${stageId}
          and (home_entrant_id in (${input.home_entrant_id}, ${input.away_entrant_id})
            or away_entrant_id in (${input.home_entrant_id}, ${input.away_entrant_id}))`;
      const ids = [...new Set(pools.map((p) => p.pool_id))];
      if (ids.length !== 1 || ids[0] == null) {
        throw new HttpError(422, "both entrants must be in the same pool of this stage");
      }
      poolId = ids[0];
    }
    const [{ maxRound }] = await tx<{ maxRound: number }[]>`
      select coalesce(max(round_no), 0)::int as "maxRound" from fixtures where stage_id = ${stageId}`;
    const round = input.round_no ?? maxRound + 1;
    const [{ nextSeq }] = await tx<{ nextSeq: number }[]>`
      select coalesce(max(seq_in_round), 0)::int + 1 as "nextSeq"
      from fixtures where stage_id = ${stageId} and round_no = ${round}`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${stageId}`;
    // Review wave 2: the venue is DERIVED from the court, exactly as
    // `applySchedule`/`moveFixture`/the joint apply now do. Accepting both
    // independently let a caller post Venue A's court with Venue B's
    // `venue_id` and create a fixture whose venue contradicts the court it
    // sits on — the FK only checks each id belongs to the org, never that the
    // two agree. A court with no resolvable venue falls back to the supplied
    // value, so a venue-only ad-hoc fixture still works.
    const adhocVenueId =
      input.court_id != null
        ? ((await courtVenueIds(tx)).get(input.court_id) ?? input.venue_id ?? null)
        : (input.venue_id ?? null);
    const [fixture] = await tx<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, pool_id, round_no, seq_in_round,
                            home_entrant_id, away_entrant_id, ext_key, status, scheduled_at,
                            venue_id, court_id)
      values (${stageId}, ${stage.division_id}, ${poolId}, ${round}, ${nextSeq},
              ${input.home_entrant_id}, ${input.away_entrant_id}, ${"adhoc-" + String(n + 1)},
              'scheduled', ${input.scheduled_at ?? null},
              ${adhocVenueId}, ${input.court_id ?? null})
      returning id`;
    return { out: { fixture_id: fixture!.id }, divisionId: stage.division_id, competitionId: stage.competition_id };
  });
  // R10e (found): an ad-hoc fixture lands on the hub with its kick-off and
  // court, so the hub drops in one DEL after the commit and the division push
  // follows it. The fixture is new: no fixture key, no fixture push.
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return write.out;
}