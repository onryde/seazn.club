import "server-only";
// Creation (spec §3.3). Claim-then-call, the shape mintIfReady already uses
// (room.ts): claim with a conditional UPDATE, call Lichess OUTSIDE any
// transaction, then commit with an UPDATE conditional on the SAME claim
// stamp — so a takeover mid-flight cannot stomp another minter's work.
//
// White's token challenges Black's username and Black's token accepts.
// Colour is READ from the pairing (whiteSideOf), never assigned here — W3
// owns colour allocation.
//
// CreateOutcome has no "busy": a lost claim answers `not_ready`, which is
// retry-safe, rather than `already`, which would promise the work is done
// while the other claimant may still fail.
//
// THE CLAIM IS TAKEN WHEN THE CREATE LEAVES THE QUEUE, not before it joins
// (controller ruling, T9 carry). The creation queue (T4) never sleeps, but a
// create still waits behind the ones ahead of it, and a claim stamped before
// that wait could go stale (MINT_CLAIM_STALE_MS, 30s) and hand a second
// claimant the same fixture — two games at Lichess for one board. Taken at
// dequeue, a claim lives only for the two HTTP calls (LICHESS_TIMEOUT_MS
// each), so it cannot age out from under its holder. At dequeue the fixture
// is re-read: a board withdrawn, re-paired, rescheduled or created by someone
// else while it waited is not created.
//
// A FAILED CREATE IS RELEASED ONLY WHEN NOTHING CAN EXIST AT LICHESS. A 429
// is lila refusing before it acts (M3), so the claim is released and the
// throttle's retryAt is recorded for the cron's retry. Every other create
// failure HOLDS the fixture for an organiser (needs_organiser) rather than
// releasing it: `outcome_unknown` (timeout, 5xx, a 200 with no id) may have
// created a challenge, and lila's create can insert and then answer a 400
// from its `.rescue` (Challenge.scala, review N4) — which reaches us as the
// same `unavailable` as a definite 4xx, so the two cannot be told apart. A
// hold is a status, not a stamp: a stamp goes stale in 30s, a status does
// not, so nothing re-creates the fixture behind the organiser's back. A
// rejected token is its own reason (spec §3.6: `token_revoked`, never a
// no-show).
//
// A CREATE THAT MAY HAVE REACHED LICHESS IS NEVER RE-SENT BLIND (fix round 1,
// I2). Before the challenge HTTP call, `create_sent_at` is written as its own
// committed statement; it is cleared only where the outcome is KNOWN (the game
// recorded, or a 429 lila refused before acting). A claim that carries it —
// stale because its minter died after Lichess answered and before the commit,
// or re-armed by an organiser — first looks the game up: White's outgoing
// challenges to Black, and White's ongoing games against Black. A candidate
// is adopted only when it is provably OUR create (fix round 2, N1): unrated,
// standard, the fixture's clock, and created within [create_sent_at − 60 s,
// now + 60 s] (symmetric since fix round 3, R2-1: a createdAt beyond it
// holds, never re-creates) — an ongoing game is verified through its export.
// A listed challenge carries NO createdAt (MEASURED live, T17 L1), so it is
// judged on its own fields — challenger, Black, clock, unrated, standard,
// White — inside our create window, which for a challenge is the lookup's
// own time: one we send leaves the list by +36 s (measured), so a match
// listed after marker + LICHESS_TIMEOUT_MS + 36 s cannot be our send. Every
// instant in these comparisons is the WALL clock (the recovery-clock task):
// the marker is dated at the send, and Lichess's time is read against the
// wall, never against a caller's `now` that may be minutes old. Such a
// match is a STRAY and is cancelled (controller ruling 2026-10-13: cancel a
// matching stray before re-creating). Exactly one candidate ⇒ adopt (a
// challenge is accepted with Black's token); none, with every lookup read ⇒
// re-create; two, or any candidate that cannot be verified, or any lookup
// failing ⇒ hold (`create_outcome_unknown`). Every Lichess call here is made
// ONE AT A TIME (Lichess API tips: "Only make one request at a time"): the two
// lookups, then each export in turn, then each stray cancel. The lookups are
// the claim's first segment; every later call is preceded by a claim write —
// a renewal before each export, each cancel and an adopted challenge's accept,
// or the marker write before a create — so no stretch of a claim's life spans
// more than two Lichess call-times (2 × LICHESS_TIMEOUT_MS <
// MINT_CLAIM_STALE_MS). A renewal that finds the claim gone ends the recovery
// there: the new claimant makes the rest of the calls.
//
// A GAME THIS CALL MADE BUT COULD NOT RECORD (its claim lost mid-flight) is
// cancelled at Lichess, best-effort, with White's token — unless another
// claimant has since recorded it as its own (fix round 1, Minor b).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { publishExternalPlayLobby } from "@/lib/realtime";
import { CreationRateLimited, enqueueCreation } from "@/server/external-play/creation-queue";
import {
  acceptChallenge,
  cancelChallenge,
  createChallengeToUser,
  exportGameMeta,
  listOngoingGames,
  listOutgoingChallenges,
  type GameMeta,
  type OutgoingChallenge,
} from "@/server/external-play/lichess/board-api";
import { boardOpenFor } from "@/server/external-play/round-open";
import { assertTimeControl, type TimeControl } from "@/server/external-play/time-controls";
import type { BoardErrorCode, NeedsReason } from "@/server/external-play/types";
import { LICHESS_TIMEOUT_MS, MINT_CLAIM_STALE_MS, boardCap, windowFor } from "@/server/external-play/window";
import { boardPhase } from "@/server/external-play/seat-line";
import { countedCheckIns } from "./check-ins";
import { log } from "@/server/logger";
import { getLichessAccessToken } from "../external-accounts";
import {
  effectiveBridge,
  ensureBridgeRow,
  loadOnlinePlayFixture,
  loadSides,
  onlinePlayClock,
  resetStaleBridge,
  whiteSideOf,
  type Side,
} from "./guard";
import { PLAYABLE_FIXTURE_STATUSES } from "./bridge-close";
import { onlineChessOffered } from "./online-chess-flag";
import { isPlayableFixtureStatus, playGrantRefusal, seatPlayer, type GrantRefusal } from "./preflight";

export type CreateOutcome =
  | { created: true; gameId: string }
  | {
      created: false;
      reason:
        | "not_ready"
        | "already"
        | "unplayable"
        | "provider_error"
        | "no_person"
        /** T20: the club is not offered online chess (the PostHog flag `online-chess` is off). A NEW game is a
         *  start; a game already on file answers `already` first, whatever the flag says, and a create already SENT
         *  is still looked up and adopted (fix round 1, m3) — this answers only once a new send is all that is left. */
        | "online_chess_disabled"
        | GrantRefusal;
    };

export type CreateGameDeps = {
  /** The caller's clock: judges the board's WINDOW only - the board's phase, the dequeue's phase, the row's expiry and the
   *  ready row's `updated_at` base. Never a claim's liveness stamp, never the marker, and never compared with Lichess's time. */
  now?: Date;
  publish?: (fixtureId: string) => Promise<void>;
  /** The WALL clock, read at the moment it is needed, never the caller's `now`, which can be minutes old by the dequeue (a sweep
   *  pass's start, a room request before the queue wait). It stamps the claim, every renewal and the marker write - both its
   *  claim (`mint_claimed_at`) and the marker itself (`create_sent_at`, the instant the create is sent) - and judges the
   *  takeover bound. The recovery reads Lichess's own time against it: a listing's instant, a game's createdAt (tolerances:
   *  LICHESS_TIMEOUT_MS for a listing, SENT_SKEW_MS for lila's clock). The sweep's liveness check (pass.ts gameMayBeOnFile)
   *  reads the claim column. Injectable for a test; production passes none. */
  clock?: () => Date;
};

/** The guard answers `null` for "not an online fixture" AND for a bye, so a
 *  bye cannot be told apart without this second read (plan premise P-B2-11).
 *  One query, only on the refusal path. */
