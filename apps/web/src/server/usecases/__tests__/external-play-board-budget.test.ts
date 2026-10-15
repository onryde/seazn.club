// D16 (design §5.6.8) - the vendor-call budget of ONE board's whole life, with a meeting per player.
//
// The spec's table gives the cost of a Required board in RealtimeKit REST calls. This drives one board through its life with
// the REAL seat, the REAL teardown and the REAL evidence read against the RealtimeKit fixture server (e2e/realtimekit-
// fixture-server.ts), and compares what the FIXTURE counted - never what the code thinks it asked - with the table's formula
// for the board's actual `k`:
//
//   - meeting create:                    2   (one per player, each in that player's minting claim)
//   - per player: the mint 1, k reads of 3, the token handed with the seat 1:   3k + 2
//   - T9's re-verify, inside the 10 s trust window:                              0
//   - teardown, per meeting (kick-all, INACTIVE):                                2 each, 4
//   - evidence, per meeting the sessions list, per player the peer ids and one peer report:  2 x (1 + 2) = 6
//
// The two players deliberately have DIFFERENT k (1 and 4), so the formula's answer (31) differs from "k = 2 each" (28) and
// from any constant: a cost that is not linear in k, or a player counted twice, cannot hide in a symmetric board. Expected
// values are typed here from the spec and the ruling's back-off table (1, 2, 4, 8 s: reads fall at 0, 1, 3, 7 s) - nothing
// is read back from the code under test. Anti-vacuity: each phase reports its counts and the whole life is compared too.
//
// Not driven here: T9's create itself (the Lichess fixture) - its re-verify is driven through the seat, and the call SHAPE
// create-game uses is pinned in external-play-create-game.test.ts. The arbiter pane is 0 here (no arbiter) and priced in
// arbiter.test.ts. Single sport, deliberately: online play exists only for boardgame.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
import { sql } from "@/lib/db";
import {
  REALTIMEKIT_FIXTURE_ENV,
  startRealtimeKitFixtureServer,
  type RealtimeKitFixtureServer,
} from "../../../../e2e/realtimekit-fixture-server";
import { seatPlayer, type SeatResult } from "../external-play/preflight";
import { CAMERA_EVIDENCE_AFTER_MS, sweepExternalPlay } from "../external-play/sweep";
import { endMeeting } from "@/server/external-play/video/realtimekit";
import { seedOnlineChessFixture } from "./_external-play-seed";

const DB = !!process.env.DATABASE_URL;

