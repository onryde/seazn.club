// W2c Task 14 — X-SR-2, X-SR-5, P5: the ONE writer of `fixtures.rules_override` (`writeFixtureRulesOverride`) and the
// live correction (owner Q11). Expected verdicts come from the signed rows — X-SR-2 "a match may switch a decider off or
// shorten it, never on or longer; any other match key is a format key"; X-SR-5 "a started, unfinished match's format may
// be corrected only if the recorded play fits it"; owner P-1 (only a correction or a staff re-freeze bumps
// `rules_version`) and P-4 (a correction that would END the match is refused) — and from the engine's own declarations
// (`ruleKeys`, `configSchema`, `variants`) and folds, never from the writer.
//
// Real Postgres (`describe.skipIf(!HAS_DB)`); every case seeds its own division through the usecases (`seedBracket`).
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  foldMatchWithStoppage,
  isCoreEventType,
  mulberry32,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
  type LineupPair,
  type StageKind,
} from "@seazn/engine/core";
import { checkFixtureOverride, deciderKeysFor, fixtureKeysFor, sportTopKeys, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { declaredCfgs, lineupFromCatalog, makeEnvelope } from "@seazn/engine/testkit";
import { canonicalJson } from "@/lib/canonical-json";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { awardedMatchState } from "@/server/engine-db/awarded-state";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { declaredVariant, seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { fixtureRow, playBadminton, rowsOf, type FixtureRow } from "@/server/engine-db/__tests__/helpers/w2b-rig";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { resnapshotFixtureConfig } from "../admin-fixture-config";
import { createCompetition } from "../competitions";
import { frozenCompetitionIds } from "../entitlement-freeze";
import { loadFixturePadCfg } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { withdrawEntrantCascade } from "../withdrawal";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A sport's shipped module: the engine's own registry. */
const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no builtin module ${key}`);
  return m;
};
/** A variant's preset, parsed by the sport's own schema — every expected value below is read from here. */
const parsedVariant = <T,>(key: string, variant: string): T => mod(key).configSchema.parse(mod(key).variants[variant]) as T;

interface Row {
  rules_override: Record<string, unknown> | null;
  config_snapshot: Record<string, unknown> | null;
  rules_version: number;
}
const row = async (id: string): Promise<Row> =>
  (await sql<Row[]>`select rules_override, config_snapshot, rules_version from fixtures where id = ${id}`)[0]!;
const events = async (id: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text n from score_events where fixture_id = ${id}`)[0]!.n);
const audit = async (id: string) =>
  sql<{ payload: { fixture_id: string; before: unknown; after: unknown; started: boolean } }[]>`
    select payload from competition_events
     where type = 'fixture.rules_override' and payload->>'fixture_id' = ${id} order by created_at`;
const matchState = async (id: string) =>
  (await sql<{ state: unknown }[]>`select state from match_states where fixture_id = ${id}`)[0]?.state ?? null;
/** What the console and the device pad fold against (`loadFixturePadCfg` → `resolveFixtureCfg`): the effective format. */
const padCfg = async (b: SeededBracket, id: string) => (await loadFixturePadCfg(b.auth, id)).cfg as Record<string, unknown>;
const sides = async (id: string) =>
  (await sql<{ home: string; away: string }[]>`
    select home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;

// I8 — a real ledger: badminton sets played with the module's own rally event (`badminton.rally {wonBy}`, the shape
// public-player-matches.test.ts uses). The rally count is the variant's own `setTo` read from the module, so a preset
// change moves the test with it.
const SHORT = parsedVariant<{ setTo: number; bestOf: number; cap: number | null; finalSetTo: number }>("badminton", "short");
async function playSet(b: SeededBracket, id: string, seq0: number, winner: string): Promise<{ next: number; lastId: string }> {
  let seq = seq0;
  let lastId = "";
  for (let i = 0; i < SHORT.setTo; i++) {
    lastId = (await appendEvent(b.auth.orgId, id, seq++, { type: "badminton.rally", payload: { wonBy: winner } })).event.id;
  }
  return { next: seq, lastId };
}
async function oneSetPlayed(b: SeededBracket) {
  const id = b.fixtureIds[0]!;
  const { home } = await sides(id);
  await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
  const { next, lastId } = await playSet(b, id, 1, home);
  return { id, home, next, lastRallyId: lastId };
}
const badmintonLeague = (entrants = 2) => seedBracket({ sport: "badminton", variant: "short", stageKind: "league", entrants });
const staffActor = async (): Promise<string> => {
  const suffix = randomUUID().slice(0, 8);
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, is_staff, staff_role)
    values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin') returning id`;
  return id;
};
/** The engine's verdict on a correction, folded HERE from the recorded ledger (never the writer's): does the corrected
 *  cfg keep the outcome and the headline, and does it end a match the recorded cfg leaves open? */
async function engineVerdict(b: SeededBracket, id: string, corrected: unknown) {
  const inputs = (await withTenant(b.auth.orgId, (tx) => loadFoldInputs(tx, id)))!;
  const fold = (cfg: unknown) => {
    const f = foldMatchWithStoppage(inputs.module, cfg, inputs.lineups, inputs.envelopes);
    return { outcome: outcomeOf(inputs.module, f), headline: summaryOf(inputs.module, f).headline };
  };
  const before = fold(inputs.cfg);
  const after = fold(corrected);
  return {
    before,
    after,
    fits: canonicalJson(before.outcome) === canonicalJson(after.outcome) && before.headline === after.headline,
  };
}

const PER_SEED_MS = 1_500;
const budget = (seeds: number) => Math.max(5_000, seeds * PER_SEED_MS * 5);

