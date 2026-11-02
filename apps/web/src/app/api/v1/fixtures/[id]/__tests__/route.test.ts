// W3 Task 14 (SW-L12, RB3-25, X-SW-30) — a Swiss pairing is changed by Unpair then Pair next, never by editing a board.
// The "blocked" half of the rule already held: `PATCH /fixtures/{id}` takes `PatchFixture`, a `.strict()` schema of
// schedule, court, officials, lock and `expected_seq`, so a body that names a seat (`home_entrant_id`,
// `away_entrant_id`) is a 400 before the handler reaches the usecase. Only the guidance was missing (the Pair next
// menu's read-only line, stages-panel-swiss-pairing.test.tsx). This file pins the refusal so the guidance can never
// promise a door that opens: the day someone adds a seat key to `PatchFixture`, this reds first.
//
// Harness mirrors stages/[id]/__tests__/route.test.ts: mock the auth door and the usecase, drive the real handler
// through the real `v1()` envelope, read what reached the usecase off the spy. A handler test can show the write never
// happens (the spy is untouched); the row read-back over real HTTP and Postgres is smoke check 19 (w3SwissA.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { patchFixture as PatchFn } from "@/server/usecases/fixtures";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };

const patchMock = vi.hoisted(() => vi.fn<typeof PatchFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/fixtures", () => ({ getFixture: vi.fn(), patchFixture: patchMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock, requireFixtureActor: authMock }));

import { PATCH } from "../route";

// A board of a Swiss round 2: the id is all the handler sees; the round lives in the row the usecase would load.
const FIXTURE_ID = "22222222-2222-4222-8222-222222222222";
const SEAT_A = "33333333-3333-4333-8333-333333333333";
const SEAT_B = "44444444-4444-4444-8444-444444444444";
const ctx = { params: Promise.resolve({ id: FIXTURE_ID }) };

function patch(body: unknown): Request {
  return new Request(`http://localhost/api/v1/fixtures/${FIXTURE_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; issues?: { code?: string; keys?: string[] }[] };
}

beforeEach(() => {
  patchMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  patchMock.mockResolvedValue({ id: FIXTURE_ID } as never);
});

describe("PATCH /api/v1/fixtures/{id} — a Swiss pairing is not edited board by board (X-SW-30)", () => {
  // The seat keys a client could try, alone and beside a legitimate key (the legitimate key must not smuggle the
  // seat through: a strict schema refuses the whole body, so the schedule edit does not land either).
  const SEAT_BODIES: [string, Record<string, unknown>, string[]][] = [
    ["home_entrant_id", { home_entrant_id: SEAT_A }, ["home_entrant_id"]],
    ["away_entrant_id", { away_entrant_id: SEAT_B }, ["away_entrant_id"]],
    ["both seats (a swap)", { home_entrant_id: SEAT_B, away_entrant_id: SEAT_A }, ["home_entrant_id", "away_entrant_id"]],
    [
      "a seat beside a good schedule edit",
      { scheduled_at: "2030-06-18T10:00:00.000Z", home_entrant_id: SEAT_A },
      ["home_entrant_id"],
    ],
  ];

  it("X-SW-30 PATCH a round-2 Swiss fixture with home_entrant_id is refused (400) and the seat is unchanged", async () => {
    // Positive control first: the same handler, same fixture, takes a legitimate edit — so the refusals below are the
    // seat keys' doing, not a broken harness or a handler that refuses everything.
    const ok = await PATCH(patch({ scheduled_at: null }), ctx);
    expect(ok.status).toBe(200);
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]).toEqual([AUTH, FIXTURE_ID, { scheduled_at: null }]);
    patchMock.mockClear();

    let checked = 0;
    for (const [label, body, named] of SEAT_BODIES) {
      const res = await PATCH(patch(body), ctx);
      const json = (await res.json()) as ErrorEnvelope;
      expect(res.status, `${label}: refused`).toBe(400);
      expect(json.ok, label).toBe(false);
      expect(json.error.code, label).toBe("VALIDATION");
      // The refusal names the keys it refused, so a client sees WHICH field is not editable.
      const refused = (json.error.issues ?? []).flatMap((i) => (i.code === "unrecognized_keys" ? (i.keys ?? []) : []));
      expect(refused.sort(), `${label}: the keys it names`).toEqual([...named].sort());
      checked++;
    }
    // The seat is unchanged: no refusal reached the usecase that writes a fixture.
    expect(patchMock, "no refused body reached patchFixture").not.toHaveBeenCalled();
    expect(checked, "anti-vacuity: every seat body was driven").toBe(SEAT_BODIES.length);
    expect(checked).toBeGreaterThan(0);
  });
});
