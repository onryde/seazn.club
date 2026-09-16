import "server-only";
// The match room usecase (chess Lichess external-play redesign, Task 8 —
// spec §5 steps 6-7, §8.2, §12.1). Three entry points front every player
// interaction with the room:
//   - readMatchRoom   — GET. NEVER writes (spec §12.1: "GET never writes").
//   - checkInToMatchRoom — POST check-in. Stamps fixture_availability, pings
//     the lobby channel, then attempts a mint (a no-op unless this call was
//     the second check-in).
//   - mintIfReady     — the check-in-and-mint core (spec §8.2): claims the
//     row with a short, stale-recoverable claim, calls Lichess OUTSIDE any
//     transaction, then commits the result with an update conditional on
//     that SAME claim, so a takeover mid-flight can never stomp another
//     minter's work.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { publishExternalPlayLobby } from "@/lib/realtime";
import {
  MINT_CLAIM_STALE_MS,
  checkInCounts,
  roomPhase,
  windowFor,
  type RoomPhase,
} from "@/server/external-play/window";
import { defaultLichessAdapter } from "@/server/external-play/lichess/client";
import type { ExternalPlayAdapter, ExternalPlayStatus, NeedsReason } from "@/server/external-play/types";
import { verifyMatchRoomToken } from "@/server/usecases/match-room-token";
import { stampFixtureCheckIn } from "@/server/usecases/me";
import {
  effectiveBridge,
  ensureBridgeRow,
  loadOnlinePlayFixture,
  loadSides,
  resetStaleBridge,
  whiteSideOf,
  type OnlinePlayFixture,
  type Side,
  type SidePlayer,
} from "./guard";

/** The caller identifies as either a signed-in session (must be one of the
 *  two players) or a personal match-room link token (spec §12.1). */
export type RoomIdentity = { kind: "session"; userId: string } | { kind: "token"; token: string };

export type MatchRoomView = {
  fixtureId: string;
  phase: RoomPhase;
  opensAt: string;
  deadline: string;
  you: { side: Side; colour: "white" | "black"; checkedIn: boolean };
  opponent: { name: string; checkedIn: boolean };
  status: ExternalPlayStatus;
  needsReason: NeedsReason | null;
  /** Caller's own colour's Lichess URL — only once the challenge is ready
   *  AND the room is still inside its window (spec §12.1: expired past T+20
   *  even with a valid token shows status/result only, never a Play link). */
  playUrl: string | null;
  /** https://lichess.org/{challengeId} — once the game is live or finished. */
  watchUrl: string | null;
  /** Both checked in, phase open, no challenge minted yet — the client may
   *  POST a check-in/mint retry. */
  canMint: boolean;
};

export type RoomDeps = {
  now?: Date;
  adapter?: ExternalPlayAdapter;
  publish?: (fixtureId: string) => Promise<void>;
};

const ROOM_NOT_FOUND = () => new HttpError(404, "This match room could not be found", "NOT_FOUND");

/**
 * Which of the fixture's two players (if either) `identity` resolves to.
 * Session identity matches ONLY `SidePlayer.userId` (never personId alone —
 * a person with no linked user cannot open the room via session). Token
 * identity additionally requires the token's `fixtureId` to match THIS
 * fixture and its `scheduledAt` snapshot to match the fixture's CURRENT
 * `scheduledAt` (a reschedule after the link was minted kills the old link —
 * spec §12.1's `sat` claim). Every failure — bad signature, expired,
 * wrong fixture, stale `sat`, a personId that resolves to neither side —
 * collapses to the same `null`; the caller turns that into an identical 404
 * `NOT_FOUND` so a probe can never learn whether the fixture even exists,
 * let alone which specific check failed.
 */
export async function resolveRoomPlayer(
  identity: RoomIdentity,
  f: OnlinePlayFixture,
): Promise<SidePlayer | null> {
  const resolved = await resolveWithSides(identity, f);
  return resolved?.player ?? null;
}

