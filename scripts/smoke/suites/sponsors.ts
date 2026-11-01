// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  CONNECT_TEST_ACCOUNT, type Session, newSession, call, check, signIn, tag, setConnect, pageRedirect, html, v1, v1data,
} from "../harness.ts";

/** v10 sponsor CRM smoke: tiered manager + public placement + tracked click
 *  on the pro org; free path keeps the flat partner strip and gets 402 on
 *  tiers/packages. Checkout runs the order-first Connect rail; keyless envs
 *  assert the 409 gate + order insert (webhook activation is unit-tested —
 *  smoke can't complete a hosted card payment). */
export async function sponsorsSuite(admin: Session, proOrgId: string, proOrgSlug: string): Promise<void> {
  // --- Pro path: tiers, per-competition scoping, placement, click tracking.
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Cup ${tag}`,
      visibility: "public",
    }),
  );
  const gold = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Goldco ${tag}`,
    tier: "gold",
    url: "https://goldco.example",
  });
  check("sp pro creates a gold sponsor", gold.status === 201);
  const goldId = v1data<{ id: string }>(gold).id;
  const scoped = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`, "POST", {
    name: `Cup Title ${tag}`,
    tier: "title",
    competition_id: comp.id,
  });
  check("sp pro creates a competition-scoped title sponsor", scoped.status === 201);

  const shared = await html(newSession(), `/shared/${proOrgSlug}/${comp.slug}`);
  check(
    "sp public page renders the perimeter board (title leads)",
    shared.status === 200 &&
      shared.body.includes("Presented by") &&
      shared.body.includes(`Cup Title ${tag}`) &&
      shared.body.includes(`Goldco ${tag}`),
  );
  check("sp public logo links via tracked redirect", shared.body.includes(`/s/${goldId}`));

  const click = await pageRedirect(newSession(), `/s/${goldId}`);
  // Response.redirect normalizes the URL (adds the trailing slash).
  check(
    "sp click 302s to the sponsor url",
    click.status === 302 && (click.location ?? "").startsWith("https://goldco.example"),
  );
  // The bump is deferred() tail work — it lands after the 302 by design, so
  // poll briefly instead of racing it (CI runners lose the instant read).
  let clicked = false;
  for (let i = 0; i < 10 && !clicked; i++) {
    const afterClick = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsors`);
    clicked =
      v1data<{ id: string; click_count: number }[]>(afterClick).find((s) => s.id === goldId)
        ?.click_count === 1;
    if (!clicked) await new Promise((r) => setTimeout(r, 300));
  }
  check("sp click_count incremented", clicked);

  // --- Monetization: package + order-first Connect checkout.
  const pkgRes = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-packages`, "POST", {
    name: `Gold Package ${tag}`,
    price_cents: 25_000,
    currency: "gbp",
    tier: "gold",
  });
  check("sp pro creates a package", pkgRes.status === 201);
  const pkg = v1data<{ id: string }>(pkgRes);

  // Connect gate: same refusal as entry fees, before any order row exists.
  await setConnect(proOrgId, false);
  const gated = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: "Gate Probe",
    sponsor_email: `delivered+gate_${tag}@resend.dev`,
  });
  check("sp checkout refused without Connect (409)", gated.status === 409);
  // The one org in the run that gets a REAL connected account, when supplied —
  // stripe_account_id is UNIQUE, so it can only ever be handed to one.
  await setConnect(proOrgId, true, CONNECT_TEST_ACCOUNT);

  const started = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`, "POST", {
    package_id: pkg.id,
    sponsor_name: `Acme ${tag}`,
    sponsor_email: `delivered+acme_${tag}@resend.dev`,
  });
  if (!process.env.STRIPE_SECRET_KEY) {
    // Keyless: the Stripe mint fails AFTER the pending order landed — the
    // order-before-intent rail is still observable below.
    check("sp checkout keyless fails after the order insert", started.status >= 500);
  } else if (!CONNECT_TEST_ACCOUNT) {
    // Keyed but destination-less. A secret key is NOT a proxy for "Connect is
    // usable": the checkout sends setConnect's fabricated acct_smoke_* as
    // transfer_data.destination, which Stripe rejects with resource_missing,
    // so 201 is unreachable no matter how valid the key is. Skip (counting the
    // check, same convention as paymentMethodSuite) rather than assert a
    // failure the fixture — not the app — causes.
    check(
      "sp checkout: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
  } else {
    check(
      "sp checkout starts (order + session url)",
      started.status === 201 && !!v1data<{ checkout_url: string }>(started).checkout_url,
    );
  }
  const orders = await v1(admin, `/api/v1/orgs/${proOrgId}/sponsor-orders`);
  check(
    "sp order row landed pending (order-before-intent)",
    orders.status === 200 &&
      v1data<{ status: string; sponsor_name: string }[]>(orders).some(
        (o) => o.status === "pending" && o.sponsor_name === `Acme ${tag}`,
      ),
  );

  // --- R4 S11: the top-level Sponsors hub. Settings -> Sponsors moved here; the old URL forwards (307, query kept).
  const hubOverview = await html(admin, `/o/${proOrgSlug}/sponsors`);
  check(
    "sp hub answers 200 for an editor and opens on Overview",
    hubOverview.status === 200 && hubOverview.body.includes('data-testid="sponsors-tab-overview"'),
  );
  const hubSponsors = await html(admin, `/o/${proOrgSlug}/sponsors?tab=sponsors`);
  check(
    "sp hub Sponsors tab renders for an editor (the moved tiered manager, not Overview)",
    hubSponsors.status === 200 &&
      hubSponsors.body.includes('data-testid="sponsors-tab-sponsors"') &&
      !hubSponsors.body.includes('data-testid="sponsors-tab-overview"'),
  );
  const hubPackages = await html(admin, `/o/${proOrgSlug}/sponsors?tab=packages`);
  check(
    "sp hub Packages tab renders the sell console for an editor",
    hubPackages.status === 200 &&
      hubPackages.body.includes('data-testid="sponsors-tab-packages"') &&
      hubPackages.body.includes('data-testid="sponsor-packages"'),
  );
  const legacyTab = await pageRedirect(admin, `/o/${proOrgSlug}/settings?tab=sponsors&x=1`);
  check(
    "sp legacy settings?tab=sponsors redirects to the hub's Sponsors tab (second param kept)",
    legacyTab.status === 307 && (legacyTab.location ?? "").endsWith(`/o/${proOrgSlug}/sponsors?tab=sponsors&x=1`),
  );
  const settingsOrg = await pageRedirect(admin, `/o/${proOrgSlug}/settings?tab=organization`);
  check("sp settings?tab=organization does NOT redirect (only the retired tab does)", settingsOrg.status === 200);
  const hubSignedOut = await pageRedirect(newSession(), `/o/${proOrgSlug}/sponsors`);
  check(
    "sp hub is not served to a signed-out visitor",
    hubSignedOut.status >= 300 && hubSignedOut.status < 400 && (hubSignedOut.location ?? "").includes("/login"),
  );

  // --- Free path: flat partner strip stays free; tiers + packages are 402.
  const free = newSession();
  const freeVer = await signIn(free, `delivered+sponsor_free_${tag}@resend.dev`);
  const freeOrgs = (await call(free, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const freeOrg = freeOrgs.find((o) => o.id === freeVer.org_id)!;
  const freeComp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Sponsor Free ${tag}`,
      visibility: "public",
    }),
  );
  const partner = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: `Corner Shop ${tag}`,
    url: "https://corner.example",
  });
  check("sp free adds a partner sponsor", partner.status === 201);
  const freeGold = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsors`, "POST", {
    name: "Blocked Gold",
    tier: "gold",
  });
  check("sp free tiering gated (402)", freeGold.status === 402);
  const freeShared = await html(newSession(), `/shared/${freeOrg.slug}/${freeComp.slug}`);
  check(
    "sp free strip renders publicly, un-tiered",
    freeShared.status === 200 &&
      freeShared.body.includes(`Corner Shop ${tag}`) &&
      !freeShared.body.includes("Presented by"),
  );
  const freePkg = await v1(free, `/api/v1/orgs/${freeOrg.id}/sponsor-packages`, "POST", {
    name: "Blocked Package",
    price_cents: 1_000,
    currency: "gbp",
    tier: "partner",
  });
  check("sp free packages gated (402)", freePkg.status === 402);
  // The hub is not itself gated: a free-plan owner reaches it, and its Packages tab (the upsell) renders rather than 402/404.
  const freeHub = await html(free, `/o/${freeOrg.slug}/sponsors?tab=packages`);
  check(
    "sp hub Packages tab answers 200 on a free org (the gate is the feature, not the page)",
    freeHub.status === 200 && freeHub.body.includes('data-testid="sponsors-tab-packages"'),
  );
}
