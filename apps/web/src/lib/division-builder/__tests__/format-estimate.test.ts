// The builder's match counts are a CLIENT estimate of the draw the server generates. The oracle is the real draw:
// `previewDivisionFixtures` (usecases/stages/preview.ts) runs the engine's own generators over placeholder entrants, and the
// engine's `generateAmericano` builds an americano rotation. Where a format is score-dependent (Swiss, ladder) the
// oracle is the rulebook, stated here, never the estimator's own arithmetic.
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { generateAmericano } from "@seazn/engine/scheduling";
import { previewDivisionFixtures, type PreviewStageInput } from "@/server/usecases/stages";
import { STAGE_TEMPLATES, buildTemplateStages, type TemplateKnobs } from "@/lib/format-templates";
import { estimateMinutes, estimatePlateField, estimateTemplate } from "../format-estimate";
import { foldFirstLosses } from "./first-loss-fold";

const BYE = "Bye";
const realMatches = (s: { matches: { home: string; away: string }[] }) =>
  s.matches.filter((m) => m.home !== BYE && m.away !== BYE).length;
const isPow2 = (k: number) => (k & (k - 1)) === 0;

/** Stage kinds whose whole draw the preview generates up front (no results needed). */
const DRAWN_KINDS = new Set(["league", "group", "knockout", "double_elim", "page_playoff", "stepladder"]);
/** Kinds whose preview sections are rounds of play (a group's sections are its pools). */
const ROUND_SECTION_KINDS = new Set(["league", "knockout", "double_elim", "page_playoff", "stepladder"]);

