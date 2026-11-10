// /api/v1 contracts — fixtures: patch and stream, Match Day call/rounds/courts/candidates, external-play arbiter, lobby, room and video.
// One module of the schemas/ folder; ./index.ts is the map and the public surface. Pure zod (loads bare under
// `node --experimental-strip-types`): relative imports carry an explicit `.ts`, types come in through `import type`.
import { z } from "zod";
// Stream overlay W1 (Task 3) — the ONE stream-link validator (R16), reused
// here rather than restated. Relative + explicit `.ts`, same reason as
// registration-rules.ts above: this file is shared with the standalone
// OpenAPI generator script, which has no `@/` alias resolution.
import { streamUrlSchema } from "../../../lib/stream-url.ts";
import type { BoardErrorCode, GrantRefusal } from "../../external-play/types.ts";
import { VenueId, CourtId, Uuid } from "./common.ts";

// ---------------------------------------------------------------------------
// Fixtures, lineups, scoring
// ---------------------------------------------------------------------------

export const PatchFixture = z
  .object({
    scheduled_at: z.iso.datetime({ offset: true }).nullable(),
    // P9 pass 3a (venues/courts cutover, FULL — not a compatibility shim):
    // `venue`/`court_label` free text leave the wire entirely. A request
    // names a real venue/court by id; `court_label`/`venue` stay in the DB,
    // unwritten, until the drop PR.
    venue_id: VenueId.nullable(),
    court_id: CourtId.nullable(),
    officials: z.array(z.record(z.string(), z.unknown())),
    /** Pin/lock (doc 12 §2): locked assignments survive re-running auto. */
    schedule_locked: z.boolean(),
    /** Optimistic token (v3/11 gap 10): the division seq the client loaded.
     *  Stale → 409 SEQ_CONFLICT, the board refetches and toasts. */
    expected_seq: z.number().int().nonnegative(),
  })
  .partial()
  // P9 pass 3a: `.strict()` so a client still sending the retired
  // `court_label`/`venue` gets a loud 400 instead of a silent no-op — a
  // plain (non-strict) object schema STRIPS an unknown key rather than
  // refusing it, and "I set court_label but the fixture never moved, with
  // no error" is a far worse failure than a 400 telling the client its
  // field name is gone. Same reasoning `ApplyCompetitionScheduleRequest`'s
  // own `.strict()` documents.
  .strict()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchFixture = z.infer<typeof PatchFixture>;

/** PUT /fixtures/{id}/stream (stream overlay W1). `.strict()` for the reason
 *  `PatchFixture` documents: a client sending `stream_url` (snake) instead of
 *  `streamUrl` gets a loud 400 rather than a silent no-op. The value is
 *  validated by the ONE allowlist both this route and the organiser panel
 *  share (`@/lib/stream-url`, R16) — never a second host list here. */
export const PutFixtureStream = z.object({ streamUrl: streamUrlSchema }).strict();
export type PutFixtureStream = z.infer<typeof PutFixtureStream>;

/** Match Day (spec 2026-10-31 §7): POST /fixtures/{id}/call and POST /fixtures/{id}/call/preview — the court to call the match
 *  onto, now. `.strict()` for the reason `PatchFixture` documents. */
export const CallFixtureInput = z.object({ court_id: CourtId }).strict();
export type CallFixtureInput = z.infer<typeof CallFixtureInput>;

/** POST /fixtures/{id}/call's answer: the match is on `court_id`, called (and timed) at `called_at`. */
export const FixtureCalled = z.object({
  fixture_id: Uuid,
  court_id: CourtId,
  called_at: z.iso.datetime({ offset: true }),
});

/** DELETE /fixtures/{id}/call's answer: the court and time the match is back on, as they were before the call (null when it had
 *  none). */
export const FixtureCallUndone = z.object({
  fixture_id: Uuid,
  court_id: CourtId.nullable(),
  scheduled_at: z.iso.datetime({ offset: true }).nullable(),
});

export const MatchDayRound = z.object({
  // The schedule board's chip text for the match's round ("QF", "SF", "F", "3rd", or its fallback "R2"), its full name ("Semi-finals",
  // "Round 2") in the reader's language, and whether the board codes it (a bracket role).
  code: z.string().min(1),
  label: z.string().min(1),
  coded: z.boolean(),
});