async function classifyRefusedFixture(fixtureId: string): Promise<"no_person" | "not_ready"> {
  const [row] = await sql<{ home: string | null; away: string | null }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${fixtureId}`;
  if (!row) return "not_ready";
  return row.home === null || row.away === null ? "no_person" : "not_ready";
}

export async function createGameIfReady(
  fixtureId: string,
  deps: CreateGameDeps = {},
): Promise<CreateOutcome> {
  const now = deps.now ?? new Date();
  const f = await loadOnlinePlayFixture(fixtureId);
  if (!f) return { created: false, reason: await classifyRefusedFixture(fixtureId) };

  const { home, away } = await loadSides(f);
  // An unrostered entrant, or one whose sole member is a merge tombstone:
  // loadSides always returns a displayName but nulls personId
  // (guard.ts:223-271). There is nobody to seat, so this fixture is never
  // offered as an online match — it says so here rather than failing at
  // creation with a provider error nobody can read.
  const homePersonId = home.personId;
  const awayPersonId = away.personId;
  if (homePersonId === null || awayPersonId === null) {
    return { created: false, reason: "no_person" };
  }
  const homeUserId = home.userId;
  const awayUserId = away.userId;
  if (homeUserId === null || awayUserId === null) {
    // A person with no linked Seazn user has no Lichess token and cannot
    // submit a move; that is not a missing PERSON, it is an unready one.
    // (Unreachable through loadSide today, which resolves a person only
    // alongside its user; kept as the narrowing the token reads need.)
    return { created: false, reason: "not_ready" };
  }

  // Nothing to do for a bridge already past 'pending' — and a recorded
  // challenge id is the one case that means "someone already did this".
  const known = effectiveBridge(f);
  if (known?.challenge_id) return { created: false, reason: "already" };
  if (known && known.status !== "pending") return { created: false, reason: "not_ready" };

  // A withdrawn or walked-over board still LOADS (guard.ts excludes only
  // finalized/cancelled; measured 2026-10-09: a league withdrawal leaves it
  // `abandoned`). T8's predicate is the one authority for "still playable".
  if (!isPlayableFixtureStatus(f.fixtureStatus)) return { created: false, reason: "not_ready" };

  // D12: the window hangs off the organiser's open, never off the timetable.
  // A paired-but-unopened round has fixtures and no invitation; creating a
  // game for it would start a clock against people who were never called.
  const open = await boardOpenFor(sql, fixtureId);
  if (!open) return { created: false, reason: "not_ready" };
  // Spec §5.7.8: past the deadline and before the board's cap the create is still owed iff BOTH players' check-ins count (a
  // player the call budget was holding in the check-in line was seated and stamped at their arrival, in the window).
  const phase = await boardPhase(now, { fixtureId, anchor: open.anchor }, {
    personId: null,
    bothOnly: true,
    facts: async () => {
      const ci = await countedCheckIns(f, home, away, open.anchor);
      return { own: false, both: ci.home && ci.away };
    },
  });
  if (phase !== "open") return { created: false, reason: "not_ready" };

  // T20: a new game STARTS online play, so the club must be offered it (the PostHog flag `online-chess`). Asked only
  // of a board otherwise ready to create — after `already` (a recorded game is never refused) and before any token
  // is read or seat opened. No person asks here (the sweep or the room), so the club is asked as itself.
  //
  // Fix round 1, m3 (controller ruling): a create already SENT whose outcome was never recorded (I2's marker) may
  // have made a game at Lichess. Looking it up and adopting it FINISHES play, and finishing is never gated — so such a
  // board goes on, adopt-only, and the refusal lands at the dequeue, after the recovery, only if a NEW send is all
  // that is left. A board with no send on file is refused here, before anything is read.
  const startOffered = await onlineChessOffered({ orgId: f.orgId, userId: null });
  if (!startOffered && !(await createAlreadySent(fixtureId))) {
    return { created: false, reason: "online_chess_disabled" };
  }

  // T2's play gate, the one authority for "a grant that is enough to play":
  // a consent stamp AND every scope in PLAY_SCOPES (board:play to move,
  // challenge:write for White's create, challenge:read for the crash-recovery
  // lookup). Both players, or the game can be
  // created and then not played. The seat asks the same gate first (fix round
  // 2); this stays as defence, and answers by NAME, never a bare not_ready —
  // T14's re-link screen is drawn on these two reasons.
  for (const userId of [homeUserId, awayUserId]) {
    const refused = await playGrantRefusal(userId);
    if (refused) return { created: false, reason: refused };
  }

  // M12: creation succeeding proves nothing about playability, so the clock
  // is validated through T5's catalogue — the same gate the division save
  // runs (assertTimeControl). The guard has already mapped the stored clock
  // to Lichess's {limit, increment}; that maps back 1:1 onto the stored
  // {base, increment} (clock.ts), and a delay clock never reaches here (the
  // guard refuses it). Checked before the seats: a board that can never be
  // created should not open a meeting first.
  const tc = playableTimeControl(f.clock);
  if (!tc) return { created: false, reason: "unplayable" };

  // Re-verified HERE, immediately before creating: seatPlayer re-asks the meeting, which is what makes a pass that went
  // stale since preflight unable to let creation through (Review Focus 3). Both seats read THIS call's clock.
  //
  // D21-fix-3 (F2): `recheck` - nobody joins with this answer, so no token is minted or refreshed for it (D22: a token and
  // three reads per player, twice a board, were the calls the budget deferred), and a camera read ON within
  // SEAT_RECHECK_TRUST_MS stands (preflight.ts states the cost). A re-verify the budget could not afford is
  // `camera_starting` -> "not ready" below, which writes NOTHING (a deferral is not a failure of the board and must not
  // look like one: no last_error, no claim) - the sweep's mint retry (sweep.ts) creates the game on its next pass.
  const seats = await Promise.all([
    seatPlayer({ fixtureId, personId: homePersonId, recheck: true }, { now }),
    seatPlayer({ fixtureId, personId: awayPersonId, recheck: true }, { now }),
  ]);
  // A seat refused on the grant keeps its name (an unlink between our gate
  // and the seat); every other seat refusal is "not ready yet".
  for (const seat of seats) {
    if (!seat.seated && (seat.reason === "lichess_link_required" || seat.reason === "lichess_reconsent_required")) {
      return { created: false, reason: seat.reason };
    }
  }
  if (seats.some((s) => !s.seated)) return { created: false, reason: "not_ready" };

  // Colour is READ from the pairing. White's token creates, so White's
  // Lichess account is the queue's challenger: lila's per-challenger budget
  // is White's (creation-queue.ts).
  const whiteSide = await whiteSideOf(f);
  const white = whiteSide === "home" ? home : away;
  const black = whiteSide === "home" ? away : home;
  const whiteLichess = white.lichess;
  const blackLichess = black.lichess;
  if (!whiteLichess || !blackLichess) {
    // The play gate above read the same link rows, so this is an unlink
    // landing between the two reads — still not ready, never a guess.
    return { created: false, reason: "not_ready" };
  }

  const plan: CreationPlan = {
    fixtureId,
    homeEntrantId: f.homeEntrantId,
    awayEntrantId: f.awayEntrantId,
    scheduledAt: f.scheduledAt,
    whiteSide,
    white: { userId: whiteSide === "home" ? homeUserId : awayUserId, lichessId: whiteLichess.id },
    black: {
      userId: whiteSide === "home" ? awayUserId : homeUserId,
      lichessId: blackLichess.id,
      username: blackLichess.username,
    },
    tc,
    startOffered,
  };

  // The queue's in-flight dedupe hands a follower the leader's result
  // without running its job: only the caller whose job ran created anything
  // (fix round 1, Minor a).
  let ranHere = false;
  let step: QueueStep;
  try {
    step = await enqueueCreation({ key: fixtureId, challenger: whiteLichess.id }, () => {
      ranHere = true;
      return createAtDequeue(plan, deps.now, deps.clock ?? (() => new Date()));
    });
  } catch (err) {
    if (!(err instanceof CreationRateLimited)) throw err;
    // The queue refused (a held or spent challenger) or Lichess 429'd. Either
    // way nothing exists at Lichess and no claim is held. Recorded for the
    // cron's mint retry, which is what honours retryAt — the queue never
    // waits it out.
    await noteThrottled(fixtureId, err);
    return { created: false, reason: "provider_error" };
  }

  switch (step.stage) {
    case "created":
      if (!ranHere) return { created: false, reason: "already" };
      await (deps.publish ?? publishExternalPlayLobby)(fixtureId);
      return { created: true, gameId: step.gameId };
    case "already":
      return { created: false, reason: "already" };
    case "held":
      return { created: false, reason: "provider_error" };
    case "lost":
    case "refused":
      return { created: false, reason: "not_ready" };
    case "disabled":
      return { created: false, reason: "online_chess_disabled" };
  }
}

/** T20 fix round 1 (m3): does the board carry I2's sent marker — a create that may have reached Lichess? One read, on
 *  the flag-off path only. The dequeue re-reads it under the claim; this only decides whether to go that far. */
async function createAlreadySent(fixtureId: string): Promise<boolean> {
  const [row] = await sql<{ sent: boolean }[]>`
    select create_sent_at is not null as sent from fixture_external_play
     where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null`;
  return row?.sent === true;
}

type CreationPlan = {
  fixtureId: string;
  homeEntrantId: string;
  awayEntrantId: string;
  /** The board's start time as planned; `null` ⇒ none (ruling 2026-10-10). */
  scheduledAt: Date | null;
  whiteSide: Side;
  white: { userId: string; lichessId: string };
  black: { userId: string; lichessId: string; username: string };
  tc: TimeControl;
  /** T20: whether the club is offered online chess — a NEW send needs it; adopting an earlier send does not (m3). */
  startOffered: boolean;
};

type QueueStep =
  | { stage: "created"; gameId: string }
  | { stage: "already" }
  | { stage: "held" }
  | { stage: "lost" }
  | { stage: "refused" }
  /** T20: nothing to adopt, and the club is not offered a new send. */
  | { stage: "disabled" };

/**
 * The queued job: everything from the claim to the commit. Runs when the
 * create leaves the queue, so every read here is as fresh as the HTTP call
 * that follows it. TWO clocks (fix round 1, I1; the recovery-clock task):
 * `fixedNow` is the CALLER's `now` when it handed one (every production
 * caller does: the room its request's, the sweep its pass start), and it
 * judges the board's window only - the phase at dequeue, the row's expiry,
 * the ready row's `updated_at`. `clock` is the wall clock, read at each use:
 * it stamps every claim (`mint_claimed_at`: the claim, each renewal, the
 * marker write) and the marker itself (`create_sent_at`), and the recovery
 * reads Lichess's time against it. A claim stamped on the caller's clock
 * would be as old as that clock at birth - stale on arrival after a long
 * queue wait or a slow sweep pass - and its renewals would rewrite the same
 * instant; a marker dated on it would make our own send look older than it
 * is to the recovery that compares it with Lichess.
 */
async function createAtDequeue(plan: CreationPlan, fixedNow: Date | undefined, clock: () => Date): Promise<QueueStep> {
  const judgedAt = fixedNow ?? new Date();
  const { fixtureId } = plan;

  // Re-check: the board this call validated may have changed while it
  // waited. Each of these is a refusal before any claim, so there is
  // nothing to release.
  const g = await loadOnlinePlayFixture(fixtureId);
  if (!g) return { stage: "refused" };
  if (effectiveBridge(g)?.challenge_id) return { stage: "already" };
  if (!isPlayableFixtureStatus(g.fixtureStatus)) return { stage: "refused" }; // withdrawn while queued
  if (
    g.homeEntrantId !== plan.homeEntrantId ||
    g.awayEntrantId !== plan.awayEntrantId ||
    (g.scheduledAt?.getTime() ?? null) !== (plan.scheduledAt?.getTime() ?? null)
  ) {
    return { stage: "refused" }; // re-paired or rescheduled while queued
  }
  // DEADLINE_AFTER_MS is the deadline to have the game created (spec §3.6), measured at
  // the create, not where it joined the queue.
  // The same allowance as createGameIfReady's, judged at the dequeue (spec §5.7.8). The board's window is read HERE, at the dequeue,
  // not carried over from the plan (spec §3.2.2): an arbiter's +5 minutes that landed while the create waited in the queue has moved
  // the deadline, and judging the plan's snapshot would refuse a create the board is still owed - or, past it, size the row's expiry
  // from a deadline the players are no longer on. A round that was un-opened while the create waited has no window: refused.
  const open = await boardOpenFor(sql, fixtureId);
  if (!open) return { stage: "refused" };
  const anchor = open.anchor;
  const dequeuePhase = await boardPhase(judgedAt, { fixtureId, anchor }, {
    personId: null,
    bothOnly: true,
    facts: async () => {
      const both = await loadSides(g);
      const ci = await countedCheckIns(g, both.home, both.away, anchor);
      return { own: false, both: ci.home && ci.away };
    },
  });
  if (dequeuePhase !== "open") return { stage: "refused" };
  if ((await whiteSideOf(g)) !== plan.whiteSide) return { stage: "refused" }; // colours re-allocated
  const sides = await loadSides(g);
  const whiteNow = plan.whiteSide === "home" ? sides.home : sides.away;
  const blackNow = plan.whiteSide === "home" ? sides.away : sides.home;
  if (whiteNow.lichess?.id !== plan.white.lichessId || blackNow.lichess?.id !== plan.black.lichessId) {
    return { stage: "refused" }; // a player unlinked or re-linked while queued
  }

  await resetStaleBridge(g);
  await ensureBridgeRow(g);

  // Claim: conditional on pending, no challenge, and either never claimed or
  // claimed stale — so a crashed minter recovers without a human. RETURNING
  // the marker: a claim on a row that carries it is never sent blind (I2).
  // Stamped and judged on the WALL clock (`clock`), the one the sweep reads liveness against.
  const claimAt = clock();
  const claimed = await sql<{ create_sent_at: Date | null }[]>`
    update fixture_external_play set mint_claimed_at = ${claimAt}, updated_at = now()
     where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null
       and (mint_claimed_at is null or mint_claimed_at < ${new Date(claimAt.getTime() - MINT_CLAIM_STALE_MS)})
     returning create_sent_at`;
  const [claimRow] = claimed;
  if (!claimRow) return { stage: "lost" };
  let claim = claimAt;
  // THIS call's claim renewed to now, conditional on still holding it — before any Lichess call that would otherwise make a
  // claim segment longer than two call-times (the header). False: the claim is another claimant's now.
  const renewClaim = async (): Promise<boolean> => {
    const renewAt = clock();
    const renewed = await sql<{ fixture_id: string }[]>`
      update fixture_external_play set mint_claimed_at = ${renewAt}, updated_at = now()
       where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null
         and mint_claimed_at = ${claim}
       returning fixture_id`;
    if (renewed.length === 0) return false;
    claim = renewAt;
    return true;
  };

  // Both tokens BEFORE the create: a challenge Black's token cannot accept
  // must never be made. Read here, at the call, so a plaintext token lives
  // only as long as the request that needs it (spec §10). A token that is
  // stored but cannot be opened throws 503 LICHESS_TOKEN_UNAVAILABLE — that
  // propagates to the caller, after the claim is released.
  let whiteToken: string | null;
  let blackToken: string | null;
  try {
    whiteToken = await getLichessAccessToken(plan.white.userId);
    blackToken = await getLichessAccessToken(plan.black.userId);
  } catch (err) {
    await releaseClaim(fixtureId, claim, "token_unavailable");
    throw err;
  }
  if (!whiteToken || !blackToken) {
    await releaseClaim(fixtureId, claim, "no_stored_token");
    return { stage: "refused" };
  }

  // The game to commit: adopted from an earlier claimant's send, or sent now.
  let gameId: string | null = null;
  let accepted = false;
  let sentHere = false;
  if (claimRow.create_sent_at !== null) {
    // The recovery reads Lichess's time (a listing, a game's createdAt) against the WALL clock, as the marker was written on
    // it - never against `judgedAt`, which is this request's and can be minutes behind the instants it would be compared with.
    const found = await findSentGame(plan, whiteToken, claimRow.create_sent_at, clock, renewClaim);
    if (found.kind === "lost") return { stage: "lost" };
    if (found.kind === "unknown") {
      const held = await holdForOrganiser(fixtureId, claim, {
        needsReason: "create_outcome_unknown",
        lastError: `recover:${found.why}`,
      });
      return held ? { stage: "held" } : { stage: "lost" };
    }
    if (found.kind === "game") {
      // An ongoing game at Lichess: already accepted, so nothing to accept.
      gameId = found.id;
      accepted = true;
    }
    if (found.kind === "challenge") {
      // L1: an open challenge of ours, not yet a game — Black's token accepts
      // it below. The calls before it may already fill this claim's segment
      // (two call-times) and the accept is one more, so it is renewed first; a
      // claim lost by now accepts nothing (whoever holds it will find the same one).
      if (!(await renewClaim())) return { stage: "lost" };
      gameId = found.id;
    }
  }

  if (gameId === null && !plan.startOffered) {
    // T20 (fix round 1, m3): nothing of an earlier send to adopt — what is left is a NEW send, which starts online
    // play, and the club is not offered it. The claim goes; the marker stays, so whoever comes next looks again
    // before it ever sends (and the sweep's deadline hold still sees a create whose outcome nobody recorded).
    await releaseClaim(fixtureId, claim, "online_chess_disabled");
    return { stage: "disabled" };
  }

  if (gameId === null) {
    // The marker, as its own committed write, BEFORE the HTTP call — and the
    // claim renewed to this instant, so the two calls below cannot outlive it.
    // BOTH are the wall clock at this write (the recovery-clock task): the
    // marker is the instant the create is really sent, which a LATER request's
    // recovery compares with Lichess's own time (a listing, a game's
    // createdAt). Dated on the caller's `now` - a sweep pass's start, a room
    // request read before the queue wait - it was as old as that clock, and
    // past ~16 s of age our own still-listed challenge read as a stray.
    const markAt = clock();
    const marked = await sql<{ fixture_id: string }[]>`
      update fixture_external_play
         set create_sent_at = ${markAt}, mint_claimed_at = ${markAt}, updated_at = now()
       where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null
         and mint_claimed_at = ${claim}
       returning fixture_id`;
    if (marked.length === 0) return { stage: "lost" }; // nothing sent
    claim = markAt;

    // HTTP, outside every transaction.
    const made = await createChallengeToUser({
      whiteToken,
      blackUsername: plan.black.username,
      limitSeconds: plan.tc.limitSeconds,
      incrementSeconds: plan.tc.incrementSeconds,
    });
    if (!made.ok) {
      if (made.code === "rate_limited") {
        // M3: lila refused before it acted — nothing exists, so the marker
        // goes with the claim. Then THROW, so the queue holds this challenger
        // (CREATION_429_HOLD_MS). Returning a value here would leave the hold
        // unset and let every retry hit Lichess again inside the same minute.
        await releaseClaim(fixtureId, claim, `create:rate_limited: ${made.raw}`, { outcomeKnown: true });
        throw new CreationRateLimited({ message: made.raw || "Lichess rate limited the create" });
      }
      // The marker STAYS: whatever this was, a game may exist.
      await holdForOrganiser(fixtureId, claim, {
        needsReason: needsReasonFor(made.code),
        lastError: `create:${made.code}: ${made.raw}`,
      });
      return { stage: "held" };
    }
    gameId = made.challengeId;
    sentHere = true;
  }

  if (!accepted) {
    const acc = await acceptChallenge({ blackToken, challengeId: gameId });
    if (!acc.ok) {
      // The challenge EXISTS at Lichess. Record it, so the unique index makes
      // a second create impossible and reconcile can still find the game, and
      // hand the fixture to an organiser.
      let recorded: boolean;
      try {
        recorded = await holdForOrganiser(fixtureId, claim, {
          needsReason: needsReasonFor(acc.code),
          lastError: `accept:${acc.code}: ${acc.raw}`,
          game: { challengeId: gameId, plan },
        });
      } catch (err) {
        if (!isChallengeRecordedElsewhere(err)) throw err;
        return refuseRecordedElsewhere(fixtureId, claim, gameId);
      }
      if (recorded) return { stage: "held" };
      if (sentHere) await closeStray(fixtureId, gameId, whiteToken, "accept_failed_claim_lost");
      return { stage: "lost" };
    }
  }

  // A game created PAST the deadline (spec §5.7.8: both players' check-ins count and the board's cap has not passed) is expected
  // to run from its creation; the row's expiry is the deadline for a create inside the window, the board's cap for one past it.
  // Sized from the anchor read at the dequeue, BEFORE the claim above: an extension that landed before that read is in it. One that
  // lands between that read and the claim is not (it is the claim that makes a game on file, `bridgeGameOnFile`, and an extension
  // is refused from then on), so the expiry stays on the deadline the board had a moment earlier - never later than the board's own.
  const readyExpiresAt = judgedAt.getTime() < windowFor(anchor).deadline.getTime() ? windowFor(anchor).deadline : boardCap(anchor);

  // Ready: create + accept. T10's first accepted move flips it to `live`;
  // nothing here writes 'live'. white_side and BOTH Lichess ids are what T8's
  // re-entry after the deadline reads to recognise a seated player.
  let ready: { fixture_id: string }[];
  try {
    ready = await sql<{ fixture_id: string }[]>`
    update fixture_external_play
       set status = 'ready', challenge_id = ${gameId}, white_side = ${plan.whiteSide},
           white_lichess_id = ${plan.white.lichessId}, black_lichess_id = ${plan.black.lichessId},
           expires_at = ${readyExpiresAt},
           ${resetLedger()},
           mint_claimed_at = null, create_sent_at = null, last_error = null,
           -- The game's creation time, on the dequeue's clock: the sweep's expected end for a board that never started takes
           -- its base from it when the game was made past the deadline (spec §5.7.8, m8). A later rewrite of the row only moves that base later.
           updated_at = ${judgedAt}
     where fixture_id = ${fixtureId} and status = 'pending' and mint_claimed_at = ${claim}
     returning fixture_id`;
  } catch (err) {
    if (!isChallengeRecordedElsewhere(err)) throw err;
    return refuseRecordedElsewhere(fixtureId, claim, gameId);
  }
  if (ready.length === 0) {
    // Lost the claim to a takeover mid-flight: do NOT record, do not publish.
    // A game THIS call made is closed; an adopted one is left for whoever
    // holds the claim now (they will find it the same way this call did).
    if (sentHere) await closeStray(fixtureId, gameId, whiteToken, "claim_lost_mid_flight");
    return { stage: "lost" };
  }
  return { stage: "created", gameId };
}

/** N2 (T17 re-review; controller ruling 2026-10-13): fixture_external_play_challenge_idx is UNIQUE — a write of a game
 *  id some other fixture stored first. */
function isChallengeRecordedElsewhere(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505" && e.constraint_name === "fixture_external_play_challenge_idx";
}

/** N2: the id this call adopted was stored by another fixture before this call could record it — that fixture's game,
 *  never this one's, and never cancelled. Refused, never thrown: the claim goes and the marker STAYS, so whoever comes
 *  next looks again (and finds the id recorded, so not a candidate). */
async function refuseRecordedElsewhere(fixtureId: string, claim: Date, gameId: string): Promise<QueueStep> {
  log.warn({ fixtureId, challengeId: gameId }, "lichess: an adopted game was recorded by another fixture first; refused");
  await releaseClaim(fixtureId, claim, `recover:recorded_elsewhere:${gameId}`);
  return { stage: "lost" };
}

/** What an earlier claimant's send left at Lichess, as far as can be shown:
 *  an ongoing game (already accepted), an open challenge (to accept), nothing,
 *  or something that cannot be told apart from ours. */
type SentGame =
  | { kind: "none" }
  | { kind: "game"; id: string }
  | { kind: "challenge"; id: string }
  | { kind: "unknown"; why: string }
  /** The claim was lost at a renewal between two calls: nothing more is called, nothing written. */
  | { kind: "lost" };

/** Challenge statuses that are not a live invitation (ChallengeStatus,
 *  lichess-org/api spec): such a challenge can never become this game. */
const CLOSED_CHALLENGE = new Set(["canceled", "declined"]);

/** N1 (controller ruling, fix round 2; made symmetric in fix round 3, R2-1):
 *  a candidate counts as ours only if it was created within
 *  [create_sent_at − SENT_SKEW_MS, now + SENT_SKEW_MS]. Both ends are the
 *  WALL clock (the recovery-clock task): the marker is the wall clock at the
 *  write just before the send, and `now` the wall clock once the exports are
 *  read - so the skew is lila's clock against ours, in either direction, and
 *  nothing else. A createdAt EARLIER than the window is not ours (excluded);
 *  one LATER than it cannot be judged — a clock that far ahead could be hiding
 *  our own game — so it is unverified and holds, never re-creates. */
const SENT_SKEW_MS = 60_000;

/** MEASURED 2026-10-13 (T17 live probe, t17-live-lichess.md §1): an
 *  unaccepted challenge sent without `keepAliveStream` (ours never carries
 *  it) is listed at +2 s and gone from GET /api/challenge by +36 s — status
 *  `offline`, and still acceptable. A listing is the only clock a challenge
 *  has: ChallengeJson carries no createdAt (measured absent). */
const CHALLENGE_LISTED_MS = 36_000;

/** L1 (controller ruling 2026-10-13): the last instant at which a LISTED
 *  challenge can still be our send — it lands at most LICHESS_TIMEOUT_MS after
 *  the marker and stays listed at most CHALLENGE_LISTED_MS. A match listed
 *  later is somebody's challenge kept alive elsewhere, never ours. Inclusive.
 *  Compared with the listing's own instant on the wall clock (findSentGame's
 *  `listedAt`), as the marker is. */
const challengeWindowEnd = (sentAt: Date): number => sentAt.getTime() + LICHESS_TIMEOUT_MS + CHALLENGE_LISTED_MS;

type Verdict = "ours" | "not_ours" | "unverified";

/** A candidate's facts, each true (as our create made it), false (differs)
 *  or null (cannot be read). ANY difference proves it is not ours; otherwise
 *  any unreadable fact leaves it unverified — never adopted on a guess. */
function verdictOf(facts: Array<boolean | null>): Verdict {
  if (facts.some((f) => f === false)) return "not_ours";
  if (facts.some((f) => f === null)) return "unverified";
  return "ours";
}
const fact = <T>(v: T | null, ok: (v: T) => boolean): boolean | null => (v === null ? null : ok(v));

/** An ongoing game, judged on its export's static facts (board-api
 *  exportGameMeta; `clock.initial` is SECONDS there, as `plan.tc` is). */
function gameVerdict(m: GameMeta, plan: CreationPlan, sentAt: Date, now: Date): Verdict {
  return verdictOf([
    fact(m.rated, (r) => r === false),
    fact(m.variant, (v) => v === "standard"),
    fact(m.clockInitialSeconds, (x) => x === plan.tc.limitSeconds),
    fact(m.clockIncrementSeconds, (x) => x === plan.tc.incrementSeconds),
    fact(m.createdAtMs, (t) => t >= sentAt.getTime() - SENT_SKEW_MS),
    // Beyond now + skew: unverifiable (null ⇒ hold), never "not ours".
    m.createdAtMs === null ? null : m.createdAtMs <= now.getTime() + SENT_SKEW_MS ? true : null,
  ]);
}

/** A challenge not (yet) a game, judged on its own fields — MEASURED shape
 *  (T17 live probe, 2026-10-13). Our create is White's token challenging
 *  Black with rated=false, variant=standard, color=white and the fixture's
 *  clock. There is no time fact: the window is the listing's (above).
 *  N3 (T17 re-review): so a challenge a player sent BY HAND with every one of these fields cannot be told from ours —
 *  adopted inside the window when ours never landed, and cancelled with White's token as a stray past it; that
 *  follows from the controller's ruling (L1, 2026-10-13) and is accepted, not an oversight. */
function challengeVerdict(c: OutgoingChallenge, plan: Pick<CreationPlan, "white" | "tc">): Verdict {
  const tc = c.timeControl;
  // A declared non-clock type (correspondence, unlimited) is not ours.
  const isClock = tc === null ? null : tc.type === "clock";
  return verdictOf([
    fact(c.challengerId, (x) => x.toLowerCase() === plan.white.lichessId.toLowerCase()),
    fact(c.rated, (r) => r === false),
    fact(c.variantKey, (v) => v === "standard"),
    tc !== null && tc.type === "clock" ? fact(tc.limit, (x) => x === plan.tc.limitSeconds) : isClock,
    tc !== null && tc.type === "clock" ? fact(tc.increment, (x) => x === plan.tc.incrementSeconds) : isClock,
    fact(c.color, (x) => x === "white"),
  ]);
}

/**
 * I2's lookup: did an earlier claimant's create reach Lichess? Both lists are
 * read with White's token — the challenger's — one after the other, and either one
 * failing (or a page too full to prove absence) is "unknown", never "none":
 * only proof of absence may re-create. A candidate is White's challenge to
 * Black that is still open, or White's ongoing game, as White, against Black;
 * one already recorded on any bridge row is another fixture's game, not ours,
 * and beside another fixture of the same two players with a create out and
 * nothing recorded (N2), nothing is adopted and no stray is cancelled.
 * Each surviving candidate is then VERIFIED (N1): a game through its export
 * (one export at a time, each on a renewed claim), a challenge on its own fields and only
 * inside the window (L1); an id in both lists is the game. Exactly one
 * verified candidate is adopted; two are "unknown" (ambiguous); any candidate
 * that cannot be verified is "unknown" too. A challenge that MATCHES but is
 * listed past the window is a stray, cancelled after the exports, one at a
 * time, each on a renewed claim. `renew` answering false (the claim lost) is
 * `lost`: no further Lichess call.
 */
async function findSentGame(
  plan: CreationPlan,
  whiteToken: string,
  sentAt: Date,
  clock: () => Date,
  renew: () => Promise<boolean>,
): Promise<SentGame> {
  // The listing's instant, on the WALL clock (`sentAt` is the wall clock at the send): read BEFORE the call, the earliest
  // instant the list can describe. Lichess answers within LICHESS_TIMEOUT_MS, so the list is of some instant in
  // [listedAt, listedAt + LICHESS_TIMEOUT_MS]; judged at its start, a listed challenge is a stray only when it could not be
  // ours at ANY instant the list may describe - the call's own bound is the tolerance, and it errs toward "may be ours".
  const listedAt = clock();
  // One request at a time (Lichess API tips): the challenges, then the games — both read, whatever the first answers.
  const outgoing = await listOutgoingChallenges(whiteToken);
  const ongoing = await listOngoingGames(whiteToken);
  if (!outgoing.ok) return { kind: "unknown", why: `challenge_list:${outgoing.code}: ${outgoing.raw}` };
  if (!ongoing.ok) return { kind: "unknown", why: `ongoing_list:${ongoing.code}: ${ongoing.raw}` };
  if (!ongoing.complete) return { kind: "unknown", why: "ongoing_list:page_full" };

  const black = plan.black.lichessId.toLowerCase();
  const challenges = new Map<string, OutgoingChallenge>();
  for (const c of outgoing.challenges) {
    if (c.destUserId?.toLowerCase() === black && !CLOSED_CHALLENGE.has(c.status)) challenges.set(c.id, c);
  }
  const games = new Set<string>();
  for (const g of ongoing.games) {
    if (g.color === "white" && g.opponentId?.toLowerCase() === black) games.add(g.gameId);
  }
  const all = [...new Set([...challenges.keys(), ...games])];
  // N2 (T17 re-review; controller ruling 2026-10-13): another fixture of the SAME two players on the same clock (a
  // double round robin, two divisions) makes a challenge that agrees with ours on every field Lichess lists. ONE
  // statement — one snapshot — reads both what is already stored on any bridge (another fixture's game: never a
  // candidate, never a stray) and which other fixtures of these two players have a create out and nothing recorded
  // (a PEER in flight, invisible to the first read). A peer that commits after this read was in flight in it; one
  // that sends after it cannot be in the lists already read. Conservative on purpose: any member of either entrant,
  // colours and age unchecked — a peer with the colours reversed cannot list a candidate here (the lists are
  // filtered to White → Black), so at worst it costs a hold, never a wrong adoption; a merged-away member counts too.
  // N5 (T17 re-review 3; controller ruling 2026-10-13): IN FLIGHT means mid-create — the peer's bridge still
  // `pending` (not held for the organiser, not closed) under a fixture still playable (T8's predicate, as
  // bridge-close lists it). A settled board's marker stays on its row — bridge-close keeps it, as evidence the
  // organiser view shows — and without this it held every later recovery of the same two players for ever. A dead
  // fixture cannot record what we adopt: its claim refuses an unplayable fixture and a row not pending.
  const peers: string[] = [];
  if (all.length > 0) {
    const known = await knownElsewhere(plan.fixtureId, plan.white.lichessId, plan.black.lichessId, all);
    peers.push(...known.peers);
    for (const id of known.recorded) {
      challenges.delete(id);
      games.delete(id);
    }
  }

  // L1: a listed challenge is a candidate only while it can still be our
  // send; after that, one that matches ours is a stray.
  const inWindow = listedAt.getTime() <= challengeWindowEnd(sentAt);
  const open: Array<[string, Verdict]> = [];
  const strays: string[] = [];
  for (const [id, c] of challenges) {
    if (games.has(id)) continue; // an id in both lists is the game
    const v = challengeVerdict(c, plan);
    if (inWindow) open.push([id, v]);
    else if (v === "ours") strays.push(id);
  }

  // N2: with a peer in flight a stray may be the PEER's challenge — left, never cancelled.
  if (peers.length > 0 && strays.length > 0) {
    log.warn({ fixtureId: plan.fixtureId, strays, peers }, "lichess: a stray matching ours may be another fixture's create; not cancelled");
  }
  const toCancel = peers.length > 0 ? [] : strays;
  const gameIds = [...games];
  // One request at a time: each export in the ongoing list's order (`metas[i]` is `gameIds[i]`'s), then each stray cancel —
  // every one on a renewed claim, so the serial calls never stretch a claim segment past two call-times (the header).
  // A claim lost at a renewal leaves the strays not yet cancelled, ON PURPOSE (review m6): while the row is still `pending`
  // the claim's new holder runs this same lookup, lists the same strays and cancels them itself — two claimants cancelling
  // side by side is the overlap this serialisation exists to stop. A row that LEFT `pending` (a withdrawal or a void closed
  // the bridge mid-recovery) has no next holder, and its strays are left open ON PURPOSE (ruling I1, 2026-11-23): they are
  // matches listed past our window - by L1, somebody's challenge kept alive elsewhere, never ours - and on a closed board
  // nothing is re-created beside them. The sweep's `close_strays` (cancelClosedBoardStrays, below) cancels only what could
  // still be our own create; by the time this claim is stale, that is past its window too.
  const metas: Array<Awaited<ReturnType<typeof exportGameMeta>>> = [];
  for (const id of gameIds) {
    if (!(await renew())) return { kind: "lost" };
    metas.push(await exportGameMeta(id));
  }
  for (const id of toCancel) {
    if (!(await renew())) return { kind: "lost" };
    await cancelStray(plan.fixtureId, id, whiteToken);
  }
  // The wall clock after every export was read: a game cannot have been created later than its export answered, so this
  // bounds createdAt from above (gameVerdict adds SENT_SKEW_MS for lila's clock against ours).
  const now = clock();
  const ours: Array<{ id: string; kind: "game" | "challenge" }> = [];
  const unverified: string[] = [];
  const tally = (id: string, kind: "game" | "challenge", v: Verdict) => {
    if (v === "ours") ours.push({ id, kind });
    else if (v === "unverified") unverified.push(id);
  };
  gameIds.forEach((id, i) => {
    const m = metas[i]!;
    tally(id, "game", m.ok ? gameVerdict(m.meta, plan, sentAt, now) : "unverified");
  });
  for (const [id, v] of open) tally(id, "challenge", v);
  // N2: beside a peer in flight, nothing here can be told from the peer's create — held, never adopted.
  if (peers.length > 0 && ours.length + unverified.length > 0) {
    return { kind: "unknown", why: `peer_in_flight:${peers.join(",")}: ${[...ours.map((o) => o.id), ...unverified].join(",")}` };
  }
  if (unverified.length > 0) return { kind: "unknown", why: `unverified: ${unverified.join(",")}` };
  if (ours.length > 1) return { kind: "unknown", why: `ambiguous: ${ours.map((o) => o.id).join(",")}` };
  if (ours.length === 1) return { kind: ours[0]!.kind, id: ours[0]!.id };
  return { kind: "none" };
}

/** L1: a challenge that matches ours, listed past the window — not our send,
 *  but one Black could still accept beside the game this call makes or keeps.
 *  Cancelled with White's token (cancel works on an `offline` challenge too —
 *  measured). Best-effort: never throws; logs the ids, never a token. */
async function cancelStray(fixtureId: string, challengeId: string, whiteToken: string): Promise<void> {
  const out = await cancelChallenge({ token: whiteToken, challengeId });
  if (out.ok) {
    log.warn({ fixtureId, challengeId }, "lichess: cancelled a stray challenge matching ours, listed past the create window");
    return;
  }
  log.error({ fixtureId, challengeId, why: out.code }, "lichess: could not cancel a stray challenge matching ours");
}

/** N2's one read — ONE statement, one snapshot — for the recovery (findSentGame) and the closed-board cleanup alike: of
 *  `ids`, those already RECORDED on any bridge row (another fixture's game: never a candidate, never a stray), and the
 *  other fixtures of the same two players with a create IN FLIGHT (N5: the bridge `pending`, the marker set, nothing
 *  recorded, the fixture still playable) — a peer whose challenge cannot be told from this fixture's. Conservative on
 *  purpose (findSentGame's N2 note): any member of either entrant, colours and age unchecked. A HELD peer
 *  (`needs_organiser`) is not in flight (N5) - carried into the closed-board cleanup unchanged; PARKED, rcs-review m5. */
async function knownElsewhere(
  fixtureId: string,
  whiteLichessId: string,
  blackLichessId: string,
  ids: readonly string[],
): Promise<{ recorded: string[]; peers: string[] }> {
  const seen = await sql<{ kind: string; id: string }[]>`
    select 'recorded' as kind, challenge_id as id from fixture_external_play where challenge_id = any(${[...ids]})
    union all
    select 'peer' as kind, b.fixture_id::text as id
      from fixture_external_play b
      join fixtures f on f.id = b.fixture_id
     where b.fixture_id <> ${fixtureId} and b.challenge_id is null and b.create_sent_at is not null
       and b.status = 'pending'
       and f.status in ${sql(PLAYABLE_FIXTURE_STATUSES as string[])}
       and exists (
         select 1 from entrant_members em
           join persons p on p.id = em.person_id
           join user_external_accounts uea on uea.user_id = p.user_id and uea.provider = 'lichess'
          where em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
            and uea.external_user_id = ${whiteLichessId})
       and exists (
         select 1 from entrant_members em
           join persons p on p.id = em.person_id
           join user_external_accounts uea on uea.user_id = p.user_id and uea.provider = 'lichess'
          where em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
            and uea.external_user_id = ${blackLichessId})`;
  return {
    recorded: seen.filter((r) => r.kind === "recorded").map((r) => r.id),
    peers: seen.filter((r) => r.kind === "peer").map((r) => r.id),
  };
}

/** Why the closed-board cleanup stamped a board done (`strays_closed_reason`, V543's CHECK lists exactly these). Done means
 *  "nothing more THIS job can do", never "nothing of ours is open" - see cancelClosedBoardStrays. */
export type StraysClosedReason = "cancelled" | "not_listed" | "token_refused" | "no_token" | "unidentifiable" | "gave_up";

/** What the closed-board cleanup did for one board (the sweep's `close_strays`, sweep/close-strays.ts). */
export type ClosedBoardStrays =
  /** Stamped (`strays_closed_at`, `strays_closed_reason`): nothing more this job can do for the board. `cancelled` - every
   *  match listed inside the window was cancelled or was already over; `not_listed` - none was listed inside it, or the
   *  board was reached only after it (no call made); `token_refused` / `no_token` - White's token cannot list or cancel;
   *  `unidentifiable` - nothing to match ours by. NOT a promise that nothing of ours is open (the header's residual). */
  | { kind: "done"; cancelled: number; reason: StraysClosedReason }
  /** Owed to a later pass, NOT stamped: a 429 (`rateLimited` - the sweep stops the whole job for the pass), an answer that
   *  proves nothing (a 5xx, a 404: lila's 404 cannot be told from a 5xx here, so the next pass's listing decides - a gone
   *  challenge is not listed), or a same-pair create in flight. The sweep counts it and gives up after a bound. */
  | { kind: "retry"; cancelled: number; why: string; rateLimited: boolean }
  /** The row is no longer a closed board with an unrecorded create and the cleanup owed: nothing done. */
  | { kind: "skipped" };

/**
 * The challenges a CLOSED board left at Lichess (review m6; the recovery-clock / strays task, 2026-11-23; fix round 1, I1).
 * A board whose bridge closed (bridge-close: a withdrawal, a void, a result entered elsewhere) while it carried the sent
 * marker and no recorded game is never claimed again, so no recovery cancels what its create left.
 *
 * ONLY what could still be our create (controller ruling I1, 2026-11-23): a listed challenge is cancelled only while it can
 * still be our send by the recovery's OWN rule - L1's window after the marker (`challengeWindowEnd`: LICHESS_TIMEOUT_MS for
 * the send to land, CHALLENGE_LISTED_MS for it to stay listed), judged on the wall-clock instant of the listing, before the
 * call. A challenge carries no createdAt (measured absent, T17), so the listing's instant is the only clock it has, exactly
 * as in the recovery. A match listed later is somebody's challenge kept alive elsewhere - a player's own, or another
 * fixture's - and is NEVER cancelled here; a board reached after its window is stamped `not_listed` with no call at all,
 * which also bounds what a first deploy finds (every historical board is past it).
 *
 * THE RESIDUAL, accepted (I1): our own unaccepted challenge leaves the list ~36 s after the send and stays acceptable, while
 * this job reaches a board only once T9's last claim is stale (30 s after the marker at the earliest, then the next pass).
 * So it can almost never see our own challenge, and the board is stamped `not_listed` over a challenge Black can still
 * accept - logged once at warn with its age. Only recording the challenge id the moment the create answers (before the
 * accept) can close that: rcs-report.md residual 1, owed its own T9 task. With that id this job could cancel the one
 * challenge that is certainly ours, listed or not.
 *
 * Inside the window: one listing of White's outgoing challenges (White's token - the challenger's, the only one that can
 * cancel), then each match - to Black, still open, `challengeVerdict` "ours" - cancelled one at a time (Lichess API tips: no
 * parallel calls). A match listed inside the window cannot be told from a lookalike sent in it (N3, as in the recovery).
 * N2 holds here as in the recovery (`knownElsewhere`): a challenge recorded on any bridge is never touched, and beside a
 * same-pair create in flight nothing is cancelled and the board waits. N5 is carried over unchanged: a HELD same-pair peer
 * is not in flight, so its unrecorded challenge can be cancelled here - PARKED (rcs-review m5), its own task.
 * There is no claim: the row is finished, which every T9 claim refuses, and the sweep reaches it only once T9's last claim
 * has gone stale (`liveMintClaimSince`), after the last Lichess call a cut-off recovery could still make. The re-read below
 * does not repeat that fence or the sweep's org scope: both only move one way (no writer re-opens a finished bridge or
 * renews a claim on one, and a fixture never changes org), so a row the candidate read let through stays let through.
 *
 * `clock` is the wall clock (the sweep passes its own); the marker is the wall clock at its write (createAtDequeue).
 */
export async function cancelClosedBoardStrays(
  fixtureId: string,
  { clock = () => new Date() }: { clock?: () => Date } = {},
): Promise<ClosedBoardStrays> {
  const [row] = await sql<
    { orgId: string; homeEntrantId: string | null; awayEntrantId: string | null; config: unknown; sentAt: Date }[]
  >`
    select f.org_id as "orgId", f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId", d.config,
           ep.create_sent_at as "sentAt"
      from fixture_external_play ep
      join fixtures f on f.id = ep.fixture_id
      join divisions d on d.id = f.division_id
     where ep.fixture_id = ${fixtureId}
       and ep.status = 'finished' and ep.challenge_id is null and ep.create_sent_at is not null
       and ep.strays_closed_at is null
       and f.status not in ${sql(PLAYABLE_FIXTURE_STATUSES as string[])}`;
  if (!row) return { kind: "skipped" };
  const done = async (cancelled: number, reason: StraysClosedReason): Promise<ClosedBoardStrays> => {
    await sql`
      update fixture_external_play set strays_closed_at = now(), strays_closed_reason = ${reason}, updated_at = now()
       where fixture_id = ${fixtureId} and strays_closed_at is null`;
    log.info({ fixtureId, cancelled, reason }, "lichess: a closed board's strays are closed");
    return { kind: "done", cancelled, reason };
  };
  const notListed = (listedAt: Date, called: boolean) => {
    log.warn(
      { fixtureId, ageMs: listedAt.getTime() - row.sentAt.getTime(), called },
      "lichess: a closed board's create is no longer listed; a challenge of ours may still be acceptable at Lichess",
    );
    return done(0, "not_listed");
  };

  // I1: the listing's instant, read BEFORE anything else - on the wall clock, as the marker is. Past the window nothing
  // listed can be our send: no call.
  const listedAt = clock();
  if (listedAt.getTime() > challengeWindowEnd(row.sentAt)) return notListed(listedAt, false);

  // A board with a create sent had both seats; one emptied since leaves no pair to match a challenge against.
  if (row.homeEntrantId === null || row.awayEntrantId === null) return done(0, "unidentifiable");
  const whiteSide = await whiteSideOf({ orgId: row.orgId, fixtureId });
  const { home, away } = await loadSides({ homeEntrantId: row.homeEntrantId, awayEntrantId: row.awayEntrantId });
  const white = whiteSide === "home" ? home : away;
  const black = whiteSide === "home" ? away : home;
  const mapped = onlinePlayClock(row.config);
  const tc = mapped.ok ? playableTimeControl(mapped.clock) : null;
  if (white.userId === null || white.lichess === null || black.lichess === null || tc === null) {
    // Nothing to match ours by (an unlink, a clock no create could have sent): never a guess at whose challenge is whose.
    log.warn({ fixtureId, white: white.lichess !== null, black: black.lichess !== null, clock: tc !== null }, "lichess: a closed board's strays cannot be identified; left");
    return done(0, "unidentifiable");
  }
  const whiteToken = await getLichessAccessToken(white.userId);
  if (whiteToken === null) return done(0, "no_token");

  const listed = await listOutgoingChallenges(whiteToken);
  if (!listed.ok) {
    if (listed.code === "unauthorized") return done(0, "token_refused");
    return { kind: "retry", cancelled: 0, why: `challenge_list:${listed.code}`, rateLimited: listed.code === "rate_limited" };
  }
  const plan = { white: { userId: white.userId, lichessId: white.lichess.id }, tc };
  const blackId = black.lichess.id.toLowerCase();
  const matches = listed.challenges
    .filter((c) => c.destUserId?.toLowerCase() === blackId && !CLOSED_CHALLENGE.has(c.status) && challengeVerdict(c, plan) === "ours")
    .map((c) => c.id);
  if (matches.length === 0) return notListed(listedAt, true);
  const known = await knownElsewhere(fixtureId, white.lichess.id, black.lichess.id, matches);
  if (known.peers.length > 0) {
    log.warn({ fixtureId, matches, peers: known.peers }, "lichess: a closed board's strays may be another fixture's create; left for a later pass");
    return { kind: "retry", cancelled: 0, why: `peer_in_flight:${known.peers.join(",")}`, rateLimited: false };
  }
  const recorded = new Set(known.recorded);
  let cancelled = 0;
  let over = 0;
  let owed: string | null = null;
  for (const challengeId of matches) {
    if (recorded.has(challengeId)) continue;
    const out = await cancelChallenge({ token: whiteToken, challengeId });
    if (out.ok) {
      cancelled += 1;
      log.warn({ fixtureId, challengeId }, "lichess: cancelled a challenge a closed board left open");
      continue;
    }
    // lila's M6 400 ("Not your turn, or game already over"): nothing open to cancel. UNMEASURED for a challenge cancel - the
    // sentence is the Board API's move refusal - so this arm reads it as over only because that is what the words say.
    if (out.code === "not_your_turn_or_over") {
      over += 1;
      continue;
    }
    if (out.code === "unauthorized") return done(cancelled, "token_refused");
    owed = `cancel:${challengeId}:${out.code}`;
    // lila asked us to stop: no further call this pass - the rest of this board, and (the sweep) every board after it.
    if (out.code === "rate_limited") return { kind: "retry", cancelled, why: owed, rateLimited: true };
  }
  if (owed !== null) return { kind: "retry", cancelled, why: owed, rateLimited: false };
  // Nothing cancelled and nothing over: every match was another fixture's recorded game, so none of ours was listed.
  return cancelled + over > 0 ? done(cancelled, "cancelled") : notListed(listedAt, true);
}

/** Minor b: a game this call created and could not record. Cancel it with
 *  White's token (cancel also aborts an accepted, unplayed game — measured),
 *  unless some other claimant has recorded it since. Best-effort: never
 *  throws; logs the ids, never a token. */
async function closeStray(fixtureId: string, challengeId: string, whiteToken: string, why: string): Promise<void> {
  const [owner] = await sql<{ fixture_id: string }[]>`
    select fixture_id from fixture_external_play where challenge_id = ${challengeId}`;
  if (owner) {
    log.warn({ fixtureId, challengeId, why, recordedBy: owner.fixture_id }, "lichess: lost the claim; the game is recorded by its new claimant");
    return;
  }
  const out = await cancelChallenge({ token: whiteToken, challengeId });
  if (out.ok) {
    log.warn({ fixtureId, challengeId, why }, "lichess: cancelled a challenge this fixture could not record");
    return;
  }
  reportUnrecorded(fixtureId, challengeId, `${why}; cancel failed: ${out.code}`);
}

/** Spec §3.6: a token Lichess rejects is not a provider fault and not a
 *  no-show — it is its own reason. Everything else is provider_error. */
function needsReasonFor(code: BoardErrorCode): NeedsReason {
  return code === "unauthorized" ? "token_revoked" : "provider_error";
}

/** Release THIS call's claim (conditional on its own stamp, so a claim some
 *  other caller holds is never cleared) and leave the fixture pending for a
 *  retry. Used only where nothing can exist at Lichess. */
async function releaseClaim(
  fixtureId: string,
  claimAt: Date,
  error: string,
  o: { outcomeKnown?: boolean } = {},
): Promise<void> {
  // The sent marker survives a release unless THIS call proved nothing exists
  // (a 429): a claim released before its own send may sit on an earlier
  // claimant's unknown outcome.
  await sql`
    update fixture_external_play
       set mint_claimed_at = null, last_error = ${error.slice(0, 500)}, updated_at = now(),
           create_sent_at = case when ${o.outcomeKnown === true}::boolean then null else create_sent_at end
     where fixture_id = ${fixtureId} and status = 'pending' and mint_claimed_at = ${claimAt}`;
}

/** T16 (T10 carry): a NEW game on a pending row starts from the start
 *  position — the move ledger's nine columns (V454) back to empty, so no
 *  earlier game's moves, clocks or draw offer reach the new board (the room
 *  and the spectators' board both read them). Both writes that record a game
 *  on a pending row carry it. A fresh `sql` fragment per query (a list of
 *  assignments), never one shared Query object. */
const resetLedger = () => sql`
  moves_uci = '[]'::jsonb, move_count = 0, last_move_at = null, white_ms = null, black_ms = null,
  clock_increment_s = null, draw_offer_by = null, white_draw_offer_ply = null, black_draw_offer_ply = null`;

/** needs_organiser, conditional on THIS call's claim. With `game`, the
 *  challenge that exists at Lichess is recorded alongside — the unique index
 *  on challenge_id is what then makes a second create for the board
 *  impossible. Returns whether the row was written. */
async function holdForOrganiser(
  fixtureId: string,
  claimAt: Date,
  a: { needsReason: NeedsReason; lastError: string; game?: { challengeId: string; plan: CreationPlan } },
): Promise<boolean> {
  const g = a.game;
  const rows = await sql<{ fixture_id: string }[]>`
    update fixture_external_play
       set status = 'needs_organiser', needs_reason = ${a.needsReason},
           challenge_id = ${g ? g.challengeId : null},
           white_side = ${g ? g.plan.whiteSide : null},
           white_lichess_id = ${g ? g.plan.white.lichessId : null},
           black_lichess_id = ${g ? g.plan.black.lichessId : null},
           -- a recorded game is a known outcome; an unrecorded one stays marked
           create_sent_at = case when ${g !== undefined}::boolean then null else create_sent_at end,
           ${resetLedger()},
           mint_claimed_at = null, last_error = ${a.lastError.slice(0, 500)}, updated_at = now()
     where fixture_id = ${fixtureId} and status = 'pending' and mint_claimed_at = ${claimAt}
     returning fixture_id`;
  return rows.length > 0;
}

/** A refused or throttled create, recorded for the cron's retry (T13, which
 *  honours retryAt). Written only to a pending row nobody holds a claim on —
 *  never over another caller's in-flight attempt. */
async function noteThrottled(fixtureId: string, err: CreationRateLimited): Promise<void> {
  const retryAt = err.retryAt === null ? "unknown" : new Date(err.retryAt).toISOString();
  await sql`
    update fixture_external_play
       set last_error = ${`create:rate_limited (${err.reason}) retry_at=${retryAt}`.slice(0, 500)},
           updated_at = now()
     where fixture_id = ${fixtureId} and status = 'pending' and challenge_id is null
       and mint_claimed_at is null`;
}

/** A challenge exists at Lichess that this fixture does not record. Never
 *  silent: an operator can find the stray game by id. */
function reportUnrecorded(fixtureId: string, challengeId: string, why: string): void {
  log.error({ fixtureId, challengeId, why }, "lichess: created a challenge this fixture does not record");
}

/** T5's setup gate, read as a nullable. Only INVALID_TIME_CONTROL means
 *  "unplayable"; anything else propagates. */
function playableTimeControl(clock: { limit: number; increment: number }): TimeControl | null {
  try {
    return assertTimeControl({ base: clock.limit, increment: clock.increment });
  } catch (err) {
    if (err instanceof HttpError && err.code === "INVALID_TIME_CONTROL") return null;
    throw err;
  }
}
