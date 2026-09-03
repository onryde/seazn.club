// PATCH /api/orgs/[id] — the two ORG-PUBLIC defaults the Preferences tab writes.
//
// Both columns predate this route by a long way and both were, until now,
// written by nothing but tests:
//
//   default_locale  read by every entrant-facing surface (public pages, embeds,
//                   calendar.ics, OpenGraph images, the slideshow) and frozen
//                   onto each registration so its mail matches the form
//   currency        RS001b/V365 — what an ENTRANT is quoted and charged, over a
//                   DB-level allowlist CHECK, and LOCKED to the settlement
//                   currency while a Stripe Connect account is attached
//
// The lock is the case worth the DB: syncConnectAccount re-mirrors the account's
// settlement currency onto `currency` on every sync, so a write accepted here
// would be silently reverted later — the org sees it save, then change back.
// Refusing it is the only honest answer, and the refusal has to live in the
// route, not the picker, because the picker is not the only caller.
//
// requireOrgRole is stubbed to skip cookie/JWT auth; everything else runs for
// real against the migrated test Postgres, same convention as route.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { User } from "@/lib/types";

const HAS_DB = !!process.env.DATABASE_URL;

const fakeUser: User = {
  id: randomUUID(),
  display_name: "Defaults Test",
  email: "defaults-test@test.local",
  avatar_url: null,
  timezone: null,
  locale: null,
};

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireOrgRole: vi.fn(async () => ({ user: fakeUser, role: "owner" as const })),
  };
});

import { PATCH } from "../route";

/** `connected` attaches a UNIQUE account id — `organizations_stripe_account_idx`
 *  is unique, so a shared literal makes the second connected seed a duplicate
 *  key rather than the case under test. */
async function seedOrg(opts: { connected?: boolean } = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, stripe_account_id)
    values (${"Defaults Org " + suffix}, ${"defaults-org-" + suffix},
            ${opts.connected ? `acct_${suffix}` : null})
    returning id`;
  return org!.id;
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost/api/orgs/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function read(id: string): Promise<{ default_locale: string | null; currency: string }> {
  const [row] = await sql<{ default_locale: string | null; currency: string }[]>`
    select default_locale, currency from organizations where id = ${id}`;
  return row!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] — public default locale", () => {
  it("writes a supported locale", async () => {
    const id = await seedOrg();
    const res = await PATCH(patchReq({ default_locale: "fr" }), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect((await read(id)).default_locale).toBe("fr");
  });

  it("rejects a locale the product does not ship, leaving the column alone", async () => {
    const id = await seedOrg();
    const before = (await read(id)).default_locale;
    // "de" is a plausible-looking code that is NOT in LOCALES — the exact
    // shape that would otherwise reach every public page as a missing
    // dictionary.
    const res = await PATCH(patchReq({ default_locale: "de" }), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(400);
    expect((await read(id)).default_locale).toBe(before);
  });
});

describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] — entry-fee currency", () => {
  it("writes an allowlisted currency while the org is unconnected", async () => {
    const id = await seedOrg();
    const res = await PATCH(patchReq({ currency: "inr" }), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect((await read(id)).currency).toBe("inr");
  });

  it("rejects a code outside the allowlist BEFORE it reaches the CHECK", async () => {
    // The column's own constraint would abort the transaction and surface as a
    // 500; zod turns the same fact into a 400 the picker can show.
    const id = await seedOrg();
    const before = (await read(id)).currency;
    const res = await PATCH(patchReq({ currency: "sek" }), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(400);
    expect((await read(id)).currency).toBe(before);
  });

  it("REFUSES the write while a Connect account is attached", async () => {
    const id = await seedOrg({ connected: true });
    const before = (await read(id)).currency;
    const res = await PATCH(patchReq({ currency: "eur" }), {
      params: Promise.resolve({ id }),
    });

    // 409, not 400: the value is legal, the state forbids it.
    expect(res.status).toBe(409);
    expect((await read(id)).currency).toBe(before);
  });

  it("still allows every OTHER field on a connected org", async () => {
    // The lock is on one column, not on the org — a connected club must still
    // be able to set its public language.
    const id = await seedOrg({ connected: true });
    const res = await PATCH(patchReq({ default_locale: "nl" }), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect((await read(id)).default_locale).toBe("nl");
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
