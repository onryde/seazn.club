// R115 review M3 (2026-10-12): a player's `matches` count is `playedInStats`, the ONE reader every other surface asks
// (the shared fold's appearance metric, apps/web's career count and the public player's match lines). The set-based,
// nested and carrom folds counted it with their own "played" formula (a rally, a set summary or a game award on the
// ledger; carrom: a payload naming an entrant), so they could disagree with the reader on the same ledger.
//
// The expected values come from the rule rows, typed per scene (X-PS-1, X-PS-2, rulings 112, 115, 118 and 120), never
// from the fold: each scene is asserted against its rule, against `playedInStats`, and against every player's `matches`.
// Every scene is folded through the real kernel first, so the sweep reads only ledgers the product records; a refusal
// is named and counted. Swept over every sport that declares a `matches` key, every declared cfg.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { aggregatePlayerStats, playedInStats, type PlayerStatRow, type PlayerStatsFoldCtx } from "../stats/stats.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";
import type { AnySportModule } from "./module.ts";

const H = "H";
const A = "A";
type Step = { type: string; payload: unknown; voidsIndex?: number };
const seqd = (steps: readonly Step[]): EventEnvelope[] =>
  steps.map((s, i) => makeEnvelope(i + 1, { type: s.type, payload: s.payload }, s.voidsIndex === undefined ? undefined : `e-${s.voidsIndex + 1}`));
const START: Step = { type: "core.start", payload: {} };
const ABANDON: Step = { type: "core.abandon", payload: { reason: "rain" } };
const SETTLE: Step = { type: "core.settle", payload: { winner: H, method: "higher_seed" } };
const forfeit = (reason: string, by: string = A): Step => ({ type: "core.forfeit", payload: { by, reason } });

function refusalOf(f: () => unknown): string | null {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e.code;
    throw e;
  }
}

function rowsOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]): PlayerStatRow[] {
  const persons: Record<string, string[]> = { [H]: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
  // "individual" for every sport: the fold's kind guard credits a "team" entrant nobody (player-stats-forfeit.test.ts).
  const ctx: PlayerStatsFoldCtx = { entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg };
  return aggregatePlayerStats(events, m.playerStats!, l, ctx);
}

describe("R115 review M3: a player's matches count is playedInStats, the one reader — on every sport that counts matches", () => {
  it("X-PS-1 + X-PS-2 (rulings 112, 115, 118, 120): every scene's matches count is its rule's, for every player, every declared cfg — an abandon with nothing played included", () => {
    const n = { sports: 0, cfgs: 0, scenes: 0, refused: 0, noPlay: 0, playerChecks: 0, settledNothingPlayed: 0, kernelSettledNothingPlayed: 0 };
    const refusals = new Map<string, number>();
    forEachSport(({ module: m }) => {
      const model = m.playerStats;
      if (model === undefined) return;
      const folded = model.folded?.keys.some((k) => k.key === "matches") === true;
      if (!folded && !model.metrics.some((x) => x.key === "matches")) return;
      n.sports++;
      const l = defaultLineupPair(m.positions);
      const persons = [...l.home.slots, ...l.away.slots].map((s) => s.personId);
      const startIsPlay = m.startIsPlay === true;
      for (const { name, cfg } of declaredCfgs(m as never)) {
        n.cfgs++;
        const label = (s: string) => `${m.key}/${name}: ${s}`;
        const prefix = seqd([START]);
        const playCfg = [cfg, m.configSchema.parse({ ...(cfg as object), ...m.bracketDeciders(cfg as never) })].find((c) => onePlayEvent(m, c, l, prefix) !== null);
        const play = playCfg === undefined ? null : onePlayEvent(m, playCfg, l, prefix);
        if (play === null) n.noPlay++;
        const P: Step | null = play === null ? null : { type: play.type, payload: play.payload };
        // [scene, steps, the rule's answer: a match for both sides' players?]
        const scenes: [string, Step[] | null, boolean][] = [
          ["X-PS-1: nothing recorded", [], false],
          ["X-PS-1: a walkover before the Start", [forfeit("walkover")], false],
          ["X-PS-1: a double walkover before the Start", [forfeit("walkover", "both")], false],
          ["X-PS-1 (ruling 112): a walkover after a bare Start", startIsPlay ? null : [START, forfeit("walkover")], false],
          ["ruling 115 / ruling 118: a disqualification after a bare Start", [START, forfeit("disqualified")], startIsPlay],
          // Ruling 120: an abandon is a match only if something was played before it — whatever its result or settle.
          ["ruling 120: an abandon settled with nothing played", [START, ABANDON, SETTLE], startIsPlay],
          ["ruling 120: an abandon with nothing played", [START, ABANDON], startIsPlay],
          ["X-PS-2: a match played", P && [START, P], true],
          ["X-PS-2: an abandon settled after play", P && [START, P, ABANDON, SETTLE], true],
          ["X-PS-2: a retirement after play", P && [START, P, forfeit("retired")], true],
          ["X-PS-2 (ruling 115): a disqualification after play", P && [START, P, forfeit("disqualified")], true],
          ["ruling 115: a disqualification after the only play was voided", P && !startIsPlay ? [START, P, { type: "core.void", payload: {}, voidsIndex: 1 }, forfeit("disqualified")] : null, false],
        ];
        for (const [what, steps, want] of scenes) {
          if (steps === null) continue;
          const events = seqd(steps);
          const refused = refusalOf(() => foldMatchWithStoppage(m as never, (P !== null && steps.includes(P) ? playCfg : cfg) as never, l, events));
          if (refused !== null) {
            refusals.set(`${what}: ${refused}`, (refusals.get(`${what}: ${refused}`) ?? 0) + 1);
            n.refused++;
            continue;
          }
          n.scenes++;
          expect(playedInStats(events, m), label(`${what}: the one reader says the rule`)).toBe(want);
          const rows = rowsOf(m, P !== null && steps.includes(P) ? playCfg : cfg, l, events);
          for (const p of persons) {
            expect(rows.find((r) => r.personId === p)?.stats.matches ?? 0, label(`${what}: ${p}'s matches`)).toBe(want ? 1 : 0);
            n.playerChecks++;
          }
          if (what.startsWith("ruling 120: an abandon settled with nothing played")) {
            n.settledNothingPlayed++;
            if (folded) n.kernelSettledNothingPlayed++;
          }
        }
      }
    });
    // Not vacuous: sports, cfgs, scenes and player counts all checked, and the settled abandon with nothing played (the
    // scene M3 and ruling 120 both moved) reached a kernel-folded `matches` (set-based, nested, carrom) on more than one
    // cfg.
    expect(n.sports, JSON.stringify(n)).toBeGreaterThanOrEqual(2);
    expect(n.cfgs, JSON.stringify(n)).toBeGreaterThan(n.sports);
    expect(n.scenes, JSON.stringify(n)).toBeGreaterThan(n.cfgs * 5);
    expect(n.playerChecks, JSON.stringify(n)).toBeGreaterThan(n.scenes);
    expect(n.kernelSettledNothingPlayed, JSON.stringify(n)).toBeGreaterThan(1);
    expect(n.noPlay, `cfgs with no play event: ${JSON.stringify(n)}`).toBe(0);
    // Every refusal is named: none expected on these scenes (each is a ledger the product records).
    expect(Object.fromEntries(refusals), JSON.stringify(n)).toEqual({});
  });

  it("M3: the set-based and nested kernels' matches key is reached by the sweep above (the kernels it moved are in the registry)", () => {
    const kernelSports: string[] = [];
    forEachSport(({ module: m }) => {
      if (m.playerStats?.folded?.keys.some((k) => k.key === "matches") === true) kernelSports.push(m.key);
    });
    // Badminton (set-based) and tennis (nested) are the two kernels' first sports; the rest of each family follows.
    expect(kernelSports, `sports whose folded stats count matches: ${kernelSports.join(", ")}`).toEqual(expect.arrayContaining(["badminton", "tennis"]));
  });
});
