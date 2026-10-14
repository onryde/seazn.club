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
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, replaceStages } from "../stages";
import { putStageRules } from "../stage-rules";
import { decidersOffRules } from "../../../../e2e/stage-deciders";

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

// Fix round 1, R-T12-1 (owner Q7: knockout deciders are "preselected, can be turned off") — a period sport's overtime
// and shoot-out are OFF in the engine as `null`, and a stage's `null` already means INHERIT (key absence). So a stage
// switches one off with an explicit `false`, and the one resolver reads it as the engine's `null`.
/** The knockout deciders whose engine OFF is null, read from the engine's own schema for the variant: the key takes null
 *  and refuses false. The test's own probe, held against the ruling's list below, never the product's predicate. */
const nullOffDeciders = (m: AnySportModule, variant: string): string[] => {
  const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
  return deciderKeysFor(m, "knockout", variant).filter(
    (k) => m.configSchema.safeParse({ ...division, [k]: null }).success && !m.configSchema.safeParse({ ...division, [k]: false }).success,
  );
};
/** The ruling's own list (R-T12-1): ice hockey's overtime and shoot-out, hockey's shoot-out. */
const RULING_OFF_BY_FALSE: Record<string, readonly string[]> = { icehockey: ["overtime", "shootout"], hockey: ["shootout"] };
/** Regulation after the opening whistle, to full time — the period kernel's labels for 3 periods and for 4 quarters. */
const REGULATION: Record<string, readonly string[]> = { icehockey: ["P2", "P3", "FT"], hockey: ["Q2", "Q3", "Q4", "FT"] };
const regulation = (sport: string) => [start, ...REGULATION[sport]!.map((to) => ({ type: `${sport}.period.advance`, payload: { to } }))];
const settleHome = (home: string) => ({ type: "core.settle", payload: { winner: home, method: "organiser" } });

