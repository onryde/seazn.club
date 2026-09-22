// W2 (design §6) — durable idempotency, through the REAL route.
//
// The unit suite proves the database guarantee with no Redis at all. This file
// proves it through the HTTP kernel, the auth layer and the envelope — and
// covers the one branch a unit test structurally cannot reach: the genuine
// RACE, where two concurrent requests both pass the optimistic-concurrency
// check and the loser's insert trips the unique index. In-process that needs
// two overlapping transactions; here it is just two un-awaited POSTs.
//
// Why a retry is not answered by accident: `appendEvent` compares
// `expected_seq` against the ledger tip BEFORE attempting any insert, so once
// the first write commits, a byte-identical retry is a stale write. Without
// W2 it is a 409. Every "the retry succeeded" assertion below is therefore
// witnessing the new behaviour, not a no-op.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { apiJson, TAG } from "./helpers";

function freshKey(): string {
  return `e2e-idem-${TAG}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A started division whose first fixture is live and sitting at seq 1. */
async function seedStartedFixture(
  request: APIRequestContext,
): Promise<{ fixtureId: string; otherFixtureId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W2 Idem ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Open",
      // `generic` / `score`, matching device-links.spec.ts. NOT badminton:
      // this repo's e2e rigs seed the generic module, and a sport_key the
      // division does not carry makes every event 422 rather than proving
      // anything about idempotency.
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/entrants`,
    "POST",
    ["Ida", "Juno", "Kilo", "Lima"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${div.data!.id}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const ids = gen.data!.fixtures.map((f) => f.id);
  // Two fixtures are load-bearing: the per-fixture scoping test needs a
  // SECOND one, and a rig that silently produced one would make that test
  // vacuous rather than red.
  expect(ids.length, "the rig must produce at least two fixtures").toBeGreaterThan(1);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

  // core.start puts the fixture in play and the tip at seq 1, so every test
  // below writes its scoring event at expected_seq 1.
  const started = await apiJson(request, `/api/v1/fixtures/${ids[0]!}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(started.status, "core.start must be accepted").toBe(201);
  return { fixtureId: ids[0]!, otherFixtureId: ids[1]! };
}

/** Every event type on the fixture, in seq order. `since_seq=0` and the flat
 *  array shape both match `scorepad-v3-badminton.spec.ts`'s own `ledger`. */
async function ledgerTypes(request: APIRequestContext, fixtureId: string): Promise<string[]> {
  const res = await apiJson<{ seq: number; type: string }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return (res.data ?? []).map((e) => e.type);
}

const RESULT = { p1Score: 3, p2Score: 1 };

test.describe("scoring idempotency — the durable guarantee, over HTTP", () => {
  test("the same key, sent twice, leaves ONE ledger row and answers both alike", async ({
    request,
  }) => {
    const { fixtureId } = await seedStartedFixture(request);
    const body = {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: freshKey(),
    };

    const first = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      body,
    );
    expect(first.status, "the first write is a create").toBe(201);

    // Byte-identical retry, stale expected_seq and all. A 2xx here cannot
    // happen by accident — before W2 this was a 409 SEQ_CONFLICT.
    const second = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      body,
    );
    expect(second.status, "the retry is answered, not refused").toBeLessThan(400);
    expect(second.data!.seq, "and answered with the ORIGINAL seq").toBe(first.data!.seq);

    const types = await ledgerTypes(request, fixtureId);
    expect(types.filter((t) => t === "generic.result").length, `ledger: ${types.join(",")}`).toBe(1);
  });

  test("two CONCURRENT sends of one key still leave exactly one row", async ({ request }) => {
    // THE RACE — two overlapping writes, which the in-process suite cannot
    // construct. This is the only test that can reach the `23505` branch:
    // when both requests clear the optimistic-concurrency check before either
    // commits, the loser's insert trips `score_events_idem_key` instead of
    // being turned away by SEQ_CONFLICT.
    //
    // Stated honestly: nothing observable from out here says WHICH branch
    // fired, and if the two requests happen to serialise, the second is an
    // ordinary stale retry. Both outcomes are correct and both are asserted
    // identically, so this test never reds for the wrong reason — what it
    // pins is that no interleaving produces a second row.
    const { fixtureId } = await seedStartedFixture(request);
    const body = {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: freshKey(),
    };

    const [a, b] = await Promise.all([
      apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", body),
      apiJson<{ seq: number }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", body),
    ]);

    // Whichever order they land in, neither may be refused and both must name
    // the same event. A 409 here means the race fell through to the generic
    // conflict path instead of the idempotency answer.
    expect(
      [a.status, b.status].every((s) => s < 400),
      `statuses: ${a.status}/${b.status}`,
    ).toBe(true);
    expect(a.data!.seq).toBe(b.data!.seq);

    const types = await ledgerTypes(request, fixtureId);
    expect(types.filter((t) => t === "generic.result").length, `ledger: ${types.join(",")}`).toBe(1);
  });

  test("a reused key with a DIFFERENT payload answers the ORIGINAL, never overwrites", async ({
    request,
  }) => {
    // A client bug — reusing a key for a different tap — must not be able to
    // rewrite history. The first write stands and is what comes back.
    const { fixtureId } = await seedStartedFixture(request);
    const key = freshKey();
    const first = await apiJson<{ seq: number; outcome: unknown }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: 1, type: "generic.result", payload: RESULT, idempotency_key: key },
    );
    expect(first.status).toBe(201);

    const second = await apiJson<{ seq: number; outcome: unknown }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      // The LOSER of the original result, sent under the same key.
      {
        expected_seq: 1,
        type: "generic.result",
        payload: { p1Score: 1, p2Score: 3 },
        idempotency_key: key,
      },
    );
    expect(second.status).toBeLessThan(400);
    expect(second.data!.seq).toBe(first.data!.seq);
    // The DECIDING assertion: the outcome is the first payload's, not the
    // second's. Comparing only the seq would pass even if the row had been
    // updated in place.
    expect(second.data!.outcome).toEqual(first.data!.outcome);

    const types = await ledgerTypes(request, fixtureId);
    expect(types.filter((t) => t === "generic.result").length).toBe(1);
  });

  test("two DIFFERENT keys both write — the guard does not over-refuse", async ({ request }) => {
    // The POSITIVE pair for every refusal above. A guard that answered
    // "replay" to everything would satisfy all of them and fail here.
    const { fixtureId } = await seedStartedFixture(request);
    const a = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: 1, type: "generic.result", payload: RESULT, idempotency_key: freshKey() },
    );
    expect(a.status).toBe(201);
    const b = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: a.data!.seq, type: "core.finalize", payload: {}, idempotency_key: freshKey() },
    );
    expect(b.status, "a second, differently-keyed event is a CREATE").toBe(201);
    expect(b.data!.seq).toBe(a.data!.seq + 1);
  });

  test("the same key on a DIFFERENT fixture is a new write, not an answer", async ({ request }) => {
    // The index is (fixture_id, idempotency_key) precisely so two courts may
    // mint the same key. If the lookup were on the key alone, this fixture
    // would be handed the OTHER one's score — a wrong result, silently.
    const { fixtureId, otherFixtureId } = await seedStartedFixture(request);
    const key = freshKey();
    const onA = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: 1, type: "generic.result", payload: RESULT, idempotency_key: key },
    );
    expect(onA.status).toBe(201);

    const startB = await apiJson(request, `/api/v1/fixtures/${otherFixtureId}/events`, "POST", {
      expected_seq: 0,
      type: "core.start",
      payload: {},
      idempotency_key: key,
    });
    expect(startB.status, "the same key on another fixture must be RECORDED").toBe(201);
    expect(await ledgerTypes(request, otherFixtureId)).toEqual(["core.start"]);
  });

  test("a stale write carrying a NEW key still gets 409", async ({ request }) => {
    // Two pads on one fixture: the other one's write landed first. This tap's
    // key has never been seen, so it is a genuine conflict — not a retry.
    // This is the case that separates "answer from the ledger" from "swallow
    // every SEQ_CONFLICT that happens to carry a key"; without it, a guard
    // that returned the lookup unconditionally would pass every test above.
    const { fixtureId } = await seedStartedFixture(request);
    const first = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: freshKey(),
    });
    expect(first.status).toBe(201);

    const stale = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
      idempotency_key: freshKey(),
    });
    expect(stale.status, "a genuine conflict must still refuse").toBe(409);
  });

  test("an UN-KEYED stale write keeps the old 409 contract exactly", async ({ request }) => {
    // Callers that send no key — the batch importer among them — must be
    // entirely unaffected. The column is nullable and NULLs are distinct in a
    // unique index, so many un-keyed rows coexist; nothing about their
    // conflict behaviour may change.
    const { fixtureId } = await seedStartedFixture(request);
    const first = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
    });
    expect(first.status).toBe(201);
    const stale = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: 1,
      type: "generic.result",
      payload: RESULT,
    });
    expect(stale.status).toBe(409);
  });
});
