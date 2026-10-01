// W1-driving Task 8 (D9, D14; rulings 51, 52): americano plans every round at
// Start and is never re-generated; mexicano is `{ kind: "americano",
// config.mode: "mexicano" }` and generates one round per decided round. The
// expected values come from the RULE (stages.ts americanoGen, read as text),
// from the engine's declarations (americano.ts quartets: min(floor(n/4),
// courtCount) per round) or from the fake's OWN rows (its members, the
// oracle) — never from americano-loop.ts or the hooks under test.
//
// Transitions: the empty case (no fixture, no pair); the first round; the
// last round (the drained probe); a round with a sit-out (F1: 7 players,
// courtCount 2); a withdrawn player (R4: a predicted product red, and on
// mexicano NO stall); a walkover (M1 on a pair entrant; on mexicano it
// stalls the rounds); a void on mexicano; round 2 of mexicano, where the
// product counts round 1's pair entrants as players (false premise 17);
// americano against mexicano; a team sport (it GENERATES, false premise 10);
// any interleaving of those (the fast-check property); and the registry
// sweep for the R4 second leg.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS, type StagePostBody } from "../lib/catalogue.ts";
import { RefusedCall, type FixtureRow, type GenerateOut, type StageRef } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { americanoRoundSize } from "../lib/scenarios/f1-odd-field.ts";
import { AmericanoModeMismatch, PAIR_PLAYERS_ROUTE, STALL_ROUTE, TEAM_MEMBER_ROUTE, modeOf, notePairEntrantDuplicates } from "../lib/scenarios/americano-loop.ts";
import { lineupsPut, seatsEntrant } from "../lib/scenarios/assertions.ts";
import { Recorder, decideFixture, ensureLineups, seatedOpen, setUpDivision, type DivisionSetup } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { TARGET_OF } from "../lib/scenarios/m1-walkover.ts";
import { KEPT_PLAYING_ROUTE, keptPlayingNote } from "../lib/scenarios/r4-withdrawal.ts";
import type { CaseSpec, ScenarioContext, ScenarioKey } from "../lib/scenarios/types.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT, FakeAmericanoDriver, WAIT_UNLESS } from "./fake-formats-driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const STAGES_TS = resolve(REPO, "apps/web/src/server/usecases/stages.ts");
const FORMAT_TEMPLATES_TS = resolve(REPO, "apps/web/src/components/v2/format-templates.ts");
const ENGINE_AMERICANO_TS = resolve(REPO, "packages/engine/src/scheduling/americano.ts");
const ENTRANT_MEMBERS_SQL = resolve(REPO, "db/migration/v2-engine/tables/V213__entrant_members.sql");
/** PF-9: every case runs on the sport's builder-default variant. */
const variantFor = offlineBuilderDefault;
/** The catalogue's americano/mexicano body (catalogue.ts stagesForRow): its declared bound and courts. */
const ROUNDS = 7;
const COURTS = 2;

