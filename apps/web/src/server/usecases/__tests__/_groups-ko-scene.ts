// Shared by the W5 app PR B best-Nth suites (pool-results-seam.test.ts, bestnth-unequal-pools.test.ts): a groups_ko division
// built by the template, its group stage drawn and started, every meeting decided through the scorer's door (`scoreEvent`).
// Extracted verbatim from pool-results-seam.test.ts (Task 0) and extended (Task 4) with a late entrant into a started pool
// (RB5-L11: the catch-up lines are the real `admitTableLateEntrant`), a leaver withdrawn before any result through the real
// cascade (`withdrawEntrantCascade`; her lines voided, so the plan's meetings with her are skipped), an optional Reinstate
// (`patchEntrant`), and a hook over the knockout's progression before it is stored. Real Postgres required.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { defaultCrossGroup } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { buildTemplateStages } from "@/lib/format-templates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { scoreEvent } from "../scoring";
import { createStages, generateStageFixtures, getSeedProposal } from "../stages";
import { storeAsOnComplete } from "./_stored-on-complete";
import { withdrawEntrantCascade } from "../withdrawal";
import { seedOrg } from "./_seed";

export type Sport = "generic" | "boardgame";
/** One meeting inside a pool, by the members' places in seed order (0 = the pool's top seed): `w` beats `l`, `score` for generic. */
export type Meeting = { w: number; l: number; score?: readonly [number, number] };

export interface Scene {
  auth: AuthCtx;
  divId: string;
  srcId: string;
  koId: string;
  /** The pools by key, each member list in seed order. */
  pools: { key: string; members: string[] }[];
}

export async function post(auth: AuthCtx, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const [{ n }] = await sql<{ n: number }[]>`select coalesce(max(seq), 0)::int as n from score_events where fixture_id = ${fixtureId}`;
  await scoreEvent(auth, fixtureId, { expected_seq: n, type, payload });
}

