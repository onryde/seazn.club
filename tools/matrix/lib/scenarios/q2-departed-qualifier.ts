// W5 app PR A, Task 24 (T5-b): Q2 - the top qualifier of a league or group source withdraws just before the stage completes. RB5-K1/K2/K3 (owner
// ruling 278): the departed LEAVES the cut, the NEXT ELIGIBLE entrant of the table takes the seat, and the table keeps their row, marked (RB5-W1).
// Planned ONLY by `--set w1-driving --scenario W5A_Q2` on the table rows a later stage is fed from (w5a-cells.ts).
//
// The script plays stage 1 to its last result, then - before /complete - withdraws the entrant the table ranks FIRST (the surest member of any cut:
// rankRange 1..n, top n of a pool). The standard loop completes the stage and confirms the proposal the completion drafted; the entrants the
// destination then seats are judged against a cut DERIVED from the stage's own final table less the departed, never from the product's proposal:
//   RB5-K1  the departed is not seeded;
//   RB5-K2  each take offers its seats to the first N ELIGIBLE entrants of its table(s), so the seat the departed would have held goes to the next
//           eligible (RB4-V6 is the destination's half; the seed set is this task's).
// The existing advance-seeded-as-declared accepts a destination SHORT by the departed (the FP-2 leave-empty model); this check does not - a backfill
// is owed, so the seeded count is the declared one.
import { DriverMisuse, type OrganiserDriver } from "../driver/types.ts";
import { assertion, type Item } from "./assertions.ts";
import { Recorder, setUpDivision } from "./common.ts";
import { takesOf, type TakeRule } from "./advance.ts";
import type { ObservedStage } from "../observed.ts";
import { type Scenario } from "./types.ts";
import { w5aField } from "../w5a-cells.ts";
import { finishRun, poolsOf, withdrawEntrant } from "./w5a-table.ts";

type Tables = ObservedStage["standings"];

/** What a cut owes: `must` seats are certain (strictly ahead of every tie at the cut's edge); a tie straddling the edge owes `count` of its
 *  `members` - which of them is X-PD-8's basis-tie order, not this script's question (the harness records "seeding tie(s) picked"). */
export interface CutOwed { readonly must: Set<string>; readonly ties: { readonly members: Set<string>; readonly count: number }[] }

/** The take's seats over the source tables with `departed` excluded: the first N eligible per table, in table order. Throws on a take kind the
 *  W5A rows do not use (a guard, not a comment: a row that gained one is a script to extend, never a silent zero). */
export function eligibleCut(takes: readonly TakeRule[], tables: Tables, departed: ReadonlySet<string>, tiePicked = false): CutOwed {
  const owed: CutOwed = { must: new Set(), ties: [] };
  const take = (rows: Tables[number]["rows"], from: number, to: number): void => {
    const sorted = rows.filter((r) => !departed.has(r.entrantId)).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
    const inside = sorted.slice(from - 1, to);
    if (inside.length === 0) return;
    const last = inside[inside.length - 1];
    const edge = last.rank ?? Infinity;
    // A tie at the cut's edge: equal rank; and, when the confirm itself picked a tie ("seeding tie(s) picked", observed.ts seeding_tie_picked), equal
    // POINTS - the confirm orders level rows by the product's listed order, which the table's tiebreak ranks need not match (X-PD-8, ruling 288).
    const level = sorted.filter((r) => ((r.rank ?? Infinity) === edge) || (tiePicked && r.points !== null && r.points === last.points));
    const sure = inside.filter((r) => !level.includes(r));
    sure.forEach((r) => owed.must.add(r.entrantId));
    const want = inside.length - sure.length;
    if (level.length === want) level.forEach((r) => owed.must.add(r.entrantId));
    else owed.ties.push({ members: new Set(level.map((r) => r.entrantId)), count: want });
  };
  for (const t of takes) {
    switch (t.kind) {
      case "rankRange": {
        const sole = tables.length === 1 ? tables[0] : tables.find((x) => x.poolId === null);
        if (sole === undefined) throw new Error("Q2: a rankRange take over a stage with no single table");
        take(sole.rows, Number(t.from), Number(t.to));
        break;
      }
      case "topNPerGroup":
        for (const tbl of tables) take(tbl.rows, 1, Number(t.n));
        break;
      default: throw new Error(`Q2: take kind '${String(t.kind)}' is not one the W5A fed rows use (rankRange, topNPerGroup)`);
    }
  }
  return owed;
}
const everyone = (o: CutOwed): Set<string> => new Set([...o.must, ...o.ties.flatMap((t) => [...t.members])]);
const seatsOwed = (o: CutOwed): number => o.must.size + o.ties.reduce((n, t) => n + t.count, 0);

export interface DepartedQualifierObs {
  readonly departed: string;
  /** The destination stage's posted takes, and what its confirm seeded and declared. */
  readonly takes: readonly TakeRule[];
  readonly seeded: readonly string[];
  readonly declared: number;
  /** The source stage's final tables, as the harness observed them after the run. */
  readonly tables: Tables;
  /** The departed entrant's rank in their table the moment before the withdrawal. */
  readonly rankBefore: number | null;
  /** The confirm picked a tie in the product's listed order (AdvanceObs.tiePicked). */
  readonly tiePicked: boolean;
}

