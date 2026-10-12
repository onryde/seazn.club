// T14 — the room's client calls. The wire types in room-api.ts mirror server
// types the client bundle may not import; the type-level block below fails
// COMPILATION (tsc, not vitest) when a mirror drifts from its source. The
// runtime block pins the envelope reading against v1's real envelope shape.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { RoomAct, RoomActOut, RoomCameraFault } from "@/server/api-v1/schemas";
import type { SeatWire, RoomClaim, CameraFaultReport } from "@/server/usecases/external-play/room";
import type { ParticipantToken } from "@/server/external-play/video/realtimekit";
import {
  claimSeat,
  fetchRoom,
  roomApiPath,
  sendAct,
  sendCameraFault,
  sendClockZero,
  type CameraFaultBody,
  type ParticipantWire,
  type RoomActAnswer,
  type RoomActBody,
  type RoomClaimAnswer,
  type SeatAnswer,
} from "../room-api";

describe("the wire mirrors match their server sources (type level)", () => {
  it("RoomActBody IS the act route's schema type, both ways", () => {
    expectTypeOf<RoomActBody>().toEqualTypeOf<RoomAct>();
  });
  it("every RoomActOut the server can send is a RoomActAnswer the client reads", () => {
    expectTypeOf<RoomActOut>().toExtend<RoomActAnswer>();
  });
  it("SeatAnswer IS the usecase's SeatWire; the participant IS RealtimeKit's token shape", () => {
    expectTypeOf<SeatAnswer>().toEqualTypeOf<SeatWire>();
    expectTypeOf<ParticipantWire>().toEqualTypeOf<ParticipantToken>();
  });
  it("the POST answer IS RoomClaim — T9's `create` included (review m3: the route no longer drops it)", () => {
    expectTypeOf<RoomClaimAnswer>().toEqualTypeOf<RoomClaim>();
  });
  it("the camera-fault body IS the route's schema type and the usecase's report (I-1)", () => {
    expectTypeOf<CameraFaultBody>().toEqualTypeOf<RoomCameraFault>();
    expectTypeOf<CameraFaultBody>().toEqualTypeOf<CameraFaultReport>();
  });
});

type Seen = { url: string; init: RequestInit };
function fakeFetch(respond: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const s = { url, init };
    seen.push(s);
    return respond(s);
  }) as unknown as typeof fetch;
  return { f, seen };
}
const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data, requestId: "r" }), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) =>
  new Response(JSON.stringify({ ok: false, error: { code, message: "x" }, requestId: "r" }), { status });

describe("roomApiPath", () => {
  it("the three routes, the personal link carried as ?t= and URL-encoded; no link ⇒ no query", () => {
    expect(roomApiPath("f-1", "", null)).toBe("/api/v1/fixtures/f-1/external-play/room");
    expect(roomApiPath("f-1", "/act", "a.b+c/d=")).toBe("/api/v1/fixtures/f-1/external-play/room/act?t=a.b%2Bc%2Fd%3D");
    expect(roomApiPath("f 1", "/clock-zero", "")).toBe("/api/v1/fixtures/f%201/external-play/room/clock-zero");
  });
});

describe("the calls", () => {
  it("GET reads the envelope's data; POST seat and clock-zero are POSTs with no body", async () => {
    const { f, seen } = fakeFetch(() => envelope({ any: 1 }));
    expect(await fetchRoom("f-1", "tok", f)).toEqual({ ok: true, data: { any: 1 } });
    expect(await claimSeat("f-1", null, f)).toEqual({ ok: true, data: { any: 1 } });
    expect(await sendClockZero("f-1", null, f)).toEqual({ ok: true, data: { any: 1 } });
    expect(seen.map((s) => [s.init.method, s.url, s.init.body ?? null])).toEqual([
      ["GET", "/api/v1/fixtures/f-1/external-play/room?t=tok", null],
      ["POST", "/api/v1/fixtures/f-1/external-play/room", null],
      ["POST", "/api/v1/fixtures/f-1/external-play/room/clock-zero", null],
    ]);
    for (const s of seen) expect([s.init.credentials, s.init.cache]).toEqual(["same-origin", "no-store"]);
  });

  it("camera-fault posts {state, participantId} as JSON, kept alive past an unload (the page closing mid-recovery still ends our stamp)", async () => {
    const { f, seen } = fakeFetch(() => envelope({ open: false }));
    expect(await sendCameraFault("f-1", "tok", { state: "end", participantId: "pt-1" }, f)).toEqual({ ok: true, data: { open: false } });
    expect([seen[0]!.init.method, seen[0]!.url]).toEqual(["POST", "/api/v1/fixtures/f-1/external-play/room/camera-fault?t=tok"]);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ state: "end", participantId: "pt-1" });
    expect(new Headers(seen[0]!.init.headers).get("content-type")).toBe("application/json");
    expect(seen[0]!.init.keepalive).toBe(true);
  });

  it("act posts the action as JSON, verbatim", async () => {
    const { f, seen } = fakeFetch(() => envelope({ ok: true, applied: true }));
    const r = await sendAct("f-1", null, { kind: "move", uci: "e7e8q" }, f);
    expect(r).toEqual({ ok: true, data: { ok: true, applied: true } });
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ kind: "move", uci: "e7e8q" });
    expect(new Headers(seen[0]!.init.headers).get("content-type")).toBe("application/json");
  });

  it("an error envelope answers its status and code; a non-JSON body answers code null; a thrown fetch is status 0", async () => {
    expect(await fetchRoom("f", null, fakeFetch(() => failure(404, "NOT_FOUND")).f)).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(await fetchRoom("f", null, fakeFetch(() => new Response("<html>", { status: 502 })).f)).toEqual({ ok: false, status: 502, code: null });
    expect(
      await fetchRoom(
        "f",
        null,
        fakeFetch(() => {
          throw new TypeError("network");
        }).f,
      ),
    ).toEqual({ ok: false, status: 0, code: null });
  });

  it("a 200 that is not an ok envelope is NOT success (no data invented)", async () => {
    const odd = new Response(JSON.stringify({ ok: false }), { status: 200 });
    expect(await fetchRoom("f", null, fakeFetch(() => odd).f)).toEqual({ ok: false, status: 200, code: null });
  });
});
