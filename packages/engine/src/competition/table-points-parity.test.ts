// W2d Task 3 — every sport's table points as a rule (SPEC §5.3 "The sport's default, as a rule", §5.10 points column,
// §13.4 parity leg; D6, D10(a)(c), B2, PS-1). Rule rows X-PT-2, X-PT-3, FB-PT-1, HK-PT-1, HK-PT-2, IH-PT-1, IH-PT-2,
// TT-PT-1, VB-PT-1, VB-PT-2, BG-PT-1, CK-PT-1, CK-PT-2.
//
// The parity oracle is each module's OWN `standingsDelta` — the pre-W2d payer, untouched by W2d except its shoot-out
// branch (PS-1), whose every row (football's and hockey's win.so / loss.so) is SIGNED below. Every other expected value
// is typed from the rulebook values SPEC §5.10 signs, never read off `tablePointsRule`.
import { describe, expect, it } from "vitest";
import { SETTLE_METHODS, foldMatchWithStoppage, outcomeOf, settledMethod, type EventEnvelope } from "../core/events.ts";
import { DRAW_KINDS, MatchOutcome, StageKind, type StandingsDelta } from "../core/types.ts";
import { FOLD_EPOCH } from "../sport/fold-epoch.ts";
import { SHARED_WIN_METHODS, type AnySportModule } from "../sport/module.ts";
// single-sport: BG-PT-1 is chess's rulebook row (FIDE 1/½/0, stored as half-points)
import { boardgame } from "../sports/boardgame/boardgame.ts";
// single-sport: CK-PT-1/CK-PT-2 are cricket's rows (the one sport with a tie, a no result and a two-innings draw)
import { cricket } from "../sports/cricket/cricket.ts";
// single-sport: FB-PT-1 and PS-1 are football's shoot-out rows (RB2B-7, B2)
import { football } from "../sports/football/football.ts";
// single-sport: HK-PT-1/HK-PT-2 are the FIH rows (draws stand; the Pro League shoot-out is a draw plus a bonus)
import { hockey } from "../sports/hockey/hockey.ts";
// single-sport: IH-PT-1/IH-PT-2 are the IIHF rows (3/2/1/0, GWS paid as overtime) and the recreational 2/1/0
import { icehockey } from "../sports/icehockey/icehockey.ts";
// single-sport: TT-PT-1 is table tennis's 2/1/0 with the unplayed loss (D6), the one sport that declares one
import { tabletennis } from "../sports/setbased/tabletennis.ts";
// single-sport: VB-PT-1/VB-PT-2 are the FIVB set-score rows (best of 5, best of 3)
import { volleyball } from "../sports/setbased/volleyball.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import {
  PointsRule,
  coverage,
  decidedInFor,
  levelOutcomeKey,
  payout,
  reachableOutcomes,
  setsToWinOf,
  type FixtureResult,
  type OutcomeKey,
} from "./index.ts";

type Raw = Record<string, unknown>;
type Row = [won: number, drawn: number, lost: number, points: number];
const SPORTS = Object.keys(FOLD_EPOCH).length; // the independent count of registered sports (PS-9g)
const TABLE_KINDS: readonly StageKind[] = StageKind.options.filter((k) => DRAW_KINDS.has(k));
const row = (d: StandingsDelta): Row => [d.won, d.drawn, d.lost, d.points];
const ruleOf = (m: AnySportModule, cfg: unknown, kind: StageKind): PointsRule => {
  // Assumptions are guards: a module without the member reds here by name, never as a TypeError mid-sweep.
  expect(typeof (m as { tablePointsRule?: unknown }).tablePointsRule, `${m.key} declares tablePointsRule`).toBe("function");
  return m.tablePointsRule(m.configSchema.parse(cfg), kind);
};

// ---------------------------------------------------------------------------------------------------------------------
// Real results, as each sport's own fold and ledger produce them.
// ---------------------------------------------------------------------------------------------------------------------

interface SetCfg {
  bestOf: number;
  setTo: number;
  finalSetTo: number;
  winBy: number;
}
let seq = 0;
const ev = (type: string, payload: Raw): EventEnvelope => makeEnvelope(++seq, { type, payload });
/** A set sport's coarse summary type (`set.summary` / `game.summary`), the module's own declaration. */
const summaryType = (m: AnySportModule): string => `${m.key}.${(m as unknown as { coarseEventType: string }).coarseEventType}`;
/** A completed set the fold accepts: the target (`finalSetTo` for the deciding set), won by `winBy`. */
function setScore(cfg: SetCfg, index: number, homeWins: boolean): Raw {
  const target = index === cfg.bestOf - 1 ? cfg.finalSetTo : cfg.setTo;
  const [w, l] = [target, target - cfg.winBy];
  return homeWins ? { home: w, away: l } : { home: l, away: w };
}
/** The ledger of a set match: `core.start`, then `sets` (true = the home side wins it), then `tail`. */
function setStream(m: AnySportModule, cfg: SetCfg, sets: readonly boolean[], tail: readonly EventEnvelope[] = []): EventEnvelope[] {
  return [ev("core.start", {}), ...sets.map((home, i) => ev(summaryType(m), setScore(cfg, i, home))), ...tail];
}
/** The final sets of a `won`-`lost` match for `winner`: the loser's sets first, so the last set decides. */
function finalSets(winner: "H" | "A", won: number, lost: number): boolean[] {
  const home = winner === "H";
  return [...Array.from({ length: lost }, () => !home), ...Array.from({ length: won }, () => home)];
}
function fold(m: AnySportModule, cfg: unknown, evs: readonly EventEnvelope[]) {
  return foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), evs) as { state: unknown };
}

interface Probe {
  outcome: MatchOutcome;
  state: unknown;
  played: boolean;
  /** A settled abandon after sets were played: the winner's sets, then the loser's, when the match stopped. */
  settledAt?: string;
}
const winOf = (winner: "H" | "A", method?: string): MatchOutcome =>
  MatchOutcome.parse({ kind: "win", winner, loser: winner === "H" ? "A" : "H", ...(method === undefined ? {} : { method }) });

/** Every decided result a stage of `kind` under `cfg` can hand the table: each own win method its cfg reaches, both
 *  seats; a settled abandon; a walkover each way; a double walkover; each level result the table pays. A set sport's
 *  wins are folded from real set summaries, one per final score its `bestOf` can end. */
