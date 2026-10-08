// W1-driving Task 7 (D8, D14; rulings 51, 52, 53): a ladder is driven through
// challenges, never through generate. Expected values come from the RULE
// (an adjacent upward challenge that the challenger wins swaps the two;
// anything else moves nobody — usecases/scoring.ts:774-786), from the
// product's text (product-text.ts) or from the engine's declarations
// (supportsDraws via drawsAllowed) — never from ladder-loop.ts itself.
//
// Transitions: an empty ladder (0 or 1 entrant); the first challenge; the
// last; a refusal at step 1; a withdrawal in the middle (R4, D14); a
// walkover challenge (M1, the last step); a withdrawal at ANY step (the
// fast-check property); a second sport (the registry sweep).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETTLE_METHODS, StageKind } from "@seazn/engine/core";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { fieldSizeFor } from "../lib/field-size.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { DEPARTED_STATUSES, FORFEIT_MODEL_KINDS, PENDING_STATUSES, snap, type FixtureSnap, type ObservedFixture, type ObservedOutcome } from "../lib/observed.ts";
import { decideState, type CheckResult } from "../lib/results.ts";
import { Recorder, decideFixture, setUpDivision, type DivisionSetup } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ladderSchedule, playLadder } from "../lib/scenarios/ladder-loop.ts";
import { cascadeItems, notChallengedLater } from "../lib/scenarios/r4-withdrawal.ts";
import type { CaseSpec, ScenarioContext, ScenarioKey } from "../lib/scenarios/types.ts";
import { planCanaryCase } from "../lib/slice.ts";
import { drawsAllowed, resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FakeLadderDriver } from "./fake-formats-driver.ts";
import { bracketWalkoverKindsText, departedStatusesText, ladderText, wireCodeFor, withdrawalPendingText, withdrawalTableKindsText } from "./product-text.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
/** Captured at Task 7 Step 0 from 88b233484 (before any Task 7 change); never regenerated in this task (review 3 m-2). */
const R4_CANARY_BEFORE = resolve(HERE, "fixtures", "r4-canary-before.json");
/** lib/table-withdrawal.ts WITHDRAWAL_PENDING_STATUSES, read as text (plan review 2 m-3). */
const PENDING: ReadonlySet<string> = new Set(withdrawalPendingText());
/** withdrawal.ts:37 TABLE_KINDS and stages.ts:880-884 BRACKET_WALKOVER_KINDS, read as text. */
const TABLE_KINDS_PINNED: ReadonlySet<string> = new Set(withdrawalTableKindsText());
const BRACKET_KINDS_PINNED: ReadonlySet<string> = new Set(bracketWalkoverKindsText());
const variantFor = offlineBuilderDefault;

