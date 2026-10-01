// W1-driving T6 (D1): the seed advance as the organiser does it — Complete
// (once, which mints a draft proposal for the next stage), then Confirm THAT
// proposal. On a tie refusal: one recompute, then the product's own listed
// order, recorded (tie semantics are W4/W5's rulebook, not ours).
import type { StagePostBody } from "../catalogue.ts";
import { RefusedCall, type FixtureRow, type SeedProposalRef, type StageRef } from "../driver/types.ts";
import type { CheckResult } from "../results.ts";
import { assertion, type Item } from "./assertions.ts";
import type { Recorder, StagePlay } from "./common.ts";
import type { ScenarioContext } from "./types.ts";

/** Pinned at Task 6 Step 0 from usecases/stages.ts confirmSeedProposal (a
 *  flagged tie with no edit or tiePick; multi-stage.test.ts reads it from the
 *  product's text). */
export const SEEDING_TIE_CODE = "SEEDING_TIE_UNRESOLVED";

export class UnknownTakeKind extends Error {
  constructor(kind: string) {
    super(`advance: take kind '${kind}' is not in the harness's vocabulary (rankRange, topNPerGroup, bestNth, roundLosers — format-templates.ts)`);
    this.name = "UnknownTakeKind";
  }
}

/** How many entrants the body's progression declares it takes. `sourcePools`
 *  is the SOURCE stage's observed pool count (its fixtures' distinct non-null
 *  pool ids, or 1). bestNth adds its count once, never per pool (engine
 *  expandTake). No progression takes nobody. */
export function declaredTake(body: StagePostBody, sourcePools: number): number {
  const sources = (body.progression as { sources?: readonly { take: readonly Record<string, unknown>[] }[] } | null)?.sources ?? [];
  let n = 0;
  for (const s of sources) {
    for (const t of s.take) {
      switch (t.kind) {
        case "rankRange": n += Number(t.to) - Number(t.from) + 1; break;
        case "topNPerGroup": n += Number(t.n) * sourcePools; break;
        case "bestNth": n += Number(t.count); break;
        case "roundLosers": n += Number(t.count); break;
        default: throw new UnknownTakeKind(String(t.kind));
      }
    }
  }
  return n;
}

/** What one confirm did: the product's status and code, the proposal it was
 *  made on, `filled` SLOTS (a bye seed owns two), the entrants the target
 *  stage now seats, the declared take, and whether a tie was picked. */
export interface AdvanceObs {
  readonly status: number;
  readonly code: string | null;
  readonly proposalId: string | null;
  readonly filled: number;
  readonly seeded: readonly string[];
  readonly declared: number;
  readonly tiePicked: boolean;
}

export async function confirmAdvance(ctx: ScenarioContext, rec: Recorder, target: StageRef, proposal: SeedProposalRef, declared: number): Promise<AdvanceObs> {
  // confirm answers the WHOLE target stage; the seats are read off it.
  const seatedOf = (fx: readonly FixtureRow[]) =>
    [...new Set(fx.filter((f) => f.stage_id === target.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null))];
  const refused = (e: RefusedCall, proposalId: string, tiePicked: boolean): AdvanceObs => {
    rec.notes.push(`confirm on stage ${target.seq} refused ${e.status} ${e.code ?? "(no code)"}`);
    return { status: e.status, code: e.code, proposalId, filled: 0, seeded: [], declared, tiePicked };
  };
  try {
    const c = await ctx.driver.confirmSeedProposal(target.id, { proposalId: proposal.id });
    return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, tiePicked: false };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    if (e.code !== SEEDING_TIE_CODE) return refused(e, proposal.id, false);
  }
  let fresh;
  try {
    fresh = await ctx.driver.recomputeSeedProposal(target.id);
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    return refused(e, proposal.id, false);
  }
  const tiePicks = fresh.ties.map((t) => ({ slots: t.slots, order: t.entrantIds }));
  rec.facts.add("seeding_tie_picked");
  rec.notes.push(`stage ${target.seq}: ${tiePicks.length} seeding tie(s) picked in the product's listed order`);
  try {
    const c = await ctx.driver.confirmSeedProposal(target.id, { proposalId: fresh.id, tiePicks });
    return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, tiePicked: true };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    return refused(e, fresh.id, true);
  }
}

/** Each later stage the run tried to advance into: the confirm was accepted;
 *  the seeded count is the declared take; seeded entrants come from the
 *  source stage's field and are never withdrawn.
 *  FP-2 (Task 6 Step 0): a departed qualifier is filtered from the proposal
 *  and her seat is LEFT EMPTY (stages.ts computeSeedProposal :4889-4905) — no
 *  close-up — so with a withdrawn entrant in the source field the count may
 *  fall short by at most that many, never exceed the take. A stage the run
 *  never reached (no advance attempted) is not counted: life-loop-bounded
 *  owns it. None counted is an abstain with its reason, never a pass. */
export function advanceSeededAsDeclared(plays: readonly StagePlay[], withdrawn: ReadonlySet<string>): CheckResult {
  const items: Item[] = plays.flatMap((p, i): Item[] => {
    if (i === 0 || p.advance === null) return [];
    const a = p.advance;
    if (a.status !== 200) return [{ ok: false, note: `stage ${p.stage.seq}: confirm refused ${a.status} ${a.code ?? "(no code)"} — nobody seeded` }];
    const prev = plays[i - 1];
    const source = new Set(prev.field ?? []);
    const gone = [...source].filter((e) => withdrawn.has(e)).length;
    const n = a.seeded.length;
    return [
      gone === 0
        ? { ok: n === a.declared, note: `stage ${p.stage.seq}: seeded ${n}, declared ${a.declared}` }
        : { ok: n <= a.declared && n >= a.declared - gone, note: `stage ${p.stage.seq}: seeded ${n}, declared ${a.declared} less at most ${gone} withdrawn` },
      { ok: a.seeded.every((e) => source.has(e)), note: `stage ${p.stage.seq}: every seeded entrant comes from stage ${prev.stage.seq}'s field` },
      { ok: a.seeded.every((e) => !withdrawn.has(e)), note: `stage ${p.stage.seq}: no withdrawn entrant seeded` },
    ];
  });
  const reason = items.length > 0 ? null : plays.length <= 1 ? "single-stage row — no later stage to seed" : "no later stage was confirmed";
  return assertion("advance-seeded-as-declared", items, reason);
}
