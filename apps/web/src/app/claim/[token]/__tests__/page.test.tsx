// /claim/[token]: what each visitor is shown for each kind of link (V464, two secrets per claim).
//   signed OUT + the secret that went into the invite EMAIL → "Claim and sign in" (ClaimSignIn);
//   signed OUT + the organiser's console link               → the auth card, exactly as before;
//   signed IN                                               → unchanged for both kinds (one-tap accept,
//                                                             or the wrong-account card);
//   a dead link of either kind                              → its dead-end copy, never a sign-in.
// The page is an async server component, so it is CALLED and its returned element tree is read (no jsdom —
// the score/[token] page test's convention). Real Postgres; skipped without DATABASE_URL (nothing touches
// `sql` at module level).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ReactElement, ReactNode } from "react";

const world = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; display_name: string; locale?: string },
  cookieLocale: undefined as string | undefined,
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getCurrentUser: async () => world.user,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "seazn_locale" && world.cookieLocale ? { value: world.cookieLocale } : undefined),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

import { CLAIM_EMAIL_SIGNIN_MS } from "@/lib/claim-signin-window";
import { sql } from "@/lib/db";
import { maskEmail } from "@/lib/mask-email";
import { AuthForm } from "@/components/auth-form";
import { ClaimAccept } from "@/components/claim-accept";
import { ClaimSignIn } from "@/components/claim-sign-in";
import { DictProvider } from "@/components/i18n/dict-provider";
import fr from "@/dictionaries/fr/ui.json";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createClaimInvite, revokeClaimInvite } from "@/server/usecases/person-claims";
import { walk, textOf } from "@/components/__tests__/_hook-harness";
import { createPerson } from "@/server/usecases/persons";
import ClaimPage from "../page";

const HAS_DB = !!process.env.DATABASE_URL;

const ofType = (tree: ReactElement[], type: unknown) => tree.filter((e) => e.type === type);

async function render(token: string) {
  const root = (await ClaimPage({ params: Promise.resolve({ token }) })) as ReactNode;
  return Object.assign(walk(root), { text: textOf(root) });
}

async function rig() {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: ownerId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pg-owner-${suffix}@test.local`}, 'owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"Page Org " + suffix}, ${"page-org-" + suffix}, ${ownerId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${ownerId}, 'owner')`;
  const owner: AuthCtx = { orgId, via: "session", userId: ownerId, role: "owner", keyId: null };
  const person = await createPerson(owner, { full_name: "Page Player", consent: {} } as never);
  const email = `Page-${suffix}@Test.Local`;
  const invite = await createClaimInvite(owner, person.id, email);
  return { owner, person, email, invite };
}

