// W4 app B, B5a Task 12 (X-CH-4) - the HANDLERS of `POST` and `DELETE /fixtures/{id}/joint-winners`. The usecase is
// joint-winners.test.ts's on Postgres; what that suite cannot see is the route: the fixture's write door opens BEFORE the
// usecase runs (a refusal there reaches nothing), the id reaches the usecase as given, and a named refusal keeps its code
// and status through `v1()`. Harness mirrors stages/[id]/late-entrants/__tests__/place.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { declareJointWinners as DeclareFn, undoJointWinners as UndoFn } from "@/server/usecases/joint-winners";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const declareMock = vi.hoisted(() => vi.fn<typeof DeclareFn>());
const undoMock = vi.hoisted(() => vi.fn<typeof UndoFn>());
const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<AuthCtx>>(async () => AUTH));
vi.mock("@/server/usecases/joint-winners", () => ({ declareJointWinners: declareMock, undoJointWinners: undoMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { DELETE, POST } from "../route";

const FIXTURE_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: FIXTURE_ID }) };
const req = (method: string) => new Request(`http://localhost/api/v1/fixtures/${FIXTURE_ID}/joint-winners`, { method });

beforeEach(() => {
  declareMock.mockReset();
  undoMock.mockReset();
  authMock.mockReset();
  authMock.mockImplementation(async () => AUTH);
});

describe("POST /fixtures/{id}/joint-winners", () => {
  it("opens the fixture's write door, then hands the usecase the id; the answer rides the 200 envelope", async () => {
    const out = { fixture_id: FIXTURE_ID, stage_completed: true };
    declareMock.mockResolvedValue(out);
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: out });
    expect(authMock.mock.calls[0]!.slice(1)).toEqual(["fixture", FIXTURE_ID, "write"]);
    expect(declareMock).toHaveBeenCalledWith(AUTH, FIXTURE_ID);
    expect(undoMock).not.toHaveBeenCalled();
  });

  it("a named refusal keeps its status and code", async () => {
    const row = KNOCKOUT_REFUSALS.JOINT_WINNERS_NOT_A_FINAL;
    declareMock.mockRejectedValue(new HttpError(row.status, row.en, "JOINT_WINNERS_NOT_A_FINAL"));
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "JOINT_WINNERS_NOT_A_FINAL", message: row.en } });
  });

  it("the door refusing reaches no usecase", async () => {
    authMock.mockImplementation(async () => {
      throw new HttpError(403, "forbidden");
    });
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(403);
    expect(declareMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /fixtures/{id}/joint-winners", () => {
  it("opens the same write door, then the Undo usecase", async () => {
    const out = { fixture_id: FIXTURE_ID, status: "scheduled" };
    undoMock.mockResolvedValue(out);
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: out });
    expect(authMock.mock.calls[0]!.slice(1)).toEqual(["fixture", FIXTURE_ID, "write"]);
    expect(undoMock).toHaveBeenCalledWith(AUTH, FIXTURE_ID);
    expect(declareMock).not.toHaveBeenCalled();
  });

  it("a named refusal keeps its status and code; the door refusing reaches no usecase", async () => {
    const row = KNOCKOUT_REFUSALS.JOINT_WINNERS_NOT_DECLARED;
    undoMock.mockRejectedValue(new HttpError(row.status, row.en, "JOINT_WINNERS_NOT_DECLARED"));
    const res = await DELETE(req("DELETE"), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "JOINT_WINNERS_NOT_DECLARED" } });
    undoMock.mockReset();
    authMock.mockImplementation(async () => {
      throw new HttpError(403, "forbidden");
    });
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(403);
    expect(undoMock).not.toHaveBeenCalled();
  });
});
