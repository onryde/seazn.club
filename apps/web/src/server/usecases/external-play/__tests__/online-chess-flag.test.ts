// T20 (owner 2026-10-11, "add the feature flag behind the chess online like streaming"): online chess is offered per
// club by the PostHog flag `online-chess`, mirroring capture-qr-v2 (stream-panel-context.ts). The values below come
// from the brief (task-20-brief.md), never from the helper: the key `online-chess`, the override ONLINE_CHESS_ALWAYS
// exactly "1", fallback OFF (PostHog unconfigured, down or throwing = off), org-group targeted, one answer per
// (org, distinct id) pair for a short TTL.
//
// These cases drive the REAL `isServerFeatureEnabled` (lib/posthog-server.ts) over a doubled `posthog-node`, so
// "PostHog throws" is PostHog's client throwing, not a stub of our own wrapper. posthog-server reads its key and
// builds its client at module load, so every case starts from fresh modules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FlagModule from "../online-chess-flag";

const ph = vi.hoisted(() => ({
  ctor: vi.fn(),
  isFeatureEnabled: vi.fn<(flag: string, distinctId: string, opts?: { groups?: Record<string, string> }) => Promise<boolean | undefined>>(),
}));

type Flag = typeof FlagModule;
let flag: Flag;

async function freshModules(opts: { configured: boolean }): Promise<Flag> {
  vi.resetModules();
  if (opts.configured) vi.stubEnv("POSTHOG_KEY", "phc_test");
  else {
    vi.stubEnv("POSTHOG_KEY", undefined);
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", undefined);
  }
  vi.doMock("posthog-node", () => ({
    PostHog: class {
      constructor() {
        ph.ctor();
      }
      isFeatureEnabled = ph.isFeatureEnabled;
      capture = vi.fn();
      flush = vi.fn(async () => undefined);
    },
  }));
  return import("../online-chess-flag");
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const as = (orgId: string, userId: string | null) => ({ orgId, userId });

beforeEach(async () => {
  ph.ctor.mockReset();
  ph.isFeatureEnabled.mockReset().mockResolvedValue(false);
  vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
  flag = await freshModules({ configured: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("online-chess: the flag decides, asked for THIS user in THIS org's group, falling back to off", () => {
  it("the declared values: key `online-chess`, the refusal code ONLINE_CHESS_DISABLED", () => {
    // From the brief, verbatim — a rename here is a rename of what the owner creates in PostHog.
    expect(flag.ONLINE_CHESS_FLAG).toBe("online-chess");
    expect(flag.ONLINE_CHESS_DISABLED_CODE).toBe("ONLINE_CHESS_DISABLED");
  });

  it("flag OFF → not offered; flag ON → offered — each asked once, by the user, in the org's group", async () => {
    let checked = 0;
    for (const on of [false, true]) {
      ph.isFeatureEnabled.mockReset().mockResolvedValue(on);
      flag.forgetOnlineChessFlagCache();
      expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), `flag ${on}`).toBe(on);
      expect(ph.isFeatureEnabled.mock.calls).toEqual([["online-chess", "user-1", { groups: { organization: ORG_A } }]]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("PostHog THROWS, or answers nothing → off (fallback false)", async () => {
    let checked = 0;
    for (const [label, answer] of [
      ["rejects", () => Promise.reject(new Error("posthog down"))],
      ["throws synchronously", () => { throw new Error("posthog exploded"); }],
      ["answers undefined (flag unknown to PostHog)", () => Promise.resolve(undefined)],
    ] as const) {
      ph.isFeatureEnabled.mockReset().mockImplementation(answer as never);
      flag.forgetOnlineChessFlagCache();
      expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), label).toBe(false);
      expect(ph.isFeatureEnabled, `${label}: PostHog WAS asked`).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("PostHog UNCONFIGURED (no key) → off, and no client is ever built", async () => {
    flag = await freshModules({ configured: false });
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1"))).toBe(false);
    expect(ph.ctor).not.toHaveBeenCalled();
    expect(ph.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("an API-key caller (no user) is asked as its org", async () => {
    ph.isFeatureEnabled.mockResolvedValue(true);
    expect(await flag.onlineChessOffered(as(ORG_A, null))).toBe(true);
    expect(ph.isFeatureEnabled.mock.calls).toEqual([["online-chess", ORG_A, { groups: { organization: ORG_A } }]]);
  });

  it("assertOnlineChessOffered: off → 403 ONLINE_CHESS_DISABLED; on → resolves", async () => {
    const { HttpError } = await import("@/lib/errors");
    ph.isFeatureEnabled.mockResolvedValue(false);
    const refused = await flag.assertOnlineChessOffered(as(ORG_A, "user-1")).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect(refused).toMatchObject({ status: 403, code: "ONLINE_CHESS_DISABLED" });
    flag.forgetOnlineChessFlagCache();
    ph.isFeatureEnabled.mockResolvedValue(true);
    await expect(flag.assertOnlineChessOffered(as(ORG_A, "user-1"))).resolves.toBeUndefined();
  });
});

describe("online-chess: ONLINE_CHESS_ALWAYS=1 forces it on — exactly \"1\", and never NODE_ENV", () => {
  it("override \"1\" with the flag OFF → offered, PostHog not even asked; any other value follows the flag", async () => {
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1"))).toBe(true);
    expect(ph.isFeatureEnabled).not.toHaveBeenCalled();
    let checked = 0;
    for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("ONLINE_CHESS_ALWAYS", value);
      for (const on of [false, true]) {
        ph.isFeatureEnabled.mockReset().mockResolvedValue(on);
        flag.forgetOnlineChessFlagCache();
        expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), `override ${JSON.stringify(value)}, flag ${on}`).toBe(on);
        expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(1);
        checked++;
      }
    }
    expect(checked).toBe(14);
  });

  it("the override wins with PostHog unconfigured too (local / CI / e2e have no key)", async () => {
    flag = await freshModules({ configured: false });
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1"))).toBe(true);
  });

  it("not NODE_ENV: development, test and production builds with the flag off and no override are all off", async () => {
    let checked = 0;
    for (const env of ["development", "test", "production"]) {
      vi.stubEnv("NODE_ENV", env);
      flag.forgetOnlineChessFlagCache();
      expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), env).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("online-chess: one answer per (org, user) pair for the TTL — never one club's answer for another", () => {
  it("org A ON and org B OFF in the same process: each keeps its OWN answer, asked once each, inside the TTL", async () => {
    ph.isFeatureEnabled.mockImplementation(async (_f, _d, opts) => opts?.groups?.organization === ORG_A);
    let checked = 0;
    for (const round of [1, 2]) {
      expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), `round ${round}: org A`).toBe(true);
      expect(await flag.onlineChessOffered(as(ORG_B, "user-1")), `round ${round}: org B`).toBe(false);
      checked += 2;
      expect(ph.isFeatureEnabled, `after round ${round}`).toHaveBeenCalledTimes(2);
    }
    expect(checked).toBe(4);
  });

  it("kept per PAIR: two users of one org, and one user in two orgs, never share an answer", async () => {
    ph.isFeatureEnabled.mockImplementation(async (_f, distinctId, opts) => distinctId === "user-1" && opts?.groups?.organization === ORG_A);
    const PAIRS: [{ orgId: string; userId: string | null }, boolean][] = [
      [as(ORG_A, "user-1"), true],
      [as(ORG_A, "user-2"), false], // another user, the same org
      [as(ORG_B, "user-1"), false], // the same user, another org
      [as(ORG_A, null), false], // an API-key caller in org A: asked as the org
    ];
    let checked = 0;
    for (const round of [1, 2]) {
      for (const [who, want] of PAIRS) {
        expect(await flag.onlineChessOffered(who), `round ${round}: ${who.orgId}/${who.userId}`).toBe(want);
        checked++;
      }
      expect(ph.isFeatureEnabled, `after round ${round}`).toHaveBeenCalledTimes(PAIRS.length);
    }
    expect(checked).toBe(2 * PAIRS.length);
  });

  it("a flip in PostHog shows once the TTL has passed, not before — and the TTL is a minute", async () => {
    expect(flag.ONLINE_CHESS_FLAG_TTL_MS).toBe(60_000);
    vi.useFakeTimers();
    ph.isFeatureEnabled.mockResolvedValue(true);
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1"))).toBe(true);
    ph.isFeatureEnabled.mockResolvedValue(false);
    vi.advanceTimersByTime(flag.ONLINE_CHESS_FLAG_TTL_MS - 1);
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), "inside the TTL: the kept answer").toBe(true);
    expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), "at the TTL: asked again").toBe(false);
    expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(2);
  });

  it("concurrent asks before the first answer share ONE call", async () => {
    let release!: (v: boolean) => void;
    ph.isFeatureEnabled.mockImplementation(() => new Promise<boolean>((r) => { release = r; }));
    const both = Promise.all([flag.onlineChessOffered(as(ORG_A, "user-1")), flag.onlineChessOffered(as(ORG_A, "user-1"))]);
    await vi.waitFor(() => expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(1));
    release(true);
    expect(await both).toEqual([true, true]);
    expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("the override answers without the cache: switching it off afterwards asks PostHog", async () => {
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1"))).toBe(true);
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    expect(await flag.onlineChessOffered(as(ORG_A, "user-1")), "nothing was cached under the override").toBe(false);
    expect(ph.isFeatureEnabled).toHaveBeenCalledTimes(1);
  });
});
