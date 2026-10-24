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
import { seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { writeFixtureRulesOverride } from "../fixture-rules";
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
    expect(cache.reads.filter((k) => k.includes(key))).toEqual([`idemv3:${fixtureId}:${key}`]);
  });
});

// Batch-5 m-2: the Redis fast path answers a retry from the cached `ScoreOutcome`, which carries the ORIGINAL write's
// `rules_version`. The contract (schemas.ts `AppendEventResponse`, `ScoreOutcome`) and the durable replay (`replay.ts`) say a
// replayed answer carries the version NOW - so a lost-ack retry after a correction is what tells the pad to reload. Served
// from the cache it said nothing, and the pad's next new tap was refused instead. Same answer whichever tier serves it.
describe.skipIf(!HAS_DB)("scoreEvent - a retry served from the Redis fast path carries the rules version NOW (batch-5 m-2)", () => {
  const game = { type: "badminton.game.summary", payload: { home: 11, away: 5 } };
  async function liveBadminton() {
    // single-sport: badminton `short` is the correction rig the other X-SR-7 tests use (best of 3 -> 5); the cache tier is sport-blind.
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await scoreEvent(b.auth, id, { expected_seq: 0, type: "core.start", payload: {} });
    return { b, id };
  }

  it("a retry after a correction names the new version, from the cache, and writes nothing; the cached entry is not rewritten", async () => {
    const { b, id } = await liveBadminton();
    const key = `m2-${randomUUID()}`;
    const first = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    const slot = `idemv3:${id}:${key}`;
    expect(cache.entries.get(slot), "premise: the first answer is in the fast path").toMatchObject({ seq: first.seq, rules_version: 0 });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const [{ v }] = await sql<{ v: number }[]>`select rules_version v from fixtures where id = ${id}`;
    expect(v, "premise: the correction moved the version").toBe(1);
    const events = async () => (await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${id}`)[0]!.n;
    const before = await events();
    cache.reads.length = 0;

    const retry = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    expect(cache.reads, "premise: it was the fast path that answered").toEqual([slot]);
    expect({ seq: retry.seq, event_id: retry.event_id }, "the original row").toEqual({ seq: first.seq, event_id: first.event_id });
    expect(retry.rules_version, "the pad is told the rules moved").toBe(1);
    expect(await events(), "no write").toBe(before);
    expect((cache.entries.get(slot) as { rules_version: number }).rules_version, "the overlay is per answer, never written back").toBe(0);
  });

  it("the negative pair: no correction, the retry is the cached answer untouched", async () => {
    const { b, id } = await liveBadminton();
    const key = `m2-quiet-${randomUUID()}`;
    const first = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    cache.reads.length = 0;
    const retry = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    expect(cache.reads).toEqual([`idemv3:${id}:${key}`]);
    expect(retry).toEqual(first);
  });

  it("two corrections between the write and the retry: the retry names the latest", async () => {
    const { b, id } = await liveBadminton();
    const key = `m2-twice-${randomUUID()}`;
    await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 3 });
    const retry = await scoreEvent(b.auth, id, { expected_seq: 1, ...game, rules_version: 0, idempotency_key: key });
    expect(retry.rules_version).toBe(2);
  });
});
