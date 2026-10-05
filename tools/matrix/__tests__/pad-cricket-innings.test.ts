// Cricket, two innings a side, on the pad (W1d Task 12, item 16; D13 of the
// W1-driving plan). The committed `test` preset is two innings a side, and its
// generator streams (ruling 44) hold a declared innings, a follow-on and a
// time-expiry draw: events the single-innings route refused by name, which left
// the 24 cricket `test` cases proven over HTTP only.
//
// Expected values come from the engine (the folds, eventSchemas, padSpec, the
// chase target found by asking the engine when an innings closes), from the
// skins' source text, and from the committed cricket `test` cases (the w1drv-l3
// run's case ids, the catalogue's overrides) — never from lib/pads.
//
// The rule (brief, Step 0): an event the skin offers no control for is a 🚫
// naming the owning wave, not a route. The skin builds a `declare` tile, so a
// declared innings is a route. It builds none for the follow-on or the
// time-expiry draw, which are rows of the generic More sheet, and a row there
// has no testid for any tap to address: both are declared `noControl`.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cricket } from "@seazn/engine/sports/cricket";
import { beforeAll, describe, expect, it } from "vitest";
import { START_MATCH_TESTID, selectorForTapStep, type TapAdapterContext } from "../../bench/lib/drivers/scorer.ts";
import type { LedgerRow } from "../../bench/lib/ledger.ts";
import { WAVE_ID } from "../lib/routing.ts";
import { foldStream } from "../lib/fold.ts";
import {
  CRICKET_DECLARE, CRICKET_DECLARE_TILE, CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE, CRICKET_NO_CONTROL, CRICKET_OVER_TILE, CRICKET_SUMMARY, cricketPad, makeCricketPad,
} from "../lib/pads/cricket.ts";
import { drawsAllowed, resolveSportCfg } from "../lib/sport-cfg.ts";
import { generateStream, matchesRequest } from "../lib/streams/index.ts";
import { GeneratorUnsupported, OutcomeUnreachable, START, type RequestedOutcome, type StreamEvent, type StreamRequest } from "../lib/streams/types.ts";
import { replayOnModel, type RowIn } from "./pad-model.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPTS = join(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts");
const SKINS = "apps/web/src/components/v2/scorepad/v3";
const HOME = "e-home";
const AWAY = "e-away";

const TEST_CFG = resolveSportCfg("cricket", "test") as { ballsPerOver: number; ballsPerInnings: number | null; inningsPerSide: number };
const req = (cfg: unknown, outcome: RequestedOutcome): StreamRequest => ({ sportKey: "cricket", cfg, stageKind: "league", home: HOME, away: AWAY, outcome });
const ctxOf = (cfg: unknown): TapAdapterContext => ({ cfg, entrants: { home: HOME, away: AWAY } });
const WIN_HOME: RequestedOutcome = { kind: "win", winner: "home" };
const WIN_AWAY: RequestedOutcome = { kind: "win", winner: "away" };
const DRAW: RequestedOutcome = { kind: "draw" };
const TIE: RequestedOutcome = { kind: "tie" };
const stream = (cfg: unknown, o: RequestedOutcome): StreamEvent[] => generateStream(req(cfg, o));
const summaries = (evs: readonly StreamEvent[]) => evs.filter((e) => e.type === CRICKET_SUMMARY);
const sum = (runs: number, wickets: number, legalBalls: number, extra: Record<string, unknown> = {}): StreamEvent => ({ type: CRICKET_SUMMARY, payload: { runs, wickets, legalBalls, ...extra } });

