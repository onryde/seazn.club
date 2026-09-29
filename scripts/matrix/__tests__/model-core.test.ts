// The fast-check model core (W1b Task 13): the void-aware ledger fold, the ten
// organiser commands, the step check run after every command, and the #879
// fence. Driven DB-free through ModelFakeDriver, whose outcomes come from the
// engine's own fold, whose schedule is the engine's own round robin, and whose
// roster lock is read from the product's own text (entrants.ts).
//
// State transitions under test (TEST-STRATEGY rule 1): the pre-Start path
// (roster growth before and after fixtures exist, a pre-Start Generate and
// Rebuild); not started → started (Start); the roster lock after Start
// (AddEntrant, an EXPECTED refusal); a withdrawal (Withdraw, its cascade riding
// the ledger); a result, a walkover, a void and a correction on one fixture; a
// second Generate; a Rebuild after results; a Complete. Empty cases: an empty
// ledger, a model with nothing to judge, a command with no candidate, a cell
// with no informative step.
import { BRACKET_STAGE_KINDS } from "@seazn/engine/competition";
import { EngineError } from "@seazn/engine/core";
import { generateDoubleElim, generatePagePlayoff, generateRoundRobin, generateSingleElim, generateStepladder, type GeneratedBracket } from "@seazn/engine/scheduling";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { engineFixtureStatus } from "../../../apps/web/src/lib/fixture-engine-status.ts";
import { BUILDER_DEFAULT_KNOBS, SPORT_KEYS } from "../lib/catalogue.ts";
import { RefusedCall, RequestTimedOut, type FixtureRow, type GenerateOut, type PostedEvent, type StartOut, type WithdrawOut } from "../lib/driver/types.ts";
import { foldStream } from "../lib/fold.ts";
import { COMMAND_KINDS, ModelViolation, checkStep, commandOf, modelCommands, newModelState, type CommandKind, type ModelState } from "../lib/model/commands.ts";
import { FENCES, fenceBlocking } from "../lib/model/fences.ts";
import { regressionFor, vacuityOf } from "../lib/model/run-cell.ts";
import { foldLedger, liveEntries, type LedgerEntry } from "../lib/model/ledger-fold.ts";
import {
  NEXT_MATCH_CHECK, NEXT_MATCH_LOCK, ORIENTATION_CHECK, ORIENTATION_STAGE_KINDS, REFUSAL_NAMED, ROSTER_LOCK, ROSTER_LOCK_CHECK, ROSTER_LOCK_FINDING, UNEXPECTED_REFUSAL, VACUITY_CHECK, VOID_STATUSES,
  absorbFixtures, fedCandidates, fedMatchStarted, informativeSteps, orientationBound, type FixtureModel,
} from "../lib/model/state.ts";
import { PENDING_STATUSES, TERMINAL_STATUSES, isNamedRefusal, sameOutcome, toObservedOutcome } from "../lib/observed.ts";
import { entrantKindFor, resolveSportCfg, sportModule, variantKeys } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { START, type RequestedOutcome } from "../lib/streams/types.ts";
import { FakeLeagueDriver, FakeSwissDriver } from "./fake-driver.ts";
import { ModelFakeDriver, type ModelFakeOpts } from "./model-fake-driver.ts";
import { bracketRoundNoText, nextMatchStartedText, rosterLockText, roundRobinKindsText, withdrawalPendingText, withdrawalReason } from "./product-text.ts";

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
/** C(n,2): one leg of a round robin over n entrants — the engine's pairing count, never read from the fake. */
const pairs = (n: number) => (n * (n - 1)) / 2;
const counts = (ran: number, o: Partial<{ accepted: number; refused: number; expected: number; unexpected: number }>) =>
  ({ ran, accepted: 0, refused: 0, expected: 0, unexpected: 0, ...o });

type Setup = { sport?: string; variant?: string; entrants?: number; knobs?: typeof HOME_AWAY };
async function fresh(opts: ModelFakeOpts = {}, over: Setup = {}, driver?: ModelFakeDriver): Promise<{ m: ModelState; d: ModelFakeDriver }> {
  const d = driver ?? new ModelFakeDriver(opts);
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
const lock = rosterLockText();
const REASON_TEXT = withdrawalReason();

/** Every command kind, fences off, each runnable where it stands: the pre-Start
 *  path (growth before fixtures exist, a pre-Start Generate and Rebuild), Start,
 *  the roster lock, play, a correction, a void, a second Generate, a refused
 *  Rebuild, then Withdraw of the entrant with the fewest results (under half
 *  played: the expunge, which posts no forfeit — the walkover leg is the F1
 *  case below) and Complete. */
async function everyKind(m: ModelState, d: ModelFakeDriver): Promise<void> {
  await play(m, d, [
    ["AddEntrant", 0], ["Generate", 0], ["Rebuild", 0], ["Start", 0], ["AddEntrant", 0],
    ["Score", 0, 0], ["Score", 0, 1], ["Correct", 0], ["Walkover", 0, 1], ["Void", 0], ["Generate", 0], ["Rebuild", 0],
  ], false);
  const mine = (e: string) => [...m.fixtures.values()].filter((f) => f.home === e || f.away === e);
  const played = (e: string) => mine(e).filter((f) => f.status === "decided" || f.status === "forfeited").length;
  const least = [...m.entrants].sort((a, b) => played(a) - played(b))[0];
  // lib/table-withdrawal + withdrawTableEntrant: under half played expunges.
  if (least === undefined || played(least) * 2 >= mine(least).length) throw new Error("test: no entrant under half played");
  await play(m, d, [["Withdraw", m.entrants.indexOf(least)], ["Complete", 0]], false);
}

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
  it("empty case first: before Start and before any fixture, only Start, AddEntrant and Generate are runnable", async () => {
    const { m } = await fresh();
    const runnable = COMMAND_KINDS.filter((k) => commandOf(k, 0, 0, true).check(m));
    expect(runnable).toEqual(["Start", "AddEntrant", "Generate"]);
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
    expect(m.generates).toEqual([{ status: 200, code: null, total: pairs(4), created: 0 }, { status: 200, code: null, total: pairs(4), created: 0 }]);
    expect(m.fixtures.size).toBe(pairs(4));
    // I8 judges every Generate at every step: 1 after the first, 2 after the second.
    expect(m.stepChecks.get(I8)).toBe(3);
  });
  it("a pre-Start Generate seats the field over the API; Start then seats nothing new (startDivision generates only an empty first stage)", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["Generate", 0]]);
    expect(m.started).toBe(false);
    expect(m.generates).toEqual([{ status: 200, code: null, total: pairs(4), created: pairs(4) }]);
    const before = [...m.fixtures.keys()];
    await play(m, d, [["Start", 0]]);
    expect([...m.fixtures.keys()]).toEqual(before);
  });
  it("roster growth BEFORE any fixture exists is not a late entry: Generate stays offered with fences on, and Start seats the grown field", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["AddEntrant", 0], ["Start", 0], ["Generate", 0]]);
    expect(m.lateEntry).toBe(false);
    expect(m.entrants.length).toBe(5);
    expect(m.fixtures.size).toBe(pairs(5));
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
    expect(m.counts.Complete).toEqual(counts(2, { accepted: 2 }));
  });
  it("Rebuild on an unplayed stage replaces every fixture (twice); after a result — even one since voided — it is refused by name", async () => {
    // single-sport: rebuild's guard reads the ledger, not a sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0]]);
    const first = [...m.fixtures.keys()];
    await play(m, d, [["Rebuild", 0], ["Rebuild", 0]]);
    const now = [...m.fixtures.keys()];
    expect(now.length).toBe(pairs(4));
    expect(now.filter((id) => first.includes(id))).toEqual([]);
    expect([...m.fixtures.values()].every((f) => f.ledger !== null && f.ledger.length === 0)).toBe(true);
    expect(m.counts.Rebuild).toEqual(counts(2, { accepted: 2 }));
    // stages.ts rebuildStageFixtures blocks on any score event (fixtureHasResultSql), not only on an outcome.
    await play(m, d, [["Score", 0, 0], ["Void", 0], ["Void", 0], ["Rebuild", 0]]);
    expect([...m.fixtures.values()].some((f) => f.status !== "scheduled")).toBe(false);
    expect(m.counts.Rebuild).toEqual(counts(3, { accepted: 2, refused: 1 }));
  });
});

