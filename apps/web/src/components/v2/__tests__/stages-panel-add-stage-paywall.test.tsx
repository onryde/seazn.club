// F5 test debt, Task 5a: AddStageForm's add() catch block had no
// ApiV1Error/PAYMENT_REQUIRED branch — a paid "Add stage" POST that came
// back PAYMENT_REQUIRED rendered as the SAME plain red error banner as any
// other failure in this file, instead of the paywall card every other paid
// action here already shows (act() :572, rebuildStage :613). The PARENT
// (StagesPanel) already owns paywallFeature/setPaywallFeature and the
// {paywallFeature && <UpgradeGate/>} render (:661) — AddStageForm now
// reports through a new `onPaywall` prop rather than a second paywall
// surface.
//
// AddStageForm is a nested stateful component, opaque to the harness's
// one-level-deep expansion when driven through StagesPanel (same reasoning
// as stages-panel-add-stage-progression.test.tsx and FixtureLine's own
// export in stages-panel-court-picker.test.tsx) — so it is exported directly
// from stages-panel.tsx for this test, same precedent as FixtureLine.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  impl: (() => Promise.resolve({})) as (
    url: string,
    options?: { method?: string; json?: unknown },
  ) => Promise<unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => net.impl(url, options),
  };
});

import { AddStageForm } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Finds and invokes a `<button>` by its rendered text — same idiom as
 *  stages-panel-court-picker.test.tsx's openEditor (invoke the handler the
 *  harness found, don't simulate a DOM click that doesn't exist here). */
function clickButton(tree: ReactElement[], text: string): void {
  const btn = tree.find((n) => n.type === "button" && textOf(n).trim() === text);
  if (!btn) {
    throw new Error(`no <button> with text "${text}" — rendered: ${tree.map((n) => textOf(n)).join(" | ")}`);
  }
  (propsOf(btn).onClick as () => void)();
}

const baseProps = {
  divisionId: "d1",
  nextSeq: 2,
} as unknown as Parameters<typeof AddStageForm>[0];

beforeEach(() => {
  net.impl = () => Promise.resolve({});
});

describe("AddStageForm — PAYMENT_REQUIRED wiring (F5 task 5a)", () => {
  it("calls onPaywall with the feature key, not onError, when the stage-create POST 402s PAYMENT_REQUIRED", async () => {
    net.impl = () =>
      Promise.reject(
        new ApiV1Error("upgrade required", 402, "PAYMENT_REQUIRED", { feature_key: "formats.finals" }),
      );
    const onDone = vi.fn();
    const onError = vi.fn();
    const onPaywall = vi.fn();
    const island = renderIsland(AddStageForm, { ...baseProps, onDone, onError, onPaywall });

    clickButton(island.tree(), "+ Add stage");
    clickButton(island.tree(), "Add stage");
    await flush();

    expect(onPaywall).toHaveBeenCalledWith("formats.finals");
    // onError("") is the pre-submit clear that add() always fires first
    // (existing convention) — a SECOND call would mean the error branch
    // fired instead of the paywall one.
    expect(onError.mock.calls).toEqual([[""]]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("regression: a non-PAYMENT_REQUIRED failure still calls onError, never with a real paywall feature key", async () => {
    net.impl = () => Promise.reject(new Error("network down"));
    const onDone = vi.fn();
    const onError = vi.fn();
    const onPaywall = vi.fn();
    const island = renderIsland(AddStageForm, { ...baseProps, onDone, onError, onPaywall });

    clickButton(island.tree(), "+ Add stage");
    clickButton(island.tree(), "Add stage");
    await flush();

    expect(onError.mock.calls).toEqual([[""], ["network down"]]);
    // onPaywall("") IS called — the pre-submit clear (see the sequential
    // test below for why this matters) — but never with a real key.
    expect(onPaywall.mock.calls).toEqual([[""]]);
  });

  // Review finding: add()'s pre-submit reset cleared `error` on every
  // attempt but never cleared the parent's `paywallFeature` the same way,
  // unlike act()/rebuildStage() elsewhere in this file which both call
  // setPaywallFeature(null) at their own entry. So: submit → PAYMENT_
  // REQUIRED → paywall card shows; resubmit → a DIFFERENT failure → the
  // stale paywall card stayed on screen alongside the new red banner,
  // since nothing cleared it. Fixed by adding onPaywall("") alongside the
  // existing onError("") in add()'s pre-submit reset — the parent's own
  // `{paywallFeature && <UpgradeGate .../>}` render condition (stages-panel
  // .tsx:662) already treats "" as falsy, so no parent-side change is
  // needed.
  //
  // AddStageForm never renders <UpgradeGate> itself (the PARENT does, from
  // the state these callbacks feed) — so this drives the callbacks across
  // TWO sequential submissions and mirrors the parent's own falsy-gated
  // state exactly, rather than re-implementing StagesPanel's render tree
  // here. `paywallFeature`/`error` below are that mirror: truthy iff the
  // parent's <UpgradeGate>/red-banner would be showing.
  it("regression: a PAYMENT_REQUIRED submit followed by a DIFFERENT failure clears the stale paywall card", async () => {
    let paywallFeature: string | null = null;
    let error: string | null = null;
    const onDone = vi.fn();
    const onError = vi.fn((msg: string) => {
      error = msg || null;
    });
    const onPaywall = vi.fn((key: string) => {
      paywallFeature = key || null;
    });
    const island = renderIsland(AddStageForm, { ...baseProps, onDone, onError, onPaywall });
    clickButton(island.tree(), "+ Add stage");

    // First submit: PAYMENT_REQUIRED — the paywall card would be showing.
    net.impl = () =>
      Promise.reject(
        new ApiV1Error("upgrade required", 402, "PAYMENT_REQUIRED", { feature_key: "formats.finals" }),
      );
    clickButton(island.tree(), "Add stage");
    await flush();
    expect(paywallFeature).toBe("formats.finals");
    expect(error).toBeNull();

    // Resubmit: a DIFFERENT, non-PAYMENT_REQUIRED failure.
    net.impl = () => Promise.reject(new Error("network down"));
    clickButton(island.tree(), "Add stage");
    await flush();

    // The stale card must be gone AND the fresh red banner must show — not
    // both stacked, which was the bug.
    expect(paywallFeature).toBeNull();
    expect(error).toBe("network down");
  });
});
