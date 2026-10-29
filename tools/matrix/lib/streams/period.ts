// hockey / icehockey — period kernel. `to` must be the exact next label under a
// strict fold (period/kernel.ts:1140-1160 applyAdvance; expectedAdvance :997;
// labels periodLabels :650-655): 4 → Q, 2 → H, otherwise P; then FT.
//
// W2e Task 20 (G2, G3): a win down a DECIDING PATH. `overtime`: level through regulation, the overtime period(s), the
// winner's goal there (sudden death ends on it; fixed extra periods are walked out to their final whistle, where the
// leader wins). `shootout` (FIH) and `gws` (the IIHF's game-winning shots) are the same kernel mechanism under two
// names: level through regulation (and through any overtime the cfg plays), then the attempts — each taken by the side
// the ENGINE names next (`summary().detail.shootoutNext`, which is `expectedKicker` under the preset's `shootoutOrder`:
// FIH flips the opener per series, the IIHF's tie-break is opened by the side that shot second; Task 9 made an
// out-of-turn attempt a strict refusal), every attempt of the cfg's first round scored, then sudden death until the
// winner leads. Every whistle is the label the engine names next (`detail.nextAdvance`), so no overtime label is listed
// here. A path is built only where the cfg switches it on and the sport's engine declares the decider (its rule keys:
// ice hockey has overtime and the shoot-out, hockey the shoot-out alone); what decided the fold is read back through
// the engine's own `decidedInFor`, and the shoot-out's name through the label the engine gives its pad panel (the cfg half)
// and the label the PRODUCT's summary headline prints (Task 21: the product half).
import { decidedInFor } from "@seazn/engine/competition";
import { deciderKeysFor } from "@seazn/engine/sport";
import { foldStream } from "../fold.ts";
import { sportModule } from "../sport-cfg.ts";
import {
  OutcomeUnreachable, START, idOf, outcomeLabel,
  type DecidedRequest, type DecidingPath, type Side, type SportStreamGenerator, type StreamEvent, type StreamRequest,
} from "./types.ts";

