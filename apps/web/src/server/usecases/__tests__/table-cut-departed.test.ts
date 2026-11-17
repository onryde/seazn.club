// W5 Task 9 — the cut's SOURCE half on league and group rows (RB5-K1..K4, K7; engine ids X-CUT-1 / X-CUT-2 / X-CUT-3).
// Shipped by W4 T13 (`lib/table-withdrawal.ts` CUT_SKIPS_DEPARTED_KINDS, `cutEligiblePools`, `departedLoseBestNth`); this
// file pins it per template ROW on BOTH timings, through the real producers:
//   * the row is the real `STAGE_TEMPLATES` entry's own `build()` (stage kinds and take rules are read off it, never typed);
//   * the departure goes through `patchEntrant` (the roster editor's door → the withdrawal cascade);
//   * the setup path is completeStage → computeSeedProposal → confirmSeedProposal; the on_complete path is completeStage's
//     own seedNextStage + generation;
//   * the public side is the real `DivisionHomePage` over a real `getPublicDivision` read.
//
// Expected values come from the rulebook, never from the cut under test: the generic sport pays a win 3, and EVERY match
// here is won by the higher seed (lower number), so a table is the seed order and a pool's best-Nth comparison is a plain
// count of the members below a finisher. RB5-K1: a withdrawn or disqualified entrant leaves the cut; RB5-K2: the next
// eligible entrant takes the place and the best-Nth comparison is recomputed without the departed; RB5-K3: the public page
// stops naming a departed entrant as a qualifier. The sources' departed row keeps its place in the table, marked.
//
// NOT pinned here (Task 11): a departure AFTER the proposal is confirmed (RB5-K6 / RB4-V3 walkover territory).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Passthrough, never memoising (the page's data door is read after real writes).
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));

import { qualificationStatus } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { divisionPointsBounds } from "@/server/public-site/qualification-view";
import { appendEvent } from "@/server/engine-db";
import { STAGE_TEMPLATES, type StageDraft } from "@/lib/format-templates";
import { Bracket } from "@/components/public-site/bracket";
import { StandingsTable } from "@/components/public-site/standings-table";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { startDivision } from "../schedule";
import { completeStage, confirmSeedProposal, createStages, generateStageFixtures, getSeedProposal, refoldStageTable } from "../stages";
import { GENERIC_CONFIG, seedOrg } from "./_seed";
import DivisionHomePage from "@/app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/page";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

type Path = "setup" | "on_complete";
const PATHS: readonly Path[] = ["setup", "on_complete"];

/** The four rows whose source is a league or a group (the task's row set); the knobs are the builder's own. */
interface RowSpec {
  key: string;
  entrants: number;
  qualified: number;
  poolCount: number;
}
const ROWS: readonly RowSpec[] = [
  { key: "league_ko", entrants: 6, qualified: 4, poolCount: 2 },
  // q = 5 over two pools of three: top 2 of each pool plus a best-third (n = 2, r = 1). Departing a pool winner leaves her pool with
  // no eligible third — the shape `departedLoseBestNth` exists for (X-CUT-2).
  { key: "groups_ko", entrants: 6, qualified: 5, poolCount: 2 },
  { key: "group_stepladder", entrants: 6, qualified: 4, poolCount: 2 },
  { key: "group_playoffs", entrants: 6, qualified: 4, poolCount: 2 },
];

const draftsOf = (row: RowSpec): StageDraft[] => {
  const tpl = STAGE_TEMPLATES.find((t) => t.key === row.key);
  expect(tpl, `the template ${row.key} exists`).toBeDefined();
  return tpl!.build({ qualified: row.qualified, poolCount: row.poolCount, swissRounds: 3, legs: 1 });
};

interface Departure {
  seed: number;
  as?: "withdrawn" | "disqualified";
  /** `before_complete` (default): after the last result, before the source completes. `after_proposal`: setup only — after
   *  the source completed and the draft proposal exists, before it is confirmed. */
  when?: "before_complete" | "after_proposal";
}

interface Scene {
  auth: AuthCtx;
  row: RowSpec;
  path: Path;
  srcKind: string;
  koKind: string;
  slugs: { org: string; comp: string; div: string };
  srcId: string;
  koId: string;
  idOf: Map<number, string>;
  seedOf: Map<string, number>;
  nameOf: (seed: number) => string;
  /** The pool each seed played in (null for a league), read off the generated fixtures. */
  poolOf: Map<number, string | null>;
  /** The KO stage's fixtures after the cut was applied, seeds in place of entrant ids. */
  ko: { round: number; seq: number; home: number | null; away: number | null }[];
  /** Who the cut named: the proposal (setup) or `config.qualified` (on_complete), as seeds, in seed-slot order. */
  qualifiedSeeds: number[];
}

