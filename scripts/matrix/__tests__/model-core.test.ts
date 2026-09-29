// The fast-check model core (W1b Task 13): the void-aware ledger fold, the ten
// organiser commands, the step check run after every command, and the #879
// fence. Driven DB-free through ModelFakeDriver, whose outcomes come from the
// engine's own fold and whose schedule is the engine's own round robin.
//
// State transitions under test (TEST-STRATEGY rule 1): not started → started
// (Start); roster growth before and after start (AddEntrant); a withdrawal
// (Withdraw, its cascade riding the ledger); a result, a walkover, a void and
// a correction on one fixture; a second Generate; a Rebuild after results; a
// Complete. Empty cases: an empty ledger, a model with nothing to judge, a
// command with no candidate.
import { generateRoundRobin } from "@seazn/engine/scheduling";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { engineFixtureStatus } from "../../../apps/web/src/lib/fixture-engine-status.ts";
import { BUILDER_DEFAULT_KNOBS, SPORT_KEYS } from "../lib/catalogue.ts";
import { RefusedCall, type FixtureRow, type PostedEvent } from "../lib/driver/types.ts";
import { COMMAND_KINDS, ModelViolation, checkStep, commandOf, modelCommands, newModelState, type CommandKind, type ModelState } from "../lib/model/commands.ts";
import { FENCES, fenceBlocking } from "../lib/model/fences.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import { ORIENTATION_CHECK, VOID_STATUSES, absorbFixtures, orientationBound } from "../lib/model/state.ts";
import { PENDING_STATUSES, TERMINAL_STATUSES, isNamedRefusal, sameOutcome, toObservedOutcome } from "../lib/observed.ts";
import { entrantKindFor, resolveSportCfg, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { START, type RequestedOutcome } from "../lib/streams/types.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { ModelFakeDriver, type ModelFakeOpts } from "./model-fake-driver.ts";

const I7 = "I7-rr-no-pair-over-legs";
const I8 = "I8-generate-named";
const cfg = resolveSportCfg("generic", "score");
const stream = (sport: string, c: unknown, home: string, away: string, outcome: RequestedOutcome) =>
  generateStream({ sportKey: sport, cfg: c, stageKind: "league", home, away, outcome });
const win = (winner: "home" | "away") => stream("generic", cfg, "h", "a", { kind: "win", winner });
const entries = (evs: { type: string; payload: unknown }[]): LedgerEntry[] => evs.map((e, i) => ({ id: `x${i + 1}`, seq: i + 1, type: e.type, payload: e.payload }));
const seatsOf = (f: { home_entrant_id: string | null; away_entrant_id: string | null }): [string, string] => {
  if (f.home_entrant_id === null || f.away_entrant_id === null) throw new Error("test: an unseated fixture");
  return [f.home_entrant_id, f.away_entrant_id];
};
/** The builder's "Home and away" legs option (division-builder.tsx legs select). */
const HOME_AWAY = { ...BUILDER_DEFAULT_KNOBS, legs: 2 };

type Setup = { sport?: string; variant?: string; entrants?: number; knobs?: typeof HOME_AWAY };
async function fresh(opts: ModelFakeOpts = {}, over: Setup = {}): Promise<{ m: ModelState; d: ModelFakeDriver }> {
  const d = new ModelFakeDriver(opts);
  const m = await newModelState({ driver: d, row: "league", sport: over.sport ?? "generic", variant: over.variant ?? "score", entrants: over.entrants ?? 4, tag: "t", ...(over.knobs === undefined ? {} : { knobs: over.knobs }) });
  return { m, d };
}
/** A hand-written command sequence: each step must be runnable, then runs. */
async function play(m: ModelState, d: ModelFakeDriver, steps: [CommandKind, number, number?][], fences = true): Promise<void> {
  for (const [kind, k, w] of steps) {
    const c = commandOf(kind, k, w ?? 0, fences);
    expect(c.check(m), `${kind} should be runnable`).toBe(true);
    await c.run(m, d);
  }
}
const violation = async (p: Promise<unknown>): Promise<ModelViolation> => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ModelViolation);
  return e as ModelViolation;
};

// Order matters: Correct needs a decided fixture, so it runs before any void.
// Fences off: the late-entry fence would withhold Generate.
const EVERY_KIND: [CommandKind, number, number?][] = [
  ["Start", 0], ["Score", 0, 0], ["Score", 0, 1], ["Correct", 0], ["Walkover", 0, 1], ["Void", 0],
  ["AddEntrant", 0], ["Generate", 0], ["Rebuild", 0], ["Withdraw", 0], ["Complete", 0],
];

