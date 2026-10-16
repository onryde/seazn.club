// Capacity tests 2 and 7 (spec §8.1; §3.2.1): the gap between check-in batches is READ from the constant, at call time, by
// every reader - and the seam is the module export.
//
// `window.ts` is replaced (vi.doMock) by the real module with ONE difference: a different CHECKIN_BATCH_GAP_MS, and a
// `boardAnchor` that spaces its batches by it. Every reader below is then imported AFTER the mock (a fresh module registry),
// so each one that reaches a board's window through `boardAnchor` follows the new gap, and one that carried a gap of its own
// (a literal copied into a reader) would not. A reader is driven through its REAL entry and judged by what it DOES at an
// instant that is inside the board's window under the mocked gap and outside it under the default - never by a number the
// test reads back from the code under test.
//
// Single-sport by construction: online play exists only for `boardgame` (the registry sweep is in external-play-batches.test.ts).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import {
  CHECKIN_BATCH_GAP_MS as DEFAULT_GAP,
  CHECKIN_BATCH_SIZE,
  DEADLINE_AFTER_MS,
  boardAnchor as realBoardAnchor,
} from "@/server/external-play/window";
import { seedOnlineChessRoundWithRankedBoard } from "./_external-play-seed";
import { configureRealtimeKit, fakeRealtimeKit } from "./_external-play-rtk-fake";

const HAS_DB = !!process.env.DATABASE_URL;
const WINDOW = "@/server/external-play/window";
const MIN = 60_000;

/** The gap the mock installs: half the starting one (the load re-run's candidate, spec §3.2.1), so a reader that kept the
 *  default is a minute-scale wrong, not a rounding one. */
const MOCK_GAP = DEFAULT_GAP / 2;

const mail = vi.hoisted(() => ({
  sent: [] as { to: string; deadlineLabel: string; opensLabel: string | undefined; locale: string }[],
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExternalPlayInviteEmail: vi.fn(
      async (to: string, args: Parameters<typeof actual.sendExternalPlayInviteEmail>[1], locale: string) => {
        mail.sent.push({ to, deadlineLabel: args.deadlineLabel, opensLabel: args.opensLabel, locale });
        return true;
      },
    ),
  };
});

const lichess = vi.hoisted(() => ({
  createChallengeToUser: vi.fn(),
  acceptChallenge: vi.fn(),
  listOutgoingChallenges: vi.fn(),
  listOngoingGames: vi.fn(),
  cancelChallenge: vi.fn(),
  exportGameMeta: vi.fn(),
}));
vi.mock("@/server/external-play/lichess/board-api", () => lichess);

/** Install the mocked window.ts and import the readers fresh. `gap` null ⇒ no mock (the default module), for the pair. */
async function readersWith(gap: number | null) {
  vi.resetModules();
  vi.doUnmock(WINDOW);
  if (gap !== null) {
    // The real module is read FIRST and the factory is synchronous: an async factory racing the readers' own imports
    // let a reader or two bind the real module (seen as a flaky 1-in-3 on the invite and view cases).
    const actual = await vi.importActual<typeof import("@/server/external-play/window")>(WINDOW);
    vi.doMock(WINDOW, () => ({
      ...actual,
      CHECKIN_BATCH_GAP_MS: gap,
      boardAnchor: (openedAt: Date, rank: number, staggered: boolean) => {
        const real = actual.boardAnchor(openedAt, rank, staggered);
        // Spaced by THIS gap; the batch itself (floor(rank / size)) is the real module's.
        return { ...real, at: new Date(openedAt.getTime() + real.batch * gap) };
      },
    }));
  }
  // One at a time: the module graph is built in a fixed order, under the mock.
  const { seatPlayer } = await import("../external-play/preflight");
  const { readRoom } = await import("../external-play/room");
  const { sweepExternalPlay } = await import("../external-play/sweep");
  const { openRound } = await import("../external-play/open-round");
  const { listOpenRounds } = await import("../external-play/open-round-view");
  return { seatPlayer, readRoom, sweepExternalPlay, openRound, listOpenRounds };
}

