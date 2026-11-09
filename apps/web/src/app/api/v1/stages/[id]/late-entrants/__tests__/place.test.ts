// W4 app-A Task 11 (X-LE-10, ruling 271) — the HANDLER of `POST /stages/{id}/late-entrants/{entrantId}/place`, the
// organiser's one tap on a waiting late player. The usecase is knockout-late-arrival.test.ts's on Postgres; what that suite
// cannot see is the route: that the stage-scoped write door opens BEFORE the usecase runs (and a refusal there reaches
// nothing), that both path params reach the usecase as given, that a placing answer and a refusal ANSWER both ride the
// 200 envelope, and that a named refusal keeps its code and status through `v1()`.
//
// Harness mirrors stages/[id]/__tests__/route.test.ts: mock the auth door and the usecase, drive the real handler through
// the real `v1()` envelope.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS } from "@/lib/knockout-refusals";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { placeWaitingKnockoutEntrant as PlaceFn } from "@/server/usecases/knockout-late-entry";

const AUTH: AuthCtx = { orgId: "org1", via: "session", userId: "user1", role: "owner", keyId: null };
const placeMock = vi.hoisted(() => vi.fn<typeof PlaceFn>());
const authMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<AuthCtx>>(async () => AUTH));
vi.mock("@/server/usecases/knockout-late-entry", () => ({ placeWaitingKnockoutEntrant: placeMock }));
vi.mock("@/server/api-v1/auth", () => ({ requireResourceAuth: authMock }));

import { POST } from "../[entrantId]/place/route";

const STAGE_ID = "11111111-1111-4111-8111-111111111111";
const ENTRANT_ID = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: STAGE_ID, entrantId: ENTRANT_ID }) };
const req = () => new Request(`http://localhost/api/v1/stages/${STAGE_ID}/late-entrants/${ENTRANT_ID}/place`, { method: "POST" });

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
    expect(placeMock).toHaveBeenCalledWith(AUTH, STAGE_ID, ENTRANT_ID);
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