describe.skipIf(!HAS_DB)("X-SR-2 writeFixtureRulesOverride — unstarted", () => {
  it("empty: null on a fixture without an override writes SQL null and one audit row", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    const out = await writeFixtureRulesOverride(b.auth, [id], null);
    expect(out).toEqual({ fixtures: [{ id, started: false, rules_version: 0 }] });
    expect((await row(id)).rules_override).toBeNull();
    const a = await audit(id);
    expect(a).toHaveLength(1);
    expect(a[0]!.payload).toEqual({ fixture_id: id, before: null, after: null, started: false });
  });

  it("empty: no fixture ids writes nothing and answers no fixtures", async () => {
    const b = await badmintonLeague();
    expect(await writeFixtureRulesOverride(b.auth, [], { bestOf: 1 })).toEqual({ fixtures: [] });
    expect((await row(b.fixtureIds[0]!)).rules_override).toBeNull();
    expect(await audit(b.fixtureIds[0]!)).toHaveLength(0);
  });

  it("a match key is written; a second write REPLACES (never merges); {} clears; null clears", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    // Values that differ from the variant's own (the right answer differs from the wrong one's constant).
    expect(SHORT.bestOf).not.toBe(1);
    const shorter = SHORT.setTo - 2;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await row(id)).rules_override).toEqual({ bestOf: 1 });
    expect((await padCfg(b, id)).bestOf).toBe(1);
    await writeFixtureRulesOverride(b.auth, [id], { setTo: shorter, finalSetTo: shorter });
    expect((await row(id)).rules_override).toEqual({ setTo: shorter, finalSetTo: shorter });
    expect((await padCfg(b, id)).bestOf, "the replaced override no longer holds best of 1").toBe(SHORT.bestOf);
    await writeFixtureRulesOverride(b.auth, [id], {});
    expect((await row(id)).rules_override).toBeNull();
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    await writeFixtureRulesOverride(b.auth, [id], null);
    expect((await row(id)).rules_override).toBeNull();
    const a = await audit(id);
    expect(a.map((r) => r.payload.after)).toEqual([{ bestOf: 1 }, { setTo: shorter, finalSetTo: shorter }, null, { bestOf: 1 }, null]);
    expect(a.map((r) => r.payload.before)).toEqual([null, { bestOf: 1 }, { setTo: shorter, finalSetTo: shorter }, null, { bestOf: 1 }]);
    expect((await row(id)).rules_version, "an unstarted write never bumps").toBe(0);
  });

  it("M2: a null VALUE is inherit — never stored, and the key reads the stage's value; a null for an undeclared key is still UNKNOWN_RULE_KEY", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: null, setTo: SHORT.setTo - 2, finalSetTo: SHORT.setTo - 2 });
    expect((await row(id)).rules_override).toEqual({ setTo: SHORT.setTo - 2, finalSetTo: SHORT.setTo - 2 });
    expect((await padCfg(b, id)).bestOf).toBe(SHORT.bestOf);
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: null });
    expect((await row(id)).rules_override, "an all-null fragment clears").toBeNull();
    await expect(writeFixtureRulesOverride(b.auth, [id], { notARule: null })).rejects.toMatchObject({
      status: 400,
      code: "UNKNOWN_RULE_KEY",
      extra: { fixture_id: id, field: "notARule" },
    });
  });

  it("carry (c): only the CHANGED leaves are stored — override bestOf beside the stage's own setTo, then change the stage's setTo; the fixture resolves the new setTo", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    // The whole form sends every value it shows; only bestOf differs from the stage.
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1, setTo: SHORT.setTo, cap: SHORT.cap });
    expect((await row(id)).rules_override).toEqual({ bestOf: 1 });
    const newSetTo = SHORT.setTo - 4;
    await sql`update stages set config = config || ${sql.json({ rules: { setTo: newSetTo, finalSetTo: newSetTo } })} where id = ${b.stageId}`;
    expect(await padCfg(b, id)).toMatchObject({ bestOf: 1, setTo: newSetTo, finalSetTo: newSetTo });
  });

  it("a stage-only key is refused RULE_NOT_SETTABLE; nothing written (football penalties, declared stage scope)", async () => {
    const football = mod("football");
    expect(football.ruleKeys?.shootout?.scope, "the premise: football declares penalties per stage").toBe("stage");
    const b = await seedBracket({ sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const stage = football.configSchema.parse(await padCfg(b, id)) as { shootout: boolean };
    await expect(writeFixtureRulesOverride(b.auth, [id], { shootout: !stage.shootout })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
      extra: { fixture_id: id, field: "shootout" },
    });
    expect((await row(id)).rules_override).toBeNull();
    expect(await audit(id)).toHaveLength(0);
  });

  it("all-or-nothing: one finalized fixture in the batch refuses the batch and names it", async () => {
    const b = await badmintonLeague(3);
    const [a, z] = b.fixtureIds;
    await sql`update fixtures set status = 'finalized' where id = ${z!}`;
    await expect(writeFixtureRulesOverride(b.auth, [a!, z!], { bestOf: 1 })).rejects.toMatchObject({
      status: 409,
      code: "FIXTURE_FORMAT_LOCKED",
      extra: { fixture_id: z },
    });
    expect((await row(a!)).rules_override).toBeNull();
    expect(await audit(a!)).toHaveLength(0);
  });

  it("a batch writes every fixture, each with its own audit row; another org's fixture refuses the batch 404", async () => {
    const b = await badmintonLeague(3);
    const other = await badmintonLeague();
    const out = await writeFixtureRulesOverride(b.auth, b.fixtureIds, { bestOf: 1 });
    expect(out.fixtures.map((f) => f.id)).toEqual(b.fixtureIds);
    let checked = 0;
    for (const id of b.fixtureIds) {
      expect((await row(id)).rules_override).toEqual({ bestOf: 1 });
      expect(await audit(id)).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(3);
    await expect(writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!, other.fixtureIds[0]!], null)).rejects.toMatchObject({ status: 404 });
    expect((await row(b.fixtureIds[0]!)).rules_override, "the refused batch wrote nothing").toEqual({ bestOf: 1 });
  });

  it("M3: an unknown nested leaf is stripped by the sport's schema and never stored (tennis set.bogus)", async () => {
    const tennis = mod("tennis");
    const stage = parsedVariant<{ set: Record<string, unknown>; game: { noAd: boolean } }>("tennis", "tour");
    // The premise, from the engine's own schema: it accepts the leaf and strips it.
    const probe = tennis.configSchema.safeParse({ ...tennis.variants.tour, set: { ...stage.set, bogus: 1 } });
    expect(probe.success && !("bogus" in (probe.data as { set: object }).set)).toBe(true);
    const b = await seedBracket({ sport: "tennis", variant: "tour", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { set: { ...stage.set, bogus: 1 } });
    expect((await row(id)).rules_override).toBeNull();
    // A real nested leaf beside it IS stored, as the leaf alone (carry (c)): `game.noAd` is a declared match key.
    expect(tennis.ruleKeys?.["game.noAd"]?.scope).toBe("match");
    await writeFixtureRulesOverride(b.auth, [id], { set: { ...stage.set, bogus: 1 }, game: { ...stage.game, noAd: !stage.game.noAd } });
    expect((await row(id)).rules_override).toEqual({ game: { noAd: !stage.game.noAd } });
    expect((tennis.configSchema.parse(await padCfg(b, id)) as { game: unknown }).game).toEqual({ ...stage.game, noAd: !stage.game.noAd });
  });

  it("nested (tennis): a slam stage's match switched to a match tie-break final set — a different shape of a strict union — is stored as a replacement and resolves valid", async () => {
    const tennis = mod("tennis");
    expect(tennis.ruleKeys?.finalSet?.scope, "the premise: the final set is a match key").toBe("match");
    const mtb = (tennis.variants["doubles-noad-mtb10"] as { finalSet: Record<string, unknown> }).finalSet;
    const b = await seedBracket({ sport: "tennis", variant: "grand-slam", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { finalSet: mtb });
    expect((await row(id)).rules_override).toEqual({ finalSet: mtb });
    const cfg = await padCfg(b, id);
    expect(cfg.finalSet).toEqual(mtb);
    expect(tennis.configSchema.safeParse(cfg).success).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("X-SR-2 every sport family through the one writer", () => {
  it("period (ice hockey) M2/M3: the check reads the PARSED stage — a stage that inherits the schema's overtime accepts a shorter one, refuses a longer one", async () => {
    const ice = mod("icehockey");
    expect(Object.hasOwn(ice.variants.iihf as object, "overtime"), "the premise: the raw iihf preset has no overtime").toBe(false);
    // A league stage: no bracket decider lays an overtime over it (a knockout's may — Task 6's preset on main).
    const b = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    // `createDivision` stores the PARSED preset (defaults materialised), so a stage only inherits the schema's overtime
    // without carrying it when its stored division config predates the key — the shape the resolver and the fold read
    // raw. Made here, so the check below really meets a raw config with no `overtime` in it (mutation t14-parsed-stage).
    await sql`update divisions set config = config - 'overtime' where id = ${b.divisionId}`;
    const raw = await padCfg(b, id); // the STAGE-resolved format (no override yet): what the match inherits
    expect(Object.hasOwn(raw, "overtime"), "the premise: the stage's resolved format carries no overtime").toBe(false);
    // The bound is the STAGE's overtime as the sport's schema reads it — never the variant's preset.
    const ot = (ice.configSchema.parse(raw) as { overtime: { minutes: number } & Record<string, unknown> }).overtime;
    await expect(writeFixtureRulesOverride(b.auth, [id], { overtime: { ...ot, minutes: ot.minutes + 1 } })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
      extra: { fixture_id: id, field: "overtime.minutes" },
    });
    await writeFixtureRulesOverride(b.auth, [id], { overtime: { ...ot, minutes: ot.minutes - 1 } });
    const cfg = await padCfg(b, id);
    expect(ice.configSchema.safeParse(cfg).success, "the resolved cfg is a valid ice hockey cfg").toBe(true);
    expect((cfg.overtime as { minutes: number }).minutes).toBe(ot.minutes - 1);
    // Over a raw stage with no overtime the leaf alone would not resolve (the strict union needs its `kind`), so the
    // writer's self-check stored the whole overtime instead.
    expect((await row(id)).rules_override).toEqual({ overtime: { ...ot, minutes: ot.minutes - 1 } });
  });

  it("period (ice hockey) carry (c) nested: a shortened overtime stores the leaf, so a later stage edit to another overtime leaf still reaches the match", async () => {
    const ot = parsedVariant<{ overtime: { kind: string; minutes: number; skaters: number } }>("icehockey", "iihf").overtime;
    const b = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "knockout", entrants: 2, stageRules: { overtime: ot } });
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { overtime: { ...ot, minutes: ot.minutes - 1 } });
    expect((await row(id)).rules_override).toEqual({ overtime: { minutes: ot.minutes - 1 } });
    await sql`update stages set config = jsonb_set(config, '{rules,overtime,skaters}', ${sql.json(ot.skaters + 1)}) where id = ${b.stageId}`;
    expect((await padCfg(b, id)).overtime).toEqual({ ...ot, minutes: ot.minutes - 1, skaters: ot.skaters + 1 });
  });

  it("cricket: a shorter innings is a format key per match; overs below the bowler limit is CONFIG_INVALID with the engine's message on the field", async () => {
    const t20 = parsedVariant<{ ballsPerInnings: number; ballsPerOver: number; maxOversPerBowler: number }>("cricket", "t20");
    const b = await seedBracket({ sport: "cricket", variant: "t20", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const tooShort = (t20.maxOversPerBowler - 1) * t20.ballsPerOver;
    const err = await writeFixtureRulesOverride(b.auth, [id], { ballsPerInnings: tooShort }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID", extra: { fixture_id: id, field: "ballsPerInnings" } });
    // The engine's own refinement message, read off its schema rather than typed here.
    const engine = mod("cricket").configSchema.safeParse({ ...mod("cricket").variants.t20, ballsPerInnings: tooShort });
    expect(engine.success).toBe(false);
    expect(String((err as Error).message)).toContain(engine.success ? "" : engine.error.issues[0]!.message);
    // Batch-3 M2: ONE wire shape for CONFIG_INVALID's issues — `{path, message}`, as v1 forwards the engine's.
    expect((err as { extra: { issues?: unknown } }).extra.issues).toEqual(engine.success ? [] : engine.error.issues.map((i) => ({ path: i.path, message: i.message })));
    expect((await row(id)).rules_override).toBeNull();
    const shorter = t20.ballsPerInnings / 2;
    await writeFixtureRulesOverride(b.auth, [id], { ballsPerInnings: shorter });
    expect((await padCfg(b, id)).ballsPerInnings).toBe(shorter);
  });

  it("carrom (Task 5 I3): game-to below the stage's queen cap is CONFIG_INVALID naming the field — the stage-only cap is never clamped", async () => {
    const carrom = mod("carrom");
    expect(carrom.ruleKeys?.queenCapAt?.scope, "the premise: the queen cap is a stage key").toBe("stage");
    const icf = parsedVariant<{ gameTo: number; queenCapAt: number }>("carrom", "icf");
    const b = await seedBracket({ sport: "carrom", variant: "icf", stageKind: "league", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const err = await writeFixtureRulesOverride(b.auth, [id], { gameTo: icf.queenCapAt - 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID", extra: { fixture_id: id, field: "gameTo" } });
    const engine = carrom.configSchema.safeParse({ gameTo: icf.queenCapAt - 1 });
    expect(String((err as Error).message)).toContain(engine.success ? "<premise: the engine refuses it>" : engine.error.issues[0]!.message);
    expect((await row(id)).rules_override).toBeNull();
    await writeFixtureRulesOverride(b.auth, [id], { gameTo: icf.queenCapAt });
    expect((await row(id)).rules_override, "game-to alone, the cap left to the stage").toEqual({ gameTo: icf.queenCapAt });
    expect(carrom.configSchema.parse(await padCfg(b, id))).toMatchObject({ gameTo: icf.queenCapAt, queenCapAt: icf.queenCapAt });
  });

  it("set (badminton): a cap below the set target is CONFIG_INVALID with the engine's message on the field", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    const below = Math.max(SHORT.setTo, SHORT.finalSetTo) - 1;
    const err = await writeFixtureRulesOverride(b.auth, [id], { cap: below }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "CONFIG_INVALID", extra: { fixture_id: id, field: "cap" } });
    const engine = mod("badminton").configSchema.safeParse({ ...mod("badminton").variants.short, cap: below });
    expect(String((err as Error).message)).toContain(engine.success ? "<premise: the engine refuses it>" : engine.error.issues[0]!.message);
  });

  it("boardgame declares no match key, so every key it has is refused per match (RULE_NOT_SETTABLE)", async () => {
    const bg = mod("boardgame");
    expect(fixtureKeysFor(bg, "knockout", "classical"), "the premise: no match-scope key").toEqual([]);
    const b = await seedBracket({ sport: "boardgame", variant: "classical", stageKind: "knockout", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const stage = bg.configSchema.parse(await padCfg(b, id)) as { tiebreak?: unknown };
    await expect(writeFixtureRulesOverride(b.auth, [id], { tiebreak: stage.tiebreak !== true })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
    });
  });

  it("a competition frozen by a downgrade refuses 402 and writes nothing; the same write went through before the freeze", async () => {
    // stage-rules.test.ts's recipe: fill the smaller plan's cap while on the larger, then drop — `selectFrozen` retires
    // the least recently active competition, this one. The cap is read from the plan, never typed.
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }); // writable BEFORE the freeze, or a 402 proves nothing
    await setOrgPlan(b.auth.orgId, "community");
    await invalidateOrgEntitlements(b.auth.orgId);
    const cap = await getLimit(b.auth.orgId, "competitions.max_active");
    expect(cap, "an unlimited community plan would make this vacuous").not.toBeNull();
    await setOrgPlan(b.auth.orgId, "pro");
    await invalidateOrgEntitlements(b.auth.orgId);
    for (let i = 0; i < cap!; i++)
      await createCompetition(b.auth, { ends_on: "2030-12-31", name: "Filler " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    await setOrgPlan(b.auth.orgId, "community");
    await invalidateOrgEntitlements(b.auth.orgId);
    expect((await frozenCompetitionIds(b.auth.orgId)).has(b.competitionId), "the premise: this competition is the one frozen").toBe(true);
    await expect(writeFixtureRulesOverride(b.auth, [id], { bestOf: 3 })).rejects.toMatchObject({ status: 402 });
    expect((await row(id)).rules_override, "the pre-freeze override is untouched").toEqual({ bestOf: 1 });
    expect(await audit(id), "only the pre-freeze write was audited").toHaveLength(1);
  }, 60_000);

  it("registry sweep: in every sport an empty override is accepted and an undeclared key is UNKNOWN_RULE_KEY", async () => {
    let checked = 0;
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const b = await seedBracket({ sport: m.key, variant, stageKind: "league", entrants: 2 });
      const id = b.fixtureIds[0]!;
      const bogus = "w2cNotARule";
      expect(sportTopKeys(m).has(bogus)).toBe(false);
      await expect(writeFixtureRulesOverride(b.auth, [id], { [bogus]: 1 }), m.key).rejects.toMatchObject({ code: "UNKNOWN_RULE_KEY" });
      expect(await writeFixtureRulesOverride(b.auth, [id], {}), m.key).toEqual({ fixtures: [{ id, started: false, rules_version: 0 }] });
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  }, budget(builtinModules.length));
});

describe.skipIf(!HAS_DB)("X-SR-5 P5 correction of a started match", () => {
  it("precondition: the short preset is best of 3, so one set leaves the match open", () => {
    expect(SHORT.bestOf).toBe(3);
  });

  it("fits: badminton best of 3 → 5 after one completed set; snapshot re-frozen, version bumped once, audit says started", async () => {
    const b = await badmintonLeague();
    const { id } = await oneSetPlayed(b);
    const before = await row(id);
    expect(before.rules_version).toBe(0); // the first event freezes; it never bumps (P-1)
    expect(before.config_snapshot).toMatchObject({ bestOf: 3 });
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const r = await row(id);
    expect(r.config_snapshot).toMatchObject({ bestOf: 5 });
    expect(r.rules_override).toEqual({ bestOf: 5 });
    expect(r.rules_version).toBe(1);
    expect(out.fixtures[0]).toEqual({ id, started: true, rules_version: 1 });
    expect(await events(id)).toBe(1 + SHORT.setTo); // nothing appended or removed by a correction
    expect((await audit(id)).at(-1)!.payload).toMatchObject({ started: true, before: null, after: { bestOf: 5 } });
    // The cache every reader serves (match_states) was refolded under the corrected cfg: it equals the engine's own
    // fold of the ledger under best of 5.
    const v = await engineVerdict(b, id, r.config_snapshot);
    const st = (await sql<{ summary: { headline: string } }[]>`select summary from match_states where fixture_id = ${id}`)[0]!;
    expect(st.summary.headline).toBe(v.after.headline);
    expect(((await matchState(id)) as { cfg?: { bestOf?: unknown } } | null)?.cfg?.bestOf).toBe(5);
  });

  it("a second identical correction neither re-freezes nor bumps; a different one bumps again", async () => {
    const b = await badmintonLeague();
    const { id } = await oneSetPlayed(b);
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    expect(out.fixtures[0]).toEqual({ id, started: true, rules_version: 1 });
    expect((await row(id)).rules_version).toBe(1);
    expect(await audit(id), "still audited").toHaveLength(2);
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 7 });
    expect((await row(id)).rules_version).toBe(2);
  });

  it("an UNSTARTED write never bumps the version (only a correction or a re-freeze does)", async () => {
    const b = await badmintonLeague();
    await writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], { bestOf: 1 });
    expect((await row(b.fixtureIds[0]!)).rules_version).toBe(0);
  });

  it("a staff re-freeze (resnapshotFixtureConfig) bumps the version through refreezeFixture", async () => {
    const b = await badmintonLeague();
    const { id } = await oneSetPlayed(b);
    await resnapshotFixtureConfig(await staffActor(), id, "w2c: staff re-freeze bumps the version"); // (actorId, fixtureId, reason)
    expect((await row(id)).rules_version).toBe(1);
  });

  it("does not fit: football extra time switched off while the match is in extra time → FORMAT_DOES_NOT_FIT_PLAY with the engine's reason; nothing changed", async () => {
    const b = await seedBracket({
      sport: "football", variant: "11-a-side", stageKind: "knockout", entrants: 2,
      stageRules: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
    });
    const id = b.fixtureIds[0]!;
    let seq = 0;
    for (const [type, payload] of [["core.start", {}], ["football.period", { phase: "HT" }], ["football.period", { phase: "FT" }], ["football.period", { phase: "ET_HT" }]] as const)
      await appendEvent(b.auth.orgId, id, seq++, { type, payload });
    const before = await row(id);
    expect(before.config_snapshot).toMatchObject({ extraTime: { enabled: true } });
    const err = await writeFixtureRulesOverride(b.auth, [id], { extraTime: { enabled: false, halfMinutes: 15 } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: id } });
    // The engine's own reason: the fold under the corrected cfg refuses the recorded ET marker.
    const corrected = { ...(before.config_snapshot as object), extraTime: { enabled: false, halfMinutes: 15 } };
    const engine = await engineVerdict(b, id, corrected).then(() => null, (e: unknown) => (e as Error).message);
    expect(engine, "the premise: the engine refuses this stream under the corrected cfg").not.toBeNull();
    expect(String((err as Error).message)).toBe(engine);
    expect(await row(id)).toEqual(before); // rules_version included: a refusal bumps nothing
  });

  it("P-4: a correction that would END the match is refused (best of 3 → 1 after a completed set); nothing changed", async () => {
    const b = await badmintonLeague();
    const { id } = await oneSetPlayed(b);
    const before = await row(id);
    const v = await engineVerdict(b, id, { ...(before.config_snapshot as object), bestOf: 1 });
    expect(v.before.outcome, "the premise: open under the recorded cfg").toBeNull();
    expect(v.after.outcome, "the premise: the engine ends it under best of 1").not.toBeNull();
    const err = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: id, fit_reason: "ends" } });
    expect(String((err as Error).message)).toBe("This format would end the match as it stands");
    expect(await row(id)).toEqual(before);
    expect(await audit(id)).toHaveLength(0);
  });

  it("batch-3 I1, one 'started': a match PLAYED with no frozen cfg (a pre-V347 row) is started — the same misfit is refused, and the write reports it started", async () => {
    // The stage lock (`rule-locks.ts`) has always counted a recorded event as play; the writer counted only a frozen
    // cfg, so a played row without one took any format unasked. Both now read `format-standing.ts`.
    const b = await badmintonLeague();
    const { id } = await oneSetPlayed(b);
    await sql`update fixtures set config_snapshot = null, config_snapshot_at = null where id = ${id}`;
    const before = await row(id);
    const err = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: id } });
    expect(await row(id)).toEqual(before);
    // Positive pair: a fitting format is taken, and reported started.
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    expect(out.fixtures).toEqual([expect.objectContaining({ id, started: true })]);
  });

  it("P-4 positive pair: the same best-of-1 correction BEFORE any set completes fits", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    const { home } = await sides(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await row(id)).config_snapshot).toMatchObject({ bestOf: 1 });
  });

  it("finalized → FIXTURE_FORMAT_LOCKED; cancelled likewise", async () => {
    let checked = 0;
    for (const status of ["finalized", "cancelled"]) {
      const b = await badmintonLeague();
      await sql`update fixtures set status = ${status} where id = ${b.fixtureIds[0]!}`;
      await expect(writeFixtureRulesOverride(b.auth, [b.fixtureIds[0]!], { bestOf: 1 })).rejects.toMatchObject({
        status: 409,
        code: "FIXTURE_FORMAT_LOCKED",
        // Batch-3 M1: why it is locked, for a client to say it with; the sentence says finished.
        extra: { fixture_id: b.fixtureIds[0], reason: "finished" },
        message: "This match is finished — its format is locked.",
      });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("after a void takes back the rally that won the first set, best of 1 fits: the refold reads that set open again", async () => {
    // A void is resolved out of the stream before the fold (`resolveVoids`), so voiding the set's last rally leaves the
    // set one rally short of its target — the set kernel needs no void handling of its own for this.
    const b = await badmintonLeague();
    const { id, next, lastRallyId } = await oneSetPlayed(b);
    const v = await appendEvent(b.auth.orgId, id, next, { type: "core.void", payload: {}, voids: lastRallyId });
    expect(v.event.voids).toBe(lastRallyId); // the void landed
    expect(v.outcome).toBeNull(); // and the match is open
    await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect((await row(id)).config_snapshot).toMatchObject({ bestOf: 1 });
    expect((await row(id)).rules_version).toBe(1);
  });

  it("after a withdrawal: the walkover's credited score is recorded play — a correction the engine scores differently is refused, one it scores the same fits", async () => {
    // A knockout line: the withdrawal walks it over to the opponent (a 2-entrant LEAGUE with nothing played expunges
    // the line instead — `core.abandon {expunge}` — which leaves nothing scored to contradict).
    const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "knockout", entrants: 2 });
    const id = b.fixtureIds[0]!;
    const { away } = await sides(id);
    await withdrawEntrantCascade(b.auth, away);
    const before = await row(id);
    expect(before.config_snapshot, "the premise: the walkover froze the cfg").not.toBeNull();
    expect(await events(id), "the premise: the walkover is a recorded event").toBeGreaterThan(0);
    // Corrections, each judged by the engine's own fold of the walkover; between them, one of each verdict.
    const shorter = SHORT.setTo - 2;
    const frags: Record<string, unknown>[] = [
      { bestOf: 5 },
      { setTo: shorter, finalSetTo: shorter },
      ...(SHORT.cap === null ? [] : [{ cap: SHORT.cap + 1 }]),
    ];
    const verdicts = await Promise.all(frags.map((f) => engineVerdict(b, id, { ...(before.config_snapshot as object), ...f })));
    expect(new Set(verdicts.map((v) => v.fits)).size, JSON.stringify(verdicts)).toBe(2);
    let checked = 0;
    for (const frag of frags) {
      // Judged against the snapshot as it stands NOW (an earlier fitting correction re-froze it); the correction
      // itself is the stage's format (the walkover's original snapshot — no override yet) with this fragment.
      const now = await engineVerdict(b, id, { ...(before.config_snapshot as object), ...frag });
      const got = await writeFixtureRulesOverride(b.auth, [id], frag).then(() => "fits", (e: { code?: string }) => e.code);
      expect(got, JSON.stringify(frag)).toBe(now.fits ? "fits" : "FORMAT_DOES_NOT_FIT_PLAY");
      checked++;
    }
    expect(checked).toBe(frags.length);
  });

  it("a frozen cfg with no ledger behind it (raw seed) fits trivially and re-freezes", async () => {
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    await sql`update fixtures set config_snapshot = ${sql.json({ ...(mod("badminton").variants.short as object) })} where id = ${id}`;
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 });
    expect(out.fixtures[0]).toEqual({ id, started: true, rules_version: 1 });
    expect((await row(id)).config_snapshot).toMatchObject({ bestOf: 1 });
    expect(await matchState(id), "no ledger, nothing folded").toBeNull();
  });

  it("Review Focus 1: a correction and an append serialise on the fixture lock (M9)", async () => {
    let runs = 0;
    for (let i = 0; i < 5; i++) {
      const b = await badmintonLeague();
      const id = b.fixtureIds[0]!;
      const [w, a] = await Promise.allSettled([
        writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }),
        appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} }),
      ]);
      expect(w.status).toBe("fulfilled"); // unstarted or fits: neither order refuses
      expect(a.status).toBe("fulfilled");
      const r = await row(id);
      expect(r.rules_override).toEqual({ bestOf: 1 });
      // Either order must leave the frozen snapshot at best of 1: if the writer ran first, the start froze the
      // override; if the start ran first, the writer saw a frozen snapshot and refolded (then rules_version is 1).
      expect((r.config_snapshot as { bestOf: number } | null)?.bestOf).toBe(1);
      expect(r.rules_version).toBeLessThanOrEqual(1);
      runs++;
    }
    expect(runs).toBe(5);
  }, budget(5));
});

