// MD-R23, the acceptance gate of "Match Day, all in one": what one Match Day POLL and one BOARD READ cost in SQL statements over an
// online round of 32 boards (the biggest the owner plans for: a club night of 64 players), measured on the REAL readers against the REAL
// database, never estimated. The estimate the plan carried was ~460-500 statements a poll; the numbers this prints are the answer, and the
// ceilings below are what stops the poll growing past them unnoticed.
//
// Two sizes are read so the SHAPE is known, not only the point: a poll that costs the same at 4 boards as at 32 is flat, one that adds a
// fixed number per board is linear, and the slope is what the report quotes. Every figure is a count of statements issued BY the call
// (`statementTexts()` before and after), so the seeding never counts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, statementTexts } from "@/lib/db";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { getMatchDay } from "../match-day";
import { loadMatchDayBoard } from "../external-play/arbiter";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "./_external-play-seed";
import { NOW, arrived, at, bridgeRow, openFlag, openStamp, presenceRow } from "./_match-day-online-seed";
import { stubOutboxEnv } from "./_invite-mail";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
  stubOutboxEnv();
  forgetOnlineChessFlagCache();
});

/** What the gate holds the poll to. The plan's estimate was "~460-500" statements; the first measurement said 409 at 32 boards (9.7 per extra
 *  board), because a board with no game yet read its colours by an owner-session lookup plus a fold-read transaction of its own (six
 *  statements a board); 00f2bf740e made them ride the board rows query. A ceiling at the old estimate could not have noticed that fix
 *  being undone (409 < 500), so the ceilings now sit just over what this run MEASURES after it:
 *
 *    poll, 4 boards: 106     poll, 32 boards: 180     slope: 2.64 per extra board     board read: 8 at 4 and 8 at 32
 *
 *  (The first two figures were 131 / 313 / 6.5 until the final review's M2: the OPENED round's boards that have no bridge row yet - the ones
 *  still checking in - were also read by `listOpenRounds`' per-board fold read for their colour, about six statements each; they ride the
 *  rows now, which took 96 statements off the 32-board poll. Then 125 / 217 / 3.29 until the lister share (gaps wave A, A1): the desk's
 *  per-board attentions and the online rounds each asked the held and the flagged lister, and the flagged one builds every flagged board
 *  (two side reads and a camera-policy read each, 8 boards at 32); `getMatchDay` now hands both ONE `sharedQueueReads`, which took 37
 *  statements off the 32-board poll and 19 off the 4-board one.)
 *
 *  - `POLL_CEILING_32` 190 = 180 + 10 (about 6%): a new fixed read or two in the poll fits, a per-board one does not (that is the slope's
 *    job, below); the pre-share poll, 217, is 27 over it, the pre-M2 313 is 123 over and the pre-fix 409 is 219 over.
 *  - `SLOPE_CEILING` 3.1 = 2.64 + 0.46: one more statement for every second board fits; the pre-share 3.29, the pre-M2 6.5 and the pre-fix
 *    9.7 are all over it.
 *  - `BOARD_READ_CEILING` 12 = 8 + 4: a board read is ONE board's own rows.
 *
 *  What the 180 still holds (read from the statement texts, 32 boards): 80 are the sides' names, two per board (`loadSides`, one per
 *  board and side: 64 for the round's 32 boards and 16 for the 8 flagged boards the lister builds again), 9 the camera policy (one for the
 *  round, one per flagged board), and the rest fixed reads. The flagged lister's second build of a board the round already composed is
 *  not a read two consumers share (the lister's `FlaggedBoard` is built without seats or a clock, the round's with both), so it stays. */
