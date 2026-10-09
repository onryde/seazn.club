// W2b Task 4 (spec §5.2; Appendix A X-DW-1, X-DW-4). A double walkover in a table: both sides played and lost, no
// points, no score, and out of every ratio — in every sport and every cfg it declares.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";

describe("X-DW-4: a double walkover in a table — P+1, L+1, 0 points, no score, out of every ratio", () => {
  it("X-DW-1: both sides absent folds to the double walkover outcome in every sport (empty case: nothing else decided it)", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const l = defaultLineupPair(m.positions);
        expect(outcomeOf(m as never, foldMatchWithStoppage(m as never, cfg as never, l, []) as never), `${m.key}/${name} empty`).toBeNull();
        const f = foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload: { by: "both", reason: "walkover" } })]);
        expect(outcomeOf(m as never, f as never), `${m.key}/${name}`).toEqual({ kind: "double_walkover" });
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  it("X-DW-4: every declared cfg of every sport, both sides", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const l = defaultLineupPair(m.positions);
        const f = foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload: { by: "both", reason: "walkover" } })]);
        const o = outcomeOf(m as never, f as never);
        expect(o, `${m.key}/${name}`).toEqual({ kind: "double_walkover" });
        const deltas = m.standingsDelta(o!, cfg, { kind: "league" } as never, f.state);
        for (const [i, d] of deltas.entries()) {
          expect({ played: d.played, won: d.won, drawn: d.drawn, lost: d.lost, points: d.points }, `${m.key}/${name} side ${i}`).toEqual({ played: 1, won: 0, drawn: 0, lost: 1, points: 0 });
          expect(Object.values(d.metrics).every((v) => v === 0), `${m.key}/${name} side ${i} metrics ${JSON.stringify(d.metrics)}`).toBe(true);
        }
        expect(deltas.map((d) => d.entrantId), `${m.key}/${name}`).toEqual([l.home.entrantId, l.away.entrantId]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  it("X-DW-4: forfeitCredit(…, both) credits nothing and excludes every metric the sport declares from its ratios", () => {
    let keys = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const l = defaultLineupPair(m.positions);
        const f = foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload: { by: "both", reason: "walkover" } })]);
        const credit = m.forfeitCredit(cfg, f.state, "walkover", "both");
        for (const side of credit.perSide) expect(Object.values(side).every((v) => v === 0), `${m.key}/${name}`).toBe(true);
        for (const metric of m.metrics) {
          expect(credit.excluded, `${m.key}/${name}`).toContain(metric.key);
          keys++;
        }
      }
    });
    expect(keys).toBeGreaterThanOrEqual(11);
  });
});
