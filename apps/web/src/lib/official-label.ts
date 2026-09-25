import type { MessageKey } from "@/lib/messages";

/**
 * The sport's official — "Umpire" / "Referee" / "Arbiter" / … — as a message
 * key, so it is said in the viewer's locale. The engine declares the label in
 * English on each module (`officialLabel.scorer`, doc 13 §1); interpolating
 * that into a translated sentence put English mid-sentence in every other
 * locale ("en tant que referee", scorer sheets T3 fix round 2).
 *
 * One row per registered sport; `official-label.test.ts` derives the list from
 * the engine's own `registerBuiltins`, so a new sport reds until it has a row,
 * and checks each en value against the engine's declared word.
 */
const OFFICIAL_LABEL_KEY: Partial<Record<string, MessageKey>> = {
  badminton: "sport.official.badminton",
  boardgame: "sport.official.boardgame",
  carrom: "sport.official.carrom",
  cricket: "sport.official.cricket",
  football: "sport.official.football",
  generic: "sport.official.generic",
  hockey: "sport.official.hockey",
  icehockey: "sport.official.icehockey",
  tabletennis: "sport.official.tabletennis",
  tennis: "sport.official.tennis",
  volleyball: "sport.official.volleyball",
};

/** An unknown sport gets the generic, localised "scorer" — never English. */
export function officialLabelKey(sportKey: string): MessageKey {
  // Own rows only: a sport key like "toString" must not reach the prototype.
  const key = Object.hasOwn(OFFICIAL_LABEL_KEY, sportKey) ? OFFICIAL_LABEL_KEY[sportKey] : undefined;
  return key ?? "sport.official.generic";
}
