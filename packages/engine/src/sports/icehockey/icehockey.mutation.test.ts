// Engine mutation debt (sport-wrapper lane) — icehockey.ts: the wrapper's own declarations over the shared period kernel.
// Expected values come from the rulebook the file cites and from hand arithmetic, never from running the module:
//   * IIHF recorded minutes (v6/01 §2): minor / bench minor 2, double minor 4, major 5, misconduct 10, game misconduct 20,
//     match 25 — PIM is that sum over a person's counted classes.
//   * Points (a skater's G + A) and the situation splits (PP / SH / penalty shot / empty net) of the IIHF game sheet.
//   * GWS: an attempt is the shooter's; a save is the goalkeeper's credit on a MISS (icehockey/DOMAIN.md, W4 #407).
//   * IIHF Rule 68 — substitution is unlimited and on the fly, the roster is closed at the pre-game sheet.
//   * Event Code §220 — H2H sub-group first, then overall; icehockey/DOMAIN.md for the bench and the single captain.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { validateLineup } from "../../sport/catalog.ts";
import { effectiveEntrantModel } from "../../sport/entrant-model.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { makeEnvelope } from "../../testkit/helpers.ts";
import { icehockey } from "./icehockey.ts";

const H = "H";
const A = "A";
const ev = (seq: number, type: string, payload: unknown): EventEnvelope => makeEnvelope(seq, { type, payload });
const model = icehockey.playerStats!;
const stream = (...events: Array<[string, unknown]>): EventEnvelope[] => events.map(([t, p], i) => ev(i + 1, t, p));
const statsOf = (events: EventEnvelope[]): Record<string, Record<string, number>> =>
  Object.fromEntries(aggregatePlayerStats(events, model).map((r) => [r.personId, r.stats]));

