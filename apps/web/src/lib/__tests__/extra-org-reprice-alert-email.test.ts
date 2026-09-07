// Body copy for the staff alert sent when an extra-organisation rider could not
// be moved onto its group's current price (`maybeAlertOrgRepriceFailed`,
// billing-events.ts).
//
// The copy this file pins used to explain the fault as a TIER ARBITRAGE: "the
// two rates ($9 Pro / $19 Pro Plus) are load-bearing — left on the Pro price, a
// Pro Plus group undercuts the tier ladder". Entitlements v18 (V393) retired
// `pro_plus`, so there is one purchasable plan, one rider rate, and no
// arbitrage reachable at all. A staff member reading the old wording was being
// told to reason about a ladder that no longer exists, and handed two dollar
// figures that no longer appear in any price list.
//
// The fault itself is unchanged and still costs money — a rider left on a stale
// price bills that rate until someone looks, and nothing schedules a retry — so
// this is a rewrite of the WHY, not a downgrade of the alert.
//
// Internal staff alert: NOT localised (it takes no locale/Dict and is composed
// inline in lib/email.ts), so English is the only copy to assert. Asserted
// through the real send path with `fetch` stubbed, like
// pass-credit-reversal-alert-email.test.ts, because the body is built inside
// the send function and there is no separate template export to call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendExtraOrgRepriceFailedAlertEmail } from "../email";

interface SentPayload {
  subject: string;
  html: string;
  text: string;
}

let sent: SentPayload[] = [];
const OLD_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  sent = [];
  process.env.RESEND_API_KEY = "re_test_key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentPayload);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

const base = {
  to: "ops@seazn.test",
  subscriptionId: "sub_group_1",
  stripeSubscriptionId: "sub_stripe_1",
  planKey: "pro",
  itemId: "si_1",
  currentPriceId: "price_old",
  expectedPriceId: "price_new",
  reason: "catalog price not found for pro monthly usd",
};

describe("extra-org reprice failure alert", () => {
  it("names no retired plan and quotes no hardcoded rate", async () => {
    await sendExtraOrgRepriceFailedAlertEmail(base);
    expect(sent).toHaveLength(1);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;

    // The retired plan, in both spellings the codebase has used for it.
    expect(body).not.toMatch(/Pro Plus/i);
    expect(body).not.toContain("pro_plus");
    // The two figures the old copy asserted. They were never read from the
    // price catalog — they were typed — so they were wrong the moment either
    // price moved, and this alert has no currency in scope to derive a
    // correct one with.
    expect(body).not.toContain("$9");
    expect(body).not.toContain("$19");
  });

  it("still reports the fault, and points at the two price ids that ARE the fault", async () => {
    // The positive pair. Without it, every assertion above is satisfied by an
    // alert that says nothing at all — and an alert nobody can act on is worse
    // than one explaining a retired ladder, because it looks fine.
    await sendExtraOrgRepriceFailedAlertEmail(base);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;

    expect(body).toContain("price_old");
    expect(body).toContain("price_new");
    expect(body).toContain("sub_group_1");
    expect(body).toContain(base.reason);
    // …and says the group is being billed wrongly RIGHT NOW, rather than
    // describing a tidiness problem.
    expect(body).toMatch(/rate its plan does not charge/i);
    // …and that nothing will fix it on its own — the sentence that decides
    // whether the ticket gets closed or acted on.
    expect(body).toMatch(/nothing re-converges this group on its own/i);
  });

  it("survives the failure shape where no item or price could be named", async () => {
    // `itemId`/`currentPriceId`/`expectedPriceId` are all nullable — catalog
    // resolution can fail before any item is reached. The copy must still be
    // sendable and must not print "null" at a reader.
    await sendExtraOrgRepriceFailedAlertEmail({
      ...base,
      itemId: null,
      currentPriceId: null,
      expectedPriceId: null,
    });
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;
    expect(body).not.toMatch(/\bnull\b/);
    expect(body).toContain("(unknown)");
    expect(body).toContain("(unresolved)");
  });
});
