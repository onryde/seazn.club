import "server-only";
import type postgres from "postgres";
import type { ForfeitAward, MatchOutcome } from "@seazn/engine/core";
import { canonicalJson } from "@/lib/canonical-json";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, fitReasonOf, ruleErrorMessage } from "@/lib/rule-errors";
import { awardFoldsUnder, isScoredAward, ledgerOf, loadAward, writeAwardedMatchState } from "@/server/engine-db/awarded-state";
import { matchName } from "./fixture-override-guards";

// W2c batch-3 I1 (ruling, under the owner's standing instruction) — a walkover no event records keeps its score in
// ONE place: the `match_states` row `writeAwardedMatchState` wrote when the award landed (F14's departed qualifier at
// Generate, `stages.ts`; ruling 116's arriving side over a dead seat, `fed-seats.ts`). No read path refolds it, and
// neither the stage lock nor the division lock counts it as play (`rule-locks.ts`: a frozen cfg or a recorded event),
// so a stage-rules save or a division save can move the format it resolves to — `bestOf` on a set sport, football's
// `awardScore` (a table key no knockout table guards), a variant. Such a save RE-WRITES those walkovers' score in its
// own transaction, under the format each now resolves: the same write the per-match writer makes
// (`writeAwardedMatchState(…, {rewrite: true})`). Never refused for the score it moves: only an award that will not hold
// under the new format (`awardFoldsUnder`: the engine refusing the forfeit, the fold deciding another award) is a named
// 409 on the save. No shipped sport's walkover reaches that arm (award-fit.test.ts's header); it is a guard, reached
// through the real saves by eventless-award-rewrite.test.ts ("both doors refuse by name"). Its own module, with no usecase import, so `stage-rules.ts` and `divisions.ts` can both call it.

type FixtureScope = postgres.PendingQuery<postgres.Row[]>;

/** One event-less scored award, as it resolved BEFORE the save wrote anything. */
export interface HeldAward {
  id: string;
  fixtureNo: number | null;
  cfg: unknown;
  /** W2c Task 16b - the walkover award its stage's points rule offers it NOW (`loadAward`), part of what the award resolves to. */
  forfeitAward?: ForfeitAward;
}

/** The scored awards in `scope` that no standing event records, each with the cfg it folds under NOW. Read before the
 *  save writes; `rewriteHeldAwards` reads them again after. A bye (no loser) credits no score and is not one. */
export async function heldAwards(tx: Tx, scope: FixtureScope): Promise<HeldAward[]> {
  const rows = await tx<{ id: string; fixture_no: number | null; outcome: MatchOutcome | null }[]>`
    select id, fixture_no, outcome from fixtures
     where ${scope} and outcome->>'kind' = 'award' and outcome->>'loser' is not null
     order by fixture_no nulls last, id`;
  const out: HeldAward[] = [];
  for (const r of rows) {
    if (!isScoredAward(r.outcome) || (await ledgerOf(tx, r.id)).standing > 0) continue;
    const award = await loadAward(tx, r.id);
    out.push({ id: r.id, fixtureNo: r.fixture_no, cfg: award.cfg, ...(award.forfeitAward === undefined ? {} : { forfeitAward: award.forfeitAward }) });
  }
  return out;
}

/** After the save's writes, in its transaction: every held award whose resolved cfg moved is re-folded under the new
 *  one and its score re-written; an award that will not hold there is a named 409 (`saveRefusal`). Returns the ids
 *  re-written. A save that moved nothing an award resolves re-writes nothing (the same save twice: one read each). */
export async function rewriteHeldAwards(tx: Tx, held: readonly HeldAward[]): Promise<string[]> {
  const rewritten: string[] = [];
  for (const h of held) {
    const now = await loadAward(tx, h.id);
    if (canonicalJson({ cfg: now.cfg, award: now.forfeitAward ?? null }) === canonicalJson({ cfg: h.cfg, award: h.forfeitAward ?? null })) continue;
    const fold = awardFoldsUnder(now.module, now.cfg, now.lineups, now.outcome, { fixtureId: h.id, recordedAt: new Date().toISOString() }, now.forfeitAward);
    if (!fold.ok) throw saveRefusal(h, fold.reason);
    await writeAwardedMatchState(tx, h.id, { rewrite: true });
    rewritten.push(h.id);
  }
  return rewritten;
}

/** The save's refusal, naming the match whose award will not hold under the format being saved. */
export const saveRefusal = (h: Pick<HeldAward, "id" | "fixtureNo">, reason: string): HttpError =>
  new HttpError(
    RULE_ERROR_STATUS.FORMAT_DOES_NOT_FIT_PLAY,
    `${matchName(h.fixtureNo)}: ${ruleErrorMessage("FORMAT_DOES_NOT_FIT_PLAY", { reason })}`,
    "FORMAT_DOES_NOT_FIT_PLAY",
    // Batch-3 M1: the facts a client says it with (`ruleRefusalText`).
    { fixture_id: h.id, fixture_no: h.fixtureNo, fit_reason: fitReasonOf(reason) },
  );
