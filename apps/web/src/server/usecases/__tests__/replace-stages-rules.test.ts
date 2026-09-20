// `replaceStages` and per-stage match rules (owner ruling 2026-09-18).
//
// The Format tab's Apply is a delete-and-recreate from the template body, and
// that body CANNOT carry `rules` — `assertNoRulesKey` refuses it, because a
// stage-config body is not a path that validates a rules fragment. So without a
// server-side carry-forward, every Apply silently wiped every per-stage format
// override an organiser had set. The ruling: preserve inside `replaceStages`
// itself, keyed on the stage SLOT, so it holds for every caller rather than for
// whichever screen we remembered to patch.
//
// Note `replaceStages` refuses outright once any fixture exists
// (FORMAT_LOCKED), so nothing here generates fixtures — and that same fact is
// why the carry-forward can never collide with D1's per-stage lock, which needs
// a fixture to bite.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, replaceStages } from "../stages";
import { putStageRules } from "../stage-rules";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Rs " + suffix}, ${"rs-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedDivision(auth: AuthCtx): Promise<string> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Rs Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "tennis",
    variant_key: "tour",
    config: { bestOf: 1 },
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return division.id;
}

const LEAGUE_THEN_KNOCKOUT = [
  { seq: 1, kind: "league" as const, name: "League", config: {}, progression: null },
  { seq: 2, kind: "knockout" as const, name: "Cup", config: {}, progression: null },
];

async function stageBySeq(
  divisionId: string,
): Promise<Map<number, { id: string; kind: string; config: Record<string, unknown> }>> {
  const rows = await sql<
    { seq: number; id: string; kind: string; config: Record<string, unknown> }[]
  >`select seq, id, kind, config from stages where division_id = ${divisionId} order by seq`;
  return new Map(rows.map((r) => [r.seq, { id: r.id, kind: r.kind, config: r.config }]));
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("replaceStages carries per-stage rules forward", () => {
  it("preserves each stage's override when the Apply keeps the stage graph", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);
    await createStages(auth, divisionId, LEAGUE_THEN_KNOCKOUT);

    const before = await stageBySeq(divisionId);
    await putStageRules(auth, before.get(1)!.id, { rules: { bestOf: 1 } });
    await putStageRules(auth, before.get(2)!.id, { rules: { bestOf: 5 } });

    // The same graph re-applied — the body carries no `rules` and cannot.
    await replaceStages(auth, divisionId, LEAGUE_THEN_KNOCKOUT);

    const after = await stageBySeq(divisionId);
    // Genuinely new rows: the old ones were deleted, so this is a carry, not a
    // no-op that never touched the table.
    expect(after.get(1)!.id).not.toBe(before.get(1)!.id);
    expect(after.get(2)!.id).not.toBe(before.get(2)!.id);
    // Per SLOT, and the two slots differ — so neither assertion can be
    // satisfied by the other stage's value.
    expect(after.get(1)!.config.rules).toEqual({ bestOf: 1 });
    expect(after.get(2)!.config.rules).toEqual({ bestOf: 5 });
  }, 60_000);

  it("drops an override when the stage at that seq changes KIND", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);
    await createStages(auth, divisionId, LEAGUE_THEN_KNOCKOUT);

    const before = await stageBySeq(divisionId);
    await putStageRules(auth, before.get(1)!.id, { rules: { bestOf: 1 } });
    await putStageRules(auth, before.get(2)!.id, { rules: { bestOf: 5 } });

    // seq 2 becomes a league. "The knockout is Best-of-5" does not mean
    // "whatever now sits at seq 2 is Best-of-5" — a different competition
    // shape does not inherit the old shape's format. Note this is a judgement
    // and not a validity constraint: the allowlist is per SPORT and the sport
    // cannot change here, so a carried fragment would have passed every guard.
    await replaceStages(auth, divisionId, [
      { seq: 1, kind: "league" as const, name: "League", config: {}, progression: null },
      { seq: 2, kind: "league" as const, name: "Second", config: {}, progression: null },
    ]);

    const after = await stageBySeq(divisionId);
    expect(after.get(2)!.kind).toBe("league");
    expect(after.get(2)!.config.rules).toBeUndefined();
    // The UNCHANGED slot still carries its override — otherwise this test
    // would also pass against a carry-forward that was simply broken.
    expect(after.get(1)!.config.rules).toEqual({ bestOf: 1 });
  }, 60_000);

  it("400s on a rules key in the body AND leaves the existing stages standing", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth);
    await createStages(auth, divisionId, LEAGUE_THEN_KNOCKOUT);
    const before = await stageBySeq(divisionId);

    // The refusal has to happen BEFORE the delete, not inside the createStages
    // this function delegates to: that call runs in its own transaction, so a
    // refusal there would land after every stage in the division was already
    // dropped. Comment-only until now — this is the witness.
    await expect(
      replaceStages(auth, divisionId, [
        { seq: 1, kind: "league" as const, name: "League", config: { rules: { bestOf: 3 } }, progression: null },
      ]),
    ).rejects.toMatchObject({ status: 400, code: "RULES_NOT_ACCEPTED_HERE" });

    const after = await stageBySeq(divisionId);
    expect(after.size).toBe(2);
    expect(after.get(1)!.id).toBe(before.get(1)!.id);
    expect(after.get(2)!.id).toBe(before.get(2)!.id);
  }, 60_000);
});
