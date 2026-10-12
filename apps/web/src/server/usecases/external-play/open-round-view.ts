import "server-only";
// T16 (D12) — what the organiser's Open round control reads. Per stage: the
// lowest round that is paired but not opened, and every opened round that
// still has someone to invite or a window running; per pairing, by colour and
// by the person's name, whether its invite went out and when.
//
// `press` PREDICTS what `openRound` (open-round.ts) would do on the same rows
// and clock, from the same predicates (`isPlayableFixtureStatus`,
// `bridgeTakesInvites`, `roomPhase`, "is any bridge row bound to the open"),
// so the control never offers a press the server refuses as already open, and
// never hides a round the server would open. open-round-view.test.ts presses
// the real usecase on every state it reads.
//
// Read for the organiser on the fixtures tab. Not gated here by the online-
// chess flag: the PAGE renders the control only while the club is offered it
// (T20), because an open STARTS play.
//
// `stage_round_opens` is SEALED (FORCE RLS, no app_user grant): it is read
// with the privileged `sql`, after the caller's organisation is proven to own
// the division.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isRoundPaired } from "@/lib/division-phase";
import type { OpenRoundPairing, OpenRoundPress, OpenRoundView } from "@/lib/open-round";
import type { AuthCtx } from "@/server/api-v1/auth";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { roundOpenAt, type RoundOpenRow } from "@/server/external-play/round-open";
import { DEADLINE_AFTER_MS, roomPhase, windowFor } from "@/server/external-play/window";
import { loadSides, whiteSideOf, type Side } from "./guard";
import { bridgeTakesInvites } from "./invite";
import { isPlayableFixtureStatus } from "./preflight";

type Row = {
  fixtureId: string;
  stageId: string;
  stageName: string;
  roundNo: number;
  seq: number | null;
  status: string;
  homeEntrantId: string | null;
  awayEntrantId: string | null;
  scheduledAt: Date | null;
  bridgeStatus: string | null;
  challengeId: string | null;
  createSentAt: Date | null;
  roundOpenId: string | null;
  whiteEmailedAt: Date | null;
  blackEmailedAt: Date | null;
  whiteSide: Side | null;
};

type Paired = Row & { homeEntrantId: string; awayEntrantId: string };

type RoundFacts = {
  stageId: string;
  stageName: string;
  roundNo: number;
  boards: Paired[];
  open: RoundOpenRow | null;
  press: OpenRoundPress;
  closed: boolean;
};

/** The seats this round's open has stamped on a board. A stamp counts only on
 *  a row bound to THIS open — openRound's own reading (`invitedFor`). */
function boundStamps(b: Row, open: RoundOpenRow | null): Date[] {
  if (open === null || b.roundOpenId !== open.id) return [];
  return [b.whiteEmailedAt, b.blackEmailedAt].filter((d): d is Date => d !== null);
}

function takesInvites(b: Row): boolean {
  return bridgeTakesInvites(
    b.bridgeStatus === null ? null : { status: b.bridgeStatus, challenge_id: b.challengeId, create_sent_at: b.createSentAt },
  );
}

function owedSeats(b: Row, open: RoundOpenRow | null): 0 | 1 | 2 {
  if (!takesInvites(b)) return 0;
  return (2 - boundStamps(b, open).length) as 0 | 1 | 2;
}

