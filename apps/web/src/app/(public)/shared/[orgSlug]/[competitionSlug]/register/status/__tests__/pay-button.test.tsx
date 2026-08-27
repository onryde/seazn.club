// PayButton — resumes Stripe checkout for ONE entry (fresh pending or
// waitlist-promoted). No jsdom in this workspace: driven through the shared
// node-env hook harness, same convention as import-client.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, walk, propsOf } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  response: null as unknown,
  rejection: null as unknown,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      if (net.rejection) {
        const e = net.rejection;
        net.rejection = null;
        return Promise.reject(e);
      }
      return Promise.resolve(net.response);
    },
  };
});

const nav = vi.hoisted(() => ({ assigned: "" }));
vi.stubGlobal("window", {
  location: {
    assign: (url: string) => {
      nav.assigned = url;
    },
  },
});

import { ApiV1Error } from "@/lib/client-v1";
import { PayButton } from "../pay-button";

beforeEach(() => {
  net.calls = [];
  net.response = null;
  net.rejection = null;
  nav.assigned = "";
});

const findButton = (tree: ReturnType<typeof walk>) => tree.find((e) => e.type === "button")!;

describe("PayButton", () => {
  it("posts to the PUBLIC per-entry checkout path with the token, then navigates to the returned checkout_url", async () => {
    net.response = { checkout_url: "https://checkout.stripe.com/pay/cs_test_123" };
    const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

    const button = findButton(island.tree());
    await (propsOf(button).onClick as () => Promise<void>)();

    expect(net.calls).toEqual([
      { url: "/api/v1/public/registrations/reg-1/checkout", method: "POST", json: { token: "rg_tok" } },
    ]);
    expect(nav.assigned).toBe("https://checkout.stripe.com/pay/cs_test_123");
  });

  // RS007 i18n follow-up — AUDIT FINDING: this used to render `err.message`
  // (un-localized English straight off the server) as the ONLY thing a
  // public visitor saw. Every failure now shows a LOCALIZED, HTTP-status-
  // classified primary message (classifyStatusActionFailure, view-model.ts),
  // matching join-form.tsx's own contract. The raw detail is kept as
  // SECONDARY, de-emphasized text (register-stepper.tsx's FIX 3 convention).
  describe("failure — localized primary message, classified from HTTP status", () => {
    it("422/503 (e.g. Connect not live) shows the localized pay-failed message as primary, with the raw detail as secondary — NOT the raw message alone", async () => {
      net.rejection = new ApiV1Error("Payments are not set up for this organiser yet", 503, "ERROR");
      const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("We couldn't start the payment");
      // Secondary — the raw server detail is still shown, just not primary.
      expect(island.text()).toContain("Payments are not set up for this organiser yet");
      expect(nav.assigned).toBe("");
    });

    it("404 (stale token/entryId) shows the SAME shared 'couldn't find that registration' copy the page's own initial load uses", async () => {
      net.rejection = new ApiV1Error("registration not found", 404, "NOT_FOUND");
      const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("We couldn't find that registration");
      expect(nav.assigned).toBe("");
    });

    it("409 (a real checkout-mint race — REGISTRATION_CHECKOUT_CONFLICT) shows the localized 'refresh and try again' message, not the raw server string as primary", async () => {
      net.rejection = new ApiV1Error(
        "Another checkout was just started for this registration — please refresh and try again",
        409,
        "REGISTRATION_CHECKOUT_CONFLICT",
      );
      const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("Another payment attempt just started");
      expect(nav.assigned).toBe("");
    });

    it("429 (rate limited) shows a 'try again in a moment' style message, not the generic failure copy", async () => {
      net.rejection = new ApiV1Error("rate limited", 429, "RATE_LIMITED");
      const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("Too many attempts");
      expect(island.text()).not.toContain("We couldn't start the payment");
      expect(nav.assigned).toBe("");
    });
  });
});