function probes(m: AnySportModule, cfg: unknown, kind: StageKind): Probe[] {
  const parsed: unknown = m.configSchema.parse(cfg);
  const reach = reachableOutcomes(m, parsed, kind);
  const out: Probe[] = [];
  const lineups = defaultLineupPair(m.positions);
  const fresh = m.init(parsed, lineups);
  if (m.reachableSetScores !== undefined) {
    const sc = parsed as SetCfg;
    for (const score of m.reachableSetScores(parsed)) {
      const [won, lost] = score.split("-").map(Number) as [number, number];
      for (const winner of ["H", "A"] as const) {
        const folded = fold(m, parsed, setStream(m, sc, finalSets(winner, won, lost)));
        const outcome = outcomeOf(m as never, folded as never);
        expect(outcome, `${m.key} ${score} folds to a win for ${winner}`).toMatchObject({ kind: "win", winner });
        out.push({ outcome: outcome!, state: folded.state, played: true });
      }
    }
  } else {
    const own = m.outcomeMethods.filter((method) => !SHARED_WIN_METHODS.includes(method));
    for (const method of [undefined, ...own]) {
      const d = method === undefined ? "regulation" : m.decidedInOf(method);
      if (!reach.has(`win.${d}`)) continue;
      for (const winner of ["H", "A"] as const) out.push({ outcome: winOf(winner, method), state: fresh, played: true });
    }
  }
  // A settled abandon (W2a X-ST-1) before any set or goal: regulation, the scoreless ledger.
  const started = m.reachableSetScores === undefined ? fresh : fold(m, parsed, [ev("core.start", {})]).state;
  for (const s of SETTLE_METHODS) for (const winner of ["H", "A"] as const) out.push({ outcome: winOf(winner, settledMethod(s)), state: started, played: true });
  // A settled abandon AFTER sets were played (T2 ruling I2, FIVB 6.4.3): every partial score short of the match, each
  // settle method, both settle winners, the real ledger (core.abandon, core.settle) folded so the sport's own payer reads
  // the sets it holds.
  const toWin = setsToWinOf(m, parsed);
  if (m.reachableSetScores !== undefined && toWin !== undefined) {
    const sc = parsed as SetCfg;
    for (let h = 0; h < toWin; h++) {
      for (let a = 0; a < toWin; a++) {
        if (h + a === 0) continue; // the scoreless ledger, above
        const sets = [...Array.from({ length: h }, () => true), ...Array.from({ length: a }, () => false)];
        for (const s of SETTLE_METHODS) {
          for (const winner of ["H", "A"] as const) {
            const tail = [ev("core.abandon", { reason: "the hall lost power" }), ev("core.settle", { winner, method: s })];
            const folded = fold(m, parsed, setStream(m, sc, sets, tail));
            const outcome = outcomeOf(m as never, folded as never);
            expect(outcome, `${m.key} settled at ${h}-${a} (${s}) for ${winner}`).toMatchObject({ kind: "win", winner, method: settledMethod(s) });
            out.push({ outcome: outcome!, state: folded.state, played: true, settledAt: winner === "H" ? `${h}-${a}` : `${a}-${h}` });
          }
        }
      }
    }
  }
  for (const winner of ["H", "A"] as const) {
    out.push({ outcome: MatchOutcome.parse({ kind: "award", winner, loser: winner === "H" ? "A" : "H", reason: "walkover" }), state: fresh, played: false });
  }
  out.push({ outcome: MatchOutcome.parse({ kind: "double_walkover" }), state: fresh, played: false });
  for (const k of ["draw", "tie", "noResult"] as const) {
    if (reach.has(k)) out.push({ outcome: MatchOutcome.parse({ kind: k === "noResult" ? "no_result" : k }), state: fresh, played: true });
  }
  return out;
}

/** The field a sport keeps its own points in (`points`, chess's `scoring`), with every key its schema declares
 *  (optional ones included), or null for a sport that pays by a set-score map. Read off the cfg schema itself. */
function pointsFieldOf(m: AnySportModule): { field: string; keys: string[] } | null {
  const shape = (m.configSchema as unknown as { shape?: Record<string, unknown> }).shape;
  const field = shape === undefined ? undefined : ["points", "scoring"].find((k) => Object.hasOwn(shape, k));
  if (shape === undefined || field === undefined) return null;
  // Unwrap `.default()` / `.optional()` down to the object.
  let inner = shape[field] as { shape?: Record<string, unknown>; unwrap?: () => unknown } | undefined;
  for (let i = 0; inner !== undefined && inner.shape === undefined && i < 4; i++) inner = inner.unwrap?.() as typeof inner;
  return inner?.shape === undefined ? null : { field, keys: Object.keys(inner.shape) };
}

/** I-1 (AGENTS.md class 19): an organiser's points for `cfg`, every key the schema declares paying a value no default
 *  pays and no other key pays — one past the cfg's largest, counting up — so a rule that reads a default constant, or
 *  one key for another, pays differently from the sport's own payer. The values are the cfg's, never the rule's. */
function organiserPoints(m: AnySportModule, name: string, cfg: unknown): { variant: string; cfg: unknown } | null {
  const pf = pointsFieldOf(m);
  if (pf === null) return null;
  const own = (m.configSchema.parse(cfg) as Raw)[pf.field] as Record<string, unknown>;
  const floor = Math.max(0, ...Object.values(own).filter((v): v is number => typeof v === "number")) + 1;
  const pts = Object.fromEntries(pf.keys.map((k, i) => [k, floor + i]));
  return { variant: `${name}+organiser points ${JSON.stringify(pts)}`, cfg: m.configSchema.parse({ ...(cfg as Raw), [pf.field]: pts }) };
}

/** The two-pair organiser map a set sport is swept with: "*" 3:0, and its default best-of's closest score 2:1. */
function organiserTwoPairs(m: AnySportModule): Record<string, [number, number]> {
  const won = Math.ceil((m.configSchema.parse({}) as SetCfg).bestOf / 2);
  return { "*": [3, 0], [`${won}-${won - 1}`]: [2, 1] };
}

/** The cfgs a sport's table can be played under: every declared variant (and the schema default), each again with
 *  organiser points (I-1), each of those again with the sport's knockout deciders switched on (an organiser may keep a
 *  shoot-out in a group, FB-PT-1), and for a set sport each `bestOf` and two organiser maps (one flat, one paying two
 *  pairs). */
