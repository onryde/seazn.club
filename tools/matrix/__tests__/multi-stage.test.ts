// W1-driving Task 6: multi-stage driving. The later stages are generated right
// after Start (TBD rows), stage N is played and completed ONCE, the proposal
// that /complete returned is confirmed, and N+1 is played on. The fake
// (fake-formats-driver.ts) proves the wiring only; Task 12 Step 7 owes the
// first live cells.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandTake } from "@seazn/engine/competition";
import { StageKind, forbidsLevelResult } from "@seazn/engine/core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { ROW_KEYS, SPORT_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { DriverMisuse, RefusedCall, type FixtureRow } from "../lib/driver/types.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { toObservedOutcome, winnerOf, type CompleteObs, type ObservedRun, type ObservedStage } from "../lib/observed.ts";
import { decideState, type CheckResult } from "../lib/results.ts";
import { SEEDING_TIE_CODE, SourcePoolsDisagree, UnknownTakeKind, advanceSeededAsDeclared, confirmAdvance, declaredTake, sourcePoolCount, takesOf, withdrawnQualifiers, type AdvanceObs } from "../lib/scenarios/advance.ts";
import { Recorder, drawsDeclaredOnReached, ensureLineups, finishStage, playDivision, playStage, recordGenerate, setUpDivision, snapshot, type DivisionSetup, type StagePlay } from "../lib/scenarios/common.ts";
import { lineupsPut } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { STRUCTURAL_FINAL_KINDS, terminalFinalKeys } from "../lib/scenarios/terminal-finals.ts";
import type { CaseSpec, ScenarioContext, ScenarioKey } from "../lib/scenarios/types.ts";
import { drawsAllowed, entrantKindFor, resolveSportCfg, variantKeys } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeMultiStageDriver } from "./fake-formats-driver.ts";

/** Fix round 1, m-5: LIFECYCLE's "config probe never ran" guard is reachable
 *  only if playDivision skips stage 1's beforeComplete, which it never does.
 *  The real playDivision runs for every test; `probeHook.drop` withholds the
 *  hook for the one test that reaches the guard. */
const probeHook = vi.hoisted(() => ({ drop: false }));
vi.mock("../lib/scenarios/common.ts", async (importOriginal) => {
  const m = await importOriginal<typeof import("../lib/scenarios/common.ts")>();
  const playDivisionAsIs: typeof m.playDivision = (ctx, rec, setup, hooks = {}) => m.playDivision(ctx, rec, setup, probeHook.drop ? { ...hooks, beforeComplete: undefined } : hooks);
  return { ...m, playDivision: playDivisionAsIs };
});

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

type Row = CaseSpec["row"];
interface Opts { row: Row; sport?: string; variant?: string }
function ctxFor(driver: FakeMultiStageDriver, scenario: ScenarioKey, opts: Opts): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? "score";
  const spec: CaseSpec = { caseId: `${opts.row}|${sport}|${variant}|${scenario}`, row: opts.row, sport, variant, scenario, canary: false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}
