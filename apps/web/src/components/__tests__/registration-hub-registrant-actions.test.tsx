// RS005 W3 — the row-expand detail's mutating action controls: approve/
// reject/withdraw/promote/resend, gated entirely by
// deriveRegistrantActionFlags (registration-hub-registrant-derive.ts) —
// never re-derived by hand here. The row/table/detail stay server
// components (task 1's zero-client-JS posture, unchanged); this is the
// SECOND client island in the row family, after the join-code copy
// control (W2b).
//
// Both `useRouter` and `useConfirm` need replacing under this harness —
// see registration-hub-settings-panel.test.tsx (useRouter) and
// billing-group-at-cap.test.tsx (useConfirm) for the same treatment:
// useRouter's real implementation throws outside a real Next tree, and
// useConfirm throws BY DESIGN outside its provider — the harness's
// useContext only ever returns each context's default, and no provider is
// ever actually mounted here.
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { REMINDER_CAP_PER_DAY, REMINDER_CONFIRM_WITHIN_MS } from "@/lib/registration-reminder";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh }),
}));

const confirmMock = vi.hoisted(() => ({
  fn: vi.fn<(opts: { title: string; body: unknown; confirmLabel: string; tone?: string }) => Promise<boolean>>(
    async () => true,
  ),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => confirmMock.fn,
}));

// Mirrors registration-hub-config-panel.test.tsx's own `net` harness, keyed
// by the LAST path segment (every action route is /registrations/{id}/<verb>)
// rather than by full URL/method, since every call this file makes is a POST.
const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json?: unknown }[],
  next: new Map<string, Promise<unknown>>(),
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method ?? "GET", json: options?.json });
      const key = url.split("/").pop()!;
      const queued = net.next.get(key);
      if (queued) {
        net.next.delete(key);
        return queued;
      }
      return Promise.resolve({});
    },
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";

