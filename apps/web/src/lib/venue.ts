// The playing area is called different things per sport — a football "pitch",
// a table-tennis "table", a badminton "court", a chess "board". Labels,
// placeholders and default names in the scheduling UI use the right word.
//
// `venueNoun`/`venueLabel`/`pluralizeVenue` answer in ENGLISH (the closed noun set, server-side keys, the schedule
// page's `venueCap` prop). UI copy that a reader sees in fr/es/nl goes through `venueWords`, which reads the noun from
// the dictionary (`venue.noun.<noun>.singular|plural`).
import type { MessageKey } from "@/lib/messages";

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
 *  ENGLISH ONLY. The label copy used to be "{venue}s", which rendered "Pitchs" — and worse,
 *  every locale carried that same English rule, so es/fr/nl pluralised with an
 *  English "s" too. Pluralising here keeps it out of the translations.
 *
 *  Sibilant endings take -es; that covers "pitch" and every other noun this
 *  file can produce (rink, table, court, board).
 *
 *  UI that reads in the reader's language uses `venueWords` below instead: its
 *  plural is a dictionary entry per locale, not this English rule. */
export function pluralizeVenue(label: string): string {
  return /(?:ch|sh|s|x|z)$/i.test(label) ? `${label}es` : `${label}s`;
}

/** The English capitalised label the board components still receive as `venueCap` (the schedule page's
 *  `venueLabel(sport)`), mapped back onto the closed noun set. A label that is not a noun - a stale "Field", an empty
 *  string, an inherited property name like "constructor" - reads the court, which is `venueNoun`'s own default. */
export function venueNounOf(label?: string | null): VenueNoun {
  const lower = (label ?? "").toLowerCase();
  return (VENUE_NOUNS as readonly string[]).includes(lower) ? (lower as VenueNoun) : "court";
}

/** The `useMsg()` shape (and `msgFor`/`t` bound to a dictionary): this module takes it as an argument so it stays
 *  importable server-side, where the match-day usecases already use `venueNoun`. */
export type VenueMsg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** A playing-area noun in the reader's language. */
export interface VenueWords {
  /** "court", "terrain", "veld": lowercase, as it reads mid-sentence. */
  singular: string;
  /** "courts", "terrains", "velden". */
  plural: string;
  /** "Court", "Terrain", "Veld": as a heading or a field label. */
  singularCap: string;
  /** "Courts", "Terrains", "Velden". */
  pluralCap: string;
}

// One dictionary entry per noun per form: a new noun is a compile error here, and a misspelt key is a compile error
// against `MessageKey`. The entries hold the CAPITALISED form, because upper-casing a first letter is not always the
// locale's rule ("IJsbaan", not "Ijsbaan"); lowercasing is.
const SINGULAR: Record<VenueNoun, MessageKey> = {
  court: "venue.noun.court.singular",
  pitch: "venue.noun.pitch.singular",
  table: "venue.noun.table.singular",
  board: "venue.noun.board.singular",
  rink: "venue.noun.rink.singular",
};
const PLURAL: Record<VenueNoun, MessageKey> = {
  court: "venue.noun.court.plural",
  pitch: "venue.noun.pitch.plural",
  table: "venue.noun.table.plural",
  board: "venue.noun.board.plural",
  rink: "venue.noun.rink.plural",
};

/** The msg-aware twin of `venueNoun` + `venueLabel` + `pluralizeVenue`: the noun's four spellings in the active locale.
 *  Dictionary-backed, so Dutch reads "veld"/"velden" where the English helpers answer "pitch"/"Pitches". */
export function venueWords(msg: VenueMsg, noun: VenueNoun): VenueWords {
  const singularCap = msg(SINGULAR[noun]);
  const pluralCap = msg(PLURAL[noun]);
  return { singular: singularCap.toLowerCase(), plural: pluralCap.toLowerCase(), singularCap, pluralCap };
}
