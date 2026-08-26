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

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh }),
}));

const confirmMock = vi.hoisted(() => ({
  fn: vi.fn(async (_opts: { title: string; body: unknown; confirmLabel: string; tone?: string }) => true),
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
  paymentIntentId: null,
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
  it("shows mark paid on a pending, fee-bearing, unpaid entry — and hides approve there, the dead end this wave closes", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(findAction(island, "approve")).toBeUndefined();
  });

  it("hides mark paid once a payment_intent_id already exists", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: "pi_123" });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("hides mark paid on a free entry (amountCents 0)", () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("hides mark paid on a non-pending status", () => {
    const island = mount({ status: "paid", approval: "manual", amountCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("shows mark paid on an AUTO-approval division too — markRegistrationPaidOffline itself carries no approval-mode check", () => {
    const island = mount({ status: "pending", approval: "auto", amountCents: 1500, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
  });

  it("confirms before marking paid, reusing the pre-existing confirm.markPaidRegistration copy", async () => {
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: null });
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
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: null });
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(net.calls.some((c) => c.url.endsWith("/mark-paid"))).toBe(false);
    expect(findAction(island, "mark-paid")).toBeTruthy();
  });

  it("hides itself the instant mark-paid is confirmed (optimistic flip straight to confirmed — the real, single-step server behaviour), then reverts on a 4xx with the server's own message", async () => {
    const d = deferred<unknown>();
    net.next.set("mark-paid", d.promise);
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: null });

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
    const island = mount({ status: "pending", approval: "manual", amountCents: 1500, paymentIntentId: null });
    await (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    expect(findAction(island, "mark-paid")).toBeUndefined();
    expect(findAction(island, "approve")).toBeUndefined();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(island.text()).toContain(t(uiEn, "reg.hub.registrants.detail.actions.markedPaid"));
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
    const island = mount({ status: "paid", approval: "manual", amountCents: 0, paymentIntentId: null });

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
      paymentIntentId: null,
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
    const island = mount({ status: "confirmed", approval: "auto", amountCents: 0, paymentIntentId: null });

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
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, paymentIntentId: null });

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
// (registration-approval.ts:128, registrations.ts:3147) — after an organiser
// edits the division's fee, the two disagree and the WRONG control renders
// and 422s while the RIGHT one stays hidden. Neither error carries a
// distinguishing `code` (both default to "UNKNOWN" — HttpError's optional
// `code` was never passed for either), so the recovery matches each
// usecase's own distinctive English substring — the same "surface the
// server's own English text" contract this file already depends on (see the
// header comment; this repo never translates thrown messages).
describe("RegistrationHubRegistrantActions — fee-edit drift recovery (RS005 F2 finding 3)", () => {
  it("fee 0->2000: approve 422s 'mark it paid first' — mark paid becomes reachable, approve does not come back", async () => {
    const d = deferred<unknown>();
    net.next.set("approve", d.promise);
    // The row's OWN frozen amountCents (0) predates the division's fee edit.
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, paymentIntentId: null });
    expect(findAction(island, "approve")).toBeTruthy();
    expect(findAction(island, "mark-paid")).toBeUndefined();

    const click = (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "approve")).toBeUndefined());
    d.reject(new ApiV1Error("Awaiting payment — mark it paid first, or approve once payment arrives", 422, "ERROR"));
    await click;

    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(findAction(island, "approve")).toBeUndefined();
  });

  it("fee 2000->0: mark paid 422s 'no entry fee' — approve becomes reachable, mark paid does not come back", async () => {
    const d = deferred<unknown>();
    net.next.set("mark-paid", d.promise);
    // The row's OWN frozen amountCents (2000) predates the division's fee
    // edit down to 0 — the mirror-image drift.
    const island = mount({ status: "pending", approval: "manual", amountCents: 2000, paymentIntentId: null });
    expect(findAction(island, "mark-paid")).toBeTruthy();
    expect(findAction(island, "approve")).toBeUndefined();

    const click = (propsOf(findAction(island, "mark-paid")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "mark-paid")).toBeUndefined());
    d.reject(new ApiV1Error("This division has no entry fee", 422, "ERROR"));
    await click;

    expect(findAction(island, "approve")).toBeTruthy();
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });

  it("an UNRELATED approve 4xx does not trigger the override", async () => {
    const d = deferred<unknown>();
    net.next.set("approve", d.promise);
    const island = mount({ status: "pending", approval: "manual", amountCents: 0, paymentIntentId: null });
    const click = (propsOf(findAction(island, "approve")!).onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(findAction(island, "approve")).toBeUndefined());
    d.reject(new ApiV1Error("This registration was already refunded and cannot be approved", 422, "ERROR"));
    await click;

    // Reverts normally — mark-paid must NOT have been force-enabled by an
    // unrelated error.
    expect(findAction(island, "approve")).toBeTruthy();
    expect(findAction(island, "mark-paid")).toBeUndefined();
  });
});
