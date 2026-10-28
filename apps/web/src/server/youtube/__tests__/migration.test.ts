// YouTube Connect T1 (spec §5): the schema's constraints are only real if something tries to violate them
// (AGENTS.md class 3). Every refusal below names its CONSTRAINT, not just its SQLSTATE, and every refusal has its
// accepted twin in the same `it` (TEST-STRATEGY: a negative assertion owes its positive pair), so a test that passes
// on an EMPTY schema cannot exist — the twin fails first with "relation does not exist".
//
// Real Postgres required (skipped without DATABASE_URL like every suite in server/usecases/__tests__). The new tables
// are reached through the privileged `sql` client: RLS is FORCEd with zero policies and no grant (the stream pattern,
// relay/__tests__/rls-static.test.ts), so `withTenant` (app_user) would see nothing — which is the point.
//
// Sealed columns: enc-boundary.test.ts bars every file outside server/relay/** from naming a stream `*_enc` column, tests
// included. So a PASTED destination is written by its one real producer (`insertStreamTarget` — which also proves that
// producer still works on the new schema), an API destination by omission (the column is NULL), and a pooled key by
// relay/__tests__/_raw-pool-key.ts. `refresh_token_enc` is a YouTube-group column (its owner, token-store.ts, is T2's).
//
// Expected values are the spec's own literals (state lists, the 10-slot cap, `setup`), typed from §5 — never read back
// from the migration. The one declared source we DO read is the stream domain's ACTIVE_STATES / TERMINAL_STATES, which
// the V421 index predicate is defined over.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ACTIVE_STATES, TERMINAL_STATES } from "@/server/relay/domain/session";
import { insertStreamTarget } from "@/server/relay/secret-columns";
import { insertRawPoolKey } from "@/server/relay/__tests__/_raw-pool-key";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;

// insertStreamTarget seals under RELAY_KEK: a KEK of this file's own, and the developer's put back afterwards (or removed
// when there was none — never assigned `undefined`, which Node stores as the string "undefined"). Never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

// ---- spec literals ------------------------------------------------------------------------------------------------
const BROADCAST_STATES = ["created", "bound", "reserved", "live", "ending", "complete", "failed"] as const;
/** §5.4: at most one OPEN broadcast per fixture — `ending` is NOT open here (a restart may follow a Stop). */
const OPEN_FOR_FIXTURE = ["created", "bound", "reserved", "live"];
/** §5.4: at most one open broadcast per KEY — `ending` IS open (the stream is still on the key). */
const OPEN_FOR_KEY = ["created", "bound", "reserved", "live", "ending"];
const NOT_OPEN_FOR_FIXTURE = ["ending", "complete", "failed"];
const NOT_OPEN_FOR_KEY = ["complete", "failed"];
const PRIVACIES = ["unlisted", "public", "private"];
const CONNECTION_STATUSES = ["connected", "reconnect_needed", "revoked"] as const;
/** The one scope Seazn asks for (spec §3.1). */
const SCOPE = "https://www.googleapis.com/auth/youtube";
const NEW_TABLES = ["org_youtube_connections", "youtube_connect_pending", "youtube_stream_keys", "youtube_broadcasts"];

const FAKE_ENVELOPE = () => Buffer.from(`not-a-real-envelope-${randomUUID()}`);
const uniq = () => randomUUID().slice(0, 8);

// ---- rig ----------------------------------------------------------------------------------------------------------
type World = { orgId: string; userId: string; fixtures: string[] };

async function newUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name) values (${`yt-${randomUUID()}@example.test`}, 'YT Tester') returning id`;
  return row!.id;
}

/** An org, a real user, and `fixtureCount` fixtures. Fixtures come two to a division (one {fixtures: 2} call), so
 *  `fixtures[0]` and `fixtures[2]` are in DIFFERENT divisions — the view test needs that. */
async function world(fixtureCount = 0): Promise<World> {
  const { auth } = await seedOrg();
  const fixtures: string[] = [];
  while (fixtures.length < fixtureCount) {
    const d = await startedDivisionWithFixture(auth, { fixtures: 2 });
    fixtures.push(...d.fixtureIds);
  }
  return { orgId: auth.orgId, userId: await newUser(), fixtures };
}

async function connection(
  w: Pick<World, "orgId" | "userId">,
  o: { channel?: string; status?: (typeof CONNECTION_STATUSES)[number]; token?: boolean; revokedAt?: boolean; privacy?: string; consentBy?: string; createdBy?: string } = {},
): Promise<string> {
  const status = o.status ?? "connected";
  const hasToken = o.token ?? status !== "revoked";
  const hasRevokedAt = o.revokedAt ?? status === "revoked";
  const [row] = await sql<{ id: string }[]>`
    insert into org_youtube_connections (org_id, channel_id, channel_title, google_sub, refresh_token_enc, granted_scope,
                                         default_privacy, consent_by, consent_at, consent_version, status, created_by, revoked_at)
    values (${w.orgId}, ${o.channel ?? `UC${uniq()}`}, 'Club channel', ${`sub-${uniq()}`}, ${hasToken ? FAKE_ENVELOPE() : null}, ${SCOPE},
            ${o.privacy ?? "unlisted"}, ${o.consentBy ?? w.userId}, now(), 1, ${status}, ${o.createdBy ?? w.userId}, ${hasRevokedAt ? new Date() : null})
    returning id`;
  return row!.id;
}

/** Set a connection to revoked the way T2's token store does: ONE statement — the token, the status, revoked_at, and the
 *  channel's id and title (DP III.E.4: they do not outlive an in-app revoke). */
async function revoke(connectionId: string): Promise<void> {
  await sql`update org_youtube_connections set refresh_token_enc = null, status = 'revoked', revoked_at = now(), channel_id = null, channel_title = null where id = ${connectionId}`;
}

async function key(w: Pick<World, "orgId">, connectionId: string, slot: number, liveStreamId = `ls-${slot}-${uniq()}`): Promise<string> {
  return insertRawPoolKey({ orgId: w.orgId, connectionId, slot, liveStreamId });
}

async function retire(connectionId: string, slot: number): Promise<void> {
  await sql`update youtube_stream_keys set retired_at = now() where connection_id = ${connectionId} and slot = ${slot} and retired_at is null`;
}

async function broadcast(
  w: Pick<World, "orgId">,
  o: {
    connection: string; fixture: string; key: string | null; state: string; reservedUntil?: boolean; id?: string; privacy?: string;
    /** Default: a real video id. Pass null for a broadcast that never reached YouTube. */
    ytId?: string | null;
    /** Default: now for a `complete` row (a part must know when it finished), null for every other state. */
    completedAt?: Date | null;
    /** When the broadcast was STARTED (its row created): a part's number follows this. Default: the statement's now(). */
    createdAt?: Date;
  },
): Promise<string> {
  const reservedUntil = o.reservedUntil ?? o.state === "reserved";
  const ytId = o.ytId === undefined ? `yt-${uniq()}` : o.ytId;
  const completedAt = o.completedAt === undefined ? (o.state === "complete" ? new Date() : null) : o.completedAt;
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_broadcasts (id, org_id, connection_id, fixture_id, key_id, yt_broadcast_id, title, privacy, state, reserved_until, completed_at, created_at)
    values (${o.id ?? randomUUID()}, ${w.orgId}, ${o.connection}, ${o.fixture}, ${o.key}, ${ytId}, 'Match', ${o.privacy ?? "unlisted"}, ${o.state},
            ${reservedUntil ? new Date(Date.now() + 5 * 60_000) : null}, ${completedAt}, ${o.createdAt ?? sql`now()`})
    returning id`;
  return row!.id;
}

