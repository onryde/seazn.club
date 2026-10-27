// YouTube Connect T5: which YouTube driver a process runs, and where the fake's routes exist.
//
// The rule (plan P12): YOUTUBE_DRIVER=fake|live picks it; UNSET is fake outside production and LIVE in production. The row
// that matters most is the production one: a production process that was not told to fake must never serve a fake channel
// (a fake grant would "connect" a club to nothing). That row is the regression this file pins, beside its twins.
//
// Expected values are typed here (the env words, the two honoured ENV_NAMEs); the fake routes' gate reuses the relay's
// FAKE_DRIVER_ENV_NAMES, so its one derived premise is asserted first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import { FakeYouTube } from "../fake";
import type { YouTubePort } from "../port";
import { setYoutubeDriverForTest, youtubeDriver, youtubeDriverMode, youtubeFakeRoutesEnabled } from "../driver";

afterEach(() => {
  vi.unstubAllEnvs();
  setYoutubeDriverForTest(null);
});

type Env = Record<string, string | undefined>;

describe("youtubeDriverMode", () => {
  it("production with YOUTUBE_DRIVER unset is live, never fake; test/dev/empty env unset is fake; 'fake' in production is fake (e2e)", () => {
    const rows: [string, Env, "fake" | "live"][] = [
      ["production, unset", { NODE_ENV: "production" }, "live"],
      ["production, empty string", { NODE_ENV: "production", YOUTUBE_DRIVER: "" }, "live"],
      ["production, blank", { NODE_ENV: "production", YOUTUBE_DRIVER: "  " }, "live"],
      ["test, unset", { NODE_ENV: "test" }, "fake"],
      ["development, unset", { NODE_ENV: "development" }, "fake"],
      ["no NODE_ENV at all", {}, "fake"],
      ["production, explicit fake (the e2e server)", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake" }, "fake"],
      ["production, explicit live", { NODE_ENV: "production", YOUTUBE_DRIVER: "live" }, "live"],
      ["test, explicit live", { NODE_ENV: "test", YOUTUBE_DRIVER: "live" }, "live"],
      ["test, explicit fake", { NODE_ENV: "test", YOUTUBE_DRIVER: "fake" }, "fake"],
      ["whitespace around a word is the word", { NODE_ENV: "production", YOUTUBE_DRIVER: " fake " }, "fake"],
    ];
    let checked = 0;
    for (const [name, env, want] of rows) {
      expect(youtubeDriverMode(env), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("anything but fake/live is a loud error, not a guess (a typo must not pick a driver)", () => {
    for (const word of ["fakee", "FAKE", "disabled", "true", "1"]) {
      expect(() => youtubeDriverMode({ NODE_ENV: "production", YOUTUBE_DRIVER: word }), word).toThrow(/YOUTUBE_DRIVER/);
    }
  });

  it("with no argument it reads process.env (the default is the live environment)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("YOUTUBE_DRIVER", "");
    expect(youtubeDriverMode()).toBe("live");
    vi.stubEnv("YOUTUBE_DRIVER", "fake");
    expect(youtubeDriverMode()).toBe("fake");
  });
});

describe("youtubeFakeRoutesEnabled — the fake's control and authorize routes", () => {
  it("PREMISE: the honoured ENV_NAMEs are exactly local and ci (the relay's own list, shared with the fake-ingest control route)", () => {
    expect([...FAKE_DRIVER_ENV_NAMES].sort()).toEqual(["ci", "local"]);
  });

  it("answers yes only in fake mode AND under an honoured ENV_NAME", () => {
    const rows: [string, Env, boolean][] = [
      ["fake + local", { NODE_ENV: "test", YOUTUBE_DRIVER: "fake", ENV_NAME: "local" }, true],
      ["fake + ci", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake", ENV_NAME: "ci" }, true],
      ["unset driver outside production + local", { NODE_ENV: "test", ENV_NAME: "local" }, true],
      ["fake + ' ci ' (trimmed, like the fake-ingest gate)", { YOUTUBE_DRIVER: "fake", ENV_NAME: " ci " }, true],
      ["fake + stg", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake", ENV_NAME: "stg" }, false],
      ["fake + prod", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake", ENV_NAME: "prod" }, false],
      ["fake + ENV_NAME unset", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake" }, false],
      ["fake + ENV_NAME empty", { NODE_ENV: "production", YOUTUBE_DRIVER: "fake", ENV_NAME: "" }, false],
      ["live + ci", { NODE_ENV: "test", YOUTUBE_DRIVER: "live", ENV_NAME: "ci" }, false],
      ["production, driver unset (= live) + ci", { NODE_ENV: "production", ENV_NAME: "ci" }, false],
      ["a typo'd driver word refuses, it does not throw", { NODE_ENV: "test", YOUTUBE_DRIVER: "fakee", ENV_NAME: "ci" }, false],
    ];
    let checked = 0;
    for (const [name, env, want] of rows) {
      expect(youtubeFakeRoutesEnabled(env), name).toBe(want);
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(rows.filter(([, , want]) => want).length, "both answers are exercised").toBe(4);
  });

  it("with no argument it reads process.env", () => {
    vi.stubEnv("YOUTUBE_DRIVER", "fake");
    vi.stubEnv("ENV_NAME", "ci");
    expect(youtubeFakeRoutesEnabled()).toBe(true);
    vi.stubEnv("ENV_NAME", "prod");
    expect(youtubeFakeRoutesEnabled()).toBe(false);
  });
});

describe("youtubeDriver", () => {
  it("in fake mode: one FakeYouTube per process (the same instance twice), shared even by a second copy of the module", async () => {
    vi.stubEnv("YOUTUBE_DRIVER", "fake");
    const a = youtubeDriver();
    expect(a).toBeInstanceOf(FakeYouTube);
    expect(a.mode).toBe("fake");
    expect(youtubeDriver(), "second call").toBe(a);
    // Next can bundle a module twice (a route and an instrumentation hook); the fake must still be ONE, which is why it
    // lives on globalThis. A module cache reset stands in for the second copy.
    vi.resetModules();
    const again = await import("../driver");
    expect(again.youtubeDriver()).toBe(a);
  });

  it("the test override wins, and clearing it (null) also clears the cached fake so the next test starts clean", () => {
    vi.stubEnv("YOUTUBE_DRIVER", "fake");
    const first = youtubeDriver();
    const mine = new FakeYouTube();
    setYoutubeDriverForTest(mine);
    expect(youtubeDriver()).toBe(mine);
    setYoutubeDriverForTest(null);
    const fresh = youtubeDriver();
    expect(fresh).toBeInstanceOf(FakeYouTube);
    expect(fresh).not.toBe(mine);
    expect(fresh, "a clear also drops the cached fake").not.toBe(first);
    expect(youtubeDriver(), "and the new one is cached").toBe(fresh);
  });

  it("in live mode it never returns the fake: it is a live port, or it refuses (until the Google driver is wired it refuses by name)", () => {
    vi.stubEnv("YOUTUBE_DRIVER", "live");
    let got: YouTubePort | Error;
    try {
      got = youtubeDriver();
    } catch (e) {
      got = e as Error;
    }
    expect(got).not.toBeInstanceOf(FakeYouTube);
    if (got instanceof Error) expect(got.message).toMatch(/YOUTUBE_DRIVER=live/);
    else expect(got.mode).toBe("live");
  });

  it("production with the variable unset: the driver is the live path, not the fake", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("YOUTUBE_DRIVER", "");
    let got: YouTubePort | Error;
    try {
      got = youtubeDriver();
    } catch (e) {
      got = e as Error;
    }
    expect(got).not.toBeInstanceOf(FakeYouTube);
    // The positive pair (as in the explicit-live test above): what it IS, not only what it is not. A driver that returned
    // `undefined`, or any other object, would pass the line above and be neither the named refusal nor a live port.
    if (got instanceof Error) expect(got.message).toMatch(/YOUTUBE_DRIVER=live/);
    else expect(got.mode).toBe("live");
  });

  it("an override set while the mode is live is still honoured (a test double stands in for Google)", () => {
    vi.stubEnv("YOUTUBE_DRIVER", "live");
    const mine = new FakeYouTube();
    setYoutubeDriverForTest(mine);
    expect(youtubeDriver()).toBe(mine);
  });
});
