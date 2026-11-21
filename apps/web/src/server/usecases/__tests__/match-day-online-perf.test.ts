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

/** The estimate MD-R23 carries and the ceiling the poll is held to: the upper end of "~460-500". */
const ESTIMATE_CEILING = 500;

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
  it("32 boards: one poll and one board read are counted, held under the estimate, and the per-board slope is known", async () => {
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
        `board read: ${b4.count} at 4, ${b32.count} at 32 (${perBoardRead.toFixed(2)} per extra board); estimate ${ESTIMATE_CEILING}`,
    );
    expect(p32.count, "a 32-board poll stays at or under the plan's estimate").toBeLessThanOrEqual(ESTIMATE_CEILING);
    expect(b32.count, "a board read stays at or under the plan's estimate").toBeLessThanOrEqual(ESTIMATE_CEILING);
    // Shape: a board read is ONE board, so it must not grow with the round (the loader reads the board's own rows, not the round's).
    expect(b32.count - b4.count, "a board read is the same size whatever the round").toBeLessThanOrEqual(2);
  }, 600_000);
});
