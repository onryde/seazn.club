// ResendConfirmation — cart-scoped (rid), not per-entry: the confirmation
// mail is cart-shaped. No jsdom: driven through the shared node-env hook
// harness.
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

import { ApiV1Error } from "@/lib/client-v1";
import { ResendConfirmation } from "../resend-confirmation";

beforeEach(() => {
  net.calls = [];
  net.response = { sent: true };
  net.rejection = null;
});

const findButton = (tree: ReturnType<typeof walk>) => tree.find((e) => e.type === "button")!;

describe("ResendConfirmation", () => {
  it("posts to the group-scoped (rid) public resend path with the token", async () => {
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(net.calls).toEqual([
      { url: "/api/v1/public/registrations/groups/grp-1/resend", method: "POST", json: { token: "rg_tok" } },
    ]);
  });

  it("shows a sent confirmation after success", async () => {
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();
    expect(island.text().toLowerCase()).toContain("sent");
  });

  // RS007 i18n follow-up — AUDIT FINDING: this used to render `err.message`
  // (un-localized English straight off the server) as the ONLY thing a
  // public visitor saw. Every failure now shows a LOCALIZED, HTTP-status-
  // classified primary message (classifyStatusActionFailure, view-model.ts),
  // matching join-form.tsx's own contract. The raw detail is kept as
  // SECONDARY, de-emphasized text (register-stepper.tsx's FIX 3 convention).
  describe("failure — localized primary message, classified from HTTP status", () => {
    it("422 (cart already terminal) shows the localized resend-failed message as primary, with the raw detail as secondary — NOT the raw message alone", async () => {
      net.rejection = new ApiV1Error("This registration is no longer active", 422, "ERROR");
      const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("We couldn't resend the confirmation");
      // Secondary — the raw server detail is still shown, just not primary.
      expect(island.text()).toContain("This registration is no longer active");
    });

    it("404 (stale token/groupId) shows the SAME shared 'couldn't find that registration' copy the page's own initial load uses", async () => {
      net.rejection = new ApiV1Error("registration not found", 404, "NOT_FOUND");
      const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("We couldn't find that registration");
    });

    it("409 (conflict) shows the localized 'status just changed, refresh' message, not the raw server string as primary", async () => {
      net.rejection = new ApiV1Error("some conflicting server detail", 409, "CONFLICT");
      const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("status just changed");
    });

    it("429 (rate limited) shows a 'try again in a moment' style message, not the generic failure copy", async () => {
      net.rejection = new ApiV1Error("rate limited", 429, "RATE_LIMITED");
      const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
      await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

      expect(island.text()).toContain("Too many attempts");
      expect(island.text()).not.toContain("We couldn't resend the confirmation");
    });
  });
});
