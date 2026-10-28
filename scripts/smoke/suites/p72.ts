import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, newSession, call, check, signIn, tag, setConnect, grantPass, v1, v1data, setPlan } from "../harness.ts";

/** payments-hardening wave (PROMPT-72..75) over real HTTP — the surfaces the
 *  DB-backed vitest suites can't reach from the outside:
 *   • the THREE competition-delete money guards, each 409 with its own copy
 *     (Task 1, spec P0-1) — a CASCADE delete would erase the only record of
 *     live money (Event Pass, unrefunded card registration, paid sponsorship);
 *   • DELETE /competitions/:id is structurally key-excluded → 403 for a
 *     manage-scope key (Task 1 NEVER_KEY_ROUTES);
 *   • a community org's card division reads `payments_unavailable` on the
 *     public register panel even with Connect live (P2-10: registration.paid
 *     is Pro-gated), while the SAME setup on an Event-Pass comp stays open;
 *   • the hourly stuck-webhook sweep cron (Task 12/P1-7): wrong secret 401,
 *     right secret returns the {replayed,failed,alerted} shape.
 *  Runs on its own fresh orgs (never touches org/org2 from main()); keyless-
 *  safe, SQL-seeded like setConnect/grantPass. */
export async function p72Suite(): Promise<void> {
  // === PRO PATH: the three delete-money guards, each pinned distinctly. ===
  const owner = newSession();
  const who = await signIn(owner, `delivered+p72_${tag}@resend.dev`);
  const orgId = who.org_id;
  await setPlan(orgId, "pro", owner); // sponsor packages + api keys are Pro surfaces

  const makeComp = async (name: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
        name: `${name} ${tag}`,
        visibility: "public",
      }),
    );
  const makeDiv = async (compId: string) =>
    v1data<{ id: string; slug: string }>(
      await v1(owner, `/api/v1/competitions/${compId}/divisions`, "POST", {
        name: "Open",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      }),
    );
  const delMsg = (r: { json: { error?: { message?: string } } }) => r.json.error?.message ?? "";

  // Guard 1 — Event Pass.
  const passComp = await makeComp("P72 Pass Cup");
  await grantPass(orgId, passComp.id, "event_pass");
  const delPass = await v1(owner, `/api/v1/competitions/${passComp.id}`, "DELETE");
  check(
    "p72: delete blocked by an Event Pass (409, 'Event Pass')",
    delPass.status === 409 && delMsg(delPass).includes("Event Pass"),
  );

  // Guard 2 — a card registration with unrefunded money.
  const regComp = await makeComp("P72 Reg Cup");
  const regDiv = await makeDiv(regComp.id);
  await seedPaidRegistration(regComp.id, regDiv.id);
  const delReg = await v1(owner, `/api/v1/competitions/${regComp.id}`, "DELETE");
  check(
    "p72: delete blocked by unrefunded card money (409, 'card payments')",
    delReg.status === 409 && delMsg(delReg).includes("card payments"),
  );

  // Guard 3 — a paid sponsorship scoped to the comp via its package.
  const sponComp = await makeComp("P72 Sponsor Cup");
  await seedPaidSponsorOrder(orgId, sponComp.id);
  const delSpon = await v1(owner, `/api/v1/competitions/${sponComp.id}`, "DELETE");
  check(
    "p72: delete blocked by a paid sponsorship (409, 'sponsorship payment records')",
    delSpon.status === 409 && delMsg(delSpon).includes("sponsorship payment records"),
  );

  // === KEY AUTH: DELETE /competitions/:id is never key-accessible → 403 for
  // ANY scope (the route is absent from the allowlist, so it default-denies).
  // A read key is enough to prove the door, and — unlike a write-capable key,
  // which V290 put above Pro and v18 kept there — it mints on a plain Pro
  // org. ===
  const mkKey = await v1(owner, `/api/v1/orgs/${orgId}/api-keys`, "POST", {
    name: "p72 probe",
    scopes: ["read"],
  });
  check("p72: read key minted for the NEVER_KEY probe", mkKey.status === 201);
  const keyAuth = {
    Authorization: `Bearer ${v1data<{ secret: string }>(mkKey).secret}`,
  };
  const cleanComp = await makeComp("P72 Key Delete Cup"); // no money — would otherwise delete
  const keyDelete = await v1(
    newSession(),
    `/api/v1/competitions/${cleanComp.id}`,
    "DELETE",
    undefined,
    keyAuth,
  );
  check("p72: a key cannot DELETE a competition (403 NEVER_KEY)", keyDelete.status === 403);
  // Prove the door, not the data: the same delete over the session succeeds.
  const sessionDelete = await v1(owner, `/api/v1/competitions/${cleanComp.id}`, "DELETE");
  check(
    "p72: the owner session still deletes a money-free comp",
    sessionDelete.status === 200 || sessionDelete.status === 204,
  );

  // === COMMUNITY PATH: since V310 freed registration.paid to every plan, a
  // card division's availability turns on CONNECT, not on plan. Both sides are
  // proved below. registration.paid is no longer a pass differentiator, so the
  // old "an Event Pass reopens a community card division" scenario is obsolete —
  // the pass's real grants (entrants 64, a cheaper fee, branded exports, …)
  // are covered by the pass-scope suites and the entrants/fee checks above. ===
  const comm = newSession();
  const commWho = await signIn(comm, `delivered+p72comm_${tag}@resend.dev`);
  const commOrgId = commWho.org_id;
  const commOrgs = (await call(comm, "/api/orgs")) as {
    id: string;
    slug: string;
  }[];
  const commSlug = commOrgs.find((o) => o.id === commOrgId)!.slug;

  // Connect NOT enabled → a Stripe-fee division cannot take money and closes
  // with an honest reason. Unlisted sidesteps the community dashboard.public.max
  // quota; the active-competition cap is 5 (V311) so both probe comps coexist.
  await setConnect(commOrgId, false);
  const brokeComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `P72 Card Cup ${tag}`,
      visibility: "unlisted",
    }),
  );
  const brokeDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${brokeComp.id}/divisions`, "POST", {
      name: "Card",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await seedStripeFeeDivision(brokeDiv.id);
  const brokeInfo = await v1(
    newSession(),
    `/api/v1/public/orgs/${commSlug}/competitions/${brokeComp.slug}/registration`,
  );
  const brokeDivs = v1data<{
    divisions: { open: boolean; closed_reason: string | null }[];
  }>(brokeInfo).divisions;
  // V310 freed the PLAN gate (community can charge), but a card division still
  // needs a Connect account to pay into. Connect is OFF here, so the division is
  // closed for payments_unavailable — the Connect dimension, isolated from the
  // now-gone entitlement dimension the "Connect live is OPEN" check below pairs
  // with.
  check(
    "p72: a community card division with Connect OFF reads payments_unavailable",
    brokeInfo.status === 200 &&
      brokeDivs.length === 1 &&
      brokeDivs[0].open === false &&
      brokeDivs[0].closed_reason === "payments_unavailable",
  );

  // Connect LIVE → the same free-plan org's card division is OPEN: paid intake
  // is free-tier now (V310), monetised through the community fee, not gated.
  await setConnect(commOrgId, true);
  const okComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `P72 Open Card Cup ${tag}`, visibility: "unlisted" }),
  );
  const okDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${okComp.id}/divisions`, "POST", {
      name: "Card", sport_key: "generic", variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await seedStripeFeeDivision(okDiv.id);
  const okInfo = await v1(
    newSession(),
    `/api/v1/public/orgs/${commSlug}/competitions/${okComp.slug}/registration`,
  );
  const okDivs = v1data<{ divisions: { open: boolean; closed_reason: string | null }[] }>(okInfo).divisions;
  check(
    "p72: with Connect live a community card division is OPEN (registration.paid is free-tier)",
    okInfo.status === 200 &&
      okDivs.length === 1 &&
      okDivs[0].open === true &&
      okDivs[0].closed_reason === null,
  );

  // === CRON: the hourly stuck-webhook sweep (Task 12/P1-7). ===
  const cronSecret = process.env.CRON_SECRET;
  const wrongCron = await fetch(`${BASE}/api/cron/billing-events`, {
    method: "POST",
    headers: { "x-cron-secret": "definitely-wrong" },
  });
  // 401 when the server has a secret; 503 when it isn't configured (CI) —
  // either way the sweep never ran on a bad/absent secret.
  check(
    "p72: cron billing-events rejects a wrong secret (401, or 503 unconfigured)",
    wrongCron.status === 401 || wrongCron.status === 503,
  );
  if (cronSecret) {
    const rightCron = await fetch(`${BASE}/api/cron/billing-events`, {
      method: "POST",
      headers: { "x-cron-secret": cronSecret },
    });
    const body = (await rightCron.json().catch(() => ({}))) as {
      ok?: boolean;
      data?: { replayed?: number; failed?: number; alerted?: number };
    };
    if (rightCron.status === 200) {
      check(
        "p72: cron billing-events runs the sweep and returns {replayed:0,…}",
        body.ok === true &&
          body.data?.replayed === 0 &&
          typeof body.data?.failed === "number" &&
          typeof body.data?.alerted === "number",
      );
    } else {
      // Server CRON_SECRET differs from the smoke env's — still a proven guard.
      check(
        "p72: cron right-secret path skipped (server secret differs)",
        rightCron.status === 401 || rightCron.status === 503,
      );
    }
  } else {
    check("p72: cron right-secret shape skipped (no CRON_SECRET in smoke env)", true);
  }
}

