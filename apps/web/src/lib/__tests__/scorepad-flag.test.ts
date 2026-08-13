import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCOREPAD_V2_FLAG,
  SCOREPAD_V2_FORCE_ENV,
  scorepadV2Enabled,
  type FlagReader,
} from "../scorepad-flag";

// S12/#421 W10. The reason this file exists at all: `SCOREPAD_V2_FORCE` is the
// only way an e2e can reach the v2 pad (PostHog is unconfigured in every
// browser run, so `isServerFeatureEnabled` returns its `fallback`, which must
// be `false`). That override therefore makes the PostHog branch unobservable
// in a browser — so it is proved HERE, with an injected reader, or nowhere.

afterEach(() => {
  delete process.env[SCOREPAD_V2_FORCE_ENV];
  vi.restoreAllMocks();
});

/** A reader that records how it was called and answers `answer`. */
function reader(answer: boolean | (() => never)): FlagReader & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (async (...args: Parameters<FlagReader>) => {
    calls.push(args);
    if (typeof answer === "function") answer();
    return answer;
  }) as FlagReader & { calls: unknown[][] };
  fn.calls = calls;
  return fn;
}

describe("scorepadV2Enabled — the override", () => {
  it('SCOREPAD_V2_FORCE="1" forces ON without consulting PostHog at all', async () => {
    process.env[SCOREPAD_V2_FORCE_ENV] = "1";
    const read = reader(false);
    expect(await scorepadV2Enabled("user-1", "org-1", read)).toBe(true);
    // Not merely "returned true" — the flag service must not be reached, or a
    // PostHog outage could still flip an e2e's flag state mid-run.
    expect(read.calls).toHaveLength(0);
  });

  it('SCOREPAD_V2_FORCE="0" forces OFF even when PostHog says yes', async () => {
    process.env[SCOREPAD_V2_FORCE_ENV] = "0";
    const read = reader(true);
    expect(await scorepadV2Enabled("user-1", "org-1", read)).toBe(false);
    expect(read.calls).toHaveLength(0);
  });

  it("any other override value defers to PostHog rather than guessing", async () => {
    // A typo'd override must not silently mean "on" — the two states are `1`
    // and `0` and everything else is "no opinion".
    process.env[SCOREPAD_V2_FORCE_ENV] = "true";
    const read = reader(false);
    expect(await scorepadV2Enabled("user-1", "org-1", read)).toBe(false);
    expect(read.calls).toHaveLength(1);
  });
});

describe("scorepadV2Enabled — the PostHog branch no browser run can reach", () => {
  it("passes the hyphenated flag name, the distinctId, the org group, and fallback:false", async () => {
    const read = reader(true);
    expect(await scorepadV2Enabled("user-7", "org-9", read)).toBe(true);
    expect(read.calls[0]).toEqual([
      SCOREPAD_V2_FLAG,
      "user-7",
      { orgId: "org-9", fallback: false },
    ]);
    // The prompt for this session names `scorepad_v2` with an underscore in one
    // place; S10 declared the hyphen. Pin the wire value, not the constant.
    expect(SCOREPAD_V2_FLAG).toBe("scorepad-v2");
  });

  it("PostHog saying no means v1", async () => {
    expect(await scorepadV2Enabled("user-1", "org-1", reader(false))).toBe(false);
  });

  it("a throwing reader fails CLOSED to v1, never open to v2 — and never propagates", async () => {
    // Both halves matter. Returning `true` would hand a scorer an untested pad
    // because analytics was down; throwing would 500 the whole fixture page,
    // which is worse than either pad.
    const boom: FlagReader = () => {
      throw new Error("posthog unreachable");
    };
    expect(await scorepadV2Enabled("user-1", "org-1", boom)).toBe(false);

    const rejects: FlagReader = () => Promise.reject(new Error("posthog timeout"));
    expect(await scorepadV2Enabled("user-1", "org-1", rejects)).toBe(false);
  });
});