async function setState(broadcastId: string, state: string): Promise<void> {
  // The way the end step will write it: a complete row gets its finish time in the SAME statement.
  await sql`update youtube_broadcasts set state = ${state},
              reserved_until = case when ${state} = 'reserved' then now() + interval '5 minutes' else null end,
              completed_at = case when ${state} = 'complete' then now() else completed_at end
            where id = ${broadcastId}`;
}

async function target(w: Pick<World, "orgId">, o: { rtmp: boolean; connectionId: string | null; kind?: string }): Promise<string> {
  const kind = o.kind ?? "youtube";
  if (o.rtmp) {
    // A pasted row, written by its real producer (the url + key sealed, the fingerprint set).
    const stored = await sql.begin((tx) => insertStreamTarget(tx, {
      orgId: w.orgId, kind, label: "Destination", watchUrl: null,
      rtmp: { url: "rtmps://a.rtmps.youtube.com/live2", streamKey: `key-${randomUUID()}` },
    }));
    if (o.connectionId === null) return stored.id;
    // BOTH sources: an UPDATE reaches the same CHECK an INSERT would.
    await sql`update org_stream_targets set youtube_connection_id = ${o.connectionId} where id = ${stored.id}`;
    return stored.id;
  }
  // An API-backed row (or, with no connection, NEITHER source): the sealed column is simply left out, so it is NULL.
  const [row] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, youtube_connection_id)
    values (${w.orgId}, ${kind}, 'Destination', ${o.connectionId})
    returning id`;
  return row!.id;
}

/** A raw session insert whose NOT NULL snapshot facts come from the fixture's own division (migration-shape's rule). */
async function session(
  w: World,
  // `apiBacked` defaults to "names a broadcast": the flag is what exempts a session from the pasted one-per-target rule.
  o: { fixture: string; target: string; broadcast: string | null; state?: string; apiBacked?: boolean },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, started_at,
                                         sport_key, competition_id, division_id, entitlement_via_override, youtube_broadcast_id, api_backed)
    select ${o.fixture}, ${w.orgId}, 'passthrough', ${o.state ?? "live"}, ${o.target}, ${w.userId}, now(),
           d.sport_key, d.competition_id, f.division_id, true, ${o.broadcast}, ${o.apiBacked ?? o.broadcast !== null}
      from fixtures f join divisions d on d.id = f.division_id where f.id = ${o.fixture}
    returning id`;
  return row!.id;
}