describe("the roster lock after Start (entrants.ts) — an EXPECTED refusal, never a stop", () => {
  it("ROSTER_LOCK is the product's own: the statuses, the open-window kinds and the status are read from entrants.ts", () => {
    expect(lock.statuses).toEqual(["active", "completed"]);
    expect([...ROSTER_LOCK.openKinds]).toEqual(lock.openKinds);
    expect(ROSTER_LOCK.status).toBe(lock.status);
    expect(lock.openKinds.length).toBeGreaterThan(0);
    // RR-2 tripwire: without it, a product fix silently moves the finding count to 0 and the register never hears.
    expect(lock.code, "entrants.ts now names the roster lock: CD-T13b is closed — switch this expectation to the code and close CD-T13b in the register").toBeNull();
  });
  it("after Start, AddEntrant is refused as expected: the roster is unchanged, the cell goes on, and a code-less refusal is recorded as finding CD-T13b", async () => {
    // single-sport: the lock reads the division and stage kinds, not a sport.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["AddEntrant", 0], ["AddEntrant", 1], ["Score", 0, 0]]);
    expect(m.counts.AddEntrant).toEqual(counts(2, { expected: 2 }));
    expect(m.entrants.length).toBe(4);
    expect((await d.listEntrants()).length).toBe(4);
    expect(m.lateEntry).toBe(false);
    expect(m.counts.Score.accepted).toBe(1);
    // The finding exists exactly while the product's refusal carries no domain code (read from the text, so a fix moves it).
    const unnamed = !isNamedRefusal(lock.status, lock.wireCode);
    expect(m.findings.get(ROSTER_LOCK_FINDING)?.count ?? 0).toBe(unnamed ? 2 : 0);
    if (unnamed) expect(m.findings.get(ROSTER_LOCK_FINDING)?.evidence[0]).toContain(`${lock.status} ${lock.wireCode}`);
    expect(m.steps.map((s) => s.verdict)).toEqual(["accepted", "expected-refusal", "expected-refusal", "accepted"]);
  });
  it("a product that NAMES the lock records no finding, and the refusal is still expected", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ rosterLock: "named" });
    await play(m, d, [["Start", 0], ["AddEntrant", 0]]);
    expect(m.counts.AddEntrant).toEqual(counts(1, { expected: 1 }));
    expect(m.findings.size).toBe(0);
  });
  it("only the lock's own status is the known finding: a code-less 5xx where the lock was expected is still model-refusal-named", async () => {
    // single-sport: as above.
    class Crashing extends ModelFakeDriver {
      override addEntrants(dv: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]): ReturnType<ModelFakeDriver["addEntrants"]> {
        return super.addEntrants(dv, es).catch(() => { throw new RefusedCall("POST", `/api/v1/divisions/${dv}/entrants`, 500, "INTERNAL", "boom"); });
      }
    }
    const { m, d } = await fresh({}, {}, new Crashing());
    await play(m, d, [["Start", 0]]);
    expect((await violation(play(m, d, [["AddEntrant", 0]]))).check).toBe("model-refusal-named");
    expect(m.findings.size).toBe(0);
  });
  it("a product that ACCEPTS a latecomer after Start on a closed format → model-roster-lock", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ rosterLock: "open" });
    await play(m, d, [["Start", 0]]);
    const e = await violation(play(m, d, [["AddEntrant", 0]]));
    expect(e.check).toBe(ROSTER_LOCK_CHECK);
  });
  it("a refusal that nonetheless changed the roster → model-roster-lock", async () => {
    // single-sport: as above.
    class Leaky extends ModelFakeDriver {
      override addEntrants(dv: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]): ReturnType<ModelFakeDriver["addEntrants"]> {
        return super.addEntrants(dv, es).catch((e: unknown) => {
          this.entrants = [...this.entrants, { id: "e99", display_name: "Leaked Player", seed: 99, status: "registered" }];
          throw e;
        });
      }
    }
    const { m, d } = await fresh({}, {}, new Leaky());
    await play(m, d, [["Start", 0]]);
    const e = await violation(play(m, d, [["AddEntrant", 0]]));
    expect(e.check).toBe(ROSTER_LOCK_CHECK);
  });
  it("an open-window stage keeps a started roster open (entrants.ts openFormat): AddEntrant is expected to be ACCEPTED there", async () => {
    // single-sport: as above.
    let checked = 0;
    for (const kind of lock.openKinds) {
      const { m, d } = await fresh();
      await play(m, d, [["Start", 0]]);
      if (d.stage === null) throw new Error("test: no stage");
      // The fake reads its stage kind for the lock, as the product reads stages.kind.
      d.stage.kind = kind;
      const open: ModelState = { ...m, stageKind: kind };
      await commandOf("AddEntrant", 0, 0, true).run(open, d);
      expect(open.counts.AddEntrant, kind).toEqual(counts(1, { accepted: 1 }));
      expect(open.entrants.length, kind).toBe(5);
      checked++;
    }
    expect(checked).toBe(lock.openKinds.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("#879 — roster growth while fixtures exist, BEFORE Start (issue #879; ruling C-1 supersedes R-PF8)", () => {
  it("the real sequence: Generate, AddEntrant, Generate → the second Generate duplicates pairs → I7 at that step (fences OFF)", async () => {
    // single-sport: #879 is a pairing defect, sport-blind.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Generate", 0], ["AddEntrant", 0]], false);
    expect(m.started).toBe(false);
    expect(m.lateEntry).toBe(true);
    const e = await violation(play(m, d, [["Generate", 0]], false));
    expect(e.check).toBe(I7);
  });
  it("#879 needs fixtures to exist when the entrant arrives: AddEntrant first, then Generate twice, duplicates nothing (fault879 on)", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["AddEntrant", 0], ["Generate", 0], ["Generate", 0], ["Start", 0], ["Generate", 0]], false);
    expect(m.lateEntry).toBe(false);
    expect(m.fixtures.size).toBe(pairs(5));
    expect(m.stepChecks.get(I7) ?? 0).toBeGreaterThan(0);
  });
  it("the fake's fault fires once, as the product's positional reconcile does: the duplicating Generate inserts, and the next — every key now present — inserts nothing", async () => {
    // single-sport: as above. Driven on the fake directly: the model stops at the first I7.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Generate", 0], ["AddEntrant", 0]]);
    expect((await d.generate()).created).toBeGreaterThan(0);
    expect((await d.generate()).created).toBe(0);
  });
  it("with fences ON, Generate is withheld after a late entry — through Start — and the fence is counted", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Generate", 0], ["AddEntrant", 0]]);
    expect(commandOf("Generate", 0, 0, true).check(m)).toBe(false);
    await play(m, d, [["Start", 0]]);
    expect(commandOf("Generate", 0, 0, true).check(m)).toBe(false);
    expect(m.fenced.get("late-entry-then-generate")).toBe(2);
    expect(fenceBlocking(m, "Generate", true)?.issue).toBe("#879");
    expect(fenceBlocking(m, "Generate", false)).toBeNull();
  });
  it("the late entry clears on the event that resolves it: an accepted Rebuild re-seats the grown field, and Generate is offered again and duplicates nothing", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ fault879: true });
    await play(m, d, [["Generate", 0], ["AddEntrant", 0], ["Rebuild", 0]]);
    expect(m.lateEntry).toBe(false);
    expect(m.fixtures.size).toBe(pairs(5));
    await play(m, d, [["Generate", 0]]);
    expect(m.fixtures.size).toBe(pairs(5));
  });
  it("…and so does an accepted Generate on a product without #879 (fences off): it adds exactly the missing pairs", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["Generate", 0], ["AddEntrant", 0], ["Generate", 0]], false);
    expect(m.lateEntry).toBe(false);
    expect(m.generates.at(-1)).toEqual({ status: 200, code: null, total: pairs(5), created: pairs(5) - pairs(4) });
  });
  it("a refused Rebuild resolves nothing: the late entry stands", async () => {
    // single-sport: as above.
    class NoRebuild extends ModelFakeDriver {
      override rebuild(): Promise<void> { return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/rebuild", 422, "SCHEDULE_LOCKED", "locked")); }
    }
    const { m, d } = await fresh({}, {}, new NoRebuild());
    await play(m, d, [["Generate", 0], ["AddEntrant", 0], ["Rebuild", 0]]);
    expect(m.counts.Rebuild).toEqual(counts(1, { refused: 1 }));
    expect(m.lateEntry).toBe(true);
  });
  it("the #879 fence is for the product's round-robin kinds only (schedule.ts roundRobinStageIds): a late entry on a swiss stage leaves Generate offered (a knockout's is MB-005's fence, below)", async () => {
    // single-sport: the fence reads stage kinds.
    const { m, d } = await fresh();
    await play(m, d, [["Generate", 0], ["AddEntrant", 0]]);
    const rr = roundRobinKindsText();
    let checked = 0;
    for (const stageKind of [...rr, "knockout", "swiss"]) {
      const s: ModelState = { ...m, stageKind };
      expect(fenceBlocking(s, "Generate", true)?.id === "late-entry-then-generate", stageKind).toBe(rr.includes(stageKind));
      checked++;
    }
    expect(checked).toBe(rr.length + 2);
    expect(rr.length).toBeGreaterThan(0);
    expect(fenceBlocking({ ...m, stageKind: "swiss" }, "Generate", true)).toBeNull();
  });
});

