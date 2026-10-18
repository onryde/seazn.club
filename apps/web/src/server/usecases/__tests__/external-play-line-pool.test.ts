// Capacity tests 14(a), 14(b), 14(d), 17 and 23 (spec §8.1, §5.7.3): ADMISSION waits for the pool, the threshold is the reservation the
// stay WOULD hold, reservations subtract and release, a new arrival joins the tail, two buckets are two lines, and N claims in
// one millisecond cannot admit more than the pool holds.
//
// Driven through the real gate (`gateClaim`) against the database, one clock (`at`) for the whole decision and the bucket PINNED to
// a stated level at that instant (`setBucket`), so no refill hides a shortfall. Every expected number is the declaration it follows:
// LINE_RESERVATION and LINE_RECHECK_COST are read from the module that declares them and the sums are made HERE from raw rows -
// never from the code under test's own arithmetic. Single sport, deliberately: the gate does not know a sport.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import {
  ADMIT_HOLD_MS,
  LINE_RECHECK_COST,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION,
  endStay,
  gateClaim,
  settleDeferral,
  type GateAnswer,
} from "@/server/external-play/seat-line";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import {
  askOf,
  claimAt,
  clearBucket,
  holdReservation,
  holdWaiting,
  putStay,
  sceneAt,
  seedBoard,
  setBucket,
  stayRow,
  stubBucket,
} from "./_external-play-line";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const R = LINE_RECHECK_COST;

const keys: string[] = [];
/** A fresh bucket - and so a fresh line - for one scene. */
function scene(): string {
  configureRealtimeKit();
  const key = stubBucket();
  keys.push(key);
  return key;
}
afterEach(async () => {
  if (DB) for (const k of keys.splice(0)) await clearBucket(k);
  vi.unstubAllEnvs();
});
beforeEach(() => {
  configureRealtimeKit();
});
afterAll(async () => {
  if (DB) await sql.end();
});

const kindOf = (a: GateAnswer) => (a.kind === "go" ? `go:${a.decision}` : a.kind);

describe.skipIf(!DB)("the pool test: the threshold is the reservation the candidate WOULD hold (test 14 (a))", () => {
  it("a non-completing candidate: queued one token under LINE_RESERVATION, admitted at it - zero admission below; the pool is never negative after an admission", async () => {
    let checked = 0;
    for (const [pool, want] of [[L - 1, "queued"], [L, "go:admit"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0)); // the line is active, and L tokens of the bucket are promised
      const c = await seedBoard();
      await setBucket(key, L + pool, sceneAt(1_000));
      const a = await claimAt(key, c, "home", sceneAt(1_000));
      expect(kindOf(a), `pool ${pool}`).toBe(want);
      const row = await stayRow(c.fixtureId, c.home.personId);
      expect(row!.admitted_at !== null, `pool ${pool}: admitted_at`).toBe(want === "go:admit");
      expect(row!.completing, "not completing").toBe(false);
      if (want === "go:admit") expect(pool - L, "the pool is not negative after the admission").toBeGreaterThanOrEqual(0);
      checked += 1;
    }
    expect(checked, "pool values checked").toBe(2);
  });

  it("a COMPLETING candidate needs LINE_RESERVATION + LINE_RECHECK_COST: every pool in [L, L+R) is queued with no admission, and L+R admits - in all three causes of `completing`", async () => {
    // The three causes (§5.7.2): the board's other side has an OPEN stay and no counted check-in; it has a COUNTED check-in and no
    // open stay; neither. Pools that are short for a completing candidate but would admit a non-completing one are the ones that matter.
    const causes = [
      { name: "an open stay on the other side", completing: true, open: true, counted: false },
      { name: "a counted check-in on the other side", completing: true, open: false, counted: true },
      { name: "neither", completing: false, open: false, counted: false },
    ];
    let cases = 0;
    for (const cause of causes) {
      const need = cause.completing ? L + R : L;
      const pools = [...new Set([need - 1, need, ...(cause.completing ? Array.from({ length: R }, (_, i) => L + i) : [])])].sort((a, b) => a - b);
      for (const pool of pools) {
        const key = scene();
        await holdReservation(key, sceneAt(0));
        const c = await seedBoard();
        if (cause.open) {
          await putStay({ fixtureId: c.fixtureId, personId: c.away.personId, budgetKey: key, firstClaimAt: sceneAt(0), seenAt: sceneAt(1_000), gate: "passed" });
        }
        await setBucket(key, L + pool, sceneAt(1_000));
        const a = await claimAt(key, c, "home", sceneAt(1_000), { otherCounted: cause.counted });
        const row = await stayRow(c.fixtureId, c.home.personId);
        if (pool >= need) {
          expect(kindOf(a), `${cause.name}, pool ${pool}`).toBe("go:admit");
          expect(row!.completing, `${cause.name}: completing as the cause says`).toBe(cause.completing);
          expect(pool - need, `${cause.name}: the pool is not negative after the admission`).toBeGreaterThanOrEqual(0);
        } else {
          expect(kindOf(a), `${cause.name}, pool ${pool}`).toBe("queued");
          expect(row!.admitted_at, `${cause.name}, pool ${pool}: no admission`).toBeNull();
        }
        cases += 1;
      }
    }
    expect(causes.length, "the three causes of `completing`, driven").toBe(3);
    expect(cases, "pool values driven across the three causes").toBeGreaterThanOrEqual(3 * 2);
  });
});

