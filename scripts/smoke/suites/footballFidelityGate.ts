// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  type Session, newSession, call, check, signIn, tag, timedFixture, v1, v1data, appendScoreEvent,
} from "../harness.ts";

/**
 * R8 sweep, task G, TURNED AROUND BY W1 (entitlements v18, owner ruling
 * 2026-08-30).
 *
 * As written, this suite asserted the v3 pad's ENTITLEMENT gating: that
 * `football.shot` — football's ONE band-3 event (football.ts's own
 * `padSpec.fidelity` comment) — was reachable on Pro and refused 402 on
 * Community, because its `fidelityTiers` tier-3 entry keyed it to
 * `scoring.ball_by_ball` and V112 granted that key to pro/business only.
 *
 * V390 deleted `scoring.ball_by_ball` and the other two fidelity keys from
 * `plan_entitlements`, and the same wave deleted `fidelityTiers`,
 * `requiredFeatureForEvent` and `resolveFidelityBand` outright. There is no
 * band-to-plan resolution left anywhere on the server: `PadSpec.fidelity` is
 * a UX filter the pad reads, and the band is the scorer's own pick.
 *
 * So the suite is INVERTED, not deleted — and it is more valuable inverted
 * than it was before. The claim it now carries is the acceptance criterion of
 * the whole wave, driven through the real HTTP door on two orgs at once:
 * `football.shot` behaves IDENTICALLY on Community and on Pro. A gate left
 * behind in `scoreEvent` — or reintroduced by a later wave — reds here.
 *
 * `football.goal` (band 0, free before and after) stays as the CONTROL, for
 * the inverse of its original reason: it proves the free fixture is genuinely
 * scoreable, so a door that accepted everything unconditionally cannot be
 * told from one that is correctly ungated. The two together bound it.
 *
 * Free-org setup reuses `scorePadV2AppendSuite`'s own primitive just above
 * (a fresh sign-up mints a community-plan org with no plan flip needed).
 */
export async function footballFidelityGateSuite(admin: Session, proOrgId: string): Promise<void> {
  const shotFixture = async (
    s: Session,
    orgId: string,
    label: string,
  ): Promise<{ fixtureId: string; homeId: string }> => {
    s.cookies["seazn_org"] = orgId;
    const comp = v1data<{ id: string }>(
      await v1(s, "/api/v1/competitions", "POST", {
        ends_on: "2030-12-31",
        name: `Fidelity Gate ${label} ${tag}`,
      }),
    );
    const fx = await timedFixture(s, comp.id, {
      name: "Gate",
      sport_key: "football",
      variant_key: "11-a-side",
      entrants: [
        { kind: "team", display_name: `${label} Home ${tag}`, seed: 1, members: [] },
        { kind: "team", display_name: `${label} Away ${tag}`, seed: 2, members: [] },
      ],
    });
    // football.shot is PLAY_PHASE_ONLY (football.tsx's own phaseAllows gate)
    // — needs core.start's "pre" -> "H1" transition before it is reachable
    // at all, regardless of entitlement.
    const started = await appendScoreEvent(s, fx.fixtureId, "core.start", {});
    check(`fidelity gate ${label}: core.start accepted (201)`, started.status === 201);
    return { fixtureId: fx.fixtureId, homeId: fx.entrantIds[0] };
  };

  // ---- Pro: band 3 (football.shot) reachable ----
  const pro = await shotFixture(admin, proOrgId, "Pro");
  const proShot = await appendScoreEvent(admin, pro.fixtureId, "football.shot", {
    by: pro.homeId,
    outcome: "saved",
  });
  check(
    "fidelity band pro: football.shot (band 3) accepted (201)",
    proShot.status === 201,
  );

  // ---- Free (community): band 3 ACCEPTED here too, band 0 as the control ----
  // W1 (entitlements v18) inverted this leg deliberately — it asserted a 402
  // until V390 deleted `scoring.ball_by_ball` and Task 3 deleted its gate. If
  // you are here because the 201 below looks wrong, the assertion is right and
  // this comment is the record of why; putting the 402 back re-establishes a
  // paywall the owner removed on 2026-08-30.
  const freeOwner = newSession();
  await signIn(freeOwner, `delivered+fidelitygatefree_${tag}@resend.dev`);
  const freeOrgId = ((await call(freeOwner, "/api/orgs")) as { id: string }[])[0].id;
  const free = await shotFixture(freeOwner, freeOrgId, "Free");
  const freeShot = await appendScoreEvent(freeOwner, free.fixtureId, "football.shot", {
    by: free.homeId,
    outcome: "saved",
  });
  check(
    "fidelity band free: football.shot (band 3) accepted (201) on COMMUNITY too — recording detail is not a plan boundary (W1; formerly 402 scoring.ball_by_ball)",
    freeShot.status === 201 && freeShot.json.error === undefined,
  );
  const freeGoal = await appendScoreEvent(freeOwner, free.fixtureId, "football.goal", {
    by: free.homeId,
  });
  check(
    "fidelity band free: football.goal (band 0) accepted (201) — the control, so an all-accepting door cannot be mistaken for a correctly ungated one",
    freeGoal.status === 201,
  );
}
