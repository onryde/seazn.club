// Phase 0 (YouTube channel safety) Task 4: GET /orgs/{id}/youtube-connections/{connectionId}/safety over the REAL handler, session door and
// database; only the YouTube port is the fake. What this file owns: the answer (young / short broadcasts), the fail-open rule (any port error
// is 200 warn:false and the connection does not move), and the org scoping (a foreign connection is 404 with ZERO port calls).
// The pure rule (thresholds, window) is channel-safety's own tests'; this is the wiring.
//
// Sport: not applicable — a YouTube channel is sport-agnostic.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
const captured = vi.hoisted(() => ({ errors: [] as unknown[] }));
vi.mock("@/lib/sentry", () => ({ captureError: (e: unknown) => { captured.errors.push(e); } }));

import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { YOUTUBE_SAFETY_CHECK_LIMIT, YOUTUBE_SHORT_BROADCAST_MINUTES, YOUTUBE_YOUNG_CHANNEL_DAYS } from "@/lib/youtube";
import { revokeConnection } from "@/server/youtube/token-store";
import { setYoutubeDriverForTest } from "@/server/youtube/driver";
import type { YoutubeErrorCode } from "@/server/youtube/port";
import { GET } from "../[connectionId]/safety/route";
import { connect, fake, org } from "@/server/youtube/__tests__/_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});
afterEach(() => { setYoutubeDriverForTest(null); captured.errors.length = 0; __setRateLimitCounterForTests(null); });

const DAY = 86_400_000;
const MIN = 60_000;
type Envelope = { ok: boolean; data?: { warn: boolean; young: boolean; shortRecent: number }; error?: { message: string } };
const json = async (res: Response): Promise<Envelope> => (await res.json()) as Envelope;
const signedInAs = (userId: string) => { authState.userId = userId; };
const safety = (orgId: string, connectionId: string) =>
  GET(new Request(`http://localhost/api/v1/orgs/${orgId}/youtube-connections/${connectionId}/safety`), { params: Promise.resolve({ id: orgId, connectionId }) });
