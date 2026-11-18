// X-BD-3 (rulebook RB5-S2; owner S1): the "super-groups" gallery template names no sport of its own. The organiser
// chooses sport, variant, entrant kind and field size; pools scale to 4 per pool; the create goes through the same door
// as every other template. Real Postgres required (the sport catalogue, divisions, stages).
//
// Every sport in the engine registry is driven (house rule), and every entrant kind each declares; the sweeps print and
// assert their counts so an empty registry or an empty kind list fails instead of passing.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { pickVariant } from "@/lib/preferred-variant";
import type { AuthCtx } from "@/server/api-v1/auth";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createFromTemplate, TEMPLATE_INSTANTIATION_FAILED_CODE } from "../templates";
import { createEntrants } from "../entrants";
import { templateSportOptions } from "../template-sports";
import { choosableSports } from "@/lib/template-choice";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "super-groups";
// The rule's own number: pools of 4.
const POOL_SIZE = 4;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Any " + suffix}, ${"any-" + suffix}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** The engine's whole registry, in the catalogue rows a create reads (`on conflict do nothing`: safe beside sync:sports). */
async function seedEverySport(): Promise<void> {
  for (const mod of builtinModules) {
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json(mod.positions as never)})
      on conflict (key) do nothing`;
    for (const [variantKey, config] of Object.entries(mod.variants)) {
      await sql`
        insert into sport_variants (sport_key, key, name, config, is_system)
        values (${mod.key}, ${variantKey}, ${variantKey}, ${sql.json((config ?? {}) as never)}, true)
        on conflict do nothing`;
    }
  }
}

const body = (extra: Record<string, unknown>) => ({
  template_key: KEY,
  name: `Any ${randomUUID().slice(0, 6)}`,
  ends_on: "2030-12-31",
  visibility: "private" as const,
  ...extra,
});

const kindsOf = (mod: (typeof builtinModules)[number]) =>
  effectiveEntrantModel((mod as { entrantModel?: never }).entrantModel ?? null, null).kinds;
const defaultKindOf = (mod: (typeof builtinModules)[number]) =>
  effectiveEntrantModel((mod as { entrantModel?: never }).entrantModel ?? null, null).defaultKind;
const variantOf = (mod: (typeof builtinModules)[number]) => pickVariant(mod.key, Object.keys(mod.variants).map((key) => ({ key })));

async function readBack(divisionId: string) {
  const [division] = await sql<{ sport_key: string; variant_key: string; config: Record<string, unknown> }[]>`
    select sport_key, variant_key, config from divisions where id = ${divisionId}`;
  const stages = await sql<{ seq: number; kind: string; config: { pools?: { count: number } }; progression: unknown }[]>`
    select seq, kind, config, progression from stages where division_id = ${divisionId} order by seq`;
  return { division: division!, stages };
}

const competitionCount = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from competitions where org_id = ${orgId}`)[0]!.n;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  globalForDb._sql = undefined;
});

