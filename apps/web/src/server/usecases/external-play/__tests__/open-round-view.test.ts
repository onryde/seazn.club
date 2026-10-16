// T16 (D12) — what the organiser's Open round control reads: per stage, the
// round waiting to be opened and every opened round that still has someone to
// invite or a window running; per pairing, whether its invite went out and
// when. The reader's `press` is a PREDICTION of what `openRound` will do, so
// every state here is checked against the REAL usecase pressed on the same
// rows (`expectPressAgrees`): a control that offers "Open round" on a round
// the server refuses is a dead button, and one that hides a round the server
// would open strands it.
//
// Single-sport by construction: online play exists only for `boardgame`
// (`supportsOnlinePlay`); the not-online case below is the other sports' answer.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isRoundPaired } from "@/lib/division-phase";
import type { OpenRoundView } from "@/lib/open-round";
import { appendEvent } from "@/server/engine-db";
import { CHECKIN_BATCH_GAP_MS, CHECKIN_BATCH_SIZE, DEADLINE_AFTER_MS } from "@/server/external-play/window";

// The email seam, as open-round.test.ts: the real `send` no-ops without
// RESEND_API_KEY and would report every invite as failed. `fail` names
// recipients whose send the provider refuses.
const mail = vi.hoisted(() => ({ sent: [] as string[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(async (to: string) => {
      if (mail.fail.has(to)) return false;
      mail.sent.push(to);
      return true;
    }),
  };
});

import { openRound } from "../open-round";
import { listOpenRounds } from "../open-round-view";
import { addFixture } from "../../stages";
import { getFixtureState } from "../../fixtures";
import { scoreEvent } from "../../scoring";
import {
  seedOnlineChessRound,
  seedOnlineChessRoundWithRankedBoard,
  seedOnlineSwiss,
  type SeedOnlineChessRoundResult,
} from "../../__tests__/_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const T0 = new Date("2026-10-16T19:04:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  mail.sent.length = 0;
  mail.fail.clear();
});

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Seeded = Pick<SeedOnlineChessRoundResult, "owner" | "divisionId" | "stageId" | "ownerUserId">;
const view = (r: Seeded, now: Date) => listOpenRounds(r.owner, r.divisionId, { now });
const press = (r: Seeded, roundNo: number, now: Date) =>
  openRound({ stageId: r.stageId, roundNo, actorUserId: r.ownerUserId }, { now });
const roundOf = (rounds: OpenRoundView[], roundNo: number): OpenRoundView => {
  const hit = rounds.filter((x) => x.roundNo === roundNo);
  expect(hit, `round ${roundNo} listed once`).toHaveLength(1);
  return hit[0]!;
};

/** The seat stamps as the DB holds them — the expected value is read from the
 *  rows openRound wrote, never from the reader under test. */
async function stamps(fixtureId: string): Promise<{ white: Date | null; black: Date | null }> {
  const [b] = await sql<{ white: Date | null; black: Date | null }[]>`
    select white_emailed_at as white, black_emailed_at as black
      from fixture_external_play where fixture_id = ${fixtureId}`;
  return b ?? { white: null, black: null };
}

/** The reader's prediction against the REAL press on the same rows, the same
 *  clock: any press it offers opens; "none" is refused as already open. */
async function expectPressAgrees(r: Seeded, v: OpenRoundView, now: Date) {
  const res = await press(r, v.roundNo, now);
  if (v.press === "none") expect(res, `round ${v.roundNo}: nothing to press ⇒ the server opens nothing`).toMatchObject({ opened: false, reason: "already_open" });
  else expect(res, `round ${v.roundNo}: '${v.press}' ⇒ the server opens`).toMatchObject({ opened: true });
  return res;
}

