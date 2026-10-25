// The organiser's roster refusal for an online-play division, said in the organiser's own language. The server refuses a
// player with TWO different reasons (owner 2026-10-25: registration holds a player to the seat gate's bar):
//
//   LICHESS_LINK_REQUIRED       no Lichess link at all        -> the player links one
//   LICHESS_RECONSENT_REQUIRED  a link that cannot play       -> the player reconnects it
//
// Server messages are English-only by design, so the panel never shows `err.message` for these: it maps the code to
// localized copy and names the people the payload names (`extra.person_ids`, exactly the people that reason is true of).

/** The error code to its copy family: `<family>.one` / `.other` when the people can be named, `<family>.unnamed` when not. */
export const LICHESS_REFUSAL_FAMILY = {
  LICHESS_LINK_REQUIRED: "entrants.lichess.linkRequired",
  LICHESS_RECONSENT_REQUIRED: "entrants.lichess.reconnectRequired",
} as const;

export type LichessRefusalCode = keyof typeof LICHESS_REFUSAL_FAMILY;

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

/** The refusal's text, or null when `err` is not one of the two Lichess reasons (the caller keeps its own handling).
 *
 *  Names are all-or-nothing: if even one person in the payload cannot be named, the nameless copy is used, because a
 *  list that leaves someone out reads as if the others were the only problem. */
export function lichessRefusalText(err: { code?: string; extra?: Record<string, unknown> }, deps: LichessRefusalDeps): string | null {
  if (!isLichessRefusalCode(err.code)) return null;
  const family = LICHESS_REFUSAL_FAMILY[err.code];
  const ids = Array.isArray(err.extra?.person_ids) ? err.extra.person_ids.filter((x): x is string => typeof x === "string") : [];
  const names = ids.map((id) => deps.nameOf(id));
  if (ids.length > 0 && names.every((n): n is string => n !== undefined && n !== "")) {
    return deps.plural(family, names.length, { players: deps.list(names as string[]) });
  }
  return deps.text(`${family}.unnamed`);
}
