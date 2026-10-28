// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, setPlan } from "../harness.ts";

/**
 * RS011 — organiser-side eligibility gates. Before this session a division's
 * age/gender/category rule was enforced ONLY on the public registration
 * path; every organiser-side roster write (add to roster, patch, sync,
 * import, lineup) accepted an ineligible person silently. This drives ONE
 * representative gate point (`createEntrants`) over real HTTP, on a plan
 * label the caller supplies — there is no entitlement to skip here (the gate
 * fires or doesn't regardless of plan), so `eligibilityGateSuite()` calls
 * this once per plan rather than branching inside it.
 */
export async function eligibilityGateOnPlanSuite(plan: "pro" | "community"): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+elig_${plan}_${tag}@resend.dev`);
  const orgId = who.org_id;
  if (plan === "pro") await setPlan(orgId, "pro", owner);

  const comp = v1data<{ id: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Elig ${plan} ${tag}`,
      visibility: "private",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Under 15",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      age_min: 10,
      age_max: 15,
    }),
  );

  const tooOld = v1data<{ id: string }>(
    await v1(owner, "/api/v1/persons", "POST", {
      full_name: `Elig Too Old ${plan} ${tag}`,
      dob: "1990-01-01",
    }),
  );

  // Blocked, and by CODE — a bare 422 is satisfied by every other guard on
  // this path (ENTRANT_ROSTER_TOO_BIG, ENTRANT_KIND_NOT_ALLOWED, …).
  const blocked = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Elig Too Old ${plan} ${tag}`,
    members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
  });
  check(
    `eligibility (${plan}): an over-age roster add 422s ELIGIBILITY_VIOLATION`,
    blocked.status === 422 && blocked.json.error?.code === "ELIGIBILITY_VIOLATION",
  );

  // The SAME request with an override reason succeeds.
  const overridden = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Elig Too Old ${plan} ${tag}`,
    members: [{ person_id: tooOld.id, is_captain: false, roles: [] }],
    eligibility_override: { reason: `Wildcard entry, smoke ${plan} ${tag}` },
  });
  check(`eligibility (${plan}): overriding with a reason succeeds`, overridden.status < 300);

  // Missing dob on the SAME age-restricted division is a warning, never a
  // block — the acceptance criterion this smoke check exists to guard.
  const noDob = v1data<{ id: string }>(
    await v1(owner, "/api/v1/persons", "POST", { full_name: `Elig No Dob ${plan} ${tag}` }),
  );
  const warned = await v1(owner, `/api/v1/divisions/${div.id}/entrants`, "POST", {
    kind: "individual",
    display_name: `Elig No Dob ${plan} ${tag}`,
    members: [{ person_id: noDob.id, is_captain: false, roles: [] }],
  });
  check(
    `eligibility (${plan}): missing dob on an age-restricted division is a WARNING, never a block`,
    warned.status < 300,
  );
}
