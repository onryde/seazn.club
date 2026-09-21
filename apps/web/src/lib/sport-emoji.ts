// The sport glyph, in ONE place.
//
// There were two maps before this file — `components/discovery-cards.tsx` and
// `components/onboarding-wizard.tsx` — and they had already drifted: discovery
// knew Carrom was 🎯, onboarding did not, so the same sport wore a different
// face on two screens. Neither knew Hockey, Ice Hockey or Tennis at all, and
// the fallback is the generic medal, so a NEW customer's first screen showed
// five identical 🏅 tiles (F8, seen on the live onboarding wizard 2026-09-21).
//
// The catalog this must cover is the `sports` table, which `sync:sports` seeds:
// badminton, boardgame, carrom, cricket, football, generic, hockey, icehockey,
// tabletennis, tennis, volleyball. `__tests__/sport-emoji.test.ts` reads that
// seed and reds when a sport is added without a glyph — the map cannot quietly
// fall behind the catalog again.
//
// `generic` keeps the medal on purpose: it is the catch-all sport, and a medal
// is what "some competition" looks like. It is the one tile that SHOULD wear
// the fallback.
export const SPORT_EMOJI: Record<string, string> = {
  badminton: "🏸",
  boardgame: "♟️",
  carrom: "🎯",
  cricket: "🏏",
  football: "⚽",
  generic: "🏅",
  hockey: "🏑",
  icehockey: "🏒",
  tabletennis: "🏓",
  tennis: "🎾",
  volleyball: "🏐",
};

/** The glyph for a sport key; the generic medal for anything unknown. */
export function sportEmoji(key: string | null | undefined): string {
  return SPORT_EMOJI[key ?? "generic"] ?? SPORT_EMOJI.generic!;
}
