// R112 review M-2 — `onePlayEvent` is the sweeps' witness that "something was played" (rulings 112, 113). That witness
// must be PLAY, meaning the score moved. A rain marker, a period change, a card or a substitution is a sport event too,
// but a test that hands one of those over as "play" proves only the fixture.
//
// "Moved the score" is read from the module's own declarations, never from a table of event names:
//   - the per-side score line of its summary (spec 03 §3: "252/8 (50)", "3–1", "2½");
//   - its played tally, which is the credit a bye earns (C-5: "a bye's credit IS the played tally").
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, isCoreEventType, outcomeOf, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "./declared-cfgs.ts";
import { forEachSport } from "./for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { onePlayEvent, PLAY_EVENT_SEEDS } from "./play-event.ts";

const start = makeEnvelope(1, { type: "core.start", payload: {} });

/** The module's per-side score lines and its played tally after `ledger`, as one comparable string each. */
function score(m: AnySportModule, cfg: unknown, ledger: readonly EventEnvelope[]): { lines: string; tally: string } {
  const f = foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), ledger);
  const s = m.summary(f.state);
  const t = m.forfeitCredit(cfg, f.state, "bye", "home");
  return { lines: JSON.stringify(s.perSide.map((x) => x.line)), tally: JSON.stringify(t.perSide) };
}

/** Every declared cfg, plus its bracket deciders (chess decides a plain game with its one event), plus Best of 1
 *  wherever a declared cfg carries a best-of (a Best of 1 set cannot be won without deciding the match). */
function cfgsOf(m: AnySportModule): { name: string; cfg: unknown }[] {
  const out: { name: string; cfg: unknown }[] = [];
  for (const { name, cfg } of declaredCfgs(m as never)) {
    const c = cfg as Record<string, unknown>;
    out.push({ name, cfg: c });
    out.push({ name: `${name} + bracket deciders`, cfg: m.configSchema.parse({ ...c, ...m.bracketDeciders(c) }) });
    if (typeof c.bestOf === "number" && c.bestOf > 1) {
      const one = m.configSchema.safeParse({ ...c, bestOf: 1 });
      if (one.success) out.push({ name: `${name} at Best of 1`, cfg: one.data });
    }
  }
  return out;
}

describe("onePlayEvent: the play it hands over moves the score (R112 review M-2)", () => {
  it("every sport, every declared cfg: the event is module-owned, accepted strictly, leaves the match undecided, and moves the per-side score line or the played tally", () => {
    let found = 0;
    let none = 0;
    const sports = forEachSport(({ module: m }) => {
      let ofSport = 0;
      for (const { name, cfg } of cfgsOf(m)) {
        const e = onePlayEvent(m, cfg, defaultLineupPair(m.positions), [start]);
        if (e === null) { none++; continue; }
        expect(isCoreEventType(e.type), `${m.key}/${name}: ${e.type} is the kernel's`).toBe(false);
        expect(e.seq, `${m.key}/${name}`).toBe(2);
        const f = foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), [start, e], { strictFromSeq: 2 });
        expect(outcomeOf(m as never, f as never), `${m.key}/${name}: ${e.type} decided the match`).toBeNull();
        const before = score(m, cfg, [start]);
        const after = score(m, cfg, [start, e]);
        expect(after.lines !== before.lines || after.tally !== before.tally, `${m.key}/${name}: ${e.type} moved no score`).toBe(true);
        found++;
        ofSport++;
      }
      expect(ofSport, `${m.key}: no cfg of the sport yields a play event`).toBeGreaterThan(0);
    });
    expect(sports).toBe(11);
    expect(found).toBeGreaterThan(sports);
    // Chess decides a plain game with its one sport event: only its bracket-decider cfgs (a draw held for the
    // tie-break) yield play. Nothing else may come back empty.
    expect(none).toBe(declaredCfgs(builtinModules.find((x) => x.key === "boardgame")! as never).length);
  });

  it("the teeth: the FIRST event a generator draws is often not play — in some sport it moves no score at all, so the old first-drawn rule handed a non-play event over", () => {
    let nonScoring = 0;
    let drawnTypes = 0;
    forEachSport(({ module: m }) => {
      if (m.arbitraryEvent === undefined) return;
      const cfg = declaredCfgs(m as never)[0]!.cfg;
      const l = defaultLineupPair(m.positions);
      const state = foldMatchWithStoppage(m as never, cfg as never, l, [start]).state;
      const before = score(m, cfg, [start]);
      const seen = new Set<string>();
      for (let seed = 1; seed <= PLAY_EVENT_SEEDS; seed++) {
        const d = m.arbitraryEvent(state, mulberry32(seed));
        if (d === null || isCoreEventType(d.type) || seen.has(d.type)) continue;
        seen.add(d.type);
        let after;
        try {
          after = score(m, cfg, [start, makeEnvelope(2, d)]);
        } catch {
          continue;
        }
        drawnTypes++;
        if (after.lines === before.lines && after.tally === before.tally) nonScoring++;
      }
    });
    expect(drawnTypes).toBeGreaterThan(11);
    expect(nonScoring, "a generator draws events that move no score (a period change, a clock, a substitution)").toBeGreaterThan(0);
  });

  it("FB: football's play is a goal — one goal on the tally (FIFA Law 10: the score is goals); VB Best of 1: a point, since its only set cannot close undecided", () => {
    // single-sport: two named witnesses, one per signal. The sweep above covers every sport.
    const fb = builtinModules.find((x) => x.key === "football")!;
    const fbCfg = declaredCfgs(fb as never)[0]!.cfg;
    const g = onePlayEvent(fb, fbCfg, defaultLineupPair(fb.positions), [start])!;
    const fold = foldMatchWithStoppage(fb as never, fbCfg as never, defaultLineupPair(fb.positions), [start, g]);
    const [h, a] = fb.forfeitCredit(fbCfg, fold.state, "bye", "home").perSide;
    expect((h.gf ?? 0) + (a.gf ?? 0), `football play ${g.type}`).toBe(1);

    const vb = builtinModules.find((x) => x.key === "volleyball")!;
    const vbCfg = vb.configSchema.parse({ bestOf: 1 });
    const p = onePlayEvent(vb, vbCfg, defaultLineupPair(vb.positions), [start])!;
    const vf = foldMatchWithStoppage(vb as never, vbCfg as never, defaultLineupPair(vb.positions), [start, p]);
    const [vh, va] = vb.forfeitCredit(vbCfg as never, vf.state, "bye", "home").perSide;
    expect((vh.points_won ?? 0) + (va.points_won ?? 0), `volleyball Bo1 play ${p.type}`).toBeGreaterThan(0);
  });
});
