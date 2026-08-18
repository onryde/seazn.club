// F2 (unified progression field): this endpoint's Body schema forwarded
// `qualification: z.unknown().nullable().default(null)` straight into
// previewDivisionFixtures, unvalidated (opaque data — the endpoint never
// interprets the shape itself). Renamed to `progression`, matching every
// other writer this session converts. Not `.strict()` (unlike CreateStage),
// so this is a genuinely silent-drop site if the key name is wrong — the
// only way to catch that is to prove what actually reaches
// previewDivisionFixtures, which is what this test does via a spy.
//
// requireAuth and previewDivisionFixtures are mocked: requireAuth because a
// real session needs a live DB (out of scope here — this route only calls
// requireAuth(req, "read"), no persistence), and previewDivisionFixtures
// because stages.ts's qualifierCount() currently throws on ANY non-first
// stage (calls an engine export Task 1/2 already removed, pending Task 6 —
// see topic_apps_web_api_v1_index memory) — irrelevant to what THIS test
// verifies, which is the wire shape reaching the call, not the engine draw.
import { describe, expect, it, vi } from "vitest";
import type { PreviewPhase, PreviewStageInput } from "@/server/usecases/stages";

// Explicit signature (not vi.fn(() => [...])'s inferred zero-arg one) —
// otherwise .mock.calls[0] types as the empty tuple `[]` and every
// destructure/cast of it below fails to typecheck.
const previewMock = vi.hoisted(() =>
  vi.fn<(stages: PreviewStageInput[], count: number) => PreviewPhase[]>(() => [
    { title: "t", sections: [] },
  ]),
);
vi.mock("@/server/usecases/stages", () => ({ previewDivisionFixtures: previewMock }));
vi.mock("@/server/api-v1/auth", () => ({
  requireAuth: vi.fn(async () => ({ orgId: "org1", userId: "user1", role: "member" })),
}));

import { POST } from "../route";

function req(body: unknown) {
  return new Request("http://localhost/api/v1/format-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/format-preview — Body forwards progression, not qualification", () => {
  it("a stage's progression field reaches previewDivisionFixtures intact", async () => {
    previewMock.mockClear();
    const progression = {
      sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
      placement: "rank_order",
      timing: "on_complete",
    };
    const res = await POST(
      req({
        count: 8,
        stages: [
          { kind: "league", name: "League", config: {}, progression: null },
          { kind: "knockout", name: "Finals", config: {}, progression },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(previewMock).toHaveBeenCalledTimes(1);
    const [stagesArg] = previewMock.mock.calls[0]!;
    expect((stagesArg as { progression: unknown }[])[1]!.progression).toEqual(progression);
  });

  it("an old client POSTing the dropped qualification key gets it silently ignored (not .strict(), unlike CreateStage) — progression reaches previewDivisionFixtures as null", async () => {
    previewMock.mockClear();
    const res = await POST(
      req({
        count: 8,
        stages: [{ kind: "league", name: "League", config: {}, qualification: { topN: 4 } }],
      }),
    );
    expect(res.status).toBe(200);
    const [stagesArg] = previewMock.mock.calls[0]!;
    const stage0 = stagesArg[0]!;
    expect(stage0.progression ?? null).toBeNull();
    expect(stage0).not.toHaveProperty("qualification");
  });
});
