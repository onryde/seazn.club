// Check-in capacity, plan 2 task 4 - the pre-mint pass (spec 2026-11-05 §11, owner rulings R3 and 2026-11-17 (2)).
//
// The job makes ROOMS, and only rooms, for every board of an UNOPENED round in an online, camera-on division, nearest round
// first, so the first claim of a round finds its room waiting instead of paying for it inside the check-in window. It never
// adopts a room, never makes a participant, never touches a board whose round is open.
//
// Driven through the REAL adapter against the e2e RealtimeKit fixture server (e2e/realtimekit-fixture-server.ts), whose
// `calls` count what the vendor was actually asked. Expected values come from the rulings and from the engine's own
// declarations (`FIXTURE_STATUSES`, `effectivePolicy`, `divisionScoringClosed`), never from the module under test. Every
// sweep reports how many items it checked and zero checked is a failure (TEST-STRATEGY.md).
//
// Chess-only (single-sport reason): online play is `onlinePlay = 'lichess'` on `boardgame`; no other sport has an online
// board (guard.ts `d.sport_key = 'boardgame'`), so there is no sport axis to sweep.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { divisionScoringClosed } from "@/lib/division-phase";
import { isSwissByeShellExtKey, SWISS_BYE_SHELL_EXT_KEY_SQL_PATTERN } from "@/lib/swiss-shell";
import { ROUND_WINDOW_TAIL_MS } from "@/server/external-play/window";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { effectivePolicy, type CameraPolicy } from "@/server/external-play/camera-policy";
import { endMeeting, ensureMeeting } from "@/server/external-play/video/realtimekit";
import { REALTIMEKIT_FIXTURE_ENV, startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../../../../../e2e/realtimekit-fixture-server";
import { unpairSwissRound } from "../../stages";
import { frozenCompetitionIds } from "../../entitlement-freeze";
import { openRound } from "../open-round";
import { seatPlayer } from "../preflight";
import {
  PREMINT_CALL_INTERVAL_MS,
  PREMINT_CALLS_PER_PASS,
  PREMINT_FAILURES_BEFORE_BREAK,
  PREMINT_LOCK,
  PREMINT_PASS_BUDGET_MS,
  premintBoardLeftWhere,
  premintBoardWhere,
  premintBudget,
  premintCandidates,
  premintExternalPlay,
  type PremintCandidate,
  type PremintDeps,
} from "../premint";
import {
  seedOnlineChessRound,
  seedOnlineSwiss,
  seedOwner,
  type SeedOnlineChessRoundOpts,
  type SeedOnlineChessRoundResult,
} from "../../__tests__/_external-play-seed";
import { seedSecondOnlineRound } from "../../__tests__/_second-online-round-seed";

// MD-R20: the freeze read, switchable per org. It is the REAL `frozenCompetitionIds` unless an org is named here, in which case it rejects
// as a failing database read would; every other test in this file reads the real one.
const freezeRead = vi.hoisted(() => ({ failOrgs: new Set<string>() }));
vi.mock("../../entitlement-freeze", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlement-freeze")>();
  return {
    ...actual,
    frozenCompetitionIds: async (orgId: string) => {
      if (freezeRead.failOrgs.has(orgId)) throw new Error("the freeze read failed (test)");
      return actual.frozenCompetitionIds(orgId);
    },
  };
});

const DB = !!process.env.DATABASE_URL;
const MIN = 60_000;
const HOUR = 60 * MIN;

