import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { upsertLichessLink } from "../external-accounts";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedBoardgameSport(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('boardgame', 'Board game', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do update set module_version = excluded.module_version`;
  for (const variant of ["classical", "rapid", "blitz"]) {
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('boardgame', ${variant}, ${variant}, ${sql.json({ variant })}, true)
      on conflict on constraint sport_variants_pkey do update set config = excluded.config`;
  }
}

async function seedOwner(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`op-${suffix}@test.local`}, 'Owner', true) returning id`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by)
    values (${"OP Org " + suffix}, ${"op-" + suffix}, ${userId}) returning id`;
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${userId}, 'owner')`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  await seedBoardgameSport();
  return { orgId, via: "session", userId, role: "owner", keyId: null } as AuthCtx;
}

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("onlinePlay division + enrollment gate", () => {
  it("patch round-trips onlinePlay on boardgame divisions", async () => {
    const owner = await seedOwner();
    const competition = await createCompetition(owner, {
      name: "Chess Cup",
      visibility: "public",
      branding: {},
      starts_on: "2026-10-01",
      ends_on: "2026-10-02",
    });
    const division = await createDivision(owner, competition.id, {
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical" },
    });

    const patched = await patchDivision(owner, division.id, {
      config: { ...(division.config as Record<string, unknown>), onlinePlay: "lichess" },
    });
    expect((patched.config as Record<string, unknown>).onlinePlay).toBe("lichess");

    await expect(
      patchDivision(owner, division.id, {
        config: { ...(patched.config as Record<string, unknown>), onlinePlay: "lichess" },
      }),
    ).resolves.toBeTruthy();

    const cleared = await patchDivision(owner, division.id, {
      config: { ...(patched.config as Record<string, unknown>), onlinePlay: "off" },
    });
    expect((cleared.config as Record<string, unknown>).onlinePlay).toBeUndefined();
  });

  it("createEntrants rejects unlinked players when onlinePlay is lichess", async () => {
    const owner = await seedOwner();
    const competition = await createCompetition(owner, {
      name: "Online Swiss",
      visibility: "public",
      branding: {},
      starts_on: "2026-10-01",
      ends_on: "2026-10-02",
    });
    const division = await createDivision(owner, competition.id, {
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess" },
    });
    expect((division.config as Record<string, unknown>).onlinePlay).toBe("lichess");

    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${owner.orgId}, 'Unlinked Player', ${owner.userId}) returning id`;

    await expect(
      createEntrants(owner, division.id, [
        {
          display_name: "Alice",
          kind: "individual",
          members: [{ person_id: personId, is_captain: false, roles: [] }],
        },
      ]),
    ).rejects.toMatchObject({ code: "LICHESS_LINK_REQUIRED" });

    await upsertLichessLink(owner.userId!, {
      externalUserId: `lid-${randomUUID().slice(0, 8)}`,
      username: "LinkedPlayer",
      accessToken: "tok",
    });

    const created = await createEntrants(owner, division.id, [
      {
        display_name: "Alice",
        kind: "individual",
        members: [{ person_id: personId, is_captain: false, roles: [] }],
      },
    ]);
    expect(created).toHaveLength(1);
  });
});