/** POST /fixtures/{id}/call/preview's answer (spec §7.1): the target court's matches the call pushes past their planned time
 *  (planned times are never written: `estimated_at` is an estimate), and the warnings the organiser confirms past (§7.2). The
 *  shape is `CallPreview` in lib/match-day/call.ts; the route test parses the real answer with this schema. */
export const FixtureCallPreview = z.object({
  shifts: z.array(
    z.object({
      fixture_id: Uuid,
      label: z.string(),
      round: MatchDayRound,
      planned_at: z.iso.datetime({ offset: true }),
      estimated_at: z.iso.datetime({ offset: true }),
    }),
  ),
  warnings: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pushes_later"), count: z.number().int().positive() }),
      z.object({
        kind: z.literal("rest_gap"),
        person_name: z.string(),
        minutes: z.number().int().nonnegative(),
        min_rest: z.number().int().positive(),
      }),
      z.object({ kind: z.literal("past_day_end"), court_name: z.string(), until: z.iso.datetime({ offset: true }) }),
      // Match Day E2 item 3: the court's closed windows (court_hours + court_exceptions) meet the match's expected span. A warning.
      z.object({
        kind: z.literal("crosses_closure"),
        court_name: z.string(),
        from: z.iso.datetime({ offset: true }),
        until: z.iso.datetime({ offset: true }),
      }),
      z.object({
        kind: z.literal("court_closed"),
        court_name: z.string(),
        until: z.iso.datetime({ offset: true }).nullable(),
        since: z.iso.datetime({ offset: true }).nullable(),
      }),
    ]),
  ),
});

/** Match Day's read model (spec 2026-10-31 §6.2, §7, §7.1, task A2). The shapes are lib/match-day/types.ts's; the route test
 *  parses each real answer with these. A match as Match Day shows it. */
export const MatchDayFixture = z.object({
  id: Uuid,
  division_id: Uuid,
  division_name: z.string(),
  division_slug: z.string(),
  fixture_no: z.number().int().positive(),
  sport_key: z.string(),
  stage_label: z.string(),
  round: MatchDayRound,
  home: z.string().nullable(),
  away: z.string().nullable(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  headline: z.string().nullable(),
  // `match_states.summary`, the shape PublicFixtureSummarySchema declares (defined further down this module, so restated).
  summary: z
    .object({
      headline: z.string().optional(),
      perSide: z.array(z.object({ entrantId: z.string(), line: z.string() })).optional(),
      detail: z.unknown().optional(),
    })
    .nullable(),
  // Who serves the next rally of a playing set-sport match, as the engine's serve reader says it over the ledger; null for
  // any other match, a sport with no serve, or when the engine does not know.
  serving: z.enum(["home", "away"]).nullable(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  called_at: z.iso.datetime({ offset: true }).nullable(),
  stream: z.enum(["live", "waiting"]).nullable(),
  // The desk's scorer attention for the match (in play, nothing recorded: nobody nominated, or the nominee silent past the grace).
  scorer_attention: z.enum(["no_scorer", "not_recording"]).nullable(),
  // While its stream is live: the YouTube video the stream goes into and that broadcast's made-for-kids stamp; null otherwise.
  live_video: z.object({ url: z.string(), made_for_kids: z.boolean() }).nullable(),
  // Match Day C2: the format a playing match plays, in the fixture page's own rules line (the court's read-only Match format);
  // null for a match not in play, and for a format the line has no words for.
  format_line: z.string().nullable(),
});

export const MatchDayCourt = z.object({
  court_id: Uuid,
  court_name: z.string(),
  // Match Day E2 item 5: the venue filter's key.
  venue_id: Uuid,
  venue_name: z.string(),
  // lib/venue.ts's VENUE_NOUNS (the route test pins the two equal; this module may not import @/).
  sport_noun: z.enum(["court", "pitch", "table", "board", "rink"]),
  state: z.enum(["playing", "called", "free", "in_use_elsewhere"]),
  current: MatchDayFixture.nullable(),
  in_use_by: z.string().nullable(),
  free_since: z.iso.datetime({ offset: true }).nullable(),
  queue: z.array(
    MatchDayFixture.extend({ planned_at: z.iso.datetime({ offset: true }), estimated_at: z.iso.datetime({ offset: true }) }),
  ),
  // Match Day E2 item 3: the court's closure today, from the scheduler's usable windows; null while open with no break to come.
  closure: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("now"), until: z.iso.datetime({ offset: true }).nullable() }),
      z.object({ kind: z.literal("later"), from: z.iso.datetime({ offset: true }), until: z.iso.datetime({ offset: true }) }),
    ])
    .nullable(),
});

