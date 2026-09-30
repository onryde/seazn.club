// Which sports the pad path covers, and which W1c task owes each of the others
// (W1c Task 7). This is a leaf with no imports: run.ts plans `--set pad-proof` and
// the PADPROOF scenario defers an uncovered sport from it, and neither of them
// may reach lib/pads, which is the browser layer (boundary.test.ts). The adapters
// themselves live in lib/pads/index.ts. pad-adapters.test.ts pins
// PAD_SPORTS === Object.keys(PAD_ADAPTERS), so a sport registered in one place
// and not the other reds there.

/** The sports with a pad adapter, in SPORT_KEYS order (the registry's wave
 *  order, never re-sorted; AGENTS class 18). Grows T7→T11 alongside PAD_ADAPTERS. */
export const PAD_SPORTS: readonly string[] = Object.freeze(["football", "generic", "volleyball", "badminton", "tabletennis", "tennis", "icehockey", "hockey"]);

/** Every other sport → the W1c task that owes its adapter (plan, Tasks 9–11).
 *  A sport moves from here to PAD_SPORTS when its adapter lands. */
export const PAD_OWNER: Readonly<Record<string, string>> = Object.freeze({
  cricket: "W1c Task 11",
  boardgame: "W1c Task 11",
  carrom: "W1c Task 11",
});

/** Why `sport` has no pad route yet. An uncovered sport that is also missing
 *  from PAD_OWNER still names a wave, so the ledger's exemption rule and the
 *  ⏳ rendering both read it. */
export function noPadReason(sport: string): string {
  return `no pad adapter for ${sport} yet → ${Object.hasOwn(PAD_OWNER, sport) ? PAD_OWNER[sport] : "W1c (no task owns it)"}`;
}
