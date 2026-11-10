import "server-only";
import { withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";

/** The competition-level ledger event a successful joint RUN writes. Named once
 *  so the writer below and {@link lastCompetitionAiApply}'s counter cannot
 *  drift — the whole `_multi` suffix exists to keep joint runs apart from
 *  single-division ones, and a literal in two places is how they get mixed up. */
export const JOINT_RUN_EVENT = "schedule.ai_generated_multi";

/**
 * The competition-level event a joint APPLY writes — **owned by Task 6**
 * (`applyCompetitionSchedule`), which does not exist yet. Exported so that
 * writer imports this constant instead of retyping the string; the reader below
 * and the two payload keys it needs are the contract:
 *
 *   type    `schedule.applied_multi`
 *   payload `{ source: "ai" | "manual", ai?: { instruction, summary } }`
 *
 * Mirrors the division twin's `schedule_applied` + `payload->>'source' = 'ai'`
 * exactly (schedule.ts:618-622), for the same reason: the same event records a
 * manual multi-division apply, and only an AI-sourced one is a recall.
 */
export const JOINT_APPLY_EVENT = "schedule.applied_multi";

/**
 * GET /competitions/{id}/schedule/ai-last — the joint twin of `lastAiApply`
 * (schedule.ts:607), field for field.
 *
 * IT RECALLS THE LAST APPLY, NOT THE LAST PROPOSAL, and that is not a shortfall
 * of the joint flow — the single-division board has never persisted a proposal
 * either. An AI plan is propose-only: nothing about it is written down unless
 * the organiser applies it, at which point the apply event carries the
 * instruction that produced it and the model's own summary of what it did.
 * Recalling that is what "what did the AI last do to my schedule?" means here.
 *
 * `last` is therefore legitimately null until Task 6 lands
 * {@link JOINT_APPLY_EVENT} — no joint apply can have happened, so there is
 * nothing to recall, and a plan run alone must not fill this in.
 *
 * `runs.used` counts joint runs on this competition. Note it is NOT the same
 * counter as the division twin's: `lastAiApply` counts `schedule.ai_generated`
 * rows carrying a matching `division_id`, which a joint run never writes, so a
 * joint run does not and should not move a division's count. One counter per
 * endpoint, each counting the runs its own endpoint bills for. `max` is null —
 * joint runs are metered by the credit wallet, not by a run quota.
 *
 * Read scope: the recall exposes provenance that is already in the ledger.
 */
export async function lastCompetitionAiApply(
  auth: AuthCtx,
  competitionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, used } = await withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      { created_at: Date; payload: { ai?: { instruction?: string; summary?: string } } }[]
    >`
      select created_at, payload from competition_events
       where competition_id = ${competitionId}
         and type = ${JOINT_APPLY_EVENT}
         and payload->>'source' = 'ai'
       -- competition_events has no seq column (division_events does), so the
       -- tie-break is the id. Two applies inside ONE transaction would share a
       -- created_at; nothing writes two.
       order by created_at desc, id desc
       limit 1`;
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
       where competition_id = ${competitionId} and type = ${JOINT_RUN_EVENT}`;
    return { rows, used: count?.n ?? 0 };
  });
  const ai = rows[0]?.payload.ai ?? {};
  return {
    last:
      rows.length === 0
        ? null
        : {
            at: new Date(rows[0]!.created_at).toISOString(),
            instruction: ai.instruction ?? "",
            summary: ai.summary ?? "",
          },
    runs: { used, max: null },
  };
}
