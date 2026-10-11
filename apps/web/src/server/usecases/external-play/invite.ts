import "server-only";
// The invite (D12, T19). An organiser's Open round is what sends it; the
// organiser's Resend on one board re-sends it. Both go through
// `sendFixtureInvite`, so there is one place the mail is built.
//
// The record that an invite went out is the per-SEAT stamp on the bridge row —
// `fixture_external_play.white_emailed_at` / `black_emailed_at` (V405, kept by
// V433). There is no second invite stamp. A stamp may only be set on a row
// that names its round's open (`round_open_id`, CHECK
// fixture_external_play_invite_needs_open_round_check), and the binding
// trigger refuses a `round_open_id` that names another round, stage or org.
//
// `resendExternalPlayNotice` was imported by the resend route and defined
// nowhere since `340dce7ed` deleted `usecases/external-play.ts`; this is its
// home now (T19, addendum 6).
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_GAME_EXISTS_CODE, RESEND_BOARD_HELD_CODE, RESEND_WINDOW_CLOSED_CODE } from "@/lib/open-round";
import { appOrigin, sendExternalPlayInviteEmail } from "@/lib/email";
import { toLocale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { roundOpenAt } from "@/server/external-play/round-open";
import { roomPhase, windowFor } from "@/server/external-play/window";
import {
  loadOnlinePlayFixture,
  loadSides,
  resetStaleBridge,
  whiteSideOf,
  type OnlinePlayFixture,
  type SidePlayer,
} from "./guard";
import { isPlayableFixtureStatus } from "./preflight";

type AnySql = postgres.TransactionSql | postgres.Sql;

export type Colour = "white" | "black";

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

/** The bridge facts that decide whether a board can still be invited into,
 *  as read FRESH from the row (the guard's `BridgeRow` snapshot does not carry
 *  `create_sent_at`). */
export type InviteBridgeFacts = { status: string; challenge_id: string | null; create_sent_at: Date | null };

/** A bridge row that a game exists — or MAY exist — behind is never invited
 *  into and never re-attached: `challenge_id` is a recorded game; a
 *  `create_sent_at` marker is a create whose outcome is unknown (T9 I2); any
 *  status past `pending` is a game or an organiser's hold. No row at all takes
 *  invites. `attachToOpen` and `claimSeat` repeat this predicate in SQL. */
export function bridgeTakesInvites(b: InviteBridgeFacts | null): boolean {
  if (b === null) return true;
  return b.status === "pending" && b.challenge_id === null && b.create_sent_at === null;
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

/**
 * One seat's invite, to every address its entrant carries. `true` iff at least
 * one address was accepted by the provider. A seat with no address at all
 * answers `false` — nothing reached anyone. Never throws: a sender that throws
 * is a send that failed, and the caller un-stamps on `false`.
 */
export async function sendFixtureInvite(a: {
  fixture: OnlinePlayFixture;
  seat: InviteSeat;
  roundNo: number;
  roundOpenedAt: Date;
  origin?: string;
}): Promise<boolean> {
  const { fixture: f, seat } = a;
  const origin = (a.origin ?? appOrigin()).replace(/\/$/, "");
  const fixtureUrl = `${origin}${routes.sharedFixture(f.orgSlug, f.competitionSlug, f.divisionSlug, f.fixtureId)}`;
  const deadline = windowFor(a.roundOpenedAt).deadline;
  let accepted = 0;
  for (const r of seat.player.recipients) {
    const locale = toLocale(r.locale);
    try {
      const ok = await sendExternalPlayInviteEmail(
        r.email,
        {
          orgName: f.orgName,
          opponentName: seat.opponent.displayName,
          roundNo: a.roundNo,
          // No start time ⇒ the game is on from the round's open (D12).
          scheduledLabel: utcLabel(f.scheduledAt ?? a.roundOpenedAt, locale),
          deadlineLabel: utcLabel(deadline, locale),
          fixtureUrl,
        },
        locale,
      );
      if (ok) accepted += 1;
    } catch (err) {
      log.error({ fixtureId: f.fixtureId, colour: seat.colour, err }, "external-play invite: sender threw");
    }
  }
  return accepted > 0;
}

const STAMP_COLUMN = { white: "white_emailed_at", black: "black_emailed_at" } as const;

/** Stamp one seat as invited, only if it is not already, on a row that names
 *  `roundOpenId` and has no game behind it. `true` ⇔ THIS call claimed it. */
export async function claimSeat(
  db: AnySql,
  fixtureId: string,
  colour: Colour,
  roundOpenId: string,
  at: Date,
): Promise<boolean> {
  const col = db(STAMP_COLUMN[colour]);
  const rows = await db<{ fixture_id: string }[]>`
    update fixture_external_play
       set ${col} = ${at}, updated_at = now()
     where fixture_id = ${fixtureId} and ${col} is null
       and round_open_id = ${roundOpenId}
       and status = 'pending' and challenge_id is null and create_sent_at is null
     returning fixture_id`;
  return rows.length === 1;
}

/** Undo THIS call's claim after its send failed, so the next open retries.
 *  Conditional on the exact stamp this call wrote — never clears another's.
 *  A row whose OTHER seat holds no stamp either was reached by nobody, so it
 *  is unbound from the open too: the binding is the round's record that
 *  someone was invited (openRound's "anyone invited?"), and a send that
 *  reached nobody is not that. */
export async function releaseSeat(db: AnySql, fixtureId: string, colour: Colour, at: Date): Promise<void> {
  const col = db(STAMP_COLUMN[colour]);
  const other = db(STAMP_COLUMN[colour === "white" ? "black" : "white"]);
  await db`
    update fixture_external_play
       set ${col} = null,
           round_open_id = case when ${other} is null then null else round_open_id end,
           updated_at = now()
     where fixture_id = ${fixtureId} and ${col} = ${at}`;
}

/**
 * POST /fixtures/{id}/external-play/resend — the organiser re-sends one
 * board's invite to both players. An explicit organiser act, so it sends
 * whether or not a seat was invited before; it does not create a game.
 *
 * It holds openRound's rules (review M6, fix round 1):
 *   - the WINDOW: after the round's T+20 nobody is invited, ⇒ 409
 *     WINDOW_CLOSED (an organiser who wants a fresh window opens the round);
 *   - the GAME rule: no invite into a board a game stands — or may stand —
 *     behind (409 ONLINE_GAME_EXISTS), nor one held for the organiser (409
 *     BOARD_HELD);
 *   - the per-seat LOCK: under the division lock every pairing write and
 *     openRound take, the board is re-read and each un-invited seat is
 *     CLAIMED before anything is sent, so a concurrent open cannot mail that
 *     seat again; a claimed seat whose send fails is un-stamped, so the
 *     round's next open retries it. A seat invited before is re-mailed and
 *     keeps its stamp.
 */
export async function resendExternalPlayNotice(
  auth: AuthCtx,
  fixtureId: string,
  origin: string,
  deps: { now?: Date } = {},
): Promise<{ emailed: number }> {
  const now = deps.now ?? new Date();
  const f = await loadOnlinePlayFixture(fixtureId);
  // Not an online board, or not this org's: the same 404, so a probe cannot
  // tell which.
  if (!f || f.orgId !== auth.orgId) throw new HttpError(404, "No online-play fixture here");
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
    const open = (await roundOpenAt(tx, pos.stageId, pos.roundNo))!;
    if (roomPhase(now, open.roundOpenedAt) === "closed") {
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
    return { open, claimed };
  });

  let emailed = 0;
  for (const seat of seats) {
    let ok = false;
    try {
      ok = await sendFixtureInvite({
        fixture: f,
        seat,
        roundNo: pos.roundNo,
        roundOpenedAt: decision.open.roundOpenedAt,
        origin,
      });
    } catch (err) {
      log.error({ fixtureId, colour: seat.colour, err }, "external-play resend: send threw");
    }
    if (ok) {
      emailed += 1;
      continue;
    }
    if (!decision.claimed.has(seat.colour)) continue; // invited before: that stamp stands
    try {
      await releaseSeat(sql, fixtureId, seat.colour, now);
    } catch (err) {
      log.error({ fixtureId, colour: seat.colour, err }, "external-play resend: un-stamp after a failed send threw");
    }
  }
  return { emailed };
}
