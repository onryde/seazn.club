import "server-only";
// Marking seed proposals stale when a source stage or the field changes.

import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { ProgressionSpec } from "@seazn/engine/competition";
import { bracketStageIsDecided } from "@/server/engine-db/competition";
import { unfillProposalSeats } from "@/server/engine-db/fed-seats";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveProgressionSource, sourcesToTables, standingsHash, poolTableRowsAcrossSources } from "../stage-seeding";
import { slateStands, type BracketDependent } from "../knockout-cut-drift";
import type { Tx } from "./types";
import { computeSeedProposal, type SeedProposalOut } from "./seed-proposal";

/** A standings change on `sourceStageId` invalidates any dependent
 *  `timing: "setup"` stage's draft proposal — mark it stale and recompute a
 *  fresh one against the corrected table (design: overrideStandings "marks
 *  dependent draft proposals stale and recomputes"). Best-effort throughout:
 *  a dependent whose recompute now trips (e.g. rules unsatisfiable, or
 *  already confirmed) is left as-is rather than blocking the write that
 *  already committed.
 *
 *  Exported (P5 review finding): `overrideStandings` is not the only
 *  standings-mutating path a COMPLETE source stage can still take.
 *  `LOCKED_FIXTURE_STATUSES` (append-event.ts) is only {finalized,
 *  cancelled} — "decided" is not locked — so a correction to an
 *  already-decided fixture via the live scoring path (usecases/scoring.ts
 *  onDecided) is permitted too, and must call this the same way.
 *
 *  W4 T14 (FX-G16, X-QM-4, RB4-Q5) `includeConfirmed`: a correction inside a completed KNOCKOUT source, where a confirmed
 *  proposal goes stale too and its seats go back before the destination starts (`correctBracketDependent`). A table source
 *  does not pass it: FX-G16's table half is W5's. Returns the lines of the dependents whose seats went back, for the
 *  caller's publish; [] without the option. */
export async function markDependentSeedProposalsStale(
  auth: AuthCtx,
  sourceStageId: string,
  opts: { includeConfirmed?: boolean } = {},
): Promise<string[]> {
  const unfilled: string[] = [];
  const dependents = await withTenant(auth.orgId, async (tx) => {
    const [src] = await tx<{ division_id: string }[]>`select division_id from stages where id = ${sourceStageId}`;
    if (!src) return [];
    const matches = await setupDependentsOf(tx, sourceStageId, src.division_id);
    if (opts.includeConfirmed) {
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + src.division_id}))`;
      const recompute: string[] = [];
      for (const dependent of matches) {
        const step = await correctBracketDependent(tx, dependent, sourceStageId);
        unfilled.push(...step.unfilled);
        if (step.recompute) recompute.push(dependent.id);
      }
      return recompute;
    }
    const ids = matches.map((m) => m.id);
    if (ids.length > 0) {
      await tx`update stage_seed_proposals set status = 'stale' where stage_id in ${tx(ids)} and status = 'draft'`;
    }
    return ids;
  });
  for (const dependentStageId of dependents) {
    try {
      await computeSeedProposal(auth, dependentStageId);
    } catch {
      // best-effort, see docstring
    }
  }
  return unfilled;
}

/** The `timing: "setup"` stages of the division that draw from `sourceStageId`. */
export async function setupDependentsOf(tx: Tx, sourceStageId: string, divisionId: string): Promise<BracketDependent[]> {
  // Restricted to timing==='setup' in SQL (not just `progression is not
  // null`): an `on_complete` stage never has a stage_seed_proposals row,
  // so including it here would only cost wasted resolveProgressionSource
  // calls below, never a real match.
  const rows = await tx<{ id: string; seq: number; kind: string; progression: Record<string, unknown> | null }[]>`
    select id, seq, kind, progression from stages
    where division_id = ${divisionId}
      and progression is not null
      and progression ->> 'timing' = 'setup'
    order by seq`;
  const matches: BracketDependent[] = [];
  for (const row of rows) {
    const progression = row.progression as unknown as ProgressionSpec;
    // A dependent may name MULTIPLE sources (Decision 4) — it depends on
    // sourceStageId if ANY of them resolves to it.
    for (const s of progression.sources) {
      try {
        const source = await resolveProgressionSource(tx, { division_id: divisionId, seq: row.seq }, s.stage);
        if (source.id === sourceStageId) {
          matches.push({ id: row.id, division_id: divisionId, seq: row.seq, kind: row.kind, progression });
          break;
        }
      } catch {
        // an unresolvable source can't depend on this stage
      }
    }
  }
  return matches;
}

/**
 * RB4-Q5, on one dependent of a knockout source that a decision just moved. The question is the same for a draft and a
 * confirmed proposal: does its slate still stand (`slateStands`)?
 *  - CONFIRMED and it does not, the same people in a new seed order included (a flipped final): the seats go back unless the
 *    destination has started (`unfillProposalSeats`, whose guard that is: then the bracket stands, and the desk warns only if
 *    the people moved, `getKnockoutCutDrift`), and the row goes stale.
 *  - DRAFT: while the source is undecided, only if it does not stand; once decided, whenever the stored ranks it was read
 *    from moved. That is the hash, not the slate: a draft whose hash moved is REFUSED at its confirm (a flipped final is the
 *    same four in a new order), and the draft panel's only button is Confirm, so leaving it would strand the organiser.
 *  - NEITHER live, and the source decided: a take-back staled it and the replay ended with the same ranks, so nothing else
 *    would ever re-propose: this does, rather than leaving a stale row nobody asked for.
 * The recompute itself runs after this transaction (the caller's), and waits for a decided source
 * (`sourcesToTables`' refusal, which is why it is not asked for while undecided).
 */