describe("icehockey playerStats — the declared metrics, labels and event types", () => {
  it("declares exactly the 19 metrics, each under its own label", () => {
    // The label is the standings/stat sheet column header the organiser reads.
    const labels: Record<string, string> = {
      goals: "Goals",
      assists: "Assists",
      pen_minor: "Minors",
      pen_double: "Double minors",
      pen_major: "Majors",
      pen_misc: "Misconducts",
      pen_gm: "Game misconducts",
      pen_match: "Match penalties",
      goals_pp: "PP goals",
      goals_sh: "SH goals",
      goals_ps: "Penalty-shot goals",
      goals_en: "Empty-net goals",
      ps_taken: "Penalty shots taken",
      so_attempts: "GWS attempts",
      so_goals: "GWS goals",
      so_saves: "GWS saves",
      pen_served: "Penalties served",
      shots: "Shots",
      shots_on_target: "Shots on target",
    };
    expect(model.metrics.map((m) => m.key)).toEqual(Object.keys(labels));
    for (const m of model.metrics) expect(m.label, m.key).toBe(labels[m.key]);
    expect(Object.keys(labels).length).toBe(19);
    expect(model.derived?.map((d) => [d.key, d.label])).toEqual([["points", "Points"], ["pim", "PIM"]]);
    expect(model.awards).toEqual([{ key: "mvp", label: "MVP" }]);
  });

  it("credits a skater's goals, assists, situation splits and points from icehockey.goal", () => {
    const s = statsOf(
      stream(
        ["icehockey.goal", { by: H, person: "P1", kind: "fg", assists: ["A1", "A2"] }],
        ["icehockey.goal", { by: H, person: "P1", kind: "pp", emptyNet: true }],
        ["icehockey.goal", { by: H, person: "P2", kind: "sh" }],
        ["icehockey.goal", { by: H, person: "P2", kind: "ps" }],
        // an own goal is the opponent's, never the striker's: no goal, no split
        ["icehockey.goal", { by: A, person: "P3", kind: "og" }],
      ),
    );
    // P1: fg + pp = 2 goals, 1 PP, 1 empty-net. P2: sh + ps = 2 goals, 1 SH, 1 PS.
    expect(s.P1).toEqual({ goals: 2, goals_pp: 1, goals_en: 1, points: 2, pim: 0 });
    expect(s.P2).toEqual({ goals: 2, goals_sh: 1, goals_ps: 1, points: 2, pim: 0 });
    expect(s.A1).toEqual({ assists: 1, points: 1, pim: 0 });
    expect(s.A2).toEqual({ assists: 1, points: 1, pim: 0 });
    expect(s.P3).toBeUndefined();
    expect(Object.keys(s).length).toBe(4);
  });

  it("counts each penalty class under its own key and sums PIM by the IIHF minutes", () => {
    const s = statsOf(
      stream(
        ["icehockey.suspension.start", { by: H, person: "P4", class: "minor" }],
        ["icehockey.suspension.start", { by: H, person: "P4", class: "bench_minor", servedBy: "P10" }],
        ["icehockey.suspension.start", { by: H, person: "P5", class: "double_minor" }],
        ["icehockey.suspension.start", { by: H, person: "P6", class: "major" }],
        ["icehockey.suspension.start", { by: H, person: "P7", class: "misconduct" }],
        ["icehockey.suspension.start", { by: H, person: "P8", class: "game_misconduct" }],
        ["icehockey.suspension.start", { by: H, person: "P9", class: "match" }],
      ),
    );
    expect(s.P4).toEqual({ pen_minor: 2, points: 0, pim: 4 }); // minor 2 + bench minor 2
    expect(s.P5).toEqual({ pen_double: 1, points: 0, pim: 4 });
    expect(s.P6).toEqual({ pen_major: 1, points: 0, pim: 5 });
    expect(s.P7).toEqual({ pen_misc: 1, points: 0, pim: 10 });
    expect(s.P8).toEqual({ pen_gm: 1, points: 0, pim: 20 });
    expect(s.P9).toEqual({ pen_match: 1, points: 0, pim: 25 });
    // the bench minor's PIM stay with the team; the server is credited only the service, no PIM (Rule 33)
    expect(s.P10).toEqual({ pen_served: 1, points: 0, pim: 0 });
    expect(Object.keys(s).length).toBe(7);
  });

  it("sums a mixed record: PIM is the weighted total over every class a person took", () => {
    const s = statsOf(
      stream(
        ["icehockey.suspension.start", { by: H, person: "P1", class: "minor" }],
        ["icehockey.suspension.start", { by: H, person: "P1", class: "double_minor" }],
        ["icehockey.suspension.start", { by: H, person: "P1", class: "major" }],
        ["icehockey.suspension.start", { by: H, person: "P1", class: "misconduct" }],
        ["icehockey.suspension.start", { by: H, person: "P1", class: "game_misconduct" }],
        ["icehockey.suspension.start", { by: H, person: "P1", class: "match" }],
      ),
    );
    expect(s.P1!.pim).toBe(2 + 4 + 5 + 10 + 20 + 25); // 66
  });

  it("credits the penalty shot taken, the GWS pair, and the shooter's shots from their own event types", () => {
    const s = statsOf(
      stream(
        ["icehockey.set_piece", { by: H, person: "S1", kind: "ps" }],
        ["icehockey.shootout.attempt", { by: H, person: "S1", scored: true, goalkeeper: "K1" }],
        ["icehockey.shootout.attempt", { by: H, person: "S2", scored: false, goalkeeper: "K1" }],
        ["icehockey.shot", { by: H, person: "S1", outcome: "scored" }],
        ["icehockey.shot", { by: H, person: "S1", outcome: "saved" }],
        ["icehockey.shot", { by: H, person: "S1", outcome: "missed" }],
        ["icehockey.shot", { by: H, person: "S1", outcome: "blocked" }],
      ),
    );
    // S1: 1 penalty shot, 1 GWS attempt scored, 4 shots of which 2 are on target (scored + saved).
    expect(s.S1).toEqual({ ps_taken: 1, so_attempts: 1, so_goals: 1, shots: 4, shots_on_target: 2, points: 0, pim: 0 });
    // S2 missed: an attempt, no goal. K1 saved only the miss.
    expect(s.S2).toEqual({ so_attempts: 1, points: 0, pim: 0 });
    expect(s.K1).toEqual({ so_saves: 1, points: 0, pim: 0 });
  });

  it("credits an MVP award under mvp_awards and refuses an unknown award key", () => {
    const s = statsOf(
      stream(["core.award", { person: "P1", key: "mvp" }], ["core.award", { person: "P2", key: "motm" }]),
    );
    expect(s.P1).toEqual({ mvp_awards: 1, points: 0, pim: 0 });
    expect(s.P2).toBeUndefined();
  });
});

