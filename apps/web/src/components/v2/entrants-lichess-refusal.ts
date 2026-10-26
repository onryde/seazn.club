// The organiser's roster refusal for an online-play division, said in the organiser's own language. The server refuses a
// player with TWO different reasons (owner 2026-10-25: registration holds a player to the seat gate's bar):
//
//   LICHESS_LINK_REQUIRED       no Lichess link at all        -> the player links one
//   LICHESS_RECONSENT_REQUIRED  a link that cannot play       -> the player reconnects it
//
// Server messages are English-only by design, so a screen never shows `err.message` for these: it maps the code to
// localized copy. EVERY organiser screen that seats a player says it through this file (one wording per reason, a family of
// keys per screen), because the same two codes now come back from five more routes than the roster add:
//
//   * the entrants panel (add, replace a roster, sync a squad)  -> `lichessRefusalText`, naming the people the payload names;
//   * the registrant hub (approve, mark paid, promote)           -> `lichessRegistrantRefusalText`: the screen is already one
//     registrant's page, and that person may not exist as a person row yet, so it never names anyone;
//   * the CSV import                                             -> `lichessImportRefusalText`, naming the FILE ROWS: a CSV's
//     reader finds a player by row, and a player the file creates has no id to name.

/** The error code to its copy family: `<family>.one` / `.other` when the people can be named, `<family>.unnamed` when not. */
export const LICHESS_REFUSAL_FAMILY = {
  LICHESS_LINK_REQUIRED: "entrants.lichess.linkRequired",
  LICHESS_RECONSENT_REQUIRED: "entrants.lichess.reconnectRequired",
} as const;

export type LichessRefusalCode = keyof typeof LICHESS_REFUSAL_FAMILY;

/** A screen's copy: the error code to the key family it says it with. */
type LichessRefusalFamilies = Readonly<Record<LichessRefusalCode, string>>;

/** The registrant hub's wording: `<family>.unnamed` only (the page is the registrant's own, so nobody is ever named). */
export const REGISTRANT_LICHESS_FAMILY: LichessRefusalFamilies = {
  LICHESS_LINK_REQUIRED: "reg.hub.registrants.lichess.linkRequired",
  LICHESS_RECONSENT_REQUIRED: "reg.hub.registrants.lichess.reconnectRequired",
};

/** The import wizard's wording: `<family>.one` / `.other` name the rows, `<family>.unnamed` says it of the file. */
export const IMPORT_LICHESS_FAMILY: LichessRefusalFamilies = {
  LICHESS_LINK_REQUIRED: "import.lichess.linkRequired",
  LICHESS_RECONSENT_REQUIRED: "import.lichess.reconnectRequired",
};

export function isLichessRefusalCode(code: unknown): code is LichessRefusalCode {
  return typeof code === "string" && Object.hasOwn(LICHESS_REFUSAL_FAMILY, code);
}

export interface LichessRefusalDeps {
  /** A person id's display name, or undefined when the client does not know that person (an inline new player is created
   *  inside the refused request, so its id exists nowhere else). */
  nameOf: (personId: string) => string | undefined;
  /** Joins names the way the locale writes a list ("Ada, Bo and Cy"). */
  list: (names: string[]) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
  /** A plain key, for the nameless copy. */
  text: (key: string) => string;
}

/** `<family>.one` / `.other` for the labels, or `<family>.unnamed` when there is nobody to name. */
function say(family: string, labels: string[], deps: Pick<LichessRefusalDeps, "list" | "plural" | "text">): string {
  return labels.length > 0 ? deps.plural(family, labels.length, { players: deps.list(labels) }) : deps.text(`${family}.unnamed`);
}

/** The refusal's text, or null when `err` is not one of the two Lichess reasons (the caller keeps its own handling).
 *
 *  Names are all-or-nothing: if even one person in the payload cannot be named, the nameless copy is used, because a
 *  list that leaves someone out reads as if the others were the only problem. */
export function lichessRefusalText(err: { code?: string; extra?: Record<string, unknown> }, deps: LichessRefusalDeps): string | null {
  if (!isLichessRefusalCode(err.code)) return null;
  const family = LICHESS_REFUSAL_FAMILY[err.code];
  const ids = Array.isArray(err.extra?.person_ids) ? err.extra.person_ids.filter((x): x is string => typeof x === "string") : [];
  const names = ids.map((id) => deps.nameOf(id));
  return say(family, ids.length > 0 && names.every((n): n is string => n !== undefined && n !== "") ? (names as string[]) : [], deps);
}

/** The registrant hub's refusal: the nameless copy of the reason (that page is one registrant's own), or null when `err` is not
 *  one of the two Lichess reasons. */
export function lichessRegistrantRefusalText(err: { code?: string }, text: (key: string) => string): string | null {
  return isLichessRefusalCode(err.code) ? text(`${REGISTRANT_LICHESS_FAMILY[err.code]}.unnamed`) : null;
}

/** The import's refusal: the whole commit was refused and the payload names the FILE ROWS (`extra.rows`, the same numbers the
 *  preview's issue list calls "Row n"). Null when `err` is not a Lichess reason. */
export function lichessImportRefusalText(
  err: { code?: string; extra?: Record<string, unknown> },
  deps: Pick<LichessRefusalDeps, "list" | "plural" | "text">,
): string | null {
  if (!isLichessRefusalCode(err.code)) return null;
  const rows = Array.isArray(err.extra?.rows) ? err.extra.rows.filter((n): n is number => Number.isInteger(n)) : [];
  return say(IMPORT_LICHESS_FAMILY[err.code], rows.map(String), deps);
}
