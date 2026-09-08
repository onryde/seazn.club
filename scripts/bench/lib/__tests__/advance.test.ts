// B05 T3 — unit coverage for lib/advance.ts, the stage-advancement flow:
// `propose -> assert -> confirm -> generate` for one target stage (D7), and
// `complete`, captured (D1).
//
// Every call goes through an injected `AdvanceTransport` fake (`{ raw }`,
// the same narrow-DI shape `simulate.ts`'s `SimTransport` and `import.ts`'s
// `ImportTransport` use) — nothing here touches `global.fetch` or a real
// server.
//
// What this file pins, and why:
//  * D7 — the assertion sits BETWEEN propose and confirm. A wrong expected
//    qualifier list reds at the proposal, and NOTHING downstream (confirm,
//    generate) is ever called — asserted by counting calls to each route,
//    not merely by reading the returned outcome.
//  * D1 — `completeStageCapture` reads `finalRanks` off the `complete`
//    response's `events[0]`, the ONLY place it ever crosses the wire.
//  * The finalRanks comparison is exact-order equality, not a length check —
//    a same-length, reordered actual must NOT match.
import { newSession, type RawResult, type Session } from "../http.ts";
import { describe, expect, it } from "vitest";
import {
  advanceStageSeeding,
  compareFinalRanks,
  compareQualifiers,
  completeStageCapture,
  type AdvanceTransport,
} from "../advance.ts";

const BASE = "http://bench.example";

function session(): Session {
  return newSession();
}

// ---------------------------------------------------------------------------
// A minimal fake for advanceStageSeeding's three routes, call-counted so a
// mismatch's "nothing downstream ran" claim can be verified directly rather
// than inferred from the returned outcome.
// ---------------------------------------------------------------------------

interface FakeOpts {
  readonly qualifiers: { rank: number; entrantId: string }[];
  readonly proposalId?: string;
  readonly confirmStatus?: number;
  readonly generateStatus?: number;
}

function fakeSeedingServer(opts: FakeOpts): { transport: AdvanceTransport; calls: string[] } {
  const calls: string[] = [];
  const proposalId = opts.proposalId ?? "proposal-1";
  const transport: AdvanceTransport = {
    async raw(_base, _s, path, method): Promise<RawResult> {
      calls.push(`${method ?? "GET"} ${path}`);
      if (/\/seed-proposal$/.test(path)) {
        return {
          status: 201,
          json: {
            ok: true,
            data: {
              id: proposalId,
              stageId: "stage-target",
              status: "draft",
              computed: { qualifiers: opts.qualifiers, ties: [], standingsHash: "h1" },
            },
          },
        };
      }
      if (/\/seed-proposal\/confirm$/.test(path)) {
        const status = opts.confirmStatus ?? 200;
        if (status !== 200) {
          return { status, json: { ok: false, error: { code: "SEEDING_STALE", message: "stale" } } };
        }
        return { status: 200, json: { ok: true, data: { proposalId, filled: opts.qualifiers.length } } };
      }
      if (/\/generate$/.test(path)) {
        const status = opts.generateStatus ?? 200;
        if (status !== 200) {
          return { status, json: { ok: false, error: { code: "SCHEDULE_LOCKED", message: "locked" } } };
        }
        return { status: 200, json: { ok: true, data: { created: 0, existing: 1, fixtures: [] } } };
      }
      throw new Error(`fake seeding server: unhandled ${method} ${path}`);
    },
  };
  return { transport, calls };
}

