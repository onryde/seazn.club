// Match Day — the page's pure reading of the read model (spec 2026-10-31-match-day-design.md §6, §7, task A3): the header's
// counts and noun, the division filter, what a candidate row says about where it waits, and a refusal in organiser words.
// Client-safe and DOM-free, so the node-environment suite reaches every decision the components make.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { fmtPublicTime } from "@/lib/format";
import { venueNoun, type VenueNoun } from "@/lib/venue";
import { scoreLevels, type ScoreLevels } from "@/lib/score/levels";
import type { Attention, Severity } from "@/lib/division-phase";
import { mayEmbedReplay, youtubeVideoId, type PublicReplayPart } from "@/lib/youtube";
import { needsYouKey } from "@/components/v2/desk/needs-you";
import { CALL_REFUSAL, TBD_ENTRANT, type CallWarning } from "./call";
import type {
  CourtClosure,
  MatchDayCandidate,
  MatchDayCourt,
  MatchDayFindCourt,
  MatchDayFixture,
  MatchDayView,
  NeedsYouItem,
  ScorerAttention,
} from "./types";

/**
 * A playing match's score as Match Day shows it (spec §6.2 "games or sets won in large type, current points beside them";
 * review V3/V4; task B3). A set sport — the engine's summary carries a set table and a count of sets won per side — reads as its
 * levels (`scoreLevels`, lib/score/levels.ts): the sets or games WON, tennis's games in the set in play between them and the
 * live points, and nothing of a finished set's score. Any other sport reads as its own headline, whole. Null before the engine
 * has published one.
 *
 * The levels are read off the summary's structure, never its headline: a tie-break's "7–6(3)" ends a headline the way a game's
 * live points do, and only the structure says which is which.
 */
export type ScoreLine = { kind: "sets"; levels: ScoreLevels } | { kind: "plain"; text: string };

export function scoreLine(f: Pick<MatchDayFixture, "summary">): ScoreLine | null {
  const s = f.summary;
  if (s === null || !s.headline) return null;
  const levels = scoreLevels(s);
  return levels === null ? { kind: "plain", text: s.headline } : { kind: "sets", levels };
}

/** The court list's one-line form of `scoreLine`: "0–1 · 12–10" for a set sport, "1–0 · 3–2 · 40–30" for tennis (sets · games ·
 *  points), the sport's own headline otherwise. */
export function compactScore(line: ScoreLine): string {
  if (line.kind === "plain") return line.text;
  const { won, mid, live } = line.levels;
  return [`${won[0]}–${won[1]}`, ...(mid === null ? [] : [`${mid[0]}–${mid[1]}`]), ...(live === null ? [] : [live.label])].join(" · ");
}

/** The v1 envelope's optimistic-concurrency refusal (api-v1/http.ts): a call or undo that raced another schedule write. */
export const SEQ_CONFLICT = "SEQ_CONFLICT";

/** The noun the header and the phone's back link use for the courts as a set: theirs when every court shares one (a football
 *  day reads "pitches"), else "court" — `venueNoun`'s own default. An empty list has no noun of its own either. */
export function sharedNoun(courts: readonly Pick<MatchDayCourt, "sport_noun">[]): VenueNoun {
  const first = courts[0]?.sport_noun;
  if (first === undefined) return "court";
  return courts.every((c) => c.sport_noun === first) ? first : "court";
}

export interface CourtCounts {
  courts: number;
  playing: number;
  free: number;
}

/** "N courts · N playing · N free" (§6.3). Called and in-use courts count as courts, neither playing nor free. */
export function courtCounts(courts: readonly Pick<MatchDayCourt, "state">[]): CourtCounts {
  let playing = 0;
  let free = 0;
  for (const c of courts) {
    if (c.state === "playing") playing++;
    else if (c.state === "free") free++;
  }
  return { courts: courts.length, playing, free };
}

/** Whether anything on the page is moving: a match playing or called — on a court, or playing on none (B4). Decides the poll's
 *  cadence (band-poll.ts). */