// Fix round 1, I2 — spec §9 P5: "per-sport fits / does-not-fit table". Every sport the registry ships is swept: one
// with a match key gets a SHORT PLAY drawn from its own generator (`arbitraryEvent`), then one correction the play fits
// and one it does not, both through the real writer; one with no match key is listed N/A. Nothing here is a hand table:
// the corrections are each match key's value in the sport's declared presets and its bound's own step, the deciders a
// knockout stage switches on are the sport's declared ones, and the verdict is the engine's fold (`foldMatchWithStoppage`
// → `outcomeOf`/`summaryOf`), never the writer's.
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const valueAt = (o: unknown, p: readonly string[]): unknown => p.reduce<unknown>((a, k) => (isRec(a) ? a[k] : undefined), o);
function withLeaf(o: unknown, p: readonly string[], v: unknown): unknown {
  if (p.length === 0) return v;
  const c: Record<string, unknown> = isRec(o) ? { ...o } : {};
  c[p[0]!] = withLeaf(c[p[0]!], p.slice(1), v);
  return c;
}
interface Correction { label: string; top: string; whole: unknown }

/** Every WHOLE decider (`deciderKeysFor`) a knockout stage of this sport carries, switched on with the sport's own
 *  value: a `{enabled}` decider flipped on, a switch set, an absent one taken from the first declared preset that has it
 *  on. So a level match goes INTO its decider rather than ending — the play a decider's match key can contradict. */
