// W2c Task 11 — `putStageRules` for EVERY sport, from the engine's own declaration (spec item 1, write path 1; D1, D3;
// X-SR-1, X-SR-3; carry I2 of Task 8's review: the stage PUT MERGES into the stored rules).
//
// The allowlist is the engine's: a key the sport never declares is UNKNOWN_RULE_KEY; a declared key the stage's kind or
// variant cannot set (or a points key) is RULE_NOT_SETTABLE. Expected values come from `builtinModules`,
// `stageTopKeysFor`, `sportTopKeys`, `DRAW_KINDS` / `BRACKET_KINDS` and the sports' own variants, never from the code
// under test. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { BRACKET_KINDS, DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS, sportTopKeys, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures } from "../stages";
import { builtFor, engineValueFor } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sr " + suffix}, ${"sr-" + suffix})
    returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** `entrantCount: 0` for a division that needs no fixture (a team sport refuses `individual` entrants). Entrants take
 *  the kind the sport DECLARES as its default. */
async function seedDivision(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  entrantCount = 2,
  config: Record<string, unknown> = {},
): Promise<{ divisionId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Sr Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sportKey,
    variant_key: variantKey,
    config,
  });
  if (entrantCount === 0) return { divisionId: division.id, entrants: [] };
  const kind = mod(sportKey).entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: entrantCount }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  return { divisionId: division.id, entrants: entrants.map((e) => e.id) };
}

async function seedStage(auth: AuthCtx, divisionId: string, seq: number, kind: StageKind = "league"): Promise<string> {
  // A swiss stage must declare its round count (assertSwissRoundsDeclared); every other kind takes an empty config.
  const config = kind === "swiss" ? { rounds: 3 } : {};
  const [stage] = await createStages(auth, divisionId, { seq, kind, name: "S" + seq, config, progression: null });
  return stage!.id;
}

