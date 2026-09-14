// Pad game-clock publish (2026-09-13) — `*.clock` sets clockRunning + asOf.
import { describe, expect, it } from "vitest";
import { foldMatch } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { hockey } from "../hockey/hockey.ts";
import { football } from "../football/football.ts";

describe("period *.clock", () => {
  const cfg = hockey.configSchema.parse({});
  const lineups = defaultLineupPair(hockey.positions);

  it("pause stamps asOf and sets clockRunning false; start flips it true", () => {
    const live = foldMatch(hockey, cfg, lineups, [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, {
        type: "hockey.clock",
        payload: { at: { period: "Q1", elapsed: 120 }, running: false },
      }),
    ]);
    expect(live.asOf).toEqual({ period: "Q1", elapsed: 120 });
    expect(live.clockRunning).toBe(false);

    const resumed = foldMatch(hockey, cfg, lineups, [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, {
        type: "hockey.clock",
        payload: { at: { period: "Q1", elapsed: 120 }, running: false },
      }),
      makeEnvelope(3, {
        type: "hockey.clock",
        payload: { at: { period: "Q1", elapsed: 120 }, running: true },
      }),
    ]);
    expect(resumed.clockRunning).toBe(true);
    expect(resumed.asOf).toEqual({ period: "Q1", elapsed: 120 });
  });

  it("period advance clears clockRunning so the overlay does not tick across the whistle", () => {
    const state = foldMatch(hockey, cfg, lineups, [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, {
        type: "hockey.clock",
        payload: { at: { period: "Q1", elapsed: 600 }, running: true },
      }),
      makeEnvelope(3, { type: "hockey.period.advance", payload: { to: "Q2" } }),
    ]);
    expect(state.clockRunning).toBe(false);
  });

  it("a goal while paused still folds — unlike core.suspend", () => {
    const state = foldMatch(hockey, cfg, lineups, [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, {
        type: "hockey.clock",
        payload: { at: { period: "Q1", elapsed: 90 }, running: false },
      }),
      makeEnvelope(3, {
        type: "hockey.goal",
        payload: { by: lineups.home.entrantId, at: { period: "Q1", elapsed: 90 } },
      }),
    ]);
    expect(state.goals.home).toBe(1);
    expect(state.clockRunning).toBe(false);
  });
});

describe("football.clock", () => {
  const cfg = football.configSchema.parse({});
  const lineups = defaultLineupPair(football.positions);

  it("pause and correct re-anchor asOf", () => {
    const state = foldMatch(football, cfg, lineups, [
      makeEnvelope(1, { type: "core.start", payload: {} }),
      makeEnvelope(2, {
        type: "football.clock",
        payload: { at: { period: "H1", elapsed: 761 }, running: false },
      }),
      makeEnvelope(3, {
        type: "football.clock",
        payload: { at: { period: "H1", elapsed: 771 }, running: false },
      }),
    ]);
    expect(state.asOf).toEqual({ period: "H1", elapsed: 771 });
    expect(state.clockRunning).toBe(false);
  });
});