async function runOn(driver: FakeMultiStageDriver, scenario: ScenarioKey, opts: Opts) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }) };
}
const verdict = (checks: { id: string; verdict: string }[], id: string) => checks.find((c) => c.id === id)?.verdict;
const failed = (checks: { id: string; verdict: string; reason?: string }[]) => checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason ?? ""}`);
const body = (take: unknown[]) => ({ kind: "knockout", name: "x", config: {}, seq: 2, progression: { sources: [{ stage: "previous", take }], placement: "rank_order", timing: "setup" } }) as never;
/** The take kinds a row's stage-2 body declares. */
const takesOfRow = (row: Row) => takesOf(stagesForRow(row)[1]!).map((t) => String(t.kind));
/** The multi-stage rows, derived from the catalogue. */
const MULTI = ROW_KEYS.filter((r) => stagesForRow(r).length > 1);
/** The rows the fake can draw: stage 1 a league or a group (fake-formats-driver.ts). */
const FAKE_ROWS = MULTI.filter((r) => ["league", "group"].includes(stagesForRow(r)[0]!.kind));
/** A bracket kind: a line there needs a winner to feed on. The engine's own split (X-DR-1, forbidsLevelResult) and never
 *  a typed list here - the typed one this replaced left out the ladder. */
const isBracketKind = (kind: string): boolean => forbidsLevelResult(kind);
/** Was a finding (W1-driving task report): the engine's deny-list declared a draw reachable on some bracket kinds
 *  (generic on page_playoff; boardgame on every kind), so the default policy posted one and the bracket line fed
 *  nobody. W2a's allow-list (X-DR-1: draws only in league, group, swiss and americano) closes it, so this is now
 *  the question every test below asks and answers NO. Derived from the module's own supportsDraws, never a typed list. */
const bracketDrawDeclared = (row: Row, sport: string, variant: string) =>
  stagesForRow(row).slice(1).some((b) => isBracketKind(b.kind) && drawsAllowed(sport, resolveSportCfg(sport, variant), b.kind as never));

describe("Step 0 — the product's multi-stage shape, pinned", () => {
  it("every multi-stage row's later bodies are timing 'setup', and declaredTake answers for each — counted", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      const bodies = stagesForRow(row);
      for (const b of bodies.slice(1)) {
        expect(b.progression?.timing, `${row} seq ${b.seq}`).toBe("setup");
        expect(declaredTake(b, 2), `${row} seq ${b.seq}`).toBeGreaterThan(0);
        checked++;
      }
    }
    const derived = ROW_KEYS.reduce((n, r) => n + stagesForRow(r).length - 1, 0);
    expect(checked).toBe(derived);
    // 8 two-stage rows + group_group_ko's two later stages; a new row moves `derived`, and this pin says so.
    expect(derived).toBe(10);
    expect(MULTI.length).toBe(9);
  });
  it("the codes the advance reads are the product's own (usecases/stages.ts), never invented", () => {
    const stages = read("apps/web/src/server/usecases/stages.ts");
    const tie = /"a flagged tie is not resolved[^"]*",\s*"([A-Z_]+)"/.exec(stages);
    expect(tie?.[1]).toBe(SEEDING_TIE_CODE);
    // The 409 a /complete answers when the stage committed and its next stage's seeding failed (:4239-4252).
    expect(stages).toMatch(/throw new HttpError\(\s*409,\s*err instanceof Error \? err\.message : String\(err\),\s*"STAGE_COMPLETED_SEEDING_FAILED"/);
    // Every later setup stage's generate short-circuits to the idempotent setup path (FP-1: it never refuses after the source completes).
    expect(stages).toMatch(/if \(progression\.timing === "setup"\) return \{ seeded: true as const \};/);
    // A departed qualifier is filtered, not closed up (FP-2).
    expect(stages).toMatch(/const computedQualifiers = resolvedQualifiers\.filter\(\(q\) => !departed\.has\(q\.entrantId\)\);/);
  });
});

// Final review m-5: the source stage's pool count — declaredTake's topNPerGroup multiplier — is the posted body's, as
// the product reads it (stages.ts poolCount: a group's pools.count, else 1; sourceShapeOf: an ungrouped source is one
// implicit pool). It was the fixtures' distinct pool ids `|| 1`, so a group whose fixtures carried none read as one pool.
describe("sourcePoolCount — the source's pools, from its posted body (final review m-5)", () => {
  const src = (kind: string, config: Record<string, unknown>) => ({ kind, name: "s", config, seq: 1, progression: null }) as never;
  const ids = (n: number) => new Set(Array.from({ length: n }, (_, i) => `pool-${i}`));
  it("empty cases first: an ungrouped source, a count-1 group and a group with no pools key name no pool id, and each is one pool", () => {
    expect(sourcePoolCount(src("league", {}), 8, ids(0))).toBe(1);
    expect(sourcePoolCount(src("group", { pools: { count: 1 } }), 8, ids(0))).toBe(1);
    expect(sourcePoolCount(src("group", {}), 8, ids(0))).toBe(1);
  });
  it("a group's count is its body's: 8 in 4 pools name 4 — and 7 in 4 name 3 (a lone seed's pool has no fixture), still 4 pools: the right answer differs from the old observed count", () => {
    expect(sourcePoolCount(src("group", { pools: { count: 4 } }), 8, ids(4))).toBe(4);
    expect(sourcePoolCount(src("group", { pools: { count: 4 } }), 7, ids(3))).toBe(4);
    expect(sourcePoolCount(src("group", { pools: { count: 2 } }), 5, ids(2))).toBe(2);
  });
  it("any other pool-id count is refused by name: a 4-pool group whose fixtures name none (the old silent one pool), an ungrouped source naming pools, too many, and a lone pool that names one", () => {
    expect(() => sourcePoolCount(src("group", { pools: { count: 4 } }), 8, ids(0))).toThrow(SourcePoolsDisagree);
    expect(() => sourcePoolCount(src("group", { pools: { count: 4 } }), 8, ids(0))).toThrow("advance: stage 1's posted body declares 4 pool(s) over a field of 8, so its fixtures name 4 pool id(s) — they name 0; no take is computed off a guess");
    expect(() => sourcePoolCount(src("league", {}), 8, ids(2))).toThrow(SourcePoolsDisagree);
    expect(() => sourcePoolCount(src("group", { pools: { count: 2 } }), 8, ids(3))).toThrow(SourcePoolsDisagree);
    expect(() => sourcePoolCount(src("group", { pools: { count: 4 } }), 7, ids(4))).toThrow(SourcePoolsDisagree);
  });
  it("through playDivision: groups_ko whose product lists its group fixtures with no pool id refuses at the advance, by name — the positive pair plays through", async () => {
    class PoolsUnlisted extends FakeMultiStageDriver {
      override async listFixtures(): Promise<FixtureRow[]> { return (await super.listFixtures()).map((f) => ({ ...f, pool_id: null })); }
    }
    await expect(runOn(new PoolsUnlisted(), "LIFECYCLE", { row: "groups_ko" })).rejects.toThrow(/^advance: stage 1's posted body declares \d+ pool\(s\) over a field of \d+, so its fixtures name \d+ pool id\(s\) — they name 0/);
    const ok = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "groups_ko" });
    expect(ok.out.observed.stages[1]!.fixtures.length).toBeGreaterThan(0);
  });
});

describe("declaredTake — the take vocabulary", () => {
  it("empty case first: a take kind the harness does not know is refused by name", () => {
    expect(() => declaredTake(body([{ kind: "luckyLosers", n: 2 }]), 1)).toThrow(UnknownTakeKind);
    expect(declaredTake({ kind: "knockout", name: "x", config: {}, seq: 1, progression: null } as never, 1)).toBe(0);
  });
  it("declaredTake reads the product's own take vocabulary: rankRange, topNPerGroup × pools, bestNth.count, roundLosers.count", () => {
    expect(declaredTake(body([{ kind: "rankRange", from: 1, to: 4 }]), 1)).toBe(4);
    expect(declaredTake(body([{ kind: "topNPerGroup", n: 2 }]), 4)).toBe(8);
    expect(declaredTake(body([{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 2 }]), 2)).toBe(6);
    expect(declaredTake(body([{ kind: "roundLosers", round: 1, count: 4 }]), 1)).toBe(4);
  });
  it("declaredTake: bestNth adds its count ONCE, never per pool — the right answer differs from a naive per-pool count (plan review 1, m-7)", () => {
    // 3 pools: top 2 per group = 6, plus the best 2 of the 3 thirds = 2 → 8. A per-pool bestNth reading gives 6 + 2×3 = 12.
    const take = [{ kind: "topNPerGroup", n: 2 }, { kind: "bestNth", nth: 3, count: 2 }] as const;
    const engineSlots = expandTake(take as never, { poolKeys: ["A", "B", "C"] }).flat().length; // the engine's own slot expansion
    expect(engineSlots).toBe(8);
    expect(declaredTake(body([...take]), 3)).toBe(engineSlots);
  });
  it("declaredTake's vocabulary is the product's take KINDS, read as text — counted; the engine's `picks` (no template uses it) is refused by name", () => {
    const text = read("apps/web/src/lib/format-templates.ts");
    const kinds = new Set([...text.matchAll(/take(?::\s*\[|\.push\()\s*\{\s*kind:\s*"([A-Za-z]+)"/g)].map((m) => m[1]!));
    expect(kinds.size, "take kinds read from the templates").toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(["bestNth", "rankRange", "roundLosers", "topNPerGroup"]);
    const one: Record<string, unknown> = { rankRange: { from: 1, to: 2 }, topNPerGroup: { n: 1 }, bestNth: { nth: 2, count: 1 }, roundLosers: { round: 1, count: 1 } };
    for (const k of kinds) expect(declaredTake(body([{ kind: k, ...(one[k] as object) }]), 2), k).toBeGreaterThan(0);
    expect(() => declaredTake(body([{ kind: "picks", picks: [] }]), 1)).toThrow(/take kind 'picks'/);
  });
});

describe("playDivision on the fake — the product sequence", () => {
  it("league_ko: later stage generated after Start, before any play; stage 1 completed ONCE; the proposal /complete returned confirmed ONCE; stage 2 played", async () => {
    const driver = new FakeMultiStageDriver();
    const { out, checks, state } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    const s1 = driver.stageIdAt(1);
    const stage2 = driver.stageIdAt(2);
    const iStart = driver.trace.indexOf("start");
    const iGen2 = driver.trace.indexOf(`generate ${stage2}`);
    const iComplete1 = driver.trace.indexOf(`completeStage ${s1}`);
    const iFirstPost = driver.trace.findIndex((c) => c.startsWith("postStream "));
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iGen2).toBeGreaterThan(iStart);
    expect(iGen2).toBeLessThan(iFirstPost);
    expect(iGen2).toBeLessThan(iComplete1);
    expect(driver.trace.filter((c) => c === `completeStage ${s1}`)).toHaveLength(1);
    expect(driver.trace.filter((c) => c === `completeStage ${stage2}`)).toHaveLength(1);
    const confirms = driver.trace.filter((c) => c.startsWith(`confirmSeedProposal ${stage2}`));
    expect(confirms).toEqual([`confirmSeedProposal ${stage2} ${driver.proposalIssuedFor(2)}`]);
    expect(driver.trace.some((c) => c.startsWith("recomputeSeedProposal"))).toBe(false);
    const [o1, o2] = out.observed.stages;
    expect([o1!.fieldSource, o2!.fieldSource]).toEqual(["division", "seeded"]);
    expect([...o2!.field].sort()).toEqual([...driver.seededInto(2)].sort());
    expect(o2!.field.length).toBe(declaredTake(stagesForRow("league_ko")[1]!, 1));
    expect([o1!.exit, o2!.exit]).toEqual(["drained", "drained"]);
    expect(o2!.complete).toMatchObject({ status: 200, completed: true, seedProposal: null });
    expect(o1!.complete?.seedProposal).toEqual({ id: driver.proposalIssuedFor(2), status: "draft" });
    // Fix round 1, m-6: the product's ext_key and is_final survive into the observation, judged against the rows the
    // fake served (the engine's bracket generator) — a non-final row omits isFinal, never carries false.
    const served = new Map(driver.fixturesOfStage(2).map((f) => [f.id, f]));
    expect(o2!.fixtures.length).toBe(served.size);
    for (const f of o2!.fixtures) {
      expect(f.extKey, f.id).toBe(served.get(f.id)!.ext_key);
      expect(typeof f.extKey, f.id).toBe("string");
    }
    const finals = driver.fixturesOfStage(2).filter((f) => f.is_final === true).map((f) => f.id);
    expect(finals).toHaveLength(1);
    expect(o2!.fixtures.filter((f) => f.isFinal === true).map((f) => f.id)).toEqual(finals);
    expect(o2!.fixtures.filter((f) => "isFinal" in f && f.isFinal !== true)).toEqual([]);
    // Stage 2's generates are its own: the setup draw, then the play loop's.
    expect(o2!.generates[0]).toMatchObject({ status: 200, created: 3 });
    expect(o1!.generates.every((g) => g.created === 0)).toBe(true);
    expect(verdict(checks, "advance-seeded-as-declared")).toBe("pass");
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
  it("group_group_ko drives all three stages; each later stage is its own ObservedStage, seeded from the stage before it", async () => {
    const driver = new FakeMultiStageDriver();
    const { out, checks, state } = await runOn(driver, "LIFECYCLE", { row: "group_group_ko" });
    expect(out.observed.stages.map((s) => [s.seq, s.fieldSource, s.exit])).toEqual([[1, "division", "drained"], [2, "seeded", "drained"], [3, "seeded", "drained"]]);
    const bodies = stagesForRow("group_group_ko");
    // The declared take, from the bodies and the SOURCE stage's observed pool count (4 pools, then 2).
    expect(out.observed.stages[1]!.field.length).toBe(declaredTake(bodies[1]!, 4));
    expect(out.observed.stages[2]!.field.length).toBe(declaredTake(bodies[2]!, 2));
    for (const seq of [2, 3]) expect(driver.trace.filter((c) => c.startsWith(`confirmSeedProposal ${driver.stageIdAt(seq)} `)), `stage ${seq}`).toEqual([`confirmSeedProposal ${driver.stageIdAt(seq)} ${driver.proposalIssuedFor(seq)}`]);
    for (const seq of [1, 2, 3]) expect(driver.trace.filter((c) => c === `completeStage ${driver.stageIdAt(seq)}`), `stage ${seq}`).toHaveLength(1);
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
  it("every multi-stage row the fake draws plays LIFECYCLE through every stage — counted over the catalogue's rows", async () => {
    expect(FAKE_ROWS.length).toBe(5); // league_ko, groups_ko, group_stepladder, group_playoffs, group_group_ko
    // W2a (X-DR-1): generic/score no longer declares a draw on page_playoff, so no row needs the win_loss variant.
    const variantOf = (row: Row) => (bracketDrawDeclared(row, "generic", "score") ? "win_loss" : "score");
    expect(FAKE_ROWS.filter((r) => variantOf(r) === "win_loss")).toEqual([]);
    let stages = 0;
    for (const row of FAKE_ROWS) {
      const { out, checks, state } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row, variant: variantOf(row) });
      expect(out.observed.stages.length, row).toBe(stagesForRow(row).length);
      for (const s of out.observed.stages.slice(1)) {
        expect([s.fieldSource, s.exit, s.complete?.completed], `${row} stage ${s.seq}`).toEqual(["seeded", "drained", true]);
        stages++;
      }
      expect(state, `${row}: ${failed(checks).join("; ")}`).toMatchObject({ state: "works" });
    }
    expect(stages).toBe(FAKE_ROWS.reduce((n, r) => n + stagesForRow(r).length - 1, 0));
  });
  it("every sport at its builder default plays league_ko LIFECYCLE through both stages — counted over the registry", async () => {
    expect(SPORT_KEYS.length).toBeGreaterThan(0);
    let judged = 0;
    for (const sport of SPORT_KEYS) {
      const variant = offlineBuilderDefault(sport);
      const { out, checks, state } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "league_ko", sport, variant });
      expect(out.observed.stages.map((s) => s.fieldSource), sport).toEqual(["division", "seeded"]);
      // W2a (X-DR-1): no sport declares a knockout draw any more, so none sticks the bracket — every one plays through.
      expect(bracketDrawDeclared("league_ko", sport, variant), sport).toBe(false);
      expect(state, `${sport}: ${failed(checks).join("; ")}`).toMatchObject({ state: "works" });
      judged++;
    }
    expect(judged).toBeGreaterThan(0);
    expect(judged).toBe(SPORT_KEYS.length);
  });
  it("F1, M1 and R4 on a league_ko row owe the decider of its KNOCKOUT stage (stage 2), counted over the registry (M-6)", async () => {
    expect(SPORT_KEYS.length).toBeGreaterThan(0);
    let judged = 0;
    for (const scenario of ["F1", "M1", "R4"] as const) {
      for (const sport of SPORT_KEYS) {
        const { out, checks } = await runOn(new FakeMultiStageDriver(), scenario, { row: "league_ko", sport, variant: offlineBuilderDefault(sport) });
        const check = checks.find((c) => c.id === "life-bracket-decider-exercised");
        expect(check, `${scenario}/${sport}: the check is in the scenario`).toBeDefined();
        // Stage 1 is a league (no decider owed); the check judges the bracket stage the run reached.
        expect(out.observed.stages.map((s) => s.kind), `${scenario}/${sport}`).toEqual(["league", "knockout"]);
        expect(check!.verdict, `${scenario}/${sport}: ${check!.reason}`).toBe("pass");
        expect(check!.checked, `${scenario}/${sport}`).toBeGreaterThan(0);
        judged++;
      }
    }
    expect(judged).toBe(3 * SPORT_KEYS.length);
  });
  it("X-DR-1 over EVERY declared stage kind: the bracket kinds are everything but league, group, swiss and americano (the rulebook's draw half), and no sport draws in one at any variant — so no bracket line in any row waits on a draw", () => {
    // single list, from the rulebook (spec §5.4.1, ruling 78) - not read back from the engine's DRAW_KINDS.
    const RULEBOOK_DRAW_KINDS = ["league", "group", "swiss", "americano"];
    let bracketKinds = 0;
    let checked = 0;
    for (const kind of StageKind.options) {
      expect(isBracketKind(kind), kind).toBe(!RULEBOOK_DRAW_KINDS.includes(kind));
      if (!isBracketKind(kind)) continue;
      bracketKinds++;
      for (const sport of SPORT_KEYS) {
        for (const variant of variantKeys(sport)) {
          expect(drawsAllowed(sport, resolveSportCfg(sport, variant), kind), `${sport}/${variant} in ${kind}`).toBe(false);
          checked++;
        }
      }
    }
    expect(bracketKinds).toBe(StageKind.options.length - RULEBOOK_DRAW_KINDS.length);
    expect(bracketKinds).toBeGreaterThan(0);
    expect(checked).toBe(bracketKinds * SPORT_KEYS.reduce((n, sport) => n + variantKeys(sport).length, 0));
  });
  it("…and generic/score's page_playoff no longer declares a draw (SC-O2, X-DR-1), so group_playoffs' stage 2 plays through instead of sticking", async () => {
    expect(bracketDrawDeclared("group_playoffs", "generic", "score")).toBe(false);
    const { checks, state } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "group_playoffs" });
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
    expect(checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("pass");
  });
  it("W2a: the bracket policy counts BRACKET fixtures, not the run's decided total — a bracket that follows a table stage whose decided count is not a multiple of three still opens with a decider, in every multi-stage row the fake draws", async () => {
    let judged = 0;
    let offset = 0;
    for (const row of FAKE_ROWS) {
      const { out } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row, sport: "generic", variant: "score" });
      const played = (fx: readonly { outcome: { kind: string } | null }[]) => fx.filter((f) => f.outcome !== null && f.outcome.kind !== "award").length;
      let before = 0; // decided fixtures in the stages before this one
      for (const st of out.observed.stages) {
        if (isBracketKind(st.kind)) {
          const ordered = [...st.fixtures].sort((a, b) => (a.roundNo ?? 0) - (b.roundNo ?? 0));
          const first = ordered.find((f) => f.outcome !== null && f.outcome.kind !== "award");
          expect((first?.outcome as { method?: string } | undefined)?.method ?? "", `${row} seq ${st.seq}: the first played bracket fixture is a decider (${before} decided before it)`).toMatch(/^settled_/);
          if (before % 3 !== 0) offset++;
          judged++;
        }
        before += played(st.fixtures);
      }
    }
    expect(judged).toBeGreaterThan(0);
    // Anti-vacuity: the offset case this test exists for was actually reached.
    expect(offset, "no row put a bracket behind a table stage with a decided count off a multiple of three").toBeGreaterThan(0);
  });
  it("T6-R3 (m-12): draws are decided PER STAGE — a sport declaring draws on stage 1's kind and none on stage 2's posts draws in stage 1 and none in stage 2, swept over the registry", async () => {
    const [k1, k2] = stagesForRow("league_ko").map((b) => b.kind as StageKind);
    let swept = 0;
    const judged: string[] = [];
    for (const sport of SPORT_KEYS) {
      const variant = offlineBuilderDefault(sport);
      const cfg = resolveSportCfg(sport, variant);
      swept++;
      // The engine's own supportsDraws picks the sports, never a typed list.
      if (!(drawsAllowed(sport, cfg, k1!) && !drawsAllowed(sport, cfg, k2!))) continue;
      const { out } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "league_ko", sport, variant });
      const [o1, o2] = out.observed.stages;
      const asked = (fx: typeof o1.fixtures) => fx.filter((f) => f.declared !== null).map((f) => f.declared!.forOutcome.kind);
      expect(asked(o1!.fixtures).filter((k) => k === "draw").length, `${sport}: stage 1 posts a draw`).toBeGreaterThan(0);
      expect(asked(o2!.fixtures).length, `${sport}: stage 2 decided`).toBeGreaterThan(0);
      expect(asked(o2!.fixtures), `${sport}: stage 2 asked for no draw`).not.toContain("draw");
      expect(o2!.fixtures.map((f) => f.outcome?.kind ?? null), `${sport}: stage 2 shows no draw`).not.toContain("draw");
      judged.push(sport);
    }
    expect(swept).toBe(SPORT_KEYS.length);
    expect(judged.length).toBeGreaterThan(0);
    process.stdout.write(`multi-stage m-12 per-stage draws: ${judged.length} of ${swept} sports declare draws on ${k1} and not on ${k2} (${judged.join(", ")})\n`);
  });
  it("a tie on confirm: one recompute, tiePicks in the product's listed order, fact seeding_tie_picked", async () => {
    const driver = new FakeMultiStageDriver({ tieAt: 2 });
    const { out, checks, state } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.trace.filter((c) => c.startsWith("recomputeSeedProposal"))).toHaveLength(1);
    expect(driver.tiesListed().length).toBe(1);
    expect(driver.lastTiePicks()).toEqual(driver.tiesListed().map((t) => ({ slots: t.slots, order: t.entrantIds })));
    expect(out.observed.facts).toContain("seeding_tie_picked");
    // The first confirm used /complete's id and was refused; the second used the recompute's.
    expect(driver.trace.filter((c) => c.startsWith("confirmSeedProposal "))).toEqual([
      `confirmSeedProposal s2 ${driver.proposalIssuedFor(2)}`, `confirmSeedProposal s2 ${driver.confirmedProposalIds[0]}`,
    ]);
    expect(driver.confirmedProposalIds[0]).not.toBe(driver.proposalIssuedFor(2));
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
  it("m-9: a tie refusal whose recompute lists NO ties confirms the recompute as computed — no seeding_tie_picked fact, no '0 ties picked' note", async () => {
    const driver = new FakeMultiStageDriver({ tieAt: 2, tieOnlyOnFirst: true });
    const { out, checks, state } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.trace.filter((c) => c.startsWith("recomputeSeedProposal"))).toHaveLength(1);
    expect(driver.tiesListed()).toEqual([]);
    expect(driver.confirmedProposalIds).toEqual([`sp-2-2`]);
    expect(driver.lastTiePicks()).toBeNull();
    expect(out.observed.facts).not.toContain("seeding_tie_picked");
    expect(out.notes.filter((n) => n.includes("seeding tie(s) picked"))).toEqual([]);
    expect(out.notes).toContain("stage 2: the recompute listed no ties — confirmed as computed");
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
  it("R4 withdraws seed 3 in stage 1; the withdrawn entrant is never seeded into stage 2", async () => {
    const driver = new FakeMultiStageDriver();
    const { out, checks } = await runOn(driver, "R4", { row: "league_ko" });
    const withdrawn = out.observed.withdrawal!.entrantId;
    expect(out.observed.stages[1]!.field.length).toBeGreaterThan(0);
    expect(out.observed.stages[1]!.field).not.toContain(withdrawn);
    expect(verdict(checks, "advance-seeded-as-declared")).toBe("pass");
  });
  it("…and a product that seeds the withdrawn entrant anyway reds advance-seeded-as-declared on its withdrawn item", async () => {
    const driver = new FakeMultiStageDriver({ seedWithdrawn: true });
    const { out, checks } = await runOn(driver, "R4", { row: "league_ko" });
    const withdrawn = out.observed.withdrawal!.entrantId;
    expect(out.observed.stages[1]!.field).toContain(withdrawn);
    const c = checks.find((x) => x.id === "advance-seeded-as-declared")!;
    expect(c.verdict).toBe("fail");
    expect(c.evidence).toEqual(["stage 2: no withdrawn entrant seeded"]);
  });
  it("m-1: a product that leaves a seat empty for NO departed qualifier reds it — R4's withdrawn seed 3 ranks outside the take, so it excuses nothing", async () => {
    const driver = new FakeMultiStageDriver({ dropLastSeat: true });
    const { out, checks } = await runOn(driver, "R4", { row: "league_ko" });
    const withdrawn = out.observed.withdrawal!.entrantId;
    const declared = declaredTake(stagesForRow("league_ko")[1]!, 1);
    // The precondition, from the product's own stage-1 table: the withdrawn entrant ranks outside rankRange 1..4.
    const row = out.observed.stages[0]!.standings.flatMap((t) => t.rows).find((r) => r.entrantId === withdrawn)!;
    expect(row.rank).toBeGreaterThan(declared);
    expect(out.observed.stages[1]!.field).toHaveLength(declared - 1);
    const c = checks.find((x) => x.id === "advance-seeded-as-declared")!;
    expect(c.verdict).toBe("fail");
    expect(c.evidence).toEqual([`stage 2: seeded ${declared - 1}, declared ${declared}`]);
  });
  it("stage 1 not drained: asked to complete once (not ready, nothing committed); stage 2 is not_reached, never confirmed, and life-loop-bounded reds", async () => {
    const driver = new FakeMultiStageDriver({ refuseGenerateOnStage1: true });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.trace.some((c) => c.startsWith("confirmSeedProposal"))).toBe(false);
    expect(driver.trace.filter((c) => c.startsWith("completeStage"))).toEqual([`completeStage ${driver.stageIdAt(1)}`]);
    expect(driver.commits).toEqual([]);
    expect(out.observed.stages[0]!.complete).toMatchObject({ status: 200, completed: false, seedProposal: null });
    expect(out.observed.stages[1]!.complete).toBeNull();
    expect(out.observed.stages.map((s) => s.exit)).toEqual(["refused_generate", "not_reached"]);
    expect(verdict(checks, "life-loop-bounded")).toBe("fail");
    expect(verdict(checks, "advance-seeded-as-declared")).toBe("abstain");
    expect(out.notes).toContain("stage 2: not reached (stage 1 completed=false, proposal none)");
  });
  it("m-4: a refused seed advance — stage 2 is not_reached and never asked to complete; the advance check fails on it and life-loop-bounded names the run's worst exit", async () => {
    const driver = new FakeMultiStageDriver({ refuseConfirm: "SEEDING_NOTHING_TO_FILL" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.trace.filter((c) => c.startsWith("confirmSeedProposal"))).toEqual([`confirmSeedProposal ${driver.stageIdAt(2)} ${driver.proposalIssuedFor(2)}`]);
    expect(driver.trace.filter((c) => c.startsWith("completeStage"))).toEqual([`completeStage ${driver.stageIdAt(1)}`]);
    expect(out.observed.stages.map((s) => s.exit)).toEqual(["drained", "not_reached"]);
    expect(out.observed.stages[1]!.complete).toBeNull();
    expect(out.notes).toContain("stage 2: not reached (its seed advance was refused 422 SEEDING_NOTHING_TO_FILL)");
    expect(checks.find((c) => c.id === "advance-seeded-as-declared")).toMatchObject({ verdict: "fail", evidence: ["stage 2: confirm refused 422 SEEDING_NOTHING_TO_FILL — nobody seeded"] });
    const loop = checks.find((c) => c.id === "life-loop-bounded")!;
    expect(loop.verdict).toBe("fail");
    // Stage 1 drained; the run's exit is the worst stage's, not the last one playStage wrote.
    expect(loop.evidence).toContain("play loop exited not_reached");
  });
  it("m-7: a /complete that commits and answers 409 STAGE_COMPLETED_SEEDING_FAILED is recorded COMPLETE with a named note; stage 2 is not_reached and the advance check FAILS on the missing proposal", async () => {
    const driver = new FakeMultiStageDriver({ failSeedingOnComplete: 1 });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "league_ko" });
    expect(driver.commits).toEqual([driver.stageIdAt(1)]);
    expect(out.observed.stages[0]!.complete).toEqual({ status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED", completed: true, finalRanks: null, seedProposal: null });
    expect(out.notes).toContain("complete committed, but the next stage's seeding failed: 409 STAGE_COMPLETED_SEEDING_FAILED");
    expect(out.notes).toContain("stage 2: not reached (stage 1 completed=true, proposal none)");
    expect(out.observed.stages.map((s) => s.exit)).toEqual(["drained", "not_reached"]);
    expect(driver.trace.some((c) => c.startsWith("confirmSeedProposal"))).toBe(false);
    // The check that owns seeding fails, naming the half that failed — never an abstain.
    expect(checks.find((c) => c.id === "advance-seeded-as-declared")).toMatchObject({ verdict: "fail", checked: 1, evidence: ["stage 2: no proposal — stage 1's /complete answered 409 STAGE_COMPLETED_SEEDING_FAILED"] });
    // Stage 1 DID complete: the stage check no longer blames it.
    expect(checks.find((c) => c.id === "life-stage-completed")).toMatchObject({ verdict: "pass", checked: 1 });
  });
  it("m-11: a later stage's posted body is looked up by seq, never by array index — reversed posted bodies advance the same", async () => {
    const d = new FakeMultiStageDriver();
    const ctx = ctxFor(d, "LIFECYCLE", { row: "league_ko" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor("league_ko", "LIFECYCLE"));
    const posted = setup.built.posted;
    const reversed: DivisionSetup = { ...setup, built: { ...setup.built, posted: { ...posted, stages: [...posted.stages].reverse() } } };
    expect(reversed.built.posted.stages.map((b) => b.seq)).toEqual([2, 1]);
    const plays = await playDivision(ctx, rec, reversed);
    expect(plays[1]!.advance).toMatchObject({ status: 200, declared: declaredTake(stagesForRow("league_ko")[1]!, 1) });
  });
  it("a team sport on groups_ko plays both stages with a lineup per side on the later stage's fixtures too", async () => {
    const football = offlineBuilderDefault("football");
    expect(entrantKindFor("football", resolveSportCfg("football", football))).toBe("team");
    const driver = new FakeMultiStageDriver();
    const { out, checks, state } = await runOn(driver, "LIFECYCLE", { row: "groups_ko", sport: "football", variant: football });
    const later = driver.fixturesOfStage(2).filter((f) => driver.decidedFixtureIds().includes(f.id));
    // A 4-entrant single elimination decides 3 lines.
    expect(later.length).toBe(3);
    for (const f of later) expect(driver.trace.filter((c) => c.startsWith(`putLineup ${f.id} `)), f.id).toHaveLength(2);
    const lineups = checks.find((c) => c.id === "life-lineups-put")!;
    expect(lineups.verdict).toBe("pass");
    // Every decided fixture of both stages, two sides each.
    expect(lineups.checked).toBe(driver.decidedFixtureIds().length * 2);
    expect(out.notes.some((n) => n === `lineups: ${driver.decidedFixtureIds().length * 2} PUT across ${driver.decidedFixtureIds().length} team fixture(s) scored`)).toBe(true);
    expect(state, failed(checks).join("; ")).toMatchObject({ state: "works" });
  });
});

describe("fix round 1, m-5 — the named 'cannot happen' refusals, each reached", () => {
  const open = async () => {
    const d = new FakeMultiStageDriver();
    const ctx = ctxFor(d, "LIFECYCLE", { row: "league_ko" });
    const rec = new Recorder();
    return { d, ctx, rec, setup: await setUpDivision(ctx, rec, fieldSizeFor("league_ko", "LIFECYCLE")) };
  };
  it("snapshot over zero plays is refused by name", async () => {
    const { ctx, rec, setup } = await open();
    await expect(snapshot(ctx, rec, setup, [], { configEdit: null, withdrawal: null })).rejects.toThrow("scenario: snapshot of a division with no stage played");
  });
  it("a later stage with no posted body is refused by name", async () => {
    const { ctx, rec, setup } = await open();
    const posted = setup.built.posted;
    const missing: DivisionSetup = { ...setup, built: { ...setup.built, posted: { ...posted, stages: posted.stages.filter((b) => b.seq !== 2) } } };
    await expect(playDivision(ctx, rec, missing)).rejects.toThrow("scenario: stage 2 has no posted body");
  });
  it("LIFECYCLE refuses a run whose config probe never ran (playDivision withholding stage 1's beforeComplete)", async () => {
    probeHook.drop = true;
    try {
      await expect(runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "league_ko" })).rejects.toThrow("scenario: LIFECYCLE's config probe never ran");
    } finally {
      probeHook.drop = false;
    }
    // …and with the hook back, the same run completes.
    expect((await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row: "league_ko" })).state.state).toBe("works");
  });
});

describe("the two checks this task adds, on their own", () => {
  const stageRef = (seq: number) => ({ id: `s${seq}`, seq, kind: seq === 1 ? "league" : "knockout", config: {}, status: "active" });
  const RANK_1_TO_4 = [{ kind: "rankRange", from: 1, to: 4 }];
  const adv = (over: Partial<AdvanceObs>): AdvanceObs =>
    ({ status: 200, code: null, proposalId: "sp-2-1", filled: 4, seeded: ["a", "b", "c", "d"], declared: 4, takes: RANK_1_TO_4, tiePicked: false, ...over });
  const done: CompleteObs = { status: 200, code: null, completed: true, finalRanks: null, seedProposal: { id: "sp-2-1", status: "draft" } };
  const root: StagePlay = { stage: stageRef(1), field: ["a", "b", "c", "d", "e", "f"], advance: null, complete: done };
  /** Stage 1's observed table: the product ranked a..f 1..6 (one pool). */
  const r = (entrantId: string, rank: number) => ({ entrantId, rank, points: null });
  const tableOf = (rows: ReturnType<typeof r>[]): Pick<ObservedRun, "stages"> =>
    ({ stages: [{ id: "s1", standings: [{ poolId: null, rows }], fixtures: [] }] }) as unknown as Pick<ObservedRun, "stages">;
  const observed = tableOf(["a", "b", "c", "d", "e", "f"].map((e, i) => r(e, i + 1)));
  it("advance-seeded-as-declared: empty case first — a single stage abstains with its reason, a later stage never advanced abstains, never a pass", () => {
    expect(advanceSeededAsDeclared([root], observed, new Set())).toMatchObject({ verdict: "abstain", checked: 0, reason: "single-stage row — no later stage to seed" });
    const never: StagePlay = { stage: stageRef(2), field: null, advance: null, complete: null };
    expect(advanceSeededAsDeclared([{ ...root, complete: null }, never], observed, new Set())).toMatchObject({ verdict: "abstain", reason: "no later stage was confirmed" });
    // A source that answered "not ready" (completed false) committed nothing: still life-loop-bounded's, not this check's.
    expect(advanceSeededAsDeclared([{ ...root, complete: { ...done, completed: false, seedProposal: null } }, never], observed, new Set())).toMatchObject({ verdict: "abstain" });
  });
  it("advance-seeded-as-declared (m-7): a source that COMMITTED with no proposal is a failing item naming the /complete answer, never an abstain", () => {
    const never: StagePlay = { stage: stageRef(2), field: null, advance: null, complete: null };
    const seedingFailed: StagePlay = { ...root, complete: { status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED", completed: true, finalRanks: null, seedProposal: null } };
    expect(advanceSeededAsDeclared([seedingFailed, never], observed, new Set())).toMatchObject({ verdict: "fail", checked: 1, evidence: ["stage 2: no proposal — stage 1's /complete answered 409 STAGE_COMPLETED_SEEDING_FAILED"] });
  });
  it("advance-seeded-as-declared: a REFUSED confirm is a failing item (nobody seeded), never an abstain", () => {
    const refused: StagePlay = { stage: stageRef(2), field: [], advance: adv({ status: 422, code: "SEEDING_NOTHING_TO_FILL", seeded: [], filled: 0 }), complete: null };
    expect(advanceSeededAsDeclared([root, refused], observed, new Set())).toMatchObject({ verdict: "fail", checked: 1, evidence: ["stage 2: confirm refused 422 SEEDING_NOTHING_TO_FILL — nobody seeded"] });
  });
  it("advance-seeded-as-declared: a seeded entrant from outside the source field fails; three items per advanced stage, counted", () => {
    const ok: StagePlay = { stage: stageRef(2), field: ["a", "b", "c", "d"], advance: adv({}), complete: null };
    expect(advanceSeededAsDeclared([root, ok], observed, new Set())).toMatchObject({ verdict: "pass", checked: 3 });
    const foreign: StagePlay = { ...ok, advance: adv({ seeded: ["a", "b", "c", "zz"] }) };
    expect(advanceSeededAsDeclared([root, foreign], observed, new Set())).toMatchObject({ verdict: "fail", evidence: ["stage 2: every seeded entrant comes from stage 1's field"] });
    // FP-2's allowance never lets the count EXCEED the take.
    const over: StagePlay = { ...ok, advance: adv({ seeded: ["a", "b", "c", "d", "e"] }) };
    expect(advanceSeededAsDeclared([root, over], observed, new Set(["d"]))).toMatchObject({ verdict: "fail", evidence: ["stage 2: seeded 5, declared 4 less at most 1 withdrawn qualifier(s)", "stage 2: no withdrawn entrant seeded"] });
  });
  it("advance-seeded-as-declared (m-1): only a withdrawn QUALIFIER excuses a short seat — a withdrawn entrant the source table ranks outside the take excuses nothing", () => {
    const short: StagePlay = { stage: stageRef(2), field: ["a", "b", "c"], advance: adv({ seeded: ["a", "b", "c"], filled: 3 }), complete: null };
    // f withdrew ranked 6th, outside rankRange 1..4: the product left no seat empty for her.
    expect(advanceSeededAsDeclared([root, short], observed, new Set(["f"]))).toMatchObject({ verdict: "fail", evidence: ["stage 2: seeded 3, declared 4"] });
    // d withdrew ranked 4th, inside it: FP-2 leaves her seat empty.
    expect(advanceSeededAsDeclared([root, short], observed, new Set(["d"]))).toMatchObject({ verdict: "pass", checked: 3 });
    // Two short with one qualifier withdrawn is still a fail: the slack is one seat per withdrawn qualifier.
    const two: StagePlay = { ...short, field: ["a", "b"], advance: adv({ seeded: ["a", "b"], filled: 2 }) };
    expect(advanceSeededAsDeclared([root, two], observed, new Set(["d", "f"]))).toMatchObject({ verdict: "fail", evidence: ["stage 2: seeded 2, declared 4 less at most 1 withdrawn qualifier(s)"] });
  });
  it("advance-seeded-as-declared: a source stage the snapshot did not observe is a named failing item, never a silent zero", () => {
    const ok: StagePlay = { stage: stageRef(2), field: ["a", "b", "c", "d"], advance: adv({}), complete: null };
    expect(advanceSeededAsDeclared([root, ok], { stages: [] }, new Set())).toMatchObject({ verdict: "fail", evidence: ["stage 2: stage 1 was not observed — its tables bound FP-2's empty seats"] });
  });
  it("withdrawnQualifiers: each take kind reads the SOURCE stage's own observation — rankRange the sole table, topNPerGroup per pool, bestNth rank nth (an upper bound), roundLosers that round's losers; an unknown kind is refused", () => {
    const all = new Set(["a", "b", "c", "d", "e", "f"]);
    const sole = { standings: [{ poolId: null, rows: [r("a", 1), r("b", 2), r("c", 3)] }], fixtures: [] };
    expect(withdrawnQualifiers([{ kind: "rankRange", from: 2, to: 3 }], sole, all).sort()).toEqual(["b", "c"]);
    expect(withdrawnQualifiers([{ kind: "rankRange", from: 2, to: 3 }], sole, new Set(["a"]))).toEqual([]);
    const pools = { standings: [{ poolId: "A", rows: [r("a", 1), r("b", 2), r("c", 3)] }, { poolId: "B", rows: [r("d", 1), r("e", 2), r("f", 3)] }], fixtures: [] };
    expect(withdrawnQualifiers([{ kind: "topNPerGroup", n: 2 }], pools, all).sort()).toEqual(["a", "b", "d", "e"]);
    expect(withdrawnQualifiers([{ kind: "topNPerGroup", n: 2 }], pools, new Set(["c", "f"]))).toEqual([]);
    expect(withdrawnQualifiers([{ kind: "bestNth", nth: 3, count: 1 }], pools, all).sort()).toEqual(["c", "f"]);
    // rankRange over a multi-pool source reads the pool keyed "" only (engine rankRangeSource): none here.
    expect(withdrawnQualifiers([{ kind: "rankRange", from: 1, to: 4 }], pools, all)).toEqual([]);
    const fx = (roundNo: number, home: string | null, away: string | null, winner: string | null) =>
      ({ id: `${roundNo}${home}${away}`, roundNo, home, away, outcome: winner === null ? null : { kind: "win", winner } });
    const bracket = { standings: [], fixtures: [fx(1, "a", "b", "a"), fx(1, "c", "d", "d"), fx(2, "a", "d", "a"), fx(1, "e", null, "e"), fx(1, "f", "a", null)] } as unknown as Pick<ObservedRun["stages"][number], "standings" | "fixtures">;
    expect(withdrawnQualifiers([{ kind: "roundLosers", round: 1, count: 2 }], bracket, all).sort()).toEqual(["b", "c"]);
    expect(() => withdrawnQualifiers([{ kind: "picks" }], sole, all)).toThrow(UnknownTakeKind);
  });
  it("T6-R3 (m-12): life-draw-path-exercised's drawOk is any REACHED stage's own declaration, never the root's alone", () => {
    const sport = "football";
    const variant = offlineBuilderDefault(sport);
    const cfg = resolveSportCfg(sport, variant);
    // From the engine's own supportsDraws: football declares draws on a league and none on a knockout.
    expect(drawsAllowed(sport, cfg, "league")).toBe(true);
    expect(drawsAllowed(sport, cfg, "knockout")).toBe(false);
    const ctx = ctxFor(new FakeMultiStageDriver(), "LIFECYCLE", { row: "league_ko", sport, variant });
    const play = (seq: number, kind: string, reached: boolean): StagePlay => ({ stage: { id: `s${seq}`, seq, kind, config: {}, status: "active" }, field: [], advance: null, complete: reached ? done : null });
    expect(drawsDeclaredOnReached(ctx, [])).toBe(false);
    expect(drawsDeclaredOnReached(ctx, [play(1, "knockout", true), play(2, "league", true)])).toBe(true);
    expect(drawsDeclaredOnReached(ctx, [play(1, "knockout", true), play(2, "league", false)])).toBe(false);
    expect(drawsDeclaredOnReached(ctx, [play(1, "league", true), play(2, "knockout", true)])).toBe(true);
    expect(drawsDeclaredOnReached(ctx, [play(1, "knockout", true), play(2, "knockout", true)])).toBe(false);
  });
  it("life-lineups-put: abstains for a non-team or rosterless division; a team division that scored nothing fails vacuous; a side scored with no PUT fails", () => {
    const rec = new Recorder();
    expect(lineupsPut(rec, { kind: "individual", rosterless: false })).toMatchObject({ verdict: "abstain", reason: "individual entrants carry no lineup" });
    expect(lineupsPut(rec, { kind: "team", rosterless: true })).toMatchObject({ verdict: "abstain" });
    expect(lineupsPut(rec, { kind: "team", rosterless: false })).toMatchObject({ verdict: "fail", checked: 0 });
    rec.teamPosts.set("f1", ["a", "b"]);
    rec.lineupSides.set("f1", new Set(["a"]));
    expect(lineupsPut(rec, { kind: "team", rosterless: false })).toMatchObject({ verdict: "fail", checked: 2, evidence: ["f1: scored with no lineup PUT for side b"] });
    rec.lineupSides.get("f1")!.add("b");
    expect(lineupsPut(rec, { kind: "team", rosterless: false })).toMatchObject({ verdict: "pass", checked: 2 });
  });
});

/** The harness's own advance steps (recordGenerate, playStage, finishStage,
 *  confirmAdvance) against the fake, one Recorder, one step at a time. A
 *  named refusal is recorded, never thrown out. */
type Step = "generateLater" | "playStage1" | "complete" | "confirmLatest" | "confirmStale" | "recompute" | { withdrawOne: number };
class AdvanceHarness {
  readonly issued: string[] = [];
  readonly confirmed: string[] = [];
  readonly before = new Set<string>();
  readonly after = new Set<string>();
  readonly refusals: string[] = [];
  /** The last confirm's observation, and the last /complete's (m-3). */
  lastAdvance: AdvanceObs | null = null;
  lastComplete: CompleteObs | null = null;
  readonly d: FakeMultiStageDriver;
  readonly ctx: ScenarioContext;
  readonly rec: Recorder;
  readonly setup: DivisionSetup;
  constructor(d: FakeMultiStageDriver, ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup) {
    this.d = d;
    this.ctx = ctx;
    this.rec = rec;
    this.setup = setup;
  }
  static async open(d: FakeMultiStageDriver, row: Row, opts: { sport?: string; variant?: string } = {}): Promise<AdvanceHarness> {
    const ctx = ctxFor(d, "LIFECYCLE", { row, ...opts });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor(row, "LIFECYCLE"));
    return new AdvanceHarness(d, ctx, rec, setup);
  }
  get stage1() { return this.setup.stages[0]!; }
  get stage2() { return this.setup.stages[1]!; }
  get body2() { return this.setup.built.posted.stages.find((b) => b.seq === 2)!; }
  pools(): number { return new Set(this.d.fixturesOfStage(1).filter((f) => f.pool_id !== null).map((f) => f.pool_id)).size || 1; }
  declared(): number { return declaredTake(this.body2, this.pools()); }
  async confirm(id: string): Promise<void> {
    const a = await confirmAdvance(this.ctx, this.rec, this.stage2, { id, status: "draft" }, this.body2, this.pools());
    this.lastAdvance = a;
    // A tie's recompute is a proposal the product issued inside the advance.
    if (a.tiePicked && a.proposalId !== null && !this.issued.includes(a.proposalId)) this.issued.push(a.proposalId);
    if (a.status === 200) this.confirmed.push(a.proposalId!);
    else this.refusals.push(`confirm ${a.status} ${a.code ?? ""}`);
  }
  async step(s: Step): Promise<void> {
    if (typeof s === "object") {
      const id = this.setup.idOfSeed((s.withdrawOne % this.setup.entrants.length) + 1);
      try {
        await this.ctx.driver.withdraw(id);
        this.rec.withdrawn.add(id);
        (this.confirmed.length > 0 ? this.after : this.before).add(id);
      } catch (e) {
        if (!(e instanceof RefusedCall)) throw e;
        this.refusals.push(`withdraw ${e.status} ${e.code ?? ""}`);
      }
      return;
    }
    switch (s) {
      case "generateLater": await recordGenerate(this.ctx, this.rec, this.stage2.id); return;
      case "playStage1": await playStage(this.ctx, this.rec, this.setup, {}, this.stage1); return;
      case "complete": {
        try {
          const c = await finishStage(this.ctx, this.rec, this.stage1.id);
          this.lastComplete = c;
          if (c.seedProposal) this.issued.push(c.seedProposal.id);
        } catch (e) {
          if (!(e instanceof DriverMisuse)) throw e;
          this.refusals.push("complete repeated: refused by the driver's guard");
        }
        return;
      }
      case "confirmLatest": {
        const id = this.issued.at(-1);
        if (id === undefined) { this.refusals.push("confirm: nothing issued yet"); return; }
        await this.confirm(id);
        return;
      }
      case "confirmStale": {
        if (this.issued.length < 2) { this.refusals.push("confirm stale: no superseded proposal"); return; }
        await this.confirm(this.issued[0]!);
        return;
      }
      case "recompute": {
        try {
          this.issued.push((await this.ctx.driver.recomputeSeedProposal(this.stage2.id)).id);
        } catch (e) {
          if (!(e instanceof RefusedCall)) throw e;
          this.refusals.push(`recompute ${e.status} ${e.code ?? ""}`);
        }
        return;
      }
    }
  }
  /** Committed completions of the stage (a not-ready /complete answers
   *  `completed: false`, commits nothing and may be asked again). */
  completesOf(seq: number): number { return this.d.commits.filter((id) => id === this.d.stageIdAt(seq)).length; }
  confirmedIds(): string[] { return [...this.confirmed]; }
  issuedIds(): string[] { return [...this.issued]; }
  seeded(): string[] {
    const out: string[] = [];
    for (const f of this.d.fixturesOfStage(2)) for (const e of [f.home_entrant_id, f.away_entrant_id]) if (e !== null && !out.includes(e)) out.push(e);
    return out;
  }
  sourceField(): string[] { return this.setup.entrants.map((e) => e.id); }
  withdrawnBeforeConfirm(): Set<string> { return this.before; }
  withdrawnAfterConfirm(): Set<string> { return this.after; }
  stage2HasEntrants(): boolean { return this.seeded().length > 0; }
  /** The harness's OWN check on the last confirm (m-3): the real snapshot of
   *  both stages, judged against the entrants withdrawn so far (or `withdrawn`). */
  async judge(withdrawn: ReadonlySet<string> = new Set(this.rec.withdrawn)): Promise<CheckResult> {
    const a = this.lastAdvance;
    if (a === null) throw new Error("harness: judge() before any confirm");
    const plays: StagePlay[] = [
      { stage: this.stage1, field: this.sourceField(), advance: null, complete: this.lastComplete },
      { stage: this.stage2, field: a.seeded, advance: a, complete: null },
    ];
    const observed = await snapshot(this.ctx, this.rec, this.setup, plays, { configEdit: null, withdrawal: null });
    return advanceSeededAsDeclared(plays, observed, withdrawn);
  }
}

describe("the advance as a sequence (TEST-STRATEGY rule 10)", () => {
  it("fast-check: any order of organiser actions around an advance keeps the harness's advance invariants after every step — league_ko (rankRange) and groups_ko (topNPerGroup × pools)", async () => {
    // Plan review 2 I-2: weighted so the generate → play → complete → confirm path is reached; `playStage1` plays
    // stage 1 to its loop exit in one step (a league of 8 needs 7 rounds, which single-round steps would rarely reach).
    const cmd = fc.oneof(
      { arbitrary: fc.constantFrom<Step>("generateLater", "playStage1", "complete", "confirmLatest", "confirmStale", "recompute"), weight: 5 },
      { arbitrary: fc.nat({ max: 15 }).map((seedIdx): Step => ({ withdrawOne: seedIdx })), weight: 1 }, // review 1 I-5: withdrawal at any point (mod the field)
    );
    // m-3: the two take kinds the multi-stage rows use from a table source (catalogue: rankRange on league_ko,
    // group_stepladder, group_playoffs; topNPerGroup × pools on groups_ko, group_group_ko). The rest have a swiss or
    // knockout stage 1, which the fake does not draw (FAKE_ROWS).
    const ROWS = ["league_ko", "groups_ko"] as const satisfies readonly Row[];
    const kinds = ROWS.map((row) => takesOfRow(row));
    expect(kinds).toEqual([["rankRange"], ["topNPerGroup"]]);
    const per = Object.fromEntries(ROWS.map((r) => [r, { runs: 0, confirmed: 0, judged: 0, short: 0 }])) as Record<(typeof ROWS)[number], { runs: number; confirmed: number; judged: number; short: number }>;
    const tally = { runs: 0, confirmed: 0, withdrewBeforeConfirm: 0, withdrewAfterConfirm: 0, judged: 0 };
    await fc.assert(fc.asyncProperty(fc.constantFrom(...ROWS), fc.array(cmd, { minLength: 1, maxLength: 16, size: "max" }), async (row, steps) => {
      const d = new FakeMultiStageDriver();
      const h = await AdvanceHarness.open(d, row);
      for (const s of steps) {
        const confirmsBefore = h.confirmedIds().length;
        await h.step(s);
        expect(h.completesOf(1)).toBeLessThanOrEqual(1); // /complete never repeated after it committed
        expect(h.confirmedIds().every((id) => h.issuedIds().includes(id))).toBe(true);
        // Review 2 I-2: judged against entrants withdrawn BEFORE the confirm that seeded them. An entrant seeded and
        // withdrawn LATER stays seated in stage 2 (the product walks it over, withdrawal.ts:191-209).
        expect(h.seeded().every((e) => h.sourceField().includes(e) && !h.withdrawnBeforeConfirm().has(e))).toBe(true);
        expect(h.stage2HasEntrants()).toBe(h.confirmedIds().length > 0); // no seat filled without a confirm
        if (h.confirmedIds().length > confirmsBefore) {
          // m-3: the harness's OWN observation and check, at the confirm that seated stage 2 — never the fake's.
          const a = h.lastAdvance!;
          expect([...a.seeded].sort()).toEqual([...h.seeded()].sort());
          const c = await h.judge();
          expect(c.verdict, `${row}: ${c.evidence.join("; ")}`).toBe("pass");
          expect(c.checked).toBe(3);
          tally.judged++;
          per[row].judged++;
          if (a.seeded.length < a.declared) per[row].short++;
        }
      }
      tally.runs++;
      per[row].runs++;
      if (h.confirmedIds().length > 0) { tally.confirmed++; per[row].confirmed++; }
      if (h.withdrawnBeforeConfirm().size > 0 && h.confirmedIds().length > 0) tally.withdrewBeforeConfirm++;
      if (h.withdrawnAfterConfirm().size > 0) tally.withdrewAfterConfirm++;
      return true;
    }), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    // Anti-vacuity (TEST-STRATEGY rule 2), each counted over the 200 runs and pasted in the task report.
    expect(tally.runs).toBe(200);
    expect(tally.confirmed, "runs that reached a successful confirm").toBeGreaterThan(0);
    expect(tally.withdrewBeforeConfirm, "runs where a withdrawal preceded a successful confirm").toBeGreaterThan(0);
    expect(tally.withdrewAfterConfirm, "runs where a withdrawal followed a successful confirm").toBeGreaterThan(0);
    for (const row of ROWS) {
      expect(per[row].confirmed, `${row}: runs that reached a successful confirm`).toBeGreaterThan(0);
      expect(per[row].judged, `${row}: confirms the harness's own check judged`).toBeGreaterThan(0);
    }
    expect(tally.judged).toBe(ROWS.reduce((n, r) => n + per[r].judged, 0));
    process.stdout.write(`multi-stage fast-check tally (seed ${process.env.MATRIX_FC_SEED ?? 20260930}): ${JSON.stringify({ ...tally, per })}\n`);
  }, 120_000);
  it("a withdrawal AFTER a confirm leaves the entrant seeded in stage 2, and stage 2 walks it over (review 2 I-2)", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    for (const s of ["generateLater", "playStage1", "complete", "confirmLatest"] as const) await h.step(s);
    expect(h.confirmedIds()).toHaveLength(1);
    const seededFirst = h.seeded()[0]!;
    await h.step({ withdrawOne: d.seedOf(seededFirst) - 1 });
    expect(h.withdrawnAfterConfirm().has(seededFirst)).toBe(true);
    expect(h.seeded()).toContain(seededFirst); // still seated: the product does not unseat
    const itsFixture = d.fixturesOfStage(2).find((f) => f.home_entrant_id === seededFirst || f.away_entrant_id === seededFirst)!;
    expect(itsFixture.status).toBe("forfeited"); // knockout is in BRACKET_WALKOVER_KINDS: walked over
    const opponent = itsFixture.home_entrant_id === seededFirst ? itsFixture.away_entrant_id : itsFixture.home_entrant_id;
    expect(opponent).not.toBeNull();
    expect(winnerOf(toObservedOutcome(itsFixture.outcome))).toBe(opponent);
  });
  it("FP-2: a would-be qualifier withdrawn before /complete is not seeded and her seat is left EMPTY — the bracket walks her opponent over", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    await h.step("generateLater");
    await h.step("playStage1");
    // Seed 1 wins every game it plays (defaultPolicy): the top of the table.
    const top = h.setup.idOfSeed(1);
    await h.step({ withdrawOne: 0 });
    await h.step("complete");
    await h.step("confirmLatest");
    expect(h.confirmedIds()).toHaveLength(1);
    const declared = h.declared();
    expect(h.seeded()).not.toContain(top);
    expect(h.seeded().length).toBe(declared - 1);
    // Her seat is empty and its line is a walkover to the seated side — nobody was promoted into it.
    const bye = d.fixturesOfStage(2).filter((f) => f.round_no === 1 && (f.home_entrant_id === null) !== (f.away_entrant_id === null));
    expect(bye).toHaveLength(1);
    expect(bye[0]!.status).toBe("forfeited");
    expect(winnerOf(toObservedOutcome(bye[0]!.outcome))).toBe(bye[0]!.home_entrant_id ?? bye[0]!.away_entrant_id);
    // The check takes the vacancy as the declared take less the withdrawn qualifier, never a pass on any count.
    // The check bounds the vacancy by the withdrawn QUALIFIER, read off the product's own stage-1 table (m-1).
    expect(h.lastAdvance).toMatchObject({ status: 200, declared });
    expect(await h.judge()).toMatchObject({ verdict: "pass", checked: 3 });
    expect(await h.judge(new Set())).toMatchObject({ verdict: "fail", evidence: [`stage 2: seeded ${declared - 1}, declared ${declared}`] });
  });
  it("empty seed: every entrant withdrawn before /complete — the confirm is refused SEEDING_NOTHING_TO_FILL, recorded, and stage 2 seats nobody", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    await h.step("generateLater");
    await h.step("playStage1");
    for (let i = 0; i < h.setup.entrants.length; i++) await h.step({ withdrawOne: i });
    await h.step("complete");
    await h.step("confirmLatest");
    expect(h.confirmedIds()).toEqual([]);
    expect(h.refusals).toContain("confirm 422 SEEDING_NOTHING_TO_FILL");
    expect(h.seeded()).toEqual([]);
    expect(h.rec.notes).toContain("confirm on stage 2 refused 422 SEEDING_NOTHING_TO_FILL");
  });
  it("a stale proposal: after a recompute, confirming /complete's id is refused SEEDING_PROPOSAL_STALE, and the recompute's id confirms", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    for (const s of ["generateLater", "playStage1", "complete", "recompute", "confirmStale"] as const) await h.step(s);
    expect(h.refusals).toEqual(["confirm 409 SEEDING_PROPOSAL_STALE"]);
    expect(h.confirmedIds()).toEqual([]);
    await h.step("confirmLatest");
    expect(h.confirmedIds()).toEqual([h.issuedIds()[1]]);
  });
  it("a second /complete never reaches the product: the guard refuses it, the product saw one", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    for (const s of ["generateLater", "playStage1", "complete", "complete"] as const) await h.step(s);
    expect(h.completesOf(1)).toBe(1);
    expect(d.trace.filter((c) => c === `completeStage ${d.stageIdAt(1)}`)).toHaveLength(1);
    expect(h.refusals).toEqual(["complete repeated: refused by the driver's guard"]);
  });
  it("FP-1: a /complete before the later stage's TBD rows exist commits the stage, answers 409 STAGE_COMPLETED_SEEDING_FAILED, and a recompute after generating recovers", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko");
    await h.step("playStage1");
    const c = await finishStage(h.ctx, h.rec, h.stage1.id);
    // m-7: the product committed the stage; the 409 names the half that failed.
    expect(c).toMatchObject({ status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED", completed: true, seedProposal: null });
    expect(h.rec.notes).toContain("complete committed, but the next stage's seeding failed: 409 STAGE_COMPLETED_SEEDING_FAILED");
    expect(h.completesOf(1)).toBe(1);
    await expect(finishStage(h.ctx, h.rec, h.stage1.id)).rejects.toBeInstanceOf(DriverMisuse);
    await h.step("generateLater");
    expect(h.rec.track(h.stage2.id).generates.at(-1)).toMatchObject({ status: 200, created: 3 });
    await h.step("recompute");
    await h.step("confirmLatest");
    expect(h.confirmedIds()).toHaveLength(1);
  });
  it("T45-R2: a later-stage fixture first seen TBD gets its lineups once confirm seats it under the SAME id (the guard keys on fixture + side)", async () => {
    const football = offlineBuilderDefault("football");
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "league_ko", { sport: "football", variant: football });
    await h.step("generateLater");
    const tbd = d.fixturesOfStage(2).find((f) => f.round_no === 1)!;
    expect([tbd.home_entrant_id, tbd.away_entrant_id]).toEqual([null, null]);
    await ensureLineups(h.ctx, h.rec, h.setup, tbd);
    expect(d.trace.filter((c) => c.startsWith(`putLineup ${tbd.id} `))).toEqual([]);
    for (const s of ["playStage1", "complete", "confirmLatest"] as const) await h.step(s);
    const seated = d.fixturesOfStage(2).find((f) => f.id === tbd.id)!;
    expect(seated.home_entrant_id).not.toBeNull();
    expect(seated.away_entrant_id).not.toBeNull();
    await ensureLineups(h.ctx, h.rec, h.setup, seated);
    expect(d.trace.filter((c) => c.startsWith(`putLineup ${tbd.id} `))).toEqual([`putLineup ${tbd.id} ${seated.home_entrant_id}`, `putLineup ${tbd.id} ${seated.away_entrant_id}`]);
    // …and a second call PUTs nothing more.
    await ensureLineups(h.ctx, h.rec, h.setup, seated);
    expect(d.trace.filter((c) => c.startsWith(`putLineup ${tbd.id} `))).toHaveLength(2);
  });
});

