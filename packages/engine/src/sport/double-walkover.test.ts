// W2b Task 4 (spec §5.2; Appendix A X-DW-1, X-DW-4). A double walkover in a table: both sides played and lost, no
// points, no score, and out of every ratio — in every sport and every cfg it declares.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/index.ts";
import { onePlayEvent } from "../testkit/play-event.ts";

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

  it("sequence: after a double walkover, a walkover, a disqualification or a retirement the fixture is over — a second walkover is refused, every sport", () => {
    // spec §5.1: a forfeit decides the fixture — the module reads its phase as "over" (D3 R0) and the kernel refuses a
    // further walkover ALREADY_DECIDED (spec 03 §2 guarantee 4). Ruling 113: a retirement needs the sport's own play
    // first (its generator's, `onePlayEvent`); chess under a plain cfg has none short of its result, counted below.
    let checked = 0;
    let noPlay = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const l = defaultLineupPair(m.positions);
        const start = makeEnvelope(1, { type: "core.start", payload: {} });
        const play = onePlayEvent(m, cfg, l, [start]);
        if (play === null) noPlay++;
        const streams: Array<[string, Array<[string, unknown]>]> = [
          ["double walkover", [["core.forfeit", { by: "both", reason: "walkover" }]]],
          ["walkover", [["core.forfeit", { by: l.away.entrantId, reason: "walkover" }]]],
          ["disqualification", [["core.start", {}], ["core.forfeit", { by: l.home.entrantId, reason: "disqualified" }]]],
          ...(play === null
            ? []
            : [["retirement", [["core.start", {}], [play.type, play.payload], ["core.forfeit", { by: l.home.entrantId, reason: "retired" }]]]] as Array<[string, Array<[string, unknown]>]>),
        ];
        for (const [label, spec] of streams) {
          const events = spec.map(([type, payload], i) => makeEnvelope(i + 1, { type, payload }));
          const f = foldMatchWithStoppage(m as never, cfg as never, l, events);
          expect(m.forfeitPhase(f.state as never), `${m.key}/${name} ${label}`).toBe("over");
          const again = makeEnvelope(events.length + 1, { type: "core.forfeit", payload: { by: l.away.entrantId, reason: "walkover" } });
          expect(() => foldMatchWithStoppage(m as never, cfg as never, l, [...events, again]), `${m.key}/${name} ${label}: second walkover`).toThrowError(
            expect.objectContaining({ code: "ALREADY_DECIDED" }), // guarantee 4: a decided fixture refuses another walkover
          );
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThanOrEqual(44 - noPlay);
    expect(noPlay, "only chess's plain cfgs have no play short of the result").toBe(declaredCfgs(builtinModules.find((x) => x.key === "boardgame")! as never).length);
  });

  it("sequence: an awarded abandon ends the match whether a side leads or it is level (D8, FB-AB-1) — the leader wins; level is a draw where the cfg takes one, no result where it refuses one (R16-3) — the goal sports", () => {
    // Single-sport family: only the goal sports declare `abandonPolicy` (football, hockey, ice hockey).
    let checked = 0;
    let refused = 0;
    forEachSport(({ module: m }) => {
      const parsed = m.configSchema.safeParse({ abandonPolicy: "award" });
      if (!parsed.success || (parsed.data as { abandonPolicy?: string }).abandonPolicy !== "award") return; // not declared here
      const cfg = parsed.data;
      const l = defaultLineupPair(m.positions);
      for (const [label, goals] of [["level", 0], ["home leads", 1]] as const) {
        const spec: Array<[string, unknown]> = [["core.start", {}], ...Array.from({ length: goals }, (): [string, unknown] => [`${m.key}.goal`, { by: l.home.entrantId }]), ["core.abandon", { reason: "floodlights" }]];
        const f = foldMatchWithStoppage(m as never, cfg as never, l, spec.map(([type, payload], i) => makeEnvelope(i + 1, { type, payload })));
        // R16-3: whether the level half is a draw is the sport's own declaration (`supportsDraws` in a league), never typed.
        const levelKind = m.supportsDraws(cfg as never, "league") ? "draw" : undefined;
        if (goals === 0 && levelKind === undefined) refused++;
        expect(outcomeOf(m as never, f as never)?.kind, `${m.key} ${label}`).toBe(goals === 0 ? levelKind : "win");
        expect(m.forfeitPhase(f.state as never), `${m.key} ${label}`).toBe("over");
        checked++;
      }
    });
    expect(checked).toBe(6);
    expect(refused, "ice hockey's default (iihf) configures overtime and a shootout: its level abandon has no result").toBeGreaterThan(0);
  });

  it("X-DW-1: generic's result card reads a loss for both sides — and a walkover reads W/O for the winner only", () => {
    // Single-sport: generic is the one module whose summary writes result letters, not a score.
    const m = builtinModules.find((x) => x.key === "generic")!;
    const cfg = m.configSchema.parse(Object.values(m.variants)[0]);
    const l = defaultLineupPair(m.positions);
    const head = (payload: unknown) => m.summary(foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload })]).state).headline;
    expect(head({ by: "both", reason: "walkover" })).toBe("L — L");
    expect(head({ by: l.away.entrantId, reason: "walkover" })).toBe("W/O — L");
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
        // MD-1: the loops above are vacuous over an EMPTY perSide, and blind to a stray key (it would reach the table's
        // metrics). X-DW-4: two sides, each crediting 0 on exactly "every key either side's ledger carries, and every key
        // the sport declares" — the ledger's keys read from a single-side walkover's table row, a different arm.
        const wo = foldMatchWithStoppage(m as never, cfg as never, l, [makeEnvelope(1, { type: "core.forfeit", payload: { by: l.away.entrantId, reason: "walkover" } })]);
        const woRow = m.standingsDelta(outcomeOf(m as never, wo as never)!, cfg, { kind: "league" } as never, wo.state);
        const want = [...new Set([...Object.keys(woRow[0].metrics), ...m.metrics.map((metric) => metric.key)])].sort();
        expect(credit.perSide, `${m.key}/${name}: two sides`).toHaveLength(2);
        for (const side of credit.perSide) expect(Object.keys(side).sort(), `${m.key}/${name}: the ledger's keys and the declared ones`).toEqual(want);
        expect([...credit.excluded].sort(), `${m.key}/${name}: excluded`).toEqual(want);
      }
    });
    expect(keys).toBeGreaterThanOrEqual(11);
  });
});
