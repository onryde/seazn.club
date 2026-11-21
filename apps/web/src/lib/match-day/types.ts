// Match Day — the read model's wire shapes (spec 2026-10-31-match-day-design.md §6.2, §7, §7.1). Client-safe: the server
// read model (server/usecases/match-day.ts), its two GET routes and the Match Day UI share them, and client code must not
// import from server/**. Type-only imports only (eslint.config.mjs refuses a value import of @/server/** here).
import type { NeedsYouItem } from "@/components/v2/desk/needs-you";
import type { ArbiterBoard, ArbiterRound } from "@/lib/arbiter-view";
import type { Attention } from "@/lib/division-phase";
import type { OpenRoundView } from "@/lib/open-round";
import type { NeedsReason } from "@/server/external-play/types";
import type { VenueNoun } from "@/lib/venue";

export type { NeedsYouItem, VenueNoun };

/** The two Needs-you kinds that are about ONE match's scorer (task A4; spec §9 "`no_scorer` / `not_recording` also mark the
 *  affected court's row"): a match in play with nothing recorded and nobody nominated, or with a nominated scorer silent past the
 *  grace. The desk's own `Attention` kinds, never a copy: lib/division-phase.ts decides them, and one match never raises both. */
export type ScorerAttention = Extract<Attention["kind"], "no_scorer" | "not_recording">;
export const SCORER_ATTENTIONS = ["no_scorer", "not_recording"] as const satisfies readonly ScorerAttention[];

/** What a court is doing now, from the fixtures' STATUS — never from the presence of a call row:
 *  - playing: one of THIS competition's matches is `in_play` on it;
 *  - called: one of this competition's matches is called onto it and the call still holds (unstarted, still on that court at
 *    the called time — match-day-call.ts's `liveCallSql`);
 *  - in_use_elsewhere: another competition of the organisation has a match playing or called on it (courts are org-level);
 *  - free: none of those. */
export type MatchDayCourtState = "playing" | "called" | "free" | "in_use_elsewhere";

/** `match_states.summary` as stored: the same shape the public live scoreboard reads (`LiveFixtureData.summary`). */
export interface MatchDaySummary {
  headline?: string;
  perSide?: { entrantId: string; line: string }[];
  detail?: unknown;
}

/** A match's round as the SCHEDULE BOARD names it (Match Day E2 item 7): the board's own `boardRoundCodes` decides it, so a
 *  Match Day chip and a board card can never disagree. */
export interface MatchDayRound {
  /** The chip text: the board's short code for a bracket round ("QF", "SF", "F", "3rd", "WB2", "Q1", "E2"), else the board's own
   *  fallback `R{round_no}` — a league or Swiss round, and any bracket the board cannot name from its rows. */
  code: string;
  /** The round's full name in the reader's language: the board's long name when it has a code ("Semi-finals"), else "Round 2".
   *  The chip's accessible name and its tooltip, and the last part of the division meta line. */
  label: string;
  /** Whether the board codes this round (a bracket role): the board's heavier chip variant. False for a plain `R{n}`. */
  coded: boolean;
}

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
  /** The match's round, as the schedule board names it (`MatchDayRound`). */
  round: MatchDayRound;
  /** Entrant display names; null for a side still to be decided. */
  home: string | null;
  away: string | null;
  /** The sides' entrant ids, in the same seats: the keys of `summary.perSide`, so a scoreboard names each line's side. */
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** The live scoreline (`match_states.summary.headline`); null when the match has no state or its engine publishes none. */
  headline: string | null;
  /** The engine's whole folded summary (`match_states.summary`): the headline, each side's line and the sport's detail (sets,
   *  points, who serves, periods, innings). The playing court's scoreboard is the public match page's own `LiveScoreBody` fed
   *  this, so every sport shows its own scorebug. Null when the match has no state yet. */
  summary: MatchDaySummary | null;
  /** Who serves the next rally (task A3 S1): a playing set-sport match only, from the engine's serve reader over the match's
   *  ledger (`setBasedServeContext`, the pad's own call; server/engine-db/serving.ts). Null for any other match, a sport with no
   *  serve, or when the engine does not know — never a guess. */
  serving: "home" | "away" | null;
  /** The real kick-off: the match's `core.start` score event. Null before it starts (fixtures have no start column). */
  started_at: string | null;
  /** When it was called onto its court; null unless its call still holds. */
  called_at: string | null;
  /** The match's stream session, as a person reads it; null when it has none up. */
  stream: "live" | "waiting" | null;
  /** The competition desk's scorer attention for this match (`ScorerAttention`, the same rows Needs you lists); null when it has
   *  none. Only a match in play can carry one. */
  scorer_attention: ScorerAttention | null;
  /** While its stream is live: the YouTube video that stream goes into (a YouTube Connect broadcast, `liveSessionVideos`) and that
   *  broadcast's own made-for-kids stamp — the Match Day preview's source (spec §6.2). Null for any match whose stream is not live,
   *  and for a live stream that names no YouTube video (a pasted key). Set on a playing court's match only. */
  live_video: { url: string; made_for_kids: boolean } | null;
  /** Match Day C2: the format this match plays, in the public line's words (`fixtureFormatLines`, the fixture page's own
   *  `effectiveLine`) — the court's read-only Match format. Set on a playing match only; null for any other, and for a format
   *  the line has no words for. */
  format_line: string | null;
  /** The match's Stream switch (`fixture_stream_settings.court_stream`): the court's phone streams this match (court stream §5.2). */
  court_stream: boolean;
  /** The match has its own ACTIVE stream code, so the switch cannot go on ("This match has its own stream code"). */
  own_stream_code: boolean;
}

