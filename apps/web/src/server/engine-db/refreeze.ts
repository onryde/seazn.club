import "server-only";
import type { Tx } from "@/lib/db";
import { fixtureStatusFromFold } from "./append-event";
import { releaseFedSeats } from "./fed-seats";
import { foldFixture } from "./fold";

/**
 * W2c (Task 14, owner P-1 "A") — RE-FREEZE ONE STARTED FIXTURE onto a new cfg, and bring every fold-derived cache on it
 * into line. Extracted from the staff re-snapshot hatch (`admin-fixture-config.ts` `resnapshotFixtureConfig`) so that
 * hatch and the organiser's live correction (`fixture-rules.ts` `writeFixtureRulesOverride`, Q11) are ONE write.
 *
 * `rules_version` (V443) moves here and nowhere else: a correction and a staff re-freeze are the only two writes that
 * change the cfg of a match already in play, so they are the only two bumps — the first event FREEZES a cfg, it never
 * bumps one, and an unstarted override write has no frozen cfg to move. An open pad compares the version it loaded
 * with this one (Task 15). Returned so the caller can tell the pad.
 *
 * The caller holds the fixture's advisory lock (`fixture:<id>`, the one every append takes) and has refused a fixture
 * in `LOCKED_FIXTURE_STATUSES`; this function asks neither again. It takes no lock itself, so it can run under
 * whatever lock order its caller already holds (stage, division, then fixture).
 *
 * What it writes, in this order, all on `tx`:
 *  1. `config_snapshot` = `cfg` (and its stamp), `rules_version + 1`.
 *  2. The READ fold of the recorded ledger, through the ordinary read path (`foldFixture` → `resolveFixtureCfg`), so it
 *     reads the snapshot just written. A throw here is wrapped in `RefreezeFoldError`: only the caller knows what a
 *     fold refusal means to its user (the hatch: "the live config cannot read this fixture"; the correction already
 *     proved the fold before calling).
 *  3. A knockout line the new cfg un-decides or flips gives back the seat its old result advanced (`releaseFedSeats`,
 *     owner 2026-09-23) — or refuses NEXT_MATCH_STARTED, rolling everything above back.
 *  4. `match_states` (what `/state`, the score page and the console read — no read path re-folds), then
 *     `fixtures.outcome` and `fixtures.status`, unconditionally and in both directions.
 *
 * A fixture with no ledger (`foldFixture` → null) gets only step 1: there is nothing to fold.
 */
export class RefreezeFoldError extends Error {
  constructor(readonly foldError: unknown) {
    super(foldError instanceof Error ? foldError.message : String(foldError));
    this.name = "RefreezeFoldError";
  }
}

export interface RefreezeResult {
  /** The fixture's `rules_version` after the bump. */
  readonly rules_version: number;
  /** Fixtures whose seat step 3 emptied — their public documents are stale too. */
  readonly released: string[];
}

/**
 * Step 1 alone: the snapshot and the bump, no fold. For a match decided by an award NO EVENT records (`awardSeededByes`,
 * ruling 116) whose cfg froze before the award took over its ledger (every event voided, Loop R M-17): there is no play
 * to refold, and refolding that ledger would write its null outcome over the award (step 4). The caller re-writes the
 * award's own score instead (`awarded-state.ts` `writeAwardedMatchState({rewrite})`, fix round 1 I1). Same lock and
 * status contract as `refreezeFixture`.
 */
export async function freezeCfg(
  tx: Tx,
  fixtureId: string,
  cfg: unknown,
): Promise<{ rules_version: number; outcome: unknown; stage_kind: string | null }> {
  // `outcome` is not written by this statement, so `returning` hands back the one the OLD cfg decided.
  const [row] = await tx<{ rules_version: number; outcome: unknown; stage_kind: string | null }[]>`
    update fixtures f
       set config_snapshot = ${tx.json(cfg as never)}, config_snapshot_at = now(),
           rules_version = rules_version + 1
      from stages s
     where f.id = ${fixtureId} and s.id = f.stage_id
    returning f.rules_version, f.outcome, s.kind as stage_kind`;
  if (!row) throw new Error(`refreezeFixture: fixture ${fixtureId} (with its stage) not found`);
  return row;
}

export async function refreezeFixture(tx: Tx, fixtureId: string, cfg: unknown): Promise<RefreezeResult> {
  const row = await freezeCfg(tx, fixtureId, cfg);
  let folded;
  try {
    folded = await foldFixture(tx, fixtureId);
  } catch (err) {
    throw new RefreezeFoldError(err);
  }
  if (!folded) return { rules_version: row.rules_version, released: [] };
  const released = await releaseFedSeats(tx, fixtureId, row.outcome, folded.outcome);
  await tx`
    insert into match_states (fixture_id, last_seq, state, summary)
    values (${fixtureId}, ${folded.lastSeq}, ${tx.json(folded.state as never)},
            ${tx.json(folded.summary as never)})
    on conflict (fixture_id) do update set
      last_seq = excluded.last_seq, state = excluded.state,
      summary = excluded.summary, updated_at = now()`;
  await tx`
    update fixtures set
      outcome = ${folded.outcome === null ? null : tx.json(folded.outcome as never)},
      status = ${fixtureStatusFromFold(folded.outcome, folded.active, row.stage_kind)}
    where id = ${fixtureId}`;
  return { rules_version: row.rules_version, released };
}
