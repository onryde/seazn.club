// RS003 W5e — the registrant-facing READ paths: `groupByRef` (RS007's status
// page consumes it) and the two reconcile-on-return paths.
//
// `groupByRef`'s own doc comment makes three SECURITY claims — a wrong token
// and a nonexistent ref throw the identical generic 404, the token compare
// runs either way, and neither the error shape nor the timing discloses
// whether the ref exists. None of the three was tested. A claim in a comment
// that nothing asserts is a claim that quietly stops being true: the ref is a
// short human-typed code (`SZ-XXXX-XXXX`), so "does this ref exist" is exactly
// the oracle an attacker enumerates against, and the payload behind it lists
// every entry and every player name in the cart.
//
// The reconcile paths matter for a different reason: they are the ONLY way a
// registrant returning from Stripe sees their payment reflected when the
// webhook is slow or lost, and 6 of their 8 branches had no coverage at all —
// including both `catch → false` arms, which is what runs when Stripe itself
// is down at exactly the moment the registrant lands back on the page.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { retrieve: stripeMock.retrieve } } }),
}));

// RS007 rebuild: resendRegistrationConfirmationPublic sends through
// sendRegistrationEmail — captured the same way registrations.test.ts
// already does (forwards to the REAL implementation so `{sent}` stays
// realistic; send() is a no-op without RESEND_API_KEY either way), so the
// resolved `args.statusUrl` this function builds is actually observable.
const emailMock = vi.hoisted(() => ({ registration: vi.fn() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendRegistrationEmail: async (opts: Parameters<typeof actual.sendRegistrationEmail>[0]) => {
      emailMock.registration(opts);
      return actual.sendRegistrationEmail(opts);
    },
  };
});

