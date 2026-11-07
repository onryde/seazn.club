import "server-only";
// The public generate/rebuild doors: write, commit-and-revalidate, Unpublished,
// and the roster-driven rebuild.

import { createHash } from "node:crypto";
import { withTenant, type Tx } from "@/lib/db";
import { isSwissBoardSeated, latestSwissRoundWithAnySeat, nextUnseatedSwissRound, swissRoundHasPlayedResult } from "@/lib/swiss-shell";
import { HttpError } from "@/lib/errors";
import { ROSTER_DRIFT_INELIGIBLE_KINDS } from "@/lib/roster-drift-eligibility";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { EngineError } from "@seazn/engine/core";
import type { ProgressionSpec } from "@seazn/engine/competition";
import { SWISS_PAIRING_NOT_SWISS_CODE, SWISS_PAIRING_NOT_SWISS_MESSAGE } from "@/lib/swiss-pairing";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { afterScheduleWrite, divisionLockState } from "../schedule";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import {
  STAGE_COLS,
  type StageRow,
  type SwissExistingFixture,
  type GenerateOutcome,
  type GenerateWrite,
  type GenerateOptions,
  type SealedSetupCounts,
} from "./types";
import { fireStageRevalidate, refoldStageTable } from "./helpers";
import { refuseFormatTooSmall, swissActiveEntrants } from "./swiss-gen";
import { sealedStageSetupCounts } from "./roster-drift";
import { generateProgressionSetupFixtures } from "./setup-fixtures";
import { generateStageFixturesTx, regenerateStageInTx } from "./generate-tx";
import { seedNextStage } from "./carry-over";

/** R10e (review-r10d m1): generate a stage's fixtures and publish the write.
 *  New fixtures change the hub (their kick-offs and courts), so the hub key
 *  drops in one DEL after the commit and the division push follows it
 *  (`afterScheduleWrite`). A generate deletes nothing, so it names no fixture
 *  key and sends no fixture push: every id it created is new, and nobody can
 *  be watching a match centre for it. A generate that created nothing sends
 *  nothing.
 *
 *  Callers that publish their own write use `generateStageFixturesUnpublished`
 *  instead: `startDivision` (one publish naming every fixture of the division)
 *  and `completeStage` (R10g: it publishes the whole completion, the draw
 *  included, once in its own `finally`, unless scoring's auto-advance opts
 *  out because scoring's post-commit `finally` publishes).
 *  `rebuildStageFixtures` runs `generateStageFixturesTx` inside its own
 *  transaction and publishes once, naming the fixtures it deleted (W3 T1). */
export async function generateStageFixtures(
  auth: AuthCtx,
  stageId: string,
  opts: GenerateOptions = {},
): Promise<GenerateOutcome> {
  const write = await generateStageFixturesWrite(auth, stageId, opts);
  // W4 T8: a knockout reconcile in place creates nothing yet changes seats, and a regenerate deletes the old lines — both
  // publish, naming the fixtures they changed or deleted.
  const changed = write.changedFixtureIds ?? [];
  if (write.outcome.created > 0 || changed.length > 0) {
    afterScheduleWrite(write.divisionId, write.competitionId, "schedule", changed);
  }
  return write.outcome;
}

/** `generateStageFixtures` without its publish, for a caller that publishes
 *  the whole write itself (see above). */
export async function generateStageFixturesUnpublished(
  auth: AuthCtx,
  stageId: string,
  opts: GenerateOptions = {},
): Promise<GenerateOutcome> {
  return (await generateStageFixturesWrite(auth, stageId, opts)).outcome;
}

