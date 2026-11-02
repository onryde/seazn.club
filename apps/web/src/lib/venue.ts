// The playing area is called different things per sport — a football "pitch",
// a table-tennis "table", a badminton "court", a chess "board". Labels,
// placeholders and default names in the scheduling UI use the right word.

/** Every playing-area noun `venueNoun` can answer: a closed set, so a caller can key copy on it (Match Day's
 *  `matchDay.noun.<noun>`) and a new noun is a compile error at every exhaustive reader rather than a missing string. */
export const VENUE_NOUNS = ["court", "pitch", "table", "board", "rink"] as const;
export type VenueNoun = (typeof VENUE_NOUNS)[number];

const VENUE_BY_SPORT: Record<string, VenueNoun> = {
  football: "pitch",
  soccer: "pitch",
  cricket: "pitch",
  rugby: "pitch",
  hockey: "pitch",
  icehockey: "rink",
  tabletennis: "table",
  table_tennis: "table",
  "table-tennis": "table",
  badminton: "court",
  tennis: "court",
  squash: "court",
  padel: "court",
  basketball: "court",
  netball: "court",
  volleyball: "court",
  boardgame: "board",
  chess: "board",
  carrom: "board",
  draughts: "board",
  checkers: "board",
};

/** Singular playing-area noun for a sport (lowercase). Defaults to "court". */
export function venueNoun(sportKey?: string | null): VenueNoun {
  return VENUE_BY_SPORT[(sportKey ?? "").toLowerCase()] ?? "court";
}

/** Capitalised singular, e.g. "Pitch". */
export function venueLabel(sportKey?: string | null): string {
  const n = venueNoun(sportKey);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Plural of an already-capitalised venue word, e.g. "Pitch" → "Pitches".
 *
 *  The label copy used to be "{venue}s", which rendered "Pitchs" — and worse,
 *  every locale carried that same English rule, so es/fr/nl pluralised with an
 *  English "s" too. Pluralising here keeps it out of the translations.
 *
 *  Sibilant endings take -es; that covers "pitch" and every other noun this
 *  file can produce (rink, table, court, board). */
export function pluralizeVenue(label: string): string {
  return /(?:ch|sh|s|x|z)$/i.test(label) ? `${label}es` : `${label}s`;
}
