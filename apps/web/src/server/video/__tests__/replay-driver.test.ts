// Task 21: which ReplayHost a process talks to, and how a stream session's deps reach it. The fake is ONE instance per process
// (a Go-live on one copy of a module and a webhook on another must see the same videos); `bunny` mode answers the Bunny adapter
// (Task 22) and never falls back to the fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNNY_ENV_NAMES } from "@/server/relay/config";
import { dbRecorder, setRelayDriversForTest } from "@/server/relay/drivers";
import { log } from "@/server/logger";
import { defaultDeps, replayOf, type SessionDeps } from "@/server/usecases/stream-sessions/deps";
import { BunnyReplayHost } from "../replay-bunny";
import { replayDriver, setReplayDriverForTest } from "../replay-driver";
import { FakeReplayHost } from "../replay-fake";

// An explicit REPLAY_DRIVER=fake is honoured only where ENV_NAME is local or ci, and a developer's .env.local may name another.
beforeEach(() => { vi.stubEnv("ENV_NAME", "local"); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setReplayDriverForTest(null);
  setRelayDriversForTest(null);
});

const BUNNY_ENV = {
  BUNNY_STREAM_LIBRARY_ID: "424242",
  BUNNY_STREAM_API_KEY: "ZZ-fake-api-key-5c1e",
  BUNNY_STREAM_READONLY_KEY: "ZZ-fake-readonly-key-77d0",
  BUNNY_STREAM_CDN_HOST: "vz-fake000.b-cdn.net",
  BUNNY_TOKEN_KEY: "ZZ-fake-token-key-a93b",
};
const setEnv = (env: Record<string, string>) => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };
// A developer's .env.local may hold real Bunny settings and vitest loads it, so a test that needs them ABSENT blanks them.
const noBunnyEnv = () => setEnv(Object.fromEntries(Object.keys(BUNNY_ENV).map((k) => [k, ""])));

describe("replayDriver", () => {
  it("fake mode answers one FakeReplayHost per process, and a test reset gives the next test an empty one", async () => {
    setEnv({ REPLAY_DRIVER: "fake" });
    const a = replayDriver();
    expect(a).toBeInstanceOf(FakeReplayHost);
    expect(replayDriver()).toBe(a);
    const id = await a.fetchFromUrl({ collectionId: "c", title: "t", url: "https://x.invalid/f.mp4" });
    expect((await replayDriver().video(id)).state).toBe("processing");
    setReplayDriverForTest(null);
    const b = replayDriver();
    expect(b).not.toBe(a);
    expect((await b.video(id)).state).toBe("absent");
  });

  it("a test's own host wins over the mode, and null puts the mode back", () => {
    setEnv({ REPLAY_DRIVER: "fake" });
    const mine = new FakeReplayHost();
    setReplayDriverForTest(mine);
    expect(replayDriver()).toBe(mine);
    setReplayDriverForTest(null);
    expect(replayDriver()).not.toBe(mine);
  });

  it("bunny mode names every missing Bunny variable and never answers the fake", () => {
    noBunnyEnv();
    setEnv({ REPLAY_DRIVER: "bunny" });
    const message = (() => { try { replayDriver(); return ""; } catch (e) { return (e as Error).message; } })();
    for (const name of BUNNY_ENV_NAMES) expect(message, name).toContain(name);
    expect(BUNNY_ENV_NAMES).toHaveLength(5);
  });

  it("bunny mode with its settings present answers the Bunny adapter, built once; a test reset builds the next one", () => {
    setEnv({ REPLAY_DRIVER: "bunny", ...BUNNY_ENV });
    const host = replayDriver();
    expect(host).toBeInstanceOf(BunnyReplayHost);
    expect(replayDriver()).toBe(host);
    setReplayDriverForTest(null);
    const next = replayDriver();
    expect(next).toBeInstanceOf(BunnyReplayHost);
    expect(next).not.toBe(host);
  });

  it("the Bunny adapter the driver builds sends its above-720p warning to the server log, naming the video id", async () => {
    // The adapter takes the global fetch when it is built, so the stub goes in first: no request leaves the process.
    const guid = "3f1c2a9e-0b7d-4c55-9a61-2d8e4f7b1c03";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ guid, status: 4, length: 28, availableResolutions: "360p,720p,1080p" }), { status: 200 })));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    setEnv({ REPLAY_DRIVER: "bunny", ...BUNNY_ENV });
    const v = await replayDriver().video(guid);
    expect([...v.heights].sort((a, b) => a - b)).toEqual([360, 720]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ videoId: guid });
    expect(String(warn.mock.calls[0][1])).toMatch(/720p/);
  });

  it("the Bunny adapter the driver builds records every call through the database recorder (V542 admits `bunny`)", async () => {
    const guid = "9a4e1c27-5b3d-4f08-8c6a-1e2d3f4a5b6c";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ guid, status: 4, length: 28, availableResolutions: "360p,720p" }), { status: 200 })));
    // The spy stands in for the insert: this file runs with no database. The row itself is seazn-replays-migration.test.ts's.
    const record = vi.spyOn(dbRecorder, "record").mockImplementation(async () => undefined);
    setEnv({ REPLAY_DRIVER: "bunny", ...BUNNY_ENV });
    await replayDriver().video(guid);
    await new Promise((done) => setImmediate(done));   // the adapter records fire-and-forget, one microtask on
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0]).toMatchObject({ provider: "bunny", operation: "video", method: "GET", subjectId: guid, status: 200 });
  });

  it("a misspelt REPLAY_DRIVER throws naming the variable", () => {
    setEnv({ REPLAY_DRIVER: "bunnny" });
    expect(() => replayDriver()).toThrow(/REPLAY_DRIVER/);
  });
});

describe("SessionDeps.replay", () => {
  const APP = "https://seazn.test";

  it("defaultDeps carries no `replay`, so spreading it reads nothing: a live relay with REPLAY_DRIVER unset does not throw", () => {
    const deps = defaultDeps(APP);
    setRelayDriversForTest(deps.drivers); // pin the relay pair, so the live setting below builds no real driver
    setEnv({ RELAY_DRIVERS: "live", ENV_NAME: "stg", REPLAY_DRIVER: "" }); // stg today: the relay is live, Phase 2 is not set up
    expect(() => replayDriver()).toThrow(/REPLAY_DRIVER/); // the setting itself IS refused…
    let copy: SessionDeps | undefined;
    expect(() => { copy = { ...defaultDeps(APP), now: () => new Date(0) }; }).not.toThrow(); // …but a copy of the deps is not
    expect(copy!.replay).toBeUndefined();
    expect(() => replayOf(copy!)).toThrow(/REPLAY_DRIVER/); // and the one call that needs the host still refuses, by name
  });

  it("replayOf takes the deps' own host, else the process driver", () => {
    setEnv({ REPLAY_DRIVER: "fake" });
    const base = { drivers: defaultDeps(APP).drivers, now: () => new Date(), appUrl: APP };
    expect(replayOf(base)).toBe(replayDriver());
    expect(replayOf(defaultDeps(APP))).toBe(replayDriver());
    const mine = new FakeReplayHost();
    expect(replayOf({ ...base, replay: mine })).toBe(mine);
    expect(replayOf({ ...base, replay: mine })).not.toBe(replayDriver());
  });
});