describe.skipIf(!DB)("reservations subtract, and release (test 14 (b))", () => {
  it("with k admitted stays the next is admitted only at tokens >= (k + 1) x LINE_RESERVATION, and a completing stay's reservation is larger by LINE_RECHECK_COST", async () => {
    let checked = 0;
    for (const k of [1, 2, 3]) {
      for (const completingFirst of [false, true]) {
        const key = scene();
        for (let i = 0; i < k; i += 1) await holdReservation(key, sceneAt(0), completingFirst && i === 0);
        const reserved = k * L + (completingFirst ? R : 0);
        const c = await seedBoard();
        await setBucket(key, reserved + L - 1, sceneAt(1_000));
        expect(kindOf(await claimAt(key, c, "home", sceneAt(1_000))), `k ${k}, completing ${completingFirst}: one token short`).toBe("queued");
        await setBucket(key, reserved + L, sceneAt(1_100));
        expect(kindOf(await claimAt(key, c, "home", sceneAt(1_100))), `k ${k}, completing ${completingFirst}: enough`).toBe("go:admit");
        checked += 1;
      }
    }
    expect(checked, "(k, completing) scenes checked").toBe(6);
  });

  it("a reservation is released at served_at, at ended_at, at the silence lapse and at ADMIT_HOLD_MS - the pool rises by exactly that stay's reservation at the instant (4 releases, a boundary pair at each time)", async () => {
    let releases = 0;
    const probe = async (key: string, c: Awaited<ReturnType<typeof seedBoard>>, ms: number) => {
      await setBucket(key, L, sceneAt(ms)); // the bucket holds exactly the one reservation that is promised
      return kindOf(await claimAt(key, c, "home", sceneAt(ms)));
    };
    // 1. served
    {
      const key = scene();
      const h = await holdReservation(key, sceneAt(0));
      const c = await seedBoard();
      expect(await probe(key, c, 1_000), "served: before").toBe("queued");
      await endStay({ fixtureId: h.fixtureId, personId: h.home.personId, how: "served", at: sceneAt(1_500) });
      expect(await probe(key, c, 2_000), "served: after").toBe("go:admit");
      releases += 1;
    }
    // 2. ended
    {
      const key = scene();
      const h = await holdReservation(key, sceneAt(0));
      const c = await seedBoard();
      expect(await probe(key, c, 1_000), "ended: before").toBe("queued");
      await endStay({ fixtureId: h.fixtureId, personId: h.home.personId, how: "ended", at: sceneAt(1_500) });
      expect(await probe(key, c, 2_000), "ended: after").toBe("go:admit");
      releases += 1;
    }
    // 3. the silence lapse: a PASSED stay is silent for LINE_RELEASE_GRACE_MS. The candidate keeps polling (it must not lapse itself).
    {
      const key = scene();
      await holdReservation(key, sceneAt(0));
      const c = await seedBoard();
      for (let ms = 10_000; ms < LINE_RELEASE_GRACE_MS - 1; ms += 10_000) expect(await probe(key, c, ms), `silence: polling at ${ms}`).toBe("queued");
      expect(await probe(key, c, LINE_RELEASE_GRACE_MS - 1), "silence: 1 ms before the grace").toBe("queued");
      expect(await probe(key, c, LINE_RELEASE_GRACE_MS), "silence: at the grace").toBe("go:admit");
      releases += 1;
    }
    // 4. ADMIT_HOLD_MS: the admitted stay keeps asking (never silent), so only the hold's end releases it.
    {
      const key = scene();
      const h = await holdReservation(key, sceneAt(0));
      const c = await seedBoard();
      const keepAsking = async (ms: number) => {
        await setBucket(key, L, sceneAt(ms));
        // The held stay's own claim: admitted and live, so it goes - and its `last_seen_at` moves.
        const a = await claimAt(key, h, "home", sceneAt(ms));
        expect(kindOf(a), `the admitted stay's claim at ${ms}`).toBe("go:admitted");
      };
      for (let ms = 10_000; ms < ADMIT_HOLD_MS - 1; ms += 10_000) {
        await keepAsking(ms);
        expect(await probe(key, c, ms + 1), `hold: the candidate at ${ms + 1}`).toBe("queued");
      }
      await keepAsking(ADMIT_HOLD_MS - 1);
      expect(await probe(key, c, ADMIT_HOLD_MS - 1), "hold: 1 ms before").toBe("queued");
      expect(await probe(key, c, ADMIT_HOLD_MS), "hold: at it").toBe("go:admit");
      releases += 1;
    }
    expect(releases, "releases driven").toBe(4);
  }, 120_000);

  it("an ADMITTED stay is entitled to its reservation: its claim passes whatever the pool says - even a pool other traffic has drained BELOW ZERO - while a candidate at the same level is queued", async () => {
    // The pool is the bucket minus every promise, the admitted stay's own included, so exempt traffic spending tokens after
    // the admission makes it negative; the stay must not be re-queued for that (it was funded when it was admitted).
    let checked = 0;
    for (const [name, completing, bucket] of [
      ["one token under its own reservation", false, L - 1],
      ["an empty bucket", false, 0],
      ["an empty bucket, completing reservation", true, 0],
    ] as const) {
      const key = scene();
      const h = await holdReservation(key, sceneAt(0), completing);
      await setBucket(key, bucket, sceneAt(1_000));
      const a = await claimAt(key, h, "home", sceneAt(1_000));
      expect(kindOf(a), `${name}: the admitted stay goes`).toBe("go:admitted");
      const row = await stayRow(h.fixtureId, h.home.personId);
      expect(row!.admitted_at, `${name}: still admitted`).not.toBeNull();
      expect(row!.ended_at, `${name}: not ended`).toBeNull();
      // The pair: the next arrival, at the very level the admitted stay passed at, is queued (a negative pool admits nobody).
      const c = await seedBoard();
      expect(kindOf(await claimAt(key, c, "home", sceneAt(1_100))), `${name}: a candidate`).toBe("queued");
      checked += 1;
    }
    expect(checked, "levels checked").toBe(3);
  });

  it("a stay that passed on an idle line and is still checking in pays the pool test on its next claim once the line is active", async () => {
    const key = scene();
    const s = await seedBoard();
    await setBucket(key, 0, sceneAt(0));
    expect(kindOf(await claimAt(key, s, "home", sceneAt(0))), "premise: the empty line lets it through").toBe("go:idle");
    expect((await stayRow(s.fixtureId, s.home.personId))!.admitted_at, "idle admitted nothing").toBeNull();
    // The line becomes active (another stay is admitted and live) while S is still checking in, and the pool cannot fund S.
    await holdReservation(key, sceneAt(500));
    await setBucket(key, L + L - 1, sceneAt(1_000));
    expect(kindOf(await claimAt(key, s, "home", sceneAt(1_000))), "its next claim meets the pool test, and fails it").toBe("queued");
    await setBucket(key, L + L, sceneAt(1_100));
    expect(kindOf(await claimAt(key, s, "home", sceneAt(1_100))), "and passes it when the pool holds the reservation").toBe("go:admit");
  });
});

