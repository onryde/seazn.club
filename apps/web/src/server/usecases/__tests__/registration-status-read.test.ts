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
  groupByRef,
  reconcileRegistration,
  reconcileRegistrationBySession,
} from "@/server/usecases/registrations";
import { generateRefCode } from "@/lib/ref-code";
import { asOwner, rig, seedOrg, seedRegistration, SETTINGS_BASE } from "./_registration-fixtures";

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
