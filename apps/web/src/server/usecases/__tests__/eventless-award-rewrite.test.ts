// W2c batch-3 I1 (ruling, under the owner's standing instruction): a walkover no event records is stored once —
// `writeAwardedMatchState` writes its `match_states` row when the award lands (F14's departed qualifier at Generate,
// `stages.ts`; ruling 116's arriving side over a dead seat) and no read path refolds it. So a stage-rules save or a
// division save that moves a key the award's fold reads (`bestOf` on a set sport, football's `awardScore`, any key
// `awardedMatchState` reads) RE-WRITES those walkovers' stored score in the same transaction — never refuses: a
// walkover has no play to misfit, and the winner never changes. The stored row must equal the engine's own walkover
// fold (`awardedMatchState`) under the format the match now resolves (the pad's cfg, `loadFixturePadCfg`) — the
// expectation is the engine's, never the save's.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { canonicalJson } from "@/lib/canonical-json";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { awardedMatchState } from "@/server/engine-db/awarded-state";
import { formatStanding } from "@/server/engine-db/format-standing";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { loadFixturePadCfg } from "../fixtures";
import { putStageRules } from "../stage-rules";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { lockedStageIdsAmong } from "../rule-locks";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";
import { movingFragment } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;

// The save's refusal arm (`award-rewrite.ts`) is reached by no shipped sport's walkover — none refuses a forfeit or
// decides another award for a format (award-fit.test.ts's header). It is a guard, so the last describe reaches it
// through the real saves by steering the engine's verdict for ONE named fixture; every other call is the real one.
const steer = vi.hoisted(() => ({ refuse: new Set<string>() }));
vi.mock("@/server/engine-db/awarded-state", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/engine-db/awarded-state")>();
  return {
    ...real,
    awardFoldsUnder: (...args: Parameters<typeof real.awardFoldsUnder>) =>
      steer.refuse.has(args[4].fixtureId) ? { ok: false as const, reason: "steered: this format refuses the walkover" } : real.awardFoldsUnder(...args),
  };
});

