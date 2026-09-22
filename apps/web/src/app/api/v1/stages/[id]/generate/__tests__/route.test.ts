// Swiss round-1 pairing (spec 2026-09-22), Task 3 — the route half of the
// optional `{ pairing }` body. `GenerateStageInput` itself is pinned in
// server/api-v1/__tests__/generate-stage-input.test.ts; what that suite cannot
// see is the HANDLER: whether the body is read at all, whether an existing
// caller that POSTs with NO body still gets through (`parseBody` would 400 it,
// which is why the route reads text), and whether the parsed mode is what
// actually reaches `generateStageFixtures`.
//
// Harness mirrors format-preview/__tests__/route.test.ts: mock the auth door
// and the usecase, drive the real `POST` through the real `v1()` envelope, and
// read what reached the usecase off the spy. No DB — the draw itself is Task 2's
// suite, not this one.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

/** `body` is sent VERBATIM — undefined means no body at all, which is what the
 *  existing desk caller does. */
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

beforeEach(() => {
  generateMock.mockClear();
  authMock.mockClear();
});

describe("POST /api/v1/stages/{id}/generate — optional { pairing } body", () => {
  it("a POST with NO body still generates, and reaches the usecase with {}", async () => {
    const res = await POST(post(), ctx);

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
});
