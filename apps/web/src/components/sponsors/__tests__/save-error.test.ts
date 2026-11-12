// Final review D3: the Sponsors hub's writes (the On stream tab's tick and dial, Share report's create and revoke) show the
// DICTIONARY's words for a refusal, never the server's English sentence. ONE map, components/sponsors/save-error.ts, keyed on
// the v1 envelope's machine code; a code it does not know reads the house fallback (`settings.saveFailed`).
//
// Expected values: the codes are the envelope's own (`statusCode` in server/api-v1/http.ts, read back below through the real
// handler for each status), and every key must exist in all four locales.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { HttpError } from "@/lib/errors";
import { SPONSOR_REFUSAL_CODES, sponsorRefusal, type SponsorRefusalCode } from "@/lib/sponsor-refusals";
import { v1 } from "@/server/api-v1/http";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { GO_LIVE_RULES, PAYMENT_METHODS } from "@/lib/sponsor-deals";
import { createDealWrite, SAVE_ERROR_BY_WRITE, SAVE_ERROR_FALLBACK_MSG, SAVE_ERROR_MSG, sponsorSaveErrorKey, type SponsorWrite } from "../save-error";

const LOCALES = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as Record<string, Record<string, string>>;

/** The machine code the REAL v1 handler answers an HttpError of `status` with. */
async function codeFor(status: number): Promise<string> {
  const res = await v1(async () => {
    throw new HttpError(status, "the server's own sentence");
  });
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("sponsorSaveErrorKey - the envelope's code, to the dictionary", () => {
  it("each status the hub's routes refuse with maps to its own key, through the code the real handler sends (count reported)", async () => {
    const cases: Array<[number, string]> = [
      [400, "sponsors.error.invalid"],
      [401, "sponsors.error.signedOut"],
      [403, "sponsors.error.forbidden"],
      [404, "sponsors.error.notFound"],
      [429, "sponsors.error.rateLimited"],
    ];
    let checked = 0;
    for (const [status, key] of cases) {
      const code = await codeFor(status);
      expect(sponsorSaveErrorKey(new ApiV1Error("the server's own sentence", status, code)), `${status} ${code}`).toBe(key);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("EVERY code the sponsor, package and deal routes refuse with - enumerated from the server's own list - reaches the client verbatim and reads its own words (count reported)", async () => {
    // Batch F review m2: the codes are no longer typed here. They come from SPONSOR_REFUSAL_CODES, the one list the server's
    // coded refusals are built from (`sponsorRefusal`, whose `code` is typed against it), so a code added to the server joins
    // this sweep and goes red here until it has words. The expected words per code are this test's own reading of what each
    // refusal means (typed against the same list, so a new code also needs an entry below).
    const EXPECTED: Record<SponsorRefusalCode, string> = {
      sponsor_locked_by_deal: "sponsors.error.lockedByDeal",
      sponsor_has_open_deal: "sponsors.error.hasOpenDeal",
      sponsor_dispute_parked: "sponsors.error.disputeParked",
      sponsor_has_deal_history: "sponsors.error.hasDealHistory",
      sponsor_has_open_checkout: "sponsors.error.hasOpenCheckout",
      package_retired: "sponsors.error.packageRetired",
      scope_outside_package: "sponsors.error.scopeOutsidePackage",
      competition_finished: "sponsors.error.competitionFinished",
      connect_required: "sponsors.error.connectRequired",
      sponsor_email_required: "sponsors.error.emailRequired",
      ends_on_in_past: "sponsors.error.endsOnInPast",
      deal_already_paid: "sponsors.error.dealAlreadyPaid",
      deal_ended: "sponsors.error.dealEnded",
      deal_not_payable: "sponsors.error.dealNotPayable",
      deal_not_awaiting_approval: "sponsors.error.notAwaitingApproval",
      deal_not_refundable: "sponsors.error.notRefundable",
      deal_disputed: "sponsors.error.dealDisputed",
      deal_not_invoiceable: "sponsors.error.notInvoiceable",
      // An offline invoice with no billing email (Task 23, F13), and Write off with nothing still due.
      no_billing_email: "sponsors.error.noBillingEmail",
      deal_nothing_due: "sponsors.error.nothingDue",
      // The org's daily invoice-email cap (T23 review m7): its own words, never the shared rate-limit line.
      invoice_send_limit: "sponsors.error.invoiceSendLimit",
      deal_changed: "sponsors.error.dealChanged",
      // Mark as paid's refusal (F37). Resend's own sentence is a per-write override, below.
      deal_paid_online: "sponsors.error.dealPaidOnline",
      on_payment_needs_payment: "sponsors.error.needsPayment",
      // A transition the deal no longer allows: it moved under the action, the same words as deal_changed.
      illegal_transition: "sponsors.error.dealChanged",
      stripe_unavailable: "sponsors.error.stripeUnavailable",
    };
    expect(SPONSOR_REFUSAL_CODES.length, "anti-vacuity: the server lists its codes").toBeGreaterThan(0);
    let checked = 0;
    for (const code of SPONSOR_REFUSAL_CODES) {
      const res = await v1(async () => {
        throw sponsorRefusal(409, "the server's own sentence", code);
      });
      const sent = ((await res.json()) as { error: { code: string } }).error.code;
      expect(sent, `${code} reaches the client verbatim`).toBe(code);
      expect(Object.hasOwn(SAVE_ERROR_MSG, code), `${code} has words in the console's map`).toBe(true);
      expect(Object.hasOwn(EXPECTED, code), `${code} has an expected key in this test`).toBe(true);
      const key = sponsorSaveErrorKey(new ApiV1Error("the server's own sentence", 409, sent));
      expect(key, `${code} is not the house fallback`).not.toBe(SAVE_ERROR_FALLBACK_MSG);
      expect(key, code).toBe(EXPECTED[code]);
      checked++;
    }
    expect(checked).toBe(SPONSOR_REFUSAL_CODES.length);
    expect(checked, "every expected entry is a listed code").toBe(Object.keys(EXPECTED).length);
    // The plan gate's code is the status's own (402 PAYMENT_REQUIRED), not a deal code.
    expect(sponsorSaveErrorKey(new ApiV1Error("x", 402, await codeFor(402)))).toBe("sponsors.error.planRequired");
    // The reverse: nothing in the map is dead - every mapped code is an envelope status code or one the server lists.
    const ENVELOPE = ["VALIDATION", "UNAUTHENTICATED", "PAYMENT_REQUIRED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED"];
    const listed = new Set<string>([...ENVELOPE, ...SPONSOR_REFUSAL_CODES]);
    const dead = Object.keys(SAVE_ERROR_MSG).filter((c) => !listed.has(c));
    expect(dead, "a mapped code nobody sends").toEqual([]);
    expect(Object.keys(SAVE_ERROR_MSG).length).toBe(ENVELOPE.length + SPONSOR_REFUSAL_CODES.length);
  });

  it("one code, two meanings: the console's Send invoice and Resend read their own words for stripe_unavailable and deal_paid_online; every other write reads the shared words (counted)", () => {
    // Expected values from the server's paths (server/usecases/sponsor-deals.ts):
    //  - createDeal sends an online deal's invoice AFTER the deal is saved (F11): without `end_current` a create's 502 leaves a
    //    saved draft - never "nothing was changed"; WITH `end_current` it may instead have failed closing the live deal's pay link,
    //    before anything was written, so its words promise neither (Task 16);
    //  - sendDealInvoice may close the old link (retire) before Stripe fails to mint a new one, so it says "not sent";
    //  - deal_paid_online on a Resend is the stored session already paid (ensureDealCheckout); on Mark as paid it is F37.
    const CASES: Array<[SponsorWrite | undefined, string, string]> = [
      ["create_deal", "stripe_unavailable", "sponsors.error.invoiceSavedNoLink"],
      ["create_deal_resend", "stripe_unavailable", "sponsors.error.invoiceSavedResend"],
      ["create_deal_ending", "stripe_unavailable", "sponsors.error.invoiceNotSentCheck"],
      ["resend_invoice", "stripe_unavailable", "sponsors.error.resendStripeUnavailable"],
      ["resend_invoice", "deal_paid_online", "sponsors.error.resendPaidOnline"],
      [undefined, "stripe_unavailable", "sponsors.error.stripeUnavailable"],
      [undefined, "deal_paid_online", "sponsors.error.dealPaidOnline"],
      // An override never leaks to another code of the same write.
      ["create_deal", "deal_changed", "sponsors.error.dealChanged"],
      ["create_deal", "package_retired", "sponsors.error.packageRetired"],
      ["create_deal_resend", "package_retired", "sponsors.error.packageRetired"],
      ["create_deal_ending", "package_retired", "sponsors.error.packageRetired"],
      ["resend_invoice", "deal_not_invoiceable", "sponsors.error.notInvoiceable"],
      ["resend_invoice", "NOT_FOUND", "sponsors.error.notFound"],
      ["create_deal", "INTERNAL", SAVE_ERROR_FALLBACK_MSG],
    ];
    let checked = 0;
    for (const [write, code, key] of CASES) {
      expect(sponsorSaveErrorKey(new ApiV1Error("x", 409, code), write), `${write ?? "any"} ${code}`).toBe(key);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("anything else - another code, an unknown one, a network failure, not an error at all - is the house fallback (count reported)", async () => {
    expect(SAVE_ERROR_FALLBACK_MSG).toBe("settings.saveFailed");
    const others: unknown[] = [
      new ApiV1Error("x", 500, await codeFor(500)),
      new ApiV1Error("x", 409, await codeFor(409)),
      new ApiV1Error("x", 0, "UNKNOWN"),
      new ApiV1Error("x", 0, "toString"),
      new TypeError("Failed to fetch"),
      "a string",
      null,
    ];
    let checked = 0;
    for (const err of others) {
      expect(sponsorSaveErrorKey(err), String(err)).toBe(SAVE_ERROR_FALLBACK_MSG);
      checked++;
    }
    expect(checked).toBe(others.length);
  });

  it("every key it can answer exists in all four locales, and none is the server's English (count reported)", () => {
    const keys = [...Object.values(SAVE_ERROR_MSG), ...Object.values(SAVE_ERROR_BY_WRITE).flatMap((m) => Object.values(m)), SAVE_ERROR_FALLBACK_MSG];
    let checked = 0;
    for (const key of keys) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(typeof dict[key], `${locale} ${key}`).toBe("string");
        expect(dict[key]!.length, `${locale} ${key}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(keys.length * 4);
  });

  it("the saved-draft sentence never says nothing was changed, in any locale (the false sentence the review found)", () => {
    // en/ui.json `sponsors.error.stripeUnavailable` says "nothing was changed"; after a create commits its deal that is false.
    const NOTHING_CHANGED: Record<string, RegExp> = { en: /nothing was changed/i, es: /no se cambió nada/i, fr: /rien n'a (donc )?été modifié/i, nl: /niets gewijzigd/i };
    let checked = 0;
    for (const [locale, dict] of Object.entries(LOCALES)) {
      expect(dict["sponsors.error.stripeUnavailable"], `${locale}: premise, the shared sentence says it`).toMatch(NOTHING_CHANGED[locale]!);
      expect(dict["sponsors.error.invoiceSavedNoLink"], locale).not.toMatch(NOTHING_CHANGED[locale]!);
      expect(dict["sponsors.error.invoiceSavedResend"], locale).not.toMatch(NOTHING_CHANGED[locale]!);
      expect(dict["sponsors.error.invoiceNotSentCheck"], locale).not.toMatch(NOTHING_CHANGED[locale]!);
      expect(dict["sponsors.error.resendStripeUnavailable"], locale).not.toMatch(NOTHING_CHANGED[locale]!);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("createDealWrite - which words a refused Add deal create reads (batch H fix round 1: m4)", () => {
  // Expected values from the server's paths: only an ONLINE create has a Stripe call of its own; an online create that ends the
  // current deal has a second one, before anything is written; the rest is the lifecycle table's (draft => Send, live/scheduled =>
  // Resend), so "immediate" is the rule that is Resend and the two that wait are Send.
  const WAITING: Record<string, SponsorWrite> = { on_payment: "create_deal", on_approval: "create_deal", immediate: "create_deal_resend" };

  it("every payment method x go-live rule x end_current x queued (36 checked): online ends => ending; online => by rule; offline and complimentary => the shared words (undefined)", () => {
    let checked = 0;
    for (const method of PAYMENT_METHODS) {
      for (const rule of GO_LIVE_RULES) {
        for (const endCurrent of [false, true]) {
          for (const queued of [false, true]) {
            const want = method !== "online" ? undefined : endCurrent ? "create_deal_ending" : WAITING[rule];
            expect(createDealWrite({ method, endCurrent, rule, queued }), `${method}/${rule}/end=${endCurrent}/queued=${queued}`).toBe(want);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(PAYMENT_METHODS.length * GO_LIVE_RULES.length * 4);
    expect(checked).toBe(36);
  });

  it("the typed table covers every go-live rule, so a new rule cannot slip past it", () => {
    expect(Object.keys(WAITING).sort()).toEqual([...GO_LIVE_RULES].sort());
  });

  it("an offline or complimentary create that ends the current deal reads the shared 'nothing was changed' words (its only Stripe call is before any write)", () => {
    for (const method of ["offline", "complimentary"] as const) {
      const write = createDealWrite({ method, endCurrent: true, rule: "immediate", queued: false });
      expect(write, method).toBeUndefined();
      expect(sponsorSaveErrorKey(new ApiV1Error("x", 502, "stripe_unavailable"), write), method).toBe("sponsors.error.stripeUnavailable");
    }
  });
});