// The invite mail seam of the one test that opens a round (_invite-mail.ts): the invite is rendered, queued on the outbox and
// sent after commit through the outbox's network seam, which is replaced here. `fail` names recipients the provider refuses.
const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(async () => {
  await fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  vi.stubEnv("EXTERNAL_PLAY_PREMINT", "1");
  mail.sent.length = 0;
  mail.fail.clear();
  freezeRead.failOrgs.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── seeds and readers ───────────────────────────────────────────────────────────────────────────────────────────────

/** A STARTED division with `fixtures` paired boards in an unopened round 1, camera `optional` unless said otherwise. */
const seedRound = (fixtures: number, over: Partial<SeedOnlineChessRoundOpts> = {}) =>
  seedOnlineChessRound({ fixtures, cameraPolicy: "optional", ...over });
type Round = SeedOnlineChessRoundResult;
const ids = (r: Round) => r.boards.map((b) => b.fixtureId);

const unseat = (fixtureIds: string[]) =>
  sql`update fixtures set home_entrant_id = null, away_entrant_id = null where id in ${sql(fixtureIds)}`;
const reseat = async (r: Round) => {
  for (const b of r.boards) {
    await sql`update fixtures set home_entrant_id = ${b.home.entrantId}, away_entrant_id = ${b.away.entrantId} where id = ${b.fixtureId}`;
  }
};

const rowsOf = (orgIds: string[]) => premintCandidates(orgIds);
const key = (c: Pick<PremintCandidate, "fixtureId" | "side">) => `${c.fixtureId}/${c.side}`;
const keysOf = (rows: PremintCandidate[]) => rows.map(key);
const bothSides = (fixtureIds: string[]) => fixtureIds.flatMap((id) => [`${id}/away`, `${id}/home`]);

const noWait = async () => {};
const run = async (orgIds: string[], over: PremintDeps = {}) => {
  const report = await premintExternalPlay({ orgIds, serialise: false, wait: noWait, ...over });
  // Every scanned row ends in exactly one of three places (anti-vacuity for every pass below): made, failed or deferred.
  expect(report.roomsMade + report.failed + report.deferred, "every scanned row is accounted for exactly once").toBe(report.scanned);
  return report;
};

type Room = { fixture_id: string; side: string; meeting_id: string; home: string | null; away: string | null; ended_at: Date | null };
const roomsOf = (fixtureIds: string[]) =>
  sql<Room[]>`
    select fixture_id, side, meeting_id, home_entrant_id as home, away_entrant_id as away, ended_at
      from fixture_video_meetings where fixture_id in ${sql(fixtureIds)} order by fixture_id, side`;
const participantRows = async (fixtureIds: string[]) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from fixture_video_participants where fixture_id in ${sql(fixtureIds)}`)[0]!.n;

const creates = () => fx.calls.filter((c) => c.route === "POST /meetings");
const titleOf = (c: { body: unknown }) => (c.body as { title: string }).title;
const titleFor = (c: Pick<PremintCandidate, "fixtureId" | "side">) => `seazn-fixture-${c.fixtureId}-${c.side}`;
/** The create titles that name one of `fixtureIds`: per-uuid, so another test's board never counts here. */
const createsFor = (fixtureIds: string[]) => creates().map(titleOf).filter((t) => fixtureIds.some((id) => t.includes(id)));
const participantPosts = () => fx.calls.filter((c) => c.route === "POST /meetings/:id/participants");

/** A room on file with the stamp GIVEN - an earlier pairing's, the current one's, or (`null`) an UNADOPTED room: both stamps
 *  null, as V531's pair check wants. `endedAt` makes it an ENDED room. */
const insertRoom = (
  fixtureId: string,
  side: "home" | "away",
  stamp: { home: string; away: string } | null,
  endedAt: Date | null = null,
) =>
  sql`
    insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id, ended_at)
    values (${fixtureId}, ${side}, (select org_id from fixtures where id = ${fixtureId}), ${`pm-${randomUUID().slice(0, 12)}`},
            ${stamp?.home ?? null}, ${stamp?.away ?? null}, ${endedAt})`;

// ─── the candidate set ───────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("premint candidates (the set)", () => {
  it("empty case: an org with no online camera division yields [], and the pass over it scans nothing and makes no vendor call; an empty scope is not 'every org'", async () => {
    const owner = await seedOwner();
    expect(await rowsOf([owner.orgId])).toEqual([]);
    expect(await run([owner.orgId])).toEqual({
      skipped: 0,
      disabled: 0,
      scanned: 0,
      roomsMade: 0,
      deferred: 0,
      failed: 0,
      windowsOpen: 0,
      failures: [],
    });
    expect(fx.calls, "no vendor call for nothing to do").toEqual([]);

    // The positive pair: the same query sees a real board, and `orgIds: []` still matches nothing (never read as unscoped).
    const r = await seedRound(1);
    await unseat(ids(r));
    expect(await premintCandidates([]), "an empty scope matches nothing").toEqual([]);
    expect(keysOf(await rowsOf([r.orgId])).sort(), "positive pair: its own scope finds the board").toEqual(bothSides(ids(r)));
  });

  it("a placeholder board (null entrants) of an unopened round in a STARTED division yields two rows, one per side", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    const rows = await rowsOf([r.orgId]);
    expect(rows).toEqual([
      { fixtureId: r.boards[0]!.fixtureId, orgId: r.orgId, competitionId: r.competitionId, side: "away" },
      { fixtureId: r.boards[0]!.fixtureId, orgId: r.orgId, competitionId: r.competitionId, side: "home" },
    ]);
  });

  it("a division still in setup: its paired Swiss round-1 board yields two rows; its placeholder shells yield none (R3; counted)", async () => {
    const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional", divisionStarted: false });
    const [{ status }] = await sql<{ status: string }[]>`select status from divisions where id = ${s.divisionId}`;
    expect(divisionScoringClosed(status!), "premise: the division has not started").toBe(true);
    const paired = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${s.stageId} and home_entrant_id is not null and away_entrant_id is not null`;
    const shells = await sql<{ id: string }[]>`
      select id from fixtures where stage_id = ${s.stageId} and (home_entrant_id is null or away_entrant_id is null)`;
    expect(paired.length, "premise: round 1 is paired (4 players, 2 boards)").toBe(2);
    expect(shells.length, "premise: later rounds exist as placeholders (else 'yields none' is vacuous)").toBeGreaterThan(0);
    expect(keysOf(await rowsOf([s.orgId])).sort(), "exactly the paired boards, both sides; no shell").toEqual(bothSides(paired.map((p) => p.id)).sort());
  });

  it("the started arm is the negation of divisionScoringClosed, and a COMPLETED division is never wanted: every division status × (paired, placeholder) is a candidate iff not completed AND (started OR paired) (counted)", async () => {
    const r = await seedRound(1);
    const f = r.boards[0]!.fixtureId;
    let checked = 0;
    let wanted = 0;
    let unwanted = 0;
    for (const status of ["setup", "scheduled", "active", "completed"]) {
      for (const paired of [true, false]) {
        await sql`update divisions set status = ${status} where id = ${r.divisionId}`;
        if (paired) await reseat(r);
        else await unseat([f]);
        // R3, and the ruling that nothing of a completed division will be opened (m6: its unopened rounds are dead candidates
        // that would otherwise lead the cap).
        const expected = status !== "completed" && (!divisionScoringClosed(status) || paired);
        expect(keysOf(await rowsOf([r.orgId])).sort(), `${status}, ${paired ? "paired" : "placeholder"}`).toEqual(expected ? bothSides([f]) : []);
        if (expected) wanted += 1;
        else unwanted += 1;
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 statuses × 2 pairings").toBe(8);
    expect([wanted, unwanted], "both outcomes occur: setup/paired, scheduled/paired, active × 2 are wanted").toEqual([4, 4]);
  });

  it("a side with ANY room on file yields no row, whatever the row: adopted for the current pairing, unadopted on a since-paired board, stamped for an EARLIER pairing, ended (count 4)", async () => {
    const r = await seedRound(5);
    const [current, unadopted, earlier, ended, control] = r.boards as [Round["boards"][0], Round["boards"][0], Round["boards"][0], Round["boards"][0], Round["boards"][0]];
    await insertRoom(current.fixtureId, "home", { home: current.home.entrantId, away: current.away.entrantId });
    await insertRoom(unadopted.fixtureId, "home", null);
    await insertRoom(earlier.fixtureId, "home", { home: randomUUID(), away: randomUUID() });
    await insertRoom(ended.fixtureId, "home", { home: ended.home.entrantId, away: ended.away.entrantId }, new Date());
    const rows = keysOf(await rowsOf([r.orgId])).sort();
    const away = [current, unadopted, earlier, ended].map((b) => `${b.fixtureId}/away`);
    expect(rows, "each of the four boards keeps only its empty (away) side; the control board keeps both").toEqual([...away, ...bothSides([control.fixtureId])].sort());
    expect(rows.filter((k) => k.endsWith("/home")), "the four home sides are never candidates: only the control's").toEqual([`${control.fixtureId}/home`]);
    expect(away.length, "anti-vacuity: four kinds of room on file").toBe(4);
  });

  it("never candidates, one case each: an opened round, a camera-off policy, an OTB division, a cancelled board, a withdrawn board - and a control that IS (count 5 + 1)", async () => {
    const control = await seedRound(1);
    const opened = await seedRound(1);
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
      values (${opened.stageId}, ${opened.orgId}, 1, now(), ${opened.ownerUserId}, false)`;
    const cameraOff = await seedRound(1, { cameraPolicy: undefined });
    const otb = await seedRound(1, { onlinePlay: "off" });
    const cancelled = await seedRound(1);
    await sql`update fixtures set status = 'cancelled' where id = ${cancelled.boards[0]!.fixtureId}`;
    const withdrawn = await seedRound(1);
    await sql`update fixtures set status = 'abandoned' where id = ${withdrawn.boards[0]!.fixtureId}`;

    expect(keysOf(await rowsOf([control.orgId])).sort(), "the control: the same board, untouched, is a candidate").toEqual(bothSides(ids(control)));
    let checked = 0;
    for (const [why, r] of [
      ["an opened round", opened],
      ["a camera-off policy (the division's own, over the competition's off)", cameraOff],
      ["an OTB division", otb],
      ["a cancelled board", cancelled],
      ["a withdrawn board", withdrawn],
    ] as const) {
      expect(await rowsOf([r.orgId]), why).toEqual([]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: five exclusions").toBe(5);
  });

  it("the NEGATION the sweep's teardown asks is total (G2): over the control and the five exclusions every board is in exactly ONE of the wanted set and the left set; a NULL rule reads LEFT (witness, counted)", async () => {
    const control = await seedRound(1);
    const opened = await seedRound(1);
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
      values (${opened.stageId}, ${opened.orgId}, 1, now(), ${opened.ownerUserId}, false)`;
    const cameraOff = await seedRound(1, { cameraPolicy: undefined });
    const otb = await seedRound(1, { onlinePlay: "off" });
    const cancelled = await seedRound(1);
    await sql`update fixtures set status = 'cancelled' where id = ${cancelled.boards[0]!.fixtureId}`;
    const withdrawn = await seedRound(1);
    await sql`update fixtures set status = 'abandoned' where id = ${withdrawn.boards[0]!.fixtureId}`;
    const seeded = [control, opened, cameraOff, otb, cancelled, withdrawn];
    const rows = await sql<{ id: string; wanted: boolean | null; left: boolean | null }[]>`
      select f.id, (${premintBoardWhere()}) as wanted, ${premintBoardLeftWhere()} as "left"
        from fixtures f
        join stages s on s.id = f.stage_id
        join divisions d on d.id = f.division_id
        join competitions c on c.id = d.competition_id
       where c.org_id in ${sql(seeded.map((r) => r.orgId))}`;
    expect(rows.length, "anti-vacuity: one board per seeded round").toBe(seeded.length);
    expect(rows.filter((r) => r.wanted === true).length, "exactly the control is wanted").toBe(1);
    expect(rows.filter((r) => r.left === true).length, "and the other five are left").toBe(seeded.length - 1);
    for (const r of rows) expect((r.wanted === true) !== (r.left === true), `board ${r.id}: in exactly one of the two sets (never both, never neither)`).toBe(true);
    // The witness: a rule that is NULL for a board. `not (null)` is NULL - in neither set; the total negation says LEFT.
    const [w] = await sql<{ naive: boolean | null; total: boolean | null }[]>`
      select not (null::boolean) as naive, ${premintBoardLeftWhere(sql`null::boolean`)} as total`;
    expect(w, "premise: the naive negation of NULL is NULL; the total one is true").toEqual({ naive: null, total: true });
  });

  it("a fixture is playable only while `scheduled` or `in_play` (controller ruling Q2): every FIXTURE_STATUSES value is a candidate iff it is one of those two (counted)", async () => {
    const r = await seedRound(1);
    const f = r.boards[0]!.fixtureId;
    // The ruling, written out - not read from preflight's predicate or the module under test.
    const playable = new Set(["scheduled", "in_play"]);
    let candidates = 0;
    let excluded = 0;
    for (const status of FIXTURE_STATUSES) {
      await sql`update fixtures set status = ${status} where id = ${f}`;
      const got = keysOf(await rowsOf([r.orgId])).sort();
      expect(got, status).toEqual(playable.has(status) ? bothSides([f]) : []);
      if (playable.has(status)) candidates += 1;
      else excluded += 1;
    }
    expect([candidates, excluded], "anti-vacuity: both outcomes occur").toEqual([2, FIXTURE_STATUSES.length - 2]);
  });

  it("the camera policy is the NEAREST set level: stage, then division, then the competition's floor - every combination agrees with effectivePolicy (counted)", async () => {
    const r = await seedRound(1);
    const f = r.boards[0]!.fixtureId;
    const levels: (CameraPolicy | null)[] = [null, ...CAMERA_POLICIES];
    let kept = 0;
    let dropped = 0;
    let checked = 0;
    for (const stage of levels) {
      for (const division of levels) {
        for (const competition of CAMERA_POLICIES) {
          await sql`update stages set camera_policy = ${stage} where id = ${r.stageId}`;
          await sql`update divisions set camera_policy = ${division} where id = ${r.divisionId}`;
          await sql`update competitions set camera_policy = ${competition} where id = ${r.competitionId}`;
          const on = effectivePolicy({ stage, division, competition }) !== "off";
          expect(keysOf(await rowsOf([r.orgId])).sort(), `stage ${stage}, division ${division}, competition ${competition}`).toEqual(on ? bothSides([f]) : []);
          if (on) kept += 1;
          else dropped += 1;
          checked += 1;
        }
      }
    }
    expect(checked, "4 stage levels × 4 division levels × 3 competition levels").toBe(4 * 4 * CAMERA_POLICIES.length);
    expect([kept > 0, dropped > 0], "anti-vacuity: the sweep saw both outcomes").toEqual([true, true]);
  });

  it("a voided round put back on its shells is a placeholder again: rooms in a STARTED division, nothing in one still in setup (sequence: paired → void → candidates)", async () => {
    const roundOne = async (stageId: string) =>
      sql<{ id: string; home: string | null; away: string | null }[]>`
        select id, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${stageId} and round_no = 1`;
    for (const started of [true, false]) {
      const s = await seedOnlineSwiss({ players: 4, pairing: "fold", cameraPolicy: "optional", divisionStarted: started });
      const label = started ? "started" : "setup";
      const before = await roundOne(s.stageId);
      expect(before.every((b) => b.home !== null && b.away !== null), `${label}: premise - round 1 is paired`).toBe(true);
      const round1 = before.map((b) => b.id);
      expect(keysOf(await rowsOf([s.orgId])), `${label}: the paired board's rooms are wanted before the void`).toEqual(expect.arrayContaining(bothSides(round1)));

      await unpairSwissRound(s.owner, s.stageId);
      const after = await roundOne(s.stageId);
      expect(after.map((b) => b.id).sort(), `${label}: premise - the same boards`).toEqual([...round1].sort());
      expect(after.every((b) => b.home === null && b.away === null), `${label}: premise - the void left placeholders`).toBe(true);
      const got = keysOf(await rowsOf([s.orgId]));
      if (started) expect(got, "started: a placeholder in a started division is wanted").toEqual(expect.arrayContaining(bothSides(round1)));
      else expect(got, "setup: nothing - a placeholder in a division still in setup is never a candidate").toEqual([]);
    }
  });

  it("NEAREST ROUND FIRST: A round 2 at T+1h (its second board T+5h), B round 1 at T+3h, an unscheduled round 1 - A's rows lead, then B, then the unscheduled; the key does not move as A's rooms are made (counted)", async () => {
    const T = Date.now() + 24 * HOUR;
    const seeded = await Promise.all([seedRound(2), seedRound(2), seedRound(2)]);
    // The org id is a sort key of the tie-break: B (round 1, scheduled later) is given the smallest org id, then the unscheduled
    // round, then A - so round number, org id and the unscheduled-last rule each disagree with the scheduled time.
    const [B, C, A] = [...seeded].sort((p, q) => (p.orgId < q.orgId ? -1 : 1));
    // B and C are one-board rounds: their second board is cancelled, so it is never a candidate.
    for (const one of [B!, C!]) await sql`update fixtures set status = 'cancelled' where id = ${one.boards[1]!.fixtureId}`;
    await sql`update fixtures set round_no = 2 where stage_id = ${A!.stageId}`;
    await sql`update fixtures set scheduled_at = ${new Date(T + HOUR)} where id = ${A!.boards[0]!.fixtureId}`;
    await sql`update fixtures set scheduled_at = ${new Date(T + 5 * HOUR)} where id = ${A!.boards[1]!.fixtureId}`;
    await sql`update fixtures set scheduled_at = ${new Date(T + 3 * HOUR)} where id = ${B!.boards[0]!.fixtureId}`;
    await sql`update fixtures set scheduled_at = null where id = ${C!.boards[0]!.fixtureId}`;
    const orgs = [A!.orgId, B!.orgId, C!.orgId];
    const [a0, a1] = [A!.boards[0]!.fixtureId, A!.boards[1]!.fixtureId];
    const b0 = B!.boards[0]!.fixtureId;
    const c0 = C!.boards[0]!.fixtureId;

    expect(keysOf(await rowsOf(orgs)), "round A (T+1h, later round) < B (T+3h) < the unscheduled round; inside A, board order").toEqual([
      ...bothSides([a0, a1, b0, c0]),
    ]);

    // The cap spends the pass on the round that opens next: callCap 2 makes A's two rooms for its EARLIEST board only.
    const report = await run(orgs, { callCap: 2 });
    expect(report).toMatchObject({ scanned: 8, roomsMade: 2, deferred: 6, failed: 0 });
    expect(creates().map(titleOf).sort(), "A's earliest board, both sides - nothing of B or the unscheduled round").toEqual(
      [`seazn-fixture-${a0}-away`, `seazn-fixture-${a0}-home`].sort(),
    );
    // Stable key: A's earliest board now has rooms, so it is out of the set, yet A's round still leads B. A key taken after the
    // rooms filter would read A's remaining board as T+5h and put B (T+3h) first.
    expect(keysOf(await rowsOf(orgs)), "A's remaining board still leads B and the unscheduled round").toEqual([...bothSides([a1, b0, c0])]);
  });

  it("inside one stage, two unopened unscheduled rounds: round 1's rows come before round 2's, whatever the insert order", async () => {
    const r = await seedRound(1, { scheduledAt: null });
    const f2 = r.boards[0]!.fixtureId;
    await sql`update fixtures set round_no = 2 where id = ${f2}`;
    const [{ id: f1 }] = await sql<{ id: string }[]>`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      values (${r.stageId}, ${r.divisionId}, ${r.orgId}, 1, 1, ${`pm-${randomUUID().slice(0, 8)}`}, 'scheduled')
      returning id`;
    expect(keysOf(await rowsOf([r.orgId])), "round 1 (inserted second) before round 2 (inserted first)").toEqual([...bothSides([f1!, f2])]);
  });
});

