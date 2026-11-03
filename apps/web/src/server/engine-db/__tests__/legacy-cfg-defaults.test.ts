// Live crash, stg 2026-11-03 (fixture 2f4a670d): every `badminton.rally` on a division stored before engine 041d70653f
// (S6/#416, 2026-08-11) added `records` to `SetBasedCfg` threw `Cannot read properties of undefined (reading
// 'expedite')` inside the fold — the write path, the read path and the pad alike, because the engine never parses the
// cfg it folds and the app resolved the fixture's cfg from the STORED division row (or its frozen snapshot) unparsed.
//
// Real Postgres, through the real producers: `appendEvent` (the write path every scorer reaches), `scoreEvent`, the
// read fold, the pad's loader, the live correction, the staff re-snapshot and the Swiss bye's freeze. The legacy shape
// is written with raw SQL because no door can write it any more (`createDivision` parses). The pure contract of the fill
// is `fixture-cfg-defaults.test.ts`. Expected scores are the rulebook's (a rally is one point); expected defaults are
// the engine's own `configSchema.parse`.
//
// Decision recorded here (owner brief, item 4): the freeze still writes the cfg AS STORED — `resolveFixtureCfg`'s
// "stored" form — so a snapshot holds exactly what it held before this fix, and every comparison against a stored
// snapshot (the correction's re-freeze test, the staff panel's divergence) still compares like with like.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { foldMatchWithStoppage, summaryOf, type EventEnvelope, type ScoreSummary } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { sql, withTenant } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { foldFixture } from "@/server/engine-db/fold";
import { fixtureConfigPanel, resnapshotFixtureConfig } from "@/server/usecases/admin-fixture-config";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { writeFixtureRulesOverride } from "@/server/usecases/fixture-rules";
import { loadFixturePadCfg } from "@/server/usecases/fixtures";
import { startDivision } from "@/server/usecases/schedule";
import { scoreEvent } from "@/server/usecases/scoring";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { seedBracket, type SeededBracket } from "./helpers/seed-bracket";
import { fixtureRow, playBadminton, rowsOf, type FixtureRow } from "./helpers/w2b-rig";

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
  if (m === undefined) throw new Error(`no builtin module ${key}`);
  return m;
};
type Cfg = Record<string, unknown>;
const badminton = mod("badminton");
const volleyball = mod("volleyball");
/** The stg division row, verbatim: badminton stored before `records` existed. */
const STG_CFG: Cfg = { cap: 30, setTo: 21, winBy: 2, bestOf: 3, pointsMap: { "*": [2, 0] }, finalSetTo: 21 };
const RECORDS = (badminton.configSchema.parse({}) as Cfg).records;

const row = async (id: string) =>
  (await sql<{ config_snapshot: Cfg | null; rules_version: number; home: string; away: string }[]>`
    select config_snapshot, rules_version, home_entrant_id as home, away_entrant_id as away from fixtures where id = ${id}`)[0]!;
const points = (s: ScoreSummary) => (s.detail as { points?: unknown }).points;
const readPoints = async (orgId: string, id: string) => points((await withTenant(orgId, (tx) => foldFixture(tx, id)))!.summary);
/** The legacy shape, raw: no door writes it any more (createDivision parses the config it stores). */
async function storeDivisionCfg(divisionId: string, cfg: Cfg): Promise<void> {
  const n = await sql`update divisions set config = ${sql.json(cfg as never)} where id = ${divisionId}`;
  expect(n.count, "the division row was rewritten").toBe(1);
  const [d] = await sql<{ config: Cfg }[]>`select config from divisions where id = ${divisionId}`;
  expect(d!.config, "premise: the row is the legacy shape").toEqual(cfg);
}
/** A badminton league whose stage plays its division as stored (no stage rules), its division rewritten to the stg row. */
async function legacyLeague(entrants = 2): Promise<SeededBracket> {
  const b = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants, stageRules: "division" });
  await storeDivisionCfg(b.divisionId, STG_CFG);
  expect(STG_CFG, "premise: the stg row has no records").not.toHaveProperty("records");
  return b;
}