interface Opts { canary?: boolean; row?: CaseSpec["row"]; sport?: string; variant?: string }
function ctxFor(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = opts.variant ?? variantFor(sport);
  const row = opts.row ?? "ladder";
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${scenario}`, row, sport, variant, scenario, canary: opts.canary ?? false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}
async function runOn(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }).state };
}
/** A canary case run end to end as run.ts would: invariants + assertions → the decided state. */
async function runCanary(spec: CaseSpec, driver: FakeLeagueDriver): Promise<{ verdict: string; checks: CheckResult[] }> {
  const out = await SCENARIOS[spec.scenario].run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(spec.sport, spec.variant), tag: "t", denied: [] });
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { verdict: decideState({ checks, deferred: null, error: null }).state, checks };
}
/** D8 (ruling 52), stated from the ruling and not read from ladder-loop.ts: step k of n−1 has the challenger climb on odd k. */
const D8_CLIMBS = (k: number): boolean => k % 2 === 1;
/** D8's first non-climbing step over a field of n (null: none) — where a draw goes when the engine declares one. */
const firstNonClimb = (n: number): number | null => Array.from({ length: Math.max(0, n - 1) }, (_, j) => j + 1).find((k) => !D8_CLIMBS(k)) ?? null;
/** The adjacent-swap RULE applied to a seed order over D8's sweep (no playLadder). */
function swapRule(seeds: readonly string[]): string[] {
  const expected = [...seeds];
  for (let k = 1; k < seeds.length; k++) {
    const i = seeds.length - k;
    if (D8_CLIMBS(k)) [expected[i - 1], expected[i]] = [expected[i]!, expected[i - 1]!];
  }
  return expected;
}

/** Plan review 1 I-5: a thin helper over the REAL setup and the REAL loop —
 *  setUpDivision on the fake, then playLadder with an afterRound hook that
 *  withdraws per the generated list. It has no challenge logic of its own.
 *  Normalisation (plan review 2 m-5), before play and counted: seedIdx is
 *  taken modulo n; a repeat of an entrant already listed is dropped (the
 *  product refuses a second withdrawal — Task 6's sequence, not this one's);
 *  afterStep 0 names no step (the hook runs after step 1 at the earliest), so
 *  it is read as step 1; a withdrawal whose step never runs is not applied. */
class LadderHarness {
  readonly #ctx: ScenarioContext;
  readonly #rec: Recorder;
  readonly #setup: DivisionSetup;
  readonly #plan: readonly { at: number; id: string }[];
  readonly dropped: number;
  #applied = 0;
  private constructor(ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup, plan: readonly { at: number; id: string }[], dropped: number) {
    this.#ctx = ctx;
    this.#rec = rec;
    this.#setup = setup;
    this.#plan = plan;
    this.dropped = dropped;
  }
  static async open(d: FakeLadderDriver, n: number, withdrawals: readonly { afterStep: number; seedIdx: number }[]): Promise<LadderHarness> {
    const ctx = ctxFor(d, "LIFECYCLE");
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, n);
    const seen = new Set<string>();
    const plan: { at: number; id: string }[] = [];
    let dropped = 0;
    for (const w of withdrawals) {
      const id = setup.idOfSeed((w.seedIdx % n) + 1);
      if (seen.has(id)) { dropped++; continue; }
      seen.add(id);
      plan.push({ at: Math.max(1, w.afterStep), id });
    }
    return new LadderHarness(ctx, rec, setup, plan, dropped);
  }
  async play(): Promise<void> {
    await playLadder(this.#ctx, this.#rec, this.#setup, this.#setup.stage, {
      afterRound: async (step) => {
        for (const p of this.#plan.filter((x) => x.at === step)) {
          await this.#ctx.driver.withdraw(p.id);
          this.#rec.withdrawn.add(p.id);
          this.#applied++;
        }
      },
    });
  }
  get exit() { return this.#rec.exit; }
  skippedWithdrawals(): number { return this.#plan.length - this.#applied; }
}

describe("ladderSchedule and playLadder — D8 (ruling 52)", () => {
  it("empty case first: a field of 0 or 1 plans no challenge, and playing it reds (never drained)", async () => {
    expect(ladderSchedule(0)).toEqual([]);
    expect(ladderSchedule(1)).toEqual([]);
    for (const n of [0, 1]) {
      const d = new FakeLadderDriver();
      const ctx = ctxFor(d, "LIFECYCLE");
      const rec = new Recorder();
      const setup = await setUpDivision(ctx, rec, n);
      await playLadder(ctx, rec, setup, setup.stage, {});
      expect(rec.exit, `field ${n}`).toBe("refused_challenge");
      expect(rec.track(setup.stage.id).exit).toBe("refused_challenge");
      expect(rec.notes).toContain("ladder: a field of < 2 has no challenge");
      expect(d.calls.filter((c) => c === "challenge")).toEqual([]);
    }
  });

  it("n entrants → n−1 adjacent upward challenges, bottom-up, the challenger winning on odd steps", () => {
    const s = ladderSchedule(8);
    expect(s.length).toBe(7);
    for (const c of s) { expect(c.opponentIdx).toBe(c.challengerIdx - 1); expect(c.challengerWins).toBe(c.step % 2 === 1); }
    expect(s.map((c) => c.challengerIdx)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    // The bound is the field, never a literal: the smallest ladder has one challenge.
    expect(ladderSchedule(2)).toEqual([{ step: 1, challengerIdx: 1, opponentIdx: 0, challengerWins: true }]);
  });

  it("ladder|generic LIFECYCLE on the fake: every challenge legal, the final order is the adjacent-swap rule applied to seed order", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, state } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
    const seeds = driver.entrantsBySeed();
    // Expected order from the RULE (a challenger who wins takes the place above; loses: no change), not from playLadder.
    const expected = swapRule(seeds);
    expect(driver.ladderOrder()).toEqual(expected);
    expect(out.observed.stages[0]!.complete?.finalRanks).toEqual(expected);
    expect(driver.refusedChallenges()).toEqual([]);
    expect(driver.issuedChallenges().length).toBe(seeds.length - 1);
    expect(state).toBe("works");
  });

  it("playLadder reads the live order from the stage after each decide, never from the challenge answer (fake option staleLadderOrderInAnswer)", async () => {
    // Range 1, not 3: D8's FINAL order survives a stale read under any wider reach — an odd step's pair is untouched
    // before it, and a stale even-step challenger loses anyway — so only the reach can witness the wrong challenger
    // (found by the Step 5 mutation sweep: at range 3 this test stayed green with the re-list deleted).
    const driver = new FakeLadderDriver({ challengeRange: 1, staleLadderOrderInAnswer: true });
    const { state } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
    expect(driver.ladderOrder()).toEqual(swapRule(driver.entrantsBySeed()));
    expect(driver.refusedChallenges()).toEqual([]);
    expect(driver.issuedChallenges().every((c) => c.liveAdjacentAtIssue)).toBe(true);
    expect(driver.issuedChallenges().length).toBe(driver.entrants.length - 1);
    expect(state).toBe("works");
  });

  it("no challenge played is red, never drained: a fake that refuses every challenge leaves exit refused_challenge, life-loop-bounded fails, the refusal is noted, and the stage does not complete (so I9 abstains)", async () => {
    const { out, checks } = await runOn(new FakeLadderDriver({ refuseAll: "LADDER_CHALLENGE_OUT_OF_RANGE" }), "LIFECYCLE", { row: "ladder" });
    expect(checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("fail");
    expect(out.observed.stages[0]!.exit).toBe("refused_challenge");
    expect(out.notes).toContain("ladder step 1: challenge refused 422 LADDER_CHALLENGE_OUT_OF_RANGE");
    // The stage's /complete answers not-complete over zero fixtures, so I9 (Task 9) has no completed ladder to judge.
    expect(out.observed.stages[0]!.complete).toMatchObject({ completed: false });
    expect(checks.find((c) => c.id === "I9-ladder-order-is-the-field")).toMatchObject({ verdict: "abstain", checked: 0 });
  });

  describe("I9 on the real snapshot (W1-driving Task 9)", () => {
    const I9 = "I9-ladder-order-is-the-field";
    it("LIFECYCLE: I9 passes over every entrant, and the order it compares is the raw stored order the product holds at the end of the run — not the setup-time config copy", async () => {
      const driver = new FakeLadderDriver();
      const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
      const s = out.observed.stages[0]!;
      // The fake's own order (D8's rule applied to the seeds), independent of I9 and of the snapshot.
      expect(driver.ladderOrder()).toEqual(swapRule(driver.entrantsBySeed()));
      expect(s.config.ladder_order).toEqual(driver.ladderOrder());
      expect(s.complete?.finalRanks).toEqual(driver.ladderOrder());
      expect(checks.find((c) => c.id === I9)).toMatchObject({ verdict: "pass", checked: driver.entrants.length });
    });
    it("a product whose stored ladder_order and finalRanks disagree reds I9 naming both", async () => {
      class OrderDrifts extends FakeLadderDriver {
        override async listStages() {
          const refs = await super.listStages();
          return refs.map((r) => (Array.isArray(r.config.ladder_order) ? { ...r, config: { ...r.config, ladder_order: [...(r.config.ladder_order as string[])].reverse() } } : r));
        }
      }
      const driver = new OrderDrifts();
      const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
      const c = checks.find((x) => x.id === I9)!;
      expect(c.verdict).toBe("fail");
      expect(c.evidence).toContain(`stage seq 1: finalRanks differ from ladder_order: ${out.observed.stages[0]!.complete!.finalRanks!.join(",")} vs ${[...driver.ladderOrder()].reverse().join(",")}`);
    });
    it("T7 carry r1-b: finalRanks with a duplicate in place of one entrant, or a foreign id in place of one, reds I9 although its length is right", async () => {
      const wrong = (edit: (ranks: string[]) => string[]) => class extends FakeLadderDriver {
        override async completeStage() {
          const out = await super.completeStage();
          return { ...out, events: out.events.map((e) => (e.finalRanks === undefined ? e : { ...e, finalRanks: edit(e.finalRanks) })) };
        }
      };
      const dup = await runOn(new (wrong((r) => [r[0]!, r[0]!, ...r.slice(2)]))(), "LIFECYCLE", { row: "ladder" });
      const second = dup.out.observed.stages[0]!.config.ladder_order as string[];
      const d = dup.checks.find((x) => x.id === I9)!;
      expect(d.verdict).toBe("fail");
      expect(d.evidence).toEqual(expect.arrayContaining([`${second[0]} ranked 2×`, `${second[1]} not ranked`]));
      const foreign = await runOn(new (wrong((r) => ["stranger", ...r.slice(1)]))(), "LIFECYCLE", { row: "ladder" });
      const f = foreign.checks.find((x) => x.id === I9)!;
      expect(f.verdict).toBe("fail");
      expect(f.evidence).toEqual(expect.arrayContaining(["stranger ranked but not in the field", `${(foreign.out.observed.stages[0]!.config.ladder_order as string[])[0]} not ranked`]));
    });
  });

  it("a second sport, the registry swept: every sport plays the same sweep to the same rule order; a ladder is a bracket kind (X-DR-1) so NO sport posts a draw, and the hard path (a settle, a chess tie-break) is posted on the first climb and the first non-climbing step", async () => {
    let judged = 0;
    let deciders = 0;
    for (const sport of SPORT_KEYS) {
      const driver = new FakeLadderDriver();
      const { out, state, checks } = await runOn(driver, "LIFECYCLE", { row: "ladder", sport });
      const failing = checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`);
      expect(failing, sport).toEqual([]);
      expect(state, sport).toBe("works");
      expect(driver.ladderOrder(), sport).toEqual(swapRule(driver.entrantsBySeed()));
      // X-DR-1, from the engine's own declaration (supportsDraws, called directly): a ladder declares no draw, in any sport.
      const cfg = resolveSportCfg(sport, variantFor(sport));
      expect(sportModule(sport).supportsDraws(cfg, "ladder"), `${sport}: supportsDraws on a ladder`).toBe(false);
      expect(drawsAllowed(sport, cfg, "ladder"), `${sport}: drawsAllowed on a ladder`).toBe(false);
      const loss = firstNonClimb(driver.entrants.length);
      expect(loss, sport).not.toBeNull();
      const hardSteps = [1, loss!];
      const byStep = new Map(driver.issuedChallenges().map((c) => [c.step, driver.fixtures.find((f) => f.id === c.fixtureId)!.outcome as { kind: string; method?: string } | null]));
      expect(driver.decidedChallenges().filter((c) => c.kind === "draw"), sport).toEqual([]);
      expect(byStep.size, sport).toBe(driver.entrants.length - 1);
      for (const [step, o] of byStep) {
        expect(o?.kind, `${sport} step ${step}`).toBe("win"); // every step ends in a WIN: never a draw, never undecided
        const method = o?.method ?? "";
        if (hardSteps.includes(step)) {
          // The hard path leaves its method on the outcome: a settle's (SETTLE_METHODS) or a chess tie-break's rung (TIEBREAK_RUNGS).
          const prefix = sport === "boardgame" ? "tiebreak_" : "settled_";
          const rest = method.slice(prefix.length);
          expect(method.startsWith(prefix) && (sport === "boardgame" ? TIEBREAK_RUNGS : SETTLE_METHODS).includes(rest as never), `${sport} step ${step}: method ${method}`).toBe(true);
          deciders++;
        } else {
          expect(method.startsWith("settled_") || method.startsWith("tiebreak_"), `${sport} step ${step}: a plain step is a plain win`).toBe(false);
        }
      }
      expect(out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "draw").length, sport).toBe(0);
      judged++;
    }
    process.stdout.write(`ladder registry sweep: ${judged} sports judged, ${deciders} deciders\n`);
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
    expect(deciders).toBe(judged * 2); // anti-vacuity: the two hard steps ran in every sport
    // The positive pair, so the declaration is not a constant false: a table stage still declares draws for a sport.
    expect(SPORT_KEYS.some((sport) => drawsAllowed(sport, resolveSportCfg(sport, variantFor(sport)), "league"))).toBe(true);
  });
});