export function isLive(view: Pick<MatchDayView, "courts" | "playing_no_court">): boolean {
  return view.playing_no_court.length > 0 || view.courts.some((c) => c.state === "playing" || c.state === "called");
}

/** The noun for the matches playing on NO court as a group (B4 fix round 1, R3): their sports' word when they share one (an
 *  online chess day: "board"), else "court" — `venueNoun`'s default, as `sharedNoun` reads the courts. */
export function noCourtNoun(fixtures: readonly Pick<MatchDayFixture, "sport_key">[]): VenueNoun {
  const nouns = fixtures.map((f) => venueNoun(f.sport_key));
  const first = nouns[0];
  if (first === undefined) return "court";
  return nouns.every((n) => n === first) ? first : "court";
}

/** The header's counts line (§6.3, B4): "N courts · N playing · N free", then the matches playing on no court when there are
 *  any ("1 match with no court", in their sports' word: `noCourtNoun`). With no courts at all the court words say nothing —
 *  "0 playing · 0 free" — so the line is the no-court count alone, or "0 courts" when there is nothing either (the empty page). */
export function headerCountParts(
  dict: Dict,
  locale: Locale,
  noun: VenueNoun,
  courts: readonly Pick<MatchDayCourt, "state">[],
  noCourt: readonly Pick<MatchDayFixture, "sport_key">[],
): string[] {
  const counts = courtCounts(courts);
  const noCourtPart =
    noCourt.length > 0 ? [plural(dict, `matchDay.header.noCourt.${noCourtNoun(noCourt)}`, noCourt.length, locale)] : [];
  if (counts.courts === 0) return noCourtPart.length > 0 ? noCourtPart : [plural(dict, `matchDay.header.places.${noun}`, 0, locale)];
  return [
    plural(dict, `matchDay.header.places.${noun}`, counts.courts, locale),
    t(dict, "matchDay.header.playing", { count: counts.playing }),
    t(dict, "matchDay.header.free", { count: counts.free }),
    ...noCourtPart,
  ];
}

/** The division filter (§6.3): `null` is every division, the default. Otherwise it narrows each court's queue to the chosen
 *  divisions and keeps a court only when it is free (a free court is where a chosen division's match can be called), or its
 *  current match or something in its queue is a chosen division's. A court busy with another division's match, and nothing
 *  of the chosen divisions waiting on it, is not the filtered desk's business. */
export function filterCourts(courts: readonly MatchDayCourt[], divisions: ReadonlySet<string> | null): MatchDayCourt[] {
  if (divisions === null) return [...courts];
  const out: MatchDayCourt[] = [];
  for (const c of courts) {
    const queue = c.queue.filter((q) => divisions.has(q.division_id));
    const mine = c.current !== null && divisions.has(c.current.division_id);
    if (c.state === "free" || mine || queue.length > 0) out.push({ ...c, queue });
  }
  return out;
}

// ---- The court list's order and its fold (Match Day E2 item 2) -----------------------------------------------------------

/** The court list's groups, in the order they are listed (owner 2026-11-01): what is on now, then what is about to be, then what
 *  nobody has — so the list opens on the courts that need attention and the empty ones are the tail.
 *  - playing, then called: the court's state;
 *  - up_next: a FREE court with a queue of this competition's matches — nothing on it, something waiting for it;
 *  - elsewhere: another competition has it (not free, so never folded into "free"; spec §7 "Which courts" — courts are shared);
 *  - free: a free court with an empty queue. */
export const COURT_GROUPS = ["playing", "called", "up_next", "elsewhere", "free"] as const;
export type CourtGroup = (typeof COURT_GROUPS)[number];

export function courtGroup(c: Pick<MatchDayCourt, "state" | "queue">): CourtGroup {
  switch (c.state) {
    case "playing":
      return "playing";
    case "called":
      return "called";
    case "in_use_elsewhere":
      return "elsewhere";
    case "free":
      return c.queue.length > 0 ? "up_next" : "free";
  }
}

