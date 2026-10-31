// Match Day — the read model's wire shapes (spec 2026-10-31-match-day-design.md §6.2, §7, §7.1). Client-safe: the server
// read model (server/usecases/match-day.ts), its two GET routes and the Match Day UI share them, and client code must not
// import from server/**. Type-only imports only (eslint.config.mjs refuses a value import of @/server/** here).
import type { NeedsYouItem } from "@/components/v2/desk/needs-you";
import type { VenueNoun } from "@/lib/venue";

export type { NeedsYouItem, VenueNoun };

/** What a court is doing now, from the fixtures' STATUS — never from the presence of a call row:
 *  - playing: one of THIS competition's matches is `in_play` on it;
 *  - called: one of this competition's matches is called onto it and the call still holds (unstarted, still on that court at
 *    the called time — match-day-call.ts's `liveCallSql`);
 *  - in_use_elsewhere: another competition of the organisation has a match playing or called on it (courts are org-level);
 *  - free: none of those. */
export type MatchDayCourtState = "playing" | "called" | "free" | "in_use_elsewhere";

/** A match as Match Day shows it. Times are ISO instants. */
export interface MatchDayFixture {
  id: string;
  division_id: string;
  division_name: string;
  /** The division's slug and the match's per-division number: its console page's address (`routes.fixture`), where the pad
   *  and the per-match stream panel live. */
  division_slug: string;
  fixture_no: number;
  sport_key: string;
  /** The stage's name. */
  stage_label: string;
  /** Entrant display names; null for a side still to be decided. */
  home: string | null;
  away: string | null;
  /** The live scoreline (`match_states.summary.headline`); null when the match has no state or its engine publishes none. */
  headline: string | null;
  /** The real kick-off: the match's `core.start` score event. Null before it starts (fixtures have no start column). */
  started_at: string | null;
  /** When it was called onto its court; null unless its call still holds. */
  called_at: string | null;
  /** The match's stream session, as a person reads it; null when it has none up. */
  stream: "live" | "waiting" | null;
}

/** A match waiting in a court's queue. `planned_at` is its planned time, which a call never changes (owner ruling B);
 *  `estimated_at` is the read-time estimate, max(planned, estimated end of the match before it) (§7.1). */
export interface MatchDayQueued extends MatchDayFixture {
  planned_at: string;
  estimated_at: string;
}

export interface MatchDayCourt {
  court_id: string;
  /** The court's display label: venue-qualified only when two venues share a court name (lib/court-directory.ts). */
  court_name: string;
  venue_name: string;
  /** What the playing area is called for the sport on it: the current match's sport, else its first queued match's, else the
   *  first division (in competition order) that has the court among its candidate courts. "court" when none says. */
  sport_noun: VenueNoun;
  state: MatchDayCourtState;
  /** This competition's match playing or called on the court; null when free or in use elsewhere. */
  current: MatchDayFixture | null;
  /** The other competition's name when `in_use_elsewhere`; null otherwise. */
  in_use_by: string | null;
  /** When the court's last match today finished, when it is free and one has; null otherwise. */
  free_since: string | null;
  /** This competition's matches planned on the court today, unstarted and not called, in planned order. Their estimates
   *  count every competition's planned matches on the court, as courts are shared. */
  queue: MatchDayQueued[];
}

export type MatchDayCandidateSource = "this_court" | "other_court" | "no_court";

/** A match that could start on a free court now (§7). */
export interface MatchDayCandidate {
  fixture: MatchDayFixture;
  /** this_court: the court's own next match; other_court: another court's next match, or a match called onto another court
   *  and not started (it may be called elsewhere); no_court: a ready match in an active stage with no court yet. */
  source: MatchDayCandidateSource;
  /** The court it waits on, for other_court; null otherwise. */
  from_court_name: string | null;
  /** Whole minutes from now until its estimated start where it waits ("next on Court 2 · ~15 min"); 0 for no_court. */
  waiting_minutes: number;
  /** Whole minutes its estimated start where it waits is past its planned time ("25 min behind Court 1"); for no_court, how
   *  long its planned time (if it has one) has passed. */
  behind_minutes: number;
  /** A hard stop (§7.2): a player of the match — a doubles partner counts; for a side with no roster, the side itself — is
   *  in a match playing, or called, elsewhere. `court_name` is null when that match has no court. */
  blocked: null | { kind: "player_busy"; person_name: string; court_name: string | null };
}

/** GET /api/v1/competitions/{id}/match-day. */
export interface MatchDayView {
  competition_id: string;
  /** The header's date label: today, YYYY-MM-DD, in `tz`. Which matches are today is decided per match, on its own division's
   *  day (the venue zone, else the organisation's), so a far-away division's matches can be on another date than this. */
  date: string;
  /** The organisation's zone: the one `date` is in, and the one times are printed in. */
  tz: string;
  now: string;
  courts: MatchDayCourt[];
  /** The competition desk's Needs-you rows (`needsYouItems`), in the reader's language. */
  needs_you: NeedsYouItem[];
  /** How many matches owe a result: the desk's `result_missing` attentions, summed. */
  results_owed: number;
  /** This competition's matches today, each on its own division's day, plus those in play (`countFixturesToday`). */
  fixtures_today: number;
}