// ─── the pass ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DB)("premint pass", () => {
  it("the flag is exactly '1': unset or anything else is `disabled` - no scan, no vendor call, no failure - and '1' makes the rooms (positive pair)", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    let checked = 0;
    for (const value of [undefined, "", "0", "true", "yes", "2"]) {
      vi.stubEnv("EXTERNAL_PLAY_PREMINT", value);
      expect(await run([r.orgId]), `flag ${JSON.stringify(value)}`).toEqual({
        skipped: 0,
        disabled: 1,
        scanned: 0,
        roomsMade: 0,
        deferred: 0,
        failed: 0,
        windowsOpen: 0,
        failures: [],
      });
      checked += 1;
    }
    expect(checked, "anti-vacuity: six off values").toBe(6);
    expect(fx.calls, "disabled makes no vendor call").toEqual([]);
    expect(await roomsOf(ids(r)), "and no room").toEqual([]);
    vi.stubEnv("EXTERNAL_PLAY_PREMINT", "1");
    expect(await run([r.orgId]), "positive pair: '1' does the work").toMatchObject({ disabled: 0, roomsMade: 2, failed: 0 });
  });

  it("makes rooms for 10 placeholders (20 POST /meetings, one per (board, side)) stamped (null, null); a second pass makes none; another org in the DB is left alone", async () => {
    const r = await seedRound(10);
    const other = await seedRound(1);
    await unseat([...ids(r), ...ids(other)]);
    const report = await run([r.orgId]);
    expect(report).toEqual({ skipped: 0, disabled: 0, scanned: 20, roomsMade: 20, deferred: 0, failed: 0, windowsOpen: 0, failures: [] });
    const wanted = ids(r).flatMap((id) => [`seazn-fixture-${id}-away`, `seazn-fixture-${id}-home`]).sort();
    expect(createsFor(ids(r)).sort(), "exactly one create per (board, side), each title once").toEqual(wanted);
    const rooms = await roomsOf(ids(r));
    expect(rooms, "20 rows").toHaveLength(20);
    expect(rooms.every((m) => m.home === null && m.away === null && m.ended_at === null), "every room is unadopted and unended").toBe(true);
    expect(await roomsOf(ids(other)), "an org outside the scope got nothing").toEqual([]);

    const before = fx.calls.length;
    expect(await run([r.orgId]), "the second pass: nothing is a candidate").toMatchObject({ scanned: 0, roomsMade: 0, deferred: 0, failed: 0 });
    expect(fx.calls.length, "and it makes no vendor call").toBe(before);
  });

  it("rooms only (ruling 2026-11-17 (2)): once the 10 boards are paired a pass makes NO vendor call, the 20 rows keep both stamps null, no participant exists; the seat's own ensureMeeting then ADOPTS one board's rooms with no vendor call", async () => {
    const r = await seedRound(10);
    await unseat(ids(r));
    expect(await run([r.orgId]), "premise: the 20 rooms are made on the placeholders").toMatchObject({ roomsMade: 20 });
    await reseat(r);
    const before = fx.calls.length;
    const report = await run([r.orgId]);
    expect(report, "a second pass over the now-paired boards: every side has a room on file").toMatchObject({ scanned: 0, roomsMade: 0, deferred: 0, failed: 0 });
    expect(fx.calls.length, "0 vendor calls: 0 POST /meetings, 0 POST participants").toBe(before);
    expect(participantPosts(), "no participant was ever made").toEqual([]);
    expect(await participantRows(ids(r)), "and none is on file").toBe(0);
    const rooms = await roomsOf(ids(r));
    expect(rooms.length).toBe(20);
    expect(rooms.every((m) => m.home === null && m.away === null), "the job never adopts: every stamp is still null").toBe(true);

    // The claim: the seat's own door, no opts. It adopts the board's two rooms (Task 2) - a database write, not a vendor call.
    const [b0, b1] = r.boards as [Round["boards"][0], Round["boards"][0]];
    const room0 = rooms.find((m) => m.fixture_id === b0.fixtureId && m.side === "home")!;
    const got = await ensureMeeting(b0.fixtureId, "home");
    expect(got.meetingId, "the job's own room, not a new one").toBe(room0.meeting_id);
    expect(fx.calls.length, "adopting made no vendor call").toBe(before);
    expect((await roomsOf([b0.fixtureId])).map((m) => [m.side, m.home, m.away]), "both of the board's rooms now name its pairing").toEqual([
      ["away", b0.home.entrantId, b0.away.entrantId],
      ["home", b0.home.entrantId, b0.away.entrantId],
    ]);
    expect((await roomsOf([b1.fixtureId])).every((m) => m.home === null), "another board's rooms are untouched").toBe(true);
  });

  it("a board already PAIRED when the job reaches it: its two rooms are stamped with the pairing, and no participant is made", async () => {
    const r = await seedRound(1);
    const b = r.boards[0]!;
    expect(await run([r.orgId])).toMatchObject({ scanned: 2, roomsMade: 2, failed: 0 });
    expect((await roomsOf([b.fixtureId])).map((m) => [m.side, m.home, m.away, m.ended_at]), "stamped with the pairing, unended").toEqual([
      ["away", b.home.entrantId, b.away.entrantId, null],
      ["home", b.home.entrantId, b.away.entrantId, null],
    ]);
    expect(participantPosts(), "0 POST participants").toEqual([]);
    expect(await participantRows([b.fixtureId]), "no participant row").toBe(0);
  });

  it("the cap: callCap 7 over 10 boards' rooms makes 7 POST /meetings at the head of the order, reports deferred = the 13 remaining rows, and the next pass continues from the top", async () => {
    const r = await seedRound(10);
    await unseat(ids(r));
    const order = await rowsOf([r.orgId]);
    expect(order.length, "premise: 20 candidate rows").toBe(20);

    let waits = 0;
    const first = await run([r.orgId], { callCap: 7, wait: async () => void (waits += 1) });
    expect(first).toMatchObject({ scanned: 20, roomsMade: 7, deferred: 13, failed: 0, failures: [] });
    expect(waits, "7 calls wait between them (6); the 8th was refused by the cap and made no call, so it waited for nothing").toBe(6);
    expect(createsFor(ids(r)).sort(), "the first 7 rows of the candidate order, and only those").toEqual(order.slice(0, 7).map(titleFor).sort());
    expect(await roomsOf(ids(r)), "7 rows on file").toHaveLength(7);

    const second = await run([r.orgId]);
    expect(second, "the next pass continues from the top: only the 13 not yet made").toMatchObject({ scanned: 13, roomsMade: 13, deferred: 0, failed: 0 });
    expect(createsFor(ids(r)).sort(), "20 creates in all, each (board, side) once").toEqual(order.map(titleFor).sort());
  });

  it("the DEFAULT cap is PREMINT_CALLS_PER_PASS: 24 boards (48 rows) and no callCap make exactly that many rooms and defer the rest, none a failure", async () => {
    const r = await seedRound(1);
    // 23 more placeholder boards in round 2, by one statement: rooms need no entrants, only a board.
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      select ${r.stageId}::uuid, ${r.divisionId}::uuid, ${r.orgId}::uuid, 2, g, 'pm-' || g || '-' || gen_random_uuid()::text, 'scheduled'
        from generate_series(1, 23) g`;
    const rows = 2 * 24;
    expect(PREMINT_CALLS_PER_PASS, "premise: the cap is below the row count, so it binds").toBeLessThan(rows);
    const report = await run([r.orgId]);
    expect(report).toMatchObject({ scanned: rows, roomsMade: PREMINT_CALLS_PER_PASS, deferred: rows - PREMINT_CALLS_PER_PASS, failed: 0, failures: [] });
    expect(creates().length, "the vendor was asked exactly PREMINT_CALLS_PER_PASS times").toBe(PREMINT_CALLS_PER_PASS);
  });

  it("a cap that is not a non-negative integer is refused by name and never fails open; callCap 0 makes nothing and defers everything; the default is the brief's 45", async () => {
    const r = await seedRound(2);
    await unseat(ids(r));
    let refused = 0;
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(run([r.orgId], { callCap: bad }), `callCap ${bad}`).rejects.toBeInstanceOf(RangeError);
      refused += 1;
    }
    expect(refused, "anti-vacuity: four bad caps").toBe(4);
    expect(fx.calls, "a refused cap made no vendor call").toEqual([]);

    expect(await run([r.orgId], { callCap: 0 }), "a zero cap is valid: nothing is made, every row is deferred").toMatchObject({
      scanned: 4,
      roomsMade: 0,
      deferred: 4,
      failed: 0,
    });
    expect(fx.calls, "and the zero cap made no vendor call").toEqual([]);

    expect(PREMINT_CALLS_PER_PASS, "45: the brief's pass budget over its one-second interval").toBe(45);
    expect(Number.isInteger(PREMINT_CALLS_PER_PASS), "an integer cappedBudget accepts").toBe(true);
  });

  it("pacing: with a counting `wait`, a pass of 5 calls waits PREMINT_CALL_INTERVAL_MS exactly 4 times - between calls, never before the first", async () => {
    const r = await seedRound(3);
    await unseat(ids(r));
    // One side already has a room, so the 3 boards are 5 candidate rows.
    await insertRoom(ids(r)[2]!, "home", null);
    const waits: { ms: number; callsSoFar: number }[] = [];
    const report = await run([r.orgId], { wait: async (ms) => void waits.push({ ms, callsSoFar: creates().length }) });
    expect(report).toMatchObject({ scanned: 5, roomsMade: 5, failed: 0 });
    expect(waits.map((w) => w.ms), "four waits of the interval").toEqual(Array(4).fill(PREMINT_CALL_INTERVAL_MS));
    expect(waits.map((w) => w.callsSoFar), "each wait sits AFTER a call: 1, 2, 3, 4 calls made - never before the first").toEqual([1, 2, 3, 4]);
    expect(creates().length).toBe(5);
  });

  it("the pass's own wall-clock budget: calls stop being STARTED once PREMINT_PASS_BUDGET_MS is spent, the rest is deferred and nothing fails (counted, derived from the constant)", async () => {
    const r = await seedRound(4);
    await unseat(ids(r));
    // A clock that the pacing wait moves: each wait costs 10 s, so call k starts (k - 1) × 10 s into the pass.
    const step = 10_000;
    let t = 0;
    const report = await run([r.orgId], { wallClock: () => t, wait: async () => void (t += step) });
    const startable = Math.ceil(PREMINT_PASS_BUDGET_MS / step); // calls k with (k - 1) × step < the budget
    expect(startable, "premise: the budget is spent mid-pass, below the 8 rows").toBeLessThan(8);
    expect(report).toMatchObject({ scanned: 8, roomsMade: startable, deferred: 8 - startable, failed: 0, failures: [] });
    expect(creates().length, "no call was started past the budget").toBe(startable);
  });

  it("the platform bucket dry: RealtimeKitDeferred stops the pass with the rest deferred and failed 0 - and a bucket that runs dry part-way is consulted for every call (rtk.budget)", async () => {
    const r = await seedRound(3);
    await unseat(ids(r));
    const dry = await run([r.orgId], { rtk: { budget: async () => false } });
    expect(dry, "dry from the first call: nothing made, all 6 rows deferred, no failure").toEqual({
      skipped: 0,
      disabled: 0,
      scanned: 6,
      roomsMade: 0,
      deferred: 6,
      failed: 0,
      windowsOpen: 0,
      failures: [],
    });
    expect(fx.calls, "a refused request never reached the vendor").toEqual([]);

    let granted = 0;
    const askedFor: string[] = [];
    const partway = await run([r.orgId], {
      rtk: {
        budget: async (k) => {
          askedFor.push(k);
          return granted++ < 3;
        },
      },
    });
    expect(partway, "3 tokens, then dry").toMatchObject({ scanned: 6, roomsMade: 3, deferred: 3, failed: 0 });
    expect(creates().length, "exactly the 3 granted calls were made").toBe(3);
    expect(askedFor.length, "the bucket was asked for every attempt: 3 granted + the 1 refusal that stopped the pass").toBe(4);
  });

  it("the PLATFORM's bucket is spent by the pass itself (no `rtk.budget`): with the base metered N creates drop the bucket by exactly N, an empty bucket defers with 0 creates, and an unmetered base never touches it", async () => {
    const key = `${fx.url}|${REALTIMEKIT_FIXTURE_ENV.CLOUDFLARE_ACCOUNT_ID}`;
    // A stamp an hour AHEAD refills nothing (elapsed is floored at zero), so the level reads exactly as the takes leave it.
    const setBucket = (tokens: number) =>
      sql`insert into realtimekit_call_budget (key, tokens, refilled_at) values (${key}, ${tokens}, now() + interval '1 hour')
          on conflict (key) do update set tokens = excluded.tokens, refilled_at = excluded.refilled_at`;
    const level = async () => Number((await sql<{ tokens: number }[]>`select tokens from realtimekit_call_budget where key = ${key}`)[0]!.tokens);
    const [a, b, c] = await Promise.all([seedRound(3), seedRound(2), seedRound(1)]);
    await unseat([...ids(a), ...ids(b), ...ids(c)]);
    try {
      // Unmetered (the fixture's base is not Cloudflare's): the same pass leaves the bucket alone. The control that the drops
      // below come from the metering and from nothing else.
      await setBucket(100);
      expect(await run([c.orgId]), "premise: unmetered, the pass makes its 2 rooms").toMatchObject({ roomsMade: 2, failed: 0 });
      expect(await level(), "unmetered: the bucket is untouched").toBe(100);

      vi.stubEnv("REALTIMEKIT_METER_ANY_BASE", "1");
      const report = await run([a.orgId]);
      expect(report, "6 rooms made").toMatchObject({ scanned: 6, roomsMade: 6, deferred: 0, failed: 0 });
      expect(await level(), "metered: 100 - 6 creates, exactly").toBe(94);

      await setBucket(0);
      const before = fx.calls.length;
      const dry = await run([b.orgId]);
      expect(dry, "an empty bucket: nothing made, all 4 rows deferred, no failure").toMatchObject({ scanned: 4, roomsMade: 0, deferred: 4, failed: 0, failures: [] });
      expect(fx.calls.length, "a refused request never reached the vendor: 0 creates").toBe(before);
      expect(await level(), "and it took nothing").toBe(0);
    } finally {
      await sql`delete from realtimekit_call_budget where key = ${key}`;
    }
  });

  it("the DEFAULT pacing wait is real: with no `wait` dep the second request starts at least PREMINT_CALL_INTERVAL_MS after the first", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    const report = await premintExternalPlay({ orgIds: [r.orgId], serialise: false });
    expect(report).toMatchObject({ scanned: 2, roomsMade: 2, failed: 0 });
    const posts = creates();
    expect(posts, "premise: two creates").toHaveLength(2);
    // The timer may fire a hair early against the fixture's own receipt stamps; the broken default (no wait) is ~10 ms.
    expect(posts[1]!.at - posts[0]!.at, "the gap between the two requests").toBeGreaterThanOrEqual(PREMINT_CALL_INTERVAL_MS - 50);
  });

  it("RealtimeKit not configured: ONE failure (code `unconfigured`) and the rest of the pass deferred, never one failure per candidate; configured again, the next pass makes them all", async () => {
    const r = await seedRound(3);
    await unseat(ids(r));
    const order = await rowsOf([r.orgId]);
    vi.stubEnv("REALTIMEKIT_API_TOKEN", "");
    const report = await run([r.orgId]);
    expect(report).toMatchObject({ scanned: 6, roomsMade: 0, deferred: 5, failed: 1 });
    expect(report.failures, "one entry, for the first row").toEqual([{ fixtureId: order[0]!.fixtureId, side: order[0]!.side, code: "unconfigured" }]);
    expect(fx.calls, "nothing reached the vendor").toEqual([]);
    vi.stubEnv("REALTIMEKIT_API_TOKEN", REALTIMEKIT_FIXTURE_ENV.REALTIMEKIT_API_TOKEN);
    expect(await run([r.orgId]), "positive pair: configured, every row is made").toMatchObject({ scanned: 6, roomsMade: 6, failed: 0 });
  });

  it("a vendor that fails PREMINT_FAILURES_BEFORE_BREAK rooms in a row is down: the pass stops asking and defers the rest; a success in between resets the streak (counted)", async () => {
    // The breaker is the brief's "one 503 and the pass goes on" test above, generalised: 3 is the threshold, not 1.
    expect(PREMINT_FAILURES_BEFORE_BREAK, "the ruling: 3").toBe(3);
    const r = await seedRound(4);
    await unseat(ids(r));
    fx.setUnavailable(true);
    const down = await run([r.orgId]);
    expect(down, "3 failures, then the 5 rows left are deferred").toMatchObject({ scanned: 8, roomsMade: 0, failed: 3, deferred: 5 });
    expect(down.failures.map((f) => f.code), "each a vendor code, never a message").toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(fx.calls.length, "exactly 3 requests reached the vendor").toBe(3);
    fx.setUnavailable(false);
    expect(await run([r.orgId]), "positive pair: the vendor is back and the next pass makes all 8").toMatchObject({ scanned: 8, roomsMade: 8, failed: 0 });

    // Only a VENDOR error counts: a row's own refusal (its fixture vanished since the scan: an HttpError 404, no vendor call) is
    // neutral, neither a failure of the vendor nor a proof it is back. Vendor, vendor, row-refusal, row-refusal, vendor: the
    // third VENDOR error is the one that breaks, so 5 failures and the last row deferred.
    const x = await seedRound(3);
    await unseat(ids(x));
    fx.setUnavailable(true);
    const order = await rowsOf([x.orgId]);
    expect(order, "premise: 6 rows, the middle fixture on rows 2 and 3").toHaveLength(6);
    expect(order[2]!.fixtureId, "rows 2 and 3 are one board's two sides").toBe(order[3]!.fixtureId);
    const gone = order[2]!.fixtureId;
    const refusing = await run([x.orgId], {
      // `offered` runs once, before the first row's request, and the scan is already taken: the fixture goes after it.
      offered: async () => {
        await sql`delete from fixtures where id = ${gone}`;
        return true;
      },
    });
    expect(refusing.failures.map((f) => f.code), "V V X X V, then the break").toEqual(["unavailable", "unavailable", "NOT_FOUND", "NOT_FOUND", "unavailable"]);
    expect(refusing, "the last row is deferred").toMatchObject({ scanned: 6, roomsMade: 0, failed: 5, deferred: 1 });
    fx.setUnavailable(false);

    // The streak resets on a success: fail, fail, ok, fail, fail, ok is 4 failures and 2 rooms, and nothing is deferred.
    const s = await seedRound(3);
    await unseat(ids(s));
    const pattern = ["F", "F", "O", "F", "F", "O"];
    let creating = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/meetings") && pattern[creating++] === "F") {
        return new Response(JSON.stringify({ success: false, error: { code: 503, message: "vendor down" } }), { status: 503 });
      }
      return fetch(input, init);
    };
    expect(await run([s.orgId], { rtk: { fetch: flaky } }), "two in a row is below the threshold, twice").toMatchObject({
      scanned: 6,
      roomsMade: 2,
      failed: 4,
      deferred: 0,
    });
  });

  it("a club not offered online chess is skipped (deferred), never minted and never a failure; the flag is asked once per club", async () => {
    const [a, b] = await Promise.all([seedRound(1), seedRound(2)]);
    await unseat([...ids(a), ...ids(b)]);
    const asked: string[] = [];
    const report = await run([a.orgId, b.orgId], {
      offered: async ({ orgId }) => {
        asked.push(orgId);
        return orgId === a.orgId;
      },
    });
    expect(report, "club A's 2 rows made; club B's 4 rows deferred").toMatchObject({ scanned: 6, roomsMade: 2, deferred: 4, failed: 0, failures: [] });
    expect(createsFor(ids(a)).length, "club A is minted").toBe(2);
    expect(createsFor(ids(b)), "club B never is").toEqual([]);
    expect(asked.sort(), "each club asked exactly once, however many rows it has").toEqual([a.orgId, b.orgId].sort());
  });

  it("T5 review M1: the pass's wall-clock budget covers the per-club FLAG ASKS too - clubs the flag keeps off make no vendor call, so a hanging flag service would otherwise cost one full ask per club and overrun the Worker's 60 s (counted, derived from the constant)", async () => {
    const CLUBS = 6;
    const rounds = await Promise.all(Array.from({ length: CLUBS }, () => seedRound(1)));
    await unseat(rounds.flatMap(ids));
    const orgIds = rounds.map((r) => r.orgId);
    // Every ask takes a fifth of the budget on the pass's own clock (a hanging flag service answering at its timeout, which is `false`):
    // the asks start at 0, 1/5, ... of the budget, so the sixth would start AT the budget and must not.
    const ask = PREMINT_PASS_BUDGET_MS / 5;
    expect(Number.isInteger(ask), "premise: the budget is a whole number of asks").toBe(true);
    let t = 0;
    const asked: string[] = [];
    const slowNo = async ({ orgId }: { orgId: string }) => {
      asked.push(orgId);
      t += ask;
      return false;
    };
    const report = await run(orgIds, { wallClock: () => t, offered: slowNo });
    expect(asked.length, "the asks that STARTED while the budget was unspent: budget / ask, never the sixth").toBe(PREMINT_PASS_BUDGET_MS / ask);
    expect(asked.length, "premise: fewer asks than clubs, so the cut is what stopped them").toBeLessThan(CLUBS);
    expect(report, "every row deferred, none made, none failed").toMatchObject({ scanned: CLUBS * 2, roomsMade: 0, deferred: CLUBS * 2, failed: 0, failures: [] });
    expect(fx.calls, "and no vendor call").toEqual([]);

    // The pair: the same six clubs with a flag service that answers at once spend no clock, so the budget cuts nothing and every
    // row is made.
    t = 0;
    asked.length = 0;
    const fastYes = async ({ orgId }: { orgId: string }) => {
      asked.push(orgId);
      return true;
    };
    const fast = await run(orgIds, { wallClock: () => t, offered: fastYes });
    expect(asked.length, "all six clubs asked").toBe(CLUBS);
    expect(fast, "positive pair: nothing deferred, every row made").toMatchObject({ scanned: CLUBS * 2, roomsMade: CLUBS * 2, deferred: 0, failed: 0 });
  });

  it("a vendor 503 on one board is one failure (a code, never a message) and the pass goes on; the failed side has no room and is made by the next pass", async () => {
    const r = await seedRound(3);
    await unseat(ids(r));
    const bad = { fixtureId: ids(r)[1]!, orgId: r.orgId, side: "home" as const };
    const flaky: typeof fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { title?: string }) : null;
      if (init?.method === "POST" && body?.title === titleFor(bad)) {
        return new Response(JSON.stringify({ success: false, error: { code: 503, message: "vendor down" } }), { status: 503 });
      }
      return fetch(input, init);
    };
    const report = await run([r.orgId], { rtk: { fetch: flaky } });
    expect(report).toMatchObject({ scanned: 6, roomsMade: 5, deferred: 0, failed: 1 });
    expect(report.failures, "one failure: which row, and a code").toEqual([{ fixtureId: bad.fixtureId, side: "home", code: "unavailable" }]);
    expect((await roomsOf(ids(r))).map((m) => `${m.fixture_id}/${m.side}`), "the other 5 rows got their rooms; the failed one did not").not.toContain(key(bad));
    expect(await roomsOf(ids(r))).toHaveLength(5);

    expect(await run([r.orgId]), "the next pass retries exactly the failed side").toMatchObject({ scanned: 1, roomsMade: 1, failed: 0 });
    expect(createsFor(ids(r)).filter((t) => t === titleFor(bad)), "the failed side reached the vendor once: only the retry (the first was refused on the wire)").toHaveLength(1);
    expect(createsFor(ids(r)), "6 creates in all, each (board, side) once").toHaveLength(6);
  });

  it("two passes at once: the second is skipped by the lock, makes no call and reports it; once the first finishes the next runs", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    const skipped = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${PREMINT_LOCK}))`;
      return premintExternalPlay({ orgIds: [r.orgId], wait: noWait });
    });
    expect(skipped, "the lock was held: skipped 1, and nothing was looked at").toEqual({
      skipped: 1,
      disabled: 0,
      scanned: 0,
      roomsMade: 0,
      deferred: 0,
      failed: 0,
      windowsOpen: 0,
      failures: [],
    });
    expect(fx.calls, "a skipped pass made no vendor call").toEqual([]);
    const next = await premintExternalPlay({ orgIds: [r.orgId], wait: noWait });
    expect(next, "positive pair: the lock was released with the transaction").toMatchObject({ skipped: 0, roomsMade: 2 });
  });

  it("T5 review M2: a flag-off pass takes NO lock - while another pass holds it the answer is `disabled: 1`, never `skipped: 1` (a failure counter for the Worker); the same held lock with the flag on is `skipped: 1` (positive pair)", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    let checked = 0;
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${PREMINT_LOCK}))`;
      // The lock is held for the whole loop below, by a transaction that is not the pass's.
      for (const value of [undefined, "", "0", "true"]) {
        vi.stubEnv("EXTERNAL_PLAY_PREMINT", value);
        expect(await premintExternalPlay({ orgIds: [r.orgId], wait: noWait }), `flag ${JSON.stringify(value)}`).toEqual({
          skipped: 0,
          disabled: 1,
          scanned: 0,
          roomsMade: 0,
          deferred: 0,
          failed: 0,
          windowsOpen: 0,
          failures: [],
        });
        checked += 1;
      }
      vi.stubEnv("EXTERNAL_PLAY_PREMINT", "1");
      expect(await premintExternalPlay({ orgIds: [r.orgId], wait: noWait }), "positive pair: flag on, the lock held").toMatchObject({ skipped: 1, disabled: 0, scanned: 0 });
    });
    expect(checked, "anti-vacuity: four off values").toBe(4);
    expect(fx.calls, "no vendor call from any of them").toEqual([]);
  });
});

// ─── the pass's budget on its own ────────────────────────────────────────────────────────────────────────────────────────

describe("premintBudget", () => {
  it("the wall-clock refusal is STICKY: once the budget is spent no later request is granted, whatever the clock reads, and none takes a token from the platform's bucket", async () => {
    let asked = 0;
    const inner = async () => {
      asked += 1;
      return true;
    };
    // The clock reads inside the budget (after the wait): in time, past the budget, then BACK to the start (a step backwards).
    const reads = [0, PREMINT_PASS_BUDGET_MS, 0, 0];
    let waited = 0;
    const budget = premintBudget({ cap: 10, inner, clock: () => reads.shift()!, startedAt: 0, wait: async () => void (waited += 1) });
    expect(await budget("k"), "in time: granted").toBe(true);
    expect(await budget("k"), "past the budget: refused").toBe(false);
    expect(await budget("k"), "the clock stepped back: still refused (sticky)").toBe(false);
    expect(await budget("k"), "and again").toBe(false);
    expect(asked, "the bucket was asked for the first two only: a sticky refusal wastes no token").toBe(2);
    expect(waited, "one wait, before the second request: the refused ones made no call").toBe(1);
    expect(reads.length, "the clock was read twice: a sticky refusal does not even ask it").toBe(2);
  });
});

// ─── the seam: the real producer, through a re-open, to a claim ──────────────────────────────────────────────────────────

describe.skipIf(!DB)("premint, through its real consumers", () => {
  it("SEAM: the pass's rooms (ensureMeeting, unpaired allow) on a placeholder board → the board is paired → a re-open → a player's claim ADOPTS the pre-made room: no second room, the participant joins it, no SQL-written rooms", async () => {
    stubOutboxEnv();
    const r = await seedRound(1);
    const b = r.boards[0]!;
    const f = b.fixtureId;
    await unseat([f]);

    // The REAL producer: the pass makes the board's two rooms while it has no pairing.
    expect(await run([r.orgId]), "premise: two rooms made on the placeholder").toMatchObject({ scanned: 2, roomsMade: 2, failed: 0 });
    const made = await roomsOf([f]);
    expect(made.map((m) => [m.side, m.home, m.away]), "premise: both rooms are unadopted").toEqual([
      ["away", null, null],
      ["home", null, null],
    ]);
    const roomOf = (side: string) => made.find((m) => m.side === side)!.meeting_id;
    await reseat(r);

    // A re-open (Task 3): the first open is refused every send, so nobody is bound to it and the second re-stamps the window.
    mail.fail.add(b.home.email).add(b.away.email);
    const end = (id: string) => endMeeting(id);
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { now: new Date(Date.now() - 30 * MIN), endMeeting: end })).toMatchObject({
      opened: true,
      invited: 0,
    });
    mail.fail.clear();
    const mark = fx.calls.length;
    expect(await openRound({ stageId: r.stageId, roundNo: 1, actorUserId: r.ownerUserId }, { endMeeting: end })).toMatchObject({ opened: true, invited: 2 });
    const audit = await sql<{ type: string }[]>`
      select type from competition_events where competition_id = ${r.competitionId} and type like 'external_play.round_%' order by created_at, id`;
    expect(audit.map((a) => a.type), "premise: the second open was a RE-OPEN (the path that retires)").toEqual(["external_play.round_opened", "external_play.round_reopened"]);
    expect(fx.calls.slice(mark).filter((c) => c.route === "PATCH /meetings/:id" || c.route === "POST /meetings"), "the re-open ended and made no room").toEqual([]);
    expect((await roomsOf([f])).map((m) => [m.side, m.meeting_id, m.home]), "the pre-made rooms survived the re-open, still unadopted").toEqual([
      ["away", roomOf("away"), null],
      ["home", roomOf("home"), null],
    ]);

    // The claim: the player's seat, the real adapter, the real adoption.
    const afterReopen = fx.calls.length;
    const seat = await seatPlayer({ fixtureId: f, personId: b.home.personId });
    expect(seat, "the home player seats").toMatchObject({ seated: true });
    const myParticipant = fx.participantFor(b.home.personId);
    expect(myParticipant?.meetingId, "the participant joined the PRE-MADE room").toBe(roomOf("home"));
    expect(fx.calls.slice(afterReopen).filter((c) => c.route === "POST /meetings"), "the claim made no room: the one it needed was waiting").toEqual([]);
    expect((await roomsOf([f])).map((m) => [m.side, m.meeting_id, m.home, m.away]), "both rooms are now adopted for the pairing, and none was replaced").toEqual([
      ["away", roomOf("away"), b.home.entrantId, b.away.entrantId],
      ["home", roomOf("home"), b.home.entrantId, b.away.entrantId],
    ]);

    // The other side's claim finds its room too.
    const seatAway = await seatPlayer({ fixtureId: f, personId: b.away.personId });
    expect(seatAway).toMatchObject({ seated: true });
    expect(fx.participantFor(b.away.personId)?.meetingId, "the away participant joined ITS pre-made room").toBe(roomOf("away"));
    expect(creates().length, "two rooms in all, both made by the pass").toBe(2);
  });
});

// ─── check-in capacity plan 2 Task 8: the open-window deferral, unseated bye shells, the placeholder's sibling (m4) ─────────────────

describe.skipIf(!DB)("premint (Task 8)", () => {
  /** A SECOND round of the round's stage, opened `agoMs` ago (a one-row round, stamped directly: the product stamps exactly these
   *  columns). Its board is in an OPENED round, so it is no candidate itself; its window is what the pre-mint job must read. */
  async function openOwnWindow(r: Round, agoMs: number) {
    await sql`
      insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status)
      values (${r.stageId}, ${r.divisionId}, ${r.orgId}, ${r.roundNo + 1}, 1, ${`w-${randomUUID().slice(0, 8)}`}, 'scheduled')`;
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
      values (${r.stageId}, ${r.orgId}, ${r.roundNo + 1}, ${new Date(Date.now() - agoMs)}, ${r.ownerUserId}, false)`;
  }

  it("R3, the window: with an own round's window open the pass makes no vendor call, reports windowsOpen 1 and counts every candidate deferred; EXTERNAL_PLAY_WINDOW_DEFER=0 lifts it; with no window it mints", async () => {
    const quiet = await seedRound(2); // an org with no round open: the control
    const r = await seedRound(2);
    await openOwnWindow(r, MIN);
    const held = await run([r.orgId]);
    expect(held, "4 candidates (2 boards x 2 sides), all deferred, the window reported").toEqual({
      skipped: 0, disabled: 0, scanned: 4, roomsMade: 0, deferred: 4, failed: 0, windowsOpen: 1, failures: [],
    });
    expect(fx.calls, "no vendor call").toEqual([]);
    expect(await roomsOf(ids(r)), "no room made").toEqual([]);

    const free = await run([quiet.orgId]);
    expect(free, "no window in THIS scope: it mints").toMatchObject({ scanned: 4, roomsMade: 4, deferred: 0, windowsOpen: 0 });
    expect(createsFor(ids(quiet)), "4 creates").toHaveLength(4);

    vi.stubEnv("EXTERNAL_PLAY_WINDOW_DEFER", "0");
    const lifted = await run([r.orgId]);
    expect(lifted, "the deferral switched off: it mints under the open window").toMatchObject({ scanned: 4, roomsMade: 4, deferred: 0, windowsOpen: 0 });
    expect(createsFor(ids(r))).toHaveLength(4);
  });

  it("R3, the window closes: an own round opened longer ago than its bound (derived from window.ts) no longer defers - one second each side of the bound (the pass reads the real clock, so the exact millisecond is pinned on `anyCheckinWindowOpen` in round-open-any-window.test.ts)", async () => {
    let checked = 0;
    for (const [agoMs, deferred] of [[ROUND_WINDOW_TAIL_MS - 1_000, true], [ROUND_WINDOW_TAIL_MS + 1_000, false]] as const) {
      const r = await seedRound(1);
      await openOwnWindow(r, agoMs);
      const out = await run([r.orgId]);
      expect([out.windowsOpen, out.deferred, out.roomsMade], `opened ${agoMs} ms ago`).toEqual(deferred ? [1, 2, 0] : [0, 0, 2]);
      checked += 1;
    }
    expect(checked, "both sides of the bound").toBe(2);
  });

  it("the unseated Swiss bye shell is no candidate (batch-3 m1): the SQL pattern agrees with isSwissByeShellExtKey over a table of keys, and a real odd Swiss field's bye shells yield no row while its board shells do", async () => {
    const keys = ["sw-r1-bye", "sw-r12-bye", "sw-r1-b1", "sw-r1-bye2", "xsw-r1-bye", "sw-r-bye", "SW-R1-BYE", "adhoc-1", "t19-ab12cd34"];
    let agree = 0;
    let isBye = 0;
    for (const k of keys) {
      const [row] = await sql<{ matches: boolean }[]>`select ${k} ~ ${SWISS_BYE_SHELL_EXT_KEY_SQL_PATTERN} as matches`;
      expect(row!.matches, `${k}: SQL and TS agree`).toBe(isSwissByeShellExtKey(k));
      agree += 1;
      if (row!.matches) isBye += 1;
    }
    expect([agree, isBye], "anti-vacuity: every key judged, and the table has both answers").toEqual([keys.length, 2]);

    const s = await seedOnlineSwiss({ players: 5, rounds: 3, pairing: "fold", cameraPolicy: "optional" });
    const shells = await sql<{ id: string; ext_key: string; unseated: boolean }[]>`
      select id, ext_key, (home_entrant_id is null and away_entrant_id is null) as unseated from fixtures where stage_id = ${s.stageId}`;
    const byeShells = shells.filter((f) => isSwissByeShellExtKey(f.ext_key) && f.unseated);
    const boardShells = shells.filter((f) => !isSwissByeShellExtKey(f.ext_key) && f.unseated);
    expect(byeShells.length, "premise: the odd field minted unseated bye shells").toBeGreaterThan(0);
    expect(boardShells.length, "premise: and board shells").toBeGreaterThan(0);
    const got = (await rowsOf([s.orgId])).map((c) => c.fixtureId);
    expect(got.filter((id) => byeShells.some((f) => f.id === id)), "no row for a bye shell").toEqual([]);
    for (const f of boardShells) expect(got, `the board shell ${f.ext_key} is wanted`).toContain(f.id);
  });

  it("a placeholder with NO ext_key is still a candidate: the bye test reads NULL against the pattern, and `not (null and ...)` would drop it", async () => {
    const r = await seedRound(1);
    await unseat(ids(r));
    await sql`update fixtures set ext_key = null where id = ${ids(r)[0]!}`;
    expect(keysOf(await rowsOf([r.orgId])).sort()).toEqual(bothSides(ids(r)));
  });

  it("m4: on a PLACEHOLDER board the pass never ends the sibling room stamped for an earlier pairing (the sweep leaves an unpaired board's rooms too); on a PAIRED board the same sibling IS retired - ended, row deleted, a fresh room made", async () => {
    const quietEnded = () => fx.calls.filter((c) => c.route === "PATCH /meetings/:id" || c.route.endsWith("/kick-all"));
    // Placeholder: home has a room made for the board's earlier pairing; its pairing is gone.
    const a = await seedRound(1);
    const fa = ids(a)[0]!;
    const old = await ensureMeeting(fa, "home"); // the real adapter against the fixture server: a real room, stamped for the pairing
    await unseat([fa]);
    expect(keysOf(await rowsOf([a.orgId])), "premise: only the away side is a candidate").toEqual([`${fa}/away`]);
    const markA = fx.calls.length;
    expect(await run([a.orgId])).toMatchObject({ scanned: 1, roomsMade: 1, failed: 0 });
    expect(quietEnded().filter((c) => fx.calls.indexOf(c) >= markA), "no vendor end call").toEqual([]);
    const rooms = await roomsOf([fa]);
    expect(rooms.map((m) => [m.side, m.ended_at]), "the sibling is still on file, unended; the away room made beside it").toEqual([["away", null], ["home", null]]);
    expect(rooms.find((m) => m.side === "home")!.meeting_id, "the sibling is the same room").toBe(old.meetingId);
    expect(rooms.find((m) => m.side === "away")!.home, "the new room is unadopted").toBeNull();

    // Paired: the pairing changed (the entrants swapped), so the sibling is stale against a pairing that exists - retired by the claim's rule.
    const b = await seedRound(1);
    const fb = ids(b)[0]!;
    const stale = await ensureMeeting(fb, "home");
    await sql`update fixtures set home_entrant_id = ${b.boards[0]!.away.entrantId}, away_entrant_id = ${b.boards[0]!.home.entrantId} where id = ${fb}`;
    const markB = fx.calls.length;
    expect(await run([b.orgId])).toMatchObject({ scanned: 1, roomsMade: 1, failed: 0 });
    const after = fx.calls.slice(markB);
    expect(after.filter((c) => c.path.includes(stale.meetingId)).map((c) => c.route), "the stale sibling was ended at the vendor: kick-all, then the deactivate").toEqual([
      "POST /meetings/:id/active-session/kick-all",
      "PATCH /meetings/:id",
    ]);
    const roomsB = await roomsOf([fb]);
    expect(roomsB.map((m) => m.meeting_id), "its row is gone and a fresh room stands").not.toContain(stale.meetingId);
    expect(roomsB.map((m) => m.side)).toEqual(["away"]);
  });
});

