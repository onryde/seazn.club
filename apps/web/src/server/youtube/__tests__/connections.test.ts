// YouTube Connect T8: the connections usecase over real Postgres — the connect flow's save, a connection's settings, the Streaming page's
// projection. What is real: the database, the token store (a real sealed token is opened back), the pending-grant producers the OAuth
// callback uses (insertPending / storeGrant / sealPendingToken), the destination fingerprint. What is stood in: nothing but the signed-in
// person (an AuthCtx) and the YouTube port, a FakeYouTube that the save is handed and must never call.
//
// Expected values are literals from the brief / spec (the sentence, the status codes, 'unlisted', the destination's kind), or come from
// the engine's own declaration (fingerprintYoutubeChannel, the token the test sealed), never from the code under test. The consent
// wording's version is the one value the test moves: `consent.version` below is what `@/lib/youtube` answers for YOUTUBE_CONSENT_VERSION.
//
// Sport: not applicable — connecting a YouTube channel is sport-agnostic.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The consent wording's version, movable: connections.ts reads YOUTUBE_CONSENT_VERSION from this module on every call.
const consent = vi.hoisted(() => ({ version: 1 }));
vi.mock("@/lib/youtube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/youtube")>();
  return { ...actual, get YOUTUBE_CONSENT_VERSION() { return consent.version; } };
});

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { fingerprintYoutubeChannel } from "@/server/relay/crypto";
import { ApiBackedTargetError, readTargetSecret } from "@/server/relay/secret-columns";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { createStreamTarget, listStreamTargets } from "@/server/usecases/stream-targets";
import { insertPending } from "@/server/youtube/connect-flow";
import {
  connectionViews, pendingChannels, pickYoutubeChannel, recordLiveState, saveConnectionFromGrant, updateConnectionSettings,
} from "@/server/youtube/connections";
import { openToken, revokeConnection } from "@/server/youtube/token-store";
import { SCOPE, channelId, colleague, connect, fake, grant, org, type Org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const OTHER_ORG_SENTENCE = "This channel is connected to another organisation on Seazn";

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});
afterEach(() => { consent.version = 1; });

