import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// next/navigation hooks used by the component — stub for SSR render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const dict = uiEn as unknown as Dict;

function render(chargesEnabled: boolean) {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <OrgPaymentInstructions
        orgId="org-1"
        initialValue={null}
        chargesEnabled={chargesEnabled}
        isOwner
      />
    </DictProvider>,
  );
}

describe("org payment instructions — Stripe default-method gate", () => {
  it("disables 'Card at sign-up' and shows the connect note when Stripe isn't live", () => {
    const html = render(false);
    const stripeInput = html.match(/<input[^>]*data-testid="method-stripe"[^>]*>/)?.[0];
    expect(stripeInput).toContain("disabled=");
    expect(html).toContain("Connect Stripe above to offer card payments");
  });

  it("allows selecting 'Card at sign-up' once Stripe is live, no note shown", () => {
    const html = render(true);
    const stripeInput = html.match(/<input[^>]*data-testid="method-stripe"[^>]*>/)?.[0];
    expect(stripeInput).not.toContain("disabled=");
    expect(html).not.toContain("Connect Stripe above to offer card payments");
  });

  it("renders the Stripe panel above the cash panel, each its own row", () => {
    const html = render(true);
    const cardIdx = html.indexOf(uiEn["pay.cardTitle"]);
    const cashIdx = html.indexOf(uiEn["pay.cashTitle"]);
    expect(cardIdx).toBeGreaterThan(-1);
    expect(cashIdx).toBeGreaterThan(cardIdx);
  });
});
