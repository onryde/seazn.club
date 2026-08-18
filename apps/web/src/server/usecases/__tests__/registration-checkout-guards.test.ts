// RS003 W5c — branch coverage for createRegistrationCheckout's early-return
// and error guards (registrations.ts ~1265-1408), reached exclusively
// through its two live callers, mintGroupCheckout and (where noted)
// sweepRegistrations. Real Postgres required; skipped without DATABASE_URL.
//
// Two of the guards below (:1277 empty entries, :1280 subtotal<=0) turned
// out to be UNREACHABLE via a single, non-concurrent call to
// mintGroupCheckout or resumeRegistrationCheckout: both callers re-derive
// the exact id list/amount they hand down from a FRESH read taken moments
// earlier (mintGroupCheckout's own `payable` SELECT filters
// `amount_cents > 0`; resumeRegistrationCheckout re-checks
// `reg.amount_cents <= 0` itself before ever calling in) — so for a single
// call, the values createRegistrationCheckout re-queries are structurally
// identical to what the caller already validated. Nothing in this codebase
// ever deletes a `registrations` row or changes its `amount_cents` outside
// these guarded paths (`git grep -a "delete from registrations"` over
// apps/web/src is empty), so the ONLY way either guard can fire for real is
// a genuine race between a caller's read and createRegistrationCheckout's
// own re-query a moment later — two non-transactional, non-locking SELECTs
// with an `await divisionCtx(...)` gap between them. `payableRaceRig` below
// simulates exactly that gap deterministically (no timing/flakiness risk):
// it intercepts mintGroupCheckout's own `payable` SELECT specifically and,
// as a side effect, mutates the just-read row(s) for real before letting
// createRegistrationCheckout's later re-query see the changed state. It is
// a one-shot, file-scoped `@/lib/db` wrap that is a complete passthrough
// for every other query in this file (see the `payableRaceRig.action`
// check inside the `apply` trap) — verified by every other test in this
// file behaving identically to the unwrapped `sql`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripeMock = vi.hoisted(() => {
  const checkoutCreate = vi.fn();
  return {
    checkoutCreate,
    stripe: { checkout: { sessions: { create: checkoutCreate } } },
  };
});
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock.stripe }));

type PayableRow = { id: string };
type RealSql = typeof import("@/lib/db").sql;
type PayableRaceAction = (rows: PayableRow[], realSql: RealSql) => Promise<void>;

/** Armed by exactly ONE test at a time, right before it calls
 *  mintGroupCheckout; consumed (reset to null) the first time the wrapped
 *  `sql` below sees the query it's waiting for. `beforeEach` also clears it,
 *  so a test that fails before arming/consuming never leaks into the next. */
const payableRaceRig: { action: PayableRaceAction | null } = { action: null };

/** Mirrors @/lib/db.ts's own (unexported) `isTaggedTemplate` — a tagged-
 *  template call's first argument is a TemplateStringsArray (an array with
 *  a `.raw` property); a fragment-builder call (`sql(someArray)`,
 *  `r.id in ${sql(ids)}`) is a plain array and must NOT be treated as SQL
 *  text to scan. */
function isTaggedTemplateCall(args: unknown[]): args is [TemplateStringsArray, ...unknown[]] {
  const first = args[0];
  return Array.isArray(first) && "raw" in (first as object);
}

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const wrapped = new Proxy(actual.sql, {
    apply(target, _thisArg, args: unknown[]) {
      // postgres.js's callable client has overloaded call signatures TS
      // can't express generically here — same cast @/lib/db.ts's own proxy
      // uses for the identical reason.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (target as any)(...args) as Promise<unknown>;
      if (
        payableRaceRig.action &&
        isTaggedTemplateCall(args) &&
        args[0].join("").includes("status = 'pending' and amount_cents > 0")
      ) {
        const action = payableRaceRig.action;
        payableRaceRig.action = null; // one-shot
        return (result as Promise<PayableRow[]>).then(async (rows) => {
          await action(rows, actual.sql);
          return rows;
        });
      }
      return result;
    },
    get(target, prop) {
      return Reflect.get(target, prop, target);
    },
  });
  return { ...actual, sql: wrapped };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { mintGroupCheckout, sweepRegistrations } from "../registrations";
import { stripeRig, seedRegistration, loadWithGroup } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

beforeEach(() => {
  stripeMock.checkoutCreate.mockReset().mockImplementation(async () => ({
    id: "cs_test_" + randomUUID().slice(0, 8),
    url: "https://checkout.stripe.test/session",
  }));
  payableRaceRig.action = null;
});