describe("FakeLadderDriver mirrors issueChallenge (stages.ts:5503-5657)", () => {
  it("its four refusal codes are the product's own, and the default reach is the product's", () => {
    const t = ladderText();
    expect(t.codes).toEqual(["LADDER_ENTRANT_FOREIGN", "LADDER_ENTRANT_WITHDRAWN", "LADDER_CHALLENGE_NOT_UPWARD", "LADDER_CHALLENGE_OUT_OF_RANGE"]);
    expect(t.defaultRange).toBeGreaterThan(0);
    expect(t.fieldStatuses.length).toBeGreaterThan(0);
    expect([...DEPARTED_STATUSES].sort()).toEqual(departedStatusesText().sort());
    expect(DEPARTED_STATUSES).toContain("withdrawn");
  });
  it("each refusal is reachable, in the product's precedence, and a refusal inserts no fixture", async () => {
    const d = new FakeLadderDriver({ challengeRange: 1 });
    const ctx = ctxFor(d, "LIFECYCLE");
    const setup = await setUpDivision(ctx, new Recorder(), 4);
    const [s1, s2, s3, s4] = [1, 2, 3, 4].map((n) => setup.idOfSeed(n));
    const code = (p: Promise<unknown>) => p.then(() => "issued", (e: { code?: string }) => e.code);
    expect(await code(d.challenge(setup.stage.id, "nobody", s1!))).toBe("LADDER_ENTRANT_FOREIGN");
    expect(await code(d.challenge(setup.stage.id, s1!, s2!))).toBe("LADDER_CHALLENGE_NOT_UPWARD");
    expect(await code(d.challenge(setup.stage.id, s4!, s2!))).toBe("LADDER_CHALLENGE_OUT_OF_RANGE");
    // A refusal rolls the first-use ladder_order write back with it, and inserts nothing.
    expect([d.fixtures, d.ladderOrder()]).toEqual([[], []]);
    expect(await code(d.challenge(setup.stage.id, s4!, s3!))).toBe("issued");
    expect(d.ladderOrder()).toEqual([s1, s2, s3, s4]); // written by seed on the first issued challenge
    await d.withdraw(s3!);
    // Departed beats not-upward (both apply: s3 is below s1 raw, and departed).
    expect(await code(d.challenge(setup.stage.id, s1!, s3!))).toBe("LADDER_ENTRANT_WITHDRAWN");
    // Reach counts LIVE rungs (F7): with s3 gone, s4 → s2 is one place.
    expect(await code(d.challenge(setup.stage.id, s4!, s2!))).toBe("issued");
    expect(d.ladderOrder()).toEqual([s1, s2, s3, s4]); // raw, never pruned
    expect(d.fixtures.map((f) => [f.home_entrant_id, f.away_entrant_id, f.round_no, f.status])).toEqual([[s4, s3, 1, "abandoned"], [s4, s2, 2, "scheduled"]]);
    expect(d.refusedChallenges().map((r) => r.code)).toEqual(["LADDER_ENTRANT_FOREIGN", "LADDER_CHALLENGE_NOT_UPWARD", "LADDER_CHALLENGE_OUT_OF_RANGE", "LADDER_ENTRANT_WITHDRAWN"]);
  });
});

