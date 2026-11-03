// Match Day PB3 item 7 - `listFrozenCompetitions`: the Match Day banner names the competitions that are billing-frozen.
//
// It must name the PERSISTED set (`frozenCompetitionIds`: chosen once, stored in `competitions.frozen_at`), not the competitions a
// fresh calculation would pick today: the banner is only worth reading if it names exactly the ones the server refuses. So the
// sequence under test is the one that tells the two apart: the set is chosen, the stored marks are then moved by hand to a
// DIFFERENT valid choice (what a later read does not undo while the overflow is unchanged), and the list must follow the stored one.
// Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { listFrozenCompetitions } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

/** An org whose active-competition ceiling is pinned at `ceiling` by an override (the matrix's own plan numbers do not matter here). */
async function seedOrg(ceiling: number): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Frozen " + suffix}, ${"frozen-" + suffix})
    returning id`;
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', ${ceiling}, 'list-frozen-competitions test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A live (draft) competition, with a name chosen to make the by-name order differ from the creation order. */
async function make(orgId: string, name: string): Promise<{ id: string; name: string; slug: string }> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`;
  const [row] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, status) values (${orgId}, ${name}, ${slug}, 'draft') returning id`;
  return { id: row!.id, name, slug };
}

describe.skipIf(!HAS_DB)("listFrozenCompetitions", () => {
  it("EMPTY CASE FIRST: an in-quota org has none frozen, and the list is empty", async () => {
    const auth = await seedOrg(5);
    await make(auth.orgId, "Only One");
    expect([...(await frozenCompetitionIds(auth.orgId))], "premise: nothing is frozen").toEqual([]);
    expect(await listFrozenCompetitions(auth)).toEqual([]);
  });

  it("names exactly the frozen set (id, name, slug), ordered by name, and no competition that is not frozen", async () => {
    const auth = await seedOrg(2);
    const made = [await make(auth.orgId, "Zulu Cup"), await make(auth.orgId, "alpha league"), await make(auth.orgId, "Mike Open"), await make(auth.orgId, "Bravo Trophy")];
    const frozen = await frozenCompetitionIds(auth.orgId);
    expect(frozen.size, "premise: four live competitions over a ceiling of two freeze two").toBe(2);
    const out = await listFrozenCompetitions(auth);
    expect(new Set(out.map((r) => r.id)), "the list is the stored set").toEqual(frozen);
    for (const r of out) {
      const m = made.find((x) => x.id === r.id)!;
      expect(r).toEqual({ id: m.id, name: m.name, slug: m.slug });
    }
    const names = out.map((r) => r.name.toLowerCase());
    expect(names, "ordered by name, case-insensitively").toEqual([...names].sort());
    expect(out.length, "anti-vacuity: the sort was asked of more than one name").toBeGreaterThan(1);
  });

  it("follows the STORED choice, not a recomputation: marks moved by hand are the ones named", async () => {
    const auth = await seedOrg(2);
    const made = [await make(auth.orgId, "One"), await make(auth.orgId, "Two"), await make(auth.orgId, "Three")];
    const chosen = [...(await frozenCompetitionIds(auth.orgId))];
    expect(chosen, "premise: one competition over the ceiling is frozen").toHaveLength(1);
    // Move the mark to a different competition. The overflow is unchanged (still one), so a later read keeps the stored choice.
    const other = made.find((m) => m.id !== chosen[0])!;
    await sql`update competitions set frozen_at = null where id = ${chosen[0]!}`;
    await sql`update competitions set frozen_at = now() where id = ${other.id}`;
    expect([...(await frozenCompetitionIds(auth.orgId))], "premise: the read keeps the moved choice").toEqual([other.id]);
    expect((await listFrozenCompetitions(auth)).map((r) => r.id)).toEqual([other.id]);
  });

  it("another organisation's frozen competitions are never named (the sequence after a second org freezes)", async () => {
    const a = await seedOrg(1);
    const b = await seedOrg(1);
    await make(a.orgId, "A One");
    await make(a.orgId, "A Two");
    await make(b.orgId, "B One");
    await make(b.orgId, "B Two");
    const outA = await listFrozenCompetitions(a);
    const outB = await listFrozenCompetitions(b);
    expect(outA).toHaveLength(1);
    expect(outB).toHaveLength(1);
    expect(outA[0]!.name.startsWith("A ")).toBe(true);
    expect(outB[0]!.name.startsWith("B ")).toBe(true);
  });

  it("a competition that leaves the live set stops being named (archived), the sequence after a withdrawal", async () => {
    const auth = await seedOrg(1);
    const first = await make(auth.orgId, "First");
    const second = await make(auth.orgId, "Second");
    const before = await listFrozenCompetitions(auth);
    expect(before).toHaveLength(1);
    // Archive the OTHER one: the overflow is gone, so nothing stays frozen.
    const survivor = before[0]!.id === first.id ? second : first;
    await sql`update competitions set status = 'archived' where id = ${survivor.id}`;
    expect(await listFrozenCompetitions(auth)).toEqual([]);
  });
});