// RS007 follow-up: reconcileRegistrationGroupBySession's own outbound-Stripe
// rate limit. The real limiter is inert without REDIS_URL (unset in this
// environment) — vi.mock so ONE test can force a throttle deterministically,
// while every other test here forwards to the real (inert) implementation
// unchanged.
const rateLimitMock = vi.hoisted(() => ({ throttle: false }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: async (...args: Parameters<typeof actual.rateLimit>) => {
      if (rateLimitMock.throttle) {
        const { HttpError: RateLimitedError } = await import("@/lib/errors");
        throw new RateLimitedError(429, "Too many requests — slow down and try again.");
      }
      return actual.rateLimit(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  groupById,
  groupByRef,
  publicCartByRef,
  reconcileRegistration,
  reconcileRegistrationBySession,
  reconcileRegistrationGroupBySession,
  resendRegistrationConfirmationPublic,
} from "@/server/usecases/registrations";
import { generateRefCode } from "@/lib/ref-code";
import { createDivision, patchDivision } from "../divisions";
import {
  asOwner,
  rig,
  seedOrg,
  seedRegistration,
  seedSecondEntry,
  SETTINGS_BASE,
  stripeRig,
} from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** Refs carry a CHECKSUM (`REF_ALPHABET` payload + 2 check chars), so an
 *  arbitrary-looking string is rejected by `isValidRefCode` before any lookup
 *  happens — it would prove nothing about existence leakage. Both the seeded
 *  ref and the absent one therefore come from the real generator: the absent
 *  one is checksum-VALID but unassigned, which is exactly what an attacker
 *  enumerating the short human-typed code space would be sending. */
function freshRef(): string {
  return generateRefCode();
}

async function stripeSettingsRig() {
  const { orgSlug, orgId, ownerId } = await seedOrg();
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
    values (${division.id}, true, 'individual', 500, 'stripe', 'auto', false)`;
  return { orgSlug, orgId, ownerId, owner, competition, division };
}

beforeEach(() => {
  stripeMock.retrieve.mockReset();
  emailMock.registration.mockReset();
  rateLimitMock.throttle = false;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("groupByRef — token gate", () => {
  it("a real ref with the WRONG token and a nonexistent ref are indistinguishable", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );

    const wrongToken = await groupByRef(refCode, "regtok_" + randomUUID()).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    const absentRef = await groupByRef(freshRef(), "regtok_" + randomUUID()).then(
      () => null,
      (e: unknown) => e as HttpError,
    );

    // Both must be errors at all — a null here would mean one of them RESOLVED.
    expect(wrongToken).toBeInstanceOf(HttpError);
    expect(absentRef).toBeInstanceOf(HttpError);
    // …and byte-identical in every field a caller (or an attacker) can read.
    expect(wrongToken!.status).toBe(404);
    expect(absentRef!.status).toBe(404);
    expect(wrongToken!.message).toBe(absentRef!.message);
    expect(wrongToken!.message).toBe("registration not found");
  });

  it("the correct token returns the cart, so the 404s above are not just a broken read", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode, players: [{ name: "Sam Player" }] },
    );

    const view = await groupByRef(refCode, access_token);
    expect(view.ref_code).toBe(refCode);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]!.players.map((p) => p.full_name)).toEqual(["Sam Player"]);
  });

  it("is case- and spacing-insensitive on the ref, but never on the token", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );

    // The ref is human-typed off an email, so it normalises.
    const view = await groupByRef(` ${refCode.toLowerCase()} `, access_token);
    expect(view.ref_code).toBe(refCode);

    // The token is machine-held and must NOT normalise — a case-flipped token
    // is simply the wrong token.
    await expect(groupByRef(refCode, access_token.toUpperCase())).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a group with zero entries returns an empty entries list rather than querying players", async () => {
    const { competition } = await stripeSettingsRig();
    const refCode = freshRef();
    const rawToken = "regtok_" + randomUUID().replace(/-/g, "");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(rawToken).digest("hex");
    await sql`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash,
         amount_cents, currency, payment_method, ref_code,
         privacy_consent_at, privacy_consent_version)
      values (${competition.id}, 'Empty Cart', 'empty@test.local', ${hash},
              0, 'gbp', null, ${refCode}, now(), 1)`;

    const view = await groupByRef(refCode, rawToken);
    expect(view.entries).toEqual([]);
  });
});

// V379/RS007 — the resolved refund policy groupByRef exposes per entry, so
// the status page can tell a registrant which side of the line they are on
// BEFORE they confirm a cancel. Same rule withdrawCore's auto-refund uses
// (resolveRefundPolicy) — its own pure-logic coverage lives in
// registrations.test.ts ("resolveRefundPolicy (pure, V379/RS007)"); these
// prove it is actually WIRED into this read path, with a real payment
// intent and a real competition row, not just callable in isolation.
describe.skipIf(!HAS_DB)("groupByRef — resolved refund policy (V379/RS007)", () => {
  it("a paid entry with no refund_lock_at falls back to the competition's own starts_on, and reads refundable while that is still ahead", async () => {
    const { competition, division } = await stripeSettingsRig(); // rig()'s default starts_on: 2026-09-15 (future)
    const refCode = freshRef();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    await sql`update registration_groups set payment_intent_id = ${"pi_test_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;
    // The entry's OWN status, not just the cart's payment intent. This test
    // is named "a paid entry" and never made one: `seedRegistration` leaves
    // it `pending`, and it passed only because buildGroupStatusView used to
    // hand the CART's shared payment_intent_id to resolveRefundPolicy for
    // every entry regardless of whether that entry was the one charged —
    // which is money-path defect #1 itself (a promoted-but-unpaid sibling
    // reading `refundable: true` off another entry's real charge, and
    // withdrawCore then refunding against it). So this assertion had frozen
    // the defect as the specification, the same shape as `steps.test.ts`
    // asserting `shouldCollapseEntries(1) === true` before RS007's own
    // entrant-kind ruling. Making the entry genuinely paid restores what
    // the title always claimed to be testing: the starts_on FALLBACK.
    // V387/H1: production stamps the intent on the ENTRY as well as the cart
    // (`confirmPaidRegistration`), and the refund policy now reads the
    // entry's — fail-closed, so a fixture that sets only the cart's models an
    // entry we cannot prove was charged, and correctly gets no automatic
    // refund. Mirror what the real payment path writes.
    await sql`update registrations
              set status = 'paid',
                  payment_intent_id = (
                    select g.payment_intent_id from registration_groups g
                    where g.id = registrations.group_id
                  )
              where id = ${registration.id}`;

    const view = await groupByRef(refCode, access_token);
    const entry = view.entries[0]!;
    expect(entry.refund_policy.refundable).toBe(true);
    expect(entry.refund_policy.amount_cents).toBe(500);
    expect(entry.refund_policy.deadline).toBe(new Date("2026-09-15").toISOString());
  });

  it("falls back to NOT refundable once the competition itself has already started", async () => {
    const { competition, division } = await stripeSettingsRig();
    await sql`update competitions set starts_on = (now() - interval '1 day')::date where id = ${competition.id}`;
    const refCode = freshRef();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    await sql`update registration_groups set payment_intent_id = ${"pi_test_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;

    const view = await groupByRef(refCode, access_token);
    expect(view.entries[0]!.refund_policy.refundable).toBe(false);
  });

  it("an explicit refund_lock_at wins over the starts_on fallback", async () => {
    const { competition, division } = await stripeSettingsRig();
    await sql`update registration_settings set refund_lock_at = '2020-01-01T00:00:00Z'
              where division_id = ${division.id}`;
    const refCode = freshRef();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    await sql`update registration_groups set payment_intent_id = ${"pi_test_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;

    const view = await groupByRef(refCode, access_token);
    const entry = view.entries[0]!;
    // Not the competition's (future) starts_on — the explicit lock, long past.
    expect(entry.refund_policy.refundable).toBe(false);
    expect(entry.refund_policy.deadline).toBe(new Date("2020-01-01T00:00:00Z").toISOString());
  });

  it("amount_cents is the entry's own remaining unrefunded balance, not the original fee", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 1000, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    await sql`update registration_groups set payment_intent_id = ${"pi_test_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;
    await sql`update registrations set refunded_cents = 300 where id = ${registration.id}`;

    const view = await groupByRef(refCode, access_token);
    expect(view.entries[0]!.refund_policy.amount_cents).toBe(700);
  });
});

// RS006 §C — the post-submit status page resolves the group by its DB id
// (`?rid=<group_id>&token=...`, the SAME convention `buildCartMail`'s
// statusUrl and `createRegistrationCheckout`'s Stripe success/cancel URLs
// already use), never by ref_code: `ref_code` is nullable on the schema and
// `rid` is the primary key, always present. Same three security claims as
// groupByRef above, proven the same way.
describe.skipIf(!HAS_DB)("groupById — token gate", () => {
  it("a real group id with the WRONG token and a nonexistent id are indistinguishable", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );

    const wrongToken = await groupById(registration.group_id, "regtok_" + randomUUID()).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    const absentId = await groupById(randomUUID(), "regtok_" + randomUUID()).then(
      () => null,
      (e: unknown) => e as HttpError,
    );

    // Both must be errors at all — a null here would mean one of them RESOLVED.
    expect(wrongToken).toBeInstanceOf(HttpError);
    expect(absentId).toBeInstanceOf(HttpError);
    // …and byte-identical in every field a caller (or an attacker) can read.
    expect(wrongToken!.status).toBe(404);
    expect(absentId!.status).toBe(404);
    expect(wrongToken!.message).toBe(absentId!.message);
    expect(wrongToken!.message).toBe("registration not found");
  });

  it("the correct token returns the cart, so the 404s above are not just a broken read", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef(), players: [{ name: "Sam Player" }] },
    );

    const view = await groupById(registration.group_id, access_token);
    expect(view.ref_code).toBe(registration.ref_code);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]!.players.map((p) => p.full_name)).toEqual(["Sam Player"]);
  });

  it("a malformed id string 404s cleanly rather than throwing a raw DB syntax error", async () => {
    await expect(groupById("not-a-uuid", "regtok_" + randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });
});

// RS007 rebuild — fields the status page needs that the RS006 minimal render
// never selected: this entry's own promotion deadline, whether the org can
// currently take a card payment, and the resolved offline instructions.
describe.skipIf(!HAS_DB)("groupById — widened fields for the status page rebuild (RS007)", () => {
  it("promotion_expires_at is null for a never-promoted entry", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.entries[0]!.promotion_expires_at).toBeNull();
  });

  it("promotion_expires_at surfaces THIS entry's own clock, distinct from the cart's shared expires_at", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    await sql`update registrations set promotion_expires_at = '2026-09-05T12:00:00Z', promoted_at = now()
              where id = ${registration.id}`;
    const view = await groupById(registration.group_id, access_token);
    expect(view.entries[0]!.promotion_expires_at).toBe(new Date("2026-09-05T12:00:00Z").toISOString());
    // The cart's own column is untouched by this raw update — proves the two
    // are genuinely separate columns, not one value read twice.
    expect(view.expires_at).not.toBe(view.entries[0]!.promotion_expires_at);
  });

  it("charges_enabled is true when the org's Connect account is live", async () => {
    const { competition, division } = await stripeRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.charges_enabled).toBe(true);
  });

  it("charges_enabled is false when the org has no live Connect account — gates the pay CTA before resumeRegistrationCheckout would 503", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.charges_enabled).toBe(false);
  });

  it("payment_instructions is null for a stripe-method cart", async () => {
    const { competition, division } = await stripeRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.payment_instructions).toBeNull();
  });

  it("payment_instructions resolves the DIVISION's own override for an offline cart", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`update organizations set payment_instructions = 'org-level fallback text' where id = ${orgId}`;
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, payment_instructions, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, 'offline', 'division-level override text', 'auto', false)`;
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "offline" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.payment_instructions).toBe("division-level override text");
  });

  it("falls back to the ORG's payment_instructions when the division has none", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await sql`update organizations set payment_instructions = 'org-level fallback text' where id = ${orgId}`;
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${division.id}, true, 'individual', 500, 'offline', 'auto', false)`;
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "offline" },
      { refCode: freshRef() },
    );
    const view = await groupById(registration.group_id, access_token);
    expect(view.payment_instructions).toBe("org-level fallback text");
  });

  // A pair's roster is fixed at exactly two (registration-submit.ts's own
  // structural check) — its join_code only ever lets the partner claim
  // their already-typed-in slot; joinTeamEntry 422s a pair's
  // insert-a-new-person path. The status page's generic (no player_id)
  // claim link must not be offered for one.
  it("allows_new_joiner is false for a pair division, true for a team division", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division: pairDivision } = await rig(owner);
    const { division: teamDivision } = await rig(owner);
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${pairDivision.id}, true, 'pair', 500, 'stripe', 'auto', false)`;
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${teamDivision.id}, true, 'team', 500, 'stripe', 'auto', false)`;

    const pairSeed = await seedRegistration(
      competition.id,
      pairDivision.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const teamSeed = await seedRegistration(
      competition.id,
      teamDivision.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );

    const pairView = await groupById(pairSeed.registration.group_id, pairSeed.access_token);
    const teamView = await groupById(teamSeed.registration.group_id, teamSeed.access_token);

    expect(pairView.entries[0]!.allows_new_joiner).toBe(false);
    expect(teamView.entries[0]!.allows_new_joiner).toBe(true);
  });
});

// RS006 (public stepper) — publicCartByRef: the TOKEN-LESS, group-level
// sibling of publicRegistrationStatusByRef/PublicRefView, for the general-
// public /r/[ref] page. Unlike groupByRef/GroupStatusView above (token
// REQUIRED, deliberately unmasked because only the token-holder ever sees
// it), this is reachable by anyone with a bare ref code, so every entry's
// display name must be masked per ITS OWN division's policy — a cart can
// hold an open-division entry alongside a youth-division one, and reusing
// groupByRef here would leak full names to the public off a ref alone.
describe.skipIf(!HAS_DB)("publicCartByRef — token-less, masked cart read", () => {
  it("masks a youth division's entry but not an open division's entry in the SAME cart — SECURITY", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division: openDiv } = await rig(owner);
    const youthDivCreated = await createDivision(owner, competition.id, {
      name: "Under 15",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    // RS007/V380: age band (and the youth flag it derives) is PATCH-only —
    // createDivision no longer accepts a jsonb rule to set it at create
    // time. age_max: 15 < 18 re-derives youth=true (divisions.ts's
    // deriveYouth), which is the property this test actually needs.
    const youthDiv = await patchDivision(owner, youthDivCreated.id, { age_max: 15 });
    await sql`
      insert into registration_settings
        (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, allow_free_agents)
      values (${openDiv.id}, true, 'individual', 500, 'stripe', 'auto', false)`;
    const refCode = freshRef();
    const { registration } = await seedRegistration(
      competition.id,
      openDiv.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode, displayName: "Alex Roberts" },
    );
    await seedSecondEntry(registration.group_id, youthDiv.id, 0, "Jamie Youngperson");

    const view = await publicCartByRef(refCode);
    expect(view.entries).toHaveLength(2);
    const openEntry = view.entries.find((e) => e.division_name === "Open")!;
    const youthEntry = view.entries.find((e) => e.division_name === "Under 15")!;
    // Non-youth, default policy: unmasked.
    expect(openEntry.display_name).toBe("Alex Roberts");
    // Youth, default policy (no explicit player_name_display override):
    // first_initial — this is the exact leak a whole-cart-shares-one-mask
    // bug would miss, since the OTHER entry in this same cart is full.
    expect(youthEntry.display_name).toBe("Jamie Y.");
  });

  it("returns every entry in the cart, in creation order — not just the oldest", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode, displayName: "First Entry" },
    );
    await seedSecondEntry(registration.group_id, division.id, 500, "Second Entry", "waitlisted");
    await seedSecondEntry(registration.group_id, division.id, 500, "Third Entry", "confirmed");

    const view = await publicCartByRef(refCode);
    expect(view.entries.map((e) => e.display_name)).toEqual([
      "First Entry",
      "Second Entry",
      "Third Entry",
    ]);
    expect(view.entries.map((e) => e.status)).toEqual(["pending", "waitlisted", "confirmed"]);
  });

  it("404s on an unknown ref, same contract as the single-entry sibling", async () => {
    await expect(publicCartByRef(freshRef())).rejects.toMatchObject({ status: 404 });
  });

  it("never exposes contact info, amounts, currency or payment method", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode, contactEmail: "secret-contact@test.local" },
    );

    const view = await publicCartByRef(refCode);
    const json = JSON.stringify(view);
    expect(json).not.toContain("secret-contact@test.local");
    expect(json).not.toMatch(/contact_email|contact_name|amount_cents|"currency"|payment_method|access_token/i);
  });

  it("can_withdraw is true only with the correct token — a wrong or missing token is false", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );

    expect((await publicCartByRef(refCode)).can_withdraw).toBe(false);
    expect((await publicCartByRef(refCode, "regtok_wrong")).can_withdraw).toBe(false);
    expect((await publicCartByRef(refCode, access_token)).can_withdraw).toBe(true);
  });

  // RS006 follow-up (data-integrity fix): can_withdraw used to be a single
  // cart-level flag evaluated against ONE entry (the oldest) — its own doc
  // comment admitted this. A multi-entry cart showed one undifferentiated
  // Withdraw control with no way to tell which row it would act on. Withdraw
  // is per-entry now, so each entry states its OWN eligibility.
  it("each entry's can_withdraw reflects its OWN status, not the oldest entry's — the exact bug this fixes", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode, displayName: "Singles" },
    );
    // Second entry (younger, so NOT the oldest regByRef would pick) already
    // withdrawn — with a valid cart-level token throughout.
    const second = await seedSecondEntry(registration.group_id, division.id, 500, "Doubles", "withdrawn");

    const view = await publicCartByRef(refCode, access_token);
    const first = view.entries.find((e) => e.id === registration.id)!;
    const withdrawnEntry = view.entries.find((e) => e.id === second.id)!;
    expect(first.can_withdraw).toBe(true);
    expect(withdrawnEntry.can_withdraw).toBe(false);
    // Cart-level can_withdraw is token validity alone now — not tied to any
    // one entry's status (that would just relocate the same bug).
    expect(view.can_withdraw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconcile-on-return. These run when the registrant lands back from Stripe
// before the webhook did (or when it never arrives — local dev, a dropped
// delivery). Both are documented "best-effort; never throws", and 6 of their 8
// branches had no coverage: every early `return false`, and BOTH `catch` arms,
// which is precisely what runs when Stripe is unreachable at the moment the
// registrant returns. A reconcile that threw there would surface a 500 on the
// page of someone who has just successfully paid.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("reconcileRegistration — token-gated return", () => {
  async function pendingStripeCart() {
    const { competition, division } = await stripeSettingsRig();
    const seeded = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    await sql`update registration_groups set checkout_session_id = ${"cs_test_" + randomUUID().slice(0, 8)}
              where id = ${seeded.registration.group_id}`;
    return seeded;
  }

  it("returns false for a wrong token, without ever calling Stripe", async () => {
    const { registration } = await pendingStripeCart();
    expect(await reconcileRegistration(registration.id, "rg_" + randomUUID())).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
  });

  it("returns false when the cart has no checkout session yet, without calling Stripe", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    expect(await reconcileRegistration(registration.id, access_token)).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
  });

  it("returns false when the entry is no longer pending", async () => {
    const { registration, access_token } = await pendingStripeCart();
    await sql`update registrations set status = 'withdrawn' where id = ${registration.id}`;
    expect(await reconcileRegistration(registration.id, access_token)).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
  });

  it("returns false when Stripe reports the session still unpaid", async () => {
    const { registration, access_token } = await pendingStripeCart();
    stripeMock.retrieve.mockResolvedValueOnce({
      id: "cs_test_x",
      payment_status: "unpaid",
      metadata: { kind: "registration_group", registration_ids: registration.id },
    });
    expect(await reconcileRegistration(registration.id, access_token)).toBe(false);
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("pending");
  });

  // The documented "never throws" contract. Without the catch this returns a
  // rejected promise and the status page 500s for someone who has just paid.
  it("swallows a Stripe outage and returns false rather than throwing", async () => {
    const { registration, access_token } = await pendingStripeCart();
    stripeMock.retrieve.mockRejectedValueOnce(new Error("stripe unreachable"));
    await expect(reconcileRegistration(registration.id, access_token)).resolves.toBe(false);
  });
});

describe.skipIf(!HAS_DB)("reconcileRegistrationBySession — token-free /r/[ref] return", () => {
  it("returns false when the session does not name this registration", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    // A paid session for somebody ELSE's cart. The ref is only a lookup; the
    // session's own metadata is the proof, so this must not confirm.
    stripeMock.retrieve.mockResolvedValueOnce({
      id: "cs_test_other",
      payment_status: "paid",
      metadata: { kind: "registration_group", registration_ids: randomUUID() },
    });
    expect(await reconcileRegistrationBySession(refCode, "cs_test_other")).toBe(false);
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("pending");
  });

  it("swallows a Stripe outage and returns false rather than throwing", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    stripeMock.retrieve.mockRejectedValueOnce(new Error("stripe unreachable"));
    await expect(reconcileRegistrationBySession(refCode, "cs_test_boom")).resolves.toBe(false);
  });

  // Security fix (RS006): /r/[ref] is public, unauthenticated, and
  // force-dynamic — `sessionId` here is a raw, attacker-controlled query
  // param. Before this fix it reached `sessions.retrieve(sessionId)`
  // unconditionally, so anyone holding a ref whose oldest entry is `pending`
  // could loop `GET /r/{ref}?session_id=cs_test_anything` and drive one real
  // Stripe API call per request, billed to the PLATFORM account. The fix
  // compares the supplied id against the cart's OWN stored
  // `checkout_session_id` before ever calling Stripe.
  it("an attacker-supplied session_id that isn't this cart's own stored session must NOT reach Stripe", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    // This cart's REAL, current session — deliberately different from what
    // gets supplied below.
    await sql`update registration_groups set checkout_session_id = ${"cs_test_owncart_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;

    const result = await reconcileRegistrationBySession(refCode, "cs_test_attacker_supplied");

    expect(result).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("pending");
  });

  it("the cart's OWN stored session id still reconciles", async () => {
    const { competition, division } = await stripeSettingsRig();
    const refCode = freshRef();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode },
    );
    const ownSessionId = "cs_test_owncart_" + randomUUID().slice(0, 8);
    await sql`update registration_groups set checkout_session_id = ${ownSessionId}
              where id = ${registration.group_id}`;
    stripeMock.retrieve.mockResolvedValueOnce({
      id: ownSessionId,
      payment_status: "paid",
      metadata: { kind: "registration_group", registration_ids: registration.id },
    });

    const result = await reconcileRegistrationBySession(refCode, ownSessionId);

    expect(result).toBe(true);
    expect(stripeMock.retrieve).toHaveBeenCalledWith(ownSessionId);
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// RS007 rebuild — the status page's own group-keyed reconcile. Same security
// posture as reconcileRegistrationBySession above (the supplied session_id is
// checked against the group's OWN stored checkout_session_id before Stripe is
// ever called), but keyed on the group's DB id + the emailed access token —
// never ref_code, which is nullable — matching groupById's own lookup.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("reconcileRegistrationGroupBySession — rid+token return (RS007)", () => {
  it("returns false for a wrong token, without ever calling Stripe", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    await sql`update registration_groups set checkout_session_id = ${"cs_test_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;
    expect(
      await reconcileRegistrationGroupBySession(registration.group_id, "rg_" + randomUUID(), "cs_test_x"),
    ).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
  });

  it("returns false when the cart has no checkout session yet, without calling Stripe", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    expect(
      await reconcileRegistrationGroupBySession(registration.group_id, access_token, "cs_test_x"),
    ).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
  });

  it("a malformed group id returns false rather than throwing a raw DB syntax error", async () => {
    await expect(
      reconcileRegistrationGroupBySession("not-a-uuid", "rg_" + randomUUID(), "cs_test_x"),
    ).resolves.toBe(false);
  });

  // The same security fix reconcileRegistrationBySession carries: sessionId is
  // an attacker-controlled query param on a public, force-dynamic page.
  it("an attacker-supplied session_id that isn't this cart's own stored session must NOT reach Stripe", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    await sql`update registration_groups set checkout_session_id = ${"cs_test_owncart_" + randomUUID().slice(0, 8)}
              where id = ${registration.group_id}`;

    const result = await reconcileRegistrationGroupBySession(
      registration.group_id,
      access_token,
      "cs_test_attacker_supplied",
    );

    expect(result).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("pending");
  });

  // RS007 follow-up: this URL (?checkout=success&session_id=...) sits in
  // browser history and referrers — every qualifying GET on the status page
  // called this unconditionally, one outbound checkout.sessions.retrieve
  // per hit, unbounded. Fulfilment is already idempotent
  // (confirmPaidRegistration no-ops on an already-paid row), so the fix is a
  // limiter, not a pending pre-check — this function deliberately has NO
  // "is some entry still pending" gate (see its own doc comment above: that
  // would refuse to even look at Stripe for a genuinely-paid multi-entry
  // cart whose representative entry happens to already be settled).
  it("a rate-limited reconcile skips Stripe entirely and returns false — even for a token/session pair that WOULD have confirmed it", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const ownSessionId = "cs_test_owncart_" + randomUUID().slice(0, 8);
    await sql`update registration_groups set checkout_session_id = ${ownSessionId}
              where id = ${registration.group_id}`;
    // Configured to SUCCEED if reached — proves the limiter itself is what
    // blocks this, not an incidental Stripe failure.
    stripeMock.retrieve.mockResolvedValueOnce({
      id: ownSessionId,
      payment_status: "paid",
      metadata: { kind: "registration_group", registration_ids: registration.id },
    });
    rateLimitMock.throttle = true;

    const result = await reconcileRegistrationGroupBySession(registration.group_id, access_token, ownSessionId);

    expect(result).toBe(false);
    expect(stripeMock.retrieve).not.toHaveBeenCalled();
    const [row2] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row2!.status).toBe("pending"); // never confirmed — the call never reached Stripe
  });

  it("swallows a Stripe outage and returns false rather than throwing", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const ownSessionId = "cs_test_owncart_" + randomUUID().slice(0, 8);
    await sql`update registration_groups set checkout_session_id = ${ownSessionId}
              where id = ${registration.group_id}`;
    stripeMock.retrieve.mockRejectedValueOnce(new Error("stripe unreachable"));
    await expect(
      reconcileRegistrationGroupBySession(registration.group_id, access_token, ownSessionId),
    ).resolves.toBe(false);
  });

  it("the cart's OWN stored session id, with the correct token, confirms the entry", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    const ownSessionId = "cs_test_owncart_" + randomUUID().slice(0, 8);
    await sql`update registration_groups set checkout_session_id = ${ownSessionId}
              where id = ${registration.group_id}`;
    stripeMock.retrieve.mockResolvedValueOnce({
      id: ownSessionId,
      payment_status: "paid",
      metadata: { kind: "registration_group", registration_ids: registration.id },
    });

    const result = await reconcileRegistrationGroupBySession(registration.group_id, access_token, ownSessionId);

    expect(result).toBe(true);
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${registration.id}`;
    expect(row!.status).toBe("confirmed");
  });

  // The reason this function exists as its OWN thing rather than reusing
  // reconcileRegistrationBySession: that function's ref-based lookup reads
  // ONE representative (oldest) entry's status as a pre-check gate. A
  // promotion mints a checkout for a single entry (V378) — in a multi-entry
  // cart where an EARLIER entry already settled (confirmed) but a LATER one
  // was just promoted and paid, gating on the oldest entry's status would
  // refuse to even look at Stripe. This function has no such gate — it
  // trusts handleRegistrationCheckoutCompleted's own per-id idempotent
  // confirm loop to do the right thing regardless of sibling state.
  it("still confirms the paid entry even when an EARLIER sibling in the same cart already settled", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef(), status: "confirmed" },
    );
    const promoted = await seedSecondEntry(registration.group_id, division.id, 500, "Second Entry", "pending");
    const ownSessionId = "cs_test_owncart_" + randomUUID().slice(0, 8);
    await sql`update registration_groups set checkout_session_id = ${ownSessionId}
              where id = ${registration.group_id}`;
    stripeMock.retrieve.mockResolvedValueOnce({
      id: ownSessionId,
      payment_status: "paid",
      metadata: { kind: "registration_group", registration_ids: promoted.id },
    });

    const result = await reconcileRegistrationGroupBySession(registration.group_id, access_token, ownSessionId);

    expect(result).toBe(true);
    const [row] = await sql<{ status: string }[]>`select status from registrations where id = ${promoted.id}`;
    expect(row!.status).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------