const nameFor = (seed: number) => `Ent${String(seed).padStart(2, "0")}`;

/** Which one match of the source to leave unplayed: a pair of seeds, or chosen from the generated fixtures (seed pairs + pool). */
type LeaveOpen = readonly [number, number] | ((fixtures: { a: number; b: number; pool: string | null }[]) => readonly [number, number]);

async function scene(row: RowSpec, path: Path, departures: Departure[], leaveOpen?: LeaveOpen): Promise<Scene> {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Cut ${suffix}`, visibility: "private", branding: {} });
  await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
  const divSlug = `open-${suffix}`;
  const div = await createDivision(auth, comp.id, { name: "Open", slug: divSlug, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  const ents = await createEntrants(
    auth,
    div.id,
    Array.from({ length: row.entrants }, (_, i) => ({ kind: "individual" as const, display_name: nameFor(i + 1), seed: i + 1, members: [] })),
  );
  const idOf = new Map(ents.map((e) => [e.seed as number, e.id]));
  const seedOf = new Map(ents.map((e) => [e.id, e.seed as number]));

  const drafts = draftsOf(row);
  expect(drafts, `${row.key}: a source stage and a destination`).toHaveLength(2);
  const stages = await createStages(
    auth,
    div.id,
    drafts.map((d, i) => ({
      seq: i + 1,
      kind: d.kind,
      name: d.name,
      config: d.config,
      progression: d.progression ? { ...d.progression, timing: path } : null,
    })) as never,
  );
  const src = stages.find((s) => s.seq === 1)!;
  const ko = stages.find((s) => s.seq === 2)!;
  if (path === "setup") await generateStageFixtures(auth, ko.id);
  await generateStageFixtures(auth, src.id);
  await startDivision(auth, div.id);

  // Every match is won by the higher seed. Raw ledger writes (not scoreEvent): scoring's auto-advance would complete the
  // source before the departure below, and the departure is what each cell is about.
  const fx = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string; pool_id: string | null }[]>`
    select id, home_entrant_id, away_entrant_id, pool_id from fixtures where stage_id = ${src.id}`;
  expect(fx.length, "the source's fixtures were generated").toBeGreaterThan(0);
  const openPair =
    typeof leaveOpen === "function"
      ? leaveOpen(fx.map((f) => ({ a: seedOf.get(f.home_entrant_id)!, b: seedOf.get(f.away_entrant_id)!, pool: f.pool_id })))
      : leaveOpen;
  const open = (f: { home_entrant_id: string; away_entrant_id: string }) =>
    openPair !== undefined && [seedOf.get(f.home_entrant_id)!, seedOf.get(f.away_entrant_id)!].sort().join() === [...openPair].sort().join();
  for (const f of fx) {
    if (open(f)) continue;
    const homeWins = seedOf.get(f.home_entrant_id)! < seedOf.get(f.away_entrant_id)!;
    await appendEvent(auth.orgId, f.id, 0, { type: "core.start", payload: {} });
    await appendEvent(auth.orgId, f.id, 1, { type: "generic.result", payload: homeWins ? { p1Score: 2, p2Score: 0 } : { p1Score: 0, p2Score: 2 } });
  }
  const poolKeys = new Map((await sql<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${src.id}`).map((p) => [p.id, p.key]));
  const poolOf = new Map<number, string | null>();
  for (const f of fx) {
    for (const id of [f.home_entrant_id, f.away_entrant_id]) poolOf.set(seedOf.get(id)!, f.pool_id === null ? null : (poolKeys.get(f.pool_id) ?? f.pool_id));
  }

  const depart = async (d: Departure) => {
    await patchEntrant(auth, idOf.get(d.seed)!, { status: d.as ?? "withdrawn" });
  };
  for (const d of departures.filter((x) => (x.when ?? "before_complete") === "before_complete")) await depart(d);
  const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const base = {
    auth, row, path, srcKind: src.kind, koKind: ko.kind,
    slugs: { org: orgSlug, comp: comp.slug, div: divSlug },
    srcId: src.id, koId: ko.id, idOf, seedOf, nameOf: nameFor, poolOf,
  };
  if (leaveOpen !== undefined) {
    // The raw ledger writes above did not fold the table; the page reads the stored one.
    await refoldStageTable(auth.orgId, { id: src.id, kind: src.kind }, "skip");
    return { ...base, ko: [], qualifiedSeeds: [] };
  }
  await completeStage(auth, src.id);
  for (const d of departures.filter((x) => x.when === "after_proposal")) await depart(d);

  let qualifiedSeeds: number[];
  if (path === "setup") {
    const proposal = await getSeedProposal(auth, ko.id);
    expect(proposal, `${row.key}/${path}: completion left a proposal`).not.toBeNull();
    expect(proposal!.status, "the draft is current (a departure refreshes it)").toBe("draft");
    expect(proposal!.computed.ties, "no tie is asked about: every table here is a total order").toEqual([]);
    qualifiedSeeds = proposal!.computed.qualifiers.map((q) => seedOf.get(q.entrantId)!);
    await confirmSeedProposal(auth, ko.id, { proposalId: proposal!.id });
  } else {
    const [s] = await sql<{ config: { qualified?: string[] } }[]>`select config from stages where id = ${ko.id}`;
    expect(Array.isArray(s!.config.qualified), `${row.key}/${path}: completion seeded config.qualified`).toBe(true);
    qualifiedSeeds = s!.config.qualified!.map((id) => seedOf.get(id)!);
  }
  const kf = await sql<{ round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select round_no, seq_in_round, home_entrant_id, away_entrant_id from fixtures where stage_id = ${ko.id} order by round_no, seq_in_round`;
  return {
    ...base,
    ko: kf.map((f) => ({
      round: f.round_no,
      seq: f.seq_in_round,
      home: f.home_entrant_id === null ? null : seedOf.get(f.home_entrant_id)!,
      away: f.away_entrant_id === null ? null : seedOf.get(f.away_entrant_id)!,
    })),
    qualifiedSeeds,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The expectation, from the rulebook alone.

/** RB5-K1/K2 for a LEAGUE source: the table is the seed order, the departed leave, the next eligible take the places. */
function leagueCut(entrants: number, q: number, gone: ReadonlySet<number>): number[] {
  return Array.from({ length: entrants }, (_, i) => i + 1)
    .filter((s) => !gone.has(s))
    .slice(0, q);
}

/** RB5-K1/K2 for a GROUP source with the template's take (`topNPerGroup n` + `bestNth n+1 × r`), wave-major. A pool's
 *  record is read from the FULL pool (the departed's results stand): 3 points per member below her; the best-Nth
 *  comparison is over the eligible Nth finishers only. Throws on a tie at the best-Nth boundary — a case that tied would
 *  not witness the rule, so that is a guard on the case, not a pass. */
function groupCut(poolOf: ReadonlyMap<number, string | null>, q: number, gone: ReadonlySet<number>, strict = true): { cut: number[]; bestNth: number[] } {
  const keys = [...new Set(poolOf.values())].sort() as string[];
  const members = (k: string) => [...poolOf.entries()].filter(([, p]) => p === k).map(([s]) => s).sort((a, b) => a - b);
  const n = Math.floor(q / keys.length);
  const r = q - n * keys.length;
  const eligible = new Map(keys.map((k) => [k, members(k).filter((s) => !gone.has(s))]));
  const cut: number[] = [];
  for (let wave = 0; wave < n; wave++) for (const k of keys) cut.push(eligible.get(k)![wave]!);
  const points = (k: string, s: number) => 3 * members(k).filter((m) => m > s).length;
  // A pool left with no Nth finisher offers no candidate (RB5-K2: the comparison is recomputed without the departed).
  const cands = keys.filter((k) => eligible.get(k)![n] !== undefined).map((k) => ({ s: eligible.get(k)![n]!, pts: points(k, eligible.get(k)![n]!) })).sort((a, b) => b.pts - a.pts);
  if (strict && r > 0 && r < cands.length) expect(cands[r - 1]!.pts, "the best-Nth boundary is not a tie").toBeGreaterThan(cands[r]!.pts);
  const bestNth = cands.slice(0, r).map((c) => c.s);
  return { cut: [...cut, ...bestNth], bestNth };
}

/** Round one of a knockout over `seeded` (rank order): seed i meets seed P+1-i on a bracket padded to P (format-templates.ts
 *  / scheduling/bracket.ts); a missing opponent is a bye (null). Unordered pairs, sorted. */
function ko1(seeded: readonly number[]): string[] {
  let p = 1;
  while (p < seeded.length) p *= 2;
  const pairs: string[] = [];
  for (let i = 1; i <= p / 2; i++) {
    const a = seeded[i - 1] ?? null;
    const b = seeded[p - i] ?? null;
    pairs.push([a, b].sort((x, y) => (x ?? 99) - (y ?? 99)).join("v"));
  }
  return pairs.sort();
}

/** What the KO stage's fixtures must show for a cut `q` (seeds, rank order), by the destination's own format. */
function expectedKo(koKind: string, q: readonly number[]): string[] {
  const pair = (a: number | null, b: number | null) => [a, b].sort((x, y) => (x ?? 99) - (y ?? 99)).join("v");
  if (koKind === "knockout") return ko1(q);
  // Page playoff: 1v2 and 3v4 open it.
  if (koKind === "page_playoff") return [pair(q[0]!, q[1]!), pair(q[2]!, q[3]!)].sort();
  // Stepladder: the bottom two meet first, then each rung up waits for the winner (a lone seat per round).
  if (koKind === "stepladder") return [pair(q[q.length - 2]!, q[q.length - 1]!), ...q.slice(0, q.length - 2).reverse().map((s) => pair(s, null))];
  throw new Error(`no expectation for destination kind ${koKind}`);
}

/** The KO's fixtures as the same pair strings: round 1 for a bracket/playoff, every round for a ladder. */
function koSeen(s: Scene): string[] {
  const pair = (a: number | null, b: number | null) => [a, b].sort((x, y) => (x ?? 99) - (y ?? 99)).join("v");
  if (s.koKind === "knockout") {
    return s.ko.filter((f) => f.round === 1).map((f) => pair(f.home, f.away)).sort();
  }
  if (s.koKind === "page_playoff") return s.ko.filter((f) => f.round === 1).map((f) => pair(f.home, f.away)).sort();
  return s.ko.map((f) => pair(f.home, f.away));
}

const seatedSeeds = (s: Scene): Set<number> => new Set(s.ko.flatMap((f) => [f.home, f.away]).filter((x): x is number => x !== null));

function cutOf(s: Scene, gone: ReadonlySet<number>): { cut: number[]; bestNth: number[] } {
  return s.srcKind === "group"
    ? groupCut(s.poolOf, s.row.qualified, gone, gone.size > 0)
    : { cut: leagueCut(s.row.entrants, s.row.qualified, gone), bestNth: [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The public page, rendered.

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

async function renderPage(s: Scene) {
  const root = await DivisionHomePage({
    params: Promise.resolve({ orgSlug: s.slugs.org, competitionSlug: s.slugs.comp, divisionSlug: s.slugs.div }),
  });
  const all = elements(root);
  const brackets = all.filter((e) => e.type === Bracket);
  const tables = all.filter((e) => e.type === StandingsTable);
  return { brackets, tables, all };
}

const textOf = (el: ReactElement) => renderToStaticMarkup(el);

// ---------------------------------------------------------------------------------------------------------------------

const checked = { cut1: new Set<string>(), cut2: new Set<string>(), cut3: new Set<string>(), open: new Set<string>() };
/** Pools of FOUR (8 entrants over 2 pools, q = 5): a departed pool winner leaves her pool three eligible entrants. */
const WIDE: RowSpec = { key: "groups_ko", entrants: 8, qualified: 5, poolCount: 2 };
const DEPART_SEED = 2; // a qualifier on every row (the table's second finisher / a pool winner)

describe.skipIf(!HAS_DB)("X-CUT table-source cut on league/group rows (W5 Task 9)", () => {
  it("X-CUT-1 the row set is read off the real templates: four rows, league or group sources", () => {
    const sources = ROWS.map((r) => draftsOf(r)[0]!.kind);
    expect(ROWS.length).toBe(4);
    expect(sources).toEqual(["league", "group", "league", "league"]);
    for (const r of ROWS) {
      const [src, dst] = draftsOf(r);
      expect(src!.progression, `${r.key}: the source feeds nothing`).toBeNull();
      expect(dst!.progression?.timing, `${r.key}: the template is a setup-path row`).toBe("setup");
    }
  });

  for (const row of ROWS) {
    for (const path of PATHS) {
      describe(`${row.key} (${path})`, () => {
        let s: Scene;
        let built: Promise<Scene> | null = null;
        const get = () => (built ??= scene(row, path, [{ seed: DEPART_SEED }]));

        it(`X-CUT-1 ${row.key} ${path}: a withdrawn qualifier leaves the cut, the next eligible entrant takes her place (the bracket names the backfill)`, async () => {
          s = await get();
          const gone = new Set([DEPART_SEED]);
          const before = cutOf(s, new Set());
          // Premise: she was a qualifier before leaving, and the backfill was not (else nothing moved).
          const { cut } = cutOf(s, gone);
          if (s.srcKind === "league") expect(before.cut, "premise: she was in the cut").toContain(DEPART_SEED);
          expect(cut, "premise: the expected cut moved without her").not.toContain(DEPART_SEED);
          expect(cut).toHaveLength(row.qualified);
          const backfill = cut.filter((x) => !before.cut.includes(x));
          expect(backfill.length, "premise: somebody new came in").toBeGreaterThan(0);

          expect([...s.qualifiedSeeds].sort((a, b) => a - b), `the ${path} cut named the eligible entrants`).toEqual([...cut].sort((a, b) => a - b));
          expect(s.qualifiedSeeds, "she is nowhere in it").not.toContain(DEPART_SEED);
          expect(seatedSeeds(s).has(DEPART_SEED), "she holds no seat in the destination's fixtures").toBe(false);
          for (const b of backfill) expect(seatedSeeds(s).has(b), `the backfill (seed ${b}) is seated`).toBe(true);
          // The bracket NAMES the backfill: round one reads the rank-ordered cut with the gap closed.
          expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
          checked.cut1.add(`${row.key}/${path}`);
        });

        if (row.key === "groups_ko") {
          it(`X-CUT-2 groups_ko ${path}: a pool left with no eligible Nth finisher hands best-Nth nobody — the departed winner's record cannot win the seat`, async () => {
            s = await get();
            const gone = new Set([DEPART_SEED]);
            const keys = [...new Set(s.poolOf.values())].sort() as string[];
            const members = (k: string) => [...s.poolOf.entries()].filter(([, p]) => p === k).map(([x]) => x).sort((a, b) => a - b);
            const pool = s.poolOf.get(DEPART_SEED)!;
            const n = Math.floor(row.qualified / keys.length);
            // Premise (the shape): she led a pool of exactly n + 1 — without her it has no Nth finisher — and she out-scored every rival
            // candidate on the record she earned (a pool winner's), so only the sunk record keeps her out of the seat.
            expect(members(pool).length, "premise: her pool holds n + 1 members").toBe(n + 1);
            expect(members(pool)[0], "premise: she is her pool's winner").toBe(DEPART_SEED);
            const { bestNth } = groupCut(s.poolOf, row.qualified, gone);
            expect(bestNth, "one best-Nth seat (n = 2, r = 1)").toHaveLength(1);
            const rivalPool = keys.find((k) => k !== pool)!;
            expect(bestNth[0], "the only eligible Nth finisher is the other pool's").toBe(members(rivalPool)[n]);
            expect(3 * (members(pool).length - 1), "premise: her record beat the rival's third").toBeGreaterThan(3 * (members(rivalPool).length - 1 - n));
            expect(s.qualifiedSeeds.slice(-1), "the last seat is the eligible third").toEqual([bestNth[0]]);
            expect(s.qualifiedSeeds, "and she is nowhere").not.toContain(DEPART_SEED);
            checked.cut2.add(`${row.key}/${path}`);
          });
        }

        it(`X-CUT-3 ${row.key} ${path}: the public page names the backfill, not the departed`, async () => {
          s = await get();
          const gone = new Set([DEPART_SEED]);
          const { cut } = cutOf(s, gone);
          const before = cutOf(s, new Set());
          const backfill = cut.filter((x) => !before.cut.includes(x));
          const page = await renderPage(s);

          // The KO stage's bracket on the page: one Bracket, whose markup names who the cut seated.
          expect(page.brackets.length, "the page renders the destination's bracket").toBe(1);
          const bracket = textOf(page.brackets[0]!);
          for (const seat of cut) {
            // Every qualifier is seated in the stage's fixtures (a ladder's waiting rungs hold theirs too), so every one is named.
            expect(seatedSeeds(s).has(seat), `seed ${seat} holds a seat`).toBe(true);
            expect(bracket, `the bracket names seed ${seat}`).toContain(s.nameOf(seat));
          }
          for (const b of backfill) expect(bracket, `the backfill (seed ${b}) is named`).toContain(s.nameOf(b));
          expect(bracket, "the departed is not named as a qualifier").not.toContain(s.nameOf(DEPART_SEED));

          // The source table: she keeps her row, marked; nobody else is.
          const tableHtml = page.tables.map(textOf).join("");
          expect(tableHtml, "premise: the departed's row is still on the table").toContain(s.nameOf(DEPART_SEED));
          // The marker the table renders for a departed row (`DEPARTED_STATUS_CHIPS`, one testid per status): exactly one, hers,
          // and not the other status's.
          const marks = (id: string) => tableHtml.split(`data-testid="${id}"`).length - 1;
          expect(marks("standings-withdrawn"), "her row wears the withdrawn marker, once").toBe(1);
          expect(marks("standings-disqualified"), "and not the disqualified one").toBe(0);

          checked.cut3.add(`${row.key}/${path}`);
        });
      });
    }
  }

  // The sequence: an empty case first, then a disqualification, a pair, and a departure after the proposal exists.
  describe("sequence on league_ko", () => {
    const row = ROWS[0]!;
    for (const path of PATHS) {
      it(`X-CUT-1 league_ko ${path}: nobody departed — the cut is the table's top ${row.qualified} (empty case)`, async () => {
        const s = await scene(row, path, []);
        expect(s.qualifiedSeeds).toEqual(leagueCut(row.entrants, row.qualified, new Set()));
        expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
      });

      it(`X-CUT-1 league_ko ${path}: a DISQUALIFIED qualifier leaves the cut exactly as a withdrawn one does`, async () => {
        const s = await scene(row, path, [{ seed: DEPART_SEED, as: "disqualified" }]);
        const status = await sql<{ status: string }[]>`select status from entrants where id = ${s.idOf.get(DEPART_SEED)!}`;
        expect(status[0]!.status, "premise: she is disqualified, not withdrawn").toBe("disqualified");
        const want = leagueCut(row.entrants, row.qualified, new Set([DEPART_SEED]));
        expect([...s.qualifiedSeeds].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
        expect(seatedSeeds(s).has(DEPART_SEED)).toBe(false);
        expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
      });

      it(`X-CUT-1 league_ko ${path}: a PAIR departs (a withdrawn and a disqualified qualifier) — two backfills, in table order`, async () => {
        const s = await scene(row, path, [{ seed: 2 }, { seed: 4, as: "disqualified" }]);
        const want = leagueCut(row.entrants, row.qualified, new Set([2, 4]));
        expect(want, "premise: the field of six left exactly the cut of four").toEqual([1, 3, 5, 6]);
        expect([...s.qualifiedSeeds].sort((a, b) => a - b)).toEqual(want);
        expect(seatedSeeds(s).has(2) || seatedSeeds(s).has(4)).toBe(false);
        expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
      });
    }

    it("X-CUT-1 league_ko setup: a departure AFTER the source completed refreshes the draft — the proposal names the backfill, and confirms", async () => {
      const s = await scene(row, "setup", [{ seed: DEPART_SEED, when: "after_proposal" }]);
      const want = leagueCut(row.entrants, row.qualified, new Set([DEPART_SEED]));
      expect([...s.qualifiedSeeds].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
      expect(seatedSeeds(s).has(DEPART_SEED)).toBe(false);
      expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
    });
  });

  // X-CUT-2, the other shape: both pools keep an eligible Nth finisher, so the comparison is a real one over records.
  describe("X-CUT-2 best-Nth recomputed over the eligible thirds (pools of four)", () => {
    const wide = WIDE;
    for (const path of PATHS) {
      it(`X-CUT-2 groups_ko ${path}: the pool winner leaves — the best-third seat goes to the better of the two ELIGIBLE thirds`, async () => {
        const s = await scene(wide, path, [{ seed: DEPART_SEED }]);
        const gone = new Set([DEPART_SEED]);
        const keys = [...new Set(s.poolOf.values())].sort() as string[];
        const pool = s.poolOf.get(DEPART_SEED)!;
        const members = (k: string) => [...s.poolOf.entries()].filter(([, p]) => p === k).map(([x]) => x).sort((a, b) => a - b);
        expect(members(pool)[0], "premise: she is her pool's winner").toBe(DEPART_SEED);
        const other = keys.find((k) => k !== pool)!;
        const recomputed = members(pool).filter((x) => x !== DEPART_SEED)[2]!; // her pool's NEW third finisher
        const rival = members(other)[2]!; // the other pool's third finisher
        const pts = (k: string, x: number) => 3 * members(k).filter((m) => m > x).length;
        expect(pts(pool, recomputed), "premise: the two candidates differ on points (no tie to hide a wrong answer)").not.toBe(pts(other, rival));
        const { bestNth } = groupCut(s.poolOf, wide.qualified, gone);
        const taken = bestNth[0]!;
        expect(taken, "the better record takes the seat").toBe(pts(pool, recomputed) > pts(other, rival) ? recomputed : rival);
        const lost = taken === recomputed ? rival : recomputed;
        expect(s.qualifiedSeeds, "the best third holds the seat").toContain(taken);
        expect(s.qualifiedSeeds, "the other eligible third is not seated").not.toContain(lost);
        expect(s.qualifiedSeeds.slice(-1), "it is the LAST seat (best-Nth rides behind the wave-major top-N)").toEqual([taken]);
        checked.cut2.add(`groups_ko_wide/${path}`);
      });
    }
  });

  // A FINISHED table carries no qualification statuses (the engine answers null once `complete`; the frozen markers are
  // RB5-T14's, later), so the public status set is pinned on a table still open: every line played but one between the two
  // entrants below the cut, so the departed's record is final and two seats are still contested.
  describe("X-CUT-3 the qualification set on an open league table", () => {
    const leagueRows = ROWS.filter((r) => draftsOf(r)[0]!.kind === "league");
    for (const row of leagueRows) {
      it(`X-CUT-3 ${row.key}: the departed has no status and is no rival — the race is run over who is still in the field`, async () => {
        const below: [number, number] = [row.qualified + 1, row.qualified + 2];
        const s = await scene(row, "setup", [{ seed: DEPART_SEED }], below);
        const page = await renderPage(s);
        const views = page.tables
          .map((t) => (t.props as { qualification?: { rows: Record<string, { status: string }> } | null }).qualification)
          .filter((v): v is { rows: Record<string, { status: string }> } => v !== null && v !== undefined);
        expect(views.length, "the open league table carries a qualification view").toBe(1);
        const rows = views[0]!.rows;
        expect(rows[s.idOf.get(DEPART_SEED)!], "she has no qualification status").toBeUndefined();

        // The engine's own answer over the entrants still in the field, from points the rulebook gives (3 a win, the higher
        // seed always wins) and the one line each of the two below the cut still owes.
        const perMatch = divisionPointsBounds(builtinModules.find((m) => m.key === "generic"), GENERIC_CONFIG)!;
        const field = leagueCut(row.entrants, row.entrants, new Set([DEPART_SEED]));
        const pts = (seed: number) => 3 * (row.entrants - seed) - (below.includes(seed) && seed === below[0] ? 3 : 0);
        const run = (active: (seed: number) => boolean, rowsOf: number[]) =>
          qualificationStatus({
            rows: rowsOf.map((x) => ({ entrantId: String(x), points: pts(x), active: active(x) })),
            remaining: new Map(rowsOf.map((x) => [String(x), below.includes(x) ? 1 : 0])),
            perMatch,
            cut: row.qualified,
            anyPlayed: true,
            complete: false,
          })!;
        const want = run(() => true, field);
        for (const x of field) expect(rows[s.idOf.get(x)!]?.status, `seed ${x}`).toBe(want.get(String(x))?.status.kind);
        // Differential: the old reading (her row a rival that still counts above the line) answers differently for the entrant
        // who took her place, so a regression to it cannot pass.
        const old = run((x) => x !== DEPART_SEED, Array.from({ length: row.entrants }, (_, i) => i + 1));
        const backfill = row.qualified + 1;
        expect(old.get(String(backfill))?.status.kind, "premise: counted as a rival she would hide the backfill's race").not.toBe(want.get(String(backfill))?.status.kind);
        expect(rows[s.idOf.get(backfill)!]?.status).toBe(want.get(String(backfill))?.status.kind);
        checked.open.add(row.key);
      });
    }
  });

  // m-3: TWO departures in one pool — the backfill reaches past both, and the second departed's sunk record cannot take the
  // best-Nth seat either.
  describe("X-CUT-1 two departed in one pool (groups_ko, pools of four)", () => {
    for (const path of PATHS) {
      it(`X-CUT-1 groups_ko ${path}: the pool's top two both leave — the backfill reaches past both, and neither's record takes the best-Nth seat`, async () => {
        const s = await scene(WIDE, path, [{ seed: DEPART_SEED }, { seed: 3 }]);
        const gone = new Set([DEPART_SEED, 3]);
        const pool = s.poolOf.get(DEPART_SEED)!;
        const members = (k: string | null) => [...s.poolOf.entries()].filter(([, p]) => p === k).map(([x]) => x).sort((a, b) => a - b);
        expect(s.poolOf.get(3), "premise: both left from one pool").toBe(pool);
        expect(members(pool).slice(0, 2), "premise: they were that pool's top two").toEqual([DEPART_SEED, 3]);
        const { cut, bestNth } = groupCut(s.poolOf, WIDE.qualified, gone);
        const rivalPool = [...new Set(s.poolOf.values())].find((k) => k !== pool)!;
        // Premise: the departed second's record (she beat every member below her) beat the rival pool's third — only the sunk
        // record keeps her from the best-Nth seat.
        const pts = (k: string | null, x: number) => 3 * members(k).filter((m) => m > x).length;
        expect(pts(pool, 3), "premise: her record out-scored the rival's third").toBeGreaterThan(pts(rivalPool, members(rivalPool)[2]!));
        expect(bestNth, "the only eligible third is the rival pool's").toEqual([members(rivalPool)[2]]);
        expect([...s.qualifiedSeeds].sort((a, b) => a - b), `the ${path} cut named the eligible entrants`).toEqual([...cut].sort((a, b) => a - b));
        for (const g of gone) expect(s.qualifiedSeeds, `seed ${g} is nowhere in the cut`).not.toContain(g);
        for (const backfill of members(pool).slice(2)) expect(seatedSeeds(s).has(backfill), `seed ${backfill} is seated past both`).toBe(true);
        expect(koSeen(s)).toEqual(expectedKo(s.koKind, s.qualifiedSeeds));
        checked.cut2.add(`groups_ko_two/${path}`);
      });
    }
  });

  // m-2: the status pin on a GROUP table still open. The pool is of four, so with her gone three are still in the field and
  // the cut (2) is still a contest — a view exists; her row has no status and is no rival for the others'.
  // The row is groups_ko with a remainder-free cut (q = 4 over 2 pools: top two of each, no best-Nth): `public_stages_v`'s
  // qualification forecast (V475) is NULL for any source holding a best-Nth take, so at the X-CUT-2 shape (q = 5) a group table
  // has no qualification view to pin — a finding, not a skip.
  describe("X-CUT-3 the qualification set on an open group table", () => {
    it("X-CUT-3 groups_ko: the departed pool winner has no status and is no rival — the race runs over who is still in the field", async () => {
      const row: RowSpec = { key: "groups_ko", entrants: 8, qualified: 4, poolCount: 2 };
      const poolMembers = (fx: { a: number; b: number; pool: string | null }[]) => {
        const pool = fx.find((f) => f.a === DEPART_SEED || f.b === DEPART_SEED)!.pool;
        return [...new Set(fx.filter((f) => f.pool === pool).flatMap((f) => [f.a, f.b]))].sort((x, y) => x - y);
      };
      // Leave the match between the two lowest of HER pool unplayed.
      const s = await scene(row, "setup", [{ seed: DEPART_SEED }], (fx) => {
        const m = poolMembers(fx);
        return [m[m.length - 2]!, m[m.length - 1]!];
      });
      const pool = s.poolOf.get(DEPART_SEED)!;
      const members = [...s.poolOf.entries()].filter(([, p]) => p === pool).map(([x]) => x).sort((a, b) => a - b);
      expect(members, "premise: her pool is four and she leads it").toHaveLength(4);
      expect(members[0]).toBe(DEPART_SEED);
      const below = [members[2]!, members[3]!] as const;
      const page = await renderPage(s);
      const idsOf = (seeds: number[]) => seeds.map((x) => s.idOf.get(x)!);
      const views = page.tables
        .map((t) => (t.props as { qualification?: { rows: Record<string, { status: string }> } | null }).qualification)
        .filter((v): v is { rows: Record<string, { status: string }> } => v !== null && v !== undefined);
      const mine = views.filter((v) => idsOf(members).some((id) => id in v.rows));
      expect(mine.length, "her open pool table carries a qualification view").toBe(1);
      const rows = mine[0]!.rows;
      expect(rows[s.idOf.get(DEPART_SEED)!], "she has no qualification status").toBeUndefined();

      // The engine's own answer over the entrants still in her pool: points the rulebook gives (3 a win, the higher seed always
      // wins, but the match between the two below is still to play), and the one line each of those two still owes.
      const perMatch = divisionPointsBounds(builtinModules.find((m) => m.key === "generic"), GENERIC_CONFIG)!;
      const cut = Math.floor(row.qualified / new Set(s.poolOf.values()).size);
      const pts = (x: number) => 3 * members.filter((m) => m > x).length - (x === below[0] ? 3 : 0);
      const field = members.filter((x) => x !== DEPART_SEED);
      const run = (rowsOf: number[], active: (x: number) => boolean) =>
        qualificationStatus({
          rows: rowsOf.map((x) => ({ entrantId: String(x), points: pts(x), active: active(x) })),
          remaining: new Map(rowsOf.map((x) => [String(x), (below as readonly number[]).includes(x) ? 1 : 0])),
          perMatch,
          cut,
          anyPlayed: true,
          complete: false,
        })!;
      const want = run(field, () => true);
      for (const x of field) expect(rows[s.idOf.get(x)!]?.status, `seed ${x}`).toBe(want.get(String(x))?.status.kind);
      // Differential: with her row counted as a rival above the line (the pre-RB4-V6 reading) the backfill answers differently.
      const old = run(members, (x) => x !== DEPART_SEED);
      const backfill = members[2]!;
      expect(old.get(String(backfill))?.status.kind, "premise: counted as a rival she would change the backfill's status").not.toBe(want.get(String(backfill))?.status.kind);
      checked.open.add("groups_ko");
    });
  });

  it("anti-vacuity: every row x path cell was checked for X-CUT-1 and X-CUT-3, and groups_ko x path for X-CUT-2", () => {
    const cells = ROWS.flatMap((r) => PATHS.map((p) => `${r.key}/${p}`)).sort();
    expect(cells).toHaveLength(8);
    expect([...checked.cut1].sort()).toEqual(cells);
    expect([...checked.cut3].sort()).toEqual(cells);
    expect([...checked.cut2].sort()).toEqual([
      "groups_ko/on_complete", "groups_ko/setup", "groups_ko_two/on_complete", "groups_ko_two/setup", "groups_ko_wide/on_complete", "groups_ko_wide/setup",
    ]);
    expect([...checked.open].sort(), "the open-table status pin ran on every league row and on a group table").toEqual(["group_playoffs", "group_stepladder", "groups_ko", "league_ko"]);
  });
});
