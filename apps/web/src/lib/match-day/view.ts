// Match Day — the page's pure reading of the read model (spec 2026-10-31-match-day-design.md §6, §7, task A3): the header's
// counts and noun, the division filter, what a candidate row says about where it waits, and a refusal in organiser words.
// Client-safe and DOM-free, so the node-environment suite reaches every decision the components make.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { fmtPublicTime } from "@/lib/format";
import type { VenueNoun } from "@/lib/venue";
import { setBreakdown } from "@/lib/public-site";
import type { Attention, Severity } from "@/lib/division-phase";
import { mayEmbedReplay, youtubeVideoId, type PublicReplayPart } from "@/lib/youtube";
import { CALL_REFUSAL, TBD_ENTRANT, type CallWarning } from "./call";
import type { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayView, NeedsYouItem, ScorerAttention } from "./types";

/**
 * A playing match's score as Match Day shows it (spec §6.2 "games or sets won in large type, current points beside them";
 * review V3/V4). A set sport — the engine's summary carries a set table and a line per side — reads as its games or sets won
 * (each side's own `perSide` line) and the CURRENT game's points: the engine's own live points, the headline's trailing "(…)"
 * ("19–19"; tennis's "40–Ad"), absent between games. A finished game's score is never part of it: those are the set table's.
 * Any other sport reads as its own headline, whole. Null before the engine has published one.
 *
 * Not `stripLiveSetPoints` (lib/public-site.ts): the public match page keeps the finished games in its large type and drops the
 * live points — the reverse of what a hall needs from across the floor. That page is left as it is (review V3).
 */
export type ScoreLine = { kind: "sets"; won: readonly [string, string]; live: string | null } | { kind: "plain"; text: string };

export function scoreLine(f: Pick<MatchDayFixture, "summary" | "sport_key">): ScoreLine | null {
  const s = f.summary;
  if (s === null || !s.headline) return null;
  const sides = s.perSide ?? [];
  if (setBreakdown(s, f.sport_key) !== null && sides.length === 2) {
    const live = /\(([^)]*)\)\s*$/.exec(s.headline)?.[1]?.trim();
    return { kind: "sets", won: [sides[0]!.line, sides[1]!.line], live: live ? live : null };
  }
  return { kind: "plain", text: s.headline };
}

/** The court list's one-line form of `scoreLine`: "0–1 · 12–10" for a set sport, the sport's own headline otherwise. */
export function compactScore(line: ScoreLine): string {
  if (line.kind === "plain") return line.text;
  const won = `${line.won[0]}–${line.won[1]}`;
  return line.live === null ? won : `${won} · ${line.live}`;
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

/** Whether anything on the page is moving: a match playing or called. Decides the poll's cadence (band-poll.ts). */
export function isLive(view: Pick<MatchDayView, "courts">): boolean {
  return view.courts.some((c) => c.state === "playing" || c.state === "called");
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

/** What is focused (§6.1, review M6): the court the organiser opened while it is still on the list; none opened yet → the first
 *  court (the desktop's default); the opened court gone from the list (the filter dropped it, or the day moved on) → `lost`,
 *  named — the page goes back to the list rather than silently showing a different court. */
export type Focus =
  | { kind: "court"; court: MatchDayCourt }
  | { kind: "lost"; name: string }
  | { kind: "none" };

export function resolveFocus(courts: readonly MatchDayCourt[], opened: { id: string; name: string } | null): Focus {
  if (opened === null) return courts[0] === undefined ? { kind: "none" } : { kind: "court", court: courts[0] };
  const court = courts.find((c) => c.court_id === opened.id);
  return court === undefined ? { kind: "lost", name: opened.name } : { kind: "court", court };
}

/** How many candidates could start here NOW (§7, review I2): a blocked one cannot, so it is not counted. */
export function callableCount(candidates: readonly MatchDayCandidate[]): number {
  return candidates.filter((c) => c.blocked === null).length;
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
  return Array.isArray(o.courts) && typeof o.date === "string" && typeof o.tz === "string" && typeof o.now === "string";
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

/** Where a candidate waits and how late it is (§7: "next on Court 2 · ~15 min", "25 min behind Court 1", "Not scheduled").
 *  The place first, then the timing when there is one: how far behind its plan, else how long until it would start. A match
 *  called onto another court and not started says so — calling it here moves it. */
export function candidateWhere(dict: Dict, c: MatchDayCandidate): string {
  const place =
    c.source === "this_court"
      ? t(dict, "matchDay.candidate.where.here")
      : c.source === "no_court"
        ? t(dict, "matchDay.candidate.where.noCourt")
        : c.fixture.called_at !== null
          ? t(dict, "matchDay.candidate.where.calledOn", { court: c.from_court_name ?? "" })
          : t(dict, "matchDay.candidate.where.nextOn", { court: c.from_court_name ?? "" });
  const timing =
    c.behind_minutes > 0
      ? t(dict, "matchDay.candidate.when.behind", { minutes: c.behind_minutes })
      : c.waiting_minutes > 0
        ? t(dict, "matchDay.candidate.when.in", { minutes: c.waiting_minutes })
        : null;
  return timing === null ? place : `${place} · ${timing}`;
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
  }
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

/** The header button's words (§6.3, "11 need you · 3 results owed"): how many rows the list holds — the list's own count — and,
 *  when any, how many matches owe a result. Parts, so the page can join them without a separator left dangling on a wrap. */
export function needsYouButtonParts(
  dict: Dict,
  view: Pick<MatchDayView, "needs_you" | "results_owed">,
  locale: Locale,
): string[] {
  const parts = [plural(dict, "matchDay.needsYou.count", view.needs_you.length, locale)];
  if (view.results_owed > 0) parts.push(plural(dict, "matchDay.needsYou.owed", view.results_owed, locale));
  return parts;
}

/** A court's scorer mark (§9: "`no_scorer` / `not_recording` also mark the affected court's row"): the desk's attention for the
 *  match playing on it. Only a match in play can carry one, so a court in any other state has none. */
export function courtScorerAttention(court: Pick<MatchDayCourt, "state" | "current">): ScorerAttention | null {
  return court.state === "playing" ? (court.current?.scorer_attention ?? null) : null;
}

/** The playing court's stream preview (§6.2 "Playing, stream live"; §8 Phase 1): the YouTube video its live stream goes into, as
 *  a replay part the public page's player plays — only when the stream is live, the address is provably a video, and the
 *  broadcast may be embedded (`mayEmbedReplay`: positively not made for kids; DP III.E.4.j). Otherwise null, and the court shows
 *  its scoreboard (C1) — never an empty video box (§5). */
export function streamPreviewOf(f: Pick<MatchDayFixture, "stream" | "live_video">): PublicReplayPart | null {
  if (f.stream !== "live" || f.live_video === null) return null;
  const part: PublicReplayPart = { partNo: 1, url: f.live_video.url, madeForKids: f.live_video.made_for_kids };
  return mayEmbedReplay(part) && youtubeVideoId(part.url) !== null ? part : null;
}
