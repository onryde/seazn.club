// B05 T2 — unit coverage for lib/import.ts, the batch write-path fold:
// division B's `PackStream`s chunked and POSTed through
// `/api/v1/divisions/{id}/events/import`.
//
// Every call goes through an injected `ImportTransport` fake (`{ raw }`,
// the SAME narrow-DI shape `simulate.ts`'s `SimTransport` uses) — nothing
// here touches `global.fetch` or a real server.
//
// What this file pins, and why:
//  * `IMPORT_CAPS` is a HAND MIRROR of the product's own constant
//    (`apps/web/src/server/usecases/event-import.ts:39`) — `import.ts`'s own
//    header comment explains why it cannot be a real import (`server-only`
//    is unresolvable outside Next's webpack). The "mirror is diffed against
//    apps/web, not itself" describe block below reads the real file as TEXT
//    and reds on absence or drift, per `validate-pack.test.ts`'s established
//    `STAGE_DECIDER_KEYS` pattern.
//  * Chunking respects all three caps, exercised at the boundary (exactly at
//    the cap, one over) and far over — `_tiny` never drives these branches
//    live, so this file is the only place they run at all.
//  * `import_id` idempotency: a REPEAT call with the SAME id replays as
//    `skipped_duplicate` for every stream (event-import.ts step 2); a
//    DIFFERENT id against an already-started fixture is `rejected` with
//    `import.fixture_started` (step 3) — two distinct refusals for two
//    distinct mistakes, both driven through the fake transport.
//  * A refusal — 400 (schema, e.g. `core.void`), 402, 409, 422 — is a
//    FINDING, never a silent skip and never a retry, matching `simulate.ts`'s
//    D5 convention exactly. 413 is deliberately NOT recognized: this file's
//    whole job is to never trip it, so one reaching here is a chunker bug
//    and THROWS, same as an unrecognized 5xx does in `simulate.ts`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newSession, type RawResult, type Session } from "../http.ts";
import { fixtureKey, type PackEvent, type PackStream } from "../pack-schema.ts";
import {
  buildImportId,
  chunkStreamsForImport,
  IMPORT_CAPS,
  importDivisionStreams,
  type ImportDivisionStreamsInput,
  type ImportTransport,
} from "../import.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

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

/** N streams, each with `eventsPerStream` `core.start` events, keyed
 *  `s0`, `s1`, ... — used for the boundary/over-cap chunking tests, which
 *  need many streams and would be unreadable authored by hand one at a
 *  time. */
function manyStreams(divisionRef: string, n: number, eventsPerStream: number): PackStream[] {
  return Array.from({ length: n }, (_v, i) =>
    stream(
      divisionRef,
      `s${i}`,
      Array.from({ length: eventsPerStream }, () => ev("core.start")),
    ),
  );
}

function fixtureMapFor(streams: readonly PackStream[]): Map<string, string> {
  return new Map(streams.map((s) => [fixtureKey(s.divisionRef, s.fixtureExtKey), `fx-${s.fixtureExtKey}`]));
}

function ok200(results: { fixture: string; status: "imported" | "skipped_duplicate" | "rejected"; eventsAppended: number; error?: { code: string } }[]): RawResult {
  return {
    status: 200,
    json: { ok: true, data: { importId: "x", totals: { imported: 0, skipped: 0, rejected: 0 }, results } },
  };
}

/** Every stream in a chunk reported "imported", with `eventsAppended` equal
 *  to its own event count — the common, clean case. */
function importedReportFor(chunkStreams: readonly PackStream[]): RawResult {
  return ok200(
    chunkStreams.map((s) => ({ fixture: `fx-${s.fixtureExtKey}`, status: "imported", eventsAppended: s.events.length })),
  );
}

interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

