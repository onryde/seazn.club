// Mutation-debt kills for the thin tennis wrapper (tennis.ts): the declarations
// it states over the nested kernel — lineup policy, tiebreak cascade, player
// stat metrics, the doubles variant's no-ad games. Expected values come from
// the ITF Rules of Tennis and v6/00 §4, never from the module under test.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { aggregatePlayerStats } from "../../stats/stats.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "./tennis.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const ev = (seq: number, type: string, payload: unknown): EventEnvelope =>
  makeEnvelope(seq, { type, payload });

describe("tennis — lineup policy (ITF Rule 30: no substitute, a retired player does not resume)", () => {
  const cfg = tennis.configSchema.parse({});

  it("declares the most restrictive policy", () => {
    expect(tennis.lineupPolicy!(cfg)).toEqual({
      reentry: "none",
      reentryPositionLock: false,
      allowSquadGrowth: false,
    });
  });

  it("refuses a return after retirement and a person who is not on the sheet", () => {
    const lineups = {
      home: { entrantId: "H", slots: [{ personId: "H-a", slot: "starting" as const, orderNo: 1 }] },
      away: { entrantId: "A", slots: [{ personId: "A-a", slot: "starting" as const, orderNo: 1 }] },
    };
    const start = ev(1, "core.start", {});
    const retire = ev(2, "core.lineup.retirement", { side: "H", personId: "H-a" });
    const back = ev(3, "core.lineup.entry", {
      side: "H",
      on: { personId: "H-a", slot: "starting", orderNo: 1 },
    });
    expect(() => foldMatch(tennis, cfg, lineups, [start, retire, back], STRICT_ALL)).toThrow(
      /does not permit a return/,
    );
    const ghost = ev(2, "core.lineup.entry", {
      side: "H",
      on: { personId: "H-ghost", slot: "starting", orderNo: 2 },
    });
    expect(() => foldMatch(tennis, cfg, lineups, [start, ghost], STRICT_ALL)).toThrow(EngineError);
    expect(() => foldMatch(tennis, cfg, lineups, [start, ghost], STRICT_ALL)).toThrow(
      /not on the team sheet/,
    );
  });
});

describe("tennis — standings cascade", () => {
  it("declares points → set ratio → game ratio → h2h → seed (v6/00 §4)", () => {
    expect(tennis.defaultTiebreakers).toEqual([
      "points",
      "set_ratio",
      "game_ratio",
      "h2h_points",
      "seed",
    ]);
  });
});

describe("tennis — doubles-noad-mtb10 plays no-ad games (ITF App VI)", () => {
  const lineups = defaultLineupPair(tennis.positions);
  const H = lineups.home.entrantId;
  const A = lineups.away.entrantId;
  const fold = (variant: string | undefined, events: ModuleEvent[]) =>
    foldMatch(
      tennis,
      tennis.configSchema.parse(variant === undefined ? {} : tennis.variants[variant]),
      lineups,
      events.map((e, i) => makeEnvelope(i, e)),
      STRICT_ALL,
    );
  const pt = (by: string): ModuleEvent => ({ type: "tennis.point", payload: { by } });
  const start: ModuleEvent = { type: "core.start", payload: {} };
  // 40-40 (three points each), then home wins the next point.
  const atDeuceThenHome = [start, pt(H), pt(A), pt(H), pt(A), pt(H), pt(A), pt(H)];

  it("ends the game on the point after 40-40", () => {
    expect(fold("doubles-noad-mtb10", atDeuceThenHome).games).toEqual({ home: 1, away: 0 });
  });

  it("whereas the tour variant plays advantage, so the same point does not end it", () => {
    // Differential: the same stream under ad-scoring leaves the game open.
    const state = fold(undefined, atDeuceThenHome);
    expect(state.games).toEqual({ home: 0, away: 0 });
  });
});

describe("tennis — player stat metrics", () => {
  it("declares each metric with its own key, label, event and credited field", () => {
    // The nested kernel adds its own entrant-fallback `points_won`; the wrapper declares the rest.
    const rows = tennis
      .playerStats!.metrics.filter((m) => m.key !== "points_won")
      .map(({ when: _when, ...m }) => m);
    expect(rows).toEqual([
      { key: "points", label: "Points won", from: "tennis.point", field: "scorer", agg: "count" },
      {
        key: "service_points",
        label: "Service points",
        from: "tennis.point",
        field: "server",
        agg: "count",
      },
      { key: "aces", label: "Aces", from: "tennis.point", field: "server", agg: "count" },
      {
        key: "double_faults",
        label: "Double faults",
        from: "tennis.point",
        field: "server",
        agg: "count",
      },
      {
        key: "violations",
        label: "Code violations",
        from: "tennis.sanction",
        field: "person",
        agg: "count",
      },
      {
        key: "medical_timeouts",
        label: "Medical timeouts",
        from: "tennis.interruption",
        field: "person",
        agg: "count",
      },
    ]);
  });

  it("credits aces and double faults to the server and only medical breaks to the person", () => {
    const events = [
      ev(1, "tennis.point", { by: "H", scorer: "p-win", server: "p-srv", meta: { kind: "ace" } }),
      ev(2, "tennis.point", { by: "A", scorer: "p-rcv", server: "p-srv", meta: { kind: "double_fault" } }),
      ev(3, "tennis.point", { by: "A", scorer: "p-rcv", server: "p-srv" }),
      ev(4, "tennis.sanction", { person: "p-cv" }),
      ev(5, "tennis.interruption", { kind: "medical", person: "p-med" }),
      ev(6, "tennis.interruption", { kind: "toilet", person: "p-med" }),
    ];
    const rows = aggregatePlayerStats(events, tennis.playerStats!);
    const stat = (id: string, key: string) => rows.find((r) => r.personId === id)?.stats[key];
    expect(stat("p-srv", "service_points")).toBe(3);
    expect(stat("p-srv", "aces")).toBe(1);
    expect(stat("p-srv", "double_faults")).toBe(1);
    expect(stat("p-win", "points")).toBe(1);
    expect(stat("p-rcv", "points")).toBe(2);
    expect(stat("p-cv", "violations")).toBe(1);
    expect(stat("p-med", "medical_timeouts")).toBe(1);
  });
});
