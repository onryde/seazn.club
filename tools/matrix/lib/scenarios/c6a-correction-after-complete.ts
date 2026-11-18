// W5 app PR A, Task 24 (T5-b): C6a - a result CORRECTED inside a COMPLETED league or group whose cut has been CONFIRMED but whose destination has not
// started (RB5-K6, X-CUT-4, FX-G16's table half). The confirmed proposal goes stale and its seats go back; the organiser re-proposes and re-confirms.
// Planned ONLY by `--set w1-driving --scenario W5A_C6A` on the fed table rows (w5a-cells.ts).
//
// The correction is the console's own: the newest entry of a decided fixture is VOIDED (the match is open again, its result gone), through the real
// route; later the same entry is posted AGAIN (the result is back). The fixture is the one that crosses the cut's edge (one side inside the cut, the
// other the next in line), closest ranks first, so the void is the correction most likely to move the cut - and the script tries the next candidate
// when it does not, restoring the first, and fails by name when none moved it (a script that never moves the cut proves nothing of RB5-K6).
//   after the void   the cut (read off the stage's own table, the Q2 oracle) differs; the destination's seats are back - no entrant seated (RB5-K6);
//   after the repost the table is the table it was; the organiser re-proposes and re-confirms; the destination seats the original cut again.
import { DriverMisuse, type FixtureRow, type OrganiserDriver } from "../driver/types.ts";
import type { StagePostBody } from "../catalogue.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, liveEvents, recordPosted, setUpDivision } from "./common.ts";
import { confirmAdvance, sourcePoolCount, takesOf, type AdvanceObs, type TakeRule } from "./advance.ts";
import { eligibleCut } from "./q2-departed-qualifier.ts";
import type { ObservedStage } from "../observed.ts";
import { VOID_EVENT } from "../driver/types.ts";
import { type Scenario } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { finishRun, poolsOf, stageLines } from "./w5a-table.ts";

type Tables = ObservedStage["standings"];
const everyone = (c: ReturnType<typeof eligibleCut>): Set<string> => new Set([...c.must, ...c.ties.flatMap((t) => [...t.members])]);
const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((e) => b.has(e));

export interface CorrectionObs {
  readonly takes: readonly TakeRule[];
  /** The stage's tables before the correction, after the void, and after the repost. */
  readonly before: Tables;
  readonly afterVoid: Tables;
  readonly afterRepost: Tables;
  /** The destination's seated entrants: at the confirm, just after the void, and after the re-confirm. */
  readonly seatedConfirmed: ReadonlySet<string>;
  readonly seatedAfterVoid: ReadonlySet<string>;
  readonly seatedFinal: ReadonlySet<string>;
  /** What the first confirm seeded, and what the re-confirm did. */
  readonly seededFirst: readonly string[];
  readonly reconfirmStatus: number;
  readonly tiePicked: boolean;
}

/** The C6a items, every one counted. */
export function correctionItems(o: CorrectionObs): Item[] {
  const cutBefore = everyone(eligibleCut(o.takes, o.before, new Set(), o.tiePicked));
  const cutVoid = everyone(eligibleCut(o.takes, o.afterVoid, new Set(), o.tiePicked));
  const cutBack = everyone(eligibleCut(o.takes, o.afterRepost, new Set(), o.tiePicked));
  const rank = (t: Tables): string => JSON.stringify(t.map((x) => [x.poolId, x.rows.map((r) => [r.entrantId, r.rank])]));
  return [
    // premises
    { ok: cutBefore.size > 0, note: "the cut read off the stage's table is empty - nothing was confirmed to correct" },
    { ok: same(cutBefore, o.seatedConfirmed), note: `the destination seated ${[...o.seatedConfirmed].length} entrant(s) at the confirm, the table's cut is ${cutBefore.size}: the premise (a confirmed cut that the table gives) does not hold` },
    { ok: !same(cutBefore, cutVoid), note: "the correction did not move the cut (every candidate fixture was tried) - the script proves nothing of RB5-K6" },
    // RB5-K6: the confirmed proposal went stale, its seats went back
    { ok: o.seatedAfterVoid.size === 0, note: `${o.seatedAfterVoid.size} entrant(s) still seated in the destination after a correction that moved the cut (RB5-K6: before the destination starts, the seats go back)` },
    // the repost restores the table, then re-propose and re-confirm
    { ok: rank(o.before) === rank(o.afterRepost), note: "the table after the repost is not the table before the correction - the repost did not restore the result" },
    { ok: same(cutBefore, cutBack), note: "the cut after the repost is not the cut before the correction" },
    { ok: o.reconfirmStatus === 200, note: `the re-confirm answered ${o.reconfirmStatus}, expected 200 (RB5-K6: re-propose and re-confirm)` },
    { ok: same(o.seatedFinal, cutBefore), note: `the destination seats ${o.seatedFinal.size} entrant(s) after the re-confirm, expected the original cut of ${cutBefore.size}, the same entrants` },
    { ok: o.seededFirst.length === cutBefore.size, note: `the first confirm seeded ${o.seededFirst.length}, the table's cut is ${cutBefore.size}` },
  ];
}

