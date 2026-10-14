// ESLint L4 (review minor 1a): the first read of BillingGroupPanel and
// IncomingTransferOffers used to carry an `if (!ignore)` flag on a `[]`-deps
// effect. Removing it survived every test, because the race it guarded cannot
// be produced from the UI: a SLOW FIRST READ could only overwrite a LATER
// post-action `load()` if an action could be taken before the first read had
// landed — and both components render NOTHING until it has, so there is no
// control to click. React 19 ignores a set after unmount, so the flag did not
// protect that either.
//
// The flag was removed rather than replaced by a request ticket. What keeps
// that decision honest is this file: it pins the PREMISE (nothing actionable
// before the first read lands) in both components. If a future change renders
// a control while the read is in flight, a post-action `load()` becomes
// reachable and these go red — which is the moment a ticket is owed.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderIsland, textOf, walk } from "./_hook-harness";
import type { ViewGroup } from "@/lib/billing-group-view";
import type { IncomingOffer } from "../incoming-transfer-offers";

vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const { BillingGroupPanel } = await import("../billing-group-panel");
const { IncomingTransferOffers } = await import("../incoming-transfer-offers");

const ME = "user-me";

const group: ViewGroup = {
  id: "grp-1",
  plan_key: "pro",
  status: "active",
  quantity_paid: 5,
  max_orgs: 5,
  has_live_subscription: true,
  orgs: [
    { id: "o1", name: "Riverside FC", slug: "riverside", status: "active", owner_user_id: ME, owner_name: "Me" },
  ],
};

const incomingOffer: IncomingOffer = {
  setup_intent_id: "seti_1",
  client_secret: "seti_1_secret",
  direction: "made_to_me",
  summary: null,
};

/** A fetch whose responses the TEST releases — the first read is "slow". */
function slowFetch(body: (url: string) => unknown) {
  const pending: (() => void)[] = [];
  const fetchMock = vi.fn(
    (url: string) =>
      new Promise((resolve) => {
        pending.push(() => resolve({ json: () => Promise.resolve(body(url)) }));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    /** Land every response that is in flight. */
    land: async () => {
      const release = pending.splice(0);
      for (const r of release) r();
      // Let the .json() / .then() chain settle.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

/** Every clickable control in the island's current tree. */
function controls(tree: ReactNode) {
  return walk(tree).filter((el) => {
    const p = el.props as { onClick?: unknown; onChange?: unknown };
    return el.type === "button" || typeof p.onClick === "function" || typeof p.onChange === "function";
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("the first read has nothing to race — no control exists while it is in flight", () => {
  it("BillingGroupPanel: nothing rendered, nothing clickable, until the first read lands", async () => {
    const net = slowFetch((url) =>
      url.includes("/transfer") ? { ok: true, data: [] } : { ok: true, data: [group] },
    );
    const island = renderIsland(BillingGroupPanel, { subscriptionId: "grp-1", currentUserId: ME });

    // In flight: the panel has read the network exactly once per endpoint and
    // shows nothing at all.
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
    expect(island.text()).toBe("");
    expect(controls(island.tree()), "an action here would start a second read").toHaveLength(0);

    await net.land();

    // Landed: now there IS something to click (non-vacuity for the empty case above).
    expect(island.text()).toContain("On this bill");
    expect(controls(island.tree()).length).toBeGreaterThan(0);
    // ...and landing it did not trigger a further read.
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("BillingGroupPanel: a first read that lands after the panel is gone does nothing and throws nothing", async () => {
    const net = slowFetch(() => ({ ok: true, data: [] }));
    const island = renderIsland(BillingGroupPanel, { subscriptionId: "grp-1", currentUserId: ME });
    island.unmount();
    await net.land();
    expect(net.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("IncomingTransferOffers: nothing rendered, nothing clickable, until the first read lands", async () => {
    const net = slowFetch(() => ({ ok: true, data: [incomingOffer] }));
    const island = renderIsland(IncomingTransferOffers, {});

    expect(net.fetchMock).toHaveBeenCalledTimes(1);
    expect(island.text()).toBe("");
    expect(controls(island.tree()), "the accept control is the only way to start a second read").toHaveLength(0);

    await net.land();

    expect(textOf(island.tree())).toContain("Take over this bill");
    expect(controls(island.tree()).length).toBeGreaterThan(0);
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("IncomingTransferOffers: a first read that lands after the card is gone does nothing and throws nothing", async () => {
    const net = slowFetch(() => ({ ok: true, data: [incomingOffer] }));
    const island = renderIsland(IncomingTransferOffers, {});
    island.unmount();
    await net.land();
    expect(net.fetchMock).toHaveBeenCalledTimes(1);
  });
});
