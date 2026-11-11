// Org PATCH invalidation call-site coverage (Task 2 review finding 3): a
// rename must call invalidateSlugCache with the old+new slug; a non-rename
// patch (e.g. logo) must not. requireOrgRole is stubbed to skip real
// cookie/JWT auth — everything else this route touches (generateOrgSlug,
// invalidateUserOrgs, the DB writes) runs for real against the migrated
// test Postgres, same DB-backed convention as slug-hygiene.test.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { EDITOR_ROLES, type User } from "@/lib/types";

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
import { requireOrgRole } from "@/lib/auth";
import { AuthError } from "@/lib/errors";
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

// Settings C8 (owner 2026-11-11): the Organisation tab saves the name, the brand colour and About with ONE button, in ONE
// request, so a save lands whole or not at all. Before this arm every body was a single key, and the three would have been
// three requests: a rename could land and the About behind it fail.
describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] — the Organisation tab's one save (name + colour + About)", () => {
  const row = async (id: string) =>
    (
      await sql<{ name: string; slug: string; about: string | null; branding: Record<string, unknown> }[]>`
        select name, slug, about, branding from organizations where id = ${id}`
    )[0]!;

  it("all three in one body land together, and the rename regenerates the slug as a rename alone does", async () => {
    const org = await seedOrg();
    const name = `Harbour Vale ${randomUUID().slice(0, 8)}`;
    const res = await PATCH(
      patchReq({ name, about: "Club nights are Tuesdays.", branding: { colors: { primary: "#0f766e" } } }),
      { params: Promise.resolve({ id: org.id }) },
    );
    expect(res.status).toBe(200);
    const after = await row(org.id);
    expect(after.name).toBe(name);
    expect(after.about).toBe("Club nights are Tuesdays.");
    expect(after.branding).toEqual({ colors: { primary: "#0f766e" } });
    expect(after.slug, "a rename riding with other keys still regenerates the slug").not.toBe(org.slug);
    expect(invalidateSlugCache).toHaveBeenCalledWith("org", null, org.slug, after.slug);
  });

  it("any subset saves on its own: About + colour without a name is not a rename", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({ about: null, branding: { colors: { primary: null } } }), {
      params: Promise.resolve({ id: org.id }),
    });
    expect(res.status).toBe(200);
    const after = await row(org.id);
    expect(after.slug).toBe(org.slug);
    expect(after.about).toBeNull();
    expect(invalidateSlugCache).not.toHaveBeenCalled();
  });

  it("all or nothing: one bad part refuses the whole body, and neither the name nor the colour is written", async () => {
    const org = await seedOrg();
    const before = await row(org.id);
    const refused: unknown[] = [
      { name: "Should not land", branding: { colors: { primary: "#zzzzzz" } } },
      { name: "Should not land", about: "x".repeat(20_001) },
      { name: "", about: "fine" },
      // An unknown key beside the three is refused like any unknown key.
      { name: "Should not land", timezone: "Europe/London", about: "fine" },
    ];
    let checked = 0;
    for (const body of refused) {
      const res = await PATCH(patchReq(body), { params: Promise.resolve({ id: org.id }) });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      checked++;
    }
    expect(checked, "anti-vacuity: every refused body was sent").toBe(refused.length);
    expect(await row(org.id), "nothing was written by any refused body").toEqual(before);
  });

  it("the empty body is still 'Nothing to update', not a silent 200", async () => {
    const org = await seedOrg();
    const res = await PATCH(patchReq({}), { params: Promise.resolve({ id: org.id }) });
    expect(res.status).toBe(400);
  });
});

