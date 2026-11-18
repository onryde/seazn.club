// P1 T9 (check-in capacity plan 1): the presence shadow report - the proof that webhook presence agrees with the seat's own
// vendor reads. Two halves:
//   1. the REAL producer: the fixture vendor emits signed webhooks whose deliverer IS the receiver (no HTTP, no hand-built body),
//      the seat (`seatPlayer`, the real adapter against the fixture) stamps `last_publisher_seen_at`, and `presenceShadowReport`
//      reads the two sides. Expected values come from the fixture's own record (`currentPeer`, `webhooks`, `webhookOutcomes`),
//      never from the receiver's output.
//   2. the SCRIPT'S COPY of the report's SQL (scripts/presence-shadow-report.ts: a root script cannot import `@/`, so it carries
//      its own): run against the same seed as the usecase and compared field by field, on a hand-built seed that exercises every
//      arm (participant match, custom-id match, source, tolerance edge, left-before-stamp, closed-by-end, scope).
//
// CLOCK: seatPlayer runs on the WALL clock (no deps.now). The seat stamps last_publisher_seen_at with its own now while the
// fixture stamps joins with the wall clock; a virtual clock would stamp seats before the real joins and read as missing with
// webhooks working. The pacing below therefore waits the real `cameraEvidenceDelayMs(k)` when a camera is still starting.
//
// Anti-vacuity (TEST-STRATEGY.md): every sweep reports how many items it checked and zero is a failure. Delivery counts are scoped
// to this file's own fixture uuids (CI runs DB files in parallel on one DB); webhook ARRIVAL ORDER is never asserted (the fixture
// delivers concurrently). Single-sport reason: presence is keyed by meeting, never by sport; chess is the only product that
// holds RealtimeKit meetings.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { cameraEvidenceDelayMs } from "@/components/public-site/match-room/room-snapshot";
import { currentBudgetKey } from "@/server/external-play/video/realtimekit";
import { currentPresence, peersOf, presenceShadowReport, SHADOW_ARRIVAL_TOLERANCE_MS, type ShadowReport } from "@/server/external-play/video/presence";
import { receiveRealtimeKitWebhook } from "@/server/external-play/video/webhook";
import { seatPlayer } from "../preflight";
import { REALTIMEKIT_FIXTURE_ENV, startRealtimeKitFixtureServer, type RealtimeKitFixtureServer } from "../../../../../e2e/realtimekit-fixture-server";
import { clearBucket, seedBoard, setBucket, type Board, type Side } from "../../__tests__/_external-play-line";
import { putVideoMeeting, putVideoParticipant } from "../../__tests__/_external-play-seed";
import {
  SHADOW_ARRIVAL_TOLERANCE_MS as SCRIPT_TOLERANCE_MS,
  run,
  shadowReportSql,
} from "../../../../../../../scripts/presence-shadow-report.ts";

const DB = !!process.env.DATABASE_URL;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SIDES: readonly Side[] = ["home", "away"];

let fx: RealtimeKitFixtureServer;
let bucketKey: string | null = null;
const uuidsMade: string[] = [];
const fixturesMade: string[] = [];

beforeAll(async () => {
  if (!DB) return;
  // Start the fixture with in-process delivery straight to the receiver. A non-200 receipt REJECTS, so the fixture records it as
  // "failed" (it catches every rejection); a storage failure is a rejection too, never an unhandled one.
  fx = await startRealtimeKitFixtureServer(0, {
    webhooks: async (w) => {
      const r = await receiveRealtimeKitWebhook({ rawBody: w.body, signature: w.signature, uuid: w.uuid }, { publicKey: async () => ({ key: fx.publicKeyPem, fetched: true }) });
      if (r.status !== 200) throw new Error(`receiver answered ${r.status}`);
    },
  });
});

