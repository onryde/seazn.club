// W5 app PR A, Task 24 (T5-b): P7 - the manual rank override, scoped PER POOL (RB5-P5, ST-G14) and refused on a stage with no table (RB5-P7, ruling 288).
// Planned ONLY by `--set w1-driving --scenario W5A_P7` on the table rows (w5a-cells.ts).
//
// The script plays stage 1 to its last result, then - before /complete - pins ranks through the real endpoint:
//   step 1  the table's LAST-ranked entrant of the first pool is pinned to rank 1 (a pin that MOVES somebody: the premise names the entrant it displaces);
//   step 2  a second override names ONLY the other pool (a league: the same, single, pool): the first pool's pin stands, the named pool's pins are
//           REPLACED (planRankOverride: "a second override of pool B leaves pool A's pins alone"). On a league that is the replacement of the one pin;
//   refused (RB5-P5)   the same rank twice in one pool, and a rank above the pool's size - both 422 RR_RANK_OVERRIDE_POOL, and neither moves the table;
//   refused (RB5-P7)   a pin on a stage that is not a table (a knockout, a stepladder, a page playoff) - 422 RR_RANK_OVERRIDE_NOT_TABLE, and the stage stores none.
// Expected values are the rulebook's: a pinned entrant ranks 1 in its pool, every other row keeps its relative order behind it; the table the run ends
// with seeds the destination (the stage's cut is read off the PINNED table - the seam from the pin to the seeding, not only to the page).
import { DriverMisuse, RefusedCall, type OrganiserDriver, type StandingsOut } from "../driver/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, setUpDivision } from "./common.ts";
import { takesOf } from "./advance.ts";
import { eligibleCut } from "./q2-departed-qualifier.ts";
import { type Scenario } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { attempt, finishRun, poolsOf } from "./w5a-table.ts";

export const RANK_OVERRIDE_POOL_CODE = "RR_RANK_OVERRIDE_POOL";
export const RANK_OVERRIDE_NOT_TABLE_CODE = "RR_RANK_OVERRIDE_NOT_TABLE";
const TABLE_KINDS: ReadonlySet<string> = new Set(["league", "group", "swiss", "americano"]);