describe("ledger fold (void-aware, the engine's own fold)", () => {
  it("empty case first: an empty ledger folds to no outcome", () => {
    expect(foldLedger("generic", cfg, "h", "a", [])).toBeNull();
  });
  it("a win stream folds to its winner, either side", () => {
    // single-sport: the registry sweep below covers every sport; this pins the two sides on one.
    expect(foldLedger("generic", cfg, "h", "a", entries(win("home")))).toMatchObject({ kind: "win", winner: "h" });
    expect(foldLedger("generic", cfg, "h", "a", entries(win("away")))).toMatchObject({ kind: "win", winner: "a" });
  });
  it("voiding every live event, newest first, folds back to no decision; liveEntries is empty", () => {
    // single-sport: void resolution is the engine kernel's (core/events.ts resolveVoids), not a sport's.
    const e = entries(win("home"));
    const voids = [...e].reverse().map((t, i) => ({ id: `v${i + 1}`, seq: e.length + i + 1, type: "core.void", payload: {}, voids: t.id }));
    const all = [...e, ...voids];
    expect(liveEntries(all)).toEqual([]);
    const out = foldLedger("generic", cfg, "h", "a", all);
    expect(out === null || out.kind !== "win").toBe(true);
  });
  it("a void naming an unknown event is the engine's named refusal, not a silent pass", () => {
    // single-sport: the refusal is the kernel's (resolveVoids), before any module reduces.
    expect(() => foldLedger("generic", cfg, "h", "a", [...entries(win("home")), { id: "v", seq: 99, type: "core.void", payload: {}, voids: "nope" }])).toThrow(/core\.void targets unknown/);
  });
  it("every registry sport: a win folds to the side asked for, and voiding the deciding event un-decides it", () => {
    let checked = 0;
    for (const sport of SPORT_KEYS) {
      const c = resolveSportCfg(sport, variantKeys(sport)[0] ?? "");
      for (const side of ["home", "away"] as const) {
        const e = entries(stream(sport, c, "h", "a", { kind: "win", winner: side }));
        const want = { kind: "win" as const, winner: side === "home" ? "h" : "a" };
        expect(sameOutcome(toObservedOutcome(foldLedger(sport, c, "h", "a", e)), want), `${sport} ${side}`).toBe(true);
        const last = e[e.length - 1];
        if (last === undefined) throw new Error(`${sport}: empty stream`);
        const undone = foldLedger(sport, c, "h", "a", [...e, { id: "v", seq: e.length + 1, type: "core.void", payload: {}, voids: last.id }]);
        expect(sameOutcome(toObservedOutcome(undone), want), `${sport} ${side} after the void`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(SPORT_KEYS.length * 2);
  });
});

describe("model commands — preconditions", () => {
  it("empty case first: before Start, only Start and AddEntrant are runnable", async () => {
    const { m } = await fresh();
    const runnable = COMMAND_KINDS.filter((k) => commandOf(k, 0, 0, true).check(m));
    expect(runnable).toEqual(["Start", "AddEntrant"]);
  });
  it("one arbitrary per command kind, in COMMAND_KINDS order (the ten §7.5 names), each generating its own kind", () => {
    const arbs = modelCommands({ fences: true });
    expect(arbs.length).toBe(10);
    expect(arbs.map((a) => String(fc.sample(a, { numRuns: 1, seed: 7 })[0]).split("(")[0])).toEqual([...COMMAND_KINDS]);
    expect([...COMMAND_KINDS]).toEqual(["Start", "AddEntrant", "Withdraw", "Score", "Walkover", "Void", "Correct", "Generate", "Rebuild", "Complete"]);
  });
  it("second call: Start is not offered twice, and a second Generate on an unchanged roster adds nothing and is judged again", async () => {
    // single-sport: Generate's pairing is sport-blind.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Generate", 0], ["Generate", 0]]);
    expect(commandOf("Start", 0, 0, true).check(m)).toBe(false);
    // C(4,2) = 6 pairs, one leg — the engine's roundRobinFixtureCount, never read from the fake.
    expect(m.generates).toEqual([{ status: 200, code: null, total: 6, created: 0 }, { status: 200, code: null, total: 6, created: 0 }]);
    expect(m.fixtures.size).toBe(6);
    // I8 judges every Generate at every step: 1 after the first, 2 after the second.
    expect(m.stepChecks.get(I8)).toBe(3);
  });
  it("roster growth BEFORE Start is not a late entry: Generate stays offered with fences on, and Start seats the grown field", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["AddEntrant", 0], ["Start", 0], ["Generate", 0]]);
    expect(m.lateEntry).toBe(false);
    expect(m.entrants.length).toBe(5);
    // C(5,2) = 10 pairs, one leg.
    expect(m.fixtures.size).toBe(10);
  });
  it("Complete: with fixtures pending the answer is completed:false and the stage stays open; once every fixture is decided it completes and is not offered again", async () => {
    // single-sport: completion reads fixture statuses, not a sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Complete", 0]]);
    expect(m.completed).toBe(false);
    expect(commandOf("Complete", 0, 0, true).check(m)).toBe(true);
    await play(m, d, [["Score", 0, 1], ["Score", 0, 0], ["Score", 0, 1], ["Score", 0, 0], ["Score", 0, 1], ["Complete", 0]]);
    expect(m.completed).toBe(true);
    expect(commandOf("Complete", 0, 0, true).check(m)).toBe(false);
    expect(m.counts.Complete).toEqual({ ran: 2, accepted: 2, refused: 0 });
  });
  it("Rebuild on an unplayed stage replaces every fixture (twice); after a result — even one since voided — it is refused by name", async () => {
    // single-sport: rebuild's guard reads the ledger, not a sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0]]);
    const first = [...m.fixtures.keys()];
    await play(m, d, [["Rebuild", 0], ["Rebuild", 0]]);
    const now = [...m.fixtures.keys()];
    expect(now.length).toBe(6);
    expect(now.filter((id) => first.includes(id))).toEqual([]);
    expect([...m.fixtures.values()].every((f) => f.ledger !== null && f.ledger.length === 0)).toBe(true);
    expect(m.counts.Rebuild).toEqual({ ran: 2, accepted: 2, refused: 0 });
    // stages.ts rebuildStageFixtures blocks on any score event (fixtureHasResultSql), not only on an outcome.
    await play(m, d, [["Score", 0, 0], ["Void", 0], ["Void", 0], ["Rebuild", 0]]);
    expect([...m.fixtures.values()].some((f) => f.status !== "scheduled")).toBe(false);
    expect(m.counts.Rebuild).toEqual({ ran: 3, accepted: 2, refused: 1 });
  });
});