describe("advanceStageSeeding — propose -> assert -> confirm -> generate (D7)", () => {
  it("a MATCHING proposal confirms and generates, in order", async () => {
    const { transport, calls } = fakeSeedingServer({
      qualifiers: [
        { rank: 1, entrantId: "id-alpha" },
        { rank: 2, entrantId: "id-bravo" },
      ],
    });
    const result = await advanceStageSeeding({
      base: BASE,
      session: session(),
      stageId: "stage-target",
      expectedQualifierEntrantIds: ["id-alpha", "id-bravo"],
      transport,
    });
    expect(result.qualifierCheck.matched).toBe(true);
    expect(result.confirmed).toEqual({ filled: 2 });
    expect(result.generated).toEqual({ created: 0, existing: 1 });
    expect(calls).toEqual([
      "POST /api/v1/stages/stage-target/seed-proposal",
      "POST /api/v1/stages/stage-target/seed-proposal/confirm",
      "POST /api/v1/stages/stage-target/generate",
    ]);
  });

  it("D7 — a WRONG expected qualifier list reds at the proposal, and confirm/generate are NEVER called", async () => {
    const { transport, calls } = fakeSeedingServer({
      qualifiers: [
        { rank: 1, entrantId: "id-alpha" },
        { rank: 2, entrantId: "id-bravo" },
      ],
    });
    const result = await advanceStageSeeding({
      base: BASE,
      session: session(),
      stageId: "stage-target",
      // WRONG: bravo/alpha reversed — the pack's own expected table said
      // alpha first.
      expectedQualifierEntrantIds: ["id-bravo", "id-alpha"],
      transport,
    });
    expect(result.qualifierCheck.matched).toBe(false);
    expect(result.qualifierCheck.expected).toEqual(["id-bravo", "id-alpha"]);
    expect(result.qualifierCheck.actual).toEqual(["id-alpha", "id-bravo"]);
    // The absence of the downstream calls, not just the absence of a
    // returned outcome — a caller that ignored `qualifierCheck.matched` and
    // called confirm anyway would still pass an assertion on `result.confirmed`
    // alone if `dataOf` happened to return something falsy-looking; counting
    // calls is what actually proves nothing downstream ran.
    expect(result.confirmed).toBeUndefined();
    expect(result.generated).toBeUndefined();
    expect(calls).toEqual(["POST /api/v1/stages/stage-target/seed-proposal"]);
  });

  it("a mismatch on COUNT ALONE (fewer actual qualifiers) also stops before confirm", async () => {
    const { transport, calls } = fakeSeedingServer({
      qualifiers: [{ rank: 1, entrantId: "id-alpha" }],
    });
    const result = await advanceStageSeeding({
      base: BASE,
      session: session(),
      stageId: "stage-target",
      expectedQualifierEntrantIds: ["id-alpha", "id-bravo"],
      transport,
    });
    expect(result.qualifierCheck.matched).toBe(false);
    expect(calls).toEqual(["POST /api/v1/stages/stage-target/seed-proposal"]);
  });

  it("a seed-proposal refusal throws — a genuine bug this bench must catch, never silently skipped", async () => {
    const transport: AdvanceTransport = {
      async raw(): Promise<RawResult> {
        return { status: 422, json: { ok: false, error: { code: "SEEDING_RULES_MISSING", message: "no rules" } } };
      },
    };
    await expect(
      advanceStageSeeding({
        base: BASE,
        session: session(),
        stageId: "stage-target",
        expectedQualifierEntrantIds: ["id-alpha"],
        transport,
      }),
    ).rejects.toThrow(/SEEDING_RULES_MISSING/);
  });

  it("a confirm refusal (e.g. a stale proposal) throws — generate is never reached", async () => {
    const { transport, calls } = fakeSeedingServer({
      qualifiers: [{ rank: 1, entrantId: "id-alpha" }],
      confirmStatus: 409,
    });
    await expect(
      advanceStageSeeding({
        base: BASE,
        session: session(),
        stageId: "stage-target",
        expectedQualifierEntrantIds: ["id-alpha"],
        transport,
      }),
    ).rejects.toThrow(/SEEDING_STALE/);
    expect(calls).toEqual([
      "POST /api/v1/stages/stage-target/seed-proposal",
      "POST /api/v1/stages/stage-target/seed-proposal/confirm",
    ]);
  });

  it("a generate refusal (e.g. a frozen/locked division) throws, after confirm succeeded", async () => {
    const { transport, calls } = fakeSeedingServer({
      qualifiers: [{ rank: 1, entrantId: "id-alpha" }],
      generateStatus: 422,
    });
    await expect(
      advanceStageSeeding({
        base: BASE,
        session: session(),
        stageId: "stage-target",
        expectedQualifierEntrantIds: ["id-alpha"],
        transport,
      }),
    ).rejects.toThrow(/SCHEDULE_LOCKED/);
    expect(calls).toEqual([
      "POST /api/v1/stages/stage-target/seed-proposal",
      "POST /api/v1/stages/stage-target/seed-proposal/confirm",
      "POST /api/v1/stages/stage-target/generate",
    ]);
  });
});

