// Da: the build sha is PARSED out of Fly's image ref, never trusted whole. Pure.
import { describe, expect, it } from "vitest";
import { buildShaOf } from "../config";

describe("buildShaOf (Da)", () => {
  it("a 40-hex tag → the sha; a deployment-… tag → null; unset → null", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildShaOf(`registry.fly.io/seazn-club:${sha}`)).toBe(sha);
    expect(buildShaOf("registry.fly.io/seazn-club:deployment-01HZX5Y8K2M3N4P5Q6R7S8T9V0")).toBeNull();
    expect(buildShaOf(undefined)).toBeNull();
  });
});
