// CancelEntry — REGRESSION-CRITICAL (RS007 acceptance): must call the
// public/withdrawCore path (withdrawRegistrationPublic, actorId: null), NEVER
// withdrawRegistrationOrganiser — the two routes differ ONLY by a `/public/`
// path segment, which is exactly the kind of thing a later "tidy the two
// paths together" refactor could silently collapse. This pins the literal
// URL the button calls. No jsdom: driven through the shared node-env hook
// harness (see import-client.test.tsx for the established convention).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, walk, propsOf } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
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
      return Promise.resolve({});
    },
  };
});

const router = vi.hoisted(() => ({ refreshCount: 0 }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => { router.refreshCount += 1; } }),
}));

const confirmMock = vi.hoisted(() => ({
  resolve: true,
  calls: [] as { title: string; body: unknown; confirmLabel: string; tone?: string }[],
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => (opts: { title: string; body: unknown; confirmLabel: string; tone?: string }) => {
    confirmMock.calls.push(opts);
    return Promise.resolve(confirmMock.resolve);
  },
}));

import { textOf } from "@/components/__tests__/_hook-harness";
import { CancelEntry } from "../cancel-entry";

beforeEach(() => {
  net.calls = [];
  net.rejection = null;
  router.refreshCount = 0;
  confirmMock.resolve = true;
  confirmMock.calls = [];
});

const findButton = (tree: ReturnType<typeof walk>) => tree.find((e) => e.type === "button")!;

describe("CancelEntry", () => {
  it("calls the PUBLIC per-entry withdraw path (withdrawRegistrationPublic), never the organiser one, and refreshes on success", async () => {
    const island = renderIsland(CancelEntry, {
      entryId: "reg-1",
      token: "rg_tok",
      divisionName: "Mixed Doubles",
      refundable: true,
      refundAmountFormatted: "£25.00",
    });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/v1/public/registrations/reg-1/withdraw");
    expect(net.calls[0]!.url).not.toBe("/api/v1/registrations/reg-1/withdraw"); // the organiser path — no /public/
    expect(net.calls[0]!.method).toBe("POST");
    expect(net.calls[0]!.json).toEqual({ token: "rg_tok" });
    expect(router.refreshCount).toBe(1);
  });

  it("does NOT call the API when the confirm dialog is declined", async () => {
    confirmMock.resolve = false;
    const island = renderIsland(CancelEntry, {
      entryId: "reg-1",
      token: "rg_tok",
      divisionName: "Mixed Doubles",
      refundable: true,
      refundAmountFormatted: "£25.00",
    });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(net.calls).toHaveLength(0);
    expect(router.refreshCount).toBe(0);
  });

  it("confirm copy states REFUNDABLE, with the amount, before the click commits", async () => {
    const island = renderIsland(CancelEntry, {
      entryId: "reg-1",
      token: "rg_tok",
      divisionName: "Mixed Doubles",
      refundable: true,
      refundAmountFormatted: "£25.00",
    });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(confirmMock.calls).toHaveLength(1);
    const body = textOf(confirmMock.calls[0]!.body as never);
    expect(body).toContain("£25.00");
    expect(body.toLowerCase()).not.toContain("discretion");
  });

  it("confirm copy states the organiser's DISCRETION, never promising a refund the policy does not, once the window has passed", async () => {
    const island = renderIsland(CancelEntry, {
      entryId: "reg-1",
      token: "rg_tok",
      divisionName: "Mixed Doubles",
      refundable: false,
      refundAmountFormatted: "£25.00",
    });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(confirmMock.calls).toHaveLength(1);
    const body = textOf(confirmMock.calls[0]!.body as never);
    expect(body.toLowerCase()).toContain("discretion");
    expect(body).not.toContain("£25.00");
  });

  it("shows the server's error message on failure, without refreshing", async () => {
    net.rejection = new Error("This registration was rejected and cannot be withdrawn");
    const island = renderIsland(CancelEntry, {
      entryId: "reg-1",
      token: "rg_tok",
      divisionName: "Mixed Doubles",
      refundable: true,
      refundAmountFormatted: "£25.00",
    });

    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(island.text()).toContain("This registration was rejected and cannot be withdrawn");
    expect(router.refreshCount).toBe(0);
  });
});
