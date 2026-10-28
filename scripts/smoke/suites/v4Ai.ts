import {
  startAiFixtureServer,
  FIXTURE_COMPILE_BRIEF,
  type AiFixtureServer,
} from "../../../apps/web/e2e/ai-fixture-server.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  type Session, newSession, check, signIn, tag, walletBalance, drainWallet, topUpWallet, latestCompetitionEvent,
  seedPlannableAiDivision, type AiPlanResponseLite, type AiPreviewLite, v1, v1data, setPlan,
} from "../harness.ts";

/** A four-entrant knockout WITH a third-place playoff, one person per entrant —
 *  the board that exercises the #396 participants recursion over HTTP.
 *
 *  Round 2 is two fixtures with no entrants at all: the final (fed by both semi
 *  winners) and the third-place playoff (fed by both semi losers). Every one of
 *  the four players can still reach EITHER of them, so the two are unsafe to
 *  play at the same moment — and nothing on the fixture rows says so, because
 *  both slots are null. Only walking the feeder graph behind those nulls finds
 *  the people, which is exactly what this seed exists to prove is happening.
 *
 *  `members: [{ person_id }]` is load-bearing. An individual entrant created
 *  from a bare `display_name` writes NO `entrant_members` row (entrants.ts), so
 *  it has no person, and every person rule passes on it vacuously — the seed
 *  would look right and assert nothing.
 *
 *  Its own competition, deliberately: a sibling division's applied board is fed
 *  to the planner as fixed court occupancy, which would make this a
 *  court-conflict test instead of a person one. */
