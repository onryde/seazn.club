// Capacity test 38 (spec §8.1, the re-review 2's M5): the gate's lock is the TWO-key lock, it cannot wait for ever, and only its one
// named refusal is answered - everything else propagates as itself. Driven through the real claim and the real database; the
// "another connection" is a reserved pool connection holding the same advisory lock the gate takes.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { LINE_POLL_MIN_MS } from "@/components/public-site/match-room/room-snapshot";
import { LINE_LOCK_TIMEOUT_MS, SeatLineBusy, seatLineBusyCount } from "@/server/external-play/seat-line";
import { claimAt, putStay, setBucket, stayRow, sceneAt, seedBoard as sceneBoard, stubBucket, clearBucket } from "./_external-play-line";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import { MIN, SEC, claimRoom, dropWorlds, fund, inWindow, level, seedBoard, world, type Board, type World } from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
/** The slack a busy answer may take beyond the timeout: the route's own work around the gate, on a loaded machine. */
const SLACK_MS = 1_500;
/** The no-timeout mutant releases the holder after this long; the claim must have answered before it. */
const HOLDER_RELEASE_MS = 3 * LINE_LOCK_TIMEOUT_MS;

afterEach(async () => {
  vi.restoreAllMocks();
  await dropWorlds();
});
afterAll(async () => {
  if (DB) await sql.end();
});

type Reserved = Awaited<ReturnType<typeof sql.reserve>>;
/** Another connection takes the gate's lock for `key` (session-level, the same two integers) and lets it go after `releaseMs`. */
async function holdLock(key: string, releaseMs: number): Promise<{ conn: Reserved; released: Promise<void> }> {
  const conn = await sql.reserve();
  await conn`select pg_advisory_lock(hashtext('rtk-line'), hashtext(${key}))`;
  const released = new Promise<void>((resolve) =>
    setTimeout(() => {
      void conn`select pg_advisory_unlock(hashtext('rtk-line'), hashtext(${key}))`.then(() => {
        conn.release();
        resolve();
      });
    }, releaseMs),
  );
  return { conn, released };
}

describe.skipIf(!DB)("the gate's lock is the two-key lock (test 38 (a))", () => {
  it("with the gate paused inside its transaction, a second connection finds exactly ONE advisory lock of the gate: classid = hashtext('rtk-line'), objid = hashtext(budget key), objsubid = 2 (the two-integer form)", async () => {
    configureRealtimeKit();
    const key = stubBucket();
    try {
      const board = await sceneBoard();
      let found: { classid: number; objid: number; objsubid: number; mine: number }[] = [];
      let expected: { c: number; o: number } | null = null;
      await setBucket(key, 1000, sceneAt(0));
      await claimAt(key, board, "home", sceneAt(0), {
        afterRead: async () => {
          // The database's own hashtext, unsigned the way pg_locks shows an oid.
          [expected] = await sql<{ c: number; o: number }[]>`
            select (hashtext('rtk-line')::bigint & 4294967295)::bigint as c, (hashtext(${key})::bigint & 4294967295)::bigint as o`;
          found = await sql<{ classid: number; objid: number; objsubid: number; mine: number }[]>`
            select l.classid::bigint as classid, l.objid::bigint as objid, l.objsubid,
                   (select count(*)::int from pg_locks m where m.pid = l.pid and m.locktype = 'advisory') as mine
              from pg_locks l
             where l.locktype = 'advisory' and l.granted and l.classid::bigint = (hashtext('rtk-line')::bigint & 4294967295)`;
        },
      });
      expect(expected, "premise: the expected hashes were computed").not.toBeNull();
      expect(found.length, "locks found in the gate's key space: exactly 1, and zero is a failure").toBe(1);
      expect(Number(found[0]!.classid)).toBe(Number(expected!.c));
      expect(Number(found[0]!.objid)).toBe(Number(expected!.o));
      expect(found[0]!.objsubid, "the two-integer form").toBe(2);
      expect(found[0]!.mine, "and the gate's backend holds no other advisory lock").toBe(1);
    } finally {
      await clearBucket(key);
    }
  });
});

