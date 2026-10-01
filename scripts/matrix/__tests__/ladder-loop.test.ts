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
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { DEPARTED_STATUSES, FORFEIT_MODEL_KINDS, PENDING_STATUSES, snap, type FixtureSnap, type ObservedFixture, type ObservedOutcome } from "../lib/observed.ts";
import { decideState, type CheckResult } from "../lib/results.ts";
import { Recorder, decideFixture, setUpDivision, type DivisionSetup } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ladderSchedule, playLadder } from "../lib/scenarios/ladder-loop.ts";
import { cascadeItems, notChallengedLater } from "../lib/scenarios/r4-withdrawal.ts";
import type { CaseSpec, ScenarioContext, ScenarioKey } from "../lib/scenarios/types.ts";
import { planCanaryCase } from "../lib/slice.ts";
import { drawsAllowed, resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FakeLadderDriver } from "./fake-formats-driver.ts";
import { bracketWalkoverKindsText, departedStatusesText, ladderText, withdrawalPendingText, withdrawalTableKindsText } from "./product-text.ts";

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
/** The adjacent-swap RULE applied to a seed order over D8's sweep (no playLadder). */
function swapRule(seeds: readonly string[]): string[] {
  const expected = [...seeds];
  for (let k = 1; k < seeds.length; k++) {
    const i = seeds.length - k;
    if (k % 2 === 1) [expected[i - 1], expected[i]] = [expected[i]!, expected[i - 1]!];
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

  it("no challenge played is red, never drained: a fake that refuses every challenge leaves exit refused_challenge and I9 fails on checked 0", async () => {
    const { out, checks } = await runOn(new FakeLadderDriver({ refuseAll: "LADDER_CHALLENGE_OUT_OF_RANGE" }), "LIFECYCLE", { row: "ladder" });
    expect(checks.find((c) => c.id === "life-loop-bounded")?.verdict).toBe("fail");
    expect(out.observed.stages[0]!.exit).toBe("refused_challenge");
    expect(out.notes).toContain("ladder step 1: challenge refused 422 LADDER_CHALLENGE_OUT_OF_RANGE");
    // I9 lands in Task 9; until then the stage's /complete answers not-complete over zero fixtures.
    expect(out.observed.stages[0]!.complete).toMatchObject({ completed: false });
  });

  it("a second sport, the registry swept: every sport plays the same sweep to the same rule order, and a draw is posted on the first non-climbing step exactly where the engine declares draws on a ladder", async () => {
    let judged = 0;
    const declaring: string[] = [];
    for (const sport of SPORT_KEYS) {
      const driver = new FakeLadderDriver();
      const { out, state, checks } = await runOn(driver, "LIFECYCLE", { row: "ladder", sport });
      const failing = checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`);
      expect(failing, sport).toEqual([]);
      expect(state, sport).toBe("works");
      expect(driver.ladderOrder(), sport).toEqual(swapRule(driver.entrantsBySeed()));
      const declares = drawsAllowed(sport, resolveSportCfg(sport, variantFor(sport)), "ladder");
      const draws = driver.decidedChallenges().filter((c) => c.kind === "draw");
      expect(draws.map((c) => c.step), sport).toEqual(declares ? [ladderSchedule(driver.entrants.length).find((c) => !c.challengerWins)!.step] : []);
      expect(out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "draw").length, sport).toBe(declares ? 1 : 0);
      if (declares) declaring.push(sport);
      judged++;
    }
    process.stdout.write(`ladder registry sweep: ${judged} sports judged, ${declaring.length} declare draws on a ladder (${declaring.join(", ")})\n`);
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
    // The differing case exists on both sides: some sport declares draws, some does not.
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring.length).toBeLessThan(judged);
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
  it("only a decided WIN by the lower player swaps: an award to the challenger (a walkover) and a draw move nobody — each the differing case against a swap", async () => {
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
    // A draw (generic score declares draws on a ladder).
    expect(drawsAllowed("generic", ctx.cfg, "ladder")).toBe(true);
    await decideFixture(ctx, rec, setup, await issue(), { kind: "draw" });
    expect([d.decidedChallenges().at(-1)!.kind, d.ladderOrder()]).toEqual(["draw", [s1, s2, s3]]);
    // The positive pair: the challenger's WIN swaps.
    await decideFixture(ctx, rec, setup, await issue(), { kind: "win", winner: "home" });
    expect(d.ladderOrder()).toEqual([s1, s3, s2]);
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
    const src = readFileSync(resolve(REPO, "scripts/matrix/lib/scenarios/r4-withdrawal.ts"), "utf8");
    expect([...PENDING].filter((x) => src.includes(`"${x}"`)), "a second pending list in r4-withdrawal.ts").toEqual([]);
    const kinds = new Set([...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED]);
    const lists = [...src.matchAll(/\[([^\]]*)\]/g)].map((m) => [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).filter((k) => kinds.has(k)));
    expect(lists.filter((l) => l.length >= 2), "a second kind list in r4-withdrawal.ts").toEqual([]);
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
    // W7: the product snapshots the RAW order into finalRanks (engine-db/competition.ts:606), so seed 3 keeps its rung.
    expect(out.notes.some((n) => n.includes(`ladder finalRanks keep withdrawn ${seed3} at rung ${heldAt}`) && /W7/.test(n))).toBe(true);
    expect(out.observed.stages[0]!.complete?.finalRanks?.[heldAt]).toBe(seed3);
    expect(checks.some((c) => /finalRanks/.test(c.id))).toBe(false);  // recorded, never asserted either way
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
    // Kinds are read from the product's text-pinned sets, plus the open-format kinds the catalogue uses; each list asserted non-empty.
    const openKinds = ["ladder", "page_playoff", "americano"].filter((k) => !TABLE_KINDS_PINNED.has(k) && !BRACKET_KINDS_PINNED.has(k));
    const forfeitKinds = [...TABLE_KINDS_PINNED, ...BRACKET_KINDS_PINNED];
    expect([openKinds.length, forfeitKinds.length]).toEqual([3, 6]);
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