/** A match waiting in a court's queue. `planned_at` is its planned time, which a call never changes (owner ruling B);
 *  `estimated_at` is the read-time estimate, max(planned, estimated end of the match before it) (§7.1). */
export interface MatchDayQueued extends MatchDayFixture {
  planned_at: string;
  estimated_at: string;
}

/** What a court card says about its hours today (Match Day E2 item 3; `lib/match-day/closure.ts` decides it from the scheduler's own
 *  usable windows, `court_hours` + `court_exceptions`). ISO instants.
 *  - now: the court is closed at the view's `now`; `until` is when it reopens, null when it does not open again today;
 *  - later: open now, with a break still to come today (`from`..`until`). A court that only closes for the night has none. */
export type CourtClosure = { kind: "now"; until: string | null } | { kind: "later"; from: string; until: string };

/** A court's live link for the day, as the desk reads it (court stream §5.5). No secret: never the code or its token. */
export interface MatchDayCourtStream {
  link_id: string;
  target_label: string;
  /** ISO: the end of the link's day. */
  expires_at: string;
  /** The court phone: unpaired (no pairing), waiting, live (an open session), or offline (three missed beats). */
  phone: "unpaired" | "waiting" | "live" | "offline";
  /** The stored refusal of the court's latest refused automatic start (the focus match's `auto_start_refusal`), else null.
   *  `competition_frozen` is served while the competition is frozen, never stored. */
  refusal: "no_destination" | "no_credit" | "not_entitled" | "destination_in_use" | "unavailable" | "competition_frozen" | null;
  /** O16: ISO instant the court's video stops by itself, while it is still to come: the court's last streamed match has a result
   *  and its court session is still live or ending inside the tail (`COURT_AUTO_STOP_AFTER_RESULT_SECONDS` after `finished_at`).
   *  The SERVER decides it (`courtTailEndsAt`); a client only counts down to it. Null outside the tail, with no session, or when the
   *  automatic stop will not fire; a court with no link has no `stream_link` at all. */
  tail_ends_at: string | null;
}

export interface MatchDayCourt {
  court_id: string;
  /** The court's display label: venue-qualified only when two venues share a court name (lib/court-directory.ts). */
  court_name: string;
  /** The court's venue (the venue filter's key, Match Day E2 item 5) and its name. */
  venue_id: string;
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
  /** The court's closure today (`CourtClosure`); null while it is open with no break still to come. */
  closure: CourtClosure | null;
  /** The court's live stream link today, with its phone's status; null when the court has none (never linked or withdrawn). */
  stream_link: MatchDayCourtStream | null;
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
  /** True when the match is the first match queued on `from_court_name`'s court, that court's very next; false for a later
   *  match of its queue, for this_court and no_court, and for a called match (F-T8-16: "Next on" is said of the first only). */
  first_in_queue: boolean;
  /** Whole minutes from now until its estimated start where it waits ("next on Court 2 · ~15 min"); 0 for no_court. */
  waiting_minutes: number;
  /** Whole minutes its estimated start where it waits is past its planned time ("25 min behind Court 1"); for no_court, how
   *  long its planned time (if it has one) has passed. */
  behind_minutes: number;
  /** The match's planned time (Match Day E2): the next match's planned time on its own court, or a no-court match's own
   *  `scheduled_at`. Null when it has none — and for a match CALLED elsewhere, whose planned time the call replaced. The row
   *  prints it ("18:00 · no court"); "Not scheduled" is the row of a match with no time at all. */
  planned_at: string | null;
  /** A hard stop (§7.2): a player of the match — a doubles partner counts; for a side with no roster, the side itself — is
   *  in a match playing, or called, elsewhere. `court_name` is null when that match has no court. */
  blocked: null | { kind: "player_busy"; person_name: string; court_name: string | null };
}

