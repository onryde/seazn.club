import "server-only";
// The automatic stop after the result (7.3): its facts, verdict and endIfAutoStopDue (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { AUTO_STOP_AFTER_RESULT_SECONDS, tunable } from "@/server/relay/config";
import { isTerminal } from "@/server/relay/domain/session";
import { autoStopApplies, autoStopVerdict, type PhoneMode } from "@/server/relay/domain/auto-stream";
import { log } from "@/server/logger";
import { type Row, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";

/** The facts `autoStopDue` (§7.3) judges, in ONE statement (one snapshot). The session's phone is its `pairing_id`, ended or
 *  not: the mode that was set is what the session's phone chose (FP13 — it lags the phone's Settings by at most one poll
 *  interval, by design). Every join is a fact, not a filter: a session with no `pairing_id` has a null `mode` (no phone, never
 *  auto-stopped), one with no settings row has `auto_stream` false, and a deleted fixture (`fixture_id` null) returns no row
 *  at all. `session_predates_result` is compared HERE, in SQL: `created_at` and `finished_at` are database stamps at
 *  microsecond precision and a JS `Date` truncates both to the millisecond, so a session created in the result's own
 *  millisecond would read equal there (Review Focus 4). Two clocks stay apart: those two stamps are compared with each other,
 *  and the delay is `deps.now()` against `finished_at`. `exec` is apply's tx when re-taken under the row lock. */
type AutoStopFacts = { auto_stream: boolean; mode: string | null; finished_at: Date | null; session_predates_result: boolean };
async function autoStopFactsOf(exec: Tx | typeof sql, sessionId: string): Promise<AutoStopFacts | null> {
  const [f] = await exec<AutoStopFacts[]>`
    select coalesce(st.auto_stream, false) as auto_stream, p.mode, f.finished_at,
           coalesce(s.created_at < f.finished_at, false) as session_predates_result
      from fixture_stream_sessions s
      join fixtures f on f.id = s.fixture_id
      left join fixture_stream_settings st on st.fixture_id = s.fixture_id
      left join fixture_stream_pairings p on p.id = s.pairing_id
     where s.id = ${sessionId}`;
  return f ?? null;
}
const phoneModeOf = (mode: string | null): PhoneMode | null => (mode === "automatic" || mode === "operator" ? mode : null);
/** B7 review M-3: whether §7.3 will ever stop this session (`autoStopApplies`), read from the SAME facts `autoStopDue` judges
 *  (one statement, the pre/post-result comparison in SQL) — the organiser panel's read model serves it, so the panel's
 *  "stops about N minutes after the result" line can never promise a stop the tick will not make. False for a session gone. */
export async function autoStopAppliesTo(sessionId: string): Promise<boolean> {
  const f = await autoStopFactsOf(sql, sessionId);
  return f !== null && autoStopApplies({
    autoStream: f.auto_stream, phoneMode: phoneModeOf(f.mode), finishedAt: f.finished_at, sessionPredatesResult: f.session_predates_result,
  });
}
function autoStopDue(f: AutoStopFacts, now: Date): boolean {
  return autoStopVerdict({
    autoStream: f.auto_stream, phoneMode: phoneModeOf(f.mode), finishedAt: f.finished_at, sessionPredatesResult: f.session_predates_result,
  }, now, tunable("AUTO_STOP_AFTER_RESULT_SECONDS", AUTO_STOP_AFTER_RESULT_SECONDS)).due;
}

/** Step 7 of the tick (§7.3): end the session `auto_stopped` once `autoStopDue`. Judged on an UNLOCKED read first (the common
 *  answer is "no", and `apply` takes the org's money lock), then RE-TAKEN on the locked row inside `apply`: a result reverted,
 *  a switch turned off or an organiser's Stop may have landed between the two, and only the locked answer ends anything. An
 *  `ending` or terminal session is not re-decided — the first reason wins (`ending × stop` is the identity in the domain, but
 *  deciding it would still cost the org lock). */
export async function endIfAutoStopDue(row: Row, deps: SessionDeps, cause: "poll" | "beat" | "sweep"): Promise<Row> {
  if (row.state === "ending" || isTerminal(row.state)) return row;
  const facts = await autoStopFactsOf(sql, row.id);
  if (!facts || !autoStopDue(facts, deps.now())) return row;
  let decided = false;
  await apply(row.id, async (s, tx) => {
    if (s.state === "ending" || isTerminal(s.state)) return null;
    const locked = await autoStopFactsOf(tx, s.id);
    decided = locked !== null && autoStopDue(locked, deps.now());
    return decided ? { type: "stop", reason: "auto_stopped" } : null;
  }, deps);
  const after = (await readRow(row.id)) ?? row;
  if (decided && (after.state === "ending" || isTerminal(after.state))) {
    log.info({ sid: row.id, orgId: row.org_id, cause, rule: "auto-stop", state: after.state }, "stream session: ended by the tick");
  }
  return after;
}