const countOf = async (table: string, where: string, value: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where ${sql(where)} = ${value}`;
  return r!.n;
};

describe.skipIf(!HAS_DB)("the youtube_connect delta — the constraints are real", () => {
  // ---- org_stream_targets: exactly one source -------------------------------------------------------------------
  it("a destination row has exactly one source: both or neither is refused, each one alone is accepted", async () => {
    const w = await world();
    const c = await connection(w);
    await expect(target(w, { rtmp: true, connectionId: c })).rejects.toMatchObject({ code: "23514", constraint_name: "org_stream_targets_one_source" });
    await expect(target(w, { rtmp: false, connectionId: null })).rejects.toMatchObject({ code: "23514", constraint_name: "org_stream_targets_one_source" });
    // The positive pair: a pasted-key row (rtmp only) and an API row (connection only, rtmp NULL — the column is nullable now).
    await expect(target(w, { rtmp: true, connectionId: null })).resolves.toBeTruthy();
    await expect(target(w, { rtmp: false, connectionId: c })).resolves.toBeTruthy();
  });

  it("a connection can back only a kind 'youtube' destination: any other kind is refused by name; youtube (API) and a pasted twitch row are accepted", async () => {
    const w = await world();
    const c = await connection(w);
    let refused = 0;
    for (const kind of ["facebook", "twitch", "kick", "custom_rtmp"]) {
      // rtmp is NULL and the connection is set, so `one_source` is SATISFIED — only the kind check can be refusing this.
      await expect(target(w, { rtmp: false, connectionId: c, kind }), kind).rejects.toMatchObject({
        code: "23514", constraint_name: "org_stream_targets_connection_is_youtube",
      });
      refused++;
    }
    expect(refused).toBe(4);
    await expect(target(w, { rtmp: false, connectionId: c, kind: "youtube" })).resolves.toBeTruthy();
    await expect(target(w, { rtmp: true, connectionId: null, kind: "twitch" })).resolves.toBeTruthy();   // a pasted twitch row is untouched
  });

  // ---- fixture_stream_sessions: one active session per PASTED target only ------------------------------------------
  it("two ACTIVE sessions on one API target are allowed (one per broadcast), in every active state", async () => {
    const w = await world(2);
    const [fA, fB] = w.fixtures as [string, string];
    const c = await connection(w);
    const api = await target(w, { rtmp: false, connectionId: c });
    const bA = await broadcast(w, { connection: c, fixture: fA, key: await key(w, c, 1), state: "live" });
    const bB = await broadcast(w, { connection: c, fixture: fB, key: await key(w, c, 2), state: "live" });
    let checked = 0;
    for (const state of ACTIVE_STATES) {
      await session(w, { fixture: fA, target: api, broadcast: bA, state });
      await expect(session(w, { fixture: fB, target: api, broadcast: bB, state }), state).resolves.toBeTruthy();
      await sql`delete from fixture_stream_sessions where org_id = ${w.orgId}`;
      checked++;
    }
    expect(checked, "the ACTIVE_STATES loop checked nothing").toBe(ACTIVE_STATES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("on a PASTED target the second active session is still 23505, in every active state; a terminal one never collides", async () => {
    const w = await world(2);
    const [fA, fB] = w.fixtures as [string, string];
    const pasted = await target(w, { rtmp: true, connectionId: null });
    let refused = 0;
    for (const state of ACTIVE_STATES) {
      await session(w, { fixture: fA, target: pasted, broadcast: null, state });
      await expect(session(w, { fixture: fB, target: pasted, broadcast: null, state }), state).rejects.toMatchObject({
        code: "23505", constraint_name: "fixture_stream_sessions_one_active_target",
      });
      await sql`delete from fixture_stream_sessions where org_id = ${w.orgId}`;
      refused++;
    }
    expect(refused).toBe(ACTIVE_STATES.length);
    // The positive pair: terminal rows land beside a live holder, and beside each other.
    await session(w, { fixture: fA, target: pasted, broadcast: null, state: "live" });
    let accepted = 0;
    for (const state of TERMINAL_STATES) {
      await expect(session(w, { fixture: fB, target: pasted, broadcast: null, state }), state).resolves.toBeTruthy();
      accepted++;
    }
    expect(accepted).toBe(TERMINAL_STATES.length);
    expect(accepted).toBeGreaterThan(0);
  });

  it("deleting the broadcasts of two active API sessions on one target succeeds and leaves both sessions active, in every active state (the FK's set null cannot move a session under the pasted rule)", async () => {
    const w = await world(2);
    const [fA, fB] = w.fixtures as [string, string];
    const c = await connection(w);
    const api = await target(w, { rtmp: false, connectionId: c });
    const [kA, kB] = [await key(w, c, 1), await key(w, c, 2)];
    let checked = 0;
    for (const state of ACTIVE_STATES) {
      const bA = await broadcast(w, { connection: c, fixture: fA, key: kA, state: "live" });
      const bB = await broadcast(w, { connection: c, fixture: fB, key: kB, state: "live" });
      const sA = await session(w, { fixture: fA, target: api, broadcast: bA, state });
      const sB = await session(w, { fixture: fB, target: api, broadcast: bB, state });
      // ONE statement removes both rows, so both sessions' broadcast ids are nulled in the same FK action: if either
      // fell back under the pasted index, the other would collide with it and this statement would fail with 23505.
      await expect(sql`delete from youtube_broadcasts where id in ${sql([bA, bB])}`, state).resolves.toBeDefined();
      const left = await sql<{ id: string; state: string; youtube_broadcast_id: string | null; api_backed: boolean }[]>`
        select id, state, youtube_broadcast_id, api_backed from fixture_stream_sessions where id in ${sql([sA, sB])}`;
      expect(left.length, `${state}: both sessions survive`).toBe(2);
      for (const r of left) expect(r, `${state}`).toMatchObject({ state, youtube_broadcast_id: null, api_backed: true });
      await sql`delete from fixture_stream_sessions where org_id = ${w.orgId}`;
      checked++;
    }
    expect(checked, "the ACTIVE_STATES loop checked nothing").toBe(ACTIVE_STATES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("api_backed: NOT NULL default false (an existing session is a pasted one); a session naming a broadcast must carry it; one admitted before its broadcast row exists is exempt too", async () => {
    const [shape] = await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'fixture_stream_sessions' and column_name = 'api_backed'`;
    expect(shape).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const w = await world(3);
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    const c = await connection(w);
    const api = await target(w, { rtmp: false, connectionId: c });
    const b = await broadcast(w, { connection: c, fixture: f1, key: await key(w, c, 1), state: "live" });
    await expect(session(w, { fixture: f1, target: api, broadcast: b, apiBacked: false })).rejects.toMatchObject({
      code: "23514", constraint_name: "fixture_stream_sessions_broadcast_implies_api_backed",
    });
    // The positive pair, and the converse that is NOT required: api_backed with no broadcast (yet, or any more).
    await expect(session(w, { fixture: f1, target: api, broadcast: b, apiBacked: true })).resolves.toBeTruthy();
    await expect(session(w, { fixture: f2, target: api, broadcast: null, apiBacked: true })).resolves.toBeTruthy();
    await expect(session(w, { fixture: f3, target: api, broadcast: null, apiBacked: true }), "two api_backed sessions, neither naming a broadcast").resolves.toBeTruthy();
    // ...whereas a session that is NOT api_backed on that target is still exclusive against another one that is not.
    await sql`delete from fixture_stream_sessions where org_id = ${w.orgId}`;
    await session(w, { fixture: f2, target: api, broadcast: null, apiBacked: false });
    await expect(session(w, { fixture: f3, target: api, broadcast: null, apiBacked: false })).rejects.toMatchObject({
      code: "23505", constraint_name: "fixture_stream_sessions_one_active_target",
    });
  });

  // ---- youtube_broadcasts: one open per fixture, one open per key ------------------------------------------------------
  it("one open broadcast per fixture — and an ENDING one does not block a new one (the restart), even after the new one exists", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const [k1, k2] = [await key(w, c, 1), await key(w, c, 2)];
    // Different keys, so the PER-KEY index cannot be what refuses the second row.
    const b1 = await broadcast(w, { connection: c, fixture: f, key: k1, state: "live" });
    await expect(broadcast(w, { connection: c, fixture: f, key: k2, state: "created" })).rejects.toMatchObject({
      code: "23505", constraint_name: "youtube_broadcasts_one_open_per_fixture",
    });
    await setState(b1, "ending");
    const b2 = await broadcast(w, { connection: c, fixture: f, key: k2, state: "created" });
    expect(b2).toBeTruthy();
    // The sequence: with b2 open, flipping the ending b1 BACK to live is refused (an UPDATE reaches the same index).
    await expect(setState(b1, "live")).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_broadcasts_one_open_per_fixture" });
  });

  it("per-fixture sweep over every state: created/bound/reserved/live block a second row; ending/complete/failed do not", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const [k1, k2] = [await key(w, c, 1), await key(w, c, 2)];
    let refused = 0, accepted = 0;
    for (const state of BROADCAST_STATES) {
      await broadcast(w, { connection: c, fixture: f, key: k1, state });
      const second = broadcast(w, { connection: c, fixture: f, key: k2, state: "created" });
      if (OPEN_FOR_FIXTURE.includes(state)) {
        await expect(second, state).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_broadcasts_one_open_per_fixture" });
        refused++;
      } else {
        await expect(second, state).resolves.toBeTruthy();
        accepted++;
      }
      await sql`delete from youtube_broadcasts where fixture_id = ${f}`;
    }
    expect(refused, "open states checked").toBe(OPEN_FOR_FIXTURE.length);
    expect(accepted, "not-open states checked").toBe(NOT_OPEN_FOR_FIXTURE.length);
    expect(refused + accepted).toBe(BROADCAST_STATES.length);
  });

  it("one open broadcast per key, ending INCLUDED; complete (and failed) free the key — per-key sweep and the brief's sequence", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const c = await connection(w);
    const k1 = await key(w, c, 1);
    // The sequence: ending holds the key; complete frees it. Different fixtures, so the PER-FIXTURE index cannot be the refuser.
    const b1 = await broadcast(w, { connection: c, fixture: f1, key: k1, state: "ending" });
    await expect(broadcast(w, { connection: c, fixture: f2, key: k1, state: "created" })).rejects.toMatchObject({
      code: "23505", constraint_name: "youtube_broadcasts_one_open_per_key",
    });
    await setState(b1, "complete");
    await expect(broadcast(w, { connection: c, fixture: f2, key: k1, state: "created" })).resolves.toBeTruthy();
    await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
    // The sweep over every state.
    let refused = 0, accepted = 0;
    for (const state of BROADCAST_STATES) {
      await broadcast(w, { connection: c, fixture: f1, key: k1, state });
      const second = broadcast(w, { connection: c, fixture: f2, key: k1, state: "created" });
      if (OPEN_FOR_KEY.includes(state)) {
        await expect(second, state).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_broadcasts_one_open_per_key" });
        refused++;
      } else {
        await expect(second, state).resolves.toBeTruthy();
        accepted++;
      }
      await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
    }
    expect(refused, "open states checked").toBe(OPEN_FOR_KEY.length);
    expect(accepted, "not-open states checked").toBe(NOT_OPEN_FOR_KEY.length);
    expect(refused + accepted).toBe(BROADCAST_STATES.length);
  });

  it("a broadcast with no key yet never collides on the key index (two keyless open rows on different fixtures)", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const c = await connection(w);
    await broadcast(w, { connection: c, fixture: f1, key: null, state: "created" });
    await expect(broadcast(w, { connection: c, fixture: f2, key: null, state: "created" })).resolves.toBeTruthy();
  });

  it("reserved ⇔ reserved_until: both directions refused as youtube_broadcasts_reserved_until; reserved + reserved_until accepted; and the state set is closed", async () => {
    const w = await world(3);
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    const c = await connection(w);
    const k = [await key(w, c, 1), await key(w, c, 2), await key(w, c, 3)] as [string, string, string];
    await expect(broadcast(w, { connection: c, fixture: f1, key: k[0], state: "reserved", reservedUntil: false })).rejects.toMatchObject({
      code: "23514", constraint_name: "youtube_broadcasts_reserved_until",
    });
    await expect(broadcast(w, { connection: c, fixture: f1, key: k[0], state: "live", reservedUntil: true })).rejects.toMatchObject({
      code: "23514", constraint_name: "youtube_broadcasts_reserved_until",
    });
    await expect(broadcast(w, { connection: c, fixture: f1, key: k[0], state: "reserved", reservedUntil: true })).resolves.toBeTruthy();
    await expect(broadcast(w, { connection: c, fixture: f2, key: k[1], state: "live", reservedUntil: false })).resolves.toBeTruthy();
    // The state set is closed: every legal state is accepted (a sweep, counted) and an invented one is refused by name.
    await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
    let accepted = 0;
    for (const state of BROADCAST_STATES) {
      await expect(broadcast(w, { connection: c, fixture: f3, key: k[2], state }), state).resolves.toBeTruthy();
      await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
      accepted++;
    }
    expect(accepted).toBe(BROADCAST_STATES.length);
    await expect(broadcast(w, { connection: c, fixture: f3, key: k[2], state: "paused" })).rejects.toMatchObject({
      code: "23514", constraint_name: "youtube_broadcasts_state_check",
    });
  });

  // ---- youtube_stream_keys ------------------------------------------------------------------------------------------
  it("a connection holds at most 10 live keys — slot 11 (and 0) are refused, a duplicate live slot is 23505, a retired slot is reusable, and a live stream is pooled once", async () => {
    const w = await world();
    const c = await connection(w);
    for (let s = 1; s <= 10; s++) await key(w, c, s);   // 10: YouTube's per-channel concurrent cap (spec §3.1)
    await expect(key(w, c, 11)).rejects.toMatchObject({ code: "23514", constraint_name: "youtube_stream_keys_slot_range" });
    await expect(key(w, c, 0)).rejects.toMatchObject({ code: "23514", constraint_name: "youtube_stream_keys_slot_range" });
    await expect(key(w, c, 3)).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_stream_keys_one_live_slot" });
    await retire(c, 3);
    await expect(key(w, c, 3)).resolves.toBeTruthy();
    // One YouTube liveStream is pooled once per connection — retired rows included (the unique is NOT partial).
    const [pooled] = await sql<{ ls: string }[]>`select live_stream_id as ls from youtube_stream_keys where connection_id = ${c} and slot = 4`;
    const ls = pooled!.ls;
    await retire(c, 4);   // slot 4 is free again, so only the (connection, liveStream) unique can refuse the repeat below
    await expect(key(w, c, 4, ls)).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_stream_keys_connection_live_stream_uniq" });
    // ...and on a DIFFERENT free slot too: the unique is (connection, liveStream), not (connection, slot, liveStream).
    await retire(c, 5);
    await expect(key(w, c, 5, ls)).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_stream_keys_connection_live_stream_uniq" });
    // Positive pair: the same liveStream id on ANOTHER connection is its own row.
    const other = await connection(w);
    await expect(key(w, other, 1, ls)).resolves.toBeTruthy();
  });

  // ---- org_youtube_connections ------------------------------------------------------------------------------------------
  it("a channel is live in at most one org — connected and reconnect_needed both hold it; revoking frees it for another org", async () => {
    const o1 = await world(), o2 = await world();
    const ch = `UC${uniq()}`;
    const c = await connection(o1, { channel: ch, status: "connected" });
    await expect(connection(o2, { channel: ch, status: "connected" })).rejects.toMatchObject({
      code: "23505", constraint_name: "org_youtube_connections_one_live_channel",
    });
    await expect(connection(o1, { channel: ch, status: "connected" })).rejects.toMatchObject({
      code: "23505", constraint_name: "org_youtube_connections_one_live_channel",
    });   // the same org too: a channel is one live row, full stop
    await sql`update org_youtube_connections set status = 'reconnect_needed' where id = ${c}`;
    await expect(connection(o2, { channel: ch, status: "connected" })).rejects.toMatchObject({
      code: "23505", constraint_name: "org_youtube_connections_one_live_channel",
    });   // a dead grant still HOLDS the channel until it is revoked
    await revoke(c);
    const taken = await connection(o2, { channel: ch, status: "connected" });
    expect(taken).toBeTruthy();
    // Revoked rows are history: any number of them beside the live one, and beside each other.
    await expect(connection(o1, { channel: ch, status: "revoked" })).resolves.toBeTruthy();
    await expect(connection(o1, { channel: ch, status: "revoked" })).resolves.toBeTruthy();
    // Four rows were made for this channel, but the first was revoked through `revoke`, which scrubs the channel (a revoke
    // leaves the id behind for no one): so three still carry it — the live one and the two revoked rows inserted holding it.
    expect(await countOf("org_youtube_connections", "channel_id", ch)).toBe(3);
  });

  it("revoked ⇔ no token and revoked ⇔ revoked_at: all four directions refused BY NAME; both consistent shapes (and the third status) accepted", async () => {
    const w = await world();
    const noToken = { code: "23514", constraint_name: "org_youtube_connections_revoked_no_token" };
    const revokedAt = { code: "23514", constraint_name: "org_youtube_connections_revoked_at" };
    await expect(connection(w, { status: "connected", token: false })).rejects.toMatchObject(noToken);
    await expect(connection(w, { status: "revoked", token: true })).rejects.toMatchObject(noToken);
    await expect(connection(w, { status: "connected", revokedAt: true })).rejects.toMatchObject(revokedAt);
    await expect(connection(w, { status: "revoked", revokedAt: false })).rejects.toMatchObject(revokedAt);
    // reconnect_needed is a LIVE state: it keeps its (dead) token, and may not drop it.
    await expect(connection(w, { status: "reconnect_needed", token: false })).rejects.toMatchObject(noToken);
    // Positive pair: the consistent shapes.
    await expect(connection(w, { status: "connected", token: true, revokedAt: false })).resolves.toBeTruthy();
    await expect(connection(w, { status: "revoked", token: false, revokedAt: true })).resolves.toBeTruthy();
    await expect(connection(w, { status: "reconnect_needed", token: true, revokedAt: false })).resolves.toBeTruthy();
    // The SEQUENCE T2's store runs: a connected row revoked in ONE statement passes; a half-revoke (token cleared, status left) is refused.
    const c = await connection(w);
    await expect(sql`update org_youtube_connections set refresh_token_enc = null where id = ${c}`).rejects.toMatchObject(noToken);
    await expect(sql`update org_youtube_connections set status = 'revoked', revoked_at = now() where id = ${c}`).rejects.toMatchObject(noToken);
    await expect(sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null where id = ${c}`).rejects.toMatchObject(revokedAt);
    await expect(revoke(c)).resolves.toBeUndefined();
  });

  it("a LIVE connection must name its channel: a null channel_id or channel_title is refused BY NAME for connected and reconnect_needed; a revoked row may hold neither, or both", async () => {
    const w = await world();
    const named = { code: "23514", constraint_name: "org_youtube_connections_live_has_channel" };
    const raw = (o: { status: "connected" | "reconnect_needed" | "revoked"; id: string | null; title: string | null }) => sql`
      insert into org_youtube_connections (org_id, channel_id, channel_title, refresh_token_enc, granted_scope, consent_by, consent_at,
                                           consent_version, status, created_by, revoked_at)
      values (${w.orgId}, ${o.id}, ${o.title}, ${o.status === "revoked" ? null : FAKE_ENVELOPE()}, ${SCOPE}, ${w.userId}, now(), 1, ${o.status}, ${w.userId},
              ${o.status === "revoked" ? new Date() : null})`;
    let refused = 0;
    for (const status of ["connected", "reconnect_needed"] as const) {
      await expect(raw({ status, id: null, title: "Club channel" }), `${status}, no id`).rejects.toMatchObject(named);
      await expect(raw({ status, id: `UC${uniq()}`, title: null }), `${status}, no title`).rejects.toMatchObject(named);
      await expect(raw({ status, id: null, title: null }), `${status}, neither`).rejects.toMatchObject(named);
      refused += 3;
    }
    expect(refused).toBe(6);
    // the positive pairs: live and named is accepted; revoked is accepted with neither, and with both (history may keep them)
    await expect(raw({ status: "connected", id: `UC${uniq()}`, title: "Club channel" })).resolves.toBeDefined();
    await expect(raw({ status: "reconnect_needed", id: `UC${uniq()}`, title: "Club channel" })).resolves.toBeDefined();
    await expect(raw({ status: "revoked", id: null, title: null })).resolves.toBeDefined();
    await expect(raw({ status: "revoked", id: `UC${uniq()}`, title: "Club channel" })).resolves.toBeDefined();
    // the SEQUENCE: a live row scrubbed WITHOUT being revoked is refused (the revoke must be one statement), and many scrubbed rows coexist (nulls are distinct)
    const c = await connection(w);
    await expect(sql`update org_youtube_connections set channel_id = null, channel_title = null where id = ${c}`).rejects.toMatchObject(named);
    await expect(revoke(c)).resolves.toBeUndefined();
    await expect(revoke(await connection(w))).resolves.toBeUndefined();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where org_id = ${w.orgId} and status = 'revoked' and channel_id is null`;
    expect(n!.n, "scrubbed revoked rows sit side by side: the raw one and the two revoked through revoke()").toBe(3);
  });

  it("the closed sets: each legal status and privacy is accepted (counted), an unlisted one is refused by name — on connections and on pending", async () => {
    const w = await world();
    let accepted = 0;
    for (const privacy of PRIVACIES) { await connection(w, { privacy }); accepted++; }
    for (const status of CONNECTION_STATUSES) { await connection(w, { status }); accepted++; }
    expect(accepted).toBe(PRIVACIES.length + CONNECTION_STATUSES.length);
    expect(accepted).toBeGreaterThan(0);
    await expect(connection(w, { privacy: "friends" })).rejects.toMatchObject({
      code: "23514", constraint_name: "org_youtube_connections_default_privacy_check",
    });
    await expect(sql`
      insert into org_youtube_connections (org_id, channel_id, channel_title, granted_scope, consent_by, consent_at, consent_version, status, created_by, refresh_token_enc)
      values (${w.orgId}, ${`UC${uniq()}`}, 't', ${SCOPE}, ${w.userId}, now(), 1, 'paused', ${w.userId}, ${FAKE_ENVELOPE()})`,
    ).rejects.toMatchObject({ code: "23514", constraint_name: "org_youtube_connections_status_check" });
    const pending = (privacy: string) => sql`
      insert into youtube_connect_pending (state_hash, org_id, user_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
      values (${randomUUID()}, ${w.orgId}, ${w.userId}, ${privacy}, false, 1, now(), now() + interval '10 minutes')`;
    await expect(pending("friends")).rejects.toMatchObject({ code: "23514", constraint_name: "youtube_connect_pending_default_privacy_check" });
    for (const privacy of PRIVACIES) await expect(pending(privacy), privacy).resolves.toBeTruthy();
  });

  it("a broadcast's privacy is a closed set: each legal value is accepted (counted), an unlisted one is refused by name", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    let accepted = 0;
    // `failed` rows are not open, so one fixture and no key hold all three.
    for (const privacy of PRIVACIES) { await expect(broadcast(w, { connection: c, fixture: f, key: null, state: "failed", privacy }), privacy).resolves.toBeTruthy(); accepted++; }
    expect(accepted).toBe(PRIVACIES.length);
    expect(accepted).toBeGreaterThan(0);
    await expect(broadcast(w, { connection: c, fixture: f, key: null, state: "failed", privacy: "friends" })).rejects.toMatchObject({
      code: "23514", constraint_name: "youtube_broadcasts_privacy_check",
    });
  });

  it("last_error_code holds a CODE: [a-z_:]{1,64} is accepted, anything shaped like a Google body or a credential is refused by name — on connections and on broadcasts", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const b = await broadcast(w, { connection: c, fixture: f, key: null, state: "failed" });
    const good = ["invalid_grant", "quota_exceeded", "youtube:rate_limited", "x", "x".repeat(64)];
    const bad = [
      '{"error":{"code":401,"message":"Invalid Credentials"}}',   // a Google error body
      "Invalid Credentials",                                       // prose
      "invalid grant",                                             // a space
      "INVALID_GRANT",                                             // upper case
      "ya29.a0AfH6SMB-not-a-real-token",                           // a credential's alphabet: digits, dots, hyphens, mixed case
      "ya29.a0af-not-a-real-token-123",                            // the same in lower case: digits, dots and hyphens alone are not a code
      "x".repeat(65),                                              // one past the cap
      "",                                                          // empty is not a code
    ];
    const writers = {
      org_youtube_connections: { name: "org_youtube_connections_last_error_code_shape", put: (v: string | null) => sql`update org_youtube_connections set last_error_code = ${v} where id = ${c}` },
      youtube_broadcasts: { name: "youtube_broadcasts_last_error_code_shape", put: (v: string | null) => sql`update youtube_broadcasts set last_error_code = ${v} where id = ${b}` },
    };
    let accepted = 0, refused = 0;
    for (const [table, wr] of Object.entries(writers)) {
      for (const v of good) { await expect(wr.put(v), `${table} accepts ${v.slice(0, 20)}`).resolves.toBeDefined(); accepted++; }
      await expect(wr.put(null), `${table} accepts no error`).resolves.toBeDefined();
      for (const v of bad) {
        await expect(wr.put(v), `${table} refuses ${v.slice(0, 20)}`).rejects.toMatchObject({ code: "23514", constraint_name: wr.name });
        refused++;
      }
    }
    expect(accepted, "accepted writes").toBe(good.length * 2);
    expect(refused, "refused writes").toBe(bad.length * 2);
    // Nothing the refused writes tried is stored: the last accepted value stands.
    const [conn] = await sql<{ last_error_code: string | null }[]>`select last_error_code from org_youtube_connections where id = ${c}`;
    expect(conn!.last_error_code).toBeNull();
  });

  it("a COMPLETE broadcast has both a finish time and a video id (both directions refused by name, on insert and on the state flip); every other state may hold neither", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const k = await key(w, c, 1);
    const facts = { code: "23514", constraint_name: "youtube_broadcasts_complete_has_facts" };
    await expect(broadcast(w, { connection: c, fixture: f, key: k, state: "complete", completedAt: null })).rejects.toMatchObject(facts);
    await expect(broadcast(w, { connection: c, fixture: f, key: k, state: "complete", ytId: null })).rejects.toMatchObject(facts);
    await expect(broadcast(w, { connection: c, fixture: f, key: k, state: "complete", ytId: null, completedAt: null })).rejects.toMatchObject(facts);
    await expect(broadcast(w, { connection: c, fixture: f, key: k, state: "complete" }), "both present").resolves.toBeTruthy();
    await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
    // Every state but complete may hold neither fact (a row that never reached YouTube, or has not finished).
    let accepted = 0;
    for (const state of BROADCAST_STATES.filter((x) => x !== "complete")) {
      await expect(broadcast(w, { connection: c, fixture: f, key: k, state, ytId: null, completedAt: null }), state).resolves.toBeTruthy();
      await sql`delete from youtube_broadcasts where org_id = ${w.orgId}`;
      accepted++;
    }
    expect(accepted).toBe(BROADCAST_STATES.length - 1);
    // The flip: an open row cannot become complete without its finish time, nor without a video id.
    const noVideo = await broadcast(w, { connection: c, fixture: f, key: k, state: "live", ytId: null });
    await expect(sql`update youtube_broadcasts set state = 'complete', completed_at = now() where id = ${noVideo}`).rejects.toMatchObject(facts);
    const noTime = await broadcast(w, { connection: c, fixture: f, key: await key(w, c, 2), state: "ending" });
    await expect(sql`update youtube_broadcasts set state = 'complete' where id = ${noTime}`).rejects.toMatchObject(facts);
    await expect(setState(noTime, "complete")).resolves.toBeUndefined();
  });

  // ---- youtube_connect_pending --------------------------------------------------------------------------------------------
  it("a pending OAuth row: state_hash is unique, a reconnect target and a sealed grant are optional, and a fresh row starts with no token", async () => {
    const w = await world();
    const c = await connection(w);
    const stateHash = randomUUID();
    const put = (hash: string, connectionId: string | null) => sql<{ id: string }[]>`
      insert into youtube_connect_pending (state_hash, org_id, user_id, connection_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
      values (${hash}, ${w.orgId}, ${w.userId}, ${connectionId}, 'unlisted', false, 1, now(), now() + interval '10 minutes')
      returning id`;
    await put(stateHash, null);
    await expect(put(stateHash, null)).rejects.toMatchObject({ code: "23505", constraint_name: "youtube_connect_pending_state_hash_key" });
    await expect(put(randomUUID(), c)).resolves.toBeTruthy();   // the reconnect target
    const [row] = await put(randomUUID(), null);
    const [fresh] = await sql<{ refresh_token_enc: Buffer | null; granted_scope: string | null; google_sub: string | null; channels: unknown }[]>`
      select refresh_token_enc, granted_scope, google_sub, channels from youtube_connect_pending where id = ${row!.id}`;
    expect(fresh).toEqual({ refresh_token_enc: null, granted_scope: null, google_sub: null, channels: null });
    // After a multi-channel grant the row holds the sealed token and the picker's list.
    await sql`update youtube_connect_pending set refresh_token_enc = ${FAKE_ENVELOPE()}, granted_scope = ${SCOPE}, google_sub = 'sub',
                channels = ${sql.json([{ id: "UC1", title: "One" }, { id: "UC2", title: "Two" }])} where id = ${row!.id}`;
    const [granted] = await sql<{ channels: { id: string }[] }[]>`select channels from youtube_connect_pending where id = ${row!.id}`;
    expect(granted!.channels.map((x) => x.id)).toEqual(["UC1", "UC2"]);
  });

  // ---- the parts view -------------------------------------------------------------------------------------------------------
  it("the parts view lists complete rows only, numbered by START (created_at - not completion, insertion or id), per fixture, tie-broken by id — and nothing for a setup or private division", async () => {
    const w = await world(4);
    const [f1, f3, f2] = [w.fixtures[0]!, w.fixtures[1]!, w.fixtures[2]!];   // f1 and f3 share a division; f2 is in another
    const c = await connection(w);
    const [k1, k2] = [await key(w, c, 1), await key(w, c, 2)];
    const at = (hhmm: string) => new Date(`2030-06-01T${hhmm}:00Z`);
    const parts = async (fixtureId: string) => sql<{ fixture_id: string; video_id: string; part_no: number; completed_at: Date }[]>`
      select fixture_id, video_id, part_no, completed_at from public_fixture_youtube_parts_v where fixture_id = ${fixtureId} order by part_no`;
    const videoOf = async (id: string) => (await sql<{ v: string }[]>`select yt_broadcast_id as v from youtube_broadcasts where id = ${id}`)[0]!.v;

    // The empty case first: a fixture with no broadcasts has no parts.
    expect(await parts(f1)).toEqual([]);

    // f1: Part 1 was STARTED first but finished LAST (its end was retried, say) - after the restart's broadcast had already finished.
    // The restart's row is inserted FIRST and its id sorts BELOW Part 1's, so insertion order, id order and completion order are ALL wrong.
    const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
    const late = await broadcast(w, { connection: c, fixture: f1, key: k1, state: "complete", createdAt: at("11:00"), completedAt: at("11:30"), id: lowId });
    const early = await broadcast(w, { connection: c, fixture: f1, key: k1, state: "complete", createdAt: at("10:00"), completedAt: at("12:00"), id: highId });
    await broadcast(w, { connection: c, fixture: f1, key: k1, state: "failed" });
    await broadcast(w, { connection: c, fixture: f1, key: k1, state: "live" });   // open on k1; the complete + failed rows hold nothing
    const f1Parts = await parts(f1);
    expect(f1Parts.map((p) => p.part_no)).toEqual([1, 2]);
    expect(f1Parts.map((p) => p.video_id)).toEqual([await videoOf(early), await videoOf(late)]);
    expect(f1Parts.map((p) => p.completed_at.toISOString()), "completed_at is still the finish time, whatever the number").toEqual([at("12:00").toISOString(), at("11:30").toISOString()]);
    expect(f1Parts.every((p) => p.fixture_id === f1)).toBe(true);

    // Numbering is per fixture: another fixture's first part is part 1 again.
    const other = await broadcast(w, { connection: c, fixture: f2, key: k2, state: "complete", completedAt: at("09:00") });
    const f2Parts = await parts(f2);
    expect(f2Parts.map((p) => p.part_no)).toEqual([1]);
    expect(f2Parts[0]!.video_id).toBe(await videoOf(other));

    // A tie on created_at is broken by id: three rows, one start instant, inserted in DESCENDING id order, and finishing in DESCENDING id
    // order too (the lowest id last) - so ordering by completion would be the exact reverse of the right answer.
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const [i, id] of [...ids].reverse().entries()) {
      await broadcast(w, { connection: c, fixture: f3, key: k1, state: "complete", createdAt: at("12:00"), completedAt: at(`1${3 + i}:00`), id });
    }
    const tied = await parts(f3);
    expect(tied.map((p) => p.part_no)).toEqual([1, 2, 3]);
    expect(tied.map((p) => p.video_id)).toEqual(await Promise.all(ids.map(videoOf)));

    // The setup redaction: flip f1/f3's division to setup → nothing for them, f2's (another division) is untouched.
    const [fx] = await sql<{ division_id: string }[]>`select division_id from fixtures where id = ${f1}`;
    const division_id = fx!.division_id;
    await sql`update divisions set status = 'setup' where id = ${division_id}`;
    expect(await parts(f1)).toEqual([]);
    expect(await parts(f3)).toEqual([]);
    expect((await parts(f2)).length).toBe(1);
    // ...and back: the redaction is the status, not a deletion.
    await sql`update divisions set status = 'active' where id = ${division_id}`;
    expect((await parts(f1)).length).toBe(2);

    // The competition's visibility: a private competition publishes no part (public_fixtures_v's own row filter); unlisted and public do.
    const [dv] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${division_id}`;
    const competition_id = dv!.competition_id;
    let seen = 0;
    for (const [visibility, expected] of [["private", 0], ["unlisted", 2], ["public", 2]] as const) {
      await sql`update competitions set visibility = ${visibility} where id = ${competition_id}`;
      expect((await parts(f1)).length, visibility).toBe(expected);
      seen++;
    }
    expect(seen).toBe(3);

    // The view's columns, in order.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'public_fixture_youtube_parts_v' order by ordinal_position`;
    expect(cols.map((x) => x.column_name)).toEqual(["fixture_id", "video_id", "part_no", "completed_at"]);
  });

  // ---- sealed, not granted ------------------------------------------------------------------------------------------------------
  it("every new table is RLS enabled AND forced with no policy; neither the tables nor the parts view are granted to app_user", async () => {
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema() and c.relname = any(${NEW_TABLES})
       order by c.relname`;
    expect(rows.map((r) => r.relname)).toEqual([...NEW_TABLES].sort());
    let checked = 0;
    for (const r of rows) {
      expect(r.rls, `${r.relname} enable`).toBe(true);
      expect(r.forced, `${r.relname} force`).toBe(true);
      expect(r.policies, `${r.relname} policies`).toBe(0);
      checked++;
    }
    expect(checked).toBe(4);
    // No grant (R7): only the privileged server client reads these. The probe's positive pair is a view that IS granted.
    const granted = async (rel: string) => (await sql<{ ok: boolean }[]>`
      select (has_table_privilege('app_user', ${rel}::text, 'select') or has_table_privilege('app_user', ${rel}::text, 'insert')
           or has_table_privilege('app_user', ${rel}::text, 'update') or has_table_privilege('app_user', ${rel}::text, 'delete')) as ok`)[0]!.ok;
    expect(await granted("public_fixtures_v"), "the probe must be able to see a grant").toBe(true);
    let ungranted = 0;
    for (const rel of [...NEW_TABLES, "public_fixture_youtube_parts_v"]) {
      expect(await granted(rel), `app_user must hold nothing on ${rel}`).toBe(false);
      ungranted++;
    }
    expect(ungranted).toBe(5);
  });

  // ---- the FK graph: what a delete does --------------------------------------------------------------------------------------------
  it("deleting an org removes its connections, pending grants, keys and broadcasts together (no FK refuses the cascade)", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const k = await key(w, c, 1);
    const b = await broadcast(w, { connection: c, fixture: f, key: k, state: "live" });
    const t = await target(w, { rtmp: false, connectionId: c });
    await session(w, { fixture: f, target: t, broadcast: b });
    // Two pending rows: a reconnect one (the connection's cascade could remove it) and a fresh one (only the org's can).
    for (const connectionId of [c, null]) {
      await sql`insert into youtube_connect_pending (state_hash, org_id, user_id, connection_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
                values (${randomUUID()}, ${w.orgId}, ${w.userId}, ${connectionId}, 'unlisted', false, 1, now(), now() + interval '10 minutes')`;
    }
    const before = await Promise.all(NEW_TABLES.map((t2) => countOf(t2, "org_id", w.orgId)));
    expect(before, "every new table held a row for the org (connections, pending, keys, broadcasts)").toEqual([1, 2, 1, 1]);
    await sql`delete from organizations where id = ${w.orgId}`;
    const after = await Promise.all(NEW_TABLES.map((t2) => countOf(t2, "org_id", w.orgId)));
    expect(after).toEqual([0, 0, 0, 0]);
  });

  it("deleting a fixture drops its broadcasts and nulls the session's broadcast; deleting a session nulls the broadcast's last_session_id; the connection and key survive both", async () => {
    const w = await world(2);
    const [f1, f2] = w.fixtures as [string, string];
    const c = await connection(w);
    const [k1, k2] = [await key(w, c, 1), await key(w, c, 2)];
    const t = await target(w, { rtmp: false, connectionId: c });
    const b1 = await broadcast(w, { connection: c, fixture: f1, key: k1, state: "live" });
    const b2 = await broadcast(w, { connection: c, fixture: f2, key: k2, state: "live" });
    const s1 = await session(w, { fixture: f1, target: t, broadcast: b1 });
    const s2 = await session(w, { fixture: f2, target: t, broadcast: b2 });
    await sql`update youtube_broadcasts set last_session_id = ${s2} where id = ${b2}`;

    await sql`delete from fixtures where id = ${f1}`;
    expect(await countOf("youtube_broadcasts", "id", b1), "the broadcast goes with its fixture").toBe(0);
    const [orphan] = await sql<{ fixture_id: string | null; youtube_broadcast_id: string | null }[]>`
      select fixture_id, youtube_broadcast_id from fixture_stream_sessions where id = ${s1}`;
    expect(orphan, "the session outlives the fixture and its broadcast, pointing at neither").toEqual({ fixture_id: null, youtube_broadcast_id: null });

    await sql`delete from fixture_stream_sessions where id = ${s2}`;
    const [kept] = await sql<{ last_session_id: string | null }[]>`select last_session_id from youtube_broadcasts where id = ${b2}`;
    expect(kept, "the broadcast outlives the session").toEqual({ last_session_id: null });
    expect(await countOf("org_youtube_connections", "id", c)).toBe(1);
    expect(await countOf("youtube_stream_keys", "id", k1)).toBe(1);
  });

  it("a user who recorded consent, or who connected the channel, cannot be hard-deleted (each FK refuses BY NAME); deleting any other user clears only their pending grants", async () => {
    const w = await world();
    const [consenter, connector, bystander] = [await newUser(), await newUser(), await newUser()] as [string, string, string];
    // Two DIFFERENT users, so each foreign key is the only thing protecting its own user.
    await connection(w, { consentBy: consenter, createdBy: connector });
    const pendingFor = (userId: string) => sql`
      insert into youtube_connect_pending (state_hash, org_id, user_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
      values (${randomUUID()}, ${w.orgId}, ${userId}, 'unlisted', false, 1, now(), now() + interval '10 minutes')`;
    await pendingFor(consenter);
    await pendingFor(bystander);
    await expect(sql`delete from users where id = ${consenter}`).rejects.toMatchObject({ code: "23503", constraint_name: "org_youtube_connections_consent_by_fkey" });
    await expect(sql`delete from users where id = ${connector}`).rejects.toMatchObject({ code: "23503", constraint_name: "org_youtube_connections_created_by_fkey" });
    expect(await countOf("users", "id", consenter), "the refused delete left the user").toBe(1);
    expect(await countOf("youtube_connect_pending", "user_id", consenter), "and left their pending row").toBe(1);
    // The positive pair: a user with no consent record is deletable, and takes only their own pending row with them.
    await sql`delete from users where id = ${bystander}`;
    expect(await countOf("youtube_connect_pending", "user_id", bystander)).toBe(0);
    expect(await countOf("youtube_connect_pending", "user_id", consenter), "the other user's pending row stays").toBe(1);
  });

  it("a connection with history is not hard-deletable (a broadcast or a destination still names it: revoke it instead); one with only keys and pending grants is, and takes them", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const pendingOn = (connectionId: string) => sql`
      insert into youtube_connect_pending (state_hash, org_id, user_id, connection_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
      values (${randomUUID()}, ${w.orgId}, ${w.userId}, ${connectionId}, 'unlisted', false, 1, now(), now() + interval '10 minutes')`;
    const withBroadcast = await connection(w);
    await broadcast(w, { connection: withBroadcast, fixture: f, key: await key(w, withBroadcast, 1), state: "complete", completedAt: new Date() });
    await expect(sql`delete from org_youtube_connections where id = ${withBroadcast}`).rejects.toMatchObject({
      code: "23503", constraint_name: "youtube_broadcasts_connection_id_fkey",
    });
    const withDestination = await connection(w);
    await target(w, { rtmp: false, connectionId: withDestination });
    await expect(sql`delete from org_youtube_connections where id = ${withDestination}`).rejects.toMatchObject({
      code: "23503", constraint_name: "org_stream_targets_youtube_connection_id_fkey",
    });
    // The positive pair: nothing but keys and a reconnect grant hangs off this one.
    const bare = await connection(w);
    await key(w, bare, 1);
    await pendingOn(bare);
    await sql`delete from org_youtube_connections where id = ${bare}`;
    expect(await countOf("youtube_stream_keys", "connection_id", bare)).toBe(0);
    expect(await countOf("youtube_connect_pending", "connection_id", bare)).toBe(0);
    expect(await countOf("org_youtube_connections", "id", bare)).toBe(0);
  });

  it("a dangling reference is refused by name — a destination's connection, a session's broadcast, a broadcast's key, a key's connection", async () => {
    const w = await world(1);
    const [f] = w.fixtures as [string];
    const c = await connection(w);
    const t = await target(w, { rtmp: false, connectionId: c });
    const ghost = randomUUID();
    await expect(target(w, { rtmp: false, connectionId: ghost })).rejects.toMatchObject({ code: "23503", constraint_name: "org_stream_targets_youtube_connection_id_fkey" });
    await expect(session(w, { fixture: f, target: t, broadcast: ghost })).rejects.toMatchObject({ code: "23503", constraint_name: "fixture_stream_sessions_youtube_broadcast_id_fkey" });
    await expect(broadcast(w, { connection: c, fixture: f, key: ghost, state: "created" })).rejects.toMatchObject({ code: "23503", constraint_name: "youtube_broadcasts_key_id_fkey" });
    await expect(key(w, ghost, 1)).rejects.toMatchObject({ code: "23503", constraint_name: "youtube_stream_keys_connection_id_fkey" });
    // The positive pair: the same four rows with real parents.
    const k = await key(w, c, 1);
    const b = await broadcast(w, { connection: c, fixture: f, key: k, state: "created" });
    await expect(session(w, { fixture: f, target: t, broadcast: b })).resolves.toBeTruthy();
  });

  // ---- text pins: what no insert can reach -------------------------------------------------------------------------------------
  it("the V421 index is narrowed to pasted rows by TEXT (name, column, both conjuncts), and the due/parts indexes carry their predicates", async () => {
    const def = async (table: string, name: string): Promise<string> => {
      const [r] = await sql<{ indexdef: string }[]>`
        select indexdef from pg_indexes where schemaname = current_schema() and tablename = ${table} and indexname = ${name}`;
      expect(r, `${name} is missing or renamed`).toBeDefined();
      return r!.indexdef;
    };
    // The session index: unique (target_id), the ACTIVE states (derived from the domain), AND no broadcast.
    const one = await def("fixture_stream_sessions", "fixture_stream_sessions_one_active_target");
    expect(one).toMatch(/^CREATE UNIQUE INDEX fixture_stream_sessions_one_active_target ON \w+\.fixture_stream_sessions USING btree \(target_id\) WHERE /);
    let seen = 0;
    for (const s of ACTIVE_STATES) { expect(one, s).toContain(`'${s}'`); seen++; }
    for (const s of TERMINAL_STATES) { expect(one, s).not.toContain(`'${s}'`); seen++; }
    expect(seen).toBe(ACTIVE_STATES.length + TERMINAL_STATES.length);
    // The exemption is the flag the session carries, NOT its broadcast: a set-null on the broadcast must not move it.
    expect(one).toContain("NOT api_backed");
    expect(one).not.toContain("youtube_broadcast_id");

    // The end step's scan (the V470 email_outbox_due_idx pattern): next_attempt_at NULLS FIRST, then created_at, over the OPEN states.
    const due = await def("youtube_broadcasts", "youtube_broadcasts_open_due_idx");
    expect(due).toMatch(/USING btree \(next_attempt_at NULLS FIRST, created_at\) WHERE /);
    for (const s of OPEN_FOR_KEY) expect(due, s).toContain(`'${s}'`);
    for (const s of NOT_OPEN_FOR_KEY) expect(due, s).not.toContain(`'${s}'`);
    // The parts read: (fixture_id, completed_at) over complete rows only.
    const parts = await def("youtube_broadcasts", "youtube_broadcasts_parts_idx");
    expect(parts).toMatch(/USING btree \(fixture_id, completed_at\) WHERE \(state = 'complete'::text\)/);
    // The connection read (spec §5.1: "one live connection per (org, channel)" is read by org).
    expect(await def("org_youtube_connections", "org_youtube_connections_org_idx")).toMatch(/USING btree \(org_id\)$/);
    // The key's any-state reads and FK walk (the per-key unique is partial on the open states): keyless rows stay out.
    expect(await def("youtube_broadcasts", "youtube_broadcasts_key_idx")).toMatch(/USING btree \(key_id\) WHERE \(key_id IS NOT NULL\)$/);
  });
});