// W1-driving Task 9 (ruling 45): a later stepladder or page playoff is judged
// on the winner of its TERMINAL final. The keys are the snapshot's, derived
// from the engine; the fake serves the engine's own is_final rows, so the two
// meet only if the snapshot sized the bracket the way the product laid it out.
describe("I2 structural on the later bracket stages the fake draws (W1-driving Task 9, ruling 45)", () => {
  const I2 = "I2-bracket-one-champion-ranks-permutation";
  const STRUCT_ROWS = FAKE_ROWS.filter((r) => stagesForRow(r).slice(1).some((b) => STRUCTURAL_FINAL_KINDS.includes(b.kind)));
  const variantOf = (row: Row) => (bracketDrawDeclared(row, "generic", "score") ? "win_loss" : "score");
  const servedFinals = (s: ObservedStage) => s.fixtures.filter((f) => f.isFinal === true).map((f) => f.extKey);
  it("each row: the snapshot's terminal keys are the is_final rows the fake served, and I2 passes with rank 1 = that final's winner — counted", async () => {
    let judged = 0;
    for (const row of STRUCT_ROWS) {
      const { out, checks } = await runOn(new FakeMultiStageDriver(), "LIFECYCLE", { row, variant: variantOf(row) });
      for (const s of out.observed.stages) {
        if (!STRUCTURAL_FINAL_KINDS.includes(s.kind)) { expect(s.terminalFinals, `${row} stage ${s.seq}`).toBeUndefined(); continue; }
        const served = servedFinals(s);
        expect(served.length, `${row} stage ${s.seq}`).toBeGreaterThan(0);
        expect(s.terminalFinals, `${row} stage ${s.seq}`).toEqual(served);
        const final = s.fixtures.find((f) => f.extKey === served.at(-1))!;
        expect(winnerOf(final.outcome), `${row} stage ${s.seq}`).not.toBeNull();
        expect(s.complete?.finalRanks?.[0], `${row} stage ${s.seq}`).toBe(winnerOf(final.outcome));
        judged++;
      }
      expect(checks.find((c) => c.id === I2), row).toMatchObject({ verdict: "pass" });
    }
    expect(judged).toBe(STRUCT_ROWS.length);
    expect(judged).toBeGreaterThan(0);
    process.stdout.write(`I2 structural over the fake's later brackets: ${judged} stage(s) (${STRUCT_ROWS.join(", ")})\n`);
  });
  it("a product whose finalRanks put the terminal final's loser first reds I2, naming the final and its winner", async () => {
    class LoserFirst extends FakeMultiStageDriver {
      override async completeStage(stageId?: string) {
        const out = await super.completeStage(stageId);
        const kind = this.stages.find((s) => s.id === stageId)?.kind;
        if (kind === undefined || !STRUCTURAL_FINAL_KINDS.includes(kind)) return out;
        return { ...out, events: out.events.map((e) => (e.finalRanks === undefined ? e : { ...e, finalRanks: [e.finalRanks[1]!, e.finalRanks[0]!, ...e.finalRanks.slice(2)] })) };
      }
    }
    let judged = 0;
    for (const row of STRUCT_ROWS) {
      const { out, checks } = await runOn(new LoserFirst(), "LIFECYCLE", { row, variant: variantOf(row) });
      const s = out.observed.stages.find((x) => STRUCTURAL_FINAL_KINDS.includes(x.kind))!;
      const key = servedFinals(s).at(-1)!;
      const winner = winnerOf(s.fixtures.find((f) => f.extKey === key)!.outcome);
      const c = checks.find((x) => x.id === I2)!;
      expect(c.verdict, row).toBe("fail");
      expect(c.evidence, row).toContain(`rank 1 is ${s.complete!.finalRanks![0]}, the ${key} winner is ${winner}`);
      judged++;
    }
    expect(judged).toBe(STRUCT_ROWS.length);
  });
  it("FP-2: a qualifier withdrawn before /complete leaves a vacancy — the keys are the DECLARED bracket's, as the product laid it out at setup, never the smaller seeded field's", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "group_stepladder");
    expect(h.stage2.kind).toBe("stepladder");
    await h.step("generateLater");
    await h.step("playStage1");
    await h.step({ withdrawOne: 0 });
    await h.step("complete");
    await h.step("confirmLatest");
    const a = h.lastAdvance!;
    const declared = h.declared();
    expect(a.seeded.length).toBe(declared - 1);
    const plays: StagePlay[] = [
      { stage: h.stage1, field: h.sourceField(), advance: null, complete: h.lastComplete },
      { stage: h.stage2, field: a.seeded, advance: a, complete: null },
    ];
    const observed = await snapshot(h.ctx, h.rec, h.setup, plays, { configEdit: null, withdrawal: null });
    const s2 = observed.stages[1]!;
    const served = servedFinals(s2);
    expect(s2.terminalFinals).toEqual(served);
    // Derived from the engine at the declared size; the seeded size gives a different key (the differing case).
    expect(served).toEqual(terminalFinalKeys("stepladder", Array.from({ length: declared }, (_, i) => `slot:${i}`), {}));
    expect(terminalFinalKeys("stepladder", a.seeded, {})).not.toEqual(served);
  });
  it("a page playoff sized where the engine refuses to lay one out carries NO keys (I2 then names them missing) — the snapshot never throws the case away; the declared 4 carries the final's", async () => {
    const d = new FakeMultiStageDriver();
    const h = await AdvanceHarness.open(d, "group_playoffs", { variant: "win_loss" });
    expect(h.stage2.kind).toBe("page_playoff");
    for (const step of ["generateLater", "playStage1", "complete", "confirmLatest"] as const) await h.step(step);
    const a = h.lastAdvance!;
    const root: StagePlay = { stage: h.stage1, field: h.sourceField(), advance: null, complete: h.lastComplete };
    const as = async (p: StagePlay) => (await snapshot(h.ctx, h.rec, h.setup, [root, p], { configEdit: null, withdrawal: null })).stages[1]!;
    const real = await as({ stage: h.stage2, field: a.seeded, advance: a, complete: null });
    expect(real.terminalFinals).toEqual(servedFinals(real));
    expect(real.terminalFinals).toHaveLength(1);
    const short = await as({ stage: h.stage2, field: a.seeded.slice(0, 3), advance: { ...a, declared: 3 }, complete: null });
    expect(short.terminalFinals).toEqual([]);
    // A stage that was never reached has no field, and so no keys at all.
    const unreached = await as({ stage: h.stage2, field: null, advance: null, complete: null });
    expect(unreached.terminalFinals).toBeUndefined();
  });
});