function decidersOn(m: AnySportModule, kind: StageKind, variant: string): Record<string, unknown> {
  const base = m.configSchema.parse(m.variants[variant]) as Record<string, unknown>;
  const presets = declaredCfgs(m).map((d) => d.cfg as Record<string, unknown>);
  const on = (v: unknown) => v !== null && v !== undefined && v !== false && !(isRec(v) && v.enabled === false);
  const out: Record<string, unknown> = {};
  for (const key of deciderKeysFor(m, kind, variant)) {
    if (key.includes(".")) continue; // a whole decider is a top-level key; a dotted one is a bound inside it
    const cur = base[key];
    if (on(cur)) continue;
    const v = isRec(cur) && "enabled" in cur ? { ...cur, enabled: true } : typeof cur === "boolean" ? true : presets.map((c) => c[key]).find(on);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The corrections one match may ask for, every one from the sport's declarations: each match key's value in every
 *  declared preset, plus its bound's own step (`shorter` and any length: one less; `off_or_shorter`: off, or a half one
 *  minute shorter; a switch: flipped). Kept only where the engine takes it as a match override of THIS stage
 *  (`checkFixtureOverride`) and the schema parses it. A top-level null is no candidate: the writer reads it as inherit. */
function correctionsFor(m: AnySportModule, kind: StageKind, variant: string, snapshot: unknown): Correction[] {
  const S = m.configSchema.parse(snapshot) as Record<string, unknown>;
  const out: Correction[] = [];
  const seen = new Set<string>();
  for (const key of fixtureKeysFor(m, kind, variant)) {
    const p = key.split(".");
    const cur = valueAt(S, p);
    const values: unknown[] = declaredCfgs(m).map((d) => valueAt(d.cfg, p));
    if (typeof cur === "number") values.push(cur - 1);
    if (typeof cur === "boolean") values.push(!cur);
    if (m.ruleKeys?.[key]?.matchBound === "off_or_shorter" && isRec(cur)) {
      values.push({ ...cur, enabled: false });
      if (typeof cur.halfMinutes === "number") values.push({ ...cur, halfMinutes: cur.halfMinutes - 1 });
    }
    for (const v of values) {
      if (v === undefined || (p.length === 1 && v === null) || canonicalJson(v) === canonicalJson(cur)) continue;
      const top = p[0]!;
      const parsed = m.configSchema.safeParse({ ...S, [top]: (withLeaf(S, p, v) as Record<string, unknown>)[top] });
      if (!parsed.success) continue;
      const whole = (parsed.data as Record<string, unknown>)[top];
      if (!checkFixtureOverride(m, kind, variant, S, { [top]: whole }).ok) continue;
      const label = `${key} = ${JSON.stringify(v)}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, top, whole });
    }
  }
  return out;
}

/** The engine's verdict (X-SR-5, P-4): the recorded play refolded under the correction must fold, keep its outcome and
 *  keep its score as shown. */
function engineFit(m: AnySportModule, snapshot: Record<string, unknown>, lineups: LineupPair, evs: readonly EventEnvelope[], c: Correction): string {
  const fold = (cfg: unknown) => {
    const f = foldMatchWithStoppage(m, cfg, lineups, evs);
    return { o: canonicalJson(outcomeOf(m, f)), h: summaryOf(m, f).headline };
  };
  const before = fold(snapshot);
  let after;
  try {
    after = fold({ ...snapshot, [c.top]: c.whole });
  } catch (e) {
    return `the fold refuses it: ${(e as Error).message}`;
  }
  if (after.o !== before.o) return before.o === "null" ? "it would end the match" : "it would change the result";
  if (after.h !== before.h) return "it would change the score";
  return "fits";
}

/** The shortest play the sport's own generator walks to where one correction fits and one does not. Each step draws up
 *  to 64 events (`arbitraryEvent`, seeded), keeps those the fold accepts STRICTLY as the next event and that leave the
 *  match open (no `core.*`: a forfeit or an abandon is not play), and takes one that reaches both verdicts if any does;
 *  else the one that keeps the score level while the match moves on (so a level match reaches its decider), else one
 *  that moves the score. Deterministic: the seeds are fixed. */
function shortPlay(m: AnySportModule, snapshot: Record<string, unknown>, lineups: LineupPair, prefix: readonly EventEnvelope[], cands: readonly Correction[]) {
  const MAX_STEPS = 400;
  const judge = (evs: readonly EventEnvelope[]) => {
    let fit: Correction | undefined;
    let nofit: { c: Correction; why: string } | undefined;
    for (const c of cands) {
      const v = engineFit(m, snapshot, lineups, evs, c);
      if (v === "fits") fit ??= c;
      else nofit ??= { c, why: v };
    }
    return fit && nofit ? { fit, nofit } : null;
  };
  const evs = [...prefix];
  const lines = (s: unknown) => m.summary(s as never).perSide.map((x) => x.line);
  const unit = (s: unknown) => JSON.stringify(m.position?.(s as never)?.segments?.[0] ?? null);
  for (let step = 0; step <= MAX_STEPS; step++) {
    const j = judge(evs);
    if (j) return { play: evs.slice(prefix.length), ...j, headline: summaryOf(m, foldMatchWithStoppage(m, snapshot, lineups, evs)).headline };
    const st = foldMatchWithStoppage(m, snapshot, lineups, evs).state;
    let pick: EventEnvelope | null = null;
    let rank = Infinity;
    for (let k = 0; k < 64 && rank > -1; k++) {
      const drawn = m.arbitraryEvent?.(st as never, mulberry32(step * 1009 + k * 7 + 1));
      if (!drawn || isCoreEventType(drawn.type)) continue;
      const e = makeEnvelope(evs.length + 1, drawn);
      let f;
      try {
        f = foldMatchWithStoppage(m, snapshot, lineups, [...evs, e], { strictFromSeq: evs.length + 1 });
      } catch {
        continue;
      }
      if (outcomeOf(m, f) !== null) continue;
      if (judge([...evs, e])) {
        pick = e;
        rank = -1;
        break;
      }
      const [a, b] = lines(f.state);
      const level = a !== undefined && a === b;
      const moved = canonicalJson(lines(f.state)) !== canonicalJson(lines(st));
      const advanced = unit(f.state) !== unit(st);
      const r = level && advanced ? 0 : level && moved ? 1 : advanced ? 2 : moved ? 3 : 4;
      if (r < rank) {
        rank = r;
        pick = e;
      }
    }
    if (pick === null) return null;
    evs.push(pick);
  }
  return null;
}

/** A catalog-valid starting lineup per side (`lineupFromCatalog`, the engine's own), each slot a real person — the
 *  sports whose play names a player (a bowler, a scorer) draw them from it. */
async function seedLineups(b: SeededBracket, id: string, m: AnySportModule, cfg: unknown): Promise<void> {
  const catalog = m.positionsFor?.(cfg as never) ?? m.positions;
  const { home, away } = await sides(id);
  for (const entrantId of [home, away]) {
    for (const s of lineupFromCatalog(catalog, entrantId).slots) {
      const [{ id: personId }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${b.auth.orgId}, ${"P5 " + randomUUID().slice(0, 6)}) returning id`;
      await sql`insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role)
                values (${id}, ${entrantId}, ${personId}, ${s.slot}, ${s.positionKey ?? null}, ${s.orderNo ?? null},
                        ${sql.json((s.roles ?? []) as never)}, 'player')`;
    }
  }
}

describe.skipIf(!HAS_DB)("P5 per-sport fits / does-not-fit (spec §9 P5, X-SR-5)", () => {
  it("every sport with a match key: after a short play from its own generator, one correction fits and one does not — the writer agrees with the engine; a sport with none is N/A", async () => {
    const table: string[] = [];
    let swept = 0;
    let na = 0;
    for (const m of builtinModules) {
      const kind: StageKind = "knockout";
      const variant = Object.keys(m.variants)[0]!;
      if (fixtureKeysFor(m, kind, variant).length === 0) {
        table.push(`${m.key}: N/A — no match key`);
        na++;
        continue;
      }
      const deciders = decidersOn(m, kind, variant);
      expect(m.configSchema.safeParse({ ...(m.configSchema.parse(m.variants[variant]) as object), ...deciders }).success, `${m.key}: the deciders parse`).toBe(true);
      const b = await seedBracket({ sport: m.key, variant, stageKind: kind, entrants: 2, stageRules: deciders });
      const id = b.fixtureIds[0]!;
      await seedLineups(b, id, m, await padCfg(b, id));
      await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
      const snapshot = (await row(id)).config_snapshot!;
      const inputs = (await withTenant(b.auth.orgId, (tx) => loadFoldInputs(tx, id)))!;
      const cands = correctionsFor(m, kind, variant, snapshot);
      expect(cands.length, `${m.key}: the sport declares corrections a match may ask for`).toBeGreaterThan(0);
      const found = shortPlay(m, snapshot, inputs.lineups, inputs.envelopes, cands);
      expect(found, `${m.key}: a short play reaches one correction that fits and one that does not (${cands.map((c) => c.label).join("; ")})`).not.toBeNull();
      // The play, through the one append path, at the ledger's own tip.
      let seq = inputs.envelopes.length;
      for (const e of found!.play) await appendEvent(b.auth.orgId, id, seq++, { type: e.type, payload: e.payload });
      const stored = (await sql<{ summary: { headline: string } }[]>`select summary from match_states where fixture_id = ${id}`)[0]!;
      expect(stored.summary.headline, `${m.key}: the recorded play is the walked play`).toBe(found!.headline);
      // Does not fit: refused, and nothing moved.
      const before = await row(id);
      const err = await writeFixtureRulesOverride(b.auth, [id], { [found!.nofit.c.top]: found!.nofit.c.whole }).catch((e: unknown) => e);
      expect(err, `${m.key}: ${found!.nofit.c.label} — ${found!.nofit.why}`).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: id } });
      expect(await row(id), `${m.key}: a refusal changes nothing`).toEqual(before);
      // Fits: re-frozen under it, one bump, and the pad reads it.
      const out = await writeFixtureRulesOverride(b.auth, [id], { [found!.fit.top]: found!.fit.whole });
      expect(out.fixtures[0], `${m.key}: ${found!.fit.label} fits`).toEqual({ id, started: true, rules_version: before.rules_version + 1 });
      const pad = m.configSchema.parse(await padCfg(b, id)) as Record<string, unknown>;
      expect(canonicalJson(pad[found!.fit.top]), `${m.key}: the pad plays the corrected format`).toBe(canonicalJson(found!.fit.whole));
      table.push(`${m.key} (${variant}, ${found!.play.length} events): fits ${found!.fit.label}; does not fit ${found!.nofit.c.label} (${found!.nofit.why})`);
      swept++;
    }
    console.info(`P5 per-sport table:\n  ${table.join("\n  ")}`);
    expect(swept, "anti-vacuity: sports swept").toBeGreaterThan(0);
    expect(swept + na, table.join("\n")).toBe(builtinModules.length);
    expect(table.filter((t) => t.includes("N/A")).length).toBe(na);
  }, 900_000);
});