function baseInput(overrides: Partial<ImportDivisionStreamsInput> = {}): ImportDivisionStreamsInput {
  return {
    base: "http://bench.example",
    session: newSession() as Session,
    divisionId: "div-b",
    importId: "import-1",
    streams: [],
    fixtureIdByKey: new Map(),
    refIdByKey: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// IMPORT_CAPS — the mirror is diffed against apps/web, not itself
// ---------------------------------------------------------------------------

describe("IMPORT_CAPS — the mirror is diffed against apps/web, not itself", () => {
  it("equals the product's own constant, read as TEXT", () => {
    // `import.ts`'s own header comment: apps/web may not be IMPORTED from
    // scripts/bench (event-import.ts opens with `import "server-only"`,
    // unresolvable outside Next's webpack). Reading the file as text is not
    // importing it, and it is the only thing that can catch the failure the
    // mirror actually has: the PRODUCT changing a ceiling. A test asserting
    // the mirror against a copy of itself cannot.
    const source = readFileSync(
      path.join(REPO_ROOT, "apps/web/src/server/usecases/event-import.ts"),
      "utf8",
    );
    const literal =
      /export const IMPORT_CAPS = \{ streams: (\d[\d_]*), eventsPerFixture: (\d[\d_]*), eventsPerCall: (\d[\d_]*) \} as const;/.exec(
        source,
      );
    // Red on ABSENCE rather than skipping: a bench that cannot see the
    // product it mirrors must say so, not quietly pass.
    expect(literal, "IMPORT_CAPS literal not found in event-import.ts").not.toBeNull();
    const [, streams, eventsPerFixture, eventsPerCall] = literal!;
    expect(IMPORT_CAPS).toEqual({
      streams: Number(streams!.replaceAll("_", "")),
      eventsPerFixture: Number(eventsPerFixture!.replaceAll("_", "")),
      eventsPerCall: Number(eventsPerCall!.replaceAll("_", "")),
    });
  });
});

// ---------------------------------------------------------------------------
// chunkStreamsForImport — boundary and over-cap, against the REAL caps
// ---------------------------------------------------------------------------

describe("chunkStreamsForImport", () => {
  it("is a no-op — zero chunks, zero oversize — on an empty stream list", () => {
    expect(chunkStreamsForImport([])).toEqual({ chunks: [], oversize: [] });
  });

  it("packs exactly IMPORT_CAPS.streams streams into ONE chunk", () => {
    const streams = manyStreams("d-b", IMPORT_CAPS.streams, 1);
    const { chunks, oversize } = chunkStreamsForImport(streams);
    expect(oversize).toEqual([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(IMPORT_CAPS.streams);
  });

  it("splits into two chunks the moment stream count is ONE OVER IMPORT_CAPS.streams", () => {
    const streams = manyStreams("d-b", IMPORT_CAPS.streams + 1, 1);
    const { chunks, oversize } = chunkStreamsForImport(streams);
    expect(oversize).toEqual([]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(IMPORT_CAPS.streams);
    expect(chunks[1]).toHaveLength(1);
    // Every stream accounted for exactly once, none lost, none duplicated.
    const allSent = chunks.flat().map((s) => s.fixtureExtKey);
    expect(new Set(allSent).size).toBe(streams.length);
  });

  it("splits by the streams cap FAR OVER (2x + a remainder)", () => {
    const n = IMPORT_CAPS.streams * 2 + 3;
    const streams = manyStreams("d-b", n, 1);
    const { chunks, oversize } = chunkStreamsForImport(streams);
    expect(oversize).toEqual([]);
    expect(chunks.map((c) => c.length)).toEqual([IMPORT_CAPS.streams, IMPORT_CAPS.streams, 3]);
  });

  it("accepts a stream carrying exactly IMPORT_CAPS.eventsPerFixture events", () => {
    const big = stream(
      "d-b",
      "big",
      Array.from({ length: IMPORT_CAPS.eventsPerFixture }, () => ev("core.start")),
    );
    const { chunks, oversize } = chunkStreamsForImport([big]);
    expect(oversize).toEqual([]);
    expect(chunks).toEqual([[big]]);
  });

  it("excludes (never chunks around) a stream ONE EVENT OVER IMPORT_CAPS.eventsPerFixture, and reports it oversize", () => {
    const tooBig = stream(
      "d-b",
      "too-big",
      Array.from({ length: IMPORT_CAPS.eventsPerFixture + 1 }, () => ev("core.start")),
    );
    const fine = stream("d-b", "fine", [ev("core.start")]);
    const { chunks, oversize } = chunkStreamsForImport([tooBig, fine]);
    expect(oversize).toEqual([
      { kind: "stream_oversize", streamKey: fixtureKey("d-b", "too-big"), eventCount: IMPORT_CAPS.eventsPerFixture + 1, cap: IMPORT_CAPS.eventsPerFixture },
    ]);
    // The oversized stream never appears in ANY chunk — splitting it across
    // calls cannot substitute (see the type's own doc comment).
    expect(chunks).toEqual([[fine]]);
  });

  it("splits into multiple chunks once total events exceed IMPORT_CAPS.eventsPerCall, FAR OVER", () => {
    // 25 streams of exactly IMPORT_CAPS.eventsPerFixture events each = 25,000
    // events on the real caps (1,000 x 25) — 2.5x IMPORT_CAPS.eventsPerCall
    // (10,000). None is individually oversize; the events-per-call bound is
    // what must split them.
    const perStream = IMPORT_CAPS.eventsPerFixture;
    const n = 25;
    const streams = manyStreams("d-b", n, perStream);
    const { chunks, oversize } = chunkStreamsForImport(streams);
    expect(oversize).toEqual([]);
    const perChunkCapacity = Math.floor(IMPORT_CAPS.eventsPerCall / perStream);
    const expectedSizes: number[] = [];
    let remaining = n;
    while (remaining > 0) {
      const take = Math.min(perChunkCapacity, remaining);
      expectedSizes.push(take);
      remaining -= take;
    }
    expect(chunks.map((c) => c.length)).toEqual(expectedSizes);
    // Every chunk stays at or under BOTH caps.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(IMPORT_CAPS.streams);
      const total = chunk.reduce((sum, s) => sum + s.events.length, 0);
      expect(total).toBeLessThanOrEqual(IMPORT_CAPS.eventsPerCall);
    }
    // No stream lost or duplicated across chunks.
    expect(chunks.flat().map((s) => s.fixtureExtKey).sort()).toEqual(
      streams.map((s) => s.fixtureExtKey).sort(),
    );
  });

  it("honors an injected caps override for a targeted small-scale test", () => {
    const streams = manyStreams("d-b", 3, 2);
    const { chunks } = chunkStreamsForImport(streams, { streams: 1, eventsPerFixture: 10, eventsPerCall: 10 });
    expect(chunks).toHaveLength(3);
  });

  it("never produces an empty leading chunk, even under a degenerate caps.streams: 0 override", () => {
    // The `current.length > 0 &&` guard on the flush condition exists for
    // exactly this: on an EMPTY accumulator, `current.length + 1 >
    // caps.streams` can be true only when `caps.streams < 1` — never true
    // for the real IMPORT_CAPS (>= 1), which is why this needs its OWN
    // degenerate override to witness at all. Without the guard, the first
    // stream would flush an empty `current` as chunk 0 before ever being
    // added anywhere.
    const streams = manyStreams("d-b", 2, 1);
    const { chunks } = chunkStreamsForImport(streams, { streams: 0, eventsPerFixture: 10, eventsPerCall: 10 });
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.flat()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildImportId — deterministic per (run, division), never random
// ---------------------------------------------------------------------------

describe("buildImportId", () => {
  it("is the SAME value across two calls with identical (divisionRef, runId)", () => {
    expect(buildImportId("d-badminton", "sha123")).toBe(buildImportId("d-badminton", "sha123"));
  });

  it("differs across divisions, and across run ids", () => {
    expect(buildImportId("d-a", "sha123")).not.toBe(buildImportId("d-b", "sha123"));
    expect(buildImportId("d-a", "sha123")).not.toBe(buildImportId("d-a", "sha456"));
  });

  it("falls back to a stable literal when no runId is given", () => {
    expect(buildImportId("d-badminton")).toBe("bench-import:local:d-badminton");
  });
});

// ---------------------------------------------------------------------------
// importDivisionStreams — the fold, chunking, and refusal handling
// ---------------------------------------------------------------------------

describe("importDivisionStreams — a clean multi-chunk fold", () => {
  it("sends one POST per chunk and sums eventsAppended across them", async () => {
    const streams = manyStreams("d-b", IMPORT_CAPS.streams + 1, 2);
    const fixtureIdByKey = fixtureMapFor(streams);
    const calls: RecordedCall[] = [];
    const transport: ImportTransport = {
      async raw(_b, _s, p, m, body) {
        calls.push({ path: p, method: m ?? "GET", body });
        const sent = (body as { streams: { fixture: { id: string } }[] }).streams;
        const byId = new Map(streams.map((s) => [`fx-${s.fixtureExtKey}`, s]));
        return ok200(
          sent.map((row) => {
            const s = byId.get(row.fixture.id)!;
            return { fixture: row.fixture.id, status: "imported", eventsAppended: s.events.length };
          }),
        );
      },
    };

    const result = await importDivisionStreams(baseInput({ streams, fixtureIdByKey, transport }));

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === "POST" && c.path === "/api/v1/divisions/div-b/events/import")).toBe(true);
    expect(result.chunks).toBe(2);
    expect(result.eventsSent).toBe(streams.length * 2);
    expect(result.findings).toEqual([]);
    expect(result.streamOutcomes).toHaveLength(streams.length);
    expect(result.eventsPerSecond).toBeGreaterThanOrEqual(0);
  });

  it("sends import_id, fixture id, type, resolved payload and at on every event", async () => {
    const s = stream("d-b", "fx1", [ev("generic.score", { by: "@e-alpha", points: 2 })]);
    const fixtureIdByKey = fixtureMapFor([s]);
    const refIdByKey = new Map([["e-alpha", "entrant-real-1"]]);
    let sentBody: unknown;
    const transport: ImportTransport = {
      async raw(_b, _s, _p, _m, body) {
        sentBody = body;
        return importedReportFor([s]);
      },
    };

    await importDivisionStreams(
      baseInput({ streams: [s], fixtureIdByKey, refIdByKey, importId: "imp-xyz", transport }),
    );

    expect(sentBody).toEqual({
      import_id: "imp-xyz",
      streams: [
        {
          fixture: { id: "fx-fx1" },
          events: [{ type: "generic.score", payload: { by: "entrant-real-1", points: 2 } }],
        },
      ],
    });
  });

  it("throws naming the stream when a stream matches no bound fixture", async () => {
    const s = stream("d-b", "wrong-key", [ev("core.start")]);
    await expect(
      importDivisionStreams(baseInput({ streams: [s], fixtureIdByKey: new Map(), transport: { raw: async () => importedReportFor([]) } })),
    ).rejects.toThrow(/wrong-key/);
  });

  it("throws when a 200 response's results array length does not match the chunk it was sent — positional correlation would silently mismatch", async () => {
    const s1 = stream("d-b", "s1", [ev("core.start")]);
    const s2 = stream("d-b", "s2", [ev("core.start")]);
    const fixtureIdByKey = fixtureMapFor([s1, s2]);
    const transport: ImportTransport = {
      // A malformed/short response — only ONE result for a two-stream chunk.
      async raw() {
        return ok200([{ fixture: "fx-s1", status: "imported", eventsAppended: 1 }]);
      },
    };
    await expect(
      importDivisionStreams(baseInput({ streams: [s1, s2], fixtureIdByKey, transport })),
    ).rejects.toThrow(/2 stream\(s\) but the report carries 1 result\(s\)/);
  });
});

describe("importDivisionStreams — an oversize stream is a finding, and never sent", () => {
  it("skips the oversize stream, imports the rest, and reports the finding", async () => {
    const tooBig = stream(
      "d-b",
      "too-big",
      Array.from({ length: IMPORT_CAPS.eventsPerFixture + 1 }, () => ev("core.start")),
    );
    const fine = stream("d-b", "fine", [ev("core.start")]);
    const fixtureIdByKey = fixtureMapFor([tooBig, fine]);
    const calls: RecordedCall[] = [];
    const transport: ImportTransport = {
      async raw(_b, _s, p, m, body) {
        calls.push({ path: p, method: m ?? "GET", body });
        return importedReportFor([fine]);
      },
    };

    const result = await importDivisionStreams(baseInput({ streams: [tooBig, fine], fixtureIdByKey, transport }));

    expect(calls).toHaveLength(1); // ONLY the fine stream's chunk was ever sent
    expect(result.findings).toEqual([
      {
        kind: "stream_oversize",
        streamKey: fixtureKey("d-b", "too-big"),
        eventCount: IMPORT_CAPS.eventsPerFixture + 1,
        cap: IMPORT_CAPS.eventsPerFixture,
      },
    ]);
    expect(result.eventsSent).toBe(1);
  });
});

describe("importDivisionStreams — call-level refusals (400/402/409/422), never silent, never retried", () => {
  const cases: { status: number; code: string; message: string }[] = [
    { status: 400, code: "VALIDATION", message: "Invalid input" }, // the core.void schema refusal shape
    { status: 402, code: "PAYMENT_REQUIRED", message: "Plan upgrade required" },
    { status: 409, code: "import.division_not_started", message: "division has not started — import is closed" },
    { status: 422, code: "SOME_OTHER_GATE", message: "generic business refusal" },
  ];

  for (const c of cases) {
    it(`a ${c.status} ${c.code} refusal is reported as a finding naming every stream in the chunk`, async () => {
      const s1 = stream("d-b", "s1", [ev("core.start")]);
      const s2 = stream("d-b", "s2", [ev("core.start")]);
      const fixtureIdByKey = fixtureMapFor([s1, s2]);
      let calls = 0;
      const transport: ImportTransport = {
        async raw() {
          calls += 1;
          return { status: c.status, json: { ok: false, error: { code: c.code, message: c.message } } };
        },
      };

      const result = await importDivisionStreams(baseInput({ streams: [s1, s2], fixtureIdByKey, transport }));

      expect(calls).toBe(1); // never retried
      expect(result.eventsSent).toBe(0);
      expect(result.findings).toEqual([
        {
          kind: "call_refused",
          chunkIndex: 0,
          streamKeys: [fixtureKey("d-b", "s1"), fixtureKey("d-b", "s2")],
          status: c.status,
          code: c.code,
          message: c.message,
        },
      ]);
    });
  }

  it("an unrecognized status (413, or a 5xx) THROWS — never swallowed as a finding", async () => {
    const s = stream("d-b", "s1", [ev("core.start")]);
    const fixtureIdByKey = fixtureMapFor([s]);
    for (const status of [413, 500]) {
      const transport: ImportTransport = {
        async raw() {
          return { status, json: { ok: false, error: { code: "X", message: "boom" } } };
        },
      };
      await expect(
        importDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, transport })),
      ).rejects.toThrow();
    }
  });
});

describe("importDivisionStreams — per-stream product outcomes inside a 200 are never silent", () => {
  it("a skipped_duplicate or rejected row becomes a stream_not_imported finding, never counted as sent", async () => {
    const s1 = stream("d-b", "dup", [ev("core.start")]);
    const s2 = stream("d-b", "bad", [ev("core.start")]);
    const fixtureIdByKey = fixtureMapFor([s1, s2]);
    const transport: ImportTransport = {
      async raw() {
        return ok200([
          { fixture: "fx-dup", status: "skipped_duplicate", eventsAppended: 0 },
          { fixture: "fx-bad", status: "rejected", eventsAppended: 0, error: { code: "import.fold_rejected" } },
        ]);
      },
    };

    const result = await importDivisionStreams(baseInput({ streams: [s1, s2], fixtureIdByKey, transport }));

    expect(result.eventsSent).toBe(0);
    expect(result.findings).toEqual([
      { kind: "stream_not_imported", streamKey: fixtureKey("d-b", "dup"), fixture: "fx-dup", status: "skipped_duplicate" },
      {
        kind: "stream_not_imported",
        streamKey: fixtureKey("d-b", "bad"),
        fixture: "fx-bad",
        status: "rejected",
        code: "import.fold_rejected",
      },
    ]);
  });
});

describe("importDivisionStreams — import_id idempotency, driven against the REAL semantics read from event-import.ts", () => {
  it("a repeat call with the SAME import_id replays as skipped_duplicate, never re-appending", async () => {
    const s = stream("d-b", "fx1", [ev("core.start"), ev("generic.result")]);
    const fixtureIdByKey = fixtureMapFor([s]);
    const importId = buildImportId("d-badminton", "sha-fixed");
    let alreadyImported = false;
    const transport: ImportTransport = {
      async raw() {
        if (!alreadyImported) {
          alreadyImported = true;
          return ok200([{ fixture: "fx-fx1", status: "imported", eventsAppended: 2 }]);
        }
        // event-import.ts step 2: a replay of an already-imported
        // (division, import_id, fixture) never even opens a transaction.
        return ok200([{ fixture: "fx-fx1", status: "skipped_duplicate", eventsAppended: 0 }]);
      },
    };

    const first = await importDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, importId, transport }));
    expect(first.eventsSent).toBe(2);
    expect(first.findings).toEqual([]);

    const second = await importDivisionStreams(baseInput({ streams: [s], fixtureIdByKey, importId, transport }));
    expect(second.eventsSent).toBe(0);
    expect(second.streamOutcomes[0]).toMatchObject({ status: "skipped_duplicate", eventsAppended: 0 });
    expect(second.findings).toEqual([
      { kind: "stream_not_imported", streamKey: fixtureKey("d-b", "fx1"), fixture: "fx-fx1", status: "skipped_duplicate" },
    ]);
  });

  it("a DIFFERENT import_id against an already-started fixture is rejected as import.fixture_started — distinct from a same-id replay", async () => {
    const s = stream("d-b", "fx1", [ev("core.start")]);
    const fixtureIdByKey = fixtureMapFor([s]);
    const transport: ImportTransport = {
      async raw() {
        // event-import.ts step 3: a NEW import_id sees the fixture already
        // has score_events rows from the earlier import and refuses the
        // whole stream — never skipped_duplicate, which only fires for a
        // REPLAY of the SAME (division, import_id, fixture).
        return ok200([{ fixture: "fx-fx1", status: "rejected", eventsAppended: 0, error: { code: "import.fixture_started" } }]);
      },
    };

    const result = await importDivisionStreams(
      baseInput({ streams: [s], fixtureIdByKey, importId: buildImportId("d-badminton", "sha-different"), transport }),
    );

    expect(result.streamOutcomes[0]).toMatchObject({ status: "rejected", eventsAppended: 0 });
    expect(result.findings).toEqual([
      {
        kind: "stream_not_imported",
        streamKey: fixtureKey("d-b", "fx1"),
        fixture: "fx-fx1",
        status: "rejected",
        code: "import.fixture_started",
      },
    ]);
  });
});