const byRank = (rows: StandingsOut["rows"]): StandingsOut["rows"] => [...rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

/** One pool's table after a pin: the pinned entrant first at rank 1, every other row behind it with its relative order kept (ranks non-decreasing in
 *  the order the table had before; a tie stays a tie, never reordered). `natural`: the pool's rows before ANY pin. */
export function pinnedTableItems(label: string, natural: StandingsOut["rows"], after: StandingsOut["rows"], pinned: string | null): Item[] {
  const items: Item[] = [
    { ok: natural.length > 0, note: `${label}: the pool's table held no row before the pin` },
    { ok: after.length === natural.length, note: `${label}: ${after.length} row(s) after the pin, ${natural.length} before - a pin reorders, it never adds or drops a row` },
  ];
  const rest = byRank(natural).filter((r) => r.entrantId !== pinned);
  const post = new Map(after.map((r) => [r.entrantId, r.rank] as const));
  if (pinned !== null) {
    items.push({ ok: post.get(pinned) === 1, note: `${label}: the pinned entrant ranks ${post.get(pinned) ?? "(none)"}, expected 1 (RB5-P5)` });
    for (const r of rest) items.push({ ok: (post.get(r.entrantId) ?? 0) >= 2, note: `${label}: ${r.entrantId} ranks ${post.get(r.entrantId) ?? "(none)"} behind a pin on rank 1, expected 2 or lower` });
  }
  for (let i = 1; i < rest.length; i++) {
    const a = post.get(rest[i - 1]!.entrantId);
    const b = post.get(rest[i]!.entrantId);
    items.push({ ok: a !== undefined && b !== undefined && a !== null && b !== null && a <= b, note: `${label}: ${rest[i - 1]!.entrantId} (${a ?? "-"}) now ranks behind ${rest[i]!.entrantId} (${b ?? "-"}) - the pin changed the unpinned order` });
  }
  return items;
}

/** A refused override: the named refusal, and the table it left exactly as it was. */
export function refusedOverrideItems(label: string, refusal: RefusedCall | undefined | unknown, code: string, before: StandingsOut["rows"], after: StandingsOut["rows"]): Item[] {
  const r = refusal instanceof RefusedCall ? refusal : undefined;
  return [
    { ok: r !== undefined, note: `${label}: the override was accepted - expected 422 ${code}` },
    { ok: r?.status === 422 && r?.code === code, note: `${label}: refused ${r?.status ?? "-"} ${r?.code ?? "(no code)"}, expected 422 ${code}` },
    { ok: after.length === before.length && after.every((row, i) => row.entrantId === before[i]?.entrantId && row.rank === before[i]?.rank), note: `${label}: the table changed after a refused override` },
  ];
}

function drivesOverride(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "overrideRanks" | "stagePools">> {
  return d.overrideRanks !== undefined && d.stagePools !== undefined;
}

const p7: Scenario = {
  key: "W5A_P7",
  entrantCount: 6,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_P7", ctx.spec.row));
    const d = ctx.driver;
    if (!drivesOverride(d)) throw new DriverMisuse("driver: W5A_P7 needs overrideRanks and stagePools - the HTTP driver has them, a layer that does not drive the path says so");
    const stage = setup.stage;
    const items: Item[] = [];
    const reason = "matrix: organiser pin (W5A_P7)";
    const pinnedAtEnd = new Map<string | null, string>();

    const finished = await finishRun(
      ctx, rec, setup,
      async (plays, observed) => {
        // the non-table refusal (RB5-P7), on every stage of the row that is no table; the pin must not be stored
        const nonTable = setup.stages.filter((s) => !TABLE_KINDS.has(s.kind));
        const anyone = setup.entrants[0]!.id;
        for (const s of nonTable) {
          const out = await attempt(rec, `override on the ${s.kind} stage`, () => d.overrideRanks(s.id, [{ entrant_id: anyone, rank: 1, reason }]));
          const stored = (await d.listStages(setup.division.id)).find((x) => x.id === s.id)?.config.rank_overrides;
          items.push(...refusedOverrideItems(`stage ${s.seq} (${s.kind})`, out, RANK_OVERRIDE_NOT_TABLE_CODE, [], []));
          items.push({ ok: !Array.isArray(stored) || stored.length === 0, note: `stage ${s.seq} (${s.kind}): a refused pin was STORED (${JSON.stringify(stored)}) - RB5-P7 refuses before the write` });
        }
        items.push({ ok: true, note: `non-table stages of the row: ${nonTable.length}` });
        // the seam to the seeding: the destination's cut read off the PINNED final table
        const advance = plays[1]?.advance ?? null;
        const source = observed.stages.find((s) => s.id === stage.id);
        if (setup.stages.length > 1 && advance !== null && advance.status === 200 && source !== undefined) {
          const body = setup.built.posted.stages.find((b) => b.seq === setup.stages[1].seq);
          if (body !== undefined) {
            const owed = eligibleCut(takesOf(body), source.standings, new Set(), advance.tiePicked);
            for (const e of owed.must) items.push({ ok: advance.seeded.includes(e), note: `${e}: a qualifier by the PINNED final table, not seeded (the pin must reach the seeding)` });
            for (const [pool, e] of pinnedAtEnd) {
              const table = source.standings.find((t) => t.poolId === pool);
              items.push({ ok: table?.rows.find((r) => r.entrantId === e)?.rank === 1, note: `${e}: pinned to rank 1 in ${pool ?? "the league"}, ranks ${table?.rows.find((r) => r.entrantId === e)?.rank ?? "(none)"} in the stage's final table` });
            }
          }
        }
        return [assertion("w5a-p7-rank-override-per-pool", items)];
      },
      {
        beforeComplete: async (st) => {
          const pools = (await poolsOf(ctx, st.id)).pools;
          const poolIds: (string | null)[] = pools.length === 0 ? [null] : pools.map((p) => p.id);
          const natural = new Map<string | null, StandingsOut["rows"]>();
          for (const id of poolIds) natural.set(id, (await d.standings(st.id, id)).rows);
          const lastOf = (id: string | null): string => {
            const rows = byRank(natural.get(id)!);
            const last = rows[rows.length - 1];
            if (last === undefined) throw new Error("scenario: W5A_P7's pool has an empty table before any pin");
            return last.entrantId;
          };
          // step 1: the first pool's last-ranked entrant to rank 1
          const first = poolIds[0]!;
          await d.overrideRanks(st.id, [{ entrant_id: lastOf(first), rank: 1, reason }]);
          pinnedAtEnd.set(first, lastOf(first));
          const afterOne = new Map<string | null, StandingsOut["rows"]>();
          for (const id of poolIds) afterOne.set(id, (await d.standings(st.id, id)).rows);
          items.push(...pinnedTableItems(`step 1, ${first ?? "the league"}`, natural.get(first)!, afterOne.get(first)!, lastOf(first)));
          for (const id of poolIds.slice(1)) items.push({ ok: JSON.stringify(afterOne.get(id)!.map((r) => [r.entrantId, r.rank])) === JSON.stringify(natural.get(id)!.map((r) => [r.entrantId, r.rank])), note: `step 1: pool ${id} changed on a pin the body did not name it in (RB5-P5: per pool)` });
          // step 2: a second override naming ONE pool - the other pool when there is one, else the league's again with a different entrant
          const second = poolIds.length > 1 ? poolIds[1]! : first;
          const target2 = second === first ? byRank(natural.get(first)!)[0]!.entrantId : lastOf(second);
          if (second === first && target2 === lastOf(first)) throw new Error("scenario: W5A_P7's league has one row, nothing to replace a pin with");
          await d.overrideRanks(st.id, [{ entrant_id: target2, rank: 1, reason }]);
          pinnedAtEnd.set(second, target2);
          const afterTwo = new Map<string | null, StandingsOut["rows"]>();
          for (const id of poolIds) afterTwo.set(id, (await d.standings(st.id, id)).rows);
          items.push(...pinnedTableItems(`step 2, ${second ?? "the league"}`, natural.get(second)!, afterTwo.get(second)!, target2));
          if (second !== first) {
            // the first pool's pin stands: a second override names only the other pool (RB5-P5)
            items.push(...pinnedTableItems(`step 2, ${first ?? "the league"} (kept)`, natural.get(first)!, afterTwo.get(first)!, lastOf(first)));
          } else {
            // the single pool's pin was REPLACED: the first pin no longer holds rank 1
            items.push({ ok: afterTwo.get(first)!.find((r) => r.entrantId === lastOf(first))?.rank !== 1, note: `step 2: the replaced pin still holds rank 1 (${lastOf(first)}) - a second override of the same pool replaces its pins` });
            pinnedAtEnd.delete(first);
            pinnedAtEnd.set(second, target2);
          }
          // refused: the same rank twice in one pool; a rank above the pool's size - neither moves the table
          const size = natural.get(first)!.length;
          const members = byRank(natural.get(first)!);
          if (members.length >= 2) {
            const dup = await attempt(rec, "the same rank twice in one pool", () => d.overrideRanks(st.id, [{ entrant_id: members[0]!.entrantId, rank: 1, reason }, { entrant_id: members[1]!.entrantId, rank: 1, reason }]));
            items.push(...refusedOverrideItems("the same rank twice in one pool (RB5-P5)", dup, RANK_OVERRIDE_POOL_CODE, afterTwo.get(first)!, (await d.standings(st.id, first)).rows));
          } else items.push({ ok: false, note: "the first pool holds fewer than two rows - the duplicate-rank refusal cannot be reached" });
          const above = await attempt(rec, "a rank above the pool's size", () => d.overrideRanks(st.id, [{ entrant_id: members[0]!.entrantId, rank: size + 1, reason }]));
          items.push(...refusedOverrideItems(`a rank above the pool's size ${size} (RB5-P5)`, above, RANK_OVERRIDE_POOL_CODE, afterTwo.get(first)!, (await d.standings(st.id, first)).rows));
        },
      },
    );
    return finished;
  },
};

export const w5aP7Scenarios: Readonly<Partial<Record<"W5A_P7", Scenario>>> = Object.freeze({ W5A_P7: p7 });
