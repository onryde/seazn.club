// Shared seeding/harness fixtures for the registration usecase test suite
// (RS003 W5a). Extracted from registrations.test.ts so sibling suites can
// reuse them instead of duplicating them — a helper left defined in both
// places drifts. Every export below is a byte-identical move: same body,
// same behaviour, only `export` added (plus, where useful, a named result
// type so a caller gets a real type instead of relying on bare inference).
//
// The Stripe `vi.mock("@/lib/stripe", …)` itself does NOT live here and
// never should: vi.mock is hoisted per-module, so a mock declared in an
// imported helper would not apply to the importing test file. Any fixture
// that needs the mocked client's call-recording handle takes it as a
// parameter instead of importing one — none of the helpers below need it.
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { LEGAL_VERSION } from "@/lib/legal";
import type { Currency } from "@/lib/currency";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  putRegistrationSettings,
  hashRegistrationToken,
  REGISTRATION_TOKEN_PREFIX,
  type RegistrationRow,
  type RegistrationWithGroupRow,
} from "../registrations";

export async function makeUser(name: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`${name}-${randomUUID().slice(0, 8)}@test.local`}, ${name}, true)
    returning id`;
  return id;
}

export async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{
  orgId: string;
  orgSlug: string;
  ownerId: string;
}> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = await makeUser("owner");
  const orgSlug = "reg-org-" + suffix;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Reg Org " + suffix}, ${orgSlug}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score',
            ${sql.json({ resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false })},
            true)
    on conflict do nothing`;
  return { orgId, orgSlug, ownerId };
}
export type SeedOrgResult = Awaited<ReturnType<typeof seedOrg>>;

export const asOwner = (orgId: string, userId: string): AuthCtx => ({
  orgId,
  via: "session",
  userId,
  role: "owner",
  keyId: null,
});

export async function rig(
  owner: AuthCtx,
  opts: { eligibility?: Record<string, unknown>[]; startsOn?: string } = {},
) {
  const competition = await createCompetition(owner, {
    name: "Reg Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: opts.startsOn ?? "2026-09-15",
    ends_on: "2026-09-20",
  });
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: opts.eligibility ?? [],
  });
  return { competition, division };
}
export type RigResult = Awaited<ReturnType<typeof rig>>;

/** r.* ∪ g.* — same join `regGroupCols` builds internally (not exported).
 *  Kept in exact column-list sync with it by the schema tests in
 *  registration-schema.test.ts, which pin every column on both tables.
 *  `g.refunded_cents` is aliased to `group_refunded_cents` (V368) so it never
 *  collides with `r.refunded_cents` — see the block comment above
 *  `RegistrationWithGroupRow` in registrations.ts. */
export async function loadWithGroup(regId: string): Promise<RegistrationWithGroupRow> {
  const [row] = await sql<RegistrationWithGroupRow[]>`
    select r.id, r.division_id, r.org_id, r.status, r.display_name, r.answers,
           r.amount_cents, r.refunded_cents, r.entrant_id, r.promoted_at, r.withdrawn_at,
           r.group_id, r.join_code, r.free_agent, r.created_at, r.updated_at,
           g.contact_name, g.contact_email, g.user_id, g.locale, g.ref_code,
           g.access_token_hash, g.currency, g.payment_method, g.checkout_session_id,
           g.payment_intent_id, g.expires_at, g.reminded_at,
           g.refunded_cents as group_refunded_cents,
           g.refunded_at, g.disputed_at, g.dispute_id, g.offline_marked_paid_at,
           g.offline_marked_paid_by, g.fee_percent, g.privacy_consent_at,
           g.privacy_consent_version
    from registrations r join registration_groups g on g.id = r.group_id
    where r.id = ${regId}`;
  return row;
}

/** Attaches a SECOND entry to an existing cart (group) — reproduces what a
 *  multi-entry cart will look like once RS002/RS003 ship group submit
 *  (design §3). No such flow exists yet, so this seeds directly, the same
 *  way seedRegistration reproduces submitRegistration's single-entry write. */
