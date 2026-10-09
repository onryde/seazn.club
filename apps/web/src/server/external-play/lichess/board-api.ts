import "server-only";
// Lichess Board API client (design §3.3-§3.5). Token-authenticated, one HTTP
// call per function, nothing long-lived — see the timeout note below.
//
// Every classification here is a MEASURED response, 2026-10-09:
//   M6  400 "Not your turn, or game already over" — ONE message, TWO states.
//       It means reconcile; it never means assume.
//   M12 400 "This game cannot be played with the Board API." — on a challenge
//       Lichess ACCEPTED at creation. Mapped separately from M6 because a
//       field configured on a bullet clock would otherwise read to every
//       player as "your turn ended".
//   M3  429 "Too many requests. Try again later." — creation only (M4: moves
//       are not rate-limited at speed).
// An unrecognised 400 is `unavailable`, never an acceptance: a body we have
// not measured is a body we do not understand.
//
// Creation alone splits its failures in two (Task 3-5 review T3-I2): a 4xx is
// lila REFUSING, so nothing exists; a timeout, network error, 5xx, or a 2xx
// with no usable id is `outcome_unknown`, because a challenge may exist.
import { LICHESS_TIMEOUT_MS } from "../window";
import { assertUci } from "./uci";
import { isLichessStatus, type BoardCall, type BoardErrorCode, type GameSnapshot } from "../types";

const DEFAULT_BASE = "https://lichess.org";

export type BoardApiDeps = { fetch?: typeof fetch; baseUrl?: string };

/** One of the caller's outgoing challenges, as the recovery lookup needs it. */
export type OutgoingChallenge = { id: string; destUserId: string | null; status: string };
/** One of the caller's ongoing games, from the caller's side. */
export type OngoingGame = { gameId: string; color: "white" | "black"; opponentId: string | null };
type Listed<T> = { ok: true } & T | { ok: false; code: BoardErrorCode; raw: string };

/** `nb`'s maximum on /api/account/playing (lichess-org/api spec). A page this
 *  full cannot prove a game is absent. */
const ONGOING_PAGE = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Every item or nothing: one entry we cannot read could be the very game a
 *  recovery is looking for, so it fails the whole list (`null`). */
function readOutgoing(raw: string): OutgoingChallenge[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed) || !Array.isArray(parsed.out)) return null;
  const out: OutgoingChallenge[] = [];
  for (const c of parsed.out) {
    if (!isRecord(c) || !nonEmpty(c.id) || typeof c.status !== "string") return null;
    if (c.destUser === null) {
      out.push({ id: c.id, destUserId: null, status: c.status });
      continue;
    }
    if (!isRecord(c.destUser) || !nonEmpty(c.destUser.id)) return null;
    out.push({ id: c.id, destUserId: c.destUser.id, status: c.status });
  }
  return out;
}

function readOngoing(raw: string): OngoingGame[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isRecord(parsed) || !Array.isArray(parsed.nowPlaying)) return null;
  const games: OngoingGame[] = [];
  for (const g of parsed.nowPlaying) {
    if (!isRecord(g) || !nonEmpty(g.gameId)) return null;
    if (g.color !== "white" && g.color !== "black") return null;
    if (!isRecord(g.opponent)) return null;
    const id = g.opponent.id;
    if (id !== null && !nonEmpty(id)) return null;
    games.push({ gameId: g.gameId, color: g.color, opponentId: id });
  }
  return games;
}

/** M6 and M12 are both 400s. Matched on the measured sentence, not on a
 *  substring that could drift: `includes`, so a trailing-field change in the
 *  JSON envelope does not silently reclassify a known state as unknown. */
const M6_MESSAGE = "Not your turn, or game already over";
const M12_MESSAGE = "This game cannot be played with the Board API.";

function classifyBoardError(status: number, raw: string): BoardErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400) {
    if (raw.includes(M12_MESSAGE)) return "unplayable_time_control";
    if (raw.includes(M6_MESSAGE)) return "not_your_turn_or_over";
  }
  return "unavailable";
}

/** Creation's failure classes. Status 0 is `call()`'s marker for a thrown
 *  fetch — the network failing or the 10s timeout firing — and neither, nor a
 *  5xx, proves lila did not commit the challenge before the failure. */