describe("model commands — a correct product passes every step", () => {
  it("each command kind runs once, every step is checked, fold parity compares > 0 fixtures", async () => {
    // single-sport: the registry sweep below runs the same sequence on every modelled sport.
    const { m, d } = await fresh();
    await play(m, d, EVERY_KIND, false);
    for (const k of COMMAND_KINDS) expect(m.counts[k].ran, k).toBeGreaterThan(0);
    expect(m.counts.Score.accepted).toBeGreaterThan(0);
    expect(m.counts.Rebuild.refused).toBe(1); // results exist → STAGE_HAS_RESULTS, named
    expect(m.foldParity).toBeGreaterThan(0);
    expect(m.stepChecks.get(I8) ?? 0).toBeGreaterThan(0);
    expect(m.stepChecks.get(I7) ?? 0).toBeGreaterThan(0);
    expect(m.stepChecks.get(ORIENTATION_CHECK) ?? 0).toBeGreaterThan(0);
    expect(m.history.length).toBe(EVERY_KIND.length);
  });
  it("every registry sport: the same sequence runs clean on each non-team sport, and a team sport is refused by name", async () => {
    let modelled = 0;
    let refused = 0;
    for (const sport of SPORT_KEYS) {
      const variant = variantKeys(sport)[0] ?? "";
      if (entrantKindFor(sport, resolveSportCfg(sport, variant)) === "team") {
        await expect(fresh({}, { sport, variant }), sport).rejects.toThrow(/fields teams/);
        refused++;
        continue;
      }
      const { m, d } = await fresh({}, { sport, variant });
      await play(m, d, EVERY_KIND, false);
      for (const k of COMMAND_KINDS) expect(m.counts[k].ran, `${sport} ${k}`).toBeGreaterThan(0);
      expect(m.counts.Score.accepted, sport).toBe(2);
      expect(m.foldParity, sport).toBeGreaterThan(0);
      modelled++;
    }
    expect(modelled).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(modelled + refused).toBe(SPORT_KEYS.length);
  });
  it("Score after a void never re-scores the voided fixture: in play is not open", async () => {
    // single-sport: candidate selection reads the model, not the sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Void", 0], ["Score", 0, 0]]);
    expect(m.counts.Score).toEqual({ ran: 2, accepted: 2, refused: 0 });
    const scored = [...m.fixtures.values()].filter((f) => (f.ledger ?? []).some((e) => e.type === "generic.result"));
    expect(scored.length).toBe(2);
  });
});