async function generateStageFixturesWrite(
  auth: AuthCtx,
  stageId: string,
  opts: GenerateOptions,
): Promise<GenerateWrite> {
  // A qualification stage must draw from the previous stage's final table
  // (config.qualified), never from the whole entrant list. If it isn't seeded
  // yet: seed it now when the previous stage is complete (stage added after
  // the fact), otherwise refuse — generating early would bracket everyone.
  //
  // F2 (Decision 1) — a `timing: "setup"` progression is a DIFFERENT
  // mechanism (see stage-seeding.ts) — it generates fully-TBD placeholder
  // fixtures at division SETUP time, with NO wait on its source stage's
  // completion (owner ruling: "ALL stages' fixtures are generated at setup
  // time with placeholder slots"), so it short-circuits before this gate
  // rather than going through it. `timing: "on_complete"` reproduces the OLD
  // `.qualification` behaviour exactly.
  // W4 B2 fr2 carry: whether this Generate can REDRAW a root knockout that already has its lines — the one path that reads
  // the sealed setup counts (`reconcileKnockoutGenerate`). Set in the pre-flight below, from the same shape test that
  // routes to that path (`generateStageFixturesTx`); every other Generate — a Swiss, a league, a first draw — never
  // opens the privileged read, so a failure there cannot stop it.
  let readsSealedSetup = false;
  {
    const pre = await withTenant(auth.orgId, async (tx) => {
      // T26c (I1, round-trip budget): whether the division holds a FED page playoff - the one size gate a non-knockout root
      // answers to - and the division's status, read in this same statement, so a root whose division has no page playoff
      // pays no extra round trip for the gate below (generate-roundtrips.test.ts pins the budget).
      const [stage] = await tx<(StageRow & { fed_page_playoff: boolean; division_status: string | null })[]>`
        select ${tx(STAGE_COLS)},
               exists (select 1 from stages p
                        where p.division_id = stages.division_id and p.kind = 'page_playoff' and p.progression is not null)
                 as fed_page_playoff,
               (select d.status from divisions d where d.id = stages.division_id) as division_status
          from stages where id = ${stageId}`;
      if (!stage) throw new HttpError(404, "stage not found");
      // A pairing mode means nothing off a Swiss stage. Refused HERE, in the
      // pre-flight, because both paths below that leave this block early
      // (`timing: "setup"`, `seedNextStage`) write before the main transaction.
      if (opts.pairing !== undefined && stage.kind !== "swiss") {
        throw new HttpError(422, SWISS_PAIRING_NOT_SWISS_MESSAGE, SWISS_PAIRING_NOT_SWISS_CODE);
      }
      // Generating a stage's fixtures IS writing the timetable — the widest
      // schedule write there is — so a frozen division refuses it.
      //
      // `startDivision` (schedule/publish.ts) already refuses on this exact predicate
      // immediately before its own call to this function, and history.ts's
      // undo/redo refuses far earlier in the same call, so neither of them can
      // reach this guard and neither changes behaviour. What could not refuse
      // was the ROUTE — `POST /api/v1/stages/{id}/generate` calls this
      // directly, at the same `requireResourceAuth(..., "write")`, bypassing
      // `startDivision` entirely. An organiser who could not Start a frozen
      // empty board could simply press Generate instead, which is the same
      // walk-around shape #230 item 2 found on the publish gate.
      //
      // HERE, in the pre-flight block, rather than in the write transaction
      // below: two of this function's paths never reach that transaction —
      // a `timing: "setup"` progression short-circuits into
      // `generateProgressionSetupFixtures`, and an `on_complete` one runs
      // `seedNextStage` first. Both write fixtures. A guard in the main
      // transaction would leave both unrefused.
      //
      // AFTER the existence check: `divisionLockState` reads a missing row as
      // `frozen: false`, so an unknown stage id must still 404 here rather
      // than depend on a lock state there is no row to read.
      const lockState = await divisionLockState(tx, stage.division_id);
      if (lockState.frozen) {
        throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
      }
      const rootKnockout = stage.kind === "knockout" && stage.progression === null;
      const drawn = rootKnockout && (await tx`select 1 from fixtures where stage_id = ${stageId} limit 1`).length > 0;
      readsSealedSetup = drawn && !Array.isArray(stage.config.qualified);
      // W4 T15 (X-PL-1, X-QM-5): a root knockout about to be drawn, or redrawn before Start, on a field its format cannot play. A
      // bracket drawn and started is left out: after Start a withdrawal is the bracket's to settle, and this Generate reshapes nothing.
      if (rootKnockout) {
        const [division] = await tx<{ status: string }[]>`select status from divisions where id = ${stage.division_id}`;
        if (!drawn || division?.status !== "active") await refuseFormatTooSmall(tx, stage.division_id);
      } else if (stage.progression === null && stage.fed_page_playoff && stage.division_status !== "active") {
        // T26c fix round 1 (I1): any other ROOT before Start, in a division with a fed page playoff. A league or a Swiss that
        // feeds a page playoff is that format's source, as a root knockout is a plate's, so a group_playoffs or swiss_playoff of
        // three is refused by name here too, never drawn and laid out with a fourth seat no stage can fill. After Start the field
        // is the bracket's to settle. Only a fed page playoff gates a non-knockout root (a guard in
        // lib/__tests__/format-size-gates.test.ts sweeps the templates for any other), so no other root pays for the gate.
        await refuseFormatTooSmall(tx, stage.division_id);
      }
      if (!stage.progression) return null;
      const progression = stage.progression as unknown as ProgressionSpec & { timing: "setup" | "on_complete" };
      if (progression.timing === "setup") return { seeded: true as const };
      if (Array.isArray(stage.config.qualified)) return null;
      const [prev] = await tx<{ id: string; status: string }[]>`
        select id, status from stages
        where division_id = ${stage.division_id} and seq < ${stage.seq}
        order by seq desc limit 1`;
      return prev ? { seeded: false as const, prev } : null;
    });
    if (pre?.seeded) {
      const write = await generateProgressionSetupFixtures(auth, stageId);
      // No refold here (W2d concern 2 ruling): a `timing: "setup"` stage's fixtures are placeholders that name no
      // entrant, so its fold has no row — there is no table to show until the seeding fills the seats, never a table of
      // placeholders. The seeding that fills them refolds (`confirmSeedProposal` → `refoldStageTable`).
      const outcome = write.outcome;
      await fireStageRevalidate(auth.orgId, stageId);
      if (outcome.created > 0) {
        await captureServer({
          event: EVENTS.SCHEDULE_GENERATED,
          distinctId: auth.userId ?? `org:${auth.orgId}`,
          orgId: auth.orgId,
          properties: { stage_id: stageId, fixtures_created: outcome.created },
        });
      }
      return write;
    }
    if (pre) {
      if (pre.prev.status !== "complete") {
        throw new EngineError(
          "STAGE_NOT_READY",
          "this stage draws its entrants from the previous stage's final table — complete the previous stage first",
          // `reason` is what the v1 envelope forwards on (api-v1/http.ts), so
          // the desk can name both stages in an amber notice.
          { stageId, previousStageId: pre.prev.id, reason: "previous_stage_incomplete" },
        );
      }
      await seedNextStage(auth, pre.prev.id);
    }
  }
  // W4 B2 fix round 2 (item 5): a knockout's redraw refuses over organiser setup, and two kinds of it live in sealed tables
  // the tenant role cannot read. The prelude reads them on this transaction's own connection, before the role drops —
  // never a pooled read inside the transaction (lib/db.ts's nesting deadlock).
  let sealedSetup: SealedSetupCounts | undefined;
  const write = await withTenant(
    auth.orgId,
    (tx) => generateStageFixturesTx(tx, auth, stageId, { ...opts, sealedSetup }),
    readsSealedSetup
      ? { privilegedPrelude: async (tx) => { sealedSetup = await sealedStageSetupCounts(tx, auth.orgId, stageId); } }
      : {},
  );
  await afterGenerateCommit(auth, stageId, write);
  return write;
}

