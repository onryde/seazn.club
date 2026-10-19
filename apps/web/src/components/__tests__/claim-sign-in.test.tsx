// "Claim and sign in" (the card the EMAILED claim link shows a signed-out visitor). Two things matter
// here that no pure-markup assertion can see (vitest is `environment: "node"`, so the island is driven by
// the hook harness):
//   - NOTHING is sent when the card renders. Mail scanners and link previews open links; a sign-in that
//     fired on load would be consumed by a robot. The POST waits for the tap.
//   - The tap posts to the accept route ONCE, goes where the SERVER says (not a path typed in the
//     component), and a failure shows the server's reason and gives the button back.
// Expected copy is read from the shipped dictionary, never typed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import { ClaimSignIn } from "@/components/claim-sign-in";
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
});