describe("isRoundPaired (D12)", () => {
  it("the EMPTY case first: no fixtures is not a paired round — it answers no", () => {
    expect(isRoundPaired({ roundOpenedAt: null, fixtureCount: 0 })).toBe(false);
    expect(isRoundPaired({ roundOpenedAt: "2026-10-09T09:50:00Z", fixtureCount: 0 })).toBe(false);
  });
  it("fixtures and no open stamp ⇒ paired; opened ⇒ not merely paired any more", () => {
    expect(isRoundPaired({ roundOpenedAt: null, fixtureCount: 3 })).toBe(true);
    expect(isRoundPaired({ roundOpenedAt: "2026-10-09T09:50:00Z", fixtureCount: 3 })).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("listOpenRounds — what the Open round control reads", () => {
  it("the empty case first: over the board, an unpaired round, a bye-only round ⇒ nothing; another club ⇒ 404", async () => {
    let checked = 0;
    const otb = await seedOnlineChessRound({ fixtures: 2, onlinePlay: "off" });
    expect(await view(otb, T0), "online play off: no round to open, though two boards are paired").toEqual([]);
    checked += 1;
    // openRound would refuse not_paired: no control that cannot open.
    const unpaired = await seedOnlineChessRound({ fixtures: 1, unpaired: true });
    expect(await view(unpaired, T0), "a board with an empty seat").toEqual([]);
    expect(await press(unpaired, 1, T0)).toEqual({ opened: false, reason: "not_paired" });
    checked += 1;
    // A bye is forfeited (not played): a round of byes has nothing to open (no_fixtures).
    const bye = await seedOnlineChessRound({ fixtures: 1, bye: true });
    await sql`update fixtures set status = 'decided' where id = ${bye.boards[0]!.fixtureId}`;
    expect(await view(bye, T0), "only a settled board and a bye").toEqual([]);
    expect(await press(bye, 1, T0)).toEqual({ opened: false, reason: "no_fixtures" });
    checked += 1;
    const other = await seedOnlineChessRound({ fixtures: 1 });
    await expect(listOpenRounds(other.owner, otb.divisionId, { now: T0 })).rejects.toMatchObject({ status: 404 });
    await expect(listOpenRounds(other.owner, randomUUID(), { now: T0 })).rejects.toBeInstanceOf(HttpError);
    checked += 1;
    expect(checked, "anti-vacuity: empty cases checked").toBe(4);
  });

  // T16 fix round 2, N3 (M4's twin): `seq_in_round` is NOT NULL, so a board's number is always its own — the old
  // `seq ?? i + 1` position fallback could never run and is gone. Numbers that differ from the positions (3 and 5, not
  // 1 and 2) are what tell the two apart.
  it("N3: a board's number is its own seq_in_round — never its position in the round; the schema refuses a board without one", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    await expect(sql`update fixtures set seq_in_round = null where id = ${r.boards[0]!.fixtureId}`).rejects.toMatchObject({ code: "23502" });
    await sql`update fixtures set seq_in_round = 3 where id = ${r.boards[0]!.fixtureId}`;
    await sql`update fixtures set seq_in_round = 5 where id = ${r.boards[1]!.fixtureId}`;
    const [v] = await view(r, T0);
    expect(v!.pairings.map((p) => [p.fixtureId, p.boardNo])).toEqual([
      [r.boards[0]!.fixtureId, 3],
      [r.boards[1]!.fixtureId, 5],
    ]);
  });

  it("paired, not opened: every pairing by colour, by the PERSON's name, each still to invite — and the press opens it", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    // F5: the entrant row's display name is not the name on the board.
    await sql`update entrants set display_name = 'Entry 3' where id = ${r.boards[0]!.home.entrantId}`;
    // Board 2's home plays Black (a pairing card): names follow the COLOUR.
    await appendEvent(r.orgId, r.boards[1]!.fixtureId, 0, { type: "boardgame.pairing", payload: { white: r.boards[1]!.away.entrantId } });

    const [v, ...rest] = await view(r, T0);
    expect(rest).toEqual([]);
    expect(v!.state).toBe("paired");
    expect(isRoundPaired({ roundOpenedAt: v!.openedAt, fixtureCount: v!.pairings.length })).toBe(true);
    expect(v!.press).toBe("open");
    expect(v!.openedAt).toBeNull();
    expect(v!.deadlineAt).toBeNull();
    expect(v!.windowMinutes).toBe(DEADLINE_AFTER_MS / MIN);
    expect(v!.scheduledAt).toBe("2026-10-01T12:10:00.000Z"); // the seed's ROUND_T
    expect(v!.pairings.map((p) => [p.boardNo, p.whiteName, p.blackName])).toEqual([
      [1, "P1W", "P1B"],
      [2, "P2B", "P2W"],
    ]);
    let pairings = 0;
    for (const p of v!.pairings) {
      expect(p, p.fixtureId).toMatchObject({ owedSeats: 2, invitedAt: null, canResend: false });
      pairings += 1;
    }
    expect(pairings, "anti-vacuity: pairings checked").toBe(2);
    await expectPressAgrees(r, v!, T0);
    expect(mail.sent).toHaveLength(4);
  });

  it("opened: each pairing's invite time is the stamp on file; nothing left to press; the round leaves once its window closes", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    expect(await press(r, 1, T0)).toEqual({ opened: true, invited: 4, skipped: [] });

    const v = roundOf(await view(r, at(MIN)), 1);
    expect(v.state).toBe("open");
    expect(isRoundPaired({ roundOpenedAt: v.openedAt, fixtureCount: v.pairings.length })).toBe(false);
    expect(v.press).toBe("none");
    expect(v.openedAt).toBe(T0.toISOString());
    expect(v.deadlineAt).toBe(at(DEADLINE_AFTER_MS).toISOString());
    let checked = 0;
    for (const p of v.pairings) {
      const s = await stamps(p.fixtureId);
      expect(s.white, "premise: both seats stamped").not.toBeNull();
      const latest = Math.max(s.white!.getTime(), s.black!.getTime());
      expect(p, p.fixtureId).toMatchObject({ owedSeats: 0, invitedAt: new Date(latest).toISOString(), canResend: true });
      checked += 1;
    }
    expect(checked, "anti-vacuity: pairings checked").toBe(2);
    await expectPressAgrees(r, v, at(MIN));

    expect(await view(r, at(DEADLINE_AFTER_MS + MIN)), "window closed, nobody to invite: nothing to show").toEqual([]);
  });

  it("a failed send: that seat is still to invite, the round offers it ('reinvite') — inside the round's own window", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const b2 = r.boards[1]!;
    mail.fail.add(b2.away.email);
    expect(await press(r, 1, T0)).toEqual({ opened: true, invited: 3, skipped: [{ fixtureId: b2.fixtureId, reason: "send_failed" }] });

    const v = roundOf(await view(r, at(2 * MIN)), 1);
    expect(v.press).toBe("reinvite");
    const p2 = v.pairings.find((p) => p.fixtureId === b2.fixtureId)!;
    const s = await stamps(b2.fixtureId);
    expect(s.black, "premise: the failed seat was un-stamped").toBeNull();
    expect(p2).toMatchObject({ owedSeats: 1, invitedAt: s.white!.toISOString() });
    expect(v.pairings.reduce((n, p) => n + p.owedSeats, 0), "players still to invite").toBe(1);
    // The window stays the round's: the deadline is the FIRST open's, not the press's.
    expect(v.deadlineAt).toBe(at(DEADLINE_AFTER_MS).toISOString());

    mail.fail.clear();
    const res = await expectPressAgrees(r, v, at(2 * MIN));
    expect(res).toEqual({ opened: true, invited: 1, skipped: [] });
    expect(roundOf(await view(r, at(3 * MIN)), 1).press).toBe("none");
  });

  it("a failed seat after the window closed: nothing the press can do, so the round is not offered", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    mail.fail.add(r.boards[1]!.away.email);
    await press(r, 1, T0);
    const late = at(DEADLINE_AFTER_MS + MIN);
    expect(await view(r, late)).toEqual([]);
    mail.fail.clear();
    // The server agrees: already open, that board skipped as window_closed.
    expect(await press(r, 1, late)).toEqual({
      opened: false,
      reason: "already_open",
      skipped: [{ fixtureId: r.boards[1]!.fixtureId, reason: "window_closed" }],
    });
  });

  it("every send failed: nobody was reached, so the press starts the window again ('reopen') — even past the old deadline", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    mail.fail.add(r.boards[0]!.home.email);
    mail.fail.add(r.boards[0]!.away.email);
    expect(await press(r, 1, T0)).toMatchObject({ opened: true, invited: 0 });
    const late = at(DEADLINE_AFTER_MS + MIN);
    const v = roundOf(await view(r, late), 1);
    expect(v.state).toBe("open");
    expect(v.press).toBe("reopen");
    expect(v.pairings[0]).toMatchObject({ owedSeats: 2, invitedAt: null, canResend: false });
    mail.fail.clear();
    expect(await expectPressAgrees(r, v, late)).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(roundOf(await view(r, late), 1).deadlineAt, "the window restarted at the press").toBe(
      new Date(late.getTime() + DEADLINE_AFTER_MS).toISOString(),
    );
  });

  it("a pairing that arrives AFTER the open is still invitable (no idempotency guard swallows it), and only it is owed", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, spares: 1 });
    await press(r, 1, T0);
    const late = r.spares[0]!;
    const added = await addFixture(r.owner, r.stageId, {
      home_entrant_id: late.home.entrantId,
      away_entrant_id: late.away.entrantId,
      round_no: 1,
      scheduled_at: "2026-10-01T12:10:00.000Z",
    });
    const v = roundOf(await view(r, at(MIN)), 1);
    expect(v.press).toBe("reinvite");
    const owed = v.pairings.filter((p) => p.owedSeats > 0);
    expect(owed.map((p) => [p.fixtureId, p.owedSeats])).toEqual([[added.fixture_id, 2]]);
    mail.sent.length = 0;
    expect(await expectPressAgrees(r, v, at(MIN))).toEqual({ opened: true, invited: 2, skipped: [] });
    expect(mail.sent.sort()).toEqual([late.home.email, late.away.email].sort());
  });

  it("a division that has not started: nothing to open — and the server agrees (division_not_started)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, divisionStarted: false });
    expect(await view(r, T0)).toEqual([]);
    expect(await press(r, 1, T0)).toEqual({ opened: false, reason: "division_not_started" });
  });

  it("a board decided before the open is no pairing: the list and the count are what the server invites", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [one, two] = r.boards as [(typeof r.boards)[0], (typeof r.boards)[0]];
    // The result entered by hand, through the real scoring path.
    const fs = await getFixtureState(r.owner, two.fixtureId);
    await scoreEvent(r.owner, two.fixtureId, { expected_seq: fs.last_seq, type: "core.start", payload: {} });
    await scoreEvent(r.owner, two.fixtureId, { expected_seq: fs.last_seq + 1, type: "boardgame.result", payload: { winner: two.home.entrantId } });

    const v = roundOf(await view(r, T0), 1);
    expect(v.pairings.map((p) => p.fixtureId)).toEqual([one.fixtureId]);
    const owed = v.pairings.reduce((n, p) => n + p.owedSeats, 0);
    const res = await expectPressAgrees(r, v, T0);
    expect(res).toMatchObject({ opened: true, invited: owed });
    expect(mail.sent.sort()).toEqual([one.home.email, one.away.email].sort());
  });

  it("a board whose game exists with no invite on file (the players found their room another way) owes nothing and offers no resend", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const two = r.boards[1]!;
    mail.fail.add(two.home.email);
    mail.fail.add(two.away.email);
    await press(r, 1, T0);
    expect(await stamps(two.fixtureId), "premise: nothing stamped on board 2").toEqual({ white: null, black: null });
    // The room created the game when both checked in (labelled SQL: the room's own writer is T9's, not this read's).
    await sql`
      insert into fixture_external_play
        (fixture_id, org_id, status, scheduled_at_basis, challenge_id, create_sent_at, white_side, white_lichess_id, black_lichess_id)
      values (${two.fixtureId}, ${r.orgId}, 'live', ${T0}, ${`gm-${randomUUID().slice(0, 12)}`}, ${T0}, 'home',
              ${two.home.lichessId}, ${two.away.lichessId})
      on conflict (fixture_id) do update
        set status = 'live', challenge_id = excluded.challenge_id, create_sent_at = excluded.create_sent_at,
            white_side = 'home', white_lichess_id = excluded.white_lichess_id, black_lichess_id = excluded.black_lichess_id`;
    const v = roundOf(await view(r, at(MIN)), 1);
    expect(v.pairings.find((p) => p.fixtureId === two.fixtureId)).toMatchObject({ owedSeats: 0, invitedAt: null, canResend: false });
    expect(v.press, "everyone who can be invited was").toBe("none");
    await expectPressAgrees(r, v, at(MIN));
  });

  it("a stamp counts only for the open it was written under (labelled SQL move: no product path moves a fixture between rounds)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, spares: 1 });
    const { fixture_id: b2 } = await addFixture(r.owner, r.stageId, {
      home_entrant_id: r.spares[0]!.home.entrantId,
      away_entrant_id: r.spares[0]!.away.entrantId,
      round_no: 2,
      scheduled_at: null,
    });
    await press(r, 1, T0);
    await press(r, 2, T0);
    const moved = r.boards[0]!.fixtureId;
    expect((await stamps(moved)).white, "premise: stamped under round 1's open").not.toBeNull();
    await sql`update fixtures set round_no = 2 where id = ${moved}`;
    const v = roundOf(await view(r, at(MIN)), 2);
    expect(v.pairings.map((p) => [p.fixtureId, p.owedSeats, p.invitedAt])).toEqual(
      expect.arrayContaining([[moved, 2, null]]),
    );
    expect(v.pairings.find((p) => p.fixtureId === b2)?.owedSeats).toBe(0);
    // The server asserts the same invariant, loudly.
    await expect(press(r, 2, at(MIN))).rejects.toThrow(/names open/);
  });

  it("the NEXT round only: of several paired rounds the lowest is offered; once it opens, the next one is", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, spares: 2 });
    for (const [i, roundNo] of [2, 3].entries()) {
      await addFixture(r.owner, r.stageId, {
        home_entrant_id: r.spares[i]!.home.entrantId,
        away_entrant_id: r.spares[i]!.away.entrantId,
        round_no: roundNo,
        scheduled_at: null,
      });
    }
    const before = await view(r, T0);
    expect(before.map((v) => [v.roundNo, v.state])).toEqual([[1, "paired"]]);
    await press(r, 1, T0);
    const after = await view(r, at(MIN));
    expect(after.map((v) => [v.roundNo, v.state, v.press])).toEqual([
      [1, "open", "none"],
      [2, "paired", "open"],
    ]);
    expect(roundOf(after, 2).scheduledAt, "an untimed round states no time").toBeNull();
    await expectPressAgrees(r, roundOf(after, 2), at(MIN));
  });

  // T16 fix round 1, R1 (controller ruling): opening round 2 while round 1 is still being played is ALLOWED — the
  // organiser drives, D8 never blocks — but the confirmation names what is still in play. "In play" is the rulebook's
  // still-to-be-played (scheduled / in_play) on a paired board; a decided board or a bye is not.
  it("R1: round 2's Open names round 1's games still in play — and stays offered and pressable; none once they finish", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, spares: 1, bye: true });
    await addFixture(r.owner, r.stageId, {
      home_entrant_id: r.spares[0]!.home.entrantId,
      away_entrant_id: r.spares[0]!.away.entrantId,
      round_no: 2,
      scheduled_at: null,
    });
    const decide = async (b: (typeof r.boards)[number]) => {
      const fs = await getFixtureState(r.owner, b.fixtureId);
      await scoreEvent(r.owner, b.fixtureId, { expected_seq: fs.last_seq, type: "core.start", payload: {} });
      await scoreEvent(r.owner, b.fixtureId, { expected_seq: fs.last_seq + 1, type: "boardgame.result", payload: { winner: b.home.entrantId } });
    };
    // The empty case first: before round 1 opens, round 1 is the one offered and nothing is earlier than it.
    expect((await view(r, T0)).map((v) => [v.roundNo, v.earlierInPlay])).toEqual([[1, []]]);
    await press(r, 1, T0);
    await decide(r.boards[0]!);
    const two = roundOf(await view(r, at(MIN)), 2);
    expect(two.press, "allowed: the organiser drives").toBe("open");
    expect(two.earlierInPlay, "one board of round 1 still to play; the decided one and the bye are not").toEqual([{ roundNo: 1, games: 1 }]);
    expect(roundOf(await view(r, at(MIN)), 1).earlierInPlay, "round 1 itself: nothing earlier").toEqual([]);
    await decide(r.boards[1]!);
    expect(roundOf(await view(r, at(MIN)), 2).earlierInPlay, "round 1 finished: nothing to name").toEqual([]);
    expect(await press(r, 2, at(MIN))).toMatchObject({ opened: true });
  });

  it("R1: an empty seat in an earlier round is not a game in play — only its paired boards are named", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, unpaired: true, spares: 1 });
    await addFixture(r.owner, r.stageId, {
      home_entrant_id: r.spares[0]!.home.entrantId,
      away_entrant_id: r.spares[0]!.away.entrantId,
      round_no: 2,
      scheduled_at: null,
    });
    // The press refuses a round with an empty seat (not_paired); opened by SQL to put one in an opened round.
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by, opened_at)
      values (${r.stageId}, ${r.orgId}, 1, ${r.ownerUserId}, ${T0})`;
    const two = roundOf(await view(r, at(MIN)), 2);
    expect(two.earlierInPlay, "the paired board, not the empty seat").toEqual([{ roundNo: 1, games: 1 }]);
  });

  it("Swiss: round 1 paired by the real generator is offered; the later rounds' empty shells are not", async () => {
    const s = await seedOnlineSwiss({ players: 4, rounds: 3 });
    const shells = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id = ${s.stageId} and round_no > 1 and home_entrant_id is null`;
    expect(shells[0]!.n, "premise: later rounds exist as unpaired shells").toBeGreaterThan(0);
    const rounds = await view(s, T0);
    expect(rounds.map((v) => [v.roundNo, v.state, v.pairings.length])).toEqual([[1, "paired", 2]]);
    await expectPressAgrees(s, rounds[0]!, T0);
  });
});

