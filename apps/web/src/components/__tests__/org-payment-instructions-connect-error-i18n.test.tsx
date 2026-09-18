// What the owner READS when Stripe onboarding fails.
//
// `createConnectOnboardingLink` answers a failed Stripe call with a clean 502
// (stripe-connect.ts's stripeOnboardingStep) instead of leaking Stripe's raw
// message. That fixed the leak but left the replacement sentence authored on
// the SERVER, in English — and startOnboarding() renders `err.message`
// verbatim, so it reached a money screen untranslated in all four locales.
// The 502 is now routed through the dictionary instead.
//
// renderToStaticMarkup cannot see this: the error only exists after a click,
// and `environment: "node"` has no DOM. renderIsland supplies React's hook
// dispatcher so the handler can be invoked the way a browser would.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "./_hook-harness";
import uiEn from "@/dictionaries/en/ui.json";

// The params object must be the SAME instance on every render. The mount
// effect lists `searchParams` in its deps, so handing back a fresh
// URLSearchParams each call makes the deps differ every render: effect →
// setConnect → re-render → effect… a hang, not a failure. renderToStaticMarkup
// never runs effects, which is why the sibling i18n test can get away with it.
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSearchParams: () => nav.search,
}));

// Only `apiV1` is replaced — `ApiV1Error` stays REAL, because the component
// branches on `err instanceof ApiV1Error` and a lookalike class would make
// that check silently false and the test vacuous.
const apiV1Mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiV1: apiV1Mock,
}));

import { ApiV1Error } from "@/lib/client-v1";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";

/** The sentence the server sends on a masked Stripe failure — the literal
 *  from stripe-connect.ts. It must never be what the screen shows. */
const SERVER_502 = "Stripe couldn't start onboarding for this organization";
/** The ToS refusal. Deliberate, actionable copy the client shows verbatim. */
const SERVER_422 = "Agree to the Terms of Service (entry-fee chargebacks) before connecting Stripe";

/** Read from the shipped catalog, never typed out here: if the copy is
 *  reworded, this test follows it instead of asserting yesterday's sentence. */
const ONBOARD_ERR = (uiEn as Record<string, string>)["pay.onboardErr"];

/** Mount the owner's card with the onboarding POST failing as given. The GET
 *  the mount effect fires is answered separately — an unconnected org, which
 *  is the state that renders the Connect CTA. */
function mountWithFailure(failure: unknown) {
  apiV1Mock.mockReset().mockImplementation(async (_url: string, opts?: { method?: string }) => {
    if (opts?.method !== "POST") {
      return {
        connected: false,
        charges_enabled: false,
        details_submitted: null,
        payouts_enabled: false,
        disabled_reason: null,
        requirements_due: 0,
      };
    }
    throw failure;
  });
  return renderIsland(OrgPaymentInstructions, {
    orgId: "org-1",
    initialValue: null,
    isOwner: true,
  });
}

/** The primary CTA — the only element carrying both an onClick and the
 *  primary button class. Found by role rather than by copy so the test does
 *  not break when the label is translated. */
function clickConnect(island: ReturnType<typeof mountWithFailure>): Promise<void> {
  const btn = island
    .tree()
    .find(
      (el) =>
        typeof propsOf(el).onClick === "function" &&
        String(propsOf(el).className ?? "").includes("btn-primary"),
    );
  if (!btn) throw new Error("Connect CTA not found — the card did not render its onboarding button");
  return (propsOf(btn).onClick as () => Promise<void>)();
}

describe("Stripe onboarding failure copy", () => {
  it("shows the DICTIONARY sentence on a 502, not the server's English", async () => {
    const island = mountWithFailure(new ApiV1Error(SERVER_502, 502, "INTERNAL"));
    await clickConnect(island);
    const text = island.text();
    // Negative: the server-authored English is gone from the screen.
    expect(text).not.toContain(SERVER_502);
    expect(text).not.toContain("Stripe couldn't");
    // Positive pair — without it, an empty error or a dropped <p> also passes
    // the negative above. This is the localizable string, read from the dict.
    expect(ONBOARD_ERR).toBeTruthy();
    expect(text).toContain(ONBOARD_ERR);
  });

  it("still shows the ToS refusal verbatim — a 422 is deliberate, actionable copy", async () => {
    // The guard against over-routing: swapping EVERY failure for the generic
    // key would pass the test above while destroying the one message that
    // tells an owner what to do next.
    //
    // NOTE: this server string is itself hardcoded English. That is a
    // PRE-EXISTING i18n gap on the 422 path, reported separately and
    // deliberately not fixed here — this test pins today's routing, not the
    // English-ness of the sentence.
    const island = mountWithFailure(new ApiV1Error(SERVER_422, 422, "ERROR"));
    await clickConnect(island);
    expect(island.text()).toContain(SERVER_422);
  });

  it("still shows the upgrade prompt on a 402, which has its own key", async () => {
    const island = mountWithFailure(
      new ApiV1Error("Plan upgrade required: registration.paid", 402, "PAYMENT_REQUIRED"),
    );
    await clickConnect(island);
    expect(island.text()).toContain((uiEn as Record<string, string>)["pay.needPro"]);
  });
});
