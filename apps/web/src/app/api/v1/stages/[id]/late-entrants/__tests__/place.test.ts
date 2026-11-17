// W4 app-A Task 11 (X-LE-10, ruling 271) — the HANDLER of `POST /stages/{id}/late-entrants/{entrantId}/place`, the
// organiser's one tap on a waiting late player. The usecase is knockout-late-arrival.test.ts's on Postgres; what that suite
// cannot see is the route: that the stage-scoped write door opens BEFORE the usecase runs (and a refusal there reaches
// nothing), that both path params reach the usecase as given, that a placing answer and a refusal ANSWER both ride the
// 200 envelope, and that a named refusal keeps its code and status through `v1()`.
//
// Harness mirrors stages/[id]/__tests__/route.test.ts: mock the auth door and the usecase, drive the real handler through
// the real `v1()` envelope.
//
// W5 T6 (X-CU-8): the route now hands the tap to `placeWaitingLateEntrant`, which dispatches by the stage's kind (a league or
// group to the table tap, everything else to the knockout one — table-late-arrival.test.ts drives that on Postgres), and reads
// an OPTIONAL body `{ pool_key }`: absent is the W4 call, a pool reaches the usecase, a body that is not JSON is a 400.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { placeWaitingLateEntrant as PlaceFn } from "@/server/usecases/roundrobin-late-entry";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const placeMock = vi.hoisted(() => vi.fn<typeof PlaceFn>());
const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<AuthCtx>>(async () => AUTH));
vi.mock("@/server/usecases/roundrobin-late-entry", () => ({ placeWaitingLateEntrant: placeMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { POST } from "../[entrantId]/place/route";

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ENTRANT_ID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: STAGE_ID, entrantId: ENTRANT_ID }) };
const req = (body?: string) =>
  new Request(`http://localhost/api/v1/stages/${STAGE_ID}/late-entrants/${ENTRANT_ID}/place`, { method: "POST", ...(body === undefined ? {} : { body }) });

beforeEach(() => {
  placeMock.mockReset();
  authMock.mockReset();
  authMock.mockImplementation(async () => AUTH);
});

describe("POST /stages/{id}/late-entrants/{entrantId}/place", () => {
  it("opens the stage's write door, then hands the usecase both ids; a placing answer is 200", async () => {
    const placed = { format: "knockout" as const, entrant_id: ENTRANT_ID, stage_id: STAGE_ID, case: "bye" as const, fixture_id: STAGE_ID, opponent_id: ENTRANT_ID, scheduled: false };
    placeMock.mockResolvedValue(placed);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: placed });
    expect(authMock).toHaveBeenCalledTimes(1);
    expect(authMock.mock.calls[0]!.slice(1)).toEqual(["stage", STAGE_ID, "write"]);
    expect(placeMock).toHaveBeenCalledWith(AUTH, STAGE_ID, ENTRANT_ID, undefined);
  });

  it("X-CU-8 a table answer rides the same envelope, and a body's pool_key reaches the usecase", async () => {
    const placed = { format: "group" as const, entrant_id: ENTRANT_ID, stage_id: STAGE_ID, case: "catch_up" as const, source: "organiser" as const, pool_key: "B" };
    placeMock.mockResolvedValue(placed);
    const res = await POST(req(JSON.stringify({ pool_key: "B" })), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: placed });
    expect(placeMock).toHaveBeenCalledWith(AUTH, STAGE_ID, ENTRANT_ID, "B");
  });

  it("X-CU-8 a body that is not JSON, or a pool_key that is no pool name, is a 400 and reaches no usecase", async () => {
    let checked = 0;
    for (const body of ["{not json", JSON.stringify({ pool_key: "" }), JSON.stringify({ pool_key: "ABC" })]) {
      const res = await POST(req(body), ctx);
      expect(res.status, body).toBe(400);
      checked++;
    }
    expect(checked).toBe(3);
    expect(placeMock).not.toHaveBeenCalled();
  });

  it("a refusal ANSWER (no slot, Rebuild offered) is 200 too: the player keeps waiting", async () => {
    const answer = { format: "knockout" as const, entrant_id: ENTRANT_ID, stage_id: STAGE_ID, case: "rebuild_offered" as const, reason: "KO_LATE_ENTRY_NO_SLOT" };
    placeMock.mockResolvedValue(answer);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: answer });
  });

  it("a named refusal keeps its status and code through the envelope", async () => {
    const row = KNOCKOUT_REFUSALS.KO_LATE_ENTRY_NOT_WAITING;
    placeMock.mockRejectedValue(new HttpError(row.status, row.en, "KO_LATE_ENTRY_NOT_WAITING"));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "KO_LATE_ENTRY_NOT_WAITING", message: row.en } });
  });

  it("the door refusing reaches no usecase", async () => {
    authMock.mockImplementation(async () => {
      throw new HttpError(403, "forbidden");
    });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(403);
    expect(placeMock).not.toHaveBeenCalled();
  });
});
