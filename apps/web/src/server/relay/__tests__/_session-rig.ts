// server/relay/__tests__/_session-rig.ts — a REAL org, a REAL users row and REAL stream
// sessions for DB-backed tests OUTSIDE server/relay/** (Task 7's stream-credits.test.ts,
// Task 7A's admin read and route tests). NOT a test file (the _stream-migration.ts
// precedent: importing a .test file re-registers its tests, C20).
// Why it lives INSIDE the boundary: a session needs a target, org_stream_targets.rtmp_enc is
// NOT NULL, and enc-boundary.test.ts claim 2 refuses that column's NAME in any file outside
// server/relay/** — tests included. Session shape: migration-shape.test.ts's insertSession —
// the snapshot columns read from the fixture's own rows, never typed.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

/** A real users row. staff_audit_log.actor_id is `not null references users(id)` (V103) and
 *  seedOrg's AuthCtx carries userId: null (_rig.ts) — so every staff credit write needs one. */
export async function rigUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`stream-rig-${randomUUID().slice(0, 8)}@test.local`}, 'Stream Rig', true)
    returning id`;
  return id;
}

export interface StreamRig {
  orgId: string;
  /** The users row that authors staff writes and sessions. */
  createdBy: string;
  fixtureIds: string[];
  /** A session on `fixtureId` in `state` (default `warming`), returning its id. */
  session(fixtureId: string, state?: string): Promise<string>;
}

export async function streamRig(opts: { fixtures?: 1 | 2; createdBy?: string } = {}): Promise<StreamRig> {
  const { auth } = await seedOrg();
  const { fixtureIds } = await startedDivisionWithFixture(auth, opts.fixtures === 2 ? { fixtures: 2 } : {});
  const createdBy = opts.createdBy ?? (await rigUser());
  const [target] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${auth.orgId}, 'youtube', 'Rig', ${Buffer.from("not-a-real-envelope")}) returning id`;
  const session = async (fixtureId: string, state = "warming") => {
    const [s] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by,
                                           sport_key, competition_id, division_id, entitlement_via_override)
      select f.id, ${auth.orgId}, 'passthrough', ${state}, ${target!.id}, ${createdBy},
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id
       where f.id = ${fixtureId}
      returning id`;
    return s!.id;
  };
  return { orgId: auth.orgId, createdBy, fixtureIds, session };
}
