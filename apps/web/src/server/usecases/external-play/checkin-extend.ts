import "server-only";
// The check-in extension (spec 2026-10-09 §3.2.2; owner-approved 2026-10-19): an arbiter adds CHECKIN_EXTEND_STEP_MS to a board's
// check-in while it is still OPEN - one board (`extendCheckin`), or every board of an opened round whose check-in is open right
// now (`extendRoundCheckin`, each board its own atomic step).
//
// WHO. Exactly the people who may use the arbiter panel: a signed-in owner or admin of the club (`requireWatcher`, the panel's
// own gate - the route's `requireResourceAuth(..., "write")` is the first half), who does not PLAY on the board (C1, D7: the
// arbiter panel never lists a board its viewer plays on, and an organiser must not give their own board more time).
//
// WHAT MOVES. Only the board's bridge row: `checkin_extra_ms` += one step, `checkin_extensions` += 1. The board's deadline is
// `T_batch + DEADLINE_AFTER_MS + checkin_extra_ms` in window.ts's `windowFor` and nowhere else, so every reader of the window -
// the seat, the room snapshot (the player's countdown), the check-in count, the create and its line cap, the no-show, the
// teardown, the invite and resend, the organiser's views - sees the extension through the board's anchor with no code of its own
// (batch-anchor-source-guard.test.ts pins that every anchor is built with it).
//
// WHEN IT IS ALLOWED. While that board's check-in is open: after it opens, BEFORE its (extended) deadline, no game on file, the
// board still to be played, under CHECKIN_EXTEND_MAX presses (`extendRefusal`, window.ts - the one rule; the single-board door
// answers each refusal with its own 409 code, the round-wide one counts them).
//
// THE RACE. The sweep's no-show and teardown judge "the deadline has passed" and then act destructively (a walkover; ending the
// players' rooms); an extension decides "the deadline has NOT passed" and moves it. Both take the board's check-in-window lock
// (`lockCheckinWindow`, an advisory lock keyed by the board), then READ the deadline under it - so whichever comes second sees
// the other's write: an extension that commits first is seen by the sweep (no walkover); a sweep that judged first made its
// judgement on a clock this extension's own clock (read AFTER the lock, so never earlier) has already passed, and the extension
// is refused `closed`. BOTH read that clock from the DATABASE (`clock_timestamp()` inside the locked transaction), never from the
// machine they run on: two clocks that disagree by a few seconds would let the extension find the window open after the sweep
// found it closed (a forfeit over a board that was just given more time), and one clock cannot disagree with itself. The create has no row lock to share (claim-then-call, a conditional UPDATE of `mint_claimed_at`), so an
// extension racing it is decided by the same facts under this lock: a claim or a marker on the row is a game on file.
//
// AUDIT. One `online_chess_audit` row per board extended (kind `checkin_extend`, V465): the actor, the board, and in `note` the
// scope, the board's press count and its new deadline. No new event type is invented: competition_events is the ledger of
// SETTINGS and results, not of an arbiter's act on one board.
//
// THE INVITES (email outbox, Task 8 and its follow-up). A chess invite is queued with `expires_at` = the board's deadline at the time,
// and the worker ends a still-queued row past it `expired`, unsent; and its SEALED BODY names that deadline. The same transaction
// therefore does two things for the board's two seats:
//   - RE-RENDERS what can safely be (`requeueUnsentInvites`): a recipient whose newest invite is `queued` AND that no request can have
//     reached the provider with (never attempted, or its only attempt answered 429) gets a fresh invite naming the NEW deadline, on the SAME
//     stamp, which retires the stale row (the V470 replace trigger); it keeps the retired row's place in the retry schedule. Any other
//     invite is not re-rendered, so no extension ever sends an extra email (controller ruling): a `sending`, `sent`, `delayed`,
//     `delivered` or ended one is out of reach, and a queued one that already had an attempt answered by a network error or a 5xx may
//     have been accepted with the answer lost, where a fresh row's new idempotency key would mail twice - it keeps its key and its
//     body, and the match room shows the live deadline. The fresh rows are dispatched after the commit (`deps.dispatch`,
//     `dispatchNow`: paced and budgeted, as the open's). The seat stamp on the bridge row is not written, so the seat stays invited
//     and the chess hook still finds its rows. This work runs in a SAVEPOINT: if the mail cannot be built the press still goes
//     through, the failure is logged, and the invites keep the deadline they were written with;
//   - moves the expiry of the retryable invites that remain (`extendEmailExpiry`), so a retry between the old deadline and the new
//     one is delivered, not expired - except a waiting invite that could have been re-rendered but got no fresh row (its recipient
//     left the seat; its stamp is unreadable): its body names the old deadline, so it ends unsent at it.
// A failure of the deadline's own writes, or of the expiry move, rolls the extension back with it. The transaction is the POOLED
// connection (`sql.begin`, privileged, as the worker's), not `withTenant`: V470 gives `app_user` INSERT only.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import { dispatchNow, extendEmailExpiry } from "@/server/email-outbox";
import { errFields } from "@/server/email-outbox/err-fields";
import { log } from "@/server/logger";
import { publishExternalPlayLobby } from "@/lib/realtime";
import {
  CHECKIN_EXTEND_STEP_MINUTES,
  EXTEND_REFUSAL_CODES,
  type CheckinExtendBoardResult,
  type CheckinExtendRoundResult,
  type ExtendRefusal,
} from "@/lib/checkin-extend";
import type { AuthCtx } from "@/server/api-v1/auth";
import { boardOpenFor, lockCheckinWindow, roundOpenAt } from "@/server/external-play/round-open";
import {
  CHECKIN_EXTEND_STEP_MS,
  boardAnchor,
  bridgeGameOnFile,
  extendRefusal,
  extensionsLeft,
  windowFor,
} from "@/server/external-play/window";
import { requireWatcher } from "./arbiter";
import { ensureBridgeRow, loadOnlinePlayFixture, type OnlinePlayFixture } from "./guard";
import { SeatsNeeded, boardSeats, requeueUnsentInvites } from "./invite";
import { isPlayableFixtureStatus } from "./preflight";
import { isSeatedOn } from "./seated";
import { CHESS_SEAT_REF_TYPE, chessSeatRef } from "./seat-stamp";