// W2c Task 11 (carry (b) of the batch-3 re-review): a save that re-writes a walkover's stored score must reach the public
// pages. The spy wraps the REAL revalidation (it still runs); it only records which division was asked for.
const revalidated = vi.hoisted(() => [] as { divisionId: string; competitionId: string | undefined }[]);
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...real,
    fireDivisionRevalidate: (...args: Parameters<typeof real.fireDivisionRevalidate>) => {
      revalidated.push({ divisionId: args[0], competitionId: args[1] });
      return real.fireDivisionRevalidate(...args);
    },
  };
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no sport ${key}`);
  return m as AnySportModule;
};

interface Walkover {
  auth: AuthCtx;
  sport: string;
  module: AnySportModule;
  divisionId: string;
  stageId: string;
  /** The F14 walkover: an award over two seated sides, no event behind it. */
  id: string;
  home: string;
  away: string;
  /** Every OTHER seated line of the draw. */
  others: string[];
}

/** F14 through the real producers (departed-qualifier-walkover.test.ts's rig): a knockout drawing from a frozen
 *  `config.qualified` list, its last qualifier withdrawn BEFORE Generate — her line generates as a walkover over two
 *  seated sides, its score written beside it and no event recording it. */
async function f14Walkover(sport: string, variant: string, field = 8): Promise<Walkover> {
  const m = mod(sport);
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "I1 " + suffix, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + suffix,
    sport_key: sport,
    variant_key: variant,
    config: m.variants[variant] as Record<string, unknown>,
  });
  const kind = m.entrantModel?.defaultKind ?? "individual";
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: field }, (_, i) => ({ kind, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, [{ seq: 1, kind: "knockout", name: "Finals", config: {} }]);
  await sql`update stages set config = ${sql.json({ qualified: entrants.map((e) => e.id) } as never)} where id = ${stage!.id}`;
  const departed = entrants.at(-1)!.id;
  await withdrawEntrantCascade(auth, departed);
  await generateStageFixtures(auth, stage!.id);
  const rows = await sql<{ id: string; home: string | null; away: string | null; status: string; outcome: { kind?: string; loser?: string } | null }[]>`
    select id, home_entrant_id as home, away_entrant_id as away, status, outcome from fixtures where stage_id = ${stage!.id}`;
  const wo = rows.find((r) => r.status === "forfeited" && r.outcome?.kind === "award" && r.outcome.loser === departed);
  if (wo === undefined || wo.home === null || wo.away === null) throw new Error(`${sport}: rig — the departed qualifier's line is no seated walkover`);
  expect(Number((await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${wo.id}`)[0]!.n), `${sport}: the premise: no event records it`).toBe(0);
  expect((await sql<{ s: unknown }[]>`select config_snapshot s from fixtures where id = ${wo.id}`)[0]!.s, `${sport}: the premise: nothing froze its cfg`).toBeNull();
  expect(await stored(wo.id), `${sport}: the premise: its score is stored`).not.toBeNull();
  const others = rows.filter((r) => r.id !== wo.id && r.home !== null && r.away !== null && r.status === "scheduled").map((r) => r.id);
  return { auth, sport, module: m, divisionId: division.id, stageId: stage!.id, id: wo.id, home: wo.home, away: wo.away, others };
}

interface Stored {
  summary: { headline: string } & Record<string, unknown>;
  state: Record<string, unknown>;
  updated_at: Date;
}
async function stored(id: string): Promise<Stored | null> {
  const [r] = await sql<Stored[]>`select summary, state, updated_at from match_states where fixture_id = ${id}`;
  return r ?? null;
}

/** The format the match resolves to NOW, as the pad reads it. */
const padCfg = async (w: Walkover) => (await loadFixturePadCfg(w.auth, w.id)).cfg;

/** The engine's walkover under `cfg` — `awardedMatchState`, the expectation (never the save's own write). */
async function fold(w: Walkover, cfg: unknown) {
  const lineups = await withTenant(w.auth.orgId, (tx) => loadLineupPair(tx, w.id, w.home, w.away));
  const outcome = (await sql<{ o: unknown }[]>`select outcome o from fixtures where id = ${w.id}`)[0]!.o;
  return awardedMatchState(w.module, cfg, lineups, outcome as never, { fixtureId: w.id, recordedAt: new Date().toISOString() });
}

/** Stored = the engine's fold under the format it now resolves: the summary, and the cfg the state was folded under
 *  (a fitting change can keep the headline, so the folded cfg is the re-write's witness — fix round 1). */
async function expectStoredIsTheFold(w: Walkover, label: string) {
  const want = await fold(w, await padCfg(w));
  const got = (await stored(w.id))!;
  expect(got.summary, `${label}: the stored score`).toEqual(want.summary);
  expect(got.state.cfg ?? null, `${label}: the cfg the stored state was folded under`).toEqual((want.state as { cfg?: unknown }).cfg ?? null);
  return want;
}

const currentConfig = async (divisionId: string) =>
  (await sql<{ c: Record<string, unknown> }[]>`select config c from divisions where id = ${divisionId}`)[0]!.c;

describe.skipIf(!HAS_DB)("X-SR-5 I1 a format save re-writes the walkovers no event records", () => {
  it("badminton, the STAGE door: a stage-rules save moving bestOf re-writes the F14 walkover's score under the new format; clearing the rules re-writes it back", async () => {
    // single-sport: the set-sport headline (bestOf) read as a number; every sport's stage door and division door are swept below.
    const w = await f14Walkover("badminton", "bwf");
    const before = await expectStoredIsTheFold(w, "the premise, as generated");
    const bestOf = Number((await padCfg(w) as { bestOf: number }).bestOf) + 2;
    const moved = await fold(w, { ...((await padCfg(w)) as object), bestOf });
    expect(moved.summary.headline, "the premise: the new format credits a different score").not.toBe(before.summary.headline);

    await putStageRules(w.auth, w.stageId, { rules: { bestOf } });
    const after = await expectStoredIsTheFold(w, "after the stage save");
    expect(after.summary.headline).toBe(moved.summary.headline);
    expect((after.state as { cfg?: { bestOf?: unknown } }).cfg?.bestOf).toBe(bestOf);

    // The second call: back to the division's format — the stored score follows it back.
    await putStageRules(w.auth, w.stageId, { rules: null });
    const back = await expectStoredIsTheFold(w, "after clearing the stage rules");
    expect(back.summary).toEqual(before.summary);
  }, 60_000);

  it("badminton, the DIVISION door: a division save moving bestOf re-writes it; re-sending the same save re-writes nothing", async () => {
    // single-sport: the same set-sport headline as the stage door (bestOf); every sport's division door is swept below.
    const w = await f14Walkover("badminton", "bwf");
    const before = (await stored(w.id))!;
    const config = await currentConfig(w.divisionId);
    const bestOf = Number((config as { bestOf?: number }).bestOf ?? ((await padCfg(w)) as { bestOf: number }).bestOf) + 2;
    await patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } });
    const after = await expectStoredIsTheFold(w, "after the division save");
    expect(after.summary.headline, "the score moved with the format").not.toBe(before.summary.headline);
    const t0 = (await stored(w.id))!.updated_at.getTime();
    await patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } });
    expect((await stored(w.id))!.updated_at.getTime(), "the same save again moves nothing the award reads").toBe(t0);
  }, 60_000);

  it("football, a STARTED knockout: the division's awardScore (a table key no knockout table guards) re-writes the F14 walkover's goals", async () => {
    // single-sport: football's awardScore is the walkover's goals (`displayedGoals`) and a points-scope key, the one
    // the knockout table-key skip lets through on a started stage (rule-locks.ts).
    const w = await f14Walkover("football", "11-a-side");
    const line = w.others[0]!;
    await appendEvent(w.auth.orgId, line, 0, { type: "core.start", payload: {} });
    // An award AFTER play is no walkover: its score is its ledger's fold, never re-written by a save. Its cfg un-frozen
    // (a pre-V347 row), so the save DOES move the format it resolves — only the "no standing event" filter keeps it out.
    const playedAward = w.others[1]!;
    const [pa] = await sql<{ away: string }[]>`select away_entrant_id as away from fixtures where id = ${playedAward}`;
    await appendEvent(w.auth.orgId, playedAward, 0, { type: "core.start", payload: {} });
    await appendEvent(w.auth.orgId, playedAward, 1, { type: "core.forfeit", payload: { by: pa!.away, reason: "disqualified" } } as never);
    await sql`update fixtures set config_snapshot = null, config_snapshot_at = null where id = ${playedAward}`;
    const playedBefore = (await stored(playedAward))!;
    expect(playedBefore, "the premise: the played award has its ledger's fold").not.toBeNull();
    const before = (await stored(w.id))!;
    const config = await currentConfig(w.divisionId);
    const cfgNow = (await padCfg(w)) as { awardScore: { goals: number } };
    const goals = cfgNow.awardScore.goals + 2;
    const moved = await fold(w, { ...cfgNow, awardScore: { goals } });
    expect(moved.summary.headline, "the premise: the new award credits a different score").not.toBe(before.summary.headline);
    const out = await patchDivision(w.auth, w.divisionId, { config: { ...config, awardScore: { goals } } });
    expect((out as { refused?: unknown[] }).refused ?? [], "the premise: the started knockout lets awardScore through").toEqual([]);
    const after = await expectStoredIsTheFold(w, "after the division save");
    expect(after.summary.headline).toBe(moved.summary.headline);
    expect(await stored(playedAward), "the award after play keeps its ledger's fold").toEqual(playedBefore);
  }, 60_000);

  it("every sport's STAGE door: a stage-rules save that moves the format re-writes the F14 walkover; clearing the rules re-writes it back (counted)", async () => {
    let walkovers = 0;
    let moved = 0;
    let witnessedCfg = 0;
    const swept: string[] = [];
    for (const m of builtinModules) {
      const variant = Object.keys(m.variants)[0]!;
      const w = await f14Walkover(m.key, variant);
      walkovers++;
      // A (key, value) a knockout stage can save that the division does not already hold: the engine's parse of the preset
      // with and without it (a save of the held value moves nothing, and the sweep would pass with no re-write).
      const pick = movingFragment(m as AnySportModule, variant, "knockout");
      expect(pick, `${m.key}: some knockout stage rule moves the format`).not.toBeNull();
      const cfgBefore = canonicalJson(await padCfg(w));
      await putStageRules(w.auth, w.stageId, { rules: pick!.frag });
      if (canonicalJson(await padCfg(w)) !== cfgBefore) moved++;
      const after = await expectStoredIsTheFold(w, `${m.key}.${pick!.key} saved on the stage`);
      if ((after.state as { cfg?: unknown }).cfg !== undefined) witnessedCfg++;
      // The second call: back to the division's format - the stored score follows it back.
      await putStageRules(w.auth, w.stageId, { rules: null });
      await expectStoredIsTheFold(w, `${m.key} after clearing the stage rules`);
      expect(canonicalJson(await padCfg(w)), `${m.key}: cleared, the format is the division's again`).toBe(cfgBefore);
      swept.push(`${m.key}.${pick!.key}`);
    }
    console.info(`I1 stage sweep: ${walkovers} sports with an F14 walkover, ${swept.length} re-written through a stage save (${swept.join(", ")})`);
    expect(walkovers, "anti-vacuity: every registered sport was asked").toBe(builtinModules.length);
    expect(swept.length).toBe(walkovers);
    expect(moved, "every sport's stage save moved the walkover's resolved format").toBe(walkovers);
    expect(witnessedCfg, "every sport's stored award state carries the cfg it was folded under, so a stale row is visible").toBe(walkovers);
  }, 900_000);

  it("every sport's division door: a change of variant re-writes the F14 walkover under the format it now resolves (counted)", async () => {
    let walkovers = 0;
    let moved = 0;
    const swept: string[] = [];
    for (const m of builtinModules) {
      const variants = Object.keys(m.variants);
      const w = await f14Walkover(m.key, variants[0]!);
      walkovers++;
      const cfgBefore = canonicalJson(await padCfg(w));
      // The first other declared variant the division accepts (a doubles preset refuses a field of singles entrants:
      // ENTRANT_KIND_IN_USE, nothing to do with the award).
      let landed: string | null = null;
      for (const v of variants.slice(1)) {
        try {
          await patchDivision(w.auth, w.divisionId, { variant_key: v });
          landed = v;
          break;
        } catch (err) {
          if ((err as { code?: unknown }).code !== "ENTRANT_KIND_IN_USE") throw err;
        }
      }
      expect(landed, `${m.key}: some other declared variant is accepted`).not.toBeNull();
      // The premise the sweep rests on: the change moved the format the walkover resolves — or stored = resolved
      // would hold with no re-write at all.
      if (canonicalJson(await padCfg(w)) !== cfgBefore) moved++;
      await expectStoredIsTheFold(w, `${m.key} → ${landed}`);
      swept.push(`${m.key}:${landed}`);
    }
    console.info(`I1 sweep: ${walkovers} sports with an F14 walkover, ${swept.length} re-written through a variant change (${swept.join(", ")})`);
    expect(walkovers, "anti-vacuity: every registered sport was asked").toBe(builtinModules.length);
    expect(swept.length).toBe(walkovers);
    expect(moved, "every sport's variant change moved the walkover's resolved format").toBe(walkovers);
  }, 600_000);
});

