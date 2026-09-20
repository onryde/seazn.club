// Regression for seed-demo's intermittent
//   POST /api/v1/stages/<league>/complete -> 409 STAGE_COMPLETED_SEEDING_FAILED
//   "this stage has no generated TBD fixtures yet — generate its fixtures first"
//
// The seeder completed stage one and only THEN generated stage two (from
// inside `playStage`). Completion is what resolves progression into stage
// two's destination slots, so with no slots minted yet the resolve refused —
// but only on the runs where a division's random play ratio happened to decide
// every fixture, which is the branch the complete sits in. Reproduced against
// the live server before this was written: same code, same message.
//
// The fake `call` below reproduces the server's actual contract — complete
// REFUSES while the next stage has no fixtures — because a fake that always
// said yes would pass just as happily on the broken order. The first test
// drives that refusal directly, so the fake is shown to have teeth before it
// is used to bless anything.
import { describe, expect, it } from "vitest";
import { completeStageIntoNext } from "../seed-progression.ts";
import type { ApiCall } from "../seed-resume.ts";

const LEAGUE = "stage-league";
const KNOCKOUT = "stage-knockout";

/** The two stage routes seed-demo uses, with the seeding precondition the real
 *  server enforces. `nextOf` mirrors the division graph: completing the league
 *  must seed the knockout. */
function fakeApi(): { call: ApiCall; calls: string[] } {
  const generated = new Set<string>();
  const nextOf = new Map([[LEAGUE, KNOCKOUT]]);
  const calls: string[] = [];
  const call: ApiCall = async (path, method = "GET") => {
    calls.push(`${method} ${path}`);
    const gen = /^\/api\/v1\/stages\/([^/]+)\/generate$/.exec(path);
    if (gen) {
      // Idempotent, like the real setup-timing path: `created` drops to 0 on a
      // repeat, so the second generate playStage still issues is a no-op.
      const created = generated.has(gen[1]!) ? 0 : 1;
      generated.add(gen[1]!);
      return { created, fixtures: [{ id: "fx-1" }] };
    }
    const done = /^\/api\/v1\/stages\/([^/]+)\/complete$/.exec(path);
    if (done) {
      const next = nextOf.get(done[1]!);
      if (next && !generated.has(next)) {
        throw new Error(
          `POST ${path} → 409 {"code":"STAGE_COMPLETED_SEEDING_FAILED","message":` +
            `"this stage has no generated TBD fixtures yet — generate its fixtures first"}`,
        );
      }
      return { status: "complete" };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, calls };
}

describe("completing a stage into the next one", () => {
  it("the fake refuses a complete whose next stage was never generated", async () => {
    // The positive pair for every assertion below: without this, a fake that
    // accepted anything would make the ordering tests vacuous.
    const { call } = fakeApi();
    await expect(call(`/api/v1/stages/${LEAGUE}/complete`, "POST")).rejects.toThrow(
      /STAGE_COMPLETED_SEEDING_FAILED/,
    );
  });

  it("generates the next stage's TBD fixtures BEFORE completing this one", async () => {
    const { call, calls } = fakeApi();
    await completeStageIntoNext(call, LEAGUE, KNOCKOUT);
    // The order, stated: reversing these two lines is exactly the defect, and
    // the fake's refusal above is what makes this a red rather than a shuffle.
    expect(calls).toEqual([
      `POST /api/v1/stages/${KNOCKOUT}/generate`,
      `POST /api/v1/stages/${LEAGUE}/complete`,
    ]);
  });

  it("leaves playStage's own generate a no-op rather than a second mint", async () => {
    // seed-demo still calls playStage(next) straight after, and playStage
    // opens with its own generate. That call must not create a second set of
    // fixtures — verified against the live server as `created: 0`.
    const { call } = fakeApi();
    await completeStageIntoNext(call, LEAGUE, KNOCKOUT);
    const again = (await call(`/api/v1/stages/${KNOCKOUT}/generate`, "POST")) as {
      created: number;
    };
    expect(again.created).toBe(0);
  });
});
