import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  CONNECT_TEST_ACCOUNT, newSession, call, check, signIn, tag, setConnect, postPaidRegistrationWebhook, v1, v1data,
  setPlan,
} from "../harness.ts";

/**
 * RS006: a real destination-charge checkout for a registration entry fee —
 * proves the fixture Connect account (STRIPE_CONNECT_TEST_ACCOUNT,
 * scripts/stripe-connect-fixture.ts) wires all the way through: org
 * currency, division fee, destination charge, application fee. Same "the
 * session actually mints" bar the "sp checkout" Connect check above already
 * holds sponsor orders to (search this file for STRIPE_CONNECT_TEST_ACCOUNT),
 * extended one step further into the webhook fulfilment path via
 * postPaidRegistrationWebhook, since Stripe cannot reach localhost and an
 * embedded Checkout page cannot be completed headlessly here either — the
 * same reason postPaidPassWebhook exists for the pass-purchase flow, and
 * exactly the gap seedPaidRegistration's own doc comment names ("the Stripe
 * checkout can't run headless") for the unrelated delete-guard seed below.
 *
 * `organizations.stripe_account_id` carries a partial UNIQUE index — at most
 * one org may hold the real account at a time. The sponsor-orders Connect
 * check earlier in main() claims it for its own org and never releases it,
 * so this suite — which runs later, in main()'s curated tail — releases
 * whichever org currently holds it before claiming it for its own fresh org.
 * That release is a real hand-off, not a discard: whoever held it is
 * remembered and restored when this suite is done, because "whoever holds
 * it" is not always another suite from the SAME run — pointed at a
 * persistent/shared dev DB rather than CI's disposable one, it can be a
 * real, already-onboarded org someone is using right now. Blanking that
 * org's stripe_account_id to null and leaving it there (an earlier version
 * of this suite did exactly that) silently disconnects Stripe Connect for
 * an org this run never touched on purpose — caught by hand, once, against
 * a local rs006 fixture org that lost its connected account this way.
 */
export async function registrationPaidLoopSuite(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) {
    check("reg checkout: skipped (no STRIPE_SECRET_KEY — cannot mint a real session)", true);
    return;
  }
  if (!CONNECT_TEST_ACCOUNT) {
    check(
      "reg checkout: skipped (no STRIPE_CONNECT_TEST_ACCOUNT — destination charge needs a real connected account)",
      true,
    );
    return;
  }

  // v1Suite's own local shape, one section up — no shared GENERIC_CONFIG
  // constant exists in this file.
  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };

  const owner = newSession();
  const who = await signIn(owner, `delivered+regpay_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is required for registrationPaidLoopSuite");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
  const db = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  // Whoever holds the fixture account right now (an earlier suite in this
  // SAME run, or a real org outside this run entirely on a persistent DB) —
  // captured so the finally block below can hand it back rather than leave
  // stripe_account_id null. See this function's own doc comment.
  let previousHolderId: string | null = null;
  try {
    // Defensive sports seed (v1Suite's own fallback, one section up): CI runs
    // sync:sports, but a local run against a DB that hasn't keeps this suite
    // from failing on a missing sport catalog rather than proving anything
    // about the Connect path.
    await db`insert into sports (key, name, module_version, position_catalog)
             values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
             on conflict (key) do nothing`;
    await db`insert into sport_variants (sport_key, key, name, config, is_system)
             values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
             on conflict do nothing`;
    // Release whichever org currently holds the fixture account, then hand
    // it to the fresh org this suite just created. A destination charge's
    // currency must match what the connected account can actually receive —
    // pin the org to gbp, the currency scripts/stripe-connect-fixture.ts's
    // onboarded test account actually settles in, rather than trust
    // whatever a fresh signup defaults to (this repo's default is NOT
    // necessarily gbp).
    const [holder] = await db<{ id: string }[]>`
      select id from organizations where stripe_account_id = ${CONNECT_TEST_ACCOUNT}`;
    previousHolderId = holder?.id ?? null;
    await db`update organizations set stripe_account_id = null where stripe_account_id = ${CONNECT_TEST_ACCOUNT}`;
    await db`update organizations set currency = 'gbp' where id = ${orgId}`;
  } finally {
    await db.end();
  }
  await setConnect(orgId, true, CONNECT_TEST_ACCOUNT);

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Reg Pay Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const settingsRes = await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 1500,
    payment_method: "stripe",
    approval: "auto",
  });
  check("reg checkout: division priced through Stripe", settingsRes.status === 200);

  const submitted = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      contact: { name: `Reg Payer ${tag}`, email: `delivered+regpayer_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: div.id,
          entrant_kind: "individual",
          players: [{ full_name: `Reg Payer ${tag}` }],
          answers: {},
        },
      ],
    },
  );
  type SubmitOut = {
    group_id: string;
    currency: string;
    checkout_url: string | null;
    entries: { registration_id: string; status: string }[];
  };
  const out = v1data<SubmitOut>(submitted);
  check(
    "reg checkout starts (submit + real session url)",
    submitted.status === 201 && !!out?.checkout_url?.startsWith("https://checkout.stripe.com/"),
  );

  // fee_percent isn't in the submit response (PublicRegisterGroupResponse has
  // no such field — createRegistrationCheckout stamps it straight onto the
  // cart) — read back what the mint actually charged, so the synthetic event
  // below carries the SAME rate a real Stripe webhook would echo, not a guess.
  const db2 = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    const [group] = await db2<{ fee_percent: number | null }[]>`
      select fee_percent from registration_groups where id = ${out.group_id}`;
    const webhookStatus = await postPaidRegistrationWebhook({
      groupId: out.group_id,
      registrationIds: out.entries.map((e) => e.registration_id),
      orgId,
      currency: out.currency,
      feePercent: group?.fee_percent ?? 0,
      paymentIntent: `pi_smoke_${tag}_reg`,
    });
    check("reg checkout: webhook fulfilment accepted (200)", webhookStatus === 200);

    const [reg] = await db2<{ status: string; entrant_id: string | null }[]>`
      select status, entrant_id from registrations where group_id = ${out.group_id}`;
    check(
      "reg checkout: entry flips to paid/confirmed and materialises an entrant",
      (reg?.status === "paid" || reg?.status === "confirmed") && !!reg?.entrant_id,
    );
  } finally {
    // Release this suite's own claim, then restore whoever held the fixture
    // account BEFORE this suite ran (captured above) — never just leave it
    // null. A suite added after this one still finds the account free either
    // way: null if nothing held it going in, or held by its rightful owner
    // again if something did. See this function's own doc comment.
    await db2`update organizations set stripe_account_id = null where id = ${orgId}`;
    if (previousHolderId) {
      await db2`update organizations set stripe_account_id = ${CONNECT_TEST_ACCOUNT} where id = ${previousHolderId}`;
    }
    await db2.end();
  }
}