export type ExtendDeps = {
  /** The decision clock. Production leaves it out: the database's own clock is read AFTER the board's lock is held (the race rule
   *  above). A test sets it to put the decision at an instant of its choosing. */
  now?: () => Date;
  /** The room nudge that makes a player's open room re-read its deadline at once. */
  publish?: (fixtureId: string) => Promise<void>;
  /** The first send of the invites the extension re-rendered, after the commit (default: the outbox's `dispatchNow`, with `now` as the
   *  decision clock when one is set). A test replaces it to see what was asked, and when. */
  dispatch?: (ids: readonly string[], opts: { now?: Date }) => Promise<unknown>;
};

type Scope = "board" | "round";

/** What one board's locked step decided. `refused` carries whether a game was on file, for the round-wide count of a settled board. */
type Step =
  | { ok: true; board: CheckinExtendBoardResult; /** The fresh invites the step queued (to be dispatched after the commit). */ inviteIds: string[] }
  | { ok: false; refusal: ExtendRefusal; gameOnFile: boolean };

/** One board, one transaction: lock the board's check-in window, re-read everything the rule asks under it, then either refuse or
 *  move the deadline and write the audit row. NOTHING is written on a refusal - not even the board's bridge row: a board nobody has
 *  touched has none, and a refusal (a withdrawn board, a closed window) must not leave one behind; the row is made only for a board
 *  that is about to be extended. Lock order (preflight.ts `organiserOverrideVideo`): the window lock first, then the fixture row
 *  BEFORE the bridge row, then the audit insert (which takes KEY SHARE on the fixture). */
async function extendOneBoard(
  a: { f: OnlinePlayFixture; actorUserId: string; scope: Scope },
  deps: ExtendDeps,
): Promise<Step> {
  // The board's seats are needed only to re-render an invite that is still waiting, and reading them takes pooled connections, which
  // this transaction (one of the pool's five) must not wait for (lib/db.ts: the nesting guard). So the first pass goes without them;
  // if an invite IS waiting it rolls back (`SeatsNeeded`, nothing written), the seats are read outside any transaction, and the second
  // pass has them. The common case - every invite already sent - never reads them.
  try {
    return await extendInTx(a, deps, null);
  } catch (err) {
    if (!(err instanceof SeatsNeeded)) throw err;
  }
  return extendInTx(a, deps, await boardSeats(a.f));
}

