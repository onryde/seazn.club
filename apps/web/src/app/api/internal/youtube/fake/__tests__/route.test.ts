// YouTube Connect T5 (R6): POST /api/internal/youtube/fake — the e2e walkthroughs' control over the FAKE YouTube, so a browser
// test can kill a token, turn video on, delete a video or read where a fixture's broadcasts stand, without ever seeing a
// refresh token or a stream key (it takes and gives HANDLES; the route resolves the secrets server-side).
//
// Two halves. First, WHERE it exists: 404 unless YOUTUBE_DRIVER is fake AND ENV_NAME is local/ci (the fake-ingest control
// route's own name list) — one case per refused combination, and a spy proves nothing was touched. Second, WHAT it does:
// every op once, then `state` against real Postgres (skipped without DATABASE_URL like every DB suite here) with the
// secrets it must NOT answer asserted absent beside the handles it must.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { fingerprintYoutubeChannel } from "@/server/relay/crypto";
import { insertPooledKey } from "@/server/relay/secret-columns";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { setYoutubeDriverForTest, youtubeDriver } from "@/server/youtube/driver";
import { YouTubeError } from "@/server/youtube/port";
import { insertConnectionWithToken } from "@/server/youtube/token-store";
import { POST } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;
const START = new Date("2026-10-27T12:00:00Z");

const call = (body: unknown) =>
  POST(new Request("http://app.test/api/internal/youtube/fake", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" },
  }));
const dataOf = async (res: Response) => ((await res.json()) as { ok: boolean; data: unknown }).data;

