// VOIDPROOF (W1d Task 14, item 15e): the first event of the first fixture is voided from the console — over the
// route here, the fakes' ledger — and the ledger and the fold are then held to it, before the division plays on.
//
// Everything rests on the fakes modelling the product's void faithfully, so their own claims are tested first
// (the ledger, the console's rule, the sequence of voids, the empty case). The scenario is then driven end to end
// through the REAL engine fold (class 1): the expected values are the engine's own fold of the harness's stream
// minus the event it voided, the console's rule as the product's text states it, and the sport's generator —
// never anything read back from void-proof.ts.
//
// single-sport (badminton): the plan is league|badminton only (match-day-set.ts). Its first score event leaves a
// best-of-three open, which the scenario requires and refuses by name where it is not so (generic's decides the
// match on its first result: tested below as the unfit case).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VOID_EVENT, DriverMisuse, type FixtureStateOut, type PostedEvent } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import { Recorder, ResumeMismatch, decideFixture, liveEvents, recordPosted, setUpDivision } from "../lib/scenarios/common.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { VOID_PROOF_ENTRANTS, VoidNotHeld, VoidProofUnfit, assertVoidable, firstOpenFixture, postThenVoid, voidFold, voidLedger, type VoidProofObs } from "../lib/scenarios/void-proof.ts";
import type { CaseSpec, ScenarioContext } from "../lib/scenarios/types.ts";
import { decideState } from "../lib/results.ts";
import { foldStream } from "../lib/fold.ts";
import { resolveSportCfg, sportModule } from "../lib/sport-cfg.ts";
import { generateStream } from "../lib/streams/index.ts";
import { START, type StreamEvent } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";
import { FakePadDriver } from "./fake-pad-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const voidProof = SCENARIOS.VOIDPROOF;
const SUMMARY = "badminton.game.summary";

function ctxOf(driver: FakeLeagueDriver, sport = "badminton"): ScenarioContext {
  const variant = offlineBuilderDefault(sport);
  const spec: CaseSpec = { caseId: `league|${sport}|${variant}|VOIDPROOF`, row: "league", sport, variant, scenario: "VOIDPROOF", canary: false };
  return { driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] };
}
async function run(driver: FakeLeagueDriver, sport = "badminton") {
  const out = await voidProof.run(ctxOf(driver, sport));
  const checks = [...evaluateInvariants(out.observed), ...out.assertions];
  return { out, checks, byId: (id: string) => checks.find((c) => c.id === id)!, state: decideState({ checks, deferred: null, error: null }).state };
}
const typesOf = (events: readonly StreamEvent[]) => events.map((e) => e.type);

