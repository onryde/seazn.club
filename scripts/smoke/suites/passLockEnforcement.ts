// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, raw, call, check, signIn, tag, grantPass, smokeDb, type V1Res, v1, v1data } from "../harness.ts";

/**
 * v17 gap W10 — the `past_ends_on` arm of the Event Pass lock, over real HTTP.
 *
 * `passGrantsSuite` already covers the lock's TERMINAL arm (archived and
 * completed) against the entitlement resolver. It covers nothing of the other
 * arm, and `ends_on` appears nowhere else in this file — which is exactly how
 * #347 and #353 survived: the lock was correct in `entitlements.ts` and two
 * enforcement sites plus the checkout route never asked it.
 *
 * Both legs are PAIRS. A competition one day past the grace must be refused
 * AND the same competition sitting exactly ON the boundary must still be
 * honoured, because "refuses everything" passes the first half on its own —
 * and a grace boundary that is off by a day is the likeliest way this breaks.
 *
 * Keyless: the quota leg is pure app SQL, and the checkout leg asserts the
 * refusal STATUS rather than a completed purchase, so it never needs Stripe.
 */
export async function passLockEnforcementSuite(): Promise<void> {
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string } | undefined)?.feature_key;
  // A UTC calendar date `n` days from today, as a string. Written as a string
  // and computed in UTC on purpose: the rule's boundary is the UTC calendar
  // date (V334), so a local-midnight Date races it for part of every day.
  const utcDay = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  const s = newSession();
  const orgId = (await signIn(s, `delivered+passlock_${tag}@resend.dev`)).org_id;
  // READ, never typed. This was `const COMMUNITY_COMP_CAP = 10` on a comment
  // citing V319; entitlements v18 (V393) cut `competitions.max_active` on
  // community to 3, so the fixture loop below 402'd on the fourth create,
  // threw on `v1data(...).id` and ABORTED the entire run from here down —
  // which is a large part of why nobody had a green smoke on this branch. The
  // cap has now moved twice; the next move must not cost another run.
  const capEnt = (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
    entitlements: Record<string, { limit?: number | null }>;
  };
  const resolvedCompCap = capEnt.entitlements["competitions.max_active"]?.limit;
  check(
    "pass lock/quota: community resolves a FINITE competitions.max_active to fill",
    typeof resolvedCompCap === "number" && resolvedCompCap >= 2,
  );
  const COMMUNITY_COMP_CAP = typeof resolvedCompCap === "number" ? resolvedCompCap : 0;
  const mkComp = async (name: string) =>
    v1data<{ id: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${name} ${tag}`, visibility: "unlisted" }),
    );

  const db = smokeDb();
  try {
    // Fill the org to its cap: ten competitions, the tenth carrying a pass.
    // Creating the tenth is itself legal (nine active + this one = the cap).
    const ids: string[] = [];
    for (let i = 0; i < COMMUNITY_COMP_CAP; i++) ids.push((await mkComp(`Lock Quota ${i}`)).id);
    const passed = ids[COMMUNITY_COMP_CAP - 1];
    await grantPass(orgId, passed, "event_pass");
    check(
      `pass lock/quota: fixture built — ${COMMUNITY_COMP_CAP} live competitions on a community org, the last one passed`,
      ids.length === COMMUNITY_COMP_CAP,
    );

    // === PAST the grace: the pass has stopped applying, so the competition it
    // covers is back inside the quota and the org is genuinely full. Nothing
    // retires a `live` competition past its end date, which is what made this
    // state permanent rather than transient.
    await db`update competitions set ends_on = ${utcDay(-(7 + 1))} where id = ${passed}`;
    const overCap = await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Lock Quota Over ${tag}`,
      visibility: "unlisted",
    });
    check(
      "pass lock/quota: a pass one day past the grace stops buying its competition out of competitions.max_active — the next create 402s (#347)",
      overCap.status === 402 && featureKey(overCap) === "competitions.max_active",
    );

    // === ON the grace boundary: still applying (the comparison is strictly
    // less), so the passed competition is still exempt and there is room. This
    // is the half that fails if anyone "fixes" the boundary to `<=`.
    await db`update competitions set ends_on = ${utcDay(-7)} where id = ${passed}`;
    const atBoundary = await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Lock Quota Boundary ${tag}`,
      visibility: "unlisted",
    });
    check(
      "pass lock/quota: a pass EXACTLY on the grace boundary still buys its competition out — the same create succeeds (201)",
      atBoundary.status === 201,
    );

    // === #353 — the checkout route refuses to SELL a pass for a competition
    // the lock rule has already ended. Its own org and its own competition: an
    // org that already holds a pass is refused for a different reason, and a
    // refusal that fires for the wrong reason proves nothing.
    const buyer = newSession();
    await signIn(buyer, `delivered+passsell_${tag}@resend.dev`);
    const buyComp = v1data<{ id: string }>(
      await v1(buyer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `Lock Sell ${tag}`,
        visibility: "unlisted",
      }),
    );
    await db`update competitions set ends_on = ${utcDay(-(7 + 1))} where id = ${buyComp.id}`;
    const sellEnded = await raw(buyer, "/api/billing/pass-checkout", "POST", {
      competition_id: buyComp.id,
    });
    check(
      "pass lock/sell: buying a pass for a competition past the grace is REFUSED with 410 (#353) — the money never lands on a pass that would read 'ended'",
      sellEnded.status === 410,
    );
    const [minted] = await db<{ n: number }[]>`
      select count(*)::int as n from competition_passes where competition_id = ${buyComp.id}`;
    check("pass lock/sell: ...and nothing was minted", minted?.n === 0);

    // The boundary pair again, and deliberately NOT asserted as 200: with no
    // Stripe key this route cannot reach a session, so what is asserted is that
    // it does not reach the LOCK refusal. A gate that 410s everything passes
    // the case above on its own.
    await db`update competitions set ends_on = ${utcDay(-7)} where id = ${buyComp.id}`;
    const sellBoundary = await raw(buyer, "/api/billing/pass-checkout", "POST", {
      competition_id: buyComp.id,
    });
    check(
      "pass lock/sell: a competition exactly on the grace boundary is still sellable — whatever else happens, it is not the 410",
      sellBoundary.status !== 410,
    );
  } finally {
    await db.end();
  }
}
