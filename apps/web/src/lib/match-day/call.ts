// Match Day — calling a match onto a court (spec 2026-10-31-match-day-design.md §7). Client-safe: the refusal codes and the
// preview's wire shape, shared by the server use case (server/usecases/match-day-call.ts) and the Match Day UI, which must not
// import from server/**.

/** The 409 refusals of POST/DELETE /api/v1/fixtures/{id}/call and POST …/call/preview. Each rides the v1 error envelope
 *  as `error.code`, with its details as sibling fields of `error`:
 *  - PLAYER_BUSY  `{ person_name, court_name }`: a player of the match (person-level: a doubles partner counts) is in a match
 *                 that is playing, or called, on another court. For a side with no roster (a name-only team or player)
 *                 the side itself counts, and `person_name` is the entrant's name;
 *  - COURT_BUSY   `{ court_name, competition_name }`: the target court has a match playing or called, from any competition;
 *  - NOT_CALLABLE `{ status }`: the match is not unstarted (`status` is its fixture status), or a side is still to be decided
 *                 (`status` is `"tbd_entrant"`);
 *  - NOT_CALLED   no details: Undo call on a match that is not called, or whose call no longer holds (the board has moved
 *                 it since);
 *  - NOT_CANDIDATE_COURT `{ court_name }`: the target court is not one the match's division may play on — the scheduler's
 *                 own candidate set (court-candidates.ts; B4 fix round 1, R1). */
export const CALL_REFUSAL = {
  PLAYER_BUSY: "PLAYER_BUSY",
  COURT_BUSY: "COURT_BUSY",
  NOT_CALLABLE: "NOT_CALLABLE",
  NOT_CALLED: "NOT_CALLED",
  NOT_CANDIDATE_COURT: "NOT_CANDIDATE_COURT",
} as const;
export type CallRefusalCode = (typeof CALL_REFUSAL)[keyof typeof CALL_REFUSAL];

/** NOT_CALLABLE's `status` for a match with a side still to be decided (a knockout TBD slot). */
export const TBD_ENTRANT = "tbd_entrant";

/** A warning in the knock-on preview: the call is allowed, the organiser confirms (spec §7.2). */
export type CallWarning =
  | { kind: "pushes_later"; count: number }
  | { kind: "rest_gap"; person_name: string; minutes: number; min_rest: number }
  | { kind: "past_day_end"; court_name: string; until: string };

/** A match on the target court that the call pushes later than its planned time. Planned times are never written (owner
 *  ruling B); `estimated_at` is the read-time estimate. */
export interface CallShift {
  fixture_id: string;
  label: string;
  planned_at: string;
  estimated_at: string;
}

export interface CallPreview {
  shifts: CallShift[];
  warnings: CallWarning[];
}