describe("FakeLadderDriver's swap (usecases/scoring.ts:774-786)", () => {
  it("only a decided WIN by the lower player swaps: an award to the challenger (a walkover) and a settled loss move nobody — each the differing case against a swap", async () => {
    const d = new FakeLadderDriver();
    const ctx = ctxFor(d, "LIFECYCLE");
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, 3);
    const [s1, s2, s3] = [1, 2, 3].map((n) => setup.idOfSeed(n));
    const issue = async () => {
      const { fixture_id } = await d.challenge(setup.stage.id, s3!, s2!);
      return (await ctx.driver.listFixtures(setup.division.id)).find((f) => f.id === fixture_id)!;
    };
    // Award to the challenger: s2 (home is the challenger, s3) does not turn up.
    const walkover = await issue();
    await decideFixture(ctx, rec, setup, walkover, { kind: "forfeit", by: "away", reason: "walkover" });
    expect([d.decidedChallenges().at(-1)!.kind, d.decidedChallenges().at(-1)!.winner]).toEqual(["award", s3]);
    expect(d.ladderOrder()).toEqual([s1, s2, s3]);
    // A settled loss for the challenger (a ladder is a bracket kind, X-DR-1: no draw exists here; the hard path is a settle).
    expect(drawsAllowed("generic", ctx.cfg, "ladder")).toBe(false);
    await decideFixture(ctx, rec, setup, await issue(), { kind: "settle", then: "away", method: "lot", after: "abandon" });
    const settledLoss = d.decidedChallenges().at(-1)!;
    expect([settledLoss.kind, settledLoss.winner, d.ladderOrder()]).toEqual(["win", s2, [s1, s2, s3]]);
    // The positive pair: the challenger's WIN swaps.
    await decideFixture(ctx, rec, setup, await issue(), { kind: "win", winner: "home" });
    expect(d.ladderOrder()).toEqual([s1, s3, s2]);
  });
});

/** Review m-3: a private copy of the product's pending set or kind union, in any shape. Comments are stripped first; a
 *  literal in any quote counts, and so does an unquoted record key. A negated status predicate (`!isTerminal(b.status)`,
 *  the shape Task 7 replaced) is a pending set by negation. A source may name at most ONE pinned kind
 *  (r4-not-paired-later's `=== "swiss"`): two or more, in any shape — array, Set, record, `||` chain, switch — is a list.
 *  What it does NOT see: a kind or status built at run time (string concatenation, a computed key). */
function privateCopies(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const quoted = (w: string) => new RegExp(`(["'\`])${w}\\1`).test(code);
  const keyed = (w: string) => new RegExp(`(^|[{,\\s])${w}\\s*:(?!:)`, "m").test(code);
  const found = [...PENDING].filter(quoted).map((x) => `pending literal ${x}`);
  if (/\bisTerminal\b/.test(code) || /!\s*is[A-Z]\w*\([^)]*\bstatus\b[^)]*\)/.test(code)) found.push("a negated status predicate (a pending set by negation)");
  const named = [...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED].filter((k) => quoted(k) || keyed(k));
  if (named.length >= 2) found.push(`a kind list: ${named.join(", ")}`);
  return found;
}

describe("the private-copy scan (review m-3): one probe per shape", () => {
  it("flags every shape of a second pending or kind list, and passes a lone kind comparison, a comment and the shared constant", () => {
    const caught: [string, string][] = [
      ["a single-quoted pending Set", "const P = new Set(['scheduled', 'in_play']);"],
      ["a double-quoted pending Set", 'const P = new Set(["scheduled", "in_play"]);'],
      ["a backtick pending literal", "if (b.status === `in_play`) walk(b);"],
      ["a negated isTerminal", "if (!isTerminal(b.status)) walk(b);"],
      ["a negated status predicate under another name", "if (!isDone(b.status)) walk(b);"],
      ["an || chain", 'const forfeit = kind === "league" || kind === "group";'],
      ["a single-quoted kind array", "const K = ['league', 'swiss'];"],
      ["a multi-line kind array", '[\n  "league",\n  "swiss",\n]'],
      ["a record with unquoted kind keys", "const M = { league: 'forfeit', knockout: 'forfeit' };"],
      ["a switch over kinds", 'switch (kind) { case "swiss": case "double_elim": return 1; }'],
    ];
    const passed: [string, string][] = [
      ["a lone kind comparison", 'if (kind === "swiss") x();'],
      ["kinds in a comment only", '// "league" || "group" — prose\nconst y = 1;'],
      ["kinds in a block comment only", '/* ["league", "swiss"] */ const y = 1;'],
      ["the shared constants", "const p = PENDING_STATUSES.includes(b.status) && FORFEIT_MODEL_KINDS.includes(kind);"],
      ["a positive status predicate", "if (isOpen(b.status)) walk(b);"],
    ];
    for (const [name, src] of caught) expect(privateCopies(src).length, `caught: ${name}`).toBeGreaterThan(0);
    for (const [name, src] of passed) expect(privateCopies(src), `passed: ${name}`).toEqual([]);
    process.stdout.write(`private-copy scan: ${caught.length} shapes caught, ${passed.length} clean shapes passed\n`);
    expect(caught.length + passed.length).toBeGreaterThan(0);
  });
});