function cfgSpace(m: AnySportModule): { variant: string; cfg: unknown }[] {
  const out: { variant: string; cfg: unknown }[] = [];
  for (const { name, cfg } of declaredCfgs(m)) {
    const organiser = organiserPoints(m, name, cfg);
    for (const base of [{ variant: name, cfg }, ...(organiser === null ? [] : [organiser])]) {
      out.push(base);
      const preset = Object.hasOwn(m.variants, name) ? name : null;
      const deciders = { ...(m.stageDefaults?.("knockout", preset) ?? {}), ...m.bracketDeciders(base.cfg) };
      if (Object.keys(deciders).length > 0) out.push({ variant: `${base.variant}+deciders`, cfg: m.configSchema.parse({ ...(base.cfg as Raw), ...deciders }) });
    }
  }
  if (m.reachableSetScores !== undefined) {
    for (const base of [...out]) {
      for (const bestOf of [1, 3, 5, 7]) {
        if ((base.cfg as SetCfg).bestOf !== bestOf) out.push({ variant: `${base.variant}+bo${bestOf}`, cfg: m.configSchema.parse({ ...(base.cfg as Raw), bestOf }) });
      }
    }
    out.push({ variant: "organiser flat", cfg: m.configSchema.parse({ pointsMap: { "*": [3, 1] } }) });
    out.push({ variant: "organiser two pairs", cfg: m.configSchema.parse({ pointsMap: organiserTwoPairs(m) }) });
  }
  // D10(c): a two-innings organiser cfg whose tie pays more than the draw default, so the draw's change is witnessed.
  // single-sport: cricket is the one sport with a two-innings draw; every sport gets the cfgs above
  if (m.key === "cricket") out.push({ variant: "test, organiser tie 2", cfg: m.configSchema.parse({ ...m.variants.test, points: { win: 2, tie: 2, noResult: 1, loss: 0 } }) });
  return out;
}

/** How the NEW rule names what it pays a side: the set score under a `bySetScore` map, else win/loss by decidedIn (an
 *  award's loser by `loss.unplayed` where the stage reaches one), else the level result's own key. */
function labelOf(rule: PointsRule, outcome: MatchOutcome, pair: FixtureResult, side: StandingsDelta, reach: ReadonlySet<OutcomeKey>, setsToWin: number | undefined, d: string): string {
  if (outcome.kind === "draw" || outcome.kind === "tie" || outcome.kind === "no_result") return levelOutcomeKey(outcome.kind);
  if (outcome.kind === "double_walkover") return "double_walkover";
  if (rule.bySetScore !== undefined) return `set:${setsToWin}-${pair.find((x) => x.won === 1)!.metrics.sets_lost}`;
  if (outcome.kind === "award") return side.won === 1 ? "win.regulation" : reach.has("loss.unplayed") ? "loss.unplayed" : "loss.regulation";
  return side.won === 1 ? `win.${d}` : `loss.${d}`;
}

// ---------------------------------------------------------------------------------------------------------------------

// The signed deltas (SPEC §5.3, §11.2): an allowlist. Each row is keyed by sport, by the label the NEW rule pays (a
// set score, a decidedIn, a level result) AND by its scope (the map, the best-of, the settled score), so a side outside
// the scope is parity-checked like any other (review M-1). Inside it, EVERY side must change (∀, a stale signature
// fails), and every row must be met. Volleyball's `set:2-0` is not signed: best of 3 pays a 2-0 3:0 before and after.
interface SignCtx {
  m: AnySportModule;
  cfg: Raw;
  label: string;
  settledAt: string | undefined;
}
interface Signed {
  sport: string;
  label: string;
  scope: string;
  why: string;
  when: (c: SignCtx) => boolean;
}
const entriesOf = (map: unknown): string => JSON.stringify(Object.entries((map ?? {}) as Raw).sort(([a], [b]) => (a < b ? -1 : 1)));
/** The cfg's map is the sport's shipped one (the schema default), whatever order its keys were written in. */
const shippedMap = (c: SignCtx): boolean => entriesOf(c.cfg.pointsMap) === entriesOf((c.m.configSchema.parse({}) as Raw).pointsMap);
const settledFrom = (c: SignCtx, from: readonly string[]): boolean => c.settledAt !== undefined && from.includes(c.settledAt);
const I2 = "T2 ruling I2 (FIVB 6.4.3; owner may overturn at pre-release): a settled abandon is scored as the winner taking the sets it needed";
/** I-2: under an organiser's two-pair map, a match settled with the loser one set short of the match is scored to the
 *  priced closest score (2:1); the old payer priced the partial score by "*" (3:0). Volleyball has no such row: its
 *  two-pair map IS the shipped FIVB map, signed above. */
const organiserI2 = (sport: string, label: string): Signed => ({
  sport,
  label,
  scope: "the organiser two-pair map, settled with the loser one set short",
  why: `${I2}; the old payer priced the partial score by "*"`,
  when: (c) => {
    const won = Math.ceil((c.m.configSchema.parse({}) as SetCfg).bestOf / 2);
    const from = Array.from({ length: won }, (_, k) => `${k}-${won - 1}`);
    return entriesOf(c.cfg.pointsMap) === entriesOf(organiserTwoPairs(c.m)) && c.label === `set:${won}-${won - 1}` && settledFrom(c, from);
  },
});
// single-sport: the signed rows are SPEC §5.10's per-sport changes; the sweep that reads them runs every sport
const SIGNED: readonly Signed[] = [
  { sport: "tabletennis", label: "loss.regulation", scope: "the shipped map", why: "D6: TT 2/1/0, a played loss pays 1", when: (c) => c.label === "loss.regulation" && shippedMap(c) },
  { sport: "volleyball", label: "set:2-1", scope: "the shipped map, best of 3", why: "D10(a): best of 3, a 2-1 pays 2:1 — played, or settled at 0-1 / 1-1 and scored 2-1 (T2 ruling I2)", when: (c) => c.label === "set:2-1" && shippedMap(c) && c.cfg.bestOf === 3 },
  {
    sport: "cricket",
    label: "draw",
    scope: "two innings, no `draw` of the organiser's, a tie not worth 1",
    why: "D10(c): a two-innings draw pays `draw`, else 1 — the old payer's fallback was the tie's points (`draw ?? tie`)",
    when: (c) => c.label === "draw" && c.cfg.inningsPerSide === 2 && (c.cfg.points as Raw).draw === undefined && (c.cfg.points as Raw).tie !== 1,
  },
  { sport: "football", label: "win.so", scope: "every cfg", why: "B2: a table shoot-out is a draw plus a bonus", when: (c) => c.label === "win.so" },
  { sport: "football", label: "loss.so", scope: "every cfg", why: "B2", when: (c) => c.label === "loss.so" },
  { sport: "hockey", label: "win.so", scope: "every cfg", why: "B2 (FIH Pro League)", when: (c) => c.label === "win.so" },
  { sport: "hockey", label: "loss.so", scope: "every cfg", why: "B2", when: (c) => c.label === "loss.so" },
  {
    sport: "volleyball",
    label: "set:3-2",
    scope: "the shipped map, best of 5, settled at 0-2, 1-2 or 2-2",
    why: `${I2}; the old payer priced the partial score by "*" (3:0), the table pays 3-2's 2:1`,
    when: (c) => c.label === "set:3-2" && shippedMap(c) && c.cfg.bestOf === 5 && settledFrom(c, ["0-2", "1-2", "2-2"]),
  },
  {
    sport: "volleyball",
    label: "set:4-2",
    scope: "the shipped map, best of 7, settled at 3-2",
    why: `${I2}; the old payer priced the partial 3-2 by its own key (2:1), the table pays 4-2's "*" (3:0)`,
    when: (c) => c.label === "set:4-2" && shippedMap(c) && c.cfg.bestOf === 7 && settledFrom(c, ["3-2"]),
  },
  organiserI2("badminton", "set:2-1"),
  organiserI2("tabletennis", "set:3-2"),
];
const signedName = (s: Signed): string => `${s.sport} ${s.label} [${s.scope}]`;

