// AI apply orchestration (v4 Task 15). The chain is the contract: a timestamped
// checkpoint, the schedule apply(s), the officials apply, then the ticked rule
// PUT — in that order. These tests mock the injected fetch seam, assert the call
// ORDER + payloads, and cover the three outcome branches from the brief. One
// case drives the real apiV1 over a mocked global fetch to prove the default
// wiring + envelope unwrap.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import {
  applyAiPlans,
  mergeConstraintSuggestions,
  suggestionKeysOf,
  type ApplyAiInput,
  type ApplyApi,
  type ConstraintSuggestions,
} from "../ai-apply";
import type { AiApplyMeta, ScheduleConfig } from "@/server/api-v1/schemas";

const audit: AiApplyMeta = { instruction: "spread it out", summary: "moved 3", model: "m", repair_rounds: 1 };
const offAudit: AiApplyMeta = { instruction: "cover it", summary: "assigned 2", model: "m", repair_rounds: 0 };

/** A recording fetch seam: logs every call in order, answers by url substring.
 *  Handlers get the method too, so the checkpoints list (GET) and create (POST)
 *  — which share a url — can answer differently. */
function recorder(
  handlers: Record<string, (call: { url: string; json: unknown; method?: string }) => unknown> = {},
) {
  const calls: { url: string; method?: string; json: unknown }[] = [];
  const api: ApplyApi = (async (url: string, options?: { method?: string; json?: unknown }) => {
    calls.push({ url, method: options?.method, json: options?.json });
    for (const [pat, fn] of Object.entries(handlers)) {
      if (url.includes(pat)) return fn({ url, json: options?.json, method: options?.method });
    }
    return {};
  }) as ApplyApi;
  return { api, calls };
}

function baseInput(over: Partial<ApplyAiInput> = {}): ApplyAiInput {
  return {
    divisionId: "div-1",
    expectedSeq: 7,
    scheduleAssignments: [
      { fixture_id: "fa", scheduled_at: "2026-08-01T10:00:00Z", court_id: "c0000000-0000-4000-8000-000000000001", stage_id: "st-1" },
      { fixture_id: "fb", scheduled_at: "2026-08-01T11:00:00Z", court_id: "c0000000-0000-4000-8000-000000000001", stage_id: "st-1" },
    ],
    scheduleAudit: audit,
    officials: {
      assignments: [
        { fixture_id: "fa", official_id: "o1", role_key: "referee", locked: false },
        { fixture_id: "fb", official_id: "o2", role_key: "referee", locked: false },
      ],
      audit: offAudit,
    },
    excludedFixtureIds: [],
    suggestions: null,
    ...over,
  };
}

// The chain no longer lists checkpoints: every apply creates its own kind:'ai'
// anchor (V303), which is exempt from the save-point quota.
const okHandlers = {
  checkpoints: ({ method }: { method?: string }) => (method === "POST" ? { id: "cp-1" } : []),
};