/** Internal twin of `resolveRoomPlayer` that also hands back the already-
 *  loaded `{ home, away }` sides, so `readMatchRoom`/`checkInToMatchRoom`
 *  don't pay for a second `loadSides` round trip to build the rest of the
 *  view. */
async function resolveWithSides(
  identity: RoomIdentity,
  f: OnlinePlayFixture,
): Promise<{ player: SidePlayer; home: SidePlayer; away: SidePlayer } | null> {
  const { home, away } = await loadSides(f);
  if (identity.kind === "session") {
    const player = [home, away].find((s) => s.userId === identity.userId) ?? null;
    return player ? { player, home, away } : null;
  }
  const claims = await verifyMatchRoomToken(identity.token).catch(() => null);
  if (!claims || claims.fixtureId !== f.fixtureId) return null;
  if (Date.parse(claims.scheduledAt) !== f.scheduledAt.getTime()) return null; // rescheduled ⇒ link dead
  const player = [home, away].find((s) => s.personId === claims.personId) ?? null;
  return player ? { player, home, away } : null;
}

/** Check-in state for both sides, scoped by fixture_id AND the two resolved
 *  person ids. A side with no resolved `personId` (unrostered entrant, or a
 *  merge tombstone) can never have a row, so it is dropped from the `IN`
 *  list rather than compared against it — postgres.js's `sql([])` renders an
 *  empty list as `(null)`, which is at best a wasted round trip and, if both
 *  sides were ever personId-less, a query this function must not even
 *  attempt. */
async function checkIns(
  f: OnlinePlayFixture,
  home: SidePlayer,
  away: SidePlayer,
): Promise<{ home: boolean; away: boolean }> {
  const ids = [home.personId, away.personId].filter((p): p is string => p !== null);
  const rows =
    ids.length === 0
      ? []
      : await sql<{ person_id: string; checked_in_at: Date | null }[]>`
          select person_id, checked_in_at from fixture_availability
           where fixture_id = ${f.fixtureId}
             and person_id in ${sql(ids)}`;
  const at = (p: string | null) => (p === null ? null : (rows.find((r) => r.person_id === p)?.checked_in_at ?? null));
  return {
    home: checkInCounts(at(home.personId), f.scheduledAt),
    away: checkInCounts(at(away.personId), f.scheduledAt),
  };
}

/** Assembles the caller-facing view. Reads only — the one write this
 *  function's callers must never let it perform is why `effectiveBridge`
 *  (pure) is used here, never `resetStaleBridge`. */
async function buildView(
  f: OnlinePlayFixture,
  resolved: { player: SidePlayer; home: SidePlayer; away: SidePlayer },
  now: Date,
): Promise<MatchRoomView> {
  const { player, home, away } = resolved;
  const bridge = effectiveBridge(f);
  const phase = roomPhase(now, f.scheduledAt);
  const ci = await checkIns(f, home, away);
  const opponent = player.side === "home" ? away : home;
  const youCheckedIn = player.side === "home" ? ci.home : ci.away;
  const opponentCheckedIn = player.side === "home" ? ci.away : ci.home;

  const whiteSide: Side = bridge?.white_side ?? (await whiteSideOf(f));
  const colour: "white" | "black" = whiteSide === player.side ? "white" : "black";

  const status: ExternalPlayStatus = bridge?.status ?? "pending";
  const needsReason = bridge?.needs_reason ?? null;

  const playUrl =
    bridge && bridge.status === "ready" && phase === "open"
      ? colour === "white"
        ? bridge.url_white
        : bridge.url_black
      : null;

  const watchUrl =
    bridge && (bridge.status === "live" || bridge.status === "finished") && bridge.challenge_id !== null
      ? `https://lichess.org/${bridge.challenge_id}`
      : null;

  // Mirrors mintIfReady's own readiness gate (`!ci.home || !ci.away ||
  // !home.lichess || !away.lichess`) — an unlinked opponent means mintIfReady
  // will always return "not_ready", so the client must not be invited to
  // retry a check-in/mint POST that can never succeed (controller ruling:
  // unlinked player, both checked in ⇒ canMint false).
  const canMint =
    phase === "open" &&
    youCheckedIn &&
    opponentCheckedIn &&
    home.lichess !== null &&
    away.lichess !== null &&
    (!bridge || (bridge.status === "pending" && bridge.challenge_id === null));

  const w = windowFor(f.scheduledAt);
  return {
    fixtureId: f.fixtureId,
    phase,
    opensAt: w.opensAt.toISOString(),
    deadline: w.deadline.toISOString(),
    you: { side: player.side, colour, checkedIn: youCheckedIn },
    opponent: { name: opponent.displayName, checkedIn: opponentCheckedIn },
    status,
    needsReason,
    playUrl,
    watchUrl,
    canMint,
  };
}