/** What follows a committed generate, outside its transaction: the table refold, the public-page revalidation and the
 *  activation event. Shared by `generateStageFixturesWrite` and `rebuildStageFixtures`, which commits its own
 *  delete-and-regenerate in one transaction and then does exactly this (W3 T1, X-RB-1). */
export async function afterGenerateCommit(auth: AuthCtx, stageId: string, write: GenerateWrite): Promise<void> {
  const outcome = write.outcome;
  // W2d concern 2 (spec §5.7, anti-goal 3; owner 2026-10-27): a table stage's table exists from the generate that
  // created its fixtures — LEVEL, every rank "–", no leader — so a visitor sees the table the organiser's Standings read
  // would otherwise write lazily (`getStandings`), never "No standings yet" for the same state. `created` counts a Swiss
  // seating too, so Pair next still refolds the bye awards it seats without score_events (same snapshot trap as Unpair:
  // the bye win shows at once, Finn/Gus). The kind gate and the empty-fold rule are `refoldStageTable`'s.
  if (outcome.created > 0) await refoldStageTable(auth.orgId, { id: stageId, kind: write.kind }, "skip");
  await fireStageRevalidate(auth.orgId, stageId);
  // Activation funnel (feature 1): fixtures exist → the tournament is playable.
  if (outcome.created > 0) {
    await captureServer({
      event: EVENTS.SCHEDULE_GENERATED,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { stage_id: stageId, fixtures_created: outcome.created },
    });
  }
}