/** A started league fixture on a league fake of `sport`, ready to be scored. */
async function started(d: FakeLeagueDriver, sport = "badminton"): Promise<string> {
  const ctx = ctxOf(d, sport);
  await setUpDivision(ctx, new Recorder(), VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
  return d.fixtures[0]!.id;
}
/** The badminton win stream the generator builds for the home side: start, then one summary per game won. */
const winStream = (d: FakeLeagueDriver, id: string): StreamEvent[] => {
  const f = d.fixtures.find((x) => x.id === id)!;
  return generateStream({ sportKey: "badminton", cfg: d.cfg, stageKind: "league", home: f.home_entrant_id!, away: f.away_entrant_id!, outcome: { kind: "win", winner: "home" } });
};

describe("the fakes model the console's void (what every scenario test below leans on)", () => {
  it("ledger(): one row per event, id = seq as a string, exclusive of since, and a void row names its target in payload.event_id", async () => {
    const d = new FakeLeagueDriver();
    const id = await started(d);
    const stream = winStream(d, id);
    expect(stream.length).toBeGreaterThanOrEqual(3);
    await d.postStream(id, stream.slice(0, 2), "p");
    await d.voidLast(id);
    const all = await d.ledger(id);
    expect(all.map((r) => [r.seq, r.id, r.type])).toEqual([[1, "1", "core.start"], [2, "2", SUMMARY], [3, "3", VOID_EVENT]]);
    expect(all[2]!.payload).toEqual({ event_id: "2" });
    expect((await d.ledger(id, 2)).map((r) => r.seq)).toEqual([3]);
    expect(await d.ledger(id, 3)).toEqual([]);
  });

  it("voidLast follows the console's rule down the ledger: newest first, never the void itself, and the start last; then nothing is left", async () => {
    const d = new FakeLeagueDriver();
    const id = await started(d);
    const stream = winStream(d, id);
    await d.postStream(id, stream, "p");
    expect(d.fixtures[0]!.status).toBe("decided");
    // Derived from the stream the generator built: the newest event first, down to the start.
    const want = [...typesOf(stream)].reverse();
    const got: string[] = [];
    for (let i = 0; i < want.length; i++) {
      const v = await d.voidLast(id);
      got.push(v.voidedType);
      // The id is the ledger's: row seq (as the fake numbers it) of the event the void names.
      expect(v.voidedEventId).toBe(String(stream.length - i));
    }
    expect(got).toEqual(want);
    const rows = await d.ledger(id);
    expect(rows).toHaveLength(stream.length * 2);
    expect(rows.slice(stream.length).every((r) => r.type === VOID_EVENT)).toBe(true);
    // A decided match voided back to its start is in play again, with no outcome (the fold of nothing).
    expect(d.fixtures[0]!.outcome).toBeNull();
    // Nothing left to void: refused by name, and no row is appended.
    const before = rows.length;
    await expect(d.voidLast(id)).rejects.toThrow(/nothing to void/);
    expect((await d.ledger(id)).length).toBe(before);
  });

  it("the empty case: a fixture with no events has nothing to void (DriverMisuse), appends nothing, and an unknown fixture is refused", async () => {
    const d = new FakeLeagueDriver();
    const id = await started(d);
    await expect(d.voidLast(id)).rejects.toBeInstanceOf(DriverMisuse);
    expect(d.fixtures[0]!.events).toEqual([]);
    await expect(d.voidLast("nope")).rejects.toThrow(/no fixture nope/);
  });

  it("a void changes what the fold says: the same fixture re-scored after a void folds to the whole stream's outcome, voids resolved", async () => {
    const d = new FakeLeagueDriver();
    const id = await started(d);
    const stream = winStream(d, id);
    await d.postStream(id, stream.slice(0, 2), "p");
    const before = await d.fixtureState(id);
    expect(before.status).toBe("in_play");
    await d.voidLast(id);
    await d.postStream(id, stream.slice(1), "q");
    const f = d.fixtures[0]!;
    // [start, summary, void(summary), summary, summary]: the engine's fold of the same ledger says decided, home.
    expect(typesOf(f.events)).toEqual([START.type, SUMMARY, VOID_EVENT, SUMMARY, SUMMARY]);
    expect(foldStream(sportModule("badminton"), d.cfg, f.home_entrant_id!, f.away_entrant_id!, f.events).outcome).toEqual(f.outcome);
    expect(f.status).toBe("decided");
  });

  it("scheduleFixtureNow dates the fixture at the fake's clock and the row carries it; an unknown fixture is refused", async () => {
    const d = new FakeLeagueDriver();
    const id = await started(d);
    d.now = () => new Date("2031-03-04T05:06:07.000Z");
    expect(await d.scheduleFixtureNow(id)).toEqual({ scheduledAt: "2031-03-04T05:06:07.000Z" });
    expect(d.rows().find((r) => r.id === id)!.scheduled_at).toBe("2031-03-04T05:06:07.000Z");
    // The others stay undated: a row the harness never dated reads as undated.
    expect(d.rows().filter((r) => r.id !== id).every((r) => r.scheduled_at === undefined || r.scheduled_at === null)).toBe(true);
    await expect(d.scheduleFixtureNow("nope")).rejects.toThrow(/no fixture nope/);
  });
});

describe("the rule the console applies, as the product's text states it", () => {
  it("fixture-console.tsx offers the newest event that is not a core.void and has no void naming it, only while scoring and undecided", () => {
    const fc = src("apps/web/src/components/v2/fixture-console.tsx");
    expect(fc).toContain('.find((e) => e.type !== "core.void" && !events.some((v) => v.voids_event_id === e.id));');
    expect(fc).toContain('{lastVoidable && scoring && !decidedLock(live.status) ? (');
    expect(fc).toContain('onClick={() => send("core.void", { event_id: lastVoidable.id })}');
  });

  it("the route refuses a void of a void, of a voided entry and of an unknown one with its own code (assertUndoTarget), so the fakes' 'next newest' is the only voidable choice", () => {
    const sc = src("apps/web/src/server/usecases/scoring.ts");
    for (const code of ["UNDO_NOOP", "UNDO_TARGET_MISSING", "UNDO_ALREADY_VOIDED", "UNDO_NOT_UNDOABLE"]) expect(sc, code).toContain(`"${code}"`);
    expect(sc).toContain('if (target.type === "core.void") {');
  });
});

describe("VOIDPROOF (W1d Task 14, item 15e)", () => {
  it("is registered: 3 entrants, no canary, and the first score is on the browser's turn like every case's (padPolicy first)", () => {
    expect(voidProof.key).toBe("VOIDPROOF");
    expect(voidProof.entrantCount).toBe(VOID_PROOF_ENTRANTS);
    expect(voidProof.canaryCheck).toBeNull();
    expect(voidProof.padPolicy ?? "first").toBe("first");
  });

  it("empty case first: a league whose start seats no fixture fails both void checks with checked 0, and voids nothing", async () => {
    class Empty extends FakeLeagueDriver {
      override start() { this.stage!.status = "active"; return Promise.resolve({ division_id: "d1", status: "active", started: true, generated: 0 }); }
    }
    const d = new Empty();
    const r = await run(d);
    expect(d.fixtures).toHaveLength(0);
    expect(r.byId("void-ledger")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(r.byId("void-fold")).toMatchObject({ verdict: "fail", checked: 0 });
    expect(d.calls).not.toContain("voidLast");
  });

  it("over the http-shaped fake: the first fixture's event is voided and re-recorded, every fixture then decided as asked, and every check passes", async () => {
    const d = new FakeLeagueDriver();
    const r = await run(d);
    expect(r.checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`)).toEqual([]);
    // ONE void in the whole run, on the first fixture, after its first score event.
    expect(d.calls.filter((c) => c === "voidLast")).toHaveLength(1);
    const first = [...d.fixtures].sort((a, b) => (a.fixture_no ?? 0) - (b.fixture_no ?? 0))[0]!;
    const want = winStream(d, first.id);
    // The start and the first score event, the void, then the voided event posted AGAIN and the rest of the match.
    expect(typesOf(first.events)).toEqual([want[0]!.type, want[1]!.type, VOID_EVENT, want[1]!.type, ...want.slice(2).map((e) => e.type)]);
    expect(first.events[2]!.payload).toEqual({ event_id: "2" });
    expect(first.events.filter((e) => e.type === VOID_EVENT)).toHaveLength(1);
    // The other fixtures were scored once, with no void.
    for (const f of d.fixtures.filter((x) => x.id !== first.id)) expect(f.events.some((e) => e.type === VOID_EVENT), f.id).toBe(false);
    expect(d.fixtures.map((f) => f.status)).toEqual(d.fixtures.map(() => "decided"));
    expect(r.byId("void-ledger").checked).toBeGreaterThanOrEqual(6);
    expect(r.byId("void-fold").checked).toBeGreaterThanOrEqual(3);
    expect(r.state).toBe("works");
    // Every row the ledger holds was a post the harness made — the void and the re-recorded event included.
    const rows = d.fixtures.reduce((n, f) => n + f.events.length, 0);
    expect(rows).toBeGreaterThan(0);
    expect(r.out.events).toBe(rows);
  });

  it("over the pad-shaped fake (every event answered with the stored row): the same, and the voided row is the pad's own", async () => {
    const d = new FakePadDriver();
    const r = await run(d);
    expect(r.checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`)).toEqual([]);
    expect(r.byId("void-ledger")).toMatchObject({ verdict: "pass" });
    expect(r.byId("void-fold")).toMatchObject({ verdict: "pass" });
  });

  it("a void the product never made (the answer is right, the ledger has no void row): the play-on is refused over that ledger, and the proof's own findings ride in the error (VoidNotHeld)", async () => {
    class NeverVoids extends FakeLeagueDriver {
      override voidLast(id: string) {
        this.log("voidLast", id);
        // The right answer — the newest event — and nothing written.
        const f = this.fixtures.find((x) => x.id === id)!;
        return Promise.resolve({ voidedEventId: String(f.events.length), voidedType: f.events.at(-1)!.type });
      }
    }
    const e = await voidProof.run(ctxOf(new NeverVoids())).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(VoidNotHeld);
    const m = (e as VoidNotHeld).message;
    expect(m).toMatch(/void-ledger: /);
    expect(m).toMatch(/newest row is not a core\.void|ledger holds/);
    expect(m).toMatch(/void-fold: /);
    expect(m).toMatch(/refused/);
    expect((e as VoidNotHeld).checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["void-ledger", "void-fold"]);
  });

  it("a driver that voids the wrong event (the start, not the last one posted) fails the item that names the choice, whatever it reports", async () => {
    class VoidsTheStart extends FakeLeagueDriver {
      override voidLast(id: string) {
        this.log("voidLast", id);
        const f = this.fixtures.find((x) => x.id === id)!;
        // A void of seq 1 appended straight to the ledger, bypassing the fake's own rule.
        f.events = [...f.events, { type: VOID_EVENT, payload: { event_id: "1" } }];
        return Promise.resolve({ voidedEventId: "1", voidedType: f.events[0]!.type });
      }
    }
    const e = await voidProof.run(ctxOf(new VoidsTheStart())).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(VoidNotHeld);
    const c = (e as VoidNotHeld).checks.find((x) => x.id === "void-ledger")!;
    expect(c.verdict).toBe("fail");
    expect(c.evidence.join("\n")).toMatch(/last one the harness posted/);
  });

  it("a driver that reports a type other than the voided row's fails the item that compares them", async () => {
    class LiesAboutType extends FakeLeagueDriver {
      override async voidLast(id: string) {
        const real = await super.voidLast(id);
        return { ...real, voidedType: "core.note" };
      }
    }
    const r = await run(new LiesAboutType());
    expect(r.byId("void-ledger").verdict).toBe("fail");
    expect(r.byId("void-ledger").evidence.join("\n")).toMatch(/type/);
  });

  it("a ledger read that comes back stale (the void row missing) fails void-ledger", async () => {
    class StaleLedger extends FakeLeagueDriver {
      override async ledger(id: string, since = 0) {
        return (await super.ledger(id, since)).filter((r) => r.type !== VOID_EVENT);
      }
    }
    const r = await run(new StaleLedger());
    expect(r.byId("void-ledger").verdict).toBe("fail");
  });

  it("a driver with no ledger read cannot prove a void: void-ledger fails naming the gap (never an abstain, never a pass)", async () => {
    const d = new FakeLeagueDriver();
    // The instance's own `ledger` shadows the prototype's: a driver that does not implement the optional read.
    Object.defineProperty(d, "ledger", { value: undefined });
    const r = await run(d);
    expect(r.byId("void-ledger")).toMatchObject({ verdict: "fail" });
    expect(r.byId("void-ledger").evidence.join("\n")).toMatch(/no ledger read/);
    expect(r.byId("void-fold")).toMatchObject({ verdict: "fail" });
  });

  it("a first score event that decides the match is unfit — the console offers no Void last entry on a decided match — and is refused by name before any void", async () => {
    // single-sport: generic's one result decides the match; badminton's first game does not (the plan's sport).
    const d = new FakeLeagueDriver();
    const e = await voidProof.run(ctxOf(d, "generic")).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(VoidProofUnfit);
    expect((e as Error).message).toMatch(/generic/);
    expect(d.calls).not.toContain("voidLast");
  });

  it("a fixture the product holds events for that the harness never posted is refused by name, not folded over", async () => {
    class Foreign extends FakeLeagueDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
        // A row the harness never posted is already in the ledger (a cascade wrote it): the answers' seq runs ahead.
        const f = this.fixtures.find((x) => x.id === id)!;
        if (f.events.length === 0) f.events.push({ type: "core.note", payload: { text: "foreign" } });
        return super.postStream(id, events, prefix);
      }
    }
    const e = await voidProof.run(ctxOf(new Foreign())).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(VoidProofUnfit);
    expect((e as Error).message).toMatch(/holds events the harness never posted/);
  });

  it("a first score event the PRODUCT answers as deciding the match is refused by name before any void, whatever the generated stream says (the console offers none on a decided match)", async () => {
    class DecidesEarly extends FakeLeagueDriver {
      override async postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
        const posted = await super.postStream(id, events, prefix);
        return posted.map((p, i) => (i === posted.length - 1 ? { ...p, outcome: { kind: "win", winner: "x" } } : p));
      }
    }
    const d = new DecidesEarly();
    const e = await voidProof.run(ctxOf(d)).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(VoidProofUnfit);
    expect((e as Error).message).toMatch(/decides the match/);
    expect(d.calls).not.toContain("voidLast");
  });

  it("the proof is on the FIRST fixture decided: one already decided is refused by name before anything is posted (the resumed stream is generated for ordinal 0)", async () => {
    const d = new FakeLeagueDriver();
    const ctx = ctxOf(d);
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
    rec.decided = 1;
    const posts = d.calls.filter((c) => c === "postStream").length;
    await expect(postThenVoid(ctx, rec, setup)).rejects.toThrow(/already decided \(1\)/);
    expect(d.calls.filter((c) => c === "postStream")).toHaveLength(posts);
    expect(d.calls).not.toContain("voidLast");
  });
});

