// The overlay's `recent` window — the shape that crosses the wire on
// `OverlayLiveData` (stream overlay W2, design §3.2). PURE: no server import of
// any kind, because the moment layer (`lib/overlay-moments.ts`, W2 Task 2) is a
// CLIENT module and in this app a client component importing anything under
// `@/server/**` is a BUILD FAILURE, not a warning — the same reason
// `lib/timeline-keys.ts` exists apart from `server/public-site/timeline.ts`.
//
// WHY A STRUCTURED PAYLOAD RATHER THAN THE TIMELINE'S LINES. The spectator
// surface already ships a consent-resolved, void-resolved ledger projection
// (`buildTimeline`), and it was measured against this need before this file was
// written: `TimelineLine` is `{ seq, at, marker, sideIndex, text: Msg,
// emphasis }` — it carries NO raw event type, `TIMELINE_KEY_FOR` is
// deliberately many-to-one (all three set-based sports share
// `timeline.setbased.rally`; both hockeys share `timeline.periodsport.goal`) so
// the key cannot be inverted back to a type, and cricket has no entry in that
// table at all. A moment has to know a six from a four and a caught from a
// run-out, so it needs the payload, not the sentence.
//
// Everything here is OPTIONAL except `seq`/`type`/`at`. A band-0 ledger records
// a goal with nothing but the side; the projection must degrade to that rather
// than invent a person.

/** A person named on a moment line. Consent-resolved SERVER-SIDE — never the
 *  stored `full_name`, and never a raw `persons.id`: an id is a stable
 *  cross-division identifier for exactly the people who withheld their name
 *  (the defect `makePersonOf` documents at `match-centre.ts`), and the overlay
 *  has no use for one. */
export interface RecentPerson {
  name: string;
  /** True when `resolvePersonDisplayName` changed the name — a masked person
   *  must not be re-joined to a fuller name by a downstream surface. */
  masked: boolean;
}

export interface RecentPayload {
  /**
   * Index into `[home, away]` of the side the payload NAMES — `by`, or `wonBy`
   * for a rally.
   *
   * NOT always the side CREDITED, and the difference is one event: on an own
   * goal, `FootballGoal.by` / `PeriodGoal.by` is the side whose player struck
   * it, and the goal counts for the opponent (football.ts:213,
   * period/kernel.ts:224). Read `ownGoal` alongside this rather than treating
   * `side` as the scoring team; the raw fact is carried here so a consumer can
   * decide, and nothing in W2 captions a side from it.
   *
   * ABSENT when the payload names neither side — cricket's ball is the live
   * case: it records a striker, not an entrant.
   */
  side?: 0 | 1;
  person?: RecentPerson;
  /** Cricket: runs off the bat (`runs.bat`). */
  runs?: number;
  boundary?: 4 | 6;
  /** A `CricketWicket.kind` member. */
  wicketKind?: string;
  /** A `FootballCard.color` member. */
  colour?: string;
  /** A period-sport suspension class key (`PeriodSuspensionStart.class`). */
  class?: string;
  /** A period-sport goal kind (`PeriodGoal.kind`) or a tennis point's shot type
   *  (`NestedPointMeta.kind` — "ace", "double_fault", "winner", "ue"). */
  kind?: string;
  ownGoal?: boolean;
  penalty?: boolean;
}

/**
 * Facts the ledger does NOT record, derived server-side by replaying the module.
 *
 * Both are engine answers, never re-typed rules. "Set point" is not a stored
 * event at any fidelity band anyone streams at (W2-F4): the only way to know
 * whether the next point wins a set is to ASK the module what would happen, so
 * that is what the server does — it applies a synthetic point for each side and
 * reads the result. No set rule, tiebreak length or deciding-set variation
 * appears anywhere in this codebase as a consequence.
 */
export interface RecentDerived {
  /** The event CLOSED a set. `set` is 1-based; `home`/`away` are that set's
   *  final scores. */
  setWon?: { set: number; winner: 0 | 1; home: number; away: number };
  /**
   * The DISMISSED batter's final figures, for a cricket wicket ball. Derived,
   * not recorded: the ball payload names who is out, never what they had made,
   * and a moment line that says "OUT" without the score is not worth reading.
   *
   * ABSENT for a COARSE innings (fidelity bands 0 and 1 keep no per-batter
   * tally), which is the honest answer rather than a pair of zeroes.
   */
  batter?: { runs: number; balls: number };
  /**
   * After this event, ONE more point by `side` would break serve, win the set,
   * or win the match.
   *
   * `fresh` is false when the previous event was already at the same state for
   * the same side — a deuce fought out over ten points is ONE match point
   * arriving, not ten. The slab fires on `fresh`.
   */
  pointState?: { kind: "break" | "set" | "match"; side: 0 | 1; fresh: boolean };
}

/** One surviving ledger event, projected. `type` is the ENGINE'S OWN recorded
 *  type string, unmapped — the moment allowlist keys on it. */
export interface RecentEvent {
  seq: number;
  type: string;
  /** ISO, the envelope's `recordedAt`. */
  at: string;
  payload: RecentPayload;
  /** ABSENT when the replay derived nothing for this event, and absent for
   *  every sport that is not set-based. Never an empty object. */
  derived?: RecentDerived;
}

/** How many surviving module events the overlay carries. Eight is the slab's
 *  own backlog bound: a viewer joining mid-match must not have the last hour
 *  replayed at them, and the queue drains one moment at a time. */
export const OVERLAY_RECENT_WINDOW = 8;
