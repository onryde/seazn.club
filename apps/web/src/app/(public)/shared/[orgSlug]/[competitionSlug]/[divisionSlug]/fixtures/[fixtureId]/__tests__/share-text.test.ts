// Task 14b (task-14-review.md OWED item 3) — `shareTextFor`'s two templates
// ("Follow it live:" for a not-yet-decided fixture, the decided sentence +
// "full-time" fallback for a decided one) were hardcoded English on the
// public fixture page, in every locale, on every render. `ShareButton`'s
// `text` prop never reaches rendered markup (it's read only inside a client
// `onClick` closure — see `share-button.tsx`), so a `renderToStaticMarkup`
// HTML-content assertion could not prove this string either way; this
// function is a plain, directly-testable extraction for exactly that
// reason (same convention as `fixture-subheading.ts`).
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { shareTextFor } from "../share-text";

describe("shareTextFor", () => {
  it("not decided (EN): invites the reader to follow it live", () => {
    expect(shareTextFor(false, "Home", "Away", "Open", "Test Comp", undefined, en as Dict)).toBe(
      "Home vs Away — Open, Test Comp. Follow it live:",
    );
  });

  it("not decided (FR): the French word appears, the English template does not", () => {
    const result = shareTextFor(false, "Home", "Away", "Open", "Test Comp", undefined, fr as Dict);
    expect(result).toBe("Home contre Away — Open, Test Comp. Suivez-le en direct :");
    expect(result).not.toContain("Follow it live");
    expect(result).not.toContain(" vs ");
  });

  it("decided with a real result (EN): the result slots into the template, no 'full-time' fallback", () => {
    expect(
      shareTextFor(true, "Home", "Away", "Open", "Test Comp", "2 – 1 — Home won", en as Dict),
    ).toBe("Home vs Away — 2 – 1 — Home won (Open, Test Comp)");
  });

  it("decided with NO result yet (EN) falls back to the localised full-time word", () => {
    expect(shareTextFor(true, "Home", "Away", "Open", "Test Comp", undefined, en as Dict)).toBe(
      "Home vs Away — full-time (Open, Test Comp)",
    );
  });

  it("decided with NO result yet (FR): the French fallback word appears, 'full-time' does not", () => {
    const result = shareTextFor(true, "Home", "Away", "Open", "Test Comp", undefined, fr as Dict);
    expect(result).toBe("Home contre Away — fin du match (Open, Test Comp)");
    expect(result).not.toContain("full-time");
  });
});
