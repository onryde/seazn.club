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
import { BRACKET_KINDS, DRAW_KINDS, type StageKind } from "@seazn/engine/core";
import { SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS, sportTopKeys, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
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
  const [stage] = await createStages(auth, divisionId, { seq, kind, name: "S" + seq, config: {}, progression: null });
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

describe.skipIf(!HAS_DB)("X-SR-1 putStageRules covers every sport", () => {
  it("every sport accepts every stage key it declares for a league stage, and stores it (counted)", async () => {
    let checked = 0;
    let declared = 0;
    let viaEditor = 0;
    const unprobed: string[] = [];
    const swept: string[] = [];
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const auth = await seedOrg();
      const { divisionId } = await seedDivision(auth, m.key, variant, 0);
      const stageId = await seedStage(auth, divisionId, 1, "league");
      for (const top of stageTopKeysFor(m as AnySportModule, "league", variant)) {
        declared++;
        let frag = builtFor(m as AnySportModule, variant, top);
        if (Object.keys(frag).length > 0) viaEditor++;
        else frag = engineValueFor(m as AnySportModule, variant, top); // no editor field builds this key (yet)
        if (Object.keys(frag).length === 0) {
          unprobed.push(`${m.key}.${top}`);
          continue;
        }
        await putStageRules(auth, stageId, { rules: {} }); // each key alone: a clear first (the merge test is below)
        await putStageRules(auth, stageId, { rules: frag }).catch((e: unknown) => {
          // Name the key and the engine's reason: a bare "invalid cricket config" says neither.
          throw new Error(`${m.key}.${top} ${JSON.stringify(frag)}: ${(e as Error).message} ${JSON.stringify((e as { data?: unknown }).data)}`);
        });
        expect(await rulesOf(stageId), `${m.key}.${top}`).toMatchObject(frag);
        checked++;
        swept.push(`${m.key}.${top}`);
      }
    }
    expect(unprobed, "every declared stage key got a value the engine accepts").toEqual([]);
    expect(checked, "every declared stage key was saved and read back").toBe(declared);
    expect(viaEditor, "most keys ride the editor's own builders").toBeGreaterThan(builtinModules.length);
    expect(declared, `anti-vacuity: ${swept.length} keys swept`).toBeGreaterThan(2 * builtinModules.length);
    expect(new Set(swept.map((s) => s.split(".")[0])).size, "every sport saved at least one key").toBe(builtinModules.length);
  }, Math.max(60_000, builtinModules.length * 30_000));

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

  it("points keys belong to the Points section, never stage rules (football points)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const s = await seedStage(auth, divisionId, 1, "league");
    expect(sportTopKeys(mod("football")).has("points"), "the premise: football declares points").toBe(true);
    await expect(putStageRules(auth, s, { rules: { points: { shootoutWin: 2, shootoutLoss: 1 } } })).rejects.toMatchObject({
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
    expect(points, "anti-vacuity: some declared-but-unsettable key was refused").toBeGreaterThan(builtinModules.length);
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
