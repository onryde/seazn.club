// YouTube Connect T5: FakeYouTube is the in-memory channel every later batch codes against (the Google driver is T6, the
// connect routes T7, go-live T11, the end tick T14, and e2e drives it through the control route). Its worth is its REALISM,
// so every number below is typed here from Google's own documentation — never imported from fake.ts:
//   * "10 active streams allowed per channel and 3 active streams per stream key"  (support.google.com/youtube/answer/2474026)
//   * enableAutoStart = true starts a bound broadcast when video arrives; enableAutoStop = false never stops it (spec §3.1)
//   * videos.list takes at most 50 ids per call
// The fake's only job a test cannot check by reading it is to REFUSE like Google does, so each limit has an accepted twin
// (the 10th is fine, the 11th is not) and a case where the right answer differs from a wrong constant's (a per-channel
// cap is not a global one; a freed slot is reusable).
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { LOGGER_OPTIONS } from "@/server/logger";
import { FakeYouTube } from "../fake";
import { YouTubeError, type YouTubePort } from "../port";

const START = new Date("2026-10-27T12:00:00Z");
const REDIRECT = "https://app.example.test/api/youtube/connect/callback";

/** A signed-in fake: one access token for refresh token `rt`. */
async function rig(over: ConstructorParameters<typeof FakeYouTube>[0] = {}, rt = "rt-main") {
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
    expect(await f.broadcastLife(at, broadcastId), "PREMISE: bound, no video yet").toBe("ready");
    f.videoOn(streamId);
    expect(await f.broadcastLife(at, broadcastId)).toBe("live");
    f.videoOff(streamId);
    expect(await f.broadcastLife(at, broadcastId), "enableAutoStop=false: no video does not end it").toBe("live");
    f.videoOn(streamId);
    expect(await f.broadcastLife(at, broadcastId)).toBe("live");
    expect(f.liveBroadcastCount(), "video coming back is not a second live broadcast").toBe(1);
    await f.complete(at, broadcastId);
    expect(await f.broadcastLife(at, broadcastId), "only complete() ends it").toBe("complete");
  });

  it("video with nothing bound starts nothing, and a broadcast that never saw video never starts", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    f.videoOn(streamId);
    expect(await f.broadcastLife(at, broadcastId), "created and unbound: video on a key starts nothing").toBe("created");
    f.videoOff(streamId);
    await f.bind(at, broadcastId, streamId);
    expect(await f.broadcastLife(at, broadcastId), "bound with the video already off").toBe("ready");
    expect(f.liveBroadcastCount()).toBe(0);
  });

  it("binding to a key that already carries video starts the broadcast at once", async () => {
    const { f, at } = await rig();
    const { streamId } = await f.insertStream(at, { title: "key" });
    f.videoOn(streamId);
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    await f.bind(at, broadcastId, streamId);
    expect(await f.broadcastLife(at, broadcastId)).toBe("live");
  });

  it("autoVideo: every bind leaves the broadcast live, as if video had arrived (e2e has no ingest to watch)", async () => {
    const { f, at } = await rig();
    f.setAutoVideo(true);
    const { broadcastId } = await boundPair(f, at);
    expect(await f.broadcastLife(at, broadcastId)).toBe("live");
    f.setAutoVideo(false);
    const second = await boundPair(f, at);
    expect(await f.broadcastLife(at, second.broadcastId), "autoVideo off again: ready until video arrives").toBe("ready");
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
    expect(await f.broadcastLife(at, pairs[10]!.broadcastId)).toBe("ready");
    // The twin that makes the 10 a LIMIT and not a count of everything: a slot freed by complete() is reusable.
    await f.complete(at, pairs[0]!.broadcastId);
    f.videoOn(pairs[10]!.streamId);
    expect(await f.broadcastLife(at, pairs[10]!.broadcastId)).toBe("live");
    expect(f.liveBroadcastCount(), "10 live again, not 11").toBe(10);
  });

  it("the 10 is per CHANNEL: ten live on A do not stop a first one live on B", async () => {
    const f = new FakeYouTube({ channels: [{ id: "UCchannelAAAAAAAAAAAAAA", title: "A" }] });
    const atA = await f.accessToken("rt-a");
    f.setChannels([{ id: "UCchannelBBBBBBBBBBBBBB", title: "B" }]);
    const atB = await f.accessToken("rt-b");
    for (let i = 0; i < 10; i++) f.videoOn((await boundPair(f, atA)).streamId);
    expect(f.liveBroadcastCount()).toBe(10);
    const onB = await boundPair(f, atB);
    f.videoOn(onB.streamId);   // a global cap of 10 would refuse this as the 11th
    expect(await f.broadcastLife(atB, onB.broadcastId)).toBe("live");
    expect(f.liveBroadcastCount()).toBe(11);
    const overA = await boundPair(f, atA);
    expect(() => f.videoOn(overA.streamId), "A is still at its 10").toThrow(YouTubeError);
  });

  it("with autoVideo on, the 11th bind resolves and the broadcast stays ready (YouTube will not start it) — no throw from bind", async () => {
    const { f, at } = await rig();
    f.setAutoVideo(true);
    const lives = [];
    for (let i = 0; i < 10; i++) lives.push(await boundPair(f, at));
    expect(f.liveBroadcastCount()).toBe(10);
    const eleventh = await boundPair(f, at);
    expect(await f.broadcastLife(at, eleventh.broadcastId)).toBe("ready");
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
    expect(await f.broadcastLife(at, ids[3]!), "the refused one is still unbound").toBe("created");
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
    // Twins: another refresh token is alive; a RECONNECT (a new token) reaches the broadcast that kept running.
    await expect(f.accessToken("rt-other")).resolves.toEqual(expect.any(String));
    const grant = await f.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: REDIRECT });
    const reconnected = await f.accessToken(grant.refreshToken);
    expect(await f.broadcastLife(reconnected, broadcastId)).toBe("live");
  });

  it("revoke(refreshToken) is Google's revocation: the token is dead afterwards; revoking an unknown token resolves", async () => {
    const { f, rt } = await rig();
    await f.revoke(rt);
    expect(((await rejection(f.accessToken(rt))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    await expect(f.revoke("never-seen")).resolves.toBeUndefined();
    await expect(f.accessToken("never-seen-2"), "an untouched token is still good").resolves.toEqual(expect.any(String));
  });

  it("an access token the fake never issued is refused like an expired one", async () => {
    const f = new FakeYouTube();
    const err = await rejection(f.listMyChannels("not-an-access-token"));
    expect((err as YouTubeError).code).toBe("youtube_reconnect_needed");
  });

  it("handles: tokenHandle is stable per token, opaque, and killHandle kills exactly that token", async () => {
    const f = new FakeYouTube();
    const secret = "1//0gSECRETrefreshTokenValue-abc_123";
    const h1 = f.tokenHandle(secret);
    expect(f.tokenHandle(secret), "stable").toBe(h1);
    const h2 = f.tokenHandle("another-token");
    expect(h2).not.toBe(h1);
    expect(h1).not.toContain("SECRET");
    expect(h1).not.toContain(secret.slice(0, 6));
    f.killHandle(h1);
    expect(((await rejection(f.accessToken(secret))) as YouTubeError).code).toBe("youtube_reconnect_needed");
    await expect(f.accessToken("another-token"), "the other handle's token is untouched").resolves.toEqual(expect.any(String));
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

  it("every one of the port's 14 methods can be failed, and each failure is single-shot", async () => {
    const f = new FakeYouTube();
    const at = await f.accessToken("rt-sweep");
    const { streamId } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, bcast());
    const invoke: Record<Exclude<keyof YouTubePort, "mode">, () => unknown> = {
      authorizeUrl: () => f.authorizeUrl({ state: "s", codeChallenge: "c", redirectUri: REDIRECT }),
      exchangeCode: () => f.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: REDIRECT }),
      accessToken: () => f.accessToken("rt-sweep"),
      listMyChannels: () => f.listMyChannels(at),
      liveEnabled: () => f.liveEnabled(at),
      insertStream: () => f.insertStream(at, { title: "k" }),
      deleteStream: () => f.deleteStream(at, streamId),
      insertBroadcast: () => f.insertBroadcast(at, bcast()),
      bind: () => f.bind(at, broadcastId, streamId),
      broadcastLife: () => f.broadcastLife(at, broadcastId),
      complete: () => f.complete(at, broadcastId),
      deleteBroadcast: () => f.deleteBroadcast(at, broadcastId),
      existingVideos: () => f.existingVideos(at, [broadcastId]),
      revoke: () => f.revoke("rt-never-used"),
    };
    let checked = 0;
    for (const [method, call] of Object.entries(invoke) as [keyof typeof invoke, () => unknown][]) {
      f.failNext(method, "youtube_limit_reached", "quotaExceeded");
      const err = await rejection(async () => call());
      expect(err, method).toBeInstanceOf(YouTubeError);
      expect((err as YouTubeError).code, method).toBe("youtube_limit_reached");
      checked++;
    }
    expect(checked, "all 14 methods swept").toBe(14);
    // Single-shot, proven on the same sweep: a SECOND call of each method is not the injected refusal. Some of these still
    // refuse for their own reasons (the stream was deleted above, so bind says not_found) — never with the injected code.
    let second = 0;
    for (const [method, call] of Object.entries(invoke) as [keyof typeof invoke, () => unknown][]) {
      const err = await rejection(async () => { await call(); throw new Error("resolved"); });
      if (err instanceof YouTubeError) expect(err.code, `${method}: injection is spent`).not.toBe("youtube_limit_reached");
      else expect((err as Error).message, `${method}: the second call went through`).toBe("resolved");
      second++;
    }
    expect(second, "all 14 methods re-called").toBe(14);
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

  it("exchangeCode: a code and verifier give a fresh refresh token with exactly the youtube scope; two grants are two tokens; an empty code is invalid_grant", async () => {
    const f = new FakeYouTube();
    const a = await f.exchangeCode({ code: "code-1", codeVerifier: "verifier", redirectUri: REDIRECT });
    const b = await f.exchangeCode({ code: "code-2", codeVerifier: "verifier", redirectUri: REDIRECT });
    expect(a.scope).toBe("https://www.googleapis.com/auth/youtube");
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(typeof a.googleSub).toBe("string");
    await expect(f.accessToken(a.refreshToken)).resolves.toEqual(expect.any(String));
    for (const bad of [{ code: "", codeVerifier: "v" }, { code: "c", codeVerifier: "" }]) {
      const err = await rejection(f.exchangeCode({ ...bad, redirectUri: REDIRECT }));
      expect((err as YouTubeError).code).toBe("youtube_reconnect_needed");
    }
  });

  it("channels: one default channel, setChannels replaces them, the empty list is a real answer", async () => {
    const { f, at } = await rig();
    const dflt = await f.listMyChannels(at);
    expect(dflt).toHaveLength(1);
    expect(dflt[0]).toEqual({ id: expect.stringMatching(/^UC[A-Za-z0-9_-]{22}$/), title: expect.any(String) });
    f.setChannels([{ id: "UCone", title: "One" }, { id: "UCtwo", title: "Two" }]);
    expect(await f.listMyChannels(at)).toEqual([{ id: "UCone", title: "One" }, { id: "UCtwo", title: "Two" }]);
    f.setChannels([]);
    expect(await f.listMyChannels(at)).toEqual([]);
    const given = new FakeYouTube({ channels: [{ id: "UCx", title: "X" }] });
    expect(await given.listMyChannels(await given.accessToken("rt"))).toEqual([{ id: "UCx", title: "X" }]);
    const returned = await given.listMyChannels(await given.accessToken("rt"));
    returned.push({ id: "UCmutated", title: "M" });
    expect(await given.listMyChannels(await given.accessToken("rt")), "callers get a copy").toHaveLength(1);
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
    expect(f.inspectBroadcast(broadcastId)).toEqual({ title: "Final", description: "Court 1", scheduledStart: START, privacy: "public", madeForKids: true, streamId: null, life: "created" });
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
    expect(await f.broadcastLife(at, broadcastId)).toBe("complete");
    expect(((await rejection(f.complete(at, "nope"))) as YouTubeError).code).toBe("youtube_not_found");
  });

  it("deleteBroadcast and deleteStream: absent resolves; present removes (and the broadcast reads absent)", async () => {
    const { f, at } = await rig();
    const { streamId, broadcastId } = await boundPair(f, at);
    await f.deleteBroadcast(at, broadcastId);
    expect(await f.broadcastLife(at, broadcastId)).toBe("absent");
    await expect(f.deleteBroadcast(at, broadcastId), "second delete").resolves.toBeUndefined();
    await expect(f.deleteBroadcast(at, "never-existed")).resolves.toBeUndefined();
    expect(f.streamsCount()).toBe(1);
    await f.deleteStream(at, streamId);
    expect(f.streamsCount()).toBe(0);
    await expect(f.deleteStream(at, streamId), "second delete").resolves.toBeUndefined();
    expect(await f.broadcastLife(at, "never-existed")).toBe("absent");
  });

  it("existingVideos: only the ids that exist; empty in, empty out; 50 ids are fine and 51 throw WITHOUT being a call; deleteVideo removes one", async () => {
    const { f, at } = await rig();
    const a = (await f.insertBroadcast(at, bcast())).broadcastId;
    const b = (await f.insertBroadcast(at, bcast())).broadcastId;
    expect(await f.existingVideos(at, [a, b, "ghost"])).toEqual(new Set([a, b]));
    expect(await f.existingVideos(at, [])).toEqual(new Set());
    f.deleteVideo(a);
    expect(await f.existingVideos(at, [a, b]), "a video deleted on YouTube is gone").toEqual(new Set([b]));
    expect(await f.broadcastLife(at, a)).toBe("absent");
    const fifty = Array.from({ length: 50 }, (_, i) => `id${i}`);
    await expect(f.existingVideos(at, fifty)).resolves.toEqual(new Set());
    const before = f.calls.length;
    await expect(f.existingVideos(at, [...fifty, "id50"])).rejects.toThrow();
    expect(f.calls.length, "refused before it counts as a call").toBe(before);
    expect(() => f.deleteVideo("never-existed")).toThrow(YouTubeError);
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
    await f2.accessToken("rt");
    expect(f2.calls).toEqual([{ method: "accessToken", at: START }]);
  });
});