describe("model commands — each fault is caught at the step that causes it", () => {
  it("#879: a late entrant then Generate duplicates pairs → I7 at that step (fences OFF)", async () => {
    // single-sport: #879 is a pairing defect, sport-blind.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["AddEntrant", 0]], false);
    const e = await violation(play(m, d, [["Generate", 0]], false));
    expect(e.check).toBe(I7);
  });
  it("#879 needs a late entrant: with fault879 on, Start then Generate (no AddEntrant) duplicates nothing (R-PF8)", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["Generate", 0]], false);
    expect(m.counts.Generate.ran).toBe(1);
    expect(m.stepChecks.get(I7) ?? 0).toBeGreaterThan(0);
  });
  it("…and with fences ON, Generate is not offered after a late entry on a league stage, and the fence is counted", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Start", 0], ["AddEntrant", 0]]);
    expect(commandOf("Generate", 0, 0, true).check(m)).toBe(false);
    expect(m.fenced.get("late-entry-then-generate")).toBe(1);
    expect(fenceBlocking(m, "Generate", true)?.issue).toBe("#879");
    expect(fenceBlocking(m, "Generate", false)).toBeNull();
  });
  it("a product that lies about an outcome → model-fold-parity", async () => {
    // single-sport: parity compares the engine's fold with the product's answer, whatever the sport.
    const { m, d } = await fresh({ lieOutcome: true });
    const e = await violation(play(m, d, [["Start", 0], ["Score", 0, 0]]));
    expect(e.check).toBe("model-fold-parity");
  });
  it("an unnamed refusal → model-refusal-named", async () => {
    // single-sport: refusal naming is api-v1's, not a sport's.
    const { m, d } = await fresh({ unnamedCompleteRefusal: true });
    const e = await violation(play(m, d, [["Start", 0], ["Complete", 0]]));
    expect(e.check).toBe("model-refusal-named");
  });
  it("carry (b): a 2xx Generate that answers zero fixtures fails I8 at that step — recorded by the model, judged by I8", async () => {
    // single-sport: an empty answer is sport-blind.
    const { m, d } = await fresh({ emptyGenerate: true });
    await play(m, d, [["Start", 0]]);
    const e = await violation(play(m, d, [["Generate", 0]]));
    expect(e.check).toBe(I8);
    expect(m.generates).toEqual([{ status: 200, code: null, total: 0, created: 0 }]);
  });
  it("checkStep on a model with nothing to judge reports zero, never a pass (R25)", async () => {
    // single-sport: nothing is posted, so no sport is exercised.
    const { m, d } = await fresh();
    await checkStep(m, d);
    expect(m.foldParity).toBe(0);
    expect(m.stepChecks.size).toBeGreaterThan(0);
    expect([...m.stepChecks.values()].every((n) => n === 0)).toBe(true);
  });
  it("FENCES is non-empty and each names an open issue", () => {
    expect(FENCES.length).toBeGreaterThan(0);
    for (const f of FENCES) expect(f.issue).toMatch(/^#\d+$/);
  });
});

describe("model walkover uses the product's forfeit composition", () => {
  it("a scheduled fixture's walkover posts START then core.forfeit (as HttpDriver.forfeit does)", async () => {
    // single-sport: the composition is core events only.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Walkover", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).some((e) => e.type === "core.forfeit"));
    expect(f?.ledger?.map((e) => e.type)).toEqual([START.type, "core.forfeit"]);
  });
});