describe.skipIf(!HAS_DB)("a division stored without records (the stg crash) scores through the real write path", () => {
  it("a start then a rally through appendEvent are accepted and score 1-0, the read fold agrees, and the first event freezes the cfg exactly as stored", async () => {
    const b = await legacyLeague();
    const id = b.fixtureIds[0]!;
    const { home } = await row(id);
    expect((await row(id)).config_snapshot, "premise: nothing frozen yet (the live branch)").toBeNull();
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    const r = await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    expect(points(r.summary)).toEqual({ home: 1, away: 0 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 1, away: 0 });
    // The freeze writes what it always wrote: the resolution AS STORED, no defaults added.
    expect((await row(id)).config_snapshot).toEqual(STG_CFG);
  });

  it("a frozen snapshot without records takes a rally, and the snapshot is left exactly as stored", async () => {
    const b = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "league", entrants: 2, stageRules: "division" });
    const id = b.fixtureIds[0]!;
    const [d] = await sql<{ config: Cfg }[]>`select config from divisions where id = ${b.divisionId}`;
    expect(d!.config, "premise: the live division HAS records, so only the frozen branch can crash").toHaveProperty("records");
    await sql`update fixtures set config_snapshot = ${sql.json(STG_CFG as never)}, config_snapshot_at = now() where id = ${id}`;
    const { home } = await row(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    const r = await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    expect(points(r.summary)).toEqual({ home: 1, away: 0 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 1, away: 0 });
    expect((await row(id)).config_snapshot).toEqual(STG_CFG);
  });

  it("the sequence: a second rally, a void of it, then a rally by the other side — each accepted, and the read fold agrees at every step", async () => {
    const b = await legacyLeague();
    const id = b.fixtureIds[0]!;
    const { home, away } = await row(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    const steps: [string, unknown][] = [];
    const second = await appendEvent(b.auth.orgId, id, 2, { type: "badminton.rally", payload: { wonBy: home } });
    steps.push(["second rally", points(second.summary)]);
    expect(points(second.summary)).toEqual({ home: 2, away: 0 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 2, away: 0 });
    const voided = await appendEvent(b.auth.orgId, id, 3, { type: "core.void", payload: {}, voids: second.event.id });
    steps.push(["void", points(voided.summary)]);
    expect(points(voided.summary)).toEqual({ home: 1, away: 0 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 1, away: 0 });
    const third = await appendEvent(b.auth.orgId, id, 4, { type: "badminton.rally", payload: { wonBy: away } });
    steps.push(["rally after the void", points(third.summary)]);
    expect(points(third.summary)).toEqual({ home: 1, away: 1 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 1, away: 1 });
    expect(steps, "every step ran").toHaveLength(3);
    expect((await row(id)).config_snapshot, "the snapshot is still the row as stored").toEqual(STG_CFG);
  });

  it("the pad's payload (loadFixturePadCfg, the console and the device pad) carries the engine's records and every stored key, live and frozen, and the engine's padSpec answers on it", async () => {
    expect(() => badminton.padSpec?.(STG_CFG as never), "premise: the raw row crashes the pad's spec").toThrow(TypeError);
    const b = await legacyLeague(3);
    const [live, frozen] = b.fixtureIds;
    await sql`update fixtures set config_snapshot = ${sql.json(STG_CFG as never)}, config_snapshot_at = now() where id = ${frozen!}`;
    let checked = 0;
    for (const id of [live!, frozen!]) {
      const { cfg } = await loadFixturePadCfg(b.auth, id);
      expect((cfg as Cfg).records, id).toEqual(RECORDS);
      expect(cfg, id).toMatchObject(STG_CFG);
      const spec = badminton.padSpec?.(cfg as never);
      expect(spec?.panels.length, "the spec has panels").toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a live correction of a started legacy match folds the corrected cfg filled: best of 3 to 5 fits, the snapshot re-frozen as stored, the version bumped", async () => {
    const b = await legacyLeague();
    const id = b.fixtureIds[0]!;
    const { home } = await row(id);
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    await appendEvent(b.auth.orgId, id, 1, { type: "badminton.rally", payload: { wonBy: home } });
    const out = await writeFixtureRulesOverride(b.auth, [id], { bestOf: 5 });
    expect(out.fixtures[0]).toEqual({ id, started: true, rules_version: 1 });
    const after = await row(id);
    expect(after.config_snapshot).toEqual({ ...STG_CFG, bestOf: 5 });
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 1, away: 0 });
  });

  it("the staff panel reads no divergence between a legacy snapshot and the live resolution, and a re-snapshot stores the resolution as stored", async () => {
    const b = await legacyLeague();
    const id = b.fixtureIds[0]!;
    await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
    const panel = await fixtureConfigPanel(id);
    expect(panel!.snapshot).toEqual(STG_CFG);
    expect(panel!.live).toEqual(STG_CFG);
    expect(panel!.diverged).toBe(false);
    const suffix = randomUUID().slice(0, 8);
    const [{ id: staff }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, is_staff, staff_role)
      values (${`staff-${suffix}@example.test`}, 'Staff', true, 'superadmin') returning id`;
    await resnapshotFixtureConfig(staff, id, "cfg defaults fix: re-snapshot a legacy fixture");
    expect((await row(id)).config_snapshot).toEqual(STG_CFG);
    expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 0, away: 0 });
  });
});

describe.skipIf(!HAS_DB)("volleyball beach keeps its own records through the write path", () => {
  it("live and frozen: a substitution is refused on beach (it records none) and a rally is accepted; the pad's cfg carries beach's records, never indoor's", async () => {
    const beach = volleyball.configSchema.parse(volleyball.variants.beach) as Cfg;
    const indoor = volleyball.configSchema.parse({}) as Cfg;
    expect((beach.records as Cfg).substitutions, "premise: beach records no substitutions").toBe(false);
    expect((indoor.records as Cfg).substitutions, "premise: the schema default (indoor) does").toBe(true);
    const b = await seedBracket({ sport: "volleyball", variant: "beach", stageKind: "league", entrants: 3, stageRules: "division" });
    const [frozenId, liveId] = b.fixtureIds;
    let checked = 0;
    for (const id of [frozenId!, liveId!]) {
      expect(((await loadFixturePadCfg(b.auth, id)).cfg as Cfg).records, id).toEqual(beach.records);
      const { home } = await row(id);
      await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
      if (id === liveId) {
        // The pre-V347 shape: a ledger with no snapshot, so the next append resolves the LIVE branch.
        await sql`update fixtures set config_snapshot = null, config_snapshot_at = null where id = ${id}`;
      } else {
        expect((await row(id)).config_snapshot, "the first event froze beach's records").toMatchObject({ records: beach.records });
      }
      await expect(appendEvent(b.auth.orgId, id, 1, { type: "volleyball.sub", payload: { by: home } })).rejects.toMatchObject({
        code: "INVALID_EVENT",
      });
      const r = await appendEvent(b.auth.orgId, id, 1, { type: "volleyball.rally", payload: { wonBy: home } });
      expect(points(r.summary), id).toEqual({ home: 1, away: 0 });
      checked++;
    }
    expect(checked).toBe(2);
  });
});

/** Review m1: badminton is not the only sport the set-based kernel scores. Every other sport declaring `records` (the
 *  engine's own variants, parsed, with `records` cut) is stored the legacy way and scored through `appendEvent`: the
 *  first rally folds the LIVE branch and freezes, the second folds the FROZEN one. */
const SET_SPORTS_WITHOUT_RECORDS = [
  ["tabletennis", "bo5"],
  ["volleyball", "indoor"],
] as const;
describe.skipIf(!HAS_DB)("the other set-based sports stored without records score through the real write path", () => {
  it.each(SET_SPORTS_WITHOUT_RECORDS)(
    "%s/%s: a rally on the live branch scores 1-0 and freezes the row as stored, a second rally on the frozen branch scores 2-0, the read fold and the pad agree",
    async (sport, variant) => {
      const m = mod(sport);
      const { records, ...legacy } = m.configSchema.parse(m.variants[variant]) as Cfg;
      expect(records, "premise: the sport declares records").toBeDefined();
      expect(() => m.padSpec?.(legacy as never), "premise: the raw row crashes the pad's spec").toThrow(TypeError);
      const b = await seedBracket({ sport, variant, stageKind: "league", entrants: 2, stageRules: "division" });
      await storeDivisionCfg(b.divisionId, legacy);
      const id = b.fixtureIds[0]!;
      const { home } = await row(id);
      expect((await row(id)).config_snapshot, "premise: nothing frozen yet (the live branch)").toBeNull();
      await appendEvent(b.auth.orgId, id, 0, { type: "core.start", payload: {} });
      const first = await appendEvent(b.auth.orgId, id, 1, { type: `${sport}.rally`, payload: { wonBy: home } });
      expect(points(first.summary)).toEqual({ home: 1, away: 0 });
      expect((await row(id)).config_snapshot, "the first event froze the row as stored").toEqual(legacy);
      const second = await appendEvent(b.auth.orgId, id, 2, { type: `${sport}.rally`, payload: { wonBy: home } });
      expect(points(second.summary)).toEqual({ home: 2, away: 0 });
      expect(await readPoints(b.auth.orgId, id)).toEqual({ home: 2, away: 0 });
      expect(((await loadFixturePadCfg(b.auth, id)).cfg as Cfg).records, "the pad's cfg carries the engine's records").toEqual(records);
    },
  );
});

/** Review m2: stg holds hockey (1) and ice hockey (5) divisions stored before `setPieceKinds` existed, and the pad's
 *  `padSpec` reads its `.length` - the pad would not open on them. The stored row is the engine's variant, parsed, with
 *  only `setPieceKinds` cut, so nothing but that key's default can make the spec answer. */
const PERIOD_SPORTS_WITHOUT_SET_PIECES = [
  ["hockey", "fih-outdoor"],
  ["icehockey", "iihf"],
] as const;
describe.skipIf(!HAS_DB)("hockey and ice hockey stored without setPieceKinds: the pad's payload opens", () => {
  it.each(PERIOD_SPORTS_WITHOUT_SET_PIECES)(
    "%s/%s: loadFixturePadCfg carries the engine's setPieceKinds, live and frozen, every stored key kept, and padSpec answers on it",
    async (sport, variant) => {
      const m = mod(sport);
      const { setPieceKinds, ...legacy } = m.configSchema.parse(m.variants[variant]) as Cfg;
      expect(setPieceKinds, "premise: the engine defaults setPieceKinds").toBeDefined();
      expect(() => m.padSpec?.(legacy as never), "premise: the raw row crashes the pad's spec").toThrow(TypeError);
      const b = await seedBracket({ sport, variant, stageKind: "league", entrants: 3, stageRules: "division" });
      await storeDivisionCfg(b.divisionId, legacy);
      const [live, frozen] = b.fixtureIds;
      await sql`update fixtures set config_snapshot = ${sql.json(legacy as never)}, config_snapshot_at = now() where id = ${frozen!}`;
      let checked = 0;
      for (const id of [live!, frozen!]) {
        const { cfg } = await loadFixturePadCfg(b.auth, id);
        expect((cfg as Cfg).setPieceKinds, id).toEqual(setPieceKinds);
        expect(cfg, id).toMatchObject(legacy);
        expect(m.padSpec?.(cfg as never)?.panels.length, "the spec has panels").toBeGreaterThan(0);
        checked++;
      }
      expect(checked).toBe(2);
    },
  );
});

describe.skipIf(!HAS_DB)("a Swiss bye on a legacy division freezes what a board's first event freezes", () => {
  it("the bye's snapshot and a board's are both the cfg as stored, and the board then scores a rally through scoreEvent", async () => {
    const { auth } = await seedOrg("pro");
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Legacy " + randomUUID().slice(0, 6), visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + randomUUID().slice(0, 6), sport_key: "badminton", variant_key: "bwf", config: {} });
    await createEntrants(auth, division.id, Array.from({ length: 5 }, (_, i) => ({ kind: "individual", display_name: `P${i + 1}`, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await sql`update stages set config = config - 'rules' where id = ${stage!.id}`;
    await storeDivisionCfg(division.id, STG_CFG);
    await startDivision(auth, division.id); // mints the round shells
    await generateStageFixtures(auth, stage!.id); // Pair round 1: the bye is awarded and frozen
    const rows = await sql<{ id: string; ext_key: string | null; away_entrant_id: string | null; home_entrant_id: string | null; config_snapshot: Cfg | null }[]>`
      select id, ext_key, away_entrant_id, home_entrant_id, config_snapshot from fixtures where stage_id = ${stage!.id} and round_no = 1`;
    const bye = rows.find((r) => r.ext_key === "sw-r1-bye");
    const board = rows.find((r) => r.ext_key !== "sw-r1-bye" && r.away_entrant_id !== null);
    expect(bye, "rig: round 1 has a bye").toBeDefined();
    expect(board, "rig: round 1 seats a board").toBeDefined();
    expect(bye!.config_snapshot).toEqual(STG_CFG);
    await scoreEvent(auth, board!.id, { expected_seq: 0, type: "core.start", payload: {} } as never);
    expect((await row(board!.id)).config_snapshot).toEqual(STG_CFG);
    const r = await scoreEvent(auth, board!.id, { expected_seq: 1, type: "badminton.rally", payload: { wonBy: board!.home_entrant_id } } as never);
    expect(r.seq).toBe(2);
    expect(await readPoints(auth.orgId, board!.id)).toEqual({ home: 1, away: 0 });
  }, 120_000);
});

describe.skipIf(!HAS_DB)("an award decided without play is refitted under the filled cfg on both sides", () => {
  /** A stored config missing a key whose default moves the walkover's credited score (`bestOf`: the sets a forfeit
   *  awards), beside `records`: the only legacy shape for which the two forms of the corrected cfg fold differently
   *  for this sport — so the one where a correction folded raw would be refused against a recorded fold folded filled. */
  const BWF = badminton.configSchema.parse(badminton.variants.bwf) as Cfg;
  const LEGACY = Object.fromEntries(Object.entries(BWF).filter(([k]) => k !== "records" && k !== "bestOf"));
  const forfeit = (lineups = { home: { entrantId: "H", slots: [] }, away: { entrantId: "A", slots: [] } }) => ({
    lineups,
    events: [{ id: "f", fixtureId: "f", seq: 1, type: "core.forfeit", payload: { by: "A", reason: "withdrew" }, recordedAt: "2026-11-03T00:00:00.000Z", recordedBy: null }] as EventEnvelope[],
  });
  const headline = (cfg: unknown) => {
    const { lineups, events } = forfeit();
    return summaryOf(badminton, foldMatchWithStoppage(badminton, cfg, lineups, events)).headline;
  };

  function siblingsInto(rows: readonly FixtureRow[]): { a: FixtureRow; b: FixtureRow; parentId: string } {
    const first = Math.min(...rows.map((r) => r.round_no));
    const r1 = rows.filter((r) => r.round_no === first && r.home_entrant_id && r.away_entrant_id);
    for (const a of r1) {
      const sib = r1.find((x) => x.id !== a.id && x.winner_to_fixture !== null && x.winner_to_fixture === a.winner_to_fixture);
      if (sib) return { a, b: sib, parentId: a.winner_to_fixture! };
    }
    throw new Error("rig: no two seated first-round lines feed one fixture");
  }

  it("ruling 116's walkover over a withdrawn winner's dead seat: a correction that keeps the credited score fits", async () => {
    const corrected = { ...LEGACY, setTo: 15, finalSetTo: 15 };
    expect(headline(corrected), "premise: raw, the corrected cfg credits a different walkover").not.toBe(headline(badminton.configSchema.parse(corrected)));
    const b = await seedBracket({ sport: "badminton", variant: "bwf", stageKind: "knockout", entrants: 8 });
    await storeDivisionCfg(b.divisionId, LEGACY);
    const { a, b: sib, parentId } = siblingsInto(await rowsOf(b.stageId));
    const w1 = (await playBadminton(b.auth, a.id, true)).home_entrant_id!;
    await withdrawEntrantCascade(b.auth, w1);
    const arriving = (await playBadminton(b.auth, sib.id, true)).home_entrant_id!;
    const tie = await fixtureRow(parentId);
    expect([tie.status, tie.outcome], "premise: a walkover naming who withdrew").toEqual([
      "forfeited",
      { kind: "award", winner: arriving, loser: w1, reason: "withdrew" },
    ]);
    expect((await row(parentId)).config_snapshot, "premise: nothing froze its cfg").toBeNull();
    const out = await writeFixtureRulesOverride(b.auth, [parentId], { setTo: 15, finalSetTo: 15 });
    expect(out.fixtures[0]).toMatchObject({ id: parentId, started: true });
    expect((await fixtureRow(parentId)).outcome, "the award stands").toEqual(tie.outcome);
  }, 120_000);
});