const POLL_CEILING_32 = 190;
const SLOPE_CEILING = 3.1;
const BOARD_READ_CEILING = 12;
/** A round that is PAIRED BUT NOT OPENED (the round between two Swiss rounds, or tomorrow's): its boards have no game, so no bridge row says who
 *  has White and the colour is the pairing card's, read from the board's fold. Read board by board (`whiteSideOf`: an owner-session mint plus a
 *  fold-read transaction, about six statements a board) it added a fixed price per board that no opened round ever shows - the busy-night seed
 *  above opens its round - and a Swiss night pays it between every two rounds, on every poll (final review, M2). Read with the board rows
 *  (`match_states.state->>'colorOfHome'`, the way the arbiter's rows do) it costs nothing per board:
 *
 *    paired round, no bridge row on any board: 75 statements at 4 boards and 75 at 32 (slope 0.00; 82 / 82 before the lister share, A1); before the change, 6.00 per board.
 *
 *  `PAIRED_SLOPE_CEILING` 1 leaves room for a statement per board and sits well under the old per-board price (a revert reads 6). */
const PAIRED_SLOPE_CEILING = 1;

/** One round of `n` boards in the mix a busy club night shows: a quarter live with both players on camera, an eighth held for the
 *  organiser, an eighth live and flagged, the rest still checking in (half of them with one player in). The states are derived from `n`,
 *  so the 4-board round is the same night in miniature. */
async function busyRound(n: number): Promise<SeedOnlineChessRoundResult & { held: string[]; flagged: string[] }> {
  const r = await seedOnlineChessRound({ fixtures: n });
  await openStamp(r, 1, at(-20));
  const quarter = Math.max(1, Math.floor(n / 4));
  const eighth = Math.max(1, Math.floor(n / 8));
  const held: string[] = [];
  const flagged: string[] = [];
  for (const [i, b] of r.boards.entries()) {
    if (i < quarter) {
      // Live, both players here with a webhook presence row each.
      await bridgeRow(b.fixtureId, r.orgId, { status: "live", moves: 12 });
      for (const side of ["home", "away"] as const) {
        const participantId = await arrived(b, r.orgId, side, at(-18), { state: "live", at: at(-1) });
        await presenceRow(b, side, participantId, { joinedAt: at(-18) });
      }
    } else if (i < quarter + eighth) {
      await bridgeRow(b.fixtureId, r.orgId, { status: "needs_organiser", reason: "mismatch", moves: 6 });
      await openFlag(r.orgId, b.fixtureId);
      await openFlag(r.orgId, b.fixtureId, { kind: "camera_lost", personId: b.home.personId, note: "camera off 95 s of 1800 s in the match" });
      held.push(b.fixtureId);
    } else if (i < quarter + 2 * eighth) {
      await bridgeRow(b.fixtureId, r.orgId, { status: "live", moves: 8 });
      await openFlag(r.orgId, b.fixtureId);
      flagged.push(b.fixtureId);
    } else if (i % 2 === 0) {
      await arrived(b, r.orgId, "home", at(-15));
    }
  }
  return { ...r, held, flagged };
}

async function statementsOf<T>(run: () => Promise<T>): Promise<{ result: T; count: number; texts: string[] }> {
  const before = statementTexts().length;
  const result = await run();
  const texts = statementTexts().slice(before) as string[];
  return { result, count: texts.length, texts };
}

