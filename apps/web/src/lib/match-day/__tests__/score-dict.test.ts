// Seazn-hosted video, Task 17 (the Task 15 review's m6): the dictionary slice the Match Day page hands its client island must carry the
// keys the Seazn player reads, in EVERY locale — `t()` returns the KEY NAME on a miss, so a slice that lacks them prints
// "seaznVideo.unavailable" where a sentence belongs (and `matchCentre.`/`forfeit.` alone, the slice before this task, lacked all four).
//
// Two halves, because each is blind to the other: the slice is proven on the real dictionaries, per locale; and the PAGE is proven to hand
// the island that slice (vitest here is `environment: "node"` and cannot render an async server page, so the join is a source read, and
// its mutation is `scoreDict={pickDictPrefixes(pub, ["matchCentre.", "forfeit."])}` put back).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { seaznVideoLabels } from "@/components/public-site/match-centre/seazn-video-labels";
import { MATCH_DAY_SCORE_DICT_PREFIXES, matchDayScoreDict } from "../score-dict";

const LOCALES: Record<string, Dict> = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl } as Record<string, Dict>;
/** The island's own keys, from `seaznVideoLabels`'s documented reads (seazn-video-labels.ts), typed here. */
const ISLAND_KEYS = ["seaznVideo.live", "seaznVideo.unavailable", "seaznVideo.part", "overlay.replay"];

describe("matchDayScoreDict: the slice the Match Day page hands the island", () => {
  it("every locale: the island's four keys are in the slice with that locale's own words, so no label reads as a key name", () => {
    let checked = 0;
    for (const [locale, full] of Object.entries(LOCALES)) {
      const slice = matchDayScoreDict(full);
      for (const key of ISLAND_KEYS) {
        expect(full[key], `PREMISE: ${locale} defines ${key}`).toEqual(expect.any(String));
        expect(slice[key], `${locale} ${key}`).toBe(full[key]);
        checked++;
      }
      const labels = seaznVideoLabels(slice);
      for (const [field, value] of Object.entries(labels)) {
        expect(value, `${locale} ${field}`).not.toMatch(/^(seaznVideo|overlay)\./);
      }
    }
    expect(checked, "anti-vacuity: 4 locales × 4 keys").toBe(16);
  });

  it("the slice is the four prefixes and nothing more: the overlay group stays on the server except the one exact key", () => {
    const slice = matchDayScoreDict(publicEn as Dict);
    const keys = Object.keys(slice);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k) => !MATCH_DAY_SCORE_DICT_PREFIXES.some((p) => k.startsWith(p)))).toEqual([]);
    expect(keys.filter((k) => k.startsWith("overlay."))).toEqual(["overlay.replay"]);
    expect(Object.keys(publicEn).filter((k) => k.startsWith("overlay.")).length, "PREMISE: the overlay group is wider than the one key").toBeGreaterThan(1);
  });
});

describe("the Match Day page hands the island that slice", () => {
  const page = readFileSync(resolve(__dirname, "../../../app/o/[orgSlug]/c/[compSlug]/match-day/page.tsx"), "utf8");
  it("scoreDict is matchDayScoreDict(pub) — and no longer the narrower matchCentre./forfeit. pick", () => {
    expect(page).toMatch(/scoreDict=\{matchDayScoreDict\(pub\)\}/);
    expect(page).toContain('import { matchDayScoreDict } from "@/lib/match-day/score-dict";');
    expect(page).not.toMatch(/scoreDict=\{pickDictPrefixes/);
    expect(page.match(/scoreDict=/g), "exactly one scoreDict prop on the page").toHaveLength(1);
  });
});