describe("applyAiPlans — chained accept", () => {
  it("runs checkpoint → schedule apply → officials apply → suggestion PUT in order", async () => {
    const { api, calls } = recorder(okHandlers);
    const out = await applyAiPlans(
      baseInput({ suggestions: { config: { courts: ["Court 1"] } as ScheduleConfig, tz: "UTC" } }),
      api,
    );

    // `stagesApplied` is part of the outcome now: one stage's worth of
    // assignments went in, and the console reads that count to tell a clean
    // apply from a half-written one.
    expect(out).toEqual({
      schedule: "applied",
      officials: "applied",
      checkpointId: "cp-1",
      stagesApplied: 1,
    });
    const seam = calls.map((c) => `${c.method} ${c.url}`);
    expect(seam).toEqual([
      "POST /api/v1/divisions/div-1/checkpoints",
      "POST /api/v1/stages/st-1/schedule/apply",
      "POST /api/v1/divisions/div-1/officials/apply",
      "PUT /api/v1/divisions/div-1/schedule-settings",
    ]);
  });

  it("stamps the payloads: label, source:ai, expected_seq, and both ai audit blocks", async () => {
    const { api, calls } = recorder(okHandlers);
    await applyAiPlans(baseInput(), api);

    // [0] POST create anchor, [1] schedule apply, [2] officials apply.
    // Label is timestamped so a restore point says WHICH run it precedes, and
    // kind:"ai" keeps it off the organiser's save-point quota.
    expect(calls[0].json).toMatchObject({ kind: "ai" });
    expect((calls[0].json as { label: string }).label).toMatch(/^Before AI · /);
    expect(calls[1].json).toMatchObject({ source: "ai", expected_seq: 7, ai: audit });
    expect((calls[1].json as { assignments: unknown }).assignments).toEqual([
      { fixture_id: "fa", scheduled_at: "2026-08-01T10:00:00Z", court_id: "c0000000-0000-4000-8000-000000000001" },
      { fixture_id: "fb", scheduled_at: "2026-08-01T11:00:00Z", court_id: "c0000000-0000-4000-8000-000000000001" },
    ]);
    expect(calls[2].json).toMatchObject({ ai: offAudit });
  });

  it("excludes unticked fixtures from BOTH the schedule and officials payloads", async () => {
    const { api, calls } = recorder(okHandlers);
    await applyAiPlans(baseInput({ excludedFixtureIds: ["fb"] }), api);

    // [1] schedule apply, [2] officials apply (after the POST create).
    expect(
      (calls[1].json as { assignments: { fixture_id: string }[] }).assignments.map((a) => a.fixture_id),
    ).toEqual(["fa"]);
    expect(
      (calls[2].json as { assignments: { fixture_id: string }[] }).assignments.map((a) => a.fixture_id),
    ).toEqual(["fa"]);
  });

  it("applies each stage separately with a forward-walking expected_seq", async () => {
    const { api, calls } = recorder({
      ...okHandlers,
      "/schedule/apply": ({ json }) => ({ applied: 1, skipped: 0, conflicts: [], seq: (json as { expected_seq: number }).expected_seq + 1 }),
    });
    await applyAiPlans(
      baseInput({
        scheduleAssignments: [
          { fixture_id: "fa", scheduled_at: "t", court_id: "c0000000-0000-4000-8000-000000000002", stage_id: "st-1" },
          { fixture_id: "fb", scheduled_at: "t", court_id: "c0000000-0000-4000-8000-000000000002", stage_id: "st-2" },
        ],
        officials: null,
      }),
      api,
    );
    const applies = calls.filter((c) => c.url.includes("/schedule/apply"));
    expect(applies.map((c) => c.url)).toEqual([
      "/api/v1/stages/st-1/schedule/apply",
      "/api/v1/stages/st-2/schedule/apply",
    ]);
    expect(applies.map((c) => (c.json as { expected_seq: number }).expected_seq)).toEqual([7, 8]);
  });

  // Review 4 of #857, Minor 1. A stage whose every fixture holds a result
  // moves nothing, writes no ledger step and leaves the seq where it was. The
  // chain assumed +1 and sent the next stage a seq the server refuses.
  it("a stage that moved nothing leaves the next stage's expected_seq where the server says it is", async () => {
    const { api, calls } = recorder({
      ...okHandlers,
      "/stages/st-1/schedule/apply": () => ({ applied: 0, skipped: 1, conflicts: [], seq: 7 }),
      "/stages/st-2/schedule/apply": () => ({ applied: 1, skipped: 0, conflicts: [], seq: 8 }),
    });
    const out = await applyAiPlans(
      baseInput({
        scheduleAssignments: [
          { fixture_id: "fa", scheduled_at: "t", court_id: "c0000000-0000-4000-8000-000000000002", stage_id: "st-1" },
          { fixture_id: "fb", scheduled_at: "t", court_id: "c0000000-0000-4000-8000-000000000002", stage_id: "st-2" },
        ],
        officials: null,
      }),
      api,
    );
    const applies = calls.filter((c) => c.url.includes("/schedule/apply"));
    expect(applies.map((c) => (c.json as { expected_seq: number }).expected_seq)).toEqual([7, 7]);
    expect(out).toMatchObject({ schedule: "applied", stagesApplied: 2 });
  });

  // ------------------------------------------------------------- outcome branches
  it("Apply schedule only → officials skipped, no officials call", async () => {
    const { api, calls } = recorder(okHandlers);
    const out = await applyAiPlans(baseInput({ officials: null }), api);
    expect(out).toMatchObject({ schedule: "applied", officials: "skipped" });
    expect(calls.some((c) => c.url.includes("/officials/apply"))).toBe(false);
  });

  it("SEQ_CONFLICT on schedule apply → seq_conflict, officials + suggestions skipped", async () => {
    const { api, calls } = recorder({
      ...okHandlers,
      "schedule/apply": () => {
        throw new ApiV1Error("stale", 409, "SEQ_CONFLICT");
      },
    });
    const out = await applyAiPlans(
      baseInput({ suggestions: { config: {} as ScheduleConfig, tz: "UTC" } }),
      api,
    );
    expect(out).toMatchObject({
      schedule: "seq_conflict",
      officials: "skipped",
      checkpointId: "cp-1",
      errorCode: "SEQ_CONFLICT",
      errorStatus: 409,
    });
    expect(calls.some((c) => c.url.includes("/officials/apply"))).toBe(false);
    expect(calls.some((c) => c.url.includes("schedule-settings"))).toBe(false);
  });

  it("a blocking SCHEDULE_CONFLICT (not stale) → schedule error, not seq_conflict", async () => {
    const { api } = recorder({
      ...okHandlers,
      "schedule/apply": () => {
        throw new ApiV1Error("blocked", 409, "SCHEDULE_CONFLICT");
      },
    });
    const out = await applyAiPlans(baseInput(), api);
    // The status rides alongside the code so the console can map it via
    // aiErrorKey (409 → "the board changed" rather than the flat generic).
    expect(out).toMatchObject({
      schedule: "error",
      officials: "skipped",
      errorCode: "SCHEDULE_CONFLICT",
      errorStatus: 409,
    });
  });

  /**
   * The refusal names the fixtures it is about, and that list has to survive the
   * trip to the console.
   *
   * The server puts the blocking conflicts in the 409's envelope precisely so a
   * client can point at them; until now `ai-apply` read only the code and the
   * status, so the dock could say "this would clash" and nothing more — which,
   * on a board of forty matches, is barely more actionable than the wrong
   * sentence it replaced.
   */
  it("carries the blocking fixtures a SCHEDULE_CONFLICT named", async () => {
    const { api } = recorder({
      ...okHandlers,
      "schedule/apply": () => {
        throw new ApiV1Error("blocked", 409, "SCHEDULE_CONFLICT", {
          conflicts: [
            { fixture_id: "fa", code: "court_double_booked", blocking: true },
            { fixture_id: "fb", code: "entrant_double_booked", blocking: true },
            // Non-blocking rows ride along in the same envelope; they are not
            // why the apply was refused, so they must not be listed as if they
            // were.
            { fixture_id: "fc", code: "rest", blocking: false },
          ],
        });
      },
    });
    const out = await applyAiPlans(baseInput(), api);
    expect(out).toMatchObject({ schedule: "error", errorCode: "SCHEDULE_CONFLICT", errorStatus: 409 });
    expect(out.errorConflicts).toStrictEqual([
      { fixtureId: "fa", code: "court_double_booked" },
      { fixtureId: "fb", code: "entrant_double_booked" },
    ]);
  });

  /**
   * A REFUSAL IS NOT A ROLLBACK.
   *
   * `applyAiPlans` groups the proposal by stage and posts one apply per stage,
   * each its own transaction with its own `expected_seq`. A division with a
   * league and a finals stage therefore has a real partial state: stage one
   * persists, stage two is refused, and the run reports failure over a board
   * that DID change. The count is what lets the console tell that apart from
   * the nothing-was-written case — and it is the same count that decides
   * whether Undo is worth offering, since the before-AI checkpoint exists
   * either way.
   */
  it("counts the stages that landed before a mid-plan refusal", async () => {
    let applies = 0;
    const { api } = recorder({
      ...okHandlers,
      "schedule/apply": () => {
        applies += 1;
        // First stage lands; the second is refused over a clash it would add.
        if (applies > 1) {
          throw new ApiV1Error("blocked", 409, "SCHEDULE_CONFLICT", {
            conflicts: [{ fixture_id: "fb", code: "court_double_booked", blocking: true }],
          });
        }
        return {};
      },
    });

    const out = await applyAiPlans(
      baseInput({
        scheduleAssignments: [
          { fixture_id: "fa", stage_id: "st-1", scheduled_at: "2026-08-01T09:00:00.000Z", court_id: "c1" },
          { fixture_id: "fb", stage_id: "st-2", scheduled_at: "2026-08-01T09:00:00.000Z", court_id: "c1" },
        ],
      }),
      api,
    );

    expect(out).toMatchObject({ schedule: "error", errorCode: "SCHEDULE_CONFLICT" });
    expect(out.stagesApplied, "one stage was written before the refusal").toBe(1);
    // The anchor is still there, which is what makes the partial state
    // recoverable rather than merely reported.
    expect(out.checkpointId).not.toBeNull();
  });

  it("reports zero stages applied when the first stage is the one refused", async () => {
    const { api } = recorder({
      ...okHandlers,
      "schedule/apply": () => {
        throw new ApiV1Error("blocked", 409, "SCHEDULE_CONFLICT");
      },
    });
    const out = await applyAiPlans(baseInput(), api);
    expect(out.stagesApplied).toBe(0);
  });

  it("officials failure leaves the schedule applied and carries its code + status", async () => {
    const { api } = recorder({
      ...okHandlers,
      "officials/apply": () => {
        throw new ApiV1Error("boom", 422, "INVALID");
      },
    });
    const out = await applyAiPlans(baseInput(), api);
    expect(out).toMatchObject({
      schedule: "applied",
      officials: "error",
      errorCode: "INVALID",
      errorStatus: 422,
    });
  });

  // V303 replaced a reuse-by-label hack. That hack existed because the anchor
  // was billed against schedule.checkpoints.max, and it had two failures:
  // restore rewound to the FIRST AI apply however many had happened since, and a
  // community org already holding one ordinary save point could not apply an AI
  // schedule at all. The anchor is now kind:"ai" and quota-exempt, so each apply
  // gets its own and Restore targets the latest run.
  it("creates its own anchor per apply — no list, no reuse", async () => {
    const { api, calls } = recorder(okHandlers);
    await applyAiPlans(baseInput(), api);
    const cp = calls.filter((c) => c.url.includes("/checkpoints"));
    expect(cp.map((c) => c.method)).toEqual(["POST"]);
    expect(cp[0]!.json).toMatchObject({ kind: "ai" });
    expect((cp[0]!.json as { label: string }).label).toMatch(/^Before AI · /);
  });

  it("two applies produce two distinct anchors, so Restore targets the later run", async () => {
    const first = recorder({
      ...okHandlers,
      checkpoints: ({ method }: { method?: string }) => (method === "POST" ? { id: "cp-1" } : []),
    });
    const a = await applyAiPlans(baseInput(), first.api);

    const second = recorder({
      ...okHandlers,
      checkpoints: ({ method }: { method?: string }) => (method === "POST" ? { id: "cp-2" } : []),
    });
    const b = await applyAiPlans(baseInput(), second.api);

    // Distinct anchors: the second apply's Undo rewinds to just before IT, not
    // back past the first — the whole point of dropping the reuse hack.
    expect(a.checkpointId).toBe("cp-1");
    expect(b.checkpointId).toBe("cp-2");
  });

  it("checkpoint save-point-quota 402 stops the chain and carries the feature key", async () => {
    const { api, calls } = recorder({
      checkpoints: ({ method }) => {
        if (method === "POST") {
          throw new ApiV1Error("quota", 402, "PAYMENT_REQUIRED", { feature_key: "schedule.checkpoints.max" });
        }
        return [];
      },
    });
    const out = await applyAiPlans(baseInput(), api);
    // The feature key rides in errorCode so the console maps it to the save-point
    // line (board.ai.apply.checkpointQuota), not the flat "upgrade to use AI".
    expect(out).toEqual({
      schedule: "error",
      officials: "skipped",
      checkpointId: null,
      // The chain stopped at the anchor, so no stage was even attempted — the
      // console can say "nothing changed" here and be right.
      stagesApplied: 0,
      errorCode: "schedule.checkpoints.max",
      errorStatus: 402,
    });
    // Just the failing create — nothing applied.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/divisions/div-1/checkpoints",
    ]);
  });

  it("skips the officials call when every proposed official is excluded (no destructive empty replace)", async () => {
    const { api, calls } = recorder(okHandlers);
    const out = await applyAiPlans(baseInput({ excludedFixtureIds: ["fa", "fb"] }), api);
    expect(out.officials).toBe("skipped");
    expect(calls.some((c) => c.url.includes("/officials/apply"))).toBe(false);
  });

  it("omits the suggestion PUT when nothing is ticked", async () => {
    const { api, calls } = recorder(okHandlers);
    await applyAiPlans(baseInput({ suggestions: null }), api);
    expect(calls.some((c) => c.url.includes("schedule-settings"))).toBe(false);
  });

  // ------------------------------------------------------- default wiring (apiV1)
  it("drives apiV1 over a mocked global fetch (envelope unwrap + method/body)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("checkpoints")) {
        // GET list → no prior save point; POST create → the new id.
        const data = init?.method === "POST" ? { id: "cp-9" } : [];
        return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, data: { applied: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await applyAiPlans(baseInput({ officials: null }));
    expect(out).toMatchObject({ schedule: "applied", checkpointId: "cp-9" });
    const cpPost = fetchMock.mock.calls.find(
      ([u, init]) => String(u).includes("checkpoints") && init?.method === "POST",
    );
    expect(cpPost).toBeTruthy();
    const body = JSON.parse(String(cpPost![1]?.body)) as { label: string; kind: string };
    expect(body.kind).toBe("ai");
    expect(body.label).toMatch(/^Before AI · /);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("constraint-suggestion helpers", () => {
  const cs: ConstraintSuggestions = { restMin: 30, noBackToBack: true, fieldFairness: "rotate" };

  it("lists only the present suggestion fields, in stable order", () => {
    expect(suggestionKeysOf(cs)).toEqual(["restMin", "noBackToBack", "fieldFairness"]);
    expect(suggestionKeysOf(null)).toEqual([]);
    expect(suggestionKeysOf({})).toEqual([]);
  });

  it("merges only the ticked fields over the current constraints", () => {
    const base = { courts: ["Court 1"], constraints: { restMin: 5, noBackToBack: false } } as ScheduleConfig;
    const merged = mergeConstraintSuggestions(base, cs, ["restMin", "fieldFairness"]);
    expect(merged.constraints).toMatchObject({ restMin: 30, noBackToBack: false, fieldFairness: "rotate" });
    // untouched top-level config survives the merge
    expect(merged.courts).toEqual(["Court 1"]);
  });

  it("seeds constraint defaults when the division has none yet", () => {
    const base = { courts: ["Court 1"] } as ScheduleConfig;
    const merged = mergeConstraintSuggestions(base, cs, ["restMin"]);
    expect(merged.constraints).toMatchObject({
      restMin: 30,
      noBackToBack: false,
      fieldFairness: "off",
      parallelism: "mixed",
      crossPersonClash: "warn",
    });
  });

  it("is a no-op when nothing is ticked", () => {
    const base = { courts: ["Court 1"] } as ScheduleConfig;
    expect(mergeConstraintSuggestions(base, cs, [])).toBe(base);
  });
});
