// Match Day online, Task 5 - `roundOpensToday` (round-open.ts): the sealed half of Match Day's "is this board today's" rule.
//
// `stage_round_opens` has no `app_user` grant, so the tenant statement that counts today's matches cannot read it; this read is made
// first, on the pool's own privileges, and handed over. It is a SUPERSET by design (the count decides which board of which division a
// row makes today's - match-day-home-today.test.ts drives that end to end), so what it owes is narrow and is pinned here directly,
// because every one of its guards has a twin in the count's own statement and would otherwise be an equivalent mutant there:
//   - it is scoped to ONE organisation (the privileged role sees every tenant);
//   - it is cut at the lookback: an open older than two days cannot be today's by the day or by a live window;
//   - an older round is still returned while a game is on file (a challenge on a bridge row that is not `finished`);
//   - `windowLive` is the window bound (`roundWindowBoundSql`) against `now`.
// Expected values are rulebook values (a division's day is at most 25 hours; the tail is summed here from its four declarations),
// never read back from the code under test. Every sweep reports how many instants it checked and zero is a failure.
// Single-sport reason: no sport is involved - rounds and instants (the seed is the online-chess one because that is the only kind of
// board that has a round open).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ROUND_OPENS_TODAY_LOOKBACK_MS, roundOpensToday } from "../round-open";
import { CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS, DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS, ROUND_WINDOW_SCAN_LOOKBACK_MS } from "../window";
import { seedOnlineChessRound, type SeedOnlineChessRoundResult } from "../../usecases/__tests__/_external-play-seed";
import { bridgeRow } from "../../usecases/__tests__/_match-day-online-seed";

const DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const HOUR = 60 * 60_000;
const NOW = new Date("2026-11-19T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
/** The tail, summed here from the four declarations it is made of (never read back from ROUND_WINDOW_TAIL_MS). */
const TAIL = DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;

/** A round (`boards` boards, no planned time) whose open is stamped at `openedAt`, as `openRound` stamps it. */
async function roundOpenedAt(openedAt: Date, boards = 1): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures: boards, scheduledAt: null });
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
    values (${r.stageId}, ${r.orgId}, ${r.roundNo}, ${openedAt}, ${r.ownerUserId})`;
  return r;
}
const keyOf = (r: Pick<SeedOnlineChessRoundResult, "stageId" | "roundNo">): string => `${r.stageId}:${r.roundNo}`;
const read = async (r: Pick<SeedOnlineChessRoundResult, "orgId">, now = NOW) => (await roundOpensToday(sql, r.orgId, now)).map((o) => ({ key: `${o.stageId}:${o.roundNo}`, ...o }));

describe.skipIf(!DB)("roundOpensToday", () => {
  it("the empty case first: an organisation with no round opened reads nothing, twice", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, scheduledAt: null }); // paired, never opened
    expect(await read(r)).toEqual([]);
    expect(await read(r)).toEqual([]);
  });

  it("is scoped to the organisation it is asked for: another club's open, in the same instant, is never returned", async () => {
    const mine = await roundOpenedAt(ago(HOUR));
    const theirs = await roundOpenedAt(ago(HOUR));
    expect(mine.orgId, "premise: two organisations").not.toBe(theirs.orgId);
    let checked = 0;
    for (const [own, foreign] of [[mine, theirs], [theirs, mine]] as const) {
      const rows = await read(own);
      expect(rows.map((x) => x.key), `${own.orgId}: only its own round`).toEqual([keyOf(own)]);
      expect(rows.map((x) => x.key)).not.toContain(keyOf(foreign));
      checked++;
    }
    expect(checked, "organisations checked").toBe(2);
  });

  it("reads an open of the last two days and not an older one: 47 hours back is in, 49 hours back is out - and a division's day never reaches back that far", async () => {
    // The rulebook: a division's calendar day that contains `now` began less than 25 hours before it (a clock change makes a day 25 hours
    // long at most), so no open older than that can be "opened today", and a window is over long before. The cut sits well past both.
    const inside = await roundOpenedAt(ago(47 * HOUR));
    const outside = await roundOpenedAt(ago(49 * HOUR));
    expect((await read(inside)).map((x) => x.key)).toEqual([keyOf(inside)]);
    expect(await read(outside), "49 hours back is cut").toEqual([]);
    expect(ROUND_OPENS_TODAY_LOOKBACK_MS, "the cut is longer than a day (25h) and than the window scan's own lookback").toBeGreaterThan(25 * HOUR);
    expect(ROUND_OPENS_TODAY_LOOKBACK_MS).toBeGreaterThanOrEqual(ROUND_WINDOW_SCAN_LOOKBACK_MS);
  });

  it("an older round is still returned while a game is on file, and not once every game is over: a finished game, a hold and an uninvited board keep nothing", async () => {
    const old = ago(10 * 24 * HOUR);
    const r = await roundOpenedAt(old, 4);
    const [live, finished, hold, pending] = r.boards.map((b) => b.fixtureId) as [string, string, string, string];
    await bridgeRow(finished, r.orgId, { status: "finished", moves: 30 });
    await bridgeRow(hold, r.orgId, { status: "needs_organiser", reason: "lichess_unlinked", hold: true }); // no challenge: no game on file
    await bridgeRow(pending, r.orgId, { status: "pending" }); // invited; no game yet
    expect(await read(r), "no game is on file: an open ten days old is cut").toEqual([]);

    await bridgeRow(live, r.orgId, { status: "live", moves: 6 });
    const rows = await read(r);
    expect(rows.map((x) => x.key), "a game on file keeps its round, however old").toEqual([keyOf(r)]);
    expect(rows[0]!.openedAt.getTime()).toBe(old.getTime());
    expect(rows[0]!.windowLive, "ten days past its window").toBe(false);

    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${live}`;
    expect(await read(r), "its last game is over: the round goes").toEqual([]);
  });

  it("windowLive is the round's bound against now: live one second before it, over at it (3 boards, one batch: the open is the last batch start)", async () => {
    const opened = ago(2 * HOUR);
    const r = await roundOpenedAt(opened, 3);
    const bound = opened.getTime() + TAIL;
    const cases: [string, Date, boolean][] = [
      ["just opened", new Date(opened.getTime() + 1_000), true],
      ["one second before the bound", new Date(bound - 1_000), true],
      ["at the bound", new Date(bound), false],
      ["one second past it", new Date(bound + 1_000), false],
    ];
    let checked = 0;
    for (const [label, now, live] of cases) {
      const rows = await read(r, now);
      expect(rows.map((x) => x.key), label).toEqual([keyOf(r)]);
      expect(rows[0]!.windowLive, label).toBe(live);
      checked++;
    }
    expect(checked, "instants checked").toBe(cases.length);
  });
});
