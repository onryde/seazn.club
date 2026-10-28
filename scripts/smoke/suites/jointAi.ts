import {
  startAiFixtureServer,
  FIXTURE_COMPILE_BRIEF,
  type AiFixtureServer,
} from "../../../apps/web/e2e/ai-fixture-server.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  type Session, newSession, check, signIn, tag, walletBalance, drainWallet, topUpWallet, latestCompetitionEvent,
  type AiPreviewLite, divisionSeqs, scheduledCountsByDivision, v1, v1data, setPlan,
} from "../harness.ts";

/** One competition with TWO plannable divisions sharing the SAME court names.
 *  Shared courts are the whole point of a joint run — cross-division court
 *  identity is a string match and nothing else — so both divisions carry the
 *  same two labels rather than two disjoint sets. */
async function seedJointAiCompetition(
  s: Session,
  label: string,
): Promise<{ compId: string; divIds: string[]; courtIds: [string, string] }> {
  const jointAiOrgId = s.cookies["seazn_org"];
  const jointAiVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${jointAiOrgId}/venues`, "POST", { name: `${label} Venue ${tag}` }),
  );
  const jointAiCourt1 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${jointAiOrgId}/venues/${jointAiVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const jointAiCourt2 = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${jointAiOrgId}/venues/${jointAiVenue.id}/courts`, "POST", {
      name: "Court 2",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const divIds: string[] = [];
  for (const name of ["Joint A", "Joint B"]) {
    const div = v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
    await v1(
      s,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      ["P", "Q", "R", "S"].map((n, i) => ({
        kind: "individual",
        display_name: `${name} ${n}${tag}`,
        seed: i + 1,
      })),
    );
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      config: {
        startAt: "2026-11-02T09:00:00.000Z",
        matchMinutes: 30,
        gapMinutes: 0,
        courts: [jointAiCourt1.id, jointAiCourt2.id],
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
      tz: "UTC",
    });
    await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST");
    divIds.push(div.id);
  }
  return { compId: comp.id, divIds, courtIds: [jointAiCourt1.id, jointAiCourt2.id] };
}

interface JointPlanLite {
  proposal: { fixture_id: string; scheduled_at: string; court_label: string; division_id: string }[];
  summary: string;
  credits: number;
  discount: number;
  budget: number;
  divergent_courts: string[];
  divisions: { id: string; name: string; movable: number; rung: number; predicted_rung: number }[];
}

/**
 * #350 — multi-division JOINT AI scheduling over HTTP, on the two numbers a
 * customer can be overcharged by.
 *
 * Both are asserted against LITERALS rather than against anything the response
 * also supplies. A check that reads `credits` back out of the payload it is
 * validating proves the field exists, not that the batch discount was applied,
 * and the discount is exactly the arithmetic a support ticket is about. So the
 * rungs are FORCED with `rung_overrides` (2 and 3 — the predictor ships
 * uncalibrated, and a smoke seed's own prediction would drift the day it is
 * retuned), and the expectations are hand-computed:
 *
 *   rungTotal 5  →  charged max(1, 5−1) = 4 credits, discount 1
 *   budget       →  tokenBudgetForCredits(5) = 128K + 32K×2 = 192K, sized from the
 *                   UNDISCOUNTED total, so the batch discount is a price cut and
 *                   never a capability cut (#350 amendment)
 *
 * The insufficient-balance leg is KEYLESS-SAFE and runs with or without a
 * model, because the refusal has to happen before the model is ever called. It
 * asserts the fixture server's call log did not grow, which is the only way to
 * tell "refused before spending" from "spent, then refused".
 *
 * Rate limit: the joint endpoint allows 3 runs an hour per COMPETITION, and
 * this suite now makes exactly THREE rate-limited requests (the 402, the W5
 * preview and the real run) — the single-division 400 is refused before the
 * limiter. That is the ceiling, not room under it: a fourth would 429, so a new
 * joint call here needs one of these three to go, or a second competition.
 */