describe("final batch F-1(b): the knockout fences steer the walk off MB-002..005's triggers, and nothing else", () => {
  const KO_TBD = "ko-withdraw-waiting-on-tbd";
  const KO_GEN = "ko-generate-after-roster-change";
  /** A started knockout, as the product lists it: e1 beat e4 and waits in the
   *  final for the winner of e2 v e3 (a TBD seat). */
  async function ko(finalStatus = "scheduled", side: "home" | "away" = "home"): Promise<ModelState> {
    // single-sport: the fences read stage kind, seats and statuses, never the sport.
    const { m } = await fresh();
    const fx = (id: string, round: number, home: string | null, away: string | null, status: string): [string, FixtureModel] => [id, { id, round, home, away, status, ledger: null }];
    const [e1, e2, e3, e4] = m.entrants;
    if (e1 === undefined || e2 === undefined || e3 === undefined || e4 === undefined) throw new Error("test: four entrants");
    const final = side === "home" ? fx("f3", 2, e1, null, finalStatus) : fx("f3", 2, null, e1, finalStatus);
    return { ...m, stageKind: "knockout", started: true, fixtures: new Map([fx("f1", 1, e1, e4, "decided"), fx("f2", 1, e2, e3, "scheduled"), final]) };
  }
  it("the premise: the pending statuses the Withdraw fence reads are the product's (lib/table-withdrawal.ts)", () => {
    expect([...PENDING_STATUSES].sort()).toEqual(withdrawalPendingText().sort());
  });
  it("the premise: both fences exist, and each is a committed OPEN case's fence (scenario-catalogue.test.ts pins the other direction)", () => {
    expect(FENCES.map((f) => f.id)).toEqual(expect.arrayContaining([KO_TBD, KO_GEN]));
    expect(FENCES.find((f) => f.id === KO_TBD)?.blocks).toBe("Withdraw");
    expect(FENCES.find((f) => f.id === KO_GEN)?.blocks).toBe("Generate");
  });
  it("MB-002/003: Withdraw is withheld only for the entrant it would withdraw that waits on a TBD seat — either side, every pending status; the fence is counted", async () => {
    let checked = 0;
    for (const side of ["home", "away"] as const) {
      for (const status of PENDING_STATUSES) {
        const s = await ko(status, side);
        expect(commandOf("Withdraw", 0, 0, true).check(s), `${side} ${status}`).toBe(false);
        expect(s.fenced.get(KO_TBD), `${side} ${status}`).toBe(1);
        expect(fenceBlocking(s, "Withdraw", true, s.entrants[0] ?? null)?.id).toBe(KO_TBD);
        checked++;
      }
    }
    expect(checked).toBe(2 * PENDING_STATUSES.length);
    expect(PENDING_STATUSES.length).toBeGreaterThan(0);
  });
  it("MB-002/003: …and offered for everyone else — a seated pending match (e2), a decided one only (e4), a TBD final no longer pending, fences off, and any stage kind but knockout", async () => {
    const s = await ko();
    expect(commandOf("Withdraw", 1, 0, true).check(s), "e2: seated opponent").toBe(true);
    expect(commandOf("Withdraw", 3, 0, true).check(s), "e4: out, decided only").toBe(true);
    expect(commandOf("Withdraw", 0, 0, false).check(s), "fences off").toBe(true);
    expect(fenceBlocking(s, "Withdraw", true, null), "no subject").toBeNull();
    let checked = 0;
    for (const status of TERMINAL_STATUSES) {
      expect(commandOf("Withdraw", 0, 0, true).check(await ko(status)), status).toBe(true);
      checked++;
    }
    for (const stageKind of [...[...BRACKET_STAGE_KINDS].filter((k) => k !== "knockout"), "league", "swiss"]) {
      expect(commandOf("Withdraw", 0, 0, true).check({ ...s, stageKind }), stageKind).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(TERMINAL_STATUSES.length + 2);
    expect(s.fenced.get(KO_TBD) ?? 0).toBe(0);
  });
  it("MB-004/005: Generate is withheld on a knockout with fixtures once the roster changed — an entrant added (MB-005) or one withdrawn (MB-004)", async () => {
    const s = await ko();
    expect(commandOf("Generate", 0, 0, true).check(s), "no roster change").toBe(true);
    const added: ModelState = { ...s, lateEntry: true, fenced: new Map() };
    expect(commandOf("Generate", 0, 0, true).check(added)).toBe(false);
    expect(added.fenced.get(KO_GEN)).toBe(1);
    const e2 = s.entrants[1];
    if (e2 === undefined) throw new Error("test: four entrants");
    const withdrawn: ModelState = { ...s, withdrawn: new Set([e2]), fenced: new Map() };
    expect(commandOf("Generate", 0, 0, true).check(withdrawn)).toBe(false);
    expect(withdrawn.fenced.get(KO_GEN)).toBe(1);
    expect(fenceBlocking(withdrawn, "Generate", false)).toBeNull();
  });
  it("MB-004/005: …and offered with no fixtures yet, and on every other stage kind but the round robins (#879's own fence)", async () => {
    const s: ModelState = { ...(await ko()), lateEntry: true };
    expect(commandOf("Generate", 0, 0, true).check({ ...s, fixtures: new Map(), fenced: new Map() }), "no fixtures").toBe(true);
    const rr = roundRobinKindsText();
    let checked = 0;
    for (const stageKind of [...[...BRACKET_STAGE_KINDS].filter((k) => k !== "knockout"), "swiss", ...rr]) {
      expect(fenceBlocking({ ...s, stageKind }, "Generate", true)?.id ?? null, stageKind).toBe(rr.includes(stageKind) ? "late-entry-then-generate" : null);
      checked++;
    }
    expect(checked).toBeGreaterThan(rr.length);
  });
});

describe("model commands — a correct product passes every step", () => {
  it("each command kind runs once, every step is checked, fold parity compares > 0 fixtures", async () => {
    // single-sport: the registry sweep below runs the same sequence on every modelled sport.
    const { m, d } = await fresh();
    await everyKind(m, d);
    for (const k of COMMAND_KINDS) expect(m.counts[k].ran, k).toBeGreaterThan(0);
    expect(m.counts.Score.accepted).toBe(2);
    expect(m.counts.AddEntrant).toEqual(counts(2, { accepted: 1, expected: 1 }));
    expect(m.counts.Rebuild).toEqual(counts(2, { accepted: 1, refused: 1 })); // results exist → STAGE_HAS_RESULTS, named
    expect(m.counts.Withdraw).toEqual(counts(1, { accepted: 1 }));
    expect(m.foldParity).toBeGreaterThan(0);
    expect(m.stepChecks.get(I8) ?? 0).toBeGreaterThan(0);
    expect(m.stepChecks.get(I7) ?? 0).toBeGreaterThan(0);
    expect(m.stepChecks.get(ORIENTATION_CHECK) ?? 0).toBeGreaterThan(0);
    expect(m.history.length).toBe(m.steps.length);
    expect(informativeSteps(m)).toMatchObject({ id: VACUITY_CHECK, verdict: "pass" });
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
      await everyKind(m, d);
      for (const k of COMMAND_KINDS) expect(m.counts[k].ran, `${sport} ${k}`).toBeGreaterThan(0);
      expect(m.counts.Score.accepted, sport).toBe(2);
      expect(m.counts.Withdraw.accepted, sport).toBe(1);
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
    expect(m.counts.Score).toEqual(counts(2, { accepted: 2 }));
    const scored = [...m.fixtures.values()].filter((f) => (f.ledger ?? []).some((e) => e.type === "generic.result"));
    expect(scored.length).toBe(2);
  });
});

describe("model commands — each fault is caught at the step that causes it", () => {
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
  it("a Generate refused BY NAME is recorded for I8 and judged there, and the cell goes on — an ordinary refusal", async () => {
    // single-sport: as above.
    class NotReady extends ModelFakeDriver {
      override generate(): Promise<GenerateOut> { return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 422, "STAGE_NOT_READY", "not ready")); }
    }
    const { m, d } = await fresh({}, {}, new NotReady());
    await play(m, d, [["Start", 0], ["Generate", 0]]);
    expect(m.generates).toEqual([{ status: 422, code: "STAGE_NOT_READY", total: 0, created: 0 }]);
    expect(m.counts.Generate).toEqual(counts(1, { refused: 1 }));
    // I8 judged one record on the Generate step (none on Start's).
    expect(m.stepChecks.get(I8)).toBe(1);
  });
  it("checkStep on a model with nothing to judge reports zero, never a pass (R25)", async () => {
    // single-sport: nothing is posted, so no sport is exercised.
    const { m, d } = await fresh();
    await checkStep(m, d);
    expect(m.foldParity).toBe(0);
    expect(m.stepChecks.size).toBeGreaterThan(0);
    expect([...m.stepChecks.values()].every((n) => n === 0)).toBe(true);
  });
  it("FENCES is non-empty; each names its GitHub issue, or null when none is filed (its witness is then the open committed case naming it: scenario-catalogue.test.ts)", () => {
    expect(FENCES.length).toBeGreaterThan(0);
    for (const f of FENCES) if (f.issue !== null) expect(f.issue, f.id).toMatch(/^#\d+$/);
    expect(FENCES.filter((f) => f.issue !== null).length, "#879's fence keeps its issue").toBeGreaterThan(0);
  });
});

// W1b Task 15, fix round 1 (a): live, both swiss cells died at their first
// step — Start mints the swiss stage's rounds as UNPAIRED shells (stages.ts),
// so I6 had no two-sided fixture to judge and R25 turned its pass into a
// failure. A step invariant with nothing to judge yet abstains for that step;
// the per-cell R25 (vacuityOf) still fails a cell where it abstained every time.
describe("swiss: a step invariant with nothing to judge yet abstains for that step (T15 fix round 1)", () => {
  // single-sport: nothing is posted here — shells and pairings are sport-blind.
  const I6 = "I6-swiss-no-rematch";
  const swiss = async (d: FakeSwissDriver) => ({ m: await newModelState({ driver: d, row: "swiss", sport: "generic", variant: "score", entrants: 4, tag: "t" }), d });
  const step = async (m: ModelState, d: FakeSwissDriver, kind: CommandKind): Promise<void> => {
    const c = commandOf(kind, 0, 0, true);
    expect(c.check(m), `${kind} should be runnable`).toBe(true);
    await c.run(m, d);
  };
  const vacuity = (m: ModelState) => vacuityOf({ counts: m.counts, stepChecks: Object.fromEntries(m.stepChecks), foldParity: m.foldParity, informative: informativeSteps(m).checked, stageKind: m.stageKind });
  const i6Line = `step invariant ${I6} checked zero items`;
  /** 4 entrants → 2 boards a round, no bye (stages.ts: floor(n/2) boards, a bye shell when n is odd). */
  const BOARDS = 2;

  it("empty case first: Start mints unpaired shells — I6 has nothing to judge, so the step abstains with 0 items, never fails", async () => {
    const { m, d } = await swiss(new FakeSwissDriver());
    await step(m, d, "Start");
    const shells = [...m.fixtures.values()];
    expect(shells.length).toBe(Number(m.stageConfig.rounds) * BOARDS);
    expect(shells.every((f) => f.home === null && f.away === null)).toBe(true);
    expect(m.stepChecks.get(I6)).toBe(0);
    expect(m.steps).toEqual([{ cmd: "Start(0,0)", verdict: "accepted" }]);
  });

  it("the next step judges: Generate pairs round 1 and I6 checks its boards; a second Generate (round 1 undecided, refused by name) judges them again", async () => {
    const { m, d } = await swiss(new FakeSwissDriver());
    await step(m, d, "Start");
    await step(m, d, "Generate");
    expect(m.stepChecks.get(I6)).toBe(BOARDS);
    await step(m, d, "Generate");
    expect(m.generates.at(-1)).toMatchObject({ status: 422, code: "STAGE_NOT_READY" });
    expect(m.stepChecks.get(I6)).toBe(2 * BOARDS);
  });

  it("a real rematch still FAILS I6 with items judged — the abstain covers nothing-to-judge only", async () => {
    /** Pairs round 2 as round 1 again, and pairs whether or not round 1 is decided. */
    class Rematching extends FakeSwissDriver {
      override start(): Promise<StartOut> { return super.start().then((o) => { this.schedule[1] = this.schedule[0]!; return o; }); }
      override generate(): Promise<GenerateOut> { this.pairNext(); return Promise.resolve({ created: 0, existing: this.fixtures.length, fixtures: this.rows() }); }
    }
    const { m, d } = await swiss(new Rematching());
    await step(m, d, "Start");
    await step(m, d, "Generate");
    const e = await violation(step(m, d, "Generate"));
    expect(e.check).toBe(I6);
    expect(e.evidence.join(" ")).toMatch(/rematched in rounds 1 and 2/);
    expect(m.stepChecks.get(I6)).toBe(BOARDS + 2 * BOARDS);
  });

  it("per-cell R25 still catches a swiss cell where I6 abstained on every step — and clears once a step judged", async () => {
    const { m, d } = await swiss(new FakeSwissDriver());
    await step(m, d, "Start");
    expect(vacuity(m)).toContain(i6Line);
    await step(m, d, "Generate");
    expect(vacuity(m)).not.toContain(i6Line);
  });
});

