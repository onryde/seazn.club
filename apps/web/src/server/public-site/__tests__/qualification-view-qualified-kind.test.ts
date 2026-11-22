// Engine 10.0.0 adds `{ kind: "qualified" }` to `QualStatus` (the frozen "Qualified" marker on a
// complete stage, engine row X-QS-1). Here the engine's own `qualificationStatus` is forced to
// answer it on a table it would not (so every row reads it), and the REAL builder and the REAL hub
// schema render it.
//
// Re-pinned by W5 app PR B Task 6: this file was #1238's tolerance pin ("renders exactly as
// `through`; the frozen variant is a later PR"). Task 6 IS that variant (R24 pick 17 A): the kind now
// travels as "qualified" with its own words - "Qualified", "Went through to {next}." - on the same
// through tick (qualification-bits.tsx). The finished-table scenes themselves are
// qualification-view-frozen.test.ts; this file keeps the per-kind mapping.
//
// Mutants, each killed here: the `qualified` arm of statusLabel / headline removed (the through
// words come back), `statusKindOf` mapping it to "through", "qualified" removed from QualStatusKind
// (parse refused).
import { describe, expect, it, vi } from "vitest";
import type { QualStatus } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import en from "@/dictionaries/en/public.json";
import { plural, t, type TKey } from "@/lib/i18n-runtime";
import { QualStatusKind, QualRowView } from "../competition-hub-schema";

const { forced } = vi.hoisted(() => ({ forced: { on: false } }));
vi.mock("@seazn/engine/competition", async (importOriginal) => {
  const real = await importOriginal<typeof import("@seazn/engine/competition")>();
  return {
    ...real,
    qualificationStatus: (...args: Parameters<typeof real.qualificationStatus>) => {
      const out = real.qualificationStatus(...args);
      if (!forced.on || out === null) return out;
      // The 10.0.0 answer: every row frozen "qualified", no loss case.
      return new Map(
        [...out].map(([id, v]) => [id, { ...v, status: { kind: "qualified" } as unknown as QualStatus, ifYouLose: null }]),
      ) as typeof out;
    },
  };
});

import {
  buildQualificationView,
  divisionPointsBounds,
  divisionAwardAddsToLedger,
  ifYouLoseSentence,
  type QualFixture,
  type QualificationViewInput,
} from "../qualification-view";
import { defaultOrderOf } from "@seazn/engine/testkit";

const GENERIC = builtinModules.find((m) => m.key === "generic")!;
const CFG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const BOUNDS = divisionPointsBounds(GENERIC, CFG)!;

let n = 0;
const won = (round: number, winner: string, loser: string): QualFixture => ({
  id: `f${++n}`,
  stage_id: "S",
  pool_id: null,
  round_no: round,
  status: "decided",
  home_entrant_id: winner,
  away_entrant_id: loser,
  outcome: { kind: "win", winner, loser },
  played: false,
});

/** League of four, cut 1, five rounds settled, round 6 to play (A is through). */
function settled(): QualificationViewInput {
  const row = (id: string, rank: number, w: number) => ({
    entrantId: id, rank, played: 5, won: w, drawn: 0, lost: 5 - w, points: w * BOUNDS.winFloor,
    metrics: { for: w, against: 5 - w, diff: 2 * w - 5 },
  });
  const open = (a: string, b: string): QualFixture => ({ ...won(6, a, b), status: "scheduled", outcome: null });
  return {
    stage: {
      id: "S",
      kind: "league",
      meta: {
        qualifyCount: 1, qualifyPerGroup: false, nextStageName: "Finals", swissRounds: null,
        pointsRule: null, hasRankOverrides: false, tablePointsRule: null,
      },
    },
    poolId: null,
    rows: [row("A", 1, 5), row("B", 2, 2), row("C", 3, 2), row("D", 4, 1)],
    fixtures: [
      won(1, "A", "C"), won(1, "B", "D"), won(2, "A", "D"), won(2, "B", "C"), won(3, "A", "B"), won(3, "C", "D"),
      won(4, "A", "C"), won(4, "D", "B"), won(5, "A", "D"), won(5, "C", "B"), open("A", "B"), open("C", "D"),
    ],
    entrantStatuses: { A: "confirmed", B: "confirmed", C: "confirmed", D: "confirmed" },
    bounds: BOUNDS,
    awardAddsToLedger: divisionAwardAddsToLedger(GENERIC, CFG),
    cascade: [...defaultOrderOf(GENERIC)],
    entrantNames: { A: "Ada", B: "Bo", C: "Cy", D: "Di" },
    msg: (k: TKey, v?: Record<string, string | number>) => t(en, k, v),
    plural: (k: string, c: number, v?: Record<string, string | number>) => plural(en, k, c, "en", v),
  };
}

describe("engine 10.0.0 QualStatus kind \"qualified\" renders the frozen Qualified row (W5 Task 6)", () => {
  it("premise: with the engine unforced the table has a through row (A) and an out row (D), so the forced run differs from it", () => {
    forced.on = false;
    const v = buildQualificationView(settled())!;
    expect(v.rows.A).toMatchObject({ status: "through", label: "Through" });
    expect(v.rows.D!.status).toBe("out");
  });

  it("every row the engine answers `qualified` carries the frozen kind and its own words, never the live through words, no loss case", () => {
    forced.on = false;
    const through = buildQualificationView(settled())!.rows.A!;
    forced.on = true;
    try {
      const v = buildQualificationView(settled())!;
      const rows = Object.values(v.rows);
      expect(rows).toHaveLength(4); // anti-vacuity: every row was read
      for (const r of rows) {
        expect(r.status).toBe("qualified");
        // R24 pick 17 A's words, typed from the mock
        expect(r.label).toBe("Qualified");
        expect(r.label).not.toBe(through.label);
        expect(r.headline).toBe("Went through to Finals.");
        expect(r.ariaLabel).toContain("Qualified");
        expect(r.ifYouLose).toBeNull();
        expect(r.whatIf).toBeNull();
        expect(Object.values(r).join(" ")).not.toMatch(/table\.qual\./); // never a printed key
      }
    } finally {
      forced.on = false;
    }
  });

  it("the document the builder emits still parses (the status it carries is in the vocabulary)", () => {
    forced.on = true;
    try {
      const rows = Object.values(buildQualificationView(settled())!.rows);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(QualRowView.safeParse(r).success).toBe(true);
    } finally {
      forced.on = false;
    }
  });

  it("the loss sentence of a `qualified` status is the through sentence", () => {
    const q = { kind: "qualified" } as unknown as QualStatus;
    const i = settled();
    expect(ifYouLoseSentence(q, 2, i)).toBe(ifYouLoseSentence({ kind: "through" }, 2, i));
    expect(ifYouLoseSentence(q, 2, i)).toBe("If you lose your next match, you're still through.");
  });

  it("the hub vocabulary accepts \"qualified\" and still refuses a word outside it", () => {
    expect(QualStatusKind.safeParse("qualified").success).toBe(true);
    expect(QualStatusKind.safeParse("maybe").success).toBe(false);
  });
});
