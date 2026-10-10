import "server-only";
// The invite (D12, T19). An organiser's Open round is what sends it; the
// organiser's Resend on one board re-sends it. Both go through
// `sendFixtureInvite`, so there is one place the mail is built.
//
// The record that an invite went out is the per-SEAT stamp on the bridge row —
// `fixture_external_play.white_emailed_at` / `black_emailed_at` (V405, kept by
// V432). There is no second invite stamp. A stamp may only be set on a row
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
import { appOrigin, sendExternalPlayInviteEmail } from "@/lib/email";
import { toLocale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { roundOpenAt } from "@/server/external-play/round-open";
import { windowFor } from "@/server/external-play/window";
import {
  loadOnlinePlayFixture,
  loadSides,
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
export async function attachToOpen(db: AnySql, f: OnlinePlayFixture, roundOpenId: string): Promise<void> {
  await db`
    insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, round_open_id)
    values (${f.fixtureId}, ${f.orgId}, ${f.scheduledAt}, ${roundOpenId})
    on conflict (fixture_id) do update
       set round_open_id = excluded.round_open_id, updated_at = now()
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
          scheduledLabel: utcLabel(f.scheduledAt, locale),
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
 *  Conditional on the exact stamp this call wrote — never clears another's. */
export async function releaseSeat(db: AnySql, fixtureId: string, colour: Colour, at: Date): Promise<void> {
  const col = db(STAMP_COLUMN[colour]);
  await db`
    update fixture_external_play set ${col} = null, updated_at = now()
     where fixture_id = ${fixtureId} and ${col} = ${at}`;
}

/**
 * POST /fixtures/{id}/external-play/resend — the organiser re-sends one
 * board's invite to both players. An explicit organiser act, so it sends
 * whether or not a seat was invited before; it does not create a game. A seat
 * whose stamp is still empty (its open-round send failed) is stamped when this
 * send gets through, so the round's next open does not mail it a second time.
 */
export async function resendExternalPlayNotice(
  auth: AuthCtx,
  fixtureId: string,
  origin: string,
): Promise<{ emailed: number }> {
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
  const [pos] = await sql<{ stageId: string; roundNo: number }[]>`
    select stage_id as "stageId", round_no as "roundNo" from fixtures where id = ${fixtureId}`;
  const open = pos ? await roundOpenAt(sql, pos.stageId, pos.roundNo) : null;
  // D12: nobody is invited to a round the organiser has not opened.
  if (!pos || !open) throw new HttpError(409, "Open the round before inviting its players", "ROUND_NOT_OPEN");

  // A no-op on a row a game stands behind (attachToOpen's own predicate).
  await attachToOpen(sql, f, open.id);
  const seats = await boardSeats(f);
  let emailed = 0;
  for (const seat of seats) {
    const ok = await sendFixtureInvite({
      fixture: f,
      seat,
      roundNo: pos.roundNo,
      roundOpenedAt: open.roundOpenedAt,
      origin,
    });
    if (!ok) continue;
    emailed += 1;
    const col = sql(STAMP_COLUMN[seat.colour]);
    await sql`
      update fixture_external_play set ${col} = now(), updated_at = now()
       where fixture_id = ${fixtureId} and ${col} is null and round_open_id = ${open.id}`;
  }
  return { emailed };
}
