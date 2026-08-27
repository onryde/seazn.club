// Payment-integrity fix: expiring a superseded checkout session on re-mint.
//
// createRegistrationCheckout overwrites registration_groups.checkout_session_id
// every time it mints (mintGroupCheckout, resumeRegistrationCheckout,
// sweepRegistrations) — before this fix nothing ever expired the session it
// replaced, so a registrant clicking "Pay now" twice (an abandoned tab
// resumed, a reminder email re-minting the still-open first session) left a
// SECOND live, payable Stripe session behind. Paying both is already handled
// (confirmPaidRegistration's kind:"duplicate" auto-refund path), but the
// registrant still sees two charges and a refund days later — preventing the
// second charge is better than reversing it.
//
// This file exercises resumeRegistrationCheckout specifically (the "Pay now"
// retry path the gap describes), through the real createRegistrationCheckout,
// with a mocked Stripe client. The second test is the regression this design
// exists to avoid: a cart can legitimately hold two open sessions covering
// DISJOINT entry subsets at once (a waitlist promotion pays for one entry
// while its siblings are separately payable — createRegistrationCheckout's
// own `registrationIds` parameter is exactly this, an explicit subset, not
// always the whole cart), but registration_groups has only ONE
// checkout_session_id column, shared by the whole cart — so the "prior"
// session this reads back could belong to a sibling entry's own, still-
// legitimate mint. Expiring unconditionally on that column's old value would
// strand a legitimate, still-payable sibling session.
//
// Design correction (post-review): the ORIGINAL predicate above expired the
// prior session on any INTERSECTION with the new mint's ids — which ALSO
// fires on a PARTIAL overlap and strands whatever the prior session covered
// that the new mint doesn't (the exact waitlist-promotion shape the previous
// paragraph describes: S1 covers {A,B}, A is promoted and S2 mints for {A}
// alone — the intersection check expired S1 outright and B lost its only
// payable link). The two tests below the existing pair prove the corrected
// SUBSUMPTION predicate: expire only when the new mint's ids are a superset
// of (or equal to) the prior session's own ids. They drive mintGroupCheckout
// as well as resumeRegistrationCheckout, since a superset re-mint (a
// single-entry prior session followed by a whole-cart re-mint) needs the
// multi-id path.
//
// Real Postgres required; skipped without DATABASE_URL (matches every
// sibling usecase suite in this directory).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";

// vi.mock is hoisted per-module and does not travel through an import (same
// note as every sibling registration suite's own header) — declared here,
// not in _registration-fixtures.ts.
const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  const checkoutRetrieve = vi.fn();
  const checkoutExpire = vi.fn();
  return {
    checkoutCreate,
    checkoutRetrieve,
    checkoutExpire,
    stripe: {
      checkout: {
        sessions: { create: checkoutCreate, retrieve: checkoutRetrieve, expire: checkoutExpire },
      },
    },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

import { resumeRegistrationCheckout, mintGroupCheckout } from "../registrations";
import { stripeRig, seedRegistration, seedSecondEntry, loadWithGroup } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** Minimal shape `checkout.sessions.retrieve` resolves to for these tests:
 *  `status` plus the same `registration_ids` metadata shape
 *  createRegistrationCheckout stamps on every session it mints. */
function openSession(id: string, registrationIds: string[]): Stripe.Checkout.Session {
  return {
    id,
    status: "open",
    metadata: { registration_ids: registrationIds.join(",") },
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  let n = 0;
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_supersede_" + ++n + "_" + randomUUID().slice(0, 6),
    url: "https://checkout.stripe.test/session",
  }));
  stripeMock.checkoutRetrieve.mockReset();
  stripeMock.checkoutExpire.mockReset().mockResolvedValue({ id: "expired" });
});