export const MatchDayView = z.object({
  competition_id: Uuid,
  date: z.iso.date(),
  tz: z.string(),
  now: z.iso.datetime({ offset: true }),
  courts: z.array(MatchDayCourt),
  // B4 (owner ruling Q1): this competition's matches in play with no court, in live divisions, in kick-off order.
  playing_no_court: z.array(MatchDayFixture),
  needs_you: z.array(
    z.object({
      key: z.string(),
      severity: z.enum(["red", "amber", "slate"]),
      kind: z.string(),
      title: z.string(),
      sub: z.string(),
      action: z.object({ label: z.string(), href: z.string() }),
      // B4: Match Day's "Find a court" on an unscheduled row — only when the division has a ready match with no court; the
      // court it opens (the first free one that match may use), or null for the page's list.
      alt: z.object({ label: z.string(), href: z.string(), court_id: Uuid.nullable() }).optional(),
    }),
  ),
  results_owed: z.number().int().nonnegative(),
  fixtures_today: z.number().int().nonnegative(),
  // Match Day E2 item 5: the venues where this competition has a match today (the venue filter's default selection).
  venues_today: z.array(Uuid),
});

export const MatchDayCandidate = z.object({
  fixture: MatchDayFixture,
  source: z.enum(["this_court", "other_court", "no_court"]),
  from_court_name: z.string().nullable(),
  waiting_minutes: z.number().int().nonnegative(),
  behind_minutes: z.number().int().nonnegative(),
  // The match's planned time, when it has one (a match called elsewhere has none: the call replaced it).
  planned_at: z.iso.datetime({ offset: true }).nullable(),
  blocked: z
    .object({ kind: z.literal("player_busy"), person_name: z.string(), court_name: z.string().nullable() })
    .nullable(),
});

/** POST /fixtures/{id}/external-play/arbiter (T15, design §5.3; D16, §5.6.4) — the request names ONE PLAYER's meeting by the
 *  ENTRANT side (a board has a meeting per player, and nothing reads a meeting by colour, which a pairing card can swap).
 *  Strict: a missing side, another value or an extra key is a 400. */
export const ArbiterJoinInput = z.object({ side: z.enum(["home", "away"]) }).strict();
export type ArbiterJoinInput = z.infer<typeof ArbiterJoinInput>;

/** POST /fixtures/{id}/external-play/arbiter (T15, design §5.3; D16, §5.6.4) — the
 *  arbiter's OWN RealtimeKit token for that player's meeting (preset `arbiter`,
 *  receive-only), a FRESH participant per open (fix round 1, I2) whose id
 *  the client hands back when it leaves, the side joined, and the participant
 *  ids of the PLAYERS in that meeting (usually one), which its client subscribes
 *  to and refuses every other peer for. Never a player's token (spec §10). */
export const ArbiterJoinOut = z.object({
  authToken: z.string(),
  participantId: z.string(),
  side: z.enum(["home", "away"]),
  players: z.array(z.string()),
});

/** DELETE /fixtures/{id}/external-play/arbiter/{participantId} (T15 fix
 *  round 1, I2) — the panel closed: the server removes the caller's own
 *  arbiter participant from the meeting. `removed: false` when it was
 *  already removed (a repeat, the sweep, the room's teardown). */
export const ArbiterLeaveOut = z.object({ removed: z.boolean() });

/** POST /fixtures/{id}/external-play/resync (T15) — the organiser's
 *  reconcile (trigger `organiser`): did a read bring Lichess's truth, how many
 *  plies it added to the ledger, and whether it closed the board. */
