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
    expect(r).toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0 });
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

/** Hand-built seed: three boards, six player seats, every arm of the report. `stamp` is every seat's last_publisher_seen_at. */
async function constructedSeed(): Promise<{ scope: { since: Date; fixtureIds: string[] }; stamp: Date; decoy: string }> {
  const stamp = new Date(Date.now() - 60_000);
  const at = (ms: number) => new Date(stamp.getTime() + ms);
  type Row = { meetingId: string; peerId: string; participantId: string | null; custom: string; side: Side; fixtureId: string } & {
    joinedAt: Date; leftAt: Date | null; leftBy: "left" | "ended" | null; source: "webhook" | "read"; receivedAt: Date;
  };
  const rows: Row[] = [];
  const seatOf = async (b: Board, side: Side) => {
    const meetingId = await putVideoMeeting({ fixtureId: b.fixtureId, orgId: b.orgId, side });
    const participantId = await putVideoParticipant({ fixtureId: b.fixtureId, side, personId: b[side].personId });
    await sql`update fixture_video_participants set last_publisher_seen_at = ${stamp} where fixture_id = ${b.fixtureId} and participant_id = ${participantId}`;
    return { b, side, meetingId, participantId, custom: b[side].personId };
  };
  const row = (s: Awaited<ReturnType<typeof seatOf>>, over: Partial<Row> & Pick<Row, "peerId" | "receivedAt">): Row => ({
    meetingId: s.meetingId, participantId: s.participantId, custom: s.custom, side: s.side, fixtureId: s.b.fixtureId,
    joinedAt: at(-5_000), leftAt: null, leftBy: null, source: "webhook", ...over,
  });

  const A = await seedBoard();
  const B = await seedBoard();
  const C = await seedBoard();
  const D = await seedBoard(); // out of scope: a verified seat with NO rows, which an unscoped read would count as missing
  fixturesMade.push(A.fixtureId, B.fixtureId, C.fixtureId, D.fixtureId);
  const [aH, aA, bH, bA, cH, cA] = [await seatOf(A, "home"), await seatOf(A, "away"), await seatOf(B, "home"), await seatOf(B, "away"), await seatOf(C, "home"), await seatOf(C, "away")];
  await seatOf(D, "home");

  rows.push(
    // A home: a webhook row naming the participant, open at the stamp: covered, and open at report time
    row(aH, { peerId: "pA-h", receivedAt: at(-4_000) }),
    // A home's reload: its OLD peer, closed by its own leave before the stamp. Not open, not closedByEnded; it makes the 'left' rows (this,
    // C home) outnumber the 'ended' ones (A away), so a count that read the wrong cause cannot land on 1 by luck
    row(aH, { peerId: "pA-h0", joinedAt: at(-9_000), receivedAt: at(-8_000), leftAt: at(-6_000), leftBy: "left" }),
    // A away: the row names NOBODY (its custom id matched no participant when it arrived) and is the seat's only through its custom id
    // in the seat's side (the readers' rule); closed by the meeting's end AFTER the stamp: covered, and the one closedByEnded
    row(aA, { peerId: "pA-a", participantId: null, receivedAt: at(-4_000), leftAt: at(5_000), leftBy: "ended" }),
    // B home: a READ hint is not a webhook: missing
    row(bH, { peerId: "pB-h", source: "read", receivedAt: at(-4_000) }),
    // B away: the webhook landed one second past the tolerance: missing
    row(bA, { peerId: "pB-a", receivedAt: at(SHADOW_ARRIVAL_TOLERANCE_MS + 1_000) }),
    // C home: the peer had LEFT before the stamp: missing (closed by its own leave, so not counted as closedByEnded)
    row(cH, { peerId: "pC-h", receivedAt: at(-4_000), leftAt: at(-1_000), leftBy: "left" }),
    // C away: arrived exactly AT the tolerance edge: covered
    row(cA, { peerId: "pC-a", receivedAt: at(SHADOW_ARRIVAL_TOLERANCE_MS) }),
  );
  for (const r of rows) {
    await sql`
      insert into fixture_video_presence (meeting_id, peer_id, fixture_id, side, participant_id, custom_participant_id, session_id, joined_at, left_at, left_by, source, received_at)
      values (${r.meetingId}, ${r.peerId}, ${r.fixtureId}, ${r.side}, ${r.participantId}, ${r.custom}, 'sess-t9', ${r.joinedAt}, ${r.leftAt}, ${r.leftBy}, ${r.source}, ${r.receivedAt})`;
  }
  return { scope: { since: at(-30_000), fixtureIds: [A.fixtureId, B.fixtureId, C.fixtureId] }, stamp, decoy: D.fixtureId };
}

