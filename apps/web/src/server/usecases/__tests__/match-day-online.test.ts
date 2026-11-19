// Match Day online (Task 2): the view carries the online chess rounds. `readOnlineRounds` (server/usecases/match-day-online.ts) is the
// producer of `MatchDayView.online_rounds`; `getMatchDay` places it, drops what it lists from `playing_no_court`, and gates it behind
// MATCH_DAY_ONLINE. Spec docs/superpowers/specs/2026-11-05-match-day-all-in-one-design.md section 4 and 5.2; owner O1 (a cancelled board is
// listed only while it has an open flag), O2 (the held and flagged boards come from the two listers, nowhere else).
//
// Chess-only by construction (online play exists only for `boardgame`, guard.ts); the one test that varies the sport is the registry
// sweep at the end, which proves every other sport is left out.
//
// Setup is the product's own writers wherever one reaches the state (`openRound` for the link hold, `closeExternalPlayFlags` for the
// settle) and the rows a writer would leave where none does without a network (`_match-day-online-seed.ts` names which). Every expected
// value is a seed value or a rule's own word: a board's number is the fixture's `seq_in_round`, a round's key is `stageId:roundNo`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, statementTexts } from "@/lib/db";
import type { ArbiterBoard } from "@/lib/arbiter-view";
import type { MatchDayBoardRow, MatchDayOnlineRound } from "@/lib/match-day/types";
import { builtinModules } from "@seazn/engine/sports";
import { stubOutboxEnv } from "./_invite-mail";

// The real open (the link-hold case) invites by mail: nothing here may reach the network.
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", () => ({
  deliver: () => Promise.resolve({ ok: false as const, reason: "http" as const, status: 422, errorName: "validation_error", detail: "refused" }),
}));
// The club's answer, wrapped so a test can count how often the read asks for it (the flag's own 60 s cache would hide a second ask from the
// PostHog mock below); every call is the real one.
vi.mock("../external-play/online-chess-flag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../external-play/online-chess-flag")>();
  return { ...actual, onlineChessOffered: vi.fn(actual.onlineChessOffered) };
});
// The club's online-chess flag: the override (vitest.config) is on; a test that needs the flag asked takes it off and answers here.
const flag = vi.hoisted(() => ({ isServerFeatureEnabled: vi.fn<(f: string, id: string, o?: { orgId?: string; fallback?: boolean }) => Promise<boolean>>() }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: (f: string, id: string, o?: { orgId?: string; fallback?: boolean }) => flag.isServerFeatureEnabled(f, id, o) };
});

import { GET as matchDayRoute } from "@/app/api/v1/competitions/[id]/match-day/route";
import { MatchDayView } from "@/server/api-v1/schemas";
import { createApiKey } from "../api-keys";
import { forgetOnlineChessFlagCache, onlineChessOffered } from "../external-play/online-chess-flag";
import { closeExternalPlayFlags } from "../external-play/flags";
import { loadArbiterRound, loadBoardsByIds } from "../external-play/arbiter";
import { listOpenRounds } from "../external-play/open-round-view";
import { openRound } from "../external-play/open-round";
import { getMatchDay } from "../match-day";
import { readOnlineRounds } from "../match-day-online";
import { createDivision } from "../divisions";
import { createStages } from "../stages";
import { putScheduleSettings, startDivision } from "../schedule";
import { seedLinkedPair, seedOnlineChessRound, type SeedOnlineChessRoundResult, type SeedRoundBoard } from "./_external-play-seed";
import { ORG_TZ, seedDay, T0, at as t0at } from "./_match-day-seed";
import {
  MIN,
  NOW,
  addRound,
  addStage,
  arrived,
  at,
  bridgeRow,
  openFlag,
  openStamp,
  presenceRow,
  seedOnlineDivisionIn,
  setFixtureStatus,
} from "./_match-day-online-seed";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "");
  stubOutboxEnv();
  forgetOnlineChessFlagCache();
});
afterEach(() => vi.unstubAllEnvs());

const idsOf = (boards: readonly Pick<ArbiterBoard, "fixtureId">[]): string[] => boards.map((b) => b.fixtureId);
const roundBoards = (row: MatchDayOnlineRound): ArbiterBoard[] => row.round?.boards ?? [];
const boardOf = (row: MatchDayOnlineRound, fixtureId: string): ArbiterBoard => {
  const b = roundBoards(row).find((x) => x.fixtureId === fixtureId);
  if (!b) throw new Error(`test: board ${fixtureId} is not in the round's boards`);
  return b;
};
/** A board's hold reason, as `readOnlineRounds` stamps it on a board of either list. */
const holdOf = (b: ArbiterBoard): unknown => (b as MatchDayBoardRow).hold_reason;
/** How many times the board is listed in the row, across `round.boards` and `needs_decision`. */
const timesListed = (row: MatchDayOnlineRound, fixtureId: string): number =>
  idsOf(roundBoards(row)).filter((i) => i === fixtureId).length + idsOf(row.needs_decision).filter((i) => i === fixtureId).length;

/** One round of `n` boards, the round opened at `openedMinutes` (relative to NOW). The boards are left as the open leaves them: no bridge
 *  row, so every board is checking in. */
