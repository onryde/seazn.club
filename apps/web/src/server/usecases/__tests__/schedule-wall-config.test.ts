// The solve wall as CONFIGURATION (`PLACEMENT_WALL_SECONDS`), and the one
// number that must move with it.
//
// WHY THIS SUITE EXISTS. The wall used to be a bare `const` and the cooldown
// window a bare `375`, with a COMMENT instructing whoever changed the wall to
// re-derive the window by hand. That instruction was correct, load-bearing, and
// had already been missed once — the window sat at 750 (right for a 20s wall)
// against a 10s wall, silently handing one org double its intended share of a
// serialised solver. Now that an operator can change the wall with
// `fly secrets set` and no code review at all, a comment cannot be the
// enforcement. These tests are.
//
// NON-VACUITY. Asserting only the defaults would pass with the env read
// deleted, and asserting only the wall would pass with the cooldown left
// hardcoded at 375 — that is precisely the bug being prevented. So every case
// below either sets a NON-default wall, or asserts a refusal.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { autoScheduleCooldown, autoSolverWallMs } from "../schedule";

const KEY = "PLACEMENT_WALL_SECONDS";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("autoSolverWallMs", () => {
  it("defaults to 10s when the env var is absent", () => {
    expect(autoSolverWallMs()).toBe(10_000);
  });

  it("defaults to 10s when the env var is present but empty", () => {
    // Fly hands an unset secret through as an empty string rather than
    // omitting it, so empty has to mean "not configured" and not "0 seconds".
    process.env[KEY] = "";
    expect(autoSolverWallMs()).toBe(10_000);
    process.env[KEY] = "   ";
    expect(autoSolverWallMs()).toBe(10_000);
  });

  it("takes the configured value, in SECONDS, and returns milliseconds", () => {
    process.env[KEY] = "30";
    expect(autoSolverWallMs()).toBe(30_000);
  });

  it("accepts a fractional number of seconds", () => {
    process.env[KEY] = "2.5";
    expect(autoSolverWallMs()).toBe(2_500);
  });

  // Refusing rather than defaulting is the whole point. A typo'd wall that
  // silently falls back to 10s leaves the operator believing they changed the
  // budget while every board still gets the old one — a plausible, stable,
  // wrong answer, which is the failure mode this subsystem produces most.
  it.each(["abc", "0", "-5", "NaN", "Infinity"])("refuses %j rather than defaulting", (bad) => {
    process.env[KEY] = bad;
    expect(() => autoSolverWallMs()).toThrow(/PLACEMENT_WALL_SECONDS/);
  });

  it("names the offending value in the error, so the typo is visible", () => {
    process.env[KEY] = "tenn";
    expect(() => autoSolverWallMs()).toThrow(/"tenn"/);
  });
});

describe("autoScheduleCooldown", () => {
  it("is unchanged at the default wall — 10 runs per 375s", () => {
    // Byte-for-byte the literal this replaced. If this moves, the migration
    // silently changed production's rate limit.
    expect(autoScheduleCooldown()).toEqual({ max: 10, windowSeconds: 375 });
  });

  it("widens the window WITH the wall, holding the ~27% capacity share", () => {
    process.env[KEY] = "20";
    // 10 runs x 20s / 0.2667 = 750s. This is the value the old hardcoded
    // constant actually held at a 20s wall, arrived at without editing a file.
    expect(autoScheduleCooldown().windowSeconds).toBe(750);
  });

  it("keeps `max` fixed as the wall moves — it is a UX number, not a capacity one", () => {
    process.env[KEY] = "45";
    expect(autoScheduleCooldown().max).toBe(10);
  });

  it("holds the capacity ratio across every wall, not just the two sampled", () => {
    // The invariant, stated directly: runs x wall / window is the share of a
    // serialised instance one org can occupy, and it must not drift with the
    // wall. Pinning the ratio rather than a table of windows means a future
    // change to the derivation cannot pass by updating the expected numbers.
    //
    // ROUNDING IS THE ONLY PERMITTED DEVIATION, and it is not negligible at
    // small walls: a 1s wall wants a 37.5s window, gets 37, and the realised
    // share is 0.2703 — 1.3% over policy. So the assertion bounds the window
    // against the ideal by the half-second `Math.round` can cost, which stays
    // exact at every wall, rather than a ratio tolerance that would have to be
    // loosened until it stopped catching a real drift.
    for (const seconds of [1, 5, 10, 20, 30, 60, 120]) {
      process.env[KEY] = String(seconds);
      const { max, windowSeconds } = autoScheduleCooldown();
      const ideal = (max * seconds) / 0.2667;
      expect(Math.abs(windowSeconds - ideal)).toBeLessThanOrEqual(0.5);
    }
  });
});