let fx: RealtimeKitFixtureServer;
beforeAll(async () => {
  fx = await startRealtimeKitFixtureServer(0);
});
afterAll(async () => {
  await fx.close();
  if (DB) await sql.end();
});
beforeEach(() => {
  fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── The table (spec 5.6.8), typed ───────────────────────────────────────────────────────────────────────────────────
const READ = 3; //                   live session, its participants, the peer report
const MINT = 1; //                   add the participant (its token comes with it)
const TOKEN = 1; //                  the token handed with the seat
const PLAYERS = 2;
const costOfPlayer = (k: number) => MINT + READ * k + TOKEN; // 3k + 2
const CREATES = PLAYERS * 1; //      a meeting per player
const RECHECK_IN_TRUST = 0;
const TEARDOWN_PER_MEETING = 2; //   kick-all, then INACTIVE
const EVIDENCE_PER_MEETING = 1; //   the sessions list
const EVIDENCE_PER_PLAYER = 2; //    the peer ids, one peer report
const formula = (ks: readonly [number, number]) =>
  CREATES + costOfPlayer(ks[0]) + costOfPlayer(ks[1]) + RECHECK_IN_TRUST + PLAYERS * TEARDOWN_PER_MEETING + PLAYERS * (EVIDENCE_PER_MEETING + EVIDENCE_PER_PLAYER);

/** The ruling's back-off: after the first read wait 1 s, then 2, then 4 - so a starting camera is read at second 0, 1, 3, 7. */
const READS_AT_S = [0, 1, 3, 7] as const;

async function seed() {
  const opened = new Date(Date.now() - 5 * 60_000);
  return seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: new Date(opened.getTime() + 10 * 60_000),
    linked: true,
    roundOpenedAt: opened,
    cameraPolicy: "required",
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type Side = "home" | "away";

const claim = (s: Seeded, side: Side, now: Date, held: string | null = null, recheck = false) =>
  seatPlayer({ fixtureId: s.fixtureId, personId: s[side].personId, heldParticipantId: held, ...(recheck ? { recheck: true } : {}) }, { now });
const reasonOf = (r: SeatResult) => (r.seated ? "seated" : r.reason);
const tokenOf = (r: SeatResult) => ("participant" in r ? r.participant : null);
const routes = (from = 0) => fx.calls.slice(from).map((c) => c.route);
const count = (route: string, from = 0) => routes(from).filter((r) => r === route).length;

describe.skipIf(!DB)("one board's whole life costs what the table says, for the board's actual k (D16, 5.6.8)", () => {
  it("check-in, re-verify, teardown and evidence: the fixture's own count equals the formula for k = (1, 4)", async () => {
    const s = await seed();
    const KS = [1, 4] as const; // home reads once and seats; away's camera starts late and is read four times
    const phase: Record<string, number> = {};

    // ── Check-in ─────────────────────────────────────────────────────────────────────────────────────────────────────
    // Each player's MINTING claim: their own meeting and their participant, nothing read.
    const t0 = Date.now();
    const mint = { home: await claim(s, "home", new Date(t0)), away: await claim(s, "away", new Date(t0)) };
    expect([reasonOf(mint.home), reasonOf(mint.away)], "premise: nobody has joined, so the minting claim is a refusal with a token").toEqual(["camera_required", "camera_required"]);
    expect(routes(), "the minting claims: a meeting and a participant each, and nothing read").toEqual([
      "POST /meetings", "POST /meetings/:id/participants", "POST /meetings", "POST /meetings/:id/participants",
    ]);
    const pid = { home: tokenOf(mint.home)!.participantId, away: tokenOf(mint.away)!.participantId };
    expect(fx.participant(pid.home)!.meetingId, "a meeting EACH").not.toBe(fx.participant(pid.away)!.meetingId);
    phase.minting = fx.calls.length;

    // Home's camera is on from the join: ONE read, which seats, and the token handed with the seat.
    fx.setLivePublisher(pid.home, true, { camera: "on" });
    // Away's camera is still starting: a claim every second for 8 s from a browser holding its token. The reads fall on the
    // ruling's schedule; the claims between them cost nothing.
    fx.setLivePublisher(pid.away, true, { camera: "pending" });
    const after = Date.now();
    const at = (s_: number) => new Date(after + s_ * 1_000);

    const before = fx.calls.length;
    expect(reasonOf(await claim(s, "home", at(0), pid.home)), "home: one read finds the camera on").toBe("seated");
    const homeCalls = fx.calls.length - before;
    expect(homeCalls, "home's reading claim: the read (3) and the token handed with the seat (1)").toBe(READ * KS[0] + TOKEN);

    const awayFrom = fx.calls.length;
    const answers: string[] = [];
    for (let t = 0; t <= READS_AT_S[3]; t += 1) {
      if (t === READS_AT_S[3]) fx.reportCamera(pid.away, "on"); // the late report arrives before the fourth read
      answers.push(reasonOf(await claim(s, "away", at(t), pid.away)));
    }
    expect(answers, "away starts, is waited on, and is seated by the fourth read").toEqual([
      ...Array<string>(READS_AT_S[3]).fill("camera_starting"), "seated",
    ]);
    const awayReads = count("GET /meetings/:id/active-session", awayFrom);
    expect(awayReads, "the reads the FIXTURE saw: k = 4, on the ruling's schedule (0, 1, 3, 7 s) - 8 claims, 4 reads").toBe(KS[1]);
    expect(fx.calls.length - awayFrom, "away's reading claims: 3 per read, and the token only with the seat").toBe(READ * KS[1] + TOKEN);
    phase.checkIn = fx.calls.length;

    // T9's re-verify before the game is created: both passes were read within the 10 s trust window.
    const recheckFrom = fx.calls.length;
    expect([reasonOf(await claim(s, "home", at(8), null, true)), reasonOf(await claim(s, "away", at(8), null, true))]).toEqual(["seated", "seated"]);
    expect(fx.calls.length - recheckFrom, "the re-verify inside the trust window makes no vendor call").toBe(RECHECK_IN_TRUST);

    const afterCheckIn = fx.calls.length;
    expect(afterCheckIn, "the check-in phase in all: creates + both players' 3k + 2").toBe(CREATES + costOfPlayer(KS[0]) + costOfPlayer(KS[1]));

    // ── The game and its end ──────────────────────────────────────────────────────────────────────────────────────────
    // The bridge row a played-and-finished game leaves (created by T9/T10/T11, which have their own tests): the window the
    // evidence is judged over starts before the cameras joined and ends now.
    const startedAt = new Date(t0 - 1_000);
    await sql`
      insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, status, challenge_id, white_side, started_at, finished_at)
      values (${s.fixtureId}, ${s.orgId}, now(), 'finished', ${`budget-${s.fixtureId.slice(0, 8)}`}, 'home', ${startedAt}, now())`;

    const sweepDeps = {
      orgIds: [s.orgId],
      serialise: false as const, // other files' passes hold the advisory lock; this pass is scoped to this board's org
      endMeeting: (id: string) => endMeeting(id),
      createGameIfReady: async () => ({ created: false as const, reason: "not_ready" as const }),
      reconcile: async () => null,
    };
    const teardownFrom = fx.calls.length;
    const torn = await sweepExternalPlay({ ...sweepDeps, now: new Date() });
    expect(torn.meetingsEnded, "the sweep tore BOTH rooms down").toBe(PLAYERS);
    expect(fx.calls.length - teardownFrom, "teardown: kick-all and INACTIVE per meeting").toBe(PLAYERS * TEARDOWN_PER_MEETING);
    expect(count("POST /meetings/:id/active-session/kick-all", teardownFrom), "one kick-all per meeting").toBe(PLAYERS);
    expect(count("PATCH /meetings/:id", teardownFrom), "one deactivate per meeting").toBe(PLAYERS);
    phase.teardown = fx.calls.length - teardownFrom;

    // ── The evidence, two minutes after the rooms ended ──────────────────────────────────────────────────────────────
    fx.setReportsFinal(true); // the peers have left, so their reports finalise
    const evidenceFrom = fx.calls.length;
    const judged = await sweepExternalPlay({ ...sweepDeps, now: new Date(Date.now() + CAMERA_EVIDENCE_AFTER_MS + 60_000) });
    expect(judged.cameraSettled, "both rooms' evidence settled in one pass").toBe(PLAYERS);
    expect(judged.failures.filter((f) => f.job === "camera_evidence"), "nothing failed").toEqual([]);
    expect(count("GET /sessions", evidenceFrom), "one sessions list per meeting").toBe(PLAYERS * EVIDENCE_PER_MEETING);
    expect(count("GET /sessions/:id/participants", evidenceFrom), "per player the peer ids").toBe(PLAYERS);
    expect(count("GET /sessions/peer-report/:peer", evidenceFrom), "and one peer report").toBe(PLAYERS);
    expect(fx.calls.length - evidenceFrom, "evidence: 2 x (1 + 2)").toBe(PLAYERS * (EVIDENCE_PER_MEETING + EVIDENCE_PER_PLAYER));
    phase.evidence = fx.calls.length - evidenceFrom;

    // ── The whole life ───────────────────────────────────────────────────────────────────────────────────────────────
    const total = fx.calls.length;
    expect(total, `the whole board: the fixture's own count against the table's formula for k = (${KS.join(", ")}) - ${JSON.stringify(phase)}`).toBe(formula(KS));
    expect(formula(KS), "premise: the board's k matters - the symmetric 'k = 2 each' figure of the spec's example is not this board's").not.toBe(formula([2, 2]));
    expect(formula([2, 2]), "and the spec's own example sums to 28").toBe(28);
    expect(formula(KS)).toBe(31);
  });
});
