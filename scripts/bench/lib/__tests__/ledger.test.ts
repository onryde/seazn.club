// Unit coverage for the tap driver's ledger reader. No live server: the
// transport is injected, the same DI seam `simulate.ts`/`oracle.ts` use, so
// nothing here touches `global.fetch`.
import { describe, expect, it } from "vitest";
import { fetchFixtureLedger, fetchFixtureStatus } from "../ledger.ts";
import { newSession } from "../http.ts";

function transportReturning(byPath: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    raw: async (_base: string, _s: unknown, path: string) => {
      calls.push(path);
      const json = byPath[path];
      if (json === undefined) throw new Error(`unexpected path ${path}`);
      return { status: 200, json: { ok: true, data: json } };
    },
  };
}

/** The real v1 error envelope (`api-v1/http.ts`'s `errorResponse`): a refusal
 *  carries `ok:false` + `error{code,message}` and NO `data` at all. */
function transportRefusing(status: number, code: string, message: string) {
  const calls: string[] = [];
  return {
    calls,
    raw: async (_base: string, _s: unknown, path: string) => {
      calls.push(path);
      return { status, json: { ok: false, error: { code, message }, requestId: "r1" } };
    },
  };
}

/** A 200 whose envelope is not what this module expects — no `data` at all, or
 *  a `data` of the wrong shape. Distinct from a refusal: the call "succeeded". */
function transportReturningBody(json: { ok: boolean; data?: unknown }) {
  const calls: string[] = [];
  return {
    calls,
    raw: async (_base: string, _s: unknown, path: string) => {
      calls.push(path);
      return { status: 200, json };
    },
  };
}

describe("fetchFixtureLedger", () => {
  it("asks only for rows after the seq it was given, and returns them in seq order", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/events?since_seq=2": [
        { id: "e4", seq: 4, type: "carrom.board.summary", payload: { winner: "en1" } },
        { id: "e3", seq: 3, type: "carrom.board.summary", payload: { winner: "en2" } },
      ],
    });
    const rows = await fetchFixtureLedger("http://x", newSession(), "f1", 2, t);
    expect(rows.map((r) => r.seq)).toEqual([3, 4]);
    expect(t.calls).toEqual(["/api/v1/fixtures/f1/events?since_seq=2"]);
  });

  it("carries each row's id, type and payload through verbatim", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/events?since_seq=0": [
        { id: "e1", seq: 1, type: "carrom.board.summary", payload: { winner: "en1", points: 7 } },
      ],
    });
    const rows = await fetchFixtureLedger("http://x", newSession(), "f1", 0, t);
    expect(rows).toEqual([
      { id: "e1", seq: 1, type: "carrom.board.summary", payload: { winner: "en1", points: 7 } },
    ]);
  });

  it("returns an empty list when nothing has been recorded yet", async () => {
    const t = transportReturning({ "/api/v1/fixtures/f1/events?since_seq=0": [] });
    expect(await fetchFixtureLedger("http://x", newSession(), "f1", 0, t)).toEqual([]);
  });

  // The guard that matters most. Without it a refusal — a renamed query
  // parameter is exactly how one arrives (the route 400s an unparseable
  // `since_seq`) — reads back as `data: undefined`, which a tolerant parser
  // turns into `[]`. The driver would then be told the scorer's taps recorded
  // NOTHING, and would report a data defect for what is really a broken call.
  it("throws on a refusal instead of reporting an empty ledger", async () => {
    const t = transportRefusing(400, "VALIDATION", "Invalid since_seq");
    const err = await fetchFixtureLedger("http://x", newSession(), "f1", 0, t).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("400");
    expect((err as Error).message).toContain("Invalid since_seq");
    expect((err as Error).message).toContain("/api/v1/fixtures/f1/events?since_seq=0");
  });

  it("ignores a row the route did not shape as an event rather than mis-seqing it", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/events?since_seq=0": [
        { id: "e1", seq: 1, type: "carrom.board.summary", payload: null },
        // Valid row, unusable id: never coerced into a plausible-looking one
        // ("[object Object]" would read as a real event id downstream).
        { id: { nope: true }, seq: 2, type: "carrom.board.summary", payload: null },
        { id: "junk", type: "carrom.board.summary", payload: null },
        null,
      ],
    });
    const rows = await fetchFixtureLedger("http://x", newSession(), "f1", 0, t);
    expect(rows.map((r) => r.id)).toEqual(["e1", ""]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  // `since_seq` is exclusive server-side (`fixtures.ts:503`). The driver reads
  // "one new row per tap" off this, so a row at the anchor coming back would
  // read as a phantom extra event.
  it("excludes a row AT the since_seq anchor and includes the one past it", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/events?since_seq=3": [
        { id: "e3", seq: 3, type: "carrom.board.summary", payload: null },
        { id: "e4", seq: 4, type: "carrom.board.summary", payload: null },
      ],
    });
    const rows = await fetchFixtureLedger("http://x", newSession(), "f1", 3, t);
    expect(rows.map((r) => r.id)).toEqual(["e4"]);
    expect(rows.map((r) => r.seq)).toEqual([4]);
  });

  it("throws when a 200 carries no data instead of reporting an empty ledger", async () => {
    const t = transportReturningBody({ ok: true });
    const err = await fetchFixtureLedger("http://x", newSession(), "f1", 0, t).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("carried no data");
    expect((err as Error).message).toContain("/api/v1/fixtures/f1/events?since_seq=0");
  });

  it("throws when a 200's data is not a list of rows", async () => {
    const t = transportReturningBody({ ok: true, data: { rows: [] } });
    const err = await fetchFixtureLedger("http://x", newSession(), "f1", 0, t).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("was not a list of rows");
  });
});

describe("fetchFixtureStatus", () => {
  it("reports the status and the server's own last_seq", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/state": { status: "in_play", last_seq: 7, outcome: null },
    });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", t)).toEqual({
      status: "in_play",
      lastSeq: 7,
    });
  });

  it("reads a fixture nobody has scored as scheduled at seq 0", async () => {
    const t = transportReturning({
      "/api/v1/fixtures/f1/state": { status: "scheduled", last_seq: 0, outcome: null },
    });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", t)).toEqual({
      status: "scheduled",
      lastSeq: 0,
    });
  });

  it("names an unrecognised state shape rather than inventing a plausible one", async () => {
    const noStatus = transportReturning({ "/api/v1/fixtures/f1/state": { last_seq: 3 } });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", noStatus)).toEqual({
      status: "(absent)",
      lastSeq: 3,
    });
    const noSeq = transportReturning({ "/api/v1/fixtures/f1/state": { status: "in_play" } });
    expect(await fetchFixtureStatus("http://x", newSession(), "f1", noSeq)).toEqual({
      status: "in_play",
      lastSeq: 0,
    });
  });

  it("throws when a 200 carries no data instead of reporting a fixture at seq 0", async () => {
    const t = transportReturningBody({ ok: true });
    const err = await fetchFixtureStatus("http://x", newSession(), "f1", t).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("carried no data");
    expect((err as Error).message).toContain("/api/v1/fixtures/f1/state");
  });

  it("throws on a refusal instead of reporting a scheduled fixture at seq 0", async () => {
    const t = transportRefusing(404, "NOT_FOUND", "fixture not found");
    const err = await fetchFixtureStatus("http://x", newSession(), "f1", t).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).toContain("fixture not found");
  });
});