function classifyCreateError(status: number, raw: string): BoardErrorCode {
  if (status === 0 || status >= 500) return "outcome_unknown";
  return classifyBoardError(status, raw);
}

/**
 * One side's latest clock, in ms, from the export's `clocks` array — or null
 * when that side has no recorded state (never 0, which would read as a flag).
 *
 * `clocks` is one entry PER PLY, not one per side: lila builds it as
 * `interleave(history(firstMover), history(other))` (`bothClockStates`,
 * modules/core/src/main/game/data.scala, lichess-org/lila 7b53d2671, read
 * 2026-10-09). Every game we create is standard chess from the initial
 * position (`variant: "standard"` below), so White moved first: White's states
 * are the even indices, Black's the odd ones, and a side's CURRENT clock is
 * its LAST state. Indices 0 and 1 are each side's clock after its FIRST move —
 * which the recorded two-ply fixture cannot tell apart from "the current pair".
 */
function latestClockMs(clocks: unknown[], parity: 0 | 1): number | null {
  const last = clocks.length - 1;
  const index = last % 2 === parity ? last : last - 1;
  if (index < 0) return null;
  const centis = clocks[index];
  return typeof centis === "number" ? centis * 10 : null;
}

export function createBoardApi(deps: BoardApiDeps = {}) {
  const base = (deps.baseUrl ?? process.env.LICHESS_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const fetchFn = deps.fetch ?? fetch;

  /** Every call in this module — creation, accept, move, resign, draw, abort,
   *  export — is a single request under LICHESS_TIMEOUT_MS (10s). There are no
   *  long reads here BY DESIGN (§4: the streaming service was removed because
   *  our server submits both players' moves). If you are about to add a
   *  Lichess endpoint that streams NDJSON, this timeout will cut it off at ten
   *  seconds and the failure will look like a flaky network — do not raise the
   *  timeout, and do not open a stream. `keepAliveStream` is never sent. */
  async function call(
    path: string,
    init: { method: "POST" | "GET"; token?: string; body?: URLSearchParams },
  ): Promise<{ status: number; raw: string }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (init.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    try {
      const r = await fetchFn(`${base}${path}`, {
        method: init.method,
        headers,
        ...(init.body ? { body: init.body.toString() } : {}),
        signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
      });
      return { status: r.status, raw: await r.text().catch(() => "") };
    } catch {
      // Network error, or the AbortSignal firing. Same outcome as a 5xx, never
      // an uncaught throw into a usecase holding a claim.
      return { status: 0, raw: "" };
    }
  }

  const asCall = ({ status, raw }: { status: number; raw: string }): BoardCall =>
    status >= 200 && status < 300
      ? { ok: true }
      : { ok: false, code: classifyBoardError(status, raw), raw };

  return {
    async createChallengeToUser(a: {
      whiteToken: string; blackUsername: string;
      limitSeconds: number; incrementSeconds: number;
    }): Promise<{ ok: true; challengeId: string } | { ok: false; code: BoardErrorCode; raw: string }> {
      // Colour is READ from the pairing (global constraint): White's token
      // challenges Black's username, so `color=white` is a statement of who is
      // calling, not an allocation. Unrated only. Standard only (§12).
      const body = new URLSearchParams({
        "clock.limit": String(a.limitSeconds),
        "clock.increment": String(a.incrementSeconds),
        rated: "false",
        color: "white",
        variant: "standard",
      });
      const out = await call(`/api/challenge/${encodeURIComponent(a.blackUsername)}`, {
        method: "POST", token: a.whiteToken, body,
      });
      if (out.status < 200 || out.status >= 300) {
        return { ok: false, code: classifyCreateError(out.status, out.raw), raw: out.raw };
      }
      // A 200 whose body is not a JSON object (a proxy's HTML page, a literal
      // `null`) is not a created game either — and it must not THROW: the
      // caller holds a claim, and a challenge may already exist at Lichess.
      // Only the parse sits inside the try, so each of the two guards is
      // independently load-bearing (and independently mutation-tested).
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.raw || "{}");
      } catch {
        parsed = undefined;
      }
      const id = parsed !== null && typeof parsed === "object"
        ? (parsed as { id?: unknown }).id
        : undefined;
      if (typeof id !== "string" || id === "") {
        // A 200 with no id is not a game we can record — returning ok would let
        // T9 write `challenge_id = undefined` — but Lichess DID answer 2xx, so
        // the challenge may exist. Unknown, not a definite failure.
        return { ok: false, code: "outcome_unknown", raw: out.raw };
      }
      return { ok: true, challengeId: id };
    },

    async acceptChallenge(a: { blackToken: string; challengeId: string }): Promise<BoardCall> {
      return asCall(await call(
        `/api/challenge/${encodeURIComponent(a.challengeId)}/accept`,
        { method: "POST", token: a.blackToken },
      ));
    },

    async submitMove(a: { token: string; gameId: string; uci: string }): Promise<BoardCall> {
      // M5: assert BEFORE the call. Lichess would accept `e7e6xx` with a 200
      // and play `e7e6`, so there is no downstream place to catch this.
      const uci = assertUci(a.uci);
      return asCall(await call(
        `/api/board/game/${encodeURIComponent(a.gameId)}/move/${uci}`,
        { method: "POST", token: a.token },
      ));
    },

    async resignGame(a: { token: string; gameId: string }): Promise<BoardCall> {
      // M9: a resign after one move lands as `aborted` with no winner, after
      // two as `resign`. This call reports ok only; the reconcile decides what
      // happened.
      return asCall(await call(
        `/api/board/game/${encodeURIComponent(a.gameId)}/resign`,
        { method: "POST", token: a.token },
      ));
    },

    async offerOrAcceptDraw(a: {
      token: string; gameId: string; accept: boolean;
    }): Promise<BoardCall> {
      return asCall(await call(
        `/api/board/game/${encodeURIComponent(a.gameId)}/draw/${a.accept ? "yes" : "no"}`,
        { method: "POST", token: a.token },
      ));
    },

    async abortGame(a: { token: string; gameId: string }): Promise<BoardCall> {
      return asCall(await call(
        `/api/board/game/${encodeURIComponent(a.gameId)}/abort`,
        { method: "POST", token: a.token },
      ));
    },

    /** Cancel a challenge the token's owner SENT — and, if it was accepted but
     *  not yet played, abort the game (lila apiCancel; it accepts board:play
     *  and challenge:write). MEASURED 2026-10-10 (t9/lookup-spike.log): on an
     *  accepted game with no move, 200 {"ok":true}, and the game left White's
     *  ongoing list. T9 uses it to close a stray game it could not record —
     *  one call for both the unaccepted challenge and the accepted game, which
     *  /api/board/game/{id}/abort cannot do (a challenge is not yet a game). */
    async cancelChallenge(a: { token: string; challengeId: string }): Promise<BoardCall> {
      return asCall(await call(
        `/api/challenge/${encodeURIComponent(a.challengeId)}/cancel`,
        { method: "POST", token: a.token },
      ));
    },

    /** Recovery lookup A (T9 fix round 1, I2): the caller's OUTGOING
     *  challenges. GET /api/challenge is gated on `challenge:read` (lila
     *  `apiList = ScopedBody(_.Challenge.Read, _.Web.Mobile)`), which
     *  PLAY_SCOPES does not carry — MEASURED 2026-10-10 with a board:play +
     *  challenge:write token: 403 {"error":"Missing scope: challenge:read"}. So
     *  with today's scopes this always answers `unauthorized`. The success
     *  shape is the lichess-org/api spec's (challengeList ⇒ {in, out}:
     *  ChallengeJson[], `destUser` a ChallengeUser or null), NOT measured. */
    async listOutgoingChallenges(token: string): Promise<Listed<{ challenges: OutgoingChallenge[] }>> {
      const out = await call("/api/challenge", { method: "GET", token });
      if (out.status < 200 || out.status >= 300) {
        return { ok: false, code: classifyBoardError(out.status, out.raw), raw: out.raw };
      }
      const challenges = readOutgoing(out.raw);
      return challenges === null ? { ok: false, code: "unavailable", raw: out.raw } : { ok: true, challenges };
    },

    /** Recovery lookup B: the caller's ongoing games (no scope needed).
     *  MEASURED 2026-10-10: each entry carries `gameId` (equal to the id of
     *  the challenge that made it), `color` from the caller's side, and
     *  `opponent.id` — an accepted challenge appears here, an unaccepted one
     *  does not. `complete` is false on a full page: absence is then
     *  unproven. */
    async listOngoingGames(token: string): Promise<Listed<{ games: OngoingGame[]; complete: boolean }>> {
      const out = await call(`/api/account/playing?nb=${ONGOING_PAGE}`, { method: "GET", token });
      if (out.status < 200 || out.status >= 300) {
        return { ok: false, code: classifyBoardError(out.status, out.raw), raw: out.raw };
      }
      const games = readOngoing(out.raw);
      return games === null
        ? { ok: false, code: "unavailable", raw: out.raw }
        : { ok: true, games, complete: games.length < ONGOING_PAGE };
    },

    /** The reconcile read (§3.5). `clocks=true` because M11 makes this the
     *  authority on both clocks; `pgnInJson=false` because we read `moves`.
     *  No Authorization header — the export is public. null on 404, on a 5xx,
     *  and on any body missing id or a string status: a reconcile must retry
     *  rather than write a result from a shape it did not recognise. A STRING
     *  status Lichess has not declared is not null — it comes back as
     *  `status: "unrecognised"` with the word in `rawStatus`, because the game
     *  is real and retrying cannot make the status known (T3-I1).
     *
     *  A game STILL IN PLAY is exported late. For a requester lila does not
     *  trust — and this call is unauthenticated — `applyDelay` withholds the
     *  last 3 plies of BOTH `moves` and `clocks` once the game is past 5 plies
     *  (`delayMovesBy = 3`, `delayKeepsFirstMoves = 5`, lila
     *  modules/game/src/main/PgnDump.scala at 7b53d2671; read from source on
     *  2026-10-09, NOT measured). So mid-game, `movesSan` is a lower bound on
     *  what has been played and the clocks are a few plies stale; only a
     *  finished game's export is complete. A shorter `movesSan` than our own
     *  ledger is therefore not a takeback, and a stale clock is not a flag. */
    async exportGame(gameId: string): Promise<GameSnapshot | null> {
      const out = await call(
        `/game/export/${encodeURIComponent(gameId)}?clocks=true&pgnInJson=false`,
        { method: "GET" },
      );
      if (out.status < 200 || out.status >= 300) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(out.raw); } catch { return null; }
      // A literal `null` parses cleanly and would then throw on `.id`.
      if (parsed === null || typeof parsed !== "object") return null;
      const json = parsed as {
        id?: unknown; status?: unknown; winner?: unknown; moves?: unknown;
        clocks?: unknown; clock?: { increment?: unknown };
      };
      if (typeof json.id !== "string" || typeof json.status !== "string") return null;
      const clocks: unknown[] = Array.isArray(json.clocks) ? json.clocks : [];
      const moves = typeof json.moves === "string" ? json.moves.trim() : "";
      const status = json.status;
      const common: Omit<GameSnapshot, "status"> = {
        gameId: json.id,
        winner: json.winner === "white" || json.winner === "black" ? json.winner : null,
        movesSan: moves === "" ? [] : moves.split(/\s+/),
        // M11: `clocks` is CENTISECONDS (`[60000,60000]` beside
        // `clock.initial: 600`), so ×10 to ms. Absent ⇒ null, never 0 — a 0
        // would read to T11 as a flag.
        whiteMs: latestClockMs(clocks, 0),
        blackMs: latestClockMs(clocks, 1),
        increment: typeof json.clock?.increment === "number" ? json.clock.increment : 0,
      };
      // Validated, never cast: the 14 statuses are LICHESS_STATUSES (types.ts).
      return isLichessStatus(status)
        ? { ...common, status }
        : { ...common, status: "unrecognised", rawStatus: status };
    },
  };
}

const defaultApi = createBoardApi();
export const createChallengeToUser = defaultApi.createChallengeToUser;
export const acceptChallenge = defaultApi.acceptChallenge;
export const submitMove = defaultApi.submitMove;
export const resignGame = defaultApi.resignGame;
export const offerOrAcceptDraw = defaultApi.offerOrAcceptDraw;
export const abortGame = defaultApi.abortGame;
export const exportGame = defaultApi.exportGame;
export const cancelChallenge = defaultApi.cancelChallenge;
export const listOutgoingChallenges = defaultApi.listOutgoingChallenges;
export const listOngoingGames = defaultApi.listOngoingGames;