describe.skipIf(!HAS_DB)("X-SR-5 I1 a save that re-writes a walkover revalidates the division's public pages", () => {
  it("the division door: revalidated when the save re-wrote a walkover, not when nothing was re-written (the empty case first)", async () => {
    // single-sport: the revalidation call is sport-blind; the per-sport re-write is swept above.
    const w = await f14Walkover("badminton", "bwf");
    const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${w.divisionId}`;
    const config = await currentConfig(w.divisionId);
    const bestOf = Number((config as { bestOf?: number }).bestOf ?? ((await padCfg(w)) as { bestOf: number }).bestOf) + 2;
    const mine = () => revalidated.filter((r) => r.divisionId === w.divisionId);

    revalidated.length = 0;
    await patchDivision(w.auth, w.divisionId, { name: "Renamed " + randomUUID().slice(0, 4) });
    expect(mine(), "a save that moves no format re-writes nothing and revalidates nothing").toEqual([]);

    await patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } });
    expect(mine(), "the save re-wrote the walkover: its public pages are told, with the competition").toEqual([{ divisionId: w.divisionId, competitionId }]);

    revalidated.length = 0;
    await patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } });
    expect(mine(), "the same save again re-writes nothing: nothing to tell").toEqual([]);
  }, 60_000);

  it("the stage door: revalidated by the save", async () => {
    const w = await f14Walkover("badminton", "bwf");
    const bestOf = Number(((await padCfg(w)) as { bestOf: number }).bestOf) + 2;
    revalidated.length = 0;
    await putStageRules(w.auth, w.stageId, { rules: { bestOf } });
    expect(revalidated.filter((r) => r.divisionId === w.divisionId)).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!HAS_DB)("I1 one 'started': every format door reads format-standing.ts", () => {
  it("six fixture shapes: the stage lock locks on PLAYED only, the per-match writer reports PLAYED or DECIDED WITHOUT PLAY (counted)", async () => {
    // single-sport: the shapes are ledger shapes (a frozen cfg, an event, a void, an award), the same in every sport.
    const w = await f14Walkover("badminton", "bwf", 16);
    expect(w.others.length, "the premise: five other seated lines").toBeGreaterThanOrEqual(5);
    const [started, voided, legacy, unstarted, refrozen] = w.others as [string, string, string, string, string];
    const locked = () => withTenant(w.auth.orgId, (tx) => lockedStageIdsAmong(tx, [w.stageId]));

    // The ruling: a walkover decided without play locks no format — the save re-writes its score instead.
    expect(await locked(), "only the walkover is decided: the stage is not locked").toEqual(new Set());

    await appendEvent(w.auth.orgId, started, 0, { type: "core.start", payload: {} });
    await appendEvent(w.auth.orgId, voided, 0, { type: "core.start", payload: {} });
    const [{ id: startId }] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${voided} and type = 'core.start'`;
    await appendEvent(w.auth.orgId, voided, 1, { type: "core.void", payload: {}, voids: startId });
    await appendEvent(w.auth.orgId, legacy, 0, { type: "core.start", payload: {} });
    await sql`update fixtures set config_snapshot = null, config_snapshot_at = null where id = ${legacy}`;
    // A frozen cfg and no event. No product path leaves one (the freeze rides the first event, the staff re-freeze
    // refuses a fixture with no snapshot, and nothing deletes events), so it is raw-seeded: D1's predicate counts the
    // snapshot on its own, and this is the shape that tells that half from the event half.
    await sql`update fixtures set config_snapshot = ${sql.json((await loadFixturePadCfg(w.auth, refrozen)).cfg as never)}, config_snapshot_at = now() where id = ${refrozen}`;
    expect(Number((await sql<{ n: number }[]>`select count(*)::int n from score_events where fixture_id = ${refrozen}`)[0]!.n), "the premise: no event").toBe(0);

    // Each shape's standing BY DEFINITION (format-standing.ts's header), never read off the code.
    const shapes: { label: string; id: string; played: boolean; decidedWithoutPlay: boolean }[] = [
      { label: "unstarted", id: unstarted, played: false, decidedWithoutPlay: false },
      { label: "F14 walkover", id: w.id, played: false, decidedWithoutPlay: true },
      { label: "started (frozen cfg + an event)", id: started, played: true, decidedWithoutPlay: false },
      { label: "its only event voided", id: voided, played: true, decidedWithoutPlay: false },
      { label: "events, no frozen cfg (pre-V347)", id: legacy, played: true, decidedWithoutPlay: false },
      { label: "a frozen cfg, no event (raw-seeded)", id: refrozen, played: true, decidedWithoutPlay: false },
    ];
    let checked = 0;
    for (const sh of shapes) {
      expect(await withTenant(w.auth.orgId, (tx) => formatStanding(tx, sh.id)), sh.label).toEqual({
        played: sh.played,
        decidedWithoutPlay: sh.decidedWithoutPlay,
      });
      // The writer's own word for it (a clearing write over no override: it moves nothing on any of the five).
      const out = await writeFixtureRulesOverride(w.auth, [sh.id], null);
      expect(out.fixtures[0]?.started, `${sh.label}: the writer's 'started'`).toBe(sh.played || sh.decidedWithoutPlay);
      checked++;
    }
    expect(checked, "anti-vacuity: every shape was asked").toBe(shapes.length);
    expect(shapes.filter((sh) => sh.played).length, "both answers are witnessed").toBe(4);
    expect(await locked(), "a played line locks the stage").toEqual(new Set([w.stageId]));
  }, 120_000);
});

