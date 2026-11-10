import "server-only";
// W4 app PR B, Task 8 (X-PL-2, X-PL-5, X-PL-7, X-SD-11; FX-G14, PL-3): the plate (the consolation bracket) is proposed AFTER round two,
// drawn at the size of its field, and completes for every field the builder offers.
//
// The plate takes `firstLosses` (Task 7): every entrant's FIRST real match loss (RB4-P1), a forfeit loser excluded (RB4-P2). That
// set is known once every first match is decided - round one for the seeds with a bye's opponent, round two for the bye holders -
// never at save time, and not when the main draw ends. So the plate stage has NO day-one lines (owner ruling G2 exempts it from
// "Start creates placeholders for every stage"): its Generate writes nothing while the field is open (`writeProgressionSetupFixtures`),
// and `maybeProposePlate` below is the one door that draws it, from whatever just decided a main-draw result.
import { firstLossField, type FirstLossField, type ProgressionSpec } from "@seazn/engine/competition";
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendDivisionEvent } from "@/server/engine-db/competition";
import { unfillProposalSeats } from "@/server/engine-db/fed-seats";
import { pinStageTableRules } from "@/server/engine-db/table-rules";
import { log } from "@/server/logger";
import type { PlateCardState } from "@/lib/plate-card-state";
import { resolveSeedingSourceStage } from "@/lib/seeding-source-ready";
import { stageHasStarted } from "./fixture-started-sql";
import { sourcesToTables, standingsHash, poolTableRowsAcrossSources } from "./stage-seeding";
import { loadBracketFixtures } from "./stages/carry-over";
import { computeSeedProposal, confirmSeedProposal } from "./stages/seed-proposal";
import { setupDependentsOf } from "./stages/seed-stale";
import { completeStage } from "./stages/completion";
import { knockoutDrawOrder } from "@/server/engine-db/knockout-draw";
import type { ActiveEntrant, Tx } from "./stages/types";

/** The plate's field: `firstLossField` over the main stage's own lines, in the engine's 0-based rounds with the seat feeds
 *  attached (`loadBracketFixtures`). Its `complete` is the plate's whole trigger (no lines at all is never complete, B4-2). */
export async function plateFieldOf(tx: Tx, mainStageId: string): Promise<FirstLossField> {
  return firstLossField(await loadBracketFixtures(tx, mainStageId));
}

/**
 * What the plate's stage card shows (`lib/plate-card-state.ts`): refused when the source is no single-elimination knockout (a stored
 * row that predates the save-time refusal; `firstLossField` would throw on a lane bracket); too small when the plate completed by name
 * with no proposal; ready when the main draw's field is complete; else waiting, `done` of `total` first matches decided - the decided
 * REAL first-match lines (a walkover is no match, RB4-P2) over those plus the lines still owed a result.
 */
export async function plateCardStateOf(
  auth: AuthCtx,
  mainStageId: string,
  plate: { status: string },
  hasProposal: boolean,
): Promise<PlateCardState> {
  return withTenant(auth.orgId, async (tx) => {
    const [main] = await tx<{ kind: string }[]>`select kind from stages where id = ${mainStageId}`;
    if (main?.kind !== "knockout") return { state: "refused" } as const;
    if (plate.status === "complete" && !hasProposal) return { state: "too_small" } as const;
    const field = await plateFieldOf(tx, mainStageId);
    if (field.complete) return { state: "ready" } as const;
    const rows = await tx<{ round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null; outcome: { kind?: string } | null }[]>`
      select round_no, seq_in_round, home_entrant_id, away_entrant_id, outcome from fixtures
       where stage_id = ${mainStageId} order by round_no, seq_in_round`;
    const played = new Set<string>();
    let done = 0;
    for (const r of rows) {
      if (r.outcome === null || r.outcome.kind === "award" || r.home_entrant_id === null || r.away_entrant_id === null) continue;
      if (!played.has(r.home_entrant_id) || !played.has(r.away_entrant_id)) done++;
      played.add(r.home_entrant_id);
      played.add(r.away_entrant_id);
    }
    return { state: "waiting", done, total: done + field.pending.length } as const;
  });
}

/**
 * The division page's loader for every plate card (`seedingStages` in page order): null for a stage that is no plate, the card's
 * state for one. One read path for the page and its tests. A source that cannot be resolved answers `refused`, never a throw.
 */
export async function plateCardStatesFor(
  auth: AuthCtx,
  stages: readonly { id: string; division_id: string; seq: number; status: string; progression: unknown }[],
  seedingStages: readonly { id: string; division_id: string; seq: number; status: string; progression: unknown }[],
  hasProposal: readonly boolean[],
): Promise<(PlateCardState | null)[]> {
  return Promise.all(
    seedingStages.map(async (s, i) => {
      const progression = s.progression as Pick<ProgressionSpec, "sources">;
      if (!isFirstLossProgression(progression)) return null;
      const main = resolveSeedingSourceStage(stages, s, progression.sources[0]!.stage);
      if (main === undefined) return null;
      return plateCardStateOf(auth, main.id, s, hasProposal[i] === true);
    }),
  );
}