type Row = "americano" | "mexicano";
interface Opts { canary?: boolean; row?: Row; sport?: string }
function ctxFor(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}): ScenarioContext {
  const sport = opts.sport ?? "generic";
  const variant = variantFor(sport);
  const row = opts.row ?? "americano";
  const spec: CaseSpec = { caseId: `${row}|${sport}|${variant}|${scenario}`, row, sport, variant, scenario, canary: opts.canary ?? false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}
async function runOn(driver: FakeLeagueDriver, scenario: ScenarioKey, opts: Opts = {}) {
  const out = await SCENARIOS[scenario].run(ctxFor(driver, scenario, opts));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { out, checks };
}
const failing = (checks: readonly { id: string; verdict: string }[]): string[] => checks.filter((c) => c.verdict === "fail").map((c) => c.id).sort();
const check = (checks: readonly { id: string; verdict: string; evidence: string[]; reason: string; checked: number }[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`test: no check ${id}`);
  return c;
};
/** The fake's oracle: does `person` sit in any fixture after `round`, through ANY entrant? */
const seatedAfter = (driver: FakeAmericanoDriver, round: number, person: string): boolean =>
  driver.fixturesAfterRound(round).some((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => e !== null && driver.membersOf(e).includes(person)));
/** The function body of `name` in `src`, by brace matching from its first `{`. */
function sliceFunction(src: string, name: string): string {
  const at = src.indexOf(`async function ${name}(`);
  if (at < 0) throw new Error(`test: no function ${name}`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`test: ${name} never closes`);
}

describe("americano and mexicano rounds (W1-driving Task 8, D9)", () => {
  it("empty case first: before Start the fake holds no fixture and no pair entrant; modeOf answers null off an americano stage and the posted mode on one", () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    expect(driver.rows()).toEqual([]);
    expect(driver.pairEntrantIds()).toEqual([]);
    expect(driver.roundsGenerated()).toEqual([]);
    expect(driver.roundsDecided()).toEqual([]);
    const stage = (kind: string, config: Record<string, unknown>): StageRef => ({ id: "s1", seq: 1, kind, config, status: "draft" });
    expect(modeOf(stage("league", { mode: "mexicano" }))).toBeNull();
    // Review 3 I-1: a `kind: "mexicano"` stage is not mexicano — the product has no such kind.
    expect(modeOf(stage("mexicano", { mode: "mexicano" }))).toBeNull();
    expect(modeOf(stage("americano", {}))).toBe("americano");
    expect(modeOf(stage("americano", { mode: "mexicano" }))).toBe("mexicano");
    // A shapeless mode reads as americano, as stages.ts:756 does.
    expect(modeOf(stage("americano", { mode: "MEXICANO" }))).toBe("americano");
  });

  it("americano: no generate after Start; rounds played lowest first; every round decided, bounded by config.rounds", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    const stageId = driver.stageIdAt(1);
    // PF-4: `calls` holds bare method names, `trace` the ids. Killed by a loop that calls recordGenerate.
    expect(driver.calls.filter((c) => c === "generate")).toEqual([]);
    expect(driver.trace.filter((c) => c === `generate ${stageId}`)).toEqual([]);
    // Start planned all ROUNDS rounds; the loop decided them lowest first.
    expect(driver.roundsGenerated()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(driver.roundsDecided()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.observed.stages[0]!.exit).toBe("drained");
    expect(check(checks, "life-loop-bounded").verdict).toBe("pass");
    expect(check(checks, "life-stage-completed").verdict).toBe("pass");
    expect(failing(checks)).toEqual([]);
  });

  it("americano past its bound: a round beyond config.rounds left open is the cap, cut_short, and a note — never drained", async () => {
    class PlansPast extends FakeAmericanoDriver {
      override async start() {
        const out = await super.start();
        const last = this.fixturesOfRound(ROUNDS)[0]!;
        this.seat(ROUNDS + 1, last.home_entrant_id, last.away_entrant_id, { ext_key: `am-r${ROUNDS + 1}-c1` });
        return out;
      }
    }
    const driver = new PlansPast({ mode: "americano" });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    expect(out.observed.stages[0]!.exit).toBe("cap");
    expect(driver.roundsDecided()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.notes).toContain(`americano: 1 fixture(s) open after config.rounds=${ROUNDS}`);
  });

  it("mexicano loop mechanics (individualsOnly, to isolate the loop): one generate per decided round plus the drained probe; created 0 before config.rounds is stalled_rounds with a note", async () => {
    const ok = new FakeAmericanoDriver({ mode: "mexicano", individualsOnly: true });
    const good = await runOn(ok, "LIFECYCLE", { row: "mexicano" });
    // Rounds 2..7 + the drained probe after round 7 (PF-4: bare names).
    expect(ok.calls.filter((c) => c === "generate").length).toBe(ROUNDS);
    expect(ok.generates.map((g) => g.created)).toEqual([1, 1, 1, 1, 1, 1, 0].map((n) => n * COURTS));
    expect(ok.roundsGenerated()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ok.roundsDecided()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(good.out.observed.stages[0]!.exit).toBe("drained");
    expect(check(good.checks, "life-loop-bounded").verdict).toBe("pass");
    expect(failing(good.checks)).toEqual([]);
    const stall = new FakeAmericanoDriver({ mode: "mexicano", stallAfter: 3, individualsOnly: true });
    const bad = await runOn(stall, "LIFECYCLE", { row: "mexicano" });
    expect(bad.out.notes.some((n) => /stalled after round 3 of 7/.test(n) && n.includes(`→ ${STALL_ROUTE.wave}`))).toBe(true);
    expect(bad.out.observed.stages[0]!.exit).toBe("stalled_rounds");
    expect(check(bad.checks, "life-loop-bounded").verdict).toBe("fail");
    // A stall with every fixture decided is NOT the forfeit/void signature.
    expect(bad.out.notes.some((n) => n.startsWith("mexicano-stalled-on-non-decided"))).toBe(false);
  });

  it("mexicano planning past config.rounds: the rounds-th generate still creating is the cap and cut_short, never played", async () => {
    // The bound the harness reads (the listed stage) says 7; the product then plans as if 99.
    class PlansPast extends FakeAmericanoDriver {
      #listed = false;
      override async listStages() {
        const out = await super.listStages();
        if (!this.#listed && this.stage !== null) { this.#listed = true; this.stage.config = { ...this.stage.config, rounds: 99 }; }
        return out;
      }
    }
    const driver = new PlansPast({ mode: "mexicano", individualsOnly: true });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "mexicano" });
    expect(out.observed.stages[0]!.exit).toBe("cap");
    expect(driver.calls.filter((c) => c === "generate").length).toBe(ROUNDS);
    expect(driver.roundsDecided()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.notes).toContain(`mexicano: generate still created fixtures after config.rounds=${ROUNDS} round(s)`);
  });

  it("persons (PF-7): each individual entrant maps to its ONE linked person, each pair entrant to TWO — both counted; setup.persons reaches the observed stage end to end", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    const persons = out.observed.stages[0]!.persons!;
    const individuals = Object.keys(persons).filter((e) => !driver.pairEntrantIds().includes(e));
    const pairs = Object.keys(persons).filter((e) => driver.pairEntrantIds().includes(e));
    expect(individuals.length, "the division's 8 individuals").toBe(8);
    expect(pairs.length, "pair entrants seen").toBeGreaterThan(0);
    for (const e of individuals) expect(persons[e]).toEqual(driver.membersOf(e));
    for (const e of individuals) expect(persons[e]!.length).toBe(1);
    for (const e of pairs) expect(persons[e]).toEqual(driver.membersOf(e));
    for (const e of pairs) expect(persons[e]!.length).toBe(2);
    // Task 5 carry: the persons setUpDivision read back are the persons the
    // product plays — every pair member is one of them, and every one plays.
    const linked = new Set(individuals.flatMap((e) => persons[e]!));
    const played = new Set(pairs.flatMap((e) => persons[e]!));
    expect([...played].filter((p) => !linked.has(p))).toEqual([]);
    expect([...linked].filter((p) => !played.has(p))).toEqual([]);
  });

  it("I10 does not exist until Task 9: no invariant judges a round's persons yet (pointer — Task 9 Step 1 replaces this)", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons: true });
    const { checks } = await runOn(driver, "R4", { row: "mexicano" });
    // Task 9 Step 1: this case seats a person twice in round 2 (the duplicate
    // signature below); I10-americano-seats-each-person-once is created then
    // and reds on it. Until then no check id starts with I10.
    expect(checks.filter((c) => c.id.startsWith("I10"))).toEqual([]);
  });

  it("fast-check (rule 10, product-shaped fake): under any interleaving of decide / forfeit / generate / withdraw, a non-decided fixture blocks every later round, round 1 never repeats a person, and every later duplicate is explained by an earlier pair entrant", async () => {
    let dupRuns = 0;
    let round1Checks = 0;
    let evidenceChecks = 0;
    let blockedGenerates = 0;
    let runs = 0;
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("generic", "badminton"),
      fc.boolean(),
      fc.array(fc.constantFrom<Step>("decideOne", "forfeitOne", "generate", "withdrawOne"), { maxLength: 24 }),
      async (sport, seedOrderedPersons, steps) => {
        runs++;
        const h = await MexicanoHarness.open(new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons }), sport);   // DEFAULT = the product's shape
        for (const s of steps) {
          // I-3: the product's wait (text-pinned below) is judged BEFORE the generate: a successful one creates scheduled fixtures.
          const blocked = s === "generate" && h.anyNonDecided();
          const before = h.driver.rows().length;
          await h.step(s);
          if (blocked) { blockedGenerates++; expect(h.driver.rows().length, "generate created a round past a non-decided fixture").toBe(before); }
          const r1 = h.rounds().find((r) => r.round_no === 1);
          if (r1) { round1Checks++; expect(new Set(r1.persons).size, "round 1").toBe(r1.persons.length); }   // only individuals exist before round 2
          // Review 2 I-3: from round 2 a duplicate is the PRODUCT's (false premise 17); its evidence must hold.
          for (const r of h.rounds().filter((x) => x.round_no >= 2)) for (const p of h.duplicatesIn(r)) {
            evidenceChecks++;
            expect(h.pairEntrantsBefore(r.round_no).some((e) => h.driver.membersOf(e).includes(p)), `round ${r.round_no}: ${p}`).toBe(true);
          }
        }
        if (h.rounds().some((r) => r.round_no >= 2 && h.duplicatesIn(r).length > 0)) dupRuns++;
        return true;
      },
    ), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    expect(runs).toBe(200);
    expect(dupRuns, "runs that reached a round-2 duplicate (anti-vacuity for the evidence invariant)").toBeGreaterThan(0);
    expect(evidenceChecks).toBeGreaterThan(0);
    expect(round1Checks).toBeGreaterThan(0);
    expect(blockedGenerates, "generates judged against the wait").toBeGreaterThan(0);
  }, 120_000);

  it("the fake's mexicano wait and player set ARE the product's (text pins, review 1 I-3, review 2 I-3)", () => {
    const src = readFileSync(STAGES_TS, "utf8");
    const gen = sliceFunction(src, "americanoGen");
    expect(gen).toContain("STAGE_NOT_READY");
    expect(gen).not.toMatch(/\nasync function /);
    expect(gen.match(/existing\.some\(\(f\) => f\.status !== "decided"\)/g)?.length).toBe(1);
    expect(WAIT_UNLESS).toBe("decided");
    const active = src.match(/const active = await tx<ActiveEntrant\[\]>`([\s\S]*?)`/)?.[1] ?? "";
    expect(active).toMatch(/status in \('registered', 'confirmed'\)/);
    expect(active).not.toMatch(/\bkind\b/);   // no kind filter: pair entrants are "players" (false premise 17)
    expect(FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT).toBe(true);
    // The default is DERIVED from the constant (plan review 3 m-4).
    expect(new FakeAmericanoDriver({ mode: "mexicano" }).individualsOnly).toBe(!FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT);
    expect(new FakeAmericanoDriver({ mode: "mexicano", individualsOnly: true }).individualsOnly).toBe(true);
    // The self-pair's 500: two member rows for one entrant and one person hit this key (V213:9).
    expect(readFileSync(ENTRANT_MEMBERS_SQL, "utf8")).toMatch(/primary key \(entrant_id, person_id\)/);
  });

  it("team americano: the product's member read has no kind filter and no order (text pin, I-2) — one arbitrary member per team, the LAST row read", () => {
    const gen = sliceFunction(readFileSync(STAGES_TS, "utf8"), "americanoGen");
    const select = gen.match(/tx<\{ entrant_id: string; person_id: string \}\[\]>`([\s\S]*?)`/)?.[1] ?? "";
    expect(select).toMatch(/from entrant_members/);
    expect(select).not.toMatch(/\bkind\b/i);
    expect(select).not.toMatch(/order by/i);
    // A Map over every row: the last row per entrant wins (the fake's `players`).
    expect(gen).toContain("const personOf = new Map(memberRows.map((r) => [r.entrant_id, r.person_id]));");
  });

  it("the fake serves a mexicano stage in the product's shape: kind americano, config.mode mexicano (review 3 I-1)", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", individualsOnly: true });
    await runOn(driver, "LIFECYCLE", { row: "mexicano" });
    const s = driver.stageAt(1);
    expect([s.kind, s.config.mode]).toEqual(["americano", "mexicano"]);
    // And the template the product ships is the same shape (format-templates.ts:261, read as text):
    expect(readFileSync(FORMAT_TEMPLATES_TS, "utf8")).toMatch(/kind: "americano",[^}]*mode: "mexicano"/);
  });

  it("the americano view is read once per stage and must agree with the mode the loop plays; a disagreeing product is AmericanoModeMismatch, named", async () => {
    const agree = new FakeAmericanoDriver({ mode: "americano" });
    await runOn(agree, "LIFECYCLE", { row: "americano" });
    expect(agree.trace.filter((c) => c.startsWith("americanoView "))).toEqual([`americanoView ${agree.stageIdAt(1)}`]);
    for (const [mode, viewMode] of [["americano", "mexicano"], ["mexicano", "americano"]] as const) {
      const driver = new FakeAmericanoDriver({ mode, viewMode, individualsOnly: true });
      const e = await runOn(driver, "LIFECYCLE", { row: mode }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AmericanoModeMismatch);
      expect((e as Error).message).toContain(`is played as ${mode} (its config.mode), but the product's americano view reads it as ${viewMode}`);
      expect(driver.roundsDecided(), "nothing is played in the wrong format").toEqual([]);
    }
  });

  it("a stage that declares no config.rounds is refused by name — the loop never guesses its bound", async () => {
    class NoRounds extends FakeAmericanoDriver {
      override postStages(d: string, stages: readonly StagePostBody[]) {
        return super.postStages(d, stages.map((s) => ({ ...s, config: Object.fromEntries(Object.entries(s.config ?? {}).filter(([k]) => k !== "rounds")) })));
      }
    }
    const driver = new NoRounds({ mode: "americano" });
    await expect(runOn(driver, "LIFECYCLE", { row: "americano" })).rejects.toThrow(`americano: stage ${"s1"} declares no config.rounds (null) — the loop has no bound`);
  });

  it("mexicano round 2 (false premise 17): the product-shaped fake repeats a person; the case records the signature with its evidence, routed W7", async () => {
    // Badminton folds no score, so every mexicano point is 0 and the order is
    // by person id: round 2's pairing holds no self-pair, isolating the
    // duplicate (the self-pair path is its own test below).
    const driver = new FakeAmericanoDriver({ mode: "mexicano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(driver.selfPairsIn(2)).toBe(0);
    const dup = driver.firstDuplicate();   // {round_no, person, viaPairEntrant} from the fake's own rows
    expect(dup.round_no).toBe(2);
    expect(out.notes.filter((n) => n.includes("mexicano-pair-entrants-counted-as-players: round 2 seats") && n.includes(dup.person) && n.includes(dup.viaPairEntrant) && n.endsWith(`→ ${PAIR_PLAYERS_ROUTE.wave}`)).length).toBe(1);
    // The FULL failing set (review 2 m-8), re-derived: no check sees the
    // duplicate yet (I10 is Task 9's). Round 3's plan then pairs a pair
    // entrant's person with their own individual entry (the same false
    // premise, one round later), the generate is the entrant_members 500, and
    // the run ends there: an unnamed 5xx generate (I4, I8) and the loop exit.
    // Round 1-2 are all decided, so the stage completes (FP-5 asks once).
    expect(driver.selfPairsIn(3)).toBeGreaterThan(0);
    expect(failing(checks)).toEqual(["I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded"]);
  });

  it("mexicano self-pair (review 3 I-2; Step 0: the entrant_members PK answers 500): round 2 refused, signature written, full failing set pinned", async () => {
    // Generic folds a score, so round 1's winners lead round 2's order and a
    // pair entrant meets its own member there — the self-pair. No fake option
    // forces it: it falls out of the product's points (deviation from the
    // brief's `selfPairAnswers500`).
    const driver = new FakeAmericanoDriver({ mode: "mexicano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano", sport: "generic" });
    expect(driver.selfPairsIn(2)).toBeGreaterThan(0);
    expect(driver.roundsGenerated()).toEqual([1]);
    expect(driver.generates).toEqual([{ created: null, status: 500 }]);
    expect(check(checks, "life-loop-bounded").evidence.some((e) => /exited refused_generate/.test(e))).toBe(true);
    expect(out.notes.filter((n) => n.startsWith("mexicano-pair-entrants-counted-as-players: round 2 generate refused 500") && n.includes(driver.pairEntrantIds().join(", ")) && n.endsWith(`→ ${PAIR_PLAYERS_ROUTE.wave}`)).length).toBe(1);
    // Re-derived under FP-5 (T6-R2: every reached stage is asked to complete
    // once): round 1 is all decided, so the complete SUCCEEDS — life-stage-
    // completed passes, and I4 fails on the unnamed 500 alone. Only round 1's
    // two fixtures were played, so the draw the harness posts on every third
    // fixture never came: life-draw-path-exercised reds as a consequence.
    expect(check(checks, "life-stage-completed").verdict).toBe("pass");
    expect(check(checks, "I4-nothing-ends-stuck").evidence).toEqual(["stage 1: generate answered 500 INTERNAL — not a named refusal"]);
    expect(failing(checks)).toEqual(["I4-nothing-ends-stuck", "I8-generate-named", "life-draw-path-exercised", "life-loop-bounded"]);
  });

  it("a 4xx mexicano refusal carries no pair-entrant signature (it has a reason of its own)", async () => {
    class Refuses422 extends FakeAmericanoDriver {
      override async generate(stageId = "s1"): Promise<GenerateOut> {
        this.log("generate", stageId);
        throw new RefusedCall("POST", `/api/v1/stages/${stageId}/generate`, 422, "STAGE_NOT_READY", "not ready");
      }
    }
    const driver = new Refuses422({ mode: "mexicano" });
    const { out } = await runOn(driver, "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(out.observed.stages[0]!.exit).toBe("refused_generate");
    expect(driver.pairEntrantIds().length, "pair entrants exist, so the refusal is what decides").toBeGreaterThan(0);
    expect(out.notes.some((n) => n.includes("generate refused"))).toBe(false);
  });

  it("mexicano M1 walkover (D14, false premise 14): the forfeit stalls every later round → stalled_rounds, a note, predicted W7", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano" });
    const { out, checks } = await runOn(driver, "M1", { row: "mexicano" });
    expect(check(checks, "m1-walkover-recorded").verdict).toBe("pass");
    expect(check(checks, "life-loop-bounded").evidence.some((e) => /exited stalled_rounds/.test(e))).toBe(true);
    expect(out.notes.filter((n) => n.startsWith("mexicano-stalled-on-non-decided: stalled after round 1 of 7; 1 fixture(s) not decided (forfeited)") && n.endsWith(`→ ${STALL_ROUTE.wave}`)).length).toBe(1);
    expect(driver.roundsGenerated()).toEqual([1]);
    // The FULL failing set, re-derived under FP-5 (T6-R2, recorded as a change
    // from the plan's [I4, life-loop-bounded, life-stage-completed]): M1
    // forfeits in round 1, so the stall comes before any round 2 (no
    // duplicate). The loop exits stalled_rounds → life-loop-bounded. FP-5
    // then asks the stalled stage to complete once; round 1 is all SETTLED
    // (one decided, one forfeited → walkover), and the product completes a
    // table stage on settled fixtures alone (engine-db/competition.ts), so the
    // complete succeeds: I4 and life-stage-completed pass. I8 passes: the
    // created-0 generate is a 2xx.
    expect(check(checks, "life-stage-completed").verdict).toBe("pass");
    expect(check(checks, "I4-nothing-ends-stuck").verdict, "judged, not abstained: the stall adds no cut_short").toBe("pass");
    expect(out.observed.stages[0]!.complete?.completed).toBe(true);
    expect(failing(checks)).toEqual(["life-loop-bounded"]);
  });

  it("a void on mexicano stalls it the same way: an abandoned round-1 fixture is not decided, so no later round comes", async () => {
    class VoidsOne extends FakeAmericanoDriver {
      override async start() {
        const out = await super.start();
        await this.abandonFixture(this.fixtures[0]!);
        return out;
      }
    }
    const driver = new VoidsOne({ mode: "mexicano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(out.observed.stages[0]!.exit).toBe("stalled_rounds");
    expect(driver.roundsGenerated()).toEqual([1]);
    expect(out.notes.filter((n) => n.startsWith("mexicano-stalled-on-non-decided: stalled after round 1 of 7; 1 fixture(s) not decided (abandoned)")).length).toBe(1);
    expect(check(checks, "life-loop-bounded").verdict).toBe("fail");
  });

  it("mexicano R4 does NOT stall (review 2 I-3), swept over the registry and both person-id orders: the signature is written iff seed 3's person sits in a later round through ANY entrant", async () => {
    // m-e: which person a round-1 pair entrant plays as hangs on the order of
    // the product's person ids (UUIDs live), so the second leg is chance. No
    // order is assumed: both are swept, and the signature must track the
    // fake's own rows (the oracle) in each.
    const seen = { later: 0, notLater: 0, round2: 0, cases: 0 };
    for (const sport of SPORT_KEYS) for (const seedOrderedPersons of [false, true]) {
      const driver = new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons });
      const { out } = await runOn(driver, "R4", { row: "mexicano", sport });
      seen.cases++;
      const label = `${sport} seedOrdered=${seedOrderedPersons}`;
      expect(out.notes.some((n) => /mexicano-stalled-on-non-decided/.test(n)), label).toBe(false);
      expect(out.observed.stages[0]!.exit, label).not.toBe("stalled_rounds");
      if (driver.roundsGenerated().includes(2)) seen.round2++;
      else expect(out.notes.some((n) => n.startsWith("mexicano-pair-entrants-counted-as-players: round 2 generate refused")), `${label}: round 2 missing only through the self-pair refusal`).toBe(true);
      const later = seatedAfter(driver, 1, driver.personOfSeed(3));
      if (later) seen.later++; else seen.notLater++;
      expect(out.notes.some((n) => /^r4-withdrawn-player-kept-playing/.test(n)), label).toBe(later);
    }
    expect(seen.cases).toBe(SPORT_KEYS.length * 2);
    expect(seen.round2, "cases where round 2 was generated").toBeGreaterThan(0);
    expect(seen.later, "both directions of the biconditional are witnessed").toBeGreaterThan(0);
    expect(seen.notLater).toBeGreaterThan(0);
  });

  it("mexicano R4 with the second leg (person ids in seed order, badminton): round 2 generated, the signature written, the full failing set pinned", async () => {
    const driver = new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons: true });
    const { out, checks } = await runOn(driver, "R4", { row: "mexicano", sport: "badminton" });
    expect(driver.roundsGenerated()).toContain(2);
    expect(seatedAfter(driver, 1, driver.personOfSeed(3))).toBe(true);
    expect(out.notes.filter((n) => n.startsWith(`r4-withdrawn-player-kept-playing: ${driver.personOfSeed(3)} still seated in`) && n.endsWith(`→ ${KEPT_PLAYING_ROUTE.wave}`)).length).toBe(1);
    // The round-2 duplicate is here too (false premise 17), named; no check sees it until Task 9's I10.
    const dup = driver.firstDuplicate();
    expect(out.notes.some((n) => n.includes(`round ${dup.round_no} seats ${dup.person} twice`))).toBe(true);
    // Full failing set at Task 8 (review 3 I-2; Task 9 Step 1 adds "I10-americano-seats-each-person-once"):
    expect(failing(checks)).toEqual(["r4-policy-reported"]);
  });

  it("mexicano R4 WITHOUT the second leg (dropWithdrawnFromPlan; review 3 m-4): round 2 exists, no signature", async () => {
    // The same field as above, so the only difference is the dropped player:
    // the option drops the withdrawn individual AND every pair entrant
    // holding their person.
    const driver = new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons: true, dropWithdrawnFromPlan: true });
    const { out, checks } = await runOn(driver, "R4", { row: "mexicano", sport: "badminton" });
    expect(seatedAfter(driver, 1, driver.personOfSeed(3))).toBe(false);
    expect(driver.roundsGenerated()).toContain(2);   // round 2 exists, so "no signature" is not vacuous
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n))).toBe(false);
    expect(check(checks, "r4-policy-reported").verdict).toBe("fail");
  });

  it("M1 on americano (D14, ruling 51): targets the first fixture whose pair entrant has seed 1's person as a member, found through entrant members", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { out, checks } = await runOn(driver, "M1", { row: "americano" });
    const p1 = driver.personOfSeed(1);
    const round1 = driver.fixturesOfRound(1);
    // Oracle: the fake's own member rows, not m1-walkover.ts.
    const expected = round1.find((f) => driver.membersOf(f.home_entrant_id!).includes(p1) || driver.membersOf(f.away_entrant_id!).includes(p1))!;
    const seed1Pair = driver.membersOf(expected.home_entrant_id!).includes(p1) ? expected.home_entrant_id : expected.away_entrant_id;
    expect(seed1Pair, "seed 1 is seated only through a pair entrant").not.toBe(driver.entrants.find((e) => e.seed === 1)!.id);
    const fx = out.observed.stages[0]!.fixtures.find((f) => f.id === expected.id)!;
    expect(fx.status).toBe("forfeited");
    expect(fx.outcome && "winner" in fx.outcome ? fx.outcome.winner : null).toBe(seed1Pair);
    expect(check(checks, "m1-walkover-recorded").verdict).toBe("pass");
    expect(check(checks, "m1-winner-progresses").verdict).toBe("abstain");
    // PF-4: the target's side was read through entrantMembers BEFORE its forfeit was posted.
    const read = driver.trace.indexOf(`entrantMembers ${seed1Pair}`);
    const forfeit = driver.trace.indexOf(`postStream ${expected.id}`);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(forfeit);
    expect(failing(checks)).toEqual([]);
  });

  it("M1 on americano, canary: expecting the ABSENT pair as the winner reds", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { checks } = await runOn(driver, "M1", { row: "americano", canary: true });
    expect(check(checks, "m1-walkover-recorded").verdict).toBe("fail");
  });

  it("M1's per-kind target table: the default is the entrant-id match, untouched; americano refuses a seed with no linked person by name", async () => {
    const f = (id: string, home: string, away: string): FixtureRow => ({ id, stage_id: "s1", round_no: 1, home_entrant_id: home, away_entrant_id: away, status: "scheduled" } as FixtureRow);
    const batch = [f("f1", "e2", "e3"), f("f2", "e4", "e1")];
    const none = async (): Promise<readonly string[]> => { throw new Error("test: the default never reads members"); };
    const setup = { persons: new Map<string, readonly string[]>() } as unknown as DivisionSetup;
    expect(await TARGET_OF.default(setup, batch, "e1", none)).toEqual({ f: batch[1], absentSide: "home", winner: "e1" });
    expect(await TARGET_OF.default(setup, batch, "e9", none)).toBeNull();
    expect(await TARGET_OF.default(setup, [], "e1", none)).toBeNull();
    await expect(TARGET_OF.americano(setup, batch, "e1", none)).rejects.toThrow("scenario: M1 on an americano stage, but seed 1 (e1) has no linked person");
    const linked = { persons: new Map([["e1", ["p1"]]]) } as unknown as DivisionSetup;
    const members = async (id: string): Promise<readonly string[]> => ({ e3: ["p1", "p7"] } as Record<string, string[]>)[id] ?? [];
    expect(await TARGET_OF.americano(linked, batch, "e1", members)).toEqual({ f: batch[0], absentSide: "home", winner: "e3" });
    expect(await TARGET_OF.americano(linked, [], "e1", members)).toBeNull();
  });

  it("R4 on americano (D14, ruling 51): the withdrawn player keeps playing → the predicted signature, routed W7, never a crash", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { out, checks } = await runOn(driver, "R4", { row: "americano" });
    expect(out.observed.withdrawal!.policy).toBe("none");
    expect(out.observed.withdrawal!.before).toEqual([]);
    expect(check(checks, "r4-policy-reported").verdict).toBe("fail");
    const p3 = driver.personOfSeed(3);
    expect(seatedAfter(driver, 1, p3)).toBe(true);
    const k = driver.fixturesAfterRound(1).filter((f) => [f.home_entrant_id, f.away_entrant_id].some((e) => e !== null && driver.membersOf(e).includes(p3))).length;
    expect(out.notes).toContain(`r4-withdrawn-player-kept-playing: ${p3} still seated in ${k} later fixture(s) — predicted product red → ${KEPT_PLAYING_ROUTE.wave}`);
    expect(failing(checks), "full failing set (review 3 I-2)").toEqual(["r4-policy-reported"]);
  });

  it("R4 on americano WITHOUT the second leg (dropWithdrawnFromPlan): no predicted signature — the red goes to normal triage", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano", dropWithdrawnFromPlan: true });
    const { out, checks } = await runOn(driver, "R4", { row: "americano" });
    expect(seatedAfter(driver, 1, driver.personOfSeed(3))).toBe(false);
    expect(driver.fixturesAfterRound(1).length, "later rounds exist, so the absence is not vacuous").toBeGreaterThan(0);
    expect(out.notes.some((n) => /r4-withdrawn-player-kept-playing/.test(n))).toBe(false);
    expect(check(checks, "r4-policy-reported").verdict).toBe("fail");
  });

  it("keptPlayingNote's legs, each alone: policy none AND nothing pending AND the person seated later — and through ANY entrant", () => {
    const stage = {
      fixtures: [
        { id: "f1", roundNo: 1, home: "pe1", away: "pe2" },
        { id: "f2", roundNo: 2, home: "pe3", away: "pe4" },
      ] as never,
      persons: { pe1: ["p3", "p5"], pe2: ["p1", "p2"], pe3: ["p3", "p6"], pe4: ["p7", "p8"] },
    };
    const w = { entrantId: "e3", afterRound: 1, policy: "none" as "none" | "walkover", before: [] as never[] };
    expect(keptPlayingNote(w, ["p3"], stage)).toBe(`r4-withdrawn-player-kept-playing: p3 still seated in 1 later fixture(s) — predicted product red → ${KEPT_PLAYING_ROUTE.wave}`);
    expect(keptPlayingNote({ ...w, policy: "walkover" }, ["p3"], stage)).toBeNull();
    expect(keptPlayingNote({ ...w, before: [{}] as never[] }, ["p3"], stage)).toBeNull();
    expect(keptPlayingNote(w, ["p5"], stage), "seated in round 1 only").toBeNull();
    expect(keptPlayingNote(w, [], stage), "no person").toBeNull();
    expect(keptPlayingNote({ ...w, afterRound: 2 }, ["p3"], stage), "nothing after the round").toBeNull();
    // Directly, through its own entrant id:
    expect(keptPlayingNote(w, ["p9"], { fixtures: [{ id: "f3", roundNo: 2, home: "e3", away: "pe4" }] as never, persons: {} })).toMatch(/still seated in 1 later fixture/);
  });

  it("americano|badminton LIFECYCLE puts zero lineups and completes; americano|football puts zero lineups, notes the pair-entrant skip and the team finding, and completes (I-1)", async () => {
    const bad = new FakeAmericanoDriver({ mode: "americano" });
    const b = await runOn(bad, "LIFECYCLE", { row: "americano", sport: "badminton" });
    expect(bad.calls.filter((c) => c === "putLineup").length).toBe(0);
    expect(b.out.observed.stages[0]!.exit).toBe("drained");
    expect(check(b.checks, "life-stage-completed").verdict).toBe("pass");
    expect(b.out.notes.some((n) => n.startsWith("americano generated on team entrants"))).toBe(false);
    const foot = new FakeAmericanoDriver({ mode: "americano" });
    const f = await runOn(foot, "LIFECYCLE", { row: "americano", sport: "football" });
    expect(foot.calls.filter((c) => c === "putLineup").length).toBe(0);
    expect(f.out.notes.filter((n) => /not a division entrant/.test(n)).length).toBe(1);   // one stage
    const team = f.out.notes.filter((n) => n.startsWith("americano generated on team entrants with one arbitrary roster member each") && n.includes(`${TEAM_MEMBER_ROUTE.wave} finding`));
    expect(team.length).toBe(1);
    // The finding names, per team, the person the product seated — the fake's own LAST member row (the oracle).
    for (const e of foot.entrants) expect(team[0]).toContain(`${e.id}→${foot.personOfSeed(e.seed!)}`);
    expect(f.out.observed.stages[0]!.exit).toBe("drained");
    expect(check(f.checks, "life-stage-completed").verdict).toBe("pass");
    // Team americano GENERATES: life-lineups-put abstains by name, never fails on zero items.
    const lineups = check(f.checks, "life-lineups-put");
    expect([lineups.verdict, lineups.reason]).toEqual(["abstain", "an americano stage seats product-minted pair entrants, which carry no lineup"]);
    expect(failing(f.checks)).toEqual([]);
  });

  it("lineupsPut abstains only when EVERY stage is americano — a team division with any other stage still owes its items", () => {
    const rec = new Recorder();
    expect(lineupsPut(rec, { kind: "team", rosterless: false, stages: [{ kind: "americano" }] }).verdict).toBe("abstain");
    expect(lineupsPut(rec, { kind: "team", rosterless: false, stages: [{ kind: "league" }] }).verdict).not.toBe("abstain");
    expect(lineupsPut(rec, { kind: "team", rosterless: false, stages: [{ kind: "americano" }, { kind: "league" }] }).verdict).not.toBe("abstain");
    expect(lineupsPut(rec, { kind: "team", rosterless: false, stages: [] }).verdict).not.toBe("abstain");
    expect(lineupsPut(rec, { kind: "team", rosterless: false }).verdict).not.toBe("abstain");
  });

  it("T45-R3: a side that is not a division entrant is skipped (noted) on an americano stage only — on any other kind, or a stage the setup never built, it is thrown by name", async () => {
    const driver = new FakeLeagueDriver();
    const ctx = ctxFor(driver, "LIFECYCLE", { sport: "football" });
    const setupOn = (kind: string) => ({ rosterless: false, kind: "team", entrantIds: new Set(["e1"]), stages: [{ id: "s1", seq: 1, kind, config: {}, status: "active" }], rosters: new Map() }) as unknown as DivisionSetup;
    const fx = (stageId: string) => ({ id: "f1", stage_id: stageId, round_no: 1, home_entrant_id: "x9", away_entrant_id: "x8", status: "scheduled" }) as FixtureRow;
    const rec = new Recorder();
    await ensureLineups(ctx, rec, setupOn("americano"), fx("s1"));
    expect(rec.notes.filter((n) => /not a division entrant/.test(n)).length).toBe(1);
    expect(driver.calls.filter((c) => c === "putLineup")).toEqual([]);
    await expect(ensureLineups(ctx, new Recorder(), setupOn("league"), fx("s1"))).rejects.toThrow("scenario: fixture f1 seats x9, which is not a division entrant, on a league stage — only an americano stage mints its own (pair) entrants");
    await expect(ensureLineups(ctx, new Recorder(), setupOn("americano"), fx("s7"))).rejects.toThrow("scenario: fixture f1 seats x9, which is not a division entrant, on stage s7, which the setup never built");
  });

  it("F1 on americano (T7-R1): the round size is the ENGINE's (americano.ts:50, min(floor(n/4), courtCount)) — never floor(n/2)", async () => {
    // The rule, stated from the engine's own line (text-pinned) and computed
    // here — never read from f1-odd-field.ts.
    expect(readFileSync(ENGINE_AMERICANO_TS, "utf8")).toContain("const playable = Math.min(Math.floor(order.length / 4), courtCount);");
    for (const sport of ["generic", "badminton"]) {   // the scoring path differs (generic folds a score); the round size must not
      const driver = new FakeAmericanoDriver({ mode: "americano" });
      const { out, checks } = await runOn(driver, "F1", { row: "americano", sport });
      const n = out.observed.stages[0]!.field.length;
      expect(n, "F1's odd field").toBe(7);
      const rule = Math.min(Math.floor(n / 4), COURTS);
      expect(rule, "a case where the engine and floor(n/2) differ").not.toBe(Math.floor(n / 2));
      for (let r = 1; r <= ROUNDS; r++) expect(driver.fixturesOfRound(r).length, `${sport} round ${r}`).toBe(rule);
      const size = check(checks, "f1-round-size");
      expect([size.verdict, size.checked]).toEqual(["pass", ROUNDS]);
      expect(check(checks, "f1-everyone-drawn").verdict).toBe("pass");
      expect(failing(checks)).toEqual([]);
    }
    const canary = new FakeAmericanoDriver({ mode: "americano" });
    const c = await runOn(canary, "F1", { row: "americano", canary: true });
    expect(check(c.checks, "f1-round-size").verdict).toBe("fail");
  });

  it("F1's round size abstains by name when the stage declares no courtCount (the product's default then hangs on the live player count)", async () => {
    expect(americanoRoundSize({ courtCount: COURTS }, 7)).toBe(1);
    expect(americanoRoundSize({ courtCount: COURTS, mode: "mexicano" }, 8)).toBe(2);
    expect(americanoRoundSize({ courtCount: 5 }, 9)).toBe(2);
    expect(americanoRoundSize({ courtCount: COURTS }, 3)).toBe(0);
    expect(americanoRoundSize({}, 7)).toBeNull();
    class NoCourts extends FakeAmericanoDriver {
      override postStages(d: string, stages: readonly StagePostBody[]) {
        return super.postStages(d, stages.map((s) => ({ ...s, config: Object.fromEntries(Object.entries(s.config ?? {}).filter(([k]) => k !== "courtCount")) })));
      }
    }
    const { checks } = await runOn(new NoCourts({ mode: "americano" }), "F1", { row: "americano" });
    const size = check(checks, "f1-round-size");
    expect([size.verdict, size.reason]).toEqual(["abstain", "americano: the stage declares no courtCount, so the engine's round size hangs on the live player count (stages.ts:757-758)"]);
  });

  it("F1 on mexicano (corrected player set): the round size holds, but the sit-outs NEVER rotate — whoever sits out round 1 sits out every round (a product finding)", async () => {
    // pairMexicanoRound sorts by points then person id and sits out the
    // bottom (americano.ts quartets: byes = order.slice(playable * 4)); a
    // person who sat out round 1 has 0 points and stays at the bottom. The
    // oracle is the fake's own rows: the persons round 1 left out.
    for (const sport of ["generic", "badminton"]) {   // with points (generic) and without (every other sport)
      const driver = new FakeAmericanoDriver({ mode: "mexicano", individualsOnly: true });
      const { out, checks } = await runOn(driver, "F1", { row: "mexicano", sport });
      const field = out.observed.stages[0]!.field;
      const inRound = (r: number) => new Set(driver.fixturesOfRound(r).flatMap((f) => [f.home_entrant_id!, f.away_entrant_id!]).flatMap((e) => driver.membersOf(e)));
      const outOfRound1 = field.filter((e) => !inRound(1).has(driver.membersOf(e)[0]!));
      expect(outOfRound1.length, `${sport}: 7 players, one court of 4`).toBe(3);
      const never = field.filter((e) => [1, 2, 3, 4, 5, 6, 7].every((r) => !inRound(r).has(driver.membersOf(e)[0]!)));
      expect(never.length, `${sport}: someone never plays`).toBeGreaterThan(0);
      expect(never.every((e) => outOfRound1.includes(e))).toBe(true);
      expect(check(checks, "f1-round-size").verdict).toBe("pass");
      const drawn = check(checks, "f1-everyone-drawn");
      expect(drawn.verdict).toBe("fail");
      expect(drawn.evidence.map((x) => x.split(" ")[0]).sort()).toEqual([...never].sort());
    }
  });

  it("seatsEntrant: direct seats always count; a person only through the stage's persons map; an empty stage seats nobody", () => {
    expect(seatsEntrant({ fixtures: [] })("e1")).toBe(false);
    const stage = { fixtures: [{ home: "pe1", away: "pe2" }, { home: "e5", away: null }] as never, persons: { e1: ["p1"], e2: ["p2"], pe1: ["p1", "p3"], pe2: ["p4", "p6"] } };
    expect(seatsEntrant(stage)("e1")).toBe(true);
    expect(seatsEntrant(stage)("e2")).toBe(false);
    expect(seatsEntrant(stage)("e5")).toBe(true);
    expect(seatsEntrant({ fixtures: stage.fixtures })("e1"), "no persons map: only a direct seat counts").toBe(false);
  });

  it("life-built-as-posted on americano: the product-minted pair entrants are set aside (counted in the note), and an individual is seated through its person", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { checks } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    const built = check(checks, "life-built-as-posted");
    expect(built.verdict).toBe("pass");
    // sport + variant, stage count + kind + its 3 config keys (mode, courtCount, rounds),
    // entrant count + echo, then 8 stored-once and 8 seated — the pairs owe none.
    expect(built.checked).toBe(2 + 1 + 1 + 3 + 2 + 8 + 8);
    expect(driver.pairEntrantIds().length).toBeGreaterThan(0);
  });

  it("notePairEntrantDuplicates: once per stage, only from round 2, only with the evidence of an earlier pair entrant", () => {
    const setup = { entrantIds: new Set(["e1", "e2", "e3", "e4", "e5"]), persons: new Map([["e1", ["p1"]], ["e2", ["p2"]], ["e3", ["p3"]], ["e4", ["p4"]], ["e5", ["p5"]]]) };
    const f = (round: number, home: string, away: string) => ({ id: `${home}-${away}`, round_no: round, home_entrant_id: home, away_entrant_id: away }) as FixtureRow;
    const persons = { pe1: ["p1", "p2"], pe2: ["p3", "p4"], pe3: ["p1", "p5"], pe4: ["p2", "p3"] };
    const run = (rows: FixtureRow[]) => { const rec = new Recorder(); notePairEntrantDuplicates(rec, setup, rows, persons); return rec.notes; };
    expect(run([])).toEqual([]);
    // Round 1 alone may never carry it (only individuals exist before round 2).
    expect(run([f(1, "pe1", "pe3")])).toEqual([]);
    // Round 2 seats p1 twice (pe3 and pe1), and pe1 is a round-1 pair: the evidence holds.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe3", "pe1")])).toEqual([`mexicano-pair-entrants-counted-as-players: round 2 seats p1 twice, directly and via pair entrant pe1 (a round-1 pair, q < r) → ${PAIR_PLAYERS_ROUTE.wave}`]);
    // A duplicate no earlier pair explains (pe3 + pe4 hold p1, p5, p2, p3; round 1 seated only individuals): no signature.
    expect(run([f(1, "e1", "e2"), f(2, "pe3", "pe1")])).toEqual([]);
    // Once per stage, however many rounds repeat a person.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe3", "pe1"), f(3, "pe3", "pe1")]).length).toBe(1);
  });
});