describe.skipIf(!DB)("a new arrival joins the tail (test 17)", () => {
  it("behind a WAITING stay it is queued whatever the pool holds - nothing is admitted ahead of an earlier waiting stay", async () => {
    const key = scene();
    await holdWaiting(key, sceneAt(0), sceneAt(1_000));
    const a = await seedBoard();
    await setBucket(key, 10 * L, sceneAt(1_000)); // a pool that would fund ten stays
    const got = await claimAt(key, a, "home", sceneAt(1_000));
    expect(got.kind).toBe("queued");
    if (got.kind === "queued") expect(got.line.position, "second in line").toBe(2);
    expect((await stayRow(a.fixtureId, a.home.personId))!.admitted_at, "not admitted").toBeNull();
  });

  it("the pair: with only ADMITTED stays (none waiting) it is admitted at once when the pool holds the reservation it would hold, and queued when it does not", async () => {
    let checked = 0;
    for (const [tokens, want] of [[L + L - 1, "queued"], [L + L, "go:admit"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0));
      const a = await seedBoard();
      await setBucket(key, tokens, sceneAt(1_000));
      expect(kindOf(await claimAt(key, a, "home", sceneAt(1_000))), `tokens ${tokens}`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("an arrival on an EMPTY line is today's path: go, nothing admitted, no reservation, nothing queued", async () => {
    const key = scene();
    const a = await seedBoard();
    await setBucket(key, 0, sceneAt(0));
    expect(kindOf(await claimAt(key, a, "home", sceneAt(0)))).toBe("go:idle");
    const row = await stayRow(a.fixtureId, a.home.personId);
    expect([row!.queued_at, row!.admitted_at]).toEqual([null, null]);
    expect(row!.last_gate).toBe("passed");
  });
});

describe.skipIf(!DB)("buckets (test 23)", () => {
  it("two budget keys are independent lines and pools: a reservation and a waiting stay on one never touch the other; two organisations on one key share both", async () => {
    const keyA = scene();
    const keyB = scene();
    await holdReservation(keyA, sceneAt(0)); // A's pool is short by one reservation, and a stay waits on A
    await holdWaiting(keyA, sceneAt(1), sceneAt(1_000));
    const onB = await seedBoard();
    await setBucket(keyB, 0, sceneAt(1_000));
    expect(kindOf(await claimAt(keyB, onB, "home", sceneAt(1_000))), "B is idle: A's line and reservations are not B's").toBe("go:idle");
    // The reservation on B is likewise invisible to A: fund A for ONE candidate beyond its own held reservation and one waiting stay.
    await holdReservation(keyB, sceneAt(2_000));
    const onA = await seedBoard();
    await setBucket(keyA, 100 * L, sceneAt(3_000));
    const a = await claimAt(keyA, onA, "home", sceneAt(3_000));
    expect(a.kind, "A's claim sits behind A's own waiting stay").toBe("queued");
    if (a.kind === "queued") expect(a.line.position, "counting A's waiting stay and not B's").toBe(2);
    // Two organisations on ONE key share the line: the second org's claim sees the first org's reservation.
    const key = scene();
    await holdReservation(key, sceneAt(0)); // another organisation's board (every seeded board is its own organisation)
    const mine = await seedBoard();
    await setBucket(key, L, sceneAt(1_000));
    expect(kindOf(await claimAt(key, mine, "home", sceneAt(1_000))), "the shared pool is short by the other organisation's reservation").toBe("queued");
  });
});

describe.skipIf(!DB)("concurrent admission, with a barrier (test 14 (d), the re-review 2's M5)", () => {
  it("N claims in the same millisecond against a pool that holds exactly M < N reservations admit M and not more; the lock keeps ONE claim inside the barrier", async () => {
    const N = 6;
    const M = 2;
    const BARRIER_MS = 80;
    const key = scene();
    const h = await holdReservation(key, sceneAt(0)); // the line is ACTIVE (an admitted stay), so a fresh arrival is a candidate
    void h;
    const boards = await Promise.all(Array.from({ length: N }, () => seedBoard()));
    const when = sceneAt(1_000);
    await setBucket(key, L + M * L, when); // beyond the held reservation, exactly M more are promised
    let arrived = 0;
    let inside = 0;
    let maxInside = 0;
    let reached = 0;
    let release: () => void = () => undefined;
    const open = new Promise<void>((r) => {
      release = r;
    });
    const afterRead = async () => {
      reached += 1;
      arrived += 1;
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      if (arrived >= N) release();
      await Promise.race([open, new Promise((r) => setTimeout(r, BARRIER_MS))]);
      inside -= 1;
    };
    const { LINE_LOCK_TIMEOUT_MS } = await import("@/server/external-play/seat-line");
    expect(BARRIER_MS * (N - 1), "the barrier must not outlast the lock timeout, or later claims time out and the test measures the wrong thing").toBeLessThan(LINE_LOCK_TIMEOUT_MS);

    const answers = await Promise.all(boards.map((b) => gateClaim({ ...askOf(key, b, "home", when), afterRead })));
    expect(reached, "the barrier was reached by every claim: a seam that is never called fails").toBe(N);
    const admitted = answers.filter((a) => a.kind === "go" && a.decision === "admit").length;
    const queued = answers.filter((a) => a.kind === "queued").length;
    expect({ N, M, admitted, queued }, "M admitted and the rest held").toEqual({ N, M, admitted: M, queued: N - M });
    expect(maxInside, "claims inside the barrier at once: 1 with the lock, N without it").toBe(1);
  }, 60_000);
});

void [holdWaiting, settleDeferral];
