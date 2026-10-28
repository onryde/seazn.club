// W2e Task 16 fix round 1 (row BD-DV-1): the entrants door in a BADMINTON division. The module declares individual and pair
// entrants only (proved engine-side in packages/engine/src/sports/setbased/w2e-rows.test.ts); this file proves the other half of the
// row, that the door's generic gate (server/usecases/entrants.ts, the `eff.kinds` check) refuses what that model excludes and takes
// what it names. Real Postgres required (RLS, the config column); skipped without DATABASE_URL.
//
// The sibling entrant-shapes suite (entrants.test.ts) drives the chess division, whose refusal is CHESS_INDIVIDUAL_ONLY and is
// judged BEFORE the generic gate, so it never reaches ENTRANT_KIND_NOT_ALLOWED; no other vitest drove that code on a sport that
// is not chess. Expected kinds are read from the module's own declaration, never typed here.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";

const HAS_DB = !!process.env.DATABASE_URL;
const BADMINTON = builtinModules.find((m) => m.key === "badminton")!;
const DECLARED = effectiveEntrantModel(BADMINTON.entrantModel ?? null);

/** Seed the REAL badminton catalog (never an empty stub: the shared test DB must stay usable by sibling suites). */
async function seedBadmintonDivision(config: Record<string, unknown> = {}) {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Bd " + suffix}, ${"bd-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const variant = Object.keys(BADMINTON.variants)[0]!;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('badminton', 'Badminton', ${BADMINTON.version}, ${sql.json(BADMINTON.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('badminton', ${variant}, ${variant}, ${sql.json((BADMINTON.variants[variant] ?? {}) as never)}, true)
    on conflict do nothing`;
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Shuttle Cup " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "badminton",
    variant_key: variant,
    config,
  } as never);
  return { auth, division };
}

const countEntrants = async (divisionId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`;
  return n;
};

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("BD-DV-1 the entrants door in a badminton division", () => {
  it("BD-DV-1 refuses a team entrant with ENTRANT_KIND_NOT_ALLOWED, takes what the module declares, and a refused batch writes nothing", async () => {
    // Anti-vacuity: the declaration under test is individual + pair, and the sweep below visits each declared kind.
    expect(DECLARED.kinds).toEqual(["individual", "pair"]);
    const { auth, division } = await seedBadmintonDivision();

    // The refusal: one team in the batch.
    await expect(
      createEntrants(auth, division.id, [{ kind: "team", display_name: "Shuttle Club", members: [] }]),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_KIND_NOT_ALLOWED" });
    expect(await countEntrants(division.id)).toBe(0);

    // The batch is atomic: a valid entrant beside a team is refused whole.
    await expect(
      createEntrants(auth, division.id, [
        { kind: "individual", display_name: "Lin", members: [] },
        { kind: "team", display_name: "Shuttle Club", members: [] },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "ENTRANT_KIND_NOT_ALLOWED" });
    expect(await countEntrants(division.id)).toBe(0);

    // The positive pair: each declared kind is taken, so the refusal above is the kind and not something else in the request.
    let taken = 0;
    for (const kind of DECLARED.kinds) {
      const [made] = await createEntrants(auth, division.id, [{ kind, display_name: `Unit ${kind}`, members: [] }]);
      expect(made?.kind, kind).toBe(kind);
      taken += 1;
    }
    expect(taken).toBe(DECLARED.kinds.length);
    expect(taken).toBeGreaterThan(0);
    expect(await countEntrants(division.id)).toBe(taken);
  });

  it("BD-DV-1 limit: the division's own entrant kinds widen the door, and a team is then taken as a unit for single matches (not a tie)", async () => {
    // The row's deviation: RB2A-32 says team ties are not built; the product does not refuse a Team chip in the division settings.
    const widened = { kinds: ["individual", "pair", "team"], defaultKind: "individual" };
    const { auth, division } = await seedBadmintonDivision({ entrants: widened });
    const [made] = await createEntrants(auth, division.id, [{ kind: "team", display_name: "Shuttle Club", members: [] }]);
    expect(made?.kind).toBe("team");
    expect(await countEntrants(division.id)).toBe(1);
  });
});