describe.skipIf(!HAS_DB)("R-T12-1 X-SR-6: a period knockout's deciders switched off with `false`, through the real fold", () => {
  it("X-SR-6 IH-KO-1 every decider off: a level period knockout is HELD (needs_decision), then settled; its preset sibling plays on — every ice-hockey and hockey variant (counted)", async () => {
    const auth = await seedOrg();
    const found: Record<string, readonly string[]> = {};
    let checked = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      for (const variant of Object.keys(m.variants)) {
        const keys = nullOffDeciders(m, variant);
        if (keys.length === 0) continue;
        found[m.key] = keys;
        const periods = (m.configSchema.parse(m.variants[variant]) as { periods: { count: number } }).periods.count;
        expect(REGULATION[m.key]!.length - 1, `${m.key}/${variant}: the premise: regulation advances through every period`).toBe(periods - 1);
        const { divisionId } = await seedDivision(auth, m.key, variant, 2);
        // The e2e rigs' own helper builds the "every decider off" rules, so this proves what they send.
        const off = decidersOffRules(m.key, variant);
        expect(off, `${m.key}/${variant}: every knockout decider, false`).toEqual(Object.fromEntries(deciderKeysFor(m, "knockout", variant).map((k) => [k, false])));
        const ko = await seatedFixture(auth, divisionId, 1, "knockout", off);
        expect((await stageConfig(ko.stageId)).rules, `${m.key}/${variant}: stored as sent, false`).toEqual(off);
        const atFt = await play(auth, ko.id, regulation(m.key));
        expect(atFt.status, `${m.key}/${variant}: held for the organiser, never refused`).toBe("needs_decision");
        const cfg = await resolvedCfg(auth, ko.id);
        for (const k of keys) expect(cfg[k], `${m.key}/${variant}: the engine reads ${k} OFF (null)`).toBeNull();
        const settled = await appendEvent(auth.orgId, ko.id, REGULATION[m.key]!.length + 1, settleHome(ko.home));
        expect(settled.status, `${m.key}/${variant}: settled`).toBe("decided");
        expect(settled.outcome).toMatchObject({ kind: "win", winner: ko.home });
        // The positive pair: the preset stage (the deciders ON) plays on from the same level score.
        const on = await seatedFixture(auth, divisionId, 2, "knockout");
        const onFt = await play(auth, on.id, regulation(m.key));
        expect(onFt.status, `${m.key}/${variant}: the preset sibling plays its decider`).toBe("in_play");
        checked++;
      }
    }
    expect(found, "exactly the ruling's keys take `false` as off").toEqual(RULING_OFF_BY_FALSE);
    expect(checked, "every ice-hockey and hockey variant").toBe(Object.keys(mod("icehockey").variants).length + Object.keys(mod("hockey").variants).length);
  });

  it("X-SR-6 `false` is OFF, `null` INHERITS: an iihf knockout that inherits plays the division's overtime, its `false` sibling is held; hockey fih-shootout the same with the shoot-out", async () => {
    const auth = await seedOrg();
    let checked = 0;
    for (const [sport, variant, phase] of [["icehockey", "iihf", "OT"], ["hockey", "fih-shootout", "SHOOTOUT"]] as const) {
      const m = mod(sport);
      const division = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
      const keys = RULING_OFF_BY_FALSE[sport]!;
      for (const k of keys) expect(division[k], `${sport}/${variant}: the premise: the division plays its own ${k}`).not.toBeNull();
      const { divisionId } = await seedDivision(auth, sport, variant, 2);
      const inherit = await seatedFixture(auth, divisionId, 1, "knockout", Object.fromEntries(keys.map((k) => [k, null])));
      expect((await stageConfig(inherit.stageId)).rules, `${sport}: null removes the preset key, nothing stored`).toBeUndefined();
      const inFt = await play(auth, inherit.id, regulation(sport));
      expect(inFt.status, `${sport}: inheriting, the division's decider is played`).toBe("in_play");
      expect((inFt.state as { phase: string }).phase).toBe(phase);
      const cfg = await resolvedCfg(auth, inherit.id);
      for (const k of keys) expect(cfg[k], `${sport}: the division's own ${k}`).toEqual(division[k]);
      const off = await seatedFixture(auth, divisionId, 2, "knockout", Object.fromEntries(keys.map((k) => [k, false])));
      expect((await play(auth, off.id, regulation(sport))).status, `${sport}: false, held`).toBe("needs_decision");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("`false` is taken only where the engine reads it as off or as itself: refused by name elsewhere (cap, periods; hockey has no overtime), nothing written", async () => {
    const auth = await seedOrg();
    let checked = 0;
    for (const [sport, variant, kind, rules, match] of [
      ["badminton", "bwf", "knockout", { cap: false }, { code: "CONFIG_INVALID" }],
      ["icehockey", "iihf", "knockout", { periods: false }, { code: "CONFIG_INVALID" }],
      // FIH hockey declares no overtime at all (the period kernel's keys, narrowed): unknown, before any value is read.
      ["hockey", "fih-shootout", "knockout", { overtime: false }, { status: 400, code: "UNKNOWN_RULE_KEY" }],
    ] as const) {
      const { divisionId } = await seedDivision(auth, sport, variant, 0);
      const err = await createStages(auth, divisionId, { seq: 1, kind, name: "KO", config: { rules }, progression: null }).catch((e: unknown) => e);
      expect(err, `${sport} ${JSON.stringify(rules)}`).toMatchObject(match);
      if (match.code === "CONFIG_INVALID") {
        const paths = ((err as { data?: { issues?: { path: PropertyKey[] }[] } }).data?.issues ?? []).map((i) => i.path[0]);
        expect(paths, `${sport}: the engine names the key`).toContain(Object.keys(rules)[0]);
      }
      expect(await stageCount(divisionId), `${sport}: nothing created`).toBe(0);
      checked++;
    }
    expect(checked).toBe(3);
    // The positive pairs: where `false` IS the engine's value (football's shoot-out, the t20 super over) it is stored and
    // read as false, never mapped to null.
    for (const [sport, variant, key] of [["football", "11-a-side", "shootout"], ["cricket", "t20", "superOver"]] as const) {
      const { divisionId } = await seedDivision(auth, sport, variant, 2);
      const f = await seatedFixture(auth, divisionId, 1, "knockout", { [key]: false });
      expect((await stageConfig(f.stageId)).rules).toMatchObject({ [key]: false });
      await play(auth, f.id, [start]); // the fold inputs exist from the first event
      expect((await resolvedCfg(auth, f.id))[key], `${sport}: the engine's own false`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("sequence: the stage PUT switches a preset decider off with `false` and back on with null; a division save over a `false` stage lands and keeps it", async () => {
    const auth = await seedOrg();
    const ice = mod("icehockey");
    const { divisionId } = await seedDivision(auth, "icehockey", "iihf", 2);
    const [st] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    const preset = stageDefaultsFor(ice, "knockout", "iihf");
    await expect(putStageRules(auth, st!.id, { rules: { shootout: false } })).resolves.toEqual({ rules: { ...preset, shootout: false } });
    await expect(putStageRules(auth, st!.id, { rules: { overtime: false } })).resolves.toEqual({ rules: { overtime: false, shootout: false } });
    await expect(putStageRules(auth, st!.id, { rules: { periods: false } })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // A division format save re-asks every stage's rules through the merged parse: `false` is read as off there too.
    const division = ice.configSchema.parse(ice.variants.iihf) as { periods: { count: number; minutes: number } };
    await expect(patchDivision(auth, divisionId, { config: { periods: { ...division.periods, minutes: division.periods.minutes + 1 } } })).resolves.toBeDefined();
    expect((await stageConfig(st!.id)).rules, "the division save keeps the stage's off").toEqual({ overtime: false, shootout: false });
    // Back on: null removes the key, and the stage inherits the division's overtime.
    await expect(putStageRules(auth, st!.id, { rules: { overtime: null } })).resolves.toEqual({ rules: { shootout: false } });
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

// Fix round 2, R-T12-4 (review I-1): `replaceStages` never re-seeds a key the organiser removed or cleared on a MATCHED
// slot (seq and kind unchanged) — R-T12-2's meaning: an organiser's removal is kept. A matched slot's stored rules ARE
// its rules: no stored rules, or a preset key absent from them, is the organiser's clear. A genuinely new slot still
// starts from its preset. Through the REAL replaceStages, every sport x variant whose knockout has a preset (counted).
describe.skipIf(!HAS_DB)("R-T12-4 replaceStages keeps an organiser's cleared preset key on a matched slot", () => {
  it("R-T12-4 X-SR-6 a preset key PUT to null, and a stage PUT to `{}` (Same as division), stay cleared across replaceStages; a new slot gets the preset; a second replace changes nothing — every preset sport and variant (counted)", async () => {
    const presetSports = new Set<string>();
    const covered = new Set<string>();
    let variants = 0;
    for (const m of builtinModules as readonly AnySportModule[]) {
      const withPreset = Object.keys(m.variants).filter((v) => Object.keys(stageDefaultsFor(m, "knockout", v)).length > 0);
      if (withPreset.length === 0) continue;
      presetSports.add(m.key);
      const auth = await seedOrg();
      for (const variant of withPreset) {
        const where = `${m.key}/${variant}`;
        const preset = stageDefaultsFor(m, "knockout", variant);
        const [cleared] = Object.keys(preset) as [string];
        const { divisionId } = await seedDivision(auth, m.key, variant, 0);
        const [ko] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
        expect((await stageConfig(ko!.id)).rules, `${where}: the premise, the preset is stored`).toEqual(preset);
        // (a) The organiser removes one preset key: the stage inherits the division's value there.
        await putStageRules(auth, ko!.id, { rules: { [cleared]: null } });
        const removed = (await stageConfig(ko!.id)).rules as Record<string, unknown> | undefined;
        expect(Object.hasOwn(removed ?? {}, cleared), `${where}: the premise, ${cleared} removed`).toBe(false);
        // The same slot re-applied, plus a genuinely new knockout slot.
        const body = [
          { seq: 1, kind: "knockout" as const, name: "KO", config: {}, progression: null },
          { seq: 2, kind: "knockout" as const, name: "KO 2", config: {}, progression: null },
        ];
        const first = await replaceStages(auth, divisionId, body);
        const bySeq = new Map(first.map((s) => [s.seq, s] as const));
        const kept = (await stageConfig(bySeq.get(1)!.id)).rules as Record<string, unknown> | undefined;
        expect(Object.hasOwn(kept ?? {}, cleared), `${where}: ${cleared} is NOT re-seeded on the matched slot`).toBe(false);
        expect(kept, `${where}: the matched slot's rules are what the organiser left`).toEqual(removed);
        // The positive pair: the new slot starts from its preset.
        expect((await stageConfig(bySeq.get(2)!.id)).rules, `${where}: a new slot gets the preset`).toEqual(preset);
        // (b) The organiser sets the new slot to "Same as division": no rules at all, and a replace keeps it so.
        await putStageRules(auth, bySeq.get(2)!.id, { rules: {} });
        expect(Object.hasOwn(await stageConfig(bySeq.get(2)!.id), "rules"), `${where}: the premise, Same as division`).toBe(false);
        const second = await replaceStages(auth, divisionId, body);
        const rulesOf = async (rows: readonly { seq: number; id: string }[]) =>
          new Map(await Promise.all(rows.map(async (s) => [s.seq, (await stageConfig(s.id)).rules] as const)));
        const afterSecond = await rulesOf(second);
        expect(afterSecond.get(2), `${where}: Same as division survives the replace (no preset restored)`).toBeUndefined();
        expect(afterSecond.get(1), `${where}: the cleared key stays cleared`).toEqual(removed);
        // (d) A further replace with nothing changed changes nothing.
        expect(await rulesOf(await replaceStages(auth, divisionId, body)), `${where}: idempotent`).toEqual(afterSecond);
        await sql`delete from stages where division_id = ${divisionId}`;
        covered.add(m.key);
        variants++;
      }
    }
    expect(variants, "anti-vacuity: knockout presets swept").toBeGreaterThan(0);
    expect([...covered].sort(), "every sport with a knockout preset was driven").toEqual([...presetSports].sort());
    expect(presetSports.size, "anti-vacuity: the engine presets some sport's knockout").toBeGreaterThan(0);
  }, 300_000);

  it("R-T12-4 a cleared key on a matched slot is kept while a body rule still lands over it, key by key", async () => {
    const auth = await seedOrg();
    const { divisionId } = await seedDivision(auth, "football", "youth", 0); // single-sport: the body-over-carry merge is sport-blind
    const preset = stageDefaultsFor(football, "knockout", "youth") as Record<string, unknown>;
    const [cleared] = Object.keys(preset) as [string];
    expect(preset.shootoutAttempts, "the premise: the body's 4 differs from the preset's").not.toBe(4);
    const [ko] = await createStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
    await putStageRules(auth, ko!.id, { rules: { [cleared]: null } });
    const [after] = await replaceStages(auth, divisionId, { seq: 1, kind: "knockout", name: "KO", config: { rules: { shootoutAttempts: 4 } }, progression: null });
    const { [cleared]: _gone, ...rest } = preset;
    expect((await stageConfig(after!.id)).rules, `${cleared} stays cleared; the body's key lands`).toEqual({ ...rest, shootoutAttempts: 4 });
  });
});