const stageConfig = async (stageId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const rulesOf = async (stageId: string): Promise<Record<string, unknown> | undefined> =>
  (await stageConfig(stageId)).rules as Record<string, unknown> | undefined;

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

/** The sports the registry held when W2c Task 11 was written: football, cricket, boardgame, carrom, generic, volleyball,
 *  badminton, tabletennis, tennis, icehockey, hockey. A literal on purpose (review M6): `builtinModules.length` as the
 *  expected count is the loop's own bound, so a sport that fell out of the registry would shrink both sides and read
 *  green. A NEW sport is a deliberate edit here, and the sweeps below then cover it. Pinned once. */
const SPORTS_AT_W2C = 11;

describe.skipIf(!HAS_DB)("X-SR-1 putStageRules covers every sport", () => {
  it(`the registry holds the ${SPORTS_AT_W2C} sports these sweeps were written for`, () => {
    expect(builtinModules.length).toBe(SPORTS_AT_W2C);
  });

  it("every sport x EVERY variant x EVERY stage kind: a declared key is saved, an undeclared-for-this-kind one is RULE_NOT_SETTABLE (counted)", async () => {
    let combos = 0;
    let accepted = 0;
    let refused = 0;
    let declaredTotal = 0;
    let viaEditor = 0;
    const unprobed: string[] = [];
    const sportsSeen = new Set<string>();
    const kindsWithAKey = new Set<string>();
    for (const m of builtinModules) {
      const sport = m as AnySportModule;
      const auth = await seedOrg();
      const known = sportTopKeys(sport);
      for (const variant of Object.keys(m.variants)) {
        const { divisionId } = await seedDivision(auth, m.key, variant, 0);
        for (const kind of StageKind.options) {
          // One stage at a time: all nine kinds in one division would outrun the plan's stages-per-division cap, and a
          // stage that is removed after its kind is swept leaves the next kind a clean division.
          const stageId = await seedStage(auth, divisionId, 1, kind);
          const settable = stageTopKeysFor(sport, kind, variant);
          combos++;
          sportsSeen.add(m.key);
          if (settable.size > 0) kindsWithAKey.add(kind);
          for (const top of settable) {
            declaredTotal++;
            let frag = builtFor(sport, variant, top);
            if (Object.keys(frag).length > 0) viaEditor++;
            else frag = engineValueFor(sport, variant, top); // no editor field builds this key (yet)
            if (Object.keys(frag).length === 0) {
              unprobed.push(`${m.key}/${variant}/${kind}.${top}`);
              continue;
            }
            await putStageRules(auth, stageId, { rules: {} }); // each key alone: a clear first (the merge tests are below)
            await putStageRules(auth, stageId, { rules: frag }).catch((e: unknown) => {
              // Name the key and the engine's reason: a bare "invalid cricket config" says neither.
              throw new Error(`${m.key}/${variant}/${kind}.${top} ${JSON.stringify(frag)}: ${(e as Error).message} ${JSON.stringify((e as { data?: unknown }).data)}`);
            });
            expect(await rulesOf(stageId), `${m.key}/${variant}/${kind}.${top}`).toMatchObject(frag);
            accepted++;
          }
          await putStageRules(auth, stageId, { rules: {} });
          for (const top of known) {
            if (settable.has(top)) continue;
            // The mirror: every key the sport declares that THIS kind and variant cannot set - including the ones a
            // sibling variant can (cricket test vs t20) - is refused, and nothing is written.
            await expect(putStageRules(auth, stageId, { rules: { [top]: null } }), `${m.key}/${variant}/${kind}.${top}`).rejects.toMatchObject({
              status: 400,
              code: "RULE_NOT_SETTABLE",
              extra: { field: top },
            });
            refused++;
          }
          expect((await rulesOf(stageId)) ?? null, `${m.key}/${variant}/${kind}: nothing written by a refusal`).toBeNull();
          await sql`delete from stages where id = ${stageId}`;
        }
      }
    }
    expect(unprobed, "every declared stage key got a value the engine accepts").toEqual([]);
    expect(accepted, "every declared (kind, variant, key) was saved and read back").toBe(declaredTotal - unprobed.length);
    // Anti-vacuity, from the engine's declarations (a sport has at least one variant and the kinds are the engine's):
    expect(combos, `${combos} (sport, variant, kind) combinations visited`).toBe(
      builtinModules.reduce((n, m) => n + Object.keys(m.variants).length, 0) * StageKind.options.length,
    );
    expect(sportsSeen.size, "every sport was visited").toBe(SPORTS_AT_W2C);
    // Exact, from the engine's declarations (Task 11 re-review b): the kinds where some sport and variant settles a key,
    // and every declared key a (sport, variant, kind) cannot set.
    const engineKinds = StageKind.options.filter((kind) =>
      builtinModules.some((m) => Object.keys(m.variants).some((v) => stageTopKeysFor(m as AnySportModule, kind, v).size > 0)),
    );
    expect(kindsWithAKey.size, `the kinds that settle a key: ${engineKinds.join(", ")}`).toBe(engineKinds.length);
    const engineRefused = builtinModules.reduce((n, m) => {
      const sport = m as AnySportModule;
      const known = [...sportTopKeys(sport)];
      return n + Object.keys(m.variants).reduce((k, v) => k + StageKind.options.reduce((j, kind) => j + known.filter((top) => !stageTopKeysFor(sport, kind, v).has(top)).length, 0), 0);
    }, 0);
    expect(viaEditor, "most keys ride the editor's own builders").toBeGreaterThan(SPORTS_AT_W2C);
    expect(accepted, `${accepted} saves`).toBeGreaterThan(2 * SPORTS_AT_W2C * StageKind.options.length);
    expect(engineRefused, "the engine declares keys some stage cannot set").toBeGreaterThan(0);
    expect(refused, `${refused} refusals`).toBe(engineRefused);
  }, 600_000);

  it("a cricket TEST stage refuses superOver and dls (they belong to the limited-overs variants); the same keys save on t20 (I1: the variant is witnessed)", async () => {
    const cricket = mod("cricket");
    const testOnly = [...stageTopKeysFor(cricket, "league", "t20")].filter((k) => !stageTopKeysFor(cricket, "league", "test").has(k));
    // The premise, from the engine's declaration: the keys t20 settles and test does not include both of these.
    expect(testOnly, "the premise: the engine narrows superOver and dls to the limited-overs variants").toEqual(expect.arrayContaining(["superOver", "dls"]));
    const auth = await seedOrg();
    const { divisionId: testDiv } = await seedDivision(auth, "cricket", "test", 0);
    const { divisionId: t20Div } = await seedDivision(auth, "cricket", "t20", 0);
    const onTest = await seedStage(auth, testDiv, 1, "league");
    const onT20 = await seedStage(auth, t20Div, 1, "league");
    let checked = 0;
    for (const top of testOnly) {
      const frag = builtFor(cricket, "t20", top);
      const value = Object.keys(frag).length > 0 ? frag : engineValueFor(cricket, "t20", top);
      expect(Object.keys(value).length, `the premise: a t20 value for ${top}`).toBeGreaterThan(0);
      await expect(putStageRules(auth, onTest, { rules: value }), top).rejects.toMatchObject({ status: 400, code: "RULE_NOT_SETTABLE", extra: { field: top } });
      expect((await rulesOf(onTest)) ?? null, `${top}: the refused save wrote nothing`).toBeNull();
      await expect(putStageRules(auth, onT20, { rules: value }), `${top} on t20`).resolves.toBeDefined(); // the positive pair
      expect(await rulesOf(onT20), `${top} on t20 is stored`).toMatchObject(value);
      checked++;
    }
    expect(checked, `anti-vacuity: ${checked} test-only keys paired`).toBeGreaterThanOrEqual(2);
  });

  it("UNKNOWN_RULE_KEY for an undeclared key; RULE_NOT_SETTABLE for a key this kind cannot set", async () => {
    const auth = await seedOrg();
    const carrom = mod("carrom");
    const variant = Object.keys(carrom.variants)[0]!;
    const { divisionId } = await seedDivision(auth, "carrom", variant, 0);
    const ko = await seedStage(auth, divisionId, 1, "knockout");
    const league = await seedStage(auth, divisionId, 2, "league");
    expect(sportTopKeys(carrom).has("tieBoard"), "the premise: carrom declares tieBoard").toBe(true);
    expect(stageTopKeysFor(carrom, "knockout", variant).has("tieBoard"), "the premise: ... but not for a knockout").toBe(false);
    expect(stageTopKeysFor(carrom, "league", variant).has("tieBoard"), "the premise: ... and it is settable on a league").toBe(true);
    await expect(putStageRules(auth, ko, { rules: { bogus: 1 } })).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
    await expect(putStageRules(auth, ko, { rules: { tieBoard: "extra" } })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
      extra: { field: "tieBoard" },
    });
    // The positive pair: the same key on a league stage is saved.
    await expect(putStageRules(auth, league, { rules: { tieBoard: "extra" } })).resolves.toBeDefined();
    expect((await rulesOf(ko)) ?? null, "a refused save writes nothing").toBeNull();
  });

  it("a key sent as null is judged too: an undeclared one is UNKNOWN_RULE_KEY, a declared-but-unsettable one RULE_NOT_SETTABLE", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "carrom", Object.keys(mod("carrom").variants)[0]!, 0);
    const ko = await seedStage(auth, divisionId, 1, "knockout");
    await expect(putStageRules(auth, ko, { rules: { bogus: null } })).rejects.toMatchObject({ code: "UNKNOWN_RULE_KEY" });
    await expect(putStageRules(auth, ko, { rules: { tieBoard: null } })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE" });
  });

  it("chess has no `tiebreak` key: the decider is `tiebreakRungs`, so `tiebreak` is UNKNOWN_RULE_KEY on every kind, while the rung list is declared (M3)", async () => {
    const auth = await seedOrg();
    const chess = mod("boardgame");
    const variant = Object.keys(chess.variants)[0]!;
    expect(sportTopKeys(chess).has("tiebreak"), "the premise: the engine declares no `tiebreak` for chess").toBe(false);
    expect(sportTopKeys(chess).has("tiebreakRungs"), "the premise: ... but declares tiebreakRungs").toBe(true);
    const { divisionId } = await seedDivision(auth, "boardgame", variant, 0);
    let refused = 0;
    let seq = 0;
    for (const kind of ["league", "knockout"] as const) {
      const stage = await seedStage(auth, divisionId, ++seq, kind);
      await expect(putStageRules(auth, stage, { rules: { tiebreak: "armageddon" } }), kind).rejects.toMatchObject({ status: 400, code: "UNKNOWN_RULE_KEY" });
      await expect(putStageRules(auth, stage, { rules: { tiebreak: null } }), `${kind} null`).rejects.toMatchObject({ code: "UNKNOWN_RULE_KEY" });
      expect((await rulesOf(stage)) ?? null, `${kind}: nothing written`).toBeNull();
      refused++;
    }
    expect(refused, "both kinds were driven").toBe(2);
  });

  it("points keys belong to the Points section, never stage rules (football points)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    expect(sportTopKeys(mod("football")).has("points"), "the premise: football declares points").toBe(true);
    // W2d PS-1: the shoot-out bonus is football's own points key now (the pair it replaced left the schema).
    await expect(putStageRules(auth, s, { rules: { points: { soBonus: 1 } } })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
      extra: { field: "points" },
    });
  });

  it("every sport refuses its own points keys as RULE_NOT_SETTABLE and a made-up key as UNKNOWN_RULE_KEY (counted)", async () => {
    let points = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const settable = stageTopKeysFor(m as AnySportModule, "league", variant);
      const auth = await seedOrg();
      const { divisionId } = await seedDivision(auth, m.key, variant, 0);
      const s = await seedStage(auth, divisionId, 1, "league");
      for (const key of sportTopKeys(m as AnySportModule)) {
        if (settable.has(key)) continue;
        await expect(putStageRules(auth, s, { rules: { [key]: null } }), `${m.key}.${key}`).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE" });
        points++;
      }
      await expect(putStageRules(auth, s, { rules: { notARuleOf_ever: 1 } }), m.key).rejects.toMatchObject({ code: "UNKNOWN_RULE_KEY" });
      expect((await rulesOf(s)) ?? null, `${m.key}: nothing written`).toBeNull();
    }
    expect(points, "anti-vacuity: some declared-but-unsettable key was refused").toBeGreaterThan(SPORTS_AT_W2C);
  }, 120_000);

  it("P-5 share needs draws: a generic stage refuses share while its division forbids draws", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "generic", "win_loss", 0); // win_loss: allowDraws false
    const s = await seedStage(auth, divisionId, 1, "league");
    const err = await putStageRules(auth, s, { rules: { abandonPolicy: "share" } }).catch((e: unknown) => e);
    // An EngineError: its code and the engine's issues (the HTTP status is http.ts's mapping, 422).
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify((err as { data?: unknown }).data)).toContain(SHARE_NEEDS_DRAWS);
    expect((await rulesOf(s)) ?? null).toBeNull();
    await expect(putStageRules(auth, s, { rules: { allowDraws: true, abandonPolicy: "share" } })).resolves.toBeDefined(); // positive pair
  });

  it("X-SR-3 rules lock at the first event and stay locked after a void", async () => {
    const auth = await seedOrg();
    const chess = mod("boardgame");
    const { divisionId } = await seedDivision(auth, "boardgame", Object.keys(chess.variants)[0]!, 2);
    const s = await seedStage(auth, divisionId, 1, "league");
    await generateStageFixtures(auth, s);
    // One fixture is enough: the lock (`lockedStageIdsAmong`, shared with the panel's read half) counts ANY match of the
    // stage - one event on any one fixture locks the whole stage, however many it holds.
    const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
    await putStageRules(auth, s, { rules: { variant: "rapid" } });
    const started = await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
    await expect(putStageRules(auth, s, { rules: { variant: "blitz" } })).rejects.toMatchObject({ status: 409, code: "STAGE_FORMAT_LOCKED" });
    const v = await appendEvent(auth.orgId, f!.id, 1, { type: "core.void", payload: {}, voids: started.event.id });
    expect(v.event.voids).toBe(started.event.id); // the void landed
    await expect(putStageRules(auth, s, { rules: { variant: "blitz" } })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    expect((await rulesOf(s))?.variant, "the refused saves wrote nothing").toBe("rapid");
  });

  it("an empty fragment clears to the division; a second clear is a no-op", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "cricket", "t20", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { rules: { superOver: true } });
    expect(await rulesOf(s), "the premise: something was stored").toEqual({ superOver: true });
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules")).toBe(false);
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules")).toBe(false);
  });

  it("CONFIG_INVALID carries the engine's reason", async () => {
    const auth = await seedOrg();
    const ice = mod("icehockey");
    const { divisionId } = await seedDivision(auth, "icehockey", Object.keys(ice.variants)[0]!, 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const err = await putStageRules(auth, s, { rules: { periods: { count: 3, minutes: -1 } } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    const bad = ice.configSchema.safeParse({ ...(ice.variants[Object.keys(ice.variants)[0]!] as object), periods: { count: 3, minutes: -1 } });
    expect(bad.success, "the premise: the engine refuses it").toBe(false);
    expect(JSON.stringify((err as { data?: { issues?: unknown } }).data?.issues)).toContain(bad.success ? "" : (bad.error.issues[0]?.message ?? "?"));
    expect((await rulesOf(s)) ?? null).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("carry I2 (Task 8 review): a stage save MERGES into the stored rules", () => {
  it("chess knockout stored with [] -> PUT another field -> read back []; an explicit [] is stored, not stripped", async () => {
    const auth = await seedOrg();
    const chess = mod("boardgame");
    const variant = Object.keys(chess.variants)[0]!;
    const { divisionId } = await seedDivision(auth, "boardgame", variant, 0);
    const ko = await seedStage(auth, divisionId, 1, "knockout");
    expect(stageTopKeysFor(chess, "knockout", variant).has("tiebreakRungs"), "the premise: tiebreakRungs is a knockout key").toBe(true);
    await putStageRules(auth, ko, { rules: { tiebreakRungs: [] } });
    expect(await rulesOf(ko), "[] means 'held for the organiser' and is stored").toEqual({ tiebreakRungs: [] });
    await putStageRules(auth, ko, { rules: { variant: "rapid" } });
    expect(await rulesOf(ko), "the other field landed and the empty list survived").toEqual({ tiebreakRungs: [], variant: "rapid" });
    // The same again: a repeat save changes nothing.
    await putStageRules(auth, ko, { rules: { variant: "rapid" } });
    expect(await rulesOf(ko)).toEqual({ tiebreakRungs: [], variant: "rapid" });
  });

  it("keys the body omits are kept; a null removes just that key; the last key removed clears the stage; {} and null clear all (set sport)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    await putStageRules(auth, s, { rules: { bestOf: 3 } });
    await putStageRules(auth, s, { rules: { setTo: 15 } });
    expect(await rulesOf(s), "the second save kept the first").toEqual({ bestOf: 3, setTo: 15 });
    await putStageRules(auth, s, { rules: { bestOf: 1 } });
    expect(await rulesOf(s), "a key the body names is replaced").toEqual({ bestOf: 1, setTo: 15 });
    await putStageRules(auth, s, { rules: { setTo: null } });
    expect(await rulesOf(s), "null removes that key and only that key").toEqual({ bestOf: 1 });
    await putStageRules(auth, s, { rules: { bestOf: null } });
    expect(Object.hasOwn(await stageConfig(s), "rules"), "the last key removed leaves no stored rules").toBe(false);
    await putStageRules(auth, s, { rules: { bestOf: 3, setTo: 15 } });
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules"), "{} clears everything").toBe(false);
    await putStageRules(auth, s, { rules: { bestOf: 3, setTo: 15 } });
    await putStageRules(auth, s, { rules: null });
    expect(Object.hasOwn(await stageConfig(s), "rules"), "null clears everything").toBe(false);
  });

  it("a null already STORED (written by an older build, not by this endpoint) is dropped by the next save, never carried (M3)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    // The endpoint never writes a null, so seed one straight onto the row: this is the pre-merge replace era's shape.
    await sql`update stages set config = config || ${sql.json({ rules: { bestOf: null, setTo: 15 } } as never)} where id = ${s}`;
    expect(await rulesOf(s), "the premise: the null is stored").toEqual({ bestOf: null, setTo: 15 });
    await putStageRules(auth, s, { rules: { finalSetTo: 15 } });
    expect(await rulesOf(s), "the stored null is gone, the stored value and the new one stay").toEqual({ setTo: 15, finalSetTo: 15 });
    // Only nulls: the merge empties and the stage returns to the division's format.
    await sql`update stages set config = config || ${sql.json({ rules: { bestOf: null } } as never)} where id = ${s}`;
    await putStageRules(auth, s, { rules: {} });
    expect(Object.hasOwn(await stageConfig(s), "rules"), "an emptied merge clears the key").toBe(false);
    await sql`update stages set config = config || ${sql.json({ rules: { bestOf: null } } as never)} where id = ${s}`;
    await putStageRules(auth, s, { rules: { setTo: 15 } });
    expect(await rulesOf(s), "the null beside a fresh key is dropped, not stored").toEqual({ setTo: 15 });
  });

  it("the merge is what is validated: a stored cap and a new setTo that break the schema together are refused, nothing written", async () => {
    const auth = await seedOrg();
    const bad = mod("badminton");
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const together = { setTo: 25, finalSetTo: 25, cap: 21 };
    expect(bad.configSchema.safeParse({ ...together }).success, "the premise: the engine refuses cap < setTo").toBe(false);
    await putStageRules(auth, s, { rules: { cap: 21 } });
    // setTo alone is valid on its own against the division (cap null) - only the MERGE with the stored cap breaks.
    expect(bad.configSchema.safeParse({ setTo: 25, finalSetTo: 25 }).success, "the premise: setTo 25 alone is fine").toBe(true);
    await expect(putStageRules(auth, s, { rules: { setTo: 25, finalSetTo: 25 } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await rulesOf(s), "the refused save wrote nothing").toEqual({ cap: 21 });
  });
});

// W2c Task 13b (D3): a stage's deciders are stored AND read under `config.rules` only. Football alone, because its
// `shootout` is one of the two keys the retired top-level overlay read (the every-sport sweep is stage-cfg.test.ts's).
describe.skipIf(!HAS_DB)("D3 (Task 13b): a stage's deciders resolve from its rules alone", () => {
  it("D3 deciders live in rules; a top-level decider no longer reaches the resolved cfg", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const s = await seedStage(auth, divisionId, 1, "knockout");
    await putStageRules(auth, s, { rules: { shootout: false } });
    expect((await stageConfig(s)).rules).toMatchObject({ shootout: false });
    // A top-level value written straight to the row (no current writer can: the create door refuses it) is ignored.
    await sql`update stages set config = config || ${sql.json({ shootout: true } as never)} where id = ${s}`;
    expect((await stageConfig(s)).shootout, "the premise: the row carries a top-level shootout").toBe(true);
    const football = mod("football");
    const resolved = async (): Promise<{ shootout: boolean }> => {
      const [row] = await sql<{ kind: string; config: Record<string, unknown>; division_config: unknown }[]>`
        select s.kind, s.config, d.config as division_config from stages s join divisions d on d.id = s.division_id
        where s.id = ${s}`;
      return resolveFixtureCfg({ config_snapshot: null, rules_override: null }, row!.division_config, row!, football) as { shootout: boolean };
    };
    expect(await resolved()).toMatchObject({ shootout: false });
    // The positive pair: the same decider saved under rules is what the stage plays, the top-level key still beside it.
    await putStageRules(auth, s, { rules: { shootout: true } });
    expect(await resolved()).toMatchObject({ shootout: true });
  });
});

describe.skipIf(!HAS_DB)("I2 (Task 11 review): a stage save validates against the division AS COMMITTED under the lock", () => {
  /** Hold the division's advisory lock on ONE connection, start the stage save on another, wait until it is queued
   *  behind the lock (pg_locks, so its first read has certainly happened - it precedes the lock), run `commit` on the
   *  holder's connection, release, and return how the save ended. Deterministic: no sleep stands in for an ordering. */
  async function saveBehindADivisionCommit(
    auth: AuthCtx,
    divisionId: string,
    stageId: string,
    rules: Record<string, unknown>,
    commit: (tx: typeof sql) => Promise<void>,
  ): Promise<unknown> {
    let saved: Promise<unknown> | undefined;
    await sql.begin(async (holder) => {
      await holder`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
      saved = putStageRules(auth, stageId, { rules }).then(
        (v) => v,
        (e: unknown) => e,
      );
      // The key as pg_locks shows it: a single bigint splits into classid (high 32) and objid (low 32), objsubid 1.
      let queued = 0;
      for (let i = 0; i < 400 && queued === 0; i++) {
        const [{ n }] = await holder<{ n: number }[]>`
          select count(*)::int as n from pg_locks
           where locktype = 'advisory' and not granted and objsubid = 1
             and ((classid::bigint << 32) | objid::bigint) = hashtext(${"division:" + divisionId})::bigint`;
        queued = n;
        if (queued === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(queued, "the stage save is queued behind the division lock (it has read, and is waiting)").toBe(1);
      await commit(holder as unknown as typeof sql);
    });
    return saved;
  }

  it("a division CONFIG committed while the save waits is the config it is judged against: cap 21 under a setTo moved to 25 is refused, nothing stored", async () => {
    const auth = await seedOrg();
    const bad = mod("badminton");
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const base = bad.variants["bwf"] as Record<string, unknown>;
    expect(bad.configSchema.safeParse({ ...base, cap: 21 }).success, "the premise: cap 21 is fine on the division as first read").toBe(true);
    expect(bad.configSchema.safeParse({ ...base, setTo: 25, finalSetTo: 25, cap: 21 }).success, "the premise: ... and not once its setTo is 25").toBe(false);
    const outcome = await saveBehindADivisionCommit(auth, divisionId, s, { cap: 21 }, async (tx) => {
      await tx`update divisions set config = config || ${tx.json({ setTo: 25, finalSetTo: 25 } as never)} where id = ${divisionId}`;
    });
    expect(outcome, "refused: the merged parse ran on the committed division, not the one read before the lock").toMatchObject({ code: "CONFIG_INVALID" });
    expect((await rulesOf(s)) ?? null, "a refused save writes nothing").toBeNull();
  });

  it("a division VARIANT committed while the save waits is the variant the allowlist reads: superOver on a division moved to test is refused", async () => {
    const auth = await seedOrg();
    const cricket = mod("cricket");
    expect(stageTopKeysFor(cricket, "league", "t20").has("superOver"), "the premise: t20 settles superOver").toBe(true);
    expect(stageTopKeysFor(cricket, "league", "test").has("superOver"), "the premise: test does not").toBe(false);
    const { divisionId } = await seedDivision(auth, "cricket", "t20", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const outcome = await saveBehindADivisionCommit(auth, divisionId, s, { superOver: true }, async (tx) => {
      await tx`update divisions set variant_key = 'test' where id = ${divisionId}`;
    });
    expect(outcome).toMatchObject({ status: 400, code: "RULE_NOT_SETTABLE", extra: { field: "superOver" } });
    expect((await rulesOf(s)) ?? null, "a refused save writes nothing").toBeNull();
  });

  it("a stage DELETED while the save waits on the division lock is a 404, and nothing is written", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const outcome = await saveBehindADivisionCommit(auth, divisionId, s, { cap: 21 }, async (tx) => {
      await tx`delete from stages where id = ${s}`;
    });
    expect(outcome, "the second read, under the lock, finds no stage").toMatchObject({ status: 404 });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from stages where id = ${s}`)[0]!.n).toBe(0);
  });

  it("the positive pair: with NO division change in between, the same waiting save lands", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "badminton", "bwf", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    const outcome = await saveBehindADivisionCommit(auth, divisionId, s, { cap: 21 }, async () => {});
    expect(outcome).toEqual({ rules: { cap: 21 }, points: null });
    expect(await rulesOf(s)).toEqual({ cap: 21 });
  });
});

describe.skipIf(!HAS_DB)("GN-AB-2 CA-AB-2 the stage's own abandon policy", () => {
  const abandonedState = async (fixtureId: string) =>
    (await sql<{ status: string; outcome: { kind: string } | null }[]>`select status, outcome from fixtures where id = ${fixtureId}`)[0]!;
  const onlyFixture = async (stageId: string) => (await sql<{ id: string }[]>`select id from fixtures where stage_id = ${stageId} order by fixture_no limit 1`)[0]!.id;

  it("GN-AB-2: a generic table stage saved with share draws an abandoned match; its sibling without it replays; the knockout refuses the setting", async () => {
    const generic = mod("generic");
    const variant = "score";
    expect((generic.configSchema.parse(generic.variants[variant]) as { allowDraws: boolean }).allowDraws, "the premise: the score variant allows draws").toBe(true);
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "generic", variant, 2);
    const sharing = await seedStage(auth, divisionId, 1, "league");
    const replaying = await seedStage(auth, divisionId, 2, "league");
    const knockout = await seedStage(auth, divisionId, 3, "knockout");
    await putStageRules(auth, sharing, { rules: { abandonPolicy: "share" } });
    expect(await rulesOf(replaying), "the premise: the sibling states no policy").toBeUndefined();

    // Table stages only (ruling 133): the engine declares where the key applies, the knockout is outside it.
    expect(DRAW_KINDS.has("league") && !DRAW_KINDS.has("knockout") && BRACKET_KINDS.has("knockout"), "the premise: league is a table kind, knockout a bracket").toBe(true);
    expect(stageTopKeysFor(generic, "knockout", variant).has("abandonPolicy")).toBe(false);
    await expect(putStageRules(auth, knockout, { rules: { abandonPolicy: "share" } })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "abandonPolicy" } });

    const played: Record<string, string> = {};
    for (const [label, stageId] of [["sharing", sharing], ["replaying", replaying], ["knockout", knockout]] as const) {
      await generateStageFixtures(auth, stageId);
      const id = await onlyFixture(stageId);
      const [f] = await sql<{ home: string; away: string }[]>`select home_entrant_id home, away_entrant_id away from fixtures where id = ${id}`;
      await appendEvent(auth.orgId, id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, id, 1, { type: "generic.score", payload: { by: f!.home, points: 2 } });
      await appendEvent(auth.orgId, id, 2, { type: "generic.score", payload: { by: f!.away, points: 1 } });
      await appendEvent(auth.orgId, id, 3, { type: "core.abandon", payload: { reason: "weather" } });
      played[label] = id;
    }
    expect(await abandonedState(played.sharing!), "as the stage says: share = a drawn result the table credits").toMatchObject({ status: "decided", outcome: { kind: "draw" } });
    expect(await abandonedState(played.replaying!), "the sibling stage replays: abandoned, nobody decided").toMatchObject({ status: "abandoned", outcome: null });
    expect(await abandonedState(played.knockout!), "in a knockout the abandon is held for the organiser, never a draw").toMatchObject({ status: "abandoned", outcome: null });
  }, 60_000);

  it("CA-AB-2: a carrom table stage saved with share draws an abandoned match only where a drawn game is possible; the sibling replays", async () => {
    const carrom = mod("carrom");
    const variant = "icf";
    expect((carrom.configSchema.parse(carrom.variants[variant]) as { tieBoard: string }).tieBoard, "the premise: ICF play breaks a tie on an extra board").toBe("extra");
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "carrom", variant, 2);
    const sharing = await seedStage(auth, divisionId, 1, "league");
    const replaying = await seedStage(auth, divisionId, 2, "league");
    const knockout = await seedStage(auth, divisionId, 3, "knockout");

    // P-5: sharing needs a drawn game to be possible, and the refusal names the setting to change.
    const refused = await putStageRules(auth, sharing, { rules: { abandonPolicy: "share" } }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify((refused as { data?: unknown }).data)).toContain(SHARE_NEEDS_DRAWN_GAME);
    expect((await rulesOf(sharing)) ?? null, "the refused save wrote nothing").toBeNull();
    await putStageRules(auth, sharing, { rules: { tieBoard: "draw", abandonPolicy: "share" } });
    expect(await rulesOf(sharing)).toEqual({ tieBoard: "draw", abandonPolicy: "share" });
    await expect(putStageRules(auth, knockout, { rules: { abandonPolicy: "share" } })).rejects.toMatchObject({ code: "RULE_NOT_SETTABLE", extra: { field: "abandonPolicy" } });

    const played: Record<string, string> = {};
    for (const [label, stageId] of [["sharing", sharing], ["replaying", replaying], ["knockout", knockout]] as const) {
      await generateStageFixtures(auth, stageId);
      const id = await onlyFixture(stageId);
      await appendEvent(auth.orgId, id, 0, { type: "core.start", payload: {} });
      await appendEvent(auth.orgId, id, 1, { type: "core.abandon", payload: { reason: "weather" } });
      played[label] = id;
    }
    expect(await abandonedState(played.sharing!)).toMatchObject({ status: "decided", outcome: { kind: "draw" } });
    expect(await abandonedState(played.replaying!)).toMatchObject({ status: "abandoned", outcome: null });
    expect(await abandonedState(played.knockout!)).toMatchObject({ status: "abandoned", outcome: null });
  }, 60_000);
});