const TILE = (tileId: string) => selectorForTapStep({ kind: "tile", tileId });
const START_SEL = selectorForTapStep({ kind: "testid", testid: START_MATCH_TESTID });
const NUM_SEL = selectorForTapStep({ kind: "number", value: 0 });
const CONFIRM_SEL = selectorForTapStep({ kind: "confirm" });
const numberOf = (tap: string): number | null => (tap.startsWith(`${NUM_SEL}=`) ? Number(tap.slice(NUM_SEL.length + 1)) : null);
const asEvents = (rows: readonly (LedgerRow | RowIn)[]): StreamEvent[] => rows.map((r) => ({ type: r.type, payload: r.payload }));
interface InningsLike { runs: number; wickets: number; legalBalls: number; closed: boolean; declared?: boolean }
const inningsOfState = (state: unknown): InningsLike[] => (state as { innings?: InningsLike[] }).innings ?? [];

/** cricket as Step 0 saw it (2026-09-30, 320): an over sheet is the overSummary
 *  tile, then runs, wickets and balls, each a number and a confirm, and writes
 *  ONE row — this over added onto the fold's open innings (0/0/0 when none is
 *  open), `partial: true`. Once the engine has an outcome the tile is gone. Two
 *  innings a side add the `declare` tile (cricket.tsx:1506-1511, an `{event}`
 *  tile that HOLDS until the replay's release): it sends the engine's
 *  declaration while an innings is open, and nothing otherwise (closedTile). */
function twoInningsModel(ctx: TapAdapterContext) {
  return (taps: readonly string[], ledger: readonly LedgerRow[]): RowIn[] => {
    if (taps.length === 1 && taps[0] === START_SEL) return [{ type: "core.start", payload: {} }];
    const out: RowIn[] = [];
    for (let i = 0; i < taps.length;) {
      const folded = foldStream(cricket, ctx.cfg, ctx.entrants.home, ctx.entrants.away, asEvents([...ledger, ...out]));
      const open = inningsOfState(folded.state).find((x) => !x.closed);
      if (taps[i] === TILE(CRICKET_DECLARE_TILE)) {
        if (folded.outcome !== null || open === undefined) return out;
        out.push({ type: CRICKET_DECLARE, payload: {} });
        i++;
        continue;
      }
      const c = taps.slice(i, i + 7);
      const [r, typedW, b] = [numberOf(c[1] ?? ""), numberOf(c[3] ?? ""), numberOf(c[5] ?? "")];
      if (c[0] !== TILE(CRICKET_OVER_TILE) || c[2] !== CONFIRM_SEL || c[4] !== CONFIRM_SEL || c[6] !== CONFIRM_SEL || r === null || typedW === null || b === null) return out;
      if (folded.outcome !== null) return out;
      const base = open ?? { runs: 0, wickets: 0, legalBalls: 0 };
      out.push({ type: CRICKET_SUMMARY, payload: { runs: base.runs + r, wickets: base.wickets + typedW, legalBalls: base.legalBalls + b, partial: true } });
      i += 7;
    }
    return out;
  };
}

/** The runs the last innings needs, found by asking the ENGINE: the smallest
 *  total at which a 4th innings of one ball closes itself, given the first
 *  three (a partial summary closes only through autoClose, and the match is
 *  decided as it closes). Never typed, never the adapter's own arithmetic. */
function engineChaseTarget(cfg: unknown, firstThree: readonly StreamEvent[]): number {
  for (let runs = 0; runs <= 5000; runs++) {
    const folded = foldStream(cricket, cfg, HOME, AWAY, [...firstThree, sum(runs, 0, 1, { partial: true })]);
    if (folded.outcome !== null) return runs;
  }
  throw new Error("the engine never closed a fourth innings by a chase");
}