export const ExternalPlayResyncOut = z.object({
  read: z.boolean(),
  adopted: z.number().int(),
  finished: z.boolean(),
});

/** POST /fixtures/{id}/external-play/video-override (D11, Task 8's
 *  organiserOverrideVideo) — the reason goes on the audit record. */
export const VideoOverrideInput = z.object({ note: z.string().trim().min(1).max(500) }).strict();
export type VideoOverrideInput = z.infer<typeof VideoOverrideInput>;
export const VideoOverrideOut = z.object({ overridden: z.literal(true) });

/** GET /fixtures/{id}/external-play/lobby (T16) — a signed-in player's door
 *  into their match room. The states are lobby.ts's LOBBY_STATES (kept in
 *  step by external-play-lobby-route.test.ts); `online_chess_off` carries no
 *  path — nothing has started and the club is not offered online chess. */
export const ExternalPlayLobbyOut = z.union([
  z.object({ state: z.literal("online_chess_off"), roomPath: z.null() }),
  z.object({
    state: z.enum(["not_opened", "before", "check_in", "closed", "playing", "held", "over"]),
    roomPath: z.string(),
    opensAt: z.string().nullable(),
    deadline: z.string().nullable(),
  }),
]);

/** POST /fixtures/{id}/external-play/resolve (T16) — the organiser settles
 *  an online board: the panel's buttons ("X wins", "Y wins", "Draw", and in
 *  place of a winner "No result" — the void — or the double walkover). The
 *  kinds are resolve.ts's RESOLVE_KINDS (kept in step by
 *  fixtures/[id]/external-play/__tests__/decision-routes.test.ts). */
export const ResolveExternalPlay = z
  .object({
    kind: z.enum(["home_wins", "away_wins", "draw", "no_result", "double_walkover"]),
  })
  .strict();
export type ResolveExternalPlay = z.infer<typeof ResolveExternalPlay>;

/** `finished`: the board has its result. `tiebreak_owed`: the draw opened a
 *  bracket tie-break, and the board waits for the organiser to pick who goes
 *  through. */
export const ResolveExternalPlayOut = z.object({
  status: z.enum(["finished", "tiebreak_owed"]),
});
export type ResolveExternalPlayOut = z.infer<typeof ResolveExternalPlayOut>;

/** POST /fixtures/{id}/external-play/flags/close (T16) — "Let the game go
 *  on": the flags the organiser was shown, by id. */
export const CloseExternalPlayFlags = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();
export type CloseExternalPlayFlags = z.infer<typeof CloseExternalPlayFlags>;
export const CloseExternalPlayFlagsOut = z.object({
  closed: z.number().int(),
  stillOpen: z.number().int(),
});

/** POST /fixtures/{id}/external-play/room/act (T14) — a player's intended
 *  move, draw offer/answer, resignation or abort, forwarded by T10's `act`.
 *  The uci length bound is a cheap first gate only: the strict UCI check is
 *  T3's `assertUci` (M5), server-side, and a suffixless promotion is refused
 *  there with 400 INVALID_UCI. No takeback: Lichess's Board API has none.
 *  `uci` carries a real move as its published example (final review M6): the generic example word, cut to the
 *  5-character bound, published "examp". */
export const RoomAct = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), uci: z.string().min(4).max(5).meta({ examples: ["e2e4"] }) }).strict(),
  z.object({ kind: z.literal("resign") }).strict(),
  z.object({ kind: z.literal("draw"), accept: z.boolean() }).strict(),
  z.object({ kind: z.literal("abort") }).strict(),
]);
export type RoomAct = z.infer<typeof RoomAct>;

/** POST /fixtures/{id}/external-play/room/camera-fault (T14 re-review 3,
 *  I-1) — the caller's browser left the meeting because it could not refuse
 *  a remote stream (D7), or is back. `participantId` names the caller's OWN
 *  seat in the meeting; the server checks it and stamps its own clock. */
export const RoomCameraFault = z
  .object({ state: z.enum(["start", "end"]), participantId: z.string().min(1).max(200) })
  .strict();
