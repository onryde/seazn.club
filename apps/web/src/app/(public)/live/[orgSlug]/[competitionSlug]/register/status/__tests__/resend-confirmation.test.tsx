// ResendConfirmation — cart-scoped (rid), not per-entry: the confirmation
// mail is cart-shaped. No jsdom: driven through the shared node-env hook
// harness.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland, walk, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { BTN_QUIET_LINK } from "@/components/public-site/register/styles";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  response: null as unknown,
  rejection: null as unknown,
  /** When set, the request waits on it (the response is in flight). */
  hold: null as Promise<unknown> | null,
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
      if (net.hold) return net.hold.then(() => net.response);
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
  net.hold = null;
});

const findButton = (tree: ReturnType<typeof walk>) => tree.find((e) => e.type === "button")!;

describe("ResendConfirmation", () => {
  // B4 review m2: while the request is in flight the button is WORKING, not unavailable. It says so to a screen reader (aria-busy) and
  // keeps full strength (the busy rule outranks the 40% dim, BTN_PRIMARY's pattern); before the click and after the answer it is neither.
  it("in flight: disabled, aria-busy and its busy label; before the click and after the answer, not busy", async () => {
    let release!: () => void;
    net.hold = new Promise<void>((r) => (release = r));
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
    expect(propsOf(findButton(island.tree()))["aria-busy"], "before the click").toBe(false);

    const click = (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));
    const busy = findButton(island.tree());
    expect(textOf(busy), "premise: the request is in flight").toBe("Sending…");
    expect(propsOf(busy).disabled).toBe(true);
    expect(propsOf(busy)["aria-busy"]).toBe(true);

    release();
    await click;
    const after = findButton(island.tree());
    expect(textOf(after)).toBe("Resend confirmation email");
    expect(propsOf(after)["aria-busy"]).toBe(false);
  });

  // Spec §5.1 item 7 and the B4 design review: the footer actions read as text links, not as the uppercase label style. Sentence case,
  // muted, underlined, 44px tall, and a busy one keeps full strength. Every class compiles to a real rule.
  it("the quiet link: sentence case, muted, underlined, 44px, busy at full strength, and every class is a real one", async () => {
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
    const cls = String(propsOf(findButton(island.tree())).className).split(/\s+/);
    expect(cls.join(" ")).toBe(BTN_QUIET_LINK);
    for (const must of ["text-ink-muted", "underline", "min-h-11", "disabled:aria-busy:opacity-100", "disabled:aria-busy:cursor-progress"]) {
      expect(cls, must).toContain(must);
    }
    for (const never of ["uppercase", "tracking-wide", "font-display"]) expect(cls, never).not.toContain(never);
    const compiled = await compileClasses(cls);
    expect(cls.length, "anti-vacuity: classes checked").toBeGreaterThan(8);
    expect(cls.filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0), "classes that compile to nothing").toEqual([]);
  }, 60_000);

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
    expect(island.text()).toContain("Confirmation email sent");
  });

  // The email outbox answers 200 { sent: false } when the first attempt was not accepted (the mail stays queued and is retried).
  // The page must not claim it was sent: it uses the existing "couldn't resend, try again or contact the organiser" copy.
  it("a 200 with sent:false does NOT say the confirmation was sent: it shows the could-not-resend copy, with no empty detail line", async () => {
    net.response = { sent: false };
    const island = renderIsland(ResendConfirmation, { groupId: "grp-1", token: "rg_tok" });
    await (propsOf(findButton(island.tree())).onClick as () => Promise<void>)();

    expect(island.text()).toContain("We couldn't resend the confirmation");
    expect(island.text()).not.toContain("Confirmation email sent");
    const detailLines = island.tree().filter((e) => e.type === "p" && String(propsOf(e).className).includes("text-ink-muted"));
    expect(detailLines, "a failure with no server detail renders no empty secondary line").toHaveLength(0);
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