describe("cricket two innings a side — the over route (W1d item 16)", () => {
  it("inningsPerSide 2 is accepted (core.start, then an innings' over sheets); one stays accepted; any other value is refused by name", () => {
    expect(TEST_CFG.inningsPerSide).toBe(2); // the preset really is two innings a side
    const pad = makeCricketPad();
    const ctx = ctxOf(TEST_CFG);
    expect(pad.stepsFor(START, ctx)).toEqual([{ kind: "testid", testid: START_MATCH_TESTID }]);
    const evs = stream(TEST_CFG, WIN_AWAY);
    expect(pad.stepsFor(summaries(evs)[0]!, ctx).length).toBeGreaterThan(0);
    // One innings a side keeps working (the builder default).
    const one = resolveSportCfg("cricket", "t20");
    const p1 = makeCricketPad();
    p1.stepsFor(START, ctxOf(one));
    expect(p1.stepsFor(summaries(stream(one, WIN_HOME))[0]!, ctxOf(one)).length).toBeGreaterThan(0);
    let refused = 0;
    for (const bad of [0, 3, undefined, "2", null]) {
      const p = makeCricketPad();
      const c = ctxOf({ ...TEST_CFG, inningsPerSide: bad });
      p.stepsFor(START, c);
      expect(() => p.stepsFor(summaries(evs)[0]!, c), String(bad)).toThrow(/inningsPerSide .* — the over route covers one or two innings a side/);
      refused++;
    }
    expect(refused).toBe(5);
  });

  it("a chase over four innings: the over sheets, the pad's rows and the engine's fold agree — four fallbacks, no finding, the requested outcome; the home win is the follow-on shape, which the pad cannot write", async () => {
    let checked = 0;
    let barred = 0;
    for (const outcome of [WIN_AWAY, TIE, WIN_HOME]) {
      const cfg = resolveSportCfg("cricket", "test", { ballsPerInnings: 12 }) as typeof TEST_CFG; // 2 overs an innings: small, and still several sheets
      const evs = stream(cfg, outcome);
      const at = JSON.stringify(outcome);
      if (evs.some((e) => e.type === CRICKET_FOLLOW_ON || e.type === CRICKET_MATCH_CLOSE)) {
        // The generator's home win is an innings victory after the follow-on: noControl, scored over http.
        expect(outcome, at).toBe(WIN_HOME);
        expect(evs.map((e) => e.type), at).toEqual(["core.start", CRICKET_SUMMARY, CRICKET_SUMMARY, CRICKET_FOLLOW_ON, CRICKET_SUMMARY]);
        barred++;
        continue;
      }
      const pad = makeCricketPad();
      const { res, ledger } = await replayOnModel(pad, evs, ctxOf(cfg), twoInningsModel(ctxOf(cfg)));
      expect(res.findings, at).toEqual([]);
      expect(res.rows.map((x) => x.verdict), at).toEqual(["equal", "fallback", "fallback", "fallback", "fallback"]);
      for (const row of res.rows.slice(1)) expect(row.stored.length, at).toBe(Math.ceil((row.expected.payload as { legalBalls: number }).legalBalls / cfg.ballsPerOver));
      expect(matchesRequest(req(cfg, outcome), foldStream(cricket, cfg, HOME, AWAY, asEvents(ledger)).outcome), at).toBe("match");
      checked++;
    }
    expect({ checked, barred }).toEqual({ checked: 2, barred: 1 }); // away win and tie; the follow-on home win
  });

  it("the chase is the FOURTH innings and its target is the engine's: a total past it before the last over is refused naming the engine's own target, and the exact target passes", () => {
    const cfg = resolveSportCfg("cricket", "test");
    const evs = stream(cfg, WIN_AWAY);
    const [i1, i2, i3] = summaries(evs);
    const target = engineChaseTarget(cfg, evs.slice(0, 4)); // START, i1, i2, i3
    const naive = (i1!.payload as { runs: number }).runs + 1; // the single-innings rule: the first innings' runs + 1
    expect(target, "the case cannot witness the aggregate rule if it equals the single-innings one").not.toBe(naive);
    // The same target, from the engine's own numbers: opposing aggregate − own + 1.
    const runs = (e: StreamEvent | undefined) => (e!.payload as { runs: number }).runs;
    expect(target).toBe(runs(i1) + runs(i3) - runs(i2) + 1);
    const ready = (): ReturnType<typeof makeCricketPad> => {
      const p = makeCricketPad();
      p.stepsFor(START, ctxOf(cfg));
      for (const e of [i1, i2, i3]) p.stepsFor(e!, ctxOf(cfg));
      return p;
    };
    expect(() => ready().stepsFor(sum(target * 2, 3, 60), ctxOf(cfg))).toThrow(new RegExp(`the chase passes its target \\(${target}\\) at over \\d+ of 10`));
    expect(() => ready().stepsFor(sum(naive * 2, 3, 60), ctxOf(cfg))).toThrow(/the chase passes its target/);
    expect(ready().stepsFor(sum(target, 3, 60), ctxOf(cfg)).length).toBe(10 * 7);
    // One run short of the target does not close itself, so the pad refuses to leave it open.
    expect(() => ready().stepsFor(sum(target - 1, 3, 60), ctxOf(cfg))).toThrow(/innings 4 would stay open/);
    // A fifth innings is refused by name.
    const done = ready();
    done.stepsFor(sum(target, 3, 60), ctxOf(cfg));
    expect(() => done.stepsFor(sum(1, 0, 6), ctxOf(cfg))).toThrow(/a fifth innings .* two-innings cricket has four/);
  });

  it("a declared innings is the over sheets and then the declare tile: rowsFor counts the declaration's row, the fold of what the pad wrote equals the fold of what was generated", async () => {
    const cfg = TEST_CFG; // no quota: the innings stays open until declared
    const draw = stream(cfg, DRAW);
    expect(draw.at(-1)!.type).toBe(CRICKET_MATCH_CLOSE);
    const prefix = draw.slice(0, -1); // up to the time-expiry draw: that event is noControl
    const declaredAt = prefix.findIndex((e) => (e.payload as { declared?: boolean }).declared === true);
    expect(declaredAt, "the draw stream holds a declared innings").toBeGreaterThan(0);
    const declared = prefix[declaredAt]!;
    const decl = cricketPad.fallbacks[0]!;
    const overs = Math.ceil((declared.payload as { legalBalls: number }).legalBalls / cfg.ballsPerOver);
    const pad = makeCricketPad();
    pad.stepsFor(START, ctxOf(cfg));
    for (const e of prefix.slice(1, declaredAt)) pad.stepsFor(e, ctxOf(cfg));
    const steps = pad.stepsFor(declared, ctxOf(cfg));
    expect(steps).toHaveLength(overs * 7 + 1);
    expect(steps.at(-1)).toEqual({ kind: "tile", tileId: CRICKET_DECLARE_TILE });
    expect(steps.slice(0, -1).every((s, i) => (i % 7 === 0 ? s.kind === "tile" && s.tileId === CRICKET_OVER_TILE : s.kind === "number" || s.kind === "confirm"))).toBe(true);
    expect(decl.rowsFor(declared, ctxOf(cfg))).toBe(overs + 1);
    expect(decl.writes).toContain(CRICKET_DECLARE);
    // Through the real replay, on the model, to the end of the prefix (the 4th innings is a partial one).
    const { res, ledger } = await replayOnModel(makeCricketPad(), prefix, ctxOf(cfg), twoInningsModel(ctxOf(cfg)));
    expect(res.findings).toEqual([]);
    expect(res.rows.map((x) => x.verdict)).toEqual(["equal", "fallback", "fallback", "fallback", "fallback"]);
    expect(res.rows[declaredAt]!.stored.map((r) => r.type)).toEqual([...Array.from({ length: overs }, () => CRICKET_SUMMARY), CRICKET_DECLARE]);
    expect(res.rows[declaredAt]!.stored.at(-1)!.payload).toEqual({});
    // The engine reads the pad's rows as the generated stream: the same four innings, the declared one declared.
    const want = inningsOfState(foldStream(cricket, cfg, HOME, AWAY, prefix).state);
    const got = inningsOfState(foldStream(cricket, cfg, HOME, AWAY, asEvents(ledger)).state);
    const shape = (xs: InningsLike[]) => xs.map((x) => ({ runs: x.runs, wickets: x.wickets, legalBalls: x.legalBalls, closed: x.closed, declared: x.declared === true }));
    expect(shape(want)).toHaveLength(4);
    expect(shape(got)).toEqual(shape(want));
    expect(shape(got)[declaredAt - 1]).toMatchObject({ closed: true, declared: true }); // the third innings
    expect(shape(got)[3]).toMatchObject({ closed: false, declared: false }); // the partial one stays open
  });

  it("the declared-innings judge: the declaration row must be a cricket.innings.declare with an empty payload and the over rows before it; each break is named", () => {
    const cfg = TEST_CFG;
    const declared = sum(200, 4, 540, { declared: true });
    const judge = cricketPad.fallbacks[0]!.judge!;
    const over = (n: number, payload: unknown, type = CRICKET_SUMMARY): LedgerRow => ({ id: `r${n}`, seq: n, type, payload });
    const last = over(2, { runs: 200, wickets: 4, legalBalls: 540, partial: true });
    const decl = over(3, {}, CRICKET_DECLARE);
    expect(cfg.ballsPerOver).toBeGreaterThan(0);
    expect(judge(declared, [over(1, { runs: 0, wickets: 0, legalBalls: 6, partial: true }), last, decl])).toEqual({ ok: true, note: null });
    expect(judge(declared, [last])).toEqual({ ok: false, note: `the declared innings ends in a ${CRICKET_SUMMARY} row, not a ${CRICKET_DECLARE} row` });
    expect(judge(declared, [])).toEqual({ ok: false, note: `the declared innings ends in no row, not a ${CRICKET_DECLARE} row` });
    expect(judge(declared, [last, over(3, { by: "x" }, CRICKET_DECLARE)])).toEqual({ ok: false, note: `the ${CRICKET_DECLARE} row carries {"by":"x"}, not an empty payload` });
    expect(judge(declared, [decl])).toEqual({ ok: false, note: "no over row stored for the innings" });
    expect(judge(declared, [over(1, { runs: 1, wickets: 4, legalBalls: 540, partial: true }), decl])).toEqual({ ok: false, note: "the last of 1 over rows: runs: stored 1, generated 200" });
    // Without a declaration the same rows are judged as before: an extra declare row is not part of that innings.
    expect(judge(sum(200, 4, 540), [last, decl])).toEqual({ ok: false, note: `a ${CRICKET_DECLARE} row among the innings' over rows` });
  });

  it("a declared or partial summary the over sheets would close by themselves is refused by name — the declare tile is disabled on a closed innings; each guard has its positive pair", () => {
    const quota = resolveSportCfg("cricket", "test", { ballsPerInnings: 12 });
    const allOut = (cricket.padSpec?.(quota as never)?.panels.flatMap((p) => p.actions).find((a) => a.type === CRICKET_SUMMARY)?.fields.find((f) => f.path === "wickets") as { max: number }).max;
    const start = (cfg: unknown) => { const p = makeCricketPad(); p.stepsFor(START, ctxOf(cfg)); return p; };
    // Declared at the quota: the balls close it first.
    expect(() => start(quota).stepsFor(sum(200, 4, 12, { declared: true }), ctxOf(quota))).toThrow(/innings 1 would close itself .* declare tile is disabled on it/);
    expect(start(quota).stepsFor(sum(200, 4, 11, { declared: true }), ctxOf(quota)).at(-1)).toEqual({ kind: "tile", tileId: CRICKET_DECLARE_TILE });
    // Declared all out: the wickets close it first.
    expect(() => start(TEST_CFG).stepsFor(sum(200, allOut, 540, { declared: true }), ctxOf(TEST_CFG))).toThrow(/would close itself/);
    expect(start(TEST_CFG).stepsFor(sum(200, allOut - 1, 540, { declared: true }), ctxOf(TEST_CFG)).at(-1)).toEqual({ kind: "tile", tileId: CRICKET_DECLARE_TILE });
    // A partial summary leaves the innings open, so the same two closes refuse it.
    expect(() => start(quota).stepsFor(sum(100, 3, 12, { partial: true }), ctxOf(quota))).toThrow(/innings 1 would close itself .* partial summary cannot leave it open/);
    expect(start(quota).stepsFor(sum(100, 3, 11, { partial: true }), ctxOf(quota)).length).toBeGreaterThan(0);
    // A partial summary, once tapped, leaves the innings open: a later summary would add to it, which the generator never builds.
    const open = start(quota);
    open.stepsFor(sum(100, 3, 11, { partial: true }), ctxOf(quota));
    expect(() => open.stepsFor(sum(150, 3, 12), ctxOf(quota))).toThrow(/after a partial one/);
    // Both flags together, a declaration on one innings a side, and a flag that is not `true`.
    expect(() => start(quota).stepsFor(sum(100, 3, 6, { partial: true, declared: true }), ctxOf(quota))).toThrow(/at most one of declared: true/);
    const one = resolveSportCfg("cricket", "t20");
    expect(() => start(one).stepsFor(sum(100, 3, 60, { declared: true }), ctxOf(one))).toThrow(/is not \{runs, wickets, legalBalls\}/);
    expect(() => start(quota).stepsFor(sum(100, 3, 6, { declared: false }), ctxOf(quota))).toThrow(/is not \{runs, wickets, legalBalls\}/);
  });

  it("follow-on and the time-expiry draw have NO route: both are declared noControl, route to an open wave, are refused by name, and the product premise is pinned (the skin builds no tile, the More sheet's rows carry no testid)", () => {
    expect(cricketPad.noControl).toBeDefined();
    expect([...cricketPad.noControl!.eventTypes].sort()).toEqual([CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE].sort());
    expect(cricketPad.noControl!.route).toBe(CRICKET_NO_CONTROL);
    expect(Object.isFrozen(CRICKET_NO_CONTROL)).toBe(true);
    expect(CRICKET_NO_CONTROL.wave).toMatch(WAVE_ID);
    // Both are what the engine declares as pad actions for a two-innings cfg (so the More sheet DOES carry them).
    const actions = cricket.padSpec?.(TEST_CFG as never)?.panels.flatMap((p) => p.actions.map((a) => a.type)) ?? [];
    for (const t of [CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE, CRICKET_DECLARE]) expect(actions, t).toContain(t);
    for (const t of [CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE, CRICKET_DECLARE, CRICKET_SUMMARY]) expect(Object.keys(cricket.eventSchemas ?? {}), t).toContain(t);
    for (const t of [CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE]) {
      const pad = makeCricketPad();
      expect(() => pad.stepsFor({ type: t, payload: {} }, ctxOf(TEST_CFG)), t).toThrow(new RegExp(`${t.replace(/\./g, "\\.")} has no addressable pad control \\(→ ${CRICKET_NO_CONTROL.wave}:`));
    }
    // The premise, from the product's text: if the skin grows a control, or the More sheet's rows get a testid, this reds and the route is owed.
    const skin = readFileSync(join(REPO, SKINS, "skins/cricket.tsx"), "utf8");
    const form = readFileSync(join(REPO, SKINS, "action-form.tsx"), "utf8");
    for (const t of [CRICKET_FOLLOW_ON, CRICKET_MATCH_CLOSE]) {
      expect(skin, `cricket.tsx names ${t} as code: a tile or a sheet may now carry it`).not.toMatch(new RegExp(`(?:type|event): "${t.replace(/\./g, "\\.")}"`));
    }
    expect(skin).toMatch(/follow-on\/match\.close only appear\s*\/\/ there at all once `padSpec\(cfg\)` itself declares them/); // they ride the generic More sheet
    const row = /if \(!expanded\) \{\s*return \(\s*<button\b([\s\S]{0,600}?)>\s*<span className="break-words">\{label\}<\/span>/.exec(form);
    expect(row, "action-form.tsx no longer renders a More-sheet row as a plain button").not.toBeNull();
    expect(row![1], "a More-sheet row now carries a testid or a data attribute: the follow-on and the draw can be tapped").not.toMatch(/data-/);
  });

  it("the declare tile and its event are the skin's and the engine's: the tile id, its event, and the two-innings gate, read from the source text", () => {
    const skin = readFileSync(join(REPO, SKINS, "skins/cricket.tsx"), "utf8");
    expect(skin).toMatch(/if \(twoInnings\) \{[\s\S]{0,1800}?tiles\.push\(superOverTile\(closedTile\(\{\s*id: "([^"]+)",[\s\S]{0,200}?action: \{ event: \{ type: "([^"]+)", payload: \{\} \} \},/);
    const m = /if \(twoInnings\) \{[\s\S]{0,1800}?tiles\.push\(superOverTile\(closedTile\(\{\s*id: "([^"]+)",[\s\S]{0,200}?action: \{ event: \{ type: "([^"]+)", payload: \{\} \} \},/.exec(skin)!;
    expect(CRICKET_DECLARE_TILE).toBe(m[1]);
    expect(CRICKET_DECLARE).toBe(m[2]);
    // closedTile disables it on a closed innings — the reason a declared innings the sheets close themselves is refused.
    expect(skin).toContain("const closedTile = (spec: TileSpec): TileSpec => (inningsClosed ? { ...spec, disabled: true } : spec);");
  });
});

describe("the 24 committed cricket `test` cases (w1drv-l3): each event type their streams hold is a route or a named 🚫", () => {
  interface CommittedCase { caseId: string; state: string }
  interface CatalogueCase { id: string; preset: string; overrides: Record<string, unknown> }
  let cases: CommittedCase[] = [];
  let catalogue: Map<string, CatalogueCase> = new Map();
  beforeAll(() => {
    const run = JSON.parse(readFileSync(join(PROMPTS, "truth-runs/w1drv-l3/results.json"), "utf8")) as { cases: CommittedCase[] };
    cases = run.cases.filter((c) => c.caseId.includes("|cricket|test|"));
    const v = JSON.parse(readFileSync(resolve(REPO, "tools/matrix/catalogue/variants.json"), "utf8")) as { sports: { sport: string; cases: CatalogueCase[] }[] };
    catalogue = new Map(v.sports.find((s) => s.sport === "cricket")!.cases.map((c) => [c.id, c]));
  });

  /** The outcomes a scenario sends a fixture (defaultPolicy: win either way, a draw where the stage allows one) and the tie the generator builds. */
  const outcomesFor = (cfg: unknown): RequestedOutcome[] => [WIN_HOME, WIN_AWAY, ...(drawsAllowed("cricket", cfg, "league") ? [DRAW] : []), TIE];

  it("exactly 24 cases, each one a `test` case of the catalogue with its own overrides (the count is the run's, and the catalogue's)", () => {
    expect(cases).toHaveLength(24);
    const ids = cases.map((c) => c.caseId.split("|").at(-1)!);
    expect(new Set(ids).size).toBe(24);
    for (const id of ids) {
      expect(catalogue.has(id), id).toBe(true);
      expect(catalogue.get(id)!.preset, id).toBe("test");
    }
    expect([...catalogue.values()].filter((c) => c.preset === "test")).toHaveLength(24);
  });

  it("every event their streams hold — across win, draw and tie — maps to a route (steps) or a named 🚫 (noControl); a stream holding a 🚫 is never half-tapped; every case has a stream the pad can write whole", () => {
    let streams = 0;
    let routableStreams = 0;
    let barredStreams = 0;
    let routedEvents = 0;
    let barredEvents = 0;
    let skipped = 0;
    const types = new Set<string>();
    const perCase = new Map<string, number>();
    for (const c of cases) {
      const id = c.caseId.split("|").at(-1)!;
      const cfg = resolveSportCfg("cricket", "test", { ...catalogue.get(id)!.overrides });
      expect((cfg as { inningsPerSide: number }).inningsPerSide, id).toBe(2);
      for (const outcome of outcomesFor(cfg)) {
        let evs: StreamEvent[];
        try {
          evs = stream(cfg, outcome);
        } catch (e) {
          if (e instanceof GeneratorUnsupported || e instanceof OutcomeUnreachable) { skipped++; continue; }
          throw e;
        }
        streams++;
        const at = `${c.caseId} ${JSON.stringify(outcome)}`;
        for (const e of evs) types.add(e.type);
        const noControl = new Set(cricketPad.noControl!.eventTypes);
        const barred = evs.filter((e) => noControl.has(e.type));
        const pad = makeCricketPad();
        if (barred.length > 0) {
          for (const e of barred) {
            expect(() => pad.stepsFor(e, ctxOf(cfg)), `${at} ${e.type}`).toThrow(/has no addressable pad control/);
            barredEvents++;
          }
          barredStreams++;
          continue;
        }
        for (const e of evs) {
          const steps = pad.stepsFor(e, ctxOf(cfg));
          expect(steps.length, `${at} ${e.type}`).toBeGreaterThan(0);
          routedEvents++;
        }
        routableStreams++;
        perCase.set(id, (perCase.get(id) ?? 0) + 1);
      }
    }
    console.info(`pad-cricket-innings: ${cases.length} cases, ${streams} streams (${skipped} refused by the generator): ${routableStreams} routable whole (${routedEvents} events), ${barredStreams} named 🚫 (${barredEvents} events); event types ${[...types].sort().join(", ")}`);
    expect(cases).toHaveLength(24);
    expect(streams).toBeGreaterThanOrEqual(24 * 3);
    expect(routedEvents).toBeGreaterThan(0);
    expect(barredEvents).toBeGreaterThan(0);
    // Every event type a case's streams hold is one the adapter knows: emitted by it, as a route or as a 🚫.
    for (const t of types) expect(cricketPad.emits, `an event type the adapter does not declare: ${t}`).toContain(t);
    // The point of the carry: no case is left with nothing the pad can write.
    expect([...perCase.keys()]).toHaveLength(24);
    for (const [id, n] of perCase) expect(n, `${id}: no stream the pad can write whole`).toBeGreaterThanOrEqual(1);
  });

  it("through the real replay on the model pad: every routable stream of every case folds, from the pad's own rows, to the outcome the case asked for", async () => {
    let replayed = 0;
    let rows = 0;
    for (const c of cases) {
      const id = c.caseId.split("|").at(-1)!;
      const cfg = resolveSportCfg("cricket", "test", { ...catalogue.get(id)!.overrides });
      for (const outcome of outcomesFor(cfg)) {
        let evs: StreamEvent[];
        try { evs = stream(cfg, outcome); } catch (e) {
          if (e instanceof GeneratorUnsupported || e instanceof OutcomeUnreachable) continue;
          throw e;
        }
        if (evs.some((e) => cricketPad.noControl!.eventTypes.includes(e.type))) continue;
        const at = `${c.caseId} ${JSON.stringify(outcome)}`;
        const { res, ledger } = await replayOnModel(makeCricketPad(), evs, ctxOf(cfg), twoInningsModel(ctxOf(cfg)));
        expect(res.findings, at).toEqual([]);
        expect(res.rows.map((x) => x.verdict), at).toEqual(evs.map((e, i) => (i === 0 ? "equal" : e.type === CRICKET_SUMMARY ? "fallback" : "?")));
        expect(matchesRequest(req(cfg, outcome), foldStream(cricket, cfg, HOME, AWAY, asEvents(ledger)).outcome), at).toBe("match");
        replayed++;
        rows += ledger.length;
      }
    }
    console.info(`pad-cricket-innings: ${replayed} streams replayed on the model, ${rows} ledger rows`);
    expect(replayed).toBeGreaterThanOrEqual(24);
  }, 120_000);
});