describe("I-1: a refusal of a command the model holds legal is an unexpected-refusal step failure, not an ordinary refusal", () => {
  class Refusing extends ModelFakeDriver {
    armed: "postStream" | "withdraw" | null = null;
    override postStream(id: string, events: Parameters<ModelFakeDriver["postStream"]>[1], prefix = ""): Promise<PostedEvent[]> {
      if (this.armed !== "postStream") return super.postStream(id, events, prefix);
      this.armed = null;
      return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 422, "INVALID_EVENT", "refused"));
    }
    override withdraw(id: string): Promise<WithdrawOut> {
      if (this.armed !== "withdraw") return super.withdraw(id);
      this.armed = null;
      return Promise.reject(new RefusedCall("POST", `/api/v1/entrants/${id}/withdraw`, 422, "WRONG_PHASE", "refused"));
    }
  }
  it("Score, Walkover, Void, Correct and the first Withdraw: each refused by name → model-unexpected-refusal, counted", async () => {
    // single-sport: the rule reads the model's own legality, not a sport.
    const CASES: { kind: CommandKind; setup: [CommandKind, number, number?][]; arm: "postStream" | "withdraw" }[] = [
      { kind: "Score", setup: [["Start", 0]], arm: "postStream" },
      { kind: "Walkover", setup: [["Start", 0]], arm: "postStream" },
      { kind: "Void", setup: [["Start", 0], ["Score", 0, 0]], arm: "postStream" },
      { kind: "Correct", setup: [["Start", 0], ["Score", 0, 0]], arm: "postStream" },
      { kind: "Withdraw", setup: [["Start", 0]], arm: "withdraw" },
    ];
    let checked = 0;
    for (const c of CASES) {
      const d = new Refusing();
      const { m } = await fresh({}, {}, d);
      await play(m, d, c.setup);
      d.armed = c.arm;
      const e = await violation(play(m, d, [[c.kind, 0]]));
      expect(e.check, c.kind).toBe(UNEXPECTED_REFUSAL);
      expect(m.counts[c.kind], c.kind).toEqual(counts(1, { unexpected: 1 }));
      checked++;
    }
    expect(checked).toBe(5);
  });
  it("…while the same named refusal of Rebuild or Generate — commands the product may refuse — stays an ordinary refusal", async () => {
    // single-sport: as above.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["Rebuild", 0]]);
    expect(m.counts.Rebuild).toEqual(counts(1, { refused: 1 }));
    expect(m.steps.at(-1)?.verdict).toBe("refused");
  });
});

