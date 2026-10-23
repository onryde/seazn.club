import "server-only";
// The chess invite's reaction to an email that ended badly (spec "The two kinds"): a seat stays stamped while any email for its
// stamp can still deliver, and is released (so the board reads "still to invite" and Resend / Reinvite work) once EVERY email for
// that stamp has ended badly. Registered in KIND_HOOKS.chess_invite (email-outbox/hooks.ts).
//
// A LEAF module (ruling R1): it imports the outbox's pure vocabularies (constants.ts), the db client, the logger and seat-stamp.ts,
// and nothing that imports the outbox back, so `hooks.ts -> here` closes no loop. invite.ts is NOT imported: the predicate and the
// release it shares with this file live in seat-stamp.ts. no-import-cycle.test.ts walks the real graph and fails if that changes.
//
// What counts as "a row for the stamp": the outbox rows of this seat (ref `fixture_seat` / `<fixtureId>:<colour>`) whose
// `meta.stampedAt` is the stamp being released. The stamp is part of the key on purpose: a seat released and invited again carries
// a NEWER stamp, and the old stamp's rows (a delivered one, a late death) say nothing about it.
//
// Statuses (ruling R12), from the row's state and never from the row the hook was handed:
//   - queued, sending, sent, delayed, delivered   the mail can still arrive, or did: the seat stays stamped;
//   - complained                                  the mail ARRIVED and the player marked it spam: NEVER releases the seat;
//   - bounced                                     releases, even after `delivered` (a late bounce: the inbox refused the mail);
//   - failed, suppressed, dead, expired           release;
//   - replaced                                    ignored: a newer row for the same recipient carries the outcome.
//
// A seat is left alone when a game exists, or may exist, behind its board (`bridgeTakesInvites`, Review Focus 3): a stamp there is
// no longer an invite's record, and releasing it would unbind a row a game stands behind.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { ENDED_BADLY_STATUSES, LIVE_STATUSES, type OutboxStatus } from "@/server/email-outbox/constants";
import type { EndedRow } from "@/server/email-outbox/hooks";
import {
  CHESS_SEAT_REF_TYPE,
  bridgeTakesInvites,
  chessSeatRef,
  releaseSeat,
  type Colour,
  type InviteBridgeFacts,
} from "./seat-stamp";