describe.skipIf(!HAS_DB)("I1 the save's one refusal: an award that will not hold under the new format", () => {
  it("both doors refuse by name (409 FORMAT_DOES_NOT_FIT_PLAY, the match and the engine's reason) and write nothing; unsteered, the same save goes through", async () => {
    // single-sport: the arm is steered (above), so the sport only supplies a real walkover and a real save.
    const w = await f14Walkover("badminton", "bwf");
    const no = (await sql<{ n: number | null }[]>`select fixture_no n from fixtures where id = ${w.id}`)[0]!.n;
    const name = no === null ? "This match" : `Match ${no}`;
    const config = await currentConfig(w.divisionId);
    const bestOf = Number(((await padCfg(w)) as { bestOf: number }).bestOf) + 2;
    const before = (await stored(w.id))!;
    const stageBefore = (await sql<{ c: unknown }[]>`select config c from stages where id = ${w.stageId}`)[0]!.c;
    steer.refuse.add(w.id);
    try {
      const doors: [string, () => Promise<unknown>][] = [
        ["stage", () => putStageRules(w.auth, w.stageId, { rules: { bestOf } })],
        ["division", () => patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } })],
      ];
      let refused = 0;
      for (const [door, save] of doors) {
        const err = await save().catch((e: unknown) => e);
        expect(err, door).toMatchObject({ status: 409, code: "FORMAT_DOES_NOT_FIT_PLAY", extra: { fixture_id: w.id, fixture_no: no } });
        // The engine's own sentence is no fit reason: nothing for a client to say better (batch-3 M1).
        expect((err as { extra: Record<string, unknown> }).extra.fit_reason, door).toBeUndefined();
        expect(String((err as Error).message), door).toBe(`${name}: steered: this format refuses the walkover`);
        refused++;
      }
      expect(refused, "anti-vacuity: both doors asked").toBe(2);
      expect(await stored(w.id), "nothing re-written").toEqual(before);
      expect(await currentConfig(w.divisionId), "the division save rolled back").toEqual(config);
      expect((await sql<{ c: unknown }[]>`select config c from stages where id = ${w.stageId}`)[0]!.c, "the stage save rolled back").toEqual(stageBefore);
    } finally {
      steer.refuse.delete(w.id);
    }
    // Positive pair: the same save, the real verdict — it goes through and re-writes.
    await patchDivision(w.auth, w.divisionId, { config: { ...config, bestOf } });
    await expectStoredIsTheFold(w, "unsteered");
  }, 120_000);
});
