// R2005 — a REAL fixture, a REAL composed stream session on it and REAL relay tokens, for the DB-backed tests of the
// overlay page's relay access (page-relay.test.ts) and the overlay route's fallback-B field (route-relay.test.ts).
// NOT a test file (importing a .test file re-registers its tests).
//
// The session is a RAW row (the `_session-rig.ts` precedent): only the page's READ of it is under test, never the
// lifecycle that writes it. `last_heartbeat` is written as the jsonb the heartbeat writer stores, so the route's
// `last_heartbeat->>'programmePhase'` read is exercised against the real column.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { seedOrg, GENERIC_CONFIG } from "@/server/usecases/__tests__/_seed";
import { rigTarget, rigUser } from "@/server/relay/__tests__/_session-rig";
import { mintRelayToken, type RelayScope } from "@/server/relay/tokens";

/** A test signing key, set only when the environment has none (the relay tokens refuse to sign without one). */
export function ensureRelaySecret(): () => void {
  const saved = process.env.AUTH_SECRET;
  if (!saved) process.env.AUTH_SECRET = `r2005-relay-overlay-test-${randomUUID()}`;
  return () => {
    if (saved === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = saved;
  };
}

export interface OverlayRig {
  orgId: string;
  competitionId: string;
  divisionId: string;
  fixtureId: string;
  /** A second fixture in the same division (the "session on a different fixture" case). */
  otherFixtureId: string;
  names: [string, string];
}

/** A generic two-entrant league with two fixtures in `visibility`, the org entitled to `streaming.overlay`. */
export async function seedOverlayRig(visibility: "public" | "private" | "unlisted"): Promise<OverlayRig> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Relay Overlay Cup", visibility, branding: {} });
  const division = await createDivision(auth, competition.id, { name: "Open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const names: [string, string] = [`Riverside ${randomUUID().slice(0, 4)}`, `Hillcrest ${randomUUID().slice(0, 4)}`];
  await createEntrants(
    auth,
    division.id,
    [...names, "Third Side"].map((display_name, i) => ({ kind: "individual" as const, display_name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  if (fixtures.length < 2) throw new Error(`seedOverlayRig: expected at least 2 fixtures, got ${fixtures.length}`);
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
            values (${auth.orgId}, 'streaming.overlay', true, 'r2005 relay overlay rig')
            on conflict (org_id, feature_key) do update set bool_value = true`;
  await invalidateOrgEntitlements(auth.orgId);
  return {
    orgId: auth.orgId,
    competitionId: competition.id,
    divisionId: division.id,
    fixtureId: (fixtures[0] as { id: string }).id,
    otherFixtureId: (fixtures[1] as { id: string }).id,
    names,
  };
}

/** Every session this rig seated, so the file's teardown can end them (`endRelaySessions`). */
const seated = new Set<string>();

/** A stream session on `fixtureId`, written raw, in `mode` / `state`, with `heartbeat` as its stored last beat. */
export async function relaySession(
  rig: Pick<OverlayRig, "orgId">,
  fixtureId: string,
  opts: { mode?: "composed" | "passthrough"; state?: string; heartbeat?: Record<string, unknown> | null } = {},
): Promise<string> {
  const { mode = "composed", state = "live", heartbeat = null } = opts;
  // `fixture_stream_sessions_one_active`: one non-terminal session per fixture. Each case seats its own, so the one an
  // earlier case left active is ended first — a test never reuses an earlier case's session.
  await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now())
            where fixture_id = ${fixtureId} and state not in ('completed', 'failed')`;
  const targetId = await rigTarget(rig.orgId);
  const createdBy = await rigUser();
  const [s] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id,
                                         division_id, entitlement_via_override, last_heartbeat)
    select f.id, ${rig.orgId}, ${mode}, ${state}, ${targetId}, ${createdBy}, d.sport_key, d.competition_id, f.division_id,
           true, ${heartbeat === null ? null : sql.json(heartbeat as never)}
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}
    returning id`;
  if (!s) throw new Error(`relaySession: no fixture ${fixtureId}`);
  seated.add(s.id);
  return s.id;
}

/** Teardown: end every session this rig seated. A RUNNING composed session reserves two matches of the ONE recording
 *  pool (`storageReservations`, R2004) and that pool is the whole database's, so a live session left behind refuses
 *  every later composed start — another suite's, or an e2e's on the same local database — `storage_exhausted`. These
 *  raw rows have no inputs, so an ENDED one reserves nothing. Returns how many it ended; throws if any is still open. */
export async function endRelaySessions(): Promise<number> {
  const ids = [...seated];
  seated.clear();
  if (ids.length === 0) return 0;
  const ended = await sql`update fixture_stream_sessions set state = 'completed', ended_at = coalesce(ended_at, now())
                          where id in ${sql(ids)} and state not in ('completed', 'failed')`;
  const [open] = await sql<{ n: number }[]>`
    select count(*)::int as n from fixture_stream_sessions where id in ${sql(ids)} and state not in ('completed', 'failed')`;
  if (open!.n !== 0) throw new Error(`endRelaySessions: ${open!.n} of ${ids.length} session(s) still open`);
  return ended.count;
}

export const relayToken = (sid: string, scope: RelayScope = "relay-page") =>
  mintRelayToken({ sid, scope, expiresAt: new Date(Date.now() + 60 * 60_000) });