async function correctBracketDependent(
  tx: Tx,
  dependent: BracketDependent,
  sourceStageId: string,
): Promise<{ unfilled: string[]; recompute: boolean }> {
  const proposals = await tx<{ id: string; status: string; computed: SeedProposalOut["computed"] }[]>`
    select id, status, computed from stage_seed_proposals where stage_id = ${dependent.id}`;
  const confirmed = proposals.find((p) => p.status === "confirmed");
  const draft = proposals.find((p) => p.status === "draft");
  const decided = await bracketStageIsDecided(tx, sourceStageId);
  if (confirmed) {
    if (await slateStands(tx, dependent, confirmed.computed, sourceStageId, decided)) return { unfilled: [], recompute: false };
    const unfilled = await unfillProposalSeats(tx, confirmed.id);
    if (unfilled.length === 0) return { unfilled: [], recompute: false };
    await tx`update stage_seed_proposals set status = 'stale' where id = ${confirmed.id}`;
    return { unfilled, recompute: decided };
  }
  if (draft) {
    const standing = decided
      ? await draftHashStands(tx, dependent, draft.computed)
      : await slateStands(tx, dependent, draft.computed, sourceStageId, false);
    if (standing) return { unfilled: [], recompute: false };
    await tx`update stage_seed_proposals set status = 'stale' where id = ${draft.id}`;
    return { unfilled: [], recompute: decided };
  }
  return { unfilled: [], recompute: decided && proposals.some((p) => p.status === "stale") };
}

/** Would the confirm still take this draft? `confirmSeedProposal`'s own freshness read. A sibling source that is not ready
 *  cannot be judged here: the draft is left alone, as the confirm's own refusal will say why. */
async function draftHashStands(tx: Tx, dependent: BracketDependent, computed: SeedProposalOut["computed"]): Promise<boolean> {
  try {
    const { tables } = await sourcesToTables(tx, dependent, dependent.progression.sources);
    return standingsHash(poolTableRowsAcrossSources(tables)) === computed.standingsHash;
  } catch (err) {
    if (err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") return true;
    throw err;
  }
}

/** A change to WHO IS IN THE FIELD invalidates any `timing: "setup"` draft
 *  proposal in the division — mark it stale and recompute it against the
 *  current field, exactly as markDependentSeedProposalsStale does for a
 *  standings change. Division-scoped rather than source-scoped because a
 *  withdrawal names no stage: it changes every dependent proposal at once,
 *  whichever source each one draws from.
 *
 *  Why this is not optional. A withdrawal does NOT move the frozen standings
 *  snapshot, so it does not move `standingsHash` either — the draft the
 *  organiser is looking at stays 'draft' and keeps naming her. And the draft
 *  panel's ONLY button is Confirm (progression-panel.tsx renders Recompute on
 *  its null and stale branches, never on a draft), so without this the
 *  organiser meets confirmSeedProposal's refusal with no control on the
 *  screen that can clear it. Staling the row is what puts the existing
 *  Recompute button in front of them — and the recompute that follows here
 *  usually means they never see the refusal at all.
 *
 *  Called on BOTH directions of the flip (patchEntrant, the single status
 *  funnel — withdrawEntrantCascade ends by calling it): an entrant who is
 *  un-withdrawn must be OFFERED again, and a proposal computed while she was
 *  out would otherwise keep her out until something else happened to stale it.
 *
 *  Best-effort throughout, like its sibling: a recompute that now trips (rules
 *  unsatisfiable, already confirmed) leaves the stale row for the organiser to
 *  act on rather than failing the withdrawal that already committed. */
export async function markFieldChangeSeedProposalsStale(orgId: string, divisionId: string): Promise<void> {
  const affected = await withTenant(orgId, async (tx) => {
    const rows = await tx<{ stage_id: string }[]>`
      select p.stage_id from stage_seed_proposals p
      join stages s on s.id = p.stage_id
      where s.division_id = ${divisionId}
        and p.status = 'draft'
        and s.progression is not null
        and s.progression ->> 'timing' = 'setup'`;
    const ids = rows.map((r) => r.stage_id);
    if (ids.length > 0) {
      await tx`update stage_seed_proposals set status = 'stale' where stage_id in ${tx(ids)} and status = 'draft'`;
    }
    return ids;
  });
  // An orgId, not an AuthCtx (review finding F3, 2026-09-21): the entrant
  // status flip that triggers this does NOT always come from a route with one
  // — `withdrawCore` (registrations.ts) reaches it from the PUBLIC
  // self-cancel, which has a token and an org, no session. Safe because
  // `computeSeedProposal` reads exactly one field off its `auth`, `orgId`
  // (verified by reading its body: `withTenant(auth.orgId, …)` and the
  // proposal INSERT's `org_id`), and every caller here has already authorised
  // the write that changed the field. This is a system refresh of the org's
  // OWN derived data, not a user action.
  const systemCtx: AuthCtx = { orgId, via: "api_key", userId: null, role: null, keyId: null };
  for (const stageId of affected) {
    try {
      await computeSeedProposal(systemCtx, stageId);
    } catch {
      // best-effort, see docstring
    }
  }
}