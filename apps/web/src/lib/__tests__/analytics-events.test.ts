import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVENTS } from "@/lib/analytics-events";

/**
 * A constant nothing emits is telemetry that does not exist, and it reads in
 * review as though it does — the same "declared, typed, and inert" shape this
 * repo keeps paying for. `BILLING_PLAN_CHANGED` sat in `EVENTS` unemitted
 * until its surface was retired in #805 and the audit that followed found it.
 *
 * So the billing/subscription block is pinned as a CLOSED SET, read off the
 * live object rather than a list typed into the assertion. Adding an event
 * here without its emitter fails this test; adding one WITH its emitter is a
 * one-line update made deliberately. The set is the billing surface's whole
 * analytics contract, so it is worth stating once.
 */
describe("analytics event names", () => {
  it("the billing and subscription block is exactly the events we emit", () => {
    const billing = Object.keys(EVENTS)
      .filter((k) => k.startsWith("BILLING_") || k.startsWith("SUBSCRIPTION_"))
      .sort();
    expect(billing).toEqual([
      "BILLING_CARD_ADDED",
      "BILLING_INTERVAL_CHANGED",
      "BILLING_VIEWED",
      "SUBSCRIPTION_CANCELED",
      "SUBSCRIPTION_CANCEL_SCHEDULED",
      "SUBSCRIPTION_RESUMED",
      "SUBSCRIPTION_STARTED",
    ]);
  });

  /**
   * The negative half, and the one that would have caught this at the time:
   * `billing_plan_changed` must not come back as a VALUE either, under any
   * key. A key-only assertion above passes if someone re-adds the dead event
   * under a new name.
   */
  it("does not carry the retired billing_plan_changed event under any key", () => {
    expect(Object.values(EVENTS)).not.toContain("billing_plan_changed");
  });

  /**
   * ...and it is gone from the SOURCE, not merely absent from the object — a
   * commented-out constant still reads as a live event name to the next
   * person auditing this file, which is how the original one survived.
   */
  it("leaves no trace of the retired name in the events module's own source", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../analytics-events.ts", import.meta.url)),
      "utf8",
    );
    // The explanatory comment above the block names it once, deliberately.
    const hits = src.match(/billing_plan_changed/g) ?? [];
    expect(hits.length, `expected the name only in the note explaining its removal, saw ${hits.length}`).toBe(1);
    expect(src).not.toMatch(/BILLING_PLAN_CHANGED\s*:/);
  });
});

describe("PLG growth events", () => {
  it("exposes the loop event names", () => {
    expect(EVENTS.ATTRIBUTION_CLICKED).toBe("attribution_clicked");
    expect(EVENTS.SHARE_FIRED).toBe("share_fired");
    expect(EVENTS.PLAYER_STARTED_OWN_ORG).toBe("player_started_own_org");
    expect(EVENTS.COMPETITION_MADE_PUBLIC).toBe("competition_made_public");
    expect(EVENTS.EMBED_RENDERED).toBe("embed_rendered");
  });
});