// ---------------------------------------------------------------------------
// createRegistrationCheckout — guards that ARE independently reachable via
// mintGroupCheckout with an ordinary (non-raced) DB state: :1305
// (stripe_account_id missing), :1357 (no session.url), and the
// checkout_session_id stamp ordering.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("createRegistrationCheckout — guards reachable via ordinary state (RS003 W5c)", () => {
  it("charges_enabled TRUE but stripe_account_id NULL (a half-finished Connect onboarding) 503s from createRegistrationCheckout's own guard, not mintGroupCheckout's (:1305)", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    // stripeRig sets stripe_charges_enabled AND stripe_account_id together,
    // like every existing fixture — clear ONLY the account id, so
    // mintGroupCheckout's own ctx.charges_enabled guard (:1398) stays green
    // and this reaches createRegistrationCheckout's guard specifically.
    await sql`update organizations set stripe_account_id = null where id = ${orgId}`;
    const first = await seedRegistration(competition.id, division.id, settings);

    const outcome = mintGroupCheckout(
      first.registration.group_id,
      division.id,
      "http://test.local",
      first.access_token,
    );
    await expect(outcome).rejects.toMatchObject({
      status: 503,
      message: "Payments are not set up for this organiser yet",
    });
    await expect(outcome).rejects.toBeInstanceOf(HttpError);
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("a Stripe session with no url 502s (:1357)", async () => {
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings);
    const sessionWithoutUrl: { id: string; url: string | undefined } = {
      id: "cs_test_no_url",
      url: undefined,
    };
    stripeMock.checkoutCreate.mockResolvedValueOnce(sessionWithoutUrl);

    await expect(
      mintGroupCheckout(first.registration.group_id, division.id, "http://test.local", first.access_token),
    ).rejects.toMatchObject({ status: 502, message: "Stripe did not return a checkout URL" });
  });

  it("checkout_session_id stays null when Stripe throws — the stamp happens ONLY after Stripe returns (:1360)", async () => {
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(new Error("stripe unreachable"));

    await expect(
      mintGroupCheckout(first.registration.group_id, division.id, "http://test.local", first.access_token),
    ).rejects.toThrow("stripe unreachable");

    const group = await loadWithGroup(first.registration.id);
    expect(group.checkout_session_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mintGroupCheckout's OWN guards — :1391 (unknown group) and :1398
// (charges_enabled), the latter proven distinct from
// resumeRegistrationCheckout's identically-shaped guard (already covered,
// via resumeRegistrationCheckout, in registrations.test.ts).
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("mintGroupCheckout — own guards (RS003 W5c)", () => {
  it("an unknown group id resolves to null — no throw, no Stripe call (:1391)", async () => {
    const { division } = await stripeRig();
    await expect(
      mintGroupCheckout(randomUUID(), division.id, "http://test.local", "faketoken"),
    ).resolves.toBeNull();
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });

  it("mintGroupCheckout's OWN charges_enabled guard 503s (:1398)", async () => {
    const { orgId, competition, division, settings } = await stripeRig();
    await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
    const first = await seedRegistration(competition.id, division.id, settings);

    await expect(
      mintGroupCheckout(first.registration.group_id, division.id, "http://test.local", first.access_token),
    ).rejects.toMatchObject({ status: 503, message: "Payments are not set up for this organiser yet" });
    expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createRegistrationCheckout — the token===null return-URL branch
// (:1308-1311). Neither mintGroupCheckout nor resumeRegistrationCheckout can
// reach this: both declare `token: string` (not nullable) and always forward
// their own real token verbatim. The only two real callers that pass
// `null` are notifyPromoted (waitlist promotion emails) and
// sweepRegistrations (payment reminder emails) — sweepRegistrations is used
// here since it exposes the Stripe call args directly via the mock, with no
// need to also mock the email sender.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("createRegistrationCheckout — token===null return-URL shape, via sweepRegistrations (RS003 W5c)", () => {
  it("a system-minted (token===null) session returns the token-free /r/[ref] URL, not the status-page shape (:1308-1311)", async () => {
    const { competition, division, settings } = await stripeRig();
    // Random suffix — a fixed literal ref code collides with a leftover row
    // from a prior run of this same test (registration_groups.ref_code is
    // UNIQUE), unlike every other fixture value here which is randomUUID-
    // suffixed for exactly this reason.
    const refCode = "TESTREF" + randomUUID().slice(0, 8).toUpperCase();
    const first = await seedRegistration(competition.id, division.id, settings, { refCode });
    // seedRegistration's own stripeWindow logic sets a 48h deadline — force
    // it inside the reminder sweep's T-24h window; reminded_at stays null
    // from the insert.
    await sql`
      update registration_groups
      set expires_at = now() + interval '2 hours'
      where id = ${first.registration.group_id}`;

    const result = await sweepRegistrations("http://test.local");
    expect(result.reminded).toBe(1);

    const args = stripeMock.checkoutCreate.mock.calls[0]![0] as {
      success_url: string;
      cancel_url: string;
    };
    expect(args.success_url).toBe(
      `http://test.local/r/${refCode}?src=email&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    );
    expect(args.cancel_url).toBe(`http://test.local/r/${refCode}?src=email&checkout=cancelled`);
    // Never the token-bearing status-page shape a user-initiated resume/mint uses.
    expect(args.success_url).not.toContain("/register/status");
  });
});

// ---------------------------------------------------------------------------
// createRegistrationCheckout — guards unreachable via a single, non-raced
// call (see the file-header comment): :1277 (empty/mismatched entries) and
// :1280 (subtotal<=0), simulated via payableRaceRig.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)(
  "createRegistrationCheckout — guards only reachable via a caller/re-query race (RS003 W5c)",
  () => {
    it("a registration deleted between mintGroupCheckout's payable read and the re-validated select 422s 'No registrations to pay for' (:1277)", async () => {
      const { competition, division, settings } = await stripeRig();
      const first = await seedRegistration(competition.id, division.id, settings);

      payableRaceRig.action = async (rows, realSql) => {
        for (const row of rows) {
          await realSql`delete from registrations where id = ${row.id}`;
        }
      };

      await expect(
        mintGroupCheckout(first.registration.group_id, division.id, "http://test.local", first.access_token),
      ).rejects.toMatchObject({ status: 422, message: "No registrations to pay for" });
      expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    });

    it("a registration's fee dropping to 0 between mintGroupCheckout's payable read and the re-validated select 422s createRegistrationCheckout's OWN 'no entry fee' guard, not a caller's redundant precheck (:1280)", async () => {
      const { competition, division, settings } = await stripeRig();
      const first = await seedRegistration(competition.id, division.id, settings);

      payableRaceRig.action = async (rows, realSql) => {
        for (const row of rows) {
          await realSql`update registrations set amount_cents = 0 where id = ${row.id}`;
        }
      };

      await expect(
        mintGroupCheckout(first.registration.group_id, division.id, "http://test.local", first.access_token),
      ).rejects.toMatchObject({ status: 422, message: "This registration has no entry fee" });
      expect(stripeMock.checkoutCreate).not.toHaveBeenCalled();
    
});
  },
);

describe.skipIf(!HAS_DB)("createRegistrationCheckout — Stripe error translation (RS003 live-probe finding)", () => {
  // Found by the LIVE per-currency probe, not by any mocked test: Stripe
  // refuses a session whose total converts to under its platform minimum
  // (~30p here). Reachable in gbp with a fee set too low — the registrant
  // would otherwise meet a raw Stripe error on the public pay page, the exact
  // outcome owner ruling 4's currency check exists to prevent.
  it("translates Stripe's amount_too_small into a clean 422, not a raw Stripe error", async () => {
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(
      Object.assign(
        new Error("The Checkout Session's total amount must convert to at least 30 pence."),
        { code: "amount_too_small" },
      ),
    );
    await expect(
      mintGroupCheckout(
        first.registration.group_id,
        division.id,
        "https://x.test",
        first.access_token,
      ),
    ).rejects.toMatchObject({ status: 422, code: "REGISTRATION_AMOUNT_TOO_SMALL" });
  });

  // The translation must stay narrow: a blanket catch would hide real
  // integration failures behind a friendly message.
  it("does NOT translate an unrelated Stripe failure", async () => {
    const { competition, division, settings } = await stripeRig();
    const first = await seedRegistration(competition.id, division.id, settings);
    stripeMock.checkoutCreate.mockRejectedValueOnce(
      Object.assign(new Error("api key expired"), { code: "api_key_expired" }),
    );
    await expect(
      mintGroupCheckout(
        first.registration.group_id,
        division.id,
        "https://x.test",
        first.access_token,
      ),
    ).rejects.toThrow("api key expired");
  });
});
