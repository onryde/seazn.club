// W2c Task 11 (batch-1 I-A) — a DIVISION save re-asks, for every stage that carries its own rules, the question the
// stage PUT asked when they were saved. Since owner P-2 "A" the division's config can change after a stage stored
// `config.rules`; the merged `{division ⊕ stage.rules}` can then be a config the sport's schema refuses (Pool B's
// `cap: 21` under a division whose `setTo` is now 25), or a `pointsMap` can stop answering the set scores a stage's
// own `bestOf` can end on. Both used to be frozen as saved and surfaced later as a crash in the standings.
//
// The refusal names the stage and rolls the whole save back. Every refusal is paired with its positive (the same save
// with the stage's rules out of the way goes through), so a guard that refuses everything cannot pass. Expected values
// come from the engine's own schema (`configSchema`, `variants`), never from numbers typed against the code under test.
// Single sport (badminton): the guard is `stageRulesProblem`, sport-blind code that reads only the sport's schema; the
// per-sport sweep of the stage door is stage-rules-every-sport.test.ts.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { stageTopKeysFor } from "@seazn/engine/sport";
import { StageKind } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createStages } from "../stages";
import { putStageRules } from "../stage-rules";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const badminton = builtinModules.find((m) => m.key === "badminton")!;
const SHORT = badminton.variants.short as Record<string, unknown>;

async function seed(config: Record<string, unknown>, stageNames: string[]) {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Ia " + suffix}, ${"ia-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Ia Cup " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open", slug: "open-" + suffix, sport_key: "badminton", variant_key: "short", config,
  });
  const stages: string[] = [];
  for (const [i, name] of stageNames.entries()) {
    const [st] = await createStages(auth, division.id, { seq: i + 1, kind: "league", name, config: {}, progression: null });
    stages.push(st!.id);
  }
  return { auth, divisionId: division.id, stages };
}
const divisionConfigOf = async (id: string) => (await sql<{ c: unknown }[]>`select config as c from divisions where id = ${id}`)[0]!.c;

