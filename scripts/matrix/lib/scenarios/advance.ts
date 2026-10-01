// W1-driving T6 (D1): the seed advance as the organiser does it — Complete
// (once, which mints a draft proposal for the next stage), then Confirm THAT
// proposal. On a tie refusal: one recompute, then the product's own listed
// order, recorded (tie semantics are W4/W5's rulebook, not ours).
import type { StagePostBody } from "../catalogue.ts";
import { RefusedCall, type FixtureRow, type SeedProposalRef, type StageRef } from "../driver/types.ts";
import { winnerOf, type ObservedRun, type ObservedStage } from "../observed.ts";
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

/** One take rule of a progression source, as the body posted it. */
export type TakeRule = Readonly<Record<string, unknown>>;

/** Every take rule the body's progression declares, across its sources. No
 *  progression takes nobody. */
export function takesOf(body: StagePostBody): TakeRule[] {
  const sources = (body.progression as { sources?: readonly { take: readonly TakeRule[] }[] } | null)?.sources ?? [];
  return sources.flatMap((s) => [...s.take]);
}

/** How many entrants the body's progression declares it takes. `sourcePools`
 *  is the SOURCE stage's observed pool count (its fixtures' distinct non-null
 *  pool ids, or 1). bestNth adds its count once, never per pool (engine
 *  expandTake). */
export function declaredTake(body: StagePostBody, sourcePools: number): number {
  let n = 0;
  for (const t of takesOf(body)) {
    switch (t.kind) {
      case "rankRange": n += Number(t.to) - Number(t.from) + 1; break;
      case "topNPerGroup": n += Number(t.n) * sourcePools; break;
      case "bestNth": n += Number(t.count); break;
      case "roundLosers": n += Number(t.count); break;
      default: throw new UnknownTakeKind(String(t.kind));
    }
  }
  return n;
}

/** FP-2's bound (fix round 1, m-1): the withdrawn entrants the SOURCE stage's
 *  own observed tables rank INSIDE the take — the would-be qualifiers whose
 *  seats the product leaves empty (stages.ts computeSeedProposal: progression
 *  resolves over tables that still carry a departed entrant, then filters
 *  her). A withdrawn entrant ranked outside it excuses nothing.
 *  Per kind, as the engine resolves it (competition/progression.ts):
 *  rankRange reads the sole table (rankRangeSource); topNPerGroup ranks 1..n
 *  of every pool; roundLosers the losers of that round's two-sided lines
 *  (loserAt reads round_no by equality). bestNth is an UPPER bound: every
 *  rank-nth row, since crossGroupOrder is not replicated here. */
export function withdrawnQualifiers(takes: readonly TakeRule[], source: Pick<ObservedStage, "standings" | "fixtures">, withdrawn: ReadonlySet<string>): string[] {
  const inside = new Set<string>();
  const rows = (tables: ObservedStage["standings"], keep: (rank: number) => boolean) => {
    for (const t of tables) for (const r of t.rows) if (keep(r.rank)) inside.add(r.entrantId);
  };
  for (const t of takes) {
    switch (t.kind) {
      case "rankRange": rows(source.standings.length === 1 ? source.standings : source.standings.filter((x) => x.poolId === null), (k) => k >= Number(t.from) && k <= Number(t.to)); break;
      case "topNPerGroup": rows(source.standings, (k) => k <= Number(t.n)); break;
      case "bestNth": rows(source.standings, (k) => k === Number(t.nth)); break;
      case "roundLosers":
        for (const f of source.fixtures) {
          const w = winnerOf(f.outcome);
          if (f.roundNo !== Number(t.round) || f.home === null || f.away === null || w === null) continue;
          inside.add(w === f.home ? f.away : f.home);
        }
        break;
      default: throw new UnknownTakeKind(String(t.kind));
    }
  }
  return [...inside].filter((e) => withdrawn.has(e));
}

/** What one confirm did: the product's status and code, the proposal it was
 *  made on, `filled` SLOTS (a bye seed owns two), the entrants the target
 *  stage now seats, the declared take and the rules it came from, and whether
 *  a tie was picked. */
export interface AdvanceObs {
  readonly status: number;
  readonly code: string | null;
  readonly proposalId: string | null;
  readonly filled: number;
  readonly seeded: readonly string[];
  readonly declared: number;
  readonly takes: readonly TakeRule[];
  readonly tiePicked: boolean;
}

/** `body`: the TARGET stage's posted body; `sourcePools`: the source stage's
 *  observed pool count (declaredTake). */
