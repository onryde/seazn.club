// Org PATCH invalidation call-site coverage (Task 2 review finding 3): a
// rename must call invalidateSlugCache with the old+new slug; a non-rename
// patch (e.g. logo) must not. requireOrgRole is stubbed to skip real
// cookie/JWT auth — everything else this route touches (generateOrgSlug,
// invalidateUserOrgs, the DB writes) runs for real against the migrated
// test Postgres, same DB-backed convention as slug-hygiene.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { User } from "@/lib/types";

const HAS_DB = !!process.env.DATABASE_URL;

const fakeUser: User = {
  id: randomUUID(),
  display_name: "Route Test",
  email: "route-test@test.local",
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

vi.mock("@/server/slug-resolve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/slug-resolve")>();
  return { ...actual, invalidateSlugCache: vi.fn(actual.invalidateSlugCache) };
});

import { invalidateSlugCache } from "@/server/slug-resolve";
import { PATCH } from "../route";

async function seedOrg(): Promise<{ id: string; slug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug)
    values (${"Route Org " + suffix}, ${"route-org-" + suffix})
    returning id, slug`;
  return org!;
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost/api/orgs/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] slug cache invalidation", () => {
  it("renaming the org calls invalidateSlugCache once with the old and new slug", async () => {
    const org = await seedOrg();
    const suffix = randomUUID().slice(0, 8);
    const res = await PATCH(patchReq({ name: `Riverside United ${suffix}` }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { slug: string } };
    expect(json.ok).toBe(true);
    expect(json.data.slug).not.toBe(org.slug);
    expect(invalidateSlugCache).toHaveBeenCalledTimes(1);
    expect(invalidateSlugCache).toHaveBeenCalledWith("org", null, org.slug, json.data.slug);
  });

  it("a non-rename patch (logo) never invalidates the slug cache", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ logo_storage_path: "orgs/logo.png" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
    expect(invalidateSlugCache).not.toHaveBeenCalled();
  });
});

// The org-wide default payment method for NEW divisions. `stripe` is only a
// legitimate default once the org's Connect account can actually take a
// charge: `stripe_charges_enabled` is what the connect settings page reads to
// disable the radio, and what registration-submit re-checks before quoting a
// card price. The UI gate was the ONLY gate until this suite — the route
// accepted the write from any client that skipped the screen, leaving new
// divisions defaulted to a method the org cannot collect on.
describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] default_payment_method gate", () => {
  it("refuses stripe as the default method while charges are not enabled", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ default_payment_method: "stripe" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(409);
  });

  it("accepts stripe once charges are enabled", async () => {
    const org = await seedOrg();
    await sql`update organizations set stripe_charges_enabled = true where id = ${org.id}`;
    const res = await PATCH(patchReq({ default_payment_method: "stripe" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
  });

  it("always accepts offline, regardless of charges_enabled", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ default_payment_method: "offline" }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
  });
});

// R4 fix batch 3 (m9, PO ruling 2026-11-08): sponsors live in the `sponsors` table only. The `sponsors` arm of this PATCH
// was the last writer of the legacy `branding.sponsors` blob (no UI called it), so it is GONE, and V492 strips the blob.
// A body naming `sponsors` is now refused exactly as this route refuses ANY key it does not know: every union arm is
// `.strict()`, so the parse throws and `handler` answers 400 "Invalid input" - and nothing is written.
describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] refuses the removed `sponsors` arm like any unknown key", () => {
  const branding = async (id: string) =>
    (await sql<{ branding: Record<string, unknown> }[]>`select branding from organizations where id = ${id}`)[0]!.branding;
  const COLOR = { primary: "#112233" };

  it("a body carrying `sponsors` is a 400 'Invalid input' and stores nothing - a full list, an empty one, one riding a brand colour (count reported)", async () => {
    const org = await seedOrg();
    await sql`update organizations set branding = ${sql.json({ colors: COLOR } as never)} where id = ${org.id}`;
    const refused: unknown[] = [
      { sponsors: [{ name: "Acme", url: "https://acme.example/" }, { name: "Bare" }] },
      { sponsors: [] },
      { branding: { colors: { primary: "#445566" } }, sponsors: [{ name: "Acme" }] },
      { branding: { colors: { primary: "#445566" }, sponsors: [{ name: "Acme" }] } },
    ];
    let checked = 0;
    for (const body of refused) {
      const res = await PATCH(patchReq(body), { params: Promise.resolve({ id: org.id }) });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error?: string }).error, JSON.stringify(body)).toBe("Invalid input");
      checked++;
    }
    expect(checked, "anti-vacuity: every refused body was sent").toBe(4);
    expect(await branding(org.id), "nothing stored: no sponsors key, the colour untouched").toEqual({ colors: COLOR });
  });

  it("positive pair: the route's rule is the unknown-key rule (`bogus` is refused the same way), and the brand colour arm still saves", async () => {
    const org = await seedOrg();
    const bogus = await PATCH(patchReq({ bogus: 1 }), { params: Promise.resolve({ id: org.id }) });
    expect(bogus.status).toBe(400);
    expect(((await bogus.json()) as { error?: string }).error).toBe("Invalid input");
    const color = await PATCH(patchReq({ branding: { colors: COLOR } }), { params: Promise.resolve({ id: org.id }) });
    expect(color.status).toBe(200);
    expect(await branding(org.id)).toEqual({ colors: COLOR });
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