describe.skipIf(!HAS_DB)("I-A: a division format save never leaves a stage's own rules unparseable", () => {
  // Pool B caps its sets at 21; the division then moves to 25-point games (cap 30). The stage's 21 is below the new
  // target - the engine's own refusal ("cap must be ≥ the set target"), asserted off its schema below.
  const POOL_CAP = 21;
  const moved = { ...SHORT, setTo: 25, finalSetTo: 25, cap: 30 };

  it("premise: the engine refuses Pool B's cap under the moved division, and accepts both halves apart", () => {
    expect(badminton.configSchema.safeParse({ ...SHORT, cap: POOL_CAP }).success, "Pool B's rules are valid today").toBe(true);
    expect(badminton.configSchema.safeParse(moved).success, "the moved division is valid alone").toBe(true);
    expect(badminton.configSchema.safeParse({ ...moved, cap: POOL_CAP }).success, "the merge is the engine's refusal").toBe(false);
  });

  it("refused 422 CONFIG_INVALID naming the stage, the engine's issues on the wire; the division is unchanged", async () => {
    const s = await seed(SHORT, ["Pool A", "Pool B"]);
    await putStageRules(s.auth, s.stages[1]!, { rules: { cap: POOL_CAP } });
    const before = await divisionConfigOf(s.divisionId);
    const err = await patchDivision(s.auth, s.divisionId, { config: moved }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID", extra: { stage_id: s.stages[1], stage_name: "Pool B" } });
    expect(String((err as Error).message)).toContain("Pool B");
    expect(String((err as Error).message), "Pool A carries no rules and is not named").not.toContain("Pool A");
    const engine = badminton.configSchema.safeParse({ ...moved, cap: POOL_CAP });
    expect(engine.success, "the premise: the engine refuses the merge").toBe(false);
    // ONE wire shape for CONFIG_INVALID's issues, `{path, message}` (http.ts forwards the engine's so).
    expect((err as { extra: { issues?: unknown } }).extra.issues).toEqual(engine.success ? [] : engine.error.issues.map((i) => ({ path: i.path, message: i.message })));
    expect(await divisionConfigOf(s.divisionId), "rolled back whole").toEqual(before);
  });

  it("positive pairs: the same save goes through once Pool B's rules are cleared, or when they still fit", async () => {
    const cleared = await seed(SHORT, ["Pool A", "Pool B"]);
    await putStageRules(cleared.auth, cleared.stages[1]!, { rules: { cap: POOL_CAP } });
    await putStageRules(cleared.auth, cleared.stages[1]!, { rules: null });
    await expect(patchDivision(cleared.auth, cleared.divisionId, { config: moved })).resolves.toBeDefined();

    const fits = await seed(SHORT, ["Pool A", "Pool B"]);
    await putStageRules(fits.auth, fits.stages[1]!, { rules: { cap: POOL_CAP } });
    const stillFits = { ...SHORT, setTo: 15, finalSetTo: 15, cap: 30 }; // 21 >= 15: Pool B's cap still sits above the target
    expect(badminton.configSchema.safeParse({ ...stillFits, cap: POOL_CAP }).success).toBe(true);
    await expect(patchDivision(fits.auth, fits.divisionId, { config: stillFits })).resolves.toBeDefined();
  });

  it("empty case: a division with no stage rules at all saves as before", async () => {
    const s = await seed(SHORT, ["Pool A"]);
    await expect(patchDivision(s.auth, s.divisionId, { config: moved })).resolves.toBeDefined();
  });

  it("a null STORED in a stage's rules is 'inherit', not a value: it is dropped before the division save is judged (M3)", async () => {
    const s = await seed(SHORT, ["Pool A", "Pool B"]);
    const stillFits = { ...SHORT, setTo: 15, finalSetTo: 15, cap: 30 };
    // The premise, off the engine: a null carried into the merge WOULD be refused, so a pass below proves the drop.
    expect(badminton.configSchema.safeParse({ ...stillFits, cap: POOL_CAP }).success, "a fitting cap is valid").toBe(true);
    expect(badminton.configSchema.safeParse({ ...stillFits, cap: POOL_CAP, bestOf: null }).success, "the premise: a null bestOf is not").toBe(false);
    // Raw-seeded (the endpoint never writes a null): Pool A holds only nulls, Pool B a null beside a fitting cap.
    await sql`update stages set config = config || ${sql.json({ rules: { bestOf: null } } as never)} where id = ${s.stages[0]!}`;
    await sql`update stages set config = config || ${sql.json({ rules: { bestOf: null, cap: POOL_CAP } } as never)} where id = ${s.stages[1]!}`;
    await expect(patchDivision(s.auth, s.divisionId, { config: stillFits })).resolves.toBeDefined();
    expect((await divisionConfigOf(s.divisionId) as Record<string, unknown>).setTo, "the save landed").toBe(15);
  });

  it("a save that does not move the config is not asked (a stage already invalid is not this save's doing)", async () => {
    const s = await seed(SHORT, ["Pool A"]);
    // Raw-seeded: the stage PUT would refuse this, so it can only exist as a row written before the guard.
    await sql`update stages set config = config || ${sql.json({ rules: { cap: 5 } } as never)} where id = ${s.stages[0]!}`;
    expect(badminton.configSchema.safeParse({ ...SHORT, cap: 5 }).success, "the premise: the stored rules are invalid").toBe(false);
    // The config is SENT and unchanged (a rename alone sends none, and would skip the whole config block): the stage arm
    // is asked only when the save really moves the config.
    const stored = await divisionConfigOf(s.divisionId);
    await expect(patchDivision(s.auth, s.divisionId, { config: stored as Record<string, unknown> })).resolves.toBeDefined();
    // …and the same stage IS refused the moment the config moves (the pair that makes the gate matter).
    await expect(patchDivision(s.auth, s.divisionId, { config: { ...(stored as object), setTo: 13, finalSetTo: 13, cap: 20 } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe.skipIf(!HAS_DB)("I-A: a division pointsMap edit never leaves a stage's own bestOf unanswered", () => {
  // A map that enumerates the Bo5 scores (no "*"): the stage PUT accepts bestOf 5 against it.
  const FULL: Record<string, [number, number]> = { "2-0": [2, 0], "2-1": [2, 0], "3-0": [2, 0], "3-1": [2, 0], "3-2": [2, 0] };
  const WITHOUT_3_2: Record<string, [number, number]> = Object.fromEntries(Object.entries(FULL).filter(([score]) => score !== "3-2"));

  it("refused 422 POINTS_MAP_INCOMPLETE naming the stage and the score; the division is unchanged", async () => {
    const s = await seed({ ...SHORT, pointsMap: FULL }, ["Pool A", "Pool B"]);
    await putStageRules(s.auth, s.stages[1]!, { rules: { bestOf: 5 } });
    const before = await divisionConfigOf(s.divisionId);
    const err = await patchDivision(s.auth, s.divisionId, { config: { ...SHORT, pointsMap: WITHOUT_3_2 } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "POINTS_MAP_INCOMPLETE", extra: { stage_id: s.stages[1], stage_name: "Pool B" } });
    expect(String((err as Error).message)).toContain("Pool B");
    expect(String((err as Error).message), "the score the map no longer answers").toContain("3-2");
    expect(String((err as Error).message), "a score it still answers is not listed").not.toContain("3-1");
    expect(await divisionConfigOf(s.divisionId), "rolled back whole").toEqual(before);
  });

  it("positive pairs: a wildcard answers it, and a stage that leaves bestOf alone is not asked", async () => {
    const wild = await seed({ ...SHORT, pointsMap: FULL }, ["Pool A", "Pool B"]);
    await putStageRules(wild.auth, wild.stages[1]!, { rules: { bestOf: 5 } });
    await expect(patchDivision(wild.auth, wild.divisionId, { config: { ...SHORT, pointsMap: { ...WITHOUT_3_2, "*": [2, 0] } } })).resolves.toBeDefined();

    const other = await seed({ ...SHORT, pointsMap: FULL }, ["Pool A", "Pool B"]);
    await putStageRules(other.auth, other.stages[1]!, { rules: { setTo: 13 } });
    await expect(patchDivision(other.auth, other.divisionId, { config: { ...SHORT, pointsMap: WITHOUT_3_2 } })).resolves.toBeDefined();
  });
});

// W2c Task 12 (Task 11 review M1) — a division VARIANT change re-asks the ALLOWLIST of every stage that carries rules: the
// keys a stage of that kind may set depend on the variant (`stageTopKeysFor`), and a key the new variant cannot carry is
// left stored and un-removable (`{superOver: null}` is itself RULE_NOT_SETTABLE once the division is a test match). Cricket:
// the engine declares the super over for the limited-overs variants only. Expected keys come from the engine.
describe.skipIf(!HAS_DB)("M1: a division variant change never strands a stage key the new variant cannot carry", () => {
  const cricket = builtinModules.find((m) => m.key === "cricket")!;
  async function seedCricket(kind: "league" | "knockout", rules?: Record<string, unknown>) {
    const suffix = randomUUID().slice(0, 8);
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug) values (${"Vm " + suffix}, ${"vm-" + suffix}) returning id`;
    await setOrgPlan(orgId);
    await invalidateOrgEntitlements(orgId);
    const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Vm Cup " + suffix, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: "cricket", variant_key: "t20", config: {} });
    const [st] = await createStages(auth, division.id, { seq: 1, kind, name: kind === "league" ? "Pool A" : "Final", config: {}, progression: null });
    if (rules !== undefined) await putStageRules(auth, st!.id, { rules });
    return { auth, divisionId: division.id, stageId: st!.id };
  }
  const variantOf = async (id: string) => (await sql<{ v: string }[]>`select variant_key as v from divisions where id = ${id}`)[0]!.v;
  const rulesOf = async (id: string) => (await sql<{ r: unknown }[]>`select config -> 'rules' as r from stages where id = ${id}`)[0]!.r;

  it("premise: superOver is a t20 stage key and not a test one", () => {
    expect(stageTopKeysFor(cricket, "league", "t20").has("superOver")).toBe(true);
    expect(stageTopKeysFor(cricket, "league", "test").has("superOver")).toBe(false);
  });

  it("t20 -> test with a stored superOver: refused RULE_NOT_SETTABLE naming the stage and the key; nothing written", async () => {
    const s = await seedCricket("league", { superOver: false });
    const err = await patchDivision(s.auth, s.divisionId, { variant_key: "test" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "RULE_NOT_SETTABLE", extra: { field: "superOver", stage_id: s.stageId, stage_name: "Pool A" } });
    expect(String((err as Error).message)).toContain("Pool A");
    expect(await variantOf(s.divisionId), "the variant is unchanged").toBe("t20");
    expect(await rulesOf(s.stageId)).toEqual({ superOver: false });
  });

  it("the positive pair: with the key cleared on the stage (allowed while t20), the same change lands", async () => {
    const s = await seedCricket("league", { superOver: false });
    await putStageRules(s.auth, s.stageId, { rules: { superOver: null } });
    await expect(patchDivision(s.auth, s.divisionId, { variant_key: "test" })).resolves.toBeDefined();
    expect(await variantOf(s.divisionId)).toBe("test");
  });

  // Fix round 1 (R-T12-2): a key still EQUAL to the old variant's preset is re-seeded by the change, never asked; only
  // a key the organiser changed reaches the allowlist (variant-preset-reseed.test.ts holds the re-seed itself).
  it("a knockout whose super over the organiser switched off is asked too, naming it; one still on its preset is re-seeded and lands", async () => {
    const s = await seedCricket("knockout", { superOver: false });
    await expect(patchDivision(s.auth, s.divisionId, { variant_key: "test" })).rejects.toMatchObject({
      code: "RULE_NOT_SETTABLE",
      extra: { field: "superOver", stage_id: s.stageId, stage_name: "Final" },
    });
    const preset = await seedCricket("knockout");
    expect(await rulesOf(preset.stageId), "the premise: the knockout stores its preset").toEqual({ superOver: true });
    await expect(patchDivision(preset.auth, preset.divisionId, { variant_key: "test" })).resolves.toBeDefined();
    expect(await variantOf(preset.divisionId)).toBe("test");
    expect(await rulesOf(preset.stageId), "the preset went with the variant").toBeNull();
  });

  // The call site asks on `configApplied || variantApplied`. The second half is unreachable with today's engine, and this
  // is the guard on that assumption: every variant switch that takes a stage key away also moves the config (so the config
  // gate already asks it). The day a sport declares a pair that does not, this reds, and the variant half needs a witness.
  it("premise sweep: every variant switch that takes a stage key away also moves the division config (counted)", () => {
    const canon = (o: unknown): string =>
      JSON.stringify(o, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
    let pairs = 0;
    const stillSame: string[] = [];
    for (const m of builtinModules) {
      const vs = Object.keys(m.variants);
      for (const from of vs) for (const to of vs) {
        if (from === to) continue;
        const loses = StageKind.options.some((k) => [...stageTopKeysFor(m, k, from)].some((key) => !stageTopKeysFor(m, k, to).has(key)));
        if (!loses) continue;
        pairs++;
        const stored = m.configSchema.parse(m.variants[from]);
        const resent = m.configSchema.safeParse({ ...(m.variants[to] as object), ...(stored as object) });
        if (resent.success && canon(resent.data) === canon(stored)) stillSame.push(`${m.key} ${from} -> ${to}`);
      }
    }
    expect(pairs, "anti-vacuity: the engine declares variant-dependent stage keys").toBeGreaterThan(0);
    expect(stillSame).toEqual([]);
  });

  it("empty case: a variant change with no stage rules lands; one whose new variant still carries the key keeps it", async () => {
    const s = await seedCricket("league");
    await expect(patchDivision(s.auth, s.divisionId, { variant_key: "test" })).resolves.toBeDefined();
    expect(stageTopKeysFor(cricket, "league", "odi").has("superOver"), "the premise: an ODI stage carries the super over").toBe(true);
    const t = await seedCricket("league", { superOver: true });
    await expect(patchDivision(t.auth, t.divisionId, { variant_key: "odi" })).resolves.toBeDefined();
    expect(await variantOf(t.divisionId)).toBe("odi");
    expect(await rulesOf(t.stageId)).toEqual({ superOver: true });
  });
});