beforeEach(() => {
  vi.stubEnv("YOUTUBE_DRIVER", "fake");
  vi.stubEnv("ENV_NAME", "ci");
  setYoutubeDriverForTest(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setYoutubeDriverForTest(null);
});
const theFake = () => youtubeDriver() as FakeYouTube;
const bcast = () => ({ title: "Match", description: "d", scheduledStart: START, privacy: "unlisted" as const, madeForKids: false });

describe("POST /api/internal/youtube/fake — refused anywhere a fake must not be driven", () => {
  // Each refused combination; the fake is installed so a leaking gate would have something to mutate.
  const REFUSED: [string, string | undefined, string | undefined, string | undefined][] = [
    ["live mode + local", "live", "local", "test"],
    ["live mode + ci", "live", "ci", "test"],
    ["fake + stg", "fake", "stg", "production"],
    ["fake + prod", "fake", "prod", "production"],
    ["fake + ENV_NAME unset", "fake", undefined, "production"],
    ["fake + ENV_NAME blank", "fake", "  ", "production"],
    ["production with YOUTUBE_DRIVER unset (= live) + ci", undefined, "ci", "production"],
    ["a typo'd YOUTUBE_DRIVER + ci", "fakee", "ci", "test"],
  ];
  for (const [name, driver, envName, nodeEnv] of REFUSED) {
    it(`404: ${name}`, async () => {
      vi.stubEnv("YOUTUBE_DRIVER", driver);
      vi.stubEnv("ENV_NAME", envName);
      vi.stubEnv("NODE_ENV", nodeEnv);
      const fake = new FakeYouTube();
      setYoutubeDriverForTest(fake);
      const touched = vi.spyOn(fake, "setChannels");
      const res = await call({ op: "setChannels", channels: [{ id: "UCx", title: "X" }] });
      expect(res.status).toBe(404);
      expect(touched).not.toHaveBeenCalled();
      // The body is not read before the gate: an invalid body is the same 404, not a 400 that proves the route exists.
      expect((await call("{not json")).status).toBe(404);
    });
  }

  for (const envName of ["local", "ci"]) {
    it(`200: fake mode under ENV_NAME=${envName} (the positive pair of the table above)`, async () => {
      vi.stubEnv("ENV_NAME", envName);
      const res = await call({ op: "setChannels", channels: [{ id: "UCx", title: "X" }] });
      expect(res.status).toBe(200);
      const fake = theFake();
      expect(await fake.listMyChannels(await fake.accessToken("rt"))).toEqual([{ id: "UCx", title: "X" }]);
    });
  }
});

describe("POST /api/internal/youtube/fake — the ops", () => {
  it("setChannels / setLive / autoVideo change the fake", async () => {
    const fake = theFake();
    const at = await fake.accessToken("rt");
    expect((await call({ op: "setChannels", channels: [] })).status).toBe(200);
    expect(await fake.listMyChannels(at)).toEqual([]);
    expect((await call({ op: "setLive", state: "not_enabled" })).status).toBe(200);
    expect(await fake.liveEnabled(at)).toBe("not_enabled");
    expect((await call({ op: "setLive", state: "enabled" })).status).toBe(200);
    expect(await fake.liveEnabled(at)).toBe("enabled");
    expect((await call({ op: "autoVideo", on: true })).status).toBe(200);
    const { streamId } = await fake.insertStream(at, { title: "k" });
    const { broadcastId } = await fake.insertBroadcast(at, bcast());
    await fake.bind(at, broadcastId, streamId);
    expect(await fake.broadcastLife(at, broadcastId), "autoVideo on: the bind left it live").toBe("live");
    expect((await call({ op: "autoVideo", on: false })).status).toBe(200);
    const second = await fake.insertBroadcast(at, bcast());
    await fake.bind(at, second.broadcastId, streamId);
    expect(await fake.broadcastLife(at, second.broadcastId), "autoVideo off: back to ready (the key has no video)").toBe("ready");
  });

  it("failNext makes the next call fail once with the code and reason given — and a token-shaped reason is dropped, not stored", async () => {
    const fake = theFake();
    const at = await fake.accessToken("rt");
    expect((await call({ op: "failNext", method: "insertStream", code: "youtube_live_blocked", reason: "livePermissionBlocked" })).status).toBe(200);
    const err = await fake.insertStream(at, { title: "k" }).then(() => null, (e: unknown) => e as YouTubeError);
    expect(err).toBeInstanceOf(YouTubeError);
    expect([err!.code, err!.reason]).toEqual(["youtube_live_blocked", "livePermissionBlocked"]);
    await expect(fake.insertStream(at, { title: "k" }), "single shot").resolves.toBeDefined();
    await call({ op: "failNext", method: "insertStream", code: "youtube_unavailable", reason: "refresh_token=1//0gSECRET&x=y" });
    const dropped = await fake.insertStream(at, { title: "k" }).then(() => null, (e: unknown) => e as YouTubeError);
    expect(dropped!.reason).toBe("");
    expect(dropped!.message).not.toContain("SECRET");
  });

  it("videoOn / videoOff take a streamId; deleteVideo takes a videoId; an unknown id is 404 and changes nothing", async () => {
    const fake = theFake();
    const at = await fake.accessToken("rt");
    const { streamId } = await fake.insertStream(at, { title: "k" });
    const { broadcastId } = await fake.insertBroadcast(at, bcast());
    await fake.bind(at, broadcastId, streamId);
    expect((await call({ op: "videoOn", streamId })).status).toBe(200);
    expect(await fake.broadcastLife(at, broadcastId)).toBe("live");
    expect((await call({ op: "videoOff", streamId })).status).toBe(200);
    expect(await fake.broadcastLife(at, broadcastId), "auto-stop is off").toBe("live");
    expect((await call({ op: "videoOn", streamId: "nope" })).status).toBe(404);
    expect((await call({ op: "videoOff", streamId: "nope" })).status).toBe(404);
    expect((await call({ op: "deleteVideo", videoId: "nope" })).status).toBe(404);
    expect((await call({ op: "deleteVideo", videoId: broadcastId })).status).toBe(200);
    expect(await fake.broadcastLife(at, broadcastId)).toBe("absent");
  });

  it("videoOn past the channel's 10 is refused 409 with YouTube's own code, and the fake is unchanged", async () => {
    const fake = theFake();
    const at = await fake.accessToken("rt");
    const streams: string[] = [];
    for (let i = 0; i < 11; i++) {
      const { streamId } = await fake.insertStream(at, { title: "k" });
      const { broadcastId } = await fake.insertBroadcast(at, bcast());
      await fake.bind(at, broadcastId, streamId);
      streams.push(streamId);
    }
    for (let i = 0; i < 10; i++) expect((await call({ op: "videoOn", streamId: streams[i] })).status).toBe(200);
    const res = await call({ op: "videoOn", streamId: streams[10] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe("youtube_limit_reached");
    expect(fake.liveBroadcastCount()).toBe(10);
  });

  it("killToken takes a HANDLE: it kills that token; an unknown handle is 404", async () => {
    const fake = theFake();
    const handle = fake.tokenHandle("1//0g-some-refresh-token");
    expect((await call({ op: "killToken", tokenHandle: "fake-th-unknown" })).status).toBe(404);
    await expect(fake.accessToken("1//0g-some-refresh-token"), "PREMISE: alive until killed").resolves.toBeDefined();
    expect((await call({ op: "killToken", tokenHandle: handle })).status).toBe(200);
    const err = await fake.accessToken("1//0g-some-refresh-token").then(() => null, (e: unknown) => e as YouTubeError);
    expect(err?.code).toBe("youtube_reconnect_needed");
  });

  it("a body that is not one of the nine ops is 400 and changes nothing: unknown op, extra key, wrong type, bad code, bad method, not JSON", async () => {
    const fake = theFake();
    const spies = [vi.spyOn(fake, "setChannels"), vi.spyOn(fake, "failNext"), vi.spyOn(fake, "killHandle"), vi.spyOn(fake, "videoOn")];
    const bad: unknown[] = [
      { op: "dropDatabase" },
      {},
      null,
      "{not json",
      { op: "videoOn", streamId: "x", extra: 1 },
      { op: "videoOn", streamId: 7 },
      { op: "autoVideo", on: "yes" },
      { op: "setLive", state: "maybe" },
      { op: "failNext", method: "insertStream", code: "youtube_channel_busy" },
      { op: "failNext", method: "mode", code: "youtube_unavailable" },
      { op: "failNext", method: "insertStreem", code: "youtube_unavailable" },
      { op: "setChannels", channels: [{ id: "UCx" }] },
      { op: "state", fixtureId: "not-a-uuid" },
    ];
    let checked = 0;
    for (const body of bad) {
      expect((await call(body)).status, JSON.stringify(body)).toBe(400);
      checked++;
    }
    expect(checked).toBe(bad.length);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("every op but `state` (which has its own DB-backed suite below) answers 200 to a valid body — the list the plan promises", async () => {
    const fake = theFake();
    const at = await fake.accessToken("rt");
    const { streamId } = await fake.insertStream(at, { title: "k" });
    const { broadcastId } = await fake.insertBroadcast(at, bcast());
    const valid: Record<string, unknown> = {
      setChannels: { op: "setChannels", channels: [{ id: "UCx", title: "X" }] },
      failNext: { op: "failNext", method: "listMyChannels", code: "youtube_unavailable" },
      killToken: { op: "killToken", tokenHandle: fake.tokenHandle("rt-for-kill") },
      videoOn: { op: "videoOn", streamId },
      videoOff: { op: "videoOff", streamId },
      deleteVideo: { op: "deleteVideo", videoId: broadcastId },
      setLive: { op: "setLive", state: "enabled" },
      autoVideo: { op: "autoVideo", on: false },
    };
    let checked = 0;
    for (const [op, body] of Object.entries(valid)) {
      expect((await call(body)).status, op).toBe(200);
      checked++;
    }
    expect(checked, "8 of the plan's 9 ops").toBe(8);
  });
});

describe.skipIf(!HAS_DB)("POST /api/internal/youtube/fake — state (real Postgres)", () => {
  const KEYS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  beforeAll(() => { for (const k of KEYS) process.env[k] = randomBytes(32).toString("hex"); });
  afterAll(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const SCOPE = "https://www.googleapis.com/auth/youtube";

  async function rig() {
    const { auth } = await seedOrg();
    const [user] = await sql<{ id: string }[]>`insert into users (email, display_name) values (${`yt5-${randomUUID()}@example.test`}, 'Fake Ctl') returning id`;
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const refreshToken = `1//rt-${randomBytes(24).toString("base64url")}`;
    const channelId = `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    const { connectionId } = await sql.begin((tx) => insertConnectionWithToken(tx, {
      orgId: auth.orgId, channelId, channelTitle: "State FC", googleSub: null, grantedScope: SCOPE, defaultPrivacy: "unlisted", madeForKids: false,
      consentBy: user!.id, consentAt: new Date(), consentVersion: 1, createdBy: user!.id, refreshToken,
    }));
    return { orgId: auth.orgId, fixtureId, refreshToken, channelId, connectionId };
  }

  /** What Go live (T11) leaves behind, written raw: a pooled key and a broadcast row naming the YouTube broadcast. */
  async function broadcastOnYoutube(r: Awaited<ReturnType<typeof rig>>, fake: FakeYouTube, state: string, slot = 1) {
    const at = await fake.accessToken(r.refreshToken);
    const stream = await fake.insertStream(at, { title: "key" });
    const { broadcastId } = await fake.insertBroadcast(at, bcast());
    await fake.bind(at, broadcastId, stream.streamId);
    const { keyId } = await sql.begin((tx) => insertPooledKey(tx, { orgId: r.orgId, connectionId: r.connectionId, slot, liveStreamId: stream.streamId, ingest: stream.ingest }));
    await sql`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, key_id, yt_broadcast_id, title, privacy, state)
      values (${r.orgId}, ${r.connectionId}, ${r.fixtureId}, ${keyId}, ${broadcastId}, 'Match', 'unlisted', ${state})`;
    return { at, stream, broadcastId };
  }

  it("answers handles only: connectionId, tokenHandle, and each broadcast's videoId / life / streamId — no refresh token, access token, stream key or ingest url", async () => {
    const fake = theFake();
    const r = await rig();
    const made = await broadcastOnYoutube(r, fake, "bound");
    const res = await call({ op: "state", fixtureId: r.fixtureId });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await dataOf(res));
    const data = JSON.parse(text) as { connectionId: string; tokenHandle: string; broadcasts: { videoId: string; life: string; streamId: string }[] };
    expect(data).toEqual({
      connectionId: r.connectionId,
      tokenHandle: fake.tokenHandle(r.refreshToken),
      broadcasts: [{ videoId: made.broadcastId, life: "ready", streamId: made.stream.streamId }],
    });
    let checked = 0;
    for (const secret of [r.refreshToken, made.at, made.stream.ingest.streamKey, made.stream.ingest.url]) {
      expect(text, "the answer carries no credential").not.toContain(secret);
      checked++;
    }
    expect(checked).toBe(4);
    expect(data.tokenHandle, "and the handle is not the token in disguise").not.toContain(r.refreshToken.slice(0, 8));
  });

  it("the handle `state` hands out is the one killToken takes: kill it, and the connection's token is dead while the broadcast still reads live", async () => {
    const fake = theFake();
    const r = await rig();
    const made = await broadcastOnYoutube(r, fake, "live");
    fake.videoOn(made.stream.streamId);
    const before = (await dataOf(await call({ op: "state", fixtureId: r.fixtureId }))) as { tokenHandle: string; broadcasts: { life: string }[] };
    expect(before.broadcasts[0]!.life).toBe("live");
    await expect(fake.accessToken(r.refreshToken), "PREMISE: alive").resolves.toBeDefined();
    expect((await call({ op: "killToken", tokenHandle: before.tokenHandle })).status).toBe(200);
    expect(((await fake.accessToken(r.refreshToken).then(() => null, (e: unknown) => e as YouTubeError)))?.code).toBe("youtube_reconnect_needed");
    const after = (await dataOf(await call({ op: "state", fixtureId: r.fixtureId }))) as { tokenHandle: string; broadcasts: { life: string }[] };
    expect(after.tokenHandle, "a handle is stable").toBe(before.tokenHandle);
    expect(after.broadcasts[0]!.life, "a dead token does not stop the video, and `state` reads without needing the token").toBe("live");
  });

  it("autoVideo on, then a bind: `state` reports the broadcast live (what the e2e relies on for a replay part)", async () => {
    const fake = theFake();
    const r = await rig();
    await call({ op: "autoVideo", on: true });
    await broadcastOnYoutube(r, fake, "live");
    const data = (await dataOf(await call({ op: "state", fixtureId: r.fixtureId }))) as { broadcasts: { life: string }[] };
    expect(data.broadcasts.map((b) => b.life)).toEqual(["live"]);
  });

  it("two broadcasts of one fixture come back oldest first, and a deleted video reads absent", async () => {
    const fake = theFake();
    const r = await rig();
    const first = await broadcastOnYoutube(r, fake, "failed");   // not open, so the second may be
    const second = await broadcastOnYoutube(r, fake, "bound", 2);
    fake.deleteVideo(first.broadcastId);
    const data = (await dataOf(await call({ op: "state", fixtureId: r.fixtureId }))) as { broadcasts: { videoId: string; life: string }[] };
    expect(data.broadcasts.map((b) => [b.videoId, b.life])).toEqual([[first.broadcastId, "absent"], [second.broadcastId, "ready"]]);
  });

  it("a fixture with a YouTube destination but no broadcast yet: the connection and its handle, and an EMPTY list (not an error)", async () => {
    const fake = theFake();
    const r = await rig();
    const [target] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, youtube_connection_id, dest_fingerprint)
      values (${r.orgId}, 'youtube', 'State FC', ${r.connectionId}, ${fingerprintYoutubeChannel(r.channelId)}) returning id`;
    await sql`insert into fixture_stream_settings (fixture_id, org_id, target_id) values (${r.fixtureId}, ${r.orgId}, ${target!.id})`;
    const res = await call({ op: "state", fixtureId: r.fixtureId });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ connectionId: r.connectionId, tokenHandle: fake.tokenHandle(r.refreshToken), broadcasts: [] });
  });

  it("a fixture with no YouTube destination and no broadcast: nulls and an empty list; an unknown fixture is 404", async () => {
    const r = await rig();
    const res = await call({ op: "state", fixtureId: r.fixtureId });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ connectionId: null, tokenHandle: null, broadcasts: [] });
    expect((await call({ op: "state", fixtureId: randomUUID() })).status).toBe(404);
  });

  it("a broadcast row not yet created on YouTube (no yt_broadcast_id) is not listed", async () => {
    const fake = theFake();
    const r = await rig();
    await sql`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
      values (${r.orgId}, ${r.connectionId}, ${r.fixtureId}, 'Match', 'unlisted', 'created')`;
    const data = (await dataOf(await call({ op: "state", fixtureId: r.fixtureId }))) as { connectionId: string; tokenHandle: string; broadcasts: unknown[] };
    expect(data.broadcasts).toEqual([]);
    expect(data.connectionId, "the row still names its connection").toBe(r.connectionId);
    expect(data.tokenHandle).toBe(fake.tokenHandle(r.refreshToken));
  });
});
