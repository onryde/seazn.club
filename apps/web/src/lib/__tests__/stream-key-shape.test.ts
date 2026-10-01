// The key-shape warning (spec 2026-09-30 §4). It WARNS and never blocks — its job is the staging incident, a key's
// NAME ("TestYouTube") saved where the key belongs. Platform coverage is derived from STREAM_PLATFORMS (the create
// allowlist, D6), never a list typed here; the per-platform cases are the spec's own regexes' edges.
import { describe, expect, it } from "vitest";
import { STREAM_PLATFORMS } from "@/lib/stream-destinations";
import { KEY_SHAPES, keyShapeWarning } from "../stream-key-shape";

describe("keyShapeWarning — warns, never blocks (spec §4)", () => {
  it("every platform has a shape and a warning key of its own", () => {
    expect(Object.keys(KEY_SHAPES).sort()).toEqual([...STREAM_PLATFORMS].sort());
    let checked = 0;
    for (const p of STREAM_PLATFORMS) {
      expect(keyShapeWarning(p, "TestKeyName"), p).toBe(`streamDest.shape.${p}`);
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("YouTube: 4 or 5 groups of 4, case-insensitive, pass; the staging key NAME and the wrong group counts warn", () => {
    for (const ok of ["abcd-1234-efgh-5678", "abcd-1234-efgh-5678-ijkl", "ABCD-1234-EFGH-5678-IJKL"]) expect(keyShapeWarning("youtube", ok), ok).toBeNull();
    for (const bad of ["TestYouTube", "abcd-1234-efgh", "abcd-1234-efgh-5678-ijkl-mnop", "abcd_1234_efgh_5678", "abc-1234-efgh-5678"]) {
      expect(keyShapeWarning("youtube", bad), bad).toBe("streamDest.shape.youtube");
    }
  });

  it("Twitch: live_<digits>_<20+ alphanumerics> passes; 19 characters, a missing prefix and the key name warn", () => {
    const twenty = "AbCdEfGhIjKlMnOpQrSt";
    expect(twenty).toHaveLength(20);
    expect(keyShapeWarning("twitch", `live_123456789_${twenty}`)).toBeNull();
    for (const bad of [`live_123456789_${twenty.slice(1)}`, `123456789_${twenty}`, "TestTwitch", `live_abc_${twenty}`]) {
      expect(keyShapeWarning("twitch", bad), bad).toBe("streamDest.shape.twitch");
    }
  });

  it("a key right for ONE platform warns on the other — the check is per platform, not 'any known shape'", () => {
    expect(keyShapeWarning("youtube", "abcd-1234-efgh-5678-ijkl")).toBeNull();
    expect(keyShapeWarning("twitch", "abcd-1234-efgh-5678-ijkl")).toBe("streamDest.shape.twitch");
    expect(keyShapeWarning("twitch", "live_123456789_AbCdEfGhIjKlMnOpQrSt")).toBeNull();
    expect(keyShapeWarning("youtube", "live_123456789_AbCdEfGhIjKlMnOpQrSt")).toBe("streamDest.shape.youtube");
  });

  it("an empty or whitespace-only key has no warning yet (the field is simply unfinished); surrounding whitespace is ignored", () => {
    expect(keyShapeWarning("youtube", "")).toBeNull();
    expect(keyShapeWarning("youtube", "   ")).toBeNull();
    expect(keyShapeWarning("youtube", "  abcd-1234-efgh-5678\n")).toBeNull();
    expect(keyShapeWarning("twitch", "\tlive_123456789_AbCdEfGhIjKlMnOpQrSt ")).toBeNull();
  });
});
