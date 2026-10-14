// W2c batch-3 I1 (ruling, under the owner's standing instruction): a walkover no event records is stored once —
// `writeAwardedMatchState` writes its `match_states` row when the award lands (F14's departed qualifier at Generate,
// `stages.ts`; ruling 116's arriving side over a dead seat) and no read path refolds it. So a stage-rules save or a
// division save that moves a key the award's fold reads (`bestOf` on a set sport, football's `awardScore`, any key
// `awardedMatchState` reads) RE-WRITES those walkovers' stored score in the same transaction — never refuses: a
// walkover has no play to misfit, and the winner never changes. The stored row must equal the engine's own walkover
// fold (`awardedMatchState`) under the format the match now resolves (the pad's cfg, `loadFixturePadCfg`) — the
// expectation is the engine's, never the save's.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { canonicalJson } from "@/lib/canonical-json";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db";
import { awardedMatchState } from "@/server/engine-db/awarded-state";
import { loadLineupPair } from "@/server/engine-db/lineups";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { loadFixturePadCfg } from "../fixtures";
import { putStageRules } from "../stage-rules";
import { createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

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

describe.skipIf(!HAS_DB)("I1 a format save re-writes the walkovers no event records", () => {
  it("badminton, the STAGE door: a stage-rules save moving bestOf re-writes the F14 walkover's score under the new format; clearing the rules re-writes it back", async () => {
    // single-sport: the stage door serves the set sports only (STAGE_RULES_SPORTS) until Task 11; the division door is swept below.
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
  }, 60_000);

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
