// W5 app PR B, Task 7 (X-ADJ-4; C5) - the HANDLER half of `POST|GET /stages/{id}/adjustments` and `DELETE /stages/{id}/adjustments/{seq}`.
// The usecase is points-adjustments.test.ts's on Postgres (every refusal by its engine reason name, through the real fold); what that
// suite cannot see is the door: the stage's WRITE door opening first with the stage id, the body parsed against the contract, the
// answer's 201, a named refusal keeping its status and code in the envelope, and the Undo's seq read from the path.
// Harness as ../../pools/__tests__/route.test.ts: the auth door and the usecase mocked, the real handler and the real `v1()` envelope.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { roundRobinRefusal } from "@/server/usecases/roundrobin-refusal";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ENTRANT = "22222222-2222-4222-8222-222222222222";

const adjustMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const undoMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/points-adjustments", () => ({ adjustPoints: adjustMock, listPointsAdjustments: listMock, undoPointsAdjustment: undoMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { GET, POST } from "../route";
import { DELETE } from "../[seq]/route";

const ctx = { params: Promise.resolve({ id: STAGE_ID }) };
const post = (body: unknown) =>
  new Request(`http://localhost/api/v1/stages/${STAGE_ID}/adjustments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const m of [adjustMock, listMock, undoMock, authMock]) m.mockReset();
  authMock.mockResolvedValue(AUTH);
});

describe("POST /api/v1/stages/{id}/adjustments", () => {
  it("opens the stage's WRITE door with the stage id, hands the parsed body on, answers 201 with the usecase's adjustment", async () => {
    const answer = { adjustment: { seq: 9, stage_id: STAGE_ID, entrant_id: ENTRANT, delta: -3, reason: "r", unit: "points", points_unit: "whole", at: "2026-11-16T10:00:00.000Z", held: false } };
    adjustMock.mockResolvedValueOnce(answer);
    const res = await POST(post({ entrant_id: ENTRANT, delta: -3, reason: "r" }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, data: answer });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "write"]);
    expect(adjustMock.mock.calls).toEqual([[AUTH, STAGE_ID, { entrant_id: ENTRANT, delta: -3, reason: "r" }]]);
  });

  it("a named refusal keeps its status and its code (X-ADJ-4 a reason is required)", async () => {
    adjustMock.mockRejectedValueOnce(roundRobinRefusal("RR_ADJUST_REASON_MISSING"));
    const res = await POST(post({ entrant_id: ENTRANT, delta: -3, reason: "" }), ctx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "RR_ADJUST_REASON_MISSING" } });
  });

  it("a body the contract refuses (no delta, a reason past 200 characters, a part or past 999 - B3 ruling 4) never reaches the usecase", async () => {
    const bodies = [
      { entrant_id: ENTRANT, reason: "r" },
      { entrant_id: ENTRANT, delta: -3, reason: "x".repeat(201) },
      { entrant_id: ENTRANT, delta: 1.5, reason: "r" },
      { entrant_id: ENTRANT, delta: 1000, reason: "r" },
      { entrant_id: ENTRANT, delta: -1000, reason: "r" },
    ];
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      const res = await POST(post(body), ctx);
      expect(res.status).toBe(400);
    }
    expect(adjustMock).not.toHaveBeenCalled();
  });

  it("a refused door never reaches the usecase", async () => {
    authMock.mockRejectedValueOnce(new HttpError(403, "forbidden"));
    const res = await POST(post({ entrant_id: ENTRANT, delta: -3, reason: "r" }), ctx);
    expect(res.status).toBe(403);
    expect(adjustMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/stages/{id}/adjustments", () => {
  it("opens the READ door and answers the list", async () => {
    listMock.mockResolvedValueOnce({ adjustments: [] });
    const res = await GET(new Request(`http://localhost/api/v1/stages/${STAGE_ID}/adjustments`), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { adjustments: [] } });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "read"]);
  });
});

describe("DELETE /api/v1/stages/{id}/adjustments/{seq}", () => {
  const del = (seq: string) => DELETE(new Request(`http://localhost/api/v1/stages/${STAGE_ID}/adjustments/${seq}`, { method: "DELETE" }), { params: Promise.resolve({ id: STAGE_ID, seq }) });
  it("hands the usecase the seq as a number, behind the WRITE door", async () => {
    undoMock.mockResolvedValueOnce({ undone: 9, voided_by: 10 });
    const res = await del("9");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { undone: 9, voided_by: 10 } });
    expect(undoMock.mock.calls).toEqual([[AUTH, STAGE_ID, 9]]);
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "write"]);
  });
  it("a seq that is no ledger position is a 404, never a usecase call; a repeat Undo keeps its 409 by name", async () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) expect((await del(bad)).status, bad).toBe(404);
    expect(undoMock).not.toHaveBeenCalled();
    undoMock.mockRejectedValueOnce(roundRobinRefusal("RR_ADJUST_ALREADY_UNDONE"));
    const res = await del("9");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "RR_ADJUST_ALREADY_UNDONE" } });
  });
});