describe.skipIf(!HAS_DB)("rule 10 - stage rules x start x void", () => {
  it("after every step: a save succeeds iff no fixture of the stage has started", async () => {
    let steps = 0;
    let voidsLanded = 0;
    let refusedAfterStart = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom("save", "clear", "start", "void"), { minLength: 1, maxLength: 6 }), async (ops) => {
        const auth = await seedOrg();
        const { divisionId } = await seedDivision(auth, "badminton", "short", 2);
        const s = await seedStage(auth, divisionId, 1, "league");
        await generateStageFixtures(auth, s);
        const [f] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${s} limit 1`;
        let seq = 0;
        let started = false;
        const live: string[] = []; // unvoided, non-void event ids (a void is not voidable)
        for (const op of ops) {
          steps++;
          if (op === "start" && seq === 0) {
            live.push((await appendEvent(auth.orgId, f!.id, seq, { type: "core.start", payload: {} })).event.id);
            seq++;
            started = true;
            continue;
          }
          if (op === "void" && live.length > 0) {
            const target = live.pop()!;
            const v = await appendEvent(auth.orgId, f!.id, seq, { type: "core.void", payload: {}, voids: target });
            expect(v.event.voids).toBe(target); // the void branch really ran
            voidsLanded++;
            seq++;
            continue;
          }
          if (op === "save" || op === "clear") {
            const p = putStageRules(auth, s, { rules: op === "save" ? { setTo: 15 } : {} });
            if (started) {
              await expect(p).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
              refusedAfterStart++;
            } else await expect(p).resolves.toBeDefined();
          }
        }
      }),
      { seed: 20261013, numRuns: 25 },
    );
    expect(steps).toBeGreaterThan(0);
    expect(voidsLanded, "the seeded runs never reached a void after a start").toBeGreaterThan(0);
    expect(refusedAfterStart, "the seeded runs never reached a refused save after a start").toBeGreaterThan(0);
  }, Math.max(5_000, 25 * 6 * 400 * 5));
});
