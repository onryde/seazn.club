// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  newSession, raw, call, check, signIn, tag, PASS_RUNGS, type PassRung, grantPass, postSignedStripeWebhook,
  walletBalance, smokeDb, type V1Res, v1, v1data, setPlan,
} from "../harness.ts";

/**
 * v17 #294 — the Event Pass **L** rung, over real HTTP.
 *
 * `passGrantsSuite` above proves WHAT an Event Pass delivers. This proves the
 * LADDER: that the rung a buyer pays for is the rung the platform stores, and
 * the rung it then enforces. Three legs, in the order the money travels.
 *
 * 1. **A paid purchase is filed as the rung that was bought.** Driven through
 *    the app's REAL webhook route with a synthetic, correctly-signed
 *    `checkout.session.completed`, because that handler is the only production
 *    writer of `competition_passes` and an embedded Stripe checkout cannot be
 *    completed headlessly. So this leg exercises `recordPassPurchase` itself —
 *    the pass row, the flat +25 credit grant and the cache bust — rather than
 *    seeding the effects and admiring them. BOTH rungs are bought, on two
 *    competitions of one org: "L was stored as L" proves nothing against a
 *    writer that hardcodes L, and the M arm is what kills that mutation.
 *    Credits are asserted as a DELTA per purchase, so the grant being flat
 *    (`PASS_CREDIT_GRANT`, never keyed by rung — L buys a bigger competition,
 *    not more credits) fails loudly if anyone parametrises it.
 *
 * 2. **The stored rung is the enforced rung.** L is unlimited entrants / 20
 *    divisions where M is 128 / 10, asserted in the same passed-vs-sibling PAIR
 *    shape `passGrantsSuite` uses — except the sibling is doubled: a PASSLESS
 *    competition (community's 4) and an M-PASSED one (M's 128/10). A ceiling
 *    that leaks in either direction therefore fails for the right reason, and
 *    "seats 200" cannot be satisfied by a plan that simply has no ceiling.
 *
 * 3. **The buy route refuses what it cannot honour** — an unrecognised rung
 *    (400 from the zod enum, before any Stripe call) and a competition that
 *    already holds a pass (400, ahead of the price lookup). Both keyless.
 *
 * Plus the PRO path, which is not a formality here: `resolveFromDb` skips the
 * Event Pass overlay entirely for a paid plan, so an L pass on a Pro org must
 * neither CAP Pro's unlimited divisions at L's 20 nor LIFT Pro's 256-entrant
 * ceiling to L's unlimited. Both directions are wrong and both are asserted.
 * That org's pass is seeded with `grantPass` — the buy route refuses a paid
 * plan outright — which also gives the rung column's `not null default
 * 'event_pass'` landmine a live witness on every run.
 *
 * Own fresh orgs. Leg 1 needs the server's `STRIPE_WEBHOOK_SECRET` (and a
 * `STRIPE_SECRET_KEY`, which the route's verifier constructs a client from) and
 * skips cleanly without them — the same convention as `paymentMethodSuite`,
 * with the rungs seeded directly so legs 2 and 3 still run. Everything else is
 * keyless and spends no AI tokens.
 */
