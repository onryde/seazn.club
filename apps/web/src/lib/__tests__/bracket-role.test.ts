// W4 app-A Task 4 (gap K3; X-RB-1): a knockout line's role key, against the ENGINE's own bracket (`generateSingleElim`
// declares the shape — pre-flight R9), stored the way the app stores it (engine-bracket-rows.ts). The expected roles
// come from the engine's flags and winner feeds (`isFinal`, `thirdPlace`, each line's path to the final), never from the
// key function under test.
//
// single-sport: none — a bracket's shape reads no sport field.
import { describe, expect, it } from "vitest";
import { BracketHasNoFinalError, bracketRoleKey, finalRoundOf } from "@/lib/bracket-role";
import { engineBracketRows } from "./engine-bracket-rows";

describe("W4 T4 finalRoundOf and bracketRoleKey (X-RB-1)", () => {
  it("the empty case first: a bracket with no line has no final, and says so by name", () => {
    expect(() => finalRoundOf([])).toThrow(BracketHasNoFinalError);
    // A third-place line alone is no final either: it is told apart by its key, not its round.
    expect(() => finalRoundOf([{ pool_id: null, round_no: 3, seq_in_round: 2, ext_key: "se-3p" }])).toThrow(BracketHasNoFinalError);
  });

  // R16: a third-place match exists only with two semi-finals (n >= 4); the engine 4.0.0 refuses one below that.
  const CASES: { n: number; thirdPlace: boolean }[] = [
    { n: 2, thirdPlace: false },
    { n: 3, thirdPlace: false },
    { n: 8, thirdPlace: true },
    { n: 9, thirdPlace: true },
    { n: 16, thirdPlace: true },
    { n: 8, thirdPlace: false },
  ];

  it("at 2, 3, 8, 9 and 16 entrants: the final is 0:1, the semi-finals feeding its home and away seats 1:1 and 1:2, the third place 3p, every line's depth its distance from the final, and no two lines share a key", () => {
    let brackets = 0;
    let lines = 0;
    let semis = 0;
    let thirds = 0;
    for (const { n, thirdPlace } of CASES) {
      const rows = engineBracketRows(n, thirdPlace);
      const finalRound = finalRoundOf(rows);
      const final = rows.find((r) => r.isFinal)!;
      expect(finalRound, `n=${n}: the final's round is the one counted back from`).toBe(final.round_no);
      const keys = new Set<string>();
      for (const r of rows) {
        const key = bracketRoleKey(r, finalRound);
        keys.add(key);
        lines++;
        if (r.thirdPlace) {
          expect(key, `n=${n}: the third place`).toBe(":3p");
          thirds++;
          continue;
        }
        expect(key.split(":")[1], `n=${n} ${r.ext_key}: depth = the engine's distance to the final`).toBe(String(r.path.length));
      }
      expect(bracketRoleKey(final, finalRound), `n=${n}: the final`).toBe(":0:1");
      if (n > 2) {
        expect(bracketRoleKey(rows.find((r) => r.path === "H")!, finalRound), `n=${n}: home semi`).toBe(":1:1");
        expect(bracketRoleKey(rows.find((r) => r.path === "A")!, finalRound), `n=${n}: away semi`).toBe(":1:2");
        semis += 2;
      }
      expect(rows.filter((r) => r.thirdPlace).length, `n=${n}: a third place exactly when asked for`).toBe(thirdPlace ? 1 : 0);
      expect(keys.size, `n=${n}: every line has its own role`).toBe(rows.length);
      brackets++;
    }
    // 1 + 3 + 8 + 16 + 16 + 7 lines (with 3p at 8, 9, 16).
    expect([brackets, lines, semis, thirds], "anti-vacuity: brackets, lines, semi-finals, third places checked").toEqual([6, 51, 10, 3]);
  });

  it("the roles survive a size change: by role the final of 8 is the final of 9 and of 16, where by round it is a semi-final", () => {
    const roleOfPath = (n: number) => {
      const rows = engineBracketRows(n, true);
      const fr = finalRoundOf(rows);
      return new Map(rows.filter((r) => r.path.length <= 1 || r.thirdPlace).map((r) => [r.path, { key: bracketRoleKey(r, fr), round: r.round_no }]));
    };
    const [eight, nine, sixteen] = [roleOfPath(8), roleOfPath(9), roleOfPath(16)];
    // The defect K3 names: the final's round_no moves with the size (8 → round 3; 9 and 16 → round 4).
    expect([eight.get("")!.round, nine.get("")!.round, sixteen.get("")!.round], "premise").toEqual([3, 4, 4]);
    let checked = 0;
    for (const path of ["", "H", "A", "3p"]) {
      expect(nine.get(path)!.key, `9: ${path || "final"}`).toBe(eight.get(path)!.key);
      expect(sixteen.get(path)!.key, `16: ${path || "final"}`).toBe(eight.get(path)!.key);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a pool's bracket keys carry the pool, so two pools' finals never meet", () => {
    const key = (pool: string) => {
      const rows = engineBracketRows(4, false, pool);
      return bracketRoleKey(rows.find((r) => r.isFinal)!, finalRoundOf(rows));
    };
    expect([key("pool-a"), key("pool-b")]).toEqual(["pool-a:0:1", "pool-b:0:1"]);
  });
});
