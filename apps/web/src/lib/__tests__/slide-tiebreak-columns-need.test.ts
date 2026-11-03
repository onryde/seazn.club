// W3 app-B T9 fix round 1 (review m1): `swissOnlyKeysOf` reads TWO halves of the engine's rule 3 refusal - `reason: "stage_format"`
// AND `need: "swiss"` (cascade-rules.d.ts: "`need` is what the step lacks ... `swiss` (`stage_format`)"). The real engine emits
// `stage_format` from one rule only, always with need "swiss", so no real order can reach the other branch: this file stands the
// engine's validator in with a recorded refusal to reach it. The positive pair (a refusal that needs "swiss" IS Swiss-only) rides
// the same stub, so a stub that answered nothing could not pass the file.
import { describe, expect, it, vi } from "vitest";
import type { AnySportModule } from "@seazn/engine/sport";

const refusal = vi.hoisted(() => ({ need: "swiss" as string | undefined, reason: "stage_format" as string }));
vi.mock("@seazn/engine/competition", () => ({
  validateCascade: (cascade: readonly string[]) => [{ index: 0, key: cascade[0], reason: refusal.reason, need: refusal.need }],
}));

import { swissOnlyKeysOf } from "../slide-tiebreak-columns";

const m = {} as AnySportModule;

describe("ST-G21 swissOnlyKeysOf reads the refusal's need as well as its reason", () => {
  it("a stage_format refusal that needs swiss is Swiss-only (the positive pair)", () => {
    Object.assign(refusal, { need: "swiss", reason: "stage_format" });
    expect([...swissOnlyKeysOf(m, ["buchholz"])]).toEqual(["buchholz"]);
  });

  it("a stage_format refusal that needs another stage kind, or names no need, is not", () => {
    for (const need of ["groups", "knockout", undefined]) {
      Object.assign(refusal, { need, reason: "stage_format" });
      expect([...swissOnlyKeysOf(m, ["buchholz"])], `need ${String(need)}`).toEqual([]);
    }
  });

  it("another reason is not, whatever its need", () => {
    Object.assign(refusal, { need: "swiss", reason: "sport" });
    expect([...swissOnlyKeysOf(m, ["buchholz"])]).toEqual([]);
  });
});
