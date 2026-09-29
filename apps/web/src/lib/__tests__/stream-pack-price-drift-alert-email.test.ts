// Body copy for the staff alert sent when the PROD drift guard (lib/relay-checkout.ts `resolveStreamPackPriceId`,
// parked c) finds a match-credit pack's live Stripe price charging something other than the table the Phone tab's
// tiles quote. Every checkout for that pack is refused until it matches, so the alert has to say what fixes it: since
// Addendum S, `pnpm stripe:sync` owns these prices, so the only way a price drifts is a hand-edit in the Stripe
// dashboard — re-run stripe:sync (it re-mints to the table) or fix the table.
//
// Asserted through the real send path with `fetch` stubbed (stream-credit-grant-alert-email.test.ts's shape), because
// the body is built inside the send function. Internal staff alert: English only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendStreamPackPriceDriftAlertEmail } from "../email";

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
  lookupKey: "seazn_stream_pack_5",
  priceId: "price_drifted_1",
  drift: "eur: live 2900, table 2925",
};

describe("match-credit pack price drift alert", () => {
  it("names the pack, the price and the difference, says checkouts are refused, and says what fixes it", async () => {
    await sendStreamPackPriceDriftAlertEmail(base);
    expect(sent).toHaveLength(1);
    const body = `${sent[0]!.subject}\n${sent[0]!.html}\n${sent[0]!.text}`;
    expect(body).toContain(base.lookupKey);
    expect(body).toContain(base.priceId);
    expect(body).toContain(base.drift);
    expect(body).toMatch(/refused/i);
    // The remedy, in the owner's words (Addendum S item 4).
    expect(sent[0]!.text).toContain("re-run stripe:sync or fix the table");
    expect(body).toContain("apps/web/src/lib/stream-credit-packs.ts");
  });
});