export async function passRungLSuite(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string } | undefined)?.feature_key;
  const entrants = (n: number, from: number, label: string) =>
    Array.from({ length: n }, (_, i) => ({
      kind: "individual",
      display_name: `${label}${from + i}`,
      seed: from + i,
    }));

  // === the ladder itself ==================================================
  // Everything below reasons about "the OTHER rung", so smoke's hand-kept
  // PASS_RUNGS copy has to still be the whole truth. A third rung seeded
  // without touching this file would leave every pair assertion quietly
  // incomplete; this is the one check that notices.
  const rungsInDb = await passRungsInDb();
  check(
    `pass L/ladder: plans carries exactly the rungs smoke knows about (${PASS_RUNGS.join(", ")})`,
    rungsInDb.join(",") === [...PASS_RUNGS].sort().join(","),
  );

  const s = newSession();
  const orgId = (await signIn(s, `delivered+passl_${tag}@resend.dev`)).org_id;
  const mkComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `${name} ${tag}`,
        visibility: "unlisted",
      }),
    );
  const mkDiv = (compId: string, name: string) =>
    v1(s, `/api/v1/competitions/${compId}/divisions`, "POST", { name, ...genericDiv });

  const lComp = await mkComp("Rung L");
  const mComp = await mkComp("Rung M");
  const plainComp = await mkComp("Rung Plain");
  check(
    "pass L: fixture built — one community org, three competitions (L, M, passless)",
    !!lComp.id && !!mComp.id && !!plainComp.id,
  );

  // === Leg 1 — the money path ==============================================
  const canSignWebhooks = !!process.env.STRIPE_WEBHOOK_SECRET && !!process.env.STRIPE_SECRET_KEY;
  if (canSignWebhooks) {
    const startBalance = await walletBalance(orgId);

    const lIntent = `pi_smoke_${tag}_l`;
    const lAck = await postPaidPassWebhook({
      orgId,
      competitionId: lComp.id,
      passKey: "event_pass_l",
      paymentIntent: lIntent,
    });
    check("pass L/paid: the signed L checkout.session.completed is accepted (200)", lAck === 200);
    const lRow = await passRowFor(lComp.id);
    check(
      "pass L/paid: the purchase is FILED as the rung that was bought (pass_key event_pass_l, carrying its intent) — the $59 sale is not recorded as the $29 product",
      lRow?.pass_key === "event_pass_l" && lRow?.stripe_payment_intent === lIntent,
    );
    const afterL = await walletBalance(orgId);
    const lGrant = afterL - startBalance;
    check(
      "pass L/paid: a one-time AI credit grant fires on an L purchase",
      lGrant > 0,
    );

    const mIntent = `pi_smoke_${tag}_m`;
    const mAck = await postPaidPassWebhook({
      orgId,
      competitionId: mComp.id,
      passKey: "event_pass",
      paymentIntent: mIntent,
    });
    const mRow = await passRowFor(mComp.id);
    check(
      "pass L/paid: the same writer files an M purchase as event_pass — the rung is read from the session, not hardcoded",
      mAck === 200 && mRow?.pass_key === "event_pass" && mRow?.stripe_payment_intent === mIntent,
    );
    // PER RUNG since entitlements v18 W2 T5, and this check asserted the
    // opposite: it pinned a FLAT 25 on both rungs, with a literal, and W2 T12
    // then set L to 35. It had been red on the L leg ever since — a stale
    // assertion in the one path a customer can no longer reach, now that the L
    // rung is off sale (owner decision 2026-09-05), which is exactly why it
    // went unnoticed.
    //
    // The rungs are compared to EACH OTHER rather than to numbers. Smoke cannot
    // import `PASS_CREDIT_GRANT` (see the PASS_RUNGS comment above — no `@/`
    // alias, no JSON import), and a literal here is what rotted; the ordering
    // is the product rule and it moves with the constant.
    const mGrant = (await walletBalance(orgId)) - afterL;
    check(
      `pass L/paid: each rung grants its OWN credit top-up — L ${lGrant}, M ${mGrant}, both positive and NOT equal`,
      mGrant > 0 && lGrant > mGrant,
    );
  } else {
    await grantPass(orgId, lComp.id, "event_pass_l");
    await grantPass(orgId, mComp.id, "event_pass");
    check(
      "pass L/paid: skipped (no STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY — cannot sign a webhook this server will accept); both rungs seeded directly instead",
      true,
    );
  }

  // === Leg 2 — the stored rung is the enforced rung ========================
  // entrants.per_division.max — L unlimited, M 128 (V319/V341), community 64.
  const lCapDiv = v1data<{ id: string }>(await mkDiv(lComp.id, "L Entrant Cap"));
  const lSeats = await v1(
    s,
    `/api/v1/divisions/${lCapDiv.id}/entrants`,
    "POST",
    entrants(200, 1, "L"),
  );
  check(
    "pass L/entrants: the L-passed competition seats 200 in one division — past M's 128 (L is unlimited)",
    lSeats.status === 201,
  );
  const mCapDiv = v1data<{ id: string }>(await mkDiv(mComp.id, "M Entrant Cap"));
  const mSeats = await v1(
    s,
    `/api/v1/divisions/${mCapDiv.id}/entrants`,
    "POST",
    entrants(128, 1, "M"),
  );
  const m129 = await v1(
    s,
    `/api/v1/divisions/${mCapDiv.id}/entrants`,
    "POST",
    entrants(1, 129, "M"),
  );
  check(
    "pass L/entrants: the M-passed competition still stops at 128 — L's unlimited did not leak to the other rung",
    mSeats.status === 201 &&
      m129.status === 402 &&
      featureKey(m129) === "entrants.per_division.max",
  );

  // divisions.per_competition.max — L 20, M 10, community 4. Each competition
  // already holds its entrant-cap division, so the fillers start at 2.
  let lDivisionsOk = true;
  for (let i = 2; i <= 20; i++) {
    if ((await mkDiv(lComp.id, `L Filler ${i}`)).status !== 201) lDivisionsOk = false;
  }
  const l21st = await mkDiv(lComp.id, "L Twenty-first");
  check("pass L/divisions: the L-passed competition takes all 20 (past M's 10)", lDivisionsOk);
  check(
    "pass L/divisions: the 21st is refused — the L ceiling is 20, not unlimited",
    l21st.status === 402 && featureKey(l21st) === "divisions.per_competition.max",
  );

  let mDivisionsOk = true;
  for (let i = 2; i <= 10; i++) {
    if ((await mkDiv(mComp.id, `M Filler ${i}`)).status !== 201) mDivisionsOk = false;
  }
  const m11th = await mkDiv(mComp.id, "M Eleventh");
  check(
    "pass L/divisions: the M-passed competition still stops at 10 — L's 20 did not leak to the other rung",
    mDivisionsOk &&
      m11th.status === 402 &&
      featureKey(m11th) === "divisions.per_competition.max",
  );

  let siblingOk = true;
  for (let i = 1; i <= 4; i++) {
    if ((await mkDiv(plainComp.id, `Sibling ${i}`)).status !== 201) siblingOk = false;
  }
  const sibling5th = await mkDiv(plainComp.id, "Sibling Fifth");
  check(
    "pass L/divisions: the passless sibling stays on community's 4 — neither rung leaked org-wide",
    siblingOk &&
      sibling5th.status === 402 &&
      featureKey(sibling5th) === "divisions.per_competition.max",
  );

  const ent = (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
    plan_key: string;
    entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
  };
  check(
    "pass L/scope: two passes bought and the org still resolves community org-wide (64 entrants, 4 divisions) — a pass is not a plan",
    ent.plan_key === "community" &&
      ent.entitlements["entrants.per_division.max"]?.limit === 64 &&
      ent.entitlements["divisions.per_competition.max"]?.limit === 4,
  );

  // === Leg 3 — what the buy route refuses (keyless: both answer before Stripe)
  const badRung = await raw(s, "/api/billing/pass-checkout", "POST", {
    competition_id: plainComp.id,
    pass_key: "event_pass_xl",
  });
  // Both checks assert the REASON as well as the status. A 400 alone is the
  // route's answer to half a dozen unrelated refusals and to any body-schema
  // change — a renamed field would 400 on "competition_id is required" and keep
  // both of these green while proving nothing about the rung enum or the
  // one-pass rule. The reasons themselves are pinned in
  // lib/__tests__/pass-checkout-plan-gate.test.ts; this is the wire version.
  check(
    "pass L/checkout: an unrecognised rung is refused (400) by the SCHEMA, naming pass_key — the enum is built from PASS_KEYS, not a hardcoded list",
    badRung.status === 400 &&
      badRung.json.error === "Invalid input" &&
      (badRung.json.issues ?? []).some((i) => (i.path ?? []).includes("pass_key")),
  );
  const alreadyPassed = await raw(s, "/api/billing/pass-checkout", "POST", {
    competition_id: lComp.id,
    pass_key: "event_pass_l",
  });
  check(
    "pass L/checkout: a competition that already holds a pass refuses a second one (400), and says so",
    alreadyPassed.status === 400 &&
      (alreadyPassed.json.error ?? "").includes("already has an Event Pass"),
  );

  // === The pro path — a pass and a paid plan are read TOGETHER (v17 #327/#337)
  // Until V344 the overlay was skipped entirely under a paid plan, so an L
  // holder who subscribed to Pro silently lost unlimited entrants on the
  // competition they had already paid to unlock. Now the BETTER of the two
  // applies per axis.
  //
  // The DIVISIONS half used to be the second direction of that ("the plan wins
  // on divisions"), and it stopped being one: entitlements v18 (V393, §2 "R2:
  // bounded; 20 is a federation") bounded Pro at 20, which is exactly what
  // event_pass_l already carried. Two equal numbers cannot witness which side
  // won, so this check no longer asserts that the 21st division lands — it
  // asserts what remains true and observable, that the pass does not LOWER the
  // Pro competition below its own plan's cap. The ENTRANTS check below (Pro 256
  // against L's unlimited) is now the only leg on this pair that discriminates,
  // and it is deliberately left as the load-bearing one. ===
  const pro = newSession();
  const proOrgId = (await signIn(pro, `delivered+passlpro_${tag}@resend.dev`)).org_id;
  await setPlan(proOrgId, "pro", pro);
  const proComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Rung L Pro ${tag}`,
      visibility: "unlisted",
    }),
  );
  await grantPass(proOrgId, proComp.id, "event_pass_l");
  const proPass = await passRowFor(proComp.id);
  check(
    "pass L/pro: a directly-seeded L pass is STORED as event_pass_l — an omitted rung is filed as M by the column default (V271) with nothing red",
    proPass?.pass_key === "event_pass_l",
  );

  // The cap is READ from the org's own resolved entitlements, never typed: it
  // was written into this file as a bare 21-iteration loop against "L's 20",
  // and V393 moved Pro onto the same 20 underneath it.
  const proEnt = (await call(pro, `/api/orgs/${proOrgId}/entitlements`)) as {
    entitlements: Record<string, { limit?: number | null }>;
  };
  const resolvedDivCap = proEnt.entitlements["divisions.per_competition.max"]?.limit;
  check(
    "pass L/pro: a passed Pro competition resolves a FINITE divisions.per_competition.max",
    typeof resolvedDivCap === "number" && resolvedDivCap >= 2,
  );
  const proDivCap = typeof resolvedDivCap === "number" ? resolvedDivCap : 0;
  const proDivIds: string[] = [];
  let oneOver: V1Res | null = null;
  for (let i = 1; i <= proDivCap + 1; i++) {
    const r = await v1(pro, `/api/v1/competitions/${proComp.id}/divisions`, "POST", {
      name: `Pro Div ${i}`,
      ...genericDiv,
    });
    if (i === proDivCap + 1) oneOver = r;
    else if (r.status === 201) proDivIds.push(v1data<{ id: string }>(r).id);
  }
  check(
    "pass L/pro: an L pass does not LOWER a Pro competition's own division cap — every one of its divisions lands, and only the one past the cap is refused (#327)",
    proDivIds.length === proDivCap &&
      oneOver?.status === 402 &&
      featureKey(oneOver) === "divisions.per_competition.max",
  );

  const proDivId = proDivIds[0];
  const pro256 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(256, 1, "R"),
  );
  const pro257 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(1, 257, "R"),
  );
  const pro300 = await v1(
    pro,
    `/api/v1/divisions/${proDivId}/entrants`,
    "POST",
    entrants(43, 258, "R"),
  );
  check(
    "pass L/pro: L's unlimited entrants LIFT Pro's 256 ceiling on the passed competition — the 257th lands, and so does the 300th (#337)",
    pro256.status === 201 && pro257.status === 201 && pro300.status === 201,
  );

  // The SELLING half of the same decision (#327): a paid org may buy a rung
  // that beats its plan, and only that rung. On a competition with no pass yet,
  // because a competition that holds one refuses any second purchase first.
  const proGateComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Rung L Pro Gate ${tag}`,
      visibility: "unlisted",
    }),
  );
  const proBuyM = await raw(pro, "/api/billing/pass-checkout", "POST", {
    competition_id: proGateComp.id,
    pass_key: "event_pass",
  });
  const proBuyL = await raw(pro, "/api/billing/pass-checkout", "POST", {
    competition_id: proGateComp.id,
    pass_key: "event_pass_l",
  });
  const coverageRefusal = (r: { status: number; json: { error?: string } }) =>
    r.status === 400 && (r.json.error ?? "").includes("already includes everything");
  check(
    "pass L/pro: the M rung is refused to a Pro org — its plan already covers everything M adds (#327)",
    coverageRefusal(proBuyM),
  );
  // NOT asserted as 200: the one-time price may be unsynced in this environment,
  // which 503s. What must be true is that the COVERAGE gate did not fire — the
  // sale is allowed to reach Stripe.
  check(
    "pass L/pro: the L rung is not refused on coverage — L beats Pro on entrants, so the sale is allowed through (#327)",
    !coverageRefusal(proBuyL),
  );
}

