import { describe, expect, it } from "vitest";
import { addTag, normalizeTag, removeTag } from "../tag-chip-input";

describe("normalizeTag", () => {
  it("trims and lowercases", () => {
    expect(normalizeTag("  Clay ")).toBe("clay");
    expect(normalizeTag("INDOOR")).toBe("indoor");
  });

  it("empty/whitespace-only input normalises to an empty string", () => {
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag("")).toBe("");
  });
});

describe("addTag", () => {
  it("appends a new normalised tag", () => {
    expect(addTag(["clay"], "  Indoor ")).toEqual(["clay", "indoor"]);
  });

  it("dedupes case-insensitively against what is already chosen", () => {
    expect(addTag(["clay", "indoor"], "Clay")).toEqual(["clay", "indoor"]);
  });

  it("drops an empty/whitespace-only draft without changing the list", () => {
    expect(addTag(["clay"], "   ")).toEqual(["clay"]);
  });

  it("preserves existing order and appends at the end", () => {
    expect(addTag(["b", "a"], "c")).toEqual(["b", "a", "c"]);
  });

  it("starting from empty produces a single-element list", () => {
    expect(addTag([], "lit")).toEqual(["lit"]);
  });
});

describe("removeTag", () => {
  it("removes the named tag and leaves the rest untouched", () => {
    expect(removeTag(["clay", "indoor", "lit"], "indoor")).toEqual(["clay", "lit"]);
  });

  it("removing a tag that is not present is a no-op", () => {
    expect(removeTag(["clay"], "grass")).toEqual(["clay"]);
  });

  it("removing from an empty list is a no-op", () => {
    expect(removeTag([], "clay")).toEqual([]);
  });
});