/** Needs you's "Find a court" for one division (B4 fix round 1, R2): present only when the division has a ready match with no
 *  court yet (Match Day's own "no court yet" rule: unstarted, both sides seated, an active stage); `court_id` is the first free
 *  court on the list that one of those matches may be called onto (`callableCourtsByFixture`), or null when none is free; `noun`
 *  is the division's sport's word for it. */
export interface MatchDayFindCourt {
  court_id: string | null;
  noun: VenueNoun;
}

// ---- online chess rounds in Match Day (spec 2026-11-05-match-day-all-in-one-design.md §4, §5, §7) -------------------------------

/** Where an online round is, as the list says it. `not_started`: the division has not started (its panel says to start it first);
 *  `before`: paired, not opened; `checkin`: opened and some board still checking in; `playing`: opened, none checking in. The
 *  server's word at the poll (`readOnlineRounds`); `onlineRoundPhase` (lib/match-day/online.ts) re-reads it from the round's boards
 *  (their states, never the clock: a deadline passing flips nothing). */
export type OnlineRoundPhase = "not_started" | "before" | "checkin" | "playing";

/** A board as the list carries it: a whole ArbiterBoard (so lib/round-column.ts's rules, which take ArbiterBoard[], apply unchanged;
 *  `flags` is [] and `flagCount` the count on the list read) plus where it sits. */
export interface MatchDayBoardRow extends ArbiterBoard {
  stage_id: string;
  round_no: number;
  /** Why a held board is held (`fixture_external_play.needs_reason`): stamped by `readOnlineRounds` on EVERY board of the row, in
   *  `round.boards` and in `needs_decision` alike (ruling MD-R6/R8) - the reason for a board in `on_hold`, null for any other. Optional
   *  in the type only because a board that did not come through `readOnlineRounds` (a fixture's own) has none. Needs you routes on it
   *  (ruling MD-R2: a link hold, `lichess_unlinked` / `lichess_reconnect`, goes to the round panel's Open round, not the board's
   *  decisions); the row's WORD never reads it (`boardRowWord`: a hold is a hold). */
  hold_reason?: NeedsReason | null;
}

/** One row of the online block: one (division, stage, round) to show. */
export interface MatchDayOnlineRound {
  /** `${stage_id}:${round_no}` - the same spelling as `roundKey` (server/external-play/round-open.ts), the `?round=` param's value. */
  key: string;
  division_id: string;
  division_name: string;
  division_slug: string;
  stage_id: string;
  stage_name: string;
  round_no: number;
  /** The division has more than one round row on the page: the row names the stage. */
  multi_stage: boolean;
  phase: OnlineRoundPhase;
  /** The club's online-chess flag (`onlineChessOffered`). */
  offered: boolean;
  /** The venue zone the column printed times in. */
  tz: string;
  /** `listOpenRounds`' view for this (stage, round) (OpenRoundView, lib/open-round.ts): the press, the pairings, the batches. Null
   *  when the reader has none for it (an opened round whose window has closed reads null, as the column handles it) and for
   *  `not_started`. */
  view: OpenRoundView | null;
  /** The opened round whole (`loadArbiterRound` with flags "count"): its boards carry `seats`, `checkin` and `sides`, which the round
   *  panel's rules read. Null before the open. `round.boards` is the row's board list. */
  round: ArbiterRound | null;
  /** Held or flagged boards of the division NOT in the `round.boards` of ANY of its rows (`round.boards` is each row's own stage's
   *  latest opened round), any round, each with its round. They are carried on the division's FIRST row only (the division page lists
   *  them once), whichever stage the board is in; every other row has []. A cancelled board is here only while it has an open flag
   *  (owner O1, 2026-11-17). */
  needs_decision: MatchDayBoardRow[];
  /** Boards the viewer plays on that no list shows: the row's own round's (the loader's count) and, on the division's FIRST row, the
   *  held boards of earlier rounds the viewer plays on. A board that is only FLAGGED in an earlier round and the viewer's own is in no
   *  count at all (the flagged list gives a count, not ids): such a board is simply not shown. */
  own_boards: number;
  /** The Swiss round this row's stage would pair next (`nextUnseatedSwissRound`, the one rule the stage rail's "Pair next round" reads): the
   *  round the panel's "Pair next round" would seat once this round is over (owner MD-R15, 2026-11-20). Null for any other kind of stage and
   *  for a Swiss stage with every round seated; a stage-level fact, stamped on every row of the stage by `readOnlineRounds`. Optional in the
   *  type only, so a row built without the producer (a test fixture) reads as null - the way `hold_reason` is. */
  pair_next_round?: number | null;
}