// Fix round 1, minor 1 — LOCK ORDER. A fed-seat release (`releaseFedSeats`, fed-seats.ts) holds a decided line's own
// fixture lock and then takes every match it fed in bracket order, ascending (round_no, id). A batch writer that took
// its fixtures in id order could hold a LATER round's lock while asking for an earlier one's — the cycle that order
// exists to rule out. The writer now takes them in the same order (`bracketOrder`).
describe.skipIf(!HAS_DB)("lock order: the batch writer takes its fixtures in bracket order", () => {
  /** pg_locks' row for a waiter on `fixture:<id>` (an advisory lock on one bigint key: objid = its low 32 bits). */
  const waitingOn = async (id: string) =>
    (await sql<{ n: number }[]>`
      select count(*)::int n from pg_locks
       where locktype = 'advisory' and not granted and objsubid = 1
         and objid::text::bigint = (hashtext(${"fixture:" + id})::bigint & 4294967295)`)[0]!.n;

  it("a release-shaped tx holding round 1 and then asking for round 2 never deadlocks with a batch over both", async () => {
    // A later-round match whose id sorts BEFORE a first-round one: id order and bracket order disagree. Random ids, so
    // re-seeded until they do (P(none) = 1/35 per draw); the premise is asserted, never assumed.
    let pick: { b: SeededBracket; early: string; late: string } | null = null;
    for (let tries = 0; tries < 6 && pick === null; tries++) {
      const b = await seedBracket({ sport: "badminton", variant: "short", stageKind: "knockout", entrants: 8 });
      const rows = await rowsOf(b.stageId);
      const first = Math.min(...rows.map((r) => r.round_no));
      for (const e of rows.filter((r) => r.round_no === first))
        for (const l of rows.filter((r) => r.round_no > first)) if (pick === null && l.id < e.id) pick = { b, early: e.id, late: l.id };
    }
    expect(pick, "the premise: a later round's id sorts before a first-round one").not.toBeNull();
    const { b, early, late } = pick!;
    let release!: () => void;
    const go = new Promise<void>((r) => (release = r));
    // The release's shape: the early line's lock, then (once the writer is queued) the later match's.
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + early}))`;
      await go;
      await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + late}))`;
    });
    await new Promise((r) => setTimeout(r, 50)); // the holder has its first lock
    const writer = writeFixtureRulesOverride(b.auth, [late, early], { bestOf: 1 });
    let queued = false;
    for (let i = 0; i < 100 && !queued; i++) {
      queued = (await waitingOn(early)) + (await waitingOn(late)) > 0;
      if (!queued) await new Promise((r) => setTimeout(r, 20));
    }
    expect(queued, "the premise: the writer queued behind the holder").toBe(true);
    release();
    const [h, w] = await Promise.allSettled([holder, writer]);
    expect(h.status === "rejected" ? String((h as PromiseRejectedResult).reason) : "ok", "the holder").toBe("ok");
    expect(w.status === "rejected" ? String((w as PromiseRejectedResult).reason) : "ok", "the writer").toBe("ok");
    expect((await row(early)).rules_override).toEqual({ bestOf: 1 });
    expect((await row(late)).rules_override).toEqual({ bestOf: 1 });
  }, 60_000);
});

