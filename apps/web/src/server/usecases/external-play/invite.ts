import "server-only";
// The invite (D12, T19). An organiser's Open round is what sends it; the
// organiser's Resend on one board re-sends it. Both go through
// `queueFixtureInvite`, so there is one place the mail is built - and, since the email
// outbox, one place it is QUEUED: a row per recipient, written in the caller's own
// transaction beside the seat stamp, sent after commit (`dispatchAndClassify`), retried
// by the worker and followed by the provider's verdict. The seat stays stamped while any
// row for its stamp can still deliver and is released by the outbox's chess hook
// (invite-outbox-hook.ts) once every one has ended badly.
//
// The record that an invite went out is the per-SEAT stamp on the bridge row —
// `fixture_external_play.white_emailed_at` / `black_emailed_at` (V405, kept by
// V451). There is no second invite stamp. A stamp may only be set on a row
// that names its round's open (`round_open_id`, CHECK
// fixture_external_play_invite_needs_open_round_check), and the binding
// trigger refuses a `round_open_id` that names another round, stage or org.
//
// `resendExternalPlayNotice` was imported by the resend route and defined
// nowhere since `340dce7ed` deleted `usecases/external-play.ts`; this is its
// home now (T19, addendum 6).
import type postgres from "postgres";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_GAME_EXISTS_CODE, RESEND_BOARD_HELD_CODE, RESEND_WINDOW_CLOSED_CODE } from "@/lib/open-round";
import { appOrigin, externalPlayInviteEmail } from "@/lib/email";
import { toLocale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import { LIVE_STATUSES, RETRYABLE_STATUSES, dispatchNow, enqueueEmail, latestStatusesOfRows, type OutboxStatus } from "@/server/email-outbox";
import { errFields } from "@/server/email-outbox/err-fields";
import { mintMatchRoomToken } from "@/server/usecases/match-room-token";
import type { AuthCtx } from "@/server/api-v1/auth";
import { boardOpenFor, roundOpenAt } from "@/server/external-play/round-open";
import { roomPhase, windowFor, type BoardAnchor } from "@/server/external-play/window";
import {
  loadOnlinePlayFixture,
  loadSides,
  resetStaleBridge,
  whiteSideOf,
  type OnlinePlayFixture,
  type SidePlayer,
} from "./guard";
import { assertOnlineChessOffered } from "./online-chess-flag";
import { isPlayableFixtureStatus } from "./preflight";
import { CHESS_SEAT_REF_TYPE, chessSeatRef, claimSeat, releaseSeat, type Colour } from "./seat-stamp";

// The stamp helpers live in the leaf seat-stamp.ts (ruling R1: the outbox hook shares them without importing this file); they are
// re-exported so every existing import from "./invite" is unchanged.
export { CHESS_SEAT_REF_TYPE, STAMP_COLUMN, bridgeTakesInvites, chessSeatRef, claimSeat, releaseSeat } from "./seat-stamp";
export type { Colour, InviteBridgeFacts } from "./seat-stamp";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type InviteSeat = { colour: Colour; player: SidePlayer; opponent: SidePlayer };

/** Both seats of a board, keyed by colour. Colour is READ from the pairing
 *  (`whiteSideOf`), never assigned — the stamps are per colour. */
export async function boardSeats(f: OnlinePlayFixture): Promise<[InviteSeat, InviteSeat]> {
  const [{ home, away }, whiteSide] = await Promise.all([loadSides(f), whiteSideOf(f)]);
  const white = whiteSide === "home" ? home : away;
  const black = whiteSide === "home" ? away : home;
  return [
    { colour: "white", player: white, opponent: black },
    { colour: "black", player: black, opponent: white },
  ];
}

/**
 * Make sure the board's bridge row exists and names THIS round's open, so a
 * seat stamp can be written on it. An existing row names either no open
 * (written by another entry point, e.g. T9's ensureBridgeRow — and then it
 * carries no stamp, by CHECK) or this one: there is one open row per
 * (stage, round), it is never deleted (FK RESTRICT), and no product path moves
 * a fixture between rounds (openRound refuses a row that names another open,
 * loudly). A row with a game behind it is left exactly as it is.
 */
export async function attachToOpen(
  db: AnySql,
  f: OnlinePlayFixture,
  open: { id: string; roundOpenedAt: Date },
): Promise<void> {
  // A board with no start time is minted on the round's open (ruling
  // 2026-10-10) — the basis the guard's stale check then never moves — and a
  // row minted for it before the open (the D11 override's provisional basis,
  // review M3) is rebased onto the open here. A timed board's basis is left
  // to the stale check (resetStaleBridge), never moved by an attach.
  await db`
    insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, round_open_id)
    values (${f.fixtureId}, ${f.orgId}, ${f.scheduledAt ?? open.roundOpenedAt}, ${open.id})
    on conflict (fixture_id) do update
       set round_open_id = excluded.round_open_id,
           scheduled_at_basis = case when ${f.scheduledAt === null}::boolean
                                     then excluded.scheduled_at_basis
                                     else fixture_external_play.scheduled_at_basis end,
           updated_at = now()
     where fixture_external_play.status = 'pending'
       and fixture_external_play.challenge_id is null
       and fixture_external_play.create_sent_at is null`;
}

/** The opening time the mail PROMISES: the instant rounded UP to the next whole minute (one already on a minute is not moved), so the
 *  mail never names a minute before the door opens. The batch-wait card applies the same rule (`formatPromisedTime`). The DEADLINE's
 *  label is not rounded: truncating names a time a few seconds earlier than the real cut-off, which is the safe direction there. */
function ceilToMinute(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
}

function utcLabel(at: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

/** What one seat's invite is, as the response words it: `invited` (the provider took it, or it arrived), `retrying` (not sent
 *  yet, or sent late: the worker is still on it) or `failed` (nothing can reach the player; the seat is released). */
export type SeatOutcome = "invited" | "retrying" | "failed";

/**
 * One seat's invite, QUEUED for every address its entrant carries: one outbox row per distinct mailbox, written on `tx` - the
 * caller's own transaction, the one that stamps the seat - so the stamp and its rows are committed together or not at all. Nothing
 * is sent here; the caller runs `dispatchAndClassify` after it commits. Returns the rows' ids (none for a seat with no address).
 *
 * Throws (and writes nothing the caller keeps, when it runs inside a savepoint) if the personal link cannot be minted, the
 * invite cannot be rendered, or the outbox refuses a row (no key to seal the body with, an expiry past its bound).
 *
 * Rows: `chess_invite`, ref `fixture_seat` / `<fixtureId>:<colour>`, expiring at the BOARD's own check-in deadline (after which
 * the invite is worthless), `meta` = the board, the colour and `stampedAt` - the stamp this row is the invite for, which is how
 * the hook finds every row of a stamp. Two members whose addresses are the same mailbox (differing in case, say) get one row: the
 * outbox replaces a row by recipient case-insensitively, so a second one would only supersede the first.
 */
export async function queueFixtureInvite(
  tx: Tx,
  a: {
    fixture: OnlinePlayFixture;
    seat: InviteSeat;
    roundNo: number;
    /** The round's open (`stage_round_opens`): the personal link is bound to
     *  it (T14, T19 review M4), and its window is the deadline the mail names. */
    roundOpenId: string;
    roundOpenedAt: Date;
    /** The BOARD's anchor (spec §3.2.1): the deadline the mail names is this board's own, and a board whose batch opens
     *  later is told when. */
    anchor: BoardAnchor;
    origin?: string;
    /** The instant the mail is sent at (the caller's clock). A later batch is "not open yet" only if this is before its opening:
     *  a resend after the batch has opened must not tell the player it "opens at" a time already past (final review M-5). */
    now?: Date;
    /** The stamp these rows are the invite for: this call's own when it claimed the seat, the one already on the seat when a
     *  resend re-mails an invited one. */
    stampedAt: Date;
  },
): Promise<string[]> {
  const { fixture: f, seat } = a;
  const origin = (a.origin ?? appOrigin()).replace(/\/$/, "");
  // T14: the player's own match room, with a personal link that identifies
  // them without a session. A seat with no single person (an empty side)
  // gets the room without a link — they sign in.
  const token =
    seat.player.personId === null
      ? undefined
      : await mintMatchRoomToken({
          fixtureId: f.fixtureId,
          personId: seat.player.personId,
          roundOpenId: a.roundOpenId,
          roundOpenedAt: a.roundOpenedAt.toISOString(),
        });
  const fixtureUrl = `${origin}${routes.sharedFixturePlay(f.orgSlug, f.competitionSlug, f.divisionSlug, f.fixtureId, token)}`;
  const w = windowFor(a.anchor);
  const deadline = w.deadline;
  // A later batch's check-in that has not opened YET when this is sent: the mail says when (externalPlayInvite.bodyLater). Batch 0
  // opens at the Open press, so it reads as it always did - and so does a later batch the mail reaches after its opening.
  const laterBatch = a.anchor.batch > 0 && (a.now ?? new Date()).getTime() < w.opensAt.getTime();
  const ids: string[] = [];
  const mailboxes = new Set<string>();
  for (const r of seat.player.recipients) {
    const mailbox = r.email.trim().toLowerCase();
    if (mailboxes.has(mailbox)) continue;
    mailboxes.add(mailbox);
    const locale = toLocale(r.locale);
    const content = await externalPlayInviteEmail(
      r.email,
      {
        orgName: f.orgName,
        opponentName: seat.opponent.displayName,
        roundNo: a.roundNo,
        deadlineLabel: utcLabel(deadline, locale),
        ...(laterBatch ? { opensLabel: utcLabel(ceilToMinute(w.opensAt), locale) } : {}),
        fixtureUrl,
      },
      locale,
    );
    ids.push(
      await enqueueEmail(tx, {
        kind: "chess_invite",
        refType: CHESS_SEAT_REF_TYPE,
        refId: chessSeatRef(f.fixtureId, seat.colour),
        orgId: f.orgId,
        to: r.email,
        ...content,
        // An invite starts a clock against the player: the marketing suppression list must not swallow it.
        transactional: true,
        expiresAt: deadline,
        meta: { fixtureId: f.fixtureId, colour: seat.colour, stampedAt: a.stampedAt.toISOString() },
      }),
    );
  }
  return ids;
}

/**
 * What a seat's invite is NOW, from the status of its rows (R6, R11) - never from what the dispatch returned, which can lag
 * the row: a webhook can mark a row `delivered` before the request that sent it has its answer, and the dispatch then reports
 * `deferred` for a mail that has arrived. `statuses` is the status of the newest non-replaced row of each recipient (see
 * `latestStatuses`); a `replaced` entry is ignored here as well, so a superseded twin can never read as "retrying".
 *
 * Any row the provider took (`sent`, `delayed`, `delivered`) or that arrived and was complained about is `invited`; otherwise any
 * row still being tried (`queued`, `sending`) is `retrying`; otherwise - every row ended badly, or there is none (a seat with no
 * address) - `failed`, which the response reports as `send_failed` and the hook has released.
 */
export function seatOutcome(statuses: readonly OutboxStatus[]): SeatOutcome {
  let retrying = false;
  for (const s of statuses) {
    if (s === "replaced") continue;
    if (RETRYABLE_STATUSES.includes(s)) retrying = true;
    else if (LIVE_STATUSES.includes(s) || s === "complained") return "invited";
  }
  return retrying ? "retrying" : "failed";
}

/** The status NOW of the newest non-replaced row for each of these rows' kind, ref and recipient (the recipient compared as the
 *  replace rule compares it, case-insensitively). A row the caller wrote and a newer one another request wrote for the same
 *  recipient answer alike: the newer row is what the recipient's mail is.
 *
 *  The rule lives in ONE place, the outbox's status module (`latestStatusesOfRows`, which shares its "not replaced" and "newest
 *  first" fragments with `latestEmailStatus`, the arbiter's read): a second copy of it here would be a second authority for what
 *  "the latest email" means. Kept as this name and signature for the invite's callers. */
export const latestStatuses = (ids: readonly string[]): Promise<Map<string, OutboxStatus>> => latestStatusesOfRows(ids);

/**
 * After the caller's transaction has committed: send each queued row once, in the request (`dispatchNow`, the open's own clock
 * so a test that opens on a past clock judges expiry on it), and say how each seat stands. One entry per seat, in order, from
 * the rows' STATUS (`seatOutcome`). Never throws: the rows are durable, so if the dispatch or the status read fails the worker
 * finishes the job, and the seats are reported `retrying` - which they are.
 */
export async function dispatchAndClassify(seatRowIds: readonly (readonly string[])[], now: Date): Promise<SeatOutcome[]> {
  const all = seatRowIds.flat();
  try {
    await dispatchNow(all, { now });
    const statuses = await latestStatuses(all);
    return seatRowIds.map((ids) =>
      seatOutcome(ids.flatMap((id) => { const s = statuses.get(id); return s === undefined ? [] : [s]; })),
    );
  } catch (err) {
    log.error({ ...errFields(err) }, "external-play invite: sending the queued invites failed; the worker will finish them");
    return seatRowIds.map((ids) => (ids.length === 0 ? "failed" : "retrying"));
  }
}

/**
 * POST /fixtures/{id}/external-play/resend — the organiser re-sends one
 * board's invite to both players. An explicit organiser act, so it sends
 * whether or not a seat was invited before; it does not create a game.
 *
 * It holds openRound's rules (review M6, fix round 1):
 *   - the WINDOW: after the round's deadline (DEADLINE_AFTER_MS) nobody is invited, ⇒ 409
 *     WINDOW_CLOSED (an organiser who wants a fresh window opens the round);
 *   - the GAME rule: no invite into a board a game stands — or may stand —
 *     behind (409 ONLINE_GAME_EXISTS), nor one held for the organiser (409
 *     BOARD_HELD);
 *   - the per-seat LOCK: under the division lock every pairing write and
 *     openRound take, the board is re-read and each un-invited seat is
 *     CLAIMED, and every seat's mail is QUEUED, in that one transaction - so a
 *     concurrent open cannot mail that seat again, and a seat is never stamped
 *     without its rows. A seat invited before is re-mailed and keeps its stamp;
 *     the outbox's replace rule supersedes its older unfinished row for the
 *     same address, while a DELIVERED older row stays and keeps the seat
 *     stamped. A claimed seat whose rows all end badly is released by the
 *     outbox's chess hook, so the round's next open retries it.
 *
 * Returns the seats the provider took (`emailed`) and the seats still being tried (`retrying`, queued behind a retry or a rate
 * limit); a seat that could not be queued, or whose every email ended badly, is in neither.
 */
export async function resendExternalPlayNotice(
  auth: AuthCtx,
  fixtureId: string,
  origin: string,
  deps: { now?: Date } = {},
): Promise<{ emailed: number; retrying: number }> {
  const now = deps.now ?? new Date();
  const f = await loadOnlinePlayFixture(fixtureId);
  // Not an online board, or not this org's: the same 404, so a probe cannot
  // tell which.
  if (!f || f.orgId !== auth.orgId) throw new HttpError(404, "No online-play fixture here");
  // T20: an invite STARTS play for the people it reaches, so the club must be offered online chess (403
  // ONLINE_CHESS_DISABLED). After the 404, so a probe still cannot tell a foreign board from a missing one.
  await assertOnlineChessOffered(auth);
  if (f.bridge?.status === "finished") {
    throw new HttpError(409, "Fixture already finished", "ALREADY_RESOLVED");
  }
  if (!isPlayableFixtureStatus(f.fixtureStatus)) {
    throw new HttpError(409, "This board can no longer be played", "FIXTURE_NOT_PLAYABLE");
  }
  const [pos] = await sql<{ stageId: string; roundNo: number; divisionId: string }[]>`
    select stage_id as "stageId", round_no as "roundNo", division_id as "divisionId"
      from fixtures where id = ${fixtureId}`;
  const opened = pos ? await roundOpenAt(sql, pos.stageId, pos.roundNo) : null;
  // D12: nobody is invited to a round the organiser has not opened.
  if (!pos || !opened) throw new HttpError(409, "Open the round before inviting its players", "ROUND_NOT_OPEN");
  await resetStaleBridge(f); // a rescheduled, game-less row starts over (T7), as in openRound
  const seats = await boardSeats(f);

  const decision = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + pos.divisionId}))`;
    const [fx] = await tx<{ home: string | null; away: string | null; status: string; roundNo: number }[]>`
      select home_entrant_id as home, away_entrant_id as away, status, round_no as "roundNo"
        from fixtures where id = ${fixtureId}`;
    if (
      !fx ||
      fx.home !== f.homeEntrantId ||
      fx.away !== f.awayEntrantId ||
      fx.roundNo !== pos.roundNo ||
      !isPlayableFixtureStatus(fx.status)
    ) {
      throw new HttpError(409, "This board changed while the invite was being sent. Try again.", "ROUND_CHANGED");
    }
    // The open row is never deleted (FK RESTRICT); re-read under the lock for
    // the window it carries now (a re-stamp may have moved it).
    const open = (await boardOpenFor(tx, fixtureId))!;
    if (roomPhase(now, open.anchor) === "closed") {
      throw new HttpError(409, "This round's window has closed. Open the round again to invite its players.", RESEND_WINDOW_CLOSED_CODE);
    }
    const [b] = await tx<{ status: string; challenge_id: string | null; create_sent_at: Date | null }[]>`
      select status, challenge_id, create_sent_at from fixture_external_play
       where fixture_id = ${fixtureId} for update`;
    if (b && (b.challenge_id !== null || b.create_sent_at !== null)) {
      throw new HttpError(409, "An online game exists on this board, so it takes no invite.", ONLINE_GAME_EXISTS_CODE);
    }
    if (b && b.status !== "pending") {
      throw new HttpError(409, "This board is waiting for an organiser's decision, so it takes no invite.", RESEND_BOARD_HELD_CODE);
    }
    await attachToOpen(tx, f, open);
    const claimed = new Set<Colour>();
    for (const seat of seats) {
      if (await claimSeat(tx, fixtureId, seat.colour, open.id, now)) claimed.add(seat.colour);
    }
    // The stamp each seat's rows ride on: this call's own for a seat it claimed, the seat's existing one otherwise. Read back
    // under the lock, and checked: a seat that neither claimed nor holds a stamp has no stamp for its rows to be about, and a
    // row written for no stamp is a row the hook could never release. Cannot happen in a locked transaction - which is why it
    // is a refusal and not an assumption (the throw rolls the claims back with everything else).
    const [stamped] = await tx<{ white: Date | null; black: Date | null }[]>`
      select white_emailed_at as white, black_emailed_at as black from fixture_external_play where fixture_id = ${fixtureId}`;
    const stampOf = new Map<Colour, Date>();
    for (const seat of seats) {
      const stamp = claimed.has(seat.colour) ? now : (stamped?.[seat.colour] ?? null);
      if (stamp === null) {
        throw new Error(`resend: the ${seat.colour} seat of fixture ${fixtureId} neither claimed nor holds an invite stamp`);
      }
      stampOf.set(seat.colour, stamp);
    }
    const rowIds = new Map<Colour, string[]>();
    const unqueued = new Set<Colour>();
    for (const seat of seats) {
      try {
        rowIds.set(
          seat.colour,
          await tx.savepoint((sp) =>
            queueFixtureInvite(sp, {
              fixture: f,
              seat,
              roundNo: pos.roundNo,
              roundOpenId: open.id,
              roundOpenedAt: open.roundOpenedAt,
              anchor: open.anchor,
              origin,
              now,
              stampedAt: stampOf.get(seat.colour)!,
            }),
          ),
        );
      } catch (err) {
        // The savepoint took this seat's rows back with it. A seat this call claimed is un-stamped in the same transaction (its
        // next open retries it); one invited before keeps the stamp it had.
        log.error({ fixtureId, colour: seat.colour, ...errFields(err) }, "external-play resend: queueing the invite failed");
        unqueued.add(seat.colour);
        if (claimed.has(seat.colour)) await releaseSeat(tx, fixtureId, seat.colour, now);
      }
    }
    return { open, claimed, rowIds, unqueued };
  });

  // After the commit: a claimed seat that has no address at all reached nobody, so its stamp goes (as a seat none of whose rows
  // could be sent always did). Then one dispatch for every row written, and the seats are counted from the rows' status.
  const queued: { colour: Colour; ids: string[] }[] = [];
  for (const seat of seats) {
    const ids = decision.rowIds.get(seat.colour);
    if (ids === undefined) continue; // not queued: reported as neither emailed nor retrying
    if (ids.length === 0) {
      if (decision.claimed.has(seat.colour)) {
        try {
          await releaseSeat(sql, fixtureId, seat.colour, now);
        } catch (err) {
          log.error({ fixtureId, colour: seat.colour, ...errFields(err) }, "external-play resend: un-stamp of a seat with no address threw");
        }
      }
      continue;
    }
    queued.push({ colour: seat.colour, ids });
  }
  const outcomes = await dispatchAndClassify(queued.map((q) => q.ids), now);
  return {
    emailed: outcomes.filter((o) => o === "invited").length,
    retrying: outcomes.filter((o) => o === "retrying").length,
  };
}