async function seedBracketAiDivision(
  s: Session,
  label: string,
): Promise<{
  divId: string;
  personIds: string[];
  fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  /** [courtA, courtB] real ids, matching the "A"/"B" names courts used to be
   *  configured/assigned by literally. */
  courtIds: [string, string];
}> {
  const bracketOrgId = s.cookies["seazn_org"];
  const bracketVenue = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${bracketOrgId}/venues`, "POST", { name: `${label} Venue ${tag}` }),
  );
  const bracketCourtA = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${bracketOrgId}/venues/${bracketVenue.id}/courts`, "POST", {
      name: "A",
    }),
  );
  const bracketCourtB = v1data<{ id: string }>(
    await v1(s, `/api/v1/orgs/${bracketOrgId}/venues/${bracketVenue.id}/courts`, "POST", {
      name: "B",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const personIds: string[] = [];
  const entrants: unknown[] = [];
  for (const [i, n] of ["A", "B", "C", "D"].entries()) {
    const person = v1data<{ id: string }>(
      await v1(s, "/api/v1/persons", "POST", {
        full_name: `${label} Player ${n} ${tag}`,
        consent: {},
      }),
    );
    personIds.push(person.id);
    entrants.push({
      kind: "individual",
      display_name: `${label} ${n}${tag}`,
      seed: i + 1,
      members: [{ person_id: person.id }],
    });
  }
  await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", entrants);
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Cup",
      config: { thirdPlace: true },
    }),
  );
  await v1(s, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
    config: {
      startAt: "2026-10-08T09:00:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [bracketCourtA.id, bracketCourtB.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  const gen = v1data<{
    fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"));
  return {
    divId: div.id,
    personIds,
    fixtures: gen.fixtures,
    courtIds: [bracketCourtA.id, bracketCourtB.id],
  };
}

/** #397 (calendar anchor): a time that never left 1970 — what the pack handed
 *  the model for a division with no configured start date, when the greedy
 *  draft was anchored at `toSlotConfig(settings, 0)`. The cut is the engine's
 *  own `isEpochSentinel` (anything before 1971-01-01), read off the INSTANT
 *  rather than the rendered year: west of UTC the epoch renders as 1969-12-31,
 *  so a year prefix would miss exactly the boards this check exists for. The
 *  pack now nulls these rather than showing them. */
const EPOCH_SENTINEL_BEFORE_MS = Date.UTC(1971, 0, 1);
const epochAnchored = (iso: string): boolean => Date.parse(iso) < EPOCH_SENTINEL_BEFORE_MS;

/** #397: the pack writes every time as `zonedIso(…, orgTz)` — an explicit UTC
 *  offset, in the ORGANISATION timezone. A pack with no timezone could not
 *  produce one, so the offset is the proof (over HTTP) that `pack.tz` is real.
 *  Note `Z` is deliberately NOT accepted: `zonedIso` always writes ±HH:MM. */
const zonedTime = (iso: string): boolean => /[+-]\d{2}:\d{2}$/.test(iso);

/** Today−1 as YYYY-MM-DD in UTC. One day of slack covers every organisation
 *  zone (±14h), so a draft dated on or after it cannot be epoch-anchored — or
 *  anchored at any other stale instant. */
const yesterdayUtcYmd = (): string =>
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** design/v4 (Task 18): the AI Schedule Architect end-to-end over HTTP.
 *
 *  A fresh Pro org walks the two-phase happy path — schedule ai-plan
 *  (proposal shape + a schedule.ai_generated ledger row stamping model/usage/
 *  cost_usd) → apply with the `ai` provenance block → ai-last recall → officials
 *  ai-plan with an EMPTY instruction (zero-token solver draft →
 *  schedule.ai_officials_generated stamped model "solver-draft"). A fresh
 *  community org proves the AI credit WALLET gate (v17 Phase 2, V320+): drain
 *  its wallet to 0 → the next run 402s at `ai.credits`, before any model
 *  spend, and topping the wallet back up (the wallet-model analog of the old
 *  admin entitlement override) admits the next run (→ 200).
 *
 *  The model is never real: the Task 17 fixture server echoes the pack's own
 *  deterministic draft, so a run is CLEAN by construction. Model-dependent steps
 *  run only when SCHEDULING_AI_BASE_URL is set — the server under test must be
 *  booted pointing at our fixture server (recipe in the Task 18 report). The cap
 *  402 is keyless-safe and always runs. The happy path uses its OWN fresh paid
 *  org rather than the passed pro org, so its wallet and entitlement cache are
 *  never shared with a sibling suite. (It used to say officials.auto is Pro Plus
 *  per V290 — V393 brought that grant back down to Pro and deleted the plan.) */
export async function v4AiSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  void admin;
  void proOrgId;
  void proOrgSlug;
  const aiConfigured = !!process.env.SCHEDULING_AI_BASE_URL;
  let fixture: AiFixtureServer | null = null;
  if (aiConfigured) {
    try {
      fixture = await startAiFixtureServer();
    } catch (e) {
      console.log(
        `v4 AI: fixture server failed to start (${(e as Error).message}); model paths skipped`,
      );
    }
  } else {
    console.log(
      "v4 AI: SCHEDULING_AI_BASE_URL unset — model-dependent AI checks skipped (the cap 402 still runs)",
    );
  }

  try {
    // ---- Free path: the AI credit wallet gate (keyless — 402 fires before any model) ----
    const free = newSession();
    const freeOrg = (await signIn(free, `delivered+smoke-ai-free-${tag}@resend.dev`)).org_id;
    const freeDivIds = await seedPlannableAiDivision(free, "AI Free");
    await drainWallet(freeOrg, 0);
    const capped = await v1(
      free,
      `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-plan`,
      "POST",
      {
        instruction: "spread the fixtures across both courts",
      },
    );
    check(
      "v4 AI/free: an AI run 402s once the wallet is exhausted (ai.credits)",
      capped.status === 402 &&
        (capped.json.error as { feature_key?: string } | undefined)?.feature_key === "ai.credits",
    );

    // W5 (#400): the preview spends no CREDIT, but it does spend our parse
    // tokens, so it carries the run's own affordability gate ahead of the
    // model. Keyless-safe for the same reason the run's 402 is: an org that
    // provably cannot pay is turned away before anything is called.
    const cappedPreview = await v1(
      free,
      `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-preview`,
      "POST",
      { instruction: "spread the fixtures across both courts" },
    );
    check(
      "W5 preview/free: an exhausted wallet 402s the preview before any model call (#400)",
      cappedPreview.status === 402 &&
        (cappedPreview.json.error as { feature_key?: string } | undefined)?.feature_key ===
          "ai.credits",
    );

    // ---- Topping the wallet back up admits the next run (needs model) ----
    await topUpWallet(freeOrg, 1);
    if (fixture) {
      const lifted = await v1(
        free,
        `/api/v1/divisions/${freeDivIds.divId}/schedule/ai-plan`,
        "POST",
        {
          instruction: "spread the fixtures across both courts",
        },
      );
      check(
        "v4 AI/topup: crediting the wallet admits the next run (200 + proposal)",
        lifted.status === 200 && Array.isArray(v1data<AiPlanResponseLite>(lifted).proposal),
      );
    }

    // ---- Paid two-phase happy path (schedule + officials) — needs the model ----
    if (fixture) {
      const paid = newSession();
      const paidOrg = (await signIn(paid, `delivered+smoke-ai-pro-${tag}@resend.dev`)).org_id;
      await setPlan(paidOrg, "pro", paid);
      const { compId, divId, stageId } = await seedPlannableAiDivision(paid, "AI Paid");
      const firstRefId = v1data<{ id: string }>(
        await v1(paid, "/api/v1/officials", "POST", {
          display_name: `AI Ref ${tag}`,
          role_keys: ["referee"],
        }),
      ).id;

      // #398: carries a phrase the stage-1 compiler can turn into a typed rule
      // ("two matches per day"), so the pre-flight compile actually runs on this
      // path and its ledger line is not vacuously present.
      const instruction = "finish by 6pm, keep both courts busy, two matches per day";

      // ---- W5 (#400): the compiled-instruction preview, ahead of any run ----
      // The gate's whole claim is that an organiser can see the rules BEFORE a
      // credit moves, so the wallet is read either side of the call. The brief
      // is the one the fixture server compiles for real
      // (`FIXTURE_COMPILE_BRIEF`); against any other sentence the canned model
      // answers "nothing compiled", and `hard.length > 0` would be asserting
      // the fixture rather than the endpoint.
      const creditsBeforePreview = await walletBalance(paidOrg);
      const pv = await v1(paid, `/api/v1/divisions/${divId}/schedule/ai-preview`, "POST", {
        instruction: FIXTURE_COMPILE_BRIEF,
      });
      const preview = v1data<AiPreviewLite>(pv);
      check(
        "W5 preview: an instruction compiles to typed rules and a reusable id (#400)",
        pv.status === 200 &&
          preview.failed === false &&
          typeof preview.preview_id === "string" &&
          preview.compiled.hard.length > 0 &&
          preview.compiled.soft.length > 0 &&
          preview.compiled.unparsed.length > 0 &&
          // Resolved against the ORG clock, not left symbolic on the wire.
          preview.window !== null &&
          /^\d{4}-\d{2}-\d{2}$/.test(preview.window.start),
      );
      check(
        "W5 preview: compiling spends NO credit — the point of the gate (#400)",
        (await walletBalance(paidOrg)) === creditsBeforePreview,
      );
      // Unpriced, but never invisible: the compile has its own ledger line under
      // the same field names a run stamps (#387/#398).
      const previewEvent = await latestCompetitionEvent(compId, "schedule.ai_previewed");
      check(
        "W5 preview: the compile books its own unpriced ledger line (schedule.ai_previewed)",
        !!previewEvent &&
          typeof previewEvent.parse_tokens === "number" &&
          previewEvent.parse_tokens > 0 &&
          previewEvent.parse_failed === false,
      );
      // The reuse gate. A confirmation is a confirmation of THAT sentence: an
      // edited brief must be refused, not silently recompiled behind the
      // agreement the organiser already gave.
      const stale = await v1(paid, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", {
        instruction: "a completely different sentence",
        preview_id: preview.preview_id,
        mode: "generate",
      });
      check(
        "W5 preview: a changed instruction 409s rather than recompiling behind the confirm (#400)",
        stale.status === 409,
      );
      check(
        "W5 preview: the refused reuse charged nothing either",
        (await walletBalance(paidOrg)) === creditsBeforePreview,
      );

      const planRes = await v1(paid, `/api/v1/divisions/${divId}/schedule/ai-plan`, "POST", {
        instruction,
        mode: "generate",
        officials_policy: { roles: ["referee"] },
      });
      const plan = v1data<AiPlanResponseLite>(planRes);
      check(
        "v4 AI/paid: schedule ai-plan returns a verified proposal (proposal + diff + usage + coverage)",
        planRes.status === 200 &&
          Array.isArray(plan.proposal) &&
          plan.proposal.length > 0 &&
          !!plan.diff &&
          typeof plan.summary === "string" &&
          !!plan.usage &&
          plan.officials_coverage !== undefined,
      );
      check(
        "v4 AI/paid: the fixture model served the schedule phase",
        fixture.calls.some((c) => c.phase === "schedule"),
      );
      // ---- #397: the pack's calendar anchor, over the one surface that shows
      // it. `tz`, `clock`, `window` and `sessionHours` are pack-internal and
      // never reach the wire — but the fixture model echoes the pack's own
      // `draft` back verbatim (ai-fixture-server.ts), so on this path every
      // `proposal` row IS a draft row and its time is the pack builder's
      // `zonedIso(…, orgTz)` output. That makes the draft the projection of tz
      // and window that HTTP can actually assert on.
      check(
        "v4 AI/anchor: every drafted time is written with a real zone offset (pack.tz, #397)",
        plan.proposal.length > 0 && plan.proposal.every((a) => zonedTime(a.scheduled_at)),
      );
      check(
        "v4 AI/anchor: no drafted time is stuck at the epoch (#397)",
        plan.proposal.length > 0 && !plan.proposal.some((a) => epochAnchored(a.scheduled_at)),
      );

      const genEvent = await latestCompetitionEvent(compId, "schedule.ai_generated");
      check(
        "v4 AI/paid: schedule.ai_generated ledger row stamps model + usage + cost_usd",
        !!genEvent &&
          typeof genEvent.model === "string" &&
          !!genEvent.usage &&
          typeof genEvent.cost_usd === "number",
      );

      // #398/#387: the compile runs OUTSIDE spendCredit, so its spend is
      // invisible unless it has its own ledger line. Asserted as a real number
      // rather than truthiness — 0 is a legitimate value and must still stamp.
      // This run's instruction is non-empty and the wallet is funded, so a
      // compile DID run: `parse_tokens` must be a real, positive number. `>= 0`
      // would pass on the "never attempted" stamp this check exists to catch.
      check(
        "v4 AI/parse: schedule.ai_generated carries the pre-flight compile on its own line (#398)",
        !!genEvent &&
          typeof genEvent.parse_tokens === "number" &&
          genEvent.parse_tokens > 0 &&
          genEvent.parse_failed === false,
      );
      // The parse must NOT be folded into what the credit bought, or
      // reconciliation double-counts it. `usage.output_tokens` is asserted
      // PRESENT — defaulting it to spent_tokens makes the comparison `x === x`.
      check(
        "v4 AI/parse: parse spend is NOT added into spent_tokens (#398)",
        !!genEvent &&
          typeof genEvent.spent_tokens === "number" &&
          typeof genEvent.usage?.output_tokens === "number" &&
          genEvent.spent_tokens === genEvent.usage.output_tokens,
      );

      // W6 (#401): the constraint solver runs before any LLM repair round. The
      // report is present on EVERY plan, including the ones where it had nothing
      // to do — "the field exists" is what makes its absence a detectable
      // regression rather than a silent revert to LLM-only repair.
      check(
        "v6 AI/repair: the plan carries a solver report (#401)",
        !!plan.repair && typeof plan.repair.solver_ran === "boolean",
      );
      // It must cost nothing. The solver is not metered, so a run that repaired
      // a board still bills exactly what the model used — if solver work ever
      // leaked into the ledger, spent_tokens would diverge from the model's own
      // output_tokens, which the check above already pins.
      check(
        "v6 AI/repair: a solver repair spends no credits and no tokens (#401)",
        !!genEvent &&
          typeof genEvent.spent_tokens === "number" &&
          genEvent.spent_tokens === genEvent.usage?.output_tokens,
      );
      // Whatever it reports must be internally consistent: it cannot claim to
      // have moved fixtures without having run, and it cannot claim proved
      // minimality without a move count to be minimal about.
      check(
        "v6 AI/repair: the report never claims work it did not do (#401)",
        !!plan.repair &&
          ((plan.repair.moved ?? 0) === 0 || plan.repair.solver_ran === true) &&
          (plan.repair.minimality !== "proved" || typeof plan.repair.moved === "number"),
      );

      const applied = await v1(paid, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
        // ApplyScheduleRequest.assignments[] wants court_id — the AI plan's
        // own proposal keeps the court_label field NAME (it already carries a
        // real court id as its value, P9 pass 3b), so this is a rename at the
        // wire boundary, not a value change.
        assignments: plan.proposal.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_id: a.court_label,
        })),
        source: "ai",
        ai: {
          instruction,
          summary: plan.summary,
          model: "claude-sonnet-5",
          repair_rounds: plan.usage.repair_rounds,
        },
      });
      check(
        "v4 AI/paid: applying the AI proposal writes the schedule (source ai)",
        applied.status === 200 && v1data<{ applied: number }>(applied).applied > 0,
      );

      const last = await v1(paid, `/api/v1/divisions/${divId}/schedule/ai-last`);
      const lastData = v1data<{
        last?: { instruction?: string } | null;
        runs?: { used?: number; max?: number | null };
      }>(last);
      check(
        "v4 AI/paid: ai-last recalls the applied instruction",
        last.status === 200 && lastData?.last?.instruction === instruction,
      );
      check(
        // v17 Phase 2 Task 5 (V322) retired the per-division run cap `runs.max`
        // used to resolve (pro_plus 50); the AI credit wallet meters spend
        // instead, so `runs.max` is now always null (lastAiApply, schedule.ts) —
        // `runs.used` still counts the same schedule.ai_generated rows.
        "v4 AI/paid: ai-last reports 1 run used and no per-division max (wallet-metered now)",
        lastData?.runs?.used === 1 && lastData?.runs?.max === null,
      );

      const offRes = await v1(paid, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
        instruction: "",
        policy: { roles: ["referee"] },
        // #387: what a confirm card would have shown. The empty-instruction
        // path is priced at a flat 1 credit, so 3 is a deliberate divergence —
        // the server must REPORT it and RECORD it, and must still return the
        // plan (this is telemetry, not a gate).
        quoted_credits: 3,
        schedule: plan.proposal.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
      });
      const off = v1data<{
        usage: {
          input_tokens: number;
          output_tokens: number;
          repair_rounds: number;
        };
        assignments: unknown[];
        credits?: number;
        quote_mismatch?: { quoted: number; charged: number };
      }>(offRes);
      check(
        "v4 AI/paid: officials ai-plan (empty instruction) returns a zero-token solver draft",
        offRes.status === 200 &&
          off.usage.input_tokens === 0 &&
          off.usage.output_tokens === 0 &&
          off.usage.repair_rounds === 0,
      );
      check(
        "v4 AI/paid: the empty-instruction officials run made NO model call",
        !fixture.calls.some((c) => c.phase === "officials"),
      );
      const offEvent = await latestCompetitionEvent(compId, "schedule.ai_officials_generated");
      check(
        'v4 AI/paid: schedule.ai_officials_generated ledger row stamps model "solver-draft"',
        !!offEvent && offEvent.model === "solver-draft",
      );

      // #387 — quote/charge reconciliation.
      check(
        "#387: the officials run reports the card's quote against what it charged",
        off.quote_mismatch?.quoted === 3 && off.quote_mismatch?.charged === off.credits,
      );
      check(
        "#387: a mismatch does not withhold the plan — it is telemetry, not a gate",
        offRes.status === 200 && off.assignments.length > 0,
      );
      const mismatchEvent = await latestCompetitionEvent(compId, "schedule.ai_quote_mismatch");
      check(
        "#387: the divergence is recorded on the competition ledger",
        !!mismatchEvent && mismatchEvent.quoted === 3 && mismatchEvent.charged === 1,
      );

      // ---- #384: an adopted candidate reaches the SOLVE, not just the diff ----
      //
      // Adopting a candidate with an empty instruction used to be discarded:
      // `prior.assignments` was consumed only as a diff baseline, so the plan
      // was re-derived from the solver and the organiser's click vanished —
      // while the diff, which DID read the prior, then reported their own
      // adoption as something the AI had changed.
      //
      // NOT VACUOUS BY CONSTRUCTION: a second referee is added and the run
      // above is used as the control, so the adopted official is deliberately
      // the one the solver did NOT choose for that slot. If the adoption were
      // dropped, the response would come back naming the control's pick.
      const secondRefId = v1data<{ id: string }>(
        await v1(paid, "/api/v1/officials", "POST", {
          display_name: `AI Ref B ${tag}`,
          role_keys: ["referee"],
        }),
      ).id;
      const officialsSchedule = plan.proposal.map((a) => ({
        fixture_id: a.fixture_id,
        scheduled_at: a.scheduled_at,
        court_label: a.court_label,
      }));
      const control = v1data<{
        assignments: { fixtureId: string; officialId: string; roleKey: string }[];
      }>(
        await v1(paid, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
          instruction: "",
          policy: { roles: ["referee"] },
          schedule: officialsSchedule,
        }),
      );
      const target = control.assignments[0];
      const adoptedId = target?.officialId === secondRefId ? firstRefId : secondRefId;
      const adoptRes = await v1(paid, `/api/v1/divisions/${divId}/officials/ai-plan`, "POST", {
        instruction: "",
        policy: { roles: ["referee"] },
        schedule: officialsSchedule,
        prior: {
          instruction: "",
          assignments: control.assignments.map((a) =>
            a.fixtureId === target?.fixtureId && a.roleKey === target?.roleKey
              ? { ...a, officialId: adoptedId }
              : a,
          ),
        },
      });
      const adopt = v1data<{
        assignments: { fixtureId: string; officialId: string; roleKey: string }[];
        diff: { changed: string[]; unchanged: string[] };
      }>(adoptRes);
      const adoptedSlot = adopt.assignments.find(
        (a) => a.fixtureId === target?.fixtureId && a.roleKey === target?.roleKey,
      );
      check(
        "#384: an adopted official survives the empty-instruction solve",
        adoptRes.status === 200 && !!target && adoptedSlot?.officialId === adoptedId,
      );
      check(
        "#384: the organiser's own adoption is not reported as AI-changed",
        !!target && !adopt.diff.changed.includes(target.fixtureId),
      );
      check(
        "#384: every other slot still comes back filled (an adopt does not blank the grid)",
        adopt.assignments.length === control.assignments.length,
      );

      // ---- #396: a to-be-decided bracket slot is checked against everyone who
      // could still reach it ----
      //
      // `refine`, not `generate`, on purpose. Refine takes the organiser's own
      // prior as the draft (schedule-ai.ts), the fixture model echoes it back,
      // and person_overlap is a WARNING rather than a blocker — so nothing
      // between here and the response is free to move the two cards apart. The
      // board handed over deliberately plays the final and the third-place
      // playoff at the same moment: legal on every rule that reads named
      // entrants (both slots are still null), unsafe on the four people who can
      // still reach them. Before #396 this run came back silent; the assertion
      // below is the difference, and it reds if the recursion behind the null
      // slots is removed, because an undecided fixture then carries no people
      // at all.
      const bracket = await seedBracketAiDivision(paid, "AI Bracket");
      const tbdIds = new Set(
        bracket.fixtures
          .filter((f) => f.home_entrant_id === null && f.away_entrant_id === null)
          .map((f) => f.id),
      );
      const decided = bracket.fixtures.filter(
        (f) => f.home_entrant_id !== null && f.away_entrant_id !== null,
      );
      const clashingPrior = [
        ...decided.map((f, i) => ({
          fixture_id: f.id,
          scheduled_at: "2026-10-08T09:00:00.000Z",
          court_label: bracket.courtIds[i === 0 ? 0 : 1],
        })),
        ...[...tbdIds].map((id, i) => ({
          fixture_id: id,
          scheduled_at: "2026-10-08T09:30:00.000Z",
          court_label: bracket.courtIds[i === 0 ? 0 : 1],
        })),
      ];
      const refinedRes = await v1(
        paid,
        `/api/v1/divisions/${bracket.divId}/schedule/ai-plan`,
        "POST",
        {
          instruction: "keep these kick-off times, they suit the venue",
          mode: "refine",
          prior: { instruction: "the organiser's own timetable", assignments: clashingPrior },
        },
      );
      const refined = v1data<AiPlanResponseLite>(refinedRes);
      const placedTbd = (refined?.proposal ?? []).filter((a) => tbdIds.has(a.fixture_id));
      // W6 (#401) CHANGED THIS OUTCOME, and the change is the point.
      //
      // These two checks used to assert that the clashing prior SURVIVED to the
      // response, on the stated premise that it was "unrepairable". That premise
      // was true only while nothing could repair it. The CP-SAT repair solver
      // now runs before the model is asked again, so the organiser is no
      // longer shown a board that puts one human on two courts at once.
      //
      // Both fixtures are still placed — the clash is resolved by MOVING one, not
      // by dropping either. The guards below keep this from going vacuous in the
      // other direction: a plan that simply lost a fixture would also produce
      // "no two fixtures in one slot".
      check(
        "v4 AI/bracket: refine REPAIRS the clashing prior instead of shipping it (#401)",
        refinedRes.status === 200 &&
          tbdIds.size === 2 &&
          placedTbd.length === 2 &&
          placedTbd[0].scheduled_at !== placedTbd[1].scheduled_at,
      );
      check(
        // The solver's own report is the evidence that the repair happened here
        // rather than the fixture model having quietly returned something else.
        // `moved === 1` is the minimality claim in its smallest observable form:
        // two fixtures collide, exactly one has to move, and the engine proves
        // no smaller change exists.
        "v4 AI/bracket: ...by moving exactly ONE fixture, proved minimal (#401)",
        refined?.repair?.solver_ran === true &&
          refined.repair.status === "repaired" &&
          refined.repair.moved === 1 &&
          refined.repair.minimality === "proved",
      );
      check(
        // #399 promoted person_overlap out of `warnings` and into `blocking`: a
        // human on two courts at once is impossible, so the runner asks for a
        // repair instead of shipping it. That classification is still what drives
        // this — the solver only repairs BLOCKING families — but the outcome is
        // now the repair, so what survives to the organiser is nothing.
        "v4 AI/bracket: the person_overlap that blocked is GONE from the response (#396, #399, #401)",
        (refined?.blocking ?? []).every(
          (w) => !(w.reason === "person_overlap" && tbdIds.has(w.fixtureId)),
        ) && (refined?.repair?.unresolved ?? 0) === 0,
      );

      // ---- #397: the division with NO configured start date ----
      //
      // The board this wave exists for. Every division seeded above carries a
      // `startAt`, so none of them can red on the actual defect: with no start
      // date the pack drafted from `toSlotConfig(settings, 0)` and handed the
      // model 1970-01-01 for every fixture. The window now opens at today in
      // the organisation zone and the draft anchors on its first session hour,
      // so a drafted date must be today or later. Read, again, through the
      // proposal — the pack's own draft echoed back by the fixture model.
      //
      // Topped up first: this is one more metered run on the paid wallet, and
      // an `ai.credits` 402 here would look like an anchor regression.
      await topUpWallet(paidOrg, 3);
      const undated = await seedPlannableAiDivision(paid, "AI Undated", null);
      const undatedRes = await v1(
        paid,
        `/api/v1/divisions/${undated.divId}/schedule/ai-plan`,
        "POST",
        { instruction: "spread the fixtures across both courts", mode: "generate" },
      );
      const undatedTimes = (v1data<AiPlanResponseLite>(undatedRes)?.proposal ?? []).map(
        (a) => a.scheduled_at,
      );
      check(
        "v4 AI/anchor: a division with NO start date still drafts zoned, non-epoch times (#397)",
        undatedRes.status === 200 &&
          undatedTimes.length > 0 &&
          undatedTimes.every((t) => zonedTime(t)) &&
          !undatedTimes.some((t) => epochAnchored(t)),
      );
      check(
        "v4 AI/anchor: its window opens today, not at the epoch — nothing drafted before yesterday (#397)",
        undatedTimes.length > 0 && undatedTimes.every((t) => t.slice(0, 10) >= yesterdayUtcYmd()),
      );
    }
  } finally {
    await fixture?.close();
  }
}