beforeEach(() => {
  mail.sent.length = 0;
  // No RealtimeKit credentials outside the one test that injects a fake: a reader that reached the vendor would throw
  // `unconfigured` rather than call out.
});
afterEach(() => {
  vi.doUnmock(WINDOW);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe("the gap between batches is read from the constant (capacity test 2)", () => {
  it("premise: the mock's gap differs from the default, by more than the batch-2 probe's slack", () => {
    expect(MOCK_GAP).not.toBe(DEFAULT_GAP);
    expect(2 * DEFAULT_GAP - 2 * MOCK_GAP, "batch 2's start moves by this much").toBeGreaterThan(MIN / 2);
  });
});

describe.skipIf(!HAS_DB)("every reader follows the mocked gap (capacity tests 2 and 7)", () => {
  const S = CHECKIN_BATCH_SIZE;
  const T = new Date("2026-10-01T12:00:30.000Z");
  const startOf = (batch: number, gap: number) => new Date(T.getTime() + batch * gap);
  const seed = () => seedOnlineChessRoundWithRankedBoard({ roundNo: 1, cameraPolicy: "optional" }, 2 * S);
  const label = (at: Date, locale: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(at);

  it("[seat] a claim at T + 2 x gap is refused under the DEFAULT gap (batch 2 opens later) and seated under the mocked one - and the room agrees", async () => {
    // The seat reaches the vendor only through the injected fake (it answers the fake's own fetch); the credentials are what
    // the adapter requires before it will take one.
    configureRealtimeKit();
    let checked = 0;
    for (const gap of [null, MOCK_GAP] as const) {
      const g = gap ?? DEFAULT_GAP;
      const r = await seed();
      const { seatPlayer, readRoom, openRound } = await readersWith(gap);
      await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T });
      // The probe instant: where the mocked gap puts batch 2's start. Under the default gap it is still before it.
      const probe = startOf(2, MOCK_GAP);
      const seat = await seatPlayer(
        { fixtureId: r.ranked.fixtureId, personId: r.ranked.home.personId },
        { now: probe, video: fakeRealtimeKit().video },
      );
      const room = await readRoom({ kind: "session", userId: r.ranked.home.userId }, r.ranked.fixtureId, { now: probe });
      if (gap === null) {
        expect(seat, "default gap: batch 2 has not opened").toEqual({ seated: false, reason: "checkin_not_open" });
        expect(room.phase).toBe("before");
      } else {
        expect(seat.seated, "mocked gap: batch 2 is open").toBe(true);
        expect(room.phase).toBe("open");
      }
      expect(room.opensAt, `the room names the window the gap puts it at (gap ${g})`).toBe(startOf(2, g).toISOString());
      expect(room.deadline).toBe(new Date(startOf(2, g).getTime() + DEADLINE_AFTER_MS).toISOString());
      checked += 1;
    }
    expect(checked, "anti-vacuity: two gaps driven").toBe(2);
  });

  it("[invite] the mail names the BOARD's start and deadline from the gap in force", async () => {
    let checked = 0;
    for (const gap of [null, MOCK_GAP] as const) {
      const g = gap ?? DEFAULT_GAP;
      mail.sent.length = 0;
      const r = await seed();
      const { openRound } = await readersWith(gap);
      await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T });
      for (const p of [r.ranked.home, r.ranked.away]) {
        const m = mail.sent.find((x) => x.to === p.email);
        expect(m, `${p.email} was mailed`).toBeDefined();
        expect(m!.opensLabel, `gap ${g}: opens`).toBe(label(startOf(2, g), m!.locale));
        expect(m!.deadlineLabel, `gap ${g}: deadline`).toBe(label(new Date(startOf(2, g).getTime() + DEADLINE_AFTER_MS), m!.locale));
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: two seats x two gaps").toBe(4);
  });

  it("[view] the organiser's batches are spaced by the gap in force", async () => {
    let checked = 0;
    for (const gap of [null, MOCK_GAP] as const) {
      const g = gap ?? DEFAULT_GAP;
      const r = await seed();
      const { openRound, listOpenRounds } = await readersWith(gap);
      await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T });
      const v = (await listOpenRounds(r.owner, r.divisionId, { now: new Date(T.getTime() + MIN) })).find((x) => x.roundNo === 1)!;
      expect(v.batches.map((b) => b.offsetMs), `gap ${g}`).toEqual([0, g, 2 * g]);
      expect(v.batches[2]!.opensAt).toBe(startOf(2, g).toISOString());
      expect(v.staggerSpanMinutes).toBe(Math.ceil((2 * g) / MIN));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("test 7 [sweep]: three minutes past T + DEADLINE_AFTER_MS the batch-2 board is forfeited at a 60 s gap (deadline T + 12 min) and NOT at the 120 s one (T + 14 min)", async () => {
    // g = the gap; the board's deadline is T + 2g + DEADLINE_AFTER_MS. `now` is three minutes past the ROUND's.
    const now = new Date(T.getTime() + DEADLINE_AFTER_MS + 3 * MIN);
    let checked = 0;
    for (const gap of [null, MOCK_GAP] as const) {
      const g = gap ?? DEFAULT_GAP;
      const r = await seed();
      const { sweepExternalPlay, openRound } = await readersWith(gap);
      await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: T });
      // The ranked board's home player came in (inside its window), the away player is the no-show.
      await sql`
        insert into fixture_availability (fixture_id, person_id, org_id, status, checked_in_at)
        values (${r.ranked.fixtureId}, ${r.ranked.home.personId}, ${r.orgId}, 'in', ${new Date(startOf(2, g).getTime() + 1_000)})`;
      const deadline = startOf(2, g).getTime() + DEADLINE_AFTER_MS;
      const forfeited = async () =>
        (await sql<{ status: string }[]>`select status from fixtures where id = ${r.ranked.fixtureId}`)[0]!.status === "forfeited";
      const report = await sweepExternalPlay({ now, orgIds: [r.orgId] });
      // The first board of the round (batch 0, nobody came) is forfeited at this `now` under either gap: the sweep ran.
      const first = (await sql<{ status: string }[]>`select status from fixtures where id = ${r.boards[0]!.fixtureId}`)[0]!.status;
      expect(first, `gap ${g}: premise - the sweep forfeited batch 0 at this now`).toBe("forfeited");
      if (gap === null) {
        expect(now.getTime(), "premise: the default gap's deadline is after `now`").toBeLessThan(deadline);
        expect(await forfeited(), "120 s gap: not forfeited").toBe(false);
      } else {
        expect(now.getTime(), "premise: the mocked gap's deadline is before `now`").toBeGreaterThan(deadline);
        expect(await forfeited(), "60 s gap: forfeited - the sweep read the gap").toBe(true);
        expect(report.noShows, "both forfeits counted").toBe(2);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: two gaps driven").toBe(2);
  });

  it("the module the readers import is the one mocked: boardAnchor in force spaces batch 2 by MOCK_GAP, and the real one by the default", async () => {
    await readersWith(MOCK_GAP);
    const mocked = await import("@/server/external-play/window");
    expect(mocked.CHECKIN_BATCH_GAP_MS).toBe(MOCK_GAP);
    expect(mocked.boardAnchor(T, 2 * S, true).at.getTime() - T.getTime()).toBe(2 * MOCK_GAP);
    expect(realBoardAnchor(T, 2 * S, true).at.getTime() - T.getTime(), "the statically imported real one").toBe(2 * DEFAULT_GAP);
  });
});
