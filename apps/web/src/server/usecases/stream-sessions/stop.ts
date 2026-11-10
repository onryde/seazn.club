import "server-only";
// The organiser's Stop: the automatic-start block stamp and stopSession (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";
import { isTerminal } from "@/server/relay/domain/session";
import { recordEvent } from "@/server/relay/telemetry";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { markAutoStartBlocked } from "../stream-codes";
import { lockRow, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { apply } from "./apply";
import { latestRow, currentSession } from "./current";

/** A12 / plan R-3 (controller, 2026-10-07): an organiser's Stop of a NON-terminal session turns automatic start off for the
 *  match (`auto_start_blocked_at`). Stamped on the transaction that DECIDES the stop (`apply`'s command function, the locked
 *  row, or the repeated tap's own lock), so the stamp commits or rolls back with the stop: a Stop the database refuses leaves
 *  no stamp, and a stamp can never survive without its stop. NOT stamped by: a Stop of a terminal session, a 409
 *  `not_active`, the tick's / the sweep's ends (`phone_lost`), the phone's own stop, `expireTargetHolders` (FP12) — none is
 *  an organiser's intent.
 *  A stamp that FAILS is reported and the Stop proceeds (a live broadcast must stop), so it runs in a SAVEPOINT: a failed
 *  statement aborts a Postgres transaction, and only the savepoint lets the stop's own writes carry on past it. */
async function stampOrganiserStop(tx: Tx, auth: AuthCtx, fixtureId: string, deps: SessionDeps): Promise<void> {
  try {
    await tx.savepoint((sp) => markAutoStartBlocked(auth.orgId, fixtureId, deps.now(), auth.userId ?? null, sp));
  } catch (err) {
    log.error({ err: String(err), orgId: auth.orgId, fixtureId }, "stream session: the Stop's automatic-start block was not stamped — the Stop proceeds");
    captureError(err, { orgId: auth.orgId, route: "relay.session.stop_stamp", extra: { fixtureId } });
  }
}

export async function stopSession(auth: AuthCtx, fixtureId: string, sessionId: string, deps: SessionDeps): Promise<StreamSessionCurrent> {
  const row = await readRow(sessionId);
  if (!row || row.fixture_id !== fixtureId || row.org_id !== auth.orgId) throw new HttpError(404, "session not found");
  // m7 (fix round 1): a REPEATED stop — a double tap, or a retry after a lost response — is idempotent. A session already
  // stopping (`ending`) or stopped is answered with the same projection the first stop returned, and nothing is DECIDED:
  // no decision, no provider call. A stop naming a session the fixture has since SUPERSEDED stays 409 not_active: the
  // fixture's projection would describe a DIFFERENT session.
  if (row.state === "ending" || isTerminal(row.state)) {
    if ((await latestRow(fixtureId))?.id !== sessionId) throw new HttpError(409, "session is not running", "not_active");
    // Task 10 n5: the TAP is still the organiser's action. A session `ending` for another reason (the deadline, a failure)
    // otherwise kept no record that anyone pressed Stop. The row names the actor and the state the tap met, under the row
    // lock (`seq` is per session); it decides nothing. A finished session's tap asks for nothing and is not recorded.
    if (row.state === "ending") {
      await sql.begin(async (tx) => {
        const locked = await lockRow(tx, sessionId);
        await recordEvent(tx, { sessionId, orgId: row.org_id, source: "client", kind: "action", type: "stop", actorUserId: auth.userId ?? null,
          occurredAt: deps.now(), payload: { state: locked?.state ?? row.state } });
        // A12 (R-3): the tap on a session still `ending` is a Stop of a non-terminal session — judged on the LOCKED row.
        if (locked && !isTerminal(locked.state)) await stampOrganiserStop(tx, auth, fixtureId, deps);
      });
    }
    return (await currentSession(auth, fixtureId, deps))!;
  }
  // M10: with no relay there is no provider to stop through — the session is ended failed(relay_disabled), the
  // reconcile's own decision, and the projection answers. Never the `stop` below, whose composed arm asks the runner and
  // would throw. N5 (Task 14b re-review): it goes through `apply` WITH the actor, so the tap is still the organiser's
  // recorded action (Task 10 n5) — the row names her and the decision her Stop made. A session another writer finished
  // first decides nothing and records nothing, as below.
  if (deps.drivers.disabled) {
    await apply(sessionId, async (s, tx) => {
      if (isTerminal(s.state)) return null;
      await stampOrganiserStop(tx, auth, fixtureId, deps);
      return { type: "relay_disabled" };
    }, deps, { userId: auth.userId ?? null, source: "client" });
    return (await currentSession(auth, fixtureId, deps))!;
  }
  // m1: re-decided on the LOCKED row (T5-a). A session another writer FINISHED after the read above (an expiry, a failure)
  // writes nothing — no decision, no tap, the same as the finished-session branch above — and the projection answers.
  // `ending` is still decided: `ending × stop` is identity, and it records the tap (n5). The A12 stamp rides this same
  // locked row (R-3): a terminal row writes neither the stop nor the stamp.
  await apply(sessionId, async (s, tx) => {
    if (isTerminal(s.state)) return null;
    await stampOrganiserStop(tx, auth, fixtureId, deps);
    return { type: "stop", reason: "stopped" };
  }, deps, { userId: auth.userId ?? null, source: "client" });   // passthrough: the complete_now effect finishes it; composed: runner session_stop → SIGINT → observed destroyed → completed. The actor lands as an `action` row (ruling 13); stop_requested_at is set by persistFacts.
  return (await currentSession(auth, fixtureId, deps))!;
}
