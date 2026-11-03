// C9 review 3 (m1): the builder's Sport picker leads with the sports the organisation has run divisions in, most recent
// first, and OPENS on the first of them (round 3). Divisions written in one transaction share `now()`, so with
// `order by max(created_at) desc` alone their order - and with it the default sport - is whatever the hash aggregate
// happens to emit, and can flip between loads. The fix breaks ties on the sport key.
//
// The tie is made real, not assumed: every synced sport's division shares one created_at, and the precondition checks
// that the unbroken query, grouped by hashing, does NOT already return them in key order (else this case could not
// witness the missing tie-break).
// The sport keys are the engine registry's, as synced into `sports`.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision, recentDivisionSports } from "@/server/usecases/divisions";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** An organisation with `n` divisions (generic, then re-pointed at the sports a case needs). */
async function orgWithDivisions(n: number): Promise<{ auth: AuthCtx; ids: string[] }> {
  const { auth } = await seedOrg("pro");
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${auth.orgId}, 'divisions.per_competition.max', ${n + 2}, 'recent-sports tie probe')`;
  await invalidateOrgEntitlements(auth.orgId);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Recent ${randomUUID().slice(0, 6)}`, visibility: "private", branding: {} });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = await createDivision(auth, comp.id, { name: `D${i}`, slug: `d${i}-${randomUUID().slice(0, 6)}`, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
    ids.push(d.id);
  }
  return { auth, ids };
}
const repoint = (id: string, sportKey: string, at: string) => sql`update divisions set sport_key = ${sportKey}, created_at = ${at} where id = ${id}`;
/** The reader in a tenant transaction; `hashed` makes the planner group by hashing (no sorted group input). */
const read = (auth: AuthCtx, opts: { hashed?: boolean } = {}) =>
  withTenant(auth.orgId, async (tx) => {
    if (opts.hashed) await tx`set local enable_sort = off`;
    return recentDivisionSports(tx, auth.orgId);
  });

describe.skipIf(!HAS_DB)("the organisation's recent sports: most recent first, ties on the sport key (m1)", () => {
  it("empty case first: an organisation with no division has no recent sport", async () => {
    const { auth } = await orgWithDivisions(0);
    expect(await read(auth)).toEqual([]);
  });

  it("sports created at one instant read in key order, before an older one - on every load, under any plan", async () => {
    const synced = (await sql<{ key: string }[]>`select key from sports`).map((r) => r.key);
    const keys = builtinModules.map((m) => m.key).filter((k) => k !== "generic" && synced.includes(k));
    expect(keys.length, "registry sports synced into `sports`").toBeGreaterThanOrEqual(5);
    // Every synced sport tied; reverse key order in, so a read that kept insertion order would not pass by accident.
    const tied = [...keys].sort().reverse();
    const { auth, ids } = await orgWithDivisions(tied.length + 1);
    const at = "2030-06-01T10:00:00Z";
    for (const [i, k] of tied.entries()) await repoint(ids[i]!, k, at);
    await repoint(ids[tied.length]!, "generic", "2030-05-01T10:00:00Z");

    // The precondition: under a hash aggregate (a plan the planner may pick as the table grows) the unbroken order does
    // NOT already come back in key order - so this case witnesses the missing tie-break.
    const unbroken = await withTenant(auth.orgId, async (tx) => {
      await tx`set local enable_sort = off`;
      return tx<{ sport_key: string }[]>`select sport_key from divisions where org_id = ${auth.orgId} group by sport_key order by max(created_at) desc`;
    });
    const head = unbroken.map((r) => r.sport_key).slice(0, tied.length);
    expect([...head].sort(), "the tied sports lead").toEqual([...tied].sort());
    expect(head, "premise: the unbroken order is not already the key order").not.toEqual([...tied].sort());

    const want = [...[...tied].sort(), "generic"];
    expect(await read(auth)).toEqual(want);
    expect(await read(auth), "a second load reads the same").toEqual(want);
    expect(await read(auth, { hashed: true }), "and under the hash aggregate").toEqual(want);
  });

  it("another organisation's divisions never lead this one's picker", async () => {
    const mine = await orgWithDivisions(1);
    const theirs = await orgWithDivisions(1);
    await repoint(theirs.ids[0]!, "badminton", "2031-01-01T00:00:00Z");
    expect(await read(mine.auth)).toEqual(["generic"]);
    expect(await read(theirs.auth)).toEqual(["badminton"]);
  });
});
