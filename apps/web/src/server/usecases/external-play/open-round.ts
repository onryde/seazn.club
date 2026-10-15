import "server-only";
// The organiser opens a round (D12, spec §3.2). Swiss PAIRS the next round by
// itself; opening and inviting is the organiser's act, because an invite
// starts a clock against real people who have to be at a screen. Nothing
// seats (T8) and no game is created (T9) until this stamps
// `stage_round_opens`, and T−10/T+20 hang off that stamp.
//
// THE RULES (controller rulings 2026-10-10, Q1–Q3):
//   - Refusals come first and write NOTHING: authorisation, an offline
//     division (422), then `division_not_started`, `clock_not_playable`
//     (addendum 1 — T6 gates a clock only when it CHANGES, so a pre-gate
//     stored clock is re-checked here), `no_fixtures`, `not_paired`. A board
//     with no start time is served (ruling 2026-10-10): `not_scheduled` was
//     deleted, since the guard no longer refuses any such case.
//   - The invite record is the per-seat stamp (invite.ts). Opening invites
//     every seat of the round that can still take an invite and has not been
//     invited for THIS open — idempotent per seat. One invite per player, per
//     board, per pairing.
//   - The window: a first open stamps `opened_at`. A re-open RE-STAMPS
//     `opened_at`/`opened_by` (a fresh window) ONLY when the round holds zero
//     invited seats — what a re-pair leaves, because `clearSwissFixtureSeats`
//     deletes the unseated boards' bridge rows. A partly invited round keeps
//     its window; a board whose window has already closed is not invited and
//     is reported per fixture as `window_closed` (Q2). No window ever moves
//     for a partly invited round.
//   - A board a game stands behind (or may: T9's create marker) is never
//     invited into and counts on neither side of that rule.
//   - A fresh window is a fresh pairing (final re-review N-2): the re-stamp
//     deletes the video meetings of the round's boards that never had a game
//     (their participants cascade), in the same transaction, and ends any
//     still active at RealtimeKit after the commit, best effort. A meeting
//     was one per fixture for life, so a re-paired board's new players met
//     the old pairing's meeting — joined it, or, once the sweep had ended it,
//     could not check in at all (VIDEO_MEETING_ENDED, under optional too).
//   - Each seat is stamped BEFORE its mail is sent and un-stamped if the send
//     fails, so a re-open retries it and nobody is mailed twice. A crash
//     between the stamp and the send loses that one invite; the organiser's
//     Resend (invite.ts) is the way back.
//
// `stage_round_opens` is SEALED (FORCE RLS, no app_user grant), so the stamp
// is written through the privileged `sql` client — which is why the actor is
// authorised HERE, first, against the stage's own org, before any write.
import { getOrgRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { OpenRoundResult, OpenRoundSkip } from "@/lib/open-round";
import { EDITOR_ROLES } from "@/lib/types";
import type { BoardgameClockInput } from "@/server/external-play/clock";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { roundOpenAt, type RoundOpenRow } from "@/server/external-play/round-open";
import { assertTimeControl } from "@/server/external-play/time-controls";
import { RealtimeKitDeferred, endMeeting, gameEvidenceOn } from "@/server/external-play/video/realtimekit";
import { roomPhase } from "@/server/external-play/window";
import { log } from "@/server/logger";
import { audit } from "../audit";
import { loadOnlinePlayFixture, resetStaleBridge, type OnlinePlayFixture } from "./guard";
import {
  attachToOpen,
  boardSeats,
  bridgeTakesInvites,
  claimSeat,
  releaseSeat,
  sendFixtureInvite,
  type Colour,
  type InviteBridgeFacts,
  type InviteSeat,
} from "./invite";
import { assertOnlineChessOffered } from "./online-chess-flag";
import { isPlayableFixtureStatus } from "./preflight";

export type { OpenRoundRefusal, OpenRoundResult, OpenRoundSkip } from "@/lib/open-round";

/** The planned name for the one reader of the open stamp (round-open.ts,
 *  addendum 3). `null` ⇒ the organiser has not opened this round. */
export async function roundOpenedAt(a: { stageId: string; roundNo: number }): Promise<Date | null> {
  return (await roundOpenAt(sql, a.stageId, a.roundNo))?.roundOpenedAt ?? null;
}

/** Test seam only — the route passes none. `now` stamps `opened_at` and the
 *  seat stamps, and is the clock the window is judged on. */
export type OpenRoundDeps = {
  now?: Date;
  origin?: string;
  /** T7's teardown, for the meetings a re-stamp deletes (N-2). */
  endMeeting?: (meetingId: string) => Promise<void>;
};

type StageRow = {
  orgId: string;
  divisionId: string;
  competitionId: string;
  sportKey: string;
  config: unknown;
  divisionStatus: string;
};

type RoundFixtureRow = {
  id: string;
  status: string;
  homeEntrantId: string | null;
  awayEntrantId: string | null;
};

type Board = { f: OnlinePlayFixture; seats: [InviteSeat, InviteSeat] };

type BridgeFactsRow = InviteBridgeFacts & {
  fixture_id: string;
  round_open_id: string | null;
  white_emailed_at: Date | null;
  black_emailed_at: Date | null;
};

type Claim = { board: Board; seat: InviteSeat };

type Decision =
  | { kind: "nothing"; skipped: OpenRoundSkip[] }
  | { kind: "opened" | "reopened" | "reinvited"; open: RoundOpenRow; claims: Claim[]; staleMeetings: string[] };

const AUDIT_TYPE = {
  opened: "external_play.round_opened",
  reopened: "external_play.round_reopened",
  reinvited: "external_play.round_reinvited",
} as const;

/** T5's catalogue on the clock the division STORES. Only INVALID_TIME_CONTROL
 *  means "not playable"; anything else propagates. */
function storedClockPlayable(config: unknown): boolean {
  try {
    assertTimeControl((config as { clock?: BoardgameClockInput } | null)?.clock);
    return true;
  } catch (err) {
    if (err instanceof HttpError && err.code === "INVALID_TIME_CONTROL") return false;
    throw err;
  }
}

function roundChanged(): HttpError {
  return new HttpError(409, "The round changed while it was being opened — try again", "ROUND_CHANGED");
}

export async function openRound(
  a: { stageId: string; roundNo: number; actorUserId: string },
  deps: OpenRoundDeps = {},
): Promise<OpenRoundResult> {
  const now = deps.now ?? new Date();

  // The stage id is the caller's; the privileged read only resolves which org
  // it belongs to, and the actor is checked against THAT org next.
  const [st] = await sql<StageRow[]>`
    select s.org_id as "orgId", s.division_id as "divisionId", d.competition_id as "competitionId",
           d.sport_key as "sportKey", d.config, d.status as "divisionStatus"
      from stages s join divisions d on d.id = s.division_id
     where s.id = ${a.stageId}`;
  if (!st) throw new HttpError(404, "stage not found");

  // Authorise FIRST. The same role set every organiser write is held to
  // (EDITOR_ROLES, via the same getOrgRole requireOrgAuth reads); the route
  // has already run requireResourceAuth(stage, write) — this is the usecase
  // refusing to write for an actor who is not an organiser of this org.
  const role = await getOrgRole(st.orgId, a.actorUserId);
  if (role === null || !(EDITOR_ROLES as readonly string[]).includes(role)) {
    throw new HttpError(403, "Only an organiser of this organisation can open a round", "OPEN_ROUND_FORBIDDEN");
  }

  if (!supportsOnlinePlay(st.sportKey) || readOnlinePlay(st.config) !== "lichess") {
    throw new HttpError(422, "This round is not played online", "ROUND_NOT_ONLINE");
  }
  // T20: an open STARTS play — it invites real people and starts their window — so the club must be offered online
  // chess (the PostHog flag `online-chess`; 403 ONLINE_CHESS_DISABLED). A re-open invites too, so it is gated alike.
  // After the two refusals above: a stranger learns nothing about the club's flag, and an offline round asks nothing.
  await assertOnlineChessOffered({ orgId: st.orgId, userId: a.actorUserId });
  // The guard serves no board of a division that has not started.
  if (st.divisionStatus === "setup" || st.divisionStatus === "scheduled") {
    return { opened: false, reason: "division_not_started" };
  }
  if (!storedClockPlayable(st.config)) return { opened: false, reason: "clock_not_playable" };

  const rows = await sql<RoundFixtureRow[]>`
    select id, status, home_entrant_id as "homeEntrantId", away_entrant_id as "awayEntrantId"
      from fixtures
     where stage_id = ${a.stageId} and round_no = ${a.roundNo}
     order by seq_in_round, id`;
  // A bye is `forfeited` and a withdrawn board `abandoned`: neither is played,
  // so neither is unpaired and neither is invited. T8's predicate is the one
  // authority for "still playable".
  const live = rows.filter((r) => isPlayableFixtureStatus(r.status));
  if (live.some((r) => r.homeEntrantId === null || r.awayEntrantId === null)) {
    return { opened: false, reason: "not_paired" };
  }
  // The empty case: no row at all, or only byes and settled boards.
  if (live.length === 0) return { opened: false, reason: "no_fixtures" };
  // A board with no start time is NOT refused (ruling 2026-10-10): the window
  // hangs off this open, and its bridge row is minted on `opened_at`.

  // Every board through THE guard. Each predicate it holds was checked above,
  // so a null here is the round changing underneath this call.
  const boards: Board[] = [];
  for (const r of live) {
    const f = await loadOnlinePlayFixture(r.id);
    if (!f) throw roundChanged();
    await resetStaleBridge(f); // a rescheduled, game-less row starts over (T7)
    boards.push({ f, seats: await boardSeats(f) });
  }

  const decision = await sql.begin(async (tx): Promise<Decision> => {
    // The lock every pairing write takes (generate, unpair, addFixture,
    // deleteEntrant): under it the seats this call is about to invite cannot
    // be re-paired, and two opens of one round cannot interleave.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + st.divisionId}))`;
    const ids = boards.map((b) => b.f.fixtureId);
    const fresh = await tx<{ id: string; home: string | null; away: string | null; status: string; roundNo: number }[]>`
      select id, home_entrant_id as home, away_entrant_id as away, status, round_no as "roundNo"
        from fixtures where id in ${tx(ids)}`;
    const byId = new Map(fresh.map((r) => [r.id, r]));
    for (const b of boards) {
      const r = byId.get(b.f.fixtureId);
      // (A fixture never changes stage, so stage_id is not re-checked.)
      if (
        !r ||
        r.home !== b.f.homeEntrantId ||
        r.away !== b.f.awayEntrantId ||
        r.roundNo !== a.roundNo ||
        !isPlayableFixtureStatus(r.status)
      ) {
        throw roundChanged();
      }
    }

    const existing = await roundOpenAt(tx, a.stageId, a.roundNo);
    const bridges = await tx<BridgeFactsRow[]>`
      select fixture_id, status, challenge_id, create_sent_at, round_open_id,
             white_emailed_at, black_emailed_at
        from fixture_external_play where fixture_id in ${tx(ids)}`;
    const bridgeOf = new Map(bridges.map((b) => [b.fixture_id, b]));
    // A stamp is only ever written on a row naming its round's open (CHECK
    // fixture_external_play_invite_needs_open_round_check + the binding
    // trigger), there is one open row per (stage, round), and no product path
    // moves a fixture between rounds — so a row of this round names no open
    // or THIS one, and a stamp on it IS an invite for this open. Asserted, not
    // assumed: a row naming another open would read its stamps as this
    // round's invites and silently mail nobody.
    const foreign = bridges.find((b) => b.round_open_id !== null && b.round_open_id !== existing?.id);
    if (foreign) {
      throw new Error(
        `openRound: bridge row of fixture ${foreign.fixture_id} names open ${foreign.round_open_id}, not this round's`,
      );
    }
    // T17B fix 2, D17 (owner ruling 2026-10-14 "re-arm"; controller ruling option 1): a playable board whose row
    // our side CLOSED with no game — the arbiter's No result (core.abandon, the row `finished`), then the
    // organiser's void — is re-armed HERE, by the organiser's re-open, never by the void. Deleting it at the void
    // handed the board to the sweep, whose no-show wrote a double walkover over it on the next pass (measured): the
    // closed row is the only thing keeping it out. Game-less is the one evidence rule a re-pair spares a meeting by
    // (gameEvidenceOn: a recorded challenge, a create marker) plus no move on file; a row with any of it is a game,
    // and stays the organiser's. Read under the division lock and locked FOR UPDATE, so the decision below and the
    // reset after it see the same row. Only `ids` (the round's PLAYABLE boards) are looked at.
    const rearmed = new Set(
      (
        await tx<{ fixture_id: string }[]>`
          select ep.fixture_id from fixture_external_play ep
           where ep.fixture_id in ${tx(ids)}
             and ep.status = 'finished' and ep.move_count = 0
             and not ${gameEvidenceOn(now)}
           order by ep.fixture_id
           for update`
      ).map((r) => r.fixture_id),
    );
    /** The bridge facts this open reads for a board: none at all for one it re-arms (it is reset before any invite). */
    const factsOf = (fixtureId: string): BridgeFactsRow | null =>
      rearmed.has(fixtureId) ? null : (bridgeOf.get(fixtureId) ?? null);
    const invitedFor = (fixtureId: string, colour: Colour): boolean => {
      const b = factsOf(fixtureId);
      if (!existing || !b) return false;
      return (colour === "white" ? b.white_emailed_at : b.black_emailed_at) !== null;
    };

    const takes = boards.filter((b) => bridgeTakesInvites(factsOf(b.f.fixtureId)));
    const pending: { board: Board; seats: InviteSeat[] }[] = [];
    for (const board of takes) {
      const open = board.seats.filter((s) => !invitedFor(board.f.fixtureId, s.colour));
      if (open.length > 0) pending.push({ board, seats: open });
    }
    // "Was anyone in this round invited?" — over EVERY bridge row bound to
    // this open, whatever became of its board: a game, a result, an
    // organiser's hold, a board no longer played (review I1, ruling
    // 2026-10-10). Counting only the boards still taking invites let a late
    // or rescheduled board read "nobody invited" once its neighbours had
    // moved on, and re-stamp the WHOLE round's window past T+20.
    //
    // The binding, not the stamp, is the record: a row is bound by the open
    // that reaches one of its seats, and stays bound when a reschedule's
    // reset (T7) clears its stamps to re-mail the new time — so that board is
    // re-invited INSIDE the round's window, never re-opens it. A failed
    // send's un-stamp unbinds a row none of whose seats was reached
    // (releaseSeat). Only a real re-pair (the unpair deletes the game-less
    // rows and refuses the rest), a rebuild, or a round whose every send
    // failed reaches "nobody", and only then does the window start again.
    const anyInvited = existing
      ? (
          await tx<{ any: boolean }[]>`
            select exists (
              select 1 from fixture_external_play where round_open_id = ${existing.id}
            ) as any`
        )[0]!.any
      : false;
    // D17's narrow exception to I1: a re-open that re-arms a board re-stamps the window when every OTHER board bound
    // to this open is decided — nobody still playing was invited into the window that would move. A neighbour still
    // playable keeps the window (the board is then `window_closed` once it has closed, exactly as before), and a
    // round re-arming nothing never takes this branch, so a late or rescheduled board still cannot re-open it. Its
    // decided neighbours' links survive the move: a room token is bound to the open's id, which a re-stamp keeps.
    const otherBoundStillPlayable =
      existing && rearmed.size > 0
        ? (
            await tx<{ fixture_id: string; status: string }[]>`
              select ep.fixture_id, fx.status from fixture_external_play ep
                join fixtures fx on fx.id = ep.fixture_id
               where ep.round_open_id = ${existing.id}`
          ).some((r) => !rearmed.has(r.fixture_id) && isPlayableFixtureStatus(r.status))
        : true;

    let open: RoundOpenRow;
    let kind: "opened" | "reopened" | "reinvited";
    let staleMeetings: string[] = [];
    if (!existing) {
      const [row] = await tx<RoundOpenRow[]>`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
        values (${a.stageId}, ${st.orgId}, ${a.roundNo}, ${now}, ${a.actorUserId})
        returning id, opened_at as "roundOpenedAt", opened_by as "openedBy"`;
      open = row!;
      kind = "opened";
    } else if (pending.length === 0) {
      return { kind: "nothing", skipped: [] };
    } else if (!anyInvited || !otherBoundStillPlayable) {
      // Nobody this round was invited (a re-pair deleted the rows, or every
      // send failed), or — D17 — the only boards still playable are the ones
      // this open re-arms: the window starts now, for everyone.
      const [row] = await tx<RoundOpenRow[]>`
        update stage_round_opens set opened_at = ${now}, opened_by = ${a.actorUserId}
         where id = ${existing.id}
        returning id, opened_at as "roundOpenedAt", opened_by as "openedBy"`;
      open = row!;
      kind = "reopened";
      // N-2: the meetings of the last window's pairing. A board a game IS or MAY BE on file behind keeps its
      // meeting — the camera evidence of that game: a recorded challenge, a sent create (T9's marker), or a LIVE mint
      // claim (T9 in flight, before its marker; R2-3) — gameEvidenceOn, the one rule ensureMeeting keeps too. Every
      // other board's meeting goes, with its participants: players who checked in through the lobby inside the old
      // window are kicked too, because the window starts now for everyone. Only the still-active meetings are ended
      // at RealtimeKit, after the commit. D16: a board has a meeting PER PLAYER and this deletes BY BOARD on purpose -
      // both rows go, and every one returned is ended below, not the first (allow-listed in the source guard).
      staleMeetings = (
        await tx<{ meeting_id: string; ended_at: Date | null }[]>`
          delete from fixture_video_meetings m
           where m.fixture_id in ${tx(ids)}
             and not exists (
               select 1 from fixture_external_play ep
                where ep.fixture_id = m.fixture_id and ${gameEvidenceOn(now)})
          returning m.meeting_id, m.ended_at`
      )
        .filter((r) => r.ended_at === null)
        .map((r) => r.meeting_id);
    } else {
      open = existing;
      kind = "reinvited";
      if (roomPhase(now, open.roundOpenedAt) === "closed") {
        return {
          kind: "nothing",
          skipped: pending.map((p) => ({ fixtureId: p.board.f.fixtureId, reason: "window_closed" as const })),
        };
      }
    }

    // D17: the re-arm, only now that the board WILL be invited (a reset answered `window_closed` would hand it to the
    // sweep's no-show). As a re-pair resets a board (stages.ts clearSwissFixtureSeats, M-10): its row goes, and with
    // it the closed pairing's stamps, so the attach below mints it afresh for this open. Its video meeting goes too —
    // it holds no game's evidence, and a meeting the sweep ended at the No result would refuse the replay's check-in
    // (VIDEO_MEETING_ENDED) — ended at RealtimeKit after the commit, as N-2's are. D16: both players' meetings, by board
    // on purpose (allow-listed in the source guard).
    if (rearmed.size > 0) {
      const rearmedIds = [...rearmed];
      staleMeetings.push(
        ...(
          await tx<{ meeting_id: string; ended_at: Date | null }[]>`
            delete from fixture_video_meetings where fixture_id in ${tx(rearmedIds)}
            returning meeting_id, ended_at`
        )
          .filter((r) => r.ended_at === null)
          .map((r) => r.meeting_id),
      );
      await tx`delete from fixture_external_play where fixture_id in ${tx(rearmedIds)}`;
    }

    const claims: Claim[] = [];
    for (const p of pending) {
      await attachToOpen(tx, p.board.f, open);
      for (const seat of p.seats) {
        if (await claimSeat(tx, p.board.f.fixtureId, seat.colour, open.id, now)) {
          claims.push({ board: p.board, seat });
        }
      }
    }
    return { kind, open, claims, staleMeetings };
  });

  if (decision.kind === "nothing") {
    return { opened: false, reason: "already_open", skipped: decision.skipped };
  }

  // N-2: its row is gone, so nothing of ours hands out a token for it again; ending it stops the old pairing's
  // cameras at the vendor. Best effort and never silent — a failure leaves an unused meeting, never a blocked open.
  for (const meetingId of decision.staleMeetings) {
    try {
      await (deps.endMeeting ?? endMeeting)(meetingId);
    } catch (err) {
      // D21-fix (m3): a call the platform's budget refused is nothing broken - warn, not error. The row is gone, so nothing
      // retries it (the sweep ends meetings it has a row for): the old meeting stays at the vendor, unused, and no
      // participant of ours holds a token for it.
      const fields = { stageId: a.stageId, roundNo: a.roundNo, meetingId, err: err instanceof Error ? err.message : String(err) };
      const message = "openRound: could not end a re-paired board's old meeting at RealtimeKit — its row is gone and it is no longer used";
      if (err instanceof RealtimeKitDeferred) log.warn(fields, message);
      else log.error(fields, message);
    }
  }

  // Sent AFTER the commit: a mail cannot be rolled back, so the stamp is
  // committed first and released on a failed send. Each seat is its own
  // attempt (review M1): a throw — from the sender, or from the un-stamp —
  // fails THAT seat, which is reported, and never strands the seats after it
  // as "invited" with no mail. The audit is written whatever happened.
  let invited = 0;
  const failed = new Set<string>();
  try {
    for (const c of decision.claims) {
      const fixtureId = c.board.f.fixtureId;
      let ok = false;
      try {
        ok = await sendFixtureInvite({
          fixture: c.board.f,
          seat: c.seat,
          roundNo: a.roundNo,
          roundOpenId: decision.open.id,
          roundOpenedAt: decision.open.roundOpenedAt,
          origin: deps.origin,
        });
      } catch (err) {
        log.error({ fixtureId, colour: c.seat.colour, err }, "openRound: invite send threw");
      }
      if (ok) {
        invited += 1;
        continue;
      }
      failed.add(fixtureId);
      try {
        await releaseSeat(sql, fixtureId, c.seat.colour, now);
      } catch (err) {
        // The seat stays stamped with nothing sent. It is reported below as
        // send_failed, so the organiser's Resend is the way back.
        log.error({ fixtureId, colour: c.seat.colour, err }, "openRound: un-stamp after a failed send threw");
      }
    }
  } finally {
    const skipped: OpenRoundSkip[] = [...failed].map((fixtureId) => ({ fixtureId, reason: "send_failed" }));
    await audit(
      sql,
      st.competitionId,
      st.orgId,
      AUDIT_TYPE[decision.kind],
      {
        stageId: a.stageId,
        roundNo: a.roundNo,
        roundOpenedAt: decision.open.roundOpenedAt.toISOString(),
        invited,
        skipped,
      },
      a.actorUserId,
    );
  }
  const skipped: OpenRoundSkip[] = [...failed].map((fixtureId) => ({ fixtureId, reason: "send_failed" }));
  return { opened: true, invited, skipped };
}