type Step = "decideOne" | "forfeitOne" | "generate" | "withdrawOne";
/** Drives the product-shaped fake directly (no loop) for the fast-check
 *  property: the REAL setup, then one action per step. */
class MexicanoHarness {
  readonly driver: FakeAmericanoDriver;
  readonly ctx: ScenarioContext;
  readonly rec: Recorder;
  readonly setup: DivisionSetup;
  private constructor(driver: FakeAmericanoDriver, ctx: ScenarioContext, rec: Recorder, setup: DivisionSetup) {
    this.driver = driver;
    this.ctx = ctx;
    this.rec = rec;
    this.setup = setup;
  }
  static async open(driver: FakeAmericanoDriver, sport: string, n = 8): Promise<MexicanoHarness> {
    const ctx = ctxFor(driver, "LIFECYCLE", { row: "mexicano", sport });
    const rec = new Recorder();
    return new MexicanoHarness(driver, ctx, rec, await setUpDivision(ctx, rec, n));
  }
  #open(): FixtureRow[] { return this.driver.rows().filter((f) => f.stage_id === this.setup.stage.id && seatedOpen(f)); }
  async step(s: Step): Promise<void> {
    if (s === "decideOne" || s === "forfeitOne") {
      const f = this.#open()[0];
      if (f === undefined) return;
      await decideFixture(this.ctx, this.rec, this.setup, f, s === "decideOne" ? { kind: "win", winner: "home" } : { kind: "forfeit", by: "away", reason: "walkover" });
      return;
    }
    if (s === "generate") {
      try {
        await this.driver.generate(this.setup.stage.id);
      } catch (e) {
        if (!(e instanceof RefusedCall)) throw e;
      }
      return;
    }
    const e = this.driver.entrants.find((x) => x.status !== "withdrawn");
    if (e === undefined) return;
    await this.driver.withdraw(e.id);
  }
  rounds(): { round_no: number; persons: string[] }[] {
    const nos = [...new Set(this.driver.rows().map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
    return nos.map((round_no) => ({
      round_no,
      persons: this.driver.fixturesOfRound(round_no).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null).flatMap((e) => this.driver.membersOf(e)),
    }));
  }
  duplicatesIn(r: { persons: string[] }): string[] {
    return [...new Set(r.persons.filter((p, i) => r.persons.indexOf(p) !== i))];
  }
  pairEntrantsBefore(round: number): string[] {
    const pairs = new Set(this.driver.pairEntrantIds());
    return [...new Set(this.driver.rows().filter((f) => (f.round_no ?? 0) < round).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null && pairs.has(e)))];
  }
  anyNonDecided(): boolean { return this.driver.rows().some((f) => f.status !== "decided"); }
}