// ─── Match Day O4, ruling MD-R16 (2026-11-20): a billing-frozen competition's unopened round is not pre-minted ───────────────────
// A frozen competition cannot open a round (402, open-round.ts), so a room made for it is vendor spend on a round that cannot start. The pass
// asks `frozenCompetitionIds` once per org and defers a frozen competition's rows - NOT a `frozen_at` predicate in the candidate SQL, because the
// mark is stored lazily (the first read that finds the org over its limit chooses and stores it). The deferred rows keep their place: they stay
// candidates (the sweep's teardown must not end the rooms already made for them), and the first pass after the freeze lifts makes them.
describe.skipIf(!DB)("premint pass - a billing-frozen competition's unopened round (MD-R16)", () => {
  /** Pin the org's `competitions.max_active` (the override the freeze sweeps use): a limit under the org's active count freezes the overflow. */
  async function setLimit(orgId: string, limit: number): Promise<void> {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value)
      values (${orgId}, 'competitions.max_active', ${limit})
      on conflict (org_id, feature_key) do update set int_value = ${limit}, bool_value = null`;
    await invalidateOrgEntitlements(orgId);
  }
  /** The create titles a pass makes for these boards: one per (board, side), the product's own naming (`seazn-fixture-<board>-<side>`). */
  const titles = (fixtureIds: string[]) => bothSides(fixtureIds).map((k) => titleFor({ fixtureId: k.split("/")[0]!, side: k.split("/")[1] as "home" | "away" })).sort();

  it("a frozen competition's rows are deferred while the same org's other competition and another org are made in the SAME pass; a second pass makes nothing more; once the freeze lifts the next pass makes them", async () => {
    const a = await seedRound(1); // the OLDER competition of its org: the one a limit of 1 freezes
    const b = await seedSecondOnlineRound(a, { scheduledAt: new Date("2026-10-01T12:00:00.000Z"), cameraPolicy: "optional" });
    const other = await seedRound(1); // another org, nothing frozen there
    const aIds = ids(a);
    const bIds = b.boards.map((x) => x.fixtureId);
    const otherIds = ids(other);
    const orgs = [a.orgId, other.orgId];

    // premise: three boards, both sides each, all candidates before anything is frozen (so "deferred" below is the freeze's doing)
    expect(keysOf(await rowsOf(orgs)).sort(), "premise: all three boards are candidates").toEqual(bothSides([...aIds, ...bIds, ...otherIds]).sort());
    expect(await frozenCompetitionIds(a.orgId), "premise: nothing is frozen yet").toEqual(new Set());

    await setLimit(a.orgId, 1);
    expect([...(await frozenCompetitionIds(a.orgId))], "premise: exactly the older competition is frozen").toEqual([a.competitionId]);
    expect(await frozenCompetitionIds(other.orgId), "premise: the other org has nothing frozen").toEqual(new Set());

    // the pass: a's two rows are deferred, the other four are made - one create per (board, side)
    const report = await run(orgs);
    expect(report).toEqual({ skipped: 0, disabled: 0, scanned: 6, roomsMade: 4, deferred: 2, failed: 0, windowsOpen: 0, failures: [] });
    expect(createsFor(aIds), "the frozen competition: no vendor call").toEqual([]);
    expect(await roomsOf(aIds), "the frozen competition: no room on file").toEqual([]);
    expect(createsFor(bIds).sort(), "the same org's other competition: made").toEqual(titles(bIds));
    expect(createsFor(otherIds).sort(), "the other org: made").toEqual(titles(otherIds));
    expect(await roomsOf(bIds), "b's rooms are on file").toHaveLength(2);

    // the SEQUENCE: still frozen, a second pass - the rows are still candidates, still deferred, and the vendor is still not asked
    const mark = fx.calls.length;
    expect(keysOf(await rowsOf(orgs)).sort(), "the deferred rows keep their place: still candidates").toEqual(bothSides(aIds).sort());
    expect(await run(orgs), "a second frozen pass").toMatchObject({ scanned: 2, roomsMade: 0, deferred: 2, failed: 0 });
    expect(fx.calls.length, "and it makes no vendor call at all").toBe(mark);

    // the freeze lifts: the next pass makes them
    await setLimit(a.orgId, 50);
    expect(await frozenCompetitionIds(a.orgId), "premise: the freeze has lifted").toEqual(new Set());
    expect(await run(orgs), "the pass after the thaw").toMatchObject({ scanned: 2, roomsMade: 2, deferred: 0, failed: 0 });
    expect(createsFor(aIds).sort(), "the thawed competition's rooms are made").toEqual(titles(aIds));
    expect(await roomsOf(aIds)).toHaveLength(2);
  }, 120_000);

  it("MD-R20: one org's freeze read failing defers ONLY that org's rows (fail closed: no vendor call for it, though nothing of it is frozen), logs the error once with its orgId, and the other org's rooms are made in the same pass; the next pass makes the deferred rooms", async () => {
    const a = await seedRound(1); // the org whose freeze read will fail: in quota, nothing frozen
    const b = await seedRound(1);
    const aIds = ids(a);
    const bIds = ids(b);
    expect(await frozenCompetitionIds(a.orgId), "premise: nothing of A is frozen, so a deferral below is the failed read's doing").toEqual(new Set());
    expect(keysOf(await rowsOf([a.orgId, b.orgId])).sort(), "premise: both boards are candidates").toEqual(bothSides([...aIds, ...bIds]).sort());

    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      freezeRead.failOrgs.add(a.orgId);
      const report = await run([a.orgId, b.orgId]);
      // A7 (gaps wave A): an org whose freeze cannot be read is a FAULT, not a quiet deferral - a competition that is merely frozen is a billing
      // state and stays `failed: 0`, but a read that keeps failing would defer an org's rooms for ever and page nobody. So it is ONE failure for
      // the org (its first row, code `freeze_unreadable`, which the Worker counts in `data.failed`) and the org's other rows are deferred;
      // `scanned = made + failed + deferred` still holds (4 = 2 + 1 + 1).
      expect(report, "the pass ran to its end: A's first row a failure and the rest deferred, B made").toMatchObject({ skipped: 0, disabled: 0, scanned: 4, roomsMade: 2, deferred: 1, failed: 1, windowsOpen: 0 });
      expect(report.failures, "ONE failure for the org, by code and never a message").toEqual([{ fixtureId: aIds[0], side: expect.stringMatching(/^(home|away)$/), code: "freeze_unreadable" }]);
      expect(report.scanned, "the ledger adds up").toBe(report.roomsMade + report.failed + report.deferred);
      expect(createsFor(aIds), "A: fail closed, no vendor call").toEqual([]);
      expect(await roomsOf(aIds), "A: no room on file").toEqual([]);
      expect(createsFor(bIds).sort(), "B: made").toEqual(titles(bIds));
      const own = logged.mock.calls.filter(([fields]) => (fields as { orgId?: string } | undefined)?.orgId === a.orgId);
      expect(own, "the error is logged ONCE for A (a row of the org each, memoised per pass), with its orgId").toHaveLength(1);
      expect(logged.mock.calls.filter(([fields]) => (fields as { orgId?: string } | undefined)?.orgId === b.orgId), "and not for B").toEqual([]);

      // the SEQUENCE: the read is still down - the next pass is the same one failure for A (it keeps paging until the read works), B's
      // rooms exist already so B has nothing to make
      const again = await run([a.orgId, b.orgId]);
      expect(again, "a second pass with the read still down").toMatchObject({ scanned: 2, roomsMade: 0, deferred: 1, failed: 1 });
      expect(again.failures.map((f) => f.code), "still the one failure, the same code").toEqual(["freeze_unreadable"]);
      expect(createsFor(aIds), "and still no vendor call for A").toEqual([]);

      // the read recovers: the deferred rows kept their place, the next pass makes them
      freezeRead.failOrgs.clear();
      expect(await run([a.orgId, b.orgId]), "the next pass").toMatchObject({ scanned: 2, roomsMade: 2, deferred: 0, failed: 0 });
      expect(createsFor(aIds).sort(), "A's rooms are made once the read works").toEqual(titles(aIds));
    } finally {
      logged.mockRestore();
    }
  }, 120_000);
});