describe("R4 on the ladder — D14 (rulings 51, 53)", () => {
  it("R4 (D14, ruling 51): seed 3 is withdrawn after ITS first challenge, not after step 1 — reds on today's hook", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    // The step is derived from the ledger, never typed: the first decided challenge that seats seed 3.
    const ledger = driver.decidedChallenges();                       // [{step, challenger, opponent, winner}] in issue order
    const first = ledger.findIndex((c) => c.challenger === seed3 || c.opponent === seed3);
    expect(first, "seed 3 played at least one challenge").toBeGreaterThanOrEqual(0);
    expect(driver.withdrawnAfterStep()).toBe(ledger[first]!.step);
    expect(ledger.slice(first + 1).some((c) => c.challenger === seed3 || c.opponent === seed3), "seed 3 challenged after withdrawal").toBe(false);
    expect(driver.refusedChallenges()).toEqual([]);
    expect(checks.find((c) => c.id === "r4-not-challenged-later")?.verdict).toBe("pass");
    expect(out.observed.withdrawal!.afterRound).toBe(ledger[first]!.step);
  });

  it("the product's pending set, read as text: WITHDRAWAL_PENDING_STATUSES is {scheduled, in_play} (plan review 2 m-3)", () => {
    expect([...PENDING].sort()).toEqual(["in_play", "scheduled"]);
    // Review 3 m-6: ONE runtime authority. The harness's PENDING_STATUSES must equal the product's set, and
    // cascadeItems / expectedPolicy read PENDING_STATUSES, never a second list.
    expect([...PENDING_STATUSES].sort()).toEqual([...PENDING].sort());
    // The runtime kind lookup must equal the pinned union, so the harness cannot drift either.
    expect(TABLE_KINDS_PINNED.size).toBeGreaterThan(0);
    expect(BRACKET_KINDS_PINNED.size).toBeGreaterThan(0);
    expect([...FORFEIT_MODEL_KINDS].sort()).toEqual([...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED].sort());
    // …and r4-withdrawal.ts holds no private copy of either: no status or kind literal of the pinned sets in its source.
    // (A single kind literal — `=== "swiss"` for r4-not-paired-later — is no list; a list literal naming two pinned kinds is.)
    const src = readFileSync(resolve(REPO, "tools/matrix/lib/scenarios/r4-withdrawal.ts"), "utf8");
    expect(privateCopies(src), "a private pending or kind list in r4-withdrawal.ts").toEqual([]);
    expect(src).toContain("PENDING_STATUSES");
    expect(src).toContain("FORFEIT_MODEL_KINDS");
  });

  it("R4 on a ladder (ruling 53): policy derived from the product's pending set — none here — and the canary's opposite reds", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const w = out.observed.withdrawal!;
    // The oracle is the product's open-format rule (withdrawal.ts:213-217) over the text-pinned PENDING set, not r4-withdrawal.ts.
    const expected = w.before.some((f) => PENDING.has(f.status)) ? "walkover" : "none";
    expect(expected).toBe("none");                                   // D8 decides each challenge before the next is issued
    expect(w.before.length, "seed 3's decided challenge was snapshotted").toBeGreaterThan(0);
    expect([w.policy, w.walkovers, w.voided, w.skippedFinalized]).toEqual([expected, 0, 0, 0]);
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "r4-cascade-consistent")?.verdict).toBe("pass");   // seed 3's decided challenge unchanged
    // T9-R1: I9 judges the active entrants against the raw stored order, the withdrawn entrant set aside.
    expect(checks.find((c) => c.id === "I9-ladder-order-is-the-field")).toMatchObject({ verdict: "pass", checked: driver.entrants.length });
    const canary = await runOn(new FakeLadderDriver({ challengeRange: 3 }), "R4", { row: "ladder", canary: true });
    expect(canary.checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("fail");
  });

  it("R4 on a ladder (ruling 53): seed 3 is gone from the LIVE order, still in the RAW ladder_order at its held index; the finalRanks rung is a W7 note, not a check", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    const heldAt = driver.rawOrderAtWithdrawal().indexOf(seed3);      // the fake's raw order the moment withdraw() answered
    expect(heldAt).toBeGreaterThanOrEqual(0);
    expect(driver.ladderOrder().indexOf(seed3)).toBe(heldAt);         // raw: never pruned (stages.ts:5562-5572)
    expect(driver.ladderOrder().filter((e) => !driver.withdrawnIds().has(e))).not.toContain(seed3);
    const later = checks.find((c) => c.id === "r4-not-challenged-later")!;
    expect(later.verdict).toBe("pass");
    // Items: live absence, raw rung, and one per later challenge (under D8 with 8 entrants, step 6 alone).
    expect(later.checked).toBe(3);
    // W7 (review m-4): the note is written AFTER the snapshot, from the finalRanks the product minted — what was seen, not
    // what must be true. The product snapshots the RAW order (competition.ts:606), so here the rung equals the held one.
    const ranks = out.observed.stages[0]!.complete?.finalRanks ?? null;
    expect(ranks?.[heldAt]).toBe(seed3);
    const w7 = out.notes.filter((n) => /W7/.test(n));
    expect(w7).toEqual([`ladder finalRanks rung ${ranks!.indexOf(seed3)} for withdrawn ${seed3} (raw held ${heldAt}) — W7 rulebook question`]);
    expect(out.notes.some((n) => /\bkeep\b/.test(n))).toBe(false);
    expect(checks.some((c) => /finalRanks/.test(c.id))).toBe(false);  // recorded, never asserted either way…
    // …and I9 (T9-R1), which does read finalRanks, passes with the withdrawn entrant keeping its rung.
    expect(ranks).toContain(seed3);
    expect(checks.find((c) => c.id === "I9-ladder-order-is-the-field")).toMatchObject({ verdict: "pass", checked: driver.entrants.length });
  });

  it("R4 on a ladder with a PENDING challenge at withdrawal (fake option withdrawWhilePending): walkover by abandon, never by forfeit", async () => {
    // withdrawWhilePending: seed 3's first challenge is issued and the hook withdraws BEFORE its result lands.
    // The differing case: the right answer ("walkover") differs from the D8 default ("none"), so a hard-coded "none" is killed.
    const driver = new FakeLadderDriver({ challengeRange: 3, withdrawWhilePending: true });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const w = out.observed.withdrawal!;
    expect(w.before.filter((f) => PENDING.has(f.status)).length).toBe(1);
    expect([w.policy, w.walkovers, w.voided]).toEqual(["walkover", 0, 1]);          // open-format branch: abandon + voided, no forfeit
    const pending = out.observed.stages[0]!.fixtures.find((f) => f.id === w.before.find((b) => PENDING.has(b.status))!.id)!;
    expect(pending.status).toBe("abandoned");
    expect(out.observed.stages[0]!.fixtures.filter((f) => f.status === "forfeited")).toEqual([]);
    expect(checks.find((c) => c.id === "r4-policy-reported")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "r4-cascade-consistent")?.verdict).toBe("pass");  // kind-aware (false premise 16)
    expect(checks.find((c) => c.id === "r4-not-challenged-later")?.verdict).toBe("pass");
  });

  it("r4-not-challenged-later: ladder only (abstains elsewhere, checked 0); zero challenges after the withdrawal is an abstain with its reason, never a pass; each item reds alone", () => {
    const base = { kind: "ladder", seed3: "e3", heldAt: 2, raw: ["e1", "e2", "e3", "e4"], departed: new Set(["e3"]) };
    const later = (home: string, away: string): ObservedFixture => ({ id: `f-${home}-${away}`, stageId: "s1", poolId: null, roundNo: 9, home, away, status: "decided", outcome: { kind: "win", winner: home }, declared: null });
    const off = notChallengedLater({ ...base, kind: "league", later: [later("e2", "e1")] });
    expect([off.verdict, off.checked]).toEqual(["abstain", 0]);
    expect(off.reason).toMatch(/ladder only/);
    const none = notChallengedLater({ ...base, later: [] });
    expect([none.verdict, none.checked, none.reason]).toEqual(["abstain", 0, "no challenge followed the withdrawal"]);
    expect(notChallengedLater({ ...base, later: [later("e2", "e1")] })).toMatchObject({ verdict: "pass", checked: 3 });
    // Seed 3 seated later; seed 3 still live (not departed); seed 3 moved off its held rung.
    expect(notChallengedLater({ ...base, later: [later("e4", "e3")] })).toMatchObject({ verdict: "fail", checked: 3 });
    expect(notChallengedLater({ ...base, departed: new Set(), later: [later("e2", "e1")] })).toMatchObject({ verdict: "fail", checked: 3 });
    expect(notChallengedLater({ ...base, raw: ["e1", "e3", "e2", "e4"], later: [later("e2", "e1")] })).toMatchObject({ verdict: "fail", checked: 3 });
    expect(notChallengedLater({ ...base, heldAt: -1, later: [later("e2", "e1")] })).toMatchObject({ verdict: "fail" });
    // A later challenge the division no longer lists is a failing item, never a silent pass.
    expect(notChallengedLater({ ...base, later: ["f-gone"] })).toMatchObject({ verdict: "fail", checked: 3, evidence: ["f-gone: a later challenge the division no longer lists"] });
  });

  it("cascadeItems is kind-aware (false premise 16): open-format walkover = every pending abandoned and counted voided; table/bracket unchanged", () => {
    // Plan review 3 I-3: product-shaped, typed fixtures, no `as never`. winnerOf reads only outcome.kind ∈ {win, award}
    // (observed.ts), and sameResult reads `before[].outcome`, so both must be real.
    const fx = (id: string, status: string, outcome: ObservedOutcome | null, home: string, away: string): ObservedFixture =>
      ({ id, stageId: "s1", poolId: null, roundNo: 1, home, away, status, outcome, declared: null });
    const decidedW = { kind: "win", winner: "w" } as const satisfies ObservedOutcome;         // f2, identical before and after
    const before: FixtureSnap[] = [fx("f1", "scheduled", null, "w", "x"), fx("f2", "decided", decidedW, "w", "y")].map(snap);
    const abandonedAfter: ObservedFixture[] = [fx("f1", "abandoned", null, "w", "x"), fx("f2", "decided", decidedW, "w", "y")];
    const forfeitedAfter: ObservedFixture[] = [fx("f1", "forfeited", { kind: "award", winner: "x" }, "w", "x"), fx("f2", "decided", decidedW, "w", "y")];
    const failing = (items: { ok: boolean; note: string }[]) => items.filter((i) => !i.ok).map((i) => i.note);
    // m-9: the open kinds are every engine stage kind (StageKind.options) outside the product's pinned union — derived, so a
    // new open kind is judged here the day the engine declares it. Each list asserted non-empty, and together they cover the engine.
    const forfeitKinds = [...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED];
    const openKinds = StageKind.options.filter((k) => !TABLE_KINDS_PINNED.has(k) && !BRACKET_KINDS_PINNED.has(k));
    expect(forfeitKinds.filter((k) => !(StageKind.options as readonly string[]).includes(k)), "a pinned kind the engine does not declare").toEqual([]);
    expect(openKinds).toContain("ladder");
    expect(openKinds.length).toBeGreaterThan(0);
    expect(forfeitKinds.length).toBeGreaterThan(0);
    expect(openKinds.length + forfeitKinds.length).toBe(StageKind.options.length);
    for (const kind of openKinds) {
      // POSITIVE: the abandon shape passes. Reds when kind-awareness is removed (forfeit model: f1 abandoned with x seated → item fails).
      expect(failing(cascadeItems("walkover", "w", before, abandonedAfter, 0, 1, kind)), kind).toEqual([]);
      // NEGATIVE: a forfeit to x is not the open-format shape. Reds when kind is ignored (the forfeit model accepts it).
      expect(failing(cascadeItems("walkover", "w", before, forfeitedAfter, 1, 0, kind)).length, `${kind}: forfeit rejected`).toBeGreaterThan(0);
    }
    for (const kind of forfeitKinds) {
      // POSITIVE: the forfeit-to-opponent shape passes (award to x, walkovers 1). Reds when the abandon model is applied to every kind.
      expect(failing(cascadeItems("walkover", "w", before, forfeitedAfter, 1, 0, kind)), kind).toEqual([]);
      // NEGATIVE: an abandon with a seated opponent is not the table/bracket shape. Reds when the abandon model is applied to every kind.
      expect(failing(cascadeItems("walkover", "w", before, abandonedAfter, 0, 1, kind)).length, `${kind}: abandon rejected`).toBeGreaterThan(0);
    }
  });

  it("the league|generic R4 canary: its verdict and its r4-policy-reported / r4-cascade-consistent entries are byte-identical before and after the kind-aware cascade; the NEW ladder-only check abstains on league", async () => {
    // Review 3 m-2: the WHOLE checks JSON cannot be byte-identical, because Task 7 adds r4-not-challenged-later, emitted on
    // every kind (abstain off the ladder). So the test compares exactly what should not move, and asserts the new entry
    // separately. The fixture was captured at Step 0 from TODAY's code and is never regenerated in this task.
    const before = JSON.parse(readFileSync(R4_CANARY_BEFORE, "utf8")) as { verdict: string; checks: CheckResult[] };
    const now = await runCanary(planCanaryCase(variantFor, "R4"), new FakeLeagueDriver());
    expect(now.verdict).toBe(before.verdict);
    for (const id of ["r4-policy-reported", "r4-cascade-consistent"]) {
      expect(before.checks.some((c) => c.id === id), `${id} in the snapshot`).toBe(true);
      expect(JSON.stringify(now.checks.find((c) => c.id === id)), id).toBe(JSON.stringify(before.checks.find((c) => c.id === id)));
    }
    expect(before.checks.some((c) => c.id === "r4-not-challenged-later")).toBe(false);          // proves the snapshot predates the change
    const added = now.checks.find((c) => c.id === "r4-not-challenged-later")!;
    expect([added.verdict, added.checked]).toEqual(["abstain", 0]);
    expect(added.reason).toMatch(/ladder only/);
  });
});