export function periodLabels(count: number): string[] {
  const prefix = count === 4 ? "Q" : count === 2 ? "H" : "P";
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

/** The overtime a period cfg plays (kernel.ts PeriodParams.overtime): one sudden-death period, or fixed extra periods. */
export type PeriodOvertime = { kind: "sudden_death"; minutes: number; skaters?: number } | { kind: "periods"; count: number; minutes: number };

/** The whistles INSIDE an overtime, in order (kernel.ts expectedAdvance over otLabels): sudden death is one period, so
 *  only the final FT; `count` fixed periods are OT1…OTn (a lone one is "OT"), each whistled to the next, then FT. The pad
 *  adapter walks them (pads/period.ts); the generator below asks the engine instead. */
export function overtimeWhistles(overtime: PeriodOvertime): string[] {
  const later = overtime.kind === "sudden_death" ? [] : Array.from({ length: overtime.count - 1 }, (_, i) => `OT${i + 2}`);
  return [...later, "FT"];
}

interface PeriodCfg { periods: { count: number }; overtime?: PeriodOvertime | null; shootout?: { attempts: number } | null }

/** W2d T18 (HK-TB-2): the write path refuses a hockey goal without its type (GOAL_KIND_REQUIRED), so a hockey goal
 *  is a field goal (`fg`, FIH's open-play goal); an ice-hockey goal stays typeless. */
function goalPayload(sportKey: string, by: string): Record<string, unknown> {
  return sportKey === "hockey" ? { by, kind: "fg" } : { by };
}

/** What decided a win down each path, in the engine's vocabulary (sport/module.ts DecidedIn): overtime is "ot", the
 *  shoot-out and the GWS are both "so". */
const PERIOD_DECIDED_IN: Readonly<Partial<Record<DecidingPath, "ot" | "so">>> = Object.freeze({ overtime: "ot", shootout: "so", gws: "so" });
/** The request vocabulary's name for the shoot-out label the engine gives its pad panel (preset.shootoutLabel: FIH "SO",
 *  IIHF "GWS"). A label this file does not know is a defect, named. */
const LABEL_PATH: Readonly<Record<string, DecidingPath>> = Object.freeze({ SO: "shootout", GWS: "gws" });

/** The engine's own name for the shoot-out this cfg plays (the label of the pad panel that carries the sport's attempt
 *  event - `preset.shootoutLabel`, which the summary headline prints too); undefined when the cfg plays none (no panel). */
function shootoutLabelOf(sportKey: string, cfg: unknown): string | undefined {
  const spec = sportModule(sportKey).padSpec?.(cfg);
  return spec?.panels.find((p) => p.actions.some((a) => a.type === `${sportKey}.shootout.attempt`))?.labelKey.label;
}

/** The deciding path of the shoot-out this cfg plays, from the engine's own label for it; null when the cfg plays none. */
function shootoutPathOf(sportKey: string, cfg: unknown): DecidingPath | null {
  const label = shootoutLabelOf(sportKey, cfg);
  if (label === undefined) return null;
  const path = LABEL_PATH[label];
  if (path === undefined) throw new Error(`streams: ${sportKey} calls its shoot-out '${label}', which the period generator has no deciding path for`);
  return path;
}

const advance = (sportKey: string, to: string): StreamEvent => ({ type: `${sportKey}.period.advance`, payload: { to } });

/** What the engine publishes about a fold (summary().detail): the phase, the whistle it names next, whose shoot-out turn
 *  it is (null before the first attempt: either side may open), and whether the match is decided. */
interface Probe { phase: string; nextAdvance: string | null; shootoutNext: Side | null; decided: boolean }
function probe(req: StreamRequest, events: readonly StreamEvent[]): Probe {
  const module = sportModule(req.sportKey);
  const folded = foldStream(module, req.cfg, req.home, req.away, events);
  const d = (module.summary(folded.state).detail ?? {}) as { phase?: unknown; nextAdvance?: unknown; shootoutNext?: unknown };
  if (typeof d.phase !== "string") throw new Error(`streams: ${req.sportKey} publishes no phase on its summary`);
  return {
    phase: d.phase,
    nextAdvance: typeof d.nextAdvance === "string" ? d.nextAdvance : null,
    shootoutNext: d.shootoutNext === "home" || d.shootoutNext === "away" ? d.shootoutNext : null,
    decided: folded.outcome !== null,
  };
}

/** Whistle after whistle, each one the engine's `nextAdvance`, until `stop`. Bounded, and a stream with no whistle left
 *  before it stops is the generator's defect, named. */
function whistleUntil(req: StreamRequest, from: readonly StreamEvent[], stop: (p: Probe) => boolean, until: string): StreamEvent[] {
  const out = [...from];
  for (let i = 0; i < 16; i++) {
    const p = probe(req, out);
    if (stop(p)) return out;
    if (p.nextAdvance === null) throw new Error(`streams: ${req.sportKey} has no whistle left from phase '${p.phase}' before ${until}`);
    out.push(advance(req.sportKey, p.nextAdvance));
  }
  throw new Error(`streams: ${req.sportKey} did not reach ${until} in 16 whistles`);
}

/** The attempts of a shoot-out `winner` wins: every attempt of the cfg's first round scored (level after them, so it goes
 *  to sudden death), then the winner scores and the loser misses. The taker of each is the side the engine names next
 *  (`shootoutNext`; null only before the first attempt, which either side may open — home does). It stops at the attempt
 *  the STRICT fold decides on, so nothing is posted to a match already over. */
function shootoutAttempts(req: StreamRequest, from: readonly StreamEvent[], winner: Side, attempts: number): StreamEvent[] {
  const out = [...from];
  const taken: Record<Side, number> = { home: 0, away: 0 };
  // Bounded: the first round, then one sudden-death pair. A stream still undecided after them is a defect.
  for (let i = 0; i < 2 * attempts + 2; i++) {
    const p = probe(req, out);
    const side: Side = p.shootoutNext ?? "home";
    const scored = taken[side] < attempts ? true : side === winner;
    taken[side]++;
    out.push({ type: `${req.sportKey}.shootout.attempt`, payload: { by: idOf(req, side), scored } });
    if (probe(req, out).decided) return out;
  }
  throw new Error(`streams: ${req.sportKey} shoot-out for ${winner} undecided after ${out.length - from.length} attempt(s) (attempts ${attempts})`);
}

/** A win down `path`: refused (OutcomeUnreachable) for a path the sport's engine declares no decider for, and for one the
 *  cfg does not switch on. The decider keys are the module's own (`deciderKeysFor`); the shoot-out is the sport's own
 *  path by the engine's label, so hockey's is 'shootout' and ice hockey's is 'gws'. */
function decidingPath(req: DecidedRequest, winner: Side, path: DecidingPath): StreamEvent[] {
  const cfg = req.cfg as PeriodCfg;
  const label = outcomeLabel(req.outcome);
  const keys = deciderKeysFor(sportModule(req.sportKey), req.stageKind, null);
  const foreign = (): never => {
    const own = keys.map((k) => (k === "shootout" ? (cfg.shootout ? shootoutPathOf(req.sportKey, cfg) : null) ?? "shootout" : k));
    throw new OutcomeUnreachable(req.sportKey, label, `${req.sportKey} has no '${path}' deciding path (its deciders: ${own.join(", ")})`);
  };
  const regulation = periodLabels(cfg.periods.count);
  const level = (stop: (p: Probe) => boolean, until: string) => whistleUntil(req, [START], stop, until);
  if (path === "overtime") {
    if (!keys.includes("overtime")) return foreign();
    if (cfg.overtime == null) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch overtime on (overtime)");
    // Regulation ends level, which opens the first overtime period; the winner's goal there, then whistles to the end if it did not decide.
    const inOvertime = level((p) => !regulation.includes(p.phase), "overtime");
    const scored: StreamEvent = { type: `${req.sportKey}.goal`, payload: goalPayload(req.sportKey, idOf(req, winner)) };
    return whistleUntil(req, [...inOvertime, scored], (p) => p.decided, "the end of overtime");
  }
  if (path === "shootout" || path === "gws") {
    if (cfg.shootout == null) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch the shoot-out on (shootout)");
    if (shootoutPathOf(req.sportKey, cfg) !== path) return foreign();
    // Level through regulation and any overtime (no goal at all), then the attempts.
    const atShootout = level((p) => p.phase === "SHOOTOUT" || p.decided, "the shoot-out");
    return shootoutAttempts(req, atShootout, winner, cfg.shootout.attempts);
  }
  return foreign();
}

export const periodGenerator: SportStreamGenerator = {
  sportKeys: ["hockey", "icehockey"],
  decided(req) {
    if (req.outcome.kind === "win" && req.outcome.path !== undefined) return decidingPath(req, req.outcome.winner, req.outcome.path);
    const labels = periodLabels((req.cfg as PeriodCfg).periods.count);
    const advances: StreamEvent[] = [...labels.slice(1), "FT"].map((to) => ({ type: `${req.sportKey}.period.advance`, payload: { to } }));
    // A draw is only requested where supportsDraws is true (overtime and
    // shootout null, period/kernel.ts:2644), so a level FT is terminal there.
    const goals: StreamEvent[] = req.outcome.kind === "draw" ? [] : [{ type: `${req.sportKey}.goal`, payload: goalPayload(req.sportKey, idOf(req, req.outcome.winner)) }];
    return [START, ...goals, ...advances];
  },
  // W2e (Task 20, F8; Task 21): the engine's own reading of the fold. The outcome carries overtime (method `extra_time`) and
  // the shoot-out (method `shootout`) through `decidedInFor`; the shoot-out's NAME (hockey's SO, the IIHF's GWS) is the
  // sport's - both write the same method - so it is the label the engine gives the cfg's shoot-out (the request's path
  // must be the one that label names), and, when the fold carries the PRODUCT's /state, that label must be the one the
  // product's own summary headline prints: `(SO 3–2)` or `(GWS 3–2)` (kernel.ts summary).
  pathWitness(path, fold) {
    const want = PERIOD_DECIDED_IN[path];
    if (want === undefined || decidedInFor(sportModule(fold.sportKey), fold.outcome) !== want) return false;
    if (want === "ot") return true;
    if (shootoutPathOf(fold.sportKey, fold.cfg) !== path) return false;
    if (fold.product === null) return true;
    const headline = (fold.product.summary as { headline?: unknown } | null)?.headline;
    return typeof headline === "string" && headline.includes(`(${shootoutLabelOf(fold.sportKey, fold.cfg)} `);
  },
  // W2b (HK-RT-1, IH-RT-1): a goal each, no period advanced — `${key}.goal {by}` (`{by, kind}` for hockey, W2d T18).
  partial(req) {
    return [
      { type: `${req.sportKey}.goal`, payload: goalPayload(req.sportKey, req.home) },
      { type: `${req.sportKey}.goal`, payload: goalPayload(req.sportKey, req.away) },
    ];
  },
};
