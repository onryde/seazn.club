import "server-only";
// May the pooled role write the outbox? `email_outbox` is FORCE RLS with an INSERT policy for `app_user` and nothing else
// (V470), so the dispatcher, the worker, the webhook and the status read all depend on the pooled role being a superuser
// or BYPASSRLS (local and CI `postgres` is a superuser; V451 relies on the same on stg/prod). A role that is neither does
// NOT get an error: its UPDATEs match zero rows, so every send is quietly `deferred` and nothing ever leaves. This turns
// that silence into a loud answer, exported for the Task 4 worker as well as `dispatchNow`. Only a TRUE answer is
// remembered: `ALTER ROLE ... BYPASSRLS` takes effect in live sessions, so an operator who fixes a role must be believed
// on the very next call, without a restart. A false answer is asked again every time (one catalogue lookup, in a state
// that is already an outage and already logging an error per call).
import { sql, type Tx } from "@/lib/db";

/** The catalogue's answer for the role `db` is running as. `current_user`, so a `set local role` is seen. */
export async function probeOutboxRole(db: Tx | typeof sql): Promise<boolean> {
  const [row] = await (db as typeof sql)<{ ok: boolean }[]>`
    select (rolsuper or rolbypassrls) as ok from pg_roles where rolname = current_user`;
  return row?.ok === true;
}

/** Remember a TRUE answer. A false answer and a probe that fails are NOT remembered (the next call asks again), and
 *  callers that arrive before an answer share the one probe in flight. */
export function createRoleCheck(probe: () => Promise<boolean>): { ok(): Promise<boolean>; reset(): void } {
  let cached: Promise<boolean> | undefined;
  return {
    ok(): Promise<boolean> {
      if (cached === undefined) {
        const pending = (async () => probe())();
        cached = pending;
        // Registered before any caller can await `pending`, so a caller resumed by the answer sees it already forgotten.
        const forget = () => {
          if (cached === pending) cached = undefined;
        };
        pending.then((ok) => (ok ? undefined : forget()), forget);
      }
      return cached;
    },
    reset(): void {
      cached = undefined;
    },
  };
}

const pooledRole = createRoleCheck(() => probeOutboxRole(sql));

/** True when the pooled role can write the outbox. A true answer is remembered for the life of the process; a false one
 *  is asked again on the next call. */
export const outboxRoleOk = (): Promise<boolean> => pooledRole.ok();

/** For tests: forget the remembered answer. */
export const resetOutboxRoleCheck = (): void => pooledRole.reset();