async function extendInTx(
  a: { f: OnlinePlayFixture; actorUserId: string; scope: Scope },
  deps: ExtendDeps,
  seats: Awaited<ReturnType<typeof boardSeats>> | null,
): Promise<Step> {
  const { fixtureId, orgId } = a.f;
  return sql.begin(async (tx): Promise<Step> => {
    await lockCheckinWindow(tx, fixtureId);
    const [fx] = await tx<{ status: string; roundNo: number }[]>`select status, round_no as "roundNo" from fixtures where id = ${fixtureId} for share`;
    const readRow = async () =>
      (
        await tx<{ status: string; challengeId: string | null; createSentAt: Date | null; mintClaimedAt: Date | null }[]>`
          select status, challenge_id as "challengeId", create_sent_at as "createSentAt", mint_claimed_at as "mintClaimedAt"
            from fixture_external_play where fixture_id = ${fixtureId} for update`
      )[0];
    const open = await boardOpenFor(tx, fixtureId);
    // Not "cannot happen" in a comment: the caller proved the round open, so a missing fixture or open is the board changing
    // underneath this call (a rebuild removed the fixture) - refused by name. A missing BRIDGE ROW is not: it is a board nobody
    // has touched (the open invites through it, but a board added since, or one that was re-paired, has none yet).
    if (!fx || open === null) throw new HttpError(409, "the board changed while its check-in was being extended - try again", "ROUND_CHANGED");
    // The rule asked of the row as it stands, on the decision clock: read AFTER the lock, from the database (the race rule above), and
    // read again at every decision, so a decision is never made on a clock older than the row it reads.
    const decide = async (r: Awaited<ReturnType<typeof readRow>>) => {
      const at = deps.now ? deps.now() : (await tx<{ at: Date }[]>`select clock_timestamp() as at`)[0]!.at;
      const gameOnFile = r ? bridgeGameOnFile(r, at) : false;
      const refusal = extendRefusal({
        now: at,
        anchor: open.anchor,
        extensions: open.extensions,
        playable: isPlayableFixtureStatus(fx.status) && r?.status !== "finished",
        gameOnFile,
      });
      return { refusal, gameOnFile, at };
    };
    let row = await readRow();
    let decision = await decide(row);
    if (decision.refusal !== null) return { ok: false, refusal: decision.refusal, gameOnFile: decision.gameOnFile };

    // Only now, for a board that WILL be extended: the row the extension lives on (idempotent; a no-op when it exists). A board with
    // no row had nothing for the read above to LOCK, and `ensureBridgeRow` runs on its own connection, so a create can mint the row
    // and claim it in that gap (it needs no lock this transaction holds). The row is therefore read again - locked now, on THIS
    // connection - and the rule asked of it again: a claim or a marker that landed in the gap is a game on file, and the press is
    // refused like any other on a board with one. (A refusal here leaves the row the create's own mint made; nothing is extended.)
    if (!row) {
      await ensureBridgeRow(a.f);
      row = await readRow();
      decision = await decide(row);
      if (decision.refusal !== null) return { ok: false, refusal: decision.refusal, gameOnFile: decision.gameOnFile };
    }
    const [moved] = await tx<{ extraMs: number; extensions: number }[]>`
      update fixture_external_play
         set checkin_extra_ms = checkin_extra_ms + ${CHECKIN_EXTEND_STEP_MS},
             checkin_extensions = checkin_extensions + 1,
             updated_at = now()
       where fixture_id = ${fixtureId}
       returning checkin_extra_ms as "extraMs", checkin_extensions as extensions`;
    // A board re-paired between the read and the make (ensureBridgeRow writes only while the fixture still seats the entrants `a.f`
    // was read with) has no row to move: the same "changed underneath" refusal, written as one and tested.
    if (!moved) throw new HttpError(409, "the board changed while its check-in was being extended - try again", "ROUND_CHANGED");
    // The deadline the board is on NOW, from window.ts's own function with the extension just written.
    const deadline = windowFor(boardAnchor(open.roundOpenedAt, open.rank, open.staggered, moved.extraMs)).deadline;
    await tx`
      insert into online_chess_audit (org_id, fixture_id, kind, actor_user_id, note)
      values (${orgId}, ${fixtureId}, 'checkin_extend', ${a.actorUserId},
              ${JSON.stringify({ scope: a.scope, extensions: moved.extensions, addedMs: CHECKIN_EXTEND_STEP_MS, deadlineAt: deadline.toISOString() })})`;
    // The invites that may still be re-rendered are, in this same transaction (header: THE INVITES) - BEFORE the expiry move, so the read
    // of their rows (which takes their lock) is the first thing to touch them: a row a send claims while this transaction waits for
    // its lock is then seen `sending` and left alone, instead of retired mid-flight. A SAVEPOINT holds the work: the arbiter's +5 must
    // not fail because a mail could not be built (a render fault, a missing key, a token that could not be minted). If it throws, its
    // rows go back with it, the failure is logged by fixture and error name, and the extension goes on to the expiry move alone - the
    // pre-Task-8 behaviour: the invites keep the deadline they were written with and the room shows the live one. `SeatsNeeded` is not
    // a failure but the first pass asking for the seats (nothing written, rolled back as a whole).
    let requeued: { fresh: string[]; left: string[] } = { fresh: [], left: [] };
    try {
      requeued = await tx.savepoint((sp) =>
        requeueUnsentInvites(sp, {
          fixture: a.f,
          seats,
          roundNo: fx.roundNo,
          roundOpenId: open.id,
          roundOpenedAt: open.roundOpenedAt,
          anchor: boardAnchor(open.roundOpenedAt, open.rank, open.staggered, moved.extraMs),
          now: decision.at,
        }),
      );
    } catch (err) {
      if (err instanceof SeatsNeeded) throw err;
      log.error(
        { fixtureId, ...errFields(err) },
        "check-in extension: re-rendering the waiting invites failed; the extension goes through and they keep the deadline they were written with",
      );
    }
    // What is left that can still be retried expires at the NEW deadline too. Both seats: the ref names the seat, and a seat can
    // have several recipients, all matched by the ref. Not the rows `left` without a fresh one (a recipient who has left the seat, a
    // stamp that could not be read): their body names the old deadline, so they end unsent at it.
    await extendEmailExpiry(
      tx,
      CHESS_SEAT_REF_TYPE,
      [chessSeatRef(fixtureId, "white"), chessSeatRef(fixtureId, "black")],
      deadline,
      requeued.left,
    );
    return {
      ok: true,
      inviteIds: requeued.fresh,
      board: {
        fixtureId,
        extensions: moved.extensions,
        extensionsLeft: extensionsLeft(moved.extensions),
        addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
        deadlineAt: deadline.toISOString(),
      },
    };
  });
}