// Fix round 1, I1 (ruling): a match with an OUTCOME is started whatever its snapshot says. `awardSeededByes`
// (stages.ts) decides a tie with no event at all — a bye, or ruling 116's walkover over a withdrawn winner's dead seat
// (`writeAwardedMatchState` writes its credited score) — and leaves `config_snapshot` null. Such a tie was read as
// unstarted: an override landed with no fit check and no refold, so the walkover's credited score went stale under a
// format it no longer matched. Now a change to it goes through the live-correction path, fitted by the award's own fold
// (`awardedMatchState`), or is refused where no fit applies (a bye credits no score; nothing records it).
const awardRow = async (id: string) =>
  (await sql<{ status: string; outcome: unknown; summary: { headline: string } | null; state: unknown }[]>`
    select f.status, f.outcome, m.summary, m.state from fixtures f left join match_states m on m.fixture_id = f.id
     where f.id = ${id}`)[0]!;
const BWF = parsedVariant<{ bestOf: number; setTo: number; finalSetTo: number; cap: number | null }>("badminton", "bwf");

/** Two seated first-round lines feeding one later tie (the generated feed graph). */
function siblingsInto(rows: readonly FixtureRow[]): { a: FixtureRow; b: FixtureRow; parentId: string } {
  const first = Math.min(...rows.map((r) => r.round_no));
  const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
  for (const a of r1) {
    const b = r1.find((x) => x.id !== a.id && x.winner_to_fixture !== null && x.winner_to_fixture === a.winner_to_fixture);
    if (b) return { a, b, parentId: a.winner_to_fixture! };
  }
  throw new Error("rig: no two seated first-round lines feed one fixture");
}