describe.skipIf(!HAS_DB)(
  "createRegistrationCheckout — expires a superseded session on re-mint (payment-integrity fix)",
  () => {
    it("re-minting the SAME entry's checkout expires the prior still-open session", async () => {
      const { competition, division, settings } = await stripeRig();
      const first = await seedRegistration(competition.id, division.id, settings, { amountCents: 500 });

      // First-ever mint for this cart: no prior session to supersede.
      await resumeRegistrationCheckout(first.registration.id, first.access_token, "http://test.local");
      expect(stripeMock.checkoutRetrieve).not.toHaveBeenCalled();
      expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
      const firstSessionId = (await loadWithGroup(first.registration.id)).checkout_session_id!;
      expect(firstSessionId).toBeTruthy();

      // Registrant clicks "Pay now" again on the SAME entry — the prior
      // session (firstSessionId) is still open and covers exactly this id.
      stripeMock.checkoutRetrieve.mockResolvedValueOnce(
        openSession(firstSessionId, [first.registration.id]),
      );

      await resumeRegistrationCheckout(first.registration.id, first.access_token, "http://test.local");

      expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(firstSessionId);
      expect(stripeMock.checkoutExpire).toHaveBeenCalledWith(firstSessionId);
      const group = await loadWithGroup(first.registration.id);
      expect(group.checkout_session_id).not.toBe(firstSessionId); // overwritten with the new session
    });

    it("re-minting a DIFFERENT, disjoint entry in the same cart does NOT expire the sibling's still-open session", async () => {
      const { competition, division, settings } = await stripeRig();
      const a = await seedRegistration(competition.id, division.id, settings, {
        displayName: "Entry A",
        amountCents: 500,
      });
      const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");

      // Mint A's own session — the cart's ONE checkout_session_id column now
      // holds A's session id.
      await resumeRegistrationCheckout(a.registration.id, a.access_token, "http://test.local");
      const sessionA = (await loadWithGroup(a.registration.id)).checkout_session_id!;

      stripeMock.checkoutRetrieve.mockResolvedValueOnce(openSession(sessionA, [a.registration.id]));

      // B shares A's group/access token (seedSecondEntry attaches to the same
      // cart) — resuming B's own, separate, still-payable entry must not
      // touch A's legitimately distinct session.
      await resumeRegistrationCheckout(b.id, a.access_token, "http://test.local");

      // The check DID run (this isn't vacuously skipped) — it just decided,
      // correctly, that A's own ids don't intersect B's.
      expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(sessionA);
      expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
    });

    it("re-minting a SUPERSET of a prior session's entries expires the prior session — nothing is stranded", async () => {
      const { competition, division, settings } = await stripeRig();
      const a = await seedRegistration(competition.id, division.id, settings, {
        displayName: "Entry A",
        amountCents: 500,
      });
      await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");

      // Prior session covers A ALONE.
      await resumeRegistrationCheckout(a.registration.id, a.access_token, "http://test.local");
      const sessionA = (await loadWithGroup(a.registration.id)).checkout_session_id!;
      stripeMock.checkoutRetrieve.mockResolvedValueOnce(openSession(sessionA, [a.registration.id]));

      // Re-mint for the WHOLE cart (both pending, payable entries): every id
      // the prior session covered (A) is also covered by the new mint, so
      // nothing is stranded — the corrected predicate must expire it.
      await mintGroupCheckout(a.registration.group_id, division.id, "http://test.local", a.access_token);

      expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(sessionA);
      expect(stripeMock.checkoutExpire).toHaveBeenCalledWith(sessionA);
      const group = await loadWithGroup(a.registration.id);
      expect(group.checkout_session_id).not.toBe(sessionA); // overwritten with the new (whole-cart) session
    });

    it("re-minting a PARTIAL subset of a prior session's entries leaves it alone — the uncovered sibling keeps its only payable link", async () => {
      const { competition, division, settings } = await stripeRig();
      const a = await seedRegistration(competition.id, division.id, settings, {
        displayName: "Entry A",
        amountCents: 500,
      });
      const b = await seedSecondEntry(a.registration.group_id, division.id, 500, "Entry B");

      // Prior session covers the WHOLE cart, {A,B}.
      await mintGroupCheckout(a.registration.group_id, division.id, "http://test.local", a.access_token);
      const sessionAB = (await loadWithGroup(a.registration.id)).checkout_session_id!;
      stripeMock.checkoutRetrieve.mockResolvedValueOnce(
        openSession(sessionAB, [a.registration.id, b.id]),
      );

      // A alone is re-minted (e.g. re-priced, or promoted and paying on its
      // own) — B's only payable link is still sessionAB, so expiring it here
      // would strand B exactly as the file-header bug describes.
      await resumeRegistrationCheckout(a.registration.id, a.access_token, "http://test.local");

      expect(stripeMock.checkoutRetrieve).toHaveBeenCalledWith(sessionAB);
      expect(stripeMock.checkoutExpire).not.toHaveBeenCalled();
      // The cart's checkout_session_id still moves to the new session — only
      // the EXPIRE decision differs, never the stamp itself.
      const group = await loadWithGroup(a.registration.id);
      expect(group.checkout_session_id).not.toBe(sessionAB);
    });
  },
);