describe("firstOpenFixture / assertVoidable: which fixture the proof is on and which streams it can be proven on", () => {
  const fx = (id: string, round: number | null, no: number | null) => ({ id, round_no: round, fixture_no: no });

  it("the lowest fixture number of the lowest round, whatever order the rows come in; none open is null", () => {
    expect(firstOpenFixture([])).toBeNull();
    const rows = [fx("c", 2, 1), fx("b", 1, 9), fx("a", 1, 4), fx("d", 3, 0)];
    expect(firstOpenFixture(rows)?.id).toBe("a");
    expect(firstOpenFixture([...rows].reverse())?.id).toBe("a");
    // A fixture with no round or no number sorts as 0, as the run sheet does.
    expect(firstOpenFixture([fx("x", 1, 3), fx("y", null, null)])?.id).toBe("y");
    expect(firstOpenFixture([fx("x", 1, 3), fx("y", 1, null)])?.id).toBe("y");
  });

  it("a stream is voidable only with a start first and at least three events: each of the two conditions refuses on its own, by name", () => {
    const ev = (type: string): StreamEvent => ({ type, payload: {} });
    expect(() => assertVoidable("badminton", "win", [START, ev("a"), ev("b")])).not.toThrow();
    // Too short (generic's first result decides the match: [start, result]).
    expect(() => assertVoidable("generic", "win", [START, ev("a")])).toThrow(/its win stream is 2 event\(s\)/);
    expect(() => assertVoidable("generic", "win", [])).toThrow(VoidProofUnfit);
    // Long enough, but not opened with a start: the first score event would not be the second row.
    expect(() => assertVoidable("badminton", "win", [ev("a"), ev("b"), ev("c")])).toThrow(/its win stream is 3 event\(s\) \(a, b, c\)/);
  });
});