/** The courts in list order: by group, and within a group in the order given (the server's court order, kept). A new array. */
export function orderCourts(courts: readonly MatchDayCourt[]): MatchDayCourt[] {
  const rank = new Map(COURT_GROUPS.map((g, i) => [g, i] as const));
  return courts
    .map((c, i) => ({ c, i, r: rank.get(courtGroup(c))! }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** A fold is worth a row only when it hides at least this many courts: "1 more court free (Court 5)" is longer than Court 5. */
export const MIN_FOLDED = 2;

/**
 * The list as drawn: `shown` (everything but the folded courts, in list order) and `folded` — the free courts with an empty
 * queue, in list order, which sit under ONE row ("5 more courts free (Courts 5–10)") that expands in place.
 *  - when EVERY court is free and empty there is nothing to rank them against: the list is shown whole (empty `folded`);
 *  - the court the organiser has open (`selectedId`) is never folded away from under them: it stays in `shown`;
 *  - fewer than `MIN_FOLDED` folded courts is no fold.
 * `courts` is already in list order (`orderCourts`).
 */
export function foldFreeCourts(
  courts: readonly MatchDayCourt[],
  selectedId: string | null,
): { shown: MatchDayCourt[]; folded: MatchDayCourt[] } {
  const foldable = (c: MatchDayCourt) => courtGroup(c) === "free";
  const whole = { shown: [...courts], folded: [] as MatchDayCourt[] };
  if (courts.every(foldable)) return whole;
  const folded = courts.filter((c) => foldable(c) && c.court_id !== selectedId);
  if (folded.length < MIN_FOLDED) return whole;
  const gone = new Set(folded.map((c) => c.court_id));
  return { shown: courts.filter((c) => !gone.has(c.court_id)), folded };
}

/**
 * The folded courts' names as a person writes them: runs of consecutive numbers under one word collapse to a range — "Courts
 * 5–10" — and anything else is listed by name ("Centre, Court 5–6, Court 9"). `singular` and `plural` are the sport's noun
 * ("Court", "Courts"): a run under exactly that word reads with the plural, a run under any other word ("Hall A 1–4") keeps its
 * own. Names arrive in list order and are never reordered.
 */
export function foldedNames(names: readonly string[], singular: string, plural: string): string {
  // `from`/`to` keep the digits as typed ("05") and the number they mean (05 + 1 = 6).
  type Run = { prefix: string; from: string; to: string; next: number; count: number; first: string };
  const runs: Run[] = [];
  for (const name of names) {
    const m = /^(.*\D)\s*(\d+)$/.exec(name.trim());
    if (m === null) {
      runs.push({ prefix: "", from: "", to: "", next: Number.NaN, count: 1, first: name });
      continue;
    }
    const prefix = m[1]!.trim();
    const last = runs[runs.length - 1];
    if (last !== undefined && last.prefix === prefix && last.next === Number(m[2])) {
      last.to = m[2]!;
      last.next = Number(m[2]) + 1;
      last.count++;
    } else runs.push({ prefix, from: m[2]!, to: m[2]!, next: Number(m[2]) + 1, count: 1, first: name });
  }
  return runs
    .map((r) => {
      if (r.count < 2) return r.first;
      const word = r.prefix.localeCompare(singular, undefined, { sensitivity: "base" }) === 0 ? plural : r.prefix;
      return `${word} ${r.from}–${r.to}`;
    })
    .join(", ");
}

// ---- The venue filter (Match Day E2 item 5) -------------------------------------------------------------------------------
// DISPLAY ONLY: it narrows which courts the page lists. Nothing a call is judged by reads it — a player busy on a court in a venue
// that is not listed still stops a call (match-day-call.ts looks at every court).

/** One venue in the filter: its courts on the board, and the noun they share (`sharedNoun`). */
export interface VenueOption {
  id: string;
  name: string;
  courts: number;
  noun: VenueNoun;
}

/** The venues the courts sit in, once each, in the order the courts come (the server lists them venue by venue). More than one is
 *  the condition for showing the filter at all. */
export function venueOptions(courts: readonly MatchDayCourt[]): VenueOption[] {
  const byId = new Map<string, { name: string; courts: MatchDayCourt[] }>();
  for (const c of courts) {
    const entry = byId.get(c.venue_id);
    if (entry === undefined) byId.set(c.venue_id, { name: c.venue_name, courts: [c] });
    else entry.courts.push(c);
  }
  return [...byId].map(([id, v]) => ({ id, name: v.name, courts: v.courts.length, noun: sharedNoun(v.courts) }));
}

/** `?venue=`: "all", a list of venue ids, or null when the URL makes no choice. A repeated key arrives as an array. */
export type VenueParam = "all" | string[] | null;

export function parseVenueParam(raw: string | readonly string[] | null | undefined): VenueParam {
  const parts = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
    .flatMap((r) => String(r).split(","))
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0]!.toLowerCase() === "all") return "all";
  return [...new Set(parts)];
}

/**
 * The venues selected when the page opens (owner 2026-11-01): the URL's choice if it names a venue on the board; else the venues
 * where this competition has a match today; else every venue. Ids that are not on the board are ignored, and a choice that leaves
 * none falls through to the next rule — a stale link never opens an empty page. The result holds only venues on the board (the
 * empty set only when there are no courts).
 */
export function initialVenueSelection(
  courts: readonly MatchDayCourt[],
  venuesToday: readonly string[],
  param: VenueParam,
): ReadonlySet<string> {
  const onBoard = venueOptions(courts).map((o) => o.id);
  const known = new Set(onBoard);
  if (param === "all") return known;
  const named = (param ?? []).filter((id) => known.has(id));
  if (named.length > 0) return new Set(named);
  const today = venuesToday.filter((id) => known.has(id));
  return today.length > 0 ? new Set(today) : known;
}

/** The courts of the selected venues (every venue selected keeps every court). A selection naming nothing on the board is no filter,
 *  rather than an empty page. */
export function filterByVenues(courts: readonly MatchDayCourt[], selected: ReadonlySet<string>): MatchDayCourt[] {
  const onBoard = new Set(courts.map((c) => c.venue_id));
  const effective = [...selected].filter((id) => onBoard.has(id));
  if (effective.length === 0) return [...courts];
  const keep = new Set(effective);
  return courts.filter((c) => keep.has(c.venue_id));
}

/** With exactly one venue selected the "(Venue)" the server added to a name two venues share is redundant: drop it. Only that
 *  court's OWN venue suffix goes. Anything else is returned as it was. */
export function scopeCourtNames(courts: readonly MatchDayCourt[], selected: ReadonlySet<string>): MatchDayCourt[] {
  const onBoard = new Set(courts.map((c) => c.venue_id));
  const effective = [...selected].filter((id) => onBoard.has(id));
  if (effective.length !== 1) return [...courts];
  return courts.map((c) => {
    const suffix = ` (${c.venue_name})`;
    return c.court_name.endsWith(suffix) && c.court_name.length > suffix.length
      ? { ...c, court_name: c.court_name.slice(0, -suffix.length) }
      : c;
  });
}

/** The `?venue=` value a selection writes: "all" when it covers every venue, else the ids in the venues' order. */
export function venueParamOf(selected: ReadonlySet<string>, options: readonly VenueOption[]): string {
  const chosen = options.filter((o) => selected.has(o.id));
  return chosen.length === options.length ? "all" : chosen.map((o) => o.id).join(",");
}

/** `href` with its `?venue=` replaced by `param` (the other parameters and the hash kept), as a path + query + hash for
 *  `history.replaceState`. */
export function withVenueParam(href: string, param: string): string {
  const url = new URL(href, "https://seazn.invalid");
  url.searchParams.set("venue", param);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The same filter on the "Playing, no court" group (B4): every match, or only the chosen divisions'. */
export function filterNoCourt(fixtures: readonly MatchDayFixture[], divisions: ReadonlySet<string> | null): MatchDayFixture[] {
  return divisions === null ? [...fixtures] : fixtures.filter((f) => divisions.has(f.division_id));
}

/** What the organiser opened: a court, or a match playing on no court (B4) — with its name, to say so if it leaves the list. */
export type Opened = { kind: "court" | "match"; id: string; name: string };

/** What is focused (§6.1, review M6): what the organiser opened while it is still on the list; none opened yet → the first
 *  court (the desktop's default), else the first match playing on no court (B4: a day with no courts at all); what was opened
 *  gone from the list (the filter dropped it, the day moved on, the match ended) → `lost`, named — the page goes back to the
 *  list rather than silently showing something else. */
export type Focus =
  | { kind: "court"; court: MatchDayCourt }
  | { kind: "match"; fixture: MatchDayFixture }
  | { kind: "lost"; name: string }
  | { kind: "none" };

export function resolveFocus(
  courts: readonly MatchDayCourt[],
  noCourt: readonly MatchDayFixture[],
  opened: Opened | null,
): Focus {
  if (opened === null) {
    if (courts[0] !== undefined) return { kind: "court", court: courts[0] };
    return noCourt[0] === undefined ? { kind: "none" } : { kind: "match", fixture: noCourt[0] };
  }
  if (opened.kind === "match") {
    const fixture = noCourt.find((f) => f.id === opened.id);
    return fixture === undefined ? { kind: "lost", name: opened.name } : { kind: "match", fixture };
  }
  const court = courts.find((c) => c.court_id === opened.id);
  return court === undefined ? { kind: "lost", name: opened.name } : { kind: "court", court };
}

/** Where "Find a court" leads (B4 fix round 1, R2): Match Day opened on that court (`?court=`, the page's focus param), or the
 *  page itself when no usable court is free. One spelling for Needs you's link and the division run sheet's (B2). */
export function findCourtHref(matchDayHref: string, courtId: string | null): string {
  return courtId === null ? matchDayHref : `${matchDayHref}?court=${encodeURIComponent(courtId)}`;
}

/** Match Day's own Needs-you rows (B4, spec §9 carried; fix round 1, R2/R3): an `unscheduled` row opens the schedule board, as
 *  on the competition page, AND — only when its division has a ready match with no court (`findCourts`, read by the server:
 *  match-day.ts `findCourtsOf`) — "Find a court/pitch/table/board/rink" in its sport's word: the first free court one of those
 *  matches may be called onto, its candidates listing it, or the page itself when none is free. A division with no such match
 *  keeps the schedule board alone. Every other row is the desk's, unchanged. */
export function withFindCourt(
  dict: Dict,
  items: readonly NeedsYouItem[],
  findCourts: ReadonlyMap<string, MatchDayFindCourt>,
  matchDayHref: string,
): NeedsYouItem[] {
  const byKey = new Map([...findCourts].map(([divisionId, fc]) => [needsYouKey(divisionId, "unscheduled"), fc] as const));
  return items.map((it) => {
    const fc = it.kind === "unscheduled" ? byKey.get(it.key) : undefined;
    if (fc === undefined) return it;
    return {
      ...it,
      alt: { label: t(dict, `matchDay.needsYou.findCourt.${fc.noun}`), href: findCourtHref(matchDayHref, fc.court_id), court_id: fc.court_id },
    };
  });
}

/** How many candidates could start here NOW (§7, review I2): a blocked one cannot, so it is not counted. */
export function callableCount(candidates: readonly MatchDayCandidate[]): number {
  return candidates.filter((c) => c.blocked === null).length;
}

/** What a free court says when NOTHING could start on it now (Match Day E2 item 4): two different truths, so two messages.
 *  `listed` is how many candidates the court lists — all of them blocked, since none is callable.
 *  - none listed: nothing is waiting to be played here today;
 *  - some listed: they are waiting, but none can start yet, and each row says why. */
export function emptyCountText(dict: Dict, listed: number, locale: Locale): string {
  return listed === 0 ? t(dict, "matchDay.free.nothingWaiting") : plural(dict, "matchDay.free.allBlocked", listed, locale);
}

/** The one candidate whose call is the primary action (review V2): the top-ranked one that is not blocked. The list arrives in
 *  rank order (estimate.ts `rankCandidates`: unblocked first, then this court, other courts, no court), so it is the first
 *  unblocked; null when every one is blocked. */
export function primaryCandidateId(candidates: readonly MatchDayCandidate[]): string | null {
  return candidates.find((c) => c.blocked === null)?.fixture.id ?? null;
}

/** A poll's answer is a view only if it has the view's shape: `apiV1` resolves a cut-off 200 to `undefined` (review M1), and
 *  setting that would crash the island — the caller keeps the last view instead. */
export function isMatchDayView(v: unknown): v is MatchDayView {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<MatchDayView>;
  return (
    Array.isArray(o.courts) &&
    Array.isArray(o.playing_no_court) &&
    typeof o.date === "string" &&
    typeof o.tz === "string" &&
    typeof o.now === "string"
  );
}

/** The same guard for a candidates answer. */
export function isCandidateList(v: unknown): v is MatchDayCandidate[] {
  return Array.isArray(v);
}

/** The same filter on a free court's candidates. */
export function filterCandidates(
  candidates: readonly MatchDayCandidate[],
  divisions: ReadonlySet<string> | null,
): MatchDayCandidate[] {
  return divisions === null ? [...candidates] : candidates.filter((c) => divisions.has(c.fixture.division_id));
}

/** "Zara Khan v Ella Brooks"; a side still to be decided reads "TBD". */
export function matchLabel(dict: Dict, f: Pick<MatchDayFixture, "home" | "away">): string {
  const tbd = t(dict, "matchDay.tbd");
  return t(dict, "matchDay.match", { home: f.home ?? tbd, away: f.away ?? tbd });
}

/** Where a candidate waits, when it was planned and how late it is (§7: "18:00 · next on Court 2 · ~15 min", "25 min behind
 *  Court 1"). Its planned time leads when it has one (E2 item 1; `time` prints an ISO instant in the page's zone, the one
 *  formatter every Match Day time goes through), then the place, then the timing: how far behind its plan, else how long until
 *  it would start. "Not scheduled" is the row of a match with NO time at all — never of one that has a time and no court yet
 *  ("18:00 · no court"). A match called onto another court and not started says so — calling it here moves it — and carries no
 *  planned time: the call replaced it. */
export function candidateWhere(dict: Dict, c: MatchDayCandidate, time: (iso: string) => string): string {
  const planned = c.planned_at === null ? null : time(c.planned_at);
  const called = c.source === "other_court" && c.fixture.called_at !== null;
  const place =
    c.source === "this_court"
      ? t(dict, "matchDay.candidate.where.here")
      : c.source === "no_court"
        ? planned === null
          ? t(dict, "matchDay.candidate.where.unscheduled")
          : t(dict, "matchDay.candidate.where.noCourt")
        : called
          ? t(dict, "matchDay.candidate.where.calledOn", { court: c.from_court_name ?? "" })
          : t(dict, "matchDay.candidate.where.nextOn", { court: c.from_court_name ?? "" });
  const timing =
    c.behind_minutes > 0
      ? t(dict, "matchDay.candidate.when.behind", { minutes: c.behind_minutes })
      : c.waiting_minutes > 0
        ? t(dict, "matchDay.candidate.when.in", { minutes: c.waiting_minutes })
        : null;
  return [...(planned === null || called ? [] : [planned]), place, ...(timing === null ? [] : [timing])].join(" · ");
}

/** A blocked candidate's reason (§7.2): "Zara Khan is on Court 3"; a busy match with no court says the person is in another
 *  match. */
export function blockedReason(dict: Dict, blocked: NonNullable<MatchDayCandidate["blocked"]>): string {
  return blocked.court_name === null
    ? t(dict, "matchDay.candidate.blockedNoCourt", { person: blocked.person_name })
    : t(dict, "matchDay.candidate.blocked", { person: blocked.person_name, court: blocked.court_name });
}

/** Every refusal code a call, an undo or a preview can answer (lib/match-day/call.ts, plus the envelope's SEQ_CONFLICT). */
export const REFUSAL_CODES = [...Object.values(CALL_REFUSAL), SEQ_CONFLICT] as const;

/**
 * A refused call, undo or preview in the organiser's words — never the raw code (§7.2). `extra` is the 409's details
 * (`ApiV1Error.extra`). A code this page does not know reads as a plain "that didn't work".
 */
export function refusalMessage(dict: Dict, code: string, extra: Record<string, unknown> = {}): string {
  const str = (k: string): string => (typeof extra[k] === "string" ? (extra[k] as string) : "");
  switch (code) {
    case CALL_REFUSAL.PLAYER_BUSY:
      return extra.court_name == null || extra.court_name === ""
        ? t(dict, "matchDay.refusal.PLAYER_BUSY.noCourt", { person: str("person_name") })
        : t(dict, "matchDay.refusal.PLAYER_BUSY", { person: str("person_name"), court: str("court_name") });
    case CALL_REFUSAL.COURT_BUSY:
      return t(dict, "matchDay.refusal.COURT_BUSY", { court: str("court_name"), competition: str("competition_name") });
    case CALL_REFUSAL.NOT_CALLABLE:
      return extra.status === TBD_ENTRANT
        ? t(dict, "matchDay.refusal.NOT_CALLABLE.tbd")
        : t(dict, "matchDay.refusal.NOT_CALLABLE");
    case CALL_REFUSAL.NOT_CALLED:
      return t(dict, "matchDay.refusal.NOT_CALLED");
    case CALL_REFUSAL.NOT_CANDIDATE_COURT:
      return t(dict, "matchDay.refusal.NOT_CANDIDATE_COURT", { court: str("court_name") });
    case SEQ_CONFLICT:
      return t(dict, "matchDay.refusal.SEQ_CONFLICT");
    default:
      return t(dict, "matchDay.refusal.other");
  }
}

/** A warning in the call's knock-on preview (§7.2), times in the page's zone. */
export function warningText(dict: Dict, w: CallWarning, locale: Locale, tz: string): string {
  switch (w.kind) {
    case "pushes_later":
      return plural(dict, "matchDay.sheet.warn.pushesLater", w.count, locale);
    case "rest_gap":
      return t(dict, "matchDay.sheet.warn.restGap", { person: w.person_name, minutes: w.minutes, min: w.min_rest });
    case "past_day_end":
      return t(dict, "matchDay.sheet.warn.pastDayEnd", { court: w.court_name, time: fmtPublicTime(locale, tz, w.until) });
    case "crosses_closure":
      return t(dict, "matchDay.sheet.warn.crossesClosure", {
        court: w.court_name,
        from: fmtPublicTime(locale, tz, w.from),
        until: fmtPublicTime(locale, tz, w.until),
      });
    case "court_closed":
      return w.until === null
        ? t(dict, "matchDay.sheet.warn.courtClosedToday", { court: w.court_name })
        : t(dict, "matchDay.sheet.warn.courtClosedUntil", { court: w.court_name, time: fmtPublicTime(locale, tz, w.until) });
  }
}

/** A court card's closure line (E2 item 3): "Closed 14:00–15:00" for a break still to come, "Closed until 15:00" while shut and
 *  reopening today, "Closed for the rest of today" while shut with no reopening. Times in the organisation's zone, the way every
 *  other Match Day time prints. Null while the court is open with no break to come. */
export function closureText(dict: Dict, closure: CourtClosure | null, locale: Locale, tz: string): string | null {
  if (closure === null) return null;
  if (closure.kind === "later") {
    return t(dict, "matchDay.closure.later", { from: fmtPublicTime(locale, tz, closure.from), until: fmtPublicTime(locale, tz, closure.until) });
  }
  return closure.until === null
    ? t(dict, "matchDay.closure.rest")
    : t(dict, "matchDay.closure.until", { time: fmtPublicTime(locale, tz, closure.until) });
}

/** Why Call is off on a court that is closed now — the line beside the disabled buttons, announced to a screen reader. Null while
 *  the court is open (a break still to come is a warning in the call preview, not a stop). */
export function callPausedReason(dict: Dict, court: Pick<MatchDayCourt, "court_name" | "closure">, locale: Locale, tz: string): string | null {
  const closure = court.closure;
  if (closure === null || closure.kind !== "now") return null;
  return closure.until === null
    ? t(dict, "matchDay.closure.callPaused.rest", { court: court.court_name })
    : t(dict, "matchDay.closure.callPaused.until", { court: court.court_name, time: fmtPublicTime(locale, tz, closure.until) });
}

// ---- Needs you, the scorer marks and the stream preview (task A4) ----------------------------------------------------------

/** The kinds Match Day lists FIRST (spec §6.3: "Results owed come first, with Enter result on each"; §9 "Results owed are counted
 *  first"). Every other row keeps the desk's own order after them (severity, then the desk's kind order: needs-you.tsx). */
export const NEEDS_YOU_FIRST: readonly Attention["kind"][] = ["result_missing"];

/** The Needs-you list as Match Day shows it: the `NEEDS_YOU_FIRST` rows, then the rest, each group in the order it arrived. */
export function needsYouOrder(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  const first = items.filter((i) => NEEDS_YOU_FIRST.includes(i.kind));
  return [...first, ...items.filter((i) => !NEEDS_YOU_FIRST.includes(i.kind))];
}

const SEVERITY_RANK: readonly Severity[] = ["red", "amber", "slate"];

/** The header button's tone: its most urgent row's severity; null for an empty list (no button). */
export function needsYouTone(items: readonly Pick<NeedsYouItem, "severity">[]): Severity | null {
  let best: Severity | null = null;
  for (const i of items) if (best === null || SEVERITY_RANK.indexOf(i.severity) < SEVERITY_RANK.indexOf(best)) best = i.severity;
  return best;
}

/** How many things need the organiser, by the header's own count (fix round 1, m1): every list row that is NOT an owed result,
 *  plus each MATCH that owes one — so "N need you" never reads fewer than the "M results owed" beside it (the desk folds all of
 *  a division's owed results into one row). */
export function needsYouCount(view: Pick<MatchDayView, "needs_you" | "results_owed">): number {
  return view.needs_you.filter((r) => r.kind !== "result_missing").length + view.results_owed;
}

/** The header button's words (§6.3, "11 need you · 3 results owed"): `needsYouCount` and, when any, how many matches owe a
 *  result. Parts, so the page can join them without a separator left dangling on a wrap. */
export function needsYouButtonParts(
  dict: Dict,
  view: Pick<MatchDayView, "needs_you" | "results_owed">,
  locale: Locale,
): string[] {
  const parts = [plural(dict, "matchDay.needsYou.count", needsYouCount(view), locale)];
  if (view.results_owed > 0) parts.push(plural(dict, "matchDay.needsYou.owed", view.results_owed, locale));
  return parts;
}

/** A court's scorer mark (§9: "`no_scorer` / `not_recording` also mark the affected court's row"): the desk's attention for the
 *  match playing on it. Only a match in play can carry one, so a court in any other state has none. */
export function courtScorerAttention(court: Pick<MatchDayCourt, "state" | "current">): ScorerAttention | null {
  return court.state === "playing" ? (court.current?.scorer_attention ?? null) : null;
}

/** The `sessionStorage` item that remembers whether the organiser Hid a court's Remote scoring panel (E2 item 6): one per court
 *  (`memoryKey` is the court's id; a match on no court uses its own), so the choice survives a poll and the next match on the
 *  court, and one court's choice never moves another's. */
export const scorerMemoryKey = (memoryKey: string): string => `seazn.matchDay.scorer.${memoryKey}`;

/** The playing court's stream preview (§6.2 "Playing, stream live"; §8 Phase 1): the YouTube video its live stream goes into, as
 *  a replay part the public page's player plays — only when the stream is live, the address is provably a video, and the
 *  broadcast may be embedded (`mayEmbedReplay`: positively not made for kids; DP III.E.4.j). Otherwise null, and the court shows
 *  its scoreboard (C1) — never an empty video box (§5). */
export function streamPreviewOf(f: Pick<MatchDayFixture, "stream" | "live_video">): PublicReplayPart | null {
  if (f.stream !== "live" || f.live_video === null) return null;
  const part: PublicReplayPart = { partNo: 1, url: f.live_video.url, madeForKids: f.live_video.made_for_kids };
  return mayEmbedReplay(part) && youtubeVideoId(part.url) !== null ? part : null;
}