describe.skipIf(!DB)("a busy gate answers within the timeout plus slack and spends nothing (test 38 (b))", () => {
  it("LINE_LOCK_TIMEOUT_MS is under LINE_POLL_MIN_MS (a busy answer is back before the floor cadence)", () => {
    expect(LINE_LOCK_TIMEOUT_MS).toBeLessThan(LINE_POLL_MIN_MS);
  });

  /** A claim that meets a held lock: the elapsed time, the answer, the vendor requests it made, the bucket before and after. */
  async function busyClaim(w: World, board: Board, side: "home" | "away", at: Date) {
    const holder = await holdLock(w.key, HOLDER_RELEASE_MS);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    const busyBefore = seatLineBusyCount();
    const levelBefore = await level(w.key);
    const callsBefore = w.rtk.http.length;
    const t0 = performance.now();
    const got = await claimRoom(w, board, side, at);
    const elapsed = performance.now() - t0;
    const out = {
      got,
      elapsed,
      calls: w.rtk.http.length - callsBefore,
      levelBefore,
      levelAfter: await level(w.key),
      busyDelta: seatLineBusyCount() - busyBefore,
      warns: warn.mock.calls.filter((c) => String(c[1] ?? c[0]).includes("gate lock busy")).length,
    };
    await holder.released;
    return out;
  }

  it("a stay not yet admitted: waited LINE_LOCK_TIMEOUT_MS and gave up (not before, not long after), zero fixture calls, bucket unchanged, answered queued at the floor cadence and marked HELD; counted once and warned once", async () => {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 500);
    const r = await busyClaim(w, b, "home", inWindow(3 * MIN));
    expect(r.elapsed, "it waited for the lock before giving up").toBeGreaterThanOrEqual(LINE_LOCK_TIMEOUT_MS);
    expect(r.elapsed, "and answered within the timeout plus the slack").toBeLessThan(LINE_LOCK_TIMEOUT_MS + SLACK_MS);
    expect(r.elapsed, "before the no-timeout mutant's holder lets go").toBeLessThan(HOLDER_RELEASE_MS);
    expect(r.calls, "the fixture server saw nothing").toBe(0);
    expect(r.levelAfter, "the bucket is unchanged").toBe(r.levelBefore);
    expect(r.got.seat, "queued, at the floor cadence").toMatchObject({ seated: false, reason: "queued", line: { pollMs: LINE_POLL_MIN_MS } });
    const row = await stayRow(b.fixtureId, b.home.personId);
    expect([row?.last_gate, row?.queued_at !== null, row?.admitted_at], "marked held: it keeps its place").toEqual(["held", true, null]);
    expect([r.busyDelta, r.warns], "the busy count and the warn lines").toEqual([1, 1]);
  }, 60_000);

  it("an ADMITTED stay: answered camera_starting, keeps its admission and its reservation (the bucket still owes it), nothing spent; counted once and warned once", async () => {
    const w = world();
    const b = await seedBoard();
    const t = inWindow(3 * MIN);
    await putStay({ fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: w.key, firstClaimAt: t, seenAt: t, gate: "passed", queuedAt: t, admittedAt: t, completing: false });
    await fund(w.key, 500);
    const r = await busyClaim(w, b, "home", new Date(t.getTime() + 5 * SEC));
    expect(r.elapsed).toBeGreaterThanOrEqual(LINE_LOCK_TIMEOUT_MS);
    expect(r.elapsed).toBeLessThan(LINE_LOCK_TIMEOUT_MS + SLACK_MS);
    expect(r.calls, "the fixture server saw nothing").toBe(0);
    expect(r.levelAfter).toBe(r.levelBefore);
    expect(r.got.seat, "camera_starting: the admitted stay is not sent back to the queue").toMatchObject({ seated: false, reason: "camera_starting" });
    const row = await stayRow(b.fixtureId, b.home.personId);
    expect([row?.admitted_at, row?.ended_at, row?.served_at], "admission kept, not ended").toEqual([t, null, null]);
    expect([r.busyDelta, r.warns]).toEqual([1, 1]);
  }, 60_000);
});

describe.skipIf(!DB)("only the named refusal is answered (test 38 (c))", () => {
  it("an error that is not 55P03, raised inside the gate, propagates out of the claim as itself; it is not answered queued, not counted busy, and no stay is marked held", async () => {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 500);
    const boom = Object.assign(new Error("a statement failed for some other reason"), { code: "57014" });
    const busyBefore = seatLineBusyCount();
    const claim = claimRoom(w, b, "home", inWindow(3 * MIN), {
      line: {
        at: inWindow(3 * MIN),
        afterRead: async () => {
          throw boom;
        },
      },
    } as never);
    await expect(claim, "the very error comes out, as itself").rejects.toBe(boom);
    expect(seatLineBusyCount(), "not counted as a busy refusal").toBe(busyBefore);
    const row = await stayRow(b.fixtureId, b.home.personId);
    expect(row?.last_gate ?? null, "no stay was marked held by a mistaken busy answer").not.toBe("held");
  }, 60_000);

  it("the named refusal is the only thing SeatLineBusy stands for: a lock timeout is it, and the gate throws it directly", async () => {
    configureRealtimeKit();
    const key = stubBucket();
    const holder = await holdLock(key, HOLDER_RELEASE_MS);
    try {
      const b = await sceneBoard();
      const attempt = await claimAt(key, b, "home", sceneAt(0)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(attempt, "the gate raises its named refusal").toBeInstanceOf(SeatLineBusy);
    } finally {
      await holder.released;
      await clearBucket(key);
    }
  }, 60_000);
});
