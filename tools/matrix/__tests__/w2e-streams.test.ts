// W2e Tasks 19–24 (A3; spec §10, D9; INV §5 G1–G8, G12): generator breadth, one stream per task, each sweep titled with
// its G-id. Every stream is folded STRICTLY through the real module (lib/fold.ts, strictFromSeq 1). What decided it is
// read from the engine's own declarations — the module's decider rule keys (`deciderKeysFor`) and `reachableDecidedIn`,
// `decidedInFor` over its win-method table, the shoot-out order the module binds (`footballNextKicker`) — never from the
// generators. Every sweep counts what it checked, per sport and per variant, and zero is a failure (TEST-STRATEGY
// anti-vacuity). `ALL_OUTCOMES` stays frozen: the new shapes run here, in their own sweeps (spec §10).
import { decidedInFor } from "@seazn/engine/competition";
import { StageKind } from "@seazn/engine/core";
import { deciderKeysFor } from "@seazn/engine/sport";
import { football, footballNextKicker, type ShootoutKick } from "@seazn/engine/sports/football";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { foldStream } from "../lib/fold.ts";
import { resolveSportCfg, stageCfg, variantKeys } from "../lib/sport-cfg.ts";
import { STREAM_GENERATORS, generateStream, matchesRequest } from "../lib/streams/index.ts";
import { KNOWN_UNSUPPORTED } from "../lib/streams/known-unsupported.ts";
import {
  ALL_OUTCOMES, DECIDING_PATHS, GeneratorUnsupported, OutcomeUnreachable, outcomeLabel,
  type DecidingPath, type RequestedOutcome, type Side, type StreamRequest,
} from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";

const SIDES: readonly Side[] = ["home", "away"];
const ID: Readonly<Record<Side, string>> = { home: "H", away: "A" };
const req = (sportKey: string, cfg: unknown, stageKind: StageKind, outcome: RequestedOutcome): StreamRequest =>
  ({ sportKey, cfg, stageKind, home: ID.home, away: ID.away, outcome });