/** Ruling 116 through the real producers (W2b Task 16's chain): line `a` is played, its winner withdraws while her next
 *  tie waits, line `b` is played, and the arriving side walks over her dead seat — an award no event records. */
async function withdrawnWinnerWalkover() {
  const b = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 8 });
  const { a, b: sib, parentId } = siblingsInto(await rowsOf(b.stageId));
  const w1 = (await playBadminton(b.auth, a.id, true)).home_entrant_id!;
  await withdrawEntrantCascade(b.auth, w1);
  const arriving = (await playBadminton(b.auth, sib.id, true)).home_entrant_id!;
  const tie = await fixtureRow(parentId);
  expect([tie.status, tie.outcome], "the premise: a walkover naming who withdrew").toEqual([
    "forfeited",
    { kind: "award", winner: arriving, loser: w1, reason: "withdrew" },
  ]);
  expect(await events(parentId), "the premise: no event records it").toBe(0);
  expect((await row(parentId)).config_snapshot, "the premise: nothing froze its cfg").toBeNull();
  const slot = a.winner_to_slot!;
  return { b, id: parentId, w1, arriving, home: slot === 1 ? w1 : arriving, away: slot === 1 ? arriving : w1 };
}

/** The award's own fold under `cfg` — the engine's walkover (`awardedMatchState`), never the writer's verdict. */
async function awardFold(w: Awaited<ReturnType<typeof withdrawnWinnerWalkover>>, cfg: unknown) {
  const lineups = await withTenant(w.b.auth.orgId, (tx) => loadLineupPair(tx, w.id, w.home, w.away));
  const outcome = (await fixtureRow(w.id)).outcome as never;
  return awardedMatchState(mod("badminton"), cfg, lineups, outcome, { fixtureId: w.id, recordedAt: new Date().toISOString() });
}