describe("M1 on the ladder — D14 (ruling 51, m-4)", () => {
  it("M1 on a ladder lands on the last challenge (D8, m-4): forfeited to seed 1, m1-winner-progresses abstains", async () => {
    const driver = new FakeLadderDriver({ challengeRange: 3 });
    const { checks } = await runOn(driver, "M1", { row: "ladder" });
    const ledger = driver.decidedChallenges();
    expect(ledger.length).toBe(driver.entrants.length - 1);
    expect(ledger.at(-1)!.opponent).toBe(driver.entrantsBySeed()[0]);
    expect([ledger.at(-1)!.kind, ledger.at(-1)!.winner]).toEqual(["award", driver.entrantsBySeed()[0]]);
    // Seed 1 keeps the top rung (the award's winner already sits above; the award-moves-nobody rule is pinned on the fake below).
    expect(driver.ladderOrder()[0]).toBe(driver.entrantsBySeed()[0]);
    expect(checks.find((c) => c.id === "m1-walkover-recorded")?.verdict).toBe("pass");
    expect(checks.find((c) => c.id === "m1-winner-progresses")?.verdict).toBe("abstain");
  });
});

describe("rule 10 — playLadder under any withdrawal set and timing (plan review 1 I-5)", () => {
  it("fast-check (rule 10): playLadder under ANY withdrawal set and timing issues zero refused challenges, and the final LIVE order is the adjacent-swap rule replayed over the product's own ledger", async () => {
    // Drives the HARNESS (playLadder + ladderSchedule), never the fake's own challenge logic.
    // Withdrawals are injected through playLadder's afterRound hook at generated steps, exactly as R4's hook would.
    const arb = fc.record({
      n: fc.integer({ min: 2, max: 10 }),
      withdrawals: fc.array(fc.record({ afterStep: fc.nat({ max: 9 }), seedIdx: fc.nat({ max: 9 }) }), { maxLength: 4 }),
    });
    const tally = { runs: 0, withdrewMidSweep: 0, challenges: 0, skipped: 0, dropped: 0 };
    await fc.assert(fc.asyncProperty(arb, async ({ n, withdrawals }) => {
      const d = new FakeLadderDriver({ challengeRange: 1 });         // the tightest legal range: any non-adjacent challenge refuses
      const h = await LadderHarness.open(d, n, withdrawals);         // setUpDivision on the fake, then playLadder with the hook
      await h.play();
      expect(d.refusedChallenges(), "playLadder issued a refused challenge").toEqual([]);
      expect(h.exit).toBe("drained");
      // Oracle: replay the product's decided-challenge ledger over the seed order with the swap rule, then drop the departed.
      // A swap needs a WIN (an award or a draw has no loser — fed-seats.ts advancingSides; scoring.ts:774-786).
      const raw = [...d.entrantsBySeed()];
      for (const c of d.decidedChallenges()) if (c.kind === "win" && c.winner === c.challenger) {
        const i = raw.indexOf(c.challenger), j = raw.indexOf(c.opponent);
        [raw[i], raw[j]] = [raw[j]!, raw[i]!];
      }
      const live = (xs: readonly string[]) => xs.filter((e) => !d.withdrawnIds().has(e));
      expect(live(d.ladderOrder())).toEqual(live(raw));
      // Every decided challenge was live-adjacent, upward, and seated no departed entrant at the time it was issued.
      for (const c of d.decidedChallenges()) expect(c.liveAdjacentAtIssue && c.upward && !c.seatedDeparted, `step ${c.step}`).toBe(true);
      // Nothing left open: D8 decides each challenge before the next.
      expect(d.decidedChallenges().length).toBe(d.issuedChallenges().length);
      tally.runs++;
      tally.challenges += d.issuedChallenges().length;
      tally.skipped += h.skippedWithdrawals();
      tally.dropped += h.dropped;
      if (d.withdrawnIds().size > 0 && d.decidedChallenges().some((c) => c.step > d.firstWithdrawalStep())) tally.withdrewMidSweep++;
      return true;
    }), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    process.stdout.write(`ladder rule-10 property: ${tally.runs} runs, ${tally.challenges} challenges judged, ${tally.withdrewMidSweep} with a challenge after a withdrawal, ${tally.skipped} withdrawals never reached, ${tally.dropped} repeats dropped\n`);
    expect(tally.runs).toBe(200);
    expect(tally.challenges, "challenges judged (anti-vacuity)").toBeGreaterThan(0);
    expect(tally.withdrewMidSweep, "runs where a challenge followed a withdrawal (anti-vacuity)").toBeGreaterThan(0);
  });
});

describe("R4 on a ladder: the W7 note on a stage that never completes (review m-4)", () => {
  it("names no rung when the product minted no finalRanks — the note says what was seen, never a finalRanks fact at withdrawal time", async () => {
    class NeverCompletes extends FakeLadderDriver {
      override completeStage(): Promise<{ completed: boolean; events: { type: string; finalRanks?: string[] }[] }> { return Promise.resolve({ completed: false, events: [] }); }
    }
    const driver = new NeverCompletes({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    const heldAt = driver.rawOrderAtWithdrawal().indexOf(seed3);
    expect(heldAt).toBeGreaterThanOrEqual(0);
    expect(out.observed.stages[0]!.complete?.finalRanks ?? null).toBeNull();
    expect(out.notes.filter((n) => /W7/.test(n))).toEqual([`ladder finalRanks: stage not complete, no rung observed for withdrawn ${seed3} (raw held ${heldAt}) — W7 rulebook question`]);
    expect(checks.some((c) => /finalRanks/.test(c.id))).toBe(false);
    expect(checks.find((c) => c.id === "life-stage-completed")?.verdict).toBe("fail");   // the run is red for its own reason
  });

  it("reads the rung from the finalRanks it observed, not the rung held at withdrawal: a product that pruned the withdrawn player is noted as holding none", async () => {
    class PrunesDeparted extends FakeLadderDriver {
      override async completeStage(): Promise<{ completed: boolean; events: { type: string; finalRanks?: string[] }[] }> {
        const out = await super.completeStage();
        const gone = this.withdrawnIds();
        return { ...out, events: out.events.map((e) => (e.finalRanks === undefined ? e : { ...e, finalRanks: e.finalRanks.filter((x) => !gone.has(x)) })) };
      }
    }
    const driver = new PrunesDeparted({ challengeRange: 3 });
    const { out, checks } = await runOn(driver, "R4", { row: "ladder" });
    const seed3 = driver.entrantsBySeed()[2]!;
    const heldAt = driver.rawOrderAtWithdrawal().indexOf(seed3);
    expect(heldAt).toBeGreaterThanOrEqual(0);
    expect(out.observed.stages[0]!.complete?.finalRanks).not.toContain(seed3);
    expect(out.notes.filter((n) => /W7/.test(n))).toEqual([`ladder finalRanks hold no rung for withdrawn ${seed3} (raw held ${heldAt}) — W7 rulebook question`]);
    // Ruling 53 asserts neither way, and that is RUN, not inferred from check ids (T9-R1): I9 reads finalRanks
    // and passes the pruned shape exactly as it passes the keep-rung one, against the UNPRUNED raw stored order.
    expect(driver.ladderOrder()).toContain(seed3);
    expect(checks.find((c) => c.id === "I9-ladder-order-is-the-field")).toMatchObject({ verdict: "pass", checked: driver.entrants.length });
  });
});

describe("F1 on the ladder — T7-R1", () => {
  it("f1-round-size ABSTAINS by name on a ladder (a ladder declares no rounds); f1-ladder-sweep passes on n−1 challenges over the seeded field and every entrant in finalRanks", async () => {
    const n = fieldSizeFor("ladder", "F1");                 // the seeded field, from the format's declaration — never a literal
    expect(n % 2, "F1 is the odd field").toBe(1);
    const driver = new FakeLadderDriver();
    const { out, checks, state } = await runOn(driver, "F1", { row: "ladder" });
    expect(driver.entrants.length).toBe(n);
    const round = checks.find((c) => c.id === "f1-round-size")!;
    expect([round.verdict, round.checked]).toEqual(["abstain", 0]);
    expect(round.reason).toMatch(/a ladder declares no rounds/);
    const sweep = checks.find((c) => c.id === "f1-ladder-sweep")!;
    // Items: challenges issued, challenges decided, and one per seeded entrant in finalRanks.
    expect(sweep).toMatchObject({ verdict: "pass", checked: 2 + n });
    expect(driver.decidedChallenges().length).toBe(n - 1);
    expect([...(out.observed.stages[0]!.complete?.finalRanks ?? [])].sort()).toEqual([...driver.entrantsBySeed()].sort());
    expect(state).toBe("works");
  });

  it("f1-ladder-sweep reds a short sweep and a finalRanks that drops an entrant, naming each; it abstains off the ladder", async () => {
    const n = fieldSizeFor("ladder", "F1");
    const refused = await runOn(new FakeLadderDriver({ refuseAll: "LADDER_CHALLENGE_OUT_OF_RANGE" }), "F1", { row: "ladder" });
    const short = refused.checks.find((c) => c.id === "f1-ladder-sweep")!;
    expect(short).toMatchObject({ verdict: "fail", checked: 2 + n });
    expect(short.evidence).toContain(`0 challenge(s) issued, expected ${n - 1} (n − 1 over a seeded field of ${n})`);
    expect(short.evidence.filter((e) => /minted no finalRanks/.test(e)).length).toBe(n);
    class DropsLastRank extends FakeLadderDriver {
      override async completeStage(): Promise<{ completed: boolean; events: { type: string; finalRanks?: string[] }[] }> {
        const out = await super.completeStage();
        return { ...out, events: out.events.map((e) => (e.finalRanks === undefined ? e : { ...e, finalRanks: e.finalRanks.slice(0, -1) })) };
      }
    }
    const dropper = new DropsLastRank();
    const dropped = await runOn(dropper, "F1", { row: "ladder" });
    const lost = dropper.ladderOrder().at(-1)!;
    expect(dropped.checks.find((c) => c.id === "f1-ladder-sweep")).toMatchObject({ verdict: "fail", evidence: [`${lost} is missing from finalRanks`] });
    // Issued but not decided: once the sweep is over, the division lists the first challenge as still in play.
    class ListsFirstUndecided extends FakeLadderDriver {
      override async listFixtures() {
        const first = this.issuedChallenges()[0]?.fixtureId;
        const over = this.decidedChallenges().length === this.entrants.length - 1;
        return (await super.listFixtures()).map((f) => (over && f.id === first ? { ...f, status: "in_play", outcome: null } : f));
      }
    }
    const undecided = await runOn(new ListsFirstUndecided(), "F1", { row: "ladder" });
    expect(undecided.checks.find((c) => c.id === "f1-ladder-sweep")).toMatchObject({ verdict: "fail", evidence: [`${n - 2} challenge(s) decided, expected ${n - 1}`] });
    const league = await runOn(new FakeLeagueDriver(), "F1", { row: "league" });
    const off = league.checks.find((c) => c.id === "f1-ladder-sweep")!;
    expect([off.verdict, off.checked]).toEqual(["abstain", 0]);
    expect(off.reason).toMatch(/ladder only/);
  });

  it("f1-round-size is unchanged off the ladder: a league round seated one pair short still reds it, naming the round", async () => {
    class SeatsShort extends FakeLeagueDriver {
      // Round 1 loses one SEATED pair (an odd field's circle also holds a BYE pair, which seats nobody either way).
      override circle(): [string, string][][] {
        return super.circle().map((r, i) => {
          if (i !== 0) return r;
          const k = r.findIndex((p) => !p.includes("BYE"));
          return r.filter((_, j) => j !== k);
        });
      }
    }
    const n = fieldSizeFor("league", "F1");
    const { checks } = await runOn(new SeatsShort(), "F1", { row: "league" });
    const round = checks.find((c) => c.id === "f1-round-size")!;
    expect(round.verdict).toBe("fail");
    expect(round.evidence).toEqual([`round 1: ${Math.floor(n / 2) - 1} seated, expected ${Math.floor(n / 2)}`]);
  });
});

describe("playLadder's guards and the fake's refusals (review m-2, m-6)", () => {
  it("a challenge whose fixture the division does not list throws, naming the fixture — never a silent skip", async () => {
    class HidesChallenges extends FakeLadderDriver {
      override async listFixtures() {
        const issued = new Set(this.issuedChallenges().map((c) => c.fixtureId));
        return (await super.listFixtures()).filter((f) => !issued.has(f.id));
      }
    }
    await expect(runOn(new HidesChallenges(), "LIFECYCLE", { row: "ladder" })).rejects.toThrow(/^ladder: challenge answered fixture \S+, which the division list does not hold$/);
  });

  it("the fake's withdraw refuses as the product does: an unknown entrant is a 404 (entrants.ts getEntrant), a repeat a codeless 409 (withdrawal.ts)", async () => {
    const product = readFileSync(resolve(REPO, "apps/web/src/server/usecases/withdrawal.ts"), "utf8");
    expect(product).toContain('throw new HttpError(409, "entrant is already withdrawn");');
    const d = new FakeLadderDriver();
    const ctx = ctxFor(d, "LIFECYCLE");
    const setup = await setUpDivision(ctx, new Recorder(), 3);
    const s3 = setup.idOfSeed(3);
    const unknown = await d.withdraw("nobody").catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(RefusedCall);
    expect(unknown).toMatchObject({ status: 404, code: wireCodeFor(404) });
    const first = await d.withdraw(s3);
    expect([first.status, first.policy]).toEqual(["withdrawn", "none"]);
    const repeat = await d.withdraw(s3).catch((e: unknown) => e);
    expect(repeat).toBeInstanceOf(RefusedCall);
    expect(repeat).toMatchObject({ status: 409, code: wireCodeFor(409) });
    expect((repeat as RefusedCall).message).toContain("entrant is already withdrawn");
    expect(d.withdrawnIds()).toEqual(new Set([s3]));            // the refused repeat changed nothing
  });

  it("the first challenge walks the SEED order, not the order addEntrants happened to answer in (m-6)", async () => {
    class AnswersReversed extends FakeLadderDriver {
      override async addEntrants(divisionId: string, es: Parameters<FakeLadderDriver["addEntrants"]>[1]) { return (await super.addEntrants(divisionId, es)).reverse(); }
    }
    const driver = new AnswersReversed({ challengeRange: 1 });
    const { state } = await runOn(driver, "LIFECYCLE", { row: "ladder" });
    expect(driver.refusedChallenges()).toEqual([]);
    const seeds = driver.entrantsBySeed();
    expect(driver.issuedChallenges()[0]).toMatchObject({ challenger: seeds.at(-1), opponent: seeds.at(-2) });
    expect(driver.ladderOrder()).toEqual(swapRule(seeds));
    expect(state).toBe("works");
  });
});