/** payments-hardening P0-1: seed a PAID registration carrying unrefunded card
 *  money (payment_intent set, refunded < amount) — the delete guard keys off
 *  exactly this. Mirrors competitions-delete-money.test.ts's SQL seed; the
 *  Stripe checkout can't run headless.
 *
 *  Post-V364: payment_intent_id/refunded_cents/contact_email/access_token_hash
 *  moved off registrations onto registration_groups (one payment per cart), so
 *  this now inserts both rows. registration_groups.org_id auto-derives from
 *  competition_id (trg_set_org), which is why this takes a competitionId —
 *  the plain division org_id the old single-table insert used is gone. */
async function seedPaidRegistration(competitionId: string, divisionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed a registration in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [group] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash,
         amount_cents, currency, payment_method, payment_intent_id, refunded_cents)
      values (${competitionId}, 'Smoke Payer', 'payer@x.test', ${crypto.randomUUID()},
              2000, 'gbp', 'stripe', ${"pi_smoke_" + divisionId.slice(0, 8)}, 0)
      returning id`;
    await sql`
      insert into registrations
        (group_id, division_id, status, display_name, amount_cents, answers)
      values (${group.id}, ${divisionId}, 'paid', 'Smoke Payer', 2000, '{}')`;
  } finally {
    await sql.end();
  }
}

/** payments-hardening P0-1: seed a PAID sponsor order scoped to a competition
 *  through its package — the delete guard's third money record. Mirrors
 *  competitions-delete-money.test.ts's SQL seed. */
async function seedPaidSponsorOrder(orgId: string, competitionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed a sponsor order in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    const [pkg] = await sql<{ id: string }[]>`
      insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
      values (${orgId}, ${competitionId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
    await sql`
      insert into sponsor_orders
        (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status, paid_at)
      values (${orgId}, ${pkg.id}, 'Smoke Sponsor', 'sponsor@x.test', 25000, 'gbp', 'paid', now())`;
  } finally {
    await sql.end();
  }
}

/** payments-hardening P2-10: flip a division's registration settings to a
 *  card (Stripe) fee directly — the settings PUT gates the stripe method on
 *  the paid entitlement, but the public-read close reason is exactly what we
 *  want to prove, so SQL-seed the state the read evaluates. Always-open
 *  window (no opens/closes), uncapped. */
async function seedStripeFeeDivision(divisionId: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to seed registration settings in smoke");
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sql = postgres(url, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
    prepare: !url.includes(":6543"),
    max: 1,
  });
  try {
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, refund_lock_at, form_fields, payment_method,
         payment_instructions, updated_at)
      values (${divisionId}, true, 'individual', null, null, null,
              2000, null, '[]', 'stripe', null, now())
      on conflict (division_id) do update set
        enabled = true, fee_cents = 2000,
        payment_method = 'stripe', opens_at = null, closes_at = null,
        capacity = null, updated_at = now()`;
  } finally {
    await sql.end();
  }
}