describe("voidLedger / voidFold on their own: what each item holds the product to", () => {
  const rowOf = (seq: number, type: string, payload: unknown = {}) => ({ id: `r${seq}`, seq, type, payload });
  const state = (over: Partial<FixtureStateOut> = {}): FixtureStateOut => ({ status: "in_play", last_seq: 3, outcome: null, ...over });
  const cfg = resolveSportCfg("badminton", offlineBuilderDefault("badminton"));
  const held: StreamEvent[] = [START, { type: SUMMARY, payload: { home: 21, away: 0 } }];
  const good = (): VoidProofObs => ({
    fixtureId: "f1", home: "H", away: "A", held,
    rows: [rowOf(1, "core.start"), rowOf(2, SUMMARY, { home: 21, away: 0 }), rowOf(3, VOID_EVENT, { event_id: "r2" })],
    voided: { voidedEventId: "r2", voidedType: SUMMARY },
    state: state(),
  });

  it("the good observation passes every item of both checks (the positive pair for each negative below)", () => {
    expect(voidLedger(good())).toMatchObject({ verdict: "pass", checked: 6 });
    expect(voidFold("badminton", cfg, good())).toMatchObject({ verdict: "pass", checked: 3 });
  });

  it("void-ledger: each item fails on its own — tip not advanced by one, newest not a void, wrong id named, wrong event, wrong type, state not open", () => {
    const base = good();
    const bad: [string, VoidProofObs, RegExp][] = [
      ["no new row", { ...base, rows: base.rows!.slice(0, 2), state: state({ last_seq: 2 }) }, /ledger holds 2 row\(s\)/],
      ["newest not a void", { ...base, rows: [base.rows![0]!, base.rows![1]!, rowOf(3, SUMMARY)] }, /newest row is not a core\.void/],
      ["names another id", { ...base, rows: [base.rows![0]!, base.rows![1]!, rowOf(3, VOID_EVENT, { event_id: "r1" })] }, /names r1, voidLast reported r2/],
      ["reports another id", { ...base, voided: { voidedEventId: "r1", voidedType: "core.start" } }, /last one the harness posted/],
      ["reports another type", { ...base, voided: { voidedEventId: "r2", voidedType: "core.note" } }, /type/],
      ["state moved on", { ...base, state: state({ last_seq: 9 }) }, /last_seq 9/],
      ["state decided", { ...base, state: state({ status: "decided" }) }, /decided/],
      ["state has an outcome", { ...base, state: state({ outcome: { kind: "win", winner: "H" } }) }, /outcome/],
    ];
    for (const [name, obs, why] of bad) {
      const c = voidLedger(obs);
      expect(c.verdict, name).toBe("fail");
      expect(c.evidence.join("\n"), name).toMatch(why);
      expect(c.checked, name).toBeGreaterThan(0);
    }
  });

  it("void-fold: the ledger's fold equals the fold of the stream before the event, and DIFFERS from the one with it — a void that moved nothing proves nothing", () => {
    // The with-event and without-event folds differ: the first game (21-0) is a game won.
    const m = sportModule("badminton");
    const withEvent = JSON.stringify(m.summary(foldStream(m, cfg, "H", "A", held).state));
    const without = JSON.stringify(m.summary(foldStream(m, cfg, "H", "A", held.slice(0, 1)).state));
    expect(withEvent).not.toBe(without);
    // A ledger with no void folds to the with-event score: item 1 fails.
    const unvoided = { ...good(), rows: good().rows!.slice(0, 2) };
    expect(voidFold("badminton", cfg, unvoided).verdict).toBe("fail");
    // A "score event" that changes nothing (a note) is voided: the fold equals the prefix's, but so does the fold WITHOUT the void.
    const note: StreamEvent = { type: "core.note", payload: { text: "x" } };
    const moved = voidFold("badminton", cfg, {
      ...good(), held: [START, note],
      rows: [rowOf(1, "core.start"), rowOf(2, "core.note", { text: "x" }), rowOf(3, VOID_EVENT, { event_id: "r2" })],
    });
    expect(moved.verdict).toBe("fail");
    expect(moved.evidence.join("\n")).toMatch(/moved nothing|did not change/);
  });

  it("void-fold: each item fails on its own — a ledger that folds to a THIRD score fails only the first, an unvoided one fails the first AND the third", () => {
    // held: [start, 21-0]; before = nothing played, with = the home side a game up. This ledger voids the 21-0 and
    // holds a 0-21 instead: neither score, so only the equality with the score before the event fails.
    const third = voidFold("badminton", cfg, { ...good(), rows: [rowOf(1, "core.start"), rowOf(2, SUMMARY, { home: 21, away: 0 }), rowOf(3, SUMMARY, { home: 0, away: 21 }), rowOf(4, VOID_EVENT, { event_id: "r2" })] });
    expect(third).toMatchObject({ verdict: "fail", checked: 3 });
    expect(third.evidence).toHaveLength(1);
    expect(third.evidence[0]).toMatch(/the ledger folds to .* the score before the event is /);
    // No void at all: the fold is the score WITH the event — it differs from the one before and equals the one with.
    const unvoided = voidFold("badminton", cfg, { ...good(), rows: good().rows!.slice(0, 2) });
    expect(unvoided).toMatchObject({ verdict: "fail", checked: 3 });
    expect(unvoided.evidence).toHaveLength(2);
    expect(unvoided.evidence.join("\n")).toMatch(/the ledger folds to /);
    expect(unvoided.evidence.join("\n")).toMatch(/still folds to the score with the event/);
  });

  it("void-fold: a ledger the engine refuses (a void naming an unknown event) is a failing item carrying the engine's words, not a crash; no ledger read is a named failure", () => {
    const refused = voidFold("badminton", cfg, { ...good(), rows: [rowOf(1, "core.start"), rowOf(2, SUMMARY, { home: 21, away: 0 }), rowOf(3, VOID_EVENT, { event_id: "zzz" })] });
    expect(refused.verdict).toBe("fail");
    expect(refused.evidence.join("\n")).toMatch(/targets unknown or non-prior event/);
    const none = voidFold("badminton", cfg, { ...good(), rows: null });
    expect(none).toMatchObject({ verdict: "fail" });
    expect(none.evidence.join("\n")).toMatch(/no ledger read/);
  });
});