/** A groups_ko division built by the template, its group stage drawn, every meeting decided as `plan` says (by the pool's size). */
export async function scene(o: {
  sport: Sport;
  entrants: number;
  poolCount: number;
  qualified: number;
  timing: "setup" | "on_complete";
  plan: (size: number) => readonly Meeting[];
  rngSeed?: (pools: Scene["pools"]) => number;
  /** T4: a late entrant into this pool after Start (a line of the pool started first, RB5-L11); she sorts last in her pool. */
  lateInto?: string;
  /** T4: the entrant(s) withdrawn after Start, before any result (0 played: RB5-W2 expunges each and voids her lines). */
  leaver?: (pools: Scene["pools"]) => string | string[];
  /** T4: Reinstate the leaver straight after (the real `patchEntrant` door: her table_withdrawal row is voided). */
  reinstate?: boolean;
  /** T4 part 2 (C9): the leaver first plays this many of her own meetings (in plan order), then withdraws - at half or more of
   *  her lines played RB5-W2 awards the rest as walkovers (policy `walkover`) instead of expunging her. Default 0. */
  leaverPlays?: number;
  /** T4 part 2 (X-UP-4): runs after each pool's last meeting is decided, before the next pool's first (pool order). */
  afterPool?: (key: string, pools: Scene["pools"], srcId: string) => Promise<void>;
  /** T4: rewrite the knockout's stored progression (e.g. a pre-ruling-286 flag). */
  progression?: (p: Record<string, unknown>) => Record<string, unknown>;
}): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "PR " + o.sport, visibility: "private", branding: {} });
  const [variant] = await sql<{ key: string; config: Record<string, unknown> }[]>`
    select key, config from sport_variants where sport_key = ${o.sport} and is_system order by key limit 1`;
  expect(variant, `${o.sport} has a system variant`).toBeDefined();
  const div = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: o.sport, variant_key: variant!.key, config: variant!.config } as never);
  await createEntrants(auth, div.id, Array.from({ length: o.entrants }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })));
  const drafts = buildTemplateStages("groups_ko", { qualified: o.qualified, poolCount: o.poolCount, swissRounds: 3, legs: 1 });
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config: d.config,
      progression: d.progression === null ? null : (o.progression ?? ((x) => x))({ ...d.progression, timing: "setup" }),
    })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  // Saved as `setup` (the save door judges an `on_complete` shape - see _stored-on-complete.ts), stored as the scene's timing.
  if (o.timing === "on_complete") for (const s of stages) if (s.seq > 1) await storeAsOnComplete(s.id);
  // The setup path proposes INTO the knockout's TBD lines, so they exist first; the on_complete path seeds before any draw.
  if (o.timing === "setup") await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);
  await startDivision(auth, div.id);
  const poolRows = await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${src.id} order by key`;
  const started = new Set<string>();
  if (o.lateInto !== undefined) {
    const into = poolRows.find((p) => p.key === o.lateInto);
    expect(into, `pool ${o.lateInto} exists`).toBeDefined();
    const [line] = await sql<{ id: string }[]>`select id from fixtures where stage_id = ${src.id} and pool_id = ${into!.id} order by round_no, seq_in_round limit 1`;
    await post(auth, line!.id, "core.start");
    started.add(line!.id);
    await createEntrants(auth, div.id, [{ kind: "individual", display_name: "Late", seed: null, members: [], late_entry_pool: o.lateInto } as never]);
  }

  const seeds = new Map((await sql<{ id: string; seed: number | null }[]>`select id, seed from entrants where division_id = ${div.id}`).map((e) => [e.id, e.seed ?? Number.MAX_SAFE_INTEGER]));
  const fx = await sql<{ id: string; pool_id: string; home_entrant_id: string; away_entrant_id: string }[]>`
    select id, pool_id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${src.id}`;
  const pools = poolRows.map((p) => ({
    key: p.key,
    members: [...new Set(fx.filter((f) => f.pool_id === p.id).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))].sort((a, b) => seeds.get(a)! - seeds.get(b)!),
  }));
  if (o.rngSeed) await sql`update stages set config = config || ${sql.json({ rngSeed: o.rngSeed(pools) } as never)} where id = ${src.id}`;
  const leavers = o.leaver ? [o.leaver(pools)].flat() : [];
  const decide = async (p: Scene["pools"][number], m: Meeting): Promise<void> => {
    const winner = p.members[m.w]!;
    const loser = p.members[m.l]!;
    const f = fx.find((x) => (x.home_entrant_id === winner && x.away_entrant_id === loser) || (x.home_entrant_id === loser && x.away_entrant_id === winner));
    expect(f, `pool ${p.key}: ${m.w} v ${m.l} is a fixture`).toBeDefined();
    if (!started.has(f!.id)) await post(auth, f!.id, "core.start");
    if (o.sport === "boardgame") {
      await post(auth, f!.id, "boardgame.result", { winner, method: "resign" });
    } else {
      const [ws, ls] = m.score!;
      await post(auth, f!.id, "generic.result", f!.home_entrant_id === winner ? { p1Score: ws, p2Score: ls } : { p1Score: ls, p2Score: ws });
    }
  };
  // A full round robin: every pair of the pool meets once (legs 1), and the plan names each pair exactly once.
  const plans = pools.map((p) => {
    const meetings = o.plan(p.members.length);
    expect(meetings.length, `pool ${p.key}: the plan decides every meeting`).toBe((p.members.length * (p.members.length - 1)) / 2);
    return { p, meetings };
  });
  // C9: the leaver's first `leaverPlays` meetings are decided BEFORE she withdraws (the rest are the cascade's walkovers, or voids).
  const playedFirst = new Set<Meeting>();
  for (const { p, meetings } of plans) {
    for (const id of leavers) {
      const hers = meetings.filter((m) => p.members[m.w] === id || p.members[m.l] === id).slice(0, o.leaverPlays ?? 0);
      for (const m of hers) {
        await decide(p, m);
        playedFirst.add(m);
      }
    }
  }
  for (const id of leavers) {
    await withdrawEntrantCascade(auth, id);
    if (o.reinstate) await patchEntrant(auth, id, { status: "registered" });
  }
  // A leaver still away has her remaining lines voided (or walked over) by the cascade: those meetings are not played.
  const away = new Set(o.reinstate ? [] : leavers);

  let decided = playedFirst.size;
  for (const { p, meetings } of plans) {
    for (const m of meetings) {
      if (playedFirst.has(m) || away.has(p.members[m.w]!) || away.has(p.members[m.l]!)) continue;
      await decide(p, m);
      decided++;
    }
    await o.afterPool?.(p.key, pools, src.id);
  }
  expect(decided, "meetings decided").toBe(fx.filter((f) => !away.has(f.home_entrant_id) && !away.has(f.away_entrant_id)).length + playedFirst.size);
  return { auth, divId: div.id, srcId: src.id, koId: ko.id, pools };
}

/** The proposal's best-Nth seats, in seed order: the qualifiers read from no group (a `best_nth` descriptor names none). */
export async function proposedBestNth(s: Scene): Promise<{ bestNth: string[]; winners: string[] }> {
  const proposal = await getSeedProposal(s.auth, s.koId);
  expect(proposal?.status, "the completion proposed the knockout").toBe("draft");
  const q = [...proposal!.computed.qualifiers].sort((a, b) => a.rank - b.rank);
  return { bestNth: q.filter((x) => x.source.group === undefined).map((x) => x.entrantId), winners: q.filter((x) => x.source.group !== undefined).map((x) => x.entrantId) };
}

export const variantConfig = async (sport: Sport) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from sport_variants where sport_key = ${sport} and is_system order by key limit 1`)[0]!.config;
/** The sport's declared cross-group order (engine `defaultCrossGroup` over its group cascade): the comparison's keys. */
export const declaredCrossGroup = async (sport: Sport) =>
  defaultCrossGroup(builtinModules.find((m) => m.key === sport)!.defaultTiebreakers("group", (await variantConfig(sport)) as never));


/** The public dictionary's own copy in `locale`, interpolated as the runtime's `t` does: the footnote's text, never typed here. */
export function publicT(locale: "en" | "es" | "fr" | "nl"): (key: string, vars?: Record<string, string | number>) => string {
  const dict = JSON.parse(readFileSync(new URL(`../../../dictionaries/${locale}/public.json`, import.meta.url), "utf8")) as Record<string, string>;
  return (key, vars) => {
    const s = dict[key];
    if (s === undefined) throw new Error(`public.json (${locale}) has no ${key}`);
    return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
  };
}
