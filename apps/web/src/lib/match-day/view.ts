// Match Day — the page's pure reading of the read model (spec 2026-10-31-match-day-design.md §6, §7, task A3): the header's
// counts and noun, the division filter, what a candidate row says about where it waits, and a refusal in organiser words.
// Client-safe and DOM-free, so the node-environment suite reaches every decision the components make.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { fmtPublicTime } from "@/lib/format";
import type { VenueNoun } from "@/lib/venue";
import { CALL_REFUSAL, TBD_ENTRANT, type CallWarning } from "./call";
import type { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayView } from "./types";

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
