import { describe, expect, it } from "vitest";
import { DRAW_KINDS, StageKind } from "../core/types.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

/** X-DR-1 inside DRAW_KINDS, per sport, from the sport's rulebook and its DECLARED cfg fields — never from
 *  `supportsDraws(cfg, "league")`, the code under test (preflight C6; spec §5.2). Every row cites its rule. */
type C = Record<string, unknown>;
const LEVEL_RESULT_RULE: Record<string, { rule: string; allows: (cfg: C) => boolean }> = {
  football: { rule: "IFAB Laws of the Game, Law 10: a league match may end level", allows: () => true },
  hockey: { rule: "FIH: draws stand where no overtime or shoot-out is configured (hockey/DOMAIN.md:59)", allows: (c) => c.overtime === null && c.shootout === null },
  icehockey: { rule: "IIHF/recreational: draws stand where no decider is configured (icehockey/DOMAIN.md:74)", allows: (c) => c.overtime === null && c.shootout === null },
  cricket: { rule: "MCC Laws of Cricket, Law 16: only a match of two innings a side can be drawn", allows: (c) => c.inningsPerSide === 2 },
  boardgame: { rule: "FIDE Laws of Chess, Art. 5.2: a game may be drawn", allows: () => true },
  carrom: { rule: "ICF Laws: a tied match plays an extra board; a draw only under the tieBoard 'draw' house rule", allows: (c) => c.tieBoard === "draw" },
  generic: { rule: "organiser-declared: a draw only with cfg.allowDraws", allows: (c) => c.allowDraws === true },
  volleyball: { rule: "FIVB: a set-based match always has a winner", allows: () => false },
  badminton: { rule: "BWF: a set-based match always has a winner", allows: () => false },
  tabletennis: { rule: "ITTF: a set-based match always has a winner", allows: () => false },
  tennis: { rule: "ITF: a tennis match always has a winner", allows: () => false },
};

describe("X-DR-1: supportsDraws is an allow-list over DRAW_KINDS, swept 11 sports × 9 kinds", () => {
  it("empty case first: DRAW_KINDS is not empty and is a strict subset of StageKind", () => {
    expect(DRAW_KINDS.size).toBeGreaterThan(0);
    expect(DRAW_KINDS.size).toBeLessThan(StageKind.options.length);
  });

  it("X-DR-1: outside DRAW_KINDS no sport allows a draw; inside, the sport's own rule over its declared cfg decides", () => {
    let checked = 0;
    let drawable = 0;
    let refused = 0;
    const seen: string[] = [];
    const sports = forEachSport(({ key, module }) => {
      const row = LEVEL_RESULT_RULE[key];
      expect(row, `${key} has no X-DR-1 rule row`).toBeDefined();
      seen.push(key);
      for (const { name, cfg } of declaredCfgs(module as never)) {
        for (const kind of StageKind.options) {
          const expected = DRAW_KINDS.has(kind) && row!.allows(cfg as C);
          expect(module.supportsDraws(cfg as never, kind), `${key}/${name} ${kind} (${row!.rule})`).toBe(expected);
          if (expected) drawable++;
          else refused++;
          checked++;
        }
      }
    });
    expect(sports).toBe(11);
    expect(seen.sort()).toEqual(Object.keys(LEVEL_RESULT_RULE).sort()); // no stale or missing rule row
    expect(checked).toBeGreaterThanOrEqual(11 * StageKind.options.length);
    expect(drawable).toBeGreaterThan(0); // a sweep that never sees a true cannot witness the allow-list
    expect(refused).toBeGreaterThan(0);
  });

  it("X-DR-1: the cases the old deny-list got wrong (generic page_playoff/ladder/americano, boardgame knockout)", () => {
    // Right answer differs from the wrong one's constant: the deny-list answered true for all four.
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "generic" && key !== "boardgame") return; // one-line reason: the two modules the deny-list / always-true covered
      // A declared cfg that allows draws: generic's `score` variant (allowDraws true); boardgame's schema default.
      const drawing = declaredCfgs(module as never).find(({ cfg }) => LEVEL_RESULT_RULE[key]!.allows(cfg as C));
      expect(drawing, `${key} declares no draw-allowing cfg`).toBeDefined();
      for (const kind of ["page_playoff", "ladder", "knockout"] as const) {
        expect(module.supportsDraws(drawing!.cfg as never, kind), `${key} ${kind}`).toBe(false);
        checked++;
      }
      expect(module.supportsDraws(drawing!.cfg as never, "americano"), `${key} americano`).toBe(true);
      checked++;
    });
    expect(checked).toBe(8);
  });
});
