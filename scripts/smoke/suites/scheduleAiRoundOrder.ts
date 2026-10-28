import {
  startAiFixtureServer,
  FIXTURE_ROUND_ORDER,
  type AiFixtureServer,
} from "../../../apps/web/e2e/ai-fixture-server.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  newSession, check, signIn, tag, seedPlannableAiDivision, type AiPlanResponseLite, v1, v1data, setPlan,
} from "../harness.ts";

/**
 * C1 gap B — the AI planning path's round-order blind spot, over REAL HTTP.
 *
 * apps/web's schedule-ai-round-order.test.ts already proves
 * `toEngineAssignments` detects a round-order violation in isolation; what
 * only smoke can prove is the WIRING — that a real `POST .../schedule/
 * ai-plan`, through a real model round trip (the AI fixture server,
 * deterministic and free), a real `buildSchedulePack` and a real verify
 * pass, actually reports one.
 *
 * `FIXTURE_ROUND_ORDER` swaps the canned plan's first and last draft cards
 * — a genuine round-order violation on the SAME 4-entrant/6-fixture
 * round-robin division `v4AiSuite`'s own happy path uses
 * (`seedPlannableAiDivision`), built from a straight swap so no court
 * conflict rides along to confound the assertion. See the sentinel's own
 * doc comment (ai-fixture-server.ts) for why this suite asserts DETECTION
 * rather than a specific repair outcome: whether a repair round resolves
 * the violation is a `repair.ts`/z3 question this branch's C1 work does
 * not touch — `plan.repair?.solver_ran` and `plan.usage.repair_rounds`
 * only tell us the solver/model were ENGAGED because of it, never whether
 * either succeeded.
 *
 * Self-contained (its own fixture server, like `v4AiSuite`) rather than
 * folded into it, so a failure here reads as exactly what it is instead of
 * one more check inside an already-large suite.
 */
export async function scheduleAiRoundOrderSuite(): Promise<void> {
  if (!process.env.SCHEDULING_AI_BASE_URL) {
    console.log(
      "v4 AI/round-order: SCHEDULING_AI_BASE_URL unset — round-order detection check skipped",
    );
    return;
  }
  let fixture: AiFixtureServer | null = null;
  try {
    fixture = await startAiFixtureServer();
  } catch (e) {
    console.log(
      `v4 AI/round-order: fixture server failed to start (${(e as Error).message}); skipped`,
    );
    return;
  }
  try {
    // Plan-agnostic: this suite is about round-order DETECTION, not a tier. It
    // sits on `pro` because that is the paid plan v4AiSuite uses and `pro_plus`
    // no longer exists in `plans` (V393, entitlements v18).
    const paid = newSession();
    const paidOrg = (await signIn(paid, `delivered+smoke-ai-roundorder-${tag}@resend.dev`)).org_id;
    await setPlan(paidOrg, "pro", paid);
    const { divId } = await seedPlannableAiDivision(paid, "AI Round Order");

    const planRes = await v1(paid, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", {
      instruction: `${FIXTURE_ROUND_ORDER} — spread the fixtures across both courts.`,
      mode: "generate",
    });
    const plan = v1data<AiPlanResponseLite>(planRes);
    check(
      "v4 AI/round-order: schedule ai-plan returns 200 even when the canned draft violates round order",
      planRes.status === 200,
    );
    check(
      "v4 AI/round-order: the fixture server actually received the schedule call (proof this reached the real model round trip)",
      fixture.calls.some((c) => c.phase === "schedule"),
    );
    // DETECTION. Before this branch's fix (953fbdaf), toEngineAssignments
    // carried no roundNo/stageId at all, so an "order" conflict could never
    // appear in either list and no repair round would ever be engaged by
    // one — the canned violation would have gone straight through as a
    // false CLEAN, zero blocking, zero warnings, no solver call.
    const reportedOrder =
      plan.blocking.some((c) => c.reason === "order") ||
      plan.warnings.some((c) => c.reason === "order");
    const repairEngaged = plan.repair?.solver_ran === true || plan.usage.repair_rounds > 0;
    check(
      "v4 AI/round-order: a round-order violation in the canned plan is detected — reported directly, or a repair round was visibly engaged because of it",
      reportedOrder || repairEngaged,
    );
  } finally {
    await fixture?.close();
  }
}