export async function listOpenRounds(
  auth: AuthCtx,
  divisionId: string,
  deps: { now?: Date } = {},
): Promise<OpenRoundView[]> {
  const now = deps.now ?? new Date();
  const [division] = await sql<{ sportKey: string; config: unknown; status: string }[]>`
    select d.sport_key as "sportKey", d.config, d.status
      from divisions d join competitions c on c.id = d.competition_id
     where d.id = ${divisionId} and c.org_id = ${auth.orgId}`;
  if (!division) throw new HttpError(404, "division not found", "NOT_FOUND");
  if (!supportsOnlinePlay(division.sportKey) || readOnlinePlay(division.config) !== "lichess") return [];
  // openRound serves no board of a division that has not started (division_not_started).
  if (division.status === "setup" || division.status === "scheduled") return [];

  const rows = await sql<Row[]>`
    select f.id as "fixtureId", f.stage_id as "stageId", s.name as "stageName", f.round_no as "roundNo",
           f.seq_in_round as "seq", f.status,
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId", f.scheduled_at as "scheduledAt",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.create_sent_at as "createSentAt",
           ep.round_open_id as "roundOpenId", ep.white_emailed_at as "whiteEmailedAt",
           ep.black_emailed_at as "blackEmailedAt", ep.white_side as "whiteSide"
      from fixtures f
      join stages s on s.id = f.stage_id
      left join fixture_external_play ep on ep.fixture_id = f.id
     where f.division_id = ${divisionId} and f.org_id = ${auth.orgId} and f.round_no is not null
     order by s.seq, f.round_no, f.seq_in_round nulls last, f.id`;

  // (stage, round) in play order, as the query sorted them.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.stageId}:${r.roundNo}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const facts: RoundFacts[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    // A bye is forfeited and a withdrawn board abandoned: neither is played, so neither is invited.
    const live = group.filter((r) => isPlayableFixtureStatus(r.status));
    if (live.length === 0) continue; // openRound: no_fixtures
    if (live.some((r) => r.homeEntrantId === null || r.awayEntrantId === null)) continue; // openRound: not_paired
    const boards = live as Paired[];
    const open = await roundOpenAt(sql, first.stageId, first.roundNo);
    const owed = boards.reduce((n, b) => n + owedSeats(b, open), 0);
    const closed = open !== null && roomPhase(now, open.roundOpenedAt) === "closed";
    let press: OpenRoundPress;
    if (open === null) press = "open";
    else if (owed === 0) press = "none";
    else {
      // "Was anyone in this round invited?" — over EVERY bridge row bound to the open, whatever became of its board.
      const any = (
        await sql<{ any: boolean }[]>`
          select exists (select 1 from fixture_external_play where round_open_id = ${open.id}) as any`
      )[0]!.any;
      press = !any ? "reopen" : closed ? "none" : "reinvite";
    }
    facts.push({ stageId: first.stageId, stageName: first.stageName, roundNo: first.roundNo, boards, open, press, closed });
  }

  // Of the paired rounds, only each stage's lowest is the next to open; an opened round stays while it still has a
  // press or its window is running.
  const nextPaired = new Map<string, number>();
  for (const f of facts) {
    if (f.open === null && !nextPaired.has(f.stageId)) nextPaired.set(f.stageId, f.roundNo);
  }
  const shown = facts.filter((f) =>
    f.open === null ? nextPaired.get(f.stageId) === f.roundNo : f.press !== "none" || !f.closed,
  );

  const out: OpenRoundView[] = [];
  for (const f of shown) {
    const pairings: OpenRoundPairing[] = [];
    for (const [i, b] of f.boards.entries()) {
      const [sides, whiteSide] = await Promise.all([
        loadSides(b),
        b.whiteSide ?? whiteSideOf({ fixtureId: b.fixtureId, orgId: auth.orgId }),
      ] as const);
      const white = whiteSide === "home" ? sides.home : sides.away;
      const black = whiteSide === "home" ? sides.away : sides.home;
      const stamped = boundStamps(b, f.open);
      const invitedAt = stamped.length === 0 ? null : new Date(Math.max(...stamped.map((d) => d.getTime()))).toISOString();
      pairings.push({
        fixtureId: b.fixtureId,
        boardNo: b.seq ?? i + 1,
        whiteName: white.displayName,
        blackName: black.displayName,
        invitedAt,
        owedSeats: owedSeats(b, f.open),
        canResend: f.open !== null && !f.closed && takesInvites(b) && invitedAt !== null,
      });
    }
    const openedAt = f.open?.roundOpenedAt ?? null;
    const times = f.boards.map((b) => b.scheduledAt?.getTime()).filter((t): t is number => t !== undefined);
    const view: OpenRoundView = {
      stageId: f.stageId,
      stageName: f.stageName,
      roundNo: f.roundNo,
      state: isRoundPaired({ roundOpenedAt: openedAt?.toISOString() ?? null, fixtureCount: f.boards.length }) ? "paired" : "open",
      openedAt: openedAt?.toISOString() ?? null,
      deadlineAt: openedAt === null ? null : windowFor(openedAt).deadline.toISOString(),
      windowMinutes: DEADLINE_AFTER_MS / 60_000,
      scheduledAt: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      press: f.press,
      pairings,
    };
    out.push(view);
  }
  return out;
}
