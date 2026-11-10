import "server-only";
// W4 app B, Task 9 (X-TP-1, X-TP-2, X-TP-6): `PATCH /stages/{id}` `{ thirdPlace }` - a knockout stage's third place, Shared or
// Play-off match, editable until the stage starts and read-only after.
//
// Under the division lock, in ONE transaction: the stage must be a knockout (STAGE_NOT_KNOCKOUT), nothing of it started
// (`stageHasStarted`: a result, a decided line, a Match Day call - THIRD_PLACE_LOCKED), a play-off needs four entrants
// (`thirdPlaceOffered`: KO_THIRD_PLACE_TOO_FEW with the count), and a later stage's rank cut from this one must stay a whole
// round under the NEW setting (`isWholeRoundCut`'s third-place arm, C20: KO_CUT_NOT_WHOLE_ROUND, both directions). Then the
// config is written and a stage already holding lines is drawn again, through app A's own surfaces: a root bracket by
// `regenerateStageInTx` (Rebuild's body: slots carried by bracket role, over organiser setup it refuses by name as Generate
// does), a fed stage by its progression's own writer. The same setting again writes nothing.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isWholeRoundCut } from "@/lib/format-size-gates";
import { thirdPlaceFlagOf, thirdPlaceModeOf, thirdPlaceOffered, type ThirdPlaceMode } from "@/lib/third-place";
import type { ProgressionSpec } from "@seazn/engine/competition";
import type { AuthCtx } from "@/server/api-v1/auth";
import { afterScheduleWrite } from "../schedule";
import { stageHasStarted } from "../fixture-started-sql";
import { resolveProgressionSource } from "../stage-seeding";
import { knockoutRefusal } from "../knockout-refusal";
import { STAGE_COLS, type StageRow, type Tx, type GenerateWrite } from "./types";
import { fireStageRevalidate } from "./helpers";
import { lockSwissBoardAppends } from "./swiss-boards";
import { sealedStageSetupCounts, stageAttachmentCounts } from "./roster-drift";
import { regenerateStageInTx } from "./generate-tx";
import { writeProgressionSetupFixtures } from "./setup-fixtures";
import { afterGenerateCommit } from "./generate";
import type { SealedSetupCounts } from "./types";

export interface PatchKnockoutStageResult {
  stage_id: string;
  thirdPlace: ThirdPlaceMode;
  /** The stage's lines were drawn again for the new setting (false: nothing to draw yet, or nothing changed). */
  regenerated: boolean;
}

/** C20 (X-QM-2 x X-TP-6): every later stage's rank cut from `source` is judged against `playoff`, the setting the PATCH
 *  would write. A rank cut that would stop being a whole finishing band is refused by name BEFORE any write. Each rank rule is
 *  judged alone, as `validateStageProgression` judges it at save time. */
async function refuseBrokenDependentCuts(tx: Tx, source: StageRow, playoff: boolean): Promise<void> {
  const dependents = await tx<{ id: string; seq: number; progression: ProgressionSpec }[]>`
    select id, seq, progression from stages
     where division_id = ${source.division_id} and progression is not null and seq > ${source.seq} order by seq`;
  for (const dependent of dependents) {
    for (const s of dependent.progression.sources) {
      let resolved: { id: string };
      try {
        resolved = await resolveProgressionSource(tx, { division_id: source.division_id, seq: dependent.seq }, s.stage);
      } catch {
        continue; // an unresolvable source depends on nothing
      }
      if (resolved.id !== source.id) continue;
      for (const rule of s.take) {
        if (rule.kind !== "rankRange" || isWholeRoundCut(rule.from, rule.to, playoff)) continue;
        throw knockoutRefusal("KO_CUT_NOT_WHOLE_ROUND", { from: rule.from, to: rule.to, width: rule.to - rule.from + 1, stageId: dependent.id });
      }
    }
  }
}

