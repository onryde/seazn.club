// cricket — one coarse summary per innings (cricket.ts:231-238, applySummary
// :1644); HOME bats first without a toss (battingFirst "home", :3626). A
// non-partial summary closes its innings; the chase closes on the target
// passed. Wickets never exceed the engine's all-out, which follows
// playersPerSide (allOutWickets, :625-629, refused under a strict fold at
// :1682), and legal balls never exceed the innings quota, which follows
// ballsPerInnings (refused under a strict fold at :1686); a winning chase
// keeps a wicket in hand. Two innings a side (the `test` preset and every
// committed case on it) is built too since ruling 44: a follow-on where the
// cfg allows it, a draw on time (cricket.match.close), and a level tie.
import type { PadSpec } from "@seazn/engine/sport";
import { sportModule } from "../sport-cfg.ts";
import { GeneratorUnsupported, OutcomeUnreachable, START, outcomeLabel, type DecidedRequest, type SportStreamGenerator, type StreamEvent, type StreamRequest } from "./types.ts";

interface CricketCfg {
  inningsPerSide: number;
  ballsPerInnings: number | null;
  superOver?: boolean;
  followOn?: { enabled?: boolean; lead?: number };
}

const SUMMARY = "cricket.innings.summary";
/** A fixed legal-ball count per innings where the cfg sets no over limit (the
 *  `test` preset's ballsPerInnings is null): 90 overs × 6. Any value the
 *  summary schema accepts serves; with no quota the fold never reads it as a
 *  limit. A cfg with a quota uses the quota instead (strict fold, :1686). */
export const TEST_BALLS = 540;
/** CricketMatchClose (cricket.ts:254): `z.strictObject({})` — time expiry ⇒ draw (:3736-3743). */
const MATCH_CLOSE_DRAW = Object.freeze({});
/** CricketFollowOn (cricket.ts:267): `z.strictObject({})` — enforced between the 2nd and 3rd innings on a lead ≥ followOn.lead (:3755-3770). */
const FOLLOW_ON_PAYLOAD = Object.freeze({});
/** The first-innings lead the follow-on shape builds (500 − 200). */
const FOLLOW_ON_LEAD = 300;

/** The engine's own declaration refused: its padSpec carries no usable wicket
 *  ceiling for an innings total, so there is no all-out to clamp to. */
export class AllOutUndeclared extends Error {
  constructor(why: string) {
    super(`streams: cricket padSpec declares no all-out for '${SUMMARY}' — ${why}`);
    this.name = "AllOutUndeclared";
  }
}

/** All-out as the engine declares it: the `wickets` ceiling of the innings
 *  summary action (cricket.ts padSpec, max = playersPerSide − 1, :3097) — the
 *  same threshold allOutWickets enforces for the harness's empty lineups. A
 *  winning chase needs a wicket in hand, so a ceiling below 1 is refused. */
export function declaredAllOut(spec: PadSpec | undefined): number {
  const action = spec?.panels.flatMap((p) => p.actions).find((a) => a.type === SUMMARY);
  if (action === undefined) throw new AllOutUndeclared("no such action");
  const field = action.fields.find((f) => f.path === "wickets");
  if (field?.kind !== "number") throw new AllOutUndeclared("no numeric 'wickets' field");
  if (!Number.isInteger(field.max) || field.max < 1) throw new AllOutUndeclared(`wickets max is ${field.max}`);
  return field.max;
}

const allOutOf = (req: StreamRequest): number => declaredAllOut(sportModule(req.sportKey).padSpec?.(req.cfg));

/** Two innings a side. HOME bats 1st and 3rd, AWAY 2nd and 4th (no toss);
 *  after a follow-on AWAY bats 2nd and 3rd. A non-partial summary closes its
 *  innings whatever its wickets (:1704); the draw's last innings is partial,
 *  so it keeps a wicket and a ball in hand or autoClose ends it (:1023-1038)
 *  and the match is decided before time runs out. */
