// Transport tests for the cp-sat gRPC client wrapper. Everything here injects a
// call seam as `solveBuild`'s third argument, so no gRPC channel, no server, no
// network — the wrapper's own behaviour is the whole subject: metadata, request
// shaping, status vocabulary, and settling instead of hanging.
import { describe, expect, it, vi } from "vitest";
import type { SolveBuildCall } from "./cpsat-client.ts";
import { CpSatError, solveBuild } from "./cpsat-client.ts";
import { fixedClock } from "../core/clock.ts";
import { SolveBuildRequest, SolveStatus } from "./generated/scheduler.ts";

/** The minimum a valid request needs; individual tests override what they probe. */
const INPUT = {
  courts: ["Court 1"],
  fixtures: [],
  grid: { slots: [], stepMinutes: 10 },
  existing: [],
  dependencies: [],
  constraints: { matchMinutes: 30, gapMinutes: 10 },
  wallSeconds: 8,
};

const EMPTY_RESPONSE = {
  assignments: [],
  status: SolveStatus.SOLVE_STATUS_FEASIBLE,
  tiersCompleted: 0,
  objectiveValues: [],
  elapsedMs: 0,
  wallExhausted: false,
  error: undefined,
};

/** A client whose single RPC answers immediately with `response`. */
function respondingClient(response: unknown = EMPTY_RESPONSE) {
  return {
    solveBuild: vi.fn(
      (
        _req: SolveBuildRequest,
        _meta: unknown,
        _opts: unknown,
        cb: (err: unknown, res: unknown) => void,
      ) => cb(null, response),
    ),
  };
}

/** A client whose single RPC fails immediately with `error`. */
function failingClient(error: { code: number; details: string; message: string }) {
  return {
    solveBuild: vi.fn(
      (
        _req: SolveBuildRequest,
        _meta: unknown,
        _opts: unknown,
        cb: (err: unknown, res: unknown) => void,
      ) => cb(error, null),
    ),
  };
}