describe.skipIf(!DB)("the script's copy of the report's SQL", () => {
  it("states the same arrival tolerance as the usecase", () => {
    expect(SCRIPT_TOLERANCE_MS).toBe(SHADOW_ARRIVAL_TOLERANCE_MS);
  });

  it("agrees with the usecase on a hand-built seed that exercises every arm, and both give the answer the seed was built to give", async () => {
    const seed = await constructedSeed();
    const fromUsecase = await presenceShadowReport(sql, seed.scope);
    const fromScript = await shadowReportSql(sql, seed.scope);
    expect(fromScript).toEqual(fromUsecase);

    // what the seed was built to give (counted by hand from the seed's comments, not read off either function)
    expect(fromUsecase.verified, "seats checked").toBe(6);
    expect(fromUsecase.covered, "A home (participant), A away (custom-id arm), C away (the tolerance edge)").toBe(3);
    expect(fromUsecase.missing.map((m) => `${m.side}`).sort(), "B home (read), B away (late), C home (left before the stamp)").toEqual(["away", "home", "home"]);
    expect(fromUsecase.open, "A home, B home, B away, C away are open; A away and C home are closed").toHaveLength(4);
    expect(fromUsecase.closedByEnded, "A away").toBe(1);
    // the missing seats carry the seat's own stamp
    for (const m of fromScript.missing) expect(m.seenAt).toEqual(seed.stamp);
  }, 60_000);

  it("scopes the same way: an unlisted fixture is never read, an empty list is an empty scope, a later `since` cuts the seats", async () => {
    const seed = await constructedSeed();
    // the decoy has a verified seat and no rows: unscoped, it would be missing
    const unscoped = await presenceShadowReport(sql, { since: seed.scope.since });
    expect(unscoped.missing.some((m) => m.fixtureId === seed.decoy)).toBe(true);
    const scoped = await shadowReportSql(sql, seed.scope);
    expect(scoped.missing.some((m) => m.fixtureId === seed.decoy)).toBe(false);
    expect(await shadowReportSql(sql, { since: seed.scope.since })).toEqual(await presenceShadowReport(sql, { since: seed.scope.since }));
    expect(await shadowReportSql(sql, { ...seed.scope, fixtureIds: [] })).toEqual({ verified: 0, covered: 0, missing: [], open: [], closedByEnded: 0 });
    const later = { ...seed.scope, since: new Date(seed.stamp.getTime() + 1_000) };
    expect(await shadowReportSql(sql, later)).toEqual(await presenceShadowReport(sql, later));
    expect((await shadowReportSql(sql, later)).verified).toBe(0);
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
      expect(g.json()).toMatchObject({ verified: 2, covered: 2, missing: [], open: [], closedByEnded: 0, strict: { pass: true, reasons: [] } });

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
      ] as const) {
        const r = await probe([...argv]);
        expect(r.code).toBe(0);
        expect(r.body.since).toBe(since);
        checked.push(since);
      }
      expect(checked, "since resolutions checked").toHaveLength(3);
      const both = await probe(["--fixture", none, "--fixture", other]);
      expect(both.body.fixtureIds).toEqual([none, other]);
      expect((await probe([])).body.fixtureIds, "no --fixture is an unscoped run").toBeNull();
    });

    it("usage errors exit 2 and run no query", async () => {
      const cases: string[][] = [
        ["--since"],
        ["--since", "not-a-date"],
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
  });
});