describe.runIf(HAS_DB)("createFromTemplate — super-groups, the sport-agnostic two-tier groups template (X-BD-3)", () => {
  it("X-BD-3 super-groups instantiates for every sport in builtinModules", async () => {
    // differential: today no such template (404 TEMPLATE_UNKNOWN_KEY for every sport)
    await seedEverySport();
    let made = 0;
    const seen: string[] = [];
    for (const mod of builtinModules) {
      const auth = await seedOrg();
      const kind = defaultKindOf(mod);
      const out = await createFromTemplate(auth, body({
        sport_key: mod.key, variant_key: variantOf(mod), entrant_kind: kind, entrant_count: 16,
      }));
      expect(out.templateKey, mod.key).toBe(KEY);
      expect(out.divisions, mod.key).toHaveLength(1);
      const { division, stages } = await readBack(out.divisions[0]!.id);
      expect([division.sport_key, division.variant_key], mod.key).toEqual([mod.key, variantOf(mod)]);
      // 16 entrants: pools of 4 -> 4 pools; then the template's own 2 super groups; then a knockout.
      expect(stages.map((s) => s.kind), mod.key).toEqual(["group", "group", "knockout"]);
      expect(stages.map((s) => s.config.pools?.count), mod.key).toEqual([16 / POOL_SIZE, 2, undefined]);
      expect(stages[1]!.progression, mod.key).not.toBeNull();
      expect(stages[2]!.progression, mod.key).not.toBeNull();
      // The division is narrowed to the kind chosen, as the builder narrows one (C9 Q3, n3).
      expect(division.config.entrants, mod.key).toEqual({ kinds: [kind], defaultKind: kind });
      seen.push(mod.key);
      made++;
    }
    expect(made).toBe(builtinModules.length);
    expect(made).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(builtinModules.length);
  });

  it("X-BD-3 every entrant kind a sport plays is built, and every kind it does not play is refused with nothing left behind", async () => {
    await seedEverySport();
    let built = 0;
    let refused = 0;
    for (const mod of builtinModules) {
      const played = kindsOf(mod);
      for (const kind of ["team", "pair", "individual"] as const) {
        const auth = await seedOrg();
        const ask = () => createFromTemplate(auth, body({ sport_key: mod.key, variant_key: variantOf(mod), entrant_kind: kind, entrant_count: 8 }));
        if (played.includes(kind)) {
          const out = await ask();
          const { division } = await readBack(out.divisions[0]!.id);
          expect(division.config.entrants, `${mod.key}/${kind}`).toEqual({ kinds: [kind], defaultKind: kind });
          built++;
        } else {
          await expect(ask(), `${mod.key}/${kind}`).rejects.toMatchObject({ status: 422, code: "TEMPLATE_ENTRANT_KIND_UNSUPPORTED" });
          expect(await competitionCount(auth.orgId), `${mod.key}/${kind}`).toBe(0);
          refused++;
        }
      }
    }
    // 11 sports x 3 kinds, split by what each declares: both halves are real (chess refuses team and pair).
    expect(built + refused).toBe(builtinModules.length * 3);
    expect(built).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("X-BD-3 each offered count builds pools of 4 (a pair sport, so the count means pairs)", async () => {
    await seedEverySport();
    const badminton = builtinModules.find((m) => m.key === "badminton")!;
    let checked = 0;
    for (const [count, pools] of [[8, 2], [12, 3], [16, 4], [24, 6], [32, 8]] as const) {
      const auth = await seedOrg();
      const out = await createFromTemplate(auth, body({ sport_key: "badminton", variant_key: variantOf(badminton), entrant_kind: "pair", entrant_count: count }));
      const { stages } = await readBack(out.divisions[0]!.id);
      expect(stages.map((s) => s.config.pools?.count), `${count} pairs`).toEqual([pools, 2, undefined]);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("X-BD-3 the narrowed kind is real: a badminton pairs event takes a pair and refuses an individual", async () => {
    await seedEverySport();
    const auth = await seedOrg();
    const out = await createFromTemplate(auth, body({ sport_key: "badminton", variant_key: "short", entrant_kind: "pair", entrant_count: 8 }));
    const divisionId = out.divisions[0]!.id;
    const person = async (n: number) => (await sql<{ id: string }[]>`
      insert into persons (org_id, full_name) values (${auth.orgId}, ${"P" + n + randomUUID().slice(0, 4)}) returning id`)[0]!.id;
    const [a, b] = [await person(1), await person(2)];
    await expect(
      createEntrants(auth, divisionId, [{ kind: "individual", display_name: "Solo", members: [{ person_id: a, is_captain: false, roles: [] }] }]),
    ).rejects.toMatchObject({ status: 422 });
    const made = await createEntrants(auth, divisionId, [{ kind: "pair", display_name: "A+B", members: [{ person_id: a, is_captain: false, roles: [] }, { person_id: b, is_captain: false, roles: [] }] }]);
    expect(made).toHaveLength(1);
  });

  it("X-BD-3 an unchosen or unoffered choice is refused by name before anything is written", async () => {
    await seedEverySport();
    const auth = await seedOrg();
    const full = { sport_key: "football", variant_key: "11-a-side", entrant_kind: "team", entrant_count: 16 };
    const cases: [string, Record<string, unknown>, number, string][] = [
      ["no choice at all", {}, 400, "TEMPLATE_CHOICE_REQUIRED"],
      ["no sport", { ...full, sport_key: undefined }, 400, "TEMPLATE_CHOICE_REQUIRED"],
      ["no variant", { ...full, variant_key: undefined }, 400, "TEMPLATE_CHOICE_REQUIRED"],
      ["no kind", { ...full, entrant_kind: undefined }, 400, "TEMPLATE_CHOICE_REQUIRED"],
      ["a count not offered", { ...full, entrant_count: 20 }, 400, "TEMPLATE_COUNT_NOT_OFFERED"],
      ["an unknown sport", { ...full, sport_key: "no-such-sport" }, 422, TEMPLATE_INSTANTIATION_FAILED_CODE],
      ["an unknown variant", { ...full, variant_key: "no-such-variant" }, 422, TEMPLATE_INSTANTIATION_FAILED_CODE],
    ];
    let checked = 0;
    for (const [label, extra, status, code] of cases) {
      await expect(createFromTemplate(auth, body(extra)), label).rejects.toMatchObject({ status, code });
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(await competitionCount(auth.orgId)).toBe(0);
  });

  it("X-BD-3 a fixed template takes no choice (refused by name), and still builds exactly as before without one", async () => {
    await seedEverySport();
    const auth = await seedOrg();
    await expect(
      createFromTemplate(auth, { template_key: "t20-super8", name: "Fixed", ends_on: "2030-12-31", visibility: "private", sport_key: "football" }),
    ).rejects.toMatchObject({ status: 400, code: "TEMPLATE_CHOICE_NOT_OFFERED" });
    expect(await competitionCount(auth.orgId)).toBe(0);
    const out = await createFromTemplate(auth, { template_key: "t20-super8", name: "Fixed", ends_on: "2030-12-31", visibility: "private" });
    const { division, stages } = await readBack(out.divisions[0]!.id);
    expect([division.sport_key, division.variant_key]).toEqual(["cricket", "t20"]);
    expect(division.config.entrants).toBeUndefined(); // no narrowing rides along on a fixed template
    expect(stages.map((s) => s.config.pools?.count)).toEqual([4, 2, undefined]);
  });

  it("X-BD-3 a second create from the same card is a second competition, not a collision", async () => {
    await seedEverySport();
    const auth = await seedOrg();
    const ask = () => createFromTemplate(auth, body({ name: "Winter Cup", sport_key: "football", variant_key: "11-a-side", entrant_kind: "team", entrant_count: 12 }));
    const [a, b] = [await ask(), await ask()];
    expect(a.competitionId).not.toBe(b.competitionId);
    expect(a.slug).not.toBe(b.slug);
    expect(await competitionCount(auth.orgId)).toBe(2);
  });

  it("X-BD-3 the sheet's sport catalogue offers every sport the create builds on, with the kinds the engine declares", async () => {
    await seedEverySport();
    const auth = await seedOrg();
    const options = choosableSports(await templateSportOptions(auth.orgId));
    let checked = 0;
    for (const mod of builtinModules) {
      const o = options.find((x) => x.key === mod.key);
      expect(o, mod.key).toBeDefined();
      expect(o!.entrants!.kinds, mod.key).toEqual([...kindsOf(mod)]);
      expect(o!.entrants!.defaultKind, mod.key).toBe(defaultKindOf(mod));
      expect(o!.variants.map((v) => v.key).sort(), mod.key).toEqual(Object.keys(mod.variants).sort());
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });
});