describe("decideFixture resumes a fixture the scenario started (common.ts Recorder.resumed)", () => {
  /** A fixture with [start, first game] posted and the first game voided, the way VOIDPROOF leaves it. */
  async function leftVoided() {
    const d = new FakeLeagueDriver();
    const ctx = ctxOf(d);
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
    const f = d.fixtures[0]!;
    const want = winStream(d, f.id);
    const first = want.slice(0, 2);
    await d.postStream(f.id, first, "p");
    await d.voidLast(f.id);
    rec.streams.set(f.id, [...first, { type: VOID_EVENT, payload: { event_id: "2" } }]);
    return { d, ctx, rec, setup, f, want, first };
  }

  it("posts only what is not yet live — the voided event again and the rest — never the start twice, and folds the whole ledger with its void", async () => {
    const { d, ctx, rec, setup, f, want } = await leftVoided();
    rec.resumed.set(f.id, { outcome: { kind: "win", winner: "home" }, live: 1, voidedType: want[1]!.type });
    await decideFixture(ctx, rec, setup, d.rows().find((r) => r.id === f.id)!, { kind: "win", winner: "away" });
    // The resumed outcome wins over the policy's: a fixture the scenario started is finished as it was started.
    expect(typesOf(d.fixtures[0]!.events)).toEqual([want[0]!.type, want[1]!.type, VOID_EVENT, ...want.slice(1).map((e) => e.type)]);
    expect(d.fixtures[0]!.outcome).toMatchObject({ kind: "win", winner: f.home_entrant_id });
    expect(rec.parity.at(-1)).toMatchObject({ fixtureId: f.id, foreign: 0, request: "match" });
    // The harness's own record folds to what the product holds.
    expect(rec.parity.at(-1)!.local).toEqual(rec.parity.at(-1)!.product);
  });

  it("a prefix that is not the generated one is refused by name before anything is posted (ResumeMismatch)", async () => {
    const { d, ctx, rec, setup, f, want } = await leftVoided();
    // The scenario claims 2 events live; only the start is.
    rec.resumed.set(f.id, { outcome: { kind: "win", winner: "home" }, live: 2, voidedType: want[1]!.type });
    const before = d.fixtures[0]!.events.length;
    await expect(decideFixture(ctx, rec, setup, d.rows().find((r) => r.id === f.id)!, { kind: "win", winner: "home" })).rejects.toBeInstanceOf(ResumeMismatch);
    expect(d.fixtures[0]!.events).toHaveLength(before);
    // …and so is a voided type that is not the next event the stream would send.
    rec.resumed.set(f.id, { outcome: { kind: "win", winner: "home" }, live: 1, voidedType: "core.note" });
    await expect(decideFixture(ctx, rec, setup, d.rows().find((r) => r.id === f.id)!, { kind: "win", winner: "home" })).rejects.toBeInstanceOf(ResumeMismatch);
    expect(d.fixtures[0]!.events).toHaveLength(before);
  });

  it("a resume that claims NOTHING live is refused by name even when the stream's first event is the one it says it voided: a void follows an event that is live", async () => {
    const d = new FakeLeagueDriver();
    const ctx = ctxOf(d);
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
    const f = d.fixtures[0]!;
    // Nothing recorded for the fixture, so an empty prefix "matches" the empty lead: only the live >= 1 rule refuses it.
    rec.resumed.set(f.id, { outcome: { kind: "win", winner: "home" }, live: 0, voidedType: START.type });
    await expect(decideFixture(ctx, rec, setup, d.rows().find((r) => r.id === f.id)!, { kind: "win", winner: "home" })).rejects.toThrow(/\(0 claimed live\)/);
    expect(d.fixtures[0]!.events).toEqual([]);
  });

  it("a fixture nobody resumed is decided exactly as before: the whole generated stream, once", async () => {
    const d = new FakeLeagueDriver();
    const ctx = ctxOf(d);
    const rec = new Recorder();
    const setup = await setUpDivision(ctx, rec, VOID_PROOF_ENTRANTS, { rosterlessTeams: true });
    const f = d.fixtures[0]!;
    await decideFixture(ctx, rec, setup, d.rows()[0]!, { kind: "win", winner: "home" });
    expect(typesOf(d.fixtures[0]!.events)).toEqual(typesOf(winStream(d, f.id)));
    expect(rec.resumed.size).toBe(0);
  });
});

