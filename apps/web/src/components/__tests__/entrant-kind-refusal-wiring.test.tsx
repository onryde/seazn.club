// FU1 fix round 1 (m2): the WIRING of the entrant-kind refusal on the registrant hub. Approve, mark paid and promote each
// seat a registrant, and since FU1 each refuses an entry whose kind the division no longer takes (422
// ENTRANT_KIND_NOT_ALLOWED, `kind`). The mapping is lib/__tests__/entrant-kind-refusal.test.ts; a green mapping suite is
// blind to a screen that never calls it, so the screen is mounted through the hook harness (no jsdom here) and driven
// through the handlers a click would call - the same harness as lichess-refusal-surfaces-wiring.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string }[],
  /** What the next call to a route (its last path segment) answers: an error to throw, or nothing for success. */
  refuse: new Map<string, { message: string; status: number; code: string; extra: Record<string, unknown> }>(),
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      net.calls.push({ url, method: options?.method ?? "GET" });
      const key = url.split("/").pop()!;
      const failure = net.refuse.get(key);
      if (failure) {
        net.refuse.delete(key);
        throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
      }
      return {};
    }),
  };
});

import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";

beforeEach(() => {
  nav.refresh.mockClear();
  net.calls.length = 0;
  net.refuse.clear();
});

type ActionProps = Parameters<typeof RegistrationHubRegistrantActions>[0];
const PROPS: ActionProps = {
  registrationId: "reg-1",
  status: "pending",
  approval: "manual",
  amountCents: 0,
  divisionFeeCents: 0,
  paymentIntentId: null,
  refundedCents: 0,
  lastRemindedAt: null,
};
const mount = (o: Partial<ActionProps> = {}) => renderIsland(RegistrationHubRegistrantActions, { ...PROPS, ...o });
const action = (island: ReturnType<typeof mount>, name: string) =>
  island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-action"] === name);
const click = (island: ReturnType<typeof mount>, name: string) => (propsOf(action(island, name)!).onClick as () => Promise<void>)();
const feedback = (island: ReturnType<typeof mount>) => {
  const el = island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined);
  return el ? { tone: propsOf(el)["data-tone"], text: textOf(el) } : null;
};

const SERVER = (kind: string) => `this division doesn't take '${kind}' entrants`;
/** The sentence the dictionary says, with the kind as the Entrants tab's own word - taken from the dictionary, not the code. */
const expected = (kind: "team" | "pair" | "individual") =>
  t(uiEn, "reg.hub.registrants.kindNotAllowed", { kind: t(uiEn, `divset.entrants.kind.${kind}`).toLocaleLowerCase() });

const DOORS = [
  { action: "approve", route: "approve", props: { status: "pending", approval: "manual" } },
  { action: "mark-paid", route: "mark-paid", props: { status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500 } },
  { action: "promote", route: "promote", props: { status: "waitlisted", approval: "auto" } },
] as const;

describe("the registrant hub says an entrant-kind refusal in the organiser's language, on every action that seats", () => {
  it("approve, mark paid and promote: each kind reads as the dictionary's sentence, never the server's English; the button comes back", async () => {
    let checked = 0;
    for (const door of DOORS) {
      for (const kind of ["team", "pair", "individual"] as const) {
        net.refuse.set(door.route, { message: SERVER(kind), status: 422, code: "ENTRANT_KIND_NOT_ALLOWED", extra: { kind } });
        const island = mount({ ...door.props });
        await click(island, door.action);

        expect(net.calls.some((c) => c.url.endsWith(`/${door.route}`)), `premise: ${door.action} was sent`).toBe(true);
        const shown = feedback(island);
        expect(shown?.tone, `${door.action} ${kind}: an error`).toBe("error");
        expect(shown?.text, `${door.action} ${kind}: said from the dictionary`).toBe(expected(kind));
        expect(shown?.text, `${door.action} ${kind}: the slot is filled`).not.toContain("{kind}");
        expect(shown?.text, `${door.action} ${kind}: never the server's English`).not.toBe(SERVER(kind));
        expect(action(island, door.action), `${door.action} ${kind}: the organiser can try again`).toBeTruthy();
        expect(nav.refresh, `${door.action} ${kind}: a refused action refreshes nothing`).not.toHaveBeenCalled();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 3 doors x 3 kinds").toBe(9);
  });

  it("the SEQUENCE: refused, the organiser adds the kind back, the same click succeeds and the refusal is gone", async () => {
    net.refuse.set("approve", { message: SERVER("team"), status: 422, code: "ENTRANT_KIND_NOT_ALLOWED", extra: { kind: "team" } });
    const island = mount({ status: "pending", approval: "manual" });
    await click(island, "approve");
    expect(feedback(island)?.text).toBe(expected("team"));

    await click(island, "approve"); // the server accepts this time
    expect(feedback(island)?.tone).toBe("success");
    expect(feedback(island)?.text).toBe(t(uiEn, "reg.hub.registrants.detail.actions.approved"));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("the other direction: the code without a kind this app knows, and any other refusal, still show the server's own message", async () => {
    let checked = 0;
    for (const [code, extra, message] of [
      ["ENTRANT_KIND_NOT_ALLOWED", {}, SERVER("team")],
      ["ENTRANT_KIND_NOT_ALLOWED", { kind: "squad" }, SERVER("squad")],
      ["ERROR", { kind: "team" }, "Division is at capacity"],
    ] as const) {
      net.refuse.set("promote", { message, status: 422, code, extra });
      const island = mount({ status: "waitlisted", approval: "auto" });
      await click(island, "promote");
      expect(feedback(island)?.text, `${code} ${JSON.stringify(extra)}`).toBe(message);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
