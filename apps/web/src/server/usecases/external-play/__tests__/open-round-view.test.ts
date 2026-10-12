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
import { DEADLINE_AFTER_MS } from "@/server/external-play/window";

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
import {
  seedOnlineChessRound,
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