export interface RebuildOutcome extends GenerateOutcome {
  /** Fixtures deleted before regenerating (0 only when the stage had none). */
  removed: number;
  /** W3 T1 (X-RB-1): what became of the stage's slots (`carrySlots`; a slot is a time, a court, a venue or a pin —
   *  `holdsSlot`). `kept` — slots a rebuilt fixture inherited at its old position (a shrinking Swiss round keeps the
   *  boards `chooseDoomedBoards` keeps); `freed` — slots no rebuilt fixture inherits; `unscheduled` — rebuilt fixtures
   *  at a new position with nothing to inherit, counted only when the stage had a layout. */
  slots: { kept: number; freed: number; unscheduled: number };
}

/**
 * Replace a root stage's fixtures wholesale — the fix for the defect the
 * roster-drift signal surfaces: `generateStageFixtures` is additive only
 * (idempotent via `fixtures.ext_key`, doc comment above), so a withdrawn
 * entrant's name never comes off the board on its own (F3 Task 5 plan,
 * "The defect this uncovers").
 *
 * ONE transaction (W3 T1, X-RB-1; #840, FX-G13). The delete and the regenerate
 * (`generateStageFixturesTx`, the very body `generateStageFixtures` runs, so
 * every invariant it holds — ext_key stability, feed rewiring, slot labels,
 * the division-events ledger — applies to the rebuild for free) commit or roll
 * back together. This used to be two transactions, the delete committing
 * first, so a regenerate that threw left the organiser an EMPTY stage; now the
 * old board survives any refusal with its times and courts. And the rebuilt
 * fixtures inherit those times and courts by POSITION — `(pool, round, seq)`,
 * `carrySlots`; a shrinking Swiss round keeps the boards `chooseDoomedBoards`
 * keeps, the pre-Start reshape's own order — instead of every one of them
 * being wiped (#840). Only the
 * work that has always followed a commit (the publish, the table refold, the
 * revalidation, analytics) runs after it.
 *
 * Refuses outright — never a partial rebuild (owner ruling, plan 5b) — the
 * moment ANY fixture in the stage carries a real result: a partial rebuild
 * would silently change who plays whom in a stage that's already half
 * played, which is unrecoverable once the organiser has acted on it.
 *
 * Generate's pre-flight is NOT run here, and need not be: its pairing refusal
 * has nothing to refuse (Rebuild sends no pairing), its progression branches
 * (`timing: "setup"`, `seedNextStage`) are unreachable past `STAGE_NOT_ROOT`
 * below, and its frozen-division refusal is restated below on the same
 * predicate, under the lock.
 */
