import "server-only";
// Swiss auto-advance (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md), plan Task 4: the two per-stage
// switches and the division's read of its auto actions.
//
//   `setStageAutoAdvance`      `PUT /stages/{id}/auto-advance` `{ autoPair?, autoConfirmHandoff? }` (§4.1). `autoPair` lives
//                              on a Swiss stage; `autoConfirmHandoff` on the TARGET stage, the one whose
//                              `progression.timing` is "setup". An ON where the switch can never act is refused by name
//                              (`autoAdvanceSwitchesFor`, the one rule); an OFF never is. Its own door, not PATCH /stages:
//                              the switches flip mid-event, after the stage has started (plan P1).
//   `listDivisionAutoActions`  `GET /divisions/{id}/auto-advance` (§4.6): every live row of the division, and each done row
//                              for AUTO_ADVANCE_DONE_VISIBLE_MS after it was done, newest first.
//
// A switch that MOVES appends `stage_auto_advance_switched { stage_id, key, on }` naming the person (actor_id). It is a
// history marker, not a change to the board: divisions.seq is not bumped (plan D7). The write merges server-side
// (`config || jsonb`, a literal-key merge the table-writers source scan can read), never a spread of a read: a key another
// writer committed while this one waited on the row survives.
import type postgres from "postgres";
import { AUTO_ADVANCE_DONE_VISIBLE_MS, LIVE_AUTO_ACTION_STATES, autoAdvanceSwitchesFor } from "@/lib/auto-advance";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AutoActionView, StageAutoAdvanceOut, StageAutoAdvancePatch } from "@/server/api-v1/schemas";
import { appendDivisionEvent } from "@/server/engine-db/competition";

type Tx = postgres.TransactionSql;

export const STAGE_AUTO_ADVANCE_SWITCHED = "stage_auto_advance_switched";

const SWITCH_KEYS = ["autoPair", "autoConfirmHandoff"] as const;
type SwitchKey = (typeof SWITCH_KEYS)[number];

const REFUSAL: Record<SwitchKey, { code: string; message: string }> = {
  autoPair: { code: "AUTO_PAIR_NOT_SWISS", message: "Automatic pairing is only for a Swiss stage." },
  autoConfirmHandoff: {
    code: "AUTO_CONFIRM_NO_HANDOFF",
    message: "Automatic confirmation is only for a stage seeded from the stage before it (a seed proposal).",
  },
};

interface StageRow {
  id: string;
  division_id: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown> | null;
}

/** A stage_auto_actions row as `ACTION_COLUMNS` selects it. */
export interface AutoActionRow {
  id: string;
  stage_id: string;
  kind: AutoActionView["kind"];
  state: AutoActionView["state"];
  target_round: number | null;
  target_proposal_id: string | null;
  due_at: Date | null;
  done_at: Date | null;
  blocked_code: string | null;
  detail: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  updated_at: Date;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The API's view of one row: camel-cased, the proposal named `proposalId`, timestamps as ISO strings. */
export function toAutoActionView(row: AutoActionRow): AutoActionView {
  return {
    id: row.id,
    stageId: row.stage_id,
    kind: row.kind,
    state: row.state,
    targetRound: row.target_round,
    proposalId: row.target_proposal_id,
    dueAt: iso(row.due_at),
    doneAt: iso(row.done_at),
    blockedCode: row.blocked_code,
    detail: row.detail,
    result: row.result,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The rows a person is shown: live, or done within the window. `scope` narrows to a division or one stage. */
async function visibleActions(tx: Tx, scope: { divisionId: string } | { stageId: string }): Promise<AutoActionView[]> {
  const where = "divisionId" in scope ? tx`division_id = ${scope.divisionId}` : tx`stage_id = ${scope.stageId}`;
  const rows = await tx<AutoActionRow[]>`
    select id, stage_id, kind, state, target_round, target_proposal_id, due_at, done_at, blocked_code, detail, result, updated_at
      from stage_auto_actions
     where ${where}
       and (state in ${tx([...LIVE_AUTO_ACTION_STATES])}
            or (state = 'done' and done_at > now() - make_interval(secs => ${AUTO_ADVANCE_DONE_VISIBLE_MS / 1000}::float8)))
     order by updated_at desc, id`;
  return rows.map(toAutoActionView);
}

const switchesOf = (config: Record<string, unknown> | null): Record<SwitchKey, boolean> => ({
  autoPair: config?.autoPair === true,
  autoConfirmHandoff: config?.autoConfirmHandoff === true,
});

export async function setStageAutoAdvance(auth: AuthCtx, stageId: string, patch: StageAutoAdvancePatch): Promise<StageAutoAdvanceOut> {
  return withTenant(auth.orgId, async (tx) => {
    const read = async () => {
      const [row] = await tx<StageRow[]>`select id, division_id, kind, progression, config from stages where id = ${stageId}`;
      return row;
    };
    const first = await read();
    if (!first) throw new HttpError(404, "stage not found");
    // The division lock orders this write against the Format tool's Save (which recreates the stage graph) and the
    // arming that reads the switch. The re-read is what the refusal and the "did it move" answer are judged on.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + first.division_id}))`;
    const stage = await read();
    if (!stage) throw new HttpError(404, "stage not found");

    // An ON where the switch can never act is refused whole, before anything is written. An OFF never is.
    const can = autoAdvanceSwitchesFor(stage);
    for (const key of SWITCH_KEYS) {
      if (patch[key] === true && !can[key]) throw new HttpError(422, REFUSAL[key].message, REFUSAL[key].code);
    }

    const before = switchesOf(stage.config);
    const moved = SWITCH_KEYS.filter((key) => patch[key] !== undefined && patch[key] !== before[key]);
    const after: Record<SwitchKey, boolean> = { ...before };
    for (const key of moved) after[key] = patch[key]!;
    if (moved.length > 0) {
      // A literal-key merge: an undefined key is dropped by the JSON serialiser, so only the keys that moved reach it.
      const autoPair = moved.includes("autoPair") ? after.autoPair : undefined;
      const autoConfirmHandoff = moved.includes("autoConfirmHandoff") ? after.autoConfirmHandoff : undefined;
      await tx`update stages set config = config || ${tx.json({ autoPair, autoConfirmHandoff } as never)} where id = ${stageId}`;
      for (const key of moved) {
        await appendDivisionEvent(tx, stage.division_id, STAGE_AUTO_ADVANCE_SWITCHED, { stage_id: stageId, key, on: after[key] }, auth.userId);
      }
    }
    return { ...after, actions: await visibleActions(tx, { stageId }) };
  });
}

export async function listDivisionAutoActions(auth: AuthCtx, divisionId: string): Promise<AutoActionView[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ id: string }[]>`select id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return visibleActions(tx, { divisionId });
  });
}