describe("carry (a): a withdrawal's cascade rides the ledger, and an abandoned fixture stays abandoned", () => {
  it("after an expunge, a post to the withdrawn entrant's fixture is refused by name and never overwrites 'abandoned'", async () => {
    // single-sport: the cascade's composition is core events only; the registry sweep runs Withdraw on every modelled sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    const scored = [...m.fixtures.values()].find((f) => (f.ledger ?? []).length > 0);
    if (scored?.home === undefined || scored.home === null) throw new Error("test: nothing scored");
    // Withdraw the scored fixture's home side: one of its three played, so the engine's policy expunges.
    await play(m, d, [["Withdraw", m.entrants.indexOf(scored.home)]]);
    expect([...m.withdrawn]).toEqual([scored.home]);
    const touched = d.fixtures.filter((f) => f.home_entrant_id === scored.home || f.away_entrant_id === scored.home);
    expect(touched.length).toBe(3);
    for (const f of touched) {
      expect(f.status, f.id).toBe("abandoned");
      expect(liveEntries(d.ledgers.get(f.id) ?? []).map((e) => e.type), f.id).toContain("core.abandon");
    }
    // The played fixture's result was voided before the abandon (withdrawal.ts voidAndAbandon).
    expect((d.ledgers.get(scored.id) ?? []).filter((e) => e.type === "core.void").length).toBe(1);
    for (const f of touched) {
      const [h, a] = seatsOf(f);
      const e = await d.postStream(f.id, stream("generic", cfg, h, a, { kind: "win", winner: "home" }), "late").then(() => null, (x: unknown) => x);
      expect(e, f.id).toBeInstanceOf(RefusedCall);
      expect(isNamedRefusal((e as RefusedCall).status, (e as RefusedCall).code), f.id).toBe(true);
      expect(d.fixtures.find((x) => x.id === f.id)?.status, f.id).toBe("abandoned");
    }
    // …and every later step reads them abandoned, their ledgers unknown to the model.
    await play(m, d, [["Generate", 0], ["Complete", 0]], false);
    for (const f of touched) expect(m.fixtures.get(f.id), f.id).toMatchObject({ status: "abandoned", ledger: null });
  });
  it("the walkover policy (played ≥ half): the pending fixture is forfeited by the cascade, and the model reads it without a false parity", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
    const played = (e: string) => [...m.fixtures.values()].filter((f) => (f.home === e || f.away === e) && f.status === "decided").length;
    // Two of three played is not under half: withdrawTableEntrant walks the rest over.
    const who = m.entrants.find((e) => played(e) === 2);
    if (who === undefined) throw new Error("test: no entrant with two results");
    await play(m, d, [["Withdraw", m.entrants.indexOf(who)]]);
    const pending = d.fixtures.filter((f) => (f.home_entrant_id === who || f.away_entrant_id === who) && f.status !== "decided");
    expect(pending.length).toBe(1);
    for (const f of pending) {
      expect(f.status, f.id).toBe("forfeited");
      expect(m.fixtures.get(f.id), f.id).toMatchObject({ status: "forfeited", ledger: null });
    }
    // The walked-over opponent's win is not the model's to judge, and the next steps still check clean.
    const before = m.foldParity;
    await play(m, d, [["Score", 0, 1], ["Generate", 0]]);
    expect(m.foldParity).toBeGreaterThan(before);
  });
});

describe("carry (c): at legs ≥ 2 a duplicate masked by a missing meeting is still seen", () => {
  it("control: the engine's mirrored home-and-away schedule passes, every pair judged once per step", async () => {
    // single-sport: the schedule is sport-blind.
    const { m, d } = await fresh({}, { knobs: HOME_AWAY });
    expect(m.stageConfig.legs).toBe(2);
    await play(m, d, [["Start", 0]]);
    // C(4,2) pairs, each judged once by I7 and once by the orientation check.
    expect(m.stepChecks.get(I7)).toBe(6);
    expect(m.stepChecks.get(ORIENTATION_CHECK)).toBe(6);
    expect(m.fixtures.size).toBe(12);
  });
  it("an unmirrored second leg meets `legs` times per pair — I7 passes it — and the orientation check fails, naming the duplicate AND the missing mirror", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ unmirroredLegs: true }, { knobs: HOME_AWAY });
    const e = await violation(play(m, d, [["Start", 0]]));
    expect(e.check).toBe(ORIENTATION_CHECK);
    // I7 judged the same step first and passed: each pair meets exactly 2 = legs times.
    expect(m.stepChecks.get(I7)).toBe(6);
    expect(e.evidence.length).toBe(6);
    for (const line of e.evidence) expect(line).toMatch(/^(\S+)→(\S+) meets 2× .* while \2→\1 meets 0×/);
  });
  it("the per-orientation bound is the engine's own: generateRoundRobin seats one orientation at most orientationBound(legs) times, and reaches it", () => {
    let combos = 0;
    for (let legs = 1; legs <= 4; legs++) {
      for (let n = 2; n <= 7; n++) {
        const count = new Map<string, number>();
        for (const f of generateRoundRobin({ entrants: Array.from({ length: n }, (_, i) => `e${i + 1}`), config: { legs } }).fixtures) {
          count.set(`${f.home}>${f.away}`, (count.get(`${f.home}>${f.away}`) ?? 0) + 1);
        }
        expect(Math.max(...count.values()), `legs ${legs}, ${n} entrants`).toBe(orientationBound(legs));
        combos++;
      }
    }
    expect(combos).toBe(24);
  });
});