beforeEach(async () => {
  if (!DB) return;
  await fx.reset();
  for (const [k, v] of Object.entries(REALTIMEKIT_FIXTURE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv("REALTIMEKIT_BASE_URL", fx.url);
  // The bucket the check-in line orders claims by is keyed by this base: fund it so nothing is held (no refill within the test).
  bucketKey = currentBudgetKey();
  if (bucketKey === null) throw new Error("RealtimeKit is not configured after the env stubs");
  await setBucket(bucketKey, 100_000, new Date(Date.now() + 3_600_000));
});

afterEach(async () => {
  if (!DB) return;
  await fx.webhooksSettled();
  uuidsMade.push(...fx.webhooks.map((w) => w.uuid));
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (DB) {
    await fx.close();
    if (bucketKey !== null) await clearBucket(bucketKey);
    if (uuidsMade.length > 0) await sql`delete from realtimekit_webhook_deliveries where rtk_uuid in ${sql(uuidsMade)}`;
    if (fixturesMade.length > 0) {
      await sql`delete from realtimekit_ended_sessions where meeting_id in (select meeting_id from fixture_video_presence where fixture_id in ${sql(fixturesMade)})`;
      await sql`delete from fixture_video_presence where fixture_id in ${sql(fixturesMade)}`;
    }
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});

type Seated = { side: Side; personId: string; participantId: string; meetingId: string };
type Scene = { board: Board; scope: { since: Date; fixtureIds: string[] }; players: Seated[] };

/** One player through the seat's own door: claim (mints the participant, answers the way in), join as the browser would
 *  (the fixture's one way to be present), claim again until seated, pacing a still-starting camera on the room's own schedule. */
async function seat(board: Board, side: Side): Promise<Seated> {
  const personId = board[side].personId;
  let participantId: string | null = null;
  let joined = false;
  let reads = 0;
  for (let claim = 1; claim <= 8; claim++) {
    const r = await seatPlayer({ fixtureId: board.fixtureId, personId, heldParticipantId: participantId });
    if (r.seated) {
      if (participantId === null) throw new Error("seated with no participant: the camera policy must be required");
      const [m] = await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id = ${board.fixtureId} and side = ${side}`;
      return { side, personId, participantId, meetingId: m!.meeting_id };
    }
    if ("participant" in r && r.participant) participantId ??= r.participant.participantId;
    if (r.reason === "camera_required" && participantId !== null && !joined) {
      fx.setLivePublisher(participantId, true);
      joined = true;
    } else if (r.reason === "camera_starting") {
      reads++;
      await sleep(cameraEvidenceDelayMs(reads));
    } else {
      throw new Error(`${side}: the seat answered ${r.reason} on claim ${claim}`);
    }
  }
  throw new Error(`${side}: not seated within 8 claims`);
}

async function scene(sides: readonly Side[] = SIDES): Promise<Scene> {
  const since = new Date(Date.now() - 5_000);
  const board = await seedBoard();
  fixturesMade.push(board.fixtureId);
  const players: Seated[] = [];
  for (const s of sides) players.push(await seat(board, s));
  return { board, scope: { since, fixtureIds: [board.fixtureId] }, players };
}

/** Every delivery the fixture started has settled, none was rejected, and each is `delivered`. Returns how many were checked. */
async function settled(): Promise<number> {
  await fx.webhooksSettled();
  expect(fx.lastWebhookError()).toBeUndefined();
  const mine = fx.webhooks.map((w) => w.uuid);
  for (const u of mine) expect(fx.webhookOutcomes.get(u), `delivery ${u}`).toBe("delivered");
  return mine.length;
}

const who = (p: Seated) => ({ meetingId: p.meetingId, participantId: p.participantId, customParticipantId: p.personId });

describe.skipIf(!DB)("presence shadow report, driven by the fixture vendor and the seat's own reads", () => {
  it("empty case: a scope with no seats verifies nothing (zero is reported, never a pass)", async () => {
    const r = await presenceShadowReport(sql, { since: new Date(Date.now() - 5_000), fixtureIds: [crypto.randomUUID()] });
    expect(r).toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0, joinLatencyMs: { p50: null, p95: null, n: 0 }, noEcho: 0 });
  });

  it("after two players are seated by the seat's own vendor reads, the presence table names both, and the shadow report has nothing missing", async () => {
    const s = await scene();
    const delivered = await settled();
    expect(delivered, "deliveries checked").toBeGreaterThan(0);
    // The deliveries ledger holds exactly this file's fixture uuids (scoped: another DB suite writes deliveries too).
    const mine = fx.webhooks.map((w) => w.uuid);
    const [rec] = await sql<{ n: number }[]>`select count(*)::int as n from realtimekit_webhook_deliveries where rtk_uuid in ${sql(mine)}`;
    expect(rec!.n).toBe(mine.length);

    const peers = new Set<string>();
    for (const p of s.players) {
      const cur = await currentPresence(sql, who(p));
      const atFixture = fx.currentPeer(p.participantId);
      expect(atFixture, `${p.side}: the fixture has a current peer`).not.toBeNull();
      expect(cur?.peerId, `${p.side}: the table's current peer is the fixture's`).toBe(atFixture);
      peers.add(atFixture!);
    }
    expect(peers.size).toBe(2);

    const r = await presenceShadowReport(sql, s.scope);
    expect(r.verified).toBe(2);
    expect(r.covered).toBe(2);
    expect(r.missing).toEqual([]);
    // Mid-round: `open` is READ, not gated - exactly the two live peers.
    expect(r.open.map((o) => o.peerId).sort()).toEqual([...peers].sort());
    expect(r.closedByEnded).toBe(0);
  }, 60_000);

  it("a reload: the second peer is current in the table exactly as at the fixture", async () => {
    const s = await scene(["home"]);
    const p = s.players[0]!;
    const first = fx.currentPeer(p.participantId)!;
    await sleep(25); // a reload is a later join: never the same millisecond as the first
    fx.setLivePublisher(p.participantId, true); // a new peer under the same row
    const second = fx.currentPeer(p.participantId)!;
    expect(second).not.toBe(first);
    expect(await settled(), "deliveries checked").toBeGreaterThan(0);

    expect((await currentPresence(sql, who(p)))?.peerId).toBe(second);
    const all = await peersOf(sql, who(p));
    expect(all.map((x) => x.peerId).sort()).toEqual([first, second].sort());
  }, 60_000);

  it("a leave: the table drops the peer exactly when the fixture does (the phantom direction)", async () => {
    const s = await scene(["home"]);
    const p = s.players[0]!;
    await settled();
    // the positive pair: before the leave the peer IS current and IS open
    expect((await currentPresence(sql, who(p)))?.peerId).toBe(fx.currentPeer(p.participantId));
    expect((await presenceShadowReport(sql, s.scope)).open).toHaveLength(1);

    await sleep(25); // the leave is later than the seat's stamp
    fx.setLivePublisher(p.participantId, false); // the last peer leaves: the fixture emits the leave, then the session's end
    expect(await settled(), "deliveries checked").toBeGreaterThanOrEqual(2);
    expect(fx.currentPeer(p.participantId)).toBeNull();
    expect(await currentPresence(sql, who(p))).toBeNull();

    // every meeting in scope has ended: `open` is empty and every closed row was closed by its own leave (the leave beats the end,
    // whichever arrived first)
    const r = await presenceShadowReport(sql, s.scope);
    expect(r.open).toEqual([]);
    expect(r.closedByEnded).toBe(0);
    expect(r.verified).toBe(1);
    expect(r.covered).toBe(1);
    const rows = await sql<{ left_by: string | null }[]>`select left_by from fixture_video_presence where fixture_id = ${s.board.fixtureId}`;
    expect(rows.length, "rows checked").toBeGreaterThan(0);
    for (const row of rows) expect(row.left_by).toBe("left");
  }, 60_000);

  it("with webhooks down the report shows both missing (the gate fails loudly, never vacuously)", async () => {
    fx.setWebhooksDown(true);
    const s = await scene();
    await fx.webhooksSettled();
    expect(fx.webhooks.length, "webhooks emitted").toBeGreaterThan(0);
    for (const w of fx.webhooks) expect(fx.webhookOutcomes.get(w.uuid)).toBe("down");

    const r = await presenceShadowReport(sql, s.scope);
    expect(r.verified).toBe(2);
    expect(r.covered).toBe(0);
    expect(r.missing).toHaveLength(2);
    expect(r.missing.map((m) => m.participantId).sort()).toEqual(s.players.map((p) => p.participantId).sort());
    expect(r.open).toEqual([]);
  }, 60_000);
});

// ─── the script: its copy of the SQL agrees with the usecase; its exit codes ───────────────────────────────────────────────

const iso = (d: Date) => d.toISOString();

type PresenceRow = {
  meetingId: string; peerId: string; participantId: string | null; custom: string; side: Side; fixtureId: string;
  joinedAt: Date; leftAt: Date | null; leftBy: "left" | "ended" | null; source: "webhook" | "read"; receivedAt: Date;
};
type StampedSeat = { b: Board; side: Side; meetingId: string; participantId: string; custom: string };

async function putPresence(r: PresenceRow): Promise<void> {
  await sql`
    insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, left_at, left_by, source, received_at)
    values (${r.meetingId}, ${r.peerId}, ${r.fixtureId}, ${r.side}, ${r.participantId}, ${r.custom}, 'sess-t9', ${r.joinedAt}, ${r.leftAt}, ${r.leftBy}, ${r.source}, ${r.receivedAt})`;
}

/** A player seat whose camera the seat's own read found on at `stamp` (its meeting and participant row are made here). */
async function stampedSeat(b: Board, side: Side, stamp: Date): Promise<StampedSeat> {
  const meetingId = await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side });
  const participantId = await putVideoParticipant({ fixtureId: b.fixtureId, side, personId: b[side].personId });
  await sql`update fixture_video_participants set last_publisher_seen_at = ${stamp} where fixture_id = ${b.fixtureId} and participant_id = ${participantId}`;
  return { b, side, meetingId, participantId, custom: b[side].personId };
}

/** A webhook row for `s`, naming its participant, open and received 4 s before `stamp`; `over` changes what a test is about. */
function rowFor(s: StampedSeat, stamp: Date, over: Partial<PresenceRow> & Pick<PresenceRow, "peerId">): PresenceRow {
  return {
    meetingId: s.meetingId, participantId: s.participantId, custom: s.custom, side: s.side, fixtureId: s.b.fixtureId,
    joinedAt: new Date(stamp.getTime() - 5_000), leftAt: null, leftBy: null, source: "webhook", receivedAt: new Date(stamp.getTime() - 4_000), ...over,
  };
}

/** Hand-built seed: four boards (three in scope), six scoped player seats, every arm of the report. `stamp` is every seat's
 *  last_publisher_seen_at. The decoy board D is OUT of scope and carries every kind of thing the report reads: a verified seat with no
 *  row (missing if read), an open row, and a row closed by the meeting's end after `since` - so an unscoped read differs on all of
 *  `missing`, `open` and `closedByEnded`. */
async function constructedSeed(): Promise<{
  scope: { since: Date; fixtureIds: string[] }; stamp: Date; decoy: string; decoyMeeting: string; allFixtures: string[];
}> {
  const stamp = new Date(Date.now() - 60_000);
  const at = (ms: number) => new Date(stamp.getTime() + ms);
  const row = (s: StampedSeat, over: Partial<PresenceRow> & Pick<PresenceRow, "peerId">) => rowFor(s, stamp, { joinedAt: at(-5_000), ...over });

  const A = await seedBoard();
  const B = await seedBoard();
  const C = await seedBoard();
  const D = await seedBoard(); // out of scope
  fixturesMade.push(A.fixtureId, B.fixtureId, C.fixtureId, D.fixtureId);
  const [aH, aA, bH, bA, cH, cA] = [
    await stampedSeat(A, "home", stamp), await stampedSeat(A, "away", stamp), await stampedSeat(B, "home", stamp),
    await stampedSeat(B, "away", stamp), await stampedSeat(C, "home", stamp), await stampedSeat(C, "away", stamp),
  ];
  await stampedSeat(D, "home", stamp); // verified, no rows: missing if an unscoped read counts it
  const decoyMeeting = await putVideoMeeting({ fixtureId: D.fixtureId, orgId: D.orgId, side: "away" });
  const decoyRow = (peerId: string, over: Partial<PresenceRow>): PresenceRow => ({
    meetingId: decoyMeeting, peerId, participantId: null, custom: D.away.personId, side: "away", fixtureId: D.fixtureId,
    joinedAt: at(-5_000), leftAt: null, leftBy: null, source: "webhook", receivedAt: at(-4_000), ...over,
  });

  const rows: PresenceRow[] = [
    // A home: a webhook row naming the participant, open at the stamp: covered, and open at report time
    row(aH, { peerId: "pA-h" }),
    // A home's reload: its OLD peer, closed by its own leave before the stamp. Not open, not closedByEnded; it makes the 'left' rows (this,
    // C home) outnumber the 'ended' ones (A away), so a count that read the wrong cause cannot land on 1 by luck
    row(aH, { peerId: "pA-h0", joinedAt: at(-9_000), receivedAt: at(-8_000), leftAt: at(-6_000), leftBy: "left" }),
    // A away: the row names NOBODY (its custom id matched no participant when it arrived) and is the seat's only through its custom id
    // in the seat's side (the readers' rule); closed by the meeting's end AFTER the stamp: covered, and the one closedByEnded
    row(aA, { peerId: "pA-a", participantId: null, leftAt: at(5_000), leftBy: "ended" }),
    // B home: a READ hint is not a webhook: missing
    row(bH, { peerId: "pB-h", source: "read" }),
    // B away: the webhook landed one second past the tolerance: missing
    row(bA, { peerId: "pB-a", receivedAt: at(SHADOW_ARRIVAL_TOLERANCE_MS + 1_000) }),
    // C home: the peer had LEFT before the stamp: missing (closed by its own leave, so not counted as closedByEnded)
    row(cH, { peerId: "pC-h", leftAt: at(-1_000), leftBy: "left" }),
    // C away: arrived exactly AT the tolerance edge: covered
    row(cA, { peerId: "pC-a", receivedAt: at(SHADOW_ARRIVAL_TOLERANCE_MS) }),
    // the decoy's: one open, one closed by the end after `since`
    decoyRow("pD-open", {}),
    decoyRow("pD-end", { receivedAt: at(-3_000), leftAt: at(5_000), leftBy: "ended" }),
  ];
  for (const r of rows) await putPresence(r);
  return {
    scope: { since: at(-30_000), fixtureIds: [A.fixtureId, B.fixtureId, C.fixtureId] }, stamp, decoy: D.fixtureId, decoyMeeting,
    allFixtures: [A.fixtureId, B.fixtureId, C.fixtureId, D.fixtureId],
  };
}

/** The NEGATIVE arms: each row below looks like a seat's row on every clause but ONE, so each must leave its seat missing, and the
 *  arbiter's stamp must not make it a verified seat. Every seat is missing, so a clause deleted from the SQL turns exactly one seat
 *  covered (or one extra seat verified). `left_at == stamp` is the boundary: a peer that left AT the stamp was not there. */
async function negativeSeed(): Promise<{
  scope: { since: Date; fixtureIds: string[] }; seats: StampedSeat[]; arbiterParticipantId: string; personIds: string[]; byArm: Record<string, StampedSeat>;
}> {
  const stamp = new Date(Date.now() - 60_000);
  const at = (ms: number) => new Date(stamp.getTime() + ms);
  const N1 = await seedBoard();
  const N2 = await seedBoard();
  fixturesMade.push(N1.fixtureId, N2.fixtureId);
  const n1h = await stampedSeat(N1, "home", stamp);
  const n1a = await stampedSeat(N1, "away", stamp);
  const n2h = await stampedSeat(N2, "home", stamp);
  const n2a = await stampedSeat(N2, "away", stamp);
  const arbiterParticipantId = await putVideoParticipant({ fixtureId: N2.fixtureId, side: "home", personId: null, preset: "arbiter" });
  await sql`update fixture_video_participants set last_publisher_seen_at = ${stamp} where fixture_id = ${N2.fixtureId} and participant_id = ${arbiterParticipantId}`;

  // (1) a DIFFERENT participant carries the seat's custom id: not the seat's row (the custom-id arm needs a row that names nobody)
  await putPresence(rowFor(n1h, stamp, { peerId: "nA", participantId: "pt-someone-else" }));
  // (2) a row naming nobody, the seat's custom id, on the OTHER side: not the seat's row
  await putPresence(rowFor(n1a, stamp, { peerId: "nB", participantId: null, side: "home", meetingId: n1h.meetingId }));
  // (3) a row naming nobody, the seat's custom id, on its side, but on ANOTHER FIXTURE
  await putPresence(rowFor(n2h, stamp, { peerId: "nC", participantId: null, side: "home", fixtureId: N1.fixtureId, meetingId: n1h.meetingId }));
  // (4) the seat's own row, but its peer left exactly AT the stamp
  await putPresence(rowFor(n2a, stamp, { peerId: "nE", leftAt: stamp, leftBy: "left", joinedAt: at(-9_000) }));
  return {
    scope: { since: at(-30_000), fixtureIds: [N1.fixtureId, N2.fixtureId] },
    seats: [n1h, n1a, n2h, n2a], arbiterParticipantId,
    personIds: [n1h, n1a, n2h, n2a].map((x) => x.custom),
    byArm: { differentParticipant: n1h, otherSide: n1a, otherFixture: n2h, leftAtStamp: n2a },
  };
}

describe.skipIf(!DB)("the script's copy of the report's SQL", () => {
  it("states the same arrival tolerance as the usecase, and both are the spec's 10 s (§6.3)", () => {
    expect(SCRIPT_TOLERANCE_MS).toBe(SHADOW_ARRIVAL_TOLERANCE_MS);
    expect(SCRIPT_TOLERANCE_MS).toBe(10_000);
  });

  it("agrees with the usecase on a hand-built seed that exercises every arm, and both give the answer the seed was built to give", async () => {
    const seed = await constructedSeed();
    const fromUsecase = await presenceShadowReport(sql, seed.scope);
    const fromScript = await shadowReportSql(sql, seed.scope);
    expect(fromScript).toEqual(fromUsecase);

    // what the seed was built to give (counted by hand from the seed's comments, not read off either function). The decoy board's rows
    // (an open one, a closed-by-end one, a seat with no rows) are in NONE of these numbers: that is the fixture scope on every query.
    expect(fromUsecase.verified, "seats checked").toBe(6);
    expect(fromUsecase.covered, "A home (participant), A away (custom-id arm), C away (the tolerance edge)").toBe(3);
    expect(fromUsecase.missing.map((m) => `${m.side}`).sort(), "B home (read), B away (late), C home (left before the stamp)").toEqual(["away", "home", "home"]);
    expect(fromUsecase.open, "A home, B home, B away, C away are open; A away and C home are closed").toHaveLength(4);
    expect(fromUsecase.closedByEnded, "A away").toBe(1);
    // spec §6.8 step 3 (I2), by hand from the rows' own stamps (received_at - joined_at over the WEBHOOK rows; pB-h is a read and the decoy
    // is out of scope): pA-h 1000, pA-h0 1000, pA-a 1000, pC-h 1000, pC-a 15000, pB-a 16000 -> sorted [1000 x4, 15000, 16000]; nearest
    // rank: p50 = the 3rd (1000), p95 = the ceil(5.7) = 6th (16000). A linear interpolation would give 15950 for p95, and a mean 5833.
    expect(fromUsecase.joinLatencyMs, "six webhook rows measured").toEqual({ p50: 1_000, p95: 16_000, n: 6 });
    expect(fromUsecase.noEcho, "pA-a names no participant; every other scoped row names one, and the decoy's two (which name none) are out of scope").toBe(1);
    // the missing seats carry the seat's own stamp
    for (const m of fromScript.missing) expect(m.seenAt).toEqual(seed.stamp);
  }, 60_000);

  it("scopes the same way: the decoy's seat, open row and ended row are read only by an UNSCOPED run; an empty list is an empty scope; a later `since` cuts the seats", async () => {
    const seed = await constructedSeed();
    const scoped = await shadowReportSql(sql, seed.scope);
    // the scoped answer does not move because of the decoy (the pinned numbers of the previous test, re-read through the script)
    expect(scoped.missing.some((m) => m.fixtureId === seed.decoy)).toBe(false);
    expect(scoped.open.some((o) => o.meetingId === seed.decoyMeeting)).toBe(false);
    expect(scoped.open).toHaveLength(4);
    expect(scoped.closedByEnded).toBe(1);

    // unscoped: all three fields see the decoy (>= for the count: a shared DB may hold other suites' rows)
    const unscoped = await shadowReportSql(sql, { since: seed.scope.since });
    expect(unscoped.missing.some((m) => m.fixtureId === seed.decoy), "decoy seat read by an unscoped run").toBe(true);
    expect(unscoped.open.some((o) => o.meetingId === seed.decoyMeeting), "decoy open row read by an unscoped run").toBe(true);
    expect(unscoped.closedByEnded).toBeGreaterThanOrEqual(scoped.closedByEnded + 1);

    // script == usecase unscoped, compared on THIS seed's fixtures and meetings only (another suite may write between the two reads)
    const meetings = new Set((await sql<{ meeting_id: string }[]>`select meeting_id from fixture_video_meetings where fixture_id in ${sql(seed.allFixtures)}`).map((r) => r.meeting_id));
    const mine = (r: ShadowReport) => ({
      missing: r.missing.filter((m) => seed.allFixtures.includes(m.fixtureId)),
      open: r.open.filter((o) => meetings.has(o.meetingId)),
    });
    const theirs = mine(await presenceShadowReport(sql, { since: seed.scope.since }));
    const ours = mine(unscoped);
    expect(ours).toEqual(theirs);
    expect(ours.missing.length + ours.open.length, "seed items compared").toBe(4 + 5);

    expect(await shadowReportSql(sql, { ...seed.scope, fixtureIds: [] })).toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0, joinLatencyMs: { p50: null, p95: null, n: 0 }, noEcho: 0 });
    const later = { ...seed.scope, since: new Date(seed.stamp.getTime() + 1_000) };
    expect(await shadowReportSql(sql, later)).toEqual(await presenceShadowReport(sql, later));
    expect((await shadowReportSql(sql, later)).verified).toBe(0);
  }, 60_000);

  it("the negative arms: a row that differs from the seat's on ONE clause never covers it, and an arbiter's stamp is not a verified seat", async () => {
    const seed = await negativeSeed();
    const fromUsecase = await presenceShadowReport(sql, seed.scope);
    const fromScript = await shadowReportSql(sql, seed.scope);
    expect(fromScript).toEqual(fromUsecase);
    // counted by hand from negativeSeed: four player seats, none covered; the arbiter (also stamped) is not among them
    expect(fromScript.verified, "player seats only (the arbiter is stamped too)").toBe(4);
    expect(fromScript.covered).toBe(0);
    const missingBy = new Set(fromScript.missing.map((m) => m.participantId));
    expect(missingBy.size).toBe(4);
    let checked = 0;
    for (const [arm, seat] of Object.entries(seed.byArm)) {
      expect(missingBy.has(seat.participantId), `${arm}: the seat is missing`).toBe(true);
      checked++;
    }
    expect(checked, "arms checked").toBe(4);
    expect(missingBy.has(seed.arbiterParticipantId)).toBe(false);
    // the three rows that are open are still READ as open: negative arms leave the other fields to their own rules
    expect(fromScript.open.map((o) => o.peerId).sort()).toEqual(["nA", "nB", "nC"]);
    expect(fromScript.closedByEnded).toBe(0);
  }, 60_000);

  it("agrees with the usecase on a real-producer seed too (one player left, one still in)", async () => {
    const s = await scene();
    await settled();
    await sleep(25);
    fx.setLivePublisher(s.players[0]!.participantId, false); // only HOME leaves: its meeting ends, AWAY's stays live
    await settled();
    const fromUsecase = await presenceShadowReport(sql, s.scope);
    const fromScript = await shadowReportSql(sql, s.scope);
    expect(fromScript).toEqual(fromUsecase);
    expect(fromScript.verified).toBe(2);
    expect(fromScript.covered).toBe(2);
    expect(fromScript.open, "away is still in the room").toHaveLength(1);
  }, 60_000);

  describe("--strict (the staging gate)", () => {
    const lines = () => {
      const out: string[] = [];
      return { out, say: (l: string) => void out.push(l), json: () => JSON.parse(out.join("\n")) as ShadowReport & { strict?: { pass: boolean; reasons: string[] } } };
    };
    const sinceArg = (s: Scene) => ["--since", iso(s.scope.since), "--fixture", s.board.fixtureId];

    it("exit 0 on the green quiescent seed, 1 with webhooks down, 1 on an EMPTY scope (a fixture id with no seats: verified 0)", async () => {
      // green: both players seated, both left (every meeting ended)
      const green = await scene();
      await sleep(25);
      for (const p of green.players) fx.setLivePublisher(p.participantId, false);
      await settled();
      const g = lines();
      expect(await run(["--strict", ...sinceArg(green)], { sql, out: g.say })).toBe(0);
      expect(g.json()).toMatchObject({ verified: 2, covered: 2, missing: [], open: [], closedByEnded: 0, blocksProofFlag: false, strict: { pass: true, reasons: [] } });
      expect(g.json(), "no note when nothing blocks the proof flag").not.toHaveProperty("note");

      // webhooks down: both seats missing
      fx.setWebhooksDown(true);
      const down = await scene();
      const d = lines();
      expect(await run(["--strict", ...sinceArg(down)], { sql, out: d.say })).toBe(1);
      expect(d.json().verified).toBe(2);
      expect(d.json().missing).toHaveLength(2);
      expect(d.json().strict?.pass).toBe(false);

      // empty scope: nothing to verify is a failure, never a pass
      const e = lines();
      expect(await run(["--strict", "--since", iso(new Date(Date.now() - 5_000)), "--fixture", crypto.randomUUID()], { sql, out: e.say })).toBe(1);
      expect(e.json().verified).toBe(0);
      expect(e.json().strict?.reasons.join(" ")).toMatch(/verified 0/);
      // ...and the same empty scope without --strict reports and exits 0 (the report is not the gate)
      const e2 = lines();
      expect(await run(["--since", iso(new Date(Date.now() - 5_000)), "--fixture", crypto.randomUUID()], { sql, out: e2.say })).toBe(0);
    }, 120_000);

    it("exit 1 on an open row (a phantom at a quiescent scope), 0 without --strict; closedByEnded is always printed", async () => {
      const s = await scene(["home"]); // mid-round: the peer is still in
      await settled();
      const strict = lines();
      expect(await run(["--strict", ...sinceArg(s)], { sql, out: strict.say })).toBe(1);
      expect(strict.json().open).toHaveLength(1);
      const plain = lines();
      expect(await run(sinceArg(s), { sql, out: plain.say })).toBe(0);
      const printed = plain.json();
      expect(printed.open).toHaveLength(1);
      expect(printed, "closedByEnded is always in the printed report").toHaveProperty("closedByEnded", 0);
    }, 60_000);

    it("--since wins over --since-hours; --since-hours defaults to 24 and counts back from the injected clock; --fixture repeats", async () => {
      const now = new Date("2026-11-17T12:00:00.000Z");
      const probe = async (argv: string[]) => {
        const l = lines();
        const code = await run(argv, { sql, out: l.say, now: () => now });
        return { code, body: l.json() as unknown as { since: string; fixtureIds: string[] | null } };
      };
      const none = crypto.randomUUID();
      const other = crypto.randomUUID();
      const checked: string[] = [];
      for (const [argv, since] of [
        [["--fixture", none], "2026-11-16T12:00:00.000Z"],
        [["--since-hours", "2", "--fixture", none], "2026-11-17T10:00:00.000Z"],
        [["--since", "2026-11-17T08:30:00.000Z", "--since-hours", "2", "--fixture", none], "2026-11-17T08:30:00.000Z"],
        [["--since", "2026-11-17T09:30:00+01:00", "--fixture", none], "2026-11-17T08:30:00.000Z"],
      ] as const) {
        const r = await probe([...argv]);
        expect(r.code).toBe(0);
        expect(r.body.since).toBe(since);
        checked.push(since);
      }
      expect(checked, "since resolutions checked").toHaveLength(4);
      const both = await probe(["--fixture", none, "--fixture", other]);
      expect(both.body.fixtureIds).toEqual([none, other]);
      expect((await probe([])).body.fixtureIds, "no --fixture is an unscoped run").toBeNull();
    });

    it("usage errors exit 2 and run no query", async () => {
      const cases: string[][] = [
        ["--since"],
        ["--since", "not-a-date"],
        ["--since", "2026-11-17T08:30:00"], // no zone: the operator's local time
        ["--since", "2026-11-17T08:30"],
        ["--since", "2026-11-17"],
        ["--since", "2026-11-17 08:30:00Z"],
        ["--since-hours", "0"],
        ["--since-hours", "abc"],
        ["--fixture", "not-a-uuid"],
        ["--nonsense"],
      ];
      let seen = 0;
      for (const argv of cases) {
        const l = lines();
        const boom = new Proxy(sql, { get: () => { throw new Error("a usage error must not touch the database"); }, apply: () => { throw new Error("a usage error must not touch the database"); } }) as typeof sql;
        expect(await run(argv, { sql: boom, out: l.say }), argv.join(" ")).toBe(2);
        expect(l.out.join("\n")).toMatch(/Usage/);
        seen++;
      }
      expect(seen).toBe(cases.length);
    });

    it("a zoneless --since is refused with a message naming the zone, and is never read as local time (the same wall time with Z is accepted)", async () => {
      const l = lines();
      expect(await run(["--since", "2026-11-17T08:30:00"], { sql, out: l.say })).toBe(2);
      expect(l.out.join("\n")).toMatch(/Z or an offset/);
      const ok = lines();
      expect(await run(["--since", "2026-11-17T08:30:00Z", "--fixture", crypto.randomUUID()], { sql, out: ok.say })).toBe(0);
    });

    it("closedByEnded > 0 prints blocksProofFlag and a note naming the proof flag and plan 1 Task 12 step 5, and never changes the exit code", async () => {
      // a CLEAN quiescent seed (verified 1, covered 1, nothing open) whose only row was closed by the meeting's end
      const stamp = new Date(Date.now() - 60_000);
      const K = await seedBoard();
      fixturesMade.push(K.fixtureId);
      const k = await stampedSeat(K, "home", stamp);
      await putPresence(rowFor(k, stamp, { peerId: "pK", leftAt: new Date(stamp.getTime() + 5_000), leftBy: "ended" }));
      const args = ["--since", iso(new Date(stamp.getTime() - 30_000)), "--fixture", K.fixtureId];

      const strict = lines();
      expect(await run(["--strict", ...args], { sql, out: strict.say }), "strict stays green").toBe(0);
      expect(strict.json()).toMatchObject({ verified: 1, covered: 1, missing: [], open: [], closedByEnded: 1, blocksProofFlag: true, strict: { pass: true, reasons: [] } });
      const body = strict.json() as unknown as { note: string };
      expect(body.note).toMatch(/EXTERNAL_PLAY_PRESENCE_PROOF/);
      expect(body.note).toMatch(/plan 1 Task 12 step 5/);

      const plain = lines();
      expect(await run(args, { sql, out: plain.say })).toBe(0);
      expect(plain.json()).toHaveProperty("blocksProofFlag", true);
    }, 60_000);

    it("reads in ONE repeatable-read transaction: `set transaction read only` and a 30 s statement timeout first, then exactly the report's three selects", async () => {
      const seen: string[] = [];
      let opts: unknown = null;
      let begun = 0;
      const record = (tx: typeof sql) =>
        new Proxy(tx, {
          apply: (target, thisArg, args: unknown[]) => {
            const strings = args[0];
            seen.push(Array.isArray(strings) ? strings.join("?").replace(/\s+/g, " ").trim().toLowerCase() : "(not a template)");
            return Reflect.apply(target, thisArg, args);
          },
        });
      const spy = new Proxy(sql, {
        get: (target, prop, receiver) => {
          if (prop !== "begin") return Reflect.get(target, prop, receiver) as unknown;
          return (o: string, fn: (tx: typeof sql) => unknown) => {
            begun++;
            opts = o;
            return (target.begin as unknown as (o: string, f: (tx: typeof sql) => unknown) => unknown)(o, (tx) => fn(record(tx as typeof sql)));
          };
        },
      }) as typeof sql;
      const l = lines();
      expect(await run(["--since", "2026-11-17T08:30:00Z", "--fixture", crypto.randomUUID()], { sql: spy, out: l.say })).toBe(0);
      expect(begun, "transactions opened").toBe(1);
      expect(opts).toMatch(/repeatable read/);
      expect(seen[0]).toBe("set transaction read only");
      expect(seen[1]).toBe("set local statement_timeout = '30s'");
      expect(seen.slice(2), "the report's statements, in the same transaction").toHaveLength(3);
      for (const q of seen.slice(2)) expect(q.startsWith("select")).toBe(true);
    });

    it("a database failure prints ONE line (the code and the first line of the message, no stack) and exits 2", async () => {
      const down = {
        begin: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1\n    at TCPConnectWrap.afterConnect (node:net:1)"), { code: "ECONNREFUSED" })),
      } as unknown as typeof sql;
      const l = lines();
      expect(await run(["--since", "2026-11-17T08:30:00Z"], { sql: down, out: l.say })).toBe(2);
      expect(l.out, "one out call").toHaveLength(1);
      expect(l.out[0]).toMatch(/ECONNREFUSED/);
      expect(l.out[0]).not.toMatch(/\n|\bat TCPConnectWrap/);
    });

    it("the printed report names seats by participant and rows by meeting and peer, and never a person or a custom participant id", async () => {
      const seed = await negativeSeed();
      const l = lines();
      expect(await run(["--since", iso(seed.scope.since), ...seed.scope.fixtureIds.flatMap((f) => ["--fixture", f])], { sql, out: l.say }), "plain run exits 0").toBe(0);
      const text = l.out.join("\n");
      // the positive pair: the output really does carry the rows (a leak check on an empty output would pass vacuously)
      for (const seat of seed.seats) expect(text).toContain(seat.participantId);
      expect(text).toContain("nA");
      let checked = 0;
      for (const personId of seed.personIds) {
        expect(text, `person/custom id ${personId}`).not.toContain(personId);
        checked++;
      }
      expect(checked, "ids checked").toBe(4);
    }, 60_000);
  });
});
