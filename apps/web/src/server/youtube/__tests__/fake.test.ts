// YouTube Connect T5: FakeYouTube is the in-memory channel every later batch codes against (the Google driver is T6, the
// connect routes T7, go-live T11, the end tick T14, and e2e drives it through the control route). Its worth is its REALISM,
// so every number below is typed here from Google's own documentation — never imported from fake.ts:
//   * "10 active streams allowed per channel and 3 active streams per stream key"  (support.google.com/youtube/answer/2474026)
//   * enableAutoStart = true starts a bound broadcast when video arrives; enableAutoStop = false never stops it (spec §3.1)
//   * videos.list takes at most 50 ids per call
// The fake's only job a test cannot check by reading it is to REFUSE like Google does, so each limit has an accepted twin
// (the 10th is fine, the 11th is not) and a case where the right answer differs from a wrong constant's (a per-channel
// cap is not a global one; a freed slot is reusable).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { LOGGER_OPTIONS } from "@/server/logger";
import { FakeYouTube } from "../fake";
import { YouTubeError, type YouTubePort } from "../port";

const START = new Date("2026-10-27T12:00:00Z");
const REDIRECT = "https://app.example.test/api/youtube/connect/callback";
// RFC 7636 appendix B's own vector. The challenge is computed here with node:crypto, from the literal verifier, and pinned to the
// RFC's literal in its own test below — the fake's S256 is never the source of the value it is checked against.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
let stateSeq = 0;
/** A whole OAuth round trip through the port: authorize, the hop's issueCode, the exchange. `before` runs once the state exists
 *  and before its code is issued: where a test binds channels or a scope to THAT state. */
async function grant(f: FakeYouTube, o: { scope?: string; before?: (state: string) => void } = {}) {
  const state = `state-${++stateSeq}`;
  f.authorizeUrl({ state, codeChallenge: CHALLENGE, redirectUri: REDIRECT });
  o.before?.(state);
  return f.exchangeCode({ code: f.issueCode(state, { scope: o.scope }), codeVerifier: VERIFIER, redirectUri: REDIRECT });
}

/** A signed-in fake: one access token for refresh token `rt`. */
async function rig(over: ConstructorParameters<typeof FakeYouTube>[0] = {}, rt = "1//rt-main") {
  const f = new FakeYouTube(over);
  const at = await f.accessToken(rt);
  return { f, at, rt };
}
const bcast = (title = "Match") => ({ title, description: "d", scheduledStart: START, privacy: "unlisted" as const, madeForKids: false });

/** A stream key plus a broadcast bound to it, `ready` (the state Go live leaves them in). */
async function boundPair(f: FakeYouTube, at: string) {
  const { streamId } = await f.insertStream(at, { title: "key" });
  const { broadcastId } = await f.insertBroadcast(at, bcast());
  await f.bind(at, broadcastId, streamId);
  return { streamId, broadcastId };
}
/** Whether a refresh token is dead: its next accessToken is youtube_reconnect_needed (any other outcome is alive; any other error fails the test). */
const isDead = (f: FakeYouTube) => async (rt: string): Promise<boolean> => {
  try {
    await f.accessToken(rt);
    return false;
  } catch (e) {
    if (e instanceof YouTubeError && e.code === "youtube_reconnect_needed") return true;
    throw e;
  }
};
async function rejection(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, and the call resolved");
}

describe("auto-start and auto-stop", () => {
  it("a bound broadcast goes live when video arrives, and auto-stop is OFF — it stays live after videoOff", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    expect((await f.broadcastLife(at, broadcastId)).life, "PREMISE: bound, no video yet").toBe("ready");
    f.videoOn(streamId);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("live");
    f.videoOff(streamId);
    expect((await f.broadcastLife(at, broadcastId)).life, "enableAutoStop=false: no video does not end it").toBe("live");
    f.videoOn(streamId);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("live");
    expect(f.liveBroadcastCount(), "video coming back is not a second live broadcast").toBe(1);
    await f.complete(at, broadcastId);
    expect((await f.broadcastLife(at, broadcastId)).life, "only complete() ends it").toBe("complete");
  });

  it("video with nothing bound starts nothing, and a broadcast that never saw video never starts", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    f.videoOn(streamId);
    expect((await f.broadcastLife(at, broadcastId)).life, "created and unbound: video on a key starts nothing").toBe("created");
    f.videoOff(streamId);
    await f.bind(at, broadcastId, streamId);
    expect((await f.broadcastLife(at, broadcastId)).life, "bound with the video already off").toBe("ready");
    expect(f.liveBroadcastCount()).toBe(0);
  });

  it("binding to a key that already carries video starts the broadcast at once", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    f.videoOn(streamId);
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    await f.bind(at, broadcastId, streamId);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("live");
  });

  it("autoVideo: every bind leaves the broadcast live, as if video had arrived (e2e has no ingest to watch)", async () => {
    const { f, at } = await rig();
    f.setAutoVideo(true);
    const { broadcastId } = await boundPair(f, at);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("live");
    f.setAutoVideo(false);
    const second = await boundPair(f, at);
    expect((await f.broadcastLife(at, second.broadcastId)).life, "autoVideo off again: ready until video arrives").toBe("ready");
  });
});

// D15: youtube_broadcasts.actual_start_at / actual_end_at. liveBroadcasts `snippet.actualStartTime` is set once the broadcast
// goes live and `actualEndTime` once it is complete (https://developers.google.com/youtube/v3/live/docs/liveBroadcasts); the fake
// reads them off its injected clock, so the instants below are the test's own, never the fake's.
describe("broadcastLife reports the actual start and end instants", () => {
  const clock = () => {
    let t = START.getTime();
    return { now: () => new Date(t), set: (ms: number) => { t = START.getTime() + ms; } };
  };

  it("reports status.madeForKids as the broadcast was created: true and false each read back, and a broadcast the fake does not hold says nothing (null, not false)", async () => {
    let checked = 0;
    for (const declared of [true, false]) {
      const f = new FakeYouTube({ now: clock().now });
      const at = await f.accessToken(`1//rt-kids-${declared}`);
      const { broadcastId } = await f.insertBroadcast(at, { ...bcast(), madeForKids: declared });
      expect((await f.broadcastLife(at, broadcastId)).madeForKids, `created with ${declared}`).toBe(declared);
      expect((await f.broadcastLife(at, "no-such-broadcast")).madeForKids, "absent: YouTube said nothing").toBeNull();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("nothing before it happens: created, ready and absent report no start and no end", async () => {
    const c = clock();
    const f = new FakeYouTube({ now: c.now });
    const at = await f.accessToken("1//rt-actual-0");
    const { streamId } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    expect(await f.broadcastLife(at, broadcastId), "created").toEqual({ life: "created", actualStartAt: null, actualEndAt: null, madeForKids: false });
    await f.bind(at, broadcastId, streamId);
    expect(await f.broadcastLife(at, broadcastId), "ready").toEqual({ life: "ready", actualStartAt: null, actualEndAt: null, madeForKids: false });
    expect(await f.broadcastLife(at, "no-such-broadcast"), "absent").toEqual({ life: "absent", actualStartAt: null, actualEndAt: null, madeForKids: null });
  });

  it("video arriving stamps the start (the clock then, not later reads); complete stamps the end; neither moves afterwards", async () => {
    const c = clock();
    const f = new FakeYouTube({ now: c.now });
    const at = await f.accessToken("1//rt-actual-1");
    const { streamId, broadcastId } = await boundPair(f, at);
    c.set(5 * 60_000);   // 12:05 — video arrives
    f.videoOn(streamId);
    c.set(9 * 60_000);   // 12:09 — a read, not an event
    expect(await f.broadcastLife(at, broadcastId)).toEqual({ life: "live", actualStartAt: new Date("2026-10-27T12:05:00Z"), actualEndAt: null, madeForKids: false });
    f.videoOff(streamId); c.set(10 * 60_000); f.videoOn(streamId);   // video returns: not a second start
    expect((await f.broadcastLife(at, broadcastId)).actualStartAt, "the first start stands").toEqual(new Date("2026-10-27T12:05:00Z"));
    c.set(50 * 60_000);   // 12:50 — the end step (inside the access token's hour)
    await f.complete(at, broadcastId);
    c.set(55 * 60_000);
    await f.complete(at, broadcastId);   // a second complete resolves (Google: redundantTransition) and moves nothing
    expect(await f.broadcastLife(at, broadcastId)).toEqual({ life: "complete", actualStartAt: new Date("2026-10-27T12:05:00Z"), actualEndAt: new Date("2026-10-27T12:50:00Z"), madeForKids: false });
    expect(f.inspectBroadcast(broadcastId), "the control view shows the same instants").toMatchObject({ actualStartAt: new Date("2026-10-27T12:05:00Z"), actualEndAt: new Date("2026-10-27T12:50:00Z") });
  });

  it("the other ways to go live stamp the start too: binding to a key already carrying video, and autoVideo", async () => {
    const c = clock();
    const f = new FakeYouTube({ now: c.now });
    const at = await f.accessToken("1//rt-actual-2");
    const { streamId } = await f.insertStream(at, { title: "k" });
    f.videoOn(streamId);
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    c.set(2 * 60_000);
    await f.bind(at, broadcastId, streamId);
    expect((await f.broadcastLife(at, broadcastId)).actualStartAt, "bind to a live key").toEqual(new Date("2026-10-27T12:02:00Z"));
    f.setAutoVideo(true);
    c.set(3 * 60_000);
    const auto = await boundPair(f, at);
    expect((await f.broadcastLife(at, auto.broadcastId)).actualStartAt, "autoVideo").toEqual(new Date("2026-10-27T12:03:00Z"));
  });

  it("complete on a broadcast that never went live is refused (invalidTransition) and stamps no end: a bound, ready broadcast has no start and no end", async () => {
    const c = clock();
    const f = new FakeYouTube({ now: c.now });
    const at = await f.accessToken("1//rt-actual-3");
    const { broadcastId } = await boundPair(f, at);
    const err = await rejection(f.complete(at, broadcastId));
    expect(err, "complete needs a live broadcast").toBeInstanceOf(YouTubeError);
    expect((err as YouTubeError).reason).toBe("invalidTransition");
    expect(await f.broadcastLife(at, broadcastId), "a refused complete stamps nothing").toEqual({ life: "ready", actualStartAt: null, actualEndAt: null, madeForKids: false });
  });

  it("the instants are copies: mutating a returned Date does not move the fake's record", async () => {
    const c = clock();
    const f = new FakeYouTube({ now: c.now });
    const at = await f.accessToken("1//rt-actual-4");
    const { streamId, broadcastId } = await boundPair(f, at);
    f.videoOn(streamId);
    const first = (await f.broadcastLife(at, broadcastId)).actualStartAt!;
    first.setUTCFullYear(1999);
    expect((await f.broadcastLife(at, broadcastId)).actualStartAt, "a second read is unchanged").toEqual(START);
  });
});

describe("Google's documented limits", () => {
  it("an 11th concurrently live broadcast on one channel is refused; the 10th is not", async () => {
    const { f, at } = await rig();
    const pairs = [];
    for (let i = 0; i < 11; i++) pairs.push(await boundPair(f, at));   // 11 keys, 11 bound broadcasts: creating them is not the limit
    expect(f.streamsCount()).toBe(11);
    for (let i = 0; i < 10; i++) f.videoOn(pairs[i]!.streamId);
    expect(f.liveBroadcastCount(), "the 10th is live").toBe(10);
    const refused = (() => { try { f.videoOn(pairs[10]!.streamId); } catch (e) { return e; } return null; })();
    expect(refused).toBeInstanceOf(YouTubeError);
    expect((refused as YouTubeError).code).toBe("youtube_limit_reached");
    expect(f.liveBroadcastCount(), "the refusal changed nothing").toBe(10);
    expect((await f.broadcastLife(at, pairs[10]!.broadcastId)).life).toBe("ready");
    // The twin that makes the 10 a LIMIT and not a count of everything: a slot freed by complete() is reusable.
    await f.complete(at, pairs[0]!.broadcastId);
    f.videoOn(pairs[10]!.streamId);
    expect((await f.broadcastLife(at, pairs[10]!.broadcastId)).life).toBe("live");
    expect(f.liveBroadcastCount(), "10 live again, not 11").toBe(10);
  });

  it("the 10 is per CHANNEL: two grants are two channels, each with its own 10 (a global cap would refuse B's first)", async () => {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-a");
    const atB = await f.accessToken("1//rt-b");
    expect(f.channelOf("1//rt-a"), "PREMISE: by default every grant has its own channel").not.toBe(f.channelOf("1//rt-b"));
    for (let i = 0; i < 10; i++) f.videoOn((await boundPair(f, atA)).streamId);
    expect(f.liveBroadcastCount(f.channelOf("1//rt-a"))).toBe(10);
    const onB = await boundPair(f, atB);
    f.videoOn(onB.streamId);   // a global cap of 10 would refuse this as the 11th
    expect((await f.broadcastLife(atB, onB.broadcastId)).life).toBe("live");
    expect(f.liveBroadcastCount(), "11 live in all").toBe(11);
    expect(f.liveBroadcastCount(f.channelOf("1//rt-b"))).toBe(1);
    const overA = await boundPair(f, atA);
    expect(() => f.videoOn(overA.streamId), "A is still at its 10").toThrow(YouTubeError);
    // B fills its own 10 as well.
    for (let i = 0; i < 9; i++) f.videoOn((await boundPair(f, atB)).streamId);
    expect(f.liveBroadcastCount(f.channelOf("1//rt-b"))).toBe(10);
    const overB = await boundPair(f, atB);
    expect(() => f.videoOn(overB.streamId), "and B has its own 10 too").toThrow(YouTubeError);
  });

  it("two grants pinned to the SAME channel share its 10: the second token's first live is the 11th", async () => {
    const f = new FakeYouTube({ channels: [{ id: "UCsharedChannelAAAAAAAAA", title: "Shared" }] });
    const at1 = await f.accessToken("1//rt-1");
    const at2 = await f.accessToken("1//rt-2");
    expect(f.channelOf("1//rt-1")).toBe(f.channelOf("1//rt-2"));
    for (let i = 0; i < 10; i++) f.videoOn((await boundPair(f, at1)).streamId);
    const eleventh = await boundPair(f, at2);
    expect(() => f.videoOn(eleventh.streamId)).toThrow(YouTubeError);
    // The same channel is visible to both tokens (the twin of the cross-channel refusals below).
    expect((await f.broadcastLife(at2, (await f.insertBroadcast(at1, bcast())).broadcastId)).life).toBe("created");
  });

  it("with autoVideo on, the 11th bind resolves and the broadcast stays ready (YouTube will not start it) — no throw from bind", async () => {
    const { f, at } = await rig();
    f.setAutoVideo(true);
    const lives = [];
    for (let i = 0; i < 10; i++) lives.push(await boundPair(f, at));
    expect(f.liveBroadcastCount()).toBe(10);
    const eleventh = await boundPair(f, at);
    expect((await f.broadcastLife(at, eleventh.broadcastId)).life).toBe("ready");
    expect(f.liveBroadcastCount()).toBe(10);
  });

  it("a 4th open broadcast bound to one key is refused; the 3rd is not", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await f.insertBroadcast(at, bcast(`m${i}`))).broadcastId);
    for (let i = 0; i < 3; i++) await f.bind(at, ids[i]!, streamId);
    expect(f.boundOpenCount(streamId), "the 3rd is bound").toBe(3);
    const refused = await rejection(f.bind(at, ids[3]!, streamId));
    expect(refused).toBeInstanceOf(YouTubeError);
    expect((refused as YouTubeError).code).toBe("youtube_limit_reached");
    expect(f.boundOpenCount(streamId)).toBe(3);
    expect((await f.broadcastLife(at, ids[3]!)).life, "the refused one is still unbound").toBe("created");
    // Twins: another key takes it; and a slot on THIS key is freed by a completed or a deleted broadcast.
    const other = await f.insertStream(at, { title: "other" });
    await f.bind(at, ids[3]!, other.streamId);
    expect(f.boundOpenCount(other.streamId)).toBe(1);
    const again = (await f.insertBroadcast(at, bcast("again"))).broadcastId;
    await f.deleteBroadcast(at, ids[0]!);
    await f.bind(at, again, streamId);
    expect(f.boundOpenCount(streamId), "a deleted broadcast freed a slot").toBe(3);
    f.videoOn(streamId);   // ids[1], ids[2], again → live
    await f.complete(at, ids[1]!);
    expect(f.boundOpenCount(streamId), "a completed broadcast is no longer open").toBe(2);
  });

  it("re-binding a broadcast to the key it already holds is not a 4th", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await f.insertBroadcast(at, bcast())).broadcastId);
      await f.bind(at, ids[i]!, streamId);
    }
    await f.bind(at, ids[0]!, streamId);   // resolves
    expect(f.boundOpenCount(streamId)).toBe(3);
  });
});

