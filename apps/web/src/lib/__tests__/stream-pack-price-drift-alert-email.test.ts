// Body copy for the staff alert queued when the PROD drift guard (lib/relay-checkout.ts `resolveStreamPackPriceId`,
// parked c) finds a match-credit pack's live Stripe price charging something other than the table the Phone tab's
// tiles quote. Every checkout for that pack is refused until it matches, so the alert has to say what fixes it: since
// Addendum S, `pnpm stripe:sync` owns these prices, so the only way a price drifts is a hand-edit in the Stripe
// dashboard — re-run stripe:sync (it re-mints to the table) or fix the table.
//
// The builder (`streamPackPriceDriftAlertEmail`) renders it, and `alertStreamPackPriceDrift` queues it on the email
// outbox as kind `staff_stream_pack_price_drift` (relay-checkout-drift-alert.test.ts proves the row); this file proves
// what it SAYS, by calling the builder. Internal staff alert: English only.
import { describe, expect, it } from "vitest";
import { streamPackPriceDriftAlertEmail } from "../email";

const base = {
  lookupKey: "seazn_stream_pack_5",
  priceId: "price_drifted_1",
  drift: "eur: live 2900, table 2925",
};

describe("match-credit pack price drift alert", () => {
  it("names the pack, the price and the difference, says checkouts are refused, and says what fixes it", () => {
    const mail = streamPackPriceDriftAlertEmail(base);
    const body = `${mail.subject}\n${mail.html}\n${mail.text}`;
    expect(mail.subject).toBe(`Match-credit pack price differs from the table: ${base.lookupKey}`);
    expect(body).toContain(base.lookupKey);
    expect(body).toContain(base.priceId);
    expect(body).toContain(base.drift);
    expect(body).toMatch(/refused/i);
    // The remedy, in the owner's words (Addendum S item 4).
    expect(mail.text).toContain("re-run stripe:sync or fix the table");
    expect(body).toContain("apps/web/src/lib/stream-credit-packs.ts");
  });
});