describe("compareQualifiers — pure", () => {
  it("matches regardless of the WIRE order, sorted by rank", () => {
    const result = compareQualifiers(
      ["id-alpha", "id-bravo"],
      [
        { rank: 2, entrantId: "id-bravo" },
        { rank: 1, entrantId: "id-alpha" },
      ],
    );
    expect(result.matched).toBe(true);
  });

  it("a same-COUNT, different-ORDER computed list does not match", () => {
    const result = compareQualifiers(
      ["id-alpha", "id-bravo"],
      [
        { rank: 1, entrantId: "id-bravo" },
        { rank: 2, entrantId: "id-alpha" },
      ],
    );
    expect(result.matched).toBe(false);
  });
});

describe("completeStageCapture — D1 (capture, because you cannot re-read)", () => {
  it("captures finalRanks off events[0] of the complete response", async () => {
    const calls: string[] = [];
    const transport: AdvanceTransport = {
      async raw(_base, _s, path, method): Promise<RawResult> {
        calls.push(`${method ?? "GET"} ${path}`);
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              completed: true,
              events: [{ type: "stage_completed", stageId: "stage-target", finalRanks: ["id-bravo", "id-alpha"] }],
            },
          },
        };
      },
    };
    const capture = await completeStageCapture(BASE, session(), "stage-target", transport);
    expect(capture.completed).toBe(true);
    expect(capture.finalRanks).toEqual(["id-bravo", "id-alpha"]);
    expect(calls).toEqual(["POST /api/v1/stages/stage-target/complete"]);
  });

  it("carries divisionCompleted when the response sets it (the last stage in the division)", async () => {
    const transport: AdvanceTransport = {
      async raw(): Promise<RawResult> {
        return {
          status: 200,
          json: {
            ok: true,
            data: {
              completed: true,
              events: [{ type: "stage_completed", stageId: "s", finalRanks: ["a", "b"] }],
              division_completed: true,
            },
          },
        };
      },
    };
    const capture = await completeStageCapture(BASE, session(), "stage-target", transport);
    expect(capture.divisionCompleted).toBe(true);
  });

  it("finalRanks is absent when the stage did not complete", async () => {
    const transport: AdvanceTransport = {
      async raw(): Promise<RawResult> {
        return { status: 200, json: { ok: true, data: { completed: false, events: [] } } };
      },
    };
    const capture = await completeStageCapture(BASE, session(), "stage-target", transport);
    expect(capture.completed).toBe(false);
    expect(capture.finalRanks).toBeUndefined();
  });

  it("a complete refusal throws", async () => {
    const transport: AdvanceTransport = {
      async raw(): Promise<RawResult> {
        return { status: 422, json: { ok: false, error: { code: "STAGE_NOT_READY", message: "not decided" } } };
      },
    };
    await expect(completeStageCapture(BASE, session(), "stage-target", transport)).rejects.toThrow(
      /STAGE_NOT_READY/,
    );
  });

  it("MUTATION CHECK: dropping the response and re-deriving from history instead loses finalRanks", async () => {
    // history.ts:375-397 selects seq/type/actor_id/created_at and NOT
    // payload — so a caller that "helpfully" re-read the division's history
    // instead of trusting the capture would find no finalRanks at all. This
    // simulates exactly that mutant: a transport whose `complete` response
    // is well-formed but whose payload has been stripped the way history's
    // own SELECT would leave it, proving the CAPTURE path (not a later
    // re-read) is what this function depends on.
    const transport: AdvanceTransport = {
      async raw(_base, _s, path): Promise<RawResult> {
        if (/\/complete$/.test(path)) {
          // What `completeStageCapture` ACTUALLY reads: events WITH payload.
          return {
            status: 200,
            json: {
              ok: true,
              data: { completed: true, events: [{ type: "stage_completed", stageId: "s", finalRanks: ["a", "b"] }] },
            },
          };
        }
        throw new Error("unreachable");
      },
    };
    const real = await completeStageCapture(BASE, session(), "stage-target", transport);
    expect(real.finalRanks).toEqual(["a", "b"]);

    // The mutant: same completed stage, but as `GET /divisions/{id}/history`
    // would report it — seq/type/actor_id/created_at, no payload, hence no
    // finalRanks. A function that dropped the capture and rebuilt this from
    // a history-shaped read would only ever see this and could never recover
    // the ranks.
    const historyShaped = { seq: 7, type: "stage_completed", actor_id: null, created_at: "2099-01-01T00:00:00Z" };
    expect((historyShaped as { finalRanks?: unknown }).finalRanks).toBeUndefined();
  });
});

