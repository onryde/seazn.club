// W2d Task 10 (spec §5.4 "What changes after the pin", §5.5 "Write paths", §5.8, §7, §11 item 4; D8, D9; rule rows X-TB-2,
// X-TB-5, FB-TB-4) — the division's default order and points after the pin, and the doors that create stages.
//
//   - A division save of `tiebreakers` (or of the points a stage's pin replaces) is no longer refused for a started stage:
//     it reaches only unpinned stages, and the answer lists the pinned stages that kept their rules (`stagesKeptPinned`).
//   - It is validated (`validateCascade`) against the sport and against every UNPINNED table stage that inherits it; a
//     refusal names the stage and its kind. A config save that flips football `fairPlay` re-asks every unpinned stage's
//     order the same way.
//   - `createStages` validates the order a new stage would inherit, and assigns `config.rngSeed` when absent; a template's
//     order is the zod enum's and is validated on apply.
//
// Expected values come from the engine (`validateCascade`, `defaultTiebreakers`, `primaryTableKey`, the presets) and the
// orders each test declares. Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { validateCascade } from "@seazn/engine/competition";
import type { StageKind } from "@seazn/engine/core";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { loadTableRules } from "@/server/engine-db/table-rules";
import { CompetitionTemplate } from "@/server/templates/schema";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures } from "../stages";
import { instantiateTemplate } from "../templates";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};
// single-sport: generic is the rig's sport for the sport-blind rules below; a test whose rule belongs to one sport names that sport (and says why).
const generic = mod("generic");
const GENERIC_DEFAULT = generic.defaultTiebreakers("league", generic.configSchema.parse(GENERIC_CONFIG));
const DIV_ORDER: TiebreakerKey[] = ["points", "diff", "lots"];

interface Division {
  auth: AuthCtx;
  divisionId: string;
  entrants: string[];
}

async function division(opts: {
  sport: string;
  variant: string;
  config?: Record<string, unknown>;
  entrants?: number;
  tiebreakers?: TiebreakerKey[];
}): Promise<Division> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T10d " + suffix, visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: opts.sport,
    variant_key: opts.variant,
    config: opts.config ?? (opts.sport === "generic" ? GENERIC_CONFIG : {}), // single-sport: the rig's cfg default: generic takes the shared GENERIC_CONFIG fixture, every other sport its variant's own.
    ...(opts.tiebreakers === undefined ? {} : { tiebreakers: opts.tiebreakers }),
  });
  const kind = mod(opts.sport).entrantModel?.defaultKind ?? "individual";
  const n = opts.entrants ?? 2;
  const created =
    n === 0
      ? []
      : await createEntrants(auth, d.id, Array.from({ length: n }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  return { auth, divisionId: d.id, entrants: created.map((e) => e.id) };
}

async function stage(d: Division, seq: number, kind: StageKind, name: string): Promise<string> {
  const [s] = await createStages(d.auth, d.divisionId, { seq, kind, name, config: kind === "swiss" ? { rounds: 1 } : {}, progression: null });
  return s!.id;
}

/** Generate the stage (it activates and is pinned) and record its first event (it starts: W2c's lock). */
async function start(d: Division, stageId: string): Promise<void> {
  await generateStageFixtures(d.auth, stageId);
  const [f] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stageId} and home_entrant_id is not null and away_entrant_id is not null limit 1`;
  await appendEvent(d.auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
}

const divisionCfg = async (divisionId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;
const stageCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`)[0]!.n;

