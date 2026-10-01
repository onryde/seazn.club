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
import { AmericanoModeMismatch, PAIR_PLAYERS_ROUTE, SELF_PAIR_CAUSE, STALL_ROUTE, TEAM_MEMBER_ROUTE, americanoPlannedRounds, americanoRoundSize, modeOf, notePairEntrantDuplicates, playMexicano } from "../lib/scenarios/americano-loop.ts";
import { lineupsPut, seatsEntrant } from "../lib/scenarios/assertions.ts";
import { MINTED_PAIRS_KIND_ROUTE, Recorder, decideFixture, ensureLineups, setUpDivision, type DivisionSetup } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { TARGET_OF } from "../lib/scenarios/m1-walkover.ts";
import { KEPT_PLAYING_ROUTE, keptPlayingNote } from "../lib/scenarios/r4-withdrawal.ts";
import type { CaseSpec, ScenarioContext, ScenarioKey } from "../lib/scenarios/types.ts";
import { entrantKindFor, resolveSportCfg } from "../lib/sport-cfg.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FAKE_COUNTS_PAIR_ENTRANTS_AS_PLAYERS_BY_DEFAULT, FakeAmericanoDriver, WAIT_UNLESS } from "./fake-formats-driver.ts";
import { entrantMembersPkeyFrom, entrantMembersPkeyText, wireCodeFor } from "./product-text.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const STAGES_TS = resolve(REPO, "apps/web/src/server/usecases/stages.ts");
const FORMAT_TEMPLATES_TS = resolve(REPO, "apps/web/src/components/v2/format-templates.ts");
const ENGINE_AMERICANO_TS = resolve(REPO, "packages/engine/src/scheduling/americano.ts");
const ENTRANT_MEMBERS_SQL = resolve(REPO, "db/migration/v2-engine/tables/V213__entrant_members.sql");
const HTTP_TS = resolve(REPO, "apps/web/src/server/api-v1/http.ts");
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
/** The fake's oracle (W1-driving Task 9): how many seats of round `r` hold
 *  `person`, a seat holding them twice counting two — from its own member
 *  rows, never from I10. */
const seatsHolding = (driver: FakeAmericanoDriver, r: number, person: string): number =>
  driver.fixturesOfRound(r).flatMap((f) => [f.home_entrant_id, f.away_entrant_id]).filter((e): e is string => e !== null)
    .reduce((n, s) => n + driver.membersOf(s).filter((x) => x === person).length, 0);
/** I10's evidence for a round's repeats, built from the fake's rows. */
const i10RepeatEvidence = (driver: FakeAmericanoDriver, dup: { round_no: number; repeats: Map<string, string[]> }): string[] =>
  [...dup.repeats.keys()].map((p) => `round ${dup.round_no}: ${p} seated ${seatsHolding(driver, dup.round_no, p)}×`);