beforeEach(() => {
  world.user = null;
  world.cookieLocale = undefined;
});
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("/claim/[token], signed OUT", () => {
  it("the EMAILED link offers Claim and sign in — the masked address, no auth card", async () => {
    const { email, invite } = await rig();

    const tree = await render(invite.emailSecret);

    const cards = ofType(tree, ClaimSignIn);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.props).toMatchObject({ token: invite.emailSecret, email: maskEmail(email) });
    // The full address is not put in the page's props; only the masked one is.
    expect(JSON.stringify(cards[0]!.props)).not.toContain(email);
    expect(ofType(tree, AuthForm)).toHaveLength(0);
    expect(ofType(tree, ClaimAccept)).toHaveLength(0);
  });

  it("the organiser's CONSOLE link still shows the auth card, back to this page — never a one-tap sign-in", async () => {
    const { invite } = await rig();

    const tree = await render(invite.secret);

    const forms = ofType(tree, AuthForm);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.props).toMatchObject({ next: `/claim/${invite.secret}` });
    expect(ofType(tree, ClaimSignIn)).toHaveLength(0);
  });

  it("an emailed link PAST its sign-in window shows the auth card like a console link — and a fresh one still shows the one-tap card", async () => {
    const aged = await rig();
    await sql`update person_claims set created_at = created_at - ${`${CLAIM_EMAIL_SIGNIN_MS + 60_000} milliseconds`}::interval where id = ${aged.invite.id}`;
    const fresh = await rig();

    const agedTree = await render(aged.invite.emailSecret);
    const freshTree = await render(fresh.invite.emailSecret);

    expect(ofType(agedTree, ClaimSignIn)).toHaveLength(0);
    const forms = ofType(agedTree, AuthForm);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.props).toMatchObject({ next: `/claim/${aged.invite.emailSecret}` });
    expect(ofType(freshTree, ClaimSignIn)).toHaveLength(1);
    expect(ofType(freshTree, AuthForm)).toHaveLength(0);
  });

  it("the card's copy follows the visitor's locale, from the shipped dictionary", async () => {
    world.cookieLocale = "fr";
    const { invite } = await rig();

    const tree = await render(invite.emailSecret);

    const providers = ofType(tree, DictProvider);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.props).toMatchObject({ locale: "fr" });
    const dict = (providers[0]!.props as { dict: Record<string, string> }).dict;
    expect(dict["claim.signin.cta"]).toBe((fr as Record<string, string>)["claim.signin.cta"]);
    expect(dict["claim.signin.cta"]).not.toBe("Claim and sign in");
  });

  it("a withdrawn or already-claimed emailed link is a dead end with its own copy, never a sign-in", async () => {
    const revoked = await rig();
    await revokeClaimInvite(revoked.owner, revoked.person.id);
    const claimed = await rig();
    await sql`update person_claims set claimed_at = now() where id = ${claimed.invite.id}`;

    const rows = [
      { tree: await render(revoked.invite.emailSecret), title: "Invite withdrawn" },
      { tree: await render(claimed.invite.emailSecret), title: "Already claimed" },
      { tree: await render("pc_no-such-link"), title: "Link not recognised" },
    ];
    for (const r of rows) {
      expect(ofType(r.tree, ClaimSignIn)).toHaveLength(0);
      expect(ofType(r.tree, AuthForm)).toHaveLength(0);
      expect(r.tree.text).toContain(r.title);
    }
    expect(rows).toHaveLength(3);
  });
});

describe.skipIf(!HAS_DB)("/claim/[token], signed IN: unchanged for both kinds", () => {
  it("the invited account on an emailed link PAST its sign-in window still gets the one-tap accept", async () => {
    const { email, invite } = await rig();
    await sql`update person_claims set created_at = created_at - ${`${CLAIM_EMAIL_SIGNIN_MS + 60_000} milliseconds`}::interval where id = ${invite.id}`;
    world.user = { id: randomUUID(), email: email.toLowerCase(), display_name: "Me" };

    const tree = await render(invite.emailSecret);

    expect(ofType(tree, ClaimAccept)).toHaveLength(1);
    expect(ofType(tree, ClaimSignIn)).toHaveLength(0);
  });

  it.each(["secret", "emailSecret"] as const)("the invited account on the %s link gets the one-tap accept", async (kind) => {
    const { email, invite } = await rig();
    world.user = { id: randomUUID(), email: email.toLowerCase(), display_name: "Me" };

    const tree = await render(invite[kind]);

    expect(ofType(tree, ClaimAccept)).toHaveLength(1);
    expect(ofType(tree, ClaimSignIn)).toHaveLength(0);
    expect(ofType(tree, AuthForm)).toHaveLength(0);
  });

  it.each(["secret", "emailSecret"] as const)("another account on the %s link gets the wrong-account card", async (kind) => {
    const { invite } = await rig();
    world.user = { id: randomUUID(), email: "someone-else@test.local", display_name: "Else" };

    const tree = await render(invite[kind]);

    expect(ofType(tree, ClaimAccept)).toHaveLength(0);
    expect(ofType(tree, ClaimSignIn)).toHaveLength(0);
    expect(tree.text).toContain("Wrong account for this invite");
  });
});