export async function rebuildStageFixtures(auth: AuthCtx, stageId: string): Promise<RebuildOutcome> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<
      { division_id: string; kind: string; progression: Record<string, unknown> | null }[]
    >`select division_id, kind, progression from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    // A root stage that carries `config.qualified` is NOT refused here: for a
    // stage with no progression, Generate's pre-flight returns before it ever
    // reads that list, so Generate and this regenerate draw from it alike —
    // and the generator's own voids on such a board are what
    // dead-feeder-cascade.test.ts and departed-qualifier-walkover.test.ts
    // rebuild on purpose.
    if (stage.progression !== null || ROSTER_DRIFT_INELIGIBLE_KINDS.has(stage.kind)) {
      throw new HttpError(
        422,
        "rebuild only applies to a stage that draws its fixtures directly from the active roster — a stage with a progression rule, a ladder stage, or an americano stage is not eligible",
        "STAGE_NOT_ROOT",
      );
    }
    await refuseFormatTooSmall(tx, stage.division_id);
    const regen = await regenerateStageInTx(tx, auth, stageId, stage);
    // W4 T11 (X-LE-10): Rebuild draws every active entrant, so nobody waits on this stage any more — the late players the
    // desk flagged are in the new bracket, and the flag goes with them.
    await tx`update entrants set knockout_waiting_stage_id = null where knockout_waiting_stage_id = ${stageId}`;
    return regen;
  });

  // After the commit, and only after it. A refusal anywhere above rolled the
  // whole rebuild back, so the board everyone sees has not changed and there
  // is nothing to publish (R10e, review-r10d m1: ONE publish, naming the
  // fixtures the delete removed — their match centres refetch and find them
  // gone — and never the ids the regenerate created).
  // In `finally`, as before: the rebuild has committed, so even a failed
  // refold must not leave the hub showing the deleted board.
  const outcome = write.generated.outcome;
  try {
    await afterGenerateCommit(auth, stageId, write.generated);
    log.info(
      { event: "stage_fixtures_rebuilt", stageId, removed: write.removedIds.length, created: outcome.created, slots: write.slots },
      "stage_fixtures_rebuilt",
    );
  } finally {
    if (write.removedIds.length > 0 || outcome.created > 0) {
      afterScheduleWrite(write.generated.divisionId, write.generated.competitionId, "schedule", write.removedIds);
    }
  }
  return { ...outcome, removed: write.removedIds.length, slots: write.slots };
}
// ---------------------------------------------------------------------------
// MD-1 Task 5 (Match Day spec §7, Review Focus 4): the next Swiss round, previewed for an approval on the phone and then
// paired against a stale check. The preview IS the desk's Pair next (`generateStageFixturesTx`), run in a transaction
// that is rolled back; the pair is the same Generate, run for real, once the inputs the preview saw are still the inputs.

/** The refusal codes the approval answers (globals: `{error: {code}}`, both 409). */
export const MD_STALE_CODE = "MD_STALE";
export const MD_ALREADY_CODE = "MD_ALREADY";

/** One pairing of a previewed round: `away` is null on the bye. `board` is the board's place in its round. */
export interface SwissPreviewPairing {
  home: string;
  away: string | null;
  board: number;
}

export interface SwissRoundPreview {
  round: number;
  pairings: SwissPreviewPairing[];
  /** `swissInputHash` of the state the preview was drawn from: the token the approve hands back. */
  inputHash: string;
}

/** The rollback a preview ends in, carrying its answer out of the transaction (the `FormatChangeDryRun` pattern). */
class SwissPreviewRollback extends Error {
  constructor(readonly preview: SwissRoundPreview) {
    super("swiss preview rollback");
  }
}

/**
 * The INPUTS of the next Swiss round, as one sha256 (hex): the stage's fixtures in id order, each by id, status and
 * result version (its score ledger's head `seq`, and its stored outcome, which a bye award or a decision written off the
 * ledger moves), and the division's active entrants as the Swiss reads them (`swissActiveEntrants`: id, seed and first
 * round), in id order.
 *
 * It NEVER hashes the drawn pairings (Review Focus 4), nor any seat: a round whose pairing takes a drawing of lots draws
 * them again at the pair (the preview's draw was rolled back), and a hash over the pairings would refuse every such
 * approve as stale. Read it under the division lock, so it describes the state the Generate after it pairs.
 */
export async function swissInputHash(tx: Tx, stageId: string): Promise<string> {
  const [stage] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  const fixtures = await tx<{ id: string; status: string; ledger_head: number; outcome: string | null }[]>`
    select f.id, f.status,
           coalesce((select max(se.seq) from score_events se where se.fixture_id = f.id), 0)::int as ledger_head,
           f.outcome::text as outcome
      from fixtures f
     where f.stage_id = ${stageId}
     order by f.id`;
  const entrants = [...(await swissActiveEntrants(tx, stage.division_id, stageId))].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const material = {
    v: 1,
    fixtures: fixtures.map((f) => [f.id, f.status, f.ledger_head, f.outcome]),
    entrants: entrants.map((e) => [e.id, e.seed, e.swiss_first_round]),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * The Swiss stage an approval acts on, read and locked in the caller's transaction: 404 for a missing stage (RLS makes
 * another org's one missing), 422 for a stage that is not a Swiss, and the generate pre-flight's own refusals that apply
 * to a next round — a frozen schedule (422 SCHEDULE_LOCKED) and a stage not generated yet, or still waiting for its
 * qualifiers (STAGE_NOT_READY). Takes the division lock: everything after it reads the state the Generate pairs.
 */
async function lockSwissStageForApproval(tx: Tx, stageId: string): Promise<SwissExistingFixture[]> {
  const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  if (stage.kind !== "swiss") throw new HttpError(422, "only a Swiss stage has a next round to pair");
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
  if ((await divisionLockState(tx, stage.division_id)).frozen) {
    throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
  }
  if (stage.progression && !Array.isArray(stage.config.qualified)) {
    throw new EngineError("STAGE_NOT_READY", "this Swiss stage is waiting for its qualifiers", { stageId });
  }
  const rows = await tx<SwissExistingFixture[]>`
    select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
           scheduled_at, court_id, venue_id, schedule_locked
      from fixtures where stage_id = ${stageId}
     order by round_no, seq_in_round`;
  if (rows.length === 0) {
    throw new EngineError("STAGE_NOT_READY", "generate this Swiss stage before pairing a round", { stageId });
  }
  return rows;
}

/** The round the next Pair seats, or MD_ALREADY: every round is seated, or the latest seated round holds no result yet
 *  (a round is only previewed once the one before it is decided, so a seated round with nothing played is the very round
 *  the approve was for, paired since by another phone or the desk). */
function nextSwissRoundOrAlready(rows: readonly SwissExistingFixture[]): number {
  const target = nextUnseatedSwissRound(rows);
  const latest = latestSwissRoundWithAnySeat(rows);
  if (target === null || (latest !== null && !swissRoundHasPlayedResult(rows, latest))) {
    throw new HttpError(409, "this Swiss round is already paired", MD_ALREADY_CODE);
  }
  return target;
}

/**
 * Preview the next Swiss round (Match Day spec §7): run the desk's Pair next (`generateStageFixturesTx`) inside a
 * transaction, read the round it seated, and roll everything back — the seats, the ledger row, any lots draw, the stage
 * status. Answers the pairings in board order (the bye, if any, with `away: null`) and the `inputHash` the approve must
 * hand back. Every refusal the Pair would raise (the round before not decided, no legal pairing, …) is raised here too.
 */
export async function previewSwissNextRound(auth: AuthCtx, stageId: string): Promise<SwissRoundPreview> {
  try {
    await withTenant(auth.orgId, async (tx) => {
      const rows = await lockSwissStageForApproval(tx, stageId);
      const round = nextSwissRoundOrAlready(rows);
      const inputHash = await swissInputHash(tx, stageId);
      await generateStageFixturesTx(tx, auth, stageId, {});
      const seated = await tx<{ seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null; outcome: unknown }[]>`
        select seq_in_round, home_entrant_id, away_entrant_id, outcome
          from fixtures where stage_id = ${stageId} and round_no = ${round}
         order by seq_in_round`;
      const pairings = seated
        .filter((f) => f.home_entrant_id !== null && isSwissBoardSeated(f))
        .map((f) => ({ home: f.home_entrant_id!, away: f.away_entrant_id, board: f.seq_in_round }));
      throw new SwissPreviewRollback({ round, pairings, inputHash });
    });
  } catch (e) {
    if (e instanceof SwissPreviewRollback) return e.preview;
    throw e;
  }
  throw new Error("swiss preview: the transaction committed instead of rolling back");
}

/**
 * Pair the next Swiss round that `previewSwissNextRound` proposed. Under the division lock: MD_ALREADY (409) when that
 * round is already seated, MD_STALE (409) when `swissInputHash` no longer matches `inputHash` (a result or the field
 * changed since the preview), else the desk's Generate, committed and published exactly as `generateStageFixtures` does.
 * With no lots drawn the round seated is the round previewed; a round that takes a drawing of lots draws them again here.
 */
export async function pairSwissNextRound(auth: AuthCtx, stageId: string, inputHash: string): Promise<{ round: number }> {
  const { round, write } = await withTenant(auth.orgId, async (tx) => {
    const rows = await lockSwissStageForApproval(tx, stageId);
    const next = nextSwissRoundOrAlready(rows);
    if ((await swissInputHash(tx, stageId)) !== inputHash) {
      throw new HttpError(409, "the draw changed since it was previewed; review it again", MD_STALE_CODE);
    }
    return { round: next, write: await generateStageFixturesTx(tx, auth, stageId, {}) };
  });
  await afterGenerateCommit(auth, stageId, write);
  if (write.outcome.created > 0) afterScheduleWrite(write.divisionId, write.competitionId, "schedule", []);
  return { round };
}