describe.skipIf(!HAS_DB)("X-SR-5 I1 a match decided without play is started (fix round 1 ruling)", () => {
  it("a bye (awardSeededByes, an odd draw) credits no score and records nothing: fitting does not apply — FIXTURE_FORMAT_LOCKED, nothing written", async () => {
    const odd = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", "bwf"), stageKind: "knockout", entrants: 6 });
    const byes = (await rowsOf(odd.stageId)).filter((r) => r.outcome?.reason === "bye");
    expect(byes.length, "the premise: the odd draw has byes").toBeGreaterThan(0);
    let checked = 0;
    for (const bye of byes) {
      expect((await row(bye.id)).config_snapshot, "the premise: a bye freezes nothing").toBeNull();
      await expect(writeFixtureRulesOverride(odd.auth, [bye.id], { bestOf: 1 })).rejects.toMatchObject({
        status: 409,
        code: "FIXTURE_FORMAT_LOCKED",
        // Batch-3 M1 (the review's note): a bye is no finished match — it was decided without play.
        extra: { fixture_id: bye.id, reason: "decided" },
        message: "This match was decided without play — its format can't be changed.",
      });
      expect((await row(bye.id)).rules_override).toBeNull();
      expect(await audit(bye.id)).toHaveLength(0);
      // Re-sending the format it already plays changes nothing, so nothing is fitted (fix round 2): accepted, no bump.
      await expect(writeFixtureRulesOverride(odd.auth, [bye.id], null)).resolves.toEqual({
        fixtures: [{ id: bye.id, started: true, rules_version: 0 }],
      });
      expect((await row(bye.id)).rules_override).toBeNull();
      checked++;
    }
    expect(checked).toBe(byes.length);
  });

  it("an award that already carries its own format (fix round 2): a second correction refits from it, re-sending it rewrites nothing, and a CLEAR re-writes the credited score under the stage's format", async () => {
    const w = await withdrawnWinnerWalkover();
    const stage = await padCfg(w.b, w.id); // no override yet: the stage's format
    const first = { setTo: BWF.setTo - 6, finalSetTo: BWF.finalSetTo - 6 };
    const second = { setTo: BWF.setTo - 4, finalSetTo: BWF.finalSetTo - 4 };
    const award0 = await awardRow(w.id);
    const credited = award0.summary!.headline;
    for (const f of [first, second])
      expect((await awardFold(w, { ...stage, ...f })).summary.headline, `the premise: ${JSON.stringify(f)} keeps the credit`).toBe(credited);
    const stateCfg = async () => ((await awardRow(w.id)).state as { cfg?: Record<string, unknown> }).cfg;
    const stamp = async () => (await sql<{ u: Date }[]>`select updated_at u from match_states where fixture_id = ${w.id}`)[0]!.u.getTime();

    await writeFixtureRulesOverride(w.b.auth, [w.id], first);
    expect(await stateCfg()).toMatchObject(first);
    // A second correction: judged against the format the award now plays (the first), stored as a whole replace.
    await expect(writeFixtureRulesOverride(w.b.auth, [w.id], second)).resolves.toEqual({ fixtures: [{ id: w.id, started: true, rules_version: 0 }] });
    expect((await row(w.id)).rules_override).toEqual(second);
    expect(await stateCfg(), "the score is re-written under the second").toMatchObject(second);
    expect((await audit(w.id)).at(-1)!.payload).toMatchObject({ before: first, after: second, started: true });
    // Re-sending it: the same format, so no fit and no re-write.
    const t0 = await stamp();
    await writeFixtureRulesOverride(w.b.auth, [w.id], second);
    expect(await stamp(), "re-sending the format it plays re-writes nothing").toBe(t0);
    // A CLEAR: back to the stage's format — the cached score with it, never left on the cleared override's.
    await expect(writeFixtureRulesOverride(w.b.auth, [w.id], null)).resolves.toEqual({ fixtures: [{ id: w.id, started: true, rules_version: 0 }] });
    expect((await row(w.id)).rules_override).toBeNull();
    const cleared = await awardRow(w.id);
    expect((cleared.state as { cfg?: unknown }).cfg, "the score is re-written under the stage's format").toMatchObject({
      setTo: stage.setTo,
      finalSetTo: stage.finalSetTo,
    });
    expect(cleared.summary).toEqual((await awardFold(w, stage)).summary);
    expect([cleared.status, cleared.outcome], "the award stands throughout").toEqual([award0.status, award0.outcome]);
  }, 60_000);

  it("a stored award its own fold cannot reproduce is refused by name (409), never a 500 — and nothing is written", async () => {
    // Raw seed: an award naming a winner who holds neither seat — the walkover folds to the other side, so the stored
    // award is not what its own format decides. Fitting does not apply: FIXTURE_FORMAT_LOCKED.
    const b = await badmintonLeague();
    const id = b.fixtureIds[0]!;
    const { away } = await sides(id);
    await sql`update fixtures set status = 'forfeited',
                outcome = ${sql.json({ kind: "award", winner: randomUUID(), loser: away, reason: "withdrew" })} where id = ${id}`;
    const before = await row(id);
    const err = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: "FIXTURE_FORMAT_LOCKED", extra: { fixture_id: id, reason: "decided" } });
    expect(await row(id)).toEqual(before);
    expect(await audit(id)).toHaveLength(0);
  });

  it("a withdrawal's walkover over her dead seat (ruling 116): a correction that changes the credited score is refused; one that keeps it fits — the award stands, its score is re-written under the new format, no version bump", async () => {
    const w = await withdrawnWinnerWalkover();
    const before = await awardRow(w.id);
    const current = await padCfg(w.b, w.id);
    // Candidates from the preset's own values; the engine's walkover fold says which keep the credited score.
    const frags: Record<string, unknown>[] = [{ bestOf: BWF.bestOf + 2 }, { setTo: BWF.setTo - 6, finalSetTo: BWF.finalSetTo - 6 }];
    const verdicts = await Promise.all(frags.map(async (f) => (await awardFold(w, { ...current, ...f })).summary.headline === before.summary!.headline));
    expect(new Set(verdicts).size, "the premise: one of each verdict").toBe(2);
    let checked = 0;
    for (const [i, frag] of frags.entries()) {
      if (verdicts[i]) {
        const out = await writeFixtureRulesOverride(w.b.auth, [w.id], frag);
        expect(out.fixtures[0]).toEqual({ id: w.id, started: true, rules_version: 0 }); // no snapshot moved: no bump (P-1)
        const after = await awardRow(w.id);
        expect([after.status, after.outcome], "the award stands").toEqual([before.status, before.outcome]);
        const want = await awardFold(w, { ...current, ...frag });
        expect(after.summary, "its score is the award's own fold under the corrected format").toEqual(want.summary);
        // The fold's state carries the cfg it was folded under (the set kernel's `cfg`): the cached row is re-written,
        // not just left showing the same headline.
        expect((before.state as { cfg?: unknown }).cfg, "the premise: the cached state was folded under the old format").not.toMatchObject(frag);
        expect((after.state as { cfg?: unknown }).cfg).toMatchObject(frag);
        expect((await row(w.id)).rules_override).toEqual(frag);
        expect((await audit(w.id)).at(-1)!.payload).toMatchObject({ started: true, after: frag });
      } else {
        const r0 = await row(w.id);
        const err = await writeFixtureRulesOverride(w.b.auth, [w.id], frag).catch((e: unknown) => e);
        expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: w.id } });
        expect(String((err as Error).message)).toBe("This format would change the score as it stands");
        expect(await row(w.id)).toEqual(r0);
        expect(await awardRow(w.id)).toEqual(before);
      }
      checked++;
    }
    expect(checked).toBe(frags.length);
  }, 60_000);

  it("the same award over a frozen snapshot and a ledger every void took back (raw seed, Loop R M-17's takeover): a fitting correction re-freezes and bumps — it never un-decides the award or releases a seat", async () => {
    const w = await withdrawnWinnerWalkover();
    const current = await padCfg(w.b, w.id);
    // Raw seed: a Start every void took back, frozen under the current format — the ledger an award may take over.
    const startId = randomUUID();
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
              values (${startId}, ${w.id}, 1, 'core.start', ${sql.json({})}, now())`;
    await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at, voids_event_id)
              values (${randomUUID()}, ${w.id}, 2, 'core.void', ${sql.json({})}, now(), ${startId})`;
    await sql`update fixtures set config_snapshot = ${sql.json(current as never)} where id = ${w.id}`;
    const before = await awardRow(w.id);
    const next = (await fixtureRow(w.id)).winner_to_fixture!;
    const seatedNext = await fixtureRow(next);
    const frag = { setTo: BWF.setTo - 6, finalSetTo: BWF.finalSetTo - 6 };
    expect((await awardFold(w, { ...current, ...frag })).summary.headline, "the premise: it keeps the credited score").toBe(before.summary!.headline);
    const out = await writeFixtureRulesOverride(w.b.auth, [w.id], frag);
    expect(out.fixtures[0]).toEqual({ id: w.id, started: true, rules_version: 1 });
    const after = await awardRow(w.id);
    expect([after.status, after.outcome], "the award stands").toEqual([before.status, before.outcome]);
    expect((await row(w.id)).config_snapshot).toMatchObject(frag);
    expect(after.summary).toEqual((await awardFold(w, { ...current, ...frag })).summary);
    expect((after.state as { cfg?: unknown }).cfg, "the cached state is re-folded under the re-frozen format").toMatchObject(frag);
    // …at the ledger's tip: the token every append is checked against (`writeAwardedMatchState`, Loop R M-17).
    expect((await sql<{ s: number }[]>`select last_seq s from match_states where fixture_id = ${w.id}`)[0]!.s).toBe(2);
    expect(await fixtureRow(next), "the arriving side keeps her next seat").toEqual(seatedNext);
    // Re-sending it (fix round 2): the snapshot already holds it — no re-freeze, no second bump.
    await expect(writeFixtureRulesOverride(w.b.auth, [w.id], frag)).resolves.toEqual({ fixtures: [{ id: w.id, started: true, rules_version: 1 }] });
    expect((await row(w.id)).rules_version).toBe(1);
    // …and one that changes the credited score is refused here too.
    await expect(writeFixtureRulesOverride(w.b.auth, [w.id], { bestOf: BWF.bestOf + 2 })).rejects.toMatchObject({ code: "FORMAT_DOES_NOT_FIT_PLAY" });
  }, 60_000);
});

/** Every leaf an object sets, as [dotted path, value] — the property's agreement invariant reads leaves, because the
 *  writer stores leaves (carry (c)). */
function leaves(o: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? leaves(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]],
  );
}
const at = (o: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);

describe.skipIf(!HAS_DB)("rule 10 — override × start × correction × void × finalize", () => {
  const RUNS = 20;
  const MAX_OPS = 7;
  it("invariants after every step", async () => {
    let steps = 0;
    let voidsLanded = 0;
    let agreements = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom("write3", "write1", "clear", "start", "void", "finalize"), { minLength: 1, maxLength: MAX_OPS }), async (ops) => {
        const b = await badmintonLeague();
        const id = b.fixtureIds[0]!;
        let seq = 0;
        let finalized = false;
        let lastVersion = 0;
        const live: string[] = []; // unvoided, non-void event ids
        for (const op of ops) {
          steps++;
          if (op === "start" && seq === 0 && !finalized) {
            live.push((await appendEvent(b.auth.orgId, id, seq++, { type: "core.start", payload: {} })).event.id);
            continue;
          }
          if (op === "void" && live.length > 0 && !finalized) {
            const target = live.pop()!;
            const v = await appendEvent(b.auth.orgId, id, seq++, { type: "core.void", payload: {}, voids: target });
            expect(v.event.voids).toBe(target); // the void branch really ran
            voidsLanded++;
            continue;
          }
          if (op === "finalize") {
            await sql`update fixtures set status = 'finalized' where id = ${id}`;
            finalized = true;
            continue;
          }
          if (op !== "write3" && op !== "write1" && op !== "clear") continue;
          const frag = op === "clear" ? {} : { bestOf: op === "write1" ? 1 : 3 };
          const p = writeFixtureRulesOverride(b.auth, [id], frag);
          if (finalized) {
            await expect(p).rejects.toMatchObject({ code: "FIXTURE_FORMAT_LOCKED" });
            continue;
          }
          await p; // with no rally recorded, every one of these fits — a refusal here is a defect
          const r = await row(id);
          // A frozen snapshot always agrees with the stored override on every leaf the override sets.
          if (r.config_snapshot && r.rules_override) {
            for (const [path, v] of leaves(r.rules_override)) {
              expect(at(r.config_snapshot, path), path).toEqual(v);
              agreements++;
            }
          }
          // ...and an unstarted fixture's effective format is the override's.
          if (!r.config_snapshot) expect((await padCfg(b, id)).bestOf).toBe(op === "write1" ? 1 : SHORT.bestOf);
          expect(r.rules_version).toBeGreaterThanOrEqual(lastVersion); // the version never goes back
          lastVersion = r.rules_version;
        }
      }),
      { seed: 20261013, numRuns: RUNS },
    );
    expect(steps).toBeGreaterThan(0);
    expect(voidsLanded, "the seeded runs never reached a void after a start").toBeGreaterThan(0);
    expect(agreements, "the seeded runs never compared a frozen snapshot with a stored override").toBeGreaterThan(0);
  }, budget(RUNS * 2));
});
