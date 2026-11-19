// Check-in capacity plan 2 Task 8 - `anyCheckinWindowOpen`, `roundWindowBoundSql`, `windowDeferralOn` (spec §6.7, owner ruling R3).
//
// "Is ANY board inside a check-in window, its grace or an extension at `now`?" is the question the sweep asks before it tears rooms
// down or reads camera evidence, and the pre-mint asks before it makes rooms: a window open means players are claiming seats, and
// every vendor call spent on housekeeping is one a player could have used. The bound is per ROUND and conservative (never a
// per-board re-derivation of `windowFor`): the round's last batch start plus `ROUND_WINDOW_TAIL_MS`.
//
// Expected values are derived from window.ts's OWN declarations (`batchCount`, `CHECKIN_BATCH_GAP_MS`, the four constants the tail
// is made of), never from the module under test. Every sweep below reports how many instants it checked and zero is a failure.
// Single-sport reason: no sport is involved - rounds and instants (the seed is the online-chess one because that is the only
// kind of board that has a round open).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { anyCheckinWindowOpen, roundWindowBoundSql, windowDeferralOn } from "../round-open";
import {
  CHECKIN_BATCH_GAP_MS,
  CHECKIN_EXTEND_MAX,
  CHECKIN_EXTEND_STEP_MS,
  DEADLINE_AFTER_MS,
  LINE_DEADLINE_GRACE_MS,
  ROUND_WINDOW_SCAN_LOOKBACK_MS,
  ROUND_WINDOW_SCAN_MAX_BOARDS,
  ROUND_WINDOW_TAIL_MS,
  batchCount,
} from "../window";
import { seedOnlineChessRound } from "../../usecases/__tests__/_external-play-seed";

const DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** The tail, summed here from the four declarations it is made of (never read back from ROUND_WINDOW_TAIL_MS). */
const TAIL = DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS + CHECKIN_EXTEND_MAX * CHECKIN_EXTEND_STEP_MS;

/** A one-board round whose stamp is written directly (the product's open stamps exactly these columns), padded with `rows` fixture
 *  rows in all: placeholders carry no entrants, but `roundWindowBoundSql` counts every fixture row of the (stage, round). */
