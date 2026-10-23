import "server-only";
// May the pooled role write the outbox? `email_outbox` is FORCE RLS with an INSERT policy for `app_user` and nothing else
// (V469), so the dispatcher, the worker, the webhook and the status read all depend on the pooled role being a superuser
// or BYPASSRLS (local and CI `postgres` is a superuser; V451 relies on the same on stg/prod). A role that is neither does
// NOT get an error: its UPDATEs match zero rows, so every send is quietly `deferred` and nothing ever leaves. This turns
// that silence into a loud answer: asked once per process (the role cannot change under a running pool), and exported for
// the Task 4 worker as well as `dispatchNow`.
import { sql, type Tx } from "@/lib/db";

/** The catalogue's answer for the role `db` is running as. `current_user`, so a `set local role` is seen. */
export async function probeOutboxRole(db: Tx | typeof sql): Promise<boolean> {
  const [row] = await (db as typeof sql)<{ ok: boolean }[]>`
    select (rolsuper or rolbypassrls) as ok from pg_roles where rolname = current_user`;
  return row?.ok === true;
}

/** Remember a probe's answer, true or false. A probe that fails is NOT remembered (the next call asks again), and two
 *  callers before the first answer share one probe. */
export function createRoleCheck(probe: () => Promise<boolean>): { ok(): Promise<boolean>; reset(): void } {
  let cached: Promise<boolean> | undefined;
  return {
    ok(): Promise<boolean> {
      if (cached === undefined) {
        const pending = (async () => probe())();
        cached = pending;
        pending.catch(() => {
          if (cached === pending) cached = undefined;
        });
      }
      return cached;
    },
    reset(): void {
      cached = undefined;
    },
  };
}

const pooledRole = createRoleCheck(() => probeOutboxRole(sql));

/** True when the pooled role can write the outbox. Memoised for the life of the process. */
export const outboxRoleOk = (): Promise<boolean> => pooledRole.ok();

/** For tests: forget the remembered answer. */
export const resetOutboxRoleCheck = (): void => pooledRole.reset();
