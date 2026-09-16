// Da: the build sha is PARSED out of Fly's image ref, never trusted whole. Pure.
// And the money guard: a process that was never told RELAY_DRIVERS=live runs the fake drivers.
import { afterEach, describe, expect, it } from "vitest";
import { buildShaOf, relayDriverMode } from "../config";

describe("buildShaOf (Da)", () => {
  it("a 40-hex tag → the sha; a deployment-… tag → null; unset → null", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildShaOf(`registry.fly.io/seazn-club:${sha}`)).toBe(sha);
    expect(buildShaOf("registry.fly.io/seazn-club:deployment-01HZX5Y8K2M3N4P5Q6R7S8T9V0")).toBeNull();
    expect(buildShaOf(undefined)).toBeNull();
  });
});

describe("relayDriverMode — unset is fake (a process not told it may spend money does not)", () => {
  // Restored after every case: removed when it was originally unset (never assigned `undefined`, which Node stores as
  // the string "undefined" — and "undefined" is exactly a value this function must refuse).
  const saved = process.env.RELAY_DRIVERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.RELAY_DRIVERS;
    else process.env.RELAY_DRIVERS = saved;
  });

  it("unset → fake, and empty → fake (the money guard)", () => {
    delete process.env.RELAY_DRIVERS;
    expect(relayDriverMode()).toBe("fake");
    process.env.RELAY_DRIVERS = "";
    expect(relayDriverMode()).toBe("fake");
  });

  it("the explicit values are themselves: fake → fake, live → live", () => {
    process.env.RELAY_DRIVERS = "fake";
    expect(relayDriverMode()).toBe("fake");
    process.env.RELAY_DRIVERS = "live";
    expect(relayDriverMode()).toBe("live");
  });

  it("anything else throws rather than guessing a mode — LIVE, true, 1, the string \"undefined\"", () => {
    for (const value of ["LIVE", "true", "1", "undefined"]) {
      process.env.RELAY_DRIVERS = value;
      expect(() => relayDriverMode(), value).toThrow(/RELAY_DRIVERS must be "fake" or "live"/);
    }
  });
});