/** After the commit: a player with the room open re-reads its snapshot (and so its deadline) at once instead of at the next poll.
 *  Fire-and-forget by the helper's own contract; a broadcast that fails costs a poll's delay, never the extension. */
async function nudge(fixtureIds: readonly string[], deps: ExtendDeps): Promise<void> {
  const publish = deps.publish ?? publishExternalPlayLobby;
  await Promise.all(fixtureIds.map((id) => publish(id).catch(() => undefined)));
}

/** After the commit: the first send of the fresh invites, paced and budgeted as the open's (`dispatchNow`; one call for a whole round, so
 *  its pacing and its budget cover the round). Never throws: the rows are durable and the worker finishes whatever this does not, so
 *  a failure here is logged by error name and costs the extension nothing - it has already committed. */
async function sendFresh(ids: readonly string[], deps: ExtendDeps): Promise<void> {
  if (ids.length === 0) return;
  try {
    await (deps.dispatch ?? dispatchNow)(ids, deps.now ? { now: deps.now() } : {});
  } catch (err) {
    log.error({ ...errFields(err) }, "check-in extension: sending the re-rendered invites failed; the worker will finish them");
  }
}

function refused(refusal: ExtendRefusal): HttpError {
  const text: Record<ExtendRefusal, string> = {
    not_playable: "this board can no longer be played",
    game_started: "a game is already on this board, so its check-in cannot be extended",
    closed: "this board's check-in has closed",
    not_open: "this board's check-in has not opened yet",
    cap_reached: "this board's check-in has already been extended as far as it can be",
  };
  return new HttpError(409, text[refusal], EXTEND_REFUSAL_CODES[refusal]);
}

/** Add CHECKIN_EXTEND_STEP_MS to ONE board's check-in. 403 for a caller who is not a signed-in organiser, or who plays on the
 *  board; 404 for a board that is not this club's online board; 409 ROUND_NOT_OPEN, then one code per refusal
 *  (`EXTEND_REFUSAL_CODES`), and ROUND_CHANGED when the board changed under the call. */