// ─── Timed check-in batches in the organiser's view (spec §3.2.1; capacity tests 6 [reader:open-round-view] and 12) ──────────
// Instants are T0 + batch x CHECKIN_BATCH_GAP_MS (+ DEADLINE_AFTER_MS), from the constants.
describe.skipIf(!HAS_DB)("listOpenRounds — timed batches", () => {
  const S = CHECKIN_BATCH_SIZE;
  const GAP = CHECKIN_BATCH_GAP_MS;
  const startOf = (batch: number) => at(batch * GAP);
  const closesOf = (batch: number) => at(batch * GAP + DEADLINE_AFTER_MS);

  it("[reader:open-round-view] a staggered round lists its batches - board ranges, opens-at and closes-at of EACH - and its deadline is the last batch's", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
    await press(r, 1, T0);
    const v = roundOf(await view(r, at(MIN)), 1);
    expect(v.staggered).toBe(true);
    expect(v.batches).toHaveLength(3);
    let checked = 0;
    v.batches.forEach((b, i) => {
      expect(b.offsetMs, `batch ${i} offset`).toBe(i * GAP);
      expect(b.opensAt, `batch ${i} opens`).toBe(startOf(i).toISOString());
      expect(b.closesAt, `batch ${i} closes`).toBe(closesOf(i).toISOString());
      checked += 1;
    });
    // The rows are 1 real board, 2S - 1 abandoned rows and 1 real board (seq 1..2S+1): batches of S, S and 1 by RANK.
    expect(v.batches.map((b) => [b.fromBoard, b.toBoard])).toEqual([
      [1, S],
      [S + 1, 2 * S],
      [2 * S + 1, 2 * S + 1],
    ]);
    expect(v.deadlineAt, "the round closes when its LAST batch does").toBe(closesOf(2).toISOString());
    expect(v.staggerSpanMinutes, "2 gaps").toBe(Math.ceil((2 * GAP) / MIN));
    expect(checked, "anti-vacuity: batches read").toBe(3);
  });

  it("a round that is not staggered (camera off) is one batch with no span, and its deadline is T + DEADLINE_AFTER_MS", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "off" }, 2 * S);
    await press(r, 1, T0);
    const v = roundOf(await view(r, at(MIN)), 1);
    expect([v.staggered, v.batches.length, v.staggerSpanMinutes]).toEqual([false, 1, 0]);
    expect(v.batches[0]).toMatchObject({ offsetMs: 0, opensAt: T0.toISOString(), closesAt: closesOf(0).toISOString() });
    expect(v.deadlineAt).toBe(closesOf(0).toISOString());
  });

  it("an UNOPENED round predicts what the open will store: required staggers, off does not (the organiser sees the stagger before pressing)", async () => {
    const on = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
    const off = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "off" }, 2 * S);
    const a = roundOf(await view(on, T0), 1);
    const b = roundOf(await view(off, T0), 1);
    expect([a.staggered, a.batches.length, a.openedAt]).toEqual([true, 3, null]);
    expect([b.staggered, b.batches.length, b.openedAt]).toEqual([false, 1, null]);
    expect(a.batches.every((x) => x.opensAt === null && x.closesAt === null), "nothing is scheduled before the press").toBe(true);
  });

  it("100 boards at the gap: the stagger is 9 x gap long (ten batches)", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 10 * S - 1);
    const v = roundOf(await view(r, T0), 1);
    expect(v.pairings.length, "two real boards; the rest are abandoned rows that still count in the rank").toBe(2);
    expect(v.batches.length, "a hundred rows = ten batches of ten").toBe(10);
    expect(v.staggerSpanMinutes).toBe(Math.ceil((9 * GAP) / MIN));
    expect(v.batches[9]!.offsetMs).toBe(9 * GAP);
  });

  it("a re-invite is offered while ANY owed board's own window runs, and the deadline it names is the earliest of those", async () => {
    const r = await seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "required" }, 2 * S);
    // Board 1's away seat and both of the ranked board's seats were not reached.
    mail.fail.add(r.boards[0]!.away.email).add(r.ranked.home.email).add(r.ranked.away.email);
    await press(r, 1, T0);
    const afterBatch0 = at(DEADLINE_AFTER_MS + 1);
    const mid = roundOf(await view(r, afterBatch0), 1);
    expect(mid.press, "the ranked board's window still runs").toBe("reinvite");
    expect(mid.deadlineAt, "the earliest deadline among the boards a re-invite would reach").toBe(closesOf(2).toISOString());
    // At the LAST batch's deadline every owed board's window has closed: nothing to press and nothing running, so the
    // round is not listed at all (the control offers no re-invite that openRound would answer already_open).
    expect((await view(r, closesOf(2))).filter((x) => x.roundNo === 1), "every owed board's window has closed").toEqual([]);
    expect((await view(r, new Date(closesOf(2).getTime() - 1))).filter((x) => x.roundNo === 1).map((x) => x.press), "one ms earlier").toEqual(["reinvite"]);
  });
});