/** …and for every round the fake seated. */
const i10AllRepeats = (driver: FakeAmericanoDriver): string[] =>
  [...new Set(driver.rows().map((f) => f.round_no ?? 0))].sort((a, b) => a - b)
    .flatMap((r) => i10RepeatEvidence(driver, { round_no: r, repeats: driver.repeatsIn(r) }));

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

  it("T8-R2 empty case: an americano Start that planned NO round is short_plan, named — never drained", async () => {
    class PlansNone extends FakeAmericanoDriver {
      override async start() {
        const out = await super.start();
        this.fixtures = [];
        return out;
      }
    }
    const driver = new PlansNone({ mode: "americano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "americano" });
    expect(out.observed.stages[0]!.exit).toBe("short_plan");
    expect(out.notes).toContain(`americano: the product planned 0 of the ${ROUNDS} round(s) the engine lays out for 8 player(s) over config.rounds=${ROUNDS} — played short, never drained`);
    expect(check(checks, "life-loop-bounded").verdict).toBe("fail");
  });

  it("T8-R2: an americano Start that planned 1 of the engine's rounds is short_plan, named — every planned round decided, still never drained", async () => {
    class PlansOne extends FakeAmericanoDriver {
      override async start() {
        const out = await super.start();
        this.fixtures = this.fixtures.filter((f) => f.round_no === 1);
        return out;
      }
    }
    // Badminton declares no draw, so one round's two fixtures leave no draw
    // owed (generic's every-third-fixture draw would red on its own here).
    const driver = new PlansOne({ mode: "americano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "americano", sport: "badminton" });
    expect(driver.roundsDecided()).toEqual([1]);
    expect(out.observed.stages[0]!.exit).toBe("short_plan");
    expect(out.notes).toContain(`americano: the product planned 1 of the ${ROUNDS} round(s) the engine lays out for 8 player(s) over config.rounds=${ROUNDS} — played short, never drained`);
    expect(check(checks, "life-loop-bounded").verdict).toBe("fail");
    // Everything else reads green over the short format — the exit is what names it.
    expect(failing(checks)).toEqual(["life-loop-bounded"]);
    expect(out.observed.facts).not.toContain("cut_short");
  });

  it("T8-R2: the expected round count is the engine planner's (rounds that seat a match), never config.rounds alone", () => {
    // The rule, from the engine's line (americano.ts:50, text-pinned in the F1
    // test): a round seats min(floor(n/4), courtCount) matches, so with any
    // court a field of 4+ fills every declared round and a field under 4 none.
    const rule = (rounds: number, n: number) => (Math.floor(n / 4) >= 1 ? rounds : 0);
    for (const [cfg, rounds, n] of [[{ courtCount: COURTS }, ROUNDS, 8], [{ courtCount: COURTS }, ROUNDS, 7], [{ courtCount: COURTS }, ROUNDS, 3], [{}, ROUNDS, 8], [{ courtCount: 1 }, 3, 12], [{ courtCount: COURTS }, ROUNDS, 0]] as const) {
      expect(americanoPlannedRounds(cfg, rounds, n), `${JSON.stringify(cfg)} rounds=${rounds} n=${n}`).toBe(rule(rounds, n));
    }
    expect(americanoPlannedRounds({ courtCount: COURTS }, ROUNDS, 3), "a case where config.rounds alone is wrong").not.toBe(ROUNDS);
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

  it("I10 (Task 9) on americano R4 (fixed rotation): no round seats anyone twice in the fake's own rows, so I10 PASSES over every round — the mexicano repeat (pinned below) is not a property of every americano stage", async () => {
    // The differing case to the pinned mexicano sets (review m-4): the same
    // invariant, the same withdrawal, a mode whose plan never reuses a person.
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const { checks } = await runOn(driver, "R4", { row: "americano" });
    const rounds = [...new Set(driver.rows().map((f) => f.round_no ?? 0))].sort((a, b) => a - b);
    expect(rounds.length).toBeGreaterThan(1);
    expect(rounds.map((r) => driver.repeatsIn(r).size)).toEqual(rounds.map(() => 0));
    const c = check(checks, "I10-americano-seats-each-person-once");
    expect(c.verdict, c.evidence.join("; ")).toBe("pass");
    expect(c.checked).toBeGreaterThan(rounds.length * 4);  // one item per person per round, at least a court of 4 each
  });

  it("fast-check (rule 10, m-2): playMexicano ITSELF over any per-round schedule of forfeit / void / withdraw, either sport, either person-id order, product or corrected player set — its exit and every note agree with the fake's own rows", async () => {
    const reach = { runs: 0, round1Checks: 0, blockChecks: 0, dupSigned: 0, noDup: 0, stalledNonDecided: 0, refusedSigned: 0, drained: 0 };
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("generic", "badminton"),
      fc.boolean(),
      fc.boolean(),
      fc.array(fc.constantFrom<Act>("none", "none", "forfeit", "void", "withdraw"), { maxLength: ROUNDS }),
      async (sport, seedOrderedPersons, individualsOnly, acts) => {
        reach.runs++;
        // individualsOnly false = the product's shape; true = the corrected product (the only one that drains).
        const driver = new FakeAmericanoDriver({ mode: "mexicano", seedOrderedPersons, individualsOnly });
        const ctx = ctxFor(driver, "LIFECYCLE", { row: "mexicano", sport });
        const rec = new Recorder();
        const setup = await setUpDivision(ctx, rec, 8);
        await playMexicano(ctx, rec, setup, setup.stage, {
          beforeRound: async (round, batch) => {
            const act = acts[round - 1] ?? "none";
            const f = batch[0];
            if (f === undefined || act === "none") return;
            if (act === "forfeit") await decideFixture(ctx, rec, setup, f, { kind: "forfeit", by: "away", reason: "walkover" });
            if (act === "void") await driver.abandonFixture(driver.fixtures.find((x) => x.id === f.id)!);
            if (act === "withdraw") {
              const e = driver.entrants.find((x) => x.status !== "withdrawn");
              if (e !== undefined) await driver.withdraw(e.id);
            }
          },
        });
        const rows = driver.rows();
        const exit = rec.exit;
        const label = `${sport} seedOrdered=${seedOrderedPersons} individualsOnly=${individualsOnly} acts=${acts.join(",")}`;
        expect(["drained", "stalled_rounds", "refused_generate", "cap"], label).toContain(exit);
        const nonDecided = rows.filter((f) => f.status !== "decided");
        expect(rec.notes.some((n) => n.startsWith("mexicano-stalled-on-non-decided:") || n.startsWith("mexicano: stalled after")), `${label}: stalled_rounds ⟺ a stall note`).toBe(exit === "stalled_rounds");
        expect(rec.notes.some((n) => n.startsWith("mexicano-stalled-on-non-decided:")), `${label}: the non-decided form ⟺ a fixture not decided`).toBe(exit === "stalled_rounds" && nonDecided.length > 0);
        if (exit === "stalled_rounds") expect(rec.facts.has("cut_short"), `${label}: a stall is never cut_short`).toBe(false);
        // The product's wait, the fake held to it (I-3): no round past the lowest round holding a non-decided fixture.
        if (nonDecided.length > 0) {
          reach.blockChecks++;
          expect(Math.max(...rows.map((f) => f.round_no ?? 0)), label).toBeLessThanOrEqual(Math.min(...nonDecided.map((f) => f.round_no ?? 0)));
        }
        reach.round1Checks++;
        expect(driver.repeatsIn(1).size, `${label}: round 1 seats each person once`).toBe(0);
        // m-1: the seating signature ⟺ a repeat the fake's rows show in some round ≥ 2.
        const repeated = [...new Set(rows.map((f) => f.round_no ?? 0))].some((r) => r >= 2 && driver.repeatsIn(r).size > 0);
        expect(rec.notes.some((n) => /^mexicano-pair-entrants-counted-as-players: round \d+ seats /.test(n)), `${label}: seating signature ⟺ an observed repeat`).toBe(repeated);
        if (repeated) reach.dupSigned++; else reach.noDup++;
        // T8-R1: the refused-form signature ⟺ a 5xx carrying the self-pair's cause.
        const last = rec.track(setup.stage.id).generates.at(-1);
        const pk = exit === "refused_generate" && last !== undefined && last.status >= 500 && SELF_PAIR_CAUSE.test(last.message ?? "");
        expect(rec.notes.some((n) => /^mexicano-pair-entrants-counted-as-players: round \d+ generate refused/.test(n)), `${label}: refused signature ⟺ the PK cause`).toBe(pk);
        if (pk) reach.refusedSigned++;
        if (exit === "stalled_rounds" && nonDecided.length > 0) reach.stalledNonDecided++;
        if (exit === "drained") reach.drained++;
        return true;
      },
    ), { numRuns: 200, seed: Number(process.env.MATRIX_FC_SEED ?? 20260930) });
    // Reach counts (anti-vacuity): each biconditional is witnessed both ways.
    expect(reach.runs).toBe(200);
    expect(reach.round1Checks).toBe(200);
    expect(reach.dupSigned, "runs with an observed round-≥2 repeat").toBeGreaterThan(0);
    expect(reach.noDup, "runs with none").toBeGreaterThan(0);
    expect(reach.stalledNonDecided, "runs stalled on a forfeit or a void").toBeGreaterThan(0);
    expect(reach.refusedSigned, "runs refused on the self-pair").toBeGreaterThan(0);
    expect(reach.blockChecks, "runs judged against the wait").toBeGreaterThan(0);
    expect(reach.drained, "runs that played every round").toBeGreaterThan(0);
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

  it("mexicano round 2 (false premise 17): the product-shaped fake repeats a person; the case records the signature with the observed repeat as its evidence, routed W7", async () => {
    // Badminton folds no score, so every mexicano point is 0 and the order is
    // by person id: round 2's pairing holds no self-pair, isolating the
    // duplicate (the self-pair path is its own test below).
    const driver = new FakeAmericanoDriver({ mode: "mexicano" });
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(driver.selfPairsIn(2)).toBe(0);
    const dup = driver.firstDuplicate();   // the first round ≥ 2 with a repeat, from the fake's own rows
    expect(dup.round_no).toBe(2);
    // T8-R3 (m-1): the evidence is the REPEAT itself — the person and the two
    // seats holding them in round 2, as the fake's rows show them.
    // T15: one note per repeated person — this fake's round 2 repeats more
    // than one, as the live product's did, and I10 names every one of them.
    const notes = out.notes.filter((n) => n.startsWith("mexicano-pair-entrants-counted-as-players: round 2 seats "));
    expect(dup.repeats.size).toBeGreaterThan(1);
    expect(notes.length).toBe(dup.repeats.size);
    for (const note of notes) {
      const [, person, seats] = /^mexicano-pair-entrants-counted-as-players: round 2 seats (\S+) twice, in (.+) → W7$/.exec(note) ?? [];
      expect(dup.repeats.get(person!), `${person} repeats in round 2`).toBeDefined();
      expect(seats!.split(" and ")).toEqual(dup.repeats.get(person!));
      expect(note.endsWith(`→ ${PAIR_PLAYERS_ROUTE.wave}`)).toBe(true);
    }
    // The FULL failing set (review 2 m-8), re-derived: I10 (Task 9) reds the
    // duplicate itself, naming round 2 and the person. Round 3's plan then
    // pairs a pair entrant's person with their own individual entry (the same
    // false premise, one round later), the generate is the entrant_members
    // 500, and the run ends there: an unnamed 5xx generate (I4, I8) and the
    // loop exit. Round 1-2 are all decided, so the stage completes (FP-5 asks once).
    expect(driver.selfPairsIn(3)).toBeGreaterThan(0);
    expect(failing(checks)).toEqual(["I10-americano-seats-each-person-once", "I4-nothing-ends-stuck", "I8-generate-named", "life-loop-bounded"]);
    expect([...check(checks, "I10-americano-seats-each-person-once").evidence].sort()).toEqual(i10RepeatEvidence(driver, dup).sort());
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
    // T8-R1: the refusal's message is kept, and it is the product's cause.
    const g = out.observed.stages[0]!.generates;
    expect(g.length).toBe(1);
    expect(g[0]!.message).toMatch(SELF_PAIR_CAUSE);
    expect(check(checks, "life-loop-bounded").evidence.some((e) => /exited refused_generate/.test(e))).toBe(true);
    expect(out.notes.filter((n) => n.startsWith(`mexicano-pair-entrants-counted-as-players: round 2 generate refused 500 INTERNAL (${entrantMembersPkeyText().name}:`) && n.includes(`after round 1 created pair entrants ${driver.pairEntrantIds().join(", ")}`) && n.endsWith(`→ ${PAIR_PLAYERS_ROUTE.wave}`)).length).toBe(1);
    // Re-derived under FP-5 (T6-R2: every reached stage is asked to complete
    // once): round 1 is all decided, so the complete SUCCEEDS — life-stage-
    // completed passes, and I4 fails on the unnamed 500 alone. Only round 1's
    // two fixtures were played, so the draw the harness posts on every third
    // fixture never came: life-draw-path-exercised reds as a consequence.
    expect(check(checks, "life-stage-completed").verdict).toBe("pass");
    expect(check(checks, "I4-nothing-ends-stuck").evidence).toEqual(["stage 1: generate answered 500 INTERNAL — not a named refusal"]);
    expect(failing(checks)).toEqual(["I4-nothing-ends-stuck", "I8-generate-named", "life-draw-path-exercised", "life-loop-bounded"]);
  });

  it("T8-R5 (I-R1): SELF_PAIR_CAUSE is the product's — the name Postgres gives V213's unnamed entrant_members key, which the v1 catch-all carries into the 500 and the fake throws", () => {
    const pk = entrantMembersPkeyText();
    expect(pk.scanned, "migration files checked for a later name, rename or drop").toBeGreaterThan(0);
    expect(SELF_PAIR_CAUSE.test(pk.violation), pk.violation).toBe(true);
    // Canary: the same violation on ANOTHER table's key — a sibling `_pkey`, as
    // a duplicate pair entrant row would raise — is NOT the cause (the regex is not over-broad).
    for (const other of ["entrants_pkey", "em_pk"]) expect(SELF_PAIR_CAUSE.test(pk.violation.replace(pk.name, other)), other).toBe(false);
    // The member insert has no ON CONFLICT, so a duplicate (entrant, person) row raises (stages.ts pairEntrantsFor).
    const pairs = sliceFunction(readFileSync(STAGES_TS, "utf8"), "pairEntrantsFor");
    expect(pairs).toContain("await tx`insert into entrant_members ${tx(memberRows)}`;");
    expect(pairs).not.toMatch(/on conflict/i);
    // The v1 catch-all: an error no earlier arm claims (a database error is
    // none of them) answers 500 INTERNAL with the error's OWN message.
    const http = readFileSync(HTTP_TS, "utf8");
    const at = http.indexOf("\nasync function v1Inner<T>(");
    expect(at, "http.ts v1Inner").toBeGreaterThan(-1);
    const inner = http.slice(at, http.indexOf("\n}\n", at) + 2);
    expect(inner).toMatch(/\n {4}if \(err instanceof HttpError\) \{[\s\S]*?\n {4}\}\n {4}Sentry\.captureException\(err\);\n {4}const message = err instanceof Error \? err\.message : "Server error";\n[^\n]*\n {4}return errorResponse\(requestId, 500, "INTERNAL", message\);\n {2}\}\n\}$/);
    expect(wireCodeFor(500)).toBe("INTERNAL");
  });

  it("T8-R5: the key's name is derived, and refused by name when V213 names it, a later migration renames, names or drops a constraint on the table, or mentions the derived name", () => {
    const v213 = readFileSync(ENTRANT_MEMBERS_SQL, "utf8");
    const ok = entrantMembersPkeyFrom(v213, [{ path: "V1__other.sql", text: "create table other (id uuid primary key);" }]);
    expect(ok).toEqual({ name: "entrant_members_pkey", violation: 'duplicate key value violates unique constraint "entrant_members_pkey"', scanned: 1 });
    // Empty case: no other migration is a scan of nothing — refused, never a vacuous pass.
    expect(() => entrantMembersPkeyFrom(v213, [])).toThrow("product-text: no migration besides V213 was scanned for entrant_members constraint changes");
    // Temp copies of V213 with the key NAMED — on its line, or on the line
    // before (each guard alone) — or on other columns: the default name no longer applies.
    for (const named of ["  constraint em_pk primary key (entrant_id, person_id)", "  constraint em_pk\n  primary key (entrant_id, person_id)", "  primary key (entrant_id, org_id)"]) {
      expect(() => entrantMembersPkeyFrom(v213.replace("  primary key (entrant_id, person_id)", named), [{ path: "x.sql", text: "" }]), named).toThrow("product-text: V213's entrant_members primary key is not the unnamed (entrant_id, person_id) clause");
    }
    for (const text of [
      "alter table entrant_members rename constraint entrant_members_pkey to em_pk;",
      "alter table if exists public.entrant_members\n  drop constraint entrant_members_pkey;",
      "ALTER TABLE entrant_members ADD CONSTRAINT em_pk PRIMARY KEY (entrant_id, person_id);",
      "alter index entrant_members_pkey rename to em_pk;",
    ]) {
      expect(() => entrantMembersPkeyFrom(v213, [{ path: "V999__later.sql", text }]), text).toThrow(/^product-text: V999__later\.sql changes entrant_members' constraints/);
    }
    // An alter that leaves the constraints alone is fine.
    expect(entrantMembersPkeyFrom(v213, [{ path: "V998__col.sql", text: "alter table entrant_members add column note text;" }]).name).toBe("entrant_members_pkey");
  });

  it("T8-R1: a mexicano 5xx whose message is NOT the self-pair's cause stays unsigned — the same 500 with the product's cause is signed", async () => {
    // After round 1, the round-2 generate answers 500 INTERNAL with a cause of
    // its own (the points query's numeric cast, stages.ts:774-783, say).
    class Other500 extends FakeAmericanoDriver {
      override async generate(stageId = "s1"): Promise<GenerateOut> {
        this.log("generate", stageId);
        throw new RefusedCall("POST", `/api/v1/stages/${stageId}/generate`, 500, wireCodeFor(500), 'invalid input syntax for type numeric: "x"');
      }
    }
    const other = new Other500({ mode: "mexicano" });
    const o = await runOn(other, "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(o.out.observed.stages[0]!.exit).toBe("refused_generate");
    expect(o.out.observed.stages[0]!.generates.map((g) => [g.status, SELF_PAIR_CAUSE.test(g.message ?? "")])).toEqual([[500, false]]);
    expect(other.pairEntrantIds().length, "pair entrants exist, so the message is what decides").toBeGreaterThan(0);
    expect(o.out.notes.some((n) => n.includes("mexicano-pair-entrants-counted-as-players"))).toBe(false);
    // The differing case: the same 500, carrying the product's cause, is signed.
    class Pk500 extends FakeAmericanoDriver {
      override async generate(stageId = "s1"): Promise<GenerateOut> {
        this.log("generate", stageId);
        throw new RefusedCall("POST", `/api/v1/stages/${stageId}/generate`, 500, wireCodeFor(500), entrantMembersPkeyText().violation);
      }
    }
    const pk = await runOn(new Pk500({ mode: "mexicano" }), "LIFECYCLE", { row: "mexicano", sport: "badminton" });
    expect(pk.out.notes.filter((n) => n.startsWith("mexicano-pair-entrants-counted-as-players: round 2 generate refused 500")).length).toBe(1);
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
    // The round-2 duplicate is here too (false premise 17), named, and I10 (Task 9) reds on it.
    const dup = driver.firstDuplicate();
    expect(out.notes.some((n) => [...dup.repeats.keys()].some((p) => n.startsWith(`mexicano-pair-entrants-counted-as-players: round ${dup.round_no} seats ${p} twice`)))).toBe(true);
    // Full failing set (review 3 I-2; Task 9 Step 1 adds I10):
    expect(failing(checks)).toEqual(["I10-americano-seats-each-person-once", "r4-policy-reported"]);
    // I10 judges EVERY round, and the product-shaped fake repeats in each one
    // after the first (rounds 2–7 here), so its evidence is every round's
    // repeats as the fake's own rows show them — led by round 2's.
    const i10 = check(checks, "I10-americano-seats-each-person-once");
    const all = i10AllRepeats(driver);
    expect(all.length).toBeGreaterThan(i10RepeatEvidence(driver, dup).length); // more than round 2: the differing case
    expect(all.length).toBeLessThanOrEqual(12);                                 // evidence keeps 12: the whole list is compared
    expect([...i10.evidence].sort()).toEqual([...all].sort());
    expect(i10RepeatEvidence(driver, dup)).toContain(i10.reason);
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
    // m-5: no person for the withdrawn entrant is thrown by name — but only once the policy legs hold.
    expect(() => keptPlayingNote(w, [], stage)).toThrow("scenario: R4 on an americano stage, but the withdrawn entrant e3 has no linked person — the setup reads one for every entrant (personsNeeded)");
    expect(keptPlayingNote({ ...w, policy: "walkover" }, [], stage), "a cascade needs no person").toBeNull();
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
    // I10 (Task 9) judges the real rounds: one item per person per round, per field person, per seated pair.
    const i10b = check(b.checks, "I10-americano-seats-each-person-once");
    expect(i10b.verdict).toBe("pass");
    expect(i10b.checked).toBeGreaterThan(bad.entrants.length);
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
    // I10 judges a team by the ENTRANT (one member seated is enough): it passes although most roster members never sit.
    expect(check(f.checks, "I10-americano-seats-each-person-once").verdict).toBe("pass");
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

  it("F1 on mexicano (corrected player set): the round size holds, and exactly the 3 entrants round 1 sits out are the ones never seated in any of the 7 rounds — f1-everyone-drawn reds on exactly them (a product finding)", async () => {
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
      expect(driver.roundsGenerated(), `${sport}: all 7 rounds were played`).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const never = field.filter((e) => [1, 2, 3, 4, 5, 6, 7].every((r) => !inRound(r).has(driver.membersOf(e)[0]!)));
      expect([...never].sort(), `${sport}: whoever sits out round 1 sits out every round`).toEqual([...outOfRound1].sort());
      expect(check(checks, "f1-round-size").verdict).toBe("pass");
      const drawn = check(checks, "f1-everyone-drawn");
      expect(drawn.verdict).toBe("fail");
      expect(drawn.evidence.map((x) => x.split(" ")[0]).sort()).toEqual([...never].sort());
      // I10 (Task 9) names the same three, by their persons (PF-8: seated in 0 fixtures).
      const i10 = check(checks, "I10-americano-seats-each-person-once");
      expect(i10.verdict, sport).toBe("fail");
      expect(i10.evidence.filter((x) => / never played$/.test(x)).sort(), sport).toEqual(never.map((e) => `${driver.membersOf(e)[0]} never played`).sort());
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

  it("notePairEntrantDuplicates (T8-R3, m-1): once per stage, only from round 2, only on an OBSERVED repeat in that round's seating — round-1 membership is no evidence", () => {
    const setup = { persons: new Map([["e1", ["p1"]], ["e2", ["p2"]], ["e3", ["p3"]], ["e4", ["p4"]], ["e5", ["p5"]]]) };
    const f = (round: number, home: string, away: string) => ({ id: `${home}-${away}`, round_no: round, home_entrant_id: home, away_entrant_id: away }) as FixtureRow;
    const persons = { pe1: ["p1", "p2"], pe2: ["p3", "p4"], pe3: ["p1", "p5"], pe4: ["p2", "p3"], pe5: ["p4", "p5"], pe6: ["p6", "p6"] };
    const run = (rows: FixtureRow[]) => { const rec = new Recorder(); notePairEntrantDuplicates(rec, setup, rows, persons); return rec.notes; };
    expect(run([])).toEqual([]);
    // Round 1 alone may never carry it (only individuals exist before round 2).
    expect(run([f(1, "pe1", "pe3")])).toEqual([]);
    // Round 2 seats p1 in two seats (pe3 and pe1): the repeat is the evidence.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe3", "pe1")])).toEqual([`mexicano-pair-entrants-counted-as-players: round 2 seats p1 twice, in pe3 and pe1 → ${PAIR_PLAYERS_ROUTE.wave}`]);
    // A person in one seat with themselves is a repeat too.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe6", "pe5")])).toEqual([`mexicano-pair-entrants-counted-as-players: round 2 seats p6 twice, in pe6 with themselves → ${PAIR_PLAYERS_ROUTE.wave}`]);
    // Evidence FALSE: every round-2 person but p5 sat in a round-1 pair (pe1,
    // pe2 hold p1-p4), yet round 2 (pe3: p1+p5, pe4: p2+p3) seats nobody twice
    // — no signature. Round-1 membership is no evidence.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe3", "pe4")])).toEqual([]);
    // A repeat with no earlier pair at all is still observed, still signed (the repeat is the evidence).
    expect(run([f(1, "e1", "e2"), f(2, "pe3", "pe1")])).toEqual([`mexicano-pair-entrants-counted-as-players: round 2 seats p1 twice, in pe3 and pe1 → ${PAIR_PLAYERS_ROUTE.wave}`]);
    // Once per PERSON per stage, however many rounds repeat them (T15: live,
    // round 2 repeated two persons and I10 named both, but the note named only
    // the first — the coverage table needs every repeated person named).
    expect(run([f(1, "pe1", "pe2"), f(2, "pe3", "pe1"), f(3, "pe3", "pe1")]).length).toBe(1);
    // Two persons repeated in one round: each named once, in the round it first repeats.
    expect(run([f(1, "pe1", "pe2"), f(2, "pe1", "pe3"), f(2, "pe4", "pe2"), f(3, "pe4", "pe2")])).toEqual([
      `mexicano-pair-entrants-counted-as-players: round 2 seats p1 twice, in pe1 and pe3 → ${PAIR_PLAYERS_ROUTE.wave}`,
      `mexicano-pair-entrants-counted-as-players: round 2 seats p2 twice, in pe1 and pe4 → ${PAIR_PLAYERS_ROUTE.wave}`,
      `mexicano-pair-entrants-counted-as-players: round 2 seats p3 twice, in pe4 and pe2 → ${PAIR_PLAYERS_ROUTE.wave}`,
    ]);
  });
});

/** One round's intervention in the rule-10 property (beforeRound). */
type Act = "none" | "forfeit" | "void" | "withdraw";

// T12-R1 (W1-driving fix round 1): live, both americano cells redded
// life-entrants-edit-accepted with 422 ENTRANT_KIND_IN_USE — the probe saved
// kinds = [the registered kind], and the product's withdraw-first guard
// (divisions.ts:857-871) counts the pair entrants the stage MINTED, which the
// organiser cannot withdraw. The probe now saves the kinds the product's
// active entrants hold; the finding stays visible as a predicted W7 note.
// The expected kinds are the engine's declared default kind (what the harness
// registers) and the product's minted `pair` — never read back from the probe.
describe("T12-R1: the entrants-only probe on an americano saves the kinds the product's active entrants hold", () => {
  it.each(["generic", "badminton", "football"])("americano|%s: both kinds saved, the save accepted, the minted-pairs note recorded once", async (sport) => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    const bodies: Record<string, unknown>[] = [];
    const save = driver.patchDivisionConfig.bind(driver);
    driver.patchDivisionConfig = async (d: string, c: Record<string, unknown>) => { bodies.push(c); return save(d, c); };
    const { out, checks } = await runOn(driver, "LIFECYCLE", { row: "americano", sport });
    const registered = entrantKindFor(sport, resolveSportCfg(sport, variantFor(sport)));
    expect(registered).not.toBe("pair");
    const entrantsOnly = bodies.filter((b) => b.entrants !== undefined);
    expect(entrantsOnly).toHaveLength(1);
    expect((entrantsOnly[0]!.entrants as { kinds: string[] }).kinds).toEqual([registered, "pair"]);
    expect(check(checks, "life-entrants-edit-accepted")).toMatchObject({ verdict: "pass", checked: 1 });
    const note = out.notes.filter((n) => n.startsWith("americano-minted-pairs-block-kind-edit: organiser cannot narrow entrant kinds on a running americano (minted pairs block)"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain(`→ ${MINTED_PAIRS_KIND_ROUTE.wave}`);
    expect(note[0]).toMatch(/\d+ minted pair entrant\(s\) active/);
  });
  it("the narrowing the probe used to send is what the product refuses: [registered] alone → 422 ENTRANT_KIND_IN_USE on the same fake", async () => {
    const driver = new FakeAmericanoDriver({ mode: "americano" });
    await runOn(driver, "LIFECYCLE", { row: "americano", sport: "badminton" });
    const registered = entrantKindFor("badminton", resolveSportCfg("badminton", variantFor("badminton")));
    const d = await driver.getDivision();
    expect(await driver.patchDivisionConfig("d1", { ...d.config, entrants: { kinds: [registered] } })).toEqual({ status: 422, code: "ENTRANT_KIND_IN_USE" });
    expect(await driver.patchDivisionConfig("d1", { ...d.config, entrants: { kinds: [registered, "pair"] } })).toEqual({ status: 200, code: null });
  });
});
