// Swiss round-1 pairing (spec 2026-09-22), Task 3 — the route half of the
// optional `{ pairing }` body. `GenerateStageInput` itself is pinned in
// server/api-v1/__tests__/generate-stage-input.test.ts; what that suite cannot
// see is the HANDLER: whether the body is read at all, whether an API caller
// that POSTs with NO body still gets through (`parseBody` would 400 it, which
// is why the route reads text), whether the parsed mode is what actually
// reaches `generateStageFixtures`, and whether the auth door opens BEFORE the
// body is parsed (the #376 order — publish-schedule/__tests__/
// route-auth-order.test.ts carries the argument).
//
// Harness mirrors format-preview/__tests__/route.test.ts: mock the auth door
// and the usecase, drive the real `POST` through the real `v1()` envelope, and
// read what reached the usecase off the spy. No DB — the draw itself is Task 2's
// suite, not this one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import {
  SWISS_PAIRING_ROUND_ONE_ONLY_CODE,
  SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE,
} from "@/lib/swiss-pairing";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { GenerateOptions, GenerateOutcome } from "@/server/usecases/stages";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };

// Explicit signature so `.mock.calls[0]` types as the real 3-tuple.
const generateMock = vi.hoisted(() =>
  vi.fn<(auth: AuthCtx, stageId: string, opts?: GenerateOptions) => Promise<GenerateOutcome>>(
    async () => ({ created: 0, existing: 0, fixtures: [] }),
  ),
);
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/stages", () => ({ generateStageFixtures: generateMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { POST } from "../route";

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: STAGE_ID }) };

/** `body` is sent VERBATIM; undefined means no body at all. The desk itself
 *  sends `"{}"` (stages-panel.tsx posts `json: {}`, and client-v1 stringifies
 *  it). A body-less POST is the API-key caller written before this body
 *  existed. */
function post(body?: string): Request {
  return new Request(`http://localhost/api/v1/stages/${STAGE_ID}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; issues?: unknown[] };
}

// mockReset, not mockClear: it also drops any unconsumed `…Once` value, so a
// refusal queued by one test can never leak into the next (vitest 4 restores
// the `vi.fn(impl)` default).
beforeEach(() => {
  generateMock.mockReset();
  authMock.mockReset();
});

describe("POST /api/v1/stages/{id}/generate — optional { pairing } body", () => {
  it("a POST with NO body still generates, and reaches the usecase with {}", async () => {
    const res = await POST(post(), ctx);

    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0]).toEqual([AUTH, STAGE_ID, {}]);
  });

  it.each([
    ["the desk's `{}`", "{}"],
    ["a whitespace-only body", " \n"],
  ])("%s reaches the usecase with {}", async (_label, body) => {
    const res = await POST(post(body), ctx);

    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0]).toEqual([AUTH, STAGE_ID, {}]);
  });

  it("forwards a valid pairing mode to the usecase", async () => {
    const res = await POST(post(JSON.stringify({ pairing: "rank_adjacent" })), ctx);

    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0]).toEqual([AUTH, STAGE_ID, { pairing: "rank_adjacent" }]);
  });

  it("400s a body that is not JSON, and generates nothing", async () => {
    const res = await POST(post("{pairing: fold"), ctx);
    const json = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(400);
    expect(json.error.message).toBe("Request body must be valid JSON");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("400s a misspelt key rather than generating with the default mode", async () => {
    const res = await POST(post(JSON.stringify({ paring: "fold" })), ctx);
    const json = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
    // The strict-object refusal, not the JSON one — and it names the typo.
    expect(json.error.message).toBe("Invalid input");
    expect(JSON.stringify(json.error.issues)).toContain("paring");
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthorised caller for AUTH, not for the shape of its body", async () => {
    // A body that is not even JSON: if the route parsed before it authenticated,
    // this caller would be told "400 Request body must be valid JSON" — the
    // leak and the probe-degradation #376 fixed on six sibling routes.
    authMock.mockRejectedValueOnce(new HttpError(403, "Forbidden"));

    const res = await POST(post("{pairing: fold"), ctx);
    const json = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes the usecase's round-1-only refusal through with its code intact", async () => {
    generateMock.mockRejectedValueOnce(
      new HttpError(422, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE, SWISS_PAIRING_ROUND_ONE_ONLY_CODE),
    );

    const res = await POST(post(JSON.stringify({ pairing: "fold" })), ctx);
    const json = (await res.json()) as ErrorEnvelope;

    expect(res.status).toBe(422);
    expect(json.error.code).toBe(SWISS_PAIRING_ROUND_ONE_ONLY_CODE);
    expect(json.error.message).toBe(SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE);
  });
});
