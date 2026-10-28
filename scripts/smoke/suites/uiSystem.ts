// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, newSession, raw, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/** PROMPT-32 smoke: match-day cards render server-side and the visibility
 *  keys flip end-to-end (share page live + noindex) on pro AND free orgs. */
export async function uiSystemSuite(admin: Session, proOrgSlug: string): Promise<void> {
  // Pro path (admin's active org is the pro org2).
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `UI Cards ${tag}`,
      visibility: "private",
    }),
  );
  const dash = await html(admin, "/dashboard");
  check("dashboard renders card grid (pro)", dash.status === 200 && dash.body.includes("ecard"));
  check("card carries status chip", dash.body.includes('data-chip="draft"'));
  check("console dashboard renders English by default", dash.body.includes("Matchday console"));

  // v5 i18n cycle 47: the console renders in the viewer's locale. Same page with
  // seazn_locale=fr → the English eyebrow is gone, the French one is present.
  const frDash = await html({ cookies: { ...admin.cookies, seazn_locale: "fr" } }, "/dashboard");
  check(
    "console dashboard localizes to French (ui catalog)",
    frDash.status === 200 &&
      frDash.body.includes("Console de jour de match") &&
      !frDash.body.includes("Matchday console"),
  );

  const flip = await v1(admin, `/api/v1/competitions/${comp.id}`, "PATCH", {
    visibility: "unlisted",
  });
  check("visibility flips to Link only (pro)", flip.status === 200);
  const shared = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}`);
  check("link-only page serves (pro)", shared.status === 200);
  check("link-only page keeps noindex", shared.body.includes("noindex"));

  // Free path: fresh community owner, same flow.
  const free = newSession();
  const freeVer = await signIn(free, `delivered+ui_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `UI Cards Free ${tag}`,
      visibility: "private",
    }),
  );
  const freeDash = await html(free, "/dashboard");
  check(
    "dashboard renders card grid (free)",
    freeDash.status === 200 && freeDash.body.includes("ecard"),
  );
  // PROMPT-30 free path: slug console URL serves for community orgs too.
  const freeConsole = await html(free, `/o/${freeOrg.slug}/c/${freeComp.slug}`);
  check("console competition page serves (free)", freeConsole.status === 200);
  const freeFlip = await v1(free, `/api/v1/competitions/${freeComp.id}`, "PATCH", {
    visibility: "unlisted",
  });
  check("visibility flips to Link only (free)", freeFlip.status === 200);
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "link-only page serves + noindex (free)",
    freeShared.status === 200 && freeShared.body.includes("noindex"),
  );

  // --- v3/11 in-app billing: the Stripe-hosted portal route is GONE, the
  // manage endpoints exist behind owner auth and degrade cleanly without a
  // Stripe customer, and the billing page renders with no portal button. ---
  // The route used to answer 404 unless BILLING_PORTAL_FALLBACK=1; that one
  // release elapsed and route.ts is deleted, so the 404 now comes from the
  // router having nothing to match. Same status, no flag left to set — kept
  // as a probe that nothing has quietly re-introduced a portal redirect.
  const portalDead = await raw(admin, "/api/billing/portal", "POST", {});
  check("v3/11 portal route is gone — POST 404s (pro)", portalDead.status === 404);
  const proSetup = await raw(admin, "/api/billing/setup-intent", "POST", {});
  check(
    "v3/11 setup-intent wants a Stripe customer first (comped pro)",
    proSetup.status === 400 && !!proSetup.json.error?.includes("billing account"),
  );
  const proPreview = await raw(admin, "/api/billing/interval/preview?interval=annual");
  check("v3/11 interval preview wants a Stripe customer first (pro)", proPreview.status === 400);
  // Developer API keys must never reach billing: /api/billing/* is session-
  // cookie auth only (never reads Authorization), lives outside /api/v1 and
  // the OpenAPI surface. A Bearer token without a session is a plain 401.
  const bearerOnly = await fetch(`${BASE}/api/billing/setup-intent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer sc_smoke_fake_key",
    },
    body: "{}",
  });
  check(
    "v3/11 API keys can't touch billing routes (401, header ignored)",
    bearerOnly.status === 401,
  );
  const proBilling = await html(admin, `/o/${proOrgSlug}/settings/billing`);
  check(
    "v3/11 billing page renders without the portal button (pro)",
    proBilling.status === 200 &&
      proBilling.body.includes("Plan &amp; Billing") &&
      !proBilling.body.includes("Manage billing →"),
  );
  check(
    "v3/11 manage sections stay hidden without a Stripe customer (pro)",
    // Check the rendered section, not the bare label: the /o DictProvider
    // serializes the whole `ui` dict (incl. "billing.paymentMethods") into the
    // page's flight payload, so the localized string is always present in body.
    !proBilling.body.includes('id="payment-methods"'),
  );
  // Product tour: the Billing and Connect steps highlight real anchors — the
  // plan card on billing, the Stripe card on payments (owner-only).
  check(
    "product tour: billing step anchor present (pro)",
    proBilling.body.includes('data-tour="billing-plan"'),
  );
  const proPayments = await html(admin, `/o/${proOrgSlug}/settings/connect`);
  check(
    "product tour: Connect step anchor present on Connect settings (owner)",
    proPayments.status === 200 && proPayments.body.includes('data-tour="connect-stripe"'),
  );
  // Rename regression (2026-07-18): the old Payments URL must forward to
  // Connect — fetch follows the redirect, so the anchor proves the landing.
  const legacyPayments = await html(admin, `/o/${proOrgSlug}/settings/payments?connect=return`);
  check(
    "legacy /settings/payments redirects to Connect (query preserved)",
    legacyPayments.status === 200 && legacyPayments.body.includes('data-tour="connect-stripe"'),
  );
  const freeCancel = await raw(free, "/api/billing/cancel", "POST", {});
  check("v3/11 cancel wants a Stripe customer first (free)", freeCancel.status === 400);
  const proAddress = await raw(admin, "/api/billing/address", "POST", {
    address: {
      line1: "1 Test Way",
      city: "London",
      postal_code: "SW1A 1AA",
      country: "GB",
    },
  });
  check("v3/11 address update wants a Stripe customer first (pro)", proAddress.status === 400);
  const freePromo = await raw(free, "/api/billing/promo", "POST", {
    code: "NOPE",
  });
  check("v3/11 promo apply wants a Stripe customer first (free)", freePromo.status === 400);
  const freeBilling = await html(free, `/o/${freeOrg.slug}/settings/billing`);
  check(
    "v3/11 billing page renders upgrade path, no portal (free)",
    freeBilling.status === 200 &&
      freeBilling.body.includes("Upgrade to Pro") &&
      !freeBilling.body.includes("Manage billing →"),
  );
  check(
    "product tour: billing step anchor present (free)",
    freeBilling.body.includes('data-tour="billing-plan"'),
  );
}