/** GET the room. Guard failure or a caller who isn't one of the two players
 *  both 404 identically (do not reveal whether the fixture exists). NEVER
 *  writes — no `resetStaleBridge`/`ensureBridgeRow` call anywhere in this
 *  function's path; a stale bridge is simply hidden (`effectiveBridge`)
 *  until a write path (check-in, or a later cron pass) resets it. */
export async function readMatchRoom(
  identity: RoomIdentity,
  fixtureId: string,
  now?: Date,
): Promise<MatchRoomView> {
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) throw ROOM_NOT_FOUND();
  const resolved = await resolveWithSides(identity, f);
  if (!resolved) throw ROOM_NOT_FOUND();
  return buildView(f, resolved, now ?? new Date());
}

/**
 * POST check-in (spec §8.2 step 2). Order: guard → lazy stale-bridge reset →
 * identity → phase gate → stamp → publish → attempt mint → return the fresh
 * view. The phase gate runs AFTER identity resolution so a non-player still
 * gets an identical 404 outside the window (never a 409 that would leak "a
 * player exists, but you aren't one" through a different status code).
 */
export async function checkInToMatchRoom(
  identity: RoomIdentity,
  fixtureId: string,
  deps: RoomDeps = {},
): Promise<MatchRoomView> {
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) throw ROOM_NOT_FOUND();
  await resetStaleBridge(f);
  const resolved = await resolveWithSides(identity, f);
  if (!resolved) throw ROOM_NOT_FOUND();

  const now = deps.now ?? new Date();
  if (roomPhase(now, f.scheduledAt) !== "open") {
    throw new HttpError(409, "Check-in is closed for this match", "CHECK_IN_CLOSED");
  }

  const { player } = resolved;
  const personId = player.personId;
  if (personId === null) {
    // Unreachable in practice: resolveWithSides only ever matches a side
    // whose personId is already resolved (session matches on a solo
    // userId, which only exists alongside a resolved personId; token
    // matches directly on personId). Narrowed here — not asserted with `!`
    // — so this function's own type stays honest about SidePlayer.personId
    // being nullable in general.
    throw ROOM_NOT_FOUND();
  }
  await stampFixtureCheckIn(personId, f.fixtureId, f.orgId);
  await (deps.publish ?? publishExternalPlayLobby)(f.fixtureId);
  await mintIfReady(f, deps);
  return readMatchRoom(identity, fixtureId, now);
}

/**
 * The check-in-and-mint core (spec §8.2). Three separate statements — the
 * claim, the Lichess HTTP call, and the ready commit — deliberately never
 * wrapped in one `sql.begin`: a transaction held open across an outbound
 * HTTP call (up to `LICHESS_TIMEOUT_MS`) would hold a row lock, or in the
 * worst case a whole connection out of the pool, for the entire request.
 *
 * Claim safety: the claim UPDATE is conditional on the row being `pending`
 * with no challenge yet and either never claimed or claimed stale
 * (`MINT_CLAIM_STALE_MS` ago) — so a crashed/hung minter is recoverable
 * without a human. The READY commit is conditional not just on `status =
 * 'pending'` but on `mint_claimed_at` still equalling the EXACT value THIS
 * call just wrote: if some other caller's claim went stale and took over
 * mid-flight (bumping `mint_claimed_at` to ITS OWN value) before this call's
 * Lichess round trip returned, this call's ready UPDATE now matches zero
 * rows — it returns "busy" and does not publish, instead of overwriting the
 * new claimant's in-flight work with a stale (and possibly duplicate)
 * challenge. That is the one case a plain `status = 'pending'` guard on the
 * ready commit would miss (status never changed away from 'pending' during
 * a takeover — only `mint_claimed_at` did).
 */