const portCalls = () => fake.calls.length;
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from org_youtube_connections where id = ${id}`)[0]!.status;

/** A connected channel whose age and recent broadcasts the fake is told (a quiet old channel unless the test says otherwise). */
async function channel(o: Awaited<ReturnType<typeof org>>, facts: { ageDays?: number; short?: number; long?: number } = {}) {
  setYoutubeDriverForTest(fake);
  const c = await connect(o);
  // The fake pins an unseen token to a fresh channel of its own: seed the grant so the token acts on the CONNECTED channel.
  fake.seedGrant({ refreshToken: c.token, channelId: c.channel.id, channelTitle: c.channel.title });
  const now = Date.now();
  fake.setChannelCreatedAt(c.channel.id, new Date(now - (facts.ageDays ?? 400) * DAY));
  for (let i = 0; i < (facts.short ?? 0); i++) {
    const start = now - (i + 1) * 60 * MIN;
    fake.addBroadcastHistory(c.channel.id, { startedAt: new Date(start), endedAt: new Date(start + (YOUTUBE_SHORT_BROADCAST_MINUTES - 5) * MIN) });
  }
  for (let i = 0; i < (facts.long ?? 0); i++) {
    const start = now - (i + 3) * 60 * MIN;
    fake.addBroadcastHistory(c.channel.id, { startedAt: new Date(start), endedAt: new Date(start + 90 * MIN) });
  }
  return c;
}

describe.skipIf(!HAS_DB)("GET youtube-connections/{id}/safety", () => {
  it("warns for a young channel, and the quiet old one does not (anti-vacuity: both answers seen)", async () => {
    const o = await org();
    signedInAs(o.userId);
    const young = await channel(o, { ageDays: YOUTUBE_YOUNG_CHANNEL_DAYS - 1 });
    const res = await safety(o.orgId, young.connectionId);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ warn: true, young: true, shortRecent: 0 });

    const o2 = await org();
    signedInAs(o2.userId);
    const old = await channel(o2, { long: 3 });
    expect((await json(await safety(o2.orgId, old.connectionId))).data).toEqual({ warn: false, young: false, shortRecent: 0 });
  });

  it("warns for two short broadcasts in the last day on an old channel, one is not enough, a long one is not short", async () => {
    const o = await org();
    signedInAs(o.userId);
    const two = await channel(o, { short: 2, long: 1 });
    expect((await json(await safety(o.orgId, two.connectionId))).data).toEqual({ warn: true, young: false, shortRecent: 2 });

    const o2 = await org();
    signedInAs(o2.userId);
    const one = await channel(o2, { short: 1, long: 2 });
    expect((await json(await safety(o2.orgId, one.connectionId))).data).toEqual({ warn: false, young: false, shortRecent: 1 });
  });

  it("uses the stored creation date when there is one (no channels.list call)", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await channel(o);   // the fake says OLD; the stored column says YOUNG: the column wins
    await sql`update org_youtube_connections set channel_created_at = ${new Date(Date.now() - 2 * DAY)} where id = ${c.connectionId}`;
    fake.calls.length = 0;
    expect((await json(await safety(o.orgId, c.connectionId))).data).toMatchObject({ warn: true, young: true });
    expect(fake.calls.map((x) => x.method)).not.toContain("channelCreatedAt");
  });

  for (const [method, code] of [
    ["accessToken", "youtube_unavailable"], ["recentBroadcasts", "youtube_limit_reached"], ["channelCreatedAt", "youtube_reconnect_needed"],
  ] as [string, YoutubeErrorCode][]) {
    it(`fails open: a port ${method} refusing ${code} is 200 warn:false, logged, and the connection stays connected`, async () => {
      const o = await org();
      signedInAs(o.userId);
      const c = await channel(o, { ageDays: 1 });
      fake.failNext(method as "accessToken", code);
      const res = await safety(o.orgId, c.connectionId);
      expect(res.status).toBe(200);
      expect((await json(res)).data).toEqual({ warn: false, young: false, shortRecent: 0 });
      expect(captured.errors, "the failure is reported").toHaveLength(1);
      expect(await statusOf(c.connectionId), "a read failure never moves the connection").toBe("connected");
    });
  }

  it("m1: a STORED young date still warns when the YouTube read fails (fail-open only for what was not read)", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await channel(o);
    await sql`update org_youtube_connections set channel_created_at = ${new Date(Date.now() - 2 * DAY)} where id = ${c.connectionId}`;
    fake.failNext("accessToken", "youtube_unavailable");
    const res = await safety(o.orgId, c.connectionId);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ warn: true, young: true, shortRecent: 0 });
    expect(captured.errors, "the failure is still reported").toHaveLength(1);
  });

  it("I2: past the per-connection budget the answer is 200 warn:false with ZERO port calls; another connection keeps its own budget", async () => {
    // A deterministic counter in place of Redis (the limiter is inert without one): the limiter's real code runs.
    const counts = new Map<string, number>();
    __setRateLimitCounterForTests(async (key) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { count, ttlMs: 30_000 };
    });
    const o = await org();
    signedInAs(o.userId);
    const c = await channel(o, { ageDays: 1 });   // young: every read inside the budget warns, so the over-budget answer is visibly different
    for (let i = 1; i <= YOUTUBE_SAFETY_CHECK_LIMIT.max; i++) {
      const before = portCalls();
      expect((await json(await safety(o.orgId, c.connectionId))).data, `read ${i} inside the budget`).toEqual({ warn: true, young: true, shortRecent: 0 });
      expect(portCalls(), `read ${i} asked YouTube`).toBeGreaterThan(before);
    }
    const before = portCalls();
    const res = await safety(o.orgId, c.connectionId);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ warn: false, young: false, shortRecent: 0 });
    expect(portCalls(), "over the budget: YouTube is asked nothing").toBe(before);

    const o2 = await org();
    signedInAs(o2.userId);
    const other = await channel(o2, { ageDays: 1 });
    expect((await json(await safety(o2.orgId, other.connectionId))).data?.warn, "another connection's budget is its own").toBe(true);
  });

  it("a DEAD grant (token killed at YouTube) is still 200 warn:false and the status is unchanged (no mark reconnect_needed)", async () => {
    const o = await org();
    signedInAs(o.userId);
    const c = await channel(o, { ageDays: 1 });
    fake.killToken(c.token);
    const res = await safety(o.orgId, c.connectionId);
    expect(res.status).toBe(200);
    expect((await json(res)).data?.warn).toBe(false);
    expect(await statusOf(c.connectionId)).toBe("connected");
  });

  it("another organisation's connection is 404 with ZERO port calls; so are an unknown id, a disconnected connection and a malformed id", async () => {
    const a = await org();
    const b = await org();
    const c = await channel(a);
    await sql`insert into org_members (org_id, user_id, role) values (${b.orgId}, ${a.userId}, 'owner')`;
    signedInAs(a.userId);
    fake.calls.length = 0;
    expect((await safety(b.orgId, c.connectionId)).status).toBe(404);
    expect((await safety(a.orgId, randomUUID())).status).toBe(404);
    expect((await safety(a.orgId, "not-a-uuid")).status).toBe(404);
    expect(portCalls(), "no port call before the scoping answers").toBe(0);
    // positive pair
    expect((await safety(a.orgId, c.connectionId)).status).toBe(200);
    expect(portCalls()).toBeGreaterThan(0);
    await sql.begin((tx) => revokeConnection(tx, a.orgId, c.connectionId));
    expect((await safety(a.orgId, c.connectionId)).status).toBe(404);
  });
});