describe("carry (d): a void fixture is not a meeting — its ad-hoc replay is not a duplicate pair", () => {
  it("an abandoned fixture plus its replay (stages.ts addFixture) passes; the replay joins the model with an empty ledger", async () => {
    // single-sport: pair counting is sport-blind.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0]]);
    const f = d.fixtures[0];
    if (f === undefined) throw new Error("test: no fixture");
    const [h, a] = seatsOf(f);
    await d.postStream(f.id, stream("generic", cfg, h, a, { kind: "abandon" }), "t");
    expect(f.status).toBe("abandoned");
    const replay = d.addFixture(h, a);
    const before = m.stepChecks.get(I7) ?? 0;
    await checkStep(m, d);
    expect((m.stepChecks.get(I7) ?? 0) - before).toBe(6);
    expect(m.fixtures.get(replay.id)?.ledger).toEqual([]);
    expect(m.fixtures.get(f.id)?.status).toBe("abandoned");
  });
  it("…while the same replay of a LIVE fixture is a duplicate pair: the exemption is for void fixtures only", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0]]);
    const f = d.fixtures[0];
    if (f === undefined) throw new Error("test: no fixture");
    d.addFixture(...seatsOf(f));
    expect((await violation(checkStep(m, d))).check).toBe(I7);
  });
  it("VOID_STATUSES is exactly the product's own void reading of a fixture status (lib/fixture-engine-status.ts)", () => {
    const all = [...PENDING_STATUSES, ...TERMINAL_STATUSES];
    for (const s of all) expect(VOID_STATUSES.includes(s), s).toBe(engineFixtureStatus(s) === "void");
    expect(all.length).toBe(7);
    expect(VOID_STATUSES.length).toBeGreaterThan(0);
  });
});