describe("W2d tablePointsRule (SPEC §5.3, §13.4)", () => {
  it("X-PT-2 tablePointsRule pays exactly what standingsDelta paid, every sport × cfg × table stage kind × result, except SIGNED (counted)", () => {
    const signed = new Map(SIGNED.map((s) => [s, { met: 0, differed: 0 }]));
    const perSport = new Map<string, number>();
    const organiserCfgs = new Map<string, number>();
    const mismatches: string[] = [];
    const stale: string[] = [];
    let checked = 0;
    let skippedAsSigned = 0;
    let settledProbes = 0;
    const swept = forEachSport(({ key, module: m }) => {
      for (const { variant, cfg } of cfgSpace(m)) {
        // the organiser cfg itself, not its +deciders / +bo copies
        if (/\+organiser points \{[^}]*\}$/.test(variant)) organiserCfgs.set(key, (organiserCfgs.get(key) ?? 0) + 1);
        const setsToWin = setsToWinOf(m, cfg);
        for (const kind of TABLE_KINDS) {
          const rule = ruleOf(m, cfg, kind);
          const reach = reachableOutcomes(m, cfg, kind);
          for (const p of probes(m, cfg, kind)) {
            if (p.settledAt !== undefined) settledProbes++;
            const old = m.standingsDelta(p.outcome, cfg, { kind }, p.state) as FixtureResult;
            const d = decidedInFor(m, p.outcome);
            const paid = payout(p.outcome, d, old, p.played, rule, m.awardScoreKeys, setsToWin);
            for (const i of [0, 1] as const) {
              const label = labelOf(rule, p.outcome, old, old[i], reach, setsToWin, d ?? "regulation");
              const same = JSON.stringify(row(paid[i])) === JSON.stringify(row(old[i]));
              const where = `${key} ${variant} ${kind} ${JSON.stringify(p.outcome)}${p.settledAt === undefined ? "" : ` settled at ${p.settledAt}`} side ${i} (${label}): ${JSON.stringify(row(old[i]))} → ${JSON.stringify(row(paid[i]))}`;
              const ctx: SignCtx = { m, cfg: cfg as Raw, label, settledAt: p.settledAt };
              const s = SIGNED.find((x) => x.sport === key && x.when(ctx));
              checked++;
              perSport.set(key, (perSport.get(key) ?? 0) + 1);
              if (s !== undefined) {
                const got = signed.get(s)!;
                got.met++;
                skippedAsSigned++;
                if (same) stale.push(`${signedName(s)}: ${where}`);
                else got.differed++;
                continue;
              }
              if (!same) mismatches.push(where);
            }
          }
        }
      }
    });
    const signedReport = SIGNED.map((s) => `${signedName(s)} met ${signed.get(s)!.met} differed ${signed.get(s)!.differed}`);
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(
      `X-PT-2: ${checked} sides checked over ${perSport.size} sports (${[...perSport].map(([k, n]) => `${k} ${n}`).join(", ")}); ` +
        `${settledProbes} settled-after-sets probes; organiser-points cfgs ${[...organiserCfgs].map(([k, n]) => `${k} ${n}`).join(", ")}; ` +
        `${mismatches.length} unsigned differences; ${skippedAsSigned} signed — ${signedReport.join("; ")}`,
    );
    expect(swept, "every registered sport swept").toBe(SPORTS);
    expect(checked, `anti-vacuity: ${checked} sides checked, ${skippedAsSigned} signed`).toBeGreaterThan(0);
    for (const [key, n] of perSport) expect(n, `${key}: sides checked`).toBeGreaterThan(0);
    expect(perSport.size, "a side checked for every sport").toBe(SPORTS);
    expect(settledProbes, "anti-vacuity: settled abandons after sets were probed").toBeGreaterThan(0);
    // I-1: every sport that keeps its own points was swept with an organiser's, and only those sports lack one.
    forEachSport(({ key, module: m }) => {
      expect(organiserCfgs.get(key) ?? 0, `${key}: organiser-points cfgs swept`).toBe(pointsFieldOf(m) === null ? 0 : declaredCfgs(m).length);
    });
    expect(organiserCfgs.size, "anti-vacuity: sports swept with organiser points").toBeGreaterThan(0);
    expect(mismatches, "unsigned parity breaks").toEqual([]);
    expect(stale, "a side inside a signed row's scope that pays as it did (a stale signature)").toEqual([]);
    for (const s of SIGNED) {
      const got = signed.get(s)!;
      expect(got.met, `SIGNED ${signedName(s)} (${s.why}) is reached`).toBeGreaterThan(0);
      expect(got.differed, `SIGNED ${signedName(s)}: every side in scope changes`).toBe(got.met);
    }
    // 37,216 sides over 11 sports (organiser points and settled-after-sets probes included): measured 14 s at load 116.
  }, 60_000);

  it("X-PT-3 every module's tablePointsRule is a valid PointsRule and covers its own reachableOutcomes, every cfg × stage kind (counted)", () => {
    let checked = 0;
    const failures: string[] = [];
    const swept = forEachSport(({ key, module: m }) => {
      for (const { variant, cfg } of cfgSpace(m)) {
        for (const kind of StageKind.options) {
          const rule = ruleOf(m, cfg, kind);
          // The rule's own schema takes it (its refinements: no `so` under draw_plus_bonus, no `soBonus` under result).
          expect(PointsRule.parse(rule), `${key} ${variant} ${kind}: the rule is its own schema's`).toEqual(rule);
          // `shootoutAs` is copied from the sport (§5.3), never chosen per cfg.
          expect(rule.shootoutAs, `${key}: shootoutAs is the sport's`).toBe(m.shootoutAs);
          const got = coverage(rule, reachableOutcomes(m, cfg, kind));
          checked++;
          if (!got.ok) failures.push(`${key} ${variant} ${kind}: ${JSON.stringify(got)}`);
        }
      }
    });
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`X-PT-3: ${checked} rules checked (sport × cfg × stage kind)`);
    expect(swept).toBe(SPORTS);
    expect(checked, "anti-vacuity: rules checked").toBeGreaterThanOrEqual(SPORTS * StageKind.options.length);
    expect(failures).toEqual([]);
    // 909 rules, each coverage-checked: measured 1.2-2.2 s on a loaded machine; the same headroom as X-PT-2.
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The rulebook rows, each from SPEC §5.10's signed values. Sequence: default variant → each preset → stage kind → sport.
// ---------------------------------------------------------------------------------------------------------------------

/** What `module`'s table pays one result under `cfg` in a `kind` stage: [home, away] as [W, D, L, Pts]. */
function pays(m: AnySportModule, cfg: unknown, kind: StageKind, p: Probe): [Row, Row] {
  const parsed: unknown = m.configSchema.parse(cfg);
  const old = m.standingsDelta(p.outcome, parsed, { kind }, p.state) as FixtureResult;
  const paid = payout(p.outcome, decidedInFor(m, p.outcome), old, p.played, ruleOf(m, parsed, kind), m.awardScoreKeys, setsToWinOf(m, parsed));
  return [row(paid[0]), row(paid[1])];
}
const at = (m: AnySportModule, cfg: unknown, outcome: MatchOutcome, played = true): Probe => ({
  outcome,
  state: m.init(m.configSchema.parse(cfg), defaultLineupPair(m.positions)),
  played,
});
const walkover = (winner: "H" | "A"): MatchOutcome => MatchOutcome.parse({ kind: "award", winner, loser: winner === "H" ? "A" : "H", reason: "walkover" });
const LEVEL = (kind: "draw" | "tie" | "no_result"): MatchOutcome => MatchOutcome.parse({ kind });
/** A set match folded from its summaries: `winner` takes it `won`-`lost`. */
function setsPlayed(m: AnySportModule, cfg: unknown, winner: "H" | "A", won: number, lost: number): Probe {
  const parsed = m.configSchema.parse(cfg) as SetCfg;
  const folded = fold(m, parsed, setStream(m, parsed, finalSets(winner, won, lost)));
  return { outcome: outcomeOf(m as never, folded as never)!, state: folded.state, played: true };
}

describe("W2d the sports' table points, row by row (SPEC §5.10)", () => {
  it("FB-PT-1 football group with a shoot-out: the SO winner gets 2, the loser 1, both drawn (RB2B-7, B2); W3 D1 L0 otherwise", () => {
    const cfg = { shootout: true };
    expect(pays(football, cfg, "group", at(football, cfg, winOf("H", "shootout")))).toEqual([[0, 1, 0, 2], [0, 1, 0, 1]]);
    expect(pays(football, cfg, "group", at(football, cfg, winOf("A", "shootout")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 2]]);
    expect(pays(football, cfg, "group", at(football, cfg, winOf("H")))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(football, cfg, "group", at(football, cfg, LEVEL("draw")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 1]]);
    // `soBonus` is the organiser's: a 2-point bonus pays the SO winner draw 1 + 2.
    const bonus2 = { shootout: true, points: { win: 3, draw: 1, loss: 0, soBonus: 2 } };
    expect(pays(football, bonus2, "group", at(football, bonus2, winOf("H", "shootout")))).toEqual([[0, 1, 0, 3], [0, 1, 0, 1]]);
    // Stage kind: a league books it the same.
    expect(pays(football, cfg, "league", at(football, cfg, winOf("H", "shootout")))).toEqual([[0, 1, 0, 2], [0, 1, 0, 1]]);
  });

  it("HK-PT-1 hockey default: 3/1/0 with draws (FIH), no shoot-out reached", () => {
    expect(reachableOutcomes(hockey, {}, "league").has("draw")).toBe(true);
    expect([...reachableOutcomes(hockey, {}, "league")].filter((k) => k.endsWith(".so"))).toEqual([]);
    expect(pays(hockey, {}, "league", at(hockey, {}, winOf("H")))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(hockey, {}, "league", at(hockey, {}, LEVEL("draw")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 1]]);
  });

  it("HK-PT-2 the fih-shootout preset pays 2/1 for a shoot-out and books D; regulation stays 3/0 (D10(f))", () => {
    const cfg = hockey.variants["fih-shootout"];
    expect(reachableOutcomes(hockey, cfg, "league").has("win.so")).toBe(true);
    expect(pays(hockey, cfg, "league", at(hockey, cfg, winOf("H", "shootout")))).toEqual([[0, 1, 0, 2], [0, 1, 0, 1]]);
    expect(pays(hockey, cfg, "group", at(hockey, cfg, winOf("A", "shootout")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 2]]);
    expect(pays(hockey, cfg, "league", at(hockey, cfg, winOf("H")))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    // `soBonus` is the organiser's here too: a 2-point bonus pays the SO winner draw 1 + 2.
    const bonus2 = { ...cfg, points: { win: 3, draw: 1, loss: 0, soBonus: 2 } };
    expect(pays(hockey, bonus2, "league", at(hockey, bonus2, winOf("H", "shootout")))).toEqual([[0, 1, 0, 3], [0, 1, 0, 1]]);
    // HK-TB-1: FIH counts regulation wins only — the module says so, and a shoot-out is no win on the table at all.
    expect(hockey.winsCount).toBe("regulation");
  });

  it("IH-PT-1 IIHF 3/2/1/0: regulation 3/0, overtime 2/1, the GWS paid as overtime and booked a result", () => {
    expect(pays(icehockey, {}, "league", at(icehockey, {}, winOf("H")))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(icehockey, {}, "league", at(icehockey, {}, winOf("H", "extra_time")))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
    expect(pays(icehockey, {}, "league", at(icehockey, {}, winOf("A", "shootout")))).toEqual([[0, 0, 1, 1], [1, 0, 0, 2]]);
  });

  it("IH-PT-2 recreational ice hockey: 2/1/0 with draws, no overtime and no shoot-out reached", () => {
    const cfg = icehockey.variants.recreational;
    expect([...reachableOutcomes(icehockey, cfg, "league")].sort()).toEqual(["draw", "loss.regulation", "win.regulation"]);
    expect(pays(icehockey, cfg, "league", at(icehockey, cfg, winOf("H")))).toEqual([[1, 0, 0, 2], [0, 0, 1, 0]]);
    expect(pays(icehockey, cfg, "league", at(icehockey, cfg, LEVEL("draw")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 1]]);
  });

  it("TT-PT-1 table tennis 2/1/0, an unplayed loss paying 0 (D6)", () => {
    for (const lost of [0, 1, 2]) {
      expect(pays(tabletennis, {}, "league", setsPlayed(tabletennis, {}, "H", 3, lost)), `3-${lost}`).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
    }
    expect(pays(tabletennis, {}, "league", { ...at(tabletennis, {}, walkover("A")), played: false })).toEqual([[0, 0, 1, 0], [1, 0, 0, 2]]);
    // Another preset (best of 7): the same 2/1/0.
    const bo7 = tabletennis.variants.bo7;
    expect(pays(tabletennis, bo7, "group", setsPlayed(tabletennis, bo7, "A", 4, 3))).toEqual([[0, 0, 1, 1], [1, 0, 0, 2]]);
  });

  it("VB-PT-1 FIVB best of 5 as SPEC §5.3's explicit map: 3-0 and 3-1 pay 3:0, 3-2 pays 2:1", () => {
    expect(ruleOf(volleyball, {}, "league").bySetScore).toEqual({ "3-0": [3, 0], "3-1": [3, 0], "3-2": [2, 1] });
    expect(pays(volleyball, {}, "league", setsPlayed(volleyball, {}, "H", 3, 0))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(volleyball, {}, "league", setsPlayed(volleyball, {}, "A", 3, 1))).toEqual([[0, 0, 1, 0], [1, 0, 0, 3]]);
    expect(pays(volleyball, {}, "league", setsPlayed(volleyball, {}, "H", 3, 2))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
  });

  it("VB-PT-2 FIVB best of 3: 2-0 pays 3:0, 2-1 pays 2:1 (D10(a)); beach's flat 2/0 is unchanged", () => {
    const bo3 = { bestOf: 3 };
    expect(ruleOf(volleyball, bo3, "league").bySetScore).toEqual({ "2-0": [3, 0], "2-1": [2, 1] });
    expect(pays(volleyball, bo3, "league", setsPlayed(volleyball, bo3, "H", 2, 0))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(volleyball, bo3, "league", setsPlayed(volleyball, bo3, "H", 2, 1))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
    const beach = volleyball.variants.beach;
    expect(pays(volleyball, beach, "league", setsPlayed(volleyball, beach, "A", 2, 1))).toEqual([[0, 0, 1, 0], [1, 0, 0, 2]]);
    // SPEC §5.3: beach's flat map is the rule as it stands, never spelled out per score.
    expect(ruleOf(volleyball, beach, "league").bySetScore).toEqual({ "*": [2, 0] });
  });

  it("VB a configured map with no \"*\" prices only its own scores; one pricing none of bestOf's scores is kept as written, and coverage names every gap", () => {
    // The expected maps are the organiser's own input: a score the map prices neither way stays out of the rule.
    const partial = { pointsMap: { "3-0": [3, 0], "3-1": [3, 0] } };
    const rule = ruleOf(volleyball, partial, "league");
    expect(Object.keys(rule.bySetScore ?? {}).sort()).toEqual(["3-0", "3-1"]);
    expect(rule.bySetScore).toEqual(partial.pointsMap);
    const gaps = coverage(rule, reachableOutcomes(volleyball, partial, "league"));
    expect(gaps.ok).toBe(false);
    expect(JSON.stringify(gaps)).toContain("3-2");
    // Best of 5 under a best-of-3 map: no score of bestOf is priced, so the map is kept as written (an empty table is
    // no rule at all) and coverage names all three of best-of-5's scores.
    const misfit = { pointsMap: { "2-0": [3, 0], "2-1": [2, 1] } };
    const kept = ruleOf(volleyball, misfit, "league");
    expect(PointsRule.parse(kept)).toEqual(kept);
    expect(kept.bySetScore).toEqual(misfit.pointsMap);
    const none = coverage(kept, reachableOutcomes(volleyball, misfit, "league"));
    expect(none.ok).toBe(false);
    for (const score of ["3-0", "3-1", "3-2"]) expect(JSON.stringify(none), score).toContain(score);
  });

  it("VB only the shipped FIVB map (any key order) takes the FIVB table; an organiser's map one key or one number away pays as written (D10(a))", () => {
    // Best of 3 is where the two differ: the FIVB table pays a 2-1 2:1, a map's "*" pays it the "*" pair. The expected
    // tables are the organiser's own map spelled out per best-of-3 score (exact entry, else "*"), or the FIVB rule's.
    const cases: { why: string; pointsMap: Record<string, [number, number]>; table: Record<string, [number, number]> }[] = [
      { why: "the shipped map, keys reordered", pointsMap: { "*": [3, 0], "3-2": [2, 1] }, table: { "2-0": [3, 0], "2-1": [2, 1] } },
      { why: "a key fewer (a flat 3:0)", pointsMap: { "*": [3, 0] }, table: { "*": [3, 0] } },
      { why: "same keys, one pair's first number moved", pointsMap: { "3-2": [2, 1], "*": [2, 0] }, table: { "2-0": [2, 0], "2-1": [2, 0] } },
      { why: "same keys, one pair's second number moved", pointsMap: { "3-2": [2, 1], "*": [3, 1] }, table: { "2-0": [3, 1], "2-1": [3, 1] } },
    ];
    for (const { why, pointsMap, table } of cases) expect(ruleOf(volleyball, { bestOf: 3, pointsMap }, "league").bySetScore, why).toEqual(table);
  });

  it("a pointsMap key that is no set score is skipped by the rule as the payer skips it; a map pricing no set score is refused, as the payer refuses its every match — every set sport (review M-4, counted)", () => {
    // The cfg schema takes any non-empty key; PointsRule takes only a set score or "*" (SET_SCORE_KEY). The payer reads a
    // match's exact "W-L", else "*" (`matchPoints`), so a key that is neither is never read.
    const code = (f: () => unknown): unknown => {
      try {
        f();
      } catch (e) {
        return (e as { code?: unknown }).code;
      }
      return "no throw";
    };
    const perSport = new Map<string, number>();
    forEachSport(({ key, module: m }) => {
      if (m.reachableSetScores === undefined) return; // a sport with no set table keeps no pointsMap
      // Two organiser maps: one paying two pairs (spelled out per score) and a flat one (kept as it stands, where a
      // copied key would land); the stray key paying a pair of its own, and the flat map's own pair (keeping it flat).
      const won = Math.ceil((m.configSchema.parse({}) as SetCfg).bestOf / 2);
      const maps: Record<string, [number, number]>[] = [{ "*": [3, 0], [`${won}-0`]: [3, 1] }, { "*": [2, 0] }];
      for (const organiser of maps) {
        for (const junk of ["x", "3:0", "best of five"]) {
          for (const pair of [[9, 9], organiser["*"]!]) {
            const cfg = m.configSchema.parse({ pointsMap: { ...organiser, [junk]: pair } });
            expect((cfg as Raw).pointsMap, `${key}: the cfg schema keeps "${junk}"`).toHaveProperty([junk]);
            for (const kind of TABLE_KINDS) {
              const rule = ruleOf(m, cfg, kind);
              const where = `${key} ${JSON.stringify((cfg as Raw).pointsMap)} ${kind}`;
              expect(PointsRule.safeParse(rule).success, `${where}: a rule the schema takes`).toBe(true);
              // Expected: the organiser's map without the key, as that map's own rule spells it.
              expect(rule, `${where}: the key is skipped`).toEqual(ruleOf(m, { pointsMap: organiser }, kind));
              perSport.set(key, (perSport.get(key) ?? 0) + 1);
            }
          }
        }
      }
      // No set score priced at all: the payer refuses every played match, and the rule refuses the map. An empty map is
      // the cfg schema's own refusal.
      expect(m.configSchema.safeParse({ pointsMap: {} }).success, `${key}: the cfg schema refuses an empty map`).toBe(false);
      perSport.set(key, (perSport.get(key) ?? 0) + 1);
      for (const pointsMap of [{ x: [3, 0] }, { "3:0": [3, 0], "best of five": [2, 1] }]) {
        const cfg = m.configSchema.parse({ pointsMap });
        const won = setsPlayed(m, cfg, "H", Math.ceil((cfg as SetCfg).bestOf / 2), 0);
        expect(code(() => m.standingsDelta(won.outcome, cfg, { kind: "league" }, won.state)), `${key} ${JSON.stringify(pointsMap)}: the payer refuses`).toBe("INVALID_EVENT");
        expect(code(() => m.tablePointsRule(cfg as never, "league")), `${key} ${JSON.stringify(pointsMap)}: the rule refuses`).toBe("CONFIG_INVALID");
        perSport.set(key, (perSport.get(key) ?? 0) + 1);
      }
    });
    expect([...perSport.keys()].sort(), "the set sports, each checked").toEqual(["badminton", "tabletennis", "volleyball"]);
    for (const [key, n] of perSport) expect(n, `${key}: cases checked`).toBe(2 * 3 * 2 * TABLE_KINDS.length + 3);
  });

  it("VB settled abandons pay FIVB 6.4.3's score under the default maps: 1-1 ⇒ 3-1 (3:0), 2-2 ⇒ 3-2 (2:1), bo3 1-1 ⇒ 2-1 (2:1)", () => {
    const settled = (cfg: unknown, sets: boolean[]): Probe => {
      const parsed = volleyball.configSchema.parse(cfg) as SetCfg;
      const tail = [ev("core.abandon", { reason: "the hall lost power" }), ev("core.settle", { winner: "H", method: "lot" })];
      const folded = fold(volleyball, parsed, setStream(volleyball, parsed, sets, tail));
      const outcome = outcomeOf(volleyball as never, folded as never);
      expect(outcome).toMatchObject({ kind: "win", winner: "H", method: "settled_lot" });
      return { outcome: outcome!, state: folded.state, played: true };
    };
    expect(pays(volleyball, {}, "league", settled({}, [true, false]))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(pays(volleyball, {}, "league", settled({}, [true, false, true, false]))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
    expect(pays(volleyball, { bestOf: 3 }, "league", settled({ bestOf: 3 }, [true, false]))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
  });

  it("BG-PT-1 chess default is 2/1/0 in half-points (unit 'half'), as 1/½/0", () => {
    const rule = ruleOf(boardgame, {}, "swiss");
    expect(rule.unit).toBe("half");
    expect(pays(boardgame, {}, "swiss", at(boardgame, {}, winOf("H")))).toEqual([[1, 0, 0, 2], [0, 0, 1, 0]]);
    expect(pays(boardgame, {}, "league", at(boardgame, {}, LEVEL("draw")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 1]]);
  });

  it("CK-PT-1 cricket default 2/1/1/0: a win 2, a tie 1 each, a no result 1 each", () => {
    expect(pays(cricket, {}, "group", at(cricket, {}, winOf("H")))).toEqual([[1, 0, 0, 2], [0, 0, 1, 0]]);
    expect(pays(cricket, {}, "group", at(cricket, {}, LEVEL("tie")))).toEqual([[0, 0, 0, 1], [0, 0, 0, 1]]);
    expect(pays(cricket, {}, "group", at(cricket, {}, LEVEL("no_result")))).toEqual([[0, 0, 0, 1], [0, 0, 0, 1]]);
  });

  it("CK-PT-2 the two-innings draw appears only when inningsPerSide === 2, and pays 1 by default (D10(c))", () => {
    for (const v of ["t20", "odi", "hundred"]) {
      expect(reachableOutcomes(cricket, cricket.variants[v], "league").has("draw"), v).toBe(false);
      expect(ruleOf(cricket, cricket.variants[v], "league").draw, v).toBeUndefined();
    }
    const twoInnings = { ...cricket.variants.test, points: { win: 2, tie: 2, noResult: 1, loss: 0 } };
    expect(reachableOutcomes(cricket, twoInnings, "league").has("draw")).toBe(true);
    expect(pays(cricket, twoInnings, "league", at(cricket, twoInnings, LEVEL("draw")))).toEqual([[0, 1, 0, 1], [0, 1, 0, 1]]);
    // The organiser's own draw points still pay.
    const own = { ...cricket.variants.test, points: { win: 2, tie: 1, noResult: 1, loss: 0, draw: 3 } };
    expect(pays(cricket, own, "league", at(cricket, own, LEVEL("draw")))).toEqual([[0, 1, 0, 3], [0, 1, 0, 3]]);
  });
});

describe("W2d PS-1 soBonus replaces shootoutWin/shootoutLoss (greenfield, no alias)", () => {
  it("football and hockey take `soBonus` and STRIP shootoutWin/shootoutLoss; ice hockey (a result sport) has no bonus knob", () => {
    const old = { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 };
    expect((football.configSchema.parse({ points: old }) as { points: Raw }).points).toEqual({ win: 3, draw: 1, loss: 0 });
    expect((hockey.configSchema.parse({ points: old }) as { points: Raw }).points).toEqual({ win: 3, draw: 1, loss: 0 });
    expect((football.configSchema.parse({ points: { win: 3, draw: 1, loss: 0, soBonus: 2 } }) as { points: Raw }).points.soBonus).toBe(2);
    expect((hockey.configSchema.parse(hockey.variants["fih-shootout"]) as { points: Raw }).points).toEqual({ win: 3, draw: 1, loss: 0, soBonus: 1 });
    // A shoot-out booked as a result pays `win.so`/`loss.so` (here: overtime's), never a bonus — the rule refuses one.
    const ih = (icehockey.configSchema.parse({ points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, soBonus: 1, shootoutWin: 2 } }) as { points: Raw }).points;
    expect(ih).toEqual({ win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1 });
  });

  it("PS-1 a shoot-out win's standingsDelta reads no deleted key: football pays win/loss, the period kernel otWin ?? win", () => {
    const delta = (m: AnySportModule, cfg: Raw, outcome: MatchOutcome): Row[] => {
      const parsed: unknown = m.configSchema.parse(cfg);
      return (m.standingsDelta(outcome, parsed, { kind: "league" }, m.init(parsed, defaultLineupPair(m.positions))) as FixtureResult).map(row);
    };
    const split = { win: 3, draw: 1, loss: 0, shootoutWin: 2, shootoutLoss: 1 };
    // Expected from each cfg's own win/loss (and otWin/otLoss), never the deleted split.
    expect(delta(football, { shootout: true, points: split }, winOf("H", "shootout"))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(delta(hockey, { ...hockey.variants["fih-shootout"] }, winOf("H", "shootout"))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(delta(icehockey, { points: { win: 3, draw: 1, loss: 0, otWin: 2, otLoss: 1, shootoutWin: 3, shootoutLoss: 0 } }, winOf("A", "shootout"))).toEqual([[0, 0, 1, 1], [1, 0, 0, 2]]);
  });

  it("PS-1 an UNPARSED frozen cfg still carrying shootoutWin/shootoutLoss pays exactly the plain shoot-out win, every sport (review M-2, counted)", () => {
    // A recorded cfg read back without the schema keeps the deleted keys: the payer must not read them. The split is
    // 100 and 101 past the cfg's largest own value, a pair none of its keys pays, so a reader that came back would pay it.
    const freeze = (m: AnySportModule, parsed: unknown): { frozen: unknown; split: number[] } => {
      const field = pointsFieldOf(m)?.field;
      if (field === undefined) return { frozen: parsed, split: [] };
      const own = (parsed as Raw)[field] as Raw;
      const top = Math.max(0, ...Object.values(own).filter((v): v is number => typeof v === "number"));
      return { frozen: { ...(parsed as Raw), [field]: { ...own, shootoutWin: top + 100, shootoutLoss: top + 101 } }, split: [top + 100, top + 101] };
    };
    const perSport = new Map<string, number>();
    const swept = forEachSport(({ key, module: m }) => {
      for (const { variant, cfg } of cfgSpace(m)) {
        const parsed: unknown = m.configSchema.parse(cfg);
        const { frozen, split } = freeze(m, parsed);
        for (const kind of TABLE_KINDS) {
          for (const p of probes(m, parsed, kind)) {
            if (p.outcome.kind !== "win" || p.outcome.method !== "shootout") continue;
            const plain = (m.standingsDelta(p.outcome, parsed, { kind }, p.state) as FixtureResult).map(row);
            const read = (m.standingsDelta(p.outcome, frozen as never, { kind }, p.state) as FixtureResult).map(row);
            expect(read, `${key} ${variant} ${kind} ${JSON.stringify(p.outcome)}`).toEqual(plain);
            for (const n of split) expect(read.map((r) => r[3]), `${key} ${variant}: no deleted key paid`).not.toContain(n);
            perSport.set(key, (perSport.get(key) ?? 0) + 1);
          }
        }
      }
    });
    // eslint-disable-next-line no-console -- TEST-STRATEGY anti-vacuity: the sweep reports what it checked
    console.info(`PS-1 frozen: ${[...perSport].map(([k, n]) => `${k} ${n}`).join(", ")} shoot-out wins checked`);
    expect(swept, "every registered sport swept").toBe(SPORTS);
    // The sports whose own methods hold a shoot-out are the ones checked, each at least once (zero is a failure).
    forEachSport(({ key, module: m }) => {
      if (m.outcomeMethods.includes("shootout")) expect(perSport.get(key) ?? 0, `${key}: shoot-out wins checked`).toBeGreaterThan(0);
      else expect(perSport.has(key), `${key} has no shoot-out`).toBe(false);
    });
    expect(perSport.size, "anti-vacuity: sports with a shoot-out checked").toBeGreaterThan(0);
    // The anchors, from each cfg's own numbers (PS-1: the chain with no split): football win/loss, the period kernel
    // otWin ?? win (IIHF's GWS 2/1, FIH's plain 3/0).
    const unparsed = (m: AnySportModule, cfg: Raw, outcome: MatchOutcome): Row[] => {
      const parsed: unknown = m.configSchema.parse(cfg);
      return (m.standingsDelta(outcome, freeze(m, parsed).frozen as never, { kind: "league" }, m.init(parsed, defaultLineupPair(m.positions))) as FixtureResult).map(row);
    };
    expect(unparsed(football, { shootout: true }, winOf("H", "shootout"))).toEqual([[1, 0, 0, 3], [0, 0, 1, 0]]);
    expect(unparsed(hockey, { ...hockey.variants["fih-shootout"] }, winOf("A", "shootout"))).toEqual([[0, 0, 1, 0], [1, 0, 0, 3]]);
    expect(unparsed(icehockey, {}, winOf("H", "shootout"))).toEqual([[1, 0, 0, 2], [0, 0, 1, 1]]);
  }, 60_000);

  it("PS-1 a shoot-out booked as a result takes no soBonus into its rule, even from an unparsed cfg that carries one; a bonus sport still does (review M-3)", () => {
    // Ice hockey books the GWS as a result (IIHF); its schema strips `soBonus`, a frozen cfg read back without it does not.
    // PointsRule refuses a bonus on a result booking, so a rule that copied it would be no rule at all.
    const ih = icehockey.configSchema.parse({}) as unknown as Raw;
    const ihFrozen = { ...ih, points: { ...(ih.points as Raw), soBonus: 2 } };
    for (const kind of TABLE_KINDS) {
      const rule = icehockey.tablePointsRule(ihFrozen as never, kind);
      expect(rule.shootoutAs, `ice hockey ${kind}`).toBe("result");
      expect(rule.soBonus, `ice hockey ${kind}: no bonus on a result booking`).toBeUndefined();
      expect(PointsRule.safeParse(rule).success, `ice hockey ${kind}: a rule the schema takes`).toBe(true);
    }
    // The other direction: hockey's draw-plus-bonus booking keeps the organiser's bonus, parsed or not.
    const hk = hockey.configSchema.parse(hockey.variants["fih-shootout"]) as unknown as Raw;
    const hkBonus = { ...hk, points: { ...(hk.points as Raw), soBonus: 2 } };
    expect(hockey.tablePointsRule(hkBonus as never, "league")).toMatchObject({ shootoutAs: "draw_plus_bonus", soBonus: 2 });
    expect(TABLE_KINDS.length, "anti-vacuity: table stage kinds checked").toBeGreaterThan(0);
  });
});
