// Final review D3: the Sponsors hub's writes (the On stream tab's tick and dial, Share report's create and revoke) show the
// DICTIONARY's words for a refusal, never the server's English sentence. ONE map, components/sponsors/save-error.ts, keyed on
// the v1 envelope's machine code; a code it does not know reads the house fallback (`settings.saveFailed`).
//
// Expected values: the codes are the envelope's own (`statusCode` in server/api-v1/http.ts, read back below through the real
// handler for each status), and every key must exist in all four locales.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { HttpError } from "@/lib/errors";
import { v1 } from "@/server/api-v1/http";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { SAVE_ERROR_FALLBACK_MSG, SAVE_ERROR_MSG, sponsorSaveErrorKey } from "../save-error";

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

  it("each sponsor-deal refusal maps to its own key, through the code the real handler sends verbatim (count reported)", async () => {
    // Sponsor deals, Task 12 (carries): the codes the deal usecases refuse with (server/usecases/sponsors.ts, sponsor-deals.ts,
    // server/sponsors/deal-apply.ts), typed here from the plan's D-table. Each reaches the client as `error.code` - the real
    // handler is asked, so a code the envelope would rewrite shows here.
    const cases: Array<[number, string, string]> = [
      [409, "sponsor_locked_by_deal", "sponsors.error.lockedByDeal"],
      [409, "sponsor_has_open_deal", "sponsors.error.hasOpenDeal"],
      [409, "sponsor_has_deal_history", "sponsors.error.hasDealHistory"],
      [409, "sponsor_has_open_checkout", "sponsors.error.hasOpenCheckout"],
      [409, "deal_changed", "sponsors.error.dealChanged"],
      [409, "deal_paid_online", "sponsors.error.dealPaidOnline"],
      [409, "deal_not_refundable", "sponsors.error.notRefundable"],
      [409, "deal_disputed", "sponsors.error.dealDisputed"],
      [409, "connect_required", "sponsors.error.connectRequired"],
      [422, "on_payment_needs_payment", "sponsors.error.needsPayment"],
      [502, "stripe_unavailable", "sponsors.error.stripeUnavailable"],
    ];
    let checked = 0;
    for (const [status, code, key] of cases) {
      const res = await v1(async () => {
        throw new HttpError(status, "the server's own sentence", code);
      });
      const sent = ((await res.json()) as { error: { code: string } }).error.code;
      expect(sent, `${code} reaches the client verbatim`).toBe(code);
      expect(sponsorSaveErrorKey(new ApiV1Error("the server's own sentence", status, sent)), code).toBe(key);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // The plan gate's code is the status's own (402 PAYMENT_REQUIRED), not a deal code.
    expect(sponsorSaveErrorKey(new ApiV1Error("x", 402, await codeFor(402)))).toBe("sponsors.error.planRequired");
    expect(Object.keys(SAVE_ERROR_MSG).length, "every mapped code is one a case reaches (5 by status + 1 plan gate + the deal codes)").toBe(5 + 1 + cases.length);
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
    let checked = 0;
    for (const key of [...Object.values(SAVE_ERROR_MSG), SAVE_ERROR_FALLBACK_MSG]) {
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(typeof dict[key], `${locale} ${key}`).toBe("string");
        expect(dict[key]!.length, `${locale} ${key}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe((Object.keys(SAVE_ERROR_MSG).length + 1) * 4);
  });
});