export async function confirmAdvance(ctx: ScenarioContext, rec: Recorder, target: StageRef, proposal: SeedProposalRef, body: StagePostBody, sourcePools: number): Promise<AdvanceObs> {
  const declared = declaredTake(body, sourcePools);
  const takes = takesOf(body);
  // confirm answers the WHOLE target stage; the seats are read off it.
  const seatedOf = (fx: readonly FixtureRow[]) =>
    [...new Set(fx.filter((f) => f.stage_id === target.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null))];
  const refused = (e: RefusedCall, proposalId: string, tiePicked: boolean): AdvanceObs => {
    rec.notes.push(`confirm on stage ${target.seq} refused ${e.status} ${e.code ?? "(no code)"}`);
    return { status: e.status, code: e.code, proposalId, filled: 0, seeded: [], declared, takes, tiePicked };
  };
  try {
    const c = await ctx.driver.confirmSeedProposal(target.id, { proposalId: proposal.id });
    return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, takes, tiePicked: false };
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
  // m-9: a tie is recorded only when one was picked; a recompute that lists
  // none is confirmed as computed.
  const tiePicked = tiePicks.length > 0;
  if (tiePicked) {
    rec.facts.add("seeding_tie_picked");
    rec.notes.push(`stage ${target.seq}: ${tiePicks.length} seeding tie(s) picked in the product's listed order`);
  } else {
    rec.notes.push(`stage ${target.seq}: the recompute listed no ties — confirmed as computed`);
  }
  try {
    const c = await ctx.driver.confirmSeedProposal(target.id, tiePicked ? { proposalId: fresh.id, tiePicks } : { proposalId: fresh.id });
    return { status: 200, code: null, proposalId: c.proposalId, filled: c.filled, seeded: seatedOf(c.fixtures), declared, takes, tiePicked };
  } catch (e) {
    if (!(e instanceof RefusedCall)) throw e;
    return refused(e, fresh.id, tiePicked);
  }
}

/** Each later stage the run tried to advance into: the confirm was accepted;
 *  the seeded count is the declared take; seeded entrants come from the
 *  source stage's field and are never withdrawn.
 *  FP-2 (Task 6 Step 0): a departed qualifier is filtered from the proposal
 *  and her seat is LEFT EMPTY (stages.ts computeSeedProposal :4889-4905) — no
 *  close-up — so the count may fall short by at most the withdrawn entrants
 *  the source stage's observed tables rank inside the take
 *  (withdrawnQualifiers, m-1), never exceed the take.
 *  m-7: a later stage whose source COMMITTED its /complete but served no
 *  proposal (409 STAGE_COMPLETED_SEEDING_FAILED) is a failing item — the
 *  seeding half failed, and this check owns seeding. A stage the run never
 *  reached for any other reason (its source never completed) is not counted:
 *  life-loop-bounded owns it. None counted is an abstain with its reason,
 *  never a pass. */
export function advanceSeededAsDeclared(plays: readonly StagePlay[], observed: Pick<ObservedRun, "stages">, withdrawn: ReadonlySet<string>): CheckResult {
  const items: Item[] = plays.flatMap((p, i): Item[] => {
    if (i === 0) return [];
    const prev = plays[i - 1];
    const a = p.advance;
    if (a === null) {
      const c = prev.complete;
      if (c === null || !c.completed || (c.seedProposal ?? null) !== null) return [];
      return [{ ok: false, note: `stage ${p.stage.seq}: no proposal — stage ${prev.stage.seq}'s /complete answered ${c.status} ${c.code ?? "(no code)"}` }];
    }
    if (a.status !== 200) return [{ ok: false, note: `stage ${p.stage.seq}: confirm refused ${a.status} ${a.code ?? "(no code)"} — nobody seeded` }];
    const source = new Set(prev.field ?? []);
    const tables = observed.stages.find((s) => s.id === prev.stage.id);
    // snapshot observes every play, so a missing source stage is a harness bug: named, never a silent zero.
    if (tables === undefined) return [{ ok: false, note: `stage ${p.stage.seq}: stage ${prev.stage.seq} was not observed — its tables bound FP-2's empty seats` }];
    const gone = withdrawnQualifiers(a.takes, tables, withdrawn).length;
    const n = a.seeded.length;
    return [
      gone === 0
        ? { ok: n === a.declared, note: `stage ${p.stage.seq}: seeded ${n}, declared ${a.declared}` }
        : { ok: n <= a.declared && n >= a.declared - gone, note: `stage ${p.stage.seq}: seeded ${n}, declared ${a.declared} less at most ${gone} withdrawn qualifier(s)` },
      { ok: a.seeded.every((e) => source.has(e)), note: `stage ${p.stage.seq}: every seeded entrant comes from stage ${prev.stage.seq}'s field` },
      { ok: a.seeded.every((e) => !withdrawn.has(e)), note: `stage ${p.stage.seq}: no withdrawn entrant seeded` },
    ];
  });
  const reason = items.length > 0 ? null : plays.length <= 1 ? "single-stage row — no later stage to seed" : "no later stage was confirmed";
  return assertion("advance-seeded-as-declared", items, reason);
}