describe("icehockey — the roster, lineup policy and entrant model", () => {
  const cfg = icehockey.configSchema.parse({});
  // A hand-built sheet: H-p1 in goal (G), H-p2..H-p6 on defence (D), H-b1..H-b5 on the bench.
  const sheet = (entrantId: string): LineupPair["home"] => ({
    entrantId,
    slots: [
      ...Array.from({ length: 6 }, (_, i) => ({
        personId: `${entrantId}-p${i + 1}`,
        positionKey: i === 0 ? "G" : "D",
        slot: "starting" as const,
        orderNo: i + 1,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({ personId: `${entrantId}-b${i + 1}`, slot: "bench" as const, orderNo: 7 + i })),
    ],
  });
  const lineups: LineupPair = { home: sheet("H"), away: sheet("A") };
  const IH = "H";
  const sub = (seq: number, off: string, on: string, positionKey: string) =>
    ev(seq, "core.lineup.substitution", { side: IH, off, on: { personId: on, positionKey, slot: "starting", orderNo: 30 + seq } });
  const strictFold = (events: EventEnvelope[]) => foldMatch(icehockey, cfg, lineups, events, { strictFromSeq: 0 });
  const start = ev(1, "core.start", {});
  const starter = "H-p2";
  const bencher = "H-b1";

  it("declares unlimited, position-free re-entry and a closed roster", () => {
    expect(icehockey.lineupPolicy!(cfg)).toEqual({
      reentry: "unlimited",
      reentryPositionLock: false,
      allowSquadGrowth: false,
    });
  });

  it("lets a substituted skater come back — on the fly, at another position — and refuses a person off the sheet", () => {
    // Rule 68: unlimited, and a returner owes no position (reentryPositionLock false); the sheet is closed (no growth).
    const state = strictFold([start, sub(2, starter, bencher, "D"), sub(3, bencher, starter, "F")]);
    expect(state.squads!.home.subsUsed).toBe(2);
    expect(() => strictFold([start, sub(2, starter, "not-on-the-sheet", "D")])).toThrow(/team sheet|not on|squad/i);
  });

  it("allows one captain and no second, and pins the six-on-the-ice sheet with a 17-man bench", () => {
    expect(icehockey.positions.roles).toEqual([{ key: "captain", name: "Captain", unique: true }]);
    const slots = lineups.home.slots;
    const two = {
      ...lineups.home,
      slots: slots.map((s, i) => (i < 2 ? { ...s, roles: ["captain"] } : s)),
    };
    const issues = validateLineup(icehockey.positions, two);
    expect(issues.filter((i) => i.kind === "role_duplicate")).toEqual([
      { kind: "role_duplicate", roleKey: "captain", personIds: [slots[0]!.personId, slots[1]!.personId] },
    ]);
    const one = { ...lineups.home, slots: slots.map((s, i) => (i < 1 ? { ...s, roles: ["captain"] } : s)) };
    expect(validateLineup(icehockey.positions, one).filter((i) => i.kind === "role_duplicate")).toEqual([]);
  });

  it("is a team sport with squad numbers and a captain", () => {
    expect(effectiveEntrantModel(icehockey.entrantModel)).toEqual({
      kinds: ["team"],
      defaultKind: "team",
      squadNumbers: true,
      captain: true,
      maxTeamMembers: null,
    });
  });
});

describe("icehockey — standings metrics and tie-break order", () => {
  it("shows GF/GA/GD and keeps PIM and the situation goals as hidden ledgers", () => {
    const byKey = new Map(icehockey.metrics.map((m) => [m.key, m]));
    for (const k of ["gf", "ga", "gd"]) expect(byKey.get(k)!.display, k).not.toBe(false);
    for (const k of ["pim", "goals_pp", "goals_sh"]) expect(byKey.get(k)!.display, k).toBe(false);
    expect(byKey.size).toBe(icehockey.metrics.length);
  });

  it("ranks points, then the H2H sub-group, then overall — Event Code §220", () => {
    expect(icehockey.defaultTiebreakers).toEqual(["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed"]);
  });
});