function twoInnings(req: DecidedRequest, cfg: CricketCfg, allOut: number): StreamEvent[] {
  const balls = cfg.ballsPerInnings ?? TEST_BALLS;
  const open = (n: number): number => Math.min(n, allOut - 1);
  const s = (runs: number, wickets: number, extra: Record<string, unknown> = {}): StreamEvent => ({ type: SUMMARY, payload: { runs, wickets, legalBalls: balls, ...extra } });
  const out = (runs: number): StreamEvent => s(runs, Math.min(10, allOut));
  if (req.outcome.kind === "draw") {
    // Home 300 + 200d, away 250 + 100/3 chasing 251 when time runs out.
    return [START, out(300), out(250), s(200, open(5), { declared: true }), s(100, open(3), { partial: true, legalBalls: Math.min(120, balls - 1) }), { type: "cricket.match.close", payload: MATCH_CLOSE_DRAW }];
  }
  if (req.outcome.winner === "home") {
    const lead = cfg.followOn?.lead ?? Number.POSITIVE_INFINITY;
    return cfg.followOn?.enabled === true && FOLLOW_ON_LEAD >= lead
      ? [START, out(500), out(200), { type: "cricket.followon", payload: FOLLOW_ON_PAYLOAD }, out(150)] // away 350 v 500: an innings and 150
      : [START, out(300), out(250), out(200), out(200)]; // home 500 v away 450: by 50 runs
  }
  return [START, out(250), out(300), out(200), s(151, open(3))]; // target 151: away by wickets
}

export const cricketGenerator: SportStreamGenerator = {
  sportKeys: ["cricket"],
  decided(req) {
    const cfg = req.cfg as CricketCfg;
    const allOut = allOutOf(req);
    if (cfg.inningsPerSide === 2) return twoInnings(req, cfg, allOut);
    // The schema allows 1 or 2 (cricket.ts:47); anything else is refused by name, never guessed.
    if (cfg.inningsPerSide !== 1) throw new GeneratorUnsupported(req.sportKey, outcomeLabel(req.outcome), `inningsPerSide ${String(cfg.inningsPerSide)}`);
    if (req.outcome.kind === "draw") throw new GeneratorUnsupported(req.sportKey, "draw", "limited-overs cricket has no draw");
    const B = cfg.ballsPerInnings as number;
    const w = (n: number): number => Math.min(n, allOut);
    const summary = (runs: number, wickets: number, legalBalls: number) => ({ type: SUMMARY, payload: { runs, wickets, legalBalls } });
    return req.outcome.winner === "home"
      ? [START, summary(180, w(4), B), summary(150, w(5), B)]
      : [START, summary(150, w(5), B), summary(151, Math.min(3, allOut - 1), Math.min(B, 60))];
  },
  tied(req) {
    const cfg = req.cfg as CricketCfg;
    // decideTie (cricket.ts:935-946): with a super over on, level scores open one instead of standing.
    if (cfg.superOver === true) throw new OutcomeUnreachable(req.sportKey, "tie", "superOver is on: a level score opens a super over");
    const allOut = allOutOf(req);
    if (cfg.inningsPerSide === 2) {
      const balls = cfg.ballsPerInnings ?? TEST_BALLS;
      const out = (runs: number): StreamEvent => ({ type: SUMMARY, payload: { runs, wickets: Math.min(10, allOut), legalBalls: balls } });
      return [START, out(250), out(200), out(200), out(250)]; // 450 v 450 after four innings
    }
    if (cfg.inningsPerSide !== 1) throw new GeneratorUnsupported(req.sportKey, "tie", `inningsPerSide ${String(cfg.inningsPerSide)}`);
    const B = cfg.ballsPerInnings as number;
    const w = Math.min(5, allOut);
    return [START, { type: SUMMARY, payload: { runs: 150, wickets: w, legalBalls: B } }, { type: SUMMARY, payload: { runs: 150, wickets: w, legalBalls: B } }];
  },
};
