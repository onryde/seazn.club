import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  newSession, raw, call, check, signIn, tag, grantPass, renderedAttr, html, v1, v1data, setPlan,
} from "../harness.ts";

/**
 * Mark a competition completed directly via SQL (v17 gap #301).
 *
 * Same disposable-DB, SQL-flip convention as grantPass/setPlan, and for the
 * same reason: the thing under test is what every SURFACE says once the
 * resolver stops honouring a pass, and the only way to reach that state through
 * the product is to finish a competition, which is not a checkout flow smoke
 * can drive. The pass ROW is deliberately left untouched — that is the whole
 * point of the gap: the row outlives its own usefulness.
 */
async function endCompetition(competitionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to end a competition in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`update competitions set status = 'completed' where id = ${competitionId}`;
  } finally {
    await sql.end();
  }
}

/** PROMPT-36 (v3/07 §2–3): the plan matrix v3 + Event Pass, free → pass →
 *  pro → downgrade, on a fresh community owner. */
export async function pricingV3Suite(): Promise<void> {
  const genericDivision = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const buyer = newSession();
  const who = await signIn(buyer, `delivered+pass_${tag}@resend.dev`);
  const orgId = who.org_id;

  // Free caps (v17 matrix, V319 "free runs big"): community now runs several
  // active competitions, with 4 divisions inside each (was 2). The pass lifts
  // the per-competition DIVISION cap — that is the boundary this test drives.
  const compA = v1data<{ id: string; slug: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Pass Cup ${tag}`,
    }),
  );
  const secondComp = await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Second Cup ${tag}`,
  });
  check("p36: 2nd active competition allowed on free (community runs several)", secondComp.status === 201);
  for (const name of ["Div 1", "Div 2", "Div 3", "Div 4"]) {
    const d = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
    check(`p36: free org creates ${name.toLowerCase()}`, d.status === 201);
  }
  const div5Blocked = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 5",
    ...genericDivision,
  });
  check("p36: 5th division blocked on free (402, community's cap is 4)", div5Blocked.status === 402);

  // Event Pass on comp A lifts ITS per-competition caps — the 5th division it
  // just refused now lands.
  await grantPass(orgId, compA.id, "event_pass");
  const div5 = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 5",
    ...genericDivision,
  });
  check("p36: pass lifts division cap on the passed comp", div5.status === 201);
  const compB = v1data<{ id: string }>(
    await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sibling Cup ${tag}`,
    }),
  );
  check("p36: a sibling competition is created (community runs several)", !!compB.id);

  // …while the sibling competition — no pass — stays on the community DIVISION
  // cap (4), proving the pass is scoped to comp A and not the org.
  for (const name of ["S1", "S2", "S3", "S4"]) {
    await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
      name,
      ...genericDivision,
    });
  }
  const sibBlocked = await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
    name: "S5",
    ...genericDivision,
  });
  check("p36: sibling comp still community-capped (402)", sibBlocked.status === 402);

  // Pro org buying a pass is pointless — the route refuses before Stripe.
  await setPlan(orgId, "pro", buyer);
  const proBuy = await raw(buyer, "/api/billing/pass-checkout", "POST", {
    competition_id: compB.id,
  });
  check("p36: pass purchase blocked on Pro (400)", proBuy.status === 400);
  const sibUnderPro = await v1(buyer, `/api/v1/competitions/${compB.id}/divisions`, "POST", {
    name: "S5",
    ...genericDivision,
  });
  check("p36: pro lifts the sibling comp", sibUnderPro.status === 201);

  // Downgrade: the pass survives — comp A keeps its 10-division headroom.
  await setPlan(orgId, "community", buyer);
  const afterDowngrade = await v1(buyer, `/api/v1/competitions/${compA.id}/divisions`, "POST", {
    name: "Div 6",
    ...genericDivision,
  });
  check("p36: pass survives downgrade (comp A still lifted)", afterDowngrade.status === 201);

  // The upgrade page reflects the pass state.
  const [orgRow] = (await call(buyer, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const upgradePage = await html(buyer, `/o/${orgRow.slug}/c/${compA.slug}/upgrade`);
  check(
    "p36: upgrade page shows pass active",
    upgradePage.status === 200 && renderedAttr(upgradePage.body, "data-pass-active"),
  );

  // v17 gap #301: finish compA's competition and prove every surface stops
  // calling its pass "active". The row is untouched, so anything still reading
  // row existence alone keeps saying active and fails here — which is exactly
  // the defect, and the reason these are integration checks rather than more
  // unit tests: each surface passed its own tests while disagreeing with the
  // resolver.
  await endCompetition(compA.id);

  const upgradeEnded = await html(buyer, `/o/${orgRow.slug}/c/${compA.slug}/upgrade`);
  // Three separate checks, deliberately. The first version ANDed all three into
  // one boolean and failed in CI without saying WHICH part failed — the same
  // "reports less than it knows" defect this wave keeps finding in guards.
  //
  // All marker checks go through `renderedAttr`, never `body.includes(name)`:
  // the flight payload carries the prop NAME in both states (see its doc), so a
  // bare-name check passed here in the wrong state and failed in the right one.
  check(
    `p301: the upgrade page still renders for a finished competition (got ${upgradeEnded.status})`,
    upgradeEnded.status === 200,
  );
  check(
    "p301: upgrade page marks the pass ENDED once its competition finished",
    renderedAttr(upgradeEnded.body, "data-pass-ended"),
  );
  check(
    "p301: upgrade page drops the ACTIVE marker once its competition finished",
    !renderedAttr(upgradeEnded.body, "data-pass-active"),
  );

  const dashboardEnded = await html(buyer, `/o/${orgRow.slug}`);
  check(
    "p301: dashboard card seal shows ENDED once its competition finished",
    dashboardEnded.status === 200 && renderedAttr(dashboardEnded.body, "data-pass-ended"),
  );
  check(
    "p301: dashboard card seal drops the HELD marker once its competition finished",
    !renderedAttr(dashboardEnded.body, "data-pass-held"),
  );

  const billingEnded = await html(buyer, `/o/${orgRow.slug}/settings/billing`);
  check(
    "p301: billing page marks the purchase ended and does not re-offer that competition",
    billingEnded.status === 200 &&
      billingEnded.body.includes('data-pass-status="ended"') &&
      !billingEnded.body.includes(`href="/o/${orgRow.slug}/c/${compA.slug}/upgrade"`),
  );

  const rebuyEnded = await raw(buyer, "/api/billing/pass-checkout", "POST", {
    competition_id: compA.id,
  });
  check(
    "p301: re-buying an ENDED pass still 400s, with the sentence that is true in both states",
    rebuyEnded.status === 400 &&
      typeof rebuyEnded.json.error === "string" &&
      /on file/i.test(rebuyEnded.json.error),
  );
}
