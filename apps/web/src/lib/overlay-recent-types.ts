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
  /** Index into `[home, away]` of the side the event credits (`by` / `wonBy`).
   *  ABSENT when the payload names neither side — cricket's ball is the live
   *  case: it records a striker, not an entrant. */
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

/** One surviving ledger event, projected. `type` is the ENGINE'S OWN recorded
 *  type string, unmapped — the moment allowlist keys on it. */
export interface RecentEvent {
  seq: number;
  type: string;
  /** ISO, the envelope's `recordedAt`. */
  at: string;
  payload: RecentPayload;
}

/** How many surviving module events the overlay carries. Eight is the slab's
 *  own backlog bound: a viewer joining mid-match must not have the last hour
 *  replayed at them, and the queue drains one moment at a time. */
export const OVERLAY_RECENT_WINDOW = 8;
