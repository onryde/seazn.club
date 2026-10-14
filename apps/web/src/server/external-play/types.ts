// External-play bridge types (chess Lichess design 2026-09-15).
// Provider union leaves room for chess.com later; v1 only implements lichess.

export type ExternalPlayProvider = "lichess";

/** The two refusals T2's play gate can produce (preflight's `playGrantRefusal`).
 *  Declared HERE, in this import-free module, because api-v1/schemas.ts types
 *  its RoomAct answer with it and schemas.ts is part of the scripts program
 *  (`tsconfig.scripts.json`, node strip-types): importing it from preflight.ts
 *  pulled that server-only, `@/`-aliased module into the scripts typecheck
 *  (T14 review I6). preflight.ts re-exports it. */
export type GrantRefusal = "lichess_link_required" | "lichess_reconsent_required";

export type ExternalPlayStatus =
  | "pending"
  | "ready"
  | "live"
  | "finished"
  | "needs_organiser";

/** Spec §9 / row `needs_reason` — why a fixture landed in `needs_organiser`.
 *  The SAME SET as the `needs_reason` CHECK (V439, as V441 re-declares it).
 *  `token_revoked` / `double_walkover_blocked` are §3.6: a revoked token is
 *  not a no-show; a blocked double walkover is its own state.
 *  external-play-needs-organiser.test.ts reads the CHECK back from
 *  pg_constraint and fails if the two sets ever differ (order is not
 *  compared — it has no runtime meaning). */
export const NEEDS_REASONS = [
  "no_show_white",
  "no_show_black",
  "no_show_both",
  "not_started",
  "aborted",
  "mismatch",
  "provider_error",
  "token_revoked",
  "double_walkover_blocked",
  // V441 (T9 fix round 1, I2): a stale create whose outcome a lookup could
  // not prove — held for an organiser, never re-created blind.
  "create_outcome_unknown",
  // V441 (T12, spec §3.6; fix round 1, R2): a drawn game in a bracket stage,
  // written through the engine, whose fold now awaits its tie-break — ship 1
  // cannot create the tie-break game, so the organiser is told. Never decided.
  "tiebreak_owed",
  // V441 (T12 fix round 1, I2): Lichess ended the game for a fair-play
  // violation (status `cheat`) — the organiser's fair-play queue.
  "fair_play",
  // V441 (final review P11): a player re-linked a DIFFERENT Lichess account
  // while their game was live or mid-create — the recorded account is no
  // longer theirs, and its grant was revoked by the re-link (M-2).
  "account_changed",
] as const;
export type NeedsReason = (typeof NEEDS_REASONS)[number];

/** Lichess challenge clock: `limit` is initial time in seconds. */
export type LichessClock = { limit: number; increment: number };

/** Board API failure classes. Every one is a MEASURED response — see
 *  lichess/board-api.ts for the bodies and the dates. */
export type BoardErrorCode =
  | "not_your_turn_or_over"   // 400 "Not your turn, or game already over"  (M6)
  | "unplayable_time_control" // 400 "This game cannot be played with the Board API." (M12)
  | "rate_limited"            // 429 (M3 — creation; M4: moves are not limited)
  | "unauthorized"            // 401/403 — token revoked or wrong scope
  // createChallengeToUser: a DEFINITE failure — Lichess answered 4xx and
  // nothing was created. Every other call: any failure not classified above,
  // 5xx, network and timeout included (the split below is creation-only).
  | "unavailable"
  // createChallengeToUser only: timeout, network error, 5xx, or a 2xx with no
  // usable id — a challenge MAY exist at Lichess. Never release a creation
  // claim on this code: look the challenge up before any re-create (Task 3-5
  // review T3-I2). Synthetic: no 5xx or timeout was measured.
  | "outcome_unknown";

export type BoardCall = { ok: true } | { ok: false; code: BoardErrorCode; raw: string };

/** EVERY status Lichess can return, in the order the OpenAPI declares them
 *  (lichess-org/api doc/specs/schemas/GameStatusName.yaml at 59ebacb; the same
 *  14 cases as scalachess core/src/main/scala/Status.scala at 2ab0a40). A
 *  runtime list, not just a type, because the export is VALIDATED against it.
 *  `aborted` is NOT a synonym for "no game": M9 measured an early resign
 *  landing there with no winner. */
export const LICHESS_STATUSES = [
  "created", "started", "aborted", "mate", "resign", "stalemate", "timeout",
  "draw", "outoftime", "cheat", "noStart", "unknownFinish",
  "insufficientMaterialClaim", "variantEnd",
] as const;
export type LichessStatus = (typeof LICHESS_STATUSES)[number];

const LICHESS_STATUS_SET: ReadonlySet<string> = new Set(LICHESS_STATUSES);

export function isLichessStatus(value: string): value is LichessStatus {
  return LICHESS_STATUS_SET.has(value);
}

/** One export read. `whiteMs`/`blackMs` are null when the export carried no
 *  `clocks` array — null, never 0, because 0 would read as a flag (M11).
 *
 *  `status` is either a status Lichess declares or the explicit marker
 *  `"unrecognised"`, which carries Lichess's own word in `rawStatus` — so a
 *  status added after 2026-10-09 reaches an organiser instead of being read as
 *  one of ours (T12 routes it; a switch over `status` must handle it). */
export type GameSnapshot = {
  gameId: string;
  winner: "white" | "black" | null;
  movesSan: string[];
  whiteMs: number | null;
  blackMs: number | null;
  increment: number;
} & (
  | { status: LichessStatus }
  | { status: "unrecognised"; rawStatus: string }
);

/** The Board API stream's first line, `gameFull` — the reconcile read (spec
 *  §3.5, amended 5903962d4). Recorded 2026-10-11 (fixtures
 *  `gamefull-*.ndjson`): exact at every ply where the export stalls (M16).
 *  `movesUci` is lila's own UCI (king-to-king-square castling, a promotion
 *  suffix always — scalachess UciDump `legacyStandardCastling`), so it speaks
 *  the ledger's canonical form. `whiteMs`/`blackMs` are what each clock reads
 *  AT THE READ (lila `remainingTime`, clamped at zero), `incrementMs` is
 *  `state.winc`. `drawOffer` is lila's `wdraw`/`bdraw`, which it writes only
 *  when true. A player with no id (anonymous) is null. */
export type BoardGameFull = {
  gameId: string;
  whiteId: string | null;
  blackId: string | null;
  movesUci: string[];
  whiteMs: number;
  blackMs: number;
  incrementMs: number;
  winner: "white" | "black" | null;
  drawOffer: { white: boolean; black: boolean };
} & (
  | { status: LichessStatus }
  | { status: "unrecognised"; rawStatus: string }
);
