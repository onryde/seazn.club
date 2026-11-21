// Task 21: which ReplayHost a process talks to, and how a stream session's deps reach it. The fake is ONE instance per process
// (a Go-live on one copy of a module and a webhook on another must see the same videos); `bunny` mode never falls back to it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDeps, replayOf } from "@/server/usecases/stream-sessions/deps";
import { replayDriver, setReplayDriverForTest } from "../replay-driver";
import { FakeReplayHost } from "../replay-fake";
import type { ReplayHost } from "../replay-ports";

afterEach(() => {
  vi.unstubAllEnvs();
  setReplayDriverForTest(null);
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
    expect(() => replayDriver()).toThrow(/BUNNY_STREAM_API_KEY/);
  });

  it("bunny mode with its settings present still never answers the fake", () => {
    setEnv({ REPLAY_DRIVER: "bunny", ...BUNNY_ENV });
    let got: ReplayHost | undefined;
    try { got = replayDriver(); } catch { /* the adapter may refuse; what must not happen is a fake in its place */ }
    expect(got).not.toBeInstanceOf(FakeReplayHost);
  });

  it("a misspelt REPLAY_DRIVER throws naming the variable", () => {
    setEnv({ REPLAY_DRIVER: "bunnny" });
    expect(() => replayDriver()).toThrow(/REPLAY_DRIVER/);
  });
});

describe("SessionDeps.replay", () => {
  it("defaultDeps reads the process driver, lazily: building deps never fails on a replay setting, reading it does", () => {
    setEnv({ REPLAY_DRIVER: "bunnny" });
    const deps = defaultDeps("https://seazn.test"); // a Stop or a heartbeat on a pasted-key match builds these
    expect(() => deps.replay).toThrow(/REPLAY_DRIVER/);
    vi.stubEnv("REPLAY_DRIVER", "fake");
    expect(deps.replay).toBe(replayDriver());
  });

  it("replayOf takes the deps' own host, else the process driver", () => {
    setEnv({ REPLAY_DRIVER: "fake" });
    const base = { drivers: defaultDeps("https://seazn.test").drivers, now: () => new Date(), appUrl: "https://seazn.test" };
    expect(replayOf(base)).toBe(replayDriver());
    const mine = new FakeReplayHost();
    expect(replayOf({ ...base, replay: mine })).toBe(mine);
    expect(replayOf({ ...base, replay: mine })).not.toBe(replayDriver());
  });
});
