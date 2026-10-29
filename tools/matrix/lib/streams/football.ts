// football — goals + period markers only (no coarse result event).
// resolveFullTime (football.ts:999-1024): level at FT → ET if enabled, else
// SHOOTOUT if enabled, else draw. applyPeriod (:1528+) gates every marker on
// cfg.halves, so the marker list must match the mode.
//
// W2e Task 19 (G1, G2): a win down a DECIDING PATH. `extraTime`: level at full
// time, the winner's goal in the first half of extra time, then ET_HT and ET_FT
// (resolveFullTime at ET_FT decides it, method `extra_time`). `shootout`: level
// at full time (and after extra time, when the cfg plays it), then the kicks —
// each taken by the side the ENGINE names next (`footballNextKicker`, football's
// own IFAB order; Task 9 made an out-of-turn kick a strict refusal), every kick
// of the cfg's attempts scored, then sudden death until the winner leads. Each
// path is built only where the cfg switches it on; what decided the fold is read
// back through the engine's own `decidedInFor`, never from this stream.
import { decidedInFor } from "@seazn/engine/competition";
import { football, footballNextKicker, type ShootoutKick } from "@seazn/engine/sports/football";
import { foldStream } from "../fold.ts";
import {
  GeneratorUnsupported, OutcomeUnreachable, START, idOf, outcomeLabel,
  type DecidedRequest, type DecidingPath, type Side, type SportStreamGenerator, type StreamEvent,
} from "./types.ts";

export function footballPhases(halves: number): string[] | null {
  if (halves === 2) return ["HT", "FT"];
  if (halves === 4) return ["QT", "HT", "3QT", "FT"];
  return null;
}

interface FootballCfg { halves: number; extraTime?: { enabled?: boolean } | null; shootout?: unknown; shootoutAttempts?: number }

/** What decided a football win down each path, in the engine's vocabulary (sport/module.ts DecidedIn): extra time is
 *  an overtime period ("ot"), the penalties a shoot-out ("so"). Football has no other deciding path. */
const FOOTBALL_DECIDED_IN: Readonly<Partial<Record<DecidingPath, "ot" | "so">>> = Object.freeze({ extraTime: "ot", shootout: "so" });

const period = (phase: string): StreamEvent => ({ type: "football.period", payload: { phase } });
const goal = (by: string, minute: number): StreamEvent => ({ type: "football.goal", payload: { by, minute } });
const etOn = (cfg: FootballCfg): boolean => cfg.extraTime?.enabled === true;
const soOn = (cfg: FootballCfg): boolean => cfg.shootout === true;

/** The kicks of a shoot-out `winner` wins: every kick of the cfg's attempts scored (level after them, so it goes to
 *  sudden death), then the winner scores and the loser misses. The kicker of each is the engine's next kicker; the
 *  first kick is home's (football lets either side open: `footballNextKicker([])` is null). It stops at the kick the
 *  STRICT fold decides on, so nothing is posted to a match already over. */
function shootoutKicks(req: DecidedRequest, cfg: FootballCfg, before: readonly StreamEvent[], winner: Side): StreamEvent[] {
  // The stage's own count, else what the engine declares an absent key means (FB-SO-1: the Laws' 5).
  const attempts = cfg.shootoutAttempts ?? football.ruleKeys?.shootoutAttempts?.whenAbsent;
  if (typeof attempts !== "number") throw new Error("streams: football declares no shoot-out attempts default (ruleKeys.shootoutAttempts.whenAbsent)");
  const taken: ShootoutKick[] = [];
  const out: StreamEvent[] = [];
  // Bounded: the regulation kicks, then one sudden-death pair. A stream still undecided after them is a defect.
  for (let i = 0; i < 2 * attempts + 2; i++) {
    const side: Side = footballNextKicker(taken) ?? "home";
    const scored = taken.filter((k) => k.side === side).length < attempts ? true : side === winner;
    taken.push({ side, scored });
    out.push({ type: "football.shootout.kick", payload: { by: idOf(req, side), scored } });
    if (foldStream(football, req.cfg, req.home, req.away, [...before, ...out]).outcome !== null) return out;
  }
  throw new Error(`streams: football shoot-out for ${winner} undecided after ${out.length} kick(s) (attempts ${attempts})`);
}

export const footballGenerator: SportStreamGenerator = {
  sportKeys: ["football"],
  decided(req) {
    const cfg = req.cfg as FootballCfg;
    const phases = footballPhases(cfg.halves);
    if (phases === null) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `halves ${cfg.halves}`);
    // supportsDraws (football.ts:2666) reads the stage only, never the cfg, so
    // a league cfg with ET or a shootout is declared drawable while its level
    // FT continues instead of ending. Refuse rather than emit a stream that
    // folds undecided.
    if (req.outcome.kind === "draw" && (etOn(cfg) || Boolean(cfg.shootout))) {
      throw new GeneratorUnsupported(req.sportKey, "draw", "level FT continues to ET/shootout under this cfg");
    }
    const markers: StreamEvent[] = phases.map(period);
    if (req.outcome.kind === "draw") return [START, ...markers];
    const { winner, path } = req.outcome;
    if (path === undefined) return [START, goal(idOf(req, winner), 10), ...markers];
    const label = outcomeLabel(req.outcome);
    if (FOOTBALL_DECIDED_IN[path] === undefined) throw new OutcomeUnreachable(req.sportKey, label, `football has no '${path}' deciding path (its deciders are extra time and the shoot-out)`);
    if (path === "extraTime") {
      if (!etOn(cfg)) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch extra time on (extraTime.enabled)");
      return [START, ...markers, goal(idOf(req, winner), 100), period("ET_HT"), period("ET_FT")];
    }
    if (!soOn(cfg)) throw new OutcomeUnreachable(req.sportKey, label, "the cfg does not switch the shoot-out on (shootout)");
    const level = [START, ...markers, ...(etOn(cfg) ? [period("ET_HT"), period("ET_FT")] : [])];
    return [...level, ...shootoutKicks(req, cfg, level, winner)];
  },
  // W2e (Task 19, F8): the engine's own reading of the fold — `decidedInFor` over football's win-method table.
  pathWitness(path, fold) {
    const want = FOOTBALL_DECIDED_IN[path];
    return want !== undefined && decidedInFor(football, fold.outcome) === want;
  },
  // W2b (FB-RT-1): a goal each in the first half, no period marker — the match is live.
  partial(req) {
    return [
      { type: "football.goal", payload: { by: req.home, minute: 10 } },
      { type: "football.goal", payload: { by: req.away, minute: 20 } },
    ];
  },
};
