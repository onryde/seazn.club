// server/relay/__tests__/_session-rig.ts — a REAL org, a REAL users row and REAL stream
// sessions for DB-backed tests OUTSIDE server/relay/** (Task 7's stream-credits.test.ts,
// Task 7A's admin read and route tests, Task 9's stream-targets.test.ts via
// `targetEnvelope`). NOT a test file (the _stream-migration.ts
// precedent: importing a .test file re-registers its tests, C20).
// Why it lives INSIDE the boundary: a session needs a target, org_stream_targets.rtmp_enc is
// NOT NULL, and enc-boundary.test.ts claim 2 refuses that column's NAME in any file outside
// server/relay/** — tests included. Session shape: migration-shape.test.ts's insertSession —
// the snapshot columns read from the fixture's own rows, never typed.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { seal } from "../crypto";
import { creditBreakdown, ensureMonthlyStreamGrant } from "@/server/usecases/stream-credits";

/** A real users row. staff_audit_log.actor_id is `not null references users(id)` (V103) and
 *  seedOrg's AuthCtx carries userId: null (_rig.ts) — so every staff credit write needs one. */
export async function rigUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`stream-rig-${randomUUID().slice(0, 8)}@test.local`}, 'Stream Rig', true)
    returning id`;
  return id;
}

/** The RAW sealed destination envelope as stored — for at-rest assertions in tests OUTSIDE
 *  server/relay/** (Task 9's stream-targets.test.ts), which may not name the column (lane C
 *  ruling A9: enc-boundary.test.ts keeps NO `__tests__` exemption). Throws on a missing row:
 *  an absent envelope must never read as "holds no plaintext". */
export async function targetEnvelope(targetId: string): Promise<Buffer> {
  const [row] = await sql<{ env: Uint8Array }[]>`
    select rtmp_enc as env from org_stream_targets where id = ${targetId}`;
  if (!row) throw new Error(`no org_stream_targets row ${targetId}`);
  return Buffer.from(row.env);
}

/** A session's first input's two sealed credential envelopes as stored, hex-encoded — for Task 10's at-rest assertion
 *  in stream-sessions.test.ts (outside server/relay/**, so it may not name the columns: A9). Throws on a missing row
 *  or a null envelope, for the same reason `targetEnvelope` does. */
export async function inputEnvelopesHex(sessionId: string): Promise<{ srt: string; rtmps: string }> {
  const [row] = await sql<{ srt: string | null; rtmps: string | null }[]>`
    select encode(ingest_srt_key_enc, 'hex') as srt, encode(ingest_rtmps_key_enc, 'hex') as rtmps
      from fixture_stream_inputs where session_id = ${sessionId} order by slot asc limit 1`;
  if (!row || row.srt === null || row.rtmps === null) throw new Error(`no sealed input for session ${sessionId}`);
  return { srt: row.srt, rtmps: row.rtmps };
}

/** Re-seal a SAVED target's destination to `rtmp` without the allowlist — the state a target is in when the
 *  allowlist SHRINKS after it was saved (lane C A20: LinkedIn was dropped 2026-09-28). createStreamTarget can never
 *  write this, which is the point: only the provision-time re-check stands between it and a dial. */
export async function resealTargetDestination(targetId: string, rtmp: { url: string; streamKey: string }): Promise<void> {
  const rows = await sql`update org_stream_targets set rtmp_enc = ${seal(JSON.stringify(rtmp))} where id = ${targetId} returning id`;
  if (rows.length !== 1) throw new Error(`no org_stream_targets row ${targetId}`);
}

/** V426 (Task 14b): createSession now grants the org's free monthly credits before it reads the balance, so a rig that
 *  seeds "N credits" would admit N + the plan's rate. This makes THIS period's grant (so createSession's ensure is a
 *  no-op) and then expires it on the spot, leaving the ledger at the pack credits the test chose — the arithmetic every
 *  pre-V426 test was written against. A test ABOUT the monthly grant opts out and lets createSession make it. Returns
 *  the rate it granted and spent (read from V426's row, never typed). */
export async function spendMonthlyStreamGrant(orgId: string): Promise<number> {
  const rate = await ensureMonthlyStreamGrant(orgId);
  const split = await creditBreakdown(sql, orgId);
  if (split.monthly > 0) {
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
      values (${orgId}, ${-split.monthly}, 'expire', 'monthly', ${split.total - split.monthly}, 'rig: monthly grant spent')`;
  }
  return rate;
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
  // One target PER SESSION: V421's fixture_stream_sessions_one_active_target refuses two non-terminal sessions on one
  // destination, and a caller that seats two live sessions on two fixtures (stream-credits.test.ts m2) means two
  // courts, which means two destinations. A raw insert with no dest_fingerprint (a legacy-shaped row — V421's partial
  // index ignores it), because the envelope is fake and nothing here opens it.
  const session = async (fixtureId: string, state = "warming") => {
    const [target] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc)
      values (${auth.orgId}, 'youtube', 'Rig', ${Buffer.from("not-a-real-envelope")}) returning id`;
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
