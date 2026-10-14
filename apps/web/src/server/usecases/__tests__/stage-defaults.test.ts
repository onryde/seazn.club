// W2c Task 12 (spec items 5, 6; §4.2; D3, D13; SC-P8; P7; Review Focus 4 and 5; X-SR-6, CK-SO-1, IH-KO-1, FB-SO-1) — a
// NEW stage is written with its sport's preset (`stageDefaults`), the create takes `config.rules` on the stage PUT's
// terms, and the preset reaches the real fold through the real resolver (§8 seam: create → generate → appendEvent →
// `loadFoldInputs`).
//
// Expected values come from the engine's own declarations (`stageDefaultsFor`, `deciderKeysFor`, `stageTopKeysFor`,
// the sports' variants and schemas), never from the code under test. Every case where it matters has one where the
// right answer differs from a default's constant: football youth plays a 3-kick shoot-out (11-a-side: 5), and an
// ice-hockey knockout's overtime is 10 minutes where its IIHF division says 5. Real Postgres; skipped without
// DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DRAW_KINDS, StageKind } from "@seazn/engine/core";
import { deciderKeysFor, SHARE_NEEDS_DRAWS, sportTopKeys, stageDefaultsFor, stageTopKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { CreateStage } from "@/server/api-v1/schemas";
import { appendEvent, type AppendResult } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";

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
const football = mod("football");

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Sd " + suffix}, ${"sd-" + suffix}) returning id`;
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** `entrantCount: 0` for a division that needs no fixture. Entrants take the kind the sport DECLARES as its default. */
async function seedDivision(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  entrantCount = 2,
  config: Record<string, unknown> = {},
): Promise<{ divisionId: string; entrants: string[] }> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Sd Cup " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
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

/** A swiss stage must declare its round count (assertSwissRoundsDeclared); every other kind takes the config given. */
const configFor = (kind: StageKind, config: Record<string, unknown> = {}) => (kind === "swiss" ? { rounds: 3, ...config } : config);

const stageConfig = async (stageId: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${stageId}`)[0]!.config;
const stageCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stages where division_id = ${divisionId}`)[0]!.n;

/** One stage of `kind`, generated, and its one seated fixture (two entrants: a final, or a one-match table). */
async function seatedFixture(auth: AuthCtx, divisionId: string, seq: number, kind: StageKind, rules?: Record<string, unknown>) {
  const [st] = await createStages(auth, divisionId, {
    seq, kind, name: `${kind} ${seq}`, config: configFor(kind, rules === undefined ? {} : { rules }), progression: null,
  });
  await generateStageFixtures(auth, st!.id);
  const [f] = await sql<{ id: string; home: string; away: string }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures
     where stage_id = ${st!.id} and home_entrant_id is not null and away_entrant_id is not null order by fixture_no limit 1`;
  if (f === undefined) throw new Error(`${kind}: no seated fixture`);
  return { stageId: st!.id, ...f };
}

/** Appends `events` in order from seq 0 through the real write path; the last append's answer. */
async function play(auth: AuthCtx, fixtureId: string, events: readonly { type: string; payload: unknown }[]): Promise<AppendResult> {
  let last: AppendResult | undefined;
  for (const [seq, e] of events.entries()) last = await appendEvent(auth.orgId, fixtureId, seq, e);
  return last!;
}
const resolvedCfg = async (auth: AuthCtx, fixtureId: string) =>
  (await withTenant(auth.orgId, (tx) => loadFoldInputs(tx, fixtureId)))!.cfg as Record<string, unknown>;

const start = { type: "core.start", payload: {} };
const whistle = (phase: string) => ({ type: "football.period", payload: { phase } });
const kick = (by: string, scored: boolean) => ({ type: "football.shootout.kick", payload: { by, scored } });
/** Football to a LEVEL full time: kick-off, half time, full time, no goal. */
const levelAtFullTime = [start, whistle("HT"), whistle("FT")];

describe.skipIf(!HAS_DB)("X-SR-6 P7 a new stage stores its sport's preset", () => {
  it("X-SR-6 P7 a new stage stores its sport's preset: every sport x every variant x every kind (counted; a table kind stores none)", async () => {
    let checked = 0;
    let withPreset = 0;
    let tableKinds = 0;
    const presetSports = new Set<string>();
    for (const m of builtinModules as readonly AnySportModule[]) {
      const auth = await seedOrg();
      for (const variant of Object.keys(m.variants)) {
        const { divisionId } = await seedDivision(auth, m.key, variant, 0);
        for (const kind of StageKind.options) {
          // One stage at a time (the stages-per-division cap), each removed once read: every kind meets a clean division.
          const [st] = await createStages(auth, divisionId, { seq: 1, kind, name: kind, config: configFor(kind), progression: null });
          const expected = stageDefaultsFor(m, kind, variant);
          const cfg = await stageConfig(st!.id);
          if (DRAW_KINDS.has(kind)) {
            // The premise, from the engine: a table stage starts with no decider.
            expect(expected, `${m.key}/${variant}/${kind}: the engine presets a table kind`).toEqual({});
            tableKinds++;
          }
          if (Object.keys(expected).length === 0) {
            expect(Object.hasOwn(cfg, "rules"), `${m.key}/${variant}/${kind}: no preset, no rules key`).toBe(false);
          } else {
            expect(cfg.rules, `${m.key}/${variant}/${kind}`).toEqual(expected);
            withPreset++;
            presetSports.add(m.key);
          }
          checked++;
          await sql`delete from stages where id = ${st!.id}`;
        }
      }
    }
    const variants = builtinModules.reduce((n, m) => n + Object.keys(m.variants).length, 0);
    expect(checked, `${checked} (sport, variant, kind) stages created`).toBe(variants * StageKind.options.length);
    expect(tableKinds, "every table kind was asked").toBe(variants * DRAW_KINDS.size);
    // Anti-vacuity, from the engine: the (sport, variant, kind) triples it presets, and the sports that declare a preset.
    const engineTriples = (builtinModules as readonly AnySportModule[]).reduce(
      (n, m) => n + Object.keys(m.variants).reduce((k, v) => k + StageKind.options.filter((kind) => Object.keys(stageDefaultsFor(m, kind, v)).length > 0).length, 0),
      0,
    );
    expect(engineTriples, "the engine presets some bracket stage").toBeGreaterThan(0);
    expect(withPreset, `${withPreset} stages stored a preset`).toBe(engineTriples);
    expect([...presetSports].sort(), "the sports that declare a preset").toEqual(
      builtinModules.filter((m) => m.stageDefaults !== undefined).map((m) => m.key).sort(),
    );
  }, 600_000);

  it("a second create on the same division: the league stores none, each bracket stage its own preset (football youth: 3 kicks)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth", 0);
    const youth = stageDefaultsFor(football, "knockout", "youth");
    // The right answer differs from the senior constant: a youth shoot-out is 3 kicks each (FB-SO-1).
    expect(youth.shootoutAttempts, "the premise: youth kicks differ from 11-a-side's").not.toEqual(stageDefaultsFor(football, "knockout", "11-a-side").shootoutAttempts);
    const [league] = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: {}, progression: null });
    const [ko] = await createStages(auth, divisionId, { seq: 2, kind: "knockout", name: "KO", config: {}, progression: null });
    const [de] = await createStages(auth, divisionId, { seq: 3, kind: "double_elim", name: "DE", config: {}, progression: null });
    expect(Object.hasOwn(await stageConfig(league!.id), "rules")).toBe(false);
    expect((await stageConfig(ko!.id)).rules).toEqual(youth);
    expect((await stageConfig(de!.id)).rules).toEqual(stageDefaultsFor(football, "double_elim", "youth"));
    expect((await stageConfig(league!.id)).rules, "the first stage is untouched by the later creates").toBeUndefined();
  });

  it("provided rules win over the preset, key by key; a null removes a preset key; the response is what is stored (SC-P8)", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth", 0);
    const preset = stageDefaultsFor(football, "knockout", "youth");
    expect(preset.shootout, "the premise: the preset turns the shoot-out on").toBe(true);
    const [off] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: { rules: { shootout: false } }, progression: null });
    expect((await stageConfig(off!.id)).rules).toEqual({ ...preset, shootout: false });
    expect(off!.config.rules, "the created row returned is the row stored").toEqual({ ...preset, shootout: false });
    const [inherit] = await createStages(auth, divisionId, { seq: 2, kind: "knockout", name: "KO2", config: { rules: { shootoutAttempts: null } }, progression: null });
    const rest = Object.fromEntries(Object.entries(preset).filter(([k]) => k !== "shootoutAttempts"));
    expect((await stageConfig(inherit!.id)).rules, "a null is 'inherit the division': the preset key is gone").toEqual(rest);
    const [empty] = await createStages(auth, divisionId, { seq: 3, kind: "knockout", name: "KO3", config: { rules: {} }, progression: null });
    expect((await stageConfig(empty!.id)).rules, "{} keeps the preset whole: a create has nothing stored to clear").toEqual(preset);
  });

  it("refusals at create write NOTHING, the whole batch: an undeclared key, a key this kind cannot set, a value the sport refuses", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const notForKnockout = [...sportTopKeys(football)].find((k) => !stageTopKeysFor(football, "knockout", "11-a-side").has(k));
    expect(notForKnockout, "the premise: football declares a key a knockout stage cannot set").toBeDefined();
    const league = { seq: 1, kind: "league" as const, name: "L", config: {}, progression: null };
    const ko = (rules: Record<string, unknown>) => ({ seq: 2, kind: "knockout" as const, name: "KO", config: { rules }, progression: null });
    let checked = 0;
    for (const [why, rules, match] of [
      ["undeclared", { bogus: 1 }, { status: 400, code: "UNKNOWN_RULE_KEY" }],
      ["not for this kind", { [notForKnockout!]: null }, { status: 400, code: "RULE_NOT_SETTABLE", extra: { field: notForKnockout } }],
      ["a value the sport refuses", { shootoutAttempts: "five" }, { code: "CONFIG_INVALID" }],
    ] as const) {
      await expect(createStages(auth, divisionId, [league, ko(rules)]), why).rejects.toMatchObject(match);
      expect(await stageCount(divisionId), `${why}: nothing created, not even the valid league before it`).toBe(0);
      checked++;
    }
    expect(checked).toBe(3);
    // The positive pair: the same batch with valid rules lands whole.
    await expect(createStages(auth, divisionId, [league, ko({ shootout: false })])).resolves.toHaveLength(2);
  });

  it("P-5 share needs draws: createStages refuses share on a division that forbids draws, nothing created; with draws allowed it lands", async () => {
    const generic = mod("generic");
    const variant = Object.keys(generic.variants).find((v) => (generic.configSchema.parse(generic.variants[v]) as { allowDraws: boolean }).allowDraws === false);
    expect(variant, "the premise: a generic variant forbids draws").toBeDefined();
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "generic", variant!, 0);
    const err = await createStages(auth, divisionId, { seq: 1, kind: "league", name: "L", config: { rules: { abandonPolicy: "share" } }, progression: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify((err as { data?: unknown }).data), "the engine's own reason rides the refusal").toContain(SHARE_NEEDS_DRAWS);
    expect(await stageCount(divisionId)).toBe(0);
    const { divisionId: drawing } = await seedDivision(auth, "generic", variant!, 0, { allowDraws: true });
    const [st] = await createStages(auth, drawing, { seq: 1, kind: "league", name: "L", config: { rules: { abandonPolicy: "share" } }, progression: null });
    expect((await stageConfig(st!.id)).rules).toEqual({ abandonPolicy: "share" });
  });
});

describe("the API takes config.rules and refuses a top-level stage decider (greenfield: no shim)", () => {
  it("CreateStage refuses top-level shootout / extraTime, naming config.rules; rules ride through", () => {
    let checked = 0;
    for (const key of ["shootout", "extraTime"]) {
      const r = CreateStage.safeParse({ seq: 1, kind: "knockout", name: "KO", config: { [key]: true }, progression: null });
      expect(r.success, key).toBe(false);
      expect(JSON.stringify(r.error?.issues), `${key}: the refusal says where it went`).toContain("config.rules");
      checked++;
    }
    expect(checked).toBe(2);
    const ok = CreateStage.safeParse({ seq: 1, kind: "knockout", name: "KO", config: { rules: { shootout: false } }, progression: null });
    expect(ok.success).toBe(true);
    expect(ok.data?.config.rules).toEqual({ shootout: false });
  });
});

describe.skipIf(!HAS_DB)("§8 seam: the preset reaches the real fold through the real resolver", () => {
  it("X-SR-6 a level football knockout at full time goes to extra time (the preset), never held", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 2);
    const division = football.configSchema.parse(football.variants["11-a-side"]) as { extraTime: { enabled: boolean } };
    expect(division.extraTime.enabled, "the premise: the division plays no extra time of its own").toBe(false);
    const f = await seatedFixture(auth, divisionId, 1, "knockout");
    const ft = await play(auth, f.id, levelAtFullTime);
    expect(ft.status).toBe("in_play");
    expect((ft.state as { phase: string }).phase).toBe("ET_H1");
    const cfg = await resolvedCfg(auth, f.id);
    const preset = stageDefaultsFor(football, "knockout", "11-a-side");
    expect({ extraTime: cfg.extraTime, shootout: cfg.shootout, shootoutAttempts: cfg.shootoutAttempts }).toEqual(preset);
  });

  it("FB-SO-1 the shoot-out is the match-scoped shootoutAttempts: youth decides after 3 kicks each, 11-a-side plays on (5)", async () => {
    const auth = await seedOrg();
    let checked = 0;
    for (const [variant, decided] of [["youth", true], ["11-a-side", false]] as const) {
      const attempts = stageDefaultsFor(football, "knockout", variant).shootoutAttempts as number;
      const { divisionId } = await seedDivision(auth, "football", variant, 2);
      const f = await seatedFixture(auth, divisionId, 1, "knockout");
      await play(auth, f.id, [...levelAtFullTime, whistle("ET_HT"), whistle("ET_FT")]);
      expect((await resolvedCfg(auth, f.id)).shootoutAttempts, variant).toBe(attempts);
      // Home scores two, away misses two: away is 2 behind with `attempts - 2` kicks left — out of reach with 3 kicks
      // each (one left), still alive with 5 (three left).
      const kicks = [kick(f.home, true), kick(f.away, false), kick(f.home, true), kick(f.away, false)];
      let last: AppendResult | undefined;
      for (const [i, k] of kicks.entries()) last = await appendEvent(auth.orgId, f.id, 5 + i, k);
      if (decided) {
        expect(last!.status, `${variant}: decided on the shoot-out`).toBe("decided");
        expect(last!.outcome).toMatchObject({ kind: "win", winner: f.home, method: "shootout" });
      } else {
        expect(last!.status, `${variant}: the shoot-out goes on`).toBe("in_play");
        expect(last!.outcome).toBeNull();
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("X-SR-6 Review Focus 4: with every decider off, a level knockout is HELD for the organiser (needs_decision), then settled", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 2);
    // "Off" is the value the division's own variant gives each decider the engine declares (never a typed literal).
    const division = football.configSchema.parse(football.variants["11-a-side"]) as Record<string, unknown>;
    const deciders = deciderKeysFor(football, "knockout", "11-a-side");
    expect(deciders.length, "the premise: football declares deciders").toBeGreaterThan(0);
    const off = Object.fromEntries(deciders.map((k) => [k, division[k]]));
    for (const k of deciders) expect(off[k], `the premise: the preset turns ${k} on`).not.toEqual(stageDefaultsFor(football, "knockout", "11-a-side")[k]);
    const f = await seatedFixture(auth, divisionId, 1, "knockout", off);
    const ft = await play(auth, f.id, levelAtFullTime);
    expect(ft.status, "held, never refused").toBe("needs_decision");
    const settled = await appendEvent(auth.orgId, f.id, 3, { type: "core.settle", payload: { winner: f.home, method: "organiser" } });
    expect(settled.outcome).toMatchObject({ kind: "win", winner: f.home });
    expect(settled.status).toBe("decided");
  });

  it("IH-KO-1 an ice-hockey knockout starts with overtime and a shootout: level after regulation goes to overtime; the league sibling draws", async () => {
    const ice = mod("icehockey");
    const auth = await seedOrg();
    let checked = 0;
    for (const variant of Object.keys(ice.variants)) {
      const division = ice.configSchema.parse(ice.variants[variant]) as { overtime: unknown };
      const preset = stageDefaultsFor(ice, "knockout", variant);
      expect(Object.keys(preset).sort(), `${variant}: the preset is overtime and the shootout`).toEqual(["overtime", "shootout"]);
      const { divisionId } = await seedDivision(auth, "icehockey", variant, 2);
      const ko = await seatedFixture(auth, divisionId, 1, "knockout");
      const regulation = [start, ...["P2", "P3", "FT"].map((to) => ({ type: "icehockey.period.advance", payload: { to } }))];
      const atFt = await play(auth, ko.id, regulation);
      expect((atFt.state as { phase: string }).phase, `${variant}: overtime is played`).toBe("OT");
      expect(atFt.status).toBe("in_play");
      const cfg = await resolvedCfg(auth, ko.id);
      expect({ overtime: cfg.overtime, shootout: cfg.shootout }, `${variant}: the stage's preset, not the division's`).toEqual(preset);
      // The right answer differs from the division's own: recreational plays no overtime at all, IIHF a 5-minute one.
      expect(preset.overtime, `${variant}: the knockout preset differs from the division`).not.toEqual(division.overtime);
      checked++;
    }
    expect(checked, "every ice-hockey variant").toBe(Object.keys(ice.variants).length);
    // The table sibling, recreational (no overtime, no shootout in the division): a level regulation is a draw.
    const { divisionId } = await seedDivision(auth, "icehockey", "recreational", 2);
    const league = await seatedFixture(auth, divisionId, 1, "league");
    const drawn = await play(auth, league.id, [start, ...["P2", "P3", "FT"].map((to) => ({ type: "icehockey.period.advance", payload: { to } }))]);
    expect(drawn.outcome).toEqual({ kind: "draw" });
  });

  it("CK-SO-1 the super over is a knockout default the organiser can switch off; switched on in a league stage it is played on a tie", async () => {
    const cricket = mod("cricket");
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "cricket", "t20", 4);
    expect((cricket.configSchema.parse(cricket.variants.t20) as { superOver: boolean }).superOver, "the premise: a t20 division plays no super over").toBe(false);
    // The knockout default, and the organiser switching it off at create.
    const [ko] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    expect((await stageConfig(ko!.id)).rules).toEqual(stageDefaultsFor(cricket, "knockout", "t20"));
    expect((await stageConfig(ko!.id)).rules, "the premise: the knockout preset is the super over").toEqual({ superOver: true });
    const [koOff] = await createStages(auth, divisionId, { seq: 2, kind: "knockout", name: "KO off", config: { rules: { superOver: false } }, progression: null });
    expect((await stageConfig(koOff!.id)).rules).toEqual({ superOver: false });
    await sql`delete from stages where id in ${sql([ko!.id, koOff!.id])}`;
    // A tied T20 (equal totals off the full quota), folded through the real write path.
    const tied = [
      start,
      { type: "cricket.innings.summary", payload: { runs: 150, wickets: 5, legalBalls: 120 } },
      { type: "cricket.innings.summary", payload: { runs: 150, wickets: 7, legalBalls: 120 } },
    ];
    const on = await seatedFixture(auth, divisionId, 1, "league", { superOver: true });
    const onTie = await play(auth, on.id, tied);
    expect((onTie.state as { phase: string }).phase, "switched on in a league stage: the super over is owed").toBe("super_over");
    expect(onTie.outcome).toBeNull();
    expect((await resolvedCfg(auth, on.id)).superOver).toBe(true);
    const plain = await seatedFixture(auth, divisionId, 2, "league");
    expect((await stageConfig(plain.stageId)).rules, "a league stage starts without it").toBeUndefined();
    expect((await play(auth, plain.id, tied)).outcome, "the positive pair: off, the tie stands").toEqual({ kind: "tie" });
  });
});

describe.skipIf(!HAS_DB)("Review Focus 5: replaceStages carries the organiser's edits over the preset", () => {
  it("a slot whose seq:kind matched keeps its edits over the preset; a changed kind starts from its own preset; the body wins", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth", 0);
    const preset = stageDefaultsFor(football, "knockout", "youth");
    await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "L", config: {}, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: { rules: { shootout: false } }, progression: null },
    ]);
    const after = await replaceStages(auth, divisionId, [
      { seq: 1, kind: "knockout", name: "L to KO", config: {}, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: null },
    ]);
    const bySeq = new Map(await Promise.all(after.map(async (s) => [s.seq, (await stageConfig(s.id)).rules] as const)));
    expect(bySeq.get(2), "matched slot: the edit over the preset").toEqual({ ...preset, shootout: false });
    expect(bySeq.get(1), "changed kind: its own preset, nothing carried").toEqual(preset);
    expect(new Map(after.map((s) => [s.seq, s.config.rules])), "the rows returned are the rows stored").toEqual(bySeq);

    // A second Apply: the carried edit survives again, and a body rule wins over the carried one, key by key.
    const again = await replaceStages(auth, divisionId, [
      { seq: 1, kind: "knockout", name: "KO1", config: { rules: { shootoutAttempts: 4 } }, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: { rules: { shootout: true } }, progression: null },
      { seq: 3, kind: "league", name: "Plate", config: {}, progression: null },
    ]);
    const bySeq2 = new Map(await Promise.all(again.map(async (s) => [s.seq, (await stageConfig(s.id)).rules] as const)));
    expect(bySeq2.get(1)).toEqual({ ...preset, shootoutAttempts: 4 });
    expect(bySeq2.get(2), "the body's shootout beats the carried false").toEqual(preset);
    expect(bySeq2.get(3), "a new table slot carries nothing").toBeUndefined();
  });

  it("refuses an invalid rules body BEFORE the delete: the existing graph stands", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const created = await createStages(auth, divisionId, [
      { seq: 1, kind: "league", name: "L", config: {}, progression: null },
      { seq: 2, kind: "knockout", name: "KO", config: {}, progression: null },
    ]);
    let checked = 0;
    for (const [why, rules, code] of [
      ["undeclared", { bogus: 1 }, "UNKNOWN_RULE_KEY"],
      ["refused by the sport", { shootoutAttempts: "five" }, "CONFIG_INVALID"],
    ] as const) {
      await expect(
        replaceStages(auth, divisionId, [{ seq: 1, kind: "knockout", name: "KO", config: { rules }, progression: null }]),
        why,
      ).rejects.toMatchObject({ code });
      const ids = (await sql<{ id: string }[]>`select id from stages where division_id = ${divisionId} order by seq`).map((r) => r.id);
      expect(ids, `${why}: both stages survive`).toEqual(created.map((s) => s.id));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("empty case: replacing a division with no stages yet writes the presets", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "11-a-side", 0);
    const [st] = await replaceStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    expect((await stageConfig(st!.id)).rules).toEqual(stageDefaultsFor(football, "knockout", "11-a-side"));
  });
});
