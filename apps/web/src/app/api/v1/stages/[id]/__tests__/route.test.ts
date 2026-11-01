// W3 Task 12 (SW-M10, #838) — the route half of the Swiss rounds edit: `PATCH /stages/{id}` with `PatchSwissStage`
// (`{ rounds?, chess? }`, strict, at least one key) and `POST /stages/{id}/swiss/add-round` (no body). The usecases are
// swiss-rounds-admin.test.ts's on Postgres; what that suite cannot see is the HANDLER: whether the auth door opens
// BEFORE the body is parsed (#376's order — publish-schedule/__tests__/route-auth-order.test.ts carries the argument),
// whether the strict body refuses a typo or an empty object instead of reaching the usecase, what exactly reaches the
// usecase, and whether a Swiss refusal's machine-readable hints (`canFinish`, `canAddRound`) survive the envelope.
//
// Harness mirrors generate/__tests__/route.test.ts: mock the auth door and the usecase, drive the real handlers through
// the real `v1()` envelope, read what reached the usecase off the spy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { SWISS_REFUSALS } from "@/lib/swiss-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { patchSwissStage as PatchFn, addSwissRound as AddFn } from "@/server/usecases/swiss-rounds-admin";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };

const PATCHED = { rounds: 3, chess: false, swiss_rounds: null, shells: { added: 0, removed: 0, slots_freed: 0 } };
const patchMock = vi.hoisted(() => vi.fn<typeof PatchFn>());
const addMock = vi.hoisted(() => vi.fn<typeof AddFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/swiss-rounds-admin", () => ({ patchSwissStage: patchMock, addSwissRound: addMock }));
vi.mock("@/server/usecases/stages", () => ({ deleteStage: vi.fn(), getStageWithTableRules: vi.fn() }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { PATCH } from "../route";
import { POST as ADD_ROUND } from "../swiss/add-round/route";

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: STAGE_ID }) };

function patch(body: string): Request {
  return new Request(`http://localhost/api/v1/stages/${STAGE_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
}

function addRound(): Request {
  return new Request(`http://localhost/api/v1/stages/${STAGE_ID}/swiss/add-round`, { method: "POST" });
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; issues?: unknown[]; [k: string]: unknown };
}

beforeEach(() => {
  patchMock.mockReset();
  addMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  patchMock.mockResolvedValue(PATCHED as never);
  addMock.mockResolvedValue({ rounds: 4, shells_added: 3 });
});

describe("PATCH /api/v1/stages/{id} — the Swiss rounds and chess edit", () => {
  it.each([
    ["rounds alone", { rounds: 3 }],
    ["chess alone", { chess: false }],
    ["both", { rounds: 4, chess: true }],
  ])("%s reaches the usecase verbatim, behind the stage's write door", async (_label, body) => {
    const res = await PATCH(patch(JSON.stringify(body)), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: PATCHED });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "write"]);
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0]).toEqual([AUTH, STAGE_ID, body]);
  });

  it.each([
    ["an empty object", "{}"],
    ["a misspelt key", JSON.stringify({ round: 3 })],
    ["an unknown key beside a good one", JSON.stringify({ rounds: 3, name: "x" })],
    ["rounds 0", JSON.stringify({ rounds: 0 })],
    ["rounds not whole", JSON.stringify({ rounds: 2.5 })],
    ["rounds as a string", JSON.stringify({ rounds: "3" })],
    ["chess as a string", JSON.stringify({ chess: "false" })],
    ["rounds null", JSON.stringify({ rounds: null })],
  ])("400s %s and edits nothing", async (_label, body) => {
    const res = await PATCH(patch(body), ctx);
    const json = (await res.json()) as ErrorEnvelope;
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON", async () => {
    const res = await PATCH(patch("{rounds: 3"), ctx);
    expect(res.status).toBe(400);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthorised caller for AUTH, not for the shape of its body", async () => {
    authMock.mockRejectedValueOnce(new HttpError(403, "Forbidden"));
    const res = await PATCH(patch("{rounds: 3"), ctx);
    const json = (await res.json()) as ErrorEnvelope;
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("passes SWISS_ROUNDS_LOCKED through as 409 with canFinish and canAddRound in the envelope", async () => {
    const { status, message } = SWISS_REFUSALS.SWISS_ROUNDS_LOCKED;
    patchMock.mockRejectedValueOnce(new HttpError(status, message, "SWISS_ROUNDS_LOCKED", { canFinish: true, canAddRound: false }));
    const res = await PATCH(patch(JSON.stringify({ rounds: 4 })), ctx);
    const json = (await res.json()) as ErrorEnvelope;
    expect(res.status).toBe(409);
    expect(json.error).toMatchObject({ code: "SWISS_ROUNDS_LOCKED", message, canFinish: true, canAddRound: false });
  });
});

describe("POST /api/v1/stages/{id}/swiss/add-round", () => {
  it("adds a round behind the stage's write door; no body is read", async () => {
    const res = await ADD_ROUND(addRound(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { rounds: 4, shells_added: 3 } });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "write"]);
    expect(addMock.mock.calls[0]).toEqual([AUTH, STAGE_ID]);
  });

  it("refuses an unauthorised caller and adds nothing", async () => {
    authMock.mockRejectedValueOnce(new HttpError(403, "Forbidden"));
    const res = await ADD_ROUND(addRound(), ctx);
    expect(res.status).toBe(403);
    expect(addMock).not.toHaveBeenCalled();
  });

  it("passes SWISS_OVER (422) and SWISS_ROUNDS_ABOVE_MAX (422, with its numbers) through intact", async () => {
    addMock.mockRejectedValueOnce(
      new HttpError(SWISS_REFUSALS.SWISS_OVER.status, SWISS_REFUSALS.SWISS_OVER.message, "SWISS_OVER", { canAddRound: false }),
    );
    const over = await ADD_ROUND(addRound(), ctx);
    expect(over.status).toBe(422);
    expect(((await over.json()) as ErrorEnvelope).error).toMatchObject({ code: "SWISS_OVER", canAddRound: false });

    const above = { rounds: 4, field: 4, hardMax: 3, canFinish: false };
    addMock.mockRejectedValueOnce(
      new HttpError(422, SWISS_REFUSALS.SWISS_ROUNDS_ABOVE_MAX.message, "SWISS_ROUNDS_ABOVE_MAX", above),
    );
    const res = await ADD_ROUND(addRound(), ctx);
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorEnvelope).error).toMatchObject({ code: "SWISS_ROUNDS_ABOVE_MAX", ...above });
  });
});