async function openedRound(n: number, openedMinutes = -5): Promise<SeedOnlineChessRoundResult> {
  const r = await seedOnlineChessRound({ fixtures: n });
  await openStamp(r, 1, at(openedMinutes));
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("readOnlineRounds - the empty case first", () => {
  it("a competition with no online division answers [] and never reads the sealed round opens", async () => {
    const day = await seedDay();
    const before = statementTexts().length;
    expect(await readOnlineRounds(day.auth, day.comp.id, NOW)).toEqual([]);
    const issued = statementTexts().slice(before);
    expect(issued.length, "premise: the read did run (the counter is live)").toBeGreaterThan(0);
    expect(issued.filter((t) => t.includes("stage_round_opens")).length, "no statement names the sealed table").toBe(0);
  });

  it("with the flag on, getMatchDay of that competition is the flag-off view with online_rounds [] - nothing else moves", async () => {
    const day = await seedDay();
    const now = new Date(T0);
    vi.stubEnv("MATCH_DAY_ONLINE", "1");
    const on = await getMatchDay(day.auth, day.comp.id, now);
    vi.stubEnv("MATCH_DAY_ONLINE", undefined);
    const off = await getMatchDay(day.auth, day.comp.id, now);
    expect(on.online_rounds).toEqual([]);
    expect(off.online_rounds).toEqual([]);
    expect(on).toEqual(off);
    expect(on.courts.length, "premise: the view is the in-hall competition's, not an empty shell").toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("readOnlineRounds - a round in check-in", () => {
  it("one row: phase checkin, the boards in board order with their flag count and no flag card, nothing owed to a decision", async () => {
    const r = await openedRound(3);
    const flagged = r.boards[1]!;
    await openFlag(r.orgId, flagged.fixtureId);
    await openFlag(r.orgId, flagged.fixtureId, { openedAt: at(-1) });
    const [division] = await sql<{ name: string; slug: string }[]>`select name, slug from divisions where id = ${r.divisionId}`;

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      key: `${r.stageId}:1`,
      division_id: r.divisionId,
      division_name: division!.name,
      division_slug: division!.slug,
      stage_id: r.stageId,
      stage_name: "RR",
      round_no: 1,
      multi_stage: false,
      phase: "checkin",
      offered: true,
      tz: "UTC",
      own_boards: 0,
    });
    expect(row.needs_decision).toEqual([]);
    expect(row.view?.state, "the open-round reader's view of the same round").toBe("open");
    expect(row.view).toMatchObject({ stageId: r.stageId, roundNo: 1 });
    // The boards: the seed's, in the seed's board order (`seq_in_round`), each in check-in.
    expect(idsOf(roundBoards(row))).toEqual(r.boards.map((b) => b.fixtureId));
    expect(roundBoards(row).map((b) => b.boardNo)).toEqual([1, 2, 3]);
    expect(roundBoards(row).map((b) => b.state.kind)).toEqual(["checking_in", "checking_in", "checking_in"]);
    // The list read counts the flags and builds none: `flagCount` is the open flags on file (two on board 2), `flags` is [].
    expect(roundBoards(row).map((b) => b.flagCount)).toEqual([0, 2, 0]);
    expect(roundBoards(row).flatMap((b) => b.flags)).toEqual([]);
    // The round carries what the round panel's rules read: seats for the boards in check-in, and the round's own facts.
    expect(roundBoards(row).every((b) => b.seats !== null)).toBe(true);
    expect(row.round).toMatchObject({ stageId: r.stageId, roundNo: 1, ownBoards: 0 });
  });

  it("the club not offered online chess: offered is false, the rows are still there, and the club's answer is asked ONCE for a whole competition", async () => {
    const day = await seedDay();
    const a = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Blitz A", fixtures: 1 });
    const b = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Blitz B", fixtures: 1 });
    await openStamp({ stageId: a.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! }, 1, t0at(-5));
    await openStamp({ stageId: b.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! }, 1, t0at(-5));
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    flag.isServerFeatureEnabled.mockReset().mockResolvedValue(false);
    vi.mocked(onlineChessOffered).mockClear(); // the seeding above asked it too (the division create is gated)

    const rows = await readOnlineRounds(day.auth, day.comp.id, new Date(T0));

    expect(rows.map((x) => x.division_id)).toEqual([a.divisionId, b.divisionId]);
    expect(rows.map((x) => x.offered)).toEqual([false, false]);
    expect(onlineChessOffered, "the club's answer is asked once for the whole call, not once per division").toHaveBeenCalledTimes(1);
    expect(flag.isServerFeatureEnabled).toHaveBeenCalledWith("online-chess", day.auth.userId, { orgId: day.orgId, fallback: false });
    // The same call with the flag on says so.
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    expect((await readOnlineRounds(day.auth, day.comp.id, new Date(T0))).map((x) => x.offered)).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("readOnlineRounds - the row source: a round in play is never dropped, a round over drops off", () => {
  it("every window closed and the open-round reader has no view for the round: still one row, view null, phase playing", async () => {
    const r = await openedRound(2, -8 * 60);
    for (const b of r.boards) {
      await bridgeRow(b.fixtureId, r.orgId, { status: "live", moves: 10 });
      await setFixtureStatus(b.fixtureId, "in_play");
    }
    // The premise, read through the real reader: the round has no view (its windows closed and nobody is owed an invite).
    expect(await listOpenRounds(r.owner, r.divisionId, { now: NOW })).toEqual([]);

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `${r.stageId}:1`, phase: "playing", view: null, offered: true });
    expect(roundBoards(rows[0]!).map((b) => b.state.kind)).toEqual(["live", "live"]);
  });

  it("a round opened two days ago whose boards are all decided and none held: no row; the same round opened today: one row (the sequence)", async () => {
    const r = await openedRound(2, -2 * 24 * 60);
    for (const b of r.boards) {
      await bridgeRow(b.fixtureId, r.orgId, { status: "finished", moves: 10 });
      await setFixtureStatus(b.fixtureId, "decided");
    }
    expect(await readOnlineRounds(r.owner, r.competitionId, NOW), "over for two days, nothing held").toEqual([]);
    // Opened today (an hour ago): the same round is the day's.
    await sql`update stage_round_opens set opened_at = ${at(-60)} where stage_id = ${r.stageId}`;
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `${r.stageId}:1`, phase: "playing" });
  });

  it("a round over for days that still holds a board is listed (a held board is the organiser's whatever the day)", async () => {
    const r = await openedRound(2, -3 * 24 * 60);
    await bridgeRow(r.boards[0]!.fixtureId, r.orgId, { status: "finished", moves: 10 });
    await setFixtureStatus(r.boards[0]!.fixtureId, "decided");
    await bridgeRow(r.boards[1]!.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_both" });
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows).toHaveLength(1);
    expect(holdOf(boardOf(rows[0]!, r.boards[1]!.fixtureId))).toBe("no_show_both");
  });

  it("a division that has not started: one row, phase not_started, no view and no round; once started and unopened its paired round is a before row", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2, divisionStarted: false });
    const before = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ key: `${r.stageId}:1`, stage_id: r.stageId, phase: "not_started", view: null, round: null, needs_decision: [], own_boards: 0 });
    await startDivision(r.owner, r.divisionId);
    const after = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ phase: "before", round: null });
    expect(after[0]!.view?.state).toBe("paired");
  });

  it("a stage with rounds 1 and 2 both opened is one row (round 2); round 1's own view is not a row", async () => {
    const r = await openedRound(2, -8);
    const second = await addRound(r, 2, r.boards.map((b) => ({ home: b.home, away: b.away })));
    await openStamp(r, 2, at(-5));
    // The premise, through the real reader: both rounds have a view, both `open` - a view that is not `paired` is never a row of its own.
    const views = await listOpenRounds(r.owner, r.divisionId, { now: NOW });
    expect(views.map((v) => `${v.roundNo}:${v.state}`).sort()).toEqual(["1:open", "2:open"]);

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: `${r.stageId}:2`, round_no: 2, multi_stage: false });
    expect(idsOf(roundBoards(rows[0]!))).toEqual(second);
  });

  it("a second stage with a paired round is a second row: round null, phase before, the open-round view; multi_stage on both", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1, divisionStarted: false });
    const pair = await seedLinkedPair(r.owner, r.divisionId);
    const s2 = await addStage(r, "Playoff", pair);
    await startDivision(r.owner, r.divisionId);
    await openStamp(r, 1, at(-5));

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows.map((x) => x.key)).toEqual([`${r.stageId}:1`, `${s2.stageId}:1`]);
    expect(rows.map((x) => x.multi_stage)).toEqual([true, true]);
    expect(rows[0]).toMatchObject({ stage_name: "RR", phase: "checkin" });
    expect(rows[0]!.round).not.toBeNull();
    expect(rows[1]).toMatchObject({ stage_id: s2.stageId, stage_name: "Playoff", round_no: 1, phase: "before", round: null });
    expect(rows[1]!.view).toMatchObject({ state: "paired", stageId: s2.stageId, roundNo: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("readOnlineRounds - the day a round is listed on", () => {
  it("a round opened yesterday stays while a board's check-in window is open now, and leaves once it has run out (a second call)", async () => {
    const r = await seedOnlineChessRound({ fixtures: 1 });
    await openStamp(r, 1, new Date("2026-11-19T23:55:00.000Z"));
    const during = new Date("2026-11-20T00:02:00.000Z");
    const after = new Date("2026-11-20T00:30:00.000Z");

    const open = await readOnlineRounds(r.owner, r.competitionId, during);
    expect(open, "the round opened yesterday, a window open now").toHaveLength(1);
    const checkin = roundBoards(open[0]!)[0]!.checkin!;
    expect(Date.parse(checkin.opensAt), "premise: the board's window has opened").toBeLessThanOrEqual(during.getTime());
    expect(Date.parse(checkin.deadlineAt), "premise: and has not run out").toBeGreaterThan(during.getTime());
    expect(roundBoards(open[0]!)[0]!.state.kind, "the board is still in check-in at both reads").toBe("checking_in");

    expect(Date.parse(checkin.deadlineAt), "premise: by the second call the window has run out").toBeLessThan(after.getTime());
    expect(await readOnlineRounds(r.owner, r.competitionId, after), "yesterday's round, no window open, nothing moving").toEqual([]);
  });

  it("a round opened days ago with a board playing is still listed (a game in play is the day's whenever the round was opened)", async () => {
    const r = await openedRound(2, -3 * 24 * 60);
    await bridgeRow(r.boards[0]!.fixtureId, r.orgId, { status: "live", moves: 10 });
    await setFixtureStatus(r.boards[0]!.fixtureId, "in_play");
    await bridgeRow(r.boards[1]!.fixtureId, r.orgId, { status: "finished", moves: 10 });
    await setFixtureStatus(r.boards[1]!.fixtureId, "decided");
    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);
    expect(rows).toHaveLength(1);
    expect(roundBoards(rows[0]!).map((b) => b.state.kind)).toEqual(["live", "result"]);
  });

  it("the day is the division's own: a round opened 18 hours ago is today in Tokyo and yesterday in Amsterdam, and each row prints its own zone", async () => {
    const day = await seedDay(); // the organisation's zone is Europe/Amsterdam (ORG_TZ)
    const tokyo = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Tokyo", fixtures: 1 });
    const inherited = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Inherited", fixtures: 1 });
    await putScheduleSettings(day.auth, tokyo.divisionId, {
      config: { startAt: "2026-11-01T00:00:00.000Z", matchMinutes: 30, gapMinutes: 0, courts: [], perEntrantMinRest: 0, blackouts: [], sessionWindows: [] },
      tz: "Asia/Tokyo",
    });
    const owner = (stageId: string) => ({ stageId, orgId: day.orgId, ownerUserId: day.auth.userId! });
    for (const d of [tokyo, inherited]) {
      // Every board decided and none held: only the day can keep the round on the list.
      await bridgeRow(d.boards[0]!.fixtureId, day.orgId, { status: "finished", moves: 10 });
      await setFixtureStatus(d.boards[0]!.fixtureId, "decided");
      // T0 is 10:00 UTC on 7 November: 18 hours earlier is 16:00 UTC on the 6th - after Tokyo's midnight (15:00 UTC), before Amsterdam's (23:00 UTC).
      await openStamp(owner(d.stageId), 1, t0at(-18 * 60));
    }

    const rows = await readOnlineRounds(day.auth, day.comp.id, new Date(T0));

    expect(rows.map((x) => x.division_id), "Tokyo's day holds the round; Amsterdam's does not").toEqual([tokyo.divisionId]);
    expect(rows[0]!.tz).toBe("Asia/Tokyo");
    // The inherited division, the same round opened inside ITS day, prints the organisation's zone.
    await sql`update stage_round_opens set opened_at = ${t0at(-60)} where stage_id = ${inherited.stageId}`;
    const both = await readOnlineRounds(day.auth, day.comp.id, new Date(T0));
    expect(both.map((x) => [x.division_id, x.tz])).toEqual([
      [tokyo.divisionId, "Asia/Tokyo"],
      [inherited.divisionId, ORG_TZ],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("readOnlineRounds - the held and flagged boards (owner O1, O2): each board is listed once", () => {
  it("a held board of the listed round is in round.boards only, with its reason - and a link hold from the REAL open reads lichess_unlinked", async () => {
    const r = await seedOnlineChessRound({ fixtures: 2 });
    // The player of board 1's away seat has no Lichess account when the organiser opens: the real open holds the board, invites the other.
    const away = r.boards[0]!.away;
    await sql`delete from user_external_accounts where user_id = ${away.userId} and provider = 'lichess'`;
    const opened = await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: at(-1) });
    expect(opened, "premise: the real open stamped the round").toMatchObject({ opened: true });
    const [held] = await sql<{ status: string; reason: string | null; challenge: string | null }[]>`
      select status, needs_reason as reason, challenge_id as challenge from fixture_external_play where fixture_id = ${r.boards[0]!.fixtureId}`;
    expect(held, "premise: the open wrote the hold row").toEqual({ status: "needs_organiser", reason: "lichess_unlinked", challenge: null });

    const [row] = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(row).toBeDefined();
    const b0 = boardOf(row!, r.boards[0]!.fixtureId);
    expect(b0.state.kind).toBe("on_hold");
    expect(holdOf(b0)).toBe("lichess_unlinked");
    expect(timesListed(row!, r.boards[0]!.fixtureId), "listed once").toBe(1);
    expect(row!.needs_decision, "not a decision of an earlier round").toEqual([]);
    // The board that was invited is not held: its reason is null (the stamp is on every board of the list).
    expect(holdOf(boardOf(row!, r.boards[1]!.fixtureId))).toBeNull();
  });

  it("a flagged board of round 1 while round 2 is listed is in needs_decision with its round and stage, never in round.boards; a held one too", async () => {
    const r = await openedRound(2, -90);
    const second = await addRound(r, 2, r.boards.map((b) => ({ home: b.home, away: b.away })));
    await openStamp(r, 2, at(-5));
    const [flaggedBoard, heldBoard] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await bridgeRow(flaggedBoard.fixtureId, r.orgId, { status: "finished", moves: 10 });
    await setFixtureStatus(flaggedBoard.fixtureId, "decided");
    await openFlag(r.orgId, flaggedBoard.fixtureId);
    await bridgeRow(heldBoard.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_white" });

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.round_no).toBe(2);
    expect(idsOf(roundBoards(row))).toEqual(second);
    expect(idsOf(row.needs_decision).sort()).toEqual([flaggedBoard.fixtureId, heldBoard.fixtureId].sort());
    expect(row.needs_decision.every((b) => b.round_no === 1 && b.stage_id === r.stageId)).toBe(true);
    const f = row.needs_decision.find((b) => b.fixtureId === flaggedBoard.fixtureId)!;
    expect(f.state.kind).toBe("result");
    expect(f.flagCount).toBe(1);
    expect(f.flags).toEqual([]);
    expect(f.hold_reason ?? null, "a flagged board is not held").toBeNull();
    const h = row.needs_decision.find((b) => b.fixtureId === heldBoard.fixtureId)!;
    expect(h.state.kind).toBe("on_hold");
    expect(h.hold_reason).toBe("no_show_white");
    for (const id of [flaggedBoard.fixtureId, heldBoard.fixtureId]) expect(timesListed(row, id), `board ${id} listed once`).toBe(1);
  });

  it("the sequence: a board that stops being held leaves needs_decision on the next read (a second call), and a result written moves its word", async () => {
    const r = await openedRound(2, -90);
    await addRound(r, 2, r.boards.map((b) => ({ home: b.home, away: b.away })));
    await openStamp(r, 2, at(-5));
    const held = r.boards[0]!;
    await bridgeRow(held.fixtureId, r.orgId, { status: "needs_organiser", reason: "aborted" });
    const first = (await readOnlineRounds(r.owner, r.competitionId, NOW))[0]!;
    expect(idsOf(first.needs_decision)).toEqual([held.fixtureId]);
    // The organiser decides it: the board's fixture is settled (a result), so it is no longer waiting for anyone.
    await setFixtureStatus(held.fixtureId, "decided");
    const second = (await readOnlineRounds(r.owner, r.competitionId, NOW))[0]!;
    expect(second.needs_decision, "no longer held: gone from the next read").toEqual([]);
    expect(first.needs_decision.length - second.needs_decision.length, "down by exactly one").toBe(1);
  });

  it("O1: a cancelled board with an open flag is in needs_decision (state cancelled); once its flags are settled through the product it is nowhere - the sequence", async () => {
    const r = await openedRound(3, -5);
    const [live, cancelledFlagged, cancelledSettled] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await setFixtureStatus(cancelledFlagged.fixtureId, "cancelled");
    await setFixtureStatus(cancelledSettled.fixtureId, "cancelled");
    const flagId = await openFlag(r.orgId, cancelledFlagged.fixtureId);
    const settledFlag = await openFlag(r.orgId, cancelledSettled.fixtureId);
    await closeExternalPlayFlags(r.owner, cancelledSettled.fixtureId, [settledFlag]);

    const listed = (await readOnlineRounds(r.owner, r.competitionId, NOW))[0]!;

    expect(idsOf(roundBoards(listed)), "a cancelled board is never a board of the round").toEqual([live.fixtureId]);
    expect(idsOf(listed.needs_decision), "only the one with an open flag").toEqual([cancelledFlagged.fixtureId]);
    expect(listed.needs_decision[0]!.state.kind).toBe("cancelled");
    expect(timesListed(listed, cancelledSettled.fixtureId), "settled: nowhere").toBe(0);

    // Settle the other one through the product's "let the game go on" door: the next read drops it, by exactly one.
    await closeExternalPlayFlags(r.owner, cancelledFlagged.fixtureId, [flagId]);
    const after = (await readOnlineRounds(r.owner, r.competitionId, NOW))[0]!;
    expect(after.needs_decision).toEqual([]);
    expect(listed.needs_decision.length - after.needs_decision.length).toBe(1);
    expect(timesListed(after, cancelledFlagged.fixtureId)).toBe(0);
  });

  it("a board the viewer plays on is left out of both lists and counted in own_boards", async () => {
    const r = await openedRound(2, -5);
    const mine = r.boards[0]!;
    await bridgeRow(mine.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_black" });
    // The organiser is the white player of board 1: the loader's rule (C1) leaves it out and counts it.
    const [org] = await sql<{ personId: string }[]>`select person_id as "personId" from entrant_members where entrant_id = ${mine.home.entrantId}`;
    await sql`update persons set user_id = ${r.ownerUserId} where id = ${org!.personId}`;

    const [row] = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(idsOf(roundBoards(row!)), "the viewer's own board is not listed").toEqual([r.boards[1]!.fixtureId]);
    expect(row!.needs_decision).toEqual([]);
    expect(row!.own_boards).toBe(1);
  });
});

describe.runIf(HAS_DB)("readOnlineRounds - a board of an earlier round the viewer plays on", () => {
  it("a held board of round 1 that the viewer plays on is not in needs_decision and is counted once, beside round 2's own board of the same player", async () => {
    const r = await openedRound(2, -90);
    const [mine, other] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    // Round 2 pairs the same entrants again (a league's players meet each round): the viewer's board is in BOTH rounds.
    const second = await addRound(r, 2, [
      { home: mine.home, away: mine.away },
      { home: other.home, away: other.away },
    ]);
    await openStamp(r, 2, at(-5));
    await bridgeRow(mine.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_black" });
    await bridgeRow(other.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_white" });
    const [org] = await sql<{ personId: string }[]>`select person_id as "personId" from entrant_members where entrant_id = ${mine.home.entrantId}`;
    await sql`update persons set user_id = ${r.ownerUserId} where id = ${org!.personId}`;

    const [row] = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(row!.round_no).toBe(2);
    expect(idsOf(roundBoards(row!)), "round 2: the viewer's board is left out").toEqual([second[1]]);
    expect(idsOf(row!.needs_decision), "round 1: only the board the viewer does not play on").toEqual([other.fixtureId]);
    expect(row!.own_boards, "one own board in round 2 (the loader's count) and one held in round 1").toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("the loader's seams (arbiter.ts): count mode and loadBoardsByIds", () => {
  it("MD-R1: a board's presence, camera and joinable ride the board in the list read, exactly as the arbiter loader builds them", async () => {
    const r = await openedRound(2, -5);
    const [a, b] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await bridgeRow(a.fixtureId, r.orgId, { status: "live", moves: 10 });
    await setFixtureStatus(a.fixtureId, "in_play");
    const home = await arrived(a, r.orgId, "home", at(-4));
    await arrived(a, r.orgId, "away", at(-4));
    await presenceRow(a, "home", home, { joinedAt: at(-3) });
    await bridgeRow(b.fixtureId, r.orgId, { status: "needs_organiser", reason: "no_show_white" });
    await arrived(b, r.orgId, "away", at(-4));
    await presenceRow(b, "away", (await sql<{ p: string }[]>`select participant_id as p from fixture_video_participants where fixture_id = ${b.fixtureId} and side = 'away'`)[0]!.p, { joinedAt: at(-3) });

    const [row] = await readOnlineRounds(r.owner, r.competitionId, NOW);
    const full = await loadArbiterRound(r.owner, r.divisionId, { now: NOW });

    // The same board through the arbiter loader (full flags): its sides are the list read's, field for field.
    const listedA = boardOf(row!, a.fixtureId);
    const loaderA = full!.boards.find((x) => x.fixtureId === a.fixtureId)!;
    expect(listedA.sides).toEqual(loaderA.sides);
    expect(listedA.sides.home.presence.present, "the home player is in the room").toBe(true);
    expect(listedA.sides.home.joinable, "an open side a player arrived on").toBe(true);
    expect(listedA.sides.away.presence.present, "the away player never joined the room").toBe(false);
    // A held board in the same round, from the same read.
    const listedB = boardOf(row!, b.fixtureId);
    expect(listedB.sides).toEqual(full!.boards.find((x) => x.fixtureId === b.fixtureId)!.sides);
    expect(listedB.sides.away.presence.present).toBe(true);
    // And the loader of needs_decision's boards builds the same sides: the held board read by id.
    const [byId] = await loadBoardsByIds(r.owner, r.divisionId, [b.fixtureId], { now: NOW, flags: "count" });
    expect(byId!.sides).toEqual(listedB.sides);
    expect(byId).toMatchObject({ stage_id: r.stageId, round_no: 1, fixtureId: b.fixtureId });
  });

  it("flags 'count': the count is the open flags, flags is [], and no guard-fault statement runs; 'full' builds the card and runs it", async () => {
    const r = await openedRound(1, -5);
    const board = r.boards[0]!;
    await bridgeRow(board.fixtureId, r.orgId, { status: "live", moves: 10 });
    await setFixtureStatus(board.fixtureId, "in_play");
    await openFlag(r.orgId, board.fixtureId, { kind: "camera_connection_problems", personId: board.home.personId });
    await openFlag(r.orgId, board.fixtureId);
    const guardTexts = (from: number) => statementTexts().slice(from).filter((t) => t.includes("fixture_video_guard_faults")).length;

    let from = statementTexts().length;
    const count = await loadArbiterRound(r.owner, r.divisionId, { now: NOW, flags: "count" });
    expect(count!.boards[0]!.flags).toEqual([]);
    expect(count!.boards[0]!.flagCount).toBe(2);
    expect(guardTexts(from), "count mode reads no guard faults").toBe(0);

    from = statementTexts().length;
    const full = await loadArbiterRound(r.owner, r.divisionId, { now: NOW });
    expect(full!.boards[0]!.flags.map((f) => f.kind).sort()).toEqual(["camera_connection_problems", "out_of_band_play"]);
    expect(full!.boards[0]!.flagCount, "the default builds the cards and counts them").toBe(2);
    expect(guardTexts(from), "premise: the default does read them (the counter sees the table)").toBeGreaterThan(0);
  });

  it("loadBoardsByIds: no ids reads nothing; another division's board is not read; a cancelled board without an open flag is not read (O1)", async () => {
    const r = await openedRound(3, -5);
    const other = await openedRound(1, -5);
    const [a, cancelledNoFlag, cancelledFlagged] = r.boards as [SeedRoundBoard, SeedRoundBoard, SeedRoundBoard];
    await setFixtureStatus(cancelledNoFlag.fixtureId, "cancelled");
    await setFixtureStatus(cancelledFlagged.fixtureId, "cancelled");
    await openFlag(r.orgId, cancelledFlagged.fixtureId);
    const opts = { now: NOW, flags: "count" } as const;

    const before = statementTexts().length;
    expect(await loadBoardsByIds(r.owner, r.divisionId, [], opts)).toEqual([]);
    expect(statementTexts().length - before, "no ids, no statement").toBe(0);

    const read = await loadBoardsByIds(r.owner, r.divisionId, [a.fixtureId, cancelledNoFlag.fixtureId, cancelledFlagged.fixtureId, other.boards[0]!.fixtureId], opts);
    expect(idsOf(read).sort(), "the division's boards: the live one and the flagged cancelled one only").toEqual([a.fixtureId, cancelledFlagged.fixtureId].sort());
    expect(read.find((b) => b.fixtureId === cancelledFlagged.fixtureId)!.state.kind).toBe("cancelled");
  });

  it("loadBoardsByIds leaves out a board the viewer plays on", async () => {
    const r = await openedRound(2, -5);
    const [org] = await sql<{ personId: string }[]>`select person_id as "personId" from entrant_members where entrant_id = ${r.boards[0]!.home.entrantId}`;
    await sql`update persons set user_id = ${r.ownerUserId} where id = ${org!.personId}`;
    const read = await loadBoardsByIds(r.owner, r.divisionId, idsOf(r.boards), { now: NOW, flags: "count" });
    expect(idsOf(read)).toEqual([r.boards[1]!.fixtureId]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe.runIf(HAS_DB)("getMatchDay - the view places the rounds and lists each board once (MATCH_DAY_ONLINE)", () => {
  async function mixedDay() {
    const day = await seedDay();
    // One in-hall match in play on no court (an untimed bracket match: the no-court list's own kind of row).
    const inHall = day.comp.fixtures[0]!.id;
    await sql`update fixtures set status = 'in_play', court_id = null, scheduled_at = ${t0at(-30)} where id = ${inHall}`;
    const online = await seedOnlineDivisionIn(day.auth, day.comp.id, { name: "Rapid", fixtures: 2 });
    await openStamp({ stageId: online.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! }, 1, t0at(-8 * 60));
    for (const b of online.boards) {
      await bridgeRow(b.fixtureId, day.orgId, { status: "live", moves: 10 }, t0at(-30));
      await setFixtureStatus(b.fixtureId, "in_play");
    }
    return { day, inHall, online };
  }

  it("an online board in play on no court is under its round and not in playing_no_court; the in-hall no-court match stays; the flag off keeps today's list", async () => {
    const { day, inHall, online } = await mixedDay();
    const now = new Date(T0);

    vi.stubEnv("MATCH_DAY_ONLINE", undefined);
    const off = await getMatchDay(day.auth, day.comp.id, now);
    expect(off.online_rounds).toEqual([]);
    expect(off.playing_no_court.map((m) => m.id).sort(), "flag off: the online boards are still no-court rows, today's behaviour").toEqual([inHall, ...idsOf(online.boards)].sort());

    vi.stubEnv("MATCH_DAY_ONLINE", "1");
    const on = await getMatchDay(day.auth, day.comp.id, now);
    expect(on.online_rounds).toHaveLength(1);
    expect(idsOf(roundBoards(on.online_rounds[0]!)).sort()).toEqual(idsOf(online.boards).sort());
    // The count against the seed: one in-hall match in play on no court, and the two online boards moved under their round.
    expect(on.playing_no_court.map((m) => m.id)).toEqual([inHall]);
    expect(off.playing_no_court.length - on.playing_no_court.length).toBe(online.boards.length);
    // Every board is listed once across the whole view (design 5.2).
    const everywhere = [...on.playing_no_court.map((m) => m.id), ...on.courts.flatMap((c) => (c.current ? [c.current.id] : [])), ...idsOf(roundBoards(on.online_rounds[0]!))];
    expect(new Set(everywhere).size).toBe(everywhere.length);
  });

  it("a held board of an EARLIER round that is still in play on no court is listed under needs_decision and is no no-court row; a live board no row lists stays one", async () => {
    const { day, inHall, online } = await mixedDay();
    const [held, live] = online.boards as [SeedRoundBoard, SeedRoundBoard];
    // Round 2 opens now with its own boards; round 1 (opened 8 hours ago) keeps two boards in play: one the arbiter holds (a tie-break owed),
    // one live. The held one reaches the page through needs_decision; the live one is on no row at all.
    await addRound({ stageId: online.stageId, divisionId: online.divisionId, orgId: day.orgId }, 2, online.boards.map((b) => ({ home: b.home, away: b.away })));
    await openStamp({ stageId: online.stageId, orgId: day.orgId, ownerUserId: day.auth.userId! }, 2, t0at(-5));
    await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'tiebreak_owed' where fixture_id = ${held.fixtureId}`;
    vi.stubEnv("MATCH_DAY_ONLINE", "1");

    const view = await getMatchDay(day.auth, day.comp.id, new Date(T0));

    const row = view.online_rounds[0]!;
    expect(row.round_no).toBe(2);
    expect(idsOf(row.needs_decision), "the held board of round 1").toEqual([held.fixtureId]);
    expect(view.playing_no_court.map((m) => m.id).sort(), "the held one is listed once (under its round); the live one no row lists stays a no-court row").toEqual([inHall, live.fixtureId].sort());
  });

  it("a second poll after a board's result is written: the board moves from live to result, the row stays while a board is held", async () => {
    const { day, online } = await mixedDay();
    vi.stubEnv("MATCH_DAY_ONLINE", "1");
    const now = new Date(T0);
    const first = (await getMatchDay(day.auth, day.comp.id, now)).online_rounds[0]!;
    expect(roundBoards(first).map((b) => b.state.kind)).toEqual(["live", "live"]);
    await setFixtureStatus(online.boards[0]!.fixtureId, "decided");
    await sql`update fixture_external_play set status = 'finished' where fixture_id = ${online.boards[0]!.fixtureId}`;
    await sql`update fixture_external_play set status = 'needs_organiser', needs_reason = 'aborted' where fixture_id = ${online.boards[1]!.fixtureId}`;
    const second = (await getMatchDay(day.auth, day.comp.id, now)).online_rounds[0]!;
    expect(roundBoards(second).map((b) => b.state.kind)).toEqual(["result", "on_hold"]);
    expect(second.key).toBe(first.key);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The seam, producer to consumer: a round built by the product's own writers (the real open holds a board for a missing link) and the
// rows a player's room leaves (arrival, presence, camera), read through getMatchDay AND the v1 poll route - the route's zod parse is the
// consumer, and it strips what it does not declare. What must reach the wire: the hold reason, and each side's presence, camera, joinable.
describe.runIf(HAS_DB)("the wire: online_rounds through the v1 poll route's schema", () => {
  const real = (minutes: number): Date => new Date(Date.now() + minutes * MIN);

  it("a link-held board (real open) and a board with live presence and camera: hold_reason, presence, camera and joinable survive the parse", async () => {
    vi.stubEnv("MATCH_DAY_ONLINE", "1");
    const r = await seedOnlineChessRound({ fixtures: 2 });
    const [held, here] = r.boards as [SeedRoundBoard, SeedRoundBoard];
    await sql`delete from user_external_accounts where user_id = ${held.away.userId} and provider = 'lichess'`;
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: real(-2) }), "premise: the real open").toMatchObject({ opened: true });
    // The second board's home player has come: room, player, a counted check-in, a live peer and a live camera report.
    const home = await arrived(here, r.orgId, "home", real(-1.5), { state: "live", at: real(-1) });
    await presenceRow(here, "home", home, { joinedAt: real(-1.5) });

    const usecase = (await getMatchDay(r.owner, r.competitionId)).online_rounds;
    expect(usecase, "online rounds read by the usecase").toHaveLength(1);

    const secret = (await createApiKey(r.owner, { name: "match day online wire", scopes: ["read"] })).secret;
    const res = await matchDayRoute(
      new Request(`https://test.local/api/v1/competitions/${r.competitionId}/match-day`, { headers: { authorization: `Bearer ${secret}` } }),
      { params: Promise.resolve({ id: r.competitionId }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown };
    const wire = MatchDayView.parse(body.data).online_rounds;
    expect(wire, "online_rounds survives the parse (a plain z.object strips an undeclared key)").toHaveLength(usecase.length);

    const wireBoards = (wire[0]!.round as { boards: (ArbiterBoard & { hold_reason?: unknown })[] }).boards;
    const wHeld = wireBoards.find((b) => b.fixtureId === held.fixtureId)!;
    const wHere = wireBoards.find((b) => b.fixtureId === here.fixtureId)!;
    expect(wHeld.state.kind).toBe("on_hold");
    expect(wHeld.hold_reason, "hold_reason on the wire").toBe("lichess_unlinked");
    expect(wHere.hold_reason ?? null).toBeNull();
    expect(wHere.sides.home.presence.present, "presence on the wire").toBe(true);
    expect(wHere.sides.home.camera.state, "camera on the wire").toBe("live");
    expect(wHere.sides.home.joinable, "joinable on the wire").toBe(true);
    expect(wHere.sides.away.joinable).toBe(false);
    // And the wire's board IS the usecase's, JSON for JSON (the schema neither dropped a field nor invented one).
    const usecaseBoards = (usecase[0]!.round as { boards: ArbiterBoard[] }).boards;
    expect(wireBoards).toEqual(JSON.parse(JSON.stringify(usecaseBoards)));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The sport registry: online play is a chess-only door, and a division of ANY other sport is left out - whatever its stored config says.
describe.runIf(HAS_DB)("readOnlineRounds - every other sport in the registry is left out", () => {
  it("a division of each registry sport but boardgame, even with onlinePlay stored as lichess, with an opened round: no row; boardgame's is the one row", async () => {
    const r = await openedRound(1, -5);
    const keys = builtinModules.map((m) => m.key);
    expect(keys, "the registry names boardgame (the one online sport) and others").toContain("boardgame");
    let swept = 0;
    for (const key of keys.filter((k) => k !== "boardgame")) {
      const [variant] = await sql<{ key: string }[]>`select key from sport_variants where sport_key = ${key} order by is_system desc, key limit 1`;
      expect(variant, `a system variant of ${key}`).toBeDefined();
      const division = await createDivision(r.owner, r.competitionId, { name: `Other ${key}`, sport_key: key, variant_key: variant!.key, config: {} });
      // A stored `lichess` on a sport that cannot play online is possible only below the doors; the predicate must still refuse it.
      await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${division.id}`;
      const [stage] = await createStages(r.owner, division.id, { seq: 1, kind: "league", name: `S ${key}`, config: {} });
      await openStamp(r, 1, at(-5), stage!.id);
      swept++;
    }
    expect(swept, "sports swept (the registry minus boardgame)").toBe(keys.length - 1);
    expect(swept, "anti-vacuity: at least one other sport").toBeGreaterThan(0);

    const rows = await readOnlineRounds(r.owner, r.competitionId, NOW);

    expect(rows.map((x) => x.division_id), "only the chess division").toEqual([r.divisionId]);
  });
});