interface ConnRow {
  id: string; org_id: string; channel_id: string | null; channel_title: string | null; google_sub: string | null; granted_scope: string;
  default_privacy: string; made_for_kids: boolean; consent_by: string; consent_at: Date; consent_version: number; status: string;
  status_since: Date; last_error_code: string | null; last_health_at: Date | null; created_by: string; revoked_at: Date | null;
}
const connRows = (orgId: string) => sql<ConnRow[]>`select * from org_youtube_connections where org_id = ${orgId} order by created_at, id`;
const connRow = async (id: string): Promise<ConnRow> => (await sql<ConnRow[]>`select * from org_youtube_connections where id = ${id}`)[0]!;
interface TargetRow { id: string; org_id: string; kind: string; label: string; youtube_connection_id: string | null; dest_fingerprint: string | null; watch_url: string | null; archived_at: Date | null }
const targetRows = (orgId: string) => sql<TargetRow[]>`select id, org_id, kind, label, youtube_connection_id, dest_fingerprint, watch_url, archived_at from org_stream_targets where org_id = ${orgId} order by created_at, id`;
const pendingCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from youtube_connect_pending where org_id = ${orgId}`)[0]!.n;
/** Is a token still sealed on this pending row? (the only trace of a grant a refused save must leave untouched) */
const stillSealed = async (pendingId: string): Promise<boolean | null> =>
  (await sql<{ sealed: boolean }[]>`select (refresh_token_enc is not null) as sealed from youtube_connect_pending where id = ${pendingId}`)[0]?.sealed ?? null;

/** What a save refused with: the HttpError's status and code. */
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    return { status: e.status ?? 0, ...(e.code ? { code: e.code } : {}), message: e.message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

/** The backends (pids) that are waiting on a lock held by backend `pid`. Exact: a wait on anything else in the database is not counted. */
const waitersOf = async (pid: number): Promise<number[]> =>
  (await sql<{ pid: number }[]>`select pid from pg_stat_activity where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`).map((r) => r.pid);
/** Poll until `read` returns something (the wait is real, not assumed): an empty answer after the budget is a FAILURE, never a pass. */
async function eventually(read: () => Promise<number[]>, what: string): Promise<number[]> {
  for (let i = 0; i < 200; i++) {
    const got = await read();
    if (got.length > 0) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`never observed: ${what}`);
}
const ROLLBACK = new Error("rollback the holder");

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("saveConnectionFromGrant — a new connection", () => {
  it("writes the connection (with the pending grant's choices and consent), its destination row (kind youtube, channel title, channel fingerprint, NO key of its own, no watch link) and consumes the pending grant", async () => {
    const o = await org();
    const consentAt = new Date("2026-10-27T09:30:00.000Z");
    const p = await grant(o, { privacy: "public", madeForKids: true, consentVersion: 1, consentAt, sub: "sub-solo" });
    const ch = p.channels[0]!;
    const saved = await saveConnectionFromGrant({ pendingId: p.id, channelId: ch.id, userId: o.userId }, fake);
    expect(saved.existing, "a channel the org did not have is NEW (the picker says plain 'connected')").toBe(false);

    const [conn] = await connRows(o.orgId);
    expect(conn).toMatchObject({
      id: saved.connectionId, org_id: o.orgId, channel_id: ch.id, channel_title: "Solo United", google_sub: "sub-solo", granted_scope: SCOPE,
      default_privacy: "public", made_for_kids: true, consent_by: o.userId, consent_version: 1, status: "connected", created_by: o.userId,
      last_error_code: null, revoked_at: null,
    });
    expect(conn!.consent_at.toISOString(), "the consent time is the pending grant's (when the box was ticked), not the save's").toBe(consentAt.toISOString());
    expect(await openToken(sql, o.orgId, saved.connectionId), "the sealed token opens to the grant's token").toBe(p.token);

    const targets = await targetRows(o.orgId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: saved.targetId, kind: "youtube", label: "Solo United", youtube_connection_id: saved.connectionId,
      dest_fingerprint: fingerprintYoutubeChannel(ch.id), watch_url: null, archived_at: null,
    });
    // No key of its own (the sealed-key column is null): the key reader — the one owner of that column — says so by name.
    await expect(sql.begin((tx) => readTargetSecret(tx, o.orgId, saved.targetId))).rejects.toBeInstanceOf(ApiBackedTargetError);
    expect(await pendingCount(o.orgId), "the pending grant, and the token sealed on it, are gone").toBe(0);
    expect(fake.calls, "a save never calls YouTube").toEqual([]);
  });

  it("a second call with the same pending grant is a 404 and writes nothing more (the pending row is spent)", async () => {
    const o = await org();
    const p = await grant(o);
    const first = await saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: o.userId }, fake);
    const second = await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: o.userId }, fake));
    expect(second.status).toBe(404);
    expect(await connRows(o.orgId)).toHaveLength(1);
    expect(await targetRows(o.orgId)).toHaveLength(1);
    expect((await connRows(o.orgId))[0]!.id).toBe(first.connectionId);
  });

  it("two connects of one grant at once: exactly one connection, one destination, and the loser is a clean 404", async () => {
    const o = await org();
    const p = await grant(o);
    const args = { pendingId: p.id, channelId: p.channels[0]!.id, userId: o.userId };
    const results = await Promise.allSettled([saveConnectionFromGrant(args, fake), saveConnectionFromGrant(args, fake)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { status?: number }).status).toBe(404);
    expect(await connRows(o.orgId)).toHaveLength(1);
    expect(await targetRows(o.orgId)).toHaveLength(1);
  });

  it("the channel is live in ANOTHER org: 409 YOUTUBE_OTHER_ORG with the spec's sentence; the other org is untouched; this org has no connection or destination; the pending grant keeps its token (and no secret is in the error)", async () => {
    const theirs = await org();
    const held = await connect(theirs);
    const beforeTheirs = await connRow(held.connectionId);
    const mine = await org();
    const p = await grant(mine, { channels: [held.channel] });

    const err = await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: held.channel.id, userId: mine.userId }, fake));
    expect(err).toMatchObject({ status: 409, code: "YOUTUBE_OTHER_ORG", message: OTHER_ORG_SENTENCE });
    expect(JSON.stringify(err).includes(p.token), "no token in the refusal").toBe(false);

    expect(fake.calls.filter((c) => c.method === "revoke"), "the new token is NOT revoked: it is the grant the other org's live connection runs on").toEqual([]);
    expect(await connRows(mine.orgId)).toEqual([]);
    expect(await targetRows(mine.orgId)).toEqual([]);
    expect(await stillSealed(p.id), "the take was rolled back: the pending grant still holds its token").toBe(true);
    // The holder's connection: same row (status, status_since, error), same token, same destination.
    const afterTheirs = await connRow(held.connectionId);
    expect(afterTheirs.status).toBe("connected");
    expect(afterTheirs.status_since.getTime()).toBe(beforeTheirs.status_since.getTime());
    expect(await openToken(sql, theirs.orgId, held.connectionId)).toBe(held.token);
    expect(await targetRows(theirs.orgId)).toHaveLength(1);
  });

  it("the channel is live in another org and the Google account has ANOTHER channel: picking that other one connects it (a refused pick is not a refused grant)", async () => {
    const theirs = await org();
    const held = await connect(theirs);
    const mine = await org();
    const free = { id: channelId(), title: "Free FC" };
    const p = await grant(mine, { channels: [held.channel, free] });

    expect((await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: held.channel.id, userId: mine.userId }, fake))).code).toBe("YOUTUBE_OTHER_ORG");
    const saved = await saveConnectionFromGrant({ pendingId: p.id, channelId: free.id, userId: mine.userId }, fake);
    expect((await connRow(saved.connectionId)).channel_id).toBe(free.id);
    expect(await openToken(sql, mine.orgId, saved.connectionId)).toBe(p.token);
  });

  it("two orgs connect one channel at once: exactly one wins, the other is YOUTUBE_OTHER_ORG, and the channel is live once", async () => {
    const a = await org();
    const b = await org();
    const ch = { id: channelId(), title: "Contested FC" };
    const pa = await grant(a, { channels: [ch] });
    const pb = await grant(b, { channels: [ch] });
    const results = await Promise.allSettled([
      saveConnectionFromGrant({ pendingId: pa.id, channelId: ch.id, userId: a.userId }, fake),
      saveConnectionFromGrant({ pendingId: pb.id, channelId: ch.id, userId: b.userId }, fake),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as { code?: string; status?: number })).toMatchObject({ status: 409, code: "YOUTUBE_OTHER_ORG" });
    const live = await sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where channel_id = ${ch.id} and status <> 'revoked'`;
    expect(live[0]!.n).toBe(1);
  });

  it("the SAME org connecting the same channel again is the existing connection: same ids, the token replaced, still one connection and one destination row, the first choices kept", async () => {
    const o = await org();
    const first = await connect(o, { privacy: "public", madeForKids: true });
    // The grant went bad meanwhile.
    await sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() - interval '2 days', last_error_code = 'youtube_reconnect_needed' where id = ${first.connectionId}`;
    const before = await connRow(first.connectionId);

    const p = await grant(o, { channels: [first.channel], privacy: "private", madeForKids: false });
    const again = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);

    expect(again, "the existing ids, flagged existing - the pick keeps the old settings and the screen must say so").toEqual({ connectionId: first.connectionId, targetId: first.targetId, existing: true });
    expect(await connRows(o.orgId)).toHaveLength(1);
    expect(await targetRows(o.orgId)).toHaveLength(1);
    expect(await openToken(sql, o.orgId, first.connectionId), "the token is the NEW grant's").toBe(p.token);
    expect(p.token).not.toBe(first.token);
    const after = await connRow(first.connectionId);
    expect(after).toMatchObject({ status: "connected", last_error_code: null, default_privacy: "public", made_for_kids: true });
    expect(after.status_since.getTime(), "status_since moved").toBeGreaterThan(before.status_since.getTime());
    expect(await pendingCount(o.orgId)).toBe(0);
  });

  it("two connects of one channel in the SAME org at once (two pending grants): the loser of the unique-index race RECONNECTS the winner's connection — same ids, the loser's token on it, one connection, one destination", async () => {
    const o = await org();
    const ch = { id: channelId(), title: "Double Tap FC" };
    const [p1, p2] = [await grant(o, { channels: [ch] }), await grant(o, { channels: [ch] })];
    const other = await connect(o);   // another channel's connection: the holder row below is an API-shaped destination row of it
    // Hold the winner (A) AFTER its connection insert and BEFORE its commit: A's destination insert waits on a row this test holds
    // (the same org's active destination with the channel's fingerprint), so A's connection row exists but is not visible.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holderPid!: number;
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = sql.begin(async (tx) => {
      holderPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      await tx`insert into org_stream_targets (org_id, kind, label, youtube_connection_id, dest_fingerprint)
               values (${o.orgId}, 'youtube', 'holder', ${other.connectionId}, ${fingerprintYoutubeChannel(ch.id)})`;
      held();
      await gate;
      throw ROLLBACK;
    }).catch((err: unknown) => { if (err !== ROLLBACK) throw err; });
    await holding;

    const a = saveConnectionFromGrant({ pendingId: p1.id, channelId: ch.id, userId: o.userId }, fake);
    const [aPid] = await eventually(() => waitersOf(holderPid), "A (the winner) waiting on the holder's destination row");
    // B starts now: A's connection is not visible, so B finds no live connection, INSERTS one, and waits on A's unique-index entry.
    const b = saveConnectionFromGrant({ pendingId: p2.id, channelId: ch.id, userId: o.userId }, fake);
    const [bPid] = await eventually(() => waitersOf(aPid!), "B waiting on A's connection insert (it is inside the race)");
    expect(bPid, "B is a different backend from A").not.toBe(aPid);
    release();
    await holder;
    const [won, lost] = await Promise.all([a, b]);

    expect(won.existing, "the winner created it").toBe(false);
    expect(lost, "the loser's answer is the winner's ids, flagged existing (it reconnected the winner's connection)").toEqual({ connectionId: won.connectionId, targetId: won.targetId, existing: true });
    expect(await connRows(o.orgId), "the raced channel's connection plus the other channel's").toHaveLength(2);
    expect((await targetRows(o.orgId)).filter((t) => t.youtube_connection_id === won.connectionId), "one destination for the raced channel").toHaveLength(1);
    expect(await targetRows(o.orgId), "plus the other channel's own").toHaveLength(2);
    expect(await openToken(sql, o.orgId, won.connectionId), "the loser reconnected: ITS token is the one on the connection").toBe(p2.token);
    expect(await pendingCount(o.orgId), "both grants are spent").toBe(0);
  });

  it("after a disconnect (revoke) the same channel connects again as a NEW connection with a NEW destination row; the archived one stays archived", async () => {
    const o = await org();
    const first = await connect(o);
    expect(await sql.begin((tx) => revokeConnection(tx, o.orgId, first.connectionId))).toBe(true);
    const p = await grant(o, { channels: [first.channel] });
    const second = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);

    expect(second.connectionId).not.toBe(first.connectionId);
    expect(second.existing, "after a disconnect the channel is NEW again").toBe(false);
    expect(second.targetId).not.toBe(first.targetId);
    const targets = await targetRows(o.orgId);
    expect(targets.map((t) => [t.id, t.archived_at !== null]).sort()).toEqual([[first.targetId, true], [second.targetId, false]].sort());
    expect((await connRow(first.connectionId)).status).toBe("revoked");
    expect((await connRow(second.connectionId)).status).toBe("connected");
  });

  it("a revoked connection that still carries its channel id (V479 allows it; the revoke statement itself nulls it) is history, not the live connection: connecting the channel again makes a NEW one", async () => {
    const o = await org();
    const first = await connect(o);
    // The state revokeConnection cannot produce but the table allows: revoked, token gone, revoked_at set, channel_id kept.
    await sql`update org_youtube_connections set status = 'revoked', refresh_token_enc = null, revoked_at = now() where id = ${first.connectionId}`;
    await sql`update org_stream_targets set archived_at = now() where id = ${first.targetId}`;   // a revoke archives the destination too
    expect((await connRow(first.connectionId)).channel_id, "the fixture keeps the channel id").toBe(first.channel.id);
    const p = await grant(o, { channels: [first.channel] });
    const second = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(second.existing, "after a disconnect the channel is NEW again").toBe(false);
    expect((await connRow(second.connectionId)).status).toBe("connected");
    expect((await connRow(first.connectionId)).status, "the revoked one is never revived").toBe("revoked");
  });

  it("a live connection that somehow has no destination row gets one when its channel is connected again", async () => {
    const o = await org();
    const first = await connect(o);
    await sql`delete from org_stream_targets where id = ${first.targetId}`;
    const p = await grant(o, { channels: [first.channel] });
    const again = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);
    expect(again.connectionId).toBe(first.connectionId);
    const targets = await targetRows(o.orgId);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: again.targetId, youtube_connection_id: first.connectionId, label: "Solo United", archived_at: null });
  });

  it("a live connection whose only destination row is ARCHIVED gets a fresh active one (an archived row is not the destination); the archived one stays archived", async () => {
    const o = await org();
    const first = await connect(o);
    await sql`update org_stream_targets set archived_at = now() where id = ${first.targetId}`;
    const p = await grant(o, { channels: [first.channel] });
    const again = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);
    expect(again.connectionId).toBe(first.connectionId);
    expect(again.targetId, "a NEW row, not the archived one").not.toBe(first.targetId);
    const targets = await targetRows(o.orgId);
    expect(targets.map((t) => [t.id, t.archived_at !== null]).sort()).toEqual([[first.targetId, true], [again.targetId, false]].sort());
  });

  it("the connection is revoked by another request WHILE a save of its channel waits on its row: 404, the save rolls back whole, the pending grant keeps its token", async () => {
    const o = await org();
    const first = await connect(o);
    const p = await grant(o, { channels: [first.channel] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let revoked!: () => void;
    const revokedInTx = new Promise<void>((resolve) => { revoked = resolve; });
    let revokerPid!: number;
    // Request B: revokes, and holds its transaction open (the row is locked, the revoke not yet visible).
    const other = sql.begin(async (tx) => {
      revokerPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      await revokeConnection(tx, o.orgId, first.connectionId);
      revoked();
      await gate;
    });
    await revokedInTx;
    // Request A: reads the connection as still live, then waits on B's lock at the token replace.
    const save = refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake));
    const waiting = await eventually(() => waitersOf(revokerPid), "the save waiting on the revoking transaction's lock");
    expect(waiting.length, "anti-vacuity: exactly the save is blocked by the revoke").toBe(1);
    release();
    await other;
    const refused = await save;
    expect(refused.status).toBe(404);
    expect((await connRow(first.connectionId)).status).toBe("revoked");
    expect(await stillSealed(p.id), "the rolled-back save left the grant's token sealed on the pending row").toBe(true);
    expect((await connRows(o.orgId)), "no second connection was made").toHaveLength(1);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("saveConnectionFromGrant — refusals leave the pending grant as they found it", () => {
  it("a channel the grant did not list is 422 YOUTUBE_CHANNEL_NOT_OFFERED; picking a listed one afterwards then works (the refusal consumed nothing)", async () => {
    const o = await org();
    const p = await grant(o, { channels: [{ id: channelId(), title: "One" }, { id: channelId(), title: "Two" }] });
    const err = await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: channelId(), userId: o.userId }, fake));
    expect(err).toMatchObject({ status: 422, code: "YOUTUBE_CHANNEL_NOT_OFFERED" });
    expect(await connRows(o.orgId)).toEqual([]);
    expect(await stillSealed(p.id)).toBe(true);
    const saved = await saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[1]!.id, userId: o.userId }, fake);
    expect((await connRow(saved.connectionId)).channel_title).toBe("Two");
  });

  it("a grant that listed no channel at all is 422 (the empty list offers nothing)", async () => {
    const o = await org();
    const p = await grant(o, { channels: [] });
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: channelId(), userId: o.userId }, fake))).status).toBe(422);
    expect(await connRows(o.orgId)).toEqual([]);
  });

  it("an expired pending grant is 410 YOUTUBE_PENDING_EXPIRED and is left as it is; one that has NOT expired (9 minutes old) saves", async () => {
    const o = await org();
    const old = await grant(o, { startedMinutesAgo: 11 });
    expect(await refusal(() => saveConnectionFromGrant({ pendingId: old.id, channelId: old.channels[0]!.id, userId: o.userId }, fake)))
      .toMatchObject({ status: 410, code: "YOUTUBE_PENDING_EXPIRED" });
    expect(await connRows(o.orgId)).toEqual([]);
    expect(await targetRows(o.orgId)).toEqual([]);
    expect(await stillSealed(old.id)).toBe(true);

    const fresh = await grant(o, { startedMinutesAgo: 9 });
    const saved = await saveConnectionFromGrant({ pendingId: fresh.id, channelId: fresh.channels[0]!.id, userId: o.userId }, fake);
    expect(await openToken(sql, o.orgId, saved.connectionId)).toBe(fresh.token);
  });

  it("expiry is judged when the token is TAKEN: a grant that expires between the pick's page and the save is refused", async () => {
    const o = await org();
    const p = await grant(o);
    await sql`update youtube_connect_pending set expires_at = now() - interval '1 second' where id = ${p.id}`;
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: o.userId }, fake))).status).toBe(410);
    expect(await connRows(o.orgId)).toEqual([]);
  });

  it("another person's pending grant is a 404 (the same org's other editor is not the person who granted); the owner's own still saves", async () => {
    const o = await org();
    const other = await colleague(o);
    const p = await grant(o);
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: other.userId! }, fake))).status).toBe(404);
    expect(await connRows(o.orgId)).toEqual([]);
    expect(await stillSealed(p.id)).toBe(true);
    await saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: o.userId }, fake);
    expect(await connRows(o.orgId)).toHaveLength(1);
  });

  it("a pending grant that never had its token sealed, and one that does not exist, are 404s", async () => {
    const o = await org();
    const unsealed = await grant(o, { sealed: false });
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: unsealed.id, channelId: unsealed.channels[0]!.id, userId: o.userId }, fake))).status).toBe(404);
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: randomUUID(), channelId: channelId(), userId: o.userId }, fake))).status).toBe(404);
    expect(await connRows(o.orgId)).toEqual([]);
  });

  it("given an org, the pending grant must be that org's: another org's id is a 404 and nothing is connected anywhere", async () => {
    const a = await org();
    const b = await org();
    // One person in both orgs — the case where only the org in the URL can tell the grants apart.
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${a.userId}, 'admin')`;
    const p = await grant(a);
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: a.userId, orgId: b.orgId }, fake))).status).toBe(404);
    expect(await connRows(a.orgId)).toEqual([]);
    expect(await connRows(b.orgId)).toEqual([]);
    expect(await stillSealed(p.id)).toBe(true);
    await saveConnectionFromGrant({ pendingId: p.id, channelId: p.channels[0]!.id, userId: a.userId, orgId: a.orgId }, fake);
    expect(await connRows(a.orgId)).toHaveLength(1);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("saveConnectionFromGrant — a reconnect", () => {
  async function openBroadcast(o: Org, connectionId: string, fixtureId: string, state: string, next: Date | null, attempts = 0) {
    const done = state === "complete";
    const [row] = await sql<{ id: string }[]>`
      insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, title, privacy, state, next_attempt_at, attempts, completed_at, yt_broadcast_id)
      values (false, ${o.orgId}, ${connectionId}, ${fixtureId}, 'Match', 'unlisted', ${state}, ${next}, ${attempts}, ${done ? new Date() : null}, ${done ? `vid-${randomUUID().slice(0, 8)}` : null})
      returning id`;
    return row!.id;
  }
  const nextOf = async (id: string): Promise<Date | null> =>
    (await sql<{ n: Date | null }[]>`select next_attempt_at as n from youtube_broadcasts where id = ${id}`)[0]!.n;
  const attemptsOf = async (id: string): Promise<number> =>
    (await sql<{ n: number }[]>`select attempts as n from youtube_broadcasts where id = ${id}`)[0]!.n;

  it("replaces the token and revives the connection (connected, status_since moved, error cleared), keeps the destination row and its id, records the new grant's Google account and scope, and consumes the pending grant", async () => {
    const o = await org();
    const first = await connect(o, { sub: "sub-old" });
    await sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() - interval '3 days', last_error_code = 'youtube_reconnect_needed', granted_scope = 'old-scope' where id = ${first.connectionId}`;
    const before = await connRow(first.connectionId);
    const p = await grant(o, { channels: [first.channel], connectionId: first.connectionId, sub: "sub-new" });

    const saved = await saveConnectionFromGrant({ pendingId: p.id, channelId: first.channel.id, userId: o.userId }, fake);
    expect(saved, "a reconnect through the connection's own id is existing too").toEqual({ connectionId: first.connectionId, targetId: first.targetId, existing: true });
    expect(await openToken(sql, o.orgId, first.connectionId)).toBe(p.token);
    const after = await connRow(first.connectionId);
    expect(after).toMatchObject({ status: "connected", last_error_code: null, google_sub: "sub-new", granted_scope: SCOPE });
    expect(after.status_since.getTime()).toBeGreaterThan(before.status_since.getTime());
    expect(await connRows(o.orgId)).toHaveLength(1);
    expect(await targetRows(o.orgId), "no second destination").toHaveLength(1);
    expect(await pendingCount(o.orgId)).toBe(0);
  });

  it("a reconnect whose grant has no Google account id (the lookup returned null) KEEPS the connection's known one; a grant that has one replaces it", async () => {
    const o = await org();
    const first = await connect(o, { sub: "sub-known" });
    const blank = await grant(o, { channels: [first.channel], connectionId: first.connectionId, sub: null });
    await saveConnectionFromGrant({ pendingId: blank.id, channelId: first.channel.id, userId: o.userId }, fake);
    const kept = await connRow(first.connectionId);
    expect(kept.google_sub, "a null never erases a known sub (T18 reads it to decide whether a revoke is safe)").toBe("sub-known");
    expect(await openToken(sql, o.orgId, first.connectionId), "the reconnect itself still happened").toBe(blank.token);
    // The positive pair: a grant that DOES carry one moves it.
    const named = await grant(o, { channels: [first.channel], connectionId: first.connectionId, sub: "sub-next" });
    await saveConnectionFromGrant({ pendingId: named.id, channelId: first.channel.id, userId: o.userId }, fake);
    expect((await connRow(first.connectionId)).google_sub).toBe("sub-next");
  });

  it("clears the retry backoff AND the failure count of every OPEN broadcast of THIS connection (the 'ending' one among them) and nothing else: a complete one, another connection's, a broadcast with no backoff", async () => {
    const o = await org();
    const { fixtureId } = await startedDivisionWithFixture(o.auth);
    const mine = await connect(o);
    const theirs = await connect(o);
    const later = new Date(Date.now() + 3_600_000);
    const live = await openBroadcast(o, mine.connectionId, fixtureId, "live", later, 7);
    const ending = await openBroadcast(o, mine.connectionId, fixtureId, "ending", later, 31);
    const quiet = await openBroadcast(o, mine.connectionId, fixtureId, "failed", later, 5);
    const complete = await openBroadcast(o, mine.connectionId, fixtureId, "complete", later, 3);
    const notMine = await openBroadcast(o, theirs.connectionId, fixtureId, "ending", later, 9);
    const p = await grant(o, { channels: [mine.channel], connectionId: mine.connectionId });
    await saveConnectionFromGrant({ pendingId: p.id, channelId: mine.channel.id, userId: o.userId }, fake);

    expect(await nextOf(live), "live").toBeNull();
    expect(await nextOf(ending), "ending").toBeNull();
    expect([await attemptsOf(live), await attemptsOf(ending)], "a fresh start: the failure count goes with the backoff").toEqual([0, 0]);
    // Not open / not this connection's: untouched (the positive pair of the two lines above).
    expect((await nextOf(quiet))?.getTime(), "failed is not open").toBe(later.getTime());
    expect((await nextOf(complete))?.getTime(), "complete is not open").toBe(later.getTime());
    expect((await nextOf(notMine))?.getTime(), "another connection's").toBe(later.getTime());
    expect([await attemptsOf(quiet), await attemptsOf(complete), await attemptsOf(notMine)], "and their failure counts stand").toEqual([5, 3, 9]);
  });

  it("restarts the stuck-age clock (claimed_at) of every ENDING broadcast of THIS connection, with a backoff or without (an admission claim has none), so a reconnect is a fresh start for the age rule too; an open 'live' one, a failed one and another connection's keep theirs", async () => {
    const o = await org();
    const { fixtureId } = await startedDivisionWithFixture(o.auth);
    const mine = await connect(o);
    const theirs = await connect(o);
    const later = new Date(Date.now() + 3_600_000);
    const backedOff = await openBroadcast(o, mine.connectionId, fixtureId, "ending", later, 4);
    const noBackoff = await openBroadcast(o, mine.connectionId, fixtureId, "ending", null, 0);   // the admission claim: ending, no lease
    const failed = await openBroadcast(o, mine.connectionId, fixtureId, "failed", later, 5);
    const notMine = await openBroadcast(o, theirs.connectionId, fixtureId, "ending", later, 9);
    const live = await openBroadcast(o, mine.connectionId, fixtureId, "live", later, 2);   // matched by the reset, unclaimed: must stay so
    // Three days of age on every row that can carry a claim: older than the stuck bound (about a day) by a wide margin.
    await sql`update youtube_broadcasts set claimed_at = now() - interval '3 days' where id in ${sql([backedOff, noBackoff, failed, notMine])}`;
    const claimedAt = async (id: string): Promise<Date | null> =>
      (await sql<{ c: Date | null }[]>`select claimed_at as c from youtube_broadcasts where id = ${id}`)[0]!.c;
    const old = [await claimedAt(failed), await claimedAt(notMine)];
    expect(old.every((d) => d !== null), "premise: the seeded age is there").toBe(true);

    const [{ t: before }] = await sql<{ t: Date }[]>`select now() as t`;
    const p = await grant(o, { channels: [mine.channel], connectionId: mine.connectionId });
    await saveConnectionFromGrant({ pendingId: p.id, channelId: mine.channel.id, userId: o.userId }, fake);
    const [{ t: after }] = await sql<{ t: Date }[]>`select now() as t`;

    for (const [name, id] of [["backed-off ending", backedOff], ["ending with no backoff", noBackoff]] as const) {
      const c = await claimedAt(id);
      expect(c, name).not.toBeNull();
      expect(c!.getTime(), `${name}: restarted at the save`).toBeGreaterThanOrEqual(before.getTime());
      expect(c!.getTime(), `${name}: restarted at the save`).toBeLessThanOrEqual(after.getTime());
    }
    expect(await claimedAt(live), "an open broadcast that was never claimed stays unclaimed").toBeNull();
    expect((await claimedAt(failed))?.getTime(), "failed is not open").toBe(old[0]!.getTime());
    expect((await claimedAt(notMine))?.getTime(), "another connection's").toBe(old[1]!.getTime());
  });

  it("a consent given on NEWER wording is written onto the connection (version, time, person); a reconnect on the SAME wording leaves the first consent alone", async () => {
    const o = await org();
    const other = await colleague(o);
    const first = await connect(o, { consentVersion: 1 });
    const original = await connRow(first.connectionId);

    // Same wording, a different editor reconnecting: nothing about the consent moves.
    const same = await grant(o, { channels: [first.channel], connectionId: first.connectionId, consentVersion: 1, userId: other.userId! });
    await saveConnectionFromGrant({ pendingId: same.id, channelId: first.channel.id, userId: other.userId! }, fake);
    const afterSame = await connRow(first.connectionId);
    expect([afterSame.consent_version, afterSame.consent_by, afterSame.consent_at.getTime()]).toEqual([1, o.userId, original.consent_at.getTime()]);

    // They re-ticked on version 2.
    const tickedAt = new Date("2026-11-02T10:00:00.000Z");
    const newer = await grant(o, { channels: [first.channel], connectionId: first.connectionId, consentVersion: 2, consentAt: tickedAt, userId: other.userId! });
    await saveConnectionFromGrant({ pendingId: newer.id, channelId: first.channel.id, userId: other.userId! }, fake);
    const afterNewer = await connRow(first.connectionId);
    expect([afterNewer.consent_version, afterNewer.consent_by, afterNewer.consent_at.toISOString()]).toEqual([2, other.userId, tickedAt.toISOString()]);
  });

  it("a grant for a different channel than the connection's is 422 YOUTUBE_DIFFERENT_CHANNEL and the connection's token is untouched; a revoked connection, or another org's, is a 404", async () => {
    const o = await org();
    const first = await connect(o);
    const stranger = { id: channelId(), title: "Somebody Else FC" };
    const bad = await grant(o, { channels: [stranger], connectionId: first.connectionId });
    expect(await refusal(() => saveConnectionFromGrant({ pendingId: bad.id, channelId: stranger.id, userId: o.userId }, fake)))
      .toMatchObject({ status: 422, code: "YOUTUBE_DIFFERENT_CHANNEL" });
    expect(await openToken(sql, o.orgId, first.connectionId)).toBe(first.token);
    expect(await stillSealed(bad.id)).toBe(true);

    // Another org's connection named by this org's pending grant.
    const b = await org();
    const foreign = await grant(b, { channels: [first.channel], connectionId: first.connectionId });
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: foreign.id, channelId: first.channel.id, userId: b.userId }, fake))).status).toBe(404);
    expect(await openToken(sql, o.orgId, first.connectionId), "the other org's token is untouched").toBe(first.token);
    expect(await connRows(b.orgId)).toEqual([]);

    // A revoked one.
    await sql.begin((tx) => revokeConnection(tx, o.orgId, first.connectionId));
    const gone = await grant(o, { channels: [first.channel], connectionId: first.connectionId });
    expect((await refusal(() => saveConnectionFromGrant({ pendingId: gone.id, channelId: first.channel.id, userId: o.userId }, fake))).status).toBe(404);
    expect((await connRow(first.connectionId)).status, "a revoked connection is never revived").toBe("revoked");
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("updateConnectionSettings", () => {
  it("privacy 'public' persists and is what the reply says; madeForKids flips both ways; both in one call; a second identical call changes nothing", async () => {
    const o = await org();
    const c = await connect(o);
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { privacy: "public" })).toMatchObject({ privacy: "public", madeForKids: false });
    expect((await connRow(c.connectionId)).default_privacy).toBe("public");
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { madeForKids: true })).toMatchObject({ privacy: "public", madeForKids: true });
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { privacy: "private", madeForKids: false })).toMatchObject({ privacy: "private", madeForKids: false });
    const once = await connRow(c.connectionId);
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { privacy: "private", madeForKids: false })).toMatchObject({ privacy: "private", madeForKids: false });
    expect(await connRow(c.connectionId)).toEqual(once);
  });

  it("an unknown privacy is 422 and changes nothing; an empty body changes nothing and answers the connection as it is", async () => {
    const o = await org();
    const c = await connect(o, { privacy: "public" });
    const before = await connRow(c.connectionId);
    expect(await refusal(() => updateConnectionSettings(o.auth, o.orgId, c.connectionId, { privacy: "everyone" as never })))
      .toMatchObject({ status: 422, code: "YOUTUBE_PRIVACY_INVALID" });
    expect(await refusal(() => updateConnectionSettings(o.auth, o.orgId, c.connectionId, { consent: false as never }))).toMatchObject({ status: 422 });
    expect(await connRow(c.connectionId)).toEqual(before);
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, {})).toMatchObject({ connectionId: c.connectionId, privacy: "public" });
    expect(await connRow(c.connectionId)).toEqual(before);
  });

  it("the reply is the Streaming page's view of the connection: the channel's id and title, privacy, kids flag, status, live state, terms, open broadcasts", async () => {
    const o = await org();
    const id = channelId();
    const c = await connect(o, { channels: [{ id, title: "Rovers TV" }], madeForKids: true });
    expect(await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { privacy: "private" })).toEqual({
      connectionId: c.connectionId, channelId: id, channelTitle: "Rovers TV", privacy: "private", madeForKids: true, status: "connected",
      liveState: "unknown", termsOutdated: false, openBroadcasts: 0,
    });
  });

  it("consent text changed (version 1 -> 2): the connection reads termsOutdated true; PATCH consent makes it false and records version 2, the caller and the time; a second press by another editor does not replace who consented", async () => {
    const o = await org();
    const other = await colleague(o);
    const c = await connect(o, { consentVersion: 1 });
    expect((await connectionViews(o.orgId)).get(c.connectionId)!.termsOutdated, "same wording: not outdated").toBe(false);

    consent.version = 2;
    expect((await connectionViews(o.orgId)).get(c.connectionId)!.termsOutdated, "wording moved on: outdated").toBe(true);
    const before = await connRow(c.connectionId);
    const view = await updateConnectionSettings(other, o.orgId, c.connectionId, { consent: true, consentMinors: true });
    expect(view.termsOutdated).toBe(false);
    const after = await connRow(c.connectionId);
    expect(after).toMatchObject({ consent_version: 2, consent_by: other.userId });
    expect(after.consent_at.getTime()).toBeGreaterThan(before.consent_at.getTime());

    const third = await colleague(o);
    await updateConnectionSettings(third, o.orgId, c.connectionId, { consent: true, consentMinors: true });
    expect(await connRow(c.connectionId), "already at the current wording: nothing re-stamped").toEqual(after);

    // The other direction: a consent given under a LATER wording than this build's is not outdated, and a consent press does not lower it.
    consent.version = 1;
    expect((await connectionViews(o.orgId)).get(c.connectionId)!.termsOutdated).toBe(false);
    await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { consent: true, consentMinors: true });
    expect((await connRow(c.connectionId)).consent_version, "never lowered").toBe(2);
  });

  it("half a consent is refused HERE too (a caller that bypasses the wire schema): the terms alone or the under-16 box alone is 422 YOUTUBE_CONSENT_INVALID and writes nothing; both together stamp the current wording (owner, PO 2026-10-30)", async () => {
    const o = await org();
    const c = await connect(o, { consentVersion: 1 });
    consent.version = 2;
    const before = await connRow(c.connectionId);
    let refused = 0;
    const halves: Parameters<typeof updateConnectionSettings>[3][] = [
      { consent: true }, { consentMinors: true }, { consent: true, consentMinors: false as never }, { consent: false as never, consentMinors: true },
      { consentMinors: true, privacy: "public" },
    ];
    for (const half of halves) {
      expect(await refusal(() => updateConnectionSettings(o.auth, o.orgId, c.connectionId, half)), JSON.stringify(half)).toMatchObject({ status: 422, code: "YOUTUBE_CONSENT_INVALID" });
      expect(await connRow(c.connectionId), `${JSON.stringify(half)}: nothing written`).toEqual(before);
      refused++;
    }
    expect(refused, "anti-vacuity: five half consents checked").toBe(5);
    // The positive pair: both boxes.
    expect((await updateConnectionSettings(o.auth, o.orgId, c.connectionId, { consent: true, consentMinors: true })).termsOutdated).toBe(false);
    expect((await connRow(c.connectionId)).consent_version).toBe(2);
  });

  it("consent needs a person: a key (no user) is 403 and writes nothing", async () => {
    const o = await org();
    const c = await connect(o, { consentVersion: 1 });
    consent.version = 2;
    const key: AuthCtx = { orgId: o.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    const before = await connRow(c.connectionId);
    expect((await refusal(() => updateConnectionSettings(key, o.orgId, c.connectionId, { consent: true, consentMinors: true }))).status).toBe(403);
    expect(await connRow(c.connectionId)).toEqual(before);
    // The positive pair: the same key may change a plain setting through this function (the route bars keys, not the usecase).
    expect(await updateConnectionSettings(key, o.orgId, c.connectionId, { madeForKids: true })).toMatchObject({ madeForKids: true });
  });

  it("another org's connection, a revoked one, a missing one, and an auth for another org are all 404 — and the other org's row is unchanged", async () => {
    const a = await org();
    const b = await org();
    const c = await connect(a, { privacy: "public" });
    const before = await connRow(c.connectionId);
    expect((await refusal(() => updateConnectionSettings(b.auth, b.orgId, c.connectionId, { privacy: "private", madeForKids: true }))).status, "org B, org A's connection").toBe(404);
    expect((await refusal(() => updateConnectionSettings(b.auth, a.orgId, c.connectionId, { privacy: "private" }))).status, "org B's auth, org A's URL").toBe(404);
    expect((await refusal(() => updateConnectionSettings(a.auth, a.orgId, randomUUID(), { privacy: "private" }))).status, "missing").toBe(404);
    expect(await connRow(c.connectionId)).toEqual(before);
    await sql.begin((tx) => revokeConnection(tx, a.orgId, c.connectionId));
    expect((await refusal(() => updateConnectionSettings(a.auth, a.orgId, c.connectionId, { privacy: "private" }))).status, "revoked").toBe(404);
    expect((await connRow(c.connectionId)).default_privacy, "a refused change to a revoked connection wrote nothing").toBe("public");
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("the Streaming page's view of a connection", () => {
  it("liveState is 'enabled' ONLY for a clean health check made since the token last changed; an unrecognised code, a check older than the last reconnect, no check, and a dead grant are all 'unknown' (10 rows checked)", async () => {
    const o = await org();
    // [status, when the check ran relative to status_since, last_error_code, expected] — the refusal codes are the port's own
    // vocabulary (port.ts); "youtube_unavailable" and the made-up one are codes this build does not map to a state.
    type When = "never" | "before" | "equal" | "after";
    const table: [string, When, string | null, string][] = [
      ["connected", "never", null, "unknown"],
      ["connected", "after", null, "enabled"],
      ["connected", "equal", null, "enabled"],
      ["connected", "after", "youtube_live_not_enabled", "not_enabled"],
      ["connected", "after", "youtube_live_blocked", "blocked"],
      ["reconnect_needed", "after", "youtube_reconnect_needed", "unknown"],
      ["connected", "after", "youtube_unavailable", "unknown"],
      ["connected", "after", "a_code_a_later_build_adds", "unknown"],
      ["connected", "before", null, "unknown"],            // a reconnect cleared the code; the check predates the new token
      ["connected", "before", "youtube_live_blocked", "unknown"],
    ];
    let checked = 0;
    for (const [status, when, code, expected] of table) {
      const c = await connect(o);
      const at = { never: sql`null`, before: sql`status_since - interval '1 minute'`, equal: sql`status_since`, after: sql`status_since + interval '1 minute'` }[when];
      await sql`update org_youtube_connections set status = ${status}, last_health_at = ${at}, last_error_code = ${code} where id = ${c.connectionId}`;
      const view = (await connectionViews(o.orgId)).get(c.connectionId)!;
      expect(view.liveState, `${status} / ${when} / ${code}`).toBe(expected);
      expect(view.status).toBe(status);
      checked++;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(10);
  });

  it("recordLiveState (B4 fix round 1, I-2): a code and a stamp on a CONNECTED row of THIS org read back as the page's own liveState; null clears the code (and is itself a check); a foreign org's id, and a dead grant, are written nothing (5 rows checked)", async () => {
    const o = await org();
    const other = await org();
    const c = await connect(o);
    const state = async () => (await connectionViews(o.orgId)).get(c.connectionId)!.liveState;
    const stamp = async () => (await connRow(c.connectionId)).last_health_at;
    expect(await state(), "empty case: never checked").toBe("unknown");
    expect(await stamp()).toBeNull();
    let checked = 0;

    // [code, the page's word] — typed from spec §6.9, not read from the writer.
    for (const [code, word] of [["youtube_live_not_enabled", "not_enabled"], ["youtube_live_blocked", "blocked"]] as const) {
      expect(await recordLiveState(sql, o.orgId, c.connectionId, code), code).toBe(true);
      expect(await state(), code).toBe(word);
      expect((await connRow(c.connectionId)).last_error_code, code).toBe(code);
      checked++;
    }
    const blockedAt = (await stamp())!;
    expect(await recordLiveState(sql, o.orgId, c.connectionId, null)).toBe(true);
    expect(await state(), "a clean bind clears it").toBe("enabled");
    expect((await connRow(c.connectionId)).last_error_code).toBeNull();
    expect((await stamp())!.getTime(), "…and is a check of its own").toBeGreaterThanOrEqual(blockedAt.getTime());
    checked++;

    // Negative pairs: another org's call, and a dead grant, write nothing.
    const before = await connRow(c.connectionId);
    expect(await recordLiveState(sql, other.orgId, c.connectionId, "youtube_live_blocked")).toBe(false);
    expect(await connRow(c.connectionId), "a foreign org changed nothing").toEqual(before);
    checked++;
    await sql`update org_youtube_connections set status = 'reconnect_needed', status_since = now() where id = ${c.connectionId}`;
    const dead = await connRow(c.connectionId);
    expect(await recordLiveState(sql, o.orgId, c.connectionId, "youtube_live_blocked")).toBe(false);
    expect(await connRow(c.connectionId), "a dead grant says nothing about live state").toEqual(dead);
    checked++;
    expect(checked, "anti-vacuity").toBe(5);
  });

  it("openBroadcasts counts the connection's broadcasts that are neither complete nor failed ('ending' included), and no other connection's", async () => {
    const o = await org();
    const { fixtureId } = await startedDivisionWithFixture(o.auth);
    const c = await connect(o);
    const d = await connect(o);
    const add = (conn: string, state: string) => sql`
      insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, title, privacy, state, completed_at, yt_broadcast_id)
      values (false, ${o.orgId}, ${conn}, ${fixtureId}, 'Match', 'unlisted', ${state}, ${state === "complete" ? new Date() : null}, ${state === "complete" ? `vid-${randomUUID().slice(0, 8)}` : null})`;
    expect((await connectionViews(o.orgId)).get(c.connectionId)!.openBroadcasts, "empty case").toBe(0);
    await add(c.connectionId, "live");
    await add(c.connectionId, "ending");
    await add(c.connectionId, "complete");
    await add(c.connectionId, "failed");
    await add(d.connectionId, "ending");
    const views = await connectionViews(o.orgId);
    expect(views.get(c.connectionId)!.openBroadcasts).toBe(2);
    expect(views.get(d.connectionId)!.openBroadcasts).toBe(1);
  });

  it("views are org-scoped and exclude revoked connections", async () => {
    const a = await org();
    const b = await org();
    const mine = await connect(a);
    const gone = await connect(a);
    const theirs = await connect(b);
    await sql.begin((tx) => revokeConnection(tx, a.orgId, gone.connectionId));
    expect([...(await connectionViews(a.orgId)).keys()]).toEqual([mine.connectionId]);
    expect([...(await connectionViews(b.orgId)).keys()]).toEqual([theirs.connectionId]);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("the Streaming page's destination list (listStreamTargets)", () => {
  it("an API row carries the connection's view, keyHint null, inUse null and no watch link; a pasted row beside it carries youtube null", async () => {
    const o = await org();
    const id = channelId();
    const c = await connect(o, { channels: [{ id, title: "Rovers TV" }], privacy: "public" });
    const pasted = await createStreamTarget(o.auth, o.orgId, { kind: "youtube", label: "Court 1", streamKey: `key-${randomBytes(12).toString("hex")}` });

    const list = await listStreamTargets(o.auth, o.orgId);
    expect(list).toHaveLength(2);
    const api = list.find((t) => t.id === c.targetId)!;
    expect(api).toMatchObject({
      kind: "youtube", label: "Rovers TV", watchUrl: null, keyHint: null, inUse: null,
      youtube: {
        connectionId: c.connectionId, channelId: id, channelTitle: "Rovers TV", privacy: "public", madeForKids: false, status: "connected", liveState: "unknown",
        termsOutdated: false, openBroadcasts: 0,
      },
    });
    // The view carries the channel's PUBLIC id for the logo link, and nothing secret: no token, no grant, no Google subject.
    const keys = Object.keys(api.youtube!).sort();
    expect(keys).toEqual(["channelId", "channelTitle", "connectionId", "liveState", "madeForKids", "openBroadcasts", "privacy", "status", "termsOutdated"]);
    expect(JSON.stringify(api)).not.toMatch(/token|google_sub|refresh/i);
    const paste = list.find((t) => t.id === pasted.id)!;
    expect(paste.youtube).toBeNull();
    expect(typeof paste.keyHint).toBe("string");
  });

  it("only this org's connections are listed, and a disconnected channel's destination (archived) is gone from the list", async () => {
    const a = await org();
    const b = await org();
    const mine = await connect(a);
    const gone = await connect(a);
    await connect(b);
    await sql.begin((tx) => revokeConnection(tx, a.orgId, gone.connectionId));
    expect((await listStreamTargets(a.auth, a.orgId)).map((t) => t.id)).toEqual([mine.targetId]);
    expect(await listStreamTargets(b.auth, b.orgId)).toHaveLength(1);
  });

  it("an ACTIVE destination whose connection is revoked is not listed at all (it would render as a pasted row with no key)", async () => {
    const o = await org();
    const c = await connect(o);
    await sql.begin((tx) => revokeConnection(tx, o.orgId, c.connectionId));
    await sql`update org_stream_targets set archived_at = null where id = ${c.targetId}`;   // the state the revoke statement cannot produce
    expect(await listStreamTargets(o.auth, o.orgId)).toEqual([]);
  });
});

// =====================================================================================================================================
describe.skipIf(!HAS_DB)("pendingChannels and pickYoutubeChannel", () => {
  it("the picker's list is the grant's channels (id and title only) for its own person in its own org", async () => {
    const o = await org();
    const chs = [{ id: channelId(), title: "First FC" }, { id: channelId(), title: "Second FC" }];
    const p = await grant(o, { channels: chs });
    expect(await pendingChannels(o.auth, o.orgId, p.id)).toEqual({ channels: chs });
  });

  it("another person's, another org's, a missing, a not-yet-granted and a key's request are 404; an expired one is 410", async () => {
    const o = await org();
    const other = await colleague(o);
    const p = await grant(o);
    const b = await org();
    const key: AuthCtx = { orgId: o.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    const ungranted = await insertPending({ state: randomUUID(), orgId: o.orgId, userId: o.userId, connectionId: null, privacy: "unlisted", madeForKids: false, consentVersion: 1, now: new Date() });
    const cases: [string, () => Promise<unknown>, number][] = [
      ["another person in the same org", () => pendingChannels(other, o.orgId, p.id), 404],
      ["the org in the URL is another org's", () => pendingChannels(b.auth, b.orgId, p.id), 404],
      ["auth for another org than the URL", () => pendingChannels(b.auth, o.orgId, p.id), 404],
      ["missing", () => pendingChannels(o.auth, o.orgId, randomUUID()), 404],
      ["not yet granted (no channel list)", () => pendingChannels(o.auth, o.orgId, ungranted.id), 404],
      ["a key", () => pendingChannels(key, o.orgId, p.id), 404],
    ];
    let checked = 0;
    for (const [name, call, status] of cases) {
      expect((await refusal(call)).status, name).toBe(status);
      checked++;
    }
    expect(checked, "anti-vacuity: cases checked").toBe(6);
    const old = await grant(o, { startedMinutesAgo: 11 });
    expect((await refusal(() => pendingChannels(o.auth, o.orgId, old.id))).status).toBe(410);
    // The positive pair: the right person still reads it.
    expect((await pendingChannels(o.auth, o.orgId, p.id)).channels).toHaveLength(1);
  });

  it("pick saves the chosen channel in the URL's org with the caller as the person; a key cannot pick", async () => {
    const o = await org();
    const chs = [{ id: channelId(), title: "First FC" }, { id: channelId(), title: "Second FC" }];
    const p = await grant(o, { channels: chs });
    const key: AuthCtx = { orgId: o.orgId, via: "api_key", userId: null, role: null, keyId: randomUUID() };
    expect((await refusal(() => pickYoutubeChannel(key, o.orgId, { pendingId: p.id, channelId: chs[1]!.id }, fake))).status).toBe(404);
    const saved = await pickYoutubeChannel(o.auth, o.orgId, { pendingId: p.id, channelId: chs[1]!.id }, fake);
    expect((await connRow(saved.connectionId))).toMatchObject({ channel_title: "Second FC", org_id: o.orgId, created_by: o.userId });
    expect(await openToken(sql, o.orgId, saved.connectionId)).toBe(p.token);
  });
});