/** Whether a stored progression takes the first losses of any source (the plate's own shape). */
export function isFirstLossProgression(progression: Pick<ProgressionSpec, "sources"> | null | undefined): boolean {
  return progression?.sources.some((s) => s.take.some((t) => t.kind === "firstLosses")) === true;
}

/**
 * X-SD-11 (RB4-D10): the plate's draw. A first_loss qualifier's `seed` is its ORDER OF FIRST LOSS, never a plate seed (engine
 * `SlotDescriptor`), so the app re-seeds: the entrants' MAIN-DRAW seeds on the fold (`entrants.seed`, the seeded first and in their
 * order, as the main draw laid them), the unseeded after them in the order the plate's OWN draw seed gives
 * (`knockoutDrawOrder(plateStageId, …)`: one PRNG, one seed rule, so the same plate and the same field always draw the same
 * bracket, RB4-D4). Returns the qualifiers renumbered 1..k in that order, sorted by it.
 */
export async function reseedPlateQualifiers<Q extends { entrantId: string; seed: number }>(
  tx: Tx,
  plate: { id: string; config: Record<string, unknown> },
  qualifiers: readonly Q[],
): Promise<Q[]> {
  if (qualifiers.length === 0) return [];
  const ids = qualifiers.map((q) => q.entrantId);
  const rows = await tx<{ id: string; seed: number | null }[]>`select id, seed from entrants where id in ${tx(ids)}`;
  const seedOf = new Map(rows.map((r) => [r.id, r.seed] as const));
  // The seeded first, by MAIN-draw seed (RB4-D10): `knockoutDrawOrder` returns its input untouched when nobody is unseeded, so the
  // order is made here, not left to the first-loss order a qualifier's own `seed` carries. Ties and the unseeded keep first-loss order.
  const inf = Number.POSITIVE_INFINITY;
  const field: ActiveEntrant[] = [...qualifiers]
    .sort((a, b) => a.seed - b.seed)
    .map((q, i) => ({ e: { id: q.entrantId, seed: seedOf.get(q.entrantId) ?? null, swiss_first_round: null } as ActiveEntrant, i }))
    .sort((a, b) => (a.e.seed ?? inf) - (b.e.seed ?? inf) || a.i - b.i)
    .map((x) => x.e);
  const order = knockoutDrawOrder(plate.id, field, plate.config);
  const placeOf = new Map(order.map((e, i) => [e.id, i + 1] as const));
  return qualifiers.map((q) => ({ ...q, seed: placeOf.get(q.entrantId)! })).sort((a, b) => a.seed - b.seed);
}

/**
 * X-PL-2: a field under two cannot play a bracket. The plate COMPLETES, by name: a `stage_completed` with no ranks (and the
 * outcome named in its payload, `plate_too_small`; the stage card says it in words), the stage `complete` with no lines - never an empty success
 * the organiser has to guess at, and never a stage left pending that holds the division open for ever. Caller holds the division lock.
 */
async function completePlateTooSmall(tx: Tx, plate: { id: string; division_id: string }, losers: number): Promise<void> {
  const seq = await appendDivisionEvent(tx, plate.division_id, "stage_completed", {
    type: "stage_completed",
    stageId: plate.id,
    finalRanks: [],
    places: [],
    outcome: "plate_too_small",
    losers,
  });
  await pinStageTableRules(tx, plate.id);
  await tx`update stages set status = 'complete' where id = ${plate.id}`;
  await tx`update divisions set seq = ${seq} where id = ${plate.division_id}`;
  log.info({ event: "plate_too_small", stageId: plate.id, losers }, "plate_too_small");
}

/** The losing side of a race between two triggers of the same plate: the draw is already confirmed, or this draft was staled by the winner. */
function isRaceLoss(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "SEEDING_ALREADY_CONFIRMED" || code === "SEEDING_PROPOSAL_STALE";
}

type PlatePlan =
  | { plateId: string; action: "too_small" }
  | { plateId: string; action: "propose" }
  | { plateId: string; action: "confirm"; proposalId: string };

/**
 * The plate's trigger. Called after every decided result of a knockout (scoring.ts), after a withdrawal, and when the main stage
 * completes; idempotent over what it finds. For each dependent `firstLosses` stage of the main draw:
 *  - field OPEN (`!complete`): nothing is proposed. A draft the field has since regressed from (a result taken back) goes stale.
 *  - field COMPLETE with fewer than two losers: the plate completes by name (`completePlateTooSmall`), `outcome: "too_small"`.
 *  - field COMPLETE with two or more: a DRAFT proposal (`computeSeedProposal`) when none stands for this field; with
 *    `auto_progress` on, `confirmSeedProposal` follows at once (X-PL-7). A field that changed after a proposal stales it and
 *    re-proposes: a confirmed one's seats go back first while the plate has not started (a started plate stands as drawn).
 * Never inside the caller's transaction: the proposal and the confirm each run their own.
 */