describe("RR-1: a knockout take-back whose next match has started is refused BY NAME (fed-seats.ts) — an expected refusal, never an unexpected one", () => {
  const next = nextMatchStartedText();
  /** A bracket on the fake: its fixtures seated before Start (Start then
   *  seats nothing — schedule.ts startDivision), its winner edges fed; the
   *  fake's stage reads as `kind`, as the product reads stages.kind. */
  async function bracket(kind: string, entrants: number, build: (d: ModelFakeDriver, e: string[]) => void, opts: ModelFakeOpts = {}, driver?: ModelFakeDriver): Promise<{ m: ModelState; d: ModelFakeDriver }> {
    const { m: base, d } = await fresh(opts, { entrants }, driver);
    if (d.stage === null) throw new Error("test: no stage");
    d.stage.kind = kind;
    const m: ModelState = { ...base, stageKind: kind };
    build(d, m.entrants);
    await play(m, d, [["Start", 0]]);
    return { m, d };
  }
  /** Two semis feeding a final: sf1 → the final's home seat, sf2 → its away seat. */
  const semis = (d: ModelFakeDriver, [e1, e2, e3, e4]: string[]) => {
    const sf1 = d.seat(1, e1, e4);
    const sf2 = d.seat(1, e2, e3);
    const fin = d.seat(2, null, null);
    d.feed(sf1.id, fin.id, 1);
    d.feed(sf2.id, fin.id, 2);
  };
  const byOrder = (m: ModelState) => {
    const [sf1, sf2, fin] = [...m.fixtures.values()];
    if (sf1 === undefined || sf2 === undefined || fin === undefined) throw new Error("test: the bracket has three fixtures");
    return { sf1, sf2, fin };
  };

  it("NEXT_MATCH_LOCK is the product's own: status and code from fed-seats.ts (its code through its import), the not-started status from hasStarted, judged on every append, on the engine's bracket kinds", () => {
    expect(NEXT_MATCH_LOCK.status).toBe(next.status);
    expect(NEXT_MATCH_LOCK.code).toBe(next.code);
    expect(NEXT_MATCH_LOCK.notStarted).toBe(next.notStarted);
    expect(NEXT_MATCH_LOCK.cascade, "isCascadeWalkover: the walkover the system awarded is reset, never refused").toEqual(next.cascade);
    expect(next.resetExempt, "planRelease refuses only `!reset && hasStarted(t)`").toBe(true);
    expect(next.everyAppend, "append-event.ts runs releaseFedSeats on every append, a void included").toBe(true);
    expect(isNamedRefusal(next.status, next.code), "a named refusal: the model can tell it apart").toBe(true);
    expect([...NEXT_MATCH_LOCK.kinds].sort()).toEqual([...BRACKET_STAGE_KINDS].sort());
    const rr = roundRobinKindsText();
    expect(rr.length).toBeGreaterThan(0);
    for (const k of rr) expect(NEXT_MATCH_LOCK.kinds, `${k} keeps must-accept`).not.toContain(k);
  });

  it("every engine bracket feed runs to a LATER product round_no — the direction the model's rule reads (engine bracket.ts through stages.ts bracketToGen)", () => {
    const roundNo = bracketRoundNoText();
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `x${i + 1}`);
    const BRACKETS: Record<string, (n: number) => GeneratedBracket[]> = {
      knockout: (n) => [generateSingleElim({ entrants: ids(n) }), generateSingleElim({ entrants: ids(n), thirdPlace: true })],
      double_elim: (n) => [generateDoubleElim({ entrants: ids(n) }), generateDoubleElim({ entrants: ids(n), bracketReset: true })],
      page_playoff: (n) => (n === 4 ? [generatePagePlayoff({ entrants: ids(n) })] : []),
      stepladder: (n) => [generateStepladder({ entrants: ids(n) })],
    };
    expect(Object.keys(BRACKETS).sort(), "one generator per engine bracket kind").toEqual([...BRACKET_STAGE_KINDS].sort());
    let edges = 0;
    for (const [kind, gen] of Object.entries(BRACKETS)) {
      let kindEdges = 0;
      for (let n = 2; n <= 12; n++) {
        for (const b of gen(n)) {
          const at = new Map(b.fixtures.map((f) => [f.id, roundNo(f.bracket, f.round, b.rounds)]));
          for (const f of b.fixtures) {
            for (const from of [f.homeFrom, f.awayFrom]) {
              if (from === undefined) continue;
              const src = at.get(from.fixtureId);
              const dst = at.get(f.id);
              expect(src, `${kind} n=${n} ${from.fixtureId} → ${f.id}`).toBeDefined();
              expect(dst ?? 0, `${kind} n=${n} ${from.fixtureId} (${src}) → ${f.id} (${dst})`).toBeGreaterThan(src ?? Infinity);
              kindEdges++;
            }
          }
        }
      }
      expect(kindEdges, kind).toBeGreaterThan(0);
      edges += kindEdges;
    }
    expect(edges).toBeGreaterThan(0);
  });

  it("knockout: a Void of a semi after the final has started is an EXPECTED refusal — counted, nothing written, the ledger kept and still judged; a second Void the same; the final's own Void is accepted", async () => {
    // single-sport: the refusal reads the bracket's feeds, not a sport.
    const { m, d } = await bracket("knockout", 4, semis);
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
    const { sf1, fin } = byOrder(m);
    expect(fin.status, "both semis played, then the final they seated").toBe("decided");
    expect(fin.home).toBe(sf1.home);
    const before = [...(sf1.ledger ?? [])];
    expect(before.length).toBeGreaterThan(0);
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(1, { expected: 1 }));
    expect(m.steps.at(-1)?.verdict).toBe("expected-refusal");
    expect(d.ledgers.get(sf1.id)?.length, "the product wrote nothing").toBe(before.length);
    expect(sf1.ledger, "nothing was written, so the model still knows the whole ledger").toEqual(before);
    const parity = m.foldParity;
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(2, { expected: 2 }));
    expect(m.foldParity, "the semi is still folded against the product").toBeGreaterThanOrEqual(parity + 3);
    await play(m, d, [["Void", 2]]);
    expect(m.counts.Void).toEqual(counts(3, { accepted: 1, expected: 2 }));
    expect(m.counts.Void.unexpected).toBe(0);
  });

  it("knockout: Correct of a semi after the final has started is refused the same on its first void — expected, nothing written", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 4, semis);
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
    const { sf2 } = byOrder(m);
    const before = [...(sf2.ledger ?? [])];
    await play(m, d, [["Correct", 1]]);
    expect(m.counts.Correct).toEqual(counts(1, { expected: 1 }));
    expect(d.ledgers.get(sf2.id)?.length).toBe(before.length);
    expect(sf2.ledger).toEqual(before);
  });

  it("knockout, before the fed match starts: the same Void is ACCEPTED and gives the seat back", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 4, semis);
    await play(m, d, [["Score", 0, 0]]);
    expect(byOrder(m).fin.home).not.toBeNull();
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(1, { accepted: 1 }));
    expect(byOrder(m).fin.home, "fed-seats.ts empties the seat the take-back vacated").toBeNull();
  });

  it("round robin keeps must-accept: a Void is accepted, and the same NEXT_MATCH_STARTED refusal on each round-robin kind is model-unexpected-refusal", async () => {
    // single-sport: the rule reads the stage kind, not a sport.
    const plain = await fresh();
    await play(plain.m, plain.d, [["Start", 0], ["Score", 0, 0], ["Void", 0]]);
    expect(plain.m.counts.Void).toEqual(counts(1, { accepted: 1 }));
    let checked = 0;
    for (const kind of roundRobinKindsText()) {
      const { m: base, d } = await fresh();
      if (d.stage === null) throw new Error("test: no stage");
      d.stage.kind = kind;
      const m: ModelState = { ...base, stageKind: kind };
      await play(m, d, [["Start", 0]]);
      const rows = [...m.fixtures.values()];
      const f = rows[0];
      if (f === undefined) throw new Error("test: no fixture");
      // A later round's meeting that seats one of f's pair: the product's feed shape, which a round robin never has.
      const g = rows.find((x) => x !== f && (x.home === f.home || x.away === f.home));
      if (g === undefined) throw new Error("test: no later meeting of f's home entrant");
      d.feed(f.id, g.id, g.home === f.home ? 1 : 2);
      await play(m, d, [["Score", 0, 0], ["Score", rows.indexOf(g) - 1, 0]]);
      const e = await violation(play(m, d, [["Void", 0]]));
      expect(e.check, kind).toBe(UNEXPECTED_REFUSAL);
      expect(e.evidence[0], kind).toContain(`${next.status} ${next.code}`);
      expect(m.counts.Void, kind).toEqual(counts(1, { unexpected: 1 }));
      checked++;
    }
    expect(checked).toBe(roundRobinKindsText().length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a NEXT_MATCH_STARTED refusal when no LATER fixture holding this one's entrant has started is still model-unexpected-refusal: the fed match unstarted, the upstream feeder and an unrelated started match do not count", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 6, (dd, [e1, e2, e3, e4, e5, e6]) => {
      const f1 = dd.seat(1, e1, e2);
      const f2 = dd.seat(2, null, e3);
      const f3 = dd.seat(3, null, e4);
      dd.seat(3, e5, e6);
      dd.feed(f1.id, f2.id, 1);
      dd.feed(f2.id, f3.id, 1);
    }, { fedSeatsFault: "always" });
    // f1 (its winner seats f2), the unrelated round-3 match, then f2 (its winner seats f3, unstarted).
    await play(m, d, [["Score", 0, 0], ["Score", 1, 0], ["Score", 0, 0]]);
    const [f1, f2, f3, x] = [...m.fixtures.values()];
    expect([f1?.status, f2?.status, f3?.status, x?.status]).toEqual(["decided", "decided", "scheduled", "decided"]);
    expect(f3?.home).toBe(f1?.home);
    const e = await violation(play(m, d, [["Void", 1]]));
    expect(e.check).toBe(UNEXPECTED_REFUSAL);
    expect(m.counts.Void).toEqual(counts(1, { unexpected: 1 }));
  });

  it("the candidates of a take-back, row by row: a later round only, one of the pair only, a bracket kind only — and the empty case first", async () => {
    // single-sport: the candidates read fixture rows, not a sport.
    const { m: base } = await fresh();
    const [e1, e2, e3, e4] = base.entrants;
    const f: FixtureModel = { id: "f", round: 1, home: e1, away: e2, status: "decided", ledger: [] };
    const g = (over: Partial<FixtureModel>): FixtureModel => ({ id: "g", round: 2, home: e1, away: null, status: next.notStarted, ledger: [], ...over });
    const ROWS: { what: string; kind?: string; f?: Partial<FixtureModel>; g: Partial<FixtureModel> | null; want: boolean }[] = [
      { what: "empty case: no other fixture", g: null, want: false },
      { what: "a later round seating f's home entrant — started or not: the driver's answer judges that", g: {}, want: true },
      { what: "the away seat holds f's away entrant", g: { home: e3, away: e2 }, want: true },
      { what: "an EARLIER round (f's own feeder)", g: { round: 0 }, want: false },
      { what: "the SAME round", g: { round: 1 }, want: false },
      { what: "a later match holding neither entrant", g: { home: e3, away: e4 }, want: false },
      { what: "the fed match has no round_no", g: { round: null }, want: false },
      { what: "f has no round_no", f: { round: null }, g: {}, want: false },
      { what: "a round-robin kind never", kind: "league", g: {}, want: false },
    ];
    let checked = 0;
    for (const row of ROWS) {
      const ff: FixtureModel = { ...f, ...row.f };
      const fixtures = new Map<string, FixtureModel>([[ff.id, ff]]);
      if (row.g !== null) fixtures.set("g", g(row.g));
      const m: ModelState = { ...base, stageKind: row.kind ?? "knockout", fixtures };
      expect(fedCandidates(m, ff).map((x) => x.id), row.what).toEqual(row.want ? ["g"] : []);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    let kinds = 0;
    for (const kind of NEXT_MATCH_LOCK.kinds) {
      const m: ModelState = { ...base, stageKind: kind, fixtures: new Map([["f", f], ["g", g({})]]) };
      expect(fedCandidates(m, f).length, kind).toBe(1);
      kinds++;
    }
    expect(kinds).toBe(BRACKET_STAGE_KINDS.size);
  });

  it("has a candidate started, on the driver's answer — fed-seats.ts `!isCascadeWalkover(t) && hasStarted(t)`, row by row, the empty case first; a null ledger alone is no evidence", () => {
    const note: LedgerEntry = { id: "n1", seq: 1, type: "core.note", payload: {} };
    const voidOf = (id: string, seq: number): LedgerEntry => ({ id: `v${seq}`, seq, type: "core.void", payload: {}, voids: id });
    const forfeit: LedgerEntry = { id: "w1", seq: 1, type: "core.forfeit", payload: { by: "a", reason: REASON_TEXT } };
    const award = { kind: next.cascade.outcomeKind, winner: "h" };
    const S = next.notStarted;
    const ROWS: { what: string; status: string; outcome: unknown; lastSeq: number; ledger: LedgerEntry[] | null; want: "started" | "not-started" | "unverified" }[] = [
      { what: "empty case: not-started status, no outcome, no event", status: S, outcome: null, lastSeq: 0, ledger: [], want: "not-started" },
      { what: "…and the model's ledger unknown: 0 events is 0 live events (the review's probe)", status: S, outcome: null, lastSeq: 0, ledger: null, want: "not-started" },
      { what: "hasStarted: the status has moved", status: "in_play", outcome: null, lastSeq: 1, ledger: null, want: "started" },
      { what: "hasStarted: decided", status: "decided", outcome: { kind: "win", winner: "h" }, lastSeq: 3, ledger: null, want: "started" },
      { what: "hasStarted: an outcome on a not-started status", status: S, outcome: { kind: "win", winner: "h" }, lastSeq: 0, ledger: [], want: "started" },
      { what: "hasStarted: a live event the model knows whole (a note keeps the status)", status: S, outcome: null, lastSeq: 1, ledger: [note], want: "started" },
      { what: "…but a voided one is not live", status: S, outcome: null, lastSeq: 2, ledger: [note, voidOf("n1", 2)], want: "not-started" },
      { what: "events the model cannot see: unverified, never 'started'", status: S, outcome: null, lastSeq: 1, ledger: null, want: "unverified" },
      { what: "a known ledger the product's tip has moved past: unverified", status: S, outcome: null, lastSeq: 1, ledger: [], want: "unverified" },
      { what: "isCascadeWalkover: forfeited + award + no event → reset, not started", status: next.cascade.status, outcome: award, lastSeq: 0, ledger: null, want: "not-started" },
      { what: "…an award whose only forfeit was voided has no live event: still the reset", status: next.cascade.status, outcome: award, lastSeq: 2, ledger: [forfeit, voidOf("w1", 2)], want: "not-started" },
      { what: "an award WITH a live forfeit (a withdrawal's) is a recorded decision: started", status: next.cascade.status, outcome: award, lastSeq: 1, ledger: [forfeit], want: "started" },
      { what: "an award whose events the model cannot see: unverified", status: next.cascade.status, outcome: award, lastSeq: 1, ledger: null, want: "unverified" },
      { what: "forfeited with a WIN (a played walkover) is no cascade award: started", status: next.cascade.status, outcome: { kind: "win", winner: "h" }, lastSeq: 0, ledger: null, want: "started" },
    ];
    let checked = 0;
    for (const r of ROWS) {
      expect(fedMatchStarted({ status: r.status, outcome: r.outcome, last_seq: r.lastSeq }, r.ledger), r.what).toBe(r.want);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });

  it("a DIFFERENT refusal of a knockout take-back after the fed match started is still model-unexpected-refusal: the permit is the code AND the status", async () => {
    // single-sport: as above.
    class Refusing extends ModelFakeDriver {
      armed: { status: number; code: string } | null = null;
      override postStream(id: string, events: Parameters<ModelFakeDriver["postStream"]>[1], prefix = ""): Promise<PostedEvent[]> {
        const a = this.armed;
        if (a === null) return super.postStream(id, events, prefix);
        this.armed = null;
        return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, a.status, a.code, "refused"));
      }
    }
    const CASES = [{ status: next.status, code: "INVALID_EVENT" }, { status: 422, code: next.code }];
    let checked = 0;
    for (const c of CASES) {
      const d = new Refusing();
      const { m } = await bracket("knockout", 4, semis, {}, d);
      await play(m, d, [["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
      expect(fedCandidates(m, byOrder(m).sf1).map((x) => x.id), "the final is sf1's candidate").toEqual([byOrder(m).fin.id]);
      expect(byOrder(m).fin.status, "…and it has started").toBe("decided");
      d.armed = c;
      const e = await violation(play(m, d, [["Void", 0]]));
      expect(e.check, `${c.status} ${c.code}`).toBe(UNEXPECTED_REFUSAL);
      checked++;
    }
    expect(checked).toBe(CASES.length);
  });

  it("(1) the fed match has really started, on the driver's answer → expected — even when the model no longer knows its ledger", async () => {
    // single-sport: the judgement reads fixture state, not a sport.
    let checked = 0;
    for (const known of [true, false]) {
      const { m, d } = await bracket("knockout", 4, semis);
      await play(m, d, [["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
      const { sf1, fin } = byOrder(m);
      if (!known) fin.ledger = null;
      const before = [...(sf1.ledger ?? [])];
      await play(m, d, [["Void", 0]]);
      expect(m.counts.Void, `known ${known}`).toEqual(counts(1, { expected: 1 }));
      expect(m.steps.at(-1)?.verdict).toBe("expected-refusal");
      expect(m.unknowns.filter((u) => u.cause === "next-match-unverified")).toEqual([]);
      expect(sf1.ledger).toEqual(before);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("(2) the fed match is scheduled with 0 events → model-unexpected-refusal, whether or not the model still knows its ledger (the review's probe: a null ledger is no evidence)", async () => {
    // single-sport: as above.
    let checked = 0;
    for (const known of [true, false]) {
      const { m, d } = await bracket("knockout", 4, semis, { fedSeatsFault: "always" });
      await play(m, d, [["Score", 0, 0]]);
      const { fin } = byOrder(m);
      expect(fin.home, "sf1 seated the final").not.toBeNull();
      expect(await d.fixtureState(fin.id)).toEqual({ status: next.notStarted, last_seq: 0, outcome: null });
      if (!known) fin.ledger = null;
      const e = await violation(play(m, d, [["Void", 0]]));
      expect(e.check, `known ${known}`).toBe(UNEXPECTED_REFUSAL);
      expect(e.evidence[0]).toContain(fin.id);
      expect(m.counts.Void).toEqual(counts(1, { unexpected: 1 }));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("(3) the fed match is a zero-event cascade walkover → the product RESETS it (the take-back is accepted and the seat given back); a refusal instead is model-unexpected-refusal", async () => {
    // single-sport: as above.
    /** resolveBracketSeats' award on the final: forfeited + {kind: award}, no event. */
    const awardFinal = (d: ModelFakeDriver, m: ModelState) => {
      const row = d.fixtures.find((x) => x.id === byOrder(m).fin.id);
      if (row === undefined || row.home_entrant_id === null) throw new Error("test: the final is not seated");
      row.status = next.cascade.status;
      row.outcome = { kind: next.cascade.outcomeKind, winner: row.home_entrant_id };
      // Absorbed while forfeited, the model would never know its ledger (the review's sticky null).
      byOrder(m).fin.ledger = null;
    };
    const ok = await bracket("knockout", 4, semis);
    await play(ok.m, ok.d, [["Score", 0, 0]]);
    awardFinal(ok.d, ok.m);
    await play(ok.m, ok.d, [["Void", 0]]);
    expect(ok.m.counts.Void, "the product resets a cascade walkover").toEqual(counts(1, { accepted: 1 }));
    expect(byOrder(ok.m).fin).toMatchObject({ status: next.notStarted, home: null });

    const bad = await bracket("knockout", 4, semis, { fedSeatsFault: "always" });
    await play(bad.m, bad.d, [["Score", 0, 0]]);
    awardFinal(bad.d, bad.m);
    const e = await violation(play(bad.m, bad.d, [["Void", 0]]));
    expect(e.check).toBe(UNEXPECTED_REFUSAL);
    expect(bad.m.counts.Void).toEqual(counts(1, { unexpected: 1 }));
  });

  it("second candidate: a take-back over a chain is expected when ANY candidate has started — the fed match played, the one after it still unstarted", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 4, (dd, [e1, e2, e3, e4]) => {
      const f1 = dd.seat(1, e1, e2);
      const f2 = dd.seat(2, null, e3);
      const f3 = dd.seat(3, null, e4);
      dd.feed(f1.id, f2.id, 1);
      dd.feed(f2.id, f3.id, 1);
    });
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0]]);
    const [f1, f2, f3] = [...m.fixtures.values()];
    if (f1 === undefined || f2 === undefined || f3 === undefined) throw new Error("test: the chain has three fixtures");
    expect(fedCandidates(m, f1).map((x) => x.id), "f2, then f3: both later, both holding f1's winner").toEqual([f2.id, f3.id]);
    expect([f2.status, f3.status]).toEqual(["decided", next.notStarted]);
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(1, { expected: 1 }));
  });

  it("final batch FB-11: the started candidate need not be listed FIRST — the chain listed final-first, so the unstarted f3 is judged before the played f2, and the take-back is still expected", async () => {
    // single-sport: as above. Task 13 review M-R3-1: with the started
    // candidate always first, judging `candidates.slice(0, 1)` stayed green.
    let ids: string[] = [];
    const { m, d } = await bracket("knockout", 4, (dd, [e1, e2, e3, e4]) => {
      const f1 = dd.seat(1, e1, e2);
      const f3 = dd.seat(3, null, e4);
      const f2 = dd.seat(2, null, e3);
      dd.feed(f1.id, f2.id, 1);
      dd.feed(f2.id, f3.id, 1);
      ids = [f1.id, f2.id, f3.id];
    });
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0]]);
    const [f1, f2, f3] = ids.map((id) => m.fixtures.get(id));
    if (f1 === undefined || f2 === undefined || f3 === undefined) throw new Error("test: the chain has three fixtures");
    expect(fedCandidates(m, f1).map((x) => x.id), "the premise: f3 is listed before f2").toEqual([f3.id, f2.id]);
    expect([f2.status, f3.status], "the premise: the first-listed candidate never started").toEqual(["decided", next.notStarted]);
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(1, { expected: 1 }));
  });

  it("a fed match whose events the model cannot see (scheduled, no outcome, last_seq > 0) → counted under unknowns: the refusal is neither expected nor a violation, and the step is not informative", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 4, semis);
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0]]);
    const { sf1, fin } = byOrder(m);
    // A second writer's note: the final stays scheduled, with a live event the model never posted.
    await d.postStream(fin.id, [{ type: "core.note", payload: { text: "court change" } }]);
    expect(await d.fixtureState(fin.id)).toEqual({ status: next.notStarted, last_seq: 1, outcome: null });
    const before = [...(sf1.ledger ?? [])];
    await play(m, d, [["Void", 0]]);
    expect(m.counts.Void).toEqual(counts(1, { refused: 1 }));
    expect(m.steps.at(-1)?.verdict).toBe("unknown");
    const u = m.unknowns.filter((x) => x.cause === "next-match-unverified");
    expect(u.map((x) => x.fixture)).toEqual([fin.id]);
    expect(u[0]?.detail).toContain(sf1.id);
    expect(sf1.ledger, "the refusal wrote nothing: sf1 is still known").toEqual(before);
    expect(informativeSteps({ ...m, steps: m.steps.slice(-1) }).verdict).toBe("fail");
  });

  it("a NEXT_MATCH_STARTED refusal that nonetheless wrote the event → model-next-match-lock: a refused take-back leaves the tip where it was", async () => {
    // single-sport: as above.
    const { m, d } = await bracket("knockout", 4, semis, { fedSeatsFault: "leaky" });
    await play(m, d, [["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
    const e = await violation(play(m, d, [["Void", 0]]));
    expect(e.check).toBe(NEXT_MATCH_CHECK);
  });
});

describe("I-2: every ledger that goes unknown is counted, and a cell with no informative step is vacuous", () => {
  it("a post the driver marks `retried` leaves that ledger unknown, counted — the step is 'unknown', never a false parity", async () => {
    // single-sport: the retry flag is the driver's.
    const { m, d } = await fresh({ retriedPosts: true });
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => x.status === "decided");
    if (f === undefined) throw new Error("test: nothing scored");
    expect(f.ledger).toBeNull();
    expect(m.unknowns).toEqual([{ cause: "retried", fixture: f.id, detail: expect.stringMatching(/retried/) }]);
    expect(m.steps.map((s) => s.verdict)).toEqual(["accepted", "unknown"]);
    expect(m.foldParity).toBe(0);
  });
  it("a tip that moved (a second writer) is counted with the fixture and both seqs", async () => {
    // single-sport: void resolution is the kernel's.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).length === 2);
    const result = f?.ledger?.[1];
    if (f === undefined || result === undefined) throw new Error("test: nothing scored");
    await d.postStream(f.id, [{ type: "core.void", payload: { event_id: result.id } }], "someone-else");
    const before = m.foldParity;
    await play(m, d, [["Generate", 0]]);
    expect(f.ledger).toBeNull();
    expect(m.foldParity).toBe(before);
    expect(m.unknowns).toEqual([{ cause: "tip-moved", fixture: f.id, detail: "product last_seq 3, model ledger 2" }]);
    expect(m.steps.at(-1)?.verdict).toBe("unknown");
  });
  it("empty case first: a cell with no step is vacuous — zero informative steps is a FAILURE", async () => {
    const { m } = await fresh();
    expect(informativeSteps(m)).toMatchObject({ id: VACUITY_CHECK, verdict: "fail", checked: 0 });
  });
  it("a cell whose every step was refused is vacuous", async () => {
    // single-sport: no event is posted.
    class RefuseAll extends ModelFakeDriver {
      override start(): Promise<StartOut> { return Promise.reject(new RefusedCall("POST", "/api/v1/divisions/d1/start", 422, "DIVISION_NOT_READY", "no")); }
      override generate(): Promise<GenerateOut> { return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 422, "STAGE_NOT_READY", "no")); }
    }
    const { m, d } = await fresh({}, {}, new RefuseAll());
    await play(m, d, [["Start", 0], ["Generate", 0]]);
    expect(m.steps.map((s) => s.verdict)).toEqual(["refused", "refused"]);
    expect(informativeSteps(m)).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("expected refusals and unknown steps are uninformative too; one accepted step makes the cell informative", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ retriedPosts: true });
    await play(m, d, [["Start", 0], ["Score", 0, 0], ["AddEntrant", 0]]);
    expect(m.steps.map((s) => s.verdict)).toEqual(["accepted", "unknown", "expected-refusal"]);
    expect(informativeSteps(m)).toMatchObject({ verdict: "pass", checked: 1 });
    expect(informativeSteps({ ...m, steps: m.steps.slice(1) })).toMatchObject({ verdict: "fail", checked: 0 });
  });
});

