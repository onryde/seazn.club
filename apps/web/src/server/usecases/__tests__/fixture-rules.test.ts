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
import { foldMatchWithStoppage, outcomeOf, summaryOf } from "@seazn/engine/core";
import { fixtureKeysFor, sportTopKeys, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { canonicalJson } from "@/lib/canonical-json";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { loadFoldInputs } from "@/server/engine-db/fold";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { resnapshotFixtureConfig } from "../admin-fixture-config";
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
const fixtureNo = async (id: string) =>
  (await sql<{ fixture_no: number }[]>`select fixture_no from fixtures where id = ${id}`)[0]!.fixture_no;

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
    const ot = parsedVariant<{ overtime: { minutes: number } & Record<string, unknown> }>("icehockey", "iihf").overtime;
    const b = await seedBracket({ sport: "icehockey", variant: "iihf", stageKind: "knockout", entrants: 2 });
    const id = b.fixtureIds[0]!;
    await expect(writeFixtureRulesOverride(b.auth, [id], { overtime: { ...ot, minutes: ot.minutes + 1 } })).rejects.toMatchObject({
      status: 400,
      code: "RULE_NOT_SETTABLE",
      extra: { fixture_id: id, field: "overtime.minutes" },
    });
    await writeFixtureRulesOverride(b.auth, [id], { overtime: { ...ot, minutes: ot.minutes - 1 } });
    const cfg = await padCfg(b, id);
    expect(ice.configSchema.safeParse(cfg).success, "the resolved cfg is a valid ice hockey cfg").toBe(true);
    expect((cfg.overtime as { minutes: number }).minutes).toBe(ot.minutes - 1);
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
    expect(err).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: id } });
    expect(String((err as Error).message)).toBe("This format would end the match as it stands");
    expect(await row(id)).toEqual(before);
    expect(await audit(id)).toHaveLength(0);
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
        extra: { fixture_id: b.fixtureIds[0] },
      });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("after a void that empties the play, a correction still refolds (the ledger, not the score, decides)", async () => {
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