describe("token death", () => {
  it("a killed token: accessToken → youtube_reconnect_needed (and stays dead); the bound key still carries video", async () => {
    const { f, at, rt } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    f.killToken(rt);
    for (const attempt of [1, 2]) {
      const err = await rejection(f.accessToken(rt));
      expect(err, `attempt ${attempt}`).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe("youtube_reconnect_needed");
    }
    expect(((await rejection(f.broadcastLife(at, broadcastId))) as YouTubeError).code, "the access token minted from it dies with it").toBe("youtube_reconnect_needed");
    f.videoOn(streamId);   // the relay is pushing video to the key; Google's revoke does not touch the stream
    expect(f.liveBroadcastCount()).toBe(1);
    expect(f.inspectBroadcast(broadcastId)?.life).toBe("live");
    // Twin: another refresh token is alive.
    await expect(f.accessToken("1//rt-other")).resolves.toEqual(expect.any(String));
    // A RECONNECT is a new grant. It gets a channel of its own by default, so the old broadcast is another channel's (absent
    // to it) — unless the test pins the channel, as a reconnect to the SAME channel does in life.
    const same = new FakeYouTube({ channels: [{ id: "UCreconnectChannelAAAAA", title: "Same" }] });
    const old = await same.accessToken("1//rt-old");
    const kept = await boundPair(same, old);
    same.killToken("1//rt-old");
    const reconnected = await same.accessToken((await grant(same)).refreshToken);
    same.videoOn(kept.streamId);
    expect((await same.broadcastLife(reconnected, kept.broadcastId)).life, "the new token reaches the broadcast that kept running").toBe("live");
  });

  it("revoke(refreshToken) is Google's revocation: the token is dead afterwards; revoking an unknown token resolves", async () => {
    const { f, rt } = await rig();
    await f.revoke(rt);
    expect(((await rejection(f.accessToken(rt))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    await expect(f.revoke("never-seen")).resolves.toBeUndefined();
    await expect(f.accessToken("1//never-seen-2"), "an untouched token is still good").resolves.toEqual(expect.any(String));
  });

  // Google: revoking a token invalidates the user's whole grant to the client (…/oauth2/web-server, "Token revocation"), so a
  // disconnect of ONE club must read, in the fake, as every token of that Google account dying — what live does.
  it("revoke kills the WHOLE grant: every refresh token of the same account — on the same channel (a reconnect), or reporting the same non-null subject on another channel — and no other account's", async () => {
    const f = new FakeYouTube();
    const mint = async (o: { sub?: string | null; channel?: string } = {}) => {
      const g = await grant(f, { before: (state) => { if (o.sub !== undefined) f.setGoogleSub(o.sub, state); if (o.channel) f.setChannels([{ id: o.channel, title: "C" }], state); } });
      return g.refreshToken;
    };
    const dead = isDead(f);
    // (a) the same channel, derived subjects: a reconnect that was never revoked
    const a1 = await mint({ channel: "UCsameChannelAAAAAAAAAAA" });
    const a2 = await mint({ channel: "UCsameChannelAAAAAAAAAAA" });
    // (b) one person, two clubs: different channels, ONE subject
    const b1 = await mint({ sub: "acct-two-clubs", channel: "UCclubOneBBBBBBBBBBBBB" });
    const b2 = await mint({ sub: "acct-two-clubs", channel: "UCclubTwoBBBBBBBBBBBBB" });
    // (d) a reconnect of an account that reports NO subject: only the channel says they are one account
    const d1 = await mint({ sub: null, channel: "UCnoSubSameChannelDDDDD" });
    const d2 = await mint({ sub: null, channel: "UCnoSubSameChannelDDDDD" });
    // (c) bystanders: another account on its own channel, and a no-subject grant on another channel
    const other = await mint();
    const noSubA = await mint({ sub: null, channel: "UCnoSubAAAAAAAAAAAAAAAA" });
    const noSubB = await mint({ sub: null, channel: "UCnoSubBBBBBBBBBBBBBBBB" });
    // PREMISE: every token is alive before anything is revoked (so 'dead after' can fail)
    let alive = 0;
    for (const rt of [a1, a2, b1, b2, d1, d2, other, noSubA, noSubB]) { expect(await dead(rt), "alive before").toBe(false); alive++; }
    expect(alive, "PREMISE: nine grants").toBe(9);

    await f.revoke(a1);
    expect([await dead(a1), await dead(a2)], "same channel: the whole account is revoked").toEqual([true, true]);
    for (const rt of [b1, b2, d1, d2, other, noSubA, noSubB]) expect(await dead(rt), "another account lives").toBe(false);

    await f.revoke(d1);
    expect([await dead(d1), await dead(d2)], "same channel, no subject: still one account (a reconnect)").toEqual([true, true]);
    for (const rt of [b1, b2, other, noSubA, noSubB]) expect(await dead(rt), "bystanders live").toBe(false);

    await f.revoke(b2);
    expect([await dead(b1), await dead(b2)], "same non-null subject on different channels: one grant").toEqual([true, true]);
    for (const rt of [other, noSubA, noSubB]) expect(await dead(rt), "bystanders still live").toBe(false);

    await f.revoke(noSubA);
    expect(await dead(noSubA), "the revoked token itself").toBe(true);
    expect(await dead(noSubB), "NULL subjects never match each other: no subject is not one account").toBe(false);
    expect(await dead(other)).toBe(false);

    // a reconnect AFTER the revoke is a new grant and works, on the same channel too
    const fresh = await mint({ channel: "UCsameChannelAAAAAAAAAAA" });
    expect(await dead(fresh), "reconnect after revoke").toBe(false);
  });

  it("killToken stays PER-TOKEN: killing one refresh token leaves the same account's other tokens alive (T14's one dead grant, not a revoke)", async () => {
    const f = new FakeYouTube();
    const channel = [{ id: "UCsameChannelKKKKKKKKKKK", title: "K" }];
    const one = await grant(f, { before: (state) => f.setChannels(channel, state) });
    const two = await grant(f, { before: (state) => f.setChannels(channel, state) });
    f.killToken(one.refreshToken);
    expect(((await rejection(f.accessToken(one.refreshToken))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    await expect(f.accessToken(two.refreshToken), "the twin on the same channel is untouched").resolves.toEqual(expect.any(String));
  });

  it("revoke logs as one 'revoke' call and is injectable like the rest (failNext('revoke') leaves every token alive)", async () => {
    const f = new FakeYouTube();
    const g = await grant(f);
    f.failNext("revoke", "youtube_unavailable", "backendError");
    await rejection(f.revoke(g.refreshToken));
    await expect(f.accessToken(g.refreshToken), "the failed revoke killed nothing").resolves.toEqual(expect.any(String));
    await f.revoke(g.refreshToken);
    expect(f.calls.filter((c) => c.method === "revoke")).toHaveLength(2);
  });

  it("an access token the fake never issued is refused like an expired one", async () => {
    const f = new FakeYouTube();
    const err = await rejection(f.listMyChannels("not-an-access-token"));
    expect((err as YouTubeError).code).toBe("youtube_reconnect_needed");
  });

  it("a refresh token the fake never issued is invalid_grant unless it has Google's 1// shape; one the exchange minted works", async () => {
    const f = new FakeYouTube();
    // None of these was ever issued, and none is shaped like Google's: a uuid, a base64url byte string, a sealed-looking blob (the
    // product stores refresh tokens sealed), a near miss of the prefix, a token that LOOKS like the fake's own but was not minted.
    const unissued = [
      "3f2b8c1e-9d4a-4b7e-8a61-0c5d2e7f9b13", "k9Qz2mXr7TvB1wYc5NfH8LpD4sJgA0eU-_x3Wq", "v1:AAAAAAAAAAAAAAAA:Zm9vYmFyYmF6:dGFn",
      "1/rt-one-slash", "/1//rt-leading-slash", "fake-rt-9999", "rt-the-old-literal",
    ];
    let checked = 0;
    for (const token of unissued) {
      const err = await rejection(f.accessToken(token));
      expect(err, token).toBeInstanceOf(YouTubeError);
      expect([(err as YouTubeError).code, (err as YouTubeError).reason], token).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
      expect(() => f.channelOf(token), `${token}: no grant was made by trying`).toThrow(YouTubeError);
      checked++;
    }
    expect(checked, "every unissued shape was tried").toBe(unissued.length);
    // Twins: a Google-shaped token is accepted unseen, each on a fresh channel; a token the exchange minted works.
    const at1 = await f.accessToken("1//x");
    const at2 = await f.accessToken("1//y");
    expect(await f.listMyChannels(at1)).toHaveLength(1);
    expect(f.channelOf("1//x")).not.toBe(f.channelOf("1//y"));
    expect(await f.accessToken("1//x"), "the same seeded token keeps its channel").toEqual(expect.any(String));
    expect(f.channelOf("1//x")).toBe((await f.listMyChannels(at1))[0]!.id);
    expect(at2).toEqual(expect.any(String));
    const minted = await grant(f);
    await expect(f.accessToken(minted.refreshToken), "a token minted by exchangeCode").resolves.toEqual(expect.any(String));
    // Empty is not a token at all.
    expect(((await rejection(f.accessToken(""))) as YouTubeError).code).toBe("youtube_reconnect_needed");
  });

  it("handles: tokenHandle is stable per token, opaque, and killHandle kills exactly that token", async () => {
    const f = new FakeYouTube();
    const secret = "1//0gSECRETrefreshTokenValue-abc_123";
    const h1 = f.tokenHandle(secret);
    expect(f.tokenHandle(secret), "stable").toBe(h1);
    const h2 = f.tokenHandle("1//another-token");
    expect(h2).not.toBe(h1);
    expect(h1).not.toContain("SECRET");
    expect(h1).not.toContain(secret.slice(0, 6));
    f.killHandle(h1);
    expect(((await rejection(f.accessToken(secret))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    await expect(f.accessToken("1//another-token"), "the other handle's token is untouched").resolves.toEqual(expect.any(String));
    expect(() => f.killHandle("fake-th-unknown")).toThrow(YouTubeError);
  });
});

describe("failNext", () => {
  it("injects exactly once, for every refusal code", async () => {
    const codes = ["youtube_reconnect_needed", "youtube_live_not_enabled", "youtube_live_blocked", "youtube_limit_reached", "youtube_unavailable"] as const;
    const { f, at } = await rig();
    let checked = 0;
    for (const c of codes) {
      f.failNext("insertStream", c, "someReason");
      const err = await rejection(f.insertStream(at, { title: "k" }));
      expect(err, c).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code).toBe(c);
      expect((err as YouTubeError).reason).toBe("someReason");
      expect(f.streamsCount(), `${c}: a refused insert created nothing`).toBe(checked);
      await expect(f.insertStream(at, { title: "k" }), `${c}: the next call succeeds`).resolves.toEqual(expect.objectContaining({ streamId: expect.any(String) }));
      checked++;
    }
    expect(checked).toBe(5);
    expect(f.streamsCount(), "one stream per success, none per refusal").toBe(5);
  });

  it("youtube_not_found is injectable too, and failures queue in order", async () => {
    const { f, at } = await rig();
    f.failNext("listMyChannels", "youtube_not_found");
    f.failNext("listMyChannels", "youtube_unavailable");
    expect(((await rejection(f.listMyChannels(at))) as YouTubeError).code).toBe("youtube_not_found");
    expect(((await rejection(f.listMyChannels(at))) as YouTubeError).code).toBe("youtube_unavailable");
    await expect(f.listMyChannels(at)).resolves.toHaveLength(1);
  });

  it("a failure belongs to ITS method: another method is untouched, and the failed call still counts as a call", async () => {
    const { f, at } = await rig();
    f.failNext("insertBroadcast", "youtube_live_blocked");
    await expect(f.insertStream(at, { title: "k" })).resolves.toBeDefined();
    expect(((await rejection(f.insertBroadcast(at, bcast()))) as YouTubeError).code).toBe("youtube_live_blocked");
    expect(f.calls.map((c) => c.method)).toEqual(["accessToken", "insertStream", "insertBroadcast"]);
  });

  it("every one of the port's 15 methods can be failed, and each failure is single-shot", async () => {
    const f = new FakeYouTube();
    const at = await f.accessToken("1//rt-sweep");
    const { streamId } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    const invoke: Record<Exclude<keyof YouTubePort, "mode">, () => unknown> = {
      authorizeUrl: () => f.authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: REDIRECT }),
      exchangeCode: () => f.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: REDIRECT }),
      accessToken: () => f.accessToken("1//rt-sweep"),
      listMyChannels: () => f.listMyChannels(at),
      liveEnabled: () => f.liveEnabled(at),
      insertStream: () => f.insertStream(at, { title: "k" }),
      deleteStream: () => f.deleteStream(at, streamId),
      listStreams: () => f.listStreams(at),
      insertBroadcast: () => f.insertBroadcast(at, bcast()),
      bind: () => f.bind(at, broadcastId, streamId),
      broadcastLife: () => f.broadcastLife(at, broadcastId),
      complete: () => f.complete(at, broadcastId),
      deleteBroadcast: () => f.deleteBroadcast(at, broadcastId),
      existingVideos: () => f.existingVideos(at, [broadcastId]),
      revoke: () => f.revoke("1//rt-never-used"),
    };
    let checked = 0;
    for (const [method, call] of Object.entries(invoke) as [keyof typeof invoke, () => unknown][]) {
      f.failNext(method, "youtube_limit_reached", "quotaExceeded");
      const err = await rejection(async () => call());
      expect(err, method).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code, method).toBe("youtube_limit_reached");
      checked++;
    }
    expect(checked, "all 15 methods swept").toBe(15);
    // Single-shot, proven on the same sweep: a SECOND call of each method is not the injected refusal. Some of these still
    // refuse for their own reasons (the stream was deleted above, so bind says not_found) — never with the injected code.
    let second = 0;
    for (const [method, call] of Object.entries(invoke) as [keyof typeof invoke, () => unknown][]) {
      const err = await rejection(async () => { await call(); throw new Error("resolved"); });
      if (err instanceof YouTubeError) expect(err.code, `${method}: injection is spent`).not.toBe("youtube_limit_reached");
      else expect((err as Error).message, `${method}: the second call went through`).toBe("resolved");
      second++;
    }
    expect(second, "all 15 methods re-called").toBe(15);
  });

  it("a method name that is not on the port is refused at injection (a typo must not become a failure that never fires)", () => {
    const f = new FakeYouTube();
    expect(() => f.failNext("insertStreem" as never, "youtube_unavailable")).toThrow();
    expect(() => f.failNext("mode" as never, "youtube_unavailable")).toThrow();
    expect(() => f.failNext("insertStream", "youtube_channel_busy" as never)).toThrow();   // Seazn's own answer, never YouTube's
  });
});

describe("secrets never leave through an error or the call log", () => {
  // A raw provider failure as Google's token endpoint writes it: a form string carrying a refresh token and a client secret.
  const TOKEN = "1//0gTOKENSHAPEDvalueNOBODYmayEverSee-xyz_987";
  const BODY = `refresh_token=${TOKEN}&client_secret=GOCSPX-clientSecretValue&error=invalid_grant`;
  const FRAGMENTS = ["refresh_token", "1//0g", "TOKENSHAPED", "NOBODYmay", "GOCSPX", "clientSecretValue", "client_secret", "invalid_grant"];

  it("a fake error carrying a token-shaped string: the thrown error, its message, stack, JSON and the LOGGED line hold no part of it", async () => {
    const { f, at } = await rig();
    f.failNext("insertStream", "youtube_unavailable", BODY);
    const err = (await rejection(f.insertStream(at, { title: "k" }))) as YouTubeError;
    expect(err).toBeInstanceOf(YouTubeError);

    const lines: string[] = [];
    const sink = pino({ ...LOGGER_OPTIONS, level: "trace" }, { write: (s: string) => { lines.push(s); } });
    sink.warn({ err }, "youtube call failed");
    sink.warn({ error: err, extra: { err } }, "youtube call failed, other keys");   // a nested key is one level deep: redact does not see it
    expect(lines.length, "anti-vacuity: the logger wrote").toBe(2);

    const surfaces: Record<string, string> = {
      message: err.message, reason: err.reason, stack: err.stack ?? "", toString: String(err), json: JSON.stringify(err),
      line1: lines[0]!, line2: lines[1]!,
    };
    let checked = 0;
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const part of FRAGMENTS) {
        expect(text, `${surface} must not contain ${part}`).not.toContain(part);
        checked++;
      }
    }
    expect(checked, "surfaces × fragments").toBe(7 * FRAGMENTS.length);
    // The positive pair: what IS logged is the closed code, so the line is not empty because the error was dropped.
    expect(err.code).toBe("youtube_unavailable");
    expect(lines[0]).toContain("youtube_unavailable");
    expect(err.reason, "a body is not a reason: dropped whole").toBe("");
  });

  it("the reason is Google's token or nothing: letters up to 64 pass, 65 letters, digits, punctuation and spaces do not", () => {
    const rows: [string, string][] = [
      ["liveStreamingNotEnabled", "liveStreamingNotEnabled"],
      ["a".repeat(64), "a".repeat(64)],
      ["", ""],
      ["a".repeat(65), ""],
      ["rate_limit", ""],
      ["abc123", ""],
      ["has space", ""],
      [`abc${TOKEN}`, ""],
    ];
    let checked = 0;
    for (const [given, want] of rows) {
      expect(new YouTubeError("youtube_unavailable", given).reason, JSON.stringify(given.slice(0, 20))).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("a code outside the closed set is never echoed: it becomes youtube_unavailable", () => {
    const err = new YouTubeError(BODY as never, "authError");
    expect(err.code).toBe("youtube_unavailable");
    expect(err.message).not.toContain("refresh_token");
    expect(new YouTubeError("__proto__" as never).code).toBe("youtube_unavailable");
    expect(new YouTubeError("youtube_not_found").code, "the positive twin: a real code is kept").toBe("youtube_not_found");
  });

  it("calls[] records method names only — no token or key substring appears in JSON.stringify(fake.calls)", async () => {
    const clock = vi.fn(() => new Date("2026-10-27T09:30:00Z"));
    const f = new FakeYouTube({ now: clock });
    const refresh = "1//0gREFRESHsecretToken-abc";
    const at = await f.accessToken(refresh);
    const { streamId, ingest } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, bcast("TitleDoesNotMatter"));
    await f.bind(at, broadcastId, streamId);
    await f.revoke(refresh);
    const text = JSON.stringify(f.calls);
    expect(f.calls.length, "anti-vacuity").toBe(5);
    expect(f.calls.map((c) => c.method)).toEqual(["accessToken", "insertStream", "insertBroadcast", "bind", "revoke"]);
    for (const secret of [refresh, at, ingest.streamKey, ingest.url, streamId, broadcastId, "TitleDoesNotMatter"]) {
      expect(text, "a call log holds names and times, never arguments").not.toContain(secret);
    }
    expect(Object.keys(f.calls[0]!).sort()).toEqual(["at", "method"]);
    expect(f.calls[0]!.at.toISOString(), "stamped by the injected clock").toBe("2026-10-27T09:30:00.000Z");
  });
});

describe("the rest of the port's behaviour", () => {
  it("authorizeUrl points at the fake-authorize hop on the redirect URI's own origin and carries state, challenge and redirect", () => {
    const f = new FakeYouTube();
    const url = new URL(f.authorizeUrl({ state: "st4te", codeChallenge: "ch4llenge", redirectUri: REDIRECT }));
    expect(url.origin).toBe("https://app.example.test");
    expect(url.pathname).toBe("/api/youtube/connect/fake-authorize");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("channels: a grant sees one channel of its own by default; setChannels is bound to ONE OAuth state and spent by the grant it mints; the empty list is a real answer", async () => {
    const f = new FakeYouTube();
    const first = await grant(f);
    const at1 = await f.accessToken(first.refreshToken);
    const dflt = await f.listMyChannels(at1);
    expect(dflt).toHaveLength(1);
    expect(dflt[0]).toEqual({ id: expect.stringMatching(/^UC[A-Za-z0-9_-]{22}$/), title: expect.any(String) });
    const second = await f.listMyChannels(await f.accessToken((await grant(f)).refreshToken));
    expect(second[0]!.id, "a second grant has a different channel").not.toBe(dflt[0]!.id);
    const two = [{ id: "UCone", title: "One" }, { id: "UCtwo", title: "Two" }];
    const pinned = await grant(f, { before: (state) => f.setChannels(two, state) });
    expect(await f.listMyChannels(await f.accessToken(pinned.refreshToken)), "the grant of THAT state sees them").toEqual(two);
    expect(await f.listMyChannels(at1), "a grant made before keeps its channels").toEqual(dflt);
    // Spent: the very next connect is a fresh channel again, neither UCone nor the first grant's.
    const after = await f.listMyChannels(await f.accessToken((await grant(f)).refreshToken));
    expect(after).toHaveLength(1);
    expect([after[0]!.id, after[0]!.title]).not.toEqual(["UCone", "One"]);
    expect(after[0]!.id).not.toBe(dflt[0]!.id);
    expect(after[0]!.id).not.toBe(second[0]!.id);
    // The empty list is a real answer, for that grant only.
    const none = await grant(f, { before: (state) => f.setChannels([], state) });
    expect(await f.listMyChannels(await f.accessToken(none.refreshToken))).toEqual([]);
    expect(await f.listMyChannels(await f.accessToken((await grant(f)).refreshToken)), "and the next one has a channel").toHaveLength(1);
    // The constructor's fixture is the one thing every grant shares, and callers get copies of it.
    const given = new FakeYouTube({ channels: [{ id: "UCx", title: "X" }] });
    expect(await given.listMyChannels(await given.accessToken("1//rt"))).toEqual([{ id: "UCx", title: "X" }]);
    const returned = await given.listMyChannels(await given.accessToken("1//rt"));
    returned.push({ id: "UCmutated", title: "M" });
    expect(await given.listMyChannels(await given.accessToken("1//rt")), "callers get a copy").toHaveLength(1);
  });

  it("a pin is bound to its STATE, not to the fake: two connects in flight each get their own, whichever finishes first", async () => {
    const f = new FakeYouTube();
    const pinA = [{ id: "UCpinForConnectA", title: "A" }];
    f.authorizeUrl({ state: "conn-a", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.setChannels(pinA, "conn-a");
    f.authorizeUrl({ state: "conn-b", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const exchange = (code: string) => f.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const b = await exchange(f.issueCode("conn-b"));
    const a = await exchange(f.issueCode("conn-a"));
    expect(await f.listMyChannels(await f.accessToken(a.refreshToken)), "A's pin reached A").toEqual(pinA);
    const seenByB = await f.listMyChannels(await f.accessToken(b.refreshToken));
    expect(seenByB, "B has a channel of its own, not A's pin").toHaveLength(1);
    expect(seenByB[0]!.id).not.toBe("UCpinForConnectA");
    // A second code for A's state carries no pin: the pin went with the first code.
    const again = await exchange(f.issueCode("conn-a"));
    expect((await f.listMyChannels(await f.accessToken(again.refreshToken)))[0]!.id, "the pin was spent").not.toBe("UCpinForConnectA");
    expect(() => f.setChannels(pinA, "never-authorized"), "an unknown state").toThrow(YouTubeError);
    expect(() => f.pinChannelsTo("fake-th-nope", "conn-a"), "an unknown handle").toThrow(YouTubeError);
  });

  it("an account with NO channel cannot create a stream or a broadcast (youtube_unavailable / youtubeSignupRequired); it can still be asked", async () => {
    const f = new FakeYouTube();
    const none = await grant(f, { before: (state) => f.setChannels([], state) });
    const at = await f.accessToken(none.refreshToken);
    expect(await f.listMyChannels(at), "PREMISE: the account has no channel").toEqual([]);
    for (const [name, call] of [
      ["insertStream", () => f.insertStream(at, { title: "k" })],
      ["insertBroadcast", () => f.insertBroadcast(at, bcast())],
    ] as const) {
      const err = await rejection(call());
      expect([name, (err as YouTubeError).code, (err as YouTubeError).reason]).toEqual([name, "youtube_unavailable", "youtubeSignupRequired"]);
    }
    expect([f.streamsCount(), f.broadcastsCount()], "and nothing was created").toEqual([0, 0]);
    expect(await f.liveEnabled(at), "asking about live streaming is not refused").toBe("enabled");
    // Twin: an account WITH a channel creates both, and a zero-channel constructor fixture refuses the same way.
    const withChannel = await f.accessToken((await grant(f)).refreshToken);
    await expect(f.insertStream(withChannel, { title: "k" })).resolves.toBeDefined();
    await expect(f.insertBroadcast(withChannel, bcast())).resolves.toBeDefined();
    const fixture = new FakeYouTube({ channels: [] });
    expect(((await rejection(fixture.insertStream(await fixture.accessToken("1//rt"), { title: "k" }))) as YouTubeError).reason).toBe("youtubeSignupRequired");
  });

  it("setLive: not_enabled / blocked refuse insertStream and insertBroadcast with the matching code; enabled works again", async () => {
    const { f, at } = await rig();
    expect(await f.liveEnabled(at)).toBe("enabled");
    const rows = [["not_enabled", "youtube_live_not_enabled"], ["blocked", "youtube_live_blocked"]] as const;
    let checked = 0;
    for (const [state, code] of rows) {
      f.setLive(state);
      expect(await f.liveEnabled(at)).toBe(state);
      expect(((await rejection(f.insertStream(at, { title: "k" }))) as YouTubeError).code).toBe(code);
      expect(((await rejection(f.insertBroadcast(at, bcast()))) as YouTubeError).code).toBe(code);
      checked++;
    }
    expect(checked).toBe(2);
    expect(f.streamsCount(), "nothing was created while refused").toBe(0);
    f.setLive("enabled");
    await expect(f.insertStream(at, { title: "k" })).resolves.toBeDefined();
  });

  it("insertStream: an RTMP ingest on YouTube's host with its own key; ids are distinct, and a video id has YouTube's 11-character shape", async () => {
    const { f, at } = await rig();
    const keys = new Set<string>();
    const streams = new Set<string>();
    const videos = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const s = await f.insertStream(at, { title: `k${i}` });
      expect(s.ingest.url).toBe("rtmp://a.rtmp.youtube.com/live2");
      keys.add(s.ingest.streamKey);
      streams.add(s.streamId);
      const b = await f.insertBroadcast(at, bcast());
      expect(b.broadcastId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      videos.add(b.broadcastId);
    }
    expect([keys.size, streams.size, videos.size], "25 of each, all distinct").toEqual([25, 25, 25]);
  });

  it("insertBroadcast keeps what it was given, readable through the inspector without a token", async () => {
    const { f, at } = await rig();
    const { broadcastId } = await f.insertBroadcast(at, { title: "Final", description: "Court 1", scheduledStart: START, privacy: "public", madeForKids: true });
    expect(f.inspectBroadcast(broadcastId)).toEqual({
      channelId: f.channelOf("1//rt-main"), title: "Final", description: "Court 1", scheduledStart: START, privacy: "public", madeForKids: true,
      streamId: null, life: "created", actualStartAt: null, actualEndAt: null,
    });
    expect(f.inspectBroadcast("nope")).toBeNull();
  });

  it("bind: an unknown broadcast or stream is youtube_not_found; a completed broadcast cannot be bound", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    expect(((await rejection(f.bind(at, "nope", streamId))) as YouTubeError).code).toBe("youtube_not_found");
    expect(((await rejection(f.bind(at, broadcastId, "nope"))) as YouTubeError).code).toBe("youtube_not_found");
    f.videoOn(streamId);
    await f.complete(at, broadcastId);
    const err = (await rejection(f.bind(at, broadcastId, streamId))) as YouTubeError;
    expect(err.code).toBe("youtube_unavailable");
    expect(err.reason).toBe("invalidTransition");
  });

  it("complete: a second call resolves (already complete); an unknown id is youtube_not_found; a broadcast that never went live cannot be completed", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    expect(((await rejection(f.complete(at, broadcastId))) as YouTubeError).reason, "ready → complete is an invalid transition").toBe("invalidTransition");
    f.videoOn(streamId);
    await f.complete(at, broadcastId);
    await expect(f.complete(at, broadcastId), "the second call").resolves.toBeUndefined();
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("complete");
    expect(((await rejection(f.complete(at, "nope"))) as YouTubeError).code).toBe("youtube_not_found");
  });

  it("deleteBroadcast and deleteStream: absent resolves; present removes (and the broadcast reads absent)", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    await f.deleteBroadcast(at, broadcastId);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("absent");
    await expect(f.deleteBroadcast(at, broadcastId), "second delete").resolves.toBeUndefined();
    await expect(f.deleteBroadcast(at, "never-existed")).resolves.toBeUndefined();
    expect(f.streamsCount()).toBe(1);
    await f.deleteStream(at, streamId);
    expect(f.streamsCount()).toBe(0);
    await expect(f.deleteStream(at, streamId), "second delete").resolves.toBeUndefined();
    expect((await f.broadcastLife(at, "never-existed")).life).toBe("absent");
  });

  it("existingVideos: only the ids that exist; empty in, empty out; 50 ids are fine and 51 throw WITHOUT being a call; deleteVideo removes one", async () => {
    const { f, at } = await rig();
    const a = (await f.insertBroadcast(at, bcast())).broadcastId;
    const b = (await f.insertBroadcast(at, bcast())).broadcastId;
    expect(new Set((await f.existingVideos(at, [a, b, "ghost"])).keys())).toEqual(new Set([a, b]));
    expect((await f.existingVideos(at, [])).size).toBe(0);
    f.deleteVideo(a);
    expect([...(await f.existingVideos(at, [a, b])).keys()], "a video deleted on YouTube is gone").toEqual([b]);
    expect((await f.broadcastLife(at, a)).life).toBe("absent");
    const fifty = Array.from({ length: 50 }, (_, i) => `id${i}`);
    expect((await f.existingVideos(at, fifty)).size).toBe(0);
    const before = f.calls.length;
    await expect(f.existingVideos(at, [...fifty, "id50"])).rejects.toThrow();
    expect(f.calls.length, "refused before it counts as a call").toBe(before);
    expect(() => f.deleteVideo("never-existed")).toThrow(YouTubeError);
  });

  it("existingVideos answers each present id with YouTube's CURRENT made-for-kids (what it was created with until YouTube designates otherwise); broadcastLife reads the same; inspectBroadcast keeps what was SENT", async () => {
    const { f, at } = await rig();
    const kids = (await f.insertBroadcast(at, { ...bcast(), madeForKids: true })).broadcastId;
    const plain = (await f.insertBroadcast(at, bcast())).broadcastId;
    const facts = async () => [...(await f.existingVideos(at, [kids, plain, "ghost"]))].map(([id, v]) => [id === kids ? "kids" : "plain", v.madeForKids]);
    expect(await facts(), "created with: what was sent; the ghost is absent").toEqual([["kids", true], ["plain", false]]);
    // YouTube decides a video the club said was ordinary is made for kids: both reads follow, the record of what was sent does not.
    f.designateMadeForKids(plain, true);
    expect(await facts()).toEqual([["kids", true], ["plain", true]]);
    expect((await f.broadcastLife(at, plain)).madeForKids, "the end step's read follows the same designation").toBe(true);
    expect(f.inspectBroadcast(plain)!.madeForKids, "what Go live SENT is still false").toBe(false);
    // ...and the other way (YouTube may say not-for-kids of a video the club declared), then the designation is withdrawn.
    f.designateMadeForKids(kids, false);
    expect(await facts()).toEqual([["kids", false], ["plain", true]]);
    f.designateMadeForKids(kids, null);
    f.designateMadeForKids(plain, null);
    expect(await facts(), "withdrawn: back to what each was created with").toEqual([["kids", true], ["plain", false]]);
    expect(() => f.designateMadeForKids("never-existed", true)).toThrow(YouTubeError);
  });

  it("existingVideos([]) follows the live driver: an empty set with NO token check, NO call logged and NO injected failure taken", async () => {
    const f = new FakeYouTube();
    const before = f.calls.length;
    expect((await f.existingVideos("never-issued-access-token", [])).size, "no token check").toBe(0);
    expect(f.calls.length, "not a call").toBe(before);
    // an injected failure waits for a call that is one
    const { f: g, at } = await rig();
    g.failNext("existingVideos", "youtube_unavailable", "backendError");
    expect((await g.existingVideos(at, [])).size).toBe(0);
    expect(((await rejection(g.existingVideos(at, ["aaa"]))) as YouTubeError).reason, "the injection was still waiting").toBe("backendError");
    // the positive pair: a non-empty list does check the token
    expect(((await rejection(f.existingVideos("never-issued-access-token", ["aaa"]))) as YouTubeError).code).toBe("youtube_reconnect_needed");
  });

  it("control ops on a stream the fake never made are refused, not silently ignored", () => {
    const f = new FakeYouTube();
    expect(() => f.videoOn("nope")).toThrow(YouTubeError);
    expect(() => f.videoOff("nope")).toThrow(YouTubeError);
  });

  it("calls[] is stamped by the injected clock and starts empty", async () => {
    const f = new FakeYouTube();
    expect(f.calls).toEqual([]);
    const f2 = new FakeYouTube({ now: () => START });
    await f2.accessToken("1//rt");
    expect(f2.calls).toEqual([{ method: "accessToken", at: START }]);
  });
});

describe("channels belong to grants: a token cannot reach another channel's resources", () => {
  /** Two orgs on two channels, each with one stream and one live broadcast bound to it. */
  async function twoChannels() {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-a");
    const atB = await f.accessToken("1//rt-b");
    const a = await boundPair(f, atA);
    const b = await boundPair(f, atB);
    f.videoOn(a.streamId);
    return { f, atA, atB, a, b };
  }
  const code = async (p: Promise<unknown>) => ((await rejection(p)) as YouTubeError).code;

  it("bind: another channel's broadcast or stream is youtube_not_found; the same-channel bind is the accepted twin", async () => {
    const { f, atA, atB, a, b } = await twoChannels();
    const spare = (await f.insertBroadcast(atB, bcast())).broadcastId;
    expect(await code(f.bind(atB, a.broadcastId, b.streamId)), "A's broadcast, by B's token").toBe("youtube_not_found");
    expect(await code(f.bind(atB, spare, a.streamId)), "A's stream, by B's token").toBe("youtube_not_found");
    expect(await code(f.bind(atA, spare, a.streamId)), "B's broadcast, by A's token").toBe("youtube_not_found");
    expect(f.boundOpenCount(a.streamId), "nothing was bound").toBe(1);
    expect(f.inspectBroadcast(spare)?.streamId).toBeNull();
    await f.bind(atB, spare, b.streamId);   // the twin
    expect(f.inspectBroadcast(spare)?.streamId).toBe(b.streamId);
  });

  it("broadcastLife reads absent for another channel's broadcast; complete is not_found and changes nothing; the owner can complete", async () => {
    const { f, atA, atB, a } = await twoChannels();
    expect((await f.broadcastLife(atB, a.broadcastId)).life).toBe("absent");
    expect((await f.broadcastLife(atA, a.broadcastId)).life).toBe("live");
    expect(await code(f.complete(atB, a.broadcastId))).toBe("youtube_not_found");
    expect(f.inspectBroadcast(a.broadcastId)?.life, "B's attempt did not end A's broadcast").toBe("live");
    await f.complete(atA, a.broadcastId);
    expect(f.inspectBroadcast(a.broadcastId)?.life).toBe("complete");
  });

  it("delete: another channel's broadcast or stream is absent to the caller — it resolves and removes nothing; the owner's delete removes", async () => {
    const { f, atA, atB, a } = await twoChannels();
    await expect(f.deleteBroadcast(atB, a.broadcastId)).resolves.toBeUndefined();
    await expect(f.deleteStream(atB, a.streamId)).resolves.toBeUndefined();
    expect(f.inspectBroadcast(a.broadcastId), "A's broadcast survives B's delete").not.toBeNull();
    expect(f.streamsCount(f.channelOf("1//rt-a")), "and so does its stream").toBe(1);
    await f.deleteBroadcast(atA, a.broadcastId);
    await f.deleteStream(atA, a.streamId);
    expect(f.inspectBroadcast(a.broadcastId)).toBeNull();
    expect(f.streamsCount(f.channelOf("1//rt-a"))).toBe(0);
  });

  it("existingVideos lists only the caller's channel's videos", async () => {
    const { f, atA, atB, a, b } = await twoChannels();
    expect([...(await f.existingVideos(atA, [a.broadcastId, b.broadcastId])).keys()]).toEqual([a.broadcastId]);
    expect([...(await f.existingVideos(atB, [a.broadcastId, b.broadcastId])).keys()]).toEqual([b.broadcastId]);
  });

  it("injections are scoped by channel where they are per-resource: failNext, setLive and autoVideo for A leave B alone", async () => {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-a");
    const atB = await f.accessToken("1//rt-b");
    const chA = f.channelOf("1//rt-a");
    // failNext scoped to A: B's call goes through, A's takes it once.
    f.failNext("insertStream", "youtube_unavailable", "", { channelId: chA });
    await expect(f.insertStream(atB, { title: "k" }), "B is not A").resolves.toBeDefined();
    expect(await code(f.insertStream(atA, { title: "k" }))).toBe("youtube_unavailable");
    await expect(f.insertStream(atA, { title: "k" }), "single shot").resolves.toBeDefined();
    // An UNSCOPED failNext is taken by whoever calls first, as before.
    f.failNext("insertStream", "youtube_unavailable");
    expect(await code(f.insertStream(atB, { title: "k" }))).toBe("youtube_unavailable");
    // setLive scoped to A.
    f.setLive("blocked", { channelId: chA });
    expect(await f.liveEnabled(atA)).toBe("blocked");
    expect(await f.liveEnabled(atB)).toBe("enabled");
    expect(await code(f.insertBroadcast(atA, bcast()))).toBe("youtube_live_blocked");
    await expect(f.insertBroadcast(atB, bcast())).resolves.toBeDefined();
    f.setLive("enabled", { channelId: chA });
    await expect(f.insertBroadcast(atA, bcast())).resolves.toBeDefined();
    // autoVideo scoped to A.
    f.setAutoVideo(true, { channelId: chA });
    expect((await f.broadcastLife(atA, (await boundPair(f, atA)).broadcastId)).life).toBe("live");
    expect((await f.broadcastLife(atB, (await boundPair(f, atB)).broadcastId)).life, "B did not get autoVideo").toBe("ready");
  });

  it("a scoped failure is not taken by a call that carries no channel (authorizeUrl), and is still there for its own channel", async () => {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-a");
    f.failNext("authorizeUrl", "youtube_unavailable", "", { channelId: f.channelOf("1//rt-a") });
    expect(() => f.authorizeUrl({ state: "s", codeChallenge: CHALLENGE, redirectUri: REDIRECT })).not.toThrow();
    f.failNext("insertStream", "youtube_unavailable", "", { channelId: f.channelOf("1//rt-a") });
    expect(await code(f.insertStream(atA, { title: "k" }))).toBe("youtube_unavailable");
  });

  it("handles name channels: channelOfHandle is the token's channel, an unknown handle is not_found, and pinChannelsTo puts exactly ONE later grant (the state's) on that channel and account", async () => {
    const f = new FakeYouTube();
    const handle = f.tokenHandle("1//rt-a");
    expect(f.channelOfHandle(handle)).toBe(f.channelOf("1//rt-a"));
    expect(() => f.channelOfHandle("fake-th-nope")).toThrow(YouTubeError);
    const reconnect = await grant(f, { before: (state) => f.pinChannelsTo(handle, state) });
    expect(f.channelOf(reconnect.refreshToken), "a reconnect to the SAME channel").toBe(f.channelOf("1//rt-a"));
    expect((await f.listMyChannels(await f.accessToken(reconnect.refreshToken)))[0]!.id).toBe(f.channelOf("1//rt-a"));
    const next = await grant(f);
    expect(f.channelOf(next.refreshToken), "the pin was spent: the next grant is fresh").not.toBe(f.channelOf("1//rt-a"));
    expect(f.channelOf((await grant(f)).refreshToken), "and so is the one after").not.toBe(f.channelOf(next.refreshToken));
  });
});

// The disconnect's clean-up (fix: YouTube Disconnect left stream keys on the channel, 2026-10-30) reads the channel's own streams and
// deletes the Seazn-named ones, and must be told apart from a delete YouTube refuses. Google's refusal for a stream it will not let go
// of is 403 `liveStreamDeletionNotAllowed` (liveStreams.delete page), which the live driver maps to youtube_unavailable (google.test.ts
// pins the parity).
describe("listStreams and a refused stream delete (the disconnect's clean-up)", () => {
  it("listStreams: the caller's channel's streams - id, title and channel - and nothing of another channel's; a deleted one is gone; an empty channel is []", async () => {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-list-a");
    const atB = await f.accessToken("1//rt-list-b");
    const chA = f.channelOf("1//rt-list-a");
    expect(await f.listStreams(atA), "the empty case first").toEqual([]);
    const one = await f.insertStream(atA, { title: "Seazn stream key" });
    const two = await f.insertStream(atA, { title: "TestYouTube" });
    await f.insertStream(atB, { title: "B's own" });
    expect(await f.listStreams(atA)).toEqual([
      { id: one.streamId, title: "Seazn stream key", channelId: chA },
      { id: two.streamId, title: "TestYouTube", channelId: chA },
    ]);
    await f.deleteStream(atA, one.streamId);
    expect((await f.listStreams(atA)).map((s) => s.id), "a deleted stream is not listed").toEqual([two.streamId]);
    expect((await f.listStreams(atB)).map((s) => s.title), "B sees only B's").toEqual(["B's own"]);
    expect(JSON.stringify(await f.listStreams(atA)), "no key and no ingest URL in a listing").not.toMatch(/fakekey|rtmp:/);
    // a dead token cannot list, like every Data API call
    f.killToken("1//rt-list-a");
    expect(((await rejection(f.listStreams(atA))) as YouTubeError).code).toBe("youtube_reconnect_needed");
  });

  it("listStreams asks the caller's room before its one page, as the driver does before each: no room is the driver's budgetSpent refusal with no call made; room is the list", async () => {
    const f = new FakeYouTube();
    const at = await f.accessToken("1//rt-list-room");
    await f.insertStream(at, { title: "Seazn stream key" });
    const before = f.calls.length;
    const cut = (await rejection(f.listStreams(at, { room: () => false }))) as YouTubeError;
    expect([cut.code, cut.reason]).toEqual(["youtube_unavailable", "budgetSpent"]);
    expect(f.calls.length - before, "no call reached YouTube").toBe(0);
    let asks = 0;
    expect(await f.listStreams(at, { room: () => (++asks, true) })).toHaveLength(1);
    expect(asks, "asked once, before its one page").toBe(1);
  });

  it("refuseStreamDelete ONCE: the next delete of that stream is youtube_unavailable / liveStreamDeletionNotAllowed and leaves it; the one after deletes it; other streams are untouched", async () => {
    const { f, at } = await rig();
    const held = await f.insertStream(at, { title: "held" });
    const free = await f.insertStream(at, { title: "free" });
    f.refuseStreamDelete(held.streamId);
    const err = (await rejection(f.deleteStream(at, held.streamId))) as YouTubeError;
    expect([err.code, err.reason]).toEqual(["youtube_unavailable", "liveStreamDeletionNotAllowed"]);
    expect(f.inspectStream(held.streamId), "refused: still there").not.toBeNull();
    await f.deleteStream(at, free.streamId);
    expect(f.inspectStream(free.streamId), "another stream deletes as before").toBeNull();
    await expect(f.deleteStream(at, held.streamId), "the refusal was spent").resolves.toBeUndefined();
    expect(f.inspectStream(held.streamId)).toBeNull();
  });

  it("refuseStreamDelete ALWAYS refuses every delete of that stream (counted); `times` refuses exactly that many; another channel's token neither sees nor spends it", async () => {
    const f = new FakeYouTube();
    const at = await f.accessToken("1//rt-refuse");
    const other = await f.accessToken("1//rt-refuse-other");
    const always = await f.insertStream(at, { title: "always" });
    const twice = await f.insertStream(at, { title: "twice" });
    f.refuseStreamDelete(always.streamId, { times: "always" });
    f.refuseStreamDelete(twice.streamId, { times: 2 });
    let refused = 0;
    for (let i = 0; i < 4; i++) {
      expect(((await rejection(f.deleteStream(at, always.streamId))) as YouTubeError).reason, `always: try ${i + 1}`).toBe("liveStreamDeletionNotAllowed");
      refused++;
    }
    expect(refused).toBe(4);
    expect(f.inspectStream(always.streamId)).not.toBeNull();
    // another channel's token: the stream is absent to it - the delete resolves, removes nothing and spends nothing
    await expect(f.deleteStream(other, twice.streamId)).resolves.toBeUndefined();
    for (let i = 0; i < 2; i++) await expect(f.deleteStream(at, twice.streamId), `twice: refusal ${i + 1}`).rejects.toBeInstanceOf(YouTubeError);
    await expect(f.deleteStream(at, twice.streamId), "the third goes through").resolves.toBeUndefined();
    expect(f.inspectStream(twice.streamId)).toBeNull();
  });

  it("refuseStreamDelete on a stream the fake does not have is refused at once (a typo must not become a refusal that never fires); a bad count too; reset clears a pending refusal", async () => {
    const { f, at } = await rig();
    expect(() => f.refuseStreamDelete("fakestream-nope")).toThrow(YouTubeError);
    const s = await f.insertStream(at, { title: "k" });
    expect(() => f.refuseStreamDelete(s.streamId, { times: 0 })).toThrow();
    expect(() => f.refuseStreamDelete(s.streamId, { times: 1.5 })).toThrow();
    f.refuseStreamDelete(s.streamId, { times: "always" });
    f.reset();
    const at2 = await f.accessToken("1//rt-main");
    const s2 = await f.insertStream(at2, { title: "k" });
    await expect(f.deleteStream(at2, s2.streamId), "nothing refuses after a reset").resolves.toBeUndefined();
  });
});

describe("reset", () => {
  it("clears every kind of fake state; the constructor's channels come back; ids from before are never reused", async () => {
    const pinned = [{ id: "UCpinnedChannelAAAAAAA", title: "Pinned" }];
    const f = new FakeYouTube({ channels: pinned });
    const rt = "1//rt-reset";
    const at = await f.accessToken(rt);
    const { streamId, broadcastId } = await boundPair(f, at);
    f.videoOn(streamId);
    const handle = f.tokenHandle(rt);
    f.failNext("listMyChannels", "youtube_unavailable");
    f.setLive("blocked");
    f.setLive("not_enabled", { channelId: f.channelOf(rt) });
    f.setAutoVideo(true);
    f.setAutoVideo(true, { channelId: f.channelOf(rt) });
    // A connect in flight with a scope and channels bound to its state.
    f.authorizeUrl({ state: "state-bound", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.setGrantedScope("https://www.googleapis.com/auth/youtube.readonly", "state-bound");
    f.setChannels([{ id: "UCother", title: "Other" }], "state-bound");
    f.killToken(rt);
    const state = "state-for-reset";
    f.authorizeUrl({ state, codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const code = f.issueCode(state);
    expect(f.calls.length, "PREMISE: there is a call log to clear").toBeGreaterThan(0);

    f.reset();

    let checked = 0;
    const check = (what: string, ok: boolean) => { expect(ok, what).toBe(true); checked++; };
    check("streams cleared", f.streamsCount() === 0);
    check("broadcasts cleared", f.broadcastsCount() === 0 && f.liveBroadcastCount() === 0 && f.inspectBroadcast(broadcastId) === null);
    check("call log cleared", f.calls.length === 0);
    check("a handle from before is unknown", (() => { try { f.channelOfHandle(handle); return false; } catch (e) { return e instanceof YouTubeError; } })());
    check("the killed token is alive again", await f.accessToken(rt).then(() => true, () => false));
    check("the pending injection is gone", await f.listMyChannels(await f.accessToken(rt)).then((c) => c.length === 1, () => false));
    check("the constructor's channels are back", (await f.listMyChannels(await f.accessToken("1//rt-fresh")))[0]!.id === pinned[0]!.id);
    const at2 = await f.accessToken(rt);
    check("live switches are back to enabled (global and scoped)", (await f.liveEnabled(at2)) === "enabled");
    check("autoVideo is off (global and scoped)", ((await f.broadcastLife(at2, (await boundPair(f, at2)).broadcastId)).life) === "ready");
    check("a state from before is unknown, so what was bound to it is gone", (() => { try { f.issueCode("state-bound"); return false; } catch (e) { return e instanceof YouTubeError; } })());
    check("the same state string authorized again carries neither the scope nor the channels bound before", await (async () => {
      f.authorizeUrl({ state: "state-bound", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
      const g = await f.exchangeCode({ code: f.issueCode("state-bound"), codeVerifier: VERIFIER, redirectUri: REDIRECT });
      const seen = await f.listMyChannels(await f.accessToken(g.refreshToken));
      return g.scope === "https://www.googleapis.com/auth/youtube" && seen[0]?.id === pinned[0]!.id;
    })());
    check("a code from before the reset is spent", await f.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT }).then(() => false, (e: unknown) => e instanceof YouTubeError));
    check("a state from before the reset is unknown", (() => { try { f.issueCode(state); return false; } catch (e) { return e instanceof YouTubeError; } })());
    check("an id from before is not reissued", (await f.insertBroadcast(at2, bcast())).broadcastId !== broadcastId);
    expect(checked, "every kind of state was checked").toBe(14);
  });

  it("the id counter is not rewound: replaying the SAME calls after a reset gives different ids, so an old id never names something new", async () => {
    const f = new FakeYouTube();
    const scenario = async () => {
      const at = await f.accessToken("1//rt-replay");
      const { streamId } = await f.insertStream(at, { title: "k" });
      const { broadcastId } = await f.insertBroadcast(at, bcast());
      return { streamId, broadcastId, channelId: f.channelOf("1//rt-replay"), handle: f.tokenHandle("1//rt-replay") };
    };
    const before = await scenario();
    f.reset();
    const after = await scenario();
    for (const key of ["streamId", "broadcastId", "channelId", "handle"] as const) expect(after[key], key).not.toBe(before[key]);
    expect(f.inspectBroadcast(before.broadcastId), "and the old id is not the new broadcast").toBeNull();
  });

  it("a refresh token exchanged before the reset is unknown after it (invalid_grant); a 1// token is seeded afresh, on a NEW channel", async () => {
    const f = new FakeYouTube();
    const minted = await grant(f);
    const seeded = "1//rt-after-reset";
    const channelBefore = f.channelOf(seeded);
    await expect(f.accessToken(minted.refreshToken), "PREMISE: alive before").resolves.toBeDefined();
    f.reset();
    const err = await rejection(f.accessToken(minted.refreshToken));
    expect([(err as YouTubeError).code, (err as YouTubeError).reason]).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
    await expect(f.accessToken(seeded)).resolves.toBeDefined();
    expect(f.channelOf(seeded), "the grant is new, and so is its channel").not.toBe(channelBefore);
  });
});

describe("OAuth exchange realism (PKCE, redirect, single use, granted scope)", () => {
  it("PREMISE: the test's S256 is the RFC 7636 appendix B vector, computed here and not by the fake", () => {
    expect(VERIFIER).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(CHALLENGE).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("happy path: authorize -> issueCode -> exchange gives a refresh token with exactly the youtube scope, and it works", async () => {
    const f = new FakeYouTube();
    const g = await grant(f);
    expect(g.scope).toBe("https://www.googleapis.com/auth/youtube");
    expect(typeof g.googleSub).toBe("string");
    await expect(f.accessToken(g.refreshToken)).resolves.toEqual(expect.any(String));
    expect((await grant(f)).refreshToken, "two grants are two tokens").not.toBe(g.refreshToken);
  });

  it("refusals follow the live driver: a wrong or empty verifier, an unknown, empty or replayed code are invalid_grant (reconnect_needed); ANOTHER redirect URI is redirect_uri_mismatch (unavailable)", async () => {
    const f = new FakeYouTube();
    const issue = () => {
      const state = `s-${++stateSeq}`;
      f.authorizeUrl({ state, codeChallenge: CHALLENGE, redirectUri: REDIRECT });
      return f.issueCode(state);
    };
    const used = issue();
    await f.exchangeCode({ code: used, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    const grantRefused = ["youtube_reconnect_needed", "invalidGrant"];
    // Google's token endpoint: invalid_grant for the code and the verifier; redirect_uri_mismatch is Seazn's own configuration
    // (google.ts maps it to youtube_unavailable: reconnecting cannot help), so the fake says the same.
    const mismatch = ["youtube_unavailable", "redirectUriMismatch"];
    const rows: [string, { code: string; codeVerifier: string; redirectUri: string }, string[]][] = [
      ["a verifier whose S256 is not the challenge", { code: issue(), codeVerifier: `${VERIFIER}x`, redirectUri: REDIRECT }, grantRefused],
      ["another verifier of the right length", { code: issue(), codeVerifier: "a".repeat(43), redirectUri: REDIRECT }, grantRefused],
      ["a different redirect URI", { code: issue(), codeVerifier: VERIFIER, redirectUri: "https://evil.example.test/callback" }, mismatch],
      ["the same origin, another path", { code: issue(), codeVerifier: VERIFIER, redirectUri: `${REDIRECT}/` }, mismatch],
      ["a code the fake never issued", { code: "fake-code-999999", codeVerifier: VERIFIER, redirectUri: REDIRECT }, grantRefused],
      ["an empty code", { code: "", codeVerifier: VERIFIER, redirectUri: REDIRECT }, grantRefused],
      ["an empty verifier", { code: issue(), codeVerifier: "", redirectUri: REDIRECT }, grantRefused],
      ["a replayed code", { code: used, codeVerifier: VERIFIER, redirectUri: REDIRECT }, grantRefused],
      ["a replayed code from another redirect URI (the code is checked first)", { code: used, codeVerifier: VERIFIER, redirectUri: "https://evil.example.test/callback" }, grantRefused],
    ];
    let checked = 0;
    for (const [name, args, want] of rows) {
      const err = await rejection(f.exchangeCode(args));
      expect(err, name).toBeInstanceOf(YouTubeError);
      expect([(err as YouTubeError).code, (err as YouTubeError).reason], name).toEqual(want);
      checked++;
    }
    expect(checked, "all refusals exercised").toBe(9);
  });

  it("an EMPTY verifier is refused even when the recorded challenge is the S256 of the empty string (no real verifier is empty)", async () => {
    const f = new FakeYouTube();
    const emptyChallenge = createHash("sha256").update("").digest("base64url");
    f.authorizeUrl({ state: "s-empty", codeChallenge: emptyChallenge, redirectUri: REDIRECT });
    const code = f.issueCode("s-empty");
    const err = await rejection(f.exchangeCode({ code, codeVerifier: "", redirectUri: REDIRECT }));
    expect([(err as YouTubeError).code, (err as YouTubeError).reason]).toEqual(["youtube_reconnect_needed", "invalidGrant"]);
  });

  it("a refused attempt does not spend the code: the right verifier and redirect afterwards still succeed — once", async () => {
    const f = new FakeYouTube();
    const state = "s-retry";
    f.authorizeUrl({ state, codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const code = f.issueCode(state);
    await rejection(f.exchangeCode({ code, codeVerifier: "wrong", redirectUri: REDIRECT }));
    await expect(f.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT })).resolves.toBeDefined();
    await rejection(f.exchangeCode({ code, codeVerifier: VERIFIER, redirectUri: REDIRECT }));
  });

  it("a code is bound to ITS state's challenge and redirect URI, not to the latest authorize or to another state's", async () => {
    const f = new FakeYouTube();
    const other = "https://other.example.test/api/youtube/connect/callback";
    const otherVerifier = "N".repeat(43);
    const otherChallenge = createHash("sha256").update(otherVerifier).digest("base64url");
    f.authorizeUrl({ state: "s-one", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.authorizeUrl({ state: "s-two", codeChallenge: otherChallenge, redirectUri: other });
    const codeOne = f.issueCode("s-one");
    const codeTwo = f.issueCode("s-two");
    await rejection(f.exchangeCode({ code: codeOne, codeVerifier: otherVerifier, redirectUri: other }));
    await rejection(f.exchangeCode({ code: codeTwo, codeVerifier: VERIFIER, redirectUri: REDIRECT }));
    await expect(f.exchangeCode({ code: codeOne, codeVerifier: VERIFIER, redirectUri: REDIRECT })).resolves.toBeDefined();
    await expect(f.exchangeCode({ code: codeTwo, codeVerifier: otherVerifier, redirectUri: other })).resolves.toBeDefined();
  });

  it("issueCode: an unknown state is youtube_not_found; the same state may be issued again (a second visit gets a second code)", async () => {
    const f = new FakeYouTube();
    expect(() => f.issueCode("never-authorized")).toThrow(YouTubeError);
    f.authorizeUrl({ state: "s-twice", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const first = f.issueCode("s-twice");
    const second = f.issueCode("s-twice");
    expect(second).not.toBe(first);
    await expect(f.exchangeCode({ code: second, codeVerifier: VERIFIER, redirectUri: REDIRECT })).resolves.toBeDefined();
    await expect(f.exchangeCode({ code: first, codeVerifier: VERIFIER, redirectUri: REDIRECT })).resolves.toBeDefined();
  });

  it("the granted scope is bound to ONE state: its first code carries it, issueCode's own scope beats it, null clears it, and no other state is touched", async () => {
    const f = new FakeYouTube();
    const readonly = "https://www.googleapis.com/auth/youtube.readonly";
    const youtube = "https://www.googleapis.com/auth/youtube";
    expect((await grant(f, { before: (state) => f.setGrantedScope(readonly, state) })).scope, "the state's control").toBe(readonly);
    expect((await grant(f)).scope, "the next connect is back to the youtube scope: the control was spent").toBe(youtube);
    expect((await grant(f, { scope: "openid", before: (state) => f.setGrantedScope(readonly, state) })).scope, "the per-code override beats it").toBe("openid");
    expect((await grant(f, { before: (state) => { f.setGrantedScope(readonly, state); f.setGrantedScope(null, state); } })).scope, "null clears it").toBe(youtube);
    // A code issued BEFORE the control keeps the scope it was issued with, and another state is never touched.
    f.authorizeUrl({ state: "s-early", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.authorizeUrl({ state: "s-other", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const early = f.issueCode("s-early");
    f.setGrantedScope(readonly, "s-early");
    expect((await f.exchangeCode({ code: early, codeVerifier: VERIFIER, redirectUri: REDIRECT })).scope).toBe(youtube);
    expect((await f.exchangeCode({ code: f.issueCode("s-other"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).scope, "another state is untouched").toBe(youtube);
    expect((await f.exchangeCode({ code: f.issueCode("s-early"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).scope, "its next code carries it").toBe(readonly);
    expect((await f.exchangeCode({ code: f.issueCode("s-early"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).scope, "and only that one: it was spent").toBe(youtube);
    expect(() => f.setGrantedScope(readonly, "never-authorized"), "an unknown state").toThrow(YouTubeError);
  });

  it("the Google subject is DISTINCT per grant by default; null and a string are state-bound overrides, each spent by one grant", async () => {
    const f = new FakeYouTube();
    const [a, b] = [await grant(f), await grant(f)];
    expect(a.googleSub, "PREMISE: an unset grant reports a subject").toEqual(expect.any(String));
    expect(b.googleSub).toEqual(expect.any(String));
    expect(a.googleSub, "two connections are two Google accounts").not.toBe(b.googleSub);
    expect((await grant(f, { before: (state) => f.setGoogleSub(null, state) })).googleSub, "null: no subject (T18's no-sub branch)").toBeNull();
    const after = (await grant(f)).googleSub;
    expect(after, "the next connect derives a subject again: the control was spent").toEqual(expect.any(String));
    expect([a.googleSub, b.googleSub], "and it is a new account").not.toContain(after);
    // The SAME account on two connections (an admin of two clubs): both report it, and neither is a derived one.
    const x = await grant(f, { before: (state) => f.setGoogleSub("acct-777", state) });
    const y = await grant(f, { before: (state) => f.setGoogleSub("acct-777", state) });
    expect([x.googleSub, y.googleSub]).toEqual(["acct-777", "acct-777"]);
    expect(x.refreshToken, "two grants, one account").not.toBe(y.refreshToken);
    const third = (await grant(f)).googleSub;
    expect(third, "a third, unset, is not that account").toEqual(expect.any(String));
    expect(third).not.toBe("acct-777");
    // A code issued BEFORE the control keeps the subject it was issued with; another state is never touched.
    f.authorizeUrl({ state: "s-early", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.authorizeUrl({ state: "s-other", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const early = f.issueCode("s-early");
    f.setGoogleSub(null, "s-early");
    expect((await f.exchangeCode({ code: early, codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub, "issued before: keeps a derived subject").toEqual(expect.any(String));
    expect((await f.exchangeCode({ code: f.issueCode("s-other"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub, "another state is untouched").toEqual(expect.any(String));
    expect((await f.exchangeCode({ code: f.issueCode("s-early"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub, "its next code carries it").toBeNull();
    expect((await f.exchangeCode({ code: f.issueCode("s-early"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub, "and only that one: it was spent").toEqual(expect.any(String));
    expect(() => f.setGoogleSub(null, "never-authorized"), "an unknown state").toThrow(YouTubeError);
  });

  it("a reconnect pinned to a handle's channel is the SAME account: it carries that grant's subject (derived, a string, or null); setGoogleSub on the state overrides it, in either order", async () => {
    const f = new FakeYouTube();
    const reconnect = (handle: string, also?: (state: string) => void) => grant(f, { before: (state) => { f.pinChannelsTo(handle, state); also?.(state); } });
    const first = await grant(f);
    const h1 = f.tokenHandle(first.refreshToken);
    expect((await reconnect(h1)).googleSub, "derived: the same one").toBe(first.googleSub);
    expect((await grant(f)).googleSub, "while an unpinned connect is another account").not.toBe(first.googleSub);
    const named = await grant(f, { before: (state) => f.setGoogleSub("acct-9", state) });
    expect((await reconnect(f.tokenHandle(named.refreshToken))).googleSub, "an overridden subject is carried").toBe("acct-9");
    const none = await grant(f, { before: (state) => f.setGoogleSub(null, state) });
    expect((await reconnect(f.tokenHandle(none.refreshToken))).googleSub, "so is 'no subject'").toBeNull();
    // the override beats the pin, called before or after it
    expect((await reconnect(h1, (state) => f.setGoogleSub("override-after", state))).googleSub).toBe("override-after");
    expect((await reconnect(h1, (state) => f.setGoogleSub(null, state))).googleSub, "null overrides too").toBeNull();
    const early = await grant(f, { before: (state) => { f.setGoogleSub("override-before", state); f.pinChannelsTo(h1, state); } });
    expect(early.googleSub, "set BEFORE the pin: still wins").toBe("override-before");
    expect(f.channelOf(early.refreshToken), "and the pin's channel still applies").toBe(f.channelOf(first.refreshToken));
  });

  it("a reset drops a subject bound to a state (the state is unknown afterwards, and the same string authorized again derives its own)", async () => {
    const f = new FakeYouTube();
    f.authorizeUrl({ state: "st-reset-sub", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    f.setGoogleSub(null, "st-reset-sub");
    f.reset();
    expect(() => f.issueCode("st-reset-sub")).toThrow(YouTubeError);
    f.authorizeUrl({ state: "st-reset-sub", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect((await f.exchangeCode({ code: f.issueCode("st-reset-sub"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).googleSub).toEqual(expect.any(String));
  });
});

describe("broadcast titles", () => {
  it("insertBroadcast refuses an empty or blank title, one over 100 characters, and one containing < or >; the boundary and the twins are accepted", async () => {
    const { f, at } = await rig();
    const refused: [string, string][] = [
      ["empty", ""], ["blank", "   "], ["101 characters", "a".repeat(101)], ["< in it", "Home <b> Away"], ["> in it", "Home > Away"],
      ["101 code points of emoji", "\u{1F3F8}".repeat(101)],
    ];
    const accepted: [string, string][] = [
      ["exactly 100 characters", "a".repeat(100)], ["100 code points of emoji (200 UTF-16 units)", "\u{1F3F8}".repeat(100)],
      ["one character", "x"], ["a normal match title", "Home v Away \u00B7 Open \u00B7 Spring Cup"],
    ];
    let checked = 0;
    for (const [name, title] of refused) {
      const before = f.broadcastsCount();
      const err = await rejection(f.insertBroadcast(at, bcast(title)));
      expect(err, name).toBeInstanceOf(YouTubeError);
      expect([(err as YouTubeError).code, (err as YouTubeError).reason], name).toEqual(["youtube_unavailable", "invalidTitle"]);
      expect(f.broadcastsCount(), `${name}: nothing created`).toBe(before);
      checked++;
    }
    for (const [name, title] of accepted) {
      await expect(f.insertBroadcast(at, bcast(title)), name).resolves.toBeDefined();
      checked++;
    }
    expect(checked).toBe(refused.length + accepted.length);
  });
});

describe("insertBroadcast refusal order follows the live driver: the title before eligibility", () => {
  it("a bad title is invalidTitle on a channel-less account, a not-enabled channel and a blocked channel; a good title there is told the eligibility reason", async () => {
    const situations: [string, () => Promise<{ f: FakeYouTube; at: string }>, string][] = [
      ["no channel", () => rig({ channels: [] }), "youtubeSignupRequired"],
      ["live not enabled", async () => { const r = await rig(); r.f.setLive("not_enabled"); return r; }, "liveStreamingNotEnabled"],
      ["live blocked", async () => { const r = await rig(); r.f.setLive("blocked"); return r; }, "livePermissionBlocked"],
    ];
    let checked = 0;
    for (const [name, build, reason] of situations) {
      const { f, at } = await build();
      const bad = (await rejection(f.insertBroadcast(at, bcast("<b>")))) as YouTubeError;
      expect([name, bad.code, bad.reason]).toEqual([name, "youtube_unavailable", "invalidTitle"]);
      const good = (await rejection(f.insertBroadcast(at, bcast("Fine title")))) as YouTubeError;
      expect([name, good.reason], "the positive pair").toEqual([name, reason]);
      expect(f.broadcastsCount(), `${name}: nothing created`).toBe(0);
      checked++;
    }
    expect(checked).toBe(situations.length);
  });
});

describe("id-free counts and a revoked broadcast (for T10 / T14)", () => {
  it("broadcastsCount / nonLiveBroadcastCount / liveBroadcastCount / streamsCount count what exists, per channel or in all", async () => {
    const f = new FakeYouTube();
    const atA = await f.accessToken("1//rt-a");
    const atB = await f.accessToken("1//rt-b");
    const [chA, chB] = [f.channelOf("1//rt-a"), f.channelOf("1//rt-b")];
    expect([f.broadcastsCount(), f.nonLiveBroadcastCount(), f.liveBroadcastCount(), f.streamsCount()], "the empty case").toEqual([0, 0, 0, 0]);
    const liveA = await boundPair(f, atA);
    f.videoOn(liveA.streamId);
    await boundPair(f, atA);   // ready
    await f.insertBroadcast(atB, bcast());   // created
    expect([f.broadcastsCount(chA), f.nonLiveBroadcastCount(chA), f.liveBroadcastCount(chA), f.streamsCount(chA)]).toEqual([2, 1, 1, 2]);
    expect([f.broadcastsCount(chB), f.nonLiveBroadcastCount(chB), f.liveBroadcastCount(chB), f.streamsCount(chB)]).toEqual([1, 1, 0, 0]);
    expect([f.broadcastsCount(), f.nonLiveBroadcastCount(), f.liveBroadcastCount(), f.streamsCount()], "in all").toEqual([3, 2, 1, 2]);
    await f.complete(atA, liveA.broadcastId);
    expect(f.nonLiveBroadcastCount(chA), "a completed broadcast is non-live").toBe(2);
    expect(f.liveBroadcastCount(chA)).toBe(0);
  });

  it("an orphan check without ids: after a refused insertBroadcast (invalid title) the channel holds no broadcast", async () => {
    const { f, at } = await rig();
    await f.insertStream(at, { title: "key" });
    await rejection(f.insertBroadcast(at, bcast("")));
    expect(f.nonLiveBroadcastCount(f.channelOf("1//rt-main"))).toBe(0);
  });

  it("killToken is the way a token becomes revoked: every later call with it or its access tokens is youtube_reconnect_needed (T14's dead grant)", async () => {
    const { f, at, rt } = await rig();
    const { broadcastId } = await boundPair(f, at);
    f.killToken(rt);
    for (const call of [() => f.accessToken(rt), () => f.complete(at, broadcastId), () => f.broadcastLife(at, broadcastId), () => f.deleteBroadcast(at, broadcastId)]) {
      expect(((await rejection(async () => call())) as YouTubeError).code).toBe("youtube_reconnect_needed");
    }
  });

  it("revokeBroadcast: life revoked, no longer open on its key or live on its channel; unknown id is not_found", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    f.videoOn(streamId);
    expect(f.liveBroadcastCount()).toBe(1);
    f.revokeBroadcast(broadcastId);
    expect((await f.broadcastLife(at, broadcastId)).life).toBe("revoked");
    expect(f.liveBroadcastCount(), "frees the live slot").toBe(0);
    expect(f.boundOpenCount(streamId), "frees the key slot").toBe(0);
    expect(((await rejection(f.complete(at, broadcastId))) as YouTubeError).reason, "a revoked broadcast cannot be completed").toBe("invalidTransition");
    expect(() => f.revokeBroadcast("nope")).toThrow(YouTubeError);
  });
});

describe("access tokens expire after 3600 s of the injected clock", () => {
  it("an access token works for 3599 s and is refused at 3600 s; a refresh gives a new one; the expiry runs from the MINT, not first use", async () => {
    let t = START.getTime();
    const f = new FakeYouTube({ now: () => new Date(t) });
    const first = await f.accessToken("1//rt-exp");
    t += 3_599_000;
    await expect(f.listMyChannels(first), "3599 s after the mint").resolves.toHaveLength(1);
    const second = await f.accessToken("1//rt-exp");   // minted at +3599 s
    t += 1_000;   // +3600 s since `first`, 1 s since `second`
    const err = await rejection(f.listMyChannels(first));
    expect(err, "3600 s after the mint").toBeInstanceOf(YouTubeError);
    expect([(err as YouTubeError).code, (err as YouTubeError).reason]).toEqual(["youtube_reconnect_needed", "authError"]);
    await expect(f.listMyChannels(second), "the fresh token is good").resolves.toHaveLength(1);
    t += 3_600_000;
    expect(((await rejection(f.listMyChannels(second))) as YouTubeError).code, "and expires in its turn").toBe("youtube_reconnect_needed");
    const third = await f.accessToken("1//rt-exp");
    await expect(f.listMyChannels(third), "a refresh after expiry works: the grant itself is alive").resolves.toHaveLength(1);
  });

  it("every method that takes an access token refuses an expired one", async () => {
    let t = START.getTime();
    const f = new FakeYouTube({ now: () => new Date(t) });
    const at = await f.accessToken("1//rt-exp2");
    const { streamId } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    t += 3_600_000;
    const withAt: Record<string, () => Promise<unknown>> = {
      listMyChannels: () => f.listMyChannels(at), liveEnabled: () => f.liveEnabled(at), insertStream: () => f.insertStream(at, { title: "k" }),
      deleteStream: () => f.deleteStream(at, streamId), insertBroadcast: () => f.insertBroadcast(at, bcast()),
      bind: () => f.bind(at, broadcastId, streamId), broadcastLife: () => f.broadcastLife(at, broadcastId), complete: () => f.complete(at, broadcastId),
      deleteBroadcast: () => f.deleteBroadcast(at, broadcastId), existingVideos: () => f.existingVideos(at, [broadcastId]),
    };
    let checked = 0;
    for (const [name, call] of Object.entries(withAt)) {
      expect(((await rejection(call)) as YouTubeError).code, name).toBe("youtube_reconnect_needed");
      checked++;
    }
    expect(checked, "the ten at-taking methods").toBe(10);
  });
});

// T17 prep (health and refresh sweeps): the sweep's spec writes a SEALED refresh token into its own database, so the fake must
// be told which channel and which Google account that token is — and then rename the channel, or take it away, on demand.
describe("seedGrant, renameChannel and removeChannel", () => {
  const listed = async (f: FakeYouTube, rt: string) => f.listMyChannels(await f.accessToken(rt));

  it("seedGrant makes the grant behind a token the test minted: its channel and title are what listMyChannels says, and the token works", async () => {
    const f = new FakeYouTube();
    f.seedGrant({ refreshToken: "1//seeded-one", channelId: "UCseededChannelAAAAAAAAA", channelTitle: "Seeded Club" });
    expect(await listed(f, "1//seeded-one")).toEqual([{ id: "UCseededChannelAAAAAAAAA", title: "Seeded Club" }]);
    expect(f.channelOf("1//seeded-one")).toBe("UCseededChannelAAAAAAAAA");
    const at = await f.accessToken("1//seeded-one");
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    expect(f.inspectBroadcast(broadcastId)?.channelId, "what it makes belongs to the seeded channel").toBe("UCseededChannelAAAAAAAAA");
    // twin: an unseeded 1// token still gets a channel of its own, not the seeded one
    expect((await listed(f, "1//never-seeded"))[0]!.id).not.toBe("UCseededChannelAAAAAAAAA");
  });

  it("seedGrant refuses a shape Google never issues, a missing channel, and a token that already has a grant — and a refused seed changes nothing", async () => {
    const f = new FakeYouTube();
    const good = { refreshToken: "1//ok-seed", channelId: "UCokChannelAAAAAAAAAAAAA", channelTitle: "OK" };
    const refused: [string, Parameters<FakeYouTube["seedGrant"]>[0]][] = [
      ["no 1// prefix", { ...good, refreshToken: "rt-plain" }],
      ["only the prefix", { ...good, refreshToken: "1//" }],
      ["empty token", { ...good, refreshToken: "" }],
      ["empty channel id", { ...good, channelId: "" }],
      ["empty title", { ...good, channelTitle: "" }],
    ];
    let checked = 0;
    for (const [name, args] of refused) {
      expect(() => f.seedGrant(args), name).toThrow();
      checked++;
    }
    expect(checked, "five refusals").toBe(5);
    expect(f.calls, "refused seeds are not port calls").toHaveLength(0);
    await expect(listed(f, "1//plain-after"), "and nothing was created by them").resolves.toHaveLength(1);

    f.seedGrant(good);
    expect(() => f.seedGrant({ ...good, channelId: "UCotherChannelAAAAAAAAAA" }), "a second seed of the same token").toThrow(/already has a grant/);
    expect((await listed(f, "1//ok-seed"))[0]!.id, "the first grant stands").toBe("UCokChannelAAAAAAAAAAAAA");
    // a token the fake already saw (lazily seeded by a use) is also a token with a grant
    await listed(f, "1//used-first");
    expect(() => f.seedGrant({ ...good, refreshToken: "1//used-first" })).toThrow(/already has a grant/);
  });

  it("seedGrant's account: omitted sub is distinct per seed, a shared sub is ONE account (revoke kills both), null has none (nothing matches it)", async () => {
    const f = new FakeYouTube();
    const seed = (rt: string, channelId: string, sub?: string | null) =>
      f.seedGrant({ refreshToken: rt, channelId, channelTitle: "C", ...(sub === undefined ? {} : { sub }) });
    const dead = isDead(f);
    seed("1//d1", "UCderivedAAAAAAAAAAAAAAA"); seed("1//d2", "UCderivedBBBBBBBBBBBBBBB");
    seed("1//s1", "UCsharedAAAAAAAAAAAAAAAA", "acct-shared"); seed("1//s2", "UCsharedBBBBBBBBBBBBBBBB", "acct-shared");
    seed("1//n1", "UCnoneAAAAAAAAAAAAAAAAAA", null); seed("1//n2", "UCnoneBBBBBBBBBBBBBBBBBB", null);
    await f.revoke("1//d1");
    expect([await dead("1//d1"), await dead("1//d2")], "two derived subjects are two accounts").toEqual([true, false]);
    await f.revoke("1//s1");
    expect([await dead("1//s1"), await dead("1//s2")], "one named subject is one account").toEqual([true, true]);
    await f.revoke("1//n1");
    expect([await dead("1//n1"), await dead("1//n2")], "null is no account").toEqual([true, false]);
  });

  it("two seeds may name ONE channel (a reconnect): they share it, and a rename reaches both", async () => {
    const f = new FakeYouTube();
    f.seedGrant({ refreshToken: "1//rc-old", channelId: "UCreconnectedAAAAAAAAAA", channelTitle: "Before" });
    f.seedGrant({ refreshToken: "1//rc-new", channelId: "UCreconnectedAAAAAAAAAA", channelTitle: "Before" });
    f.renameChannel("UCreconnectedAAAAAAAAAA", "After");
    expect([(await listed(f, "1//rc-old"))[0]!.title, (await listed(f, "1//rc-new"))[0]!.title]).toEqual(["After", "After"]);
    f.renameChannel("UCreconnectedAAAAAAAAAA", "After again");
    expect((await listed(f, "1//rc-new"))[0], "the id never moves; the latest rename wins").toEqual({ id: "UCreconnectedAAAAAAAAAA", title: "After again" });
  });

  it("renameChannel moves only the channel it names, also for a grant that came through OAuth, and refuses an id nobody lists", async () => {
    const f = new FakeYouTube();
    f.seedGrant({ refreshToken: "1//r1", channelId: "UCrenameOneAAAAAAAAAAAA", channelTitle: "One" });
    f.seedGrant({ refreshToken: "1//r2", channelId: "UCrenameTwoAAAAAAAAAAAA", channelTitle: "Two" });
    const oauth = await grant(f, { before: (state) => f.setChannels([{ id: "UCoauthChannelAAAAAAAAAA", title: "Via OAuth" }], state) });
    f.renameChannel("UCoauthChannelAAAAAAAAAA", "Renamed OAuth");
    expect((await listed(f, oauth.refreshToken))[0]!.title).toBe("Renamed OAuth");
    expect((await listed(f, "1//r1"))[0]!.title, "another channel untouched").toBe("One");
    expect((await listed(f, "1//r2"))[0]!.title).toBe("Two");
    for (const id of ["UCnobodyListsThisAAAAAAA", ""]) {
      const err = await rejection(async () => f.renameChannel(id, "X"));
      expect(err, id).toBeInstanceOf(YouTubeError);
      expect([(err as YouTubeError).code, (err as YouTubeError).reason]).toEqual(["youtube_not_found", "unknownChannel"]);
    }
  });

  it("removeChannel takes the channel out of every grant that listed it: a one-channel grant becomes the no-channel account, the rest are untouched, a second remove is refused", async () => {
    const f = new FakeYouTube();
    f.seedGrant({ refreshToken: "1//x1", channelId: "UCgoneAAAAAAAAAAAAAAAAA", channelTitle: "Gone" });
    f.seedGrant({ refreshToken: "1//x2", channelId: "UCgoneAAAAAAAAAAAAAAAAA", channelTitle: "Gone" });
    f.seedGrant({ refreshToken: "1//x3", channelId: "UCstaysAAAAAAAAAAAAAAAA", channelTitle: "Stays" });
    const at = await f.accessToken("1//x1");
    const { broadcastId } = await f.insertBroadcast(at, bcast());   // PREMISE: it could create before the removal
    f.removeChannel("UCgoneAAAAAAAAAAAAAAAAA");
    expect(await listed(f, "1//x1")).toEqual([]);
    expect(await listed(f, "1//x2"), "every grant that listed it").toEqual([]);
    expect(await listed(f, "1//x3")).toEqual([{ id: "UCstaysAAAAAAAAAAAAAAAA", title: "Stays" }]);
    const err = await rejection(f.insertStream(await f.accessToken("1//x1"), { title: "k" }));
    expect([(err as YouTubeError).code, (err as YouTubeError).reason], "the account is the no-channel one now").toEqual(["youtube_unavailable", "youtubeSignupRequired"]);
    expect(f.inspectBroadcast(broadcastId), "what it already made is untouched").not.toBeNull();
    const again = await rejection(async () => f.removeChannel("UCgoneAAAAAAAAAAAAAAAAA"));
    expect((again as YouTubeError).reason, "removing it twice is a typo, not a no-op").toBe("unknownChannel");
  });
});

describe("redirectUriOf: where the fake authorize hop sends the browser back (T7)", () => {
  it("answers the redirect URI the state's authorizeUrl RECORDED, per state, and a second authorize of a state starts it over", () => {
    const f = new FakeYouTube();
    const a = "https://a.example.test/api/youtube/connect/callback";
    const b = "https://b.example.test/api/youtube/connect/callback";
    f.authorizeUrl({ state: "ru-1", codeChallenge: CHALLENGE, redirectUri: a });
    f.authorizeUrl({ state: "ru-2", codeChallenge: CHALLENGE, redirectUri: b });
    // Two states, two answers: one global "last redirect URI" would give both the same.
    expect(f.redirectUriOf("ru-1")).toBe(a);
    expect(f.redirectUriOf("ru-2")).toBe(b);
    f.authorizeUrl({ state: "ru-1", codeChallenge: CHALLENGE, redirectUri: b });
    expect(f.redirectUriOf("ru-1"), "authorizing a state again starts it over").toBe(b);
  });

  it("an unknown state is youtube_not_found/unknownState, and so is every state after reset (what was recorded is gone)", () => {
    const f = new FakeYouTube();
    const refusal = (state: string) => {
      try {
        f.redirectUriOf(state);
      } catch (e) {
        return e as YouTubeError;
      }
      throw new Error("expected redirectUriOf to throw");
    };
    expect([refusal("never-authorized").code, refusal("never-authorized").reason]).toEqual(["youtube_not_found", "unknownState"]);
    f.authorizeUrl({ state: "ru-3", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    expect(f.redirectUriOf("ru-3")).toBe(REDIRECT);   // PREMISE: it was known until the reset
    f.reset();
    expect(refusal("ru-3").code).toBe("youtube_not_found");
  });

  it("is a read: it logs no port call and spends nothing (the state still mints its code afterwards)", async () => {
    const f = new FakeYouTube();
    f.authorizeUrl({ state: "ru-4", codeChallenge: CHALLENGE, redirectUri: REDIRECT });
    const before = f.calls.length;
    f.redirectUriOf("ru-4");
    f.redirectUriOf("ru-4");
    expect(f.calls.length).toBe(before);
    await expect(f.exchangeCode({ code: f.issueCode("ru-4"), codeVerifier: VERIFIER, redirectUri: REDIRECT })).resolves.toEqual(expect.objectContaining({ scope: "https://www.googleapis.com/auth/youtube" }));
  });
});
