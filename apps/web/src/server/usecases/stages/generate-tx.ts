import "server-only";
// The in-transaction generate and rebuild core: one stage's fixtures written
// against the live roster, the root-knockout reconcile, cross-stage feeds.

import { randomUUID } from "node:crypto";
import { swissDrawSeed } from "@/lib/swiss-draw";
import { HttpError } from "@/lib/errors";
import { knockoutRefusal } from "../knockout-refusal";
import { swissRoundsNoticeOf, type SwissRoundsNotice } from "@/lib/swiss-rounds";
import { EngineError } from "@seazn/engine/core";
import { pinStageTableRules } from "@/server/engine-db/table-rules";
import { FIXTURE_DELETED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "../external-play/cancel-invites";
import { writeAwardedMatchState } from "@/server/engine-db/awarded-state";
import { BYE_SLOT_LABEL, isByeLine, type ByeLineRow } from "@/lib/bye-line";
import { bracketRoleKey, finalRoundOf, type BracketRoleRow } from "@/lib/bracket-role";
import type { AuthCtx } from "@/server/api-v1/auth";
import { courtNamesById, divisionLockState } from "../schedule";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { fixtureCalledSql, stageHasStarted } from "../fixture-started-sql";
// W4 T8 (FX-G2): a root knockout's Generate over existing lines reconciles them (bracket-reconcile.ts).
import { reconcileRootBracket } from "../bracket-reconcile";
import { carriedSlotCounts, carrySlots } from "@/lib/rebuild-slots";
import { refuseOwnFormatLoss } from "../fixture-override-guards";
import {
  STAGE_COLS,
  type Tx,
  type StageRow,
  type FixtureRow,
  type GenFixture,
  type ActiveEntrant,
  type SwissExistingFixture,
  type SwissReshape,
  type GenerateWrite,
  type GenerateOptions,
  type SealedSetupCounts,
} from "./types";
import { divisionHasStarted } from "./helpers";
import {
  americanoGen,
  BRACKET_WALKOVER_KINDS,
  EMPTY_ID_SET,
  walkoverDepartedQualifiers,
  generatedAward,
  knockoutDraws,
  knockoutDrawOrder,
  POOL_KEYS,
  poolCount,
  generateForStage,
} from "./generators";
import { isEmptySwissReshape } from "./swiss-reconcile";
import { swissActiveEntrants, swissGen } from "./swiss-gen";
import { lockBoardsRefusingOnlineGames } from "./swiss-boards";
import { stageAttachmentCounts } from "./roster-drift";
import { fillSlot, resolveBracketSeats } from "./bracket-seats";

/** A stage's fixture rows as `GenerateOutcome.fixtures` carries them: every column, plus the venue name and the
 *  venue-qualified court name. */
async function readStageFixtureRows(tx: Tx, stageId: string): Promise<FixtureRow[]> {
  const fixtureRows = await tx<Omit<FixtureRow, "court_name">[]>`
    select f.id, f.stage_id, f.division_id, f.pool_id, f.round_no, f.seq_in_round, f.fixture_no,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.scheduled_at, f.venue, f.court_label, f.court_id,
           f.venue_id, ven.name as venue_name,
           f.officials, f.status, f.outcome, f.schedule_source, f.schedule_locked, f.created_at,
           f.ext_key, f.lane, f.is_final, f.third_place, f.conditional
    from fixtures f
    left join venues ven on ven.id = f.venue_id
    where f.stage_id = ${stageId} order by f.round_no, f.seq_in_round`;
  // #14: venue-qualified label (a bare joined `courts.name` can't tell two
  // same-named courts in different venues apart) — same fallback
  // convention as FixtureRow's own doc comment: fall back to the id
  // itself on a miss (should not happen; FK-restricted).
  const courtNames = await courtNamesById(tx);
  return fixtureRows.map((f) => ({
    ...f,
    court_name: f.court_id !== null ? (courtNames.get(f.court_id) ?? f.court_id) : null,
  }));
}

/**
 * W4 T8 (FX-G2): Generate over a root knockout that already has its lines, in the caller's transaction and lock. The
 * driver (`reconcileRootBracket`) refuses after Start when the roster changed (KO_GENERATE_AFTER_START), answers a named
 * no-op when nothing did, or changes lines in place (a newcomer into a bye, a departed entrant's line to a bye); when the
 * bracket crossed a power of two it asks for a regenerate, which is Rebuild's own body (`regenerateStageInTx`): one
 * delete and one fresh draw in this transaction, slots carried by role. `entrants` is the field in draw order.
 */
/** The labels a root knockout's own lines carry: the bye (`lib/bye-line.ts`) and the feeder (`fed-seats.ts`). Any other key is a
 *  progression's, for a seat a proposal's confirm fills. */
const ROOT_BRACKET_LABEL_KEYS: readonly string[] = [BYE_SLOT_LABEL.key, "slot.winner_match", "slot.loser_match"];

/** A seated entrant is never "waiting": clear the mark on everyone now holding a round-1 seat of the stage. */
async function clearSeatedWaitingMarks(tx: Tx, stageId: string): Promise<void> {
  await tx`
    update entrants set knockout_waiting_stage_id = null
     where knockout_waiting_stage_id = ${stageId}
       and id in (select home_entrant_id from fixtures where stage_id = ${stageId} and round_no = 1 and home_entrant_id is not null
                  union select away_entrant_id from fixtures where stage_id = ${stageId} and round_no = 1 and away_entrant_id is not null)`;
}

async function reconcileKnockoutGenerate(
  tx: Tx,
  auth: AuthCtx,
  stage: StageRow,
  field: ActiveEntrant[],
  poolIds: Map<string, string>,
  inPlaceOnly: boolean,
  sealedSetup: SealedSetupCounts | undefined,
  waitNewcomers: boolean,
): Promise<GenerateWrite> {
  let entrants = field;
  // W4 app B, Task 20 (C27; PO ruling): on a frozen board Start does not seat a newcomer (a schedule write) - it MARKS them
  // waiting, as the late-entry path does (`markWaiting`), and reconciles the rest of the field as ever. The newcomer is out of
  // the field this reconcile reads, so a departure still plans in place and a redraw is still refused by name. Written in this
  // transaction: a refusal below rolls the marks back with everything else.
  if (waitNewcomers) {
    const seats = await tx<{ home: string | null; away: string | null }[]>`
      select home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stage.id} and round_no = 1`;
    const seated = new Set(seats.flatMap((l) => [l.home, l.away]).filter((id): id is string => id !== null));
    const newcomers = entrants.filter((e) => !seated.has(e.id));
    if (newcomers.length > 0) {
      await tx`update entrants set knockout_waiting_stage_id = ${stage.id} where id in ${tx(newcomers.map((e) => e.id))}`;
      entrants = entrants.filter((e) => seated.has(e.id));
    }
  }
  const started = (await divisionHasStarted(tx, stage.division_id)) || (await stageHasStarted(tx, stage.id));
  // The lines a fresh draw of the CURRENT field would make - needed only to plan a change BEFORE Start. After Start a Generate never
  // reshapes (`reconcileRootBracket` answers a no-op or refuses by name from the seats alone), so it is not drawn: a drawn,
  // started Play-off whose withdrawals left under four is settled by its own rules (RB4-T6: both sides of the third-place match
  // out ends it 4,4), and drawing it again would refuse "A third-place match needs at least 4 entrants. Use Shared" (X-TP-1,
  // which gates DRAWING) and offer the one thing that would delete its -3p line mid-event (matrix W4B_Q3_OUT).
  const fresh = started
    ? []
    : generateForStage(stage.id, stage.kind, stage.config, entrants, poolIds).map((g) => ({
        pool_id: g.poolId ?? null,
        round_no: g.roundNo,
        seq_in_round: g.seqInRound,
        ext_key: g.extKey,
      }));
  const decision = await reconcileRootBracket(tx, { stageId: stage.id, started, active: entrants, fresh });
  if (decision.kind === "regenerate") {
    // B2 fix round 2 (item 2): Start reconciles in place only. A redraw deletes every line — the slots move, printed
    // sheets stop, public pages hold the old lines — and Start has no notice to say so; Update draw (this same Generate,
    // pressed) does. So Start refuses it by name, before any write, and names the button.
    // Review I2: on a frozen Start (`waitNewcomers`) Update draw is refused too, so the refusal says unfreeze first.
    if (inPlaceOnly) throw knockoutRefusal(waitNewcomers ? "KO_START_NEEDS_UPDATE_DRAW_FROZEN" : "KO_START_NEEDS_UPDATE_DRAW");
    // B2 fix round 1 (I1): a redraw deletes every line, and the delete cascades into the organiser's setup on them (every
    // kind `stageAttachmentCounts` counts). Generate has no confirm, so it never takes them silently: refused by name,
    // pointing to Rebuild, whose confirm lists what it clears. Read before the delete (the counts Rebuild's dialog reads).
    // The sealed kinds were read by `generateStageFixturesWrite`'s privileged prelude, on this transaction's connection.
    if (sealedSetup === undefined) {
      throw new Error("reconcileKnockoutGenerate: a redraw's sealed setup counts were not read (generateStageFixturesWrite's privilegedPrelude)");
    }
    const attachments = await stageAttachmentCounts(tx, stage.id, sealedSetup);
    if (Object.values(attachments).some((n) => n > 0)) {
      throw knockoutRefusal("KO_REDRAW_WOULD_CLEAR_SETUP", { attachments });
    }
    const regen = await regenerateStageInTx(tx, auth, stage.id, stage);
    if (!started) await clearSeatedWaitingMarks(tx, stage.id);
    return {
      ...regen.generated,
      outcome: {
        ...regen.generated.outcome,
        reconcile: {
          kind: "regenerated",
          placed: decision.placed,
          vacated: decision.vacated,
          vacated_seats: decision.vacatedSeats,
          slots: regen.slots,
        },
      },
      changedFixtureIds: regen.removedIds,
    };
  }
  if (decision.kind === "in_place") {
    // B2 fix round 1 (m6): a change in place moves seats under the division's history, so a Redo waiting on the old board
    // would re-apply onto a line that is now a bye. Cleared as a Generate that creates clears it. No ledger row: a
    // Generate writes one only when it creates fixtures (`fixture_ids` is Undo's delete list), and this creates none.
    await tx`update divisions set edit_watermark = null where id = ${stage.division_id}`;
  }
  // Review I1 (defensive): an entrant seated before Start never carries a waiting mark - a mark left by an earlier Start that
  // was refused, or by the desk, must not outlive the seat.
  if (!started) await clearSeatedWaitingMarks(tx, stage.id);
  // Cross-format feeds (Jul3/08 §4), as every other Generate's trailing pass wires them: a declared edge whose target was
  // generated after this bracket is wired by this Generate, a no-op or not (`wireCrossFeeds` fills NULL edges only, so
  // it never overwrites). The regenerate branch above runs the full Generate, which wires them itself.
  await wireCrossFeeds(tx, stage.division_id);
  const fixtures = await readStageFixtureRows(tx, stage.id);
  const [division] = await tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${stage.division_id}`;
  return {
    outcome: {
      created: 0,
      existing: fixtures.length,
      fixtures,
      reconcile: { kind: decision.kind, placed: decision.placed, vacated: decision.vacated, vacated_seats: decision.vacatedSeats },
    },
    divisionId: stage.division_id,
    competitionId: division.competition_id,
    kind: stage.kind,
    changedFixtureIds: decision.touched,
  };
}

/**
 * The main write of a Generate (doc 08 §3), in the CALLER's transaction: everything `generateStageFixtures` does
 * between its pre-flight and its post-commit work, unchanged in behaviour. Extracted (W3 T1, X-RB-1) so
 * `rebuildStageFixtures` can delete and regenerate in ONE transaction — a regenerate that throws then rolls the
 * delete back instead of leaving an empty stage (FX-G13).
 *
 * Takes the division advisory lock itself. A caller that already holds it (Rebuild) takes it again here, which is
 * re-entrant within one transaction. Runs NONE of the pre-flight: the frozen-division refusal, the pairing-on-a-
 * non-Swiss refusal, and the progression branches (`timing: "setup"`, `seedNextStage`) are the caller's.
 */
export async function generateStageFixturesTx(
  tx: Tx,
  auth: AuthCtx,
  stageId: string,
  opts: GenerateOptions,
  /** `"record"`: this pass is an organiser's edit — it appends its own `fixtures_generated` and puts the watermark at
   *  the head. `"step"` (batch-1 I1): a history step re-applying a Swiss Pair runs it — the step's own row records the
   *  work (`ledgerPayload`) and the step keeps the engine's watermark. A fresh row there made every Undo after a Redo
   *  re-pair the round three steps later, and a Restore across it never converge. */
  ledger: "record" | "step" = "record",
): Promise<GenerateWrite> {
  const [stage] = await tx<StageRow[]>`
    select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

  const active = await swissActiveEntrants(tx, stage.division_id, stageId);

  // A seeded stage (qualification resolved at the previous stage's completion,
  // stored as config.qualified) draws from that ordered list — its order IS
  // the seeding. Otherwise: every active division entrant.
  const qualified = Array.isArray(stage.config.qualified)
    ? (stage.config.qualified as string[])
    : null;
  let entrants: ActiveEntrant[];
  // F14 (owner ruling 2026-09-21): the qualifiers who have since departed.
  // Empty for every path but a BRACKET drawing from `config.qualified`.
  let departedQualifiers: ReadonlySet<string> = EMPTY_ID_SET;
  // The ext_keys whose line has no live recipient and is therefore VOID —
  // written as `abandoned`, see the insert below.
  let voidedExtKeys: ReadonlySet<string> = EMPTY_ID_SET;
  if (qualified) {
    const activeIds = new Set(active.map((e) => e.id));
    if (BRACKET_WALKOVER_KINDS.has(stage.kind)) {
      // A bracket's qualification order IS the draw, so a departure must not
      // move anybody: re-seeding the SURVIVORS 1..n (what this did until
      // F14) slides every later qualifier up a seat, into a different half
      // of the draw and against a different opponent — a silent promotion,
      // and one that also robs the departed qualifier's opponent of the
      // walkover they are owed. Keep the published positions; the pairings
      // that hold a departed qualifier become walkovers below.
      entrants = qualified.map((id, i) => ({ id, seed: i + 1, swiss_first_round: null }));
      const gone = qualified.filter((id) => !activeIds.has(id));
      // Restored refusal (re-review C2). Keeping the full slate above means
      // `entrants.length` is now the PUBLISHED draw's size, so the
      // `entrants.length < 2` check below — which is what refused this
      // before F14 — can no longer see a field that has emptied out.
      // Without this, "every qualifier withdrew" generated a complete
      // bracket of withdrawn entrants, and "only one is left" generated a
      // bracket whose single survivor has nobody to play. Same threshold as
      // the pre-F14 behaviour and as `SEEDING_NOTHING_TO_FILL` on the
      // `setup` path: a stage needs two live entrants to be a competition.
      if (qualified.length - gone.length < 2) {
        throw new EngineError(
          "STAGE_NOT_READY",
          "the qualifiers for this stage have left the field — recompute or reopen it once the field is settled",
          { stageId, qualified: qualified.length, live: qualified.length - gone.length },
        );
      }
      if (gone.length > 0) departedQualifiers = new Set(gone);
    } else {
      // A table stage has no draw to preserve and no opponent to walk over
      // to: nothing has been played, so spec 05 §5's policy for these kinds
      // is EXPUNGE — the departed entrant simply is not in the field.
      // W3 T6: a qualified field is fixed when the stage is drawn, so every qualifier plays from its round 1 — an
      // entrant's `swiss_first_round` belongs to the Swiss stage that admitted them late, not to this one.
      entrants = qualified.filter((id) => activeIds.has(id)).map((id, i) => ({ id, seed: i + 1, swiss_first_round: null }));
    }
  } else {
    // W4 T7 (K5, X-SD-6): a root knockout draws its unseeded entrants with the stage's own seed — main placed them in the
    // active select's order (`seed nulls last, created_at, id`), so the byes went to the earliest registrants.
    entrants = stage.kind === "knockout" ? knockoutDrawOrder(stageId, active, stage.config) : active;
  }
  // RB4-D4: the seed is recorded on this Generate's ledger row only when the draw was used.
  const knockoutDrawSeed = stage.kind === "knockout" && qualified === null && knockoutDraws(active, stage.config) ? swissDrawSeed(stageId) : null;
  if (entrants.length < 2) {
    throw new EngineError("STAGE_NOT_READY", "need at least 2 active entrants to generate", {
      stageId,
      entrants: entrants.length,
    });
  }

  // Group stages with pools: materialise the pools rows first (idempotent),
  // so generated fixtures can reference them.
  const poolIds = new Map<string, string>();
  if (stage.kind === "group" && poolCount(stage.config) > 1) {
    const existing = await tx<{ id: string; key: string }[]>`
      select id, key from pools where stage_id = ${stageId}`;
    for (const pool of existing) poolIds.set(pool.key, pool.id);
    for (let i = 0; i < poolCount(stage.config); i++) {
      const key = POOL_KEYS[i];
      if (poolIds.has(key)) continue;
      const [row] = await tx<{ id: string }[]>`
        insert into pools (stage_id, key, name)
        values (${stageId}, ${key}, ${"Pool " + key}) returning id`;
      poolIds.set(key, row.id);
    }
  }

  // ORDERED (W3 T3, controller ruling from the engine review): swissGen walks these rows to build each player's colour
  // history, and the engine reads that history as a sequence. Without the ORDER BY the rows come back in whatever order
  // the plan yields — round order through the (stage_id, round_no, seq_in_round) index, PHYSICAL order through a seq or
  // bitmap scan, where a round written after a later one (any update makes a new tuple) reads back after it
  // (swiss-history-round-order.test.ts). Since W3 T6 `buildSwissHistory` also sorts its own copy, so the colours no
  // longer depend on this ORDER BY alone; it stays so every other reader of `existing` sees round order too.
  const existing = await tx<SwissExistingFixture[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;

  // W4 T8 (FX-G2, MB-004/005; spec §6.5): a ROOT knockout that already has its lines is reconciled, never inserted into
  // by `ext_key` (6 → 7 inserted nothing and said "up to date"; 8 → 9 seated the field twice beside a second final; a
  // line that became a bye 500'd on the bye-award bulk update below). Fed stages (`config.qualified`) keep their path.
  if (stage.kind === "knockout" && qualified === null && stage.progression === null && existing.length > 0) {
    // A reconcile never asks a seat what it is waiting for, so a progression's label on a stage that no longer has a
    // progression would sit beside an empty seat for good. A root bracket's own are the bye's and the feeder's; anything else
    // is refused before a write, as the bulk updates below refuse theirs.
    const stranded = await tx<{ id: string }[]>`
      select id from fixtures
      where stage_id = ${stage.id}
        and (home_slot_label ->> 'key' not in ${tx(ROOT_BRACKET_LABEL_KEYS)} or away_slot_label ->> 'key' not in ${tx(ROOT_BRACKET_LABEL_KEYS)})`;
    if (stranded.length > 0) {
      throw new Error(
        `generateStageFixtures: a reconciled Generate would strand a home_slot_label or away_slot_label on fixture(s) ${stranded.map((f) => f.id).join(",")}: a root bracket's lines carry only a bye's or a feeder's label`,
      );
    }
    return reconcileKnockoutGenerate(tx, auth, stage, entrants, poolIds, opts.inPlaceOnly === true, opts.sealedSetup, opts.inPlaceOnly === true && opts.waitNewcomers === true);
  }

  let swissSeatedCount = 0;
  let swissReshaped: SwissReshape | undefined;
  let swissRoundsWarn: SwissRoundsNotice | undefined;
  // W3 app-B T7 (X-SW-10): the look-ahead's verdict when it is not "pairable", and the round it follows.
  let swissNext: { verdict: "unpairable" | "unknown"; round: number } | undefined;
  // Rides on this pass's `fixtures_generated` row when it seated a round.
  let swissAudit: Record<string, unknown> | undefined;
  let gen: GenFixture[];
  if (stage.kind === "swiss") {
    const swiss = await swissGen(tx, stageId, stage.division_id, stage.config, entrants, existing, opts.pairing);
    gen = swiss.gen;
    swissSeatedCount = swiss.seatedCount;
    if (!isEmptySwissReshape(swiss.reshaped)) swissReshaped = swiss.reshaped;
    swissRoundsWarn = swissRoundsNoticeOf(swiss.swissRounds);
    if (swiss.round !== null && swiss.nextRound !== null && swiss.nextRound !== "pairable") {
      swissNext = { verdict: swiss.nextRound, round: swiss.round };
    }
    // `override` is true only when the body named a mode OTHER than the one
    // this round would have used anyway — picking the default is no override.
    swissAudit =
      swiss.seatedIds.length > 0
        ? {
            round: swiss.round,
            pairing: swiss.pairing,
            override: opts.pairing !== undefined && opts.pairing !== swiss.defaultPairing,
            seated_fixture_ids: swiss.seatedIds,
            // W3 T8: round 1's draw seed (X-SW-22) and colour lot (BG-SW-1), each only when this pass used one, so the
            // round can be replayed from the ledger.
            ...(swiss.drawSeed !== null ? { draw_seed: swiss.drawSeed } : {}),
            // W3 T9 (T8 review n1): and its drawn order, which later rounds read instead of re-deriving it.
            ...(swiss.drawOrder !== null ? { draw_order: swiss.drawOrder } : {}),
            ...(swiss.colourLot !== null ? { colour_lot: swiss.colourLot } : {}),
            // W3 app-B T7 (X-SW-11): the final round's topscorer line this pass sent - the stage's one use of it.
            ...(swiss.finalRoundMaxScore !== null ? { final_round_max_score: swiss.finalRoundMaxScore } : {}),
          }
        : undefined;
  } else if (stage.kind === "americano") {
    gen = await americanoGen(tx, stage.division_id, stageId, stage.config, entrants);
  } else if (stage.kind === "ladder") {
    gen = []; // Jul3/08 §6: ladder fixtures come from challenges, on demand
  } else {
    gen = generateForStage(stage.id, stage.kind, stage.config, entrants, poolIds);
  }

  // F14: the draw above was built over the FULL qualification list, so every
  // survivor sits where the published draw put them. Settle the lines that
  // hold a departed qualifier as walkovers, off the same engine policy the
  // post-generation cascade uses.
  if (departedQualifiers.size > 0) {
    const walked = walkoverDepartedQualifiers(stageId, stage.kind, gen, departedQualifiers);
    gen = walked.gen;
    voidedExtKeys = walked.voided;
  }

  // Guard against the misleading "nothing new — up to date" success shape
  // (design/fix-ui/03 §"misleading success message"): a `group` stage with
  // enough TOTAL entrants to pass the `entrants.length < 2` check above can
  // still produce zero pairings once those entrants are split across N
  // configured groups (e.g. 2 entrants snake-distributed into 4 groups —
  // every group ends up with 0 or 1 entrant, so roundRobinGen has nothing to
  // pair). Before this guard, that returned `created: 0, existing: 0` — the
  // exact same shape as "already generated, run again, nothing changed" —
  // so the UI showed a green "up to date" banner while zero fixtures ever
  // existed. Distinguish the two: this is a precondition failure, not a
  // no-op success, so it must throw (a real reason), not return quietly.
  if ((stage.kind === "group" || stage.kind === "league") && gen.length === 0 && existing.length === 0) {
    const groups = stage.kind === "group" ? poolCount(stage.config) : 1;
    const required = Math.max(2, groups * 2);
    throw new EngineError(
      "STAGE_NOT_READY",
      groups > 1
        ? `not enough entrants to fill ${groups} groups — each group needs at least 2 (have ${entrants.length}, need ${required})`
        : "not enough entrants to generate any matches",
      { stageId, reason: "group_too_few_entrants", groups, entrants: entrants.length, required },
    );
  }

  const byKey = new Map<string, string>(); // ext_key → fixture uuid
  for (const f of existing) if (f.ext_key) byKey.set(f.ext_key, f.id);

  // Cross-stage fill unification (D4a/P5 scope item 3): when `entrants`
  // came from `stage.config.qualified` (the OLD auto-seed-on-complete
  // flow — see seedNextStage below), the two REAL sides of a fixture must
  // land through the SAME slot-fill pathway as intra-bracket advancement
  // (fillSlot), not baked into this INSERT — one pathway, not two. A bye
  // AWARD stays a direct bake: it is an immediate, self-contained
  // walkover decision made at generation time (same as it always was for
  // the plain/registered-entrant path), not a "fill a slot with a
  // qualified entrant" concern, so it is out of scope for this
  // unification and untouched.
  const viaFillSlot = qualified !== null;
  const bakeDirect = (g: GenFixture) => !viaFillSlot || g.award !== undefined;

  // Match-sourced slot labels (P7/F1): a slot with no baked entrant, fed by
  // an earlier fixture in THIS generation (g.homeFrom/g.awayFrom), gets an
  // i18n pattern ref persisted alongside the null entrant id — { key:
  // "slot.winner_match" | "slot.loser_match", params: { round, seq } },
  // numbers, NEVER a rendered fragment (resolveSlotLabel composes the ref
  // text at render time via slot.match_ref, so every locale/surface can
  // differ). This is the SAME {key,params} shape the `timing:"setup"` path
  // (descriptorLabel, stage-seeding.ts — untouched) already writes for its
  // own kind of TBD slot; only the descriptor differs. `refByExt` mirrors
  // the preview helper's own map above (extKey → the SOURCE fixture's
  // {round, seq}) — built from the FULL `gen`, not just the new rows below,
  // so a homeFrom/awayFrom pointing at an already-existing fixture still
  // resolves. Gated on the ACTUAL entrant id about to be inserted (not
  // `bakeDirect(g)` alone) — `bakeDirect` is a constant `true` for every
  // fixture on the common, non-cross-stage-fill path, so a round-2+
  // intra-bracket slot (g.home already null there) needs its OWN nullness
  // check, not a proxy that never fires in that path.
  //
  // EXCEPT a bye: `byeExtKeys` names every source whose "match" resolves to
  // an immediate award, not a real fixture ever played. Its winner is
  // propagated into the fed slot synchronously below (the "Third pass"),
  // inside this SAME transaction — no user ever sees that slot render as
  // TBD, so labelling it would only create a label this call is about to
  // strand. The Third pass's own invariant guard (P5 review finding, right
  // below) exists precisely to catch a stale label reaching that update
  // path; skipping the label here for a bye source is what keeps this
  // task's own new label-writing from being the thing that trips it.
  const refByExt = new Map(gen.map((f) => [f.extKey, { round: f.roundNo, seq: f.seqInRound }]));
  const byeExtKeys = new Set(gen.filter((f) => f.award !== undefined).map((f) => f.extKey));
  const matchSlotLabel = (
    from?: { extKey: string; side: "winner" | "loser" },
  ): { key: string; params: { round: number; seq: number } } | null => {
    if (!from) return null;
    if (byeExtKeys.has(from.extKey)) return null;
    const params = refByExt.get(from.extKey);
    if (!params) return null;
    const key = from.side === "loser" ? "slot.loser_match" : "slot.winner_match";
    return { key, params };
  };
  // Review finding (defect 1): a bye is known at setup and never resolves
  // to anyone — "TBD" tells an organiser to wait for something that is not
  // coming (same rationale previewDivisionFixtures already applies at its
  // own bye branch above). The engine always lands the award on `home`
  // (buildSingleElim), so in practice this only ever fires for `away`, but
  // both sides are guarded symmetrically rather than assuming that engine
  // detail here. Stored at INSERT time, not derived at render time: this
  // is the ONE place a bye's phantom side is decided, so every renderer
  // that already goes through resolveSlotLabel (public bracket, console
  // stages/bracket panels, …) picks it up for free, the same way every
  // other slot label on this row already does.
  const byeSlotLabel = (isBye: boolean): { key: string; params: Record<string, never> } | null =>
    isBye ? BYE_SLOT_LABEL : null;

  // First pass: all new fixtures in one multi-row insert. Ids are generated
  // client-side so the feed/bye passes can reference them without relying
  // on RETURNING order.
  const newRows = gen
    .filter((g) => !byKey.has(g.extKey))
    .map((g) => {
      const home_entrant_id = bakeDirect(g) ? g.home : null;
      const away_entrant_id = bakeDirect(g) ? g.away : null;
      return {
        id: randomUUID(),
        stage_id: stageId,
        division_id: stage.division_id,
        pool_id: g.poolId ?? null,
        round_no: g.roundNo,
        seq_in_round: g.seqInRound,
        home_entrant_id,
        away_entrant_id,
        home_slot_label: home_entrant_id
          ? null
          : g.departedSeat === "home"
            ? BYE_SLOT_LABEL
            : (byeSlotLabel(g.award !== undefined) ?? matchSlotLabel(g.homeFrom)),
        away_slot_label: away_entrant_id
          ? null
          : g.departedSeat === "away"
            ? BYE_SLOT_LABEL
            : (byeSlotLabel(g.award !== undefined) ?? matchSlotLabel(g.awayFrom)),
        ext_key: g.extKey,
        // `abandoned` is what a VOID line is in this column: the cascade
        // reaches the same state by posting `core.abandon`
        // (`withdrawal.ts`'s void branch -> append-event.ts:126), and
        // `abandoned` is in the desk's own VOID_STATUSES. There is no
        // `void` status in the fixtures table — that word is the ENGINE's
        // vocabulary for the verdict, not the column's value.
        status: voidedExtKeys.has(g.extKey)
          ? "abandoned"
          : g.award !== undefined
            ? "forfeited"
            : "scheduled",
        // Every other outcome writer in this codebase uses tx.json(...), never
        // JSON.stringify — the latter double-encodes a jsonb column (the driver
        // then stores a JSON STRING SCALAR, not an object), so every reader
        // doing `outcome?.kind` / `outcome?.winner` silently saw undefined for
        // every generated bye. Found 2026-09-05, walkthrough gate 1 finding 1.
        // W2b C-5: a bye names its reason and no loser; F14's departed-qualifier walkover (both seats filled) is a
        // withdrawal's walkover, the same outcome the cascade records once the bracket exists.
        outcome: g.award !== undefined ? tx.json(generatedAward(g.award, home_entrant_id, away_entrant_id) as never) : null,
        // F1: the bracket ROLE the engine already computed (BracketFixtureGen
        // via bracketToGen) — always present with a concrete value (never
        // `undefined`) so every row in this batch insert shares one column
        // set; a non-bracket/single-lane fixture keeps lane null, same as
        // every row does today, so no existing render changes.
        lane: g.lane ?? null,
        is_final: g.isFinal === true,
        third_place: g.thirdPlace === true,
        conditional: g.conditional === true,
      };
    });
  if (newRows.length > 0) await tx`insert into fixtures ${tx(newRows)}`;
  for (const r of newRows) byKey.set(r.ext_key, r.id);
  // Loop R M-8 (R116-2's other door): F14's departed-qualifier walkover — an award over two seated sides, which a
  // withdrawal would record as `core.forfeit{by, "withdrew"}` once the bracket exists — shows that walkover's score
  // too, so "withdraw then generate" reads as "generate then withdraw" does. No event records it (nobody played,
  // X-PS-1): the award's state is written beside it, as `awardSeededByes` writes its own. A bye credits no score.
  for (const r of newRows) {
    if (r.status === "forfeited" && r.home_entrant_id !== null && r.away_entrant_id !== null) await writeAwardedMatchState(tx, r.id);
  }
  // Pair next reports seated shell rows as `created` for UI notices.
  const created = newRows.length + swissSeatedCount;
  const createdIds = newRows.map((r) => r.id);

  // 1b pass — cross-stage fill, through fillSlot (see viaFillSlot above).
  // Runs over the FULL `gen` (not just newRows): fillSlot's own
  // `and *_entrant_id is null` guard makes an already-filled fixture a
  // no-op, so a resumed/partial regeneration also fills anything a prior
  // run left open.
  if (viaFillSlot) {
    for (const g of gen) {
      if (g.award !== undefined) continue; // byes: see bakeDirect above
      const fixtureId = byKey.get(g.extKey);
      if (fixtureId === undefined) continue;
      if (g.home) await fillSlot(tx, fixtureId, 1, g.home);
      if (g.away) await fillSlot(tx, fixtureId, 2, g.away);
    }
  }

  // Second pass: feeds, batched per side. A target's homeFrom/awayFrom
  // becomes the SOURCE fixture's winner_to/loser_to (+slot 1=home, 2=away).
  const feedUpdates = { winner: [], loser: [] } as Record<
    "winner" | "loser",
    { source: string; target: string; slot: number }[]
  >;
  for (const g of gen) {
    const targetId = byKey.get(g.extKey);
    if (!targetId) continue;
    for (const [feed, slot] of [
      [g.homeFrom, 1],
      [g.awayFrom, 2],
    ] as const) {
      if (!feed) continue;
      const sourceId = byKey.get(feed.extKey);
      if (!sourceId) continue;
      feedUpdates[feed.side].push({ source: sourceId, target: targetId, slot });
    }
  }
  if (feedUpdates.winner.length > 0) {
    const u = feedUpdates.winner;
    await tx`
      update fixtures f
      set winner_to_fixture = v.target_id, winner_to_slot = v.slot
      from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                   unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                   unnest(${u.map((x) => x.slot)}::int[])    as slot) v
      where f.id = v.source_id and f.winner_to_fixture is null`;
  }
  if (feedUpdates.loser.length > 0) {
    const u = feedUpdates.loser;
    await tx`
      update fixtures f
      set loser_to_fixture = v.target_id, loser_to_slot = v.slot
      from (select unnest(${u.map((x) => x.source)}::uuid[]) as source_id,
                   unnest(${u.map((x) => x.target)}::uuid[]) as target_id,
                   unnest(${u.map((x) => x.slot)}::int[])    as slot) v
      where f.id = v.source_id and f.loser_to_fixture is null`;
  }

  // Third pass: propagate bye awards into their winner feeds (one lookup
  // for all byes, then one fill per slot side).
  // F14: a departed qualifier can still HOLD a structural bye — the draw is
  // preserved, so a top qualifier who withdrew keeps the bye line the
  // bracket gave them (the cascade leaves an already-settled bye alone for
  // the same reason). What must not happen is that bye carrying them into
  // the next round: propagating it would seat a withdrawn entrant in round
  // two, which is the very defect this change exists to close. The slot is
  // left open for the organiser instead.
  const awarded = gen.filter(
    (g) => g.award !== undefined && byKey.has(g.extKey) && !departedQualifiers.has(g.award),
  );
  if (awarded.length > 0) {
    const sources = await tx<
      { id: string; winner_to_fixture: string | null; winner_to_slot: number | null }[]
    >`
      select id, winner_to_fixture, winner_to_slot from fixtures
      where id in ${tx(awarded.map((g) => byKey.get(g.extKey)!))}`;
    const srcOf = new Map(sources.map((s) => [s.id, s]));
    const fills: Record<1 | 2, { fixture: string; entrant: string }[]> = { 1: [], 2: [] };
    for (const g of awarded) {
      const source = srcOf.get(byKey.get(g.extKey)!);
      if (source?.winner_to_fixture && (source.winner_to_slot === 1 || source.winner_to_slot === 2)) {
        fills[source.winner_to_slot].push({ fixture: source.winner_to_fixture, entrant: g.award! });
      }
    }
    // Invariant guard (P5 review finding): this is the ONE other
    // home/away_entrant_id writer in this file that bypasses fillSlot, so
    // unlike every other entrant-write here it does NOT clear a matching
    // *_slot_label. Verified harmless today only because a PLAIN
    // (non-`timing:"setup"`) stage's fixtures never carry a label to begin
    // with — only generateProgressionSetupFixtures' own third pass (above) stamps
    // one, and that path never reaches this bulk UPDATE. Nothing enforces
    // that stays true, so refuse loudly if it ever stops holding, rather
    // than silently filling the entrant and leaving the label stale
    // (which would make a filled slot render as if it were still TBD).
    if (fills[1].length > 0) {
      const stale = await tx<{ id: string }[]>`
        select id from fixtures
        where id in ${tx(fills[1].map((x) => x.fixture))} and home_slot_label is not null`;
      if (stale.length > 0) {
        throw new Error(
          `generateStageFixtures: bye-award bulk UPDATE would strand home_slot_label on fixture(s) ${stale.map((f) => f.id).join(",")} instead of clearing it (fillSlot's job) — this path is not supposed to be reachable with a label present`,
        );
      }
      await tx`
        update fixtures f
        set home_entrant_id = v.entrant_id
        from (select unnest(${fills[1].map((x) => x.fixture)}::uuid[]) as fixture_id,
                     unnest(${fills[1].map((x) => x.entrant)}::uuid[]) as entrant_id) v
        where f.id = v.fixture_id and f.home_entrant_id is null`;
    }
    if (fills[2].length > 0) {
      const stale = await tx<{ id: string }[]>`
        select id from fixtures
        where id in ${tx(fills[2].map((x) => x.fixture))} and away_slot_label is not null`;
      if (stale.length > 0) {
        throw new Error(
          `generateStageFixtures: bye-award bulk UPDATE would strand away_slot_label on fixture(s) ${stale.map((f) => f.id).join(",")} instead of clearing it (fillSlot's job) — this path is not supposed to be reachable with a label present`,
        );
      }
      await tx`
        update fixtures f
        set away_entrant_id = v.entrant_id
        from (select unnest(${fills[2].map((x) => x.fixture)}::uuid[]) as fixture_id,
                     unnest(${fills[2].map((x) => x.entrant)}::uuid[]) as entrant_id) v
        where f.id = v.fixture_id and f.away_entrant_id is null`;
    }
  }

  // The cascade (owner ruling 2026-09-21). The voids `walkoverDepartedQualifiers`
  // wrote above are dead feeders from the instant they are inserted, so a
  // seat they point at can already be actionable HERE — a structural bye
  // pushed its winner into the round above two blocks up, and if that seat's
  // other feeder is void the line is a walkover before anyone has played.
  // Everything not yet actionable is deliberately left alone; `onDecided`
  // picks it up at the moment the sibling feeder resolves.
  await resolveBracketSeats(tx, stageId);

  if (stage.status === "pending") {
    await tx`update stages set status = 'active' where id = ${stageId}`;
    // W2d X-TB-2 (OC2): the table rules are fixed in the transaction that starts the stage.
    await pinStageTableRules(tx, stageId);
  }

  const fixtures = await readStageFixtureRows(tx, stageId);
  // Cross-format feeds (Jul3/08 §4): winner_to/loser_to may target another
  // stage (CL loser → EL slot). Wire every entry whose source and target
  // both exist; the per-decided-fixture fillSlot then follows them like any
  // other feed.
  await wireCrossFeeds(tx, stage.division_id);

  // Undoable generation (Jul3/03 §3): the ledger records which fixtures this
  // pass created so undo can remove exactly them (results-guarded).
  // `fixture_ids` IS that Undo contract — undo DELETEs every id in it — so a
  // Swiss seat's ids (UPDATEd shells that already existed) ride separately
  // in `seated_fixture_ids`, which Undo of Pair next reads to put exactly
  // those rows back onto their shells (W3 T5, history.ts `stepWrite`).
  if (created > 0 && ledger === "record") {
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload)
      values (${stage.division_id}, ${last + 1}, 'fixtures_generated',
              ${tx.json({ stage_id: stageId, fixture_ids: createdIds, ...(swissAudit ?? {}), ...(knockoutDrawSeed !== null ? { draw_seed: knockoutDrawSeed } : {}) } as never)})`;
    await tx`update divisions set seq = ${last + 1}, edit_watermark = null
             where id = ${stage.division_id}`;
  }
  const [division] = await tx<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${stage.division_id}`;
  return {
    outcome: {
      created,
      existing: gen.length - newRows.length,
      fixtures,
      ...(swissReshaped ? { reshaped: swissReshaped } : {}),
      ...(swissRoundsWarn ? { swiss_rounds: swissRoundsWarn } : {}),
      ...(swissNext ? { swiss_next_round: swissNext.verdict, swiss_paired_round: swissNext.round } : {}),
    },
    divisionId: stage.division_id,
    competitionId: division!.competition_id,
    kind: stage.kind,
    ...(ledger === "step" ? { ledgerPayload: { fixture_ids: createdIds, ...(swissAudit ?? {}) } } : {}),
  };
}

/** W4 T4 (K3, X-RB-1): a knockout line's role key (`bracketRoleKey`), counted back from ITS bracket's final. The final
 *  is read on first use, so a side with no rows (nothing generated) never asks; a side with rows and no final refuses by
 *  name (`BracketHasNoFinalError`), which rolls the Rebuild back. */
function roleKeyOf(rows: readonly BracketRoleRow[]): (row: BracketRoleRow) => string {
  let finalRound: number | undefined;
  return (row) => bracketRoleKey(row, (finalRound ??= finalRoundOf(rows)));
}

/** The kinds a Rebuild carries by bracket role (`roleKeyOf`): a knockout (W4 T4, K3), and a stepladder and a page playoff
 *  (T26c), whose `round_no` also counts from the first round, so a stepladder that gains a rung moves its final to a new
 *  round. A page playoff is always the same four lines, so for it role and position are the SAME key (an equivalent member,
 *  kept as defence in depth: removing it changes no Rebuild today, and the T26c review measured that mutant surviving). A
 *  double elimination still carries by position: its lanes need their own role keys (owed to W6, W6-double-elim.md). */
const ROLE_CARRY_KINDS: ReadonlySet<string> = new Set(["knockout", "stepladder", "page_playoff"]);

/**
 * Rebuild's delete-and-regenerate, in the CALLER's transaction (W4 T8: extracted unchanged so a knockout's Generate can
 * regenerate when the bracket crosses a power of two — `reconcileKnockoutGenerate`). Takes the division lock, refuses a
 * frozen division, a played or called line, an online game and a match's own format, cancels the boards' invites,
 * deletes the stage's fixtures, generates afresh (`generateStageFixturesTx`, its ledger row included), and carries each
 * old slot to the line that inherits it (a knockout, a stepladder and a page playoff by bracket ROLE — `ROLE_CARRY_KINDS`
 * — every other kind by position). `stage` is the row
 * the caller read. Returns the write, the deleted ids and the slot counts; the caller publishes after its commit.
 */
export async function regenerateStageInTx(
  tx: Tx,
  auth: AuthCtx,
  stageId: string,
  stage: { division_id: string; kind: string },
): Promise<{ generated: GenerateWrite; removedIds: string[]; slots: { kept: number; freed: number; unscheduled: number } }> {
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
  // A frozen division refuses the rebuild — the same predicate as generate's
  // pre-flight, read here under the lock. Strictly wider than the
  // `clearScheduleScoped` the freeze already refuses: this HARD-DELETES
  // every fixture on the stage, cascading into score_events, match_states,
  // match_reports, lineups, official_marks, fixture_officials and
  // device_links (see the guard's own comment below). Refused before the
  // delete, so `stages-schedule-lock.test.ts`'s `fixtureCount` assertion
  // reads an untouched board.
  const lockState = await divisionLockState(tx, stage.division_id);
  if (lockState.frozen) {
    throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
  }

  // Never destroy a real result (hard constraint 1). Mirrors deleteStage's
  // guard above (same three statuses), with one refinement for 'forfeited'.
  // The status alone covers three different rows: a generation-time BYE
  // (one side null by construction), the generator's own F14 walkover for a
  // qualifier who departed before the draw (both seats filled, nothing
  // played), and a WALKOVER RECORDED IN PLAY (withdrawal.ts's core.forfeit
  // — append-event.ts maps it to this same status). Only the last holds a
  // result, and it is the only one with evidence: its core.forfeit is a
  // score event. So a 'forfeited' fixture blocks through its evidence
  // alone (review 3 of #857, N2, owner ruling), never through its status.
  // Status alone is NOT a sufficient test, because `delete from fixtures`
  // CASCADEs into score_events, match_states, match_reports, lineups,
  // official_marks, fixture_officials and device_links, and SET NULLs
  // suspensions.fixture_id. Two holes a status-only guard leaves:
  //   - 'abandoned' is a match that was PLAYED and stopped. match-reports.ts
  //     (:40 REPORTABLE) accepts a report on exactly this status, so a
  //     status-only guard deletes the report along with the fixture.
  //   - any fixture carrying evidence rows under a status this list does not
  //     name — the scoring pad writes score_events/match_states, and nothing
  //     here should depend on WHEN a status flips relative to the first
  //     event landing.
  // So block on the evidence itself as well as on status: if a fixture has
  // anything recorded against it, it is not ours to delete.
  //
  // What this deliberately does NOT block on (F3 ultrareview finding 5):
  // `lineups`, `fixture_officials` and `device_links` also CASCADE away
  // with the fixtures, but they are organiser SETUP, not a result. An
  // organiser who has already appointed referees is the one most likely to
  // need a rebuild before match day, so blocking would disable the feature
  // exactly when it earns its keep. Destroying them silently is equally
  // wrong, so `getStageRosterDrift` counts all three and the confirm
  // dialog names them before the click (progression.rosterDrift.confirm*).
  // If a future table holds real RESULT data, it belongs in the guard
  // below, not in that count.
  //
  // One latent trapdoor, checked and currently INERT (2026-08-19): fixtures
  // .parent_fixture_id is a self-FK declared ON DELETE CASCADE (V214:18), so
  // a fixture that is someone's parent takes its children with it. Nothing
  // in apps/web writes that column today (zero rows), and its only intended
  // use — table-tennis rubbers under a tie (sports/setbased/tabletennis.ts)
  // — is same-stage, where taking the children with the parent is correct.
  // If a writer ever creates CROSS-STAGE parent links, this delete would
  // silently remove another stage's board and the guard below would not see
  // it. Note the cascade RECURSES on a self-FK: a chain deeper than one
  // level takes the whole subtree, not just direct children, so the blast
  // radius is not bounded at one hop. Verify with
  //   select count(*) from fixtures c join fixtures p
  //     on c.parent_fixture_id = p.id where c.stage_id <> p.stage_id;
  // (fixtures.court_id is RESTRICT but points OUT at courts, so it
  // constrains deleting a COURT, never this delete.)
  // NARROWED 2026-09-21 (the cascade). `abandoned` used to block on its own.
  // That was written for a match that was PLAYED and stopped, and it is now
  // ALSO the value the generator's own void writes (walkoverDepartedQualifiers,
  // re-review C2) — so from the instant a departed pairing was voided at
  // generation the stage became permanently un-rebuildable, and the organiser
  // pressing "Rebuild fixtures" on a board nobody had played was told
  // "this stage already has recorded results". Driven in a browser; the
  // sentence on screen was false, which is worse than a control that does
  // nothing.
  //
  // A generation-time void has no outcome, no score events, no match report
  // and no config snapshot — it is a line the regenerate would draw again
  // identically. A real abandonment has at least the `core.abandon` event
  // that produced the status, and a cricket-style no-result carries an
  // outcome; both still block, the first through `fixtureEvidenceSql` below
  // and the second through the `outcome is not null` clause. That split is
  // what `dead-feeder-cascade.test.ts`'s two CONTROL cases pin, one per
  // side.
  //
  // The evidence-table list itself lives in `fixtureEvidenceSql` — ONE
  // literal, shared with `unpairSwissRound`'s guard, because the
  // 2026-09-20 review found Unpair shipping a SUBSET of this list and
  // destroying real results through the gap. Only the status clause is
  // per-caller. (`config_snapshot is not null` joins the list there; it is
  // implied by `exists(score_events)` for this guard — nothing in apps/web
  // ever deletes a score event — so it adds no refusal here, only
  // monotonicity where status is unreliable.)
  //
  // This guard's status clause and evidence are `fixtureHasResultSql`,
  // which history reads as its played set (review 2 of #857, I3), so what
  // rebuild refuses for a RESULT history never deletes. Since W4 T2 the
  // guard's whole set is wider — results ∪ a live Match Day call (below) —
  // while history's `unplayed` is still results only. That gap is
  // unreachable today, not closed: a call appends a `schedule_edited` ledger
  // row (match-day-call.ts), so Undo inverts the call (moving the match off
  // the called slot) before it can reach a Generate's `fixtures_cleared`
  // (B1a review #3). A call that wrote no ledger row would open it. A walkover
  // blocks only through its evidence (review 3 of #857, N2): the one a
  // scorer records posts `core.forfeit`; the generator's F14 walkover has
  // nothing played behind it, so a stage holding one rebuilds.
  //
  // W4 T2 (K4, X-LE-9; owner ruling 257): a live Match Day call refuses too. A call writes a court and a time and no
  // status or event, so nothing above sees it, and the delete cascades into `fixture_calls` (V484) — the players
  // standing at the court would lose their match and its call. Only the call arm of the one "started" predicate
  // (`fixtureCalledSql`, fixture-started-sql.ts): its online-game arm is refused below by name (ONLINE_GAME_EXISTS, and
  // a bridge row with no game rebuilds, M-10), and its decided arm would refuse the F14 walkover N2 keeps rebuildable.
  const [blocked] = await tx<{ id: string }[]>`
    select f.id from fixtures f
    where f.stage_id = ${stageId} and (${fixtureHasResultSql(tx)} or ${fixtureCalledSql(tx)})
    limit 1`;
  if (blocked) {
    throw new HttpError(
      409,
      "this stage has fixtures with a recorded result — rebuild refuses to touch a stage that has already been played, even partly; complete it as it stands, or use Generate to add missing entrants without disturbing what's already been decided",
      "STAGE_HAS_RESULTS",
    );
  }

  // The delete CASCADEs into fixture_external_play, and no result guard
  // above can see an online game in progress (online chess appends nothing
  // until the result). A board a game stands behind refuses the rebuild,
  // under the same lock order as the Swiss seat clear (review M8).
  const stageFixtureIds = (
    await tx<{ id: string }[]>`select id from fixtures where stage_id = ${stageId}`
  ).map((r) => r.id);
  await lockBoardsRefusingOnlineGames(tx, stageFixtureIds);
  // W2c Task 14: a match's own format would be regenerated away with its row — refused by name instead.
  await refuseOwnFormatLoss(tx, tx`stage_id = ${stageId}`);
  // Phase 3 wave 1 (G-1): the boards go, and their queued invites with them - after every refusal above, before the delete. The
  // rebuilt boards are new fixtures with new ids, so an invite left queued would mail a board that no longer exists.
  await cancelBoardInvites(tx, stageFixtureIds, FIXTURE_DELETED_REASON);
  // X-RB-1: the slots the delete is about to take, read before it — with what `isByeLine` reads (W4 T4).
  const before = await tx<
    ({
      pool_id: string | null;
      round_no: number;
      seq_in_round: number;
      scheduled_at: Date | null;
      court_id: string | null;
      venue_id: string | null;
      schedule_locked: boolean;
    } & ByeLineRow)[]
  >`
    select pool_id, round_no, seq_in_round, ext_key, scheduled_at, court_id, venue_id, schedule_locked,
           status, outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
    from fixtures where stage_id = ${stageId}
    order by pool_id nulls first, round_no, seq_in_round, created_at, id`;
  const deleted = await tx<{ id: string }[]>`
    delete from fixtures where stage_id = ${stageId} returning id`;

  const generated = await generateStageFixturesTx(tx, auth, stageId, {});

  // W4 T4 (K3, X-RB-1): a bye line neither gives nor takes a slot (`isByeLine`, every kind), and a knockout carries by
  // bracket ROLE — its `round_no` counts from the first round, so by position an 8 → 9 Rebuild handed the final's
  // slot to a semi-final. Each side is keyed against its own final. Every other kind keeps the position.
  const oldRows = before.map((r) => ({
    pool_id: r.pool_id,
    round_no: r.round_no,
    seq_in_round: r.seq_in_round,
    ext_key: r.ext_key,
    scheduled_at: r.scheduled_at === null ? null : r.scheduled_at.toISOString(),
    court_id: r.court_id,
    venue_id: r.venue_id,
    schedule_locked: r.schedule_locked,
    bye: isByeLine(r),
  }));
  const newRows = generated.outcome.fixtures.map((f) => ({
    id: f.id,
    pool_id: f.pool_id,
    round_no: f.round_no,
    seq_in_round: f.seq_in_round,
    ext_key: f.ext_key ?? null,
    bye: isByeLine({ ...f, ext_key: f.ext_key ?? null }),
  }));
  const carry = carrySlots(
    oldRows,
    newRows,
    ROLE_CARRY_KINDS.has(stage.kind) ? { before: roleKeyOf(oldRows), after: roleKeyOf(newRows) } : undefined,
  );
  const carried = [...carry.assign];
  if (carried.length > 0) {
    // ONE update for every carried slot, batched the way this file batches
    // its feed writes: a row of parallel arrays per column. The pins travel as
    // `text[]` and are cast per element: postgres.js sends a JS boolean
    // array typed as a scalar `bool` (refused as `boolean[]`), and a string
    // array cast to `boolean[]` is serialised with the bool serializer,
    // which reads every "true" as false.
    await tx`
      update fixtures f set
        scheduled_at = v.scheduled_at,
        court_id = v.court_id,
        venue_id = v.venue_id,
        schedule_locked = v.schedule_locked
      from (select unnest(${carried.map(([id]) => id)}::uuid[])                        as id,
                   unnest(${carried.map(([, s]) => s.scheduled_at)}::timestamptz[])    as scheduled_at,
                   unnest(${carried.map(([, s]) => s.court_id)}::uuid[])               as court_id,
                   unnest(${carried.map(([, s]) => s.venue_id)}::uuid[])               as venue_id,
                   unnest(${carried.map(([, s]) => String(s.schedule_locked))}::text[])::boolean as schedule_locked) v
      where f.id = v.id and f.stage_id = ${stageId}`;
  }
  const fixtures = carried.length > 0 ? await readStageFixtureRows(tx, stageId) : generated.outcome.fixtures;

  return {
    generated: { ...generated, outcome: { ...generated.outcome, fixtures } },
    removedIds: deleted.map((row) => row.id),
    slots: carriedSlotCounts(carry),
  };
}

interface CrossFeed {
  from_ext_key: string;
  side: "winner" | "loser";
  to_stage_seq: number;
  to_ext_key: string;
  slot: 1 | 2;
}

/** Wire every declared `cross_feeds` edge whose source and target both exist,
 *  filling NULL edges only — so it is safe to re-run at any time. Also called
 *  by history.ts `restoreFixtures`: an undo's delete SET NULLs the edges into
 *  the rows it removes, and restoring them re-derives the declared ones. */
export async function wireCrossFeeds(tx: Tx, divisionId: string): Promise<void> {
  const stages = await tx<{ id: string; seq: number; config: Record<string, unknown> }[]>`
    select id, seq, config from stages where division_id = ${divisionId}`;
  const bySeq = new Map(stages.map((s) => [s.seq, s]));
  for (const stage of stages) {
    const feeds = stage.config.cross_feeds as CrossFeed[] | undefined;
    if (!Array.isArray(feeds)) continue;
    for (const feed of feeds) {
      const target = bySeq.get(feed.to_stage_seq);
      if (!target) continue;
      const [source] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${stage.id} and ext_key = ${feed.from_ext_key}`;
      const [dest] = await tx<{ id: string }[]>`
        select id from fixtures where stage_id = ${target.id} and ext_key = ${feed.to_ext_key}`;
      if (!source || !dest) continue; // wired once both stages generated
      if (feed.side === "winner") {
        await tx`update fixtures set winner_to_fixture = ${dest.id}, winner_to_slot = ${feed.slot}
                 where id = ${source.id} and winner_to_fixture is null`;
      } else {
        await tx`update fixtures set loser_to_fixture = ${dest.id}, loser_to_slot = ${feed.slot}
                 where id = ${source.id} and loser_to_fixture is null`;
      }
    }
  }
}