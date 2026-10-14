// W2c Task 14, fix round 2 — `awardFit`, the pure verdict on a format correction to a match decided WITHOUT play
// (`fixture-rules.ts` (7a)): the award's own walkover fold (`awardedMatchState`) under the format it plays now and under
// the corrected one. No shipped sport's walkover depends on its cfg for WHO it decides, so the two refusal arms that
// read the fold itself — the engine refusing the forfeit, and the fold deciding a different award — are unreachable
// through the real modules. They are guards, so they are reached here with a synthetic module whose forfeit fold is
// steered by its cfg (TEST-STRATEGY: assumptions are guards).
//
// Expected verdicts are the arms' own contract: FIXTURE_FORMAT_LOCKED when no fit applies to the stored award (a bye,
// a non-award, an award its current format cannot reproduce), FORMAT_DOES_NOT_FIT_PLAY with the engine's message, the
// "result" reason, or the "score" reason (`lib/rule-errors.ts` FORMAT_FIT_REASONS) — never read back from `awardFit`.
// Pure: no database.
import { describe, expect, it } from "vitest";
import { EngineError, type FoldableModule, type LineupPair, type MatchOutcome, type ScoreSummary } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { FORMAT_FIT_REASONS } from "@/lib/rule-errors";
import { awardFit, awardFoldsUnder } from "../awarded-state";

const H = "home-entrant";
const A = "away-entrant";
const lineups: LineupPair = { home: { entrantId: H, slots: [] }, away: { entrantId: A, slots: [] } } as unknown as LineupPair;
const at = { fixtureId: "f-1", recordedAt: "2026-10-14T00:00:00.000Z" };

/** The synthetic cfg: `credit` is the walkover's credited score; `refuse` makes the engine refuse the forfeit;
 *  `flip` makes the fold award the OTHER side; `crash` is a module bug (a plain Error, not a verdict). */
interface FakeCfg {
  credit: number;
  refuse?: boolean;
  flip?: boolean;
  crash?: boolean;
}
interface FakeState {
  cfg: FakeCfg;
  outcome: MatchOutcome | null;
}
const fake: FoldableModule<FakeCfg, FakeState> & { summary(s: FakeState): ScoreSummary } = {
  init: (cfg) => ({ cfg, outcome: null }),
  apply: (s, e) => {
    if (e.type !== "core.forfeit") return s;
    if (s.cfg.crash) throw new Error("fake: a bug in the module");
    if (s.cfg.refuse) throw new EngineError("INVALID_EVENT", "fake: this format refuses a walkover");
    const { by, reason } = e.payload as { by: string; reason: "withdrew" };
    const other = by === H ? A : H;
    return { ...s, outcome: s.cfg.flip ? { kind: "award", winner: by, loser: other, reason } : { kind: "award", winner: other, loser: by, reason } };
  },
  outcome: (s) => s.outcome,
  summary: (s) => ({
    headline: `${s.cfg.credit} — 0`,
    perSide: [
      { entrantId: H, line: String(s.cfg.credit) },
      { entrantId: A, line: "0" },
    ],
    detail: {},
  }) as unknown as ScoreSummary,
};
const m = fake as unknown as AnySportModule;
/** The stored award: away withdrew, home walked over. */
const award: MatchOutcome = { kind: "award", winner: H, loser: A, reason: "withdrew" } as MatchOutcome;
const fit = (current: FakeCfg, corrected: FakeCfg, outcome: MatchOutcome = award) => awardFit(m, current, corrected, lineups, outcome, at);

describe("awardFit: the verdict on correcting a match decided without play", () => {
  it("premise: the fake's walkover under its plain format decides exactly the stored award", () => {
    expect(fit({ credit: 2 }, { credit: 2 })).toEqual({ ok: true });
  });

  it("every arm, each with the verdict its contract names", () => {
    const table: { label: string; got: unknown; want: unknown }[] = [
      { label: "fits: the same credit under a changed format", got: fit({ credit: 2 }, { credit: 2, flip: false }), want: { ok: true } },
      {
        label: "the corrected fold credits a different score",
        got: fit({ credit: 2 }, { credit: 3 }),
        want: { ok: false, code: "FORMAT_DOES_NOT_FIT_PLAY", reason: FORMAT_FIT_REASONS.score },
      },
      {
        label: "the engine refuses the forfeit under the corrected format (its own message)",
        got: fit({ credit: 2 }, { credit: 2, refuse: true }),
        want: { ok: false, code: "FORMAT_DOES_NOT_FIT_PLAY", reason: "fake: this format refuses a walkover" },
      },
      {
        label: "the corrected fold decides a different award",
        got: fit({ credit: 2 }, { credit: 2, flip: true }),
        want: { ok: false, code: "FORMAT_DOES_NOT_FIT_PLAY", reason: FORMAT_FIT_REASONS.result },
      },
      {
        label: "the CURRENT format cannot reproduce the stored award: no fit applies",
        got: fit({ credit: 2, flip: true }, { credit: 2 }),
        want: { ok: false, code: "FIXTURE_FORMAT_LOCKED" },
      },
      {
        label: "the engine refuses the forfeit under the CURRENT format: no fit applies",
        got: fit({ credit: 2, refuse: true }, { credit: 2 }),
        want: { ok: false, code: "FIXTURE_FORMAT_LOCKED" },
      },
      {
        label: "a bye: no loser, no credited score",
        got: fit({ credit: 2 }, { credit: 3 }, { kind: "award", winner: H, loser: null, reason: "bye" } as MatchOutcome),
        want: { ok: false, code: "FIXTURE_FORMAT_LOCKED" },
      },
      {
        label: "not an award at all",
        got: fit({ credit: 2 }, { credit: 3 }, { kind: "win", winner: H, loser: A } as unknown as MatchOutcome),
        want: { ok: false, code: "FIXTURE_FORMAT_LOCKED" },
      },
    ];
    let checked = 0;
    for (const row of table) {
      expect(row.got, row.label).toMatchObject(row.want as object);
      checked++;
    }
    expect(checked, "anti-vacuity: every arm was asked").toBe(8);
  });

  it("a module bug is not a verdict: a plain Error from either fold propagates", () => {
    expect(() => fit({ credit: 2 }, { credit: 2, crash: true })).toThrow("fake: a bug in the module");
    expect(() => fit({ credit: 2, crash: true }, { credit: 2 })).toThrow("fake: a bug in the module");
  });

  it("batch-3 I1, awardFoldsUnder — a FORMAT SAVE's only question: does the award hold under the new format?", () => {
    // A save moves the credited score with it, so another score is a fold that HOLDS; the engine refusing and another
    // award are the two that do not, each with its own reason; a module bug is no verdict.
    const holds = (cfg: FakeCfg) => awardFoldsUnder(m, cfg, lineups, award, at);
    const table: { label: string; cfg: FakeCfg; want: { ok: true; headline: string } | { ok: false; reason: string } }[] = [
      { label: "the same credit", cfg: { credit: 2 }, want: { ok: true, headline: "2 — 0" } },
      { label: "another credited score (the save re-writes it)", cfg: { credit: 3 }, want: { ok: true, headline: "3 — 0" } },
      { label: "the engine refuses the forfeit", cfg: { credit: 2, refuse: true }, want: { ok: false, reason: "fake: this format refuses a walkover" } },
      { label: "the fold decides another award", cfg: { credit: 2, flip: true }, want: { ok: false, reason: FORMAT_FIT_REASONS.result } },
    ];
    let checked = 0;
    for (const row of table) {
      const got = holds(row.cfg);
      expect(got.ok ? { ok: true, headline: got.state.summary.headline } : got, row.label).toEqual(row.want);
      checked++;
    }
    expect(checked, "anti-vacuity: every arm was asked").toBe(4);
    expect(() => holds({ credit: 2, crash: true }), "a module bug is no verdict").toThrow("fake: a bug in the module");
  });
});