// W2a Task 14, phase 3: the bracket-finish scenarios' pick (RoundHooks.bracketPick) is the scenario's rule for EVERY
// bracket match. playDivision gave the round hooks to stage 1 only (D12), so on ko_plate and qualifying_main the second
// bracket was decided by bracketPolicy while its scenario's check counted it as a match that must take the forced path:
// 48 truth-run reds on the bracket-root rows (33 abandon, 9 level, 3 tie-break, 3 extra board), none a product defect. league_ko is the fake's one row
// with a bracket BEHIND a table, so a bracket stage after stage 1 is reached with a real producer and consumer.
describe("W2a: a scenario's bracketPick reaches a bracket stage after stage 1 (playDivision)", () => {
  it("every match of the later knockout is asked by the pick, not bracketPolicy: n counts run-wide from 0, `higher` is the better seed's side; stage 1's table is untouched by it", async () => {
    const driver = new FakeMultiStageDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "league_ko" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor("league_ko", "LIFECYCLE"));
    const calls: { fixtureId: string; n: number; higher: string }[] = [];
    // The side the policy would NOT pick, so a match bracketPolicy decided is told from one the pick decided.
    const against = (f: FixtureRow, n: number, higher: "home" | "away") => { calls.push({ fixtureId: f.id, n, higher }); return { kind: "win", winner: higher === "home" ? "away" : "home" } as const; };
    await playDivision(ctx, rec, setup, { bracketPick: against });
    // The rule: the better seed is the LOWER seed number (setup.seedOf). The drives are what the product was asked.
    expect(rec.bracketDrives.length, "the later knockout drove some matches").toBeGreaterThan(0);
    expect(calls.length, "the pick was asked for every one of them").toBe(rec.bracketDrives.length);
    expect(calls.map((c) => c.n), "n is the run-wide bracket ordinal").toEqual(rec.bracketDrives.map((_, i) => i));
    for (const d of rec.bracketDrives) {
      const better = setup.seedOf(d.home) < setup.seedOf(d.away) ? "home" : "away";
      const call = calls.find((c) => c.fixtureId === d.fixtureId)!;
      expect(call.higher, d.fixtureId).toBe(better);
      expect(d.asked, d.fixtureId).toEqual({ kind: "win", winner: better === "home" ? "away" : "home" });
    }
    // Stage 1 is a league: no bracket fixture, so none of its matches reached the pick.
    const stage1 = new Set(driver.fixturesOfStage(1).map((f) => f.id));
    expect(calls.filter((c) => stage1.has(c.fixtureId))).toEqual([]);
    expect(stage1.size).toBeGreaterThan(0);
  });
  it("the round hooks stay on stage 1 (D12): the pick goes to later stages, beforeRound and afterRound do not", async () => {
    const driver = new FakeMultiStageDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "league_ko" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor("league_ko", "LIFECYCLE"));
    const hooked: string[] = [];
    const stage1 = new Set(driver.fixturesOfStage(1).map((f) => f.id));
    const note = async (_round: number, batch: FixtureRow[]) => { for (const f of batch) hooked.push(f.id); };
    await playDivision(ctx, rec, setup, { beforeRound: note, afterRound: note, bracketPick: (_f, _n, higher) => ({ kind: "win", winner: higher }) });
    expect(hooked.length, "the hooks ran on stage 1").toBeGreaterThan(0);
    expect(hooked.filter((id) => !stage1.has(id)), "no later-stage fixture reached a round hook").toEqual([]);
    expect(rec.bracketDrives.length, "while the pick did reach the later stage").toBeGreaterThan(0);
  });
  it("no pick: the later knockout is asked by bracketPolicy byte for byte (the hard path on the first of each three, a plain win for the better seed otherwise)", async () => {
    const driver = new FakeMultiStageDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "league_ko" });
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, fieldSizeFor("league_ko", "LIFECYCLE"));
    await playDivision(ctx, rec, setup, {});
    expect(rec.bracketDrives.length).toBeGreaterThan(0);
    rec.bracketDrives.forEach((d, i) => {
      const better = setup.seedOf(d.home) < setup.seedOf(d.away) ? "home" : "away";
      if (i % 3 !== 0) expect(d.asked, `match ${i}`).toEqual({ kind: "win", winner: better });
      else expect(d.asked.kind, `match ${i} is the hard path`).not.toBe("win");
    });
  });
});