function drivesCorrection(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "stagePools">> {
  return d.stagePools !== undefined;
}

const c6a: Scenario = {
  key: "W5A_C6A",
  entrantCount: 6,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_C6A", ctx.spec.row));
    const d = ctx.driver;
    if (!drivesCorrection(d)) throw new DriverMisuse("driver: W5A_C6A needs stagePools - the HTTP driver has it, a layer that does not drive the path says so");
    if (setup.stages.length < 2) throw new Error(`scenario: W5A_C6A needs a fed row, ${ctx.spec.row} has ${setup.stages.length} stage`);
    const source = setup.stage;
    const target = setup.stages[1];
    const body = setup.built.posted.stages.find((b) => b.seq === target.seq) as StagePostBody | undefined;
    const sourceBody = setup.built.posted.stages.find((b) => b.seq === source.seq) as StagePostBody | undefined;
    if (body === undefined || sourceBody === undefined) throw new Error("scenario: W5A_C6A's posted stage bodies are missing");
    const takes = takesOf(body);
    let obs: CorrectionObs | null = null;
    let why: string | null = null;

    const tablesOf = async (): Promise<Tables> => {
      const pools = (await poolsOf(ctx, source.id)).pools;
      const ids: (string | null)[] = pools.length === 0 ? [null] : pools.map((p) => p.id);
      const out: Tables = [];
      for (const id of ids) out.push({ poolId: id, rows: (await d.standings(source.id, id)).rows.map((r) => ({ entrantId: r.entrantId, rank: r.rank, points: r.points ?? null })) });
      return out;
    };
    const seatedOfTarget = async (): Promise<Set<string>> => new Set((await stageLines(ctx, setup, target.id)).flatMap((l) => [l.home, l.away]).filter((e): e is string => e !== null));
    let n = 0;
    /** Voids the fixture's newest live entry and keeps the harness's own record of it (fold parity, VOIDPROOF's rule). */
    const voidNewest = async (f: FixtureRow): Promise<{ index: number } | null> => {
      const prior = rec.streams.get(f.id);
      if (prior === undefined) return null;
      const live = liveEvents(prior);
      const last = live[live.length - 1];
      if (last === undefined) return null;
      const index = prior.lastIndexOf(last);
      const voided = await d.voidLast(f.id);
      if (voided.voidedType !== last.type) { why = `voidLast took a ${voided.voidedType}, the harness's newest live entry is a ${last.type}`; return null; }
      rec.streams.set(f.id, [...prior, { type: VOID_EVENT, payload: { event_id: String(index + 1) } }]);
      rec.events += 1;
      return { index };
    };
    const repost = async (f: FixtureRow, index: number): Promise<void> => {
      const prior = rec.streams.get(f.id)!;
      const event = prior[index]!;
      const posted = await d.postStream(f.id, [event], `${ctx.tag}:${f.id}:c6a${n++}`);
      recordPosted(rec, f.id, prior, [event], posted);
      rec.events += 1;
    };

    const out = await finishRun(
      ctx, rec, setup,
      () => [assertion("w5a-c6a-correction-after-complete", obs === null
        ? [{ ok: false, note: why ?? "the correction never ran (the destination was not confirmed)" }]
        : correctionItems(obs))],
      {
        afterAdvance: async (stage, advance: AdvanceObs) => {
          if (advance.status !== 200) { why = `the destination's confirm answered ${advance.status}`; return; }
          const before = await tablesOf();
          const seatedConfirmed = await seatedOfTarget();
          const cutSet = everyone(eligibleCut(takes, before, new Set(), advance.tiePicked));
          const rankOf = new Map(before.flatMap((t) => t.rows.map((r) => [r.entrantId, r.rank ?? 99] as const)));
          const fixtures = (await d.listFixtures(setup.division.id)).filter((f) => f.stage_id === source.id && f.home_entrant_id !== null && f.away_entrant_id !== null && rec.streams.has(f.id));
          // the fixtures that cross the cut's edge, the closest ranks first
          const candidates = fixtures
            .filter((f) => cutSet.has(f.home_entrant_id!) !== cutSet.has(f.away_entrant_id!))
            .sort((a, b) => Math.abs(rankOf.get(a.home_entrant_id!)! - rankOf.get(a.away_entrant_id!)!) - Math.abs(rankOf.get(b.home_entrant_id!)! - rankOf.get(b.away_entrant_id!)!))
            .slice(0, 4);
          if (candidates.length === 0) { why = "no decided fixture crosses the cut's edge"; return; }
          for (const f of candidates) {
            const voided = await voidNewest(f);
            if (voided === null) return;
            const afterVoid = await tablesOf();
            if (same(cutSet, everyone(eligibleCut(takes, afterVoid, new Set(), advance.tiePicked)))) { await repost(f, voided.index); continue; }
            const seatedAfterVoid = await seatedOfTarget();
            await repost(f, voided.index);
            const afterRepost = await tablesOf();
            // re-propose and re-confirm (RB5-K6)
            const fresh = await d.recomputeSeedProposal(target.id);
            const listed = (await d.listFixtures(setup.division.id)).filter((x) => x.stage_id === source.id);
            const named = new Set(listed.filter((x) => x.pool_id !== null).map((x) => x.pool_id!));
            const pools = sourcePoolCount(sourceBody, setup.entrants.length, named);
            const again = await confirmAdvance(ctx, rec, stage, { id: fresh.id, status: fresh.status }, body, pools);
            obs = { takes, before, afterVoid, afterRepost, seatedConfirmed, seatedAfterVoid, seatedFinal: await seatedOfTarget(), seededFirst: advance.seeded, reconfirmStatus: again.status, tiePicked: advance.tiePicked || again.tiePicked };
            return;
          }
          why = `none of the ${candidates.length} fixture(s) crossing the cut's edge moved it when voided - the script proves nothing of RB5-K6`;
        },
      },
    );
    return out;
  },
};

export const w5aC6aScenarios: Readonly<Partial<Record<"W5A_C6A", Scenario>>> = Object.freeze({ W5A_C6A: c6a });