describe("recordPosted: what the harness keeps of a post — the rows the product stored, else the events it sent (common.ts, shared by decideFixture and VOIDPROOF)", () => {
  const ev = (type: string): StreamEvent => ({ type, payload: {} });
  const sent = [ev("a"), ev("b")];
  const ans = (seq: number, stored?: { type: string; payload: unknown }): PostedEvent => ({ seq, status: "in_play", outcome: null, event_id: `e${seq}`, ...(stored === undefined ? {} : { stored }) });

  it("no row carries the stored shape: the harness keeps what it sent, after what it already held", () => {
    const rec = new Recorder();
    const whole = recordPosted(rec, "f1", [ev("start")], sent, [ans(2), ans(3)]);
    expect(whole.map((e) => e.type)).toEqual(["start", "a", "b"]);
    expect(rec.streams.get("f1")).toBe(whole);
    expect(rec.storedFixtures.has("f1")).toBe(false);
  });

  it("every row carries the stored shape: the harness keeps the STORED rows, not what it sent, and marks the fixture stored", () => {
    const rec = new Recorder();
    const whole = recordPosted(rec, "f1", [], sent, [ans(1, { type: "x", payload: { n: 1 } }), ans(2, { type: "y", payload: { n: 2 } })]);
    expect(whole).toEqual([{ type: "x", payload: { n: 1 } }, { type: "y", payload: { n: 2 } }]);
    expect(rec.storedFixtures.has("f1")).toBe(true);
  });

  it("only some rows carry the stored shape: refused by name (a driver answers every event from the ledger, or none), and nothing is recorded", () => {
    const rec = new Recorder();
    expect(() => recordPosted(rec, "f1", [], sent, [ans(1, { type: "x", payload: {} }), ans(2)])).toThrow(/1 of 2 answered event\(s\) carry the stored row/);
    expect(rec.streams.has("f1")).toBe(false);
  });

  it("an empty answer for a non-empty post folds nothing, and a note says so; an empty post with an empty answer is no note", () => {
    const rec = new Recorder();
    expect(recordPosted(rec, "f1", [], sent, [])).toEqual([]);
    expect(rec.notes.join("\n")).toMatch(/f1: the driver answered no event for the 2 sent/);
    const quiet = new Recorder();
    expect(recordPosted(quiet, "f2", [], [], [])).toEqual([]);
    expect(quiet.notes).toEqual([]);
  });

  it("a post that landed on a SEQ_CONFLICT retry is traced, not silent", () => {
    const rec = new Recorder();
    recordPosted(rec, "f1", [], sent, [ans(1), { ...ans(2), retried: true }]);
    expect(rec.notes.join("\n")).toMatch(/f1: 1 event\(s\) landed on a SEQ_CONFLICT retry/);
  });
});

describe("liveEvents: the harness's stream with its voids resolved (a void names its target by seq, as fold.ts numbers it)", () => {
  const ev = (type: string, payload: unknown = {}): StreamEvent => ({ type, payload });
  it("drops a core.void and the event it names; keeps the rest in order; an empty stream is empty", () => {
    expect(liveEvents([])).toEqual([]);
    const stream = [ev("core.start"), ev("a"), ev(VOID_EVENT, { event_id: "2" }), ev("a")];
    expect(liveEvents(stream).map((e) => e.type)).toEqual(["core.start", "a"]);
    // The kept `a` is the 4th event, not the voided 2nd: the live stream is [1, 4].
    expect(liveEvents(stream)).toEqual([stream[0], stream[3]]);
  });
  it("a void naming a later or unknown seq voids nothing live; two voids resolve two events", () => {
    const stream = [ev("core.start"), ev("a"), ev("b"), ev(VOID_EVENT, { event_id: "3" }), ev(VOID_EVENT, { event_id: "2" })];
    expect(liveEvents(stream).map((e) => e.type)).toEqual(["core.start"]);
    expect(liveEvents([ev("core.start"), ev(VOID_EVENT, { event_id: "99" })]).map((e) => e.type)).toEqual(["core.start"]);
  });
});
