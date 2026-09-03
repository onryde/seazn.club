// Embed door (v3/10 #4): private divisions 404, link-only render, Pro orgs
// pass. V392 (entitlements v18) granted `embeds.enabled` on Community too, so
// no PLAN denies it any more — the not_entitled arm is proven through the
// override, which is the only remaining way an org can lose the key and is
// what keeps the gate site itself under test. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { embedDivisionData, type EmbedPayload } from "@/server/embed-data";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { createEntrants } from "@/server/usecases/entrants";
import type { AuthCtx } from "@/server/api-v1/auth";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seed(visibility: string, plan: string) {
  const s = randomUUID().slice(0, 8);
  // divisions.sport_key FKs the sports catalog — make sure it exists on a
  // fresh test DB (no sync:sports run).
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Emb " + s}, ${"emb-" + s}) returning id`;
  await setOrgPlan(orgId, plan);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + s}, ${"comp-" + s}, ${visibility}) returning id`;
  const [{ id: divId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, config, module_version)
    values (${orgId}, ${compId}, 'Div', 'div', 'generic', 'score', '{}', '1.0.0') returning id`;
  return { orgId, divId };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("embedDivisionData", () => {
  it("private division → not_found (never a side door)", async () => {
    const { divId } = await seed("private", "pro");
    expect(await embedDivisionData(divId)).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("link-only division on Pro → ok", async () => {
    const { divId } = await seed("unlisted", "pro");
    const res = await embedDivisionData(divId);
    expect(res.ok).toBe(true);
  });

  it("public division on Community → ok (V392 made embeds free)", async () => {
    const { divId } = await seed("public", "community");
    const res = await embedDivisionData(divId);
    expect(res.ok).toBe(true);
  });

  it("an org denied embeds.enabled → not_entitled", async () => {
    // The gate site is still live code; an override is the only thing left
    // that can take the key away, so it is what proves the door still shuts.
    const { orgId, divId } = await seed("public", "community");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, 'embeds.enabled', false, 'test')`;
    await invalidateOrgEntitlements(orgId);
    expect(await embedDivisionData(divId)).toEqual({
      ok: false,
      reason: "not_entitled",
    });
  });

  it("garbage id → not_found", async () => {
    expect(await embedDivisionData("nope")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

// RS008 review fix #5 — this embeds door ran its OWN separate entrants query
// (structurally identical to public-site/data.ts's getPublicDivision) with
// ZERO masking, not even by youth. A paying org's embed widget, live on a
// THIRD-PARTY website, could show an opted-out (or underage) person's full
// name to any visitor of that external page.
describe.skipIf(!HAS_DB)("embedDivisionData — consent masking (RS008 review fix #5)", () => {
  it("masks a non-team entrant's display_name when its linked person opted out — even on a non-youth division", async () => {
    const { orgId, divId } = await seed("public", "pro");
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Arun Kumar', ${sql.json({ public_name: false } as never)})
      returning id`;
    await createEntrants(auth, divId, [
      {
        kind: "individual",
        display_name: "Arun Kumar",
        seed: 1,
        members: [{ person_id: personId, is_captain: false, roles: [] }],
      },
      { kind: "individual", display_name: "Dev Patel", seed: 2, members: [] },
    ]);

    const res = await embedDivisionData(divId);
    expect(res.ok).toBe(true);
    const names = (res as { ok: true; data: EmbedPayload }).data.entrants.map((e) => e.display_name);
    expect(names).not.toContain("Arun Kumar");
    expect(names).toContain("Arun K.");
    expect(names).toContain("Dev Patel"); // per-entrant, not blanket
  });

  it("never masks a TEAM's own display_name by a roster member's opt-out", async () => {
    const { orgId, divId } = await seed("public", "pro");
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${orgId}, 'Cap Tain', ${sql.json({ public_name: false } as never)})
      returning id`;
    await createEntrants(auth, divId, [
      {
        kind: "team",
        display_name: "Thunder Strikers",
        seed: 1,
        members: [{ person_id: personId, is_captain: true, roles: [] }],
      },
    ]);

    const res = await embedDivisionData(divId);
    const names = (res as { ok: true; data: EmbedPayload }).data.entrants.map((e) => e.display_name);
    expect(names).toContain("Thunder Strikers");
  });
});