export async function maybeProposePlate(auth: AuthCtx, mainStageId: string): Promise<{ proposed: boolean; outcome?: "too_small" }> {
  const { plans, autoProgress } = await withTenant(auth.orgId, async (tx) => {
    const [main] = await tx<{ id: string; division_id: string; kind: string }[]>`
      select id, division_id, kind from stages where id = ${mainStageId}`;
    if (!main || main.kind !== "knockout") return { plans: [] as PlatePlan[], autoProgress: false };
    const plates = (await setupDependentsOf(tx, main.id, main.division_id)).filter((d) => isFirstLossProgression(d.progression));
    if (plates.length === 0) return { plans: [] as PlatePlan[], autoProgress: false };
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + main.division_id}))`;
    const [division] = await tx<{ auto_progress: boolean }[]>`select auto_progress from divisions where id = ${main.division_id}`;
    const field = await plateFieldOf(tx, main.id);
    const plans: PlatePlan[] = [];
    for (const plate of plates) {
      const [row] = await tx<{ status: string }[]>`select status from stages where id = ${plate.id}`;
      if (row === undefined || row.status === "complete") continue;
      const proposals = await tx<{ id: string; status: string; computed: { standingsHash?: string } }[]>`
        select id, status, computed from stage_seed_proposals where stage_id = ${plate.id} order by created_at desc, id desc`;
      const latest = proposals[0];
      const lineCount = async () => (await tx<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${plate.id}`)[0]!.n;
      if (!field.complete) {
        // A field a taken-back result has reopened: a DRAFT is withdrawn WITH its lines (never a draft that cannot be confirmed, never
        // lines under no proposal). A confirmed, seated plate stands until the result is decided again (T7: a first loss is not provable
        // mid-correction); a started plate always stands.
        if (latest?.status === "draft" && !(await stageHasStarted(tx, plate.id))) {
          await tx`update stage_seed_proposals set status = 'stale' where id = ${latest.id}`;
          await tx`delete from fixtures where stage_id = ${plate.id}`;
        }
        continue;
      }
      if (field.losers.length < 2) {
        // A plate that has begun stands as drawn. Before that, whatever was drawn for a bigger field goes (the draft is staled, a
        // confirmed one's seats go back, the lines are removed) and the plate completes by name.
        if (await stageHasStarted(tx, plate.id)) continue;
        if (latest?.status === "confirmed") await unfillProposalSeats(tx, latest.id);
        if (latest !== undefined && latest.status !== "stale") await tx`update stage_seed_proposals set status = 'stale' where id = ${latest.id}`;
        await tx`delete from fixtures where stage_id = ${plate.id}`;
        await completePlateTooSmall(tx, plate, field.losers.length);
        plans.push({ plateId: plate.id, action: "too_small" });
        continue;
      }
      const { tables } = await sourcesToTables(tx, plate, plate.progression.sources);
      const hash = standingsHash(poolTableRowsAcrossSources(tables));
      if ((latest?.status === "draft" || latest?.status === "confirmed") && latest.computed.standingsHash === hash) {
        // Same field. A draft whose lines have since gone (an Undo of the draw's generation) cannot be confirmed: draw it again.
        if (latest.status === "draft" && (await lineCount()) === 0) {
          plans.push({ plateId: plate.id, action: "propose" });
        } else if (latest.status === "draft") {
          plans.push({ plateId: plate.id, action: "confirm", proposalId: latest.id });
        }
        continue;
      }
      if (latest?.status === "confirmed") {
        // The field moved after the draw. Before the plate starts the seats go back and the plate is drawn again; after, it stands.
        if (await stageHasStarted(tx, plate.id)) continue;
        await unfillProposalSeats(tx, latest.id);
        await tx`update stage_seed_proposals set status = 'stale' where id = ${latest.id}`;
      }
      plans.push({ plateId: plate.id, action: "propose" });
    }
    return { plans, autoProgress: division?.auto_progress === true };
  });

  let proposed = false;
  let outcome: "too_small" | undefined;
  for (const plan of plans) {
    if (plan.action === "too_small") {
      outcome = "too_small";
      // The plate was the last open stage when the main draw is already complete: the division is done (never a 409).
      await completeStage(auth, plan.plateId, { publish: false });
      continue;
    }
    let proposalId: string;
    if (plan.action === "propose") {
      try {
        proposalId = (await computeSeedProposal(auth, plan.plateId)).id;
      } catch (err) {
        // Two last results racing both plan "propose": the other won (it is confirmed already). Idempotent, so quiet.
        if (isRaceLoss(err)) continue;
        throw err;
      }
      proposed = true;
    } else {
      proposalId = plan.proposalId;
    }
    if (!autoProgress) continue;
    try {
      await confirmSeedProposal(auth, plan.plateId, { proposalId });
    } catch (err) {
      if (isRaceLoss(err)) continue;
      // Best-effort, like every auto step: the draft stands for the organiser to confirm, and says why it did not.
      log.warn({ event: "plate_auto_confirm_failed", stageId: plan.plateId, err: String(err) }, "plate_auto_confirm_failed");
    }
  }
  return { proposed, ...(outcome !== undefined ? { outcome } : {}) };
}
