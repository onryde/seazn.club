// device-void-mine, review round 1 — the Redis idempotency answers are
// versioned by their key PREFIX, and Fix A had to move it.
//
// Fix A put `event_id` on every append answer, and OpenAPI marks it required.
// An answer cached under the old prefix before the deploy has no `event_id`,
// and lives for up to 24 hours (`IDEM_TTL_SECONDS`). Serving it would hand a
// pad an ack with no row id — the exact shape Fix A exists to end — for a
// full day after the release. A new prefix makes every such entry a miss, and
// a miss falls through to the durable replay (`replayOutcomeFor`), which does
// carry the id.
//
// A cache stand-in is legitimate HERE, unlike scoring-durable-idempotency.test.ts
// (which forbids one for its own reason): what is under test is which Redis KEY
// is read. `REDIS_URL` is unset in this suite, so without a stand-in nothing is
// ever read at all and the old prefix could not be told from the new one.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ entries: new Map<string, unknown>(), reads: [] as string[] }));

vi.mock("@/lib/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache")>();
  return {
    ...actual,
    cacheGet: async (key: string) => {
      cache.reads.push(key);
      return cache.entries.get(key) ?? null;
    },
    cacheSet: async (key: string, value: unknown) => {
      cache.entries.set(key, value);
    },
  };
});

import { sql } from "@/lib/db";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { scoreEvent } from "../scoring";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  cache.entries.clear();
  cache.reads.length = 0;
});
afterEach(() => __setRateLimitCounterForTests(null));

describe.skipIf(!HAS_DB)("scoreEvent — an answer cached before event_id existed is never served", () => {
  it("a retry past a deploy misses the old-prefix entry and names its row from the ledger", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const key = `idem-${randomUUID()}`;
    await scoreEvent(auth, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const first = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
      idempotency_key: key,
    });
    const [row] = await sql<{ id: string }[]>`
      select id from score_events where fixture_id = ${fixtureId} and seq = ${first.seq}`;
    expect(row, "the ack's seq must name a real row").toBeDefined();

    // The Redis a deploy inherits: only the PRE-deploy answer, under the old
    // prefix, shaped the way the old code wrote it — no `event_id`.
    cache.entries.clear();
    cache.entries.set(`idemv1:${fixtureId}:${key}`, {
      seq: first.seq,
      state_summary: first.state_summary,
      outcome: first.outcome,
      status: first.status,
    });
    cache.reads.length = 0;

    const retry = await scoreEvent(auth, fixtureId, {
      expected_seq: 1,
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
      idempotency_key: key,
    });

    expect(retry.event_id, "the retry's answer must name the row, not replay a pre-event_id answer").toBe(row!.id);
    // Pinned by name, so the prefix cannot drift back without this failing.
    expect(cache.reads.filter((k) => k.includes(key))).toEqual([`idemv2:${fixtureId}:${key}`]);
  });
});
