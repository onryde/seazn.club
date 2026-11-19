// W5 T17 (X-BD-4 <- RB5-S4, CS-1): a SECOND Complete is a named case, not something the drivers steer around. Until this wave
// both drivers refused to send /complete again, because the product answered `completed: true` and re-ran the
// next stage's progression - a NEW draft proposal, a stale one beside a confirmed one. The product now answers a no-op that says
// so, and this case sends the repeat for every stage the run completed and judges the answer.
import { RefusedCall } from "../driver/types.ts";
import type { CompleteObs } from "../observed.ts";
import type { CheckResult } from "../results.ts";
import { assertion } from "./assertions.ts";
import type { StagePlay } from "./common.ts";
import type { ScenarioContext } from "./types.ts";

/** What a repeat /complete answered for one stage the run had completed. `thrown` is a refusal or a driver misuse, kept as text. */
export interface CompleteAgainObs {
  readonly seq: number;
  readonly first: CompleteObs;
  /** Whether the stage AFTER this one was reached by the run (`plays[i + 1].field` was read); null when there is no later stage. A
   *  later stage that was NOT reached after a completed one is a draft that was never minted (5xx or SEEDING_FAILED on the first call). */
  readonly successorReached: boolean | null;
  readonly answer: { readonly completed: boolean; readonly alreadyComplete: boolean | null; readonly divisionCompleted: boolean | null; readonly seedProposal: { id: string; status: string } | null } | null;
  readonly thrown: string | null;
}

/** Ask Complete again of every stage the run completed (`plays`' own observation says which), in stage order. Sent after the
 *  run's play and before its readbacks, so every later check reads the state AFTER the repeat: a repeat that moved something
 *  is judged by the same checks as the first. */
export async function completeAgain(ctx: ScenarioContext, plays: readonly StagePlay[]): Promise<CompleteAgainObs[]> {
  const out: CompleteAgainObs[] = [];
  for (const [i, p] of plays.entries()) {
    if (p.complete === null || p.complete.completed !== true) continue;
    const successorReached = plays[i + 1] === undefined ? null : plays[i + 1].field !== null;
    try {
      const c = await ctx.driver.completeStage(p.stage.id);
      out.push({ seq: p.stage.seq, first: p.complete, successorReached, thrown: null, answer: { completed: c.completed, alreadyComplete: c.already_complete ?? null, divisionCompleted: c.division_completed ?? null, seedProposal: c.seed_proposal ?? null } });
    } catch (e) {
      out.push({ seq: p.stage.seq, first: p.complete, successorReached, answer: null, thrown: e instanceof RefusedCall ? `${e.status} ${e.code ?? "(no code)"}` : `${e instanceof Error ? e.constructor.name : "thrown"}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

/** life-complete-twice-noop: for every completed stage, the repeat answered 200 `completed: false, already_complete: true`,
 *  did not complete the division again, and named no draft other than the one the first call minted (the draft the harness
 *  confirmed is no longer a draft: null), unless the first call minted none and the next stage was never reached: that null is a
 *  missing draft (a 5xx during the first progression), never a clean no-op. Zero stages repeated is not a pass - the first completion is `life-stage-completed`'s,
 *  and a run that completed nothing abstains there; here it abstains with its reason. */
export function completeTwiceNoop(obs: readonly CompleteAgainObs[]): CheckResult {
  return assertion("life-complete-twice-noop", obs.map((o) => {
    if (o.answer === null) return { ok: false, note: `stage ${o.seq}: the repeat /complete was ${o.thrown}` };
    const a = o.answer;
    const draftOk = a.seedProposal === null || (o.first.seedProposal != null && a.seedProposal.id === o.first.seedProposal.id);
    // A repeat that names no draft is a clean no-op ONLY when the first call minted one (the harness has since confirmed it, so it is
    // no longer a draft). When the first call minted none and the run never reached the next stage, the null is a draft that never
    // existed - a 5xx or STAGE_COMPLETED_SEEDING_FAILED during the first progression - and the repeat cannot make it one.
    const draftMissing = a.seedProposal === null && o.first.seedProposal == null && o.successorReached === false;
    return {
      ok: a.completed === false && a.alreadyComplete === true && a.divisionCompleted === null && draftOk && !draftMissing,
      note: `stage ${o.seq}: repeat /complete → completed=${a.completed} already_complete=${a.alreadyComplete} division_completed=${a.divisionCompleted} seed_proposal=${a.seedProposal === null ? "null" : `${a.seedProposal.id} ${a.seedProposal.status}`} (first minted ${o.first.seedProposal == null ? "none" : o.first.seedProposal.id}; first answered ${o.first.status}${o.first.code === null ? "" : " " + o.first.code})${draftMissing ? ": NO DRAFT after the first completion and the next stage was never reached - the repeat's null is a missing draft, not a clean no-op" : ""}`,
    };
  }), obs.length === 0 ? "no stage completed in this run, so there is nothing to complete twice (life-stage-completed judges that)" : null);
}