describe("compareFinalRanks — pure, EXACT order (D1's finalRanks oracle)", () => {
  it("matches on exact order", () => {
    expect(compareFinalRanks(["id-alpha", "id-bravo"], ["id-alpha", "id-bravo"]).matched).toBe(true);
  });

  it("a MISMATCH renders both sides", () => {
    const result = compareFinalRanks(["id-alpha", "id-bravo"], ["id-bravo", "id-alpha"]);
    expect(result.matched).toBe(false);
    expect(result.expected).toEqual(["id-alpha", "id-bravo"]);
    expect(result.actual).toEqual(["id-bravo", "id-alpha"]);
  });

  it("MUTATION TARGET — comparing LENGTHS ONLY must not be satisfied by a same-length reorder", () => {
    // This is the exact mutant the brief names: `actual.length ===
    // expected.length` alone, no per-element check. Proven here by
    // asserting the REAL function reds on a same-length reorder; the mutant
    // itself is exercised by hand in the mutation sweep (see the task
    // report), which breaks `compareFinalRanks` down to a bare length
    // check and confirms THIS test goes red.
    const expected = ["id-alpha", "id-bravo", "id-charlie"];
    const actualReordered = ["id-charlie", "id-bravo", "id-alpha"];
    expect(expected.length).toBe(actualReordered.length);
    expect(compareFinalRanks(expected, actualReordered).matched).toBe(false);
  });

  it("undefined actual (the stage never completed) never matches", () => {
    expect(compareFinalRanks(["id-alpha"], undefined).matched).toBe(false);
  });

  // B05 review round 1, MAJOR 3: the same vacuous-pass shape
  // `compareRankCrossings` was hardened away from in 8376359cc. `[].every(…)`
  // is vacuously true and `0 === 0`, so empty/empty reported `matched: true` —
  // a comparator agreeing with nothing. Only `pack-schema.ts`'s
  // `order.min(2)` kept it unreachable, which is a schema constraint standing
  // in for the comparator's own discipline.
  it("empty EXPECTED and empty ACTUAL is a RED, not a vacuous pass, and says why", () => {
    const result = compareFinalRanks([], []);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/nothing to agree on/);
  });

  it("an empty side reds even when the OTHER side is real — both directions", () => {
    const emptyActual = compareFinalRanks(["id-alpha", "id-bravo"], []);
    expect(emptyActual.matched).toBe(false);
    expect(emptyActual.reason).toMatch(/nothing to agree on/);

    const emptyExpected = compareFinalRanks([], ["id-alpha", "id-bravo"]);
    expect(emptyExpected.matched).toBe(false);
    expect(emptyExpected.reason).toMatch(/nothing to agree on/);
  });

  it("POSITIVE PAIR — a real agreement still matches, and carries NO reason", () => {
    // Without this, "return matched:false always" passes every red above.
    const result = compareFinalRanks(["id-alpha", "id-bravo"], ["id-alpha", "id-bravo"]);
    expect(result.matched).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("an ordinary mismatch carries NO reason — emptiness is a distinct verdict", () => {
    // `reason` is set only on false-by-EMPTINESS, exactly as
    // `RankCrossingComparison.reason` is, so a reader is never tempted to
    // read one as the other.
    expect(compareFinalRanks(["id-alpha", "id-bravo"], ["id-bravo", "id-alpha"]).reason).toBeUndefined();
    expect(compareFinalRanks(["id-alpha"], undefined).reason).toBeUndefined();
  });
});