export async function seedSecondEntry(
  groupId: string,
  divisionId: string,
  amountCents: number,
  displayName: string,
  status: RegistrationRow["status"] = "pending",
): Promise<RegistrationWithGroupRow> {
  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, status, amount_cents)
    values (${groupId}, ${divisionId}, ${displayName}, ${status}, ${amountCents})
    returning id`;
  return loadWithGroup(reg.id);
}

/**
 * `submitRegistration` is deleted (RS001 registration demolition) — the
 * public submit route stays closed until RS002/RS003 ship the new
 * group-shaped cart flow (design §4). Every usecase exercised BELOW submit
 * (confirm, refund, waitlist, dispute, sweep, export, .ics…) is untouched and
 * still needs its regression coverage, so this seeds an equivalent
 * single-entry cart DIRECTLY — registration_groups → registrations →
 * registration_players, the V363/V364 shape — reproducing exactly what
 * `submitRegistration` used to write for one entry. It does NOT reproduce
 * submitRegistration's OWN decision logic (eligibility gate, form-answer
 * validation, privacy-consent gate, window/capacity checks, ref minting) —
 * those are gone with it; RS002/RS003 own re-testing them against the new
 * flow. `checkout_url` is always null here — a test that needs a live Stripe
 * session calls the surviving `resumeRegistrationCheckout` explicitly.
 */
export async function seedRegistration(
  competitionId: string,
  divisionId: string,
  settings: { fee_cents: number; currency: string; payment_method: "offline" | "stripe" },
  over: {
    displayName?: string;
    contactEmail?: string;
    status?: RegistrationRow["status"];
    amountCents?: number;
    answers?: Record<string, unknown>;
    players?: {
      name: string;
      dob?: string | null;
      gender?: string | null;
      squadNumber?: number | null;
    }[];
    locale?: string | null;
    refCode?: string | null;
  } = {},
): Promise<{ registration: RegistrationWithGroupRow; access_token: string; checkout_url: null }> {
  const rawToken = REGISTRATION_TOKEN_PREFIX + randomUUID().replace(/-/g, "");
  const status = over.status ?? "pending";
  // Waitlisted rows hold amount 0 and no pay window — same invariant
  // `promoteOldestWaitlisted` relies on (registrations.ts:624).
  const waitlisted = status === "waitlisted";
  const amountCents = waitlisted ? 0 : (over.amountCents ?? settings.fee_cents);
  const method = waitlisted ? null : settings.payment_method;
  const stripeWindow = !waitlisted && method === "stripe" && amountCents > 0 && status === "pending";
  const displayName = over.displayName ?? "Alex Test";

  const [group] = await sql<{ id: string }[]>`
    insert into registration_groups
      (competition_id, contact_name, contact_email, access_token_hash,
       amount_cents, currency, payment_method, expires_at, locale, ref_code,
       privacy_consent_at, privacy_consent_version)
    values (
      ${competitionId}, ${displayName}, ${over.contactEmail ?? "alex@test.local"},
      ${hashRegistrationToken(rawToken)},
      ${amountCents}, ${settings.currency}, ${method},
      ${stripeWindow ? sql`now() + interval '48 hours'` : null},
      ${over.locale ?? null}, ${over.refCode ?? null},
      now(), ${LEGAL_VERSION}
    )
    returning id`;

  const [reg] = await sql<{ id: string }[]>`
    insert into registrations (group_id, division_id, display_name, status, amount_cents, answers)
    values (
      ${group.id}, ${divisionId}, ${displayName}, ${status}, ${amountCents},
      ${sql.json((over.answers ?? {}) as never)}
    )
    returning id`;

  for (const p of over.players ?? []) {
    await sql`
      insert into registration_players (registration_id, full_name, dob, gender, squad_number, source)
      values (
        ${reg.id}, ${p.name}, ${p.dob ?? null}, ${p.gender ?? null},
        ${p.squadNumber ?? null}, 'captain_entered'
      )`;
  }

  const row = await loadWithGroup(reg.id);
  return { registration: row, access_token: rawToken, checkout_url: null };
}
export type SeedRegistrationResult = Awaited<ReturnType<typeof seedRegistration>>;

/** Builds a group checkout session (RS003 W3a/W3b metadata shape). Accepts
 *  either a single registration id (the common single-entry case — nearly
 *  every existing call site) or an array for a multi-entry cart; either way
 *  `metadata.registration_ids` is the comma-joined list
 *  `handleRegistrationCheckoutCompleted` actually reads. */
export function fakeSession(
  regId: string | string[],
  amount: number,
  feePercent?: number,
): Stripe.Checkout.Session {
  const ids = Array.isArray(regId) ? regId : [regId];
  return {
    id: "cs_test_" + ids[0].slice(0, 8),
    payment_intent: "pi_test_" + ids[0].slice(0, 8),
    payment_status: "paid",
    amount_total: amount,
    // The session carries the rate it was billed at, exactly as
    // createRegistrationCheckout stamps it (V312).
    metadata: {
      kind: "registration_group",
      registration_group_id: "rg_group_test_" + ids[0].slice(0, 8),
      registration_ids: ids.join(","),
      ...(feePercent === undefined ? {} : { fee_percent: String(feePercent) }),
    },
  } as unknown as Stripe.Checkout.Session;
}

export const SETTINGS_BASE = {
  enabled: true,
  entrant_kind: "individual" as const,
  opens_at: null,
  closes_at: null,
  capacity: null,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
};

export async function stripeRig(opts: { capacity?: number | null; feeCents?: number } = {}) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  await sql`update organizations
            set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
            where id = ${orgId}`;
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    payment_method: "stripe",
    fee_cents: opts.feeCents ?? 500,
    capacity: opts.capacity ?? null,
  });
  return { orgId, orgSlug, ownerId, owner, competition, division, settings };
}
export type StripeRigResult = Awaited<ReturnType<typeof stripeRig>>;

/** Same shape as stripeRig (above), but pins the org's CURRENT currency to an
 *  explicit value instead of leaving it at V365's 'gbp' default, so the
 *  matrix below can seed a group whose snapshot matches ctx.currency for
 *  every member of REGISTRATION_CURRENCIES. Kept as its own helper rather
 *  than adding a currency opt to stripeRig, so this fixture carries zero
 *  risk to stripeRig's ~30 existing callers. */
export async function currencyRig(currency: Currency) {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const stripeAccountId = "acct_" + randomUUID().slice(0, 8);
  await sql`update organizations
            set stripe_charges_enabled = true, stripe_account_id = ${stripeAccountId}, currency = ${currency}
            where id = ${orgId}`;
  const { competition, division } = await rig(owner);
  return { orgId, orgSlug, owner, competition, division, stripeAccountId };
}
export type CurrencyRigResult = Awaited<ReturnType<typeof currencyRig>>;
