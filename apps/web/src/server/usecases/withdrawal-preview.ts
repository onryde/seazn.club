// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition) — what a departure WOULD do, before it is confirmed. Read-only.
//
// The table stages read the rows the way the cascade reads them and call the cascade's own decision (`decideTableWithdrawal`),
// so the copy's count is the count the rule then acts on (withdrawal-preview.test.ts drives both and compares). The skips are
// the cascade's too: an entrant already departed is owed no cascade (`patchEntrant`'s C6), a finished league or group takes
// nothing (W5 T8 C1), and before Start a departure is a plain status flip.
//
// `fixtureId`: the disqualification is being recorded IN that match (the pad's sanction ending). The match is then one she has
// played (RB5-W4: its forfeit decides it), so it is read as decided and is not one of the remaining; on a bracket fixture the
// forfeit is the bracket's own and nothing else follows (W4; Part 2's `disqualifyFromMatch` runs only on a table stage).
//
// A bracket stage lists her lines still to play (the planner walks every unsettled line of hers over, `withdrawBracketEntrant`);
// a qualifier a lucky loser replaces (W4 T13) and the open formats (americano) are not previewed.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { WITHDRAWAL_PENDING_STATUSES, WITHDRAWAL_PLAYED_STATUSES } from "@/lib/table-withdrawal";
import type { WithdrawalPreview, WithdrawalPreviewStage } from "@/lib/withdrawal-consequence";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getDivision } from "./divisions";
import { DEPARTED_STATUSES, getEntrant, listEntrants } from "./entrants";
import { listDivisionFixtures } from "./fixtures";
import { divisionHasStarted, listStages } from "./stages";
import { WITHDRAWAL_WALKOVER_KINDS, decideTableWithdrawal } from "./withdrawal";

const TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss"]);
const ROUND_ROBIN_KINDS: ReadonlySet<string> = new Set(["league", "group"]);

interface Row {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
}

export async function previewWithdrawal(
  auth: AuthCtx,
  entrantId: string,
  as: "withdrawn" | "disqualified",
  opts: { fixtureId?: string } = {},
): Promise<WithdrawalPreview> {
  if (opts.fixtureId !== undefined) {
    // The fixture door admits an actor for ONE match: before anything about the entrant is read, she must sit on it, so the
    // route never answers for an entrant elsewhere in the org (not even that she has left).
    const [seated] = await withTenant(auth.orgId, (tx) =>
      tx<{ id: string }[]>`select id from fixtures where id = ${opts.fixtureId!} and ${entrantId} in (home_entrant_id, away_entrant_id)`,
    );
    if (seated === undefined) throw new HttpError(404, "entrant is not on this fixture");
  }
  const entrant = await getEntrant(auth, entrantId);
  const base: WithdrawalPreview = { entrant_id: entrantId, name: entrant.display_name, as, started: false, cascade: true, stages: [] };
  if (DEPARTED_STATUSES.has(entrant.status)) return { ...base, cascade: false };
  const division = await getDivision(auth, entrant.division_id);
  if (!(await withTenant(auth.orgId, (tx) => divisionHasStarted(tx, division.id)))) {
    if (opts.fixtureId !== undefined) throw new HttpError(404, "fixture not found");
    return base;
  }
  const [stages, fixtures, entrants] = await Promise.all([
    listStages(auth, division.id),
    listDivisionFixtures(auth, division.id),
    listEntrants(auth, division.id),
  ]);
  const nameOf = new Map(entrants.map((e) => [e.id, e.display_name]));
  let mine = (fixtures as unknown as Row[]).filter((f) => f.home_entrant_id === entrantId || f.away_entrant_id === entrantId);

  if (opts.fixtureId !== undefined) {
    const line = mine.find((f) => f.id === opts.fixtureId);
    if (line === undefined) throw new HttpError(404, "entrant is not on this fixture");
    const kind = stages.find((s) => s.id === line.stage_id)?.kind;
    if (kind === undefined || !TABLE_KINDS.has(kind)) return { ...base, started: true, cascade: false };
    // RB5-W4: the match her disqualification is recorded in is decided by it — played, and not one of the remaining.
    const winner = line.home_entrant_id === entrantId ? line.away_entrant_id : line.home_entrant_id;
    mine = mine.map((f) =>
      f.id === line.id ? { ...f, status: "forfeited", outcome: f.outcome ?? { kind: "award", winner, loser: entrantId, reason: as } } : f,
    );
  }

  const opponentOf = (f: Row): string | null => {
    const id = f.home_entrant_id === entrantId ? f.away_entrant_id : f.home_entrant_id;
    return id ? (nameOf.get(id) ?? null) : null;
  };
  const out: WithdrawalPreviewStage[] = [];
  for (const stage of stages) {
    const rows = mine.filter((f) => f.stage_id === stage.id);
    if (rows.length === 0) continue;
    const roundOf = new Map(rows.map((f) => [f.id, f.round_no]));
    if (TABLE_KINDS.has(stage.kind)) {
      if (ROUND_ROBIN_KINDS.has(stage.kind) && stage.status === "complete") continue; // W5 T8 C1: a finished table takes nothing
      const d = decideTableWithdrawal({ id: stage.id, kind: stage.kind as "league" | "group" | "swiss" }, entrantId, rows);
      out.push({
        stage_id: stage.id,
        stage_kind: stage.kind,
        mode: d.mode === "expunge" ? "expunge" : "award",
        played: d.played,
        scheduled: d.scheduled,
        pending: d.pending.map((p) => ({
          fixture_id: p.id,
          opponent: p.opponent === "" ? null : (nameOf.get(p.opponent) ?? null),
          round_no: roundOf.get(p.id) ?? 0,
        })),
        undo: stage.kind === "swiss" ? "rejoins" : "restores",
      });
    } else if (WITHDRAWAL_WALKOVER_KINDS.has(stage.kind)) {
      const pending = rows.filter((f) => WITHDRAWAL_PENDING_STATUSES.has(f.status));
      const played = rows.filter((f) => WITHDRAWAL_PLAYED_STATUSES.has(f.status) && f.outcome !== null).length;
      out.push({
        stage_id: stage.id,
        stage_kind: stage.kind,
        mode: "bracket_walkover",
        played,
        scheduled: played + pending.length,
        pending: pending.map((f) => ({ fixture_id: f.id, opponent: opponentOf(f), round_no: f.round_no })),
        undo: "waits",
      });
    }
  }
  return { ...base, started: true, stages: out };
}