describe("model walkover uses the organiser's forfeit composition", () => {
  it("a scheduled fixture's walkover posts START then core.forfeit (as HttpDriver.forfeit does)", async () => {
    // single-sport: the composition is core events only.
    const { m, d } = await fresh();
    await play(m, d, [["Start", 0], ["Walkover", 0, 0]]);
    const f = [...m.fixtures.values()].find((x) => (x.ledger ?? []).some((e) => e.type === "core.forfeit"));
    expect(f?.ledger?.map((e) => e.type)).toEqual([START.type, "core.forfeit"]);
  });
});

/** Start and three results: the first open fixture each time, so one entrant
 *  (round 1 then round 2) has two results and one scheduled match left — the
 *  walkover policy (played ≥ half, withdrawTableEntrant). */
async function twoOfThree(m: ModelState, d: ModelFakeDriver): Promise<{ who: string; pending: FixtureRow }> {
  await play(m, d, [["Start", 0], ["Score", 0, 0], ["Score", 0, 0], ["Score", 0, 0]]);
  const mine = (e: string) => [...m.fixtures.values()].filter((f) => f.home === e || f.away === e);
  const who = m.entrants.find((e) => mine(e).filter((f) => f.status === "decided").length === 2);
  if (who === undefined) throw new Error("test: no entrant with two results");
  const pending = d.fixtures.filter((f) => (f.home_entrant_id === who || f.away_entrant_id === who) && f.status === "scheduled");
  if (pending.length !== 1 || pending[0] === undefined) throw new Error(`test: ${who} has ${pending.length} scheduled matches, not 1`);
  return { who, pending: pending[0] };
}

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
  it("the walkover policy (played ≥ half): the pending fixture gets withdrawal.ts's BARE core.forfeit, and the model reads it without a false parity", async () => {
    // single-sport: the F1 sweep below runs this on every modelled sport.
    const { m, d } = await fresh();
    const { who, pending } = await twoOfThree(m, d);
    await play(m, d, [["Withdraw", m.entrants.indexOf(who)]]);
    expect(pending.status).toBe("forfeited");
    // withdrawal.ts applyUpdate: no START first, the product's REASON.
    expect((d.ledgers.get(pending.id) ?? []).map((e) => [e.type, e.payload])).toEqual([["core.forfeit", { by: who, reason: withdrawalReason() }]]);
    expect(m.fixtures.get(pending.id)).toMatchObject({ status: "forfeited", ledger: null });
    const before = m.foldParity;
    await play(m, d, [["Score", 0, 1], ["Generate", 0]]);
    expect(m.foldParity).toBeGreaterThan(before);
  });
  it("F1 offline, every modelled sport: where the engine refuses a forfeit before core.start, the cascade's bare walkover is refused and the first Withdraw fails as an unexpected refusal", async () => {
    let refusing = 0;
    let accepting = 0;
    for (const sport of SPORT_KEYS) {
      const variant = variantKeys(sport)[0] ?? "";
      const c = resolveSportCfg(sport, variant);
      if (entrantKindFor(sport, c) === "team") continue;
      // The engine's own answer (the harness fold, lib/fold.ts): does a bare forfeit fold on a fresh fixture?
      let bare = true;
      try {
        foldStream(sportModule(sport), c, "h", "a", [{ type: "core.forfeit", payload: { by: "h", reason: withdrawalReason() } }]);
      } catch (e) {
        if (!EngineError.is(e)) throw e;
        bare = false;
      }
      const { m, d } = await fresh({}, { sport, variant });
      const { who, pending } = await twoOfThree(m, d);
      if (bare) {
        await play(m, d, [["Withdraw", m.entrants.indexOf(who)]]);
        expect(pending.status, sport).toBe("forfeited");
        accepting++;
      } else {
        const e = await violation(play(m, d, [["Withdraw", m.entrants.indexOf(who)]]));
        expect(e.check, sport).toBe(UNEXPECTED_REFUSAL);
        expect(m.counts.Withdraw, sport).toEqual(counts(1, { unexpected: 1 }));
        refusing++;
      }
    }
    expect(refusing).toBeGreaterThan(0);
    expect(accepting).toBeGreaterThan(0);
  });
});