describe("model guards — assumptions are refusals, not comments", () => {
  it("a command run with no candidate throws by name, never a silent pick", async () => {
    // single-sport: nothing is posted.
    const { m, d } = await fresh();
    await expect(commandOf("Score", 0, 0, true).run(m, d)).rejects.toThrow(/no candidate/);
  });
  it("a driver that answers more events than were posted is a harness fault, not a ledger", async () => {
    // single-sport: the guard is on the driver's answer shape.
    class Overanswer extends ModelFakeDriver {
      override async postStream(id: string, events: Parameters<ModelFakeDriver["postStream"]>[1], prefix = ""): Promise<PostedEvent[]> {
        const out = await super.postStream(id, events, prefix);
        return [...out, ...out.slice(-1)];
      }
    }
    const d = new Overanswer();
    const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
    await play(m, d, [["Start", 0]]);
    await expect(commandOf("Score", 0, 0, true).run(m, d)).rejects.toThrow(/answered 3 events for 2 posted/);
  });
  it("an addEntrants that answers no entrant is a harness fault, not a silently unchanged roster", async () => {
    // single-sport: the guard is on the driver's answer shape.
    class Silent extends ModelFakeDriver {
      override async addEntrants(d: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]): Promise<Awaited<ReturnType<ModelFakeDriver["addEntrants"]>>> {
        return es.length === 1 ? [] : super.addEntrants(d, es);
      }
    }
    const d = new Silent();
    const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
    await expect(commandOf("AddEntrant", 0, 0, true).run(m, d)).rejects.toThrow(/answered no entrant/);
    expect(m.entrants.length).toBe(4);
  });
  it("fold parity: a known ledger the ENGINE refuses, which the product accepted, is a parity violation — not a crash, not a pass", async () => {
    // single-sport: the refusal is the kernel's payload validation.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).length === 2);
    const [s, r] = f?.ledger ?? [];
    if (f === undefined || s === undefined || r === undefined) throw new Error("test: nothing scored");
    f.ledger = [s, { ...r, type: "core.forfeit", payload: { by: 7 } }];
    const e = await violation(checkStep(m, d));
    expect(e.check).toBe("model-fold-parity");
    expect(e.evidence.join(" ")).toMatch(/engine fold of the ledger a refusal/);
  });
  it("…and an engine refusal is a parity violation even when the product has NO outcome yet: a refused fold is not 'no outcome'", async () => {
    // single-sport: the refusal is the kernel's payload validation. The case
    // exists because null === null: a fold that refused and a product still
    // in play both read as no outcome, so only the refusal itself can tell.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0]]);
    const row = d.fixtures[0];
    const f = row === undefined ? undefined : m.fixtures.get(row.id);
    if (row === undefined || f === undefined) throw new Error("test: no fixture");
    const [posted] = await d.postStream(row.id, [START], "t");
    if (posted === undefined) throw new Error("test: START not posted");
    f.ledger = [{ id: posted.event_id, seq: posted.seq, type: "core.forfeit", payload: { by: 7 } }];
    expect(row.status).toBe("in_play");
    expect(toObservedOutcome(row.outcome)).toBeNull();
    const e = await violation(checkStep(m, d));
    expect(e.check).toBe("model-fold-parity");
    expect(e.evidence.join(" ")).toMatch(/product null, engine fold of the ledger a refusal/);
  });
  it("a second writer: a void the model did not post makes that ledger unknown (the tip moved), never a false parity violation", async () => {
    // single-sport: void resolution is the kernel's.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).length === 2);
    const result = f?.ledger?.[1];
    if (f === undefined || result === undefined) throw new Error("test: nothing scored");
    await d.postStream(f.id, [{ type: "core.void", payload: { event_id: result.id } }], "someone-else");
    const before = m.foldParity;
    await checkStep(m, d);
    expect(f.ledger).toBeNull();
    expect(m.foldParity).toBe(before);
  });
  it("a withdrawal refused part-way still leaves that entrant's ledgers unknown: the cascade may have written", async () => {
    // single-sport: the cascade's composition is core events only.
    class HalfWithdraw extends ModelFakeDriver {
      override async withdraw(entrantId: string): ReturnType<ModelFakeDriver["withdraw"]> {
        await super.withdraw(entrantId);
        throw new RefusedCall("POST", `/api/v1/entrants/${entrantId}/withdraw`, 409, "SEQ_CONFLICT", "raced");
      }
    }
    const d = new HalfWithdraw();
    const m = await newModelState({ driver: d, row: "league", sport: "generic", variant: "score", entrants: 4, tag: "t" });
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Withdraw", 0]]);
    expect(m.counts.Withdraw).toEqual({ ran: 1, accepted: 0, refused: 1 });
    const mine = [...m.fixtures.values()].filter((f) => f.home === m.entrants[0] || f.away === m.entrants[0]);
    expect(mine.length).toBe(3);
    for (const f of mine) expect(f.ledger, f.id).toBeNull();
  });
  it("absorbFixtures: a new scheduled fixture starts with a known empty ledger; one first seen already under way is unknown; one gone from the list is dropped", async () => {
    // single-sport: no event is folded.
    const { m } = await fresh();
    const row = (id: string, status: string): FixtureRow => ({ id, stage_id: m.stageId, pool_id: null, round_no: 1, fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2", status, outcome: null });
    absorbFixtures(m, [row("n1", "scheduled"), row("n2", "in_play"), row("n3", "decided")]);
    expect([...m.fixtures.values()].map((f) => [f.id, f.ledger])).toEqual([["n1", []], ["n2", null], ["n3", null]]);
    absorbFixtures(m, [row("n2", "decided")]);
    expect([...m.fixtures.keys()]).toEqual(["n2"]);
  });
  it("newModelState refuses a multi-stage row by name", async () => {
    await expect(newModelState({ driver: new ModelFakeDriver(), row: "league_ko", sport: "generic", variant: "score", entrants: 4, tag: "t" })).rejects.toThrow(/multi-stage/);
  });
  it("FakeLeagueDriver.rebuild refuses by name (the table fake models no rebuild)", async () => {
    await expect(new FakeLeagueDriver().rebuild("s1")).rejects.toMatchObject({ status: 422, code: "UNSUPPORTED_IN_FAKE" });
  });
});