export type RoomCameraFault = z.infer<typeof RoomCameraFault>;

/** POST /fixtures/{id}/external-play/room/camera-report (D16, §5.6.3) — the caller's own camera, as THEIR browser last saw
 *  it: `live` (the camera is on) or `off`. `heartbeat` is true for a repeat of an unchanged state (the keep-alive that stops a
 *  live camera reading as unknown) and false for a CHANGE; the server stamps its own clock either way. The opponent's pill
 *  is the only thing that reads it. Strict. */
export const RoomCameraReport = z
  .object({ state: z.enum(["live", "off"]), heartbeat: z.boolean() })
  .strict();
export type RoomCameraReport = z.infer<typeof RoomCameraReport>;

/** POST /fixtures/{id}/external-play/room (D21-fix-3, F1) — the seat claim's OPTIONAL body. `heldParticipantId` is the
 *  participant whose token this browser already holds (the room sends it with every claim once it has one). A claim
 *  answered `camera_starting` then carries no token: the browser keeps the one it has, and the server saves a vendor
 *  request. A hint about what to SAVE, never a credential and never an authority: the server compares it with the
 *  caller's own participant on file, and no body (or null) means "I hold none" — the safe answer, which hands one. */
export const RoomSeatClaim = z
  .object({ heldParticipantId: z.string().min(1).max(200).nullable().optional() })
  .strict();
export type RoomSeatClaim = z.infer<typeof RoomSeatClaim>;

/** POST /fixtures/{id}/external-play/room/camera (D21-fix-3) - an OPTIONAL camera's token, asked for again by a player
 *  seated without one because the platform's call budget was spent (the seat answer said `cameraRetry`). No body. The
 *  answer: the caller's own participant token if there is one yet, and whether asking again can still bring one -
 *  `retry: false` with no token is FINAL (camera Off, an organiser's override, a vendor outage, a refused seat). */
export const RoomCameraAnswer = z
  .object({
    participant: z.object({ participantId: z.string(), authToken: z.string() }).strict().nullable(),
    retry: z.boolean(),
  })
  .strict();
export type RoomCameraAnswer = z.infer<typeof RoomCameraAnswer>;

/** Every reason T10 answers `reconcile: true` with: a Board API failure
 *  class, or a ledger that no longer replays. Typed both ways against the
 *  source unions, so a new code there fails compilation here. */
const ROOM_ACT_RECONCILE_REASONS = [
  "not_your_turn_or_over",
  "unplayable_time_control",
  "rate_limited",
  "unauthorized",
  "unavailable",
  "outcome_unknown",
  "unreplayable",
] as const satisfies readonly (BoardErrorCode | "unreplayable")[];
const ROOM_ACT_GRANT_REFUSALS = ["lichess_link_required", "lichess_reconsent_required"] as const satisfies readonly GrantRefusal[];
type _ReconcileReasonsCovered = Exclude<BoardErrorCode | "unreplayable", (typeof ROOM_ACT_RECONCILE_REASONS)[number]>;
type _GrantRefusalsCovered = Exclude<GrantRefusal, (typeof ROOM_ACT_GRANT_REFUSALS)[number]>;
const _roomActCovered: [_ReconcileReasonsCovered, _GrantRefusalsCovered] extends [never, never] ? true : never = true;
void _roomActCovered;

/** T10's PlayResult on the wire. `ended: true` ⇒ the move ended the game at
 *  Lichess (the room has already asked reconcile to close it). */
export const RoomActOut = z.union([
  z.object({ ok: z.literal(true), applied: z.boolean(), ended: z.literal(true).optional() }).strict(),
  z.object({ ok: z.literal(false), reconcile: z.literal(true), reason: z.enum(ROOM_ACT_RECONCILE_REASONS) }).strict(),
  z.object({ ok: z.literal(false), reconcile: z.literal(false), reason: z.enum(ROOM_ACT_GRANT_REFUSALS) }).strict(),
]);
export type RoomActOut = z.infer<typeof RoomActOut>;

export const FixtureStream = z.object({
  id: z.string(),
  stream_url: z.string().nullable(),
});
export type FixtureStream = z.infer<typeof FixtureStream>;
