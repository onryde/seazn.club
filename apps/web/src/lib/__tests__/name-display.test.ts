// Youth privacy (v3/11 gap 8): public surfaces render "Arun K." instead of
// the full name when a division's player_name_display resolves first_initial.
import { describe, expect, it } from "vitest";
import {
  anyOptedOut,
  maskDisplayName,
  resolveNameDisplay,
  resolvePersonDisplayName,
} from "@/lib/name-display";

describe("resolveNameDisplay", () => {
  it("explicit setting wins", () => {
    expect(resolveNameDisplay("full", true)).toBe("full");
    expect(resolveNameDisplay("first_initial", false)).toBe("first_initial");
  });

  it("defaults by youth flag when unset", () => {
    expect(resolveNameDisplay(null, true)).toBe("first_initial");
    expect(resolveNameDisplay(null, false)).toBe("full");
  });
});

describe("maskDisplayName", () => {
  it("keeps full names in full mode", () => {
    expect(maskDisplayName("Arun Kumar", "full")).toBe("Arun Kumar");
  });

  it("renders first name + last initial in first_initial mode", () => {
    expect(maskDisplayName("Arun Kumar", "first_initial")).toBe("Arun K.");
    expect(maskDisplayName("Mary Jane Watson", "first_initial")).toBe("Mary W.");
  });

  it("leaves single-word names alone (nothing to initialise)", () => {
    expect(maskDisplayName("Arun", "first_initial")).toBe("Arun");
  });

  it("handles pair names joined with & or /", () => {
    expect(maskDisplayName("Arun Kumar & Dev Patel", "first_initial")).toBe("Arun K. & Dev P.");
    expect(maskDisplayName("Arun Kumar / Dev Patel", "first_initial")).toBe("Arun K. / Dev P.");
  });

  it("tolerates whitespace junk", () => {
    expect(maskDisplayName("  Arun   Kumar  ", "first_initial")).toBe("Arun K.");
  });
});

// RS008 — the resolver both axes (division youth policy AND the person's own
// consent opt-out) must go through, stricter wins. Full matrix: {consent
// true/false/absent} × {division full/first_initial/null-with-youth-true/
// null-with-youth-false}.
describe("resolvePersonDisplayName (RS008 — consent + youth, stricter wins)", () => {
  const FULL = "full";
  const FIRST_INITIAL = "first_initial";

  it("consent true, division full → full name", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: true }, FULL, false)).toBe("Arun Kumar");
  });

  it("consent true, division first_initial → masked (division wins)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: true }, FIRST_INITIAL, false)).toBe("Arun K.");
  });

  it("consent true, null setting + youth true → masked (youth default)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: true }, null, true)).toBe("Arun K.");
  });

  it("consent true, null setting + youth false → full", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: true }, null, false)).toBe("Arun Kumar");
  });

  it("consent false, division full → masked (consent wins)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: false }, FULL, false)).toBe("Arun K.");
  });

  it("consent false, division first_initial → masked (both agree)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: false }, FIRST_INITIAL, false)).toBe("Arun K.");
  });

  it("consent false, null setting + youth true → masked (both agree)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: false }, null, true)).toBe("Arun K.");
  });

  it("consent false, null setting + youth false → masked (consent wins over the adult default)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", { public_name: false }, null, false)).toBe("Arun K.");
  });

  it("consent absent (undefined), division full → full (absent is NOT opted out)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", undefined, FULL, false)).toBe("Arun Kumar");
  });

  it("consent null, division full → full (null is NOT opted out)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", null, FULL, false)).toBe("Arun Kumar");
  });

  it("consent {} (no explicit false), division full → full — RS007's default must never need backfilling", () => {
    expect(resolvePersonDisplayName("Arun Kumar", {}, FULL, false)).toBe("Arun Kumar");
  });

  it("consent absent, division first_initial → masked (division alone is enough)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", undefined, FIRST_INITIAL, false)).toBe("Arun K.");
  });

  it("consent absent, null setting + youth true → masked (youth alone is enough)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", undefined, null, true)).toBe("Arun K.");
  });

  it("consent absent, null setting + youth false → full (neither axis fires)", () => {
    expect(resolvePersonDisplayName("Arun Kumar", undefined, null, false)).toBe("Arun Kumar");
  });

  it("a pair-style compound name still masks each side when opted out", () => {
    expect(resolvePersonDisplayName("Arun Kumar & Dev Patel", { public_name: false }, FULL, false)).toBe(
      "Arun K. & Dev P.",
    );
  });
});

describe("anyOptedOut (RS008 — multi-person display_name aggregation)", () => {
  it("false for an empty list", () => {
    expect(anyOptedOut([])).toBe(false);
  });

  it("false when every consent is true, absent, null, or {}", () => {
    expect(anyOptedOut([{ public_name: true }, undefined, null, {}])).toBe(false);
  });

  it("true when exactly one of several has explicitly opted out", () => {
    expect(anyOptedOut([{ public_name: true }, { public_name: false }])).toBe(true);
  });

  it("true when a lone entry has opted out", () => {
    expect(anyOptedOut([{ public_name: false }])).toBe(true);
  });
});