/** The Q2 items, every one counted. */
export function departedQualifierItems(o: DepartedQualifierObs): Item[] {
  const without = eligibleCut(o.takes, o.tables, new Set([o.departed]), o.tiePicked);
  // the cut the table gives the departed had they stayed: ranked first, so their seat is the cut's first
  const withDeparted = eligibleCut(o.takes, o.tables.map((t) => ({ ...t, rows: t.rows.map((r) => ({ ...r, rank: r.entrantId === o.departed ? 0 : r.rank })) })), new Set(), o.tiePicked);
  const stayers = everyone(withDeparted);
  const backfilled = [...everyone(without)].filter((e) => !stayers.has(e));
  const seeded = new Set(o.seeded);
  const departedRow = o.tables.flatMap((t) => t.rows).find((r) => r.entrantId === o.departed);
  const items: Item[] = [
    // premises
    { ok: o.rankBefore === 1, note: `the departed ranked ${o.rankBefore ?? "(none)"} before the withdrawal, expected 1 (the surest member of any cut)` },
    { ok: withDeparted.must.has(o.departed), note: "the departed was not inside the cut the table gives them - the script proves no backfill" },
    { ok: backfilled.length >= 1, note: "no entrant outside the cut with the departed in it takes a seat without them - the backfill is not exercised" },
    // RB5-K1 / K2
    { ok: !seeded.has(o.departed), note: `the departed ${o.departed} is seeded into the destination (RB5-K1: a departed entrant leaves the cut)` },
    { ok: o.seeded.length === seatsOwed(without) && o.seeded.length === o.declared, note: `seeded ${o.seeded.length}, expected ${seatsOwed(without)} (the declared ${o.declared}): the seat the departed leaves is filled (RB5-K2), not left empty` },
    // RB5-K3: the table keeps the row, ranked last
    { ok: departedRow !== undefined, note: "the departed entrant has no row in the source table (RB5-K3: the table keeps their row, marked)" },
  ];
  for (const e of without.must) items.push({ ok: seeded.has(e), note: `${e}: a first-eligible qualifier by the source table, not seeded (RB5-K2)` });
  for (const t of without.ties) items.push({ ok: [...t.members].filter((e) => seeded.has(e)).length === t.count, note: `a tie at the cut's edge (${[...t.members].join(",")}) owes ${t.count} seat(s), seeded ${[...t.members].filter((e) => seeded.has(e)).length} (RB5-K2; which of them is X-PD-8's order)` });
  const allowed = everyone(without);
  for (const e of o.seeded) items.push({ ok: allowed.has(e), note: `${e}: seeded, but not among the cut's first eligible entrants (RB5-K1/K2)` });
  for (const e of backfilled) if (without.must.has(e)) items.push({ ok: seeded.has(e), note: `${e}: the next eligible entrant behind the departed did not take the seat (RB5-K2)` });
  return items;
}

function drivesStandingsAndPools(d: OrganiserDriver): d is OrganiserDriver & Required<Pick<OrganiserDriver, "stagePools">> {
  return d.stagePools !== undefined;
}

const q2: Scenario = {
  key: "W5A_Q2",
  entrantCount: 6,
  canaryCheck: null,
  async run(ctx) {
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, w5aField("W5A_Q2", ctx.spec.row));
    const d = ctx.driver;
    if (!drivesStandingsAndPools(d)) throw new DriverMisuse("driver: W5A_Q2 needs stagePools - the HTTP driver has it, a layer that does not drive the path says so");
    if (setup.stages.length < 2) throw new Error(`scenario: W5A_Q2 needs a fed row, ${ctx.spec.row} has ${setup.stages.length} stage`);
    const body = setup.built.posted.stages.find((b) => b.seq === setup.stages[1].seq);
    if (body === undefined) throw new Error(`scenario: stage ${setup.stages[1].seq} has no posted body`);
    const takes = takesOf(body);
    let departed: string | null = null;
    let rankBefore: number | null = null;
    let obs: Awaited<ReturnType<typeof withdrawEntrant>>["obs"] | null = null;
    return finishRun(
      ctx, rec, setup,
      (plays, observed) => {
        const advance = plays[1]?.advance ?? null;
        const source = observed.stages.find((s) => s.id === setup.stage.id);
        if (departed === null || source === undefined || advance === null || advance.status !== 200) {
          return [assertion("w5a-q2-departed-qualifier", [{ ok: false, note: `the departure or the advance did not happen (departed ${departed ?? "none"}, advance ${advance?.status ?? "none"})` }])];
        }
        rec.notes.push(`Q2 source table: ${source.standings.map((t) => t.rows.map((r) => `${r.entrantId.slice(0, 4)}:${r.rank}:${r.points}`).join(" ")).join(" | ")}; departed ${departed.slice(0, 4)}; seeded ${advance.seeded.map((e) => e.slice(0, 4)).join(" ")}`);
        return [assertion("w5a-q2-departed-qualifier", departedQualifierItems({ departed, takes, seeded: advance.seeded, declared: advance.declared, tables: source.standings, rankBefore, tiePicked: advance.tiePicked }))];
      },
      {
        beforeComplete: async (stage) => {
          const pools = (await poolsOf(ctx, stage.id)).pools;
          const poolId = pools.length === 0 ? null : pools[0].id;
          const table = await d.standings(stage.id, poolId);
          const top = [...table.rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
          if (top === undefined) return;
          departed = top.entrantId;
          rankBefore = top.rank ?? null;
          const w = await withdrawEntrant(ctx, rec, setup, top.entrantId, 0);
          obs = w.obs;
          rec.notes.push(`the top entrant withdrew before completion: policy ${w.answer.policy}, ${w.answer.walkovers} walkover(s), ${w.answer.voided} voided`);
        },
      },
      () => obs,
    );
  },
};

export const w5aQ2Scenarios: Readonly<Partial<Record<"W5A_Q2", Scenario>>> = Object.freeze({ W5A_Q2: q2 });