describe("W4 T15 (FX-G14): the estimate and the server agree on a field the format cannot play", () => {
  const KNOBS: TemplateKnobs = { qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 };

  it.each([
    ["ko_plate", 4],
    ["qualifying_main", 4],
  ])("%s below %i counts nothing, on any stage, and has no playing time", (key, min) => {
    let checked = 0;
    for (let n = 0; n < min; n++) {
      const est = estimateTemplate(key, n, KNOBS);
      expect(est.matches, `n=${n}`).toBeNull();
      expect(est.rounds, `n=${n}`).toBeNull();
      expect(est.stages.length, `n=${n}: the stages are still listed`).toBe(2);
      expect(est.stages.every((s) => s.matches === null && s.rounds === null), `n=${n}`).toBe(true);
      expect(estimateMinutes(est, 2, 30), `n=${n}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(min);
    // At the bound there is a draw to count.
    expect(estimateTemplate(key, min, KNOBS).matches, "at the bound").toBeGreaterThan(0);
  });

  it("a plain knockout at the same fields is no business of the gate", () => {
    let checked = 0;
    for (const n of [2, 3]) {
      expect(estimateTemplate("knockout", n, KNOBS).matches, `n=${n}`).toBe(n - 1);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

function knobGrid(n: number): TemplateKnobs[] {
  const out: TemplateKnobs[] = [];
  for (const qualified of [2, 4, 8]) {
    if (qualified > n) continue;
    for (const poolCount of [2, 3, 4]) {
      if (poolCount * 2 > n) continue;
      for (const legs of [1, 2]) for (const swissRounds of [3, 5]) out.push({ qualified, poolCount, legs, swissRounds });
    }
  }
  return out;
}

describe("estimateTemplate against the real draw (previewDivisionFixtures, engine generators)", () => {
  it("every drawn stage's match count and rounds equal the preview's, every template x n 4..16 x knob grid (counts)", () => {
    let checkedMatches = 0;
    let checkedRounds = 0;
    const templates = new Set<string>();
    for (const t of STAGE_TEMPLATES) {
      for (let n = 4; n <= 16; n++) {
        for (const knobs of knobGrid(n)) {
          const drafts = buildTemplateStages(t.key, knobs);
          const preview = previewDivisionFixtures(drafts as unknown as PreviewStageInput[], n);
          const est = estimateTemplate(t.key, n, knobs);
          expect(est.stages.length, `${t.key} n=${n}`).toBe(drafts.length);
          drafts.forEach((d, i) => {
            const phase = preview[i]!;
            const stage = est.stages[i]!;
            if (!DRAWN_KINDS.has(d.kind)) return;
            // The preview sizes a later stage from the take rule alone; it does not cap a plate at the main draw's real
            // round-one losers, nor draw a double-elimination's bye lines without minting matches off them. Those
            // cases are pinned by the rulebook tests below instead.
            if (i > 0 && t.key === "ko_plate") return;
            if (d.kind === "double_elim" && !isPow2(stage.entrants)) return;
            const want = phase.sections.reduce((sum, s) => sum + realMatches(s), 0);
            expect(stage.matches, `${t.key} n=${n} ${JSON.stringify(knobs)} stage ${i} ${d.kind}`).toBe(want);
            checkedMatches++;
            templates.add(t.key);
            if (ROUND_SECTION_KINDS.has(d.kind)) {
              expect(stage.rounds, `${t.key} n=${n} stage ${i} rounds`).toBe(phase.sections.length);
              checkedRounds++;
            }
          });
        }
      }
    }
    // Anti-vacuity: every template with a drawn stage was compared, and the sweep was wide.
    const drawnTemplates = STAGE_TEMPLATES.filter((t) =>
      buildTemplateStages(t.key, { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 }).some((d) => DRAWN_KINDS.has(d.kind)),
    ).map((t) => t.key);
    expect(drawnTemplates.length).toBeGreaterThan(0);
    expect([...templates].sort()).toEqual(drawnTemplates.sort());
    expect(checkedMatches).toBeGreaterThan(500);
    expect(checkedRounds).toBeGreaterThan(300);
  });

  it("americano and mexicano rounds equal the engine's own rotation (generateAmericano), n 4..16 (counts)", () => {
    let checked = 0;
    for (const key of ["americano", "mexicano"]) {
      for (let n = 4; n <= 16; n++) {
        const knobs = { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 };
        const [draft] = buildTemplateStages(key, knobs);
        const cfg = draft!.config as { courtCount: number; rounds: number };
        const players = Array.from({ length: n }, (_, i) => `p${i}`);
        const rounds = generateAmericano(players, { mode: "americano", courtCount: cfg.courtCount, rounds: cfg.rounds });
        const est = estimateTemplate(key, n, knobs);
        expect(est.matches, `${key} n=${n}`).toBe(rounds.reduce((s, r) => s + r.matches.length, 0));
        expect(est.rounds, `${key} n=${n}`).toBe(rounds.length);
        checked++;
      }
    }
    expect(checked).toBe(26);
  });
});

describe("estimateTemplate against the rulebook (score-dependent formats, and what the preview cannot draw)", () => {
  it("Swiss: every round pairs floor(n/2) boards (FIDE C.04: an odd player out takes the bye), for the round knob", () => {
    let checked = 0;
    for (const key of ["swiss", "swiss_playoff", "swiss_knockout"]) {
      for (let n = 4; n <= 17; n++) {
        for (const swissRounds of [3, 5, 7]) {
          const est = estimateTemplate(key, n, { qualified: 4, poolCount: 2, legs: 1, swissRounds });
          expect(est.stages[0]!.matches, `${key} n=${n} R=${swissRounds}`).toBe(Math.floor(n / 2) * swissRounds);
          expect(est.stages[0]!.rounds).toBe(swissRounds);
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * 14 * 3);
  });

  it("double elimination: every entrant but the champion goes out on its second loss, so 2n - 2 matches before any reset", () => {
    for (const n of [5, 6, 7, 9, 12, 13]) {
      expect(estimateTemplate("double_elim", n, { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 }).matches, `n=${n}`).toBe(2 * n - 2);
    }
  });

  it("a plate takes every first loss: a 5-player draw has three byes, so round one has one loser and the two bye holders who meet in round two give one more", () => {
    const knobs = { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 };
    // 5 into 8: seeds 1-3 have byes; round two is 1 v (4/5) and 2 v 3, and the 2 v 3 loser lost her FIRST match: field 2, one match.
    expect(estimateTemplate("ko_plate", 5, knobs).stages[1]!.entrants).toBe(2);
    expect(estimateTemplate("ko_plate", 5, knobs).stages[1]!.matches).toBe(1);
    // 8: four round-one losers, so a plate of four: three matches.
    expect(estimateTemplate("ko_plate", 8, knobs).stages[1]!.matches).toBe(3);
    // 12 into 16: four byes, four round-one matches, four losers (no two bye holders meet: (2n-S)/2 only). The Top N knob is not read.
    expect(estimateTemplate("ko_plate", 12, { ...knobs, qualified: 8 }).stages[1]!.entrants).toBe(4);
    expect(estimateTemplate("ko_plate", 12, { ...knobs, qualified: 2 }).stages[1]!.entrants).toBe(4);
  });

  describe("X-PL-6 estimatePlateField — the first-loss field (PL-1: a Top 4 dropped first losses above 12 entrants)", () => {
    it("empty case first: nobody to lose, nothing to take", () => {
      expect(estimatePlateField(0)).toBe(0);
      expect(estimatePlateField(1)).toBe(0);
      expect(estimatePlateField(-3)).toBe(0);
    });

    it("X-PL-6 the estimate counts the first-loss field, n = 4…131 counted — each n equals the fold of the engine's own bracket", () => {
      const named = [5, 6, 7, 9, 13, 17, 33, 34, 35, 65, 66, 67, 129, 130, 131];
      let checked = 0;
      let above4 = 0;
      for (let n = 4; n <= 131; n++) {
        expect(estimatePlateField(n), `n=${n}`).toBe(foldFirstLosses(n));
        checked++;
        if (n > 12 && estimatePlateField(n) > 4) above4++;
      }
      for (const n of named) {
        expect(estimatePlateField(n), `named n=${n}`).toBe(foldFirstLosses(n));
        checked++;
      }
      expect(checked).toBe(131 - 4 + 1 + named.length); // anti-vacuity: every n and every named one was folded
      // PL-1: above 12 entrants the old Top 4 dropped first losses — the field exceeds 4 for EVERY n above 12.
      expect(above4).toBe(131 - 13 + 1);
    });

    it("the fold itself is not the estimate: it differs from the round-one-losers count where bye holders meet (n = 5, 9)", () => {
      expect(foldFirstLosses(5)).toBe(2); // one round-one loser + the 2 v 3 line
      expect(foldFirstLosses(9)).toBe(4); // one round-one loser + three bye-v-bye lines
      expect(foldFirstLosses(8)).toBe(4);
    });
  });

  it("a ladder has no fixed draw: no match count, no rounds, no time estimate", () => {
    const est = estimateTemplate("ladder", 10, { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 });
    expect(est.matches).toBeNull();
    expect(est.rounds).toBeNull();
    expect(estimateMinutes(est, 2, 30)).toBeNull();
  });

  it("home and away doubles a league: 8 entrants play 56 matches over 14 rounds", () => {
    const est = estimateTemplate("league", 8, { qualified: 4, poolCount: 2, legs: 2, swissRounds: 3 });
    expect(est.matches).toBe(56);
    expect(est.rounds).toBe(14);
  });
});

describe("estimateMinutes", () => {
  const knobs = { qualified: 4, poolCount: 2, legs: 1, swissRounds: 3 };
  it("a round cannot start before the last one ends: a knockout of 8 on 8 courts still needs its 3 rounds", () => {
    expect(estimateMinutes(estimateTemplate("knockout", 8, knobs), 8, 30)).toBe(3 * 30);
  });
  it("courts bind when they are short: a league of 8 (28 matches) on 2 courts is 14 slots", () => {
    expect(estimateMinutes(estimateTemplate("league", 8, knobs), 2, 30)).toBe(14 * 30);
  });
  it("stages run one after another: league of 6 (15 matches, 5 rounds) then a 4-player knockout (3, 2 rounds) on 3 courts", () => {
    // league: max(5 rounds, ceil(15/3)=5) = 5 slots; knockout of 4: max(2, ceil(3/3)=1) = 2 slots.
    expect(estimateMinutes(estimateTemplate("league_ko", 6, knobs), 3, 20)).toBe((5 + 2) * 20);
  });
  it("zero courts or minutes is no estimate, not zero time", () => {
    expect(estimateMinutes(estimateTemplate("league", 8, knobs), 0, 30)).toBeNull();
    expect(estimateMinutes(estimateTemplate("league", 8, knobs), 2, 0)).toBeNull();
  });
});
