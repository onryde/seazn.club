// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, html, v1, v1data, setPlan } from "../harness.ts";

/** The rung ABOVE Pro (Task 11, spec §1), walked on one org across three plans:
 *  community's save-point window rolls at 2 and its officials stay ungated,
 *  Pro's read-only keys stay free while a score- or manage-scope key still
 *  402s on api.write, and the tier above Pro lifts the save-point window and
 *  mints the write-capable key.
 *
 *  Was `proPlusSuite`. V393 (entitlements v18) deleted `pro_plus` from `plans`,
 *  so the rung is `enterprise` now; the suite follows the rung rather than the
 *  plan name, because what it exists to prove — that api.write is the
 *  above-Pro differentiator — is still true.
 *
 *  Runs on its own fresh community owner (never touches org/org2 from main()),
 *  but still restores the org's own plan at the end (shared-DB poison trap:
 *  leave a flipped org as found in case a later suite lands above this one). */
export async function aboveProRungSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+aboveprorung_${tag}@resend.dev`);
  const orgId = who.org_id;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Plus Probe ${tag}`,
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: `Plus A ${tag}`, seed: 1 },
    { kind: "individual", display_name: `Plus B ${tag}`, seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(owner, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const gen = await v1(owner, `/api/v1/stages/${stage.id}/generate`, "POST");
  const fixtureId = v1data<{ fixtures: { id: string }[] }>(gen).fixtures[0].id;
  await v1(owner, `/api/v1/divisions/${div.id}/start`, "POST");

  // (a) Community: officials are ungated on every plan (#253, V319 —
  // officials.per_fixture.max is now unlimited), so a 2nd distinct official on
  // the SAME fixture is allowed (200), not refused.
  const offA = v1data<{ id: string }>(
    await v1(owner, "/api/v1/officials", "POST", {
      display_name: `Plus Ref A ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const offB = v1data<{ id: string }>(
    await v1(owner, "/api/v1/officials", "POST", {
      display_name: `Plus Ref B ${tag}`,
      role_keys: ["referee"],
    }),
  );
  const setTwoOfficials = () =>
    v1(owner, `/api/v1/fixtures/${fixtureId}/officials`, "PATCH", {
      set: [
        { official_id: offA.id, role_key: "referee", locked: false },
        { official_id: offB.id, role_key: "referee", locked: false },
      ],
    });
  const officialsAllowed = await setTwoOfficials();
  check(
    "rung: community allows a 2nd official on one fixture (officials.per_fixture.max ungated #253)",
    officialsAllowed.status === 200,
  );

  // (a) Community: save points — community's window is 2 wide (V319). The 1st
  // and 2nd land silently; since #382 the 3rd ROLLS rather than 402ing, and the
  // response names the label it replaced.
  const cp1Label = `plus 1 ${tag}`;
  const cp1 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: cp1Label,
  });
  check("rung: community's first save point is free", cp1.status === 201);
  const cp2 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 2 ${tag}`,
  });
  check("rung: community's second save point is free (cap is 2)", cp2.status === 201);
  const cp3Rolled = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `plus 3 ${tag}`,
  });
  check(
    "rung: community's 3rd save point rolls the window and names what it replaced (#382)",
    cp3Rolled.status === 201 &&
      (cp3Rolled.json.data as { evicted?: { label?: string } } | undefined)?.evicted?.label ===
        cp1Label,
  );
  const cpList = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "GET");
  check(
    "rung: community holds exactly 2 manual save points after the roll",
    ((cpList.json.data as { kind?: string }[] | undefined) ?? []).filter(
      (r) => (r.kind ?? "manual") === "manual",
    ).length === 2,
  );

  // (b) Pro: read-only keys stay free (api.access), but a score- or
  // manage-scope key still needs the rung ABOVE Pro — V290 re-armed it and
  // v18 kept it there (api.write: false on pro, true on enterprise).
  await setPlan(orgId, "pro", owner);
  const proScoreKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "plus score",
    scopes: ["score"],
  });
  check(
    "rung: pro 402s a score-scope key (api.write is granted above Pro only)",
    proScoreKey.status === 402 &&
      (proScoreKey.json.error as { feature_key?: string } | undefined)?.feature_key === "api.write",
  );
  const proManageKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "plus manage",
    scopes: ["manage"],
  });
  check(
    "rung: pro 402s a manage-scope key (api.write is granted above Pro only)",
    proManageKey.status === 402 &&
      (proManageKey.json.error as { feature_key?: string } | undefined)?.feature_key ===
        "api.write",
  );

  // (c) The rung ABOVE Pro. Was `pro_plus`; V393 (entitlements v18) deleted that
  // plan from `plans` and `subscriptions.plan_key` carries a live FK, so this
  // flip was throwing. `enterprise` is the rung now.
  await setPlan(orgId, "enterprise", owner);

  // NOT a cap lift any more, and the old name said it was. V393 DELETED
  // `officials.per_fixture.max` outright — arm (a) above already gets 200 for
  // the same two officials on COMMUNITY. So what is worth asserting here is
  // that the key stays gone at the top of the ladder too: if a row for it ever
  // reappeared, a finite cap would arrive on every plan at once and this is the
  // tier where nobody would think to look.
  const officialsOk = await setTwoOfficials();
  check(
    "rung: two officials on one fixture still land above Pro (V393 deleted officials.per_fixture.max)",
    officialsOk.status === 200,
  );

  // A save-point lift, asserted so it can FAIL. `201` alone is satisfied by
  // community too, because #382 made the over-cap 3rd ROLL rather than 402 —
  // the difference between the tiers is whether anything was EVICTED to make
  // room. Community rolled at 2 (asserted above, `evicted.label`); above Pro
  // the cap is unlimited, so the 3rd must land with no eviction and the window
  // must hold three.
  const cp3 = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "POST", {
    label: `rung 3 ${tag}`,
  });
  const cp3Evicted = (cp3.json.data as { evicted?: { label?: string } } | undefined)?.evicted;
  const cpListAfter = await v1(owner, `/api/v1/divisions/${div.id}/checkpoints`, "GET");
  check(
    "rung: the save-point window lifts above Pro — the 3rd lands and evicts NOTHING (community rolled here)",
    cp3.status === 201 &&
      cp3Evicted === undefined &&
      ((cpListAfter.json.data as { kind?: string }[] | undefined) ?? []).filter(
        (r) => (r.kind ?? "manual") === "manual",
      ).length === 3,
  );

  const rungManageKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "rung manage",
    scopes: ["manage"],
  });
  check("rung: the tier above Pro mints a manage-scope key", rungManageKey.status === 201);

  // (d) /pricing renders the matrix marker + the above-Pro offer — marketing
  // never drifts from what the resolver enforces (spec §5). The Pro Plus CARD
  // is gone with the plan (V393); design §4 replaced it with a Contact-us strip
  // under the comparison table (`pricing.enterprise.*`), so that strip is what
  // the above-Pro offer looks like now.
  const pricing = await html(newSession(), "/en/pricing");
  check(
    "rung: /pricing carries the comparison table + the above-Pro contact offer",
    pricing.status === 200 &&
      pricing.body.includes("data-pricing-matrix") &&
      pricing.body.includes("federations, leagues at scale") &&
      pricing.body.includes("Talk to us"),
  );
  // T84: the three v16 league-ops entitlements (discipline, marks, auto
  // news) are surfaced on the Pro card + comparison matrix, not just gated.
  check(
    "rung: /pricing surfaces the v16 league-ops entitlements",
    pricing.body.includes("Suspensions &amp; discipline tracking") &&
      pricing.body.includes("Automatic suspension tracking"),
  );

  // Restore: this org is never touched by another suite in main(), but leave
  // it as found in case a later suite lands above this one (poison trap).
  await setPlan(orgId, "community", owner);
}
