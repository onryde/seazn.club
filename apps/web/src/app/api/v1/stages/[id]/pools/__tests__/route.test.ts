// W5 app PR A, Task 22 (X-SF-6; ST-G28) - the HANDLER half of `GET /stages/{id}/pools`. The usecase is standings-api-shape.test.ts's on
// Postgres; what that suite cannot see is the door: the stage's READ door opening first with the stage id, the usecase getting the
// authenticated org's context and the id, the envelope carrying its answer verbatim, and a refusal keeping its status.
// Harness as ../../__tests__/route.test.ts: the auth door and the usecase mocked, the real handler and the real `v1()` envelope.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { listStagePools as ListFn } from "@/server/usecases/stage-standings-api";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const POOL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POOL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const listMock = vi.hoisted(() => vi.fn<typeof ListFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/stage-standings-api", () => ({ listStagePools: listMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { GET } from "../route";

const ctx = { params: Promise.resolve({ id: STAGE_ID }) };
const get = () => new Request(`http://localhost/api/v1/stages/${STAGE_ID}/pools`, { method: "GET" });

beforeEach(() => {
  listMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
});

describe("GET /api/v1/stages/{id}/pools", () => {
  it("opens the stage's READ door with the stage id, then answers the usecase's pools in the envelope", async () => {
    const answer = {
      stage_id: STAGE_ID,
      pools: [
        { id: POOL_A, key: "A", name: "Pool A" },
        { id: POOL_B, key: "B", name: "Pool B" },
      ],
    };
    listMock.mockResolvedValueOnce(answer);
    const res = await GET(get(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: answer });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "read"]);
    expect(listMock.mock.calls).toEqual([[AUTH, STAGE_ID]]);
  });

  it("a stage that lists no pools answers an empty list, not an error", async () => {
    listMock.mockResolvedValueOnce({ stage_id: STAGE_ID, pools: [] });
    const res = await GET(get(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { stage_id: STAGE_ID, pools: [] } });
  });

  it("a refused door never reaches the usecase", async () => {
    authMock.mockRejectedValueOnce(new HttpError(403, "forbidden"));
    const res = await GET(get(), ctx);
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("a usecase 404 keeps its status in the envelope", async () => {
    listMock.mockRejectedValueOnce(new HttpError(404, "stage not found"));
    const res = await GET(get(), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { message: "stage not found" } });
  });
});
