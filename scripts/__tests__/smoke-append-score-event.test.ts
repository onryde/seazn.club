// W3 app-B T5 review m6: the smoke harness's `appendScoreEvent` keyed every event `(fixture, type, attempt)`. Since V413 the server
// holds `(fixture_id, idempotency_key)` unique on `score_events` and answers a repeat of a key with the FIRST answer, applying
// nothing (scoring.ts `replayOutcomeFor`). So the second event of one type on one fixture - ice hockey's three `period.advance`, a
// second `game.summary` - was reported a success and never applied. The key is now unique per CALL as well.
//
// The server is a fake that obeys exactly that one rule (a repeated key replays the stored answer and applies nothing), nothing
// more; the live witness is smoke check 6 (w3SwissB), whose three `period.advance` a board now go through this helper.
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendScoreEvent, newSession } from "../smoke/harness.ts";

interface Posted {
  fixtureId: string;
  type: string;
  key: string;
  applied: boolean;
}

/** A fake `/api/v1/fixtures/{id}/{state,events}` with V413's replay rule; `conflicts` first POSTs answer 409 and apply nothing. */
function fakeServer(conflicts = 0) {
  const stored = new Map<string, number>(); // `${fixture}|${key}` -> the seq it was applied at
  const seqOf = new Map<string, number>();
  const posted: Posted[] = [];
  let left = conflicts;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const fixtureId = /fixtures\/([^/]+)\//.exec(path)![1]!;
    if (path.endsWith("/state")) return reply(200, { ok: true, data: { last_seq: seqOf.get(fixtureId) ?? 0 } });
    const body = JSON.parse(String(init?.body)) as { expected_seq: number; type: string; idempotency_key: string };
    if (left > 0) {
      left--;
      posted.push({ fixtureId, type: body.type, key: body.idempotency_key, applied: false });
      return reply(409, { ok: false, error: { code: "SEQ_CONFLICT", current_seq: seqOf.get(fixtureId) ?? 0 } });
    }
    const slot = `${fixtureId}|${body.idempotency_key}`;
    const replay = stored.has(slot);
    if (!replay) {
      const next = (seqOf.get(fixtureId) ?? 0) + 1;
      seqOf.set(fixtureId, next);
      stored.set(slot, next);
    }
    posted.push({ fixtureId, type: body.type, key: body.idempotency_key, applied: !replay });
    return reply(200, { ok: true, data: { seq: stored.get(slot) } });
  };
  return { impl, posted, seqOf };
}

afterEach(() => vi.unstubAllGlobals());

describe("smoke harness appendScoreEvent: an idempotency key that is unique per call (T5 review m6)", () => {
  it("empty case: one event is applied once, with a key naming its fixture and type", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(server.impl));
    const res = await appendScoreEvent(newSession(), "fx-1", "core.start", {});
    expect(res.status).toBe(200);
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0]).toMatchObject({ fixtureId: "fx-1", type: "core.start", applied: true });
    expect(server.posted[0]!.key).toContain("fx-1-core.start");
  });

  it("three events of ONE type on one fixture are all applied, not replayed (differential: the (fixture, type) key applied only the first)", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(server.impl));
    const s = newSession();
    for (const to of ["P2", "P3", "FT"]) await appendScoreEvent(s, "fx-1", "icehockey.period.advance", { to });
    expect(server.posted, "anti-vacuity: three posts reached the server").toHaveLength(3);
    expect(new Set(server.posted.map((p) => p.key)).size, "three distinct keys").toBe(3);
    expect(server.posted.map((p) => p.applied), "each one applied").toEqual([true, true, true]);
    expect(server.seqOf.get("fx-1"), "the fixture's ledger holds all three").toBe(3);
  });

  it("another fixture and another type do not collide either", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", vi.fn(server.impl));
    const s = newSession();
    await appendScoreEvent(s, "fx-1", "core.start", {});
    await appendScoreEvent(s, "fx-2", "core.start", {});
    await appendScoreEvent(s, "fx-1", "icehockey.goal", { by: "a" });
    await appendScoreEvent(s, "fx-1", "icehockey.goal", { by: "b" });
    expect(server.posted.map((p) => p.applied)).toEqual([true, true, true, true]);
    expect(server.seqOf.get("fx-1")).toBe(3);
    expect(server.seqOf.get("fx-2")).toBe(1);
  });

  it("a 409 retry lands once under a fresh key, and the next call after it is applied too", async () => {
    const server = fakeServer(1);
    vi.stubGlobal("fetch", vi.fn(server.impl));
    const s = newSession();
    const first = await appendScoreEvent(s, "fx-1", "core.start", {});
    expect(first.status).toBe(200);
    expect(server.posted.map((p) => p.applied), "the 409 attempt applied nothing, the retry applied once").toEqual([false, true]);
    expect(new Set(server.posted.map((p) => p.key)).size, "the retry used a fresh key").toBe(2);
    await appendScoreEvent(s, "fx-1", "core.start", {});
    expect(server.posted.at(-1)!.applied, "and a later call of the same type is applied").toBe(true);
    expect(server.seqOf.get("fx-1")).toBe(2);
  });
});
