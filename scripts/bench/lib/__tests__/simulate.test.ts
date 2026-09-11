// B05 T1 — unit coverage for lib/simulate.ts, the single-event write-path
// fold: division A's `PackStream`s POSTed one at a time, in stream order,
// through the real `/api/v1/fixtures/{id}/events` route.
//
// Every call goes through an injected `SimTransport` fake (`{ raw }`, the
// SAME narrow-DI shape `seed.ts`'s `SeedTransport` and `dls-gate.ts`'s
// `ProbeTransport` already use) — nothing here touches `global.fetch`.
//
// What this file pins, and why each one is here rather than assumed:
//  * `expected_seq` is the stream's own 0-based array index, matching
//    `append-event.ts:184-193`'s ledger-tip contract (`lastSeq !== expectedSeq`
//    on an empty ledger means the FIRST call must send 0, not 1) — pack-
//    schema.ts's header note 2 ("array order IS the sequence") says the same
//    thing from the authoring side. A test that only asserted "some seq was
//    sent" could not tell a correct fold from an off-by-one.
//  * Strictly sequential PER FIXTURE, concurrent ACROSS fixtures (_RULES.md
//    §3's "expected_seq discipline") — proven by blocking one fixture's first
//    call and observing the effect on both its own second call and on a
//    DIFFERENT fixture's call, never by reading the implementation.
//  * The D5 regression: an out-of-order `expected_seq` gets back HTTP 409
//    `SEQ_CONFLICT` with `current_seq`, reported as a finding, and the failed
//    call is never retried (`calls.length` pins the retry count directly).
//  * A 422 (and the REAL entitlement-refusal shape, 402 `PAYMENT_REQUIRED` —
//    see dls-gate.ts's header comment: "never the 'typed 422' an earlier
//    draft of this task expected", the same stale premise this task's own
//    brief carried) is ALSO a finding, never a silent skip.
//  * An unrecognized status (5xx) still THROWS — only a recognized refusal
//    becomes a finding; everything else is a genuine bug the run must catch.
//  * `@`-sigilled entrant/person refs in a payload are resolved to real ids
//    before the event is sent (pack-schema.ts header note 6) — an unresolved
//    ref throws, naming itself, rather than shipping the literal `"@ref"`
//    string to the API.
import { describe, expect, it } from "vitest";
import { newSession, type RawResult, type Session } from "../http.ts";
import { fixtureKey, type PackEvent, type PackStream } from "../pack-schema.ts";
import {
  computeEventsPerSecond,
  resolvePayloadRefs,
  simulateDivisionStreams,
  type SimTransport,
  type SimulateStreamsInput,
} from "../simulate.ts";

// ---------------------------------------------------------------------------
// test fixtures
// ---------------------------------------------------------------------------

function ev(type: string, payload: Record<string, unknown> = {}): PackEvent {
  return { type, payload } as PackEvent;
}

function stream(divisionRef: string, fixtureExtKey: string, events: PackEvent[]): PackStream {
  return {
    divisionRef,
    fixtureExtKey,
    home: "e1",
    away: "e2",
    provenance: "real",
    events,
  } as PackStream;
}

function ok201(): RawResult {
  return { status: 201, json: { ok: true, data: { seq: 1 } } };
}

interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function baseInput(overrides: Partial<SimulateStreamsInput> = {}): SimulateStreamsInput {
  return {
    base: "http://bench.example",
    session: newSession() as Session,
    streams: [],
    fixtureIdByKey: new Map(),
    refIdByKey: new Map(),
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// ---------------------------------------------------------------------------
// computeEventsPerSecond — pure arithmetic
// ---------------------------------------------------------------------------

describe("computeEventsPerSecond", () => {
  it("computes events per whole second from events sent and wall-clock ms", () => {
    expect(computeEventsPerSecond(100, 1000)).toBe(100);
    expect(computeEventsPerSecond(50, 500)).toBe(100);
    expect(computeEventsPerSecond(9, 3000)).toBe(3);
  });

  it("is 0 when nothing was sent, regardless of elapsed time", () => {
    expect(computeEventsPerSecond(0, 500)).toBe(0);
    expect(computeEventsPerSecond(0, 0)).toBe(0);
  });

  it("does not divide by zero (or return Infinity) when wall time reads as 0ms", () => {
    expect(computeEventsPerSecond(10, 0)).toBe(10);
    expect(Number.isFinite(computeEventsPerSecond(10, 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePayloadRefs — the `@`-sigil rewrite
// ---------------------------------------------------------------------------

describe("resolvePayloadRefs", () => {
  it("rewrites every @-sigilled string to the real id, leaving other values untouched", () => {
    const refIdByKey = new Map([
      ["e-alpha", "entrant-real-1"],
      ["p-ana", "person-real-1"],
    ]);
    const out = resolvePayloadRefs(
      { by: "@e-alpha", person: "@p-ana", points: 3, note: "not a ref", nested: { by: "@e-alpha" } },
      refIdByKey,
    );
    expect(out).toEqual({
      by: "entrant-real-1",
      person: "person-real-1",
      points: 3,
      note: "not a ref",
      nested: { by: "entrant-real-1" },
    });
  });

  it("walks arrays too", () => {
    const refIdByKey = new Map([["e-alpha", "entrant-real-1"]]);
    expect(resolvePayloadRefs({ sides: ["@e-alpha", "plain"] }, refIdByKey)).toEqual({
      sides: ["entrant-real-1", "plain"],
    });
  });

  it("throws, naming the unresolved ref, rather than sending the literal @-string", () => {
    expect(() => resolvePayloadRefs({ by: "@nobody" }, new Map())).toThrow(/@nobody/);
  });

  it("defaults its throw's prefix to \"simulate:\" when no caller is named", () => {
    expect(() => resolvePayloadRefs({ by: "@nobody" }, new Map())).toThrow(/^simulate: payload ref/);
  });

  // T2.5 review MINOR: `import.ts:336` reuses this function, and an
  // unresolved ref there used to throw with a HARDCODED "simulate:" prefix —
  // an import-fold failure would misreport itself as a simulate failure. The
  // prefix now reflects the ACTUAL caller.
  it("reflects the actual caller in its throw's prefix, nested inside an array/object too", () => {
    expect(() => resolvePayloadRefs({ by: "@nobody" }, new Map(), "import")).toThrow(/^import: payload ref/);
    expect(() => resolvePayloadRefs({ sides: ["@nobody"] }, new Map(), "import")).toThrow(/^import: payload ref/);
  });
});

// ---------------------------------------------------------------------------
// simulateDivisionStreams — the fold
// ---------------------------------------------------------------------------

// B06b — a bracket's fixtures are NOT independent of each other. A knockout
// fixture's entrants are written by its feeders' decisions, so folding round 2
// concurrently with round 1 refuses every later round with `WRONG_PHASE —
// fixture has an unassigned entrant (bye/TBD)`. Suite 11 lost 63 of 95
// fixtures to this; `_tiny` could never see it, because its only
// multi-fixture stage is a league and its knockout is a single fixture.
describe("simulateDivisionStreams — dependency waves", () => {
  /** Records the ORDER events reached the transport, and holds each call open
   *  until every call of its round has arrived — so a flat `Promise.all`
   *  interleaves rounds observably instead of racing to a lucky order. */
  function orderRecordingTransport(): { transport: SimTransport; order: string[] } {
    const order: string[] = [];
    return {
      order,
      transport: {
        async raw(_b, _s, path) {
          order.push(path);
          // One macrotask of slack: enough for any concurrently-started
          // sibling to land before this one resolves.
          await new Promise((r) => setTimeout(r, 0));
          return ok201();
        },
      },
    };
  }

  const bracket = () => {
    const streams = [
      stream("d-ko", "se-r1-i0", [ev("core.start")]),
      stream("d-ko", "se-r0-i0", [ev("core.start")]),
      stream("d-ko", "se-r0-i1", [ev("core.start")]),
    ];
    const fixtureIdByKey = new Map([
      [fixtureKey("d-ko", "se-r0-i0"), "fx-r0a"],
      [fixtureKey("d-ko", "se-r0-i1"), "fx-r0b"],
      [fixtureKey("d-ko", "se-r1-i0"), "fx-r1"],
    ]);
    const roundByFixtureKey = new Map([
      [fixtureKey("d-ko", "se-r0-i0"), 1],
      [fixtureKey("d-ko", "se-r0-i1"), 1],
      [fixtureKey("d-ko", "se-r1-i0"), 2],
    ]);
    return { streams, fixtureIdByKey, roundByFixtureKey };
  };

  it("folds every round-1 fixture BEFORE any round-2 fixture, even when the streams arrive out of order", async () => {
    const { transport, order } = orderRecordingTransport();
    const { streams, fixtureIdByKey, roundByFixtureKey } = bracket();

    const result = await simulateDivisionStreams(
      baseInput({ streams, fixtureIdByKey, roundByFixtureKey, transport }),
    );

    expect(result.eventsSent).toBe(3);
    // The round-2 fixture is FIRST in the stream array and must still be last
    // on the wire.
    expect(order.map((p) => (p.includes("fx-r1") ? "r2" : "r1"))).toEqual(["r1", "r1", "r2"]);
  });

  it("without the round map, behaves exactly as before — one flat wave", async () => {
    const { transport, order } = orderRecordingTransport();
    const { streams, fixtureIdByKey } = bracket();

    await simulateDivisionStreams(baseInput({ streams, fixtureIdByKey, transport }));

    // Concurrent across all three, so the round-2 fixture (first in the array)
    // reaches the wire first. This is the OLD behaviour, kept for leagues —
    // and it is exactly what broke suite 11.
    expect(order[0]).toContain("fx-r1");
  });

  it("keeps a stream whose fixture has no round in its own first wave rather than dropping it", async () => {
    const { transport, order } = orderRecordingTransport();
    const { streams, fixtureIdByKey, roundByFixtureKey } = bracket();
    // An unmapped fixture is a binding anomaly `bindStreamFixtures` should
    // have refused; folding it first surfaces it instead of hiding it.
    roundByFixtureKey.delete(fixtureKey("d-ko", "se-r0-i1"));

    const result = await simulateDivisionStreams(
      baseInput({ streams, fixtureIdByKey, roundByFixtureKey, transport }),
    );

    expect(result.eventsSent).toBe(3);
    expect(order[0]).toContain("fx-r0b");
  });

  it("folds nothing, and returns a clean empty result, for an empty stream list", async () => {
    const { transport, order } = orderRecordingTransport();
    const result = await simulateDivisionStreams(
      baseInput({ streams: [], fixtureIdByKey: new Map(), roundByFixtureKey: new Map(), transport }),
    );
    expect(result.eventsSent).toBe(0);
    expect(order).toEqual([]);
  });
});

describe("simulateDivisionStreams — expected_seq discipline", () => {
  it("sends expected_seq as the event's 0-based array index — the FIRST call is 0, never 1", async () => {
    const seqs: number[] = [];
    const transport: SimTransport = {
      async raw(_b, _s, _p, _m, body) {
        seqs.push((body as { expected_seq: number }).expected_seq);
        return ok201();
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("core.start"), ev("generic.result"), ev("core.finalize")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    const result = await simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport }));

    expect(seqs).toEqual([0, 1, 2]);
    expect(result.eventsSent).toBe(3);
  });

  it("sends type and the ref-resolved payload alongside expected_seq, nothing else", async () => {
    const sent: unknown[] = [];
    const transport: SimTransport = {
      async raw(_b, _s, path, method, body) {
        sent.push({ path, method, body });
        return ok201();
      },
    };
    const s = stream("d-tiny", "rr-r2-c1", [ev("generic.score", { by: "@e-alpha", points: 2 })]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r2-c1"), "fx-2"]]);
    const refIdByKey = new Map([["e-alpha", "entrant-real-1"]]);

    await simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, refIdByKey, transport }));

    expect(sent).toEqual([
      {
        path: "/api/v1/fixtures/fx-2/events",
        method: "POST",
        body: { expected_seq: 0, type: "generic.score", payload: { by: "entrant-real-1", points: 2 } },
      },
    ]);
  });

  it("throws naming the stream when a stream's (divisionRef, ext_key) matches no bound fixture", async () => {
    const s = stream("d-tiny", "wrong-key", [ev("core.start")]);
    await expect(
      simulateDivisionStreams(
        baseInput({ streams: [s], fixtureIdByKey: new Map(), transport: { raw: async () => ok201() } }),
      ),
    ).rejects.toThrow(/wrong-key/);
  });
});

describe("simulateDivisionStreams — sequentiality and concurrency (_RULES.md §3)", () => {
  it("does NOT send event index 1 until event index 0's request has resolved", async () => {
    const calls: number[] = [];
    const gate = deferred<void>();
    const transport: SimTransport = {
      async raw(_b, _s, _p, _m, body) {
        const seq = (body as { expected_seq: number }).expected_seq;
        calls.push(seq);
        if (seq === 0) await gate.promise;
        return ok201();
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("core.start"), ev("generic.result")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    const resultPromise = simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport }));
    await flushMicrotasks();
    expect(calls).toEqual([0]); // event 1 must NOT have been sent yet

    gate.resolve();
    const result = await resultPromise;
    expect(calls).toEqual([0, 1]);
    expect(result.eventsSent).toBe(2);
  });

  it("processes two different fixtures CONCURRENTLY — one blocked fixture never stalls another", async () => {
    const calledPaths: string[] = [];
    const gateA = deferred<void>();
    const transport: SimTransport = {
      async raw(_b, _s, path) {
        calledPaths.push(path);
        if (path.includes("fx-a")) await gateA.promise;
        return ok201();
      },
    };
    const streams = [
      stream("d-tiny", "a", [ev("core.start")]),
      stream("d-tiny", "b", [ev("core.start")]),
    ];
    const fixtureIdByKey = new Map([
      [fixtureKey("d-tiny", "a"), "fx-a"],
      [fixtureKey("d-tiny", "b"), "fx-b"],
    ]);

    const resultPromise = simulateDivisionStreams(baseInput({ streams, fixtureIdByKey, transport }));
    await flushMicrotasks();
    // fx-b's call landed even though fx-a's is still blocked on the gate —
    // a fold that awaited fixtures ONE AT A TIME (Promise.all replaced by a
    // sequential for-loop) would never reach fx-b here.
    expect(calledPaths).toContain("/api/v1/fixtures/fx-b/events");

    gateA.resolve();
    const result = await resultPromise;
    expect(result.eventsSent).toBe(2);
  });
});

describe("simulateDivisionStreams — D5: the deliberate out-of-order 409", () => {
  it("reports SEQ_CONFLICT as a finding with current_seq, and NEVER retries the failed call", async () => {
    const calls: RecordedCall[] = [];
    const transport: SimTransport = {
      async raw(_b, _s, path, method = "GET", body) {
        calls.push({ path, method, body });
        // The SECOND call (event index 1) is the deliberate conflict.
        if (calls.length === 2) {
          return {
            status: 409,
            json: {
              ok: false,
              error: {
                code: "SEQ_CONFLICT",
                message: "expected seq 1 but ledger is at 2",
                current_seq: 2,
              },
            },
          };
        }
        return ok201();
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("core.start"), ev("generic.result"), ev("core.finalize")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    const result = await simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport }));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      status: 409,
      code: "SEQ_CONFLICT",
      currentSeq: 2,
      eventIndex: 1,
      fixtureId: "fx-1",
    });
    // Only the first event succeeded before the conflict fired.
    expect(result.eventsSent).toBe(1);
    // Exactly two calls total: the conflict was never retried, and the third
    // event (index 2) was never attempted once its own fixture's fold gave up.
    expect(calls).toHaveLength(2);
  });
});

describe("simulateDivisionStreams — the 422/402 refusal findings", () => {
  it("a 422 refusal is reported as a finding, never silently skipped", async () => {
    const transport: SimTransport = {
      async raw() {
        return {
          status: 422,
          json: { ok: false, error: { code: "WRONG_PHASE", message: "division has not started" } },
        };
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("core.start")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    const result = await simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport }));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: 422, code: "WRONG_PHASE" });
    expect(result.eventsSent).toBe(0);
  });

  it("a 402 PAYMENT_REQUIRED entitlement refusal — the REAL shape (dls-gate.ts's own header comment: " +
    "'never the typed 422 an earlier draft expected') — is reported as a finding too", async () => {
    const transport: SimTransport = {
      async raw() {
        return {
          status: 402,
          json: {
            ok: false,
            error: { code: "PAYMENT_REQUIRED", message: "Plan upgrade required", feature_key: "cricket.dls" },
          },
        };
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("cricket.revise")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    const result = await simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport }));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ status: 402, code: "PAYMENT_REQUIRED" });
  });

  it("an unrecognized 5xx is THROWN, never swallowed as a finding", async () => {
    const transport: SimTransport = {
      async raw() {
        return { status: 500, json: { ok: false, error: { code: "INTERNAL", message: "boom" } } };
      },
    };
    const s = stream("d-tiny", "rr-r1-c1", [ev("core.start")]);
    const fixtureIdByKey = new Map([[fixtureKey("d-tiny", "rr-r1-c1"), "fx-1"]]);

    await expect(
      simulateDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport })),
    ).rejects.toThrow();
  });
});

