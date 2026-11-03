// Match Day C8 — the New competition form's two pure rules: where Ends goes when
// Starts moves, and why Create is disabled. Both are decided here, not inside
// the island, so every branch is reachable without a DOM.
import { describe, expect, it } from "vitest";
import { createBlocker, endsOnAfterStartChange } from "../new-competition-form";

describe("endsOnAfterStartChange", () => {
  it("Ends defaults to the first Start picked", () => {
    expect(endsOnAfterStartChange({ prevStart: "", nextStart: "2026-11-14", endsOn: "" })).toBe("2026-11-14");
  });

  it("Ends keeps following Start while it still equals the previous Start — forward and back", () => {
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-20", endsOn: "2026-11-14" })).toBe("2026-11-20");
    // Backwards is the case a plain "end < start" rule misses: Ends was only
    // ever a copy of Start and must go with it.
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-10", endsOn: "2026-11-14" })).toBe("2026-11-10");
  });

  it("Ends that was earlier than the previous Start moves to the new Start", () => {
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-12", endsOn: "2026-11-01" })).toBe("2026-11-12");
  });

  it("Ends pushed past Start by the organiser is theirs: it stays when Start moves earlier or a little later", () => {
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-10", endsOn: "2026-11-16" })).toBe("2026-11-16");
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-15", endsOn: "2026-11-16" })).toBe("2026-11-16");
  });

  it("Ends the organiser typed first stays unless the new Start would pass it", () => {
    expect(endsOnAfterStartChange({ prevStart: "", nextStart: "2026-11-10", endsOn: "2026-11-16" })).toBe("2026-11-16");
    expect(endsOnAfterStartChange({ prevStart: "", nextStart: "2026-11-20", endsOn: "2026-11-16" })).toBe("2026-11-20");
  });

  it("a Start that moves past a longer event drags Ends with it rather than leave Ends before Start", () => {
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "2026-11-30", endsOn: "2026-11-16" })).toBe("2026-11-30");
  });

  it("clearing Start leaves Ends alone, including an empty one", () => {
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "", endsOn: "2026-11-14" })).toBe("2026-11-14");
    expect(endsOnAfterStartChange({ prevStart: "2026-11-14", nextStart: "", endsOn: "" })).toBe("");
  });
});

describe("createBlocker", () => {
  const ok = { name: "Autumn Open", startsOn: "2026-11-14", endsOn: "2026-11-15" };

  it("is null when nothing is missing", () => {
    expect(createBlocker(ok)).toBeNull();
    // Start is optional.
    expect(createBlocker({ ...ok, startsOn: "" })).toBeNull();
    // Same-day event.
    expect(createBlocker({ ...ok, endsOn: "2026-11-14" })).toBeNull();
  });

  it("names exactly what is missing — each field alone, then both", () => {
    expect(createBlocker({ ...ok, name: "" })).toBe("name");
    expect(createBlocker({ ...ok, endsOn: "" })).toBe("endsOn");
    expect(createBlocker({ ...ok, name: "", endsOn: "" })).toBe("both");
  });

  it("a name of spaces is no name", () => {
    expect(createBlocker({ ...ok, name: "   " })).toBe("name");
  });

  it("an End before the Start is its own reason, and only once both are present", () => {
    expect(createBlocker({ ...ok, endsOn: "2026-11-13" })).toBe("order");
    // A missing field outranks the order: there is no End to compare yet.
    expect(createBlocker({ ...ok, name: "", endsOn: "2026-11-13" })).toBe("name");
    expect(createBlocker({ ...ok, startsOn: "", endsOn: "2026-11-13" })).toBeNull();
  });
});
