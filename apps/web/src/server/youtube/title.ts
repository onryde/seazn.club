// server/youtube/title.ts — a YouTube broadcast's title and description (spec §6.5, plan P11). Pure: the words (`vs`, `tbd`,
// the description's line) arrive already in the org's default locale; prepare.ts looks them up.
//
// YouTube's rules (developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert, re-read 2026-10-28 for T10):
//   - snippet.title: "must be between 1 and 100 characters long" (`invalidTitle`); the videos resource's title — a broadcast
//     is one video — may hold any UTF-8 character "except < and >". Counted in CODE POINTS (Array.from), as the fake and
//     the live driver count it, so an emoji is one character and a cut never splits a surrogate pair.
//   - snippet.description: up to 5000 characters, and the same "< and >" rule. One line plus a URL is far inside that.
// Shape: `<Home> v <Away> · <Division> · <Competition>`. Over the limit, the COMPETITION gives way first (cut with an ellipsis,
// or dropped when too little of it would show), then the division, and only then the match itself.

/** YouTube's title limit (liveBroadcasts.insert `invalidTitle`). */
const TITLE_MAX_CHARS = 100;
const SEP = " · ";
const ELLIPSIS = "…";
/** A cut part keeps at least this many of its own characters before the ellipsis, or it is dropped: "C…" says nothing. */
const MIN_KEPT_CHARS = 3;

const chars = (s: string): string[] => Array.from(s);
const length = (s: string): number => chars(s).length;

/** No `<` or `>` (YouTube refuses both), and no run of whitespace, leading or trailing. */
const clean = (s: string | null): string => (s ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

/** `s` in at most `room` code points: whole when it fits, else its beginning plus an ellipsis — or null when fewer than
 *  MIN_KEPT_CHARS of it would show. */
function fit(s: string, room: number): string | null {
  if (length(s) <= room) return s;
  const keep = room - 1;
  if (keep < MIN_KEPT_CHARS) return null;
  return chars(s).slice(0, keep).join("").trimEnd() + ELLIPSIS;
}

export function broadcastTitle(a: {
  home: string | null; away: string | null; division: string; competition: string; vs: string; tbd: string;
}): string {
  const tbd = clean(a.tbd);
  const match = `${clean(a.home) || tbd} ${clean(a.vs)} ${clean(a.away) || tbd}`;
  const division = clean(a.division);
  const competition = clean(a.competition);

  const join = (...parts: string[]) => parts.filter((p) => p !== "").join(SEP);
  const full = join(match, division, competition);
  if (length(full) <= TITLE_MAX_CHARS) return full;

  // 1. The competition gives way first.
  const head = join(match, division);
  if (length(head) <= TITLE_MAX_CHARS) {
    const cut = competition === "" ? null : fit(competition, TITLE_MAX_CHARS - length(head) - SEP.length);
    return cut === null ? head : join(head, cut);
  }
  // 2. Then the division.
  if (length(match) <= TITLE_MAX_CHARS) {
    const cut = division === "" ? null : fit(division, TITLE_MAX_CHARS - length(match) - SEP.length);
    return cut === null ? match : join(match, cut);
  }
  // 3. The match alone is over the limit: cut it.
  return fit(match, TITLE_MAX_CHARS) ?? chars(match).slice(0, TITLE_MAX_CHARS).join("");
}

/** One line, then the public match URL, both without `<` or `>`. */
export function broadcastDescription(a: { line: string; matchUrl: string }): string {
  return `${clean(a.line)} ${a.matchUrl.replace(/[<>]/g, "")}`;
}
