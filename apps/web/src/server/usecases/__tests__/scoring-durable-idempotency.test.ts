// THE money path (W2, design §6).
//
// `REDIS_URL` is unset in this suite — cache.ts:35-36 gates everything on it,
// so `cacheGet` misses and `cacheSet` is a no-op. That is not an accident of
// the environment, it is the CONDITION UNDER TEST: it is exactly the state in
// which the old code recorded the same tap twice, because the fail-open cache
// was the only thing standing between a retry and a second write.
//
// Do NOT add a cache mock here. A mocked `cacheGet` that answers the retry
// would make every assertion below pass while proving the Redis fast path,
// which is not what this wave built.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { cacheEnabled } from "@/lib/cache";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { scoreEvent } from "../scoring";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

afterEach(() => __setRateLimitCounterForTests(null));

const HAS_DB = !!process.env.DATABASE_URL;

const RESULT = { p1Score: 3, p2Score: 1 };

describe.skipIf(!HAS_DB)("scoreEvent — durable idempotency, with no cache at all", () => {
  it("is running with the cache OFF, which is the condition under test", () => {
    // Load-bearing, not decoration. If REDIS_URL is ever set in this suite's
    // environment, every test below would be satisfied by the Redis fast path
    // and would stop witnessing the database guarantee entirely — silently.
    expect(cacheEnabled()).toBe(false);
  });

  it("records a retried tap ONCE and answers both calls the same", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;

    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const first = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: key,
    });

    // The retry a pad on flaky Wi-Fi sends: same expected_seq, same key. The
    // ledger has already moved past expected_seq 1, so WITHOUT the idempotency
    // answer this is a SEQ_CONFLICT — which is what makes the assertion
    // non-vacuous. It cannot succeed by accident.
    const second = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: key,
    });

    expect(second).toEqual(first);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events
      where fixture_id = ${fixtureId} and idempotency_key = ${key}`;
    expect(n).toBe(1);

    // And the ledger as a whole did not grow: core.start + the one result.
    // The count above alone would pass if the retry wrote a row with a NULL
    // key — which is precisely what a guard that dropped the key would do.
    const [{ total }] = await sql<{ total: number }[]>`
      select count(*)::int as total from score_events where fixture_id = ${fixtureId}`;
    expect(total).toBe(2);
  });

  it("does not make two DIFFERENT taps collide", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const a = await scoreEvent(auth, fixtureId, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: `idem-${randomUUID()}`,
    });
    const b = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: `idem-${randomUUID()}`,
    });
    // The POSITIVE pair for the refusal above. A guard that answered "replay"
    // to everything would pass the first test and fail here.
    expect(b.seq).toBe(a.seq + 1);
  });

  it("still raises SEQ_CONFLICT for a stale write carrying NO key", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
    });
    // Un-keyed writes keep the old contract EXACTLY. A change here would break
    // the batch importer and every client that does not send a key, and it is
    // the half a "return the original outcome" guard is most likely to widen
    // past by accident.
    await expect(
      scoreEvent(auth, fixtureId, {
        expected_seq: 1,
        type: "generic.result",
        payload: RESULT,
      }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
  });

  it("still raises SEQ_CONFLICT when the stale write carries a NEW key", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: `idem-${randomUUID()}`,
    });

    // Two pads on one fixture: the other one's write landed first, so this
    // tap's expected_seq is stale — but its key is one the ledger has NEVER
    // seen, so this is a genuine conflict, not a retry. It must 409.
    //
    // This is the case that separates "answer from the ledger" from "swallow
    // every SEQ_CONFLICT that happens to carry a key". Without it, a guard
    // that returned the lookup unconditionally would hand the scorer a null
    // outcome dressed as success, and the four tests above would all stay
    // green. (Measured: dropping the `if (replayed)` gate reds only this one.)
    await expect(
      scoreEvent(auth, fixtureId, {
        expected_seq: 1,
        type: "generic.result",
        payload: RESULT,
        idempotency_key: `idem-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "SEQ_CONFLICT" });
  });

  it("charges the REPLAY bucket when it answers from the ledger", async () => {
    // The ledger answer is a free, unbounded surface otherwise: a `dl_` secret
    // is a shareable URL, so anyone holding a leaked link could replay one
    // known key forever. `scoring-replay-is-free.test.ts` already pins this for
    // the CACHE branch, but it mocks `cacheGet` to HIT, so it never reaches the
    // database branch at all — measured: deleting this rateLimit left that file
    // 10/10 green. Hence a counting test here, where the cache always misses.
    //
    // No cache mock is added for this: the counter is not a cache, and the
    // file's no-Redis contract above still holds.
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: key,
    });

    // Armed only for the RETRY, so the buckets seen below belong to it alone.
    const seen: string[] = [];
    __setRateLimitCounterForTests(async (k: string) => {
      seen.push(k);
      return 1;
    });
    await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: key,
    });

    expect(
      seen.some((k) => k.includes(`scorereplayv1:${fixtureId}`)),
      `the ledger answer was not rate limited — buckets charged: ${seen.join(",") || "(none)"}`,
    ).toBe(true);
  });

  it("does not answer a key minted on a DIFFERENT fixture", async () => {
    const { auth } = await seedOrg();
    const a = await startedDivisionWithFixture(auth);
    const b = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await scoreEvent(auth, a.fixtureId, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: key,
    });
    // The same key on another fixture is a legitimately NEW write (two courts
    // may mint the same key), so it must be recorded, not answered from
    // fixture a's ledger.
    const onB = await scoreEvent(auth, b.fixtureId, {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: key,
    });
    expect(onB.seq).toBe(1);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from score_events where fixture_id = ${b.fixtureId}`;
    expect(n).toBe(1);
  });
});