// Sponsor deals, Task 21: the two columns V501 added (`sponsor_invoice_address`, `sponsor_invoice_bank_details`) are written by
// two arms of the same union as `payment_instructions` - each a single-key `.strict()` object, no combined arm (F30). So:
//   - each arm stores its own column and nothing else, and null clears it;
//   - a key the arm does not know is refused EVEN BESIDE a valid arm (F30: a body of `{ foo: 1 }` alone matches no arm and would
//     be refused whatever the arms' strictness - only a valid arm plus an unknown key tells a `.strict()` arm from a loosened one);
//   - a body naming BOTH columns matches no arm (the island sends two PATCHes instead);
//   - the length caps are the brief's (1000 and 2000 characters), at the boundary and one past it;
//   - the write is the org's own and rides the same role guard as every other arm (requireOrgRole with EDITOR_ROLES).
describe.skipIf(!HAS_DB)("PATCH /api/orgs/[id] sponsor invoice details", () => {
  const ARMS = [
    { key: "sponsor_invoice_address", other: "sponsor_invoice_bank_details", max: 1000 },
    { key: "sponsor_invoice_bank_details", other: "sponsor_invoice_address", max: 2000 },
  ] as const;
  const stored = async (id: string) =>
    (
      await sql<{ sponsor_invoice_address: string | null; sponsor_invoice_bank_details: string | null }[]>`
        select sponsor_invoice_address, sponsor_invoice_bank_details from organizations where id = ${id}`
    )[0]!;
  const send = (id: string, body: unknown) => PATCH(patchReq(body), { params: Promise.resolve({ id }) });

  it("each arm stores its own column, leaves the other alone, and null clears it (count reported)", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      const org = await seedOrg();
      const first = await send(org.id, { [arm.key]: "Riverside CC, 12 Mill Lane" });
      expect(first.status, `${arm.key} accepted`).toBe(200);
      expect((await stored(org.id))[arm.key], `${arm.key} stored`).toBe("Riverside CC, 12 Mill Lane");
      expect((await stored(org.id))[arm.other], `${arm.other} untouched`).toBeNull();
      const cleared = await send(org.id, { [arm.key]: null });
      expect(cleared.status, `${arm.key}: null accepted`).toBe(200);
      expect((await stored(org.id))[arm.key], `${arm.key} cleared`).toBeNull();
      checked++;
    }
    expect(checked, "anti-vacuity: both arms were driven").toBe(2);
  });

  // Fix round 1 (I1): a blank is "nothing to print", and the column must never hold one. A client that is not this card (a script,
  // an older tab) sending "   " would otherwise store a blank that a later invoice reads as a real address (and `|| null` guards
  // downstream would not see it as empty). So the ROUTE normalises: trimmed, and an empty result is null - on both arms.
  it("I1: a blank value ('', spaces, tab/newline whitespace) is stored as null, over a stored value too (both arms, count reported)", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      for (const blank of ["", "   ", "\n\t "]) {
        const org = await seedOrg();
        await sql`update organizations set ${sql({ [arm.key]: "kept" })} where id = ${org.id}`;
        const res = await send(org.id, { [arm.key]: blank });
        expect(res.status, `${arm.key}=${JSON.stringify(blank)} accepted`).toBe(200);
        expect((await stored(org.id))[arm.key], `${arm.key}=${JSON.stringify(blank)} stored as null, not the blank`).toBeNull();
        expect((await stored(org.id))[arm.other], `${arm.other} untouched`).toBeNull();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 arms x 3 blanks").toBe(6);
  });

  it("I1: text is stored trimmed, and its inner whitespace is left alone (positive pair of the blank rule; both arms, count reported)", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      for (const [sent, expected] of [
        [" x ", "x"],
        ["  \n x  y\n12 Mill Lane \t", "x  y\n12 Mill Lane"],
      ] as const) {
        const org = await seedOrg();
        const res = await send(org.id, { [arm.key]: sent });
        expect(res.status, `${arm.key}=${JSON.stringify(sent)} accepted`).toBe(200);
        expect((await stored(org.id))[arm.key], `${arm.key}=${JSON.stringify(sent)} trimmed at the ends only`).toBe(expected);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 arms x 2 texts").toBe(4);
  });

  it("the second write of the pair keeps the first (two sequential PATCHes, F30), and a re-save overwrites", async () => {
    const org = await seedOrg();
    expect((await send(org.id, { sponsor_invoice_address: "12 Mill Lane" })).status).toBe(200);
    expect((await send(org.id, { sponsor_invoice_bank_details: "Sort 12-34-56, acc 12345678" })).status).toBe(200);
    expect(await stored(org.id)).toEqual({
      sponsor_invoice_address: "12 Mill Lane",
      sponsor_invoice_bank_details: "Sort 12-34-56, acc 12345678",
    });
    expect((await send(org.id, { sponsor_invoice_address: "14 Mill Lane" })).status).toBe(200);
    expect(await stored(org.id)).toEqual({
      sponsor_invoice_address: "14 Mill Lane",
      sponsor_invoice_bank_details: "Sort 12-34-56, acc 12345678",
    });
  });

  it("F30: an unknown key beside a VALID arm is a 400 'Invalid input' and stores nothing (both arms, null and text, count reported)", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      for (const value of ["12 Mill Lane", null]) {
        const org = await seedOrg();
        // Seed a stored value so "nothing stored" also proves a null body did not clear it.
        await sql`update organizations set ${sql({ [arm.key]: "kept" })} where id = ${org.id}`;
        const res = await send(org.id, { [arm.key]: value, foo: 1 });
        expect(res.status, `${arm.key}=${JSON.stringify(value)} + foo`).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toBe("Invalid input");
        expect((await stored(org.id))[arm.key], `${arm.key} untouched by the refused body`).toBe("kept");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 arms x 2 values").toBe(4);
  });

  it("a body naming BOTH columns matches no arm: 400 and neither is written (no combined arm, F30)", async () => {
    const org = await seedOrg();
    const res = await send(org.id, { sponsor_invoice_address: "12 Mill Lane", sponsor_invoice_bank_details: "Sort 12-34-56" });
    expect(res.status).toBe(400);
    expect(await stored(org.id)).toEqual({ sponsor_invoice_address: null, sponsor_invoice_bank_details: null });
  });

  it("the length caps are 1000 and 2000 characters: the cap itself is stored, one past it is a 400 (count reported)", async () => {
    let checked = 0;
    for (const arm of ARMS) {
      const org = await seedOrg();
      const atCap = "x".repeat(arm.max);
      expect((await send(org.id, { [arm.key]: atCap })).status, `${arm.key} at ${arm.max}`).toBe(200);
      expect((await stored(org.id))[arm.key]).toBe(atCap);
      const over = await send(org.id, { [arm.key]: atCap + "x" });
      expect(over.status, `${arm.key} at ${arm.max + 1}`).toBe(400);
      expect((await stored(org.id))[arm.key], "the refused write left the capped value").toBe(atCap);
      checked++;
    }
    expect(checked, "anti-vacuity: both arms").toBe(2);
  });

  it("a non-string value is a 400 (a number, an object, an array)", async () => {
    const org = await seedOrg();
    let checked = 0;
    for (const arm of ARMS) {
      for (const value of [7, { a: 1 }, ["x"], true]) {
        expect((await send(org.id, { [arm.key]: value })).status, `${arm.key}=${JSON.stringify(value)}`).toBe(400);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(8);
    expect(await stored(org.id)).toEqual({ sponsor_invoice_address: null, sponsor_invoice_bank_details: null });
  });

  it("writes only the named org's row", async () => {
    const mine = await seedOrg();
    const other = await seedOrg();
    expect((await send(mine.id, { sponsor_invoice_address: "Mine" })).status).toBe(200);
    expect(await stored(other.id)).toEqual({ sponsor_invoice_address: null, sponsor_invoice_bank_details: null });
  });

  it("rides the editor-role guard: a member the guard refuses gets a 401 and stores nothing; an editor passes through requireOrgRole(id, EDITOR_ROLES)", async () => {
    const org = await seedOrg();
    vi.mocked(requireOrgRole).mockRejectedValueOnce(new AuthError("Insufficient permissions"));
    const refused = await send(org.id, { sponsor_invoice_bank_details: "Sort 12-34-56" });
    expect(refused.status).toBe(401);
    expect(await stored(org.id)).toEqual({ sponsor_invoice_address: null, sponsor_invoice_bank_details: null });

    vi.mocked(requireOrgRole).mockClear();
    expect((await send(org.id, { sponsor_invoice_bank_details: "Sort 12-34-56" })).status).toBe(200);
    expect(requireOrgRole).toHaveBeenCalledTimes(1);
    expect(requireOrgRole).toHaveBeenCalledWith(org.id, EDITOR_ROLES);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