/** The focused board's position, from the bridge's moves (`fenAfter`): the read-only chess board's whole input. */
export interface BoardPosition {
  fen: string;
  lastMove: [string, string] | null;
  turn: "white" | "black";
}

/** The focused board, as GET /api/v1/fixtures/{id}/match-day-board answers it (`loadMatchDayBoard`): the board as the arbiter's round
 *  view paints it - the same composition, so its sides carry presence, camera and `joinable` and a board in check-in its seats - with
 *  every open flag built in full (`flags`, not a count) and the position of its game: null while no game is on file. `stage_id` and
 *  `round_no` say where it sits; `hold_reason` is stamped on EVERY read (the reason of a board in `on_hold`, null otherwise: ruling
 *  MD-R8), where the list's boards carry it optionally. */
export interface MatchDayBoard extends MatchDayBoardRow {
  hold_reason: NeedsReason | null;
  position: BoardPosition | null;
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
  /** This competition's matches in play with NO court (owner ruling Q1, task B4): an untimed bracket match, an online chess
   *  board — every `in_play` match of a live (not archived) division whose `court_id` is null, in kick-off order (a match with
   *  no recorded kick-off last). Each carries what a playing court's match carries (`serving`, `scorer_attention`,
   *  `live_video`), so its panel is the same scoreboard and scorer QR. Empty when there is none. */
  playing_no_court: MatchDayFixture[];
  /** The competition desk's Needs-you rows (`needsYouItems`), in the reader's language — on a match day only (B1, spec §9: the
   *  list lives in one place at a time, `needsYouHome`); empty before the day, when the competition page carries it. */
  needs_you: NeedsYouItem[];
  /** How many matches owe a result: the desk's `result_missing` attentions, summed (`resultsOwedOf`); 0 when not a match day. */
  results_owed: number;
  /** This competition's matches today, each on its own division's day, plus those in play, plus the boards of an online round that
   *  makes the day (opened in it, a live check-in window, or a game on file: an online board has no planned time) (`countFixturesToday`,
   *  read once per poll: the competition desk's own `fixtures_today`). */
  fixtures_today: number;
  /** The venues where THIS competition has a match today (Match Day E2 item 5): the venue of every court one of its matches today
   *  is on — played, playing, queued or called — whatever the match's state. The venue filter's default selection; empty when
   *  none of today's matches has a court. */
  venues_today: string[];
  /** The competition's online chess rounds (one per division, stage and round to show), after the courts in the list; empty when it
   *  has none. Read by `readOnlineRounds` (server/usecases/match-day-online.ts). */
  online_rounds: MatchDayOnlineRound[];
  /** True when THIS poll's online read failed (ruling MD-R9 answers the day without it, so the courts never go down with chess): then
   *  `online_rounds` is `[]` because nothing was read, NOT because the competition has no online round. It is also true when the held or
   *  flagged lister failed for the desk's own read of its per-board Needs-you rows, whatever the online rounds did (they come from the
   *  same two listers), so `needs_you` and `results_owed` may lack those rows. A page that already holds an answer keeps its rounds, its
   *  rows and its count (`viewAfterPoll`), so the board panel open on a game does not close and its cameras do not leave for a database
   *  hiccup. False on every poll whose online read answered, an empty answer included. */
  online_failed: boolean;
}
