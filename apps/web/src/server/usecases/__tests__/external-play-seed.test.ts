// T17 re-review N4: `external-play-play.test.ts` went red on `users_email_key` — seedOwner's address
// (`ep7-<suffix>@test.local`) collided with one an earlier run left in the accumulated test database. The suffix has
// to be wide enough that, at the volume of owners ALREADY on file here, one more insert colliding is negligible.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOwner } from "./_external-play-seed";

afterAll(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** One collision in a billion inserts — a flake rate nobody will ever meet in this suite. */
const MAX_COLLISION_ODDS = 1e-9;

describe.skipIf(!process.env.DATABASE_URL)("seedOwner — an address no earlier run can already hold", () => {
  it("the email and org slug suffix make a collision negligible at this database's own volume", async () => {
    const owner = await seedOwner();
    const [row] = await sql<{ email: string; slug: string }[]>`
      select u.email, o.slug from users u join organizations o on o.created_by = u.id
       where u.id = ${owner.userId!} and o.id = ${owner.orgId}`;
    const suffix = /^ep7-([0-9a-f]+)@test\.local$/.exec(row!.email)?.[1];
    expect(suffix, row!.email).toBeDefined();
    expect(row!.slug, "the slug carries the same suffix (organizations_slug_key is unique too)").toBe(`ep7-${suffix}`);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from users where email like 'ep7-%@test.local'`;
    expect(n, "anti-vacuity: at least the owner just seeded").toBeGreaterThan(0);
    const odds = n / 2 ** (suffix!.length * 4);
    expect(odds, `${n} owners on file, ${suffix!.length} hex characters`).toBeLessThan(MAX_COLLISION_ODDS);
  });
});
