import { describe, expect, it } from "vitest";
import { competitionMetaDescription, playerMetaDescription } from "@/lib/public-meta";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

// Task 12 changed this helper's signature: it no longer builds the English
// fallback sentence itself, it takes the one the PAGE resolved. The English
// literal below is therefore a test fixture and nothing more — production's
// copy is `landing.metaDescription`, in four locales, asserted by
// `server/public-site/__tests__/hub-dictionary.test.ts`.
const FALLBACK =
  "Live scores, standings and brackets for FIFA World Cup 2026 — hosted by FIFA on Seazn Club.";

describe("competitionMetaDescription", () => {
  it("uses the competition's own description, truncated to 160", () => {
    const long = "x".repeat(200);
    expect(competitionMetaDescription(long, FALLBACK)).toBe("x".repeat(160));
  });

  it("falls back to the caller's resolved sentence when the description is missing or blank", () => {
    for (const empty of [undefined, null, "", "   "]) {
      expect(competitionMetaDescription(empty, FALLBACK)).toBe(FALLBACK);
    }
  });

  // The fallback is a LOCALE's sentence now, so the helper must be indifferent
  // to which one it is handed. A helper that had kept any English of its own
  // — a prefix, a suffix, a " — " it assembled — would fail here while the
  // test above stayed green, because that test's fixture IS the English one.
  it("returns the caller's sentence verbatim, whatever language it is in", () => {
    const nl =
      "Live uitslagen, standen en toernooischema's van Autumn Cup — georganiseerd door Riverside SC op Seazn Club.";
    expect(competitionMetaDescription(null, nl)).toBe(nl);
  });

  // The 160-cap belongs to the organiser's OWN prose, which is free text of any
  // length. The fallback is dictionary copy the repo controls, and truncating
  // it would cut a translated sentence mid-word for the longest locale — so it
  // is returned whole. Pinned because "cap everything" is the obvious wrong
  // simplification of the branch above.
  it("does not truncate the fallback, only the organiser's own description", () => {
    const longFallback = "y".repeat(200);
    expect(competitionMetaDescription("   ", longFallback)).toBe(longFallback);
  });
});

describe("playerMetaDescription", () => {
  it("always yields supporting text for the player card", () => {
    expect(playerMetaDescription("A. Kannan", "Riverside Open", en)).toBe(
      "A. Kannan's player card at Riverside Open — appearances, results and stats on Seazn Club.",
    );
  });

  // Task 16: the sentence lives in `player.metaDescription` now, four locales.
  // A caller that passes the org's `public` dictionary gets that locale's
  // sentence. The dictionary is REQUIRED: the English default it had while the
  // player page was unwired is gone, so no caller can silently ship English to
  // a Spanish org (the page half: `players/[personId]/__tests__/page.test.tsx`).
  const DICTS = { en, es, fr, nl } as Record<string, Record<string, string>>;
  const expected = (d: Record<string, string>) =>
    d["player.metaDescription"]!.replace("{player}", "A. Kannan").replace(
      "{competition}",
      "Riverside Open",
    );

  it("premise: the key exists in all four locales, with both params, and es differs from en", () => {
    for (const [l, d] of Object.entries(DICTS)) {
      expect(d["player.metaDescription"], l).toContain("{player}");
      expect(d["player.metaDescription"], l).toContain("{competition}");
    }
    expect(expected(DICTS.es!)).not.toBe(expected(DICTS.en!));
  });

  for (const locale of ["en", "es", "fr", "nl"]) {
    it(`${locale}: equals that locale's dictionary sentence, interpolated`, () => {
      const d = DICTS[locale]!;
      const out = playerMetaDescription("A. Kannan", "Riverside Open", d);
      expect(out).toBe(expected(d));
      expect(out).not.toMatch(/\{\w+\}/);
    });
  }

  // The compile-time half. Never called: vitest does not typecheck, so what
  // holds this line is `tsc --noEmit`. If `dict` becomes optional again, the
  // directive below is unused and tsc reds with TS2578.
  it("a call without the dictionary does not compile", () => {
    const _missingDict = () =>
      // @ts-expect-error — `dict` is required: a caller must pass its org's dictionary.
      playerMetaDescription("A. Kannan", "Riverside Open");
    expect(typeof _missingDict).toBe("function");
  });
});
