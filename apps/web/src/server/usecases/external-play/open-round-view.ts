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
import type { OpenRoundBatch, OpenRoundPairing, OpenRoundPress, OpenRoundView } from "@/lib/open-round";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stageCameraPolicy } from "@/server/external-play/camera-policy";
import { readOnlinePlay, supportsOnlinePlay } from "@/server/external-play/online-play";
import { boardExtraSql, boardRankSql, roundKey, roundOpensOfDivisions, type RoundOpenRow } from "@/server/external-play/round-open";
import {
  CHECKIN_BATCH_GAP_MS,
  DEADLINE_AFTER_MS,
  batchCount,
  batchOfRank,
  boardAnchor,
  bridgeGameOnFile,
  extendRefusal,
  roomPhase,
  windowFor,
} from "@/server/external-play/window";
import { loadSideNames, whiteSideOf, type Side } from "./guard";
import { bridgeTakesInvites } from "./invite";
import { isPlayableFixtureStatus } from "./preflight";
import { fixturesSeating } from "./seated";

type Row = {
  fixtureId: string;
  stageId: string;
  stageName: string;
  roundNo: number;
  /** `fixtures.seq_in_round`, NOT NULL in the schema: every board has its own number (N3, T16 fix round 2 — as M4 for
   *  the arbiter: an `i + 1` fallback could never run). */
  seq: number;
  /** The board's zero-based position among EVERY row of its (stage, round) - `boardRankSql`, the one authority for it. */
  rank: number;
  status: string;
  homeEntrantId: string | null;
  awayEntrantId: string | null;
  scheduledAt: Date | null;
  bridgeStatus: string | null;
  challengeId: string | null;
  createSentAt: Date | null;
  /** A live mint claim is a game in flight (`bridgeGameOnFile`); with the challenge and the marker it is what refuses an extension. */
  mintClaimedAt: Date | null;
  /** The board's check-in extension so far (spec §3.2.2): the milliseconds added to its deadline, and how many presses made them. */
  extraMs: number;
  extensions: number;
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
  /** EVERY fixture row of the (stage, round) in rank order (`seq_in_round`, `id`), byes and withdrawn boards included.
   *  A board's rank, and so its batch, is its `rank` (spec §3.2.1), read from `boardRankSql` with the row and not derived
   *  from its place in this list. */
  group: Row[];
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
           f.seq_in_round as "seq", ${boardRankSql(sql)} as "rank", f.status,
           f.home_entrant_id as "homeEntrantId", f.away_entrant_id as "awayEntrantId", f.scheduled_at as "scheduledAt",
           ep.status as "bridgeStatus", ep.challenge_id as "challengeId", ep.create_sent_at as "createSentAt",
           ep.mint_claimed_at as "mintClaimedAt", ${boardExtraSql(sql)} as "extraMs",
           coalesce(ep.checkin_extensions, 0)::int as extensions,
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

  // M8: the division's round opens, and which of them bound anyone, in two reads — not two per (stage, round).
  const opens = await roundOpensOfDivisions(sql, [divisionId]);
  const openIds = [...opens.values()].map((o) => o.id);
  // "Was anyone in this round invited?" — over EVERY bridge row bound to the open, whatever became of its board.
  const boundOpenIds =
    openIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await sql<{ id: string }[]>`
              select distinct round_open_id as id from fixture_external_play
               where round_open_id = any(${openIds}::uuid[])`
          ).map((r) => r.id),
        );

  // R1: per stage, each round's games still in play — a paired board still to be played (a bye is forfeited, a
  // decided board settled: neither is in play).
  const inPlay = new Map<string, { roundNo: number; games: number }[]>();
  for (const group of groups.values()) {
    const games = group.filter((r) => isPlayableFixtureStatus(r.status) && r.homeEntrantId !== null && r.awayEntrantId !== null).length;
    if (games === 0) continue;
    const list = inPlay.get(group[0]!.stageId) ?? [];
    list.push({ roundNo: group[0]!.roundNo, games });
    inPlay.set(group[0]!.stageId, list);
  }

  const facts: RoundFacts[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    // A bye is forfeited and a withdrawn board abandoned: neither is played, so neither is invited.
    const live = group.filter((r) => isPlayableFixtureStatus(r.status));
    if (live.length === 0) continue; // openRound: no_fixtures
    if (live.some((r) => r.homeEntrantId === null || r.awayEntrantId === null)) continue; // openRound: not_paired
    const boards = live as Paired[];
    const open = opens.get(roundKey(first.stageId, first.roundNo)) ?? null;
    const owed = boards.reduce((n, b) => n + owedSeats(b, open), 0);
    // Spec §3.2.1: each board's window is its OWN batch's. The round is closed when its LAST batch has closed (rank
    // order, so the last row's anchor is the latest); a re-invite is offered only while some board it would still invite
    // has a window that has not closed - openRound skips the rest, and would answer already_open if nothing is left.
    // Spec §3.2.2: ...and each carries its own check-in extension, so the round is closed when the board whose (extended)
    // deadline is LATEST has closed - not simply the last batch's, which a longer extension on an earlier board can outlast.
    const anchorOf = (b: Row) => boardAnchor(open!.roundOpenedAt, b.rank, open!.staggered, b.extraMs);
    const latestDeadline = open === null ? null : Math.max(...group.map((r) => windowFor(anchorOf(r)).deadline.getTime()));
    const closed = open !== null && now.getTime() >= latestDeadline!;
    const owedOpen = open === null ? owed : boards.reduce((n, b) => n + (roomPhase(now, anchorOf(b)) === "closed" ? 0 : owedSeats(b, open)), 0);
    let press: OpenRoundPress;
    if (open === null) press = "open";
    else if (owed === 0) press = "none";
    else press = !boundOpenIds.has(open.id) ? "reopen" : owedOpen === 0 ? "none" : "reinvite";
    facts.push({ stageId: first.stageId, stageName: first.stageName, roundNo: first.roundNo, boards, group, open, press, closed });
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

  // M8: every shown board's names in one read. The colour stays per board — `whiteSideOf` is the fold's own reading
  // (getFixtureState), asked only where no game has fixed it yet — but concurrently, not one board after another.
  const shownBoards = shown.flatMap((f) => f.boards);
  const [names, colours] = await Promise.all([
    loadSideNames(shownBoards.flatMap((b) => [b.homeEntrantId, b.awayEntrantId])),
    Promise.all(shownBoards.map((b) => b.whiteSide ?? whiteSideOf({ fixtureId: b.fixtureId, orgId: auth.orgId }))),
  ]);
  const whiteSideByFixture = new Map(shownBoards.map((b, i) => [b.fixtureId, colours[i]!]));
  const nameOf = (entrantId: string) => names.get(entrantId) ?? "—";

  // Whether a round that is not yet open WOULD stagger: the camera policy of this moment, which is what the open will store.
  const policyByStage = new Map<string, boolean>();
  for (const f of shown) {
    if (f.open === null && !policyByStage.has(f.stageId)) {
      policyByStage.set(f.stageId, (await stageCameraPolicy(sql, f.stageId)) !== "off");
    }
  }

  // Spec §3.2.2: a board the viewer plays on is never extended by them (C1), so it is not counted among the boards a
  // round-wide press would reach.
  const own = auth.userId === null || shownBoards.length === 0 ? new Set<string>() : await fixturesSeating(auth.userId, shownBoards.map((b) => b.fixtureId));

  const out: OpenRoundView[] = [];
  for (const f of shown) {
    const pairings: OpenRoundPairing[] = [];
    for (const b of f.boards) {
      const whiteSide = whiteSideByFixture.get(b.fixtureId)!;
      const white = nameOf(whiteSide === "home" ? b.homeEntrantId : b.awayEntrantId);
      const black = nameOf(whiteSide === "home" ? b.awayEntrantId : b.homeEntrantId);
      const stamped = boundStamps(b, f.open);
      const invitedAt = stamped.length === 0 ? null : new Date(Math.max(...stamped.map((d) => d.getTime()))).toISOString();
      pairings.push({
        fixtureId: b.fixtureId,
        boardNo: b.seq,
        whiteName: white,
        blackName: black,
        invitedAt,
        owedSeats: owedSeats(b, f.open),
        // No `closed` term: a closed round is shown only as 'reopen' (nobody bound to its open), where nothing is
        // stamped — invitedAt is null on every board. (A `!closed` here survived its mutant: it was unreachable.)
        canResend: f.open !== null && takesInvites(b) && invitedAt !== null,
      });
    }
    const openedAt = f.open?.roundOpenedAt ?? null;
    const staggered = f.open !== null ? f.open.staggered : (policyByStage.get(f.stageId) ?? false);
    const batches: OpenRoundBatch[] = [];
    const nBatches = staggered ? batchCount(f.group.length) : 1;
    for (let i = 0; i < nBatches; i++) {
      const slice = staggered ? f.group.filter((r) => batchOfRank(r.rank) === i) : f.group;
      // The batch's start and deadline come from window.ts and from nowhere else: its start from the anchor of its first board,
      // its close from its boards' own (extended) deadlines - the latest among them (spec §3.2.2: a board of the batch can
      // have been given more time than its neighbours, and the batch is open until the last of them has closed).
      const first = f.open === null ? null : boardAnchor(f.open.roundOpenedAt, staggered ? slice[0]!.rank : 0, staggered);
      const open = f.open;
      const closes = open === null ? null : new Date(Math.max(...slice.map((r) => windowFor(boardAnchor(open.roundOpenedAt, r.rank, staggered, r.extraMs)).deadline.getTime())));
      batches.push({
        fromBoard: slice[0]!.seq,
        toBoard: slice[slice.length - 1]!.seq,
        offsetMs: staggered ? i * CHECKIN_BATCH_GAP_MS : 0,
        opensAt: first?.at.toISOString() ?? null,
        closesAt: closes?.toISOString() ?? null,
      });
    }
    // The deadline a re-invite names is the earliest among the boards it would still invite (never later than the truth);
    // otherwise the round's LAST close - the latest of its batches' - when the round as a whole closes.
    const closings = batches.flatMap((b) => (b.closesAt === null ? [] : [new Date(b.closesAt).getTime()]));
    let deadlineAt = openedAt === null || closings.length === 0 ? null : new Date(Math.max(...closings)).toISOString();
    if (f.open !== null && f.press === "reinvite") {
      const open = f.open;
      const ahead = f.boards
        .filter((b) => owedSeats(b, open) > 0)
        .map((b) => windowFor(boardAnchor(open.roundOpenedAt, b.rank, open.staggered, b.extraMs)).deadline)
        .filter((d) => d.getTime() > now.getTime());
      if (ahead.length > 0) deadlineAt = new Date(Math.min(...ahead.map((d) => d.getTime()))).toISOString();
    }
    const times = f.boards.map((b) => b.scheduledAt?.getTime()).filter((t): t is number => t !== undefined);
    const view: OpenRoundView = {
      stageId: f.stageId,
      stageName: f.stageName,
      roundNo: f.roundNo,
      state: isRoundPaired({ roundOpenedAt: openedAt?.toISOString() ?? null, fixtureCount: f.boards.length }) ? "paired" : "open",
      openedAt: openedAt?.toISOString() ?? null,
      deadlineAt,
      windowMinutes: DEADLINE_AFTER_MS / 60_000,
      staggered,
      batches,
      staggerSpanMinutes: Math.ceil(((nBatches - 1) * (staggered ? CHECKIN_BATCH_GAP_MS : 0)) / 60_000),
      scheduledAt: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(),
      press: f.press,
      pairings,
      // Spec §3.2.2: how many boards a "+N min to the round" would extend right now - the same rule the door asks, board by board.
      extendableBoards:
        f.open === null
          ? 0
          : f.boards.filter(
              (b) =>
                !own.has(b.fixtureId) &&
                extendRefusal({
                  now,
                  anchor: boardAnchor(f.open!.roundOpenedAt, b.rank, f.open!.staggered, b.extraMs),
                  extensions: b.extensions,
                  playable: isPlayableFixtureStatus(b.status) && b.bridgeStatus !== "finished",
                  gameOnFile: bridgeGameOnFile(
                    { status: b.bridgeStatus ?? "pending", challengeId: b.challengeId, createSentAt: b.createSentAt, mintClaimedAt: b.mintClaimedAt },
                    now,
                  ),
                }) === null,
            ).length,
      earlierInPlay: (inPlay.get(f.stageId) ?? []).filter((x) => x.roundNo < f.roundNo).sort((a, b) => a.roundNo - b.roundNo),
    };
    out.push(view);
  }
  return out;
}