export async function jointAiSuite(): Promise<void> {
  const aiConfigured = !!process.env.SCHEDULING_AI_BASE_URL;
  let fixture: AiFixtureServer | null = null;
  if (aiConfigured) {
    try {
      fixture = await startAiFixtureServer();
    } catch (e) {
      console.log(
        `#350 joint AI: fixture server failed to start (${(e as Error).message}); the priced run is skipped`,
      );
    }
  } else {
    console.log(
      "#350 joint AI: SCHEDULING_AI_BASE_URL unset — the priced run is skipped (the 400 and the 402 still run)",
    );
  }

  try {
    const s = newSession();
    const orgId = (await signIn(s, `delivered+smoke-ai-joint-${tag}@resend.dev`)).org_id;
    // scheduling.multi_division is Pro and above, and Pro matches the sibling AI
    // suite. (It used to flip to `pro_plus`, a plan V393 deleted from `plans`;
    // the credit balance this suite reasons about is set by `drainWallet`
    // below, not by the plan's monthly allowance, so nothing here depended on
    // the larger grant.)
    await setPlan(orgId, "pro", s);
    const { compId, divIds } = await seedJointAiCompetition(s, "Joint AI");
    const instruction = "keep both divisions off each other's courts and finish by 6pm";
    const rung_overrides = { [divIds[0]]: 2, [divIds[1]]: 3 };

    // ---- One division is not a joint run: refused before the limiter ----
    const single = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: [divIds[0]],
      instruction,
    });
    check(
      "#350 joint/gate: a one-division joint request is refused 400 AI_PLAN_SINGLE_DIVISION (no discount arbitrage)",
      single.status === 400 &&
        (single.json.error)?.code === "AI_PLAN_SINGLE_DIVISION",
    );

    // ---- Insufficient balance: refused BEFORE the model, not after ----
    await drainWallet(orgId, 3); // the run below costs 4
    const callsBeforeRefusal = fixture?.calls.length ?? 0;
    const poor = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: divIds,
      instruction,
      rung_overrides,
    });
    check(
      "#350 joint/credits: a wallet holding 3 credits cannot start a 4-credit joint run (402 ai.credits)",
      poor.status === 402 &&
        (poor.json.error as { feature_key?: string } | undefined)?.feature_key === "ai.credits",
    );
    // GUARDED, not `(fixture?.calls.length ?? 0) === callsBeforeRefusal`: that
    // form reads 0 on both sides with no fixture server and reports PASS for a
    // property it never tested. A check that passes when it cannot run is worse
    // than no check — it occupies the slot a real one would fill.
    if (fixture) {
      check(
        "#350 joint/credits: the refusal happened before any model call",
        fixture.calls.length === callsBeforeRefusal,
      );
    }

    if (!fixture) return;

    // ---- The priced run ----
    await topUpWallet(orgId, 20);
    const balanceBefore = await walletBalance(orgId);

    // W5 (#400): the same gate over a JOINT scope. It is priced from the same
    // `rung_overrides` the run will use — a preview that priced itself at the
    // prediction would refuse (or admit) a run nobody was about to make — and
    // it moves no money.
    const jointPreview = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-preview`, "POST", {
      division_ids: divIds,
      instruction: FIXTURE_COMPILE_BRIEF,
      rung_overrides,
    });
    const jpv = v1data<AiPreviewLite>(jointPreview);
    check(
      "W5 preview/joint: a joint instruction compiles over both divisions without spending (#400)",
      jointPreview.status === 200 &&
        jpv.failed === false &&
        typeof jpv.preview_id === "string" &&
        jpv.compiled.hard.length > 0 &&
        (await walletBalance(orgId)) === balanceBefore,
    );

    const runRes = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-plan`, "POST", {
      division_ids: divIds,
      instruction,
      rung_overrides,
    });
    const plan = v1data<JointPlanLite>(runRes);
    check(
      "#350 joint/run: a joint plan returns placements for BOTH divisions in one run",
      runRes.status === 200 &&
        Array.isArray(plan.proposal) &&
        new Set(plan.proposal.map((p) => p.division_id)).size === 2,
    );
    check(
      "#350 joint/price: rungs 2+3 are charged max(1, 5−1) = 4 credits with a 1-credit batch discount",
      plan.credits === 4 && plan.discount === 1,
    );
    check(
      "#350 joint/price: the budget is sized from the UNDISCOUNTED total (5 credits → 192K), not the 4 charged (which buys 160K)",
      plan.budget === 192_000,
    );
    check(
      "#350 joint/price: the breakdown names each division with the rung it was priced at",
      plan.divisions.length === 2 &&
        plan.divisions.every((d) => divIds.includes(d.id) && d.movable > 0 && !!d.name) &&
        plan.divisions
          .map((d) => d.rung)
          .sort()
          .join(",") === "2,3",
    );
    check(
      "#350 joint/price: the wallet actually moved by the 4 credits quoted",
      (await walletBalance(orgId)) === balanceBefore - 4,
    );
    check(
      "#350 joint/courts: two divisions on the same court names report no divergence",
      plan.divergent_courts.length === 0,
    );

    const jointEvent = await latestCompetitionEvent(compId, "schedule.ai_generated_multi");
    check(
      "#350 joint/ledger: the joint run books its own event type with model + usage + cost_usd",
      !!jointEvent &&
        typeof jointEvent.model === "string" &&
        !!jointEvent.usage &&
        typeof jointEvent.cost_usd === "number",
    );

    // ---- Atomic apply across both divisions ----
    const seqs = await divisionSeqs(divIds);
    const byDivision = divIds.map((id) => ({
      division_id: id,
      expected_seq: seqs[id] ?? 0,
      // ApplyCompetitionScheduleRequest wants court_id — same field-name
      // rename at the wire boundary as the single-division apply above.
      assignments: plan.proposal
        .filter((p) => p.division_id === id)
        .map((p) => ({
          fixture_id: p.fixture_id,
          scheduled_at: p.scheduled_at,
          court_id: p.court_label,
        })),
    }));
    const applied = await v1(s, `/api/v1/competitions/${compId}/schedule/apply`, "POST", {
      divisions: byDivision,
      source: "ai",
      ai: {
        instruction,
        summary: plan.summary,
        model: "claude-sonnet-5",
        repair_rounds: 0,
      },
    });
    check(
      "#350 joint/apply: one request writes every division's board",
      applied.status === 200 &&
        v1data<{ applied: number }>(applied).applied ===
          byDivision.reduce((n, d) => n + d.assignments.length, 0),
    );
    // EXACT counts, not `> 0`. A partial board is precisely what the atomic
    // apply exists to prevent, and `> 0` cannot see one — it only catches a
    // division that got nothing at all. The expected number per division is
    // already in hand as that division's own assignment list.
    const scheduled = await scheduledCountsByDivision(divIds);
    check(
      "#350 joint/apply: every division came out with its WHOLE board, not a partial one",
      byDivision.every((d) => (scheduled[d.division_id] ?? 0) === d.assignments.length) &&
        byDivision.every((d) => d.assignments.length > 0),
    );

    const last = await v1(s, `/api/v1/competitions/${compId}/schedule/ai-last`);
    check(
      "#350 joint/ai-last: the competition recalls the applied joint instruction",
      last.status === 200 &&
        v1data<{ last?: { instruction?: string } | null }>(last)?.last?.instruction === instruction,
    );
  } finally {
    await fixture?.close();
  }
}
