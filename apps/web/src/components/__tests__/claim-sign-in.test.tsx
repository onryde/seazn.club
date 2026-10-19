// "Claim and sign in" (the card the EMAILED claim link shows a signed-out visitor). Two things matter
// here that no pure-markup assertion can see (vitest is `environment: "node"`, so the island is driven by
// the hook harness):
//   - NOTHING is sent when the card renders. Mail scanners and link previews open links; a sign-in that
//     fired on load would be consumed by a robot. The POST waits for the tap.
//   - The tap posts to the accept route ONCE, goes where the SERVER says (not a path typed in the
//     component), and a failure shows the server's reason and gives the button back.
//   - A tap that arrives AFTER the 72h window (the page was loaded inside it) is answered with
//     CLAIM_SIGNIN_EXPIRED; the card then turns, in place, into the normal sign-in (no reload, no navigation).
//     Only that code does: every other refusal keeps the card and its reason.
// Expected copy is read from the shipped dictionary, never typed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { ClaimSignIn } from "@/components/claim-sign-in";
import { AuthForm } from "@/components/auth-form";
import { ApiError } from "@/lib/client";
import { LegalNotice } from "@/components/legal-notice";
import en from "@/dictionaries/en/ui.json";

const h = vi.hoisted(() => ({
  posts: [] as { url: string; method?: string }[],
  pushed: [] as string[],
  refreshed: 0,
  next: null as null | { reject?: Error; redirect?: string },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (to: string) => void h.pushed.push(to),
    refresh: () => void (h.refreshed += 1),
  }),
}));
vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn(async (url: string, opts?: { method?: string }) => {
    h.posts.push({ url, method: opts?.method });
    if (h.next?.reject) throw h.next.reject;
    return { redirect: h.next?.redirect ?? "/somewhere-the-server-chose" };
  }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const dict = en as Record<string, string>;
const button = (island: { tree: () => ReactElement[] }) => {
  const b = island.tree().find((el) => el.type === "button");
  if (!b) throw new Error("no button rendered");
  return b;
};

beforeEach(() => {
  h.posts.length = 0;
  h.pushed.length = 0;
  h.refreshed = 0;
  h.next = null;
});

describe("ClaimSignIn", () => {
  const props = { token: "pc_email-secret-0123", email: "s***m@t***.local" };

  it("renders the masked invited address, one primary button, the legal notice — and posts NOTHING", async () => {
    const island = renderIsland(ClaimSignIn, props);
    await flush();

    expect(h.posts).toEqual([]); // not on load: a robot opening the link must not consume it
    expect(button(island).props).toMatchObject({ disabled: false });
    expect(textOf(button(island))).toBe(dict["claim.signin.cta"]);
    expect(island.text()).toContain("s***m@t***.local");
    expect(island.text()).toContain(dict["claim.signin.hint"]);
    expect(island.tree().some((el) => el.type === LegalNotice)).toBe(true);
    // Exactly one button: the card has one job.
    expect(island.tree().filter((el) => el.type === "button")).toHaveLength(1);
  });

  it("a tap POSTs the accept route once, disables the button, then goes where the server said", async () => {
    h.next = { redirect: "/me?claimed=1" };
    const island = renderIsland(ClaimSignIn, props);

    (propsOf(button(island)).onClick as () => void)();
    // In flight: busy copy, disabled — a second tap can only meet the server's "already claimed".
    expect(propsOf(button(island)).disabled).toBe(true);
    expect(textOf(button(island))).toBe(dict["claim.signin.busy"]);
    await flush();

    expect(h.posts).toEqual([{ url: "/api/claims/pc_email-secret-0123/accept", method: "POST" }]);
    expect(h.pushed).toEqual(["/me?claimed=1"]);
    expect(h.refreshed).toBe(1);
  });

  it("a refusal shows the server's reason and hands the button back; nothing navigates", async () => {
    h.next = { reject: new Error("This profile has already been claimed") };
    const island = renderIsland(ClaimSignIn, props);

    (propsOf(button(island)).onClick as () => void)();
    await flush();

    expect(island.text()).toContain("This profile has already been claimed");
    expect(propsOf(button(island)).disabled).toBe(false);
    expect(h.pushed).toEqual([]);
  });

  it("a refusal with no message falls back to the localised line", async () => {
    h.next = { reject: new Error("") };
    const island = renderIsland(ClaimSignIn, props);

    (propsOf(button(island)).onClick as () => void)();
    await flush();

    expect(island.text()).toContain(dict["claim.signin.failed"]);
  });
  it("a tap past the window (CLAIM_SIGNIN_EXPIRED) turns the card, IN PLACE, into the normal sign-in for this claim: one POST, no navigation, no reload", async () => {
    const serverEnglish = "The server's English refusal text";
    h.next = { reject: new ApiError(serverEnglish, 401, "CLAIM_SIGNIN_EXPIRED") };
    const island = renderIsland(ClaimSignIn, props);
    // Before the tap: the one-tap card, no sign-in form (the page was loaded inside the window).
    expect(island.tree().some((el) => el.type === AuthForm)).toBe(false);

    (propsOf(button(island)).onClick as () => void)();
    await flush();

    // After: the same sign-in the console link gets, coming back to THIS claim page once signed in.
    const forms = island.tree().filter((el) => el.type === AuthForm);
    expect(forms).toHaveLength(1);
    expect(propsOf(forms[0]!).next).toBe(`/claim/${props.token}`);
    // The one-tap button is gone; the explanation is the localised line, not the server's English refusal.
    expect(island.tree().some((el) => el.type === "button")).toBe(false);
    expect(island.text()).toContain(dict["claim.signin.expired"]);
    expect(island.text()).not.toContain(serverEnglish);
    expect(island.text()).not.toContain(dict["claim.signin.failed"]);
    // In place: exactly the one tap's POST, nothing navigated, nothing refreshed.
    expect(h.posts).toEqual([{ url: "/api/claims/pc_email-secret-0123/accept", method: "POST" }]);
    expect(h.pushed).toEqual([]);
    expect(h.refreshed).toBe(0);
  });

  it("every OTHER refusal keeps the one-tap card and shows its reason (only CLAIM_SIGNIN_EXPIRED swaps to the sign-in)", async () => {
    const others: { name: string; err: Error }[] = [
      { name: "a bare 401 (a console link's answer)", err: new ApiError("Not authenticated", 401) },
      { name: "CLAIM_REVOKED", err: new ApiError("This invite was withdrawn", 401, "CLAIM_REVOKED") },
      { name: "CLAIM_CLAIMED", err: new ApiError("This profile has already been claimed", 409, "CLAIM_CLAIMED") },
      { name: "a plain Error", err: new Error("Network down") },
    ];
    let checked = 0;
    for (const { err } of others) {
      h.next = { reject: err };
      const island = renderIsland(ClaimSignIn, props);
      (propsOf(button(island)).onClick as () => void)();
      await flush();

      expect(island.tree().some((el) => el.type === AuthForm)).toBe(false);
      expect(island.text()).toContain(err.message);
      expect(propsOf(button(island)).disabled).toBe(false);
      checked++;
    }
    expect(checked).toBe(others.length);
  });

  it("the sequence: refused as expired, the sign-in card stays; a tap cannot happen again (no one-tap button to press)", async () => {
    h.next = { reject: new ApiError("x", 401, "CLAIM_SIGNIN_EXPIRED") };
    const island = renderIsland(ClaimSignIn, props);
    (propsOf(button(island)).onClick as () => void)();
    await flush();
    await flush();

    expect(island.tree().filter((el) => el.type === "button")).toHaveLength(0);
    expect(island.tree().filter((el) => el.type === AuthForm)).toHaveLength(1);
    expect(h.posts).toHaveLength(1); // the expired answer is not retried
  });
});