describe.runIf(HAS_DB)("MD-R23: statements per Match Day poll and per board read, measured", () => {
  it("32 boards: one poll and one board read are counted, held under their measured ceilings, and the per-board slope is held too", async () => {
    const small = await busyRound(4);
    const big = await busyRound(32);
    expect(big.boards.length, "premise: 32 boards seeded").toBe(32);
    expect(small.boards.length, "premise: 4 boards seeded").toBe(4);
    const now = NOW;

    const poll = async (r: SeedOnlineChessRoundResult) => statementsOf(() => getMatchDay(r.owner, r.competitionId, now));
    // Warm-up read of each: the first call of a process pays caches (the flag's, the sport registry's) that a steady poll does not. The
    // measured read is the SECOND, which is what the shell's every-few-seconds poll costs.
    await poll(small);
    await poll(big);
    const p4 = await poll(small);
    const p32 = await poll(big);

    // Anti-vacuity: the counter is live and the polls read what was seeded.
    expect(p4.count, "the counter is live (4 boards)").toBeGreaterThan(0);
    expect(p32.count, "the counter is live (32 boards)").toBeGreaterThan(0);
    const online = (v: Awaited<ReturnType<typeof getMatchDay>>) => v.online_rounds.flatMap((x) => x.round?.boards ?? []);
    expect(online(p32.result).length, "the poll carries all 32 boards").toBe(32);
    expect(online(p4.result).length, "the poll carries all 4 boards").toBe(4);

    // One board read of the HELD board (the heaviest: flags, reason, position) at each size.
    const read = async (r: SeedOnlineChessRoundResult & { held: string[] }) => {
      const id = r.held[0]!;
      await loadMatchDayBoard(r.owner, id, { now }); // warm
      return statementsOf(() => loadMatchDayBoard(r.owner, id, { now }));
    };
    const b4 = await read(small);
    const b32 = await read(big);
    expect(b32.result.fixtureId, "the board read is the held board").toBe(big.held[0]);
    expect(b4.count, "the counter is live (board read)").toBeGreaterThan(0);

    const perBoardPoll = (p32.count - p4.count) / (32 - 4);
    const perBoardRead = (b32.count - b4.count) / (32 - 4);
    // The numbers the report quotes (a test's output is the only place they are measured, never recalled).
    console.log(
      `[MD-R23] poll: ${p4.count} statements at 4 boards, ${p32.count} at 32 (${perBoardPoll.toFixed(2)} per extra board); ` +
        `board read: ${b4.count} at 4, ${b32.count} at 32 (${perBoardRead.toFixed(2)} per extra board); ceilings ${POLL_CEILING_32} / ${SLOPE_CEILING} / ${BOARD_READ_CEILING}`,
    );
    expect(p32.count, "a 32-board poll stays at or under its measured ceiling").toBeLessThanOrEqual(POLL_CEILING_32);
    expect(perBoardPoll, "and a board added to the round adds no more than its measured statements").toBeLessThanOrEqual(SLOPE_CEILING);
    expect(b32.count, "a board read stays at or under its measured ceiling").toBeLessThanOrEqual(BOARD_READ_CEILING);
    // Shape: a board read is ONE board, so it must not grow with the round (the loader reads the board's own rows, not the round's).
    expect(b32.count - b4.count, "a board read is the same size whatever the round").toBeLessThanOrEqual(2);
  }, 600_000);

  it("a PAIRED, NOT OPENED round of 32 boards costs the poll no more per board than a few statements: its colours ride the board rows, not a fold read each (M2)", async () => {
    // seedOnlineChessRound pairs the boards and starts the division; no `openStamp` - the round is paired, not opened, and no board has a bridge row.
    const small = await seedOnlineChessRound({ fixtures: 4 });
    const big = await seedOnlineChessRound({ fixtures: 32 });
    const poll = async (r: SeedOnlineChessRoundResult) => statementsOf(() => getMatchDay(r.owner, r.competitionId, NOW));
    await poll(small);
    await poll(big);
    const p4 = await poll(small);
    const p32 = await poll(big);

    // Anti-vacuity: the polls read what was seeded - a round in the "before" phase carrying its pairings - and nothing is opened.
    const before = (v: Awaited<ReturnType<typeof getMatchDay>>) => v.online_rounds.filter((x) => x.phase === "before");
    expect(before(p4.result), "premise: one paired-not-opened round (4 boards)").toHaveLength(1);
    expect(before(p32.result), "premise: one paired-not-opened round (32 boards)").toHaveLength(1);
    expect(before(p4.result)[0]!.view?.pairings.length, "the 4-board round's pairings are on the wire").toBe(4);
    expect(before(p32.result)[0]!.view?.pairings.length, "the 32-board round's pairings are on the wire").toBe(32);
    expect(p4.count, "the counter is live").toBeGreaterThan(0);

    const slope = (p32.count - p4.count) / (32 - 4);
    console.log(`[MD-R23/M2] paired round poll: ${p4.count} statements at 4 boards, ${p32.count} at 32 (${slope.toFixed(2)} per extra board); ceiling ${PAIRED_SLOPE_CEILING}`);
    expect(slope, "a paired board adds no per-board colour read").toBeLessThanOrEqual(PAIRED_SLOPE_CEILING);
  }, 600_000);
});
