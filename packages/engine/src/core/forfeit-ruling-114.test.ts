// W2b ruling 114 (2026-10-11, owner "A"): any sport event after Start counts as "played", scoring or not. It keeps
// ruling 112's test as built: `playRecorded` counts any active module-owned event after `core.start`. The ruling's edges,
// accepted: a rain delay before the first ball (`cricket.interruption`), a sanction or warning in tennis and the set
// sports, a card or sin-bin before kick-off (football), a suspension before face-off (hockey) — each counts as play, so
// a no-show after one is not offered a walkover. Its workaround: take the event back (void it), then record the walkover.
//
// R112 fix round 2 (m2): R112 review M-2 made `onePlayEvent` hand over score-moving play only, so nothing pinned the
// non-scoring half of the ruling. These sweeps draw the non-scoring events from each module's OWN generator and
// declarations — never a typed table of payloads — and count what they checked; zero checked is a failure.
import { describe, expect, it } from "vitest";
import { EngineError } from "./errors.ts";
import { foldMatchWithStoppage, forfeitAdmission, outcomeOf, playRecorded, type EventEnvelope } from "./events.ts";
import { FORFEIT_REASONS, type LineupPair } from "./types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { reachableAfterStart, type Scene } from "../testkit/after-start-events.ts";
import { makeEnvelope } from "../testkit/helpers.ts";

const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const START = (): EventEnvelope => ev(1, "core.start");
const fold = (m: AnySportModule, cfg: unknown, l: LineupPair, events: EventEnvelope[]) => foldMatchWithStoppage(m as never, cfg as never, l, events);
const refusalOf = (f: () => unknown): EngineError | null => {
  try {
    f();
    return null;
  } catch (e) {
    if (EngineError.is(e)) return e;
    throw e;
  }
};

const SCENES: Scene[] = builtinModules.flatMap((m) => reachableAfterStart(m as never));
const NON_SCORING = SCENES.filter((s) => !s.scoring);
const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key)! as never;

/** Ruling 114's list once something is played (rulings 112, 113): everything but the walkover. */
const PLAYED_REASONS: readonly string[] = FORFEIT_REASONS.filter((r) => r !== "walkover");

/** The ruling's checks on one sport event after a bare Start. */
function expectPlayed(s: Scene): void {
  const m = moduleOf(s.sport);
  const label = `${s.sport}/${s.cfgName}: ${s.event.type} (${s.source}${s.scoring ? "" : ", non-scoring"})`;
  const { l, cfg, event } = s;
  const ledger = [START(), event];
  expect(playRecorded(ledger, m), `${label}: counts as played`).toBe(true);
  const state = fold(m, cfg, l, ledger).state;
  const phase = m.forfeitPhase(state);
  // The walkover is refused once something is played, unless the module declares a walkover in that phase (chess).
  const walkoverInPhase = (m.walkoverPhases ?? ["pre"]).includes(phase);
  const walkover = refusalOf(() => fold(m, cfg, l, [...ledger, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]));
  if (walkoverInPhase) expect(walkover, label).toBeNull();
  else {
    expect(walkover?.code, `${label}: a walkover after it`).toBe("FORFEIT_REASON_WRONG_PHASE");
    expect(walkover!.data, label).toMatchObject({ reason: "walkover", played: true });
    const both = refusalOf(() => fold(m, cfg, l, [...ledger, ev(3, "core.forfeit", { by: "both", reason: "walkover" })]));
    expect(both?.code, `${label}: a double walkover after it`).toBe("FORFEIT_REASON_WRONG_PHASE");
  }
  // Something was played, so the retirement is recorded (ruling 113): the retiree loses.
  const retired = fold(m, cfg, l, [...ledger, ev(3, "core.forfeit", { by: l.away.entrantId, reason: "retired" })]);
  expect(outcomeOf(m as never, retired as never), `${label}: a retirement after it`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "retired" });
  // The console asks the same question (forfeitAdmission with the ledger's own fact).
  const admitted = forfeitAdmission(m as never, state as never, { playRecorded: playRecorded(ledger, m) });
  if (!walkoverInPhase) expect(admitted, `${label}: the console's offer`).toMatchObject({ reasons: PLAYED_REASONS, both: false });
  // The workaround: void the event, and the walkover is recordable again — nothing is played.
  const voided = [START(), event, ev(3, "core.void", {}, event.id)];
  expect(playRecorded(voided, m), `${label}: voided`).toBe(false);
  const wo = fold(m, cfg, l, [...voided, ev(4, "core.forfeit", { by: l.away.entrantId, reason: "walkover" })]);
  expect(outcomeOf(m as never, wo as never), `${label}: a walkover after voiding it`).toEqual({ kind: "award", winner: l.home.entrantId, loser: l.away.entrantId, reason: "walkover" });
}

describe("ruling 114: any sport event after Start counts as played, scoring or not", () => {
  it("discovery first: the sweep draws sport events after a bare Start in every sport, and non-scoring ones in some (counted)", () => {
    expect(new Set(SCENES.map((s) => s.sport)).size).toBe(builtinModules.length - 1); // chess's one event decides a plain game
    expect(NON_SCORING.length, "non-scoring sport events drawn").toBeGreaterThan(0);
    expect(new Set(NON_SCORING.map((s) => s.sport)).size, "sports with a non-scoring event").toBeGreaterThan(0);
  });

  it("X-RS-1 (ruling 114): a NON-SCORING sport event after Start sets playRecorded, refuses the walkover and the double walkover, admits the retirement; voided, the walkover is admitted again — every sport whose generator draws one", () => {
    let checked = 0;
    const sports = new Set<string>();
    for (const s of NON_SCORING) {
      expectPlayed(s);
      sports.add(s.sport);
      checked++;
    }
    expect(checked).toBe(NON_SCORING.length);
    // Measured 2026-10-12 from the declarations: 21 non-scoring events in 8 sports — football, cricket (its pad's rain
    // delay), volleyball, badminton, tabletennis, tennis, hockey and ice hockey; generic, carrom and chess reach none
    // (each of their events scores or decides). The floor is the sports the ruling names for a non-scoring edge.
    for (const k of ["cricket", "tennis", "volleyball", "badminton", "tabletennis", "football"]) expect([...sports], k).toContain(k);
  });

  it("ruling 114's named edges each reach the sweep — a rain delay (cricket), a sanction (tennis and the set sports), a card or sin-bin (football), a suspension (hockey, ice hockey) — and each counts as play", () => {
    // The ruling's text names these event types; the payloads are the module's own (its generator, else its pad).
    const NAMED = ["cricket.interruption", "tennis.sanction", "volleyball.sanction", "badminton.sanction", "tabletennis.sanction", "football.card", "football.sinbin.start", "hockey.suspension.start", "icehockey.suspension.start"];
    let checked = 0;
    for (const type of NAMED) {
      const s = SCENES.find((x) => x.event.type === type);
      expect(s, `${type}: reachable after a bare Start`).toBeDefined();
      expectPlayed(s!);
      checked++;
    }
    expect(checked).toBe(NAMED.length);
    // The non-scoring ones among them are in the non-scoring sweep: a rain delay, a sanction and a sin-bin move no score.
    for (const type of ["cricket.interruption", "tennis.sanction", "volleyball.sanction", "badminton.sanction", "tabletennis.sanction", "football.sinbin.start"]) {
      expect(NON_SCORING.map((x) => x.event.type), type).toContain(type);
    }
  });
});