/** An externally-settleable promise — lets a test observe the OPTIMISTIC
 *  state (after the flip, before the network settles) before deciding
 *  whether the request succeeds or 4xxs. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Typed against the COMPONENT's own props, not `as const` inference. With
// `as const` the base literals are `"pending"`/`"manual"`, so
// `Partial<typeof PROPS>` rejects every override this suite makes
// (`"waitlisted"`, `"confirmed"`, `"paid"`, `"auto"`) — 26 tsc errors that
// vitest never sees, because vitest does not typecheck test files. Binding to
// the real prop type also makes the fixture track the contract: narrowing the
// component's accepted statuses would red here instead of silently letting a
// test assert a state the component can no longer be given.
type ActionProps = ComponentProps<typeof RegistrationHubRegistrantActions>;

// amountCents: 0 / paymentIntentId: null by default — a free entry never
// hits RS005 R1's awaiting-payment carve-out, so every EXISTING test below
// (written before that carve-out existed) keeps exercising approve/reject/
// withdraw/promote's plain approval-mode/status legality unchanged. Tests
// that need a real fee override both explicitly.
const PROPS: ActionProps = {
  registrationId: "reg-1",
  status: "pending",
  approval: "manual",
  amountCents: 0,
  divisionFeeCents: 0,
  paymentIntentId: null,
  entryPaymentIntentId: null,
  refundedCents: 0,
  lastRemindedAt: null,
  remindersInWindow: 0,
  approvedAt: null,
};

function mount(overrides: Partial<ActionProps> = {}) {
  return renderIsland(RegistrationHubRegistrantActions, { ...PROPS, ...overrides });
}

function findAction(island: ReturnType<typeof mount>, action: string) {
  return island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-action"] === action);
}

beforeEach(() => {
  nav.refresh.mockClear();
  confirmMock.fn.mockReset();
  confirmMock.fn.mockImplementation(async () => true);
  net.calls.length = 0;
  net.next.clear();
});

describe("RegistrationHubRegistrantActions — legality (which buttons render)", () => {
  it("shows approve and reject on a manual division's pending entry", () => {
    const island = mount({ status: "pending", approval: "manual" });
    expect(findAction(island, "approve")).toBeTruthy();
    expect(findAction(island, "reject")).toBeTruthy();
  });

  it("shows approve and reject on a manual division's paid entry", () => {
    const island = mount({ status: "paid", approval: "manual" });
    expect(findAction(island, "approve")).toBeTruthy();
    expect(findAction(island, "reject")).toBeTruthy();
  });

  it("hides approve and reject on an auto-approval division, even pending/paid", () => {
    const island = mount({ status: "pending", approval: "auto" });
    expect(findAction(island, "approve")).toBeUndefined();
    expect(findAction(island, "reject")).toBeUndefined();
  });

  it("hides approve and reject on a terminal row, even a manual division", () => {
    const island = mount({ status: "rejected", approval: "manual" });
    expect(findAction(island, "approve")).toBeUndefined();
    expect(findAction(island, "reject")).toBeUndefined();
  });

  it("shows withdraw on every non-terminal status", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      expect(findAction(mount({ status, approval: "auto" }), "withdraw")).toBeTruthy();
    }
  });

  it("hides withdraw on every terminal status", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(findAction(mount({ status, approval: "auto" }), "withdraw")).toBeUndefined();
    }
  });

  // RS007 finding #16 — the refund control. Until this wave the endpoint
  // (POST /api/v1/registrations/{id}/refund) and its confirm copy
  // (confirm.refundRegistration.*, written in all four locales since RS002)
  // had NO caller anywhere in apps/web/src.
  it("hides refund when there is no payment on file", () => {
    expect(
      findAction(mount({ status: "confirmed", approval: "auto", amountCents: 2500 }), "refund"),
    ).toBeUndefined();
  });

  // Polish wave W8 (walkthrough s08b): the still-unpaid entry of a cart whose SIBLING paid. The cart's intent is the sibling's
  // payment; this entry has none of its own, so Refund is hidden (the server refuses it 422 - it used to refund the sibling's money).
  it("hides refund on an unpaid entry whose cart carries a sibling's payment (W8)", () => {
    const island = mount({ status: "pending", approval: "auto", amountCents: 1000, divisionFeeCents: 1000, paymentIntentId: "pi_sibling", entryPaymentIntentId: null });
    expect(findAction(island, "refund")).toBeUndefined();
    expect(findAction(island, "withdraw"), "the row still has its other actions (the control set is not empty)").toBeTruthy();
  });

  it("shows refund on a paid entry with a balance left", () => {
    expect(
      findAction(
        mount({ status: "confirmed", approval: "auto", amountCents: 2500, paymentIntentId: "pi_1", entryPaymentIntentId: "pi_1" }),
        "refund",
      ),
    ).toBeTruthy();
  });

  it("hides refund once the entry is fully refunded — the server answers 'Already fully refunded'", () => {
    expect(
      findAction(
        mount({
          status: "confirmed",
          approval: "auto",
          amountCents: 2500,
          refundedCents: 2500,
          paymentIntentId: "pi_1",
          entryPaymentIntentId: "pi_1",
        }),
        "refund",
      ),
    ).toBeUndefined();
  });

  // The case the control exists for, and the one every OTHER action here is
  // hidden on. Past `refund_lock_at` withdrawCore refuses to auto-refund and
  // the registrant is told at that moment that any refund is "at the
  // organiser's discretion" — so the organiser must still be able to act on a
  // TERMINAL row, unlike withdraw/resend/approve/reject.
  it("shows refund on a WITHDRAWN entry that was paid, where every other action is hidden", () => {
    const island = mount({
      status: "withdrawn",
      approval: "manual",
      amountCents: 4000,
      paymentIntentId: "pi_1",
      entryPaymentIntentId: "pi_1",
    });
    expect(findAction(island, "refund")).toBeTruthy();
    expect(findAction(island, "withdraw")).toBeUndefined();
    expect(findAction(island, "resend")).toBeUndefined();
    expect(findAction(island, "approve")).toBeUndefined();
  });

  it("shows promote ONLY for a waitlisted entry", () => {
    expect(findAction(mount({ status: "waitlisted" }), "promote")).toBeTruthy();
    expect(findAction(mount({ status: "confirmed" }), "promote")).toBeUndefined();
    expect(findAction(mount({ status: "pending" }), "promote")).toBeUndefined();
  });

  // RS005 R1 second-wave finding — corrects the ORIGINAL "always shows
  // resend" rule this test used to assert: observed live, a WITHDRAWN entry
  // rendered Resend and the send succeeded, mailing someone who had pulled
  // out a cart-shaped "you're registered" confirmation, siblings included.
  it("shows resend on every non-terminal status, for every approval mode", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      for (const approval of ["auto", "manual"] as const) {
        expect(findAction(mount({ status, approval }), "resend")).toBeTruthy();
      }
    }
  });

  it("hides resend on every terminal status (withdrawn, rejected, expired) — a withdrawn/rejected/expired entry must not receive a 'you're registered' email", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      expect(findAction(mount({ status, approval: "auto" }), "resend")).toBeUndefined();
      expect(findAction(mount({ status, approval: "manual" }), "resend")).toBeUndefined();
    }
  });
});

describe("RegistrationHubRegistrantActions — confirm gating", () => {
  it("does NOT confirm before approving (a safe action)", async () => {
    const island = mount({ status: "pending", approval: "manual" });
    await (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).not.toHaveBeenCalled();
    expect(net.calls.some((c) => c.url === "/api/v1/registrations/reg-1/approve" && c.method === "POST")).toBe(
      true,
    );
  });

  it("confirms before rejecting, with a danger tone", async () => {
    const island = mount({ status: "pending", approval: "manual" });
    await (propsOf(findAction(island, "reject")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({ tone: "danger" });
    expect(net.calls.some((c) => c.url === "/api/v1/registrations/reg-1/reject")).toBe(true);
  });

  it("sends no request, and changes nothing, when the reject confirm is cancelled", async () => {
    confirmMock.fn.mockImplementationOnce(async () => false);
    const island = mount({ status: "pending", approval: "manual" });
    await (propsOf(findAction(island, "reject")!).onClick as () => Promise<void>)();
    expect(net.calls.some((c) => c.url.endsWith("/reject"))).toBe(false);
    expect(findAction(island, "reject")).toBeTruthy();
    expect(findAction(island, "approve")).toBeTruthy();
  });

  it("confirms before withdrawing too", async () => {
    const island = mount({ status: "confirmed", approval: "auto" });
    await (propsOf(findAction(island, "withdraw")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
  });

  // RS007 finding #16. The assertion that matters is the URL: the whole
  // defect was that `POST /api/v1/registrations/{id}/refund` had no caller,
  // so a test that only checked a button rendered would have passed against
  // a button wired to nothing.
  it("confirms with the pre-existing refund copy, then POSTs to the refund endpoint", async () => {
    const island = mount({
      status: "withdrawn",
      approval: "auto",
      amountCents: 4000,
      paymentIntentId: "pi_1",
      entryPaymentIntentId: "pi_1",
    });
    await (propsOf(findAction(island, "refund")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({
      title: t(uiEn, "confirm.refundRegistration.title"),
      confirmLabel: t(uiEn, "confirm.refundRegistration.label"),
      tone: "danger",
    });
    expect(
      net.calls.some((c) => c.url === "/api/v1/registrations/reg-1/refund" && c.method === "POST"),
      `no POST reached the refund endpoint — calls were ${JSON.stringify(net.calls)}`,
    ).toBe(true);
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("sends no refund request when the confirm is cancelled — money must never move on a mis-click", async () => {
    confirmMock.fn.mockImplementationOnce(async () => false);
    const island = mount({
      status: "withdrawn",
      approval: "auto",
      amountCents: 4000,
      paymentIntentId: "pi_1",
      entryPaymentIntentId: "pi_1",
    });
    await (propsOf(findAction(island, "refund")!).onClick as () => Promise<void>)();
    expect(net.calls.some((c) => c.url.endsWith("/refund"))).toBe(false);
  });

  // A refund does not change `status`, so the button must survive the round
  // trip rather than being optimistically cleared: it is `refunded_cents`,
  // arriving via router.refresh(), that turns canRefund false.
  it("surfaces the server's own error text when a refund is refused, and leaves the row alone", async () => {
    net.next.set("refund", Promise.reject(new ApiV1Error("Already fully refunded", 422, "ERROR")));
    const island = mount({
      status: "withdrawn",
      approval: "auto",
      amountCents: 4000,
      paymentIntentId: "pi_1",
      entryPaymentIntentId: "pi_1",
    });
    await (propsOf(findAction(island, "refund")!).onClick as () => Promise<void>)();
    const feedback = island
      .tree()
      .find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined);
    expect(propsOf(feedback!)["data-tone"]).toBe("error");
    expect(findAction(island, "refund")).toBeTruthy();
  });

  it("does not confirm before promoting or resending", async () => {
    const promoteIsland = mount({ status: "waitlisted" });
    await (propsOf(findAction(promoteIsland, "promote")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).not.toHaveBeenCalled();

    const resendIsland = mount({ status: "confirmed" });
    await (propsOf(findAction(resendIsland, "resend")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).not.toHaveBeenCalled();
  });
});

describe("RegistrationHubRegistrantActions — optimistic flip + 4xx revert", () => {
  it("hides approve/reject the instant reject is confirmed, then REVERTS on a 4xx and shows the server's own message", async () => {
    const d = deferred<unknown>();
    net.next.set("reject", d.promise);
    const island = mount({ status: "paid", approval: "manual" });

    const click = (propsOf(findAction(island, "reject")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "reject")).toBeUndefined());
    // Optimistically flipped to "rejected" (terminal) — approve is gone too,
    // and the row's OWN controls, not just a spinner, reflect the flip.
    expect(findAction(island, "approve")).toBeUndefined();

    d.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR"));
    await click;

    // Reverted: an organiser must never be shown a state the server refused.
    expect(findAction(island, "reject")).toBeTruthy();
    expect(findAction(island, "approve")).toBeTruthy();
    expect(island.text()).toContain("This registration was already refunded and cannot be approved");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("keeps the optimistic flip and refreshes on a successful reject", async () => {
    const island = mount({ status: "paid", approval: "manual" });
    await (propsOf(findAction(island, "reject")!).onClick as () => Promise<void>)();
    expect(findAction(island, "reject")).toBeUndefined();
    expect(findAction(island, "withdraw")).toBeUndefined(); // rejected is terminal
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.status.rejected"));
  });

  it("reverts a failed approve back to its pending controls, with the server's message shown", async () => {
    const d = deferred<unknown>();
    net.next.set("approve", d.promise);
    const island = mount({ status: "pending", approval: "manual" });

    const click = (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "approve")).toBeUndefined());

    // A generic revert check — deliberately NOT the awaiting-payment text,
    // which now drives the fee-override recovery covered in its own
    // describe block below (RS005 F2 finding 3).
    d.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR"));
    await click;

    expect(findAction(island, "approve")).toBeTruthy();
    expect(island.text()).toContain("This registration was already refunded and cannot be approved");
  });

  it("reverts a failed withdraw back to its controls too", async () => {
    const d = deferred<unknown>();
    net.next.set("withdraw", d.promise);
    const island = mount({ status: "confirmed", approval: "auto" });

    const click = (propsOf(findAction(island, "withdraw")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "withdraw")).toBeUndefined());

    d.reject(new ApiV1Error("Something went wrong", 500, "INTERNAL"));
    await click;

    expect(findAction(island, "withdraw")).toBeTruthy();
    expect(island.text()).toContain("Something went wrong");
  });

  it("promote: hides itself once clicked, and a success shows a generic 'promoted' message rather than guessing a specific resulting status", async () => {
    const island = mount({ status: "waitlisted", approval: "manual" });
    await (propsOf(findAction(island, "promote")!).onClick as () => Promise<void>)();
    expect(findAction(island, "promote")).toBeUndefined();
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.promoted"));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("promote: a 4xx brings the button back with the server's message", async () => {
    const d = deferred<unknown>();
    net.next.set("promote", d.promise);
    const island = mount({ status: "waitlisted", approval: "manual" });

    const click = (propsOf(findAction(island, "promote")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "promote")).toBeUndefined());

    d.reject(new ApiV1Error("Division is at capacity", 422, "ERROR"));
    await click;

    expect(findAction(island, "promote")).toBeTruthy();
    expect(island.text()).toContain("Division is at capacity");
  });

  it("promote sends registration_id, so it promotes THIS row rather than the division's default oldest-waitlisted pick", async () => {
    const island = mount({ status: "waitlisted", registrationId: "reg-77" });
    await (propsOf(findAction(island, "promote")!).onClick as () => Promise<void>)();
    const call = net.calls.find((c) => c.url === "/api/v1/registrations/reg-77/promote");
    expect(call).toBeTruthy();
    expect(call!.json).toEqual({ registration_id: "reg-77" });
  });
});

describe("RegistrationHubRegistrantActions — resend, distinguishable feedback", () => {
  it("shows a distinct, visible success message when the email is actually sent", async () => {
    net.next.set("resend-confirmation", Promise.resolve({ sent: true }));
    const island = mount({ status: "confirmed" });
    await (propsOf(findAction(island, "resend")!).onClick as () => Promise<void>)();
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.resent"));
  });

  it("distinguishes a false `sent` result from a real send — never reads the same as success or as nothing happened", async () => {
    net.next.set("resend-confirmation", Promise.resolve({ sent: false }));
    const island = mount({ status: "confirmed" });
    await (propsOf(findAction(island, "resend")!).onClick as () => Promise<void>)();
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.resendNotSent"));
    expect(island.text()).not.toContain(t(uiEn, "reg.hub.registrants.detail.actions.resent"));
  });

  it("surfaces the server's error message on a failed resend", async () => {
    net.next.set("resend-confirmation", Promise.reject(new ApiV1Error("Rate limited", 429, "RATE_LIMITED")));
    const island = mount({ status: "confirmed" });
    await (propsOf(findAction(island, "resend")!).onClick as () => Promise<void>)();
    expect(island.text()).toContain("Rate limited");
  });
});

describe("RegistrationHubRegistrantActions — data hook", () => {
  it("carries a root data hook for e2e/regression targeting", () => {
    const island = mount();
    const root = island.tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-registrant-actions");
  });
});

// RS005 R1 finding 1's recovery path. Component-level rendering only —
// deriveRegistrantActionFlags's own pure-function legality (including the
// mutual-exclusion-with-approve invariant and the full status/fee/payment
// matrix) is exhaustively covered in registration-hub-registrant-derive.test.ts;
// these assert the CONTROL renders/wires exactly where that pure function
// says it should, and that its confirm/success/revert plumbing is correct.
describe("RegistrationHubRegistrantActions — mark paid (RS005 R1 finding 1)", () => {
  it("shows mark paid on a pending, fee-bearing, unpaid entry — and (polish wave P5, W12) approve beside it: two decisions", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(findAction(island, "approve")).toBeTruthy();
  });

  it("hides mark paid once the entry's OWN payment intent exists", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: "pi_123", entryPaymentIntentId: "pi_123" });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  // Polish wave P5 (P1 carry): a card cart where only a SIBLING paid carries the sibling's intent on the cart; this entry paid
  // nothing, so Mark paid is its way forward; W12: Approve is offered too (it approves with the fee due and seats nobody).
  it("a sibling's payment on the cart does not hide mark paid on the unpaid entry", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1000, divisionFeeCents: 1000, paymentIntentId: "pi_sibling", entryPaymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(findAction(island, "approve")).toBeTruthy();
  });

  it("hides mark paid on a free entry (amountCents 0)", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, divisionFeeCents: 0, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("hides mark paid on a non-pending status", () => {
    const island = mount({ status: "paid", approval: "manual", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("shows mark paid on an AUTO-approval division too — markRegistrationPaidOffline itself carries no approval-mode check", () => {
    const island = mount({ status: "pending", approval: "auto", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
  });

  it("confirms before marking paid, reusing the pre-existing confirm.markPaidRegistration copy (auto division: it confirms the entry)", async () => {
    const island = mount({ status: "pending", approval: "auto", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({
      title: t(uiEn, "confirm.markPaidRegistration.title"),
      body: t(uiEn, "confirm.markPaidRegistration.body"),
      confirmLabel: t(uiEn, "confirm.markPaidRegistration.label"),
      tone: "default",
    });
    expect(net.calls.some((c) => c.url === "/api/v1/registrations/reg-1/mark-paid" && c.method === "POST")).toBe(
      true,
    );
  });

  it("sends no request, and changes nothing, when the mark-paid confirm is cancelled", async () => {
    confirmMock.fn.mockImplementationOnce(async () => false);
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(net.calls.some((c) => c.url.endsWith("/mark-paid"))).toBe(false);
    expect(findAction(island, "mark-paid")).toBeTruthy();
  });

  it("hides itself the instant mark-paid is confirmed (auto division: optimistic flip straight to confirmed — the real, single-step server behaviour), then reverts on a 4xx with the server's own message", async () => {
    const d = deferred<unknown>();
    net.next.set("mark-paid", d.promise);
    const island = mount({ status: "pending", approval: "auto", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });

    const click = (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "mark-paid")).toBeUndefined());
    expect(findAction(island, "approve")).toBeUndefined();
    expect(findAction(island, "withdraw")).toBeTruthy(); // optimistically "confirmed", not terminal

    // A generic revert check — deliberately NOT the no-entry-fee text,
    // which now drives the fee-override recovery covered in its own
    // describe block below (RS005 F2 finding 3).
    d.reject(new ApiV1Error("This registration was paid by card — refund it on the payments trail instead", 422, "ERROR"));
    await click;

    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(island.text()).toContain("This registration was paid by card — refund it on the payments trail instead");
  });

  it("keeps the optimistic flip and refreshes on a successful mark-paid, showing the dedicated 'marked as paid' message", async () => {
    const island = mount({ status: "pending", approval: "auto", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null });
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(findAction(island, "mark-paid")).toBeUndefined();
    expect(findAction(island, "approve")).toBeUndefined();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.markedPaid"));
  });
});

// Polish wave P5 (W12): Approve and Mark paid are two decisions on a manual division. The server rules under the controls
// (registration-approval.ts, organiser-actions.ts): Approve on an unpaid entry approves it and leaves it pending (fee due); Mark paid on
// an entry not yet approved records the money and leaves it `paid`, awaiting approval; whichever comes second confirms.
describe("RegistrationHubRegistrantActions — Approve and Mark paid split (W12)", () => {
  const UNPAID_MANUAL = { status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500, paymentIntentId: null } as const;
  const approvedCaption = (island: ReturnType<typeof mount>) =>
    island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-approved-awaiting-payment"] !== undefined);

  it("Approve on an unpaid entry: it stays pending - Approve goes, Mark paid stays, the row says 'approved, payment due'", async () => {
    const island = mount(UNPAID_MANUAL);
    expect(approvedCaption(island), "the empty case: nothing approved yet, no caption").toBeUndefined();
    await (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    expect(net.calls.some((c) => c.url === "/api/v1/registrations/reg-1/approve" && c.method === "POST")).toBe(true);
    expect(findAction(island, "approve"), "approved once: nothing more to approve").toBeUndefined();
    expect(findAction(island, "mark-paid"), "the fee is still due").toBeTruthy();
    expect(approvedCaption(island)).toBeTruthy();
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.approvedPaymentDue"));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("a refused Approve on an unpaid entry leaves Approve in place and claims no approval", async () => {
    net.next.set("approve", Promise.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR")));
    const island = mount(UNPAID_MANUAL);
    await (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    expect(findAction(island, "approve")).toBeTruthy();
    expect(approvedCaption(island)).toBeUndefined();
  });

  it("an entry already approved ahead of payment (approvedAt from the server): no Approve, the caption, and Mark paid promises to confirm", async () => {
    const island = mount({ ...UNPAID_MANUAL, approvedAt: "2026-11-12T10:00:00.000Z" });
    expect(findAction(island, "approve")).toBeUndefined();
    expect(approvedCaption(island)).toBeTruthy();
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({
      body: t(uiEn, "confirm.markPaidRegistration.body"),
      confirmLabel: t(uiEn, "confirm.markPaidRegistration.label"),
    });
    // The payment confirms the approved entry: everything pending-only goes.
    expect(findAction(island, "mark-paid")).toBeUndefined();
    expect(approvedCaption(island), "confirmed: no longer awaiting payment").toBeUndefined();
  });

  it("Mark paid on an entry NOT yet approved: the dialog says it stays awaiting approval, and the row lands on paid with Approve offered", async () => {
    const island = mount(UNPAID_MANUAL);
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({
      body: t(uiEn, "confirm.markPaidRegistration.bodyAwaitingApproval"),
      confirmLabel: t(uiEn, "confirm.markPaidRegistration.labelAwaitingApproval"),
    });
    expect(t(uiEn, "confirm.markPaidRegistration.bodyAwaitingApproval"), "two different promises").not.toBe(t(uiEn, "confirm.markPaidRegistration.body"));
    expect(findAction(island, "mark-paid")).toBeUndefined();
    expect(findAction(island, "approve"), "paid, awaiting the organiser's yes").toBeTruthy();
    expect(approvedCaption(island)).toBeUndefined();
  });
});

// RS005 R1 finding 2, whole-branch review MAJOR — the assertion that matters
// most. Old behaviour: `runStatusAction` captured `optimisticStatus` in a
// plain closure variable at CLICK time and restored exactly that value in
// `catch`, unconditionally. If a `router.refresh()` — fired by ANY other
// row's action on the same page, or a second organiser editing this same
// row — lands a FRESHER `status` prop while this row's own request is still
// in flight, the render-time prop-sync block (above) already moves
// `optimisticStatus` to that fresh truth — and the OLD catch then clobbered
// it straight back to the stale click-time snapshot the moment the request
// failed, showing an organiser a status the server had already moved past.
describe("RegistrationHubRegistrantActions — finding 2: a failure never resurrects a stale status (RS005 R1)", () => {
  it("a fresher prop landing mid-flight survives a subsequent 4xx — the row shows the SERVER's current status, never the click-time one", async () => {
    const d = deferred<unknown>();
    net.next.set("reject", d.promise);
    const island = mount({ status: "paid", approval: "manual", amountCents: 0, divisionFeeCents: 0, paymentIntentId: null });

    // Click time: optimistic flip to "rejected" (terminal) — approve AND
    // withdraw both disappear.
    const click = (propsOf(findAction(island, "reject")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "reject")).toBeUndefined());
    expect(findAction(island, "withdraw")).toBeUndefined();

    // While the reject request is STILL in flight, a router.refresh() from
    // elsewhere lands this row's real, current server truth: another
    // organiser already approved it through a different session.
    island.rerender({
      registrationId: "reg-1",
      status: "confirmed",
      approval: "manual",
      amountCents: 0,
      divisionFeeCents: 0,
      paymentIntentId: null,
      entryPaymentIntentId: null,
  refundedCents: 0,
      lastRemindedAt: null,
      remindersInWindow: 0,
      approvedAt: null,
    });
    // The existing render-time prop-sync already reconciles to it —
    // withdraw (legal on "confirmed") reappears.
    expect(findAction(island, "withdraw")).toBeTruthy();

    // NOW the original (now-stale) reject request fails.
    d.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR"));
    await click;

    // The bug this guards: reverting to the click-time snapshot ("paid")
    // would resurrect a status the server has already moved past. The row
    // must keep showing "confirmed" — withdraw still legal, reject/approve
    // still illegal (confirmed is past the awaiting-decision window) —
    // never fall back to "paid"'s own control set.
    expect(findAction(island, "withdraw")).toBeTruthy();
    expect(findAction(island, "reject")).toBeUndefined();
    expect(findAction(island, "approve")).toBeUndefined();
    expect(island.text()).toContain("This registration was already refunded and cannot be approved");
  });

  it("with NO concurrent prop change, a 4xx still reverts to the pre-click status exactly as before — the fix does not change the common case", async () => {
    const d = deferred<unknown>();
    net.next.set("withdraw", d.promise);
    const island = mount({ status: "confirmed", approval: "auto", amountCents: 0, divisionFeeCents: 0, paymentIntentId: null });

    const click = (propsOf(findAction(island, "withdraw")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "withdraw")).toBeUndefined());

    d.reject(new ApiV1Error("Something went wrong", 500, "INTERNAL"));
    await click;

    expect(findAction(island, "withdraw")).toBeTruthy();
    expect(island.text()).toContain("Something went wrong");
  });
});

// RS005 F2 finding 4 — one level deeper than finding 2 above. `latestStatusRef`
// only ever learned a fresh status from the `status` PROP (via the effect in
// the component), which lags until router.refresh() actually lands new server
// data. router.refresh() is fire-and-forget and `finally` re-enables every
// button before that lands — so a SECOND action on the SAME row, clicked in
// that window, used to revert to whatever the ref held from mount, never to
// what this row's OWN first action had just confirmed.
describe("RegistrationHubRegistrantActions — finding 4 (RS005 F2): a later action's revert must not precede this row's own just-confirmed success", () => {
  it("approve succeeds (no rerender/refresh simulated); a SUBSEQUENT withdraw then 4xxs — must settle on 'confirmed', never resurrect approve/reject", async () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, divisionFeeCents: 0, paymentIntentId: null });

    // approve resolves immediately (nothing queued for "approve" -> the
    // net harness's default Promise.resolve({})). optimisticStatus flips to
    // "confirmed" and STAYS there — this test never calls island.rerender(),
    // matching the real world where router.refresh() has not landed yet.
    await (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    expect(findAction(island, "approve")).toBeUndefined();
    expect(findAction(island, "withdraw")).toBeTruthy(); // "confirmed" is non-terminal

    // A second action, still within that same in-flight-refresh window, now
    // fails.
    const d = deferred<unknown>();
    net.next.set("withdraw", d.promise);
    const click = (propsOf(findAction(island, "withdraw")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "withdraw")).toBeUndefined());
    d.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR"));
    await click;

    // The bug: reverting to latestStatusRef's stale, prop-derived value
    // ("pending") would resurrect approve/reject on an entry the server
    // already confirmed. Must settle on "confirmed" instead — approve/
    // reject both illegal there (past the awaiting-decision window),
    // withdraw legal again.
    expect(findAction(island, "approve")).toBeUndefined();
    expect(findAction(island, "reject")).toBeUndefined();
    expect(findAction(island, "withdraw")).toBeTruthy();
  });
});

// RS005 F2 finding 3: deriveRegistrantActionFlags's amount_cents-based guess
// stands in for the division's LIVE registration_settings.fee_cents
// (registration-approval.ts:128, usecases/registrations/) — after an organiser
// edits the division's fee, the two disagree and the WRONG control renders
// and 422s while the RIGHT one stays hidden. Neither error carries a
// distinguishing `code` (both default to "UNKNOWN" — HttpError's optional
// `code` was never passed for either), so the recovery matches each
// usecase's own distinctive English substring — the same "surface the
// server's own English text" contract this file already depends on (see the
// header comment; this repo never translates thrown messages).
describe("RegistrationHubRegistrantActions — a fee edited after the entry exists", () => {
  // The island now receives the DIVISION's live fee, so the correct control
  // renders on the FIRST render. This replaces a version that inferred the fee
  // from the server's 4xx TEXT: that needed a failed click before it could be
  // right, and coupled these buttons to error prose no test pins — two
  // unrelated fixtures had to be reworded to stop colliding with the match.
  it("fee raised 0 -> 20.00 under a pending entry: offers mark paid (and, W12, approve with the fee due)", () => {
    const island = mount({
      status: "pending",
      approval: "manual",
      amountCents: 0, // quoted while the division was free
      divisionFeeCents: 2000, // charged now
      paymentIntentId: null,
  refundedCents: 0,
    });
    expect(findAction(island, "mark-paid"), "the control the server accepts").toBeTruthy();
    expect(findAction(island, "approve"), "W12: approve approves it with the fee due").toBeTruthy();
  });

  it("fee dropped 20.00 -> 0 under a pending entry: offers approve, not mark paid", () => {
    const island = mount({
      status: "pending",
      approval: "manual",
      amountCents: 2000,
      divisionFeeCents: 0,
      paymentIntentId: null,
  refundedCents: 0,
    });
    expect(findAction(island, "approve"), "nothing is owed, so approve is live").toBeTruthy();
    expect(findAction(island, "mark-paid"), "mark paid would 422 'no entry fee'").toBeUndefined();
  });
});

// Player payment page, Task 6: the organiser's "Send payment reminder".
describe("RegistrationHubRegistrantActions — send payment reminder", () => {
  const owed = { status: "pending", approval: "auto", divisionFeeCents: 1500, amountCents: 1500 } as const;
  const feedbackOf = (island: ReturnType<typeof mount>) =>
    propsOf(island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined)!);
  const press = (island: ReturnType<typeof mount>) => (propsOf(findAction(island, "remind")!).onClick as () => Promise<void>)();
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  it("renders iff the entry is pending in a division with a fee, labelled from the dictionary, after resend", () => {
    let checked = 0;
    for (const status of ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "rejected", "expired"] as const) {
      for (const divisionFeeCents of [0, 1500]) {
        const island = mount({ ...owed, status, divisionFeeCents });
        expect(!!findAction(island, "remind"), `${status} / fee ${divisionFeeCents}`).toBe(status === "pending" && divisionFeeCents > 0);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity").toBe(14);
    const island = mount(owed);
    const labelOf = propsOf(findAction(island, "remind")!).children;
    expect(String(labelOf)).toBe(t(uiEn, "reg.action.remind"));
    expect(t(uiEn, "reg.action.remind")).toBe("Send payment reminder");
    const keys = island.tree().map((e) => propsOf(e)["data-registration-hub-registrant-action"]).filter(Boolean);
    expect(keys.indexOf("remind"), "after Resend confirmation email").toBe(keys.indexOf("resend") + 1);
  });

  it("the rename landed in every locale: each differs from its previous value", () => {
    const before = { en: "Send reminder", es: "Enviar recordatorio", fr: "Envoyer un rappel", nl: "Herinnering sturen" };
    const now = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };
    for (const loc of ["en", "es", "fr", "nl"] as const) {
      expect((now[loc] as Record<string, string>)["reg.action.remind"], loc).not.toBe(before[loc]);
    }
  });

  it("sends with no confirm when never reminded, or last reminded over an hour ago; success says 'Payment reminder sent.'", async () => {
    for (const lastRemindedAt of [null, ago(REMINDER_CONFIRM_WITHIN_MS + 60_000)]) {
      confirmMock.fn.mockClear();
      net.calls.length = 0;
      net.next.set("remind", Promise.resolve({ sent: true }));
      const island = mount({ ...owed, lastRemindedAt });
      await press(island);
      expect(confirmMock.fn, String(lastRemindedAt)).not.toHaveBeenCalled();
      expect(net.calls.map((c) => c.url)).toEqual(["/api/v1/registrations/reg-1/remind"]);
      expect(island.text()).toContain("Payment reminder sent.");
      expect(island.text()).toContain(t(uiEn, "reg.remind.sent"));
      expect(nav.refresh).toHaveBeenCalled();
    }
  });

  it("asks first when last reminded under an hour ago; cancelling sends nothing, confirming sends", async () => {
    const lastRemindedAt = ago(REMINDER_CONFIRM_WITHIN_MS - 60_000);
    confirmMock.fn.mockImplementationOnce(async () => false);
    const island = mount({ ...owed, lastRemindedAt });
    await press(island);
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
    expect(confirmMock.fn.mock.calls[0]![0]).toMatchObject({
      title: t(uiEn, "reg.remind.confirmRecent.title"),
      body: t(uiEn, "reg.remind.confirmRecent.body"),
    });
    expect(net.calls, "cancelled: no request").toHaveLength(0);

    net.next.set("remind", Promise.resolve({ sent: true }));
    await press(island);
    expect(confirmMock.fn).toHaveBeenCalledTimes(2);
    expect(net.calls).toHaveLength(1);
  });

  it("{ sent: false } says it may arrive late; the 429 says the limit in the organiser's own copy, not the server's English", async () => {
    net.next.set("remind", Promise.resolve({ sent: false }));
    const late = mount(owed);
    await press(late);
    expect(late.text()).toContain(t(uiEn, "reg.remind.notSent"));
    expect(propsOf(findAction(late, "remind")!)).toBeTruthy();

    net.next.set("remind", Promise.reject(new ApiV1Error("SERVER ENGLISH WORDS", 429, "PAYMENT_REMINDER_LIMIT")));
    const capped = mount(owed);
    await press(capped);
    expect(feedbackOf(capped)["data-tone"]).toBe("error");
    expect(capped.text()).toContain(t(uiEn, "reg.remind.limit", { count: REMINDER_CAP_PER_DAY }));
    // Gap wave G8: the number is the cap the server enforces, filled in - never a placeholder left showing.
    expect(capped.text()).toMatch(new RegExp(`\\b${REMINDER_CAP_PER_DAY}\\b`));
    expect(capped.text()).not.toContain("{count}");
    expect(capped.text()).not.toContain("SERVER ENGLISH WORDS");

    net.next.set("remind", Promise.reject(new ApiV1Error("Some other refusal", 422, "ERROR")));
    const other = mount(owed);
    await press(other);
    expect(other.text()).toContain("Some other refusal");
  });

  // Registration walk-fix F13 (walkthrough R08, presses 6 and 7): the cap is known before the press, so at the cap the button says
  // so and is disabled - no "Send another reminder?" dialog for a press the server will refuse. The count is the organiser's presses
  // in the cap's own 24 h window (the row's `reminders_in_window`, read with the cap's own SQL). Below the cap nothing changes.
  it("at the cap the button is disabled and says 'Reminder limit reached' (title: the limit sentence); pressing asks nothing and sends nothing; one below it still works", async () => {
    const recent = ago(REMINDER_CONFIRM_WITHIN_MS - 60_000);
    let checked = 0;
    for (const n of [REMINDER_CAP_PER_DAY, REMINDER_CAP_PER_DAY + 2]) {
      confirmMock.fn.mockClear();
      net.calls.length = 0;
      const island = mount({ ...owed, lastRemindedAt: recent, remindersInWindow: n });
      const button = propsOf(findAction(island, "remind")!);
      expect(button.disabled, `${n} presses: disabled`).toBe(true);
      expect(String(button.children), `${n}: the label`).toBe(t(uiEn, "reg.action.remindLimitReached"));
      expect(t(uiEn, "reg.action.remindLimitReached")).toBe("Reminder limit reached");
      expect(button.title, `${n}: the reason`).toBe(t(uiEn, "reg.remind.limit", { count: REMINDER_CAP_PER_DAY }));
      await (button.onClick as () => Promise<void>)();
      expect(confirmMock.fn, `${n}: no dialog`).not.toHaveBeenCalled();
      expect(net.calls, `${n}: no request`).toHaveLength(0);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(2);

    // One below the cap: the old behaviour, recent press asks first.
    confirmMock.fn.mockClear();
    net.next.set("remind", Promise.resolve({ sent: true }));
    const below = mount({ ...owed, lastRemindedAt: recent, remindersInWindow: REMINDER_CAP_PER_DAY - 1 });
    const live = propsOf(findAction(below, "remind")!);
    expect(live.disabled).toBe(false);
    expect(String(live.children)).toBe(t(uiEn, "reg.action.remind"));
    await (live.onClick as () => Promise<void>)();
    expect(confirmMock.fn).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(1);
  });

  it("'Reminder limit reached' exists in every locale and is not the send label", () => {
    let checked = 0;
    for (const [locale, dict] of [["en", uiEn], ["es", uiEs], ["fr", uiFr], ["nl", uiNl]] as const) {
      const copy = (dict as Record<string, string>)["reg.action.remindLimitReached"];
      expect(copy, `${locale}: the key exists`).toBeTruthy();
      expect(copy, `${locale}: differs from the send label`).not.toBe((dict as Record<string, string>)["reg.action.remind"]);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  // Gap wave G8 (ledger :64): the limit copy hardcoded "5" in every locale, so a change to REMINDER_CAP_PER_DAY (the cap the server
  // enforces, organiser-actions.ts) would leave four dictionaries naming the old number. Each locale now takes it as {count}.
  it("the limit copy takes the cap as {count} in every locale and names no number of its own", () => {
    const own = new RegExp(`\\b${REMINDER_CAP_PER_DAY}\\b`);
    let checked = 0;
    for (const [locale, dict] of [["en", uiEn], ["es", uiEs], ["fr", uiFr], ["nl", uiNl]] as const) {
      const copy = (dict as Record<string, string>)["reg.remind.limit"];
      expect(copy, `${locale}: the key exists`).toBeTruthy();
      expect(copy!.split("{count}").length - 1, `${locale}: one {count}`).toBe(1);
      expect(copy, `${locale}: no hardcoded cap`).not.toMatch(own);
      expect(t(dict, "reg.remind.limit", { count: REMINDER_CAP_PER_DAY }), `${locale}: the cap is filled in`).toMatch(own);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale was read").toBe(4);
  });
});