describe("simulateDivisionStreams — aggregation across multiple streams", () => {
  it("sums eventsSent and collects findings from every stream, and reports wall-clock throughput", async () => {
    const transport: SimTransport = {
      async raw(_b, _s, path, _m, body) {
        if (path.includes("fx-conflict") && (body as { expected_seq: number }).expected_seq === 1) {
          return { status: 409, json: { ok: false, error: { code: "SEQ_CONFLICT", message: "x", current_seq: 1 } } };
        }
        return ok201();
      },
    };
    const streams = [
      stream("d-tiny", "clean", [ev("core.start"), ev("generic.result"), ev("core.finalize")]),
      stream("d-tiny", "conflict", [ev("core.start"), ev("generic.result")]),
    ];
    const fixtureIdByKey = new Map([
      [fixtureKey("d-tiny", "clean"), "fx-clean"],
      [fixtureKey("d-tiny", "conflict"), "fx-conflict"],
    ]);

    const result = await simulateDivisionStreams(baseInput({ streams, fixtureIdByKey, transport }));

    // 3 from the clean fixture + 1 from the conflicted one (the second event
    // 409s and stops that fixture's fold).
    expect(result.eventsSent).toBe(4);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fixtureId).toBe("fx-conflict");
    expect(result.wallMs).toBeGreaterThanOrEqual(0);
    expect(result.eventsPerSecond).toBe(computeEventsPerSecond(result.eventsSent, result.wallMs));
  });

  it("is a no-op — zero events, zero findings — on an empty stream list", async () => {
    const result = await simulateDivisionStreams(
      baseInput({ streams: [], transport: { raw: async () => ok201() } }),
    );
    expect(result).toMatchObject({ eventsSent: 0, findings: [], streams: [] });
  });
});
