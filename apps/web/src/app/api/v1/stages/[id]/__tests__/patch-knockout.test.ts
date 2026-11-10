// W4 app B, Task 9 (X-TP-6) - the route half of the third-place setting: `PATCH /stages/{id}` with `{ thirdPlace }`. The usecase
// is third-place-setting.test.ts's on Postgres; what that suite cannot see is the HANDLER: the body's shape picking the knockout
// usecase and not the Swiss one, the strict body refusing an empty object, a typo, a bad value or a MIXED body (Swiss keys beside
// `thirdPlace`) before the usecase, the auth door opening first (#376), and the refusals' machine-readable hints surviving the envelope.
// Harness as route.test.ts: the auth door and the usecases mocked, the real handler and the real `v1()` envelope.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { patchSwissStage as SwissFn } from "@/server/usecases/swiss-rounds-admin";
import type { patchKnockoutStage as KoFn } from "@/server/usecases/stages";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const STAGE_ID = "11111111-1111-4111-8111-111111111111";

const koMock = vi.hoisted(() => vi.fn<typeof KoFn>());
const swissMock = vi.hoisted(() => vi.fn<typeof SwissFn>());
const authMock = vi.hoisted(() => vi.fn(async () => AUTH));
vi.mock("@/server/usecases/swiss-rounds-admin", () => ({ patchSwissStage: swissMock }));
vi.mock("@/server/usecases/stages", () => ({ deleteStage: vi.fn(), getStageWithTableRules: vi.fn(), patchKnockoutStage: koMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { PATCH } from "../route";

const ctx = { params: Promise.resolve({ id: STAGE_ID }) };
const patch = (body: string) =>
  new Request(`http://localhost/api/v1/stages/${STAGE_ID}`, { method: "PATCH", headers: { "content-type": "application/json" }, body });

interface ErrorEnvelope {
  ok: false;
  error: { code: string; message: string; [k: string]: unknown };
}

beforeEach(() => {
  koMock.mockReset();
  swissMock.mockReset();
  authMock.mockReset();
  authMock.mockResolvedValue(AUTH);
  koMock.mockResolvedValue({ stage_id: STAGE_ID, thirdPlace: "playoff", regenerated: true });
  swissMock.mockResolvedValue({ rounds: 3, chess: false, swiss_rounds: null, shells: { added: 0, removed: 0, slots_freed: 0 } } as never);
});

describe("PATCH /api/v1/stages/{id} - a knockout stage's third place", () => {
  it.each(["shared", "playoff"] as const)("%s reaches the knockout usecase verbatim, behind the stage's write door, and never the Swiss one", async (thirdPlace) => {
    koMock.mockResolvedValueOnce({ stage_id: STAGE_ID, thirdPlace, regenerated: false });
    const res = await PATCH(patch(JSON.stringify({ thirdPlace })), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { stage_id: STAGE_ID, thirdPlace, regenerated: false } });
    expect(authMock.mock.calls[0]).toEqual([expect.any(Request), "stage", STAGE_ID, "write"]);
    expect(koMock.mock.calls).toEqual([[AUTH, STAGE_ID, { thirdPlace }]]);
    expect(swissMock).not.toHaveBeenCalled();
  });

  it("a Swiss body still reaches the Swiss usecase, and never the knockout one", async () => {
    const res = await PATCH(patch(JSON.stringify({ rounds: 3 })), ctx);
    expect(res.status).toBe(200);
    expect(swissMock.mock.calls).toEqual([[AUTH, STAGE_ID, { rounds: 3 }]]);
    expect(koMock).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty object", "{}"],
    ["a misspelt key", JSON.stringify({ thirdplace: "playoff" })],
    ["a value that is no mode", JSON.stringify({ thirdPlace: "bronze" })],
    ["the stored boolean (the wire speaks modes)", JSON.stringify({ thirdPlace: true })],
    ["null", JSON.stringify({ thirdPlace: null })],
    ["an unknown key beside a good one", JSON.stringify({ thirdPlace: "playoff", name: "x" })],
    ["Swiss keys beside thirdPlace (one door, one setting at a time)", JSON.stringify({ thirdPlace: "playoff", rounds: 3 })],
  ])("400s %s and edits nothing", async (_label, body) => {
    const res = await PATCH(patch(body), ctx);
    const json = (await res.json()) as ErrorEnvelope;
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION");
    expect(koMock).not.toHaveBeenCalled();
    expect(swissMock).not.toHaveBeenCalled();
  });

  it("refuses an unauthorised caller for AUTH, not for the shape of its body", async () => {
    authMock.mockRejectedValueOnce(new HttpError(403, "Forbidden"));
    const res = await PATCH(patch("{thirdPlace"), ctx);
    expect(res.status).toBe(403);
    expect(koMock).not.toHaveBeenCalled();
  });

  it("passes THIRD_PLACE_LOCKED (409), STAGE_NOT_KNOCKOUT (422) and KO_THIRD_PLACE_TOO_FEW (422, with the count) through intact", async () => {
    let seen = 0;
    for (const [code, extra] of [
      ["THIRD_PLACE_LOCKED", undefined],
      ["STAGE_NOT_KNOCKOUT", undefined],
      ["KO_THIRD_PLACE_TOO_FEW", { entrants: 3 }],
    ] as const) {
      const row = KNOCKOUT_REFUSALS[code];
      koMock.mockRejectedValueOnce(new HttpError(row.status, row.en, code, extra));
      const res = await PATCH(patch(JSON.stringify({ thirdPlace: "playoff" })), ctx);
      const json = (await res.json()) as ErrorEnvelope;
      expect(res.status, code).toBe(row.status);
      expect(json.error, code).toMatchObject({ code, message: row.en, ...(extra ?? {}) });
      seen++;
    }
    expect(seen, "anti-vacuity: all three refusals driven").toBe(3);
  });
});
