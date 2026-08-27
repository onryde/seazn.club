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

  it("shows the server's error message on failure", async () => {
    net.rejection = new Error("This registration is no longer active");
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();
    expect(island.text()).toContain("This registration is no longer active");
  });
});
