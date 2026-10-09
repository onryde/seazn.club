import { describe, expect, it } from "vitest";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";

/** Spec §5.2's declarations, read from the rule rows: BG-KO-1 (tiebreak),
 *  CA-KO-1 (extra board); every other sport declares nothing in W2a. */
const RULED: Readonly<Record<string, Record<string, unknown>>> = {
  boardgame: { tiebreak: true }, // BG-KO-1
  carrom: { tieBoard: "extra" }, // CA-KO-1
};

describe("bracketDeciders, per sport (spec §5.2)", () => {
  it("empty case first: {} is a legal declaration and changes nothing when merged", () => {
    // Every sport that declares {} — merged over each config it declares — parses back to exactly that config.
    let checked = 0;
    const sports = forEachSport(({ key, module }) => {
      for (const { name, cfg } of declaredCfgs(module as never)) {
        const overlay: Record<string, unknown> = module.bracketDeciders(cfg);
        if (Object.keys(overlay).length > 0) continue;
        expect(module.configSchema.parse({ ...(cfg as object), ...overlay }), `${key}/${name}`).toEqual(cfg);
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBeGreaterThan(0);
  });

  it("BG-KO-1 CA-KO-1: every sport declares exactly its ruled overlay, and the overlay parses under its own schema", () => {
    let checked = 0;
    let nonEmpty = 0;
    const sports = forEachSport(({ key, module }) => {
      for (const { cfg } of declaredCfgs(module as never)) { // preflight C7: generic has no schema default
        const overlay: Record<string, unknown> = module.bracketDeciders(cfg);
        expect(overlay, key).toEqual(RULED[key] ?? {});
        expect(() => module.configSchema.parse({ ...(cfg as object), ...overlay }), key).not.toThrow();
        if (Object.keys(overlay).length > 0) nonEmpty++;
        checked++;
      }
    });
    expect(sports).toBe(11);
    expect(checked).toBeGreaterThan(11);
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it("CA-KO-1: the overlay wins over a division tieBoard 'draw' (right answer differs from the division's constant)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      if (key !== "carrom") return; // one-line reason: CA-KO-1 is carrom's own rule
      const cfg = module.configSchema.parse({ tieBoard: "draw" }) as { tieBoard: string };
      expect({ ...cfg, ...module.bracketDeciders(cfg as never) }.tieBoard).toBe("extra");
      checked++;
    });
    expect(checked).toBe(1);
  });
});