describe.skipIf(!HAS_DB)("W2d T10 the division's order and points after the pin", () => {
  it("X-TB-2 a division tiebreakers save is no longer refused for a started stage; the response lists it in stagesKeptPinned", async () => {
    // single-sport: generic carries this sport-blind write-path rule (no sport step or cfg key in it could refuse the save for another reason).
    const d = await division({ sport: "generic", variant: "score", entrants: 2 });
    const a = await stage(d, 1, "league", "Pool A");
    const b = await stage(d, 2, "league", "Pool B");
    await start(d, a);
    const pinned = await loadTableRules(sql, a);
    expect(pinned.tiebreakers, "premise: Pool A is pinned to the sport's order").toEqual(GENERIC_DEFAULT);
    const out = await patchDivision(d.auth, d.divisionId, { tiebreakers: DIV_ORDER });
    expect(out.refused).toEqual([]);
    expect(out.tiebreakers).toEqual(DIV_ORDER);
    expect(out.stagesKeptPinned).toEqual([{ stageId: a, name: "Pool A" }]);
    // The started stage kept its pin; the unpinned one reads the new order.
    expect((await loadTableRules(sql, a)).tiebreakers).toEqual(GENERIC_DEFAULT);
    const pending = await loadTableRules(sql, b);
    expect(pending.tiebreakers).toEqual(DIV_ORDER);
    expect(pending.sources.tiebreakers).toBe("division");
    // Second call: re-sending the stored order changes nothing, so nothing is kept from anything.
    const again = await patchDivision(d.auth, d.divisionId, { tiebreakers: DIV_ORDER });
    expect(again.stagesKeptPinned).toEqual([]);
    // Back to null (the sport's): a change again, the pinned stage listed again.
    const cleared = await patchDivision(d.auth, d.divisionId, { tiebreakers: null });
    expect(cleared.tiebreakers).toBeNull();
    expect(cleared.stagesKeptPinned).toEqual([{ stageId: a, name: "Pool A" }]);
  });

  it("STAGE_POINTS_REPLACES: a division otWin / soBonus / tie / draw save is accepted once stages are pinned; boardgame `scoring` still DIVISION_TABLE_RULES_LOCKED", async () => {
    // single-sport: each case is a sport that declares that points key (icehockey otWin, football soBonus and draw, cricket tie); boardgame is the one whose `scoring` also writes the headline, so the one still locked.
    // Each sport's points key, nested where its schema declares it (`points.otWin` etc.): the save changes `points`.
    const cases: { sport: string; variant: string; sub: string }[] = [
      { sport: "icehockey", variant: "iihf", sub: "otWin" },
      { sport: "football", variant: "11-a-side", sub: "soBonus" },
      { sport: "cricket", variant: "t20", sub: "tie" },
      { sport: "football", variant: "11-a-side", sub: "draw" },
    ];
    let checked = 0;
    for (const c of cases) {
      const d = await division({ sport: c.sport, variant: c.variant, entrants: 2 });
      const s = await stage(d, 1, "league", "Pool A");
      await start(d, s);
      const pin = await loadTableRules(sql, s);
      const cfg = await divisionCfg(d.divisionId);
      const points = { ...(cfg.points as Record<string, unknown>), [c.sub]: 7 };
      const out = await patchDivision(d.auth, d.divisionId, { config: { ...cfg, points } });
      expect(out.refused, `${c.sport} ${c.sub}`).toEqual([]);
      expect((await divisionCfg(d.divisionId)).points, `${c.sport} ${c.sub} landed`).toMatchObject({ [c.sub]: 7 });
      expect(out.stagesKeptPinned, `${c.sport} ${c.sub}`).toEqual([{ stageId: s, name: "Pool A" }]);
      expect((await loadTableRules(sql, s)).points, `${c.sport} ${c.sub}: the pin did not move`).toEqual(pin.points);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Boardgame's `scoring` also writes the game's headline: still the W2c lock.
    const bg = await division({ sport: "boardgame", variant: "classical", entrants: 2 });
    const s = await stage(bg, 1, "league", "Pool A");
    await start(bg, s);
    const cfg = await divisionCfg(bg.divisionId);
    const scoring = { ...(cfg.scoring as Record<string, unknown>), win: 3 };
    await expect(patchDivision(bg.auth, bg.divisionId, { config: { ...cfg, scoring } })).rejects.toMatchObject({
      status: 409,
      code: "DIVISION_TABLE_RULES_LOCKED",
      extra: { refused: [{ field: "scoring", stageName: "Pool A" }] },
    });
  });

  it("X-TB-5 a division default invalid for one unpinned inheriting stage is refused naming that stage and its kind; a pinned stage is not consulted", async () => {
    // single-sport: the stage-kind refusal is sport-blind (buchholz is a Swiss step in every sport), so generic carries it; football stands for a sport that records no NRR (cricket's step) for the sport refusal.
    const d = await division({ sport: "generic", variant: "score", entrants: 2 });
    const a = await stage(d, 1, "league", "Pool A");
    await stage(d, 2, "swiss", "Swiss");
    const b = await stage(d, 3, "league", "Pool B");
    await start(d, a);
    // A Swiss-only step: valid where the stage is Swiss, refused on a league (rule 3).
    const order: TiebreakerKey[] = ["points", "buchholz", "lots"];
    const cfg = generic.configSchema.parse(await divisionCfg(d.divisionId));
    expect(validateCascade(order, { module: generic, cfg, stageKind: "swiss", crossGroup: false }), "premise: valid on Swiss").toEqual([]);
    const want = validateCascade(order, { module: generic, cfg, stageKind: "league", crossGroup: false });
    expect(want, "premise: refused on a league").toEqual([expect.objectContaining({ index: 1, key: "buchholz", reason: "stage_format" })]);
    await expect(patchDivision(d.auth, d.divisionId, { tiebreakers: order })).rejects.toMatchObject({
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      // Pool B, not Pool A: the pinned league is never consulted.
      extra: { stage_id: b, stage_name: "Pool B", stage_kind: "league", refusals: want },
    });
    expect((await sql<{ t: unknown }[]>`select tiebreakers as t from divisions where id = ${d.divisionId}`)[0]!.t, "nothing written").toBeNull();
    // Pool B takes an order of its own: it no longer inherits, so the default lands (the Swiss stage takes it).
    await putStageRules(d.auth, b, { tiebreakers: DIV_ORDER });
    const out = await patchDivision(d.auth, d.divisionId, { tiebreakers: order });
    expect(out.tiebreakers).toEqual(order);
    // Against the sport (no stage needed): an order naming a step the sport does not record is refused at create too.
    const football = mod("football");
    await expect(division({ sport: "football", variant: "11-a-side", tiebreakers: [football.primaryTableKey, "nrr", "lots"] })).rejects.toMatchObject({
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      extra: { refusals: [expect.objectContaining({ key: "nrr", reason: "sport" })] },
    });
    await expect(division({ sport: "generic", variant: "score", tiebreakers: [] })).rejects.toMatchObject({
      code: "TIEBREAK_KEY_INVALID",
      extra: { refusals: [{ index: -1, key: null, reason: "empty" }] },
    });
  });

  it("FB-TB-4 flipping football fairPlay off while an unpinned stage has an OWN or division order holding fair_play is refused naming it; a stage inheriting the sport default is not refused (the default drops fair_play with it — PS-7c, Task 11)", async () => {
    // single-sport: FB-TB-4 is football's alone: fairPlay is its cfg key and fair_play its step, and no other sport declares either.
    const football = mod("football");
    const d = await division({ sport: "football", variant: "11-a-side", entrants: 2 });
    const s = await stage(d, 1, "league", "Pool A");
    const cfg = await divisionCfg(d.divisionId);
    expect(cfg.fairPlay, "premise: the preset tracks fair play").toBe(true);
    const withFairPlay = football.defaultTiebreakers("league", football.configSchema.parse(cfg));
    const withoutFairPlay = football.defaultTiebreakers("league", football.configSchema.parse({ ...cfg, fairPlay: false }));
    expect(withFairPlay, "premise: the default ranks on fair play while tracked").toContain("fair_play");
    expect(withoutFairPlay, "premise: and drops it when not (PS-7c)").not.toContain("fair_play");
    const off = { ...cfg, fairPlay: false };
    const refusal = {
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      extra: { stage_id: s, stage_name: "Pool A", refusals: [expect.objectContaining({ key: "fair_play", reason: "fair_play_off" })] },
    };
    // (a) the stage's OWN order holds fair_play
    await putStageRules(d.auth, s, { tiebreakers: [...withFairPlay] });
    await expect(patchDivision(d.auth, d.divisionId, { config: off })).rejects.toMatchObject(refusal);
    expect((await divisionCfg(d.divisionId)).fairPlay, "nothing written").toBe(true);
    // (b) the stage inherits the DIVISION's order, which holds it
    await putStageRules(d.auth, s, { tiebreakers: null });
    await patchDivision(d.auth, d.divisionId, { tiebreakers: [...withFairPlay] });
    await expect(patchDivision(d.auth, d.divisionId, { config: off })).rejects.toMatchObject(refusal);
    // (c) it inherits the SPORT's default: the flip lands, and the stage now ranks by the default without fair play
    await patchDivision(d.auth, d.divisionId, { tiebreakers: null });
    const out = await patchDivision(d.auth, d.divisionId, { config: off });
    expect(out.refused).toEqual([]);
    expect((await divisionCfg(d.divisionId)).fairPlay).toBe(false);
    expect((await loadTableRules(sql, s)).tiebreakers).toEqual(withoutFairPlay);
  });

  it("FB-TB-4 a PINNED stage is not asked (spec §5.5: the flip re-validates every UNPINNED inheriting cascade): its pin ranks on fair_play, the flip lands, the pin is kept", async () => {
    // single-sport: FB-TB-4 is football's alone: fairPlay is its cfg key and fair_play its step, and no other sport declares either.
    const football = mod("football");
    const d = await division({ sport: "football", variant: "11-a-side", entrants: 2 });
    const s = await stage(d, 1, "league", "Pool A");
    const cfg = await divisionCfg(d.divisionId);
    const withFairPlay = football.defaultTiebreakers("league", football.configSchema.parse(cfg));
    expect(withFairPlay, "premise: the default ranks on fair play while tracked").toContain("fair_play");
    await putStageRules(d.auth, s, { tiebreakers: [...withFairPlay] });
    await generateStageFixtures(d.auth, s);
    const pin = await loadTableRules(sql, s);
    expect(pin.pinnedAt, "premise: pinned").not.toBeNull();
    expect(pin.tiebreakers, "premise: the pin ranks on fair play").toContain("fair_play");
    const off = { ...cfg, fairPlay: false };
    expect(validateCascade(pin.tiebreakers, { module: football, cfg: football.configSchema.parse(off), stageKind: "league", crossGroup: false }), "premise: asked, the pin's order would be refused under the flip").toEqual([
      expect.objectContaining({ key: "fair_play", reason: "fair_play_off" }),
    ]);
    const out = await patchDivision(d.auth, d.divisionId, { config: off });
    expect(out.refused, "the flip is not refused").toEqual([]);
    expect((await divisionCfg(d.divisionId)).fairPlay, "and lands").toBe(false);
    expect((await loadTableRules(sql, s)).tiebreakers, "the pin is kept").toEqual(pin.tiebreakers);
  });

  it("createStages: an inherited key invalid for the new stage's kind is refused with the 'set this stage's own order' reason; rngSeed is assigned when absent", async () => {
    // single-sport: the kind refusal on an inherited key is sport-blind (buchholz is a Swiss step in every sport), so generic carries it.
    const order: TiebreakerKey[] = ["points", "buchholz", "lots"];
    const d = await division({ sport: "generic", variant: "score", tiebreakers: order });
    await expect(
      createStages(d.auth, d.divisionId, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null }),
    ).rejects.toMatchObject({
      status: 422,
      code: "TIEBREAK_KEY_INVALID",
      message: expect.stringContaining("set this stage's own order"),
      extra: { stage_kind: "league", inherited: "division", refusals: [expect.objectContaining({ key: "buchholz", reason: "stage_format" })] },
    });
    expect(await stageCount(d.divisionId), "the batch wrote nothing").toBe(0);
    // A Swiss stage takes the inherited order, and is given a lots seed.
    const [swiss] = await createStages(d.auth, d.divisionId, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 1 }, progression: null });
    const seed = (swiss!.config as { rngSeed?: unknown }).rngSeed;
    expect(Number.isInteger(seed), "rngSeed assigned").toBe(true);
    expect(seed as number).toBeGreaterThanOrEqual(0);
    expect(seed as number).toBeLessThan(2 ** 31);
    const [{ stored }] = await sql<{ stored: unknown }[]>`select config -> 'rngSeed' as stored from stages where id = ${swiss!.id}`;
    expect(stored, "and stored").toBe(seed);
    // A seed sent is kept.
    const [kept] = await createStages(d.auth, d.divisionId, { seq: 2, kind: "swiss", name: "Swiss 2", config: { rounds: 1, rngSeed: 42 }, progression: null });
    expect((kept!.config as { rngSeed?: unknown }).rngSeed).toBe(42);
  });

  it("a template whose tiebreakers hold an unknown key is refused at apply (schema.ts no longer z.string())", async () => {
    // single-sport: the refusal is the template schema's key enum, which no sport changes; the synthetic template needs a sport, and generic is the neutral one.
    const template = (tiebreakers: string[], kind: "league" | "knockout" = "league"): CompetitionTemplate => ({
      key: "t10-synthetic",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: [
        {
          i18nNameKey: "templates.slam128.div.main",
          sportKey: "generic",
          variantKey: "score",
          entrantKind: "individual",
          entrantCount: 4,
          tiebreakers: tiebreakers as TiebreakerKey[],
          stages: [{ i18nNameKey: "templates.stage.mainDraw", kind }],
        },
      ],
    });
    // The schema is the vocabulary's enum now: an unknown key does not parse.
    expect(CompetitionTemplate.safeParse(template(["points", "not_a_key", "lots"])).success).toBe(false);
    expect(CompetitionTemplate.safeParse(template(DIV_ORDER)).success, "the positive pair parses").toBe(true);
    const { auth } = await seedOrg("pro");
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from competitions where org_id = ${auth.orgId}`)[0]!.n;
    const before = await count();
    // Applied with the object as given (no parse in front): an unknown key, and a known one the sport does not record.
    for (const bad of [["points", "not_a_key", "lots"], ["points", "nrr", "lots"]]) {
      await expect(instantiateTemplate(auth, template(bad), { name: "T10 tpl", ends_on: "2030-12-31" }), bad.join(",")).rejects.toMatchObject({
        status: 422,
        code: "TEMPLATE_INSTANTIATION_FAILED",
      });
    }
    // A division with no table stage asks no stage of its order: the division door's own sport check refuses it alone.
    await expect(instantiateTemplate(auth, template(["points", "nrr", "lots"], "knockout"), { name: "T10 tpl ko", ends_on: "2030-12-31" }), "knockout, nrr").rejects.toMatchObject({
      status: 422,
      code: "TEMPLATE_INSTANTIATION_FAILED",
    });
    expect(await count(), "nothing left behind").toBe(before);
    const ko = await instantiateTemplate(auth, template(DIV_ORDER, "knockout"), { name: "T10 tpl ko ok", ends_on: "2030-12-31" });
    expect(ko.divisions, "the positive pair: the same knockout template with a valid order instantiates").toHaveLength(1);
    const ok = await instantiateTemplate(auth, template(DIV_ORDER), { name: "T10 tpl ok", ends_on: "2030-12-31" });
    const [{ t }] = await sql<{ t: unknown }[]>`select tiebreakers as t from divisions where id = ${ok.divisions[0]!.id}`;
    expect(t).toEqual(DIV_ORDER);
  });

  it("§5.8 no non-Swiss product path reaches the seed → id fallback: every sport default (forEachSport × non-Swiss TableStageKind × the module's default cfg) and every order a write path accepts ends in lots (counted, > 0); a migrated pin is the one exception (B1), counted separately", async () => {
    const NON_SWISS: TableStageKind[] = ["league", "group", "americano"];
    let defaults = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        const cfg = m.configSchema.parse(m.variants[variant]);
        for (const kind of NON_SWISS) {
          const order = m.defaultTiebreakers(kind, cfg);
          expect(order.at(-1), `${m.key}/${variant}/${kind}`).toBe("lots");
          expect(validateCascade(order, { module: m, cfg, stageKind: kind, crossGroup: false }), `${m.key}/${variant}/${kind}`).toEqual([]);
          defaults++;
        }
      }
    }
    // Fix round 1 m8: the exact count, from the registry's own declarations (every sport × its variants × the three kinds),
    // so a sport or a variant the loop skipped is a red — and every sport is in it.
    const variants = (builtinModules as readonly AnySportModule[]).reduce((n, m) => n + Object.keys(m.variants).length, 0);
    expect(variants, "anti-vacuity: every sport declares a variant").toBeGreaterThanOrEqual(builtinModules.length);
    expect(defaults, "anti-vacuity: sport defaults checked, each sport × variant × non-Swiss kind").toBe(variants * NON_SWISS.length);
    // Every write path refuses an order that does not end in lots on a non-Swiss stage: the stage's own (PUT) and the
    // division's (PATCH, an unpinned league inheriting it), per sport.
    let refused = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      const variant = Object.keys(m.variants)[0]!;
      const d = await division({ sport: m.key, variant, config: m.key === "generic" ? GENERIC_CONFIG : {}, entrants: 0 });
      const s = await stage(d, 1, "league", "Pool A");
      const cfg = m.configSchema.parse(await divisionCfg(d.divisionId));
      const noLots = m.defaultTiebreakers("league", cfg).filter((k) => k !== "lots");
      await expect(putStageRules(d.auth, s, { tiebreakers: noLots }), m.key).rejects.toMatchObject({
        code: "TIEBREAK_KEY_INVALID",
        extra: { refusals: expect.arrayContaining([expect.objectContaining({ reason: "last", need: "lots" })]) },
      });
      await expect(patchDivision(d.auth, d.divisionId, { tiebreakers: noLots }), m.key).rejects.toMatchObject({
        code: "TIEBREAK_KEY_INVALID",
        extra: { stage_id: s, refusals: expect.arrayContaining([expect.objectContaining({ reason: "last" })]) },
      });
      refused += 2;
    }
    expect(refused, "anti-vacuity: write paths checked").toBe(builtinModules.length * 2);
    // B1: the migration pinned a stage to the order it ranked by before W2d — badminton's, with no lots — and the loader
    // serves it unvalidated. That is the one exception, counted on its own.
    const d = await division({ sport: "generic", variant: "score", entrants: 2 });
    const s = await stage(d, 1, "league", "Pool A");
    await generateStageFixtures(d.auth, s);
    const legacy = ["points", "diff", "for"];
    await sql`
      update stages set table_rules_pinned = jsonb_set(jsonb_set(table_rules_pinned, '{tiebreakers}', ${sql.json(legacy as never)}),
                                                       '{sources,tiebreakers}', '"migrated"')
       where id = ${s}`;
    const migrated = await loadTableRules(sql, s);
    let exceptions = 0;
    if (migrated.sources.tiebreakers === "migrated" && migrated.tiebreakers.at(-1) !== "lots") exceptions++;
    expect(exceptions, "the migrated pin is served as pinned").toBe(1);
  }, 180_000);
});

// W2d Task 8 carry 2 (spec §5.5 "Write paths"; PS-9f reads stay tolerant): a set-score table is keyed by set score ("W-L")
// or "*". At WRITE time a key that is neither is refused (CONFIG_INVALID, the key in `issues`), and so is a table that prices
// no set score at all; a stray key a row ALREADY holds is tolerated (the read is, and a save that leaves it is not asked
// again). Every sport whose parsed default config carries a `pointsMap` (counted; zero is a failure).
describe.skipIf(!HAS_DB)("W2d T10 (T8 carry) a points table is checked at write time: no stray key, at least one set score", () => {
  it("every pointsMap sport: create and save refuse a stray key and a table with no set score; a stored stray key rides an unrelated save", async () => {
    let sports = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const parsed = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
      const map = parsed.pointsMap as Record<string, [number, number]> | undefined;
      if (map === undefined) continue;
      expect(Object.keys(map).length, `${m.key}: premise, the sport's table prices a set score`).toBeGreaterThan(0);
      const stray = { ...map, note: [1, 1] as [number, number] };
      const { auth } = await seedOrg("pro");
      const suffix = randomUUID().slice(0, 8);
      const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T10s " + suffix, visibility: "private", branding: {} });
      const create = (pointsMap: Record<string, unknown>, n: number) =>
        createDivision(auth, comp.id, { name: `S${n}`, slug: `s${n}-${suffix}`, sport_key: m.key, variant_key: variant, config: { pointsMap } });
      await expect(create(stray, 1), `${m.key}: create, a stray key`).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        data: { issues: [expect.objectContaining({ path: ["pointsMap", "note"] })] },
      });
      await expect(create({}, 2), `${m.key}: create, no set score`).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      const d = await create(map, 3);
      const stored = await divisionCfg(d.id);
      await expect(patchDivision(auth, d.id, { config: { ...stored, pointsMap: stray } }), `${m.key}: save, a stray key`).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        data: { issues: [expect.objectContaining({ path: ["pointsMap", "note"] })] },
      });
      await expect(patchDivision(auth, d.id, { config: { ...stored, pointsMap: {} } }), `${m.key}: save, no set score`).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect((await divisionCfg(d.id)).pointsMap, `${m.key}: a refused save writes nothing`).toEqual(stored.pointsMap);
      // A row that already holds a stray key (written before the check): the read tolerates it and an unrelated save lands.
      await sql`update divisions set config = jsonb_set(config, '{pointsMap,legacy}', '[0, 0]') where id = ${d.id}`;
      const legacyCfg = await divisionCfg(d.id);
      const out = await patchDivision(auth, d.id, { name: `S3 renamed`, config: legacyCfg });
      expect(out.name, `${m.key}: the save beside a stored stray key lands`).toBe("S3 renamed");
      expect((await divisionCfg(d.id)).pointsMap, `${m.key}: and the stray key is left as it was`).toMatchObject({ legacy: [0, 0] });
      // The stored stray key alone, every set score dropped: no stray key is ADDED, yet the table prices no set score.
      await expect(patchDivision(auth, d.id, { config: { ...legacyCfg, pointsMap: { legacy: [0, 0] } } }), `${m.key}: save, only the stored stray key`).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        message: expect.stringContaining("prices no set score"),
      });
      sports++;
    }
    expect(sports, "anti-vacuity: pointsMap sports checked").toBeGreaterThan(0);
    console.info(`[division-tiebreaks-write] T8 carry: ${sports} pointsMap sports checked`);
  }, 180_000);
});
