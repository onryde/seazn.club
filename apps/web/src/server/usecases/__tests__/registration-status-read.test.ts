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

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  groupById,
  groupByRef,
  publicCartByRef,
  reconcileRegistration,
  reconcileRegistrationBySession,
} from "@/server/usecases/registrations";
import { generateRefCode } from "@/lib/ref-code";
import { createDivision } from "../divisions";
import {
  asOwner,
  rig,
  seedOrg,
  seedRegistration,
  seedSecondEntry,
  SETTINGS_BASE,
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
    const youthDiv = await createDivision(owner, competition.id, {
      name: "Under 15",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [{ kind: "age", maxAgeAt: 15 }],
    });
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
