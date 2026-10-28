// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, newSession, call, check, signIn, tag, v1, v1data, appendScoreEvent } from "../harness.ts";
import { footballDecidedSequenceSuite } from "./footballDecidedSequence.ts";

/**
 * S13/W11 — closes the smoke debt S1/S3-S8/S10/S11 all deferred: the v2
 * ScorePad's append path (transport.ts/use-pad-pipeline.ts) had ZERO
 * real-HTTP coverage in this file. Scores one fixture to a DECIDED result on
 * the Pro org AND a fresh free (community) org, asserting the server's own
 * reported outcome — never merely a 201. See `footballDecidedSequenceSuite`
 * above for the companion multi-event path this alone cannot cover.
 *
 * Sport chosen: generic. generic.ts's own `padSpec(cfg).fidelity` declares
 * band 0 (the lowest granularity — module.ts's `FIDELITY[0] === "result"`,
 * what the design docs called "quick" before that three-word vocabulary was
 * retired 2026-08-06 in favour of the closed 0-3 numeric scale) as EXACTLY
 * ONE event type: `generic.result` alone, nothing else. That event legally
 * folds from a fixture's initial "pre" phase (generic.ts's apply(): the only
 * guard on `generic.result` is `phase !== "pre" && phase !== "live"`), and
 * append-event.ts places no fixture-status precondition beyond the LOCKED
 * set (finalized/cancelled) — so a single POST decides a brand-new fixture
 * outright, with no core.start first. No other shipped module reaches a
 * decided result in fewer than a core.start plus at least one sport-specific
 * event, which makes this provably the shortest decided-result path of any
 * module here, not just a convenient one. This mirrors how
 * `pagePlayoffSuite`'s own `decide()` helper and `v1Suite`'s
 * standings-decide loop already score fixtures elsewhere in this file.
 *
 * Band 0 is free on every plan — since W1 (entitlements v18, 2026-09-02),
 * EVERY band is free on every plan for every module: `fidelity.ts`'s
 * `requiredFeatureForEvent`, which used to gate a band onto a paywall key, is
 * deleted entirely. So the free half is expected to reach the SAME decided
 * outcome as the Pro half, with no plan flip. If it did not, that would be a
 * finding to report, not something to paper over with a Pro entitlement on
 * the free org.
 */
export async function scorePadV2AppendSuite(admin: Session, proOrgId: string): Promise<void> {
  const genericConfig = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

  const decideOneFixture = async (s: Session, orgId: string, label: string): Promise<void> => {
    s.cookies["seazn_org"] = orgId;
    const comp = v1data<{ id: string }>(
      await v1(s, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `ScorePad Append ${label} ${tag}`,
      }),
    );
    const div = v1data<{ id: string }>(
      await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
        name: "Decided",
        sport_key: "generic",
        variant_key: "score",
        config: genericConfig,
      }),
    );
    await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", [
      { kind: "individual", display_name: `${label} Home ${tag}`, seed: 1, members: [] },
      { kind: "individual", display_name: `${label} Away ${tag}`, seed: 2, members: [] },
    ]);
    const stage = v1data<{ id: string }>(
      await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
    );
    const fx = v1data<{ fixtures: { id: string }[] }>(
      await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"),
    ).fixtures[0].id;
    await v1(s, `/api/v1/divisions/${div.id}/start`, "POST");

    // THE append: one event, the exact wire shape use-pad-pipeline.ts's own
    // transport sends, retried on a real 409 rather than assumed clean.
    const scored = await appendScoreEvent(s, fx, "generic.result", { p1Score: 2, p2Score: 0 });
    check(`scorepad append ${label}: generic.result accepted (201)`, scored.status === 201);
    const acked = v1data<{ status: string; outcome: unknown }>(scored);
    check(
      `scorepad append ${label}: the append ack reports the fixture DECIDED`,
      acked.status === "decided",
    );
    check(
      `scorepad append ${label}: the ack's outcome is a real win, not null`,
      !!acked.outcome && (acked.outcome as { kind?: string }).kind === "win",
    );

    // Confirm through the SAME read the pad's own reconciliation step uses
    // (transport.ts's fetchState / GET .../state) — never just the append ack.
    const state = v1data<{ status: string; outcome: unknown }>(
      await v1(s, `/api/v1/fixtures/${fx}/state`),
    );
    check(
      `scorepad append ${label}: GET .../state independently confirms decided`,
      state.status === "decided" && !!state.outcome,
    );
  };

  // ---- Pro path: minimal one-shot (generic.result, tier 0) ----
  await decideOneFixture(admin, proOrgId, "Pro");

  // ---- Pro path: multi-event sequence (football) — see
  // footballDecidedSequenceSuite's own doc for why the one-shot above cannot
  // see a fold-fails-to-advance defect on its own. ----
  await footballDecidedSequenceSuite(admin, proOrgId);

  // ---- Free (community) path: proves a free org can score at all through
  // the same append door — tier 0 carries no entitlement, so no plan flip. ----
  const freeOwner = newSession();
  await signIn(freeOwner, `delivered+scorepadfree_${tag}@resend.dev`);
  const freeOrgId = ((await call(freeOwner, "/api/orgs")) as { id: string }[])[0].id;
  await decideOneFixture(freeOwner, freeOrgId, "Free");
}
