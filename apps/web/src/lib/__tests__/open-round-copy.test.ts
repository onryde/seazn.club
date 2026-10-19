// T19 — every reason the Open round answers with has copy in every locale.
// Swept from the vocabulary's own lists, so a new reason with no copy reds.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LOCALES } from "@/lib/i18n-constants";
import {
  ONLINE_GAME_EXISTS_KEY,
  OPEN_ROUND_ALREADY_OPEN_KEY,
  OPEN_ROUND_INVITED_KEY,
  OPEN_ROUND_REFUSAL_KEYS,
  OPEN_ROUND_REFUSALS,
  OPEN_ROUND_SKIP_KEYS,
  OPEN_ROUND_SKIP_REASONS,
  RESEND_REFUSAL_KEYS,
} from "@/lib/open-round";

const DICTS: Record<(typeof LOCALES)[number], Record<string, string>> = { en, es, fr, nl };

describe("open-round copy", () => {
  it("every refusal, skip reason, already-open, online-game-exists, the resend refusals and the invited plural have copy in every locale", () => {
    const keys = [
      ...OPEN_ROUND_REFUSALS.map((r) => OPEN_ROUND_REFUSAL_KEYS[r]),
      ...OPEN_ROUND_SKIP_REASONS.map((r) => OPEN_ROUND_SKIP_KEYS[r]),
      OPEN_ROUND_ALREADY_OPEN_KEY,
      ONLINE_GAME_EXISTS_KEY,
      ...Object.values(RESEND_REFUSAL_KEYS),
      `${OPEN_ROUND_INVITED_KEY}.one`,
      `${OPEN_ROUND_INVITED_KEY}.other`,
    ];
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of keys) {
        const v = DICTS[loc][k];
        expect(typeof v === "string" && v.trim().length > 0, `${loc} ${k}`).toBe(true);
        checked++;
      }
      // The plural carries its count.
      expect(DICTS[loc][`${OPEN_ROUND_INVITED_KEY}.other`]).toContain("{count}");
    }
    expect(checked).toBe(LOCALES.length * (OPEN_ROUND_REFUSALS.length + OPEN_ROUND_SKIP_REASONS.length + 4 + 2));
    expect(Object.keys(RESEND_REFUSAL_KEYS)).toEqual(["WINDOW_CLOSED", "BOARD_HELD"]);
    expect(OPEN_ROUND_REFUSALS.length).toBeGreaterThan(0);
  });

  it("each reason has its OWN sentence (no two reasons share copy)", () => {
    for (const loc of LOCALES) {
      const texts = [
        ...OPEN_ROUND_REFUSALS.map((r) => DICTS[loc][OPEN_ROUND_REFUSAL_KEYS[r]]),
        ...OPEN_ROUND_SKIP_REASONS.map((r) => DICTS[loc][OPEN_ROUND_SKIP_KEYS[r]]),
        DICTS[loc][OPEN_ROUND_ALREADY_OPEN_KEY],
        DICTS[loc][ONLINE_GAME_EXISTS_KEY],
        ...Object.values(RESEND_REFUSAL_KEYS).map((k) => DICTS[loc][k]),
      ];
      expect(new Set(texts).size, loc).toBe(texts.length);
    }
  });
});