export async function mintIfReady(
  f: OnlinePlayFixture,
  deps: RoomDeps = {},
): Promise<"minted" | "not_ready" | "busy" | "failed"> {
  const now = deps.now ?? new Date();
  if (roomPhase(now, f.scheduledAt) !== "open") return "not_ready";

  // A bridge already past 'pending' (ready/live/finished/needs_organiser) is
  // simply nothing to do — never "busy" (nobody is contesting it) and never
  // worth a Lichess round trip. `effectiveBridge` hides a STALE non-pending
  // bridge (isStale never applies to live/finished, so this only masks a
  // rescheduled ready/needs_organiser row), letting the reset+claim below
  // run against what is, in the current window, really a fresh 'pending'
  // fixture.
  const known = effectiveBridge(f);
  if (known && known.status !== "pending") return "not_ready";

  const { home, away } = await loadSides(f);
  const ci = await checkIns(f, home, away);
  if (!ci.home || !ci.away || !home.lichess || !away.lichess) return "not_ready";

  await resetStaleBridge(f);
  await ensureBridgeRow(f);

  const claimed = await sql<{ fixture_id: string }[]>`
    update fixture_external_play set mint_claimed_at = ${now}, updated_at = now()
     where fixture_id = ${f.fixtureId} and status = 'pending' and challenge_id is null
       and (mint_claimed_at is null or mint_claimed_at < ${new Date(now.getTime() - MINT_CLAIM_STALE_MS)})
     returning fixture_id`;
  if (claimed.length === 0) return "busy";

  const whiteSide = await whiteSideOf(f);
  const white = whiteSide === "home" ? home : away;
  const black = whiteSide === "home" ? away : home;
  // No-`!` narrowing (repo rule): the truthy check above covered
  // home.lichess/away.lichess, but TS cannot carry that through the
  // whiteSide-dependent reassignment into white/black.
  const wl = white.lichess;
  const bl = black.lichess;
  if (!wl || !bl) return "not_ready";

  const adapter = deps.adapter ?? defaultLichessAdapter();
  const deadline = windowFor(f.scheduledAt).deadline;
  try {
    const ch = await adapter.createOpenChallenge({
      // Outside any transaction — see this function's doc comment.
      whiteUsername: wl.username,
      blackUsername: bl.username,
      clock: f.clock,
      expiresAt: deadline,
    });
    const ready = await sql<{ fixture_id: string }[]>`
      update fixture_external_play
         set status = 'ready', challenge_id = ${ch.challengeId}, url_white = ${ch.urlWhite},
             url_black = ${ch.urlBlack}, white_side = ${whiteSide},
             white_lichess_id = ${wl.id}, black_lichess_id = ${bl.id},
             expires_at = ${deadline}, mint_claimed_at = null, last_error = null, updated_at = now()
       where fixture_id = ${f.fixtureId} and status = 'pending' and mint_claimed_at = ${now}
       returning fixture_id`;
    if (ready.length === 0) return "busy"; // lost the claim to a takeover mid-flight; do not publish
    await (deps.publish ?? publishExternalPlayLobby)(f.fixtureId);
    return "minted";
  } catch (err) {
    await sql`
      update fixture_external_play
         set mint_claimed_at = null, last_error = ${err instanceof Error ? err.message.slice(0, 500) : "mint_failed"}, updated_at = now()
       where fixture_id = ${f.fixtureId} and status = 'pending'`;
    return "failed";
  }
}