describe("W2e request vocabulary (Task 19: the interface Tasks 20–24 build on)", () => {
  it("empty case first: ALL_OUTCOMES is W2b's seven, frozen, and names no deciding path and no sanction ending", () => {
    expect(ALL_OUTCOMES.map(outcomeLabel)).toEqual(["win-home", "win-away", "draw", "forfeit-away-walkover", "forfeit-home-retired", "abandon", "tie"]);
    expect(Object.isFrozen(ALL_OUTCOMES)).toBe(true);
    expect(ALL_OUTCOMES.filter((o) => o.kind === "sanctionEnd" || (o.kind === "win" && o.path !== undefined))).toEqual([]);
    expect(KNOWN_UNSUPPORTED).toEqual([]);
  });

  it("labels: a path win is win-<side>-<path>, a sanction ending sanction-<by>-<level>; every one distinct, none colliding with an older label", () => {
    // The closed list, from the plan's interface (Tasks 19–24 table), frozen.
    expect([...DECIDING_PATHS]).toEqual(["extraTime", "shootout", "overtime", "gws", "superOver", "dls", "decidingSet", "cap", "tiebreakSet", "shortSetTb"]);
    expect(Object.isFrozen(DECIDING_PATHS)).toBe(true);
    const fresh: RequestedOutcome[] = [];
    for (const winner of SIDES) for (const path of DECIDING_PATHS) {
      const o: RequestedOutcome = { kind: "win", winner, path };
      expect(outcomeLabel(o)).toBe(`win-${winner}-${path}`);
      fresh.push(o);
    }
    for (const by of SIDES) for (const level of ["black", "default", "expulsion"]) {
      const o: RequestedOutcome = { kind: "sanctionEnd", by, level };
      expect(outcomeLabel(o)).toBe(`sanction-${by}-${level}`);
      fresh.push(o);
    }
    // A win that names no path is W1's label, byte for byte (committed case ids).
    expect(outcomeLabel({ kind: "win", winner: "home" })).toBe("win-home");
    const labels = [...ALL_OUTCOMES, ...fresh].map(outcomeLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(fresh.length).toBe(2 * DECIDING_PATHS.length + 2 * 3);
  });

  it("a path request to a sport whose generator builds no path is refused by name (GeneratorUnsupported), never built as a plain win — over the registry, counted", () => {
    let refused = 0;
    let witnessed = 0;
    for (const sportKey of SPORT_KEYS) {
      const gen = STREAM_GENERATORS[sportKey]!;
      const variant = offlineBuilderDefault(sportKey);
      const cfg = stageCfg(sportKey, resolveSportCfg(sportKey, variant), "knockout", variant);
      if (gen.pathWitness !== undefined) { witnessed++; continue; }
      for (const path of DECIDING_PATHS) {
        const ask = () => generateStream(req(sportKey, cfg, "knockout", { kind: "win", winner: "home", path }));
        expect(ask, `${sportKey} ${path}`).toThrow(GeneratorUnsupported);
        expect(ask, `${sportKey} ${path}`).toThrow(/builds no deciding path/);
        refused++;
      }
    }
    console.info(`w2e: ${witnessed} sport(s) witness a deciding path; ${refused} path request(s) refused by name on the rest`);
    expect(STREAM_GENERATORS.football!.pathWitness, "Task 19: football builds its paths").toBeDefined();
    expect(witnessed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("G12 is Task 24's: until it lands, generateStream refuses a sanctionEnd by name and matchesRequest throws by name — it never answers", () => {
    let checked = 0;
    for (const sportKey of SPORT_KEYS) {
      const r = req(sportKey, resolveSportCfg(sportKey, offlineBuilderDefault(sportKey)), "league", { kind: "sanctionEnd", by: "home", level: "x" });
      expect(() => generateStream(r), sportKey).toThrow(GeneratorUnsupported);
      expect(() => generateStream(r), sportKey).toThrow(/Task 24/);
      for (const outcome of [null, { kind: "award", winner: ID.away, loser: ID.home, reason: "disqualified" }] as const) {
        expect(() => matchesRequest(r, outcome as never), `${sportKey} ${JSON.stringify(outcome)}`).toThrow(/Task 24/);
      }
      checked++;
    }
    expect(checked).toBe(SPORT_KEYS.length);
  });

  it("a path is witnessed on the fold's STATE as well as its outcome: matchesRequest refuses a path request handed no state, by name", () => {
    const cfg = stageCfg("football", resolveSportCfg("football", "11-a-side"), "knockout", "11-a-side");
    const r = req("football", cfg, "knockout", { kind: "win", winner: "home", path: "shootout" });
    const folded = foldStream(football, cfg, ID.home, ID.away, generateStream(r));
    expect(matchesRequest(r, folded.outcome, folded.state)).toBe("match");
    expect(() => matchesRequest(r, folded.outcome)).toThrow(/path 'shootout' is witnessed on the folded state/);
    // A request that names no path is matched on the outcome alone, as before W2e.
    expect(matchesRequest(req("football", cfg, "knockout", { kind: "win", winner: "home" }), folded.outcome)).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// Task 19 — G1 (football extra time), G2 (football shoot-out).

const FB = "football";
/** A decider rule key is ON when its value is `true` (the shoot-out) or an `{enabled: true}` object (extra time). */
const isOn = (v: unknown): boolean => v === true || (typeof v === "object" && v !== null && (v as { enabled?: unknown }).enabled === true);
/** The deciding paths a football cfg switches on: the module's own decider rule keys (`deciderKeysFor`) whose value is on.
 *  Football's decider keys ARE path names (extraTime, shootout) — pinned below, so a renamed key reds here. */
function declaredPaths(cfg: unknown, kind: StageKind, variant: string): DecidingPath[] {
  return deciderKeysFor(football, kind, variant).filter((k) => isOn((cfg as Record<string, unknown>)[k])).map((k) => k as DecidingPath);
}
/** What decided each path, in the engine's own vocabulary (sport/module.ts `DecidedIn`): football's extra time is decided
 *  "in overtime" (`ot`), the penalty shoot-out "by a shoot-out" (`so`). */
const DECIDED_IN: Readonly<Record<"extraTime" | "shootout", "ot" | "so">> = { extraTime: "ot", shootout: "so" };
/** Every football variant × every stage kind the engine declares, under the cfg the product folds that stage's fixtures
 *  under (`stageCfg`: the division's variant, then the stage preset the create door writes — a bracket's extra time and
 *  penalties, X-SR-6, FB-SO-1). */
const CELLS = variantKeys(FB).flatMap((variant) =>
  StageKind.options.map((kind) => ({ variant, kind, cfg: stageCfg(FB, resolveSportCfg(FB, variant), kind, variant) as Record<string, unknown> })));
const fold = (cfg: unknown, events: Parameters<typeof foldStream>[4]) => foldStream(football, cfg, ID.home, ID.away, events);

describe("G1 G2 football: a win down extra time, a win down the shoot-out (Task 19)", () => {
  it("empty case first: football's decider keys are the two path names, and a cfg that switches neither on (every table stage) refuses both by name — as does a path football has no rule for", () => {
    expect([...deciderKeysFor(football, "knockout", null)].sort()).toEqual(["extraTime", "shootout"]);
    let refused = 0;
    for (const { variant, kind, cfg } of CELLS) {
      if (declaredPaths(cfg, kind, variant).length > 0) continue;
      for (const path of ["extraTime", "shootout"] as const) {
        expect(() => generateStream(req(FB, cfg, kind, { kind: "win", winner: "home", path })), `${variant}/${kind} ${path}`).toThrow(OutcomeUnreachable);
        refused++;
      }
    }
    expect(refused, "some football stage switches no decider on").toBeGreaterThan(0);
    const ko = CELLS.find((c) => c.variant === "11-a-side" && c.kind === "knockout")!;
    let foreign = 0;
    for (const path of DECIDING_PATHS.filter((p) => !deciderKeysFor(football, "knockout", null).includes(p))) {
      expect(() => generateStream(req(FB, ko.cfg, "knockout", { kind: "win", winner: "home", path })), path).toThrow(OutcomeUnreachable);
      expect(() => generateStream(req(FB, ko.cfg, "knockout", { kind: "win", winner: "home", path })), path).toThrow(`football has no '${path}' deciding path`);
      foreign++;
    }
    expect(foreign).toBe(DECIDING_PATHS.length - 2);
  });

  it("G1 G2: every football variant whose cfg declares extra time or a shoot-out builds a win down EACH declared path, for both winners, under a strict fold — decided in the engine's own 'ot' / 'so', counted per variant", () => {
    const perVariant = new Map<string, number>();
    let declaringCells = 0;
    for (const { variant, kind, cfg } of CELLS) {
      const paths = declaredPaths(cfg, kind, variant);
      // The engine's own reachability agrees with the cfg's switches.
      const reach = football.reachableDecidedIn(cfg as never, kind);
      expect(reach.has("ot"), `${variant}/${kind} ot`).toBe(paths.includes("extraTime"));
      expect(reach.has("so"), `${variant}/${kind} so`).toBe(paths.includes("shootout"));
      if (paths.length === 0) continue;
      declaringCells++;
      for (const path of paths) for (const winner of SIDES) {
        const at = `${variant}/${kind} ${path} ${winner}`;
        const r = req(FB, cfg, kind, { kind: "win", winner, path });
        const events = generateStream(r);
        const folded = fold(cfg, events); // strict: an out-of-order kick or a marker in the wrong phase throws
        expect(folded.outcome, at).toMatchObject({ kind: "win", winner: ID[winner], loser: ID[winner === "home" ? "away" : "home"] });
        expect(decidedInFor(football, folded.outcome), at).toBe(DECIDED_IN[path as "extraTime" | "shootout"]);
        expect(reach.has(decidedInFor(football, folded.outcome)!), at).toBe(true);
        expect(matchesRequest(r, folded.outcome, folded.state), at).toBe("match");
        // It decides on its LAST event: nothing is posted to a match already over.
        expect(fold(cfg, events.slice(0, -1)).outcome, at).toBeNull();
        // A second call builds the same stream.
        expect(generateStream(r), at).toEqual(events);
        perVariant.set(variant, (perVariant.get(variant) ?? 0) + 1);
      }
    }
    console.info(`G1 G2 football: ${declaringCells} cell(s) declare a decider; wins per variant ${JSON.stringify(Object.fromEntries(perVariant))}`);
    expect(declaringCells).toBeGreaterThan(0);
    for (const v of variantKeys(FB)) expect(perVariant.get(v) ?? 0, `${v}: no deciding-path win was checked`).toBeGreaterThan(0);
  });

  it("G2: every kick is taken by the side the engine names next (footballNextKicker over the kicks before it), the kicks run past the cfg's attempts into sudden death, and the engine took every one", () => {
    let kicksChecked = 0;
    let streams = 0;
    const attemptsSeen = new Set<number>();
    for (const { variant, kind, cfg } of CELLS) {
      if (!declaredPaths(cfg, kind, variant).includes("shootout")) continue;
      // The kicks before sudden death: the stage preset's `shootoutAttempts`, else what the engine declares an absent key means.
      const attempts = (cfg.shootoutAttempts as number | undefined) ?? (football.ruleKeys!.shootoutAttempts!.whenAbsent as number);
      attemptsSeen.add(attempts);
      for (const winner of SIDES) {
        const at = `${variant}/${kind} ${winner}`;
        const events = generateStream(req(FB, cfg, kind, { kind: "win", winner, path: "shootout" }));
        const kicks = events.filter((e) => e.type === "football.shootout.kick").map((e) => e.payload as { by: string; scored: boolean });
        const taken: ShootoutKick[] = [];
        for (const k of kicks) {
          const side: Side = k.by === ID.home ? "home" : "away";
          const next = footballNextKicker(taken);
          if (next !== null) expect(side, `${at} kick ${taken.length + 1}`).toBe(next);
          taken.push({ side, scored: k.scored });
          kicksChecked++;
        }
        expect(kicks.length, `${at}: sudden death (more than ${attempts} kicks a side)`).toBeGreaterThan(2 * attempts);
        // The shoot-out follows extra time when the cfg plays extra time (resolveFullTime), and comes straight after FT otherwise.
        const markers = events.filter((e) => e.type === "football.period").map((e) => (e.payload as { phase: string }).phase);
        expect(markers.includes("ET_FT"), at).toBe(isOn(cfg.extraTime));
        expect(events.some((e) => e.type === "football.goal"), `${at}: level into the kicks`).toBe(false);
        const state = fold(cfg, events).state as { shootout: { kicks: ShootoutKick[] } | null };
        expect(state.shootout?.kicks.map((k) => [k.side, k.scored]), at).toEqual(taken.map((k) => [k.side, k.scored]));
        streams++;
      }
    }
    console.info(`G2 football: ${streams} shoot-out stream(s), ${kicksChecked} kick(s) in the engine's order; attempts seen ${[...attemptsSeen].sort().join(", ")}`);
    expect(streams).toBeGreaterThan(0);
    // The right answer differs from a typed constant: the youth formats take 3 kicks, the rest 5 (FB-SO-1).
    expect(attemptsSeen.size, "more than one attempts count was exercised").toBeGreaterThan(1);
  });

  it("the right answer differs from the wrong one: a win down one path matches no request for the other, a regulation win matches no path, the wrong winner matches nothing, and a path win still matches a plain win request", () => {
    const { cfg } = CELLS.find((c) => c.variant === offlineBuilderDefault(FB) && c.kind === "knockout")!;
    const ask = (winner: Side, path?: DecidingPath) => req(FB, cfg, "knockout", path === undefined ? { kind: "win", winner } : { kind: "win", winner, path });
    const played = (r: StreamRequest) => fold(cfg, generateStream(r));
    const et = played(ask("home", "extraTime"));
    const so = played(ask("home", "shootout"));
    const reg = played(ask("home"));
    expect(decidedInFor(football, reg.outcome)).toBe("regulation");
    const rows: [string, StreamRequest, ReturnType<typeof played>, "match" | "mismatch"][] = [
      ["et as et", ask("home", "extraTime"), et, "match"],
      ["so as so", ask("home", "shootout"), so, "match"],
      ["et as so", ask("home", "shootout"), et, "mismatch"],
      ["so as et", ask("home", "extraTime"), so, "mismatch"],
      ["regulation as et", ask("home", "extraTime"), reg, "mismatch"],
      ["regulation as so", ask("home", "shootout"), reg, "mismatch"],
      ["et, other winner", ask("away", "extraTime"), et, "mismatch"],
      ["so, other winner", ask("away", "shootout"), so, "mismatch"],
      ["so as gws (not football's)", ask("home", "gws"), so, "mismatch"],
      ["et as a plain win", ask("home"), et, "match"],
      ["so as a plain win", ask("home"), so, "match"],
    ];
    for (const [label, r, f, want] of rows) expect(matchesRequest(r, f.outcome, f.state), label).toBe(want);
    expect(rows.filter((x) => x[3] === "mismatch").length).toBe(7);
  });

  it("G1 G2 off the presets: extra time on and the shoot-out off builds extra time and refuses the kicks; the kicks on and extra time off go from full time straight to the kicks", () => {
    const etOnly = resolveSportCfg(FB, "11-a-side", { extraTime: { enabled: true, halfMinutes: 15 }, shootout: false });
    expect(declaredPaths(etOnly, "knockout", "11-a-side")).toEqual(["extraTime"]);
    const et = generateStream(req(FB, etOnly, "knockout", { kind: "win", winner: "away", path: "extraTime" }));
    expect(decidedInFor(football, fold(etOnly, et).outcome)).toBe("ot");
    expect(() => generateStream(req(FB, etOnly, "knockout", { kind: "win", winner: "away", path: "shootout" }))).toThrow(OutcomeUnreachable);
    const soOnly = resolveSportCfg(FB, "11-a-side", { extraTime: { enabled: false, halfMinutes: 15 }, shootout: true });
    expect(declaredPaths(soOnly, "knockout", "11-a-side")).toEqual(["shootout"]);
    const so = generateStream(req(FB, soOnly, "knockout", { kind: "win", winner: "away", path: "shootout" }));
    expect(so.some((e) => e.type === "football.period" && String((e.payload as { phase: string }).phase).startsWith("ET_"))).toBe(false);
    expect(decidedInFor(football, fold(soOnly, so).outcome)).toBe("so");
    expect(() => generateStream(req(FB, soOnly, "knockout", { kind: "win", winner: "away", path: "extraTime" }))).toThrow(OutcomeUnreachable);
  });
});