// RS007 rebuild — the registrant self-service resend of the cart's
// confirmation email, the token-gated sibling of the organiser-only
// resendRegistrationConfirmation. Cart-scoped (the mail is cart-shaped): it
// refuses only when EVERY entry in the cart is terminal, never when one
// arbitrarily-picked entry happens to be.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("resendRegistrationConfirmationPublic (RS007)", () => {
  it("a wrong token 404s, matching every other public token-gated action", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );
    await expect(
      resendRegistrationConfirmationPublic(registration.group_id, "rg_" + randomUUID(), "https://test.local"),
    ).rejects.toMatchObject({ status: 404 });
    expect(emailMock.registration).not.toHaveBeenCalled();
  });

  it("refuses once EVERY entry in the cart is terminal", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef(), status: "withdrawn" },
    );
    await expect(
      resendRegistrationConfirmationPublic(registration.group_id, access_token, "https://test.local"),
    ).rejects.toMatchObject({ status: 422 });
    expect(emailMock.registration).not.toHaveBeenCalled();
  });

  it("attempts the send when the cart has at least one still-active entry, even if an ARBITRARY other one is terminal", async () => {
    const { competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef(), status: "withdrawn" },
    );
    await seedSecondEntry(registration.group_id, division.id, 500, "Still Active", "pending");

    // Whether the provider itself reports success depends on RESEND_API_KEY
    // being configured in the environment (lib/email.ts) — not this
    // function's own logic, which is what "reached the real send" proves.
    await resendRegistrationConfirmationPublic(registration.group_id, access_token, "https://test.local");

    expect(emailMock.registration).toHaveBeenCalledTimes(1);
  });

  // Unlike the organiser path (which never holds the plaintext token past
  // submit — only its hash survives), THIS path is called from the very page
  // that already has it in the URL. It should thread the real token through
  // so the resent mail's statusUrl is the full rid+token page, not the
  // masked /r/[ref] fallback buildCartMail uses when token is null.
  it("threads the REAL token through so the resent mail links back to the full rid+token status page", async () => {
    const { orgSlug, competition, division } = await stripeSettingsRig();
    const { registration, access_token } = await seedRegistration(
      competition.id,
      division.id,
      { ...SETTINGS_BASE, fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { refCode: freshRef() },
    );

    await resendRegistrationConfirmationPublic(registration.group_id, access_token, "https://test.local");

    expect(emailMock.registration).toHaveBeenCalledTimes(1);
    const args = emailMock.registration.mock.calls[0]![0] as { statusUrl: string };
    expect(args.statusUrl).toBe(
      `https://test.local/shared/${orgSlug}/${competition.slug}/register/status?rid=${registration.group_id}&token=${access_token}`,
    );
  });
});