describe("carry (c): at legs ≥ 2 a duplicate masked by a missing meeting is still seen", () => {
  it("control: the engine's mirrored home-and-away schedule passes, every pair judged once per step", async () => {
    // single-sport: the schedule is sport-blind.
    const { m, d } = await fresh({}, { knobs: HOME_AWAY });
    expect(m.stageConfig.legs).toBe(2);
    await play(m, d, [["Start", 0]]);
    // C(4,2) pairs, each judged once by I7 and once by the orientation check.
    expect(m.stepChecks.get(I7)).toBe(pairs(4));
    expect(m.stepChecks.get(ORIENTATION_CHECK)).toBe(pairs(4));
    expect(m.fixtures.size).toBe(2 * pairs(4));
  });
  it("T14 fix round 1: the orientation check judges only the kinds it declares (ORIENTATION_STAGE_KINDS) — on a swiss it counts nothing, so vacuity never owes it there", async () => {
    // single-sport: the schedule is sport-blind. The fake always schedules a
    // round robin, so the stage is relabelled: only the kind differs between the two.
    expect(ORIENTATION_STAGE_KINDS).not.toContain("swiss");
    const swiss = await fresh();
    (swiss.m as { stageKind: string }).stageKind = "swiss";
    const league = await fresh();
    await play(swiss.m, swiss.d, [["Start", 0]]);
    await play(league.m, league.d, [["Start", 0]]);
    expect(swiss.m.fixtures.size).toBe(pairs(4));
    expect(swiss.m.stepChecks.get(ORIENTATION_CHECK) ?? 0).toBe(0);
    expect(league.m.stepChecks.get(ORIENTATION_CHECK)).toBe(pairs(4));
  });
  it("an unmirrored second leg meets `legs` times per pair — I7 passes it — and the orientation check fails, naming the duplicate AND the missing mirror", async () => {
    // single-sport: as above.
    const { m, d } = await fresh({ unmirroredLegs: true }, { knobs: HOME_AWAY });
    const e = await violation(play(m, d, [["Start", 0]]));
    expect(e.check).toBe(ORIENTATION_CHECK);
    // I7 judged the same step first and passed: each pair meets exactly 2 = legs times.
    expect(m.stepChecks.get(I7)).toBe(pairs(4));
    expect(e.evidence.length).toBe(pairs(4));
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
    expect((m.stepChecks.get(I7) ?? 0) - before).toBe(pairs(4));
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
    const { m, d } = await fresh({}, {}, new Overanswer());
    await play(m, d, [["Start", 0]]);
    await expect(commandOf("Score", 0, 0, true).run(m, d)).rejects.toThrow(/answered 3 events for 2 posted/);
  });
  it("T14 fix round 2, RR-3: a post that errors part-way (here, a request that did not answer after one event landed) leaves that fixture's ledger UNKNOWN, never a known empty one", async () => {
    // single-sport: the rule is on the post's own bookkeeping.
    class LandsOneThenHangs extends ModelFakeDriver {
      armed = false;
      postedTo: string | null = null;
      override async postStream(id: string, events: Parameters<ModelFakeDriver["postStream"]>[1], prefix = ""): Promise<PostedEvent[]> {
        if (!this.armed) return super.postStream(id, events, prefix);
        this.postedTo = id;
        await super.postStream(id, events.slice(0, 1), prefix);
        throw new RequestTimedOut("POST", `/api/v1/fixtures/${id}/events`, 60_000);
      }
    }
    const d = new LandsOneThenHangs();
    const { m } = await fresh({}, {}, d);
    await play(m, d, [["Start", 0]]);
    const knownBefore = [...m.fixtures.values()].filter((f) => f.ledger !== null && f.ledger.length === 0).length;
    expect(knownBefore, "no known empty ledger to lose").toBeGreaterThan(1);
    d.armed = true;
    await expect(commandOf("Score", 0, 0, true).run(m, d)).rejects.toBeInstanceOf(RequestTimedOut);
    if (d.postedTo === null) throw new Error("test: the Score posted nothing");
    expect(m.fixtures.get(d.postedTo)?.ledger).toBeNull();
    // Only that fixture: every other ledger is still known and empty.
    expect([...m.fixtures.values()].filter((f) => f.ledger !== null && f.ledger.length === 0).length).toBe(knownBefore - 1);
  });
  it("an addEntrants that answers no entrant is a harness fault, not a silently unchanged roster", async () => {
    // single-sport: the guard is on the driver's answer shape.
    class Silent extends ModelFakeDriver {
      override async addEntrants(dv: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]): Promise<Awaited<ReturnType<ModelFakeDriver["addEntrants"]>>> {
        return es.length === 1 ? [] : super.addEntrants(dv, es);
      }
    }
    const { m, d } = await fresh({}, {}, new Silent());
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
  it("a withdrawal refused part-way is an unexpected refusal, and still leaves that entrant's ledgers unknown: the cascade may have written", async () => {
    // single-sport: the cascade's composition is core events only.
    class HalfWithdraw extends ModelFakeDriver {
      override async withdraw(entrantId: string): ReturnType<ModelFakeDriver["withdraw"]> {
        await super.withdraw(entrantId);
        throw new RefusedCall("POST", `/api/v1/entrants/${entrantId}/withdraw`, 409, "SEQ_CONFLICT", "raced");
      }
    }
    const { m, d } = await fresh({}, {}, new HalfWithdraw());
    await play(m, d, [["Start", 0], ["Score", 0, 0]]);
    expect((await violation(play(m, d, [["Withdraw", 0]]))).check).toBe(UNEXPECTED_REFUSAL);
    expect(m.counts.Withdraw).toEqual(counts(1, { unexpected: 1 }));
    const mine = [...m.fixtures.values()].filter((f) => f.home === m.entrants[0] || f.away === m.entrants[0]);
    expect(mine.length).toBe(3);
    for (const f of mine) expect(f.ledger, f.id).toBeNull();
  });
  it("absorbFixtures: a new scheduled fixture with no result starts with a known empty ledger; one under way, or scheduled but CARRYING an outcome, is unknown; one gone from the list is dropped", async () => {
    // single-sport: no event is folded.
    const { m } = await fresh();
    const row = (id: string, status: string, outcome: unknown = null): FixtureRow => ({ id, stage_id: m.stageId, pool_id: null, round_no: 1, fixture_no: 1, home_entrant_id: "e1", away_entrant_id: "e2", status, outcome });
    absorbFixtures(m, [row("n1", "scheduled"), row("n2", "in_play"), row("n3", "decided"), row("n4", "scheduled", { kind: "award", winner: "e1" })]);
    expect([...m.fixtures.values()].map((f) => [f.id, f.ledger])).toEqual([["n1", []], ["n2", null], ["n3", null], ["n4", null]]);
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

describe("the product's own answer rides every refusal violation as `said` — the only text a committed case's `match` is tested against (T15 fix round 3, I-1)", () => {
  // single-sport: the four refusal sites read the product's refusal, not a sport.
  const CELL = "t|generic";
  const caseFor = (id: string, check: string, match: string) =>
    ({ id, title: "t", issue: null, cell: CELL, variant: "score", check, seed: 1, path: "0", replayPath: null, maxCommands: 30, fencesOn: false, fence: null, match, status: "open" as const, found: "2026-09-29", runId: "t" });
  /** The product's NEXT_MATCH_STARTED sentence after its label (fed-seats.ts through lib/next-match-started.ts), read from the product. */
  const nextTail = (() => {
    const [, tail] = nextMatchStartedText().message("|").split("|");
    if (tail === undefined || tail.trim() === "") throw new Error("test: the product's next-match sentence has no text after its label");
    return tail;
  })();
  type Site = { site: string; check: string; product: string; drive: () => Promise<ModelViolation> };
  const SITES: Site[] = [
    {
      site: "an expected refusal that is unnamed and not the known lock (commands.ts, expected branch)",
      check: REFUSAL_NAMED,
      product: "test: the roster write crashed",
      drive: async () => {
        class Crashing extends ModelFakeDriver {
          override addEntrants(dv: string, es: Parameters<ModelFakeDriver["addEntrants"]>[1]): ReturnType<ModelFakeDriver["addEntrants"]> {
            return super.addEntrants(dv, es).catch(() => { throw new RefusedCall("POST", `/api/v1/divisions/${dv}/entrants`, 500, "INTERNAL", "test: the roster write crashed"); });
          }
        }
        const { m, d } = await fresh({}, {}, new Crashing());
        await play(m, d, [["Start", 0]]);
        return violation(play(m, d, [["AddEntrant", 0]]));
      },
    },
    {
      site: "a permitted refusal its judge holds unexpected (commands.ts, judge branch)",
      check: UNEXPECTED_REFUSAL,
      product: nextTail,
      drive: async () => {
        const { m: base, d } = await fresh({ fedSeatsFault: "always" }, { entrants: 6 });
        if (d.stage === null) throw new Error("test: no stage");
        d.stage.kind = "knockout";
        const m: ModelState = { ...base, stageKind: "knockout" };
        const [e1, e2, e3, e4, e5, e6] = m.entrants;
        const f1 = d.seat(1, e1 ?? null, e2 ?? null);
        const f2 = d.seat(2, null, e3 ?? null);
        d.seat(3, e5 ?? null, e6 ?? null);
        d.feed(f1.id, f2.id, 1);
        d.seat(3, null, e4 ?? null);
        await play(m, d, [["Start", 0], ["Score", 0, 0]]);
        return violation(play(m, d, [["Void", 0]]));
      },
    },
    {
      site: "an unnamed refusal of an ordinary command (commands.ts, the ordinary branch — the only path MB-004/005 are recognised by)",
      check: REFUSAL_NAMED,
      product: "test: the bulk UPDATE would strand home_slot_label",
      drive: async () => {
        class Crashing extends ModelFakeDriver {
          override generate(): ReturnType<ModelFakeDriver["generate"]> {
            return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, null, "test: the bulk UPDATE would strand home_slot_label"));
          }
        }
        const { m, d } = await fresh({}, {}, new Crashing());
        return violation(play(m, d, [["Generate", 0]]));
      },
    },
    {
      site: "a named refusal of a command the model holds legal (commands.ts, must-accept branch)",
      check: UNEXPECTED_REFUSAL,
      product: "test: refuses every result",
      drive: async () => {
        class RefusingPosts extends ModelFakeDriver {
          override postStream(id: string): Promise<PostedEvent[]> {
            return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses every result"));
          }
        }
        const { m, d } = await fresh({}, {}, new RefusingPosts());
        await play(m, d, [["Start", 0]]);
        return violation(play(m, d, [["Score", 0, 0]]));
      },
    },
  ];

  it("each refusal site: the product's answer is `said`, the evidence's last line, absent from the model's own lines — and a case matching it is recognised, while one matching only the model's line is not", async () => {
    let checked = 0;
    for (const s of SITES) {
      const v = await s.drive();
      expect(v.check, s.site).toBe(s.check);
      expect(v.said, s.site).not.toBeNull();
      expect(v.said ?? "", s.site).toContain(s.product);
      expect(v.evidence.at(-1), `${s.site}: said is the evidence's last line`).toBe(v.said);
      const own = v.evidence.slice(0, -1);
      expect(own.length, s.site).toBeGreaterThan(0);
      for (const line of own) expect(line, `${s.site}: the model's own line`).not.toContain(s.product);
      expect(regressionFor([caseFor("MB-T", s.check, s.product)], CELL, v.check, v.said), s.site).toBe("MB-T");
      // The command's own name is in the model's line and never in the product's answer.
      const cmd = own[0]?.slice(0, own[0].indexOf(":")) ?? "";
      expect(cmd.length, s.site).toBeGreaterThan(0);
      expect(v.said ?? "", s.site).not.toContain(cmd);
      expect(regressionFor([caseFor("MB-H", s.check, cmd)], CELL, v.check, v.said), `${s.site}: a match on the model's own line`).toBeNull();
      checked++;
    }
    expect(checked).toBe(SITES.length);
    expect(checked).toBe(4);
  });

  it("a violation the harness judged on its own carries no `said`, and nothing matches it", async () => {
    const { m, d } = await fresh({ rosterLock: "open" });
    await play(m, d, [["Start", 0]]);
    const v = await violation(play(m, d, [["AddEntrant", 0]]));
    expect(v.check).toBe(ROSTER_LOCK_CHECK);
    expect(v.said).toBeNull();
    expect(regressionFor([caseFor("MB-T", v.check, "the product accepted")], CELL, v.check, v.said)).toBeNull();
  });
});