export async function patchKnockoutStage(
  auth: AuthCtx,
  stageId: string,
  body: { thirdPlace: ThirdPlaceMode },
): Promise<PatchKnockoutStageResult> {
  // Whether the privileged prelude is owed: only a root bracket that holds lines can be drawn again over organiser setup,
  // and only that path reads the sealed counts (a stage with none never opens the read, so a failure there cannot stop it).
  const pre = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ kind: string; progression: unknown; lines: number }[]>`
      select kind, progression, (select count(*)::int from fixtures where stage_id = ${stageId}) as lines
        from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    return stage;
  });
  let sealed: SealedSetupCounts | undefined;
  // Shared never reads them: it deletes the -3p line in place and refuses over no setup (M-3).
  const readsSealed = thirdPlaceFlagOf(body.thirdPlace) && pre.kind === "knockout" && pre.progression === null && pre.lines > 0;
  let removedScope: { divisionId: string; competitionId: string } | null = null;

  const write = await withTenant(
    auth.orgId,
    async (tx) => {
      const [stage] = await tx<StageRow[]>`select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
      if (!stage) throw new HttpError(404, "stage not found");
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
      if (stage.kind !== "knockout") throw knockoutRefusal("STAGE_NOT_KNOCKOUT");

      const rows = await tx<{ id: string; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
        select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stageId}`;
      // The boards' append locks are taken before "started" is read: a first event in flight commits first and is seen, or waits.
      await lockSwissBoardAppends(tx, rows.map((r) => r.id));
      if (await stageHasStarted(tx, stageId)) throw knockoutRefusal("THIRD_PLACE_LOCKED");

      const was = thirdPlaceModeOf(stage.config);
      const playoff = thirdPlaceFlagOf(body.thirdPlace);
      const base = { stage_id: stageId, thirdPlace: body.thirdPlace };
      if (was === body.thirdPlace) return { result: { ...base, regenerated: false }, generated: null as GenerateWrite | null, removedIds: [] as string[], changed: false };

      const root = stage.progression === null;
      if (playoff && root) {
        // X-TP-1: a root bracket's field is the active roster (the same count `refuseFormatTooSmall` reads).
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from entrants where division_id = ${stage.division_id} and status in ('registered', 'confirmed')`;
        if (!thirdPlaceOffered(n)) throw knockoutRefusal("KO_THIRD_PLACE_TOO_FEW", { entrants: n, stageId });
      }
      await refuseBrokenDependentCuts(tx, stage, playoff);

      const qualified = Array.isArray(stage.config.qualified);

      await tx`update stages set config = config || ${tx.json({ thirdPlace: playoff } as never)} where id = ${stageId}`;
      if (rows.length === 0) return { result: { ...base, regenerated: false }, generated: null, removedIds: [], changed: true };

      // M-3 (PO ruling): Shared before the first match ALWAYS succeeds, whatever the stage's kind or setup. It never draws the
      // bracket again: the -3p line goes in place (its court/time slot with it, and any setup on that one line), the semi-finals'
      // loser edges into it are cleared, and every other line keeps its row and its organiser setup. Play-off (adding a line)
      // is the redraw / progression writer below.
      if (!playoff) {
        const bronze = await tx<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} and third_place`;
        const ids = bronze.map((b) => b.id);
        if (ids.length > 0) {
          await tx`update fixtures set loser_to_fixture = null, loser_to_slot = null where loser_to_fixture in ${tx(ids)}`;
          await tx`delete from fixtures where id in ${tx(ids)}`;
        }
        if (ids.length > 0) {
          const [div] = await tx<{ competition_id: string }[]>`select competition_id from divisions where id = ${stage.division_id}`;
          removedScope = { divisionId: stage.division_id, competitionId: div!.competition_id };
        }
        return { result: { ...base, regenerated: ids.length > 0 }, generated: null, removedIds: ids, changed: true };
      }
      if (root || qualified) {
        if (readsSealed && sealed === undefined) throw new Error("patchKnockoutStage: the sealed setup counts were not read");
        const attachments = await stageAttachmentCounts(tx, stageId, sealed ?? { streams: 0, youtubeBroadcasts: 0 });
        if (Object.values(attachments).some((c) => c > 0)) throw knockoutRefusal("KO_REDRAW_WOULD_CLEAR_SETUP", { attachments });
        const regen = await regenerateStageInTx(tx, auth, stageId, stage);
        return { result: { ...base, regenerated: true }, generated: regen.generated, removedIds: regen.removedIds, changed: true };
      }
      // A fed stage's lines (placeholders, or SEATED from a confirmed proposal: I-1, the stage has not started) are edited IN
      // PLACE, never drawn again - a redraw would drop the confirmed draw. The progression's own writer is idempotent over the
      // rows it finds (keyed by ext_key) and adds the missing -3p line with its two loser feeds.
      const removedIds: string[] = [];
      const generated = await writeProgressionSetupFixtures(tx, stageId);
      return { result: { ...base, regenerated: true }, generated, removedIds, changed: true };
    },
    readsSealed ? { privilegedPrelude: async (tx) => { sealed = await sealedStageSetupCounts(tx, auth.orgId, stageId); } } : {},
  );

  if (write.generated !== null) {
    try {
      await afterGenerateCommit(auth, stageId, write.generated);
    } finally {
      afterScheduleWrite(write.generated.divisionId, write.generated.competitionId, "schedule", write.removedIds);
    }
  } else if (write.changed) {
    await fireStageRevalidate(auth.orgId, stageId);
    // m1: a Shared switch deletes lines in place (no generate write), so the hub / division / fixture caches and the realtime
    // push still owe their invalidation for the removed -3p line.
    const scope = removedScope as { divisionId: string; competitionId: string } | null;
    if (scope !== null && write.removedIds.length > 0) afterScheduleWrite(scope.divisionId, scope.competitionId, "schedule", write.removedIds);
  }
  return write.result;
}