/** Every Event Pass rung the `plans` table actually carries, sorted. Read with
 *  a plain `select key` and filtered in JS rather than a `like 'event\_pass%'`
 *  — the escaped underscore is a needless trap inside a tagged template. */
async function passRungsInDb(): Promise<string[]> {
  const sql = smokeDb();
  try {
    const rows = await sql<{ key: string }[]>`select key from plans order by key`;
    return rows.map((r) => r.key).filter((k) => k.startsWith("event_pass"));
  } catch {
    return [];
  } finally {
    await sql.end();
  }
}

/** The Event Pass row a competition actually holds — the rung the resolver will
 *  enforce and the money trace will name. Read back, never assumed: the whole
 *  point of the L rung is that storing the wrong one is silent. */
async function passRowFor(
  competitionId: string,
): Promise<{ pass_key: string; stripe_payment_intent: string | null } | null> {
  const sql = smokeDb();
  try {
    const [row] = await sql<{ pass_key: string; stripe_payment_intent: string | null }[]>`
      select pass_key, stripe_payment_intent from competition_passes
      where competition_id = ${competitionId}`;
    return row ?? null;
  } finally {
    await sql.end();
  }
}

/**
 * A PAID Event Pass checkout session, in the shape `buildPassCheckoutParams`
 * stamps and `handleCheckoutCompleted` reads: `metadata.pass_key` is what tells
 * the handler which rung was bought, and `payment_status: "paid"` is what makes
 * it record anything at all.
 *
 * Deliberately carries NO `amount_total`: nothing in the pass branch reads it,
 * and writing a price here would plant exactly the kind of stale `2900` literal
 * this rung ladder exists to stop. `customer` is null so the handler skips
 * `linkStripeCustomer` — smoke has no Stripe customer to link and does not need
 * one to prove which rung landed.
 */
async function postPaidPassWebhook(args: {
  orgId: string;
  competitionId: string;
  passKey: PassRung;
  paymentIntent: string;
}): Promise<number> {
  return postSignedStripeWebhook("checkout.session.completed", {
    id: `cs_smoke_${tag}_${args.passKey}_${args.competitionId.slice(0, 8)}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    currency: "usd",
    customer: null,
    payment_intent: args.paymentIntent,
    metadata: {
      org_id: args.orgId,
      competition_id: args.competitionId,
      pass_key: args.passKey,
    },
  });
}