describe("solveBuild", () => {
  it("attaches the shared secret as call metadata", async () => {
    const mockClient = respondingClient();

    const result = await solveBuild(INPUT, { secret: "s3cr3t" }, mockClient);

    expect(mockClient.solveBuild).toHaveBeenCalled();
    const [, metadata] = mockClient.solveBuild.mock.calls[0]!;
    expect((metadata as { get(k: string): unknown[] }).get("x-internal-secret")).toEqual(["s3cr3t"]);
    expect(result.status).toBe("FEASIBLE");
  });

  // The channel-side deadline has to sit BEYOND the solver's own wall budget:
  // the service returns a partial board when its wall runs out, and a transport
  // deadline at or below `wallSeconds` would abort that response in flight and
  // turn every long solve into a failure. Injecting a fixed clock is the only
  // way to assert the instant rather than a range.
  it("sets a transport deadline one margin beyond the solver's wall budget", async () => {
    const mockClient = respondingClient();
    const startedAtIso = "2026-08-09T12:00:00.000Z";

    await solveBuild(
      { ...INPUT, wallSeconds: 8 },
      { secret: "s3cr3t", clock: fixedClock(startedAtIso) },
      mockClient,
    );

    const [, , callOptions] = mockClient.solveBuild.mock.calls[0]!;
    const deadline = (callOptions as { deadline: Date }).deadline;
    // 8s wall + the 2s margin.
    expect(deadline.toISOString()).toBe("2026-08-09T12:00:10.000Z");
  });

  // The two per-division constraints are the only place the caller's shape and
  // the wire's shape genuinely disagree: TS models them as two Records keyed
  // by division id, the proto as ONE repeated `DivisionRule` keyed by
  // `division_index` (half 1's `DivisionRestRule` + `DivisionDayCapRule`
  // merge). Handing a Record straight to the generated encoder is not a type
  // error the compiler can catch through the call seam, and it does not fail
  // loudly either — it iterates a non-iterable or emits nothing, so the
  // solver gets a board with every rest rule and day cap silently missing and
  // proves it OPTIMAL. This test is the only thing that distinguishes the
  // two, now including the division id -> index step.
  it("maps per-division constraint records onto the proto's repeated division rules", async () => {
    const mockClient = respondingClient();

    await solveBuild(
      {
        ...INPUT,
        constraints: {
          matchMinutes: 30,
          gapMinutes: 10,
          restByDivision: { "div-a": 45 },
          dayCapByDivision: { "div-b": 3 },
        },
      },
      { secret: "s3cr3t" },
      mockClient,
    );

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    // Neither fixture references either division (INPUT.fixtures is empty),
    // so `divisionIndex` comes entirely from `constraints`: restByDivision's
    // keys first ("div-a" -> 0), then dayCapByDivision's keys not already
    // seen ("div-b" -> 1). Each rule carries only the half it actually has —
    // no false zero for the field it does not.
    expect(request.divisionRules).toEqual([
      { divisionIndex: 0, minRestMinutes: 45, maxFixturesPerDay: undefined },
      { divisionIndex: 1, minRestMinutes: undefined, maxFixturesPerDay: 3 },
    ]);
  });

  // A client that never calls back is not a contrived mock — it is what a wedged
  // connection looks like from here. gRPC's own `deadline` CallOption cannot be
  // the only guard: it is enforced by the channel, so anything that settles the
  // call outside the channel (or a channel that stalls before the deadline timer
  // is armed) leaves the promise pending forever, and a solve that never returns
  // is worse than one that fails — `build.ts` has a greedy fallback it can only
  // take if this rejects.
  it(
    "rejects the call when it exceeds the deadline margin",
    async () => {
      const mockClient = {
        solveBuild: vi.fn(() => {
          /* never calls back — a wedged call */
        }),
      };
      // `performance.now()` rather than `Date.now()`: the engine boundary gate
    // scans test files too and bans ambient time outside core/clock.ts. It is
    // also the correct API for an elapsed-duration measurement — monotonic, and
    // immune to a clock adjustment mid-test.
    const startedAt = performance.now();

      await expect(
        solveBuild({ ...INPUT, wallSeconds: 0.05 }, { secret: "s3cr3t" }, mockClient),
      ).rejects.toThrow(/deadline/i);

      // Pins that the rejection came from the elapsed-time guard rather than
      // from a synchronous throw that happens to mention "deadline": the margin
      // is 2s, so a real wait has to have happened.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    },
    10_000,
  );

  it("turns a transport DEADLINE_EXCEEDED into a clear error", async () => {
    const mockClient = failingClient({
      code: 4,
      details: "Deadline exceeded",
      message: "4 DEADLINE_EXCEEDED",
    });

    await expect(
      solveBuild(INPUT, { secret: "s3cr3t" }, mockClient),
    ).rejects.toThrow(/deadline/i);
  });

  // The ACL runs in both directions, and the return leg is the easy one to get
  // wrong: rejecting the raw `ServiceError` compiles, reads fine, and hands
  // `build.ts` an integer `grpc.status` to branch on — at which point `build.ts`
  // is gRPC-aware and the layering is gone. Nothing past this module may need to
  // know what 16 means.
  it.each([
    ["UNAUTHENTICATED", 16, "unauthenticated"],
    ["PERMISSION_DENIED", 7, "unauthenticated"],
    ["UNAVAILABLE", 14, "unavailable"],
    ["INVALID_ARGUMENT", 3, "invalid_request"],
    ["RESOURCE_EXHAUSTED", 8, "transport"],
  ])("translates a %s transport status into a domain failure", async (label, code, failure) => {
    const mockClient = failingClient({ code, details: `boom: ${label}`, message: label });

    const rejection = await solveBuild(INPUT, { secret: "s3cr3t" }, mockClient).catch(
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(CpSatError);
    expect((rejection as CpSatError).failure).toBe(failure);
    // The grpc status integer is not part of the surface `build.ts` sees.
    expect(rejection).not.toHaveProperty("code");
  });

  // proto3 drops a zero scalar from the wire, so for these fields "unset" and
  // "the caller meant zero" are the same bytes — and each one yields a board the
  // solver proves OPTIMAL while quietly meaning something else. The service's
  // own ACL rejects all three; refusing here too means the caller learns why
  // without spending a round trip, and learns it as `invalid_request`.
  it.each([
    ["matchMinutes", { ...INPUT, constraints: { matchMinutes: 0, gapMinutes: 10 } }],
    [
      "dayCapByDivision entry",
      {
        ...INPUT,
        constraints: { matchMinutes: 30, gapMinutes: 10, dayCapByDivision: { "div-b": 0 } },
      },
    ],
    ["wallSeconds", { ...INPUT, wallSeconds: 0 }],
  ])("refuses a request whose %s is an ambiguous zero", async (_label, badInput) => {
    const mockClient = respondingClient();

    const rejection = await solveBuild(badInput, { secret: "s3cr3t" }, mockClient).catch(
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(CpSatError);
    expect((rejection as CpSatError).failure).toBe("invalid_request");
    // Refused before the wire, not after a round trip.
    expect(mockClient.solveBuild).not.toHaveBeenCalled();
  });

  // The injected-client seam types the request as `SolveBuildRequest`, but the
  // real channel does not stop at the type — it hands the object straight to
  // `SolveBuildRequest.encode`. Anything the wrapper leaves `undefined` that the
  // encoder expects to be present (`requestId` is the one the obvious cast
  // misses) throws or emits garbage only once a real server is on the other end,
  // which no amount of mocking would reveal. Serialising here is the cheapest
  // proxy for "a real channel would accept this".
  it("builds a request the generated encoder can round-trip", async () => {
    const mockClient = respondingClient();

    await solveBuild(
      {
        ...INPUT,
        fixtures: [{ fixtureId: "f1", entrantIds: ["e1", "e2"], divisionId: "div-a" }],
        grid: {
          slots: [{ court: "Court 1", startAtMs: 1_700_000_000_000, dayIndex: 0 }],
          stepMinutes: 10,
        },
        constraints: { matchMinutes: 30, gapMinutes: 10, restByDivision: { "div-a": 45 } },
      },
      { secret: "s3cr3t", requestId: "req-42" },
      mockClient,
    );

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    const decoded = SolveBuildRequest.decode(SolveBuildRequest.encode(request).finish());

    expect(decoded.requestId).toBe("req-42");
    expect(decoded.courtNames).toEqual(["Court 1"]);
    expect(decoded.entrantCount).toBe(2);
    expect(decoded.divisionCount).toBe(1);
    // `courtIndex: 0`, `divisionIndex: 0`, and `dayIndex: 0` all have to
    // survive the round trip through the REAL binary codec. Each is
    // proto3-`optional` precisely because 0 is a legitimate first index, not
    // an unset field: without explicit presence the encoder would drop every
    // one of them as a default, the service would see an absent field, and
    // (for `dayIndex` specifically) every slot would collapse into one
    // day-cap bucket.
    expect(decoded.slots).toEqual([{ courtIndex: 0, startAtMs: 1_700_000_000_000, dayIndex: 0 }]);
    expect(decoded.fixtures).toEqual([{ entrantIndices: [0, 1], divisionIndex: 0 }]);
    expect(decoded.divisionRules).toEqual([
      { divisionIndex: 0, minRestMinutes: 45, maxFixturesPerDay: undefined },
    ]);
    expect(decoded.wallSeconds).toBe(8);
  });

  // proto3 gives every enum a zero value the sender never means to set, and
  // ts-proto adds `UNRECOGNIZED = -1` for a status added to the service but not
  // yet regenerated here. Neither is a status the solver claimed. Reporting them
  // as "UNKNOWN" would be indistinguishable from the solver genuinely returning
  // an unproven board, which `build.ts` may reasonably still use — so the
  // unreadable cases have to land on the fail-safe side.
  it.each([
    ["UNSPECIFIED", SolveStatus.SOLVE_STATUS_UNSPECIFIED],
    ["UNRECOGNIZED", SolveStatus.UNRECOGNIZED],
  ])("reports an unreadable %s wire status as ERROR, not UNKNOWN", async (_label, wireStatus) => {
    const mockClient = respondingClient({ ...EMPTY_RESPONSE, status: wireStatus });

    const result = await solveBuild(INPUT, { secret: "s3cr3t" }, mockClient);

    expect(result.status).toBe("ERROR");
  });

  // A throw out of the RPC call itself (a message the generated encoder refuses,
  // a channel already closed) never reaches the callback, so without an explicit
  // catch the caller waits the full deadline to learn the call never started.
  it("rejects immediately when the call throws synchronously", async () => {
    const mockClient = {
      solveBuild: vi.fn(() => {
        throw new Error("channel closed");
      }),
    };
    // `performance.now()` rather than `Date.now()`: the engine boundary gate
    // scans test files too and bans ambient time outside core/clock.ts. It is
    // also the correct API for an elapsed-duration measurement — monotonic, and
    // immune to a clock adjustment mid-test.
    const startedAt = performance.now();

    await expect(
      solveBuild(INPUT, { secret: "s3cr3t" }, mockClient as unknown as SolveBuildCall),
    ).rejects.toThrow(/channel closed/);

    // Not swallowed into the 10s watchdog wait.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  // `settle()` disarms the watchdog BEFORE running its callback, so anything
  // that throws while translating the response leaves the promise pending with
  // nothing left to time it out — a permanent hang, strictly worse than the
  // failure it came from. `toOutcome` really can throw: the generated decoder
  // raises on an int64 past MAX_SAFE_INTEGER, and a repeated field that is not
  // an array dies on `.map`.
  it("rejects rather than hanging when the response cannot be translated", async () => {
    // `assignments` is not an array — `.map` throws inside the settle callback.
    const mockClient = respondingClient({ ...EMPTY_RESPONSE, assignments: 5 });
    const startedAt = performance.now();

    const rejection = await solveBuild(INPUT, { secret: "s3cr3t" }, mockClient).catch(
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(CpSatError);
    expect((rejection as CpSatError).failure).toBe("transport");
    // The point of the test: it settled at all, and did not wait out the 10s watchdog.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  // The wire budget and the transport deadline must come from ONE field. While
  // the budget was also settable through the options object, the two could
  // disagree with nothing to catch it: pass 8s in the input and 0 in the
  // options and the request still says 8s while the deadline lands at +2s, so
  // every solve dies at the margin and `build.ts` falls back to greedy on every
  // board. Asserting both halves against the same number is what pins them
  // together — the options type no longer has anywhere to put a second copy.
  it("derives the wire budget and the transport deadline from the same wallSeconds", async () => {
    const mockClient = respondingClient();

    await solveBuild(
      { ...INPUT, wallSeconds: 30 },
      { secret: "s3cr3t", clock: fixedClock("2026-08-09T12:00:00.000Z") },
      mockClient,
    );

    const [request, , callOptions] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.wallSeconds).toBe(30);
    // 30s wall + the 2s margin — not the 8s that INPUT and every other test use.
    expect((callOptions as { deadline: Date }).deadline.toISOString()).toBe(
      "2026-08-09T12:00:32.000Z",
    );
  });

  // A small multi-fixture, multi-court, multi-division board used by the two
  // round-trip tests below. "bob" deliberately appears in BOTH fixtures
  // (proves entrant dedup), and the fabricated response in the second test
  // deliberately uses SWAPPED indices relative to array order (proves
  // inversion reads the real index rather than just walking
  // `fixtures`/`courts` in order and coincidentally returning the right
  // strings — the brief's warning that "a mapping that is wrong in both
  // directions round-trips perfectly and is still wrong").
  const ROUND_TRIP_INPUT = {
    courts: ["Court 1", "Court 2"],
    fixtures: [
      { fixtureId: "f1", entrantIds: ["alice", "bob"], divisionId: "div-a" },
      { fixtureId: "f2", entrantIds: ["bob", "carol"], divisionId: "div-b" },
    ],
    grid: {
      slots: [
        { court: "Court 1", startAtMs: 1_700_000_000_000, dayIndex: 0 },
        { court: "Court 2", startAtMs: 1_700_003_600_000, dayIndex: 0 },
      ],
      stepMinutes: 10,
    },
    existing: [{ fixtureId: "pinned-1", court: "Court 2", startAtMs: 1_700_007_200_000 }],
    dependencies: [{ beforeFixtureId: "f1", afterFixtureId: "f2" }],
    constraints: { matchMinutes: 30, gapMinutes: 10, restByDivision: { "div-a": 45 } },
    wallSeconds: 8,
  };

  it("sends ids as positional indices, derived from the input, on the wire", async () => {
    const mockClient = respondingClient();

    await solveBuild(ROUND_TRIP_INPUT, { secret: "s3cr3t" }, mockClient);

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.courtNames).toEqual(["Court 1", "Court 2"]);
    // "bob" is in BOTH fixtures and gets ONE index — entrants dedup by id;
    // courts and fixtures do not (see the duplicate-court tests below).
    expect(request.entrantCount).toBe(3); // alice, bob, carol
    expect(request.divisionCount).toBe(2); // div-a, div-b
    expect(request.fixtures).toEqual([
      { entrantIndices: [0, 1], divisionIndex: 0 }, // f1: alice=0, bob=1, div-a=0
      { entrantIndices: [1, 2], divisionIndex: 1 }, // f2: bob=1 (reused), carol=2, div-b=1
    ]);
    expect(request.slots).toEqual([
      { courtIndex: 0, startAtMs: 1_700_000_000_000, dayIndex: 0 },
      { courtIndex: 1, startAtMs: 1_700_003_600_000, dayIndex: 0 },
    ]);
    // `existing[].fixtureId` ("pinned-1") is dropped, not translated: PinnedRow
    // carries no identity on the wire any more.
    expect(request.existing).toEqual([{ courtIndex: 1, startAtMs: 1_700_007_200_000 }]);
    expect(request.dependencies).toEqual([{ beforeIndex: 0, afterIndex: 1 }]);
    expect(request.divisionRules).toEqual([
      { divisionIndex: 0, minRestMinutes: 45, maxFixturesPerDay: undefined },
    ]);
  });

  it("inverts assignment indices back to the original ids on the way out", async () => {
    const outcome = await solveBuild(
      ROUND_TRIP_INPUT,
      { secret: "s3cr3t" },
      respondingClient({
        ...EMPTY_RESPONSE,
        assignments: [
          { fixtureIndex: 1, courtIndex: 0, startAtMs: 1_700_000_000_000 },
          { fixtureIndex: 0, courtIndex: 1, startAtMs: 1_700_003_600_000 },
        ],
      }),
    );

    expect(outcome.assignments).toEqual([
      { fixtureId: "f2", court: "Court 1", startAtMs: 1_700_000_000_000 },
      { fixtureId: "f1", court: "Court 2", startAtMs: 1_700_003_600_000 },
    ]);
  });

  // "Duplicate court names are now legal and must round-trip" (round-6
  // brief). Two courts genuinely named "Court 1" are two courts: they get two
  // distinct wire indices, and BOTH must decode back to "Court 1" — proving
  // the mapping does not collapse them into one.
  it("gives two identically-named courts distinct indices that both decode correctly", async () => {
    const input = {
      ...INPUT,
      courts: ["Court 1", "Court 1"],
      fixtures: [{ fixtureId: "f1", entrantIds: [], divisionId: "div-a" }],
    };
    const mockClient = respondingClient();

    await solveBuild(input, { secret: "s3cr3t" }, mockClient);

    // Not deduplicated: the SECOND "Court 1" keeps its own wire position.
    const [request] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.courtNames).toEqual(["Court 1", "Court 1"]);

    const outcome = await solveBuild(
      input,
      { secret: "s3cr3t" },
      respondingClient({
        ...EMPTY_RESPONSE,
        assignments: [
          { fixtureIndex: 0, courtIndex: 0, startAtMs: 1 },
          { fixtureIndex: 0, courtIndex: 1, startAtMs: 2 },
        ],
      }),
    );
    expect(outcome.assignments).toEqual([
      { fixtureId: "f1", court: "Court 1", startAtMs: 1 },
      { fixtureId: "f1", court: "Court 1", startAtMs: 2 },
    ]);
  });

  // The input-side counterpart of the test above, and the limitation it
  // implies: a SLOT names a court only by string, which cannot address one
  // specific duplicate among several identically-named courts — nothing on
  // `SolveBuildInput` distinguishes them beyond array position, and position
  // is exactly what a bare string reference throws away. Pinned here as a
  // documented, deterministic convention (first occurrence wins) rather than
  // an unstated gap that could drift silently.
  it("resolves a slot naming a duplicate court to its first occurrence", async () => {
    const mockClient = respondingClient();

    await solveBuild(
      {
        ...INPUT,
        courts: ["Court 1", "Court 1"],
        grid: { slots: [{ court: "Court 1", startAtMs: 5, dayIndex: 0 }], stepMinutes: 10 },
      },
      { secret: "s3cr3t" },
      mockClient,
    );

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.slots).toEqual([{ courtIndex: 0, startAtMs: 5, dayIndex: 0 }]);
  });

  // A guard against a subtly wrong implementation: if the index assigned to a
  // NEW court name were "how many DISTINCT names seen so far" rather than
  // "this court's own array position", an earlier duplicate would make every
  // later court's index one too LOW. `courts[2]` ("Court 2") must resolve to
  // courtIndex 2, not 1, even though only 2 distinct names precede it.
  it("keeps a later distinct court at its own array position after an earlier duplicate", async () => {
    const mockClient = respondingClient();

    await solveBuild(
      {
        ...INPUT,
        courts: ["Court 1", "Court 1", "Court 2"],
        grid: { slots: [{ court: "Court 2", startAtMs: 1, dayIndex: 0 }], stepMinutes: 10 },
      },
      { secret: "s3cr3t" },
      mockClient,
    );

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.courtNames).toEqual(["Court 1", "Court 1", "Court 2"]);
    expect(request.slots).toEqual([{ courtIndex: 2, startAtMs: 1, dayIndex: 0 }]);
  });

  // The three families that defeated three rounds of server-side
  // `_require_id` content rules (round-6 brief): trailing whitespace, an
  // invisible code point that still passes `isprintable()`, and a homoglyph.
  // The TS client never validated name CONTENT to begin with, so "harmless"
  // here means: two distinct byte strings resolve to two distinct indices,
  // neither is rejected, and each is sent verbatim — no trimming, no
  // normalising, which would silently defeat the whole point of the redesign.
  it.each([
    ["trailing whitespace", "Court 1", "Court 1 "],
    ["an invisible code point (U+3164 Hangul Filler)", "Court 1", "Court 1ㅤ"],
    ["a homoglyph (Cyrillic Es U+0421)", "Court 1", "Сourt 1"],
  ])("treats two courts differing only by %s as distinct, not rejected", async (_label, a, b) => {
    const mockClient = respondingClient();

    await solveBuild(
      {
        ...INPUT,
        courts: [a, b],
        grid: {
          slots: [
            { court: a, startAtMs: 1, dayIndex: 0 },
            { court: b, startAtMs: 2, dayIndex: 0 },
          ],
          stepMinutes: 10,
        },
      },
      { secret: "s3cr3t" },
      mockClient,
    );

    const [request] = mockClient.solveBuild.mock.calls[0]!;
    expect(request.courtNames).toEqual([a, b]);
    expect(request.slots).toEqual([
      { courtIndex: 0, startAtMs: 1, dayIndex: 0 },
      { courtIndex: 1, startAtMs: 2, dayIndex: 0 },
    ]);
  });

  // "Presence, not zero": if a slot names a court that is not anywhere in
  // `courts`, the client must refuse rather than silently resolving to SOME
  // index — there is no safe default, because 0 is itself a real court.
  it("refuses a slot that references a court missing from courts", async () => {
    const mockClient = respondingClient();

    const rejection = await solveBuild(
      {
        ...INPUT,
        courts: ["Court 1"],
        grid: { slots: [{ court: "Court 9", startAtMs: 1, dayIndex: 0 }], stepMinutes: 10 },
      },
      { secret: "s3cr3t" },
      mockClient,
    ).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(CpSatError);
    expect((rejection as CpSatError).failure).toBe("invalid_request");
    // Refused before the wire, not after a round trip.
    expect(mockClient.solveBuild).not.toHaveBeenCalled();
  });

  // Same defence for the OTHER string reference the client resolves itself:
  // a dependency naming a fixture that is not in `fixtures`.
  it("refuses a dependency that references an unknown fixture", async () => {
    const mockClient = respondingClient();

    const rejection = await solveBuild(
      {
        ...INPUT,
        fixtures: [{ fixtureId: "f1", entrantIds: [], divisionId: "div-a" }],
        dependencies: [{ beforeFixtureId: "f1", afterFixtureId: "ghost" }],
      },
      { secret: "s3cr3t" },
      mockClient,
    ).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(CpSatError);
    expect((rejection as CpSatError).failure).toBe("invalid_request");
    expect(mockClient.solveBuild).not.toHaveBeenCalled();
  });
});