export async function extendCheckin(auth: AuthCtx, fixtureId: string, deps: ExtendDeps = {}): Promise<CheckinExtendBoardResult> {
  const userId = requireWatcher(auth);
  const f = await loadOnlinePlayFixture(fixtureId);
  if (f === null || f.orgId !== auth.orgId) throw new HttpError(404, "fixture not found", "NOT_FOUND");
  // C1 (D7): an organiser who plays on a board does not give it more time.
  if (await isSeatedOn(userId, fixtureId)) {
    throw new HttpError(403, "You play on this board, so another organiser must extend its check-in", "ARBITER_PLAYS_THIS_BOARD");
  }
  if ((await boardOpenFor(sql, fixtureId)) === null) throw new HttpError(409, "this board's round is not open yet", "ROUND_NOT_OPEN");
  const step = await extendOneBoard({ f, actorUserId: userId, scope: "board" }, deps);
  if (!step.ok) throw refused(step.refusal);
  await nudge([fixtureId], deps);
  await sendFresh(step.inviteIds, deps);
  return step.board;
}

/** Add CHECKIN_EXTEND_STEP_MS to EVERY board of an opened round whose check-in is open right now: one action, the same rule as
 *  the single board's, each board its own atomic step (a board that cannot be extended never holds up another). Not-yet-open
 *  batches are untouched (`notOpenYet`); a board the caller plays on is left alone (`ownBoards`, C1). A board of the round that is
 *  not an online board (a bye; an unpaired seat), and a settled board with no game on file (withdrawn, voided), have nothing to
 *  extend and are not counted. */
export async function extendRoundCheckin(
  auth: AuthCtx,
  a: { stageId: string; roundNo: number },
  deps: ExtendDeps = {},
): Promise<CheckinExtendRoundResult> {
  const userId = requireWatcher(auth);
  const [stage] = await sql<{ orgId: string }[]>`select org_id as "orgId" from stages where id = ${a.stageId}`;
  if (!stage || stage.orgId !== auth.orgId) throw new HttpError(404, "stage not found", "NOT_FOUND");
  if (!(await roundOpenAt(sql, a.stageId, a.roundNo))) throw new HttpError(409, "this round is not open yet", "ROUND_NOT_OPEN");

  const fixtures = await sql<{ id: string }[]>`
    select id from fixtures
     where stage_id = ${a.stageId} and round_no = ${a.roundNo}
       and home_entrant_id is not null and away_entrant_id is not null
     order by seq_in_round, id`;

  const result: CheckinExtendRoundResult = {
    extended: 0,
    skipped: { closed: 0, gameStarted: 0, capReached: 0 },
    notOpenYet: 0,
    ownBoards: 0,
    failed: 0,
    addedMinutes: CHECKIN_EXTEND_STEP_MINUTES,
  };
  const moved: string[] = [];
  const fresh: string[] = [];
  for (const { id: fixtureId } of fixtures) {
    try {
      const f = await loadOnlinePlayFixture(fixtureId);
      if (f === null || f.orgId !== auth.orgId) continue; // not an online board of this club (online play switched off after the open)
      if (await isSeatedOn(userId, fixtureId)) {
        result.ownBoards += 1;
        continue;
      }
      const step = await extendOneBoard({ f, actorUserId: userId, scope: "round" }, deps);
      if (step.ok) {
        result.extended += 1;
        moved.push(fixtureId);
        fresh.push(...step.inviteIds);
      } else if (step.refusal === "closed") result.skipped.closed += 1;
      else if (step.refusal === "game_started") result.skipped.gameStarted += 1;
      else if (step.refusal === "cap_reached") result.skipped.capReached += 1;
      else if (step.refusal === "not_open") result.notOpenYet += 1;
      else if (step.gameOnFile) result.skipped.gameStarted += 1; // not_playable: a finished game is a game that started
    } catch (err) {
      // A board whose step threw does not stop the others (each is atomic, so it changed nothing). Counted, and reported.
      result.failed += 1;
      captureError(err, { orgId: auth.orgId, route: "external-play/extend-checkin", extra: { fixtureId } });
    }
  }
  await nudge(moved, deps);
  await sendFresh(fresh, deps);
  return result;
}