/** The statuses of a row that keep its seat stamped: every live one, and a complaint (it arrived; see the header). */
export const SEAT_HOLDING_STATUSES: readonly OutboxStatus[] = [...LIVE_STATUSES, "complained"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `Date.prototype.toISOString()`'s shape, the only one `queueFixtureInvite` writes; checked in SQL too (see the finder). */
const ISO_INSTANT = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

type SeatStamp = { fixtureId: string; colour: Colour; stampedAt: Date };

/** The seat and stamp a chess-invite row is about, from its `meta` (checked against its ref), or null when it is not well formed. */
function seatOf(row: EndedRow): SeatStamp | null {
  const { fixtureId, colour, stampedAt } = row.meta;
  const stamp = typeof stampedAt === "string" ? new Date(stampedAt) : null;
  if (
    row.refType !== CHESS_SEAT_REF_TYPE ||
    typeof fixtureId !== "string" ||
    !UUID.test(fixtureId) ||
    (colour !== "white" && colour !== "black") ||
    row.refId !== chessSeatRef(fixtureId, colour) ||
    stamp === null ||
    Number.isNaN(stamp.getTime()) ||
    stamp.toISOString() !== stampedAt
  ) {
    // Ids only: the meta is non-secret, but a hook's refusal needs to name the row, not echo what it was given.
    log.error({ outboxId: row.id, refType: row.refType }, "chess invite hook: the row's ref or meta is not a seat stamp; nothing was released");
    return null;
  }
  return { fixtureId, colour, stampedAt: stamp };
}

/**
 * Release the seat if (and only if) every email for its stamp has ended badly. Idempotent, recomputed from the database: it may
 * run twice for one row (the request that ended it and the worker's re-drive).
 *
 * One transaction: the bridge row is locked `for update` first, so the sibling check and the release see the same board (a
 * resend or an open that claims or re-stamps a seat waits for it, or it for them).
 */
export async function chessInviteEndedBadly(row: EndedRow): Promise<void> {
  const seat = seatOf(row);
  if (!seat) return;
  const ref = chessSeatRef(seat.fixtureId, seat.colour);
  await sql.begin(async (tx) => {
    const [bridge] = await tx<InviteBridgeFacts[]>`
      select status, challenge_id, create_sent_at from fixture_external_play
       where fixture_id = ${seat.fixtureId} for update`;
    // No row: no stamp to release. A game on file or a hold: leave the board alone (a stamp there is not an invite's record).
    if (!bridge || !bridgeTakesInvites(bridge)) return;
    const [held] = await tx<{ id: string }[]>`
      select id from email_outbox
       where kind = 'chess_invite' and ref_type = ${CHESS_SEAT_REF_TYPE} and ref_id = ${ref}
         and meta->>'stampedAt' = ${seat.stampedAt.toISOString()}
         and status = any(${SEAT_HOLDING_STATUSES as OutboxStatus[]}::text[])
       limit 1`;
    if (held) return; // an email for this stamp can still arrive, or did
    await releaseSeat(tx, seat.fixtureId, seat.colour, seat.stampedAt);
  });
}

type UnappliedRecord = { id: string; ref_type: string; ref_id: string; status: OutboxStatus; meta: Record<string, string> };

/**
 * R9 (M2): the badly-ended chess invites whose release was never applied - a seat still stamped, with this row's stamp, whose
 * emails have ALL ended badly - at most `limit`, oldest first, one per seat and stamp. A process that dies between the terminal
 * write and the hook leaves exactly such a row; the worker asks on every tick and re-drives `chessInviteEndedBadly`.
 *
 * Applied endings are excluded IN the query, before the limit: an ending whose seat is released (or whose board holds a game, or
 * whose stamp moved on, or that a complaint or a live row holds) is not unapplied, and must not fill the limit and starve one that is.
 * The finder and the hook decide on the same facts, so a row it reports is one the hook will release (no row is reported for ever).
 *
 * `meta` is read defensively: a value that is not an instant or a uuid compares as no match instead of failing the whole query,
 * so one malformed row cannot hide every other.
 */
export async function findUnappliedChessEndings(limit: number): Promise<EndedRow[]> {
  if (!(limit >= 1)) return [];
  const rows = await sql<UnappliedRecord[]>`
    select d.id, d.ref_type, d.ref_id, d.status, d.meta
      from (
        select distinct on (o.ref_id, o.meta->>'stampedAt')
               o.id, o.ref_type, o.ref_id, o.status, o.meta, o.status_at
          from email_outbox o
          join fixture_external_play ep
            on ep.fixture_id = case when o.meta->>'fixtureId' ~* ${UUID.source} then (o.meta->>'fixtureId')::uuid end
         where o.kind = 'chess_invite' and o.ref_type = ${CHESS_SEAT_REF_TYPE}
           and o.status = any(${ENDED_BADLY_STATUSES as OutboxStatus[]}::text[])
           and ep.status = 'pending' and ep.challenge_id is null and ep.create_sent_at is null
           and (case o.meta->>'colour' when 'white' then ep.white_emailed_at when 'black' then ep.black_emailed_at end)
               = (case when o.meta->>'stampedAt' ~ ${ISO_INSTANT} then (o.meta->>'stampedAt')::timestamptz end)
           and not exists (
             select 1 from email_outbox s
              where s.kind = 'chess_invite' and s.ref_type = o.ref_type and s.ref_id = o.ref_id
                and s.meta->>'stampedAt' = o.meta->>'stampedAt'
                and s.status = any(${SEAT_HOLDING_STATUSES as OutboxStatus[]}::text[]))
         order by o.ref_id, o.meta->>'stampedAt', o.status_at, o.id
      ) d
     order by d.status_at, d.id
     limit ${limit}`;
  return rows.map((r) => ({ id: r.id, kind: "chess_invite" as const, refType: r.ref_type, refId: r.ref_id, status: r.status, meta: r.meta }));
}