async function roundOpenedAt(openedAt: Date, o: { rows: number; staggered: boolean }) {
  const r = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "optional" });
  const [fixture] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${r.stageId} limit 1`;
  expect(fixture, "premise: the seed made a board").toBeDefined();
  if (o.rows > 1) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      select ${r.stageId}::uuid, ${r.divisionId}::uuid, ${r.orgId}::uuid, ${r.roundNo}::int, 100 + g, 'pad-' || g, 'scheduled'
        from generate_series(1, ${o.rows - 1}::int) g`;
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${r.stageId} and round_no = ${r.roundNo}`;
  expect(n, "premise: the round has exactly the rows asked for").toBe(o.rows);
  await sql`
    insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
    values (${r.stageId}, ${r.orgId}, ${r.roundNo}, ${openedAt}, ${r.ownerUserId}, ${o.staggered})`;
  return r;
}

describe("the bound's constant tail (window.ts)", () => {
  it("ROUND_WINDOW_TAIL_MS is the deadline, the line's grace and the maximum extension, each from its own declaration", () => {
    expect(ROUND_WINDOW_TAIL_MS).toBe(TAIL);
    // Anti-vacuity: every term is a real, positive amount, so a zeroed term cannot hide in the sum.
    for (const term of [DEADLINE_AFTER_MS, LINE_DEADLINE_GRACE_MS, CHECKIN_EXTEND_MAX, CHECKIN_EXTEND_STEP_MS]) expect(term).toBeGreaterThan(0);
  });
});

describe("the scan's lookback (window.ts)", () => {
  it("ROUND_WINDOW_SCAN_LOOKBACK_MS is the tail plus the stagger of the biggest round it allows for, and covers every field the product sells (counted)", () => {
    expect(ROUND_WINDOW_SCAN_LOOKBACK_MS).toBe(TAIL + (batchCount(ROUND_WINDOW_SCAN_MAX_BOARDS) - 1) * CHECKIN_BATCH_GAP_MS);
    expect(ROUND_WINDOW_SCAN_LOOKBACK_MS, "the stagger term is a real, positive amount").toBeGreaterThan(TAIL);
    // The Pro tier's entrant limit is 256 (entitlements.ts): a round of that many rows is never past the lookback while it is open.
    let checked = 0;
    for (const rows of [1, 10, 256, 1_000]) {
      expect(ROUND_WINDOW_SCAN_LOOKBACK_MS, `${rows} rows`).toBeGreaterThanOrEqual(TAIL + (batchCount(rows) - 1) * CHECKIN_BATCH_GAP_MS);
      checked += 1;
    }
    expect(checked, "round sizes checked").toBe(4);
  });
});

describe("windowDeferralOn", () => {
  it("unset: on; \"0\": off; \"1\": on - read at call time (3 cases)", () => {
    const saved = process.env.EXTERNAL_PLAY_WINDOW_DEFER;
    let checked = 0;
    try {
      for (const [value, want] of [[undefined, true], ["0", false], ["1", true]] as const) {
        if (value === undefined) delete process.env.EXTERNAL_PLAY_WINDOW_DEFER;
        else process.env.EXTERNAL_PLAY_WINDOW_DEFER = value;
        expect(windowDeferralOn(), `EXTERNAL_PLAY_WINDOW_DEFER=${String(value)}`).toBe(want);
        checked += 1;
      }
    } finally {
      if (saved === undefined) delete process.env.EXTERNAL_PLAY_WINDOW_DEFER;
      else process.env.EXTERNAL_PLAY_WINDOW_DEFER = saved;
    }
    expect(checked, "cases checked").toBe(3);
  });
});

describe.skipIf(!DB)("anyCheckinWindowOpen", () => {
  it("the empty case first: an org that has opened no round has no window open - and an empty scope is not 'every org'", async () => {
    const quiet = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "optional" });
    expect(await anyCheckinWindowOpen(sql, new Date(), [quiet.orgId]), "no round was ever opened").toBe(false);
    // The positive pair: with a round opened a minute ago the same call answers true, and `[]` still matches nothing.
    const now = new Date();
    const busy = await roundOpenedAt(new Date(now.getTime() - 60_000), { rows: 1, staggered: false });
    expect(await anyCheckinWindowOpen(sql, now, [busy.orgId]), "positive pair: an own round opened a minute ago").toBe(true);
    expect(await anyCheckinWindowOpen(sql, now, []), "an empty scope matches nothing").toBe(false);
  });

  it("an unstaggered round: open inside the window, the grace and the extension, closed from the bound on (instants counted)", async () => {
    const opened = new Date("2026-11-18T10:00:00.000Z");
    const r = await roundOpenedAt(opened, { rows: 1, staggered: false });
    const at = (ms: number) => new Date(opened.getTime() + ms);
    const cases: [string, Date, boolean][] = [
      ["inside the window", at(60_000), true],
      ["at the deadline (the grace begins)", at(DEADLINE_AFTER_MS), true],
      ["inside the line's grace", at(DEADLINE_AFTER_MS + 60_000), true],
      ["at the cap (the extensions' room begins)", at(DEADLINE_AFTER_MS + LINE_DEADLINE_GRACE_MS), true],
      ["one ms before the bound", at(TAIL - 1), true],
      ["at the bound", at(TAIL), false],
      ["an hour past it", at(TAIL + 60 * 60_000), false],
    ];
    for (const [why, now, want] of cases) expect(await anyCheckinWindowOpen(sql, now, [r.orgId]), why).toBe(want);
    expect(cases.length, "instants checked").toBe(7);
  });

  it("a staggered round extends the bound by the batch gaps: 1, 10, 11, 20, 21 and 25 rows against the rulebook's batchCount (counted)", async () => {
    let checked = 0;
    for (const rows of [1, 10, 11, 20, 21, 25]) {
      const opened = new Date("2026-11-18T10:00:00.000Z");
      const r = await roundOpenedAt(opened, { rows, staggered: true });
      const lastBatchStart = opened.getTime() + (batchCount(rows) - 1) * CHECKIN_BATCH_GAP_MS;
      const bound = lastBatchStart + TAIL;
      expect(await anyCheckinWindowOpen(sql, new Date(bound - 1), [r.orgId]), `${rows} rows: 1 ms before the bound`).toBe(true);
      expect(await anyCheckinWindowOpen(sql, new Date(bound), [r.orgId]), `${rows} rows: at the bound`).toBe(false);
      checked += 1;
    }
    expect(checked, "round sizes checked").toBe(6);
  });

  it("the scan is bounded to opens recent enough to be in a window: the cut is exactly `opened_at > now - lookback`, and the lookback must carry the stagger term (the seam names the lookback)", async () => {
    // 25 rows staggered: three batches, so the window is open until opened + 2 gaps + the tail - and the round is that much older than a
    // round that is not staggered when it closes.
    const opened = new Date("2026-11-18T10:00:00.000Z");
    const r = await roundOpenedAt(opened, { rows: 25, staggered: true });
    const lastOpen = new Date(opened.getTime() + (batchCount(25) - 1) * CHECKIN_BATCH_GAP_MS + TAIL - 1);
    const age = lastOpen.getTime() - opened.getTime();
    expect(age, "premise: the round is older than the bare tail, and still open").toBe(TAIL + 2 * CHECKIN_BATCH_GAP_MS - 1);
    const cases: [string, number | undefined, boolean][] = [
      ["the production lookback", undefined, true],
      ["a lookback one ms longer than the round's age", age + 1, true],
      ["a lookback exactly the round's age: the cut is strict", age, false],
      ["a lookback of the bare tail, which has no stagger term: the open round is missed", TAIL, false],
      ["a lookback of an hour", 60 * 60_000, true],
    ];
    for (const [why, lookback, want] of cases) {
      expect(await anyCheckinWindowOpen(sql, lastOpen, [r.orgId], lookback), why).toBe(want);
    }
    expect(cases.length, "cases checked").toBe(5);
  });

  it("an UNSTAGGERED round of 25 rows does not extend (its flag was stored at the open): its bound is the open's own", async () => {
    const opened = new Date("2026-11-18T10:00:00.000Z");
    const r = await roundOpenedAt(opened, { rows: 25, staggered: false });
    expect(batchCount(25), "premise: 25 rows would have been three batches").toBe(3);
    expect(await anyCheckinWindowOpen(sql, new Date(opened.getTime() + TAIL - 1), [r.orgId])).toBe(true);
    expect(await anyCheckinWindowOpen(sql, new Date(opened.getTime() + TAIL), [r.orgId])).toBe(false);
  });

  it("scoped to its orgs: another org's open round is not seen; unscoped sees both (the scope is a test seam, production passes none)", async () => {
    const now = new Date();
    const mine = await seedOnlineChessRound({ fixtures: 1, cameraPolicy: "optional" });
    const theirs = await roundOpenedAt(new Date(now.getTime() - 60_000), { rows: 1, staggered: false });
    expect(await anyCheckinWindowOpen(sql, now, [mine.orgId]), "my org opened nothing").toBe(false);
    expect(await anyCheckinWindowOpen(sql, now, [theirs.orgId]), "their org's round is open").toBe(true);
    expect(await anyCheckinWindowOpen(sql, now, [mine.orgId, theirs.orgId]), "either org").toBe(true);
    expect(await anyCheckinWindowOpen(sql, now), "unscoped: platform-wide, so theirs is seen").toBe(true);
  });

  it("roundWindowBoundSql, selected on its own, is the round's last batch start plus the tail (21 rows, staggered: three batches)", async () => {
    const opened = new Date("2026-11-18T10:00:00.000Z");
    const r = await roundOpenedAt(opened, { rows: 21, staggered: true });
    const [row] = await sql<{ bound: Date }[]>`
      select ${roundWindowBoundSql(sql)} as bound from stage_round_opens o where o.stage_id = ${r.stageId} and o.round_no = ${r.roundNo}`;
    expect(row!.bound.getTime()).toBe(opened.getTime() + (batchCount(21) - 1) * CHECKIN_BATCH_GAP_MS + TAIL);
  });
});
