// The claim link a failed invite email leaves on screen is the one-time claim SECRET, and it is painted as text. PostHog replay
// compresses its DOM frames before `before_send` can scrub them, and its recorder blocks only an element with the class
// `ph-no-capture` (seazn-qr-image.tsx has the rule; lib/__tests__/scrub-secret-painters.test.ts is the source scan over every
// painter of every scrubbed secret). This drives the two components through their real flows, with a secret the real minter
// made and a URL built the way the route builds it, and reads the element the secret ends up in.
//
// No jsdom in this workspace: driven through the shared node-env hook harness (components/__tests__/_hook-harness.tsx).
// Sport: not applicable.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  sql: (await import("@/lib/__tests__/_fake-sql")).fakeSql,
}));

const net = vi.hoisted(() => ({
  reply: null as { claim_url: string; email_sent: boolean } | null,
  calls: [] as { url: string; method?: string }[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string }) => {
      net.calls.push({ url, method: options?.method });
      return Promise.resolve(net.reply);
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { mintClaimSecret } from "@/server/usecases/person-claims";
import { routes } from "@/lib/routes";
import { InviteClaim } from "../invite-claim";
import { OfficialInviteForm } from "../officials-shared";

const CLASS = "ph-no-capture";
const tokens = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
/** Every string a node paints: its direct text children and every non-handler prop value. */
function painted(el: ReactElement): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(propsOf(el))) {
    if (key === "children") {
      for (const child of [value].flat(Infinity)) if (typeof child === "string" || typeof child === "number") out.push(String(child));
    } else if (typeof value === "string" && key !== "className") out.push(value);
  }
  return out;
}
/** The elements that paint the secret, anywhere in the tree. */
const painting = (tree: ReactElement[], secret: string) => tree.filter((el) => painted(el).some((s) => s.includes(secret)));

let secret = "";
let claimUrl = "";
beforeEach(() => {
  secret = mintClaimSecret();
  claimUrl = `https://seazn.club${routes.claim(secret)}`;
  net.calls = [];
  net.reply = { claim_url: claimUrl, email_sent: false };
});

describe("InviteClaim: the claim link shown after a failed send", () => {
  async function inviteFlow() {
    const island = renderIsland(InviteClaim, { personId: "p1", personName: "Ana", claimed: false, claimPending: false });
    const open = island.tree().find((e) => e.type === "button" && propsOf(e).title !== undefined)!;
    (propsOf(open).onClick as () => void)();
    const input = island.tree().find((e) => e.type === "input")!;
    (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value: "ana@example.com" } });
    const form = island.tree().find((e) => e.type === "form")!;
    await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    return island;
  }

  it("the secret is painted, in exactly one element, and that element is ph-no-capture", async () => {
    const island = await inviteFlow();
    expect(net.calls).toEqual([{ url: "/api/v1/persons/p1/claim-invites", method: "POST" }]);
    const hits = painting(island.tree(), secret);
    expect(hits.length, "premise: the link is on screen").toBe(1);
    expect(hits[0]!.type).toBe("code");
    expect(propsOf(hits[0]!)["data-testid"]).toBe("claim-link");
    expect(tokens(hits[0]!)).toContain(CLASS);
  });

  it("the class is a token of its own: not 'ph-no-capture-x' and not on the neighbouring button", async () => {
    const island = await inviteFlow();
    const [code] = painting(island.tree(), secret);
    expect(tokens(code!)).not.toContain(`${CLASS}-x`);
    for (const el of island.tree().filter((e) => e.type === "button")) expect(tokens(el), "a button blocks nothing it does not paint").not.toContain(CLASS);
  });

  it("the other outcome (the email went) paints no link at all: the negative pair", async () => {
    net.reply = { claim_url: claimUrl, email_sent: true };
    const island = await inviteFlow();
    expect(painting(island.tree(), secret)).toEqual([]);
    expect(walk(island.tree()).length).toBeGreaterThan(5);
  });
});

describe("OfficialInviteForm: the claim link shown after a failed send", () => {
  async function inviteFlow() {
    const island = renderIsland(OfficialInviteForm, { officialId: "o1", initialEmail: "ref@example.com", onClose: () => {} });
    const form = island.tree().find((e) => e.type === "form")!;
    await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} });
    return island;
  }

  it("the secret is painted, in exactly one element, and that element is ph-no-capture", async () => {
    const island = await inviteFlow();
    expect(net.calls).toEqual([{ url: "/api/v1/officials/o1/invite", method: "POST" }]);
    const hits = painting(island.tree(), secret);
    expect(hits.length, "premise: the link is on screen").toBe(1);
    expect(hits[0]!.type).toBe("code");
    expect(tokens(hits[0]!)).toContain(CLASS);
  });

  it("the email went: no link is painted", async () => {
    net.reply = { claim_url: claimUrl, email_sent: true };
    const island = await inviteFlow();
    expect(painting(island.tree(), secret)).toEqual([]);
  });
});
