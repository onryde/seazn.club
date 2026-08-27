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

  it("shows the server's error message on failure, without navigating anywhere", async () => {
    net.rejection = new Error("Payments are not set up for this organiser yet");
    const island = renderIsland(PayButton, { entryId: "reg-1", token: "rg_tok" });

    const button = findButton(island.tree());
    await (propsOf(button).onClick as () => Promise<void>)();

    expect(island.text()).toContain("Payments are not set up for this organiser yet");
    expect(nav.assigned).toBe("");
  });
});
