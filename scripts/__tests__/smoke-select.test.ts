// SMOKE_ONLY (review R1): scripts/smoke.ts had no suite filter, so proving ONE new suite meant a full local smoke. The
// selector is pure, so its contract lives here: unset = everything (CI's smoke unchanged), a named subset runs exactly
// those, and a name nobody registered — or a set-but-empty value — fails loudly instead of running fewer suites than the
// caller believes. The last case reads smoke.ts's own registry, so this test's KNOWN list cannot drift from it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SmokeSelectionError, selectSmokeSuites } from "../smoke-select.ts";

const KNOWN = ["streamTargets", "v1", "captureV2"] as const;

describe("SMOKE_ONLY — selectSmokeSuites (review R1)", () => {
  it("UNSET means run everything, and unset is the default: CI never sets SMOKE_ONLY, so CI's smoke is unchanged", () => {
    expect(selectSmokeSuites(KNOWN, undefined)).toEqual({ mode: "all" });
    const workflows = ["ci.yml", "e2e.yml"].map((f) => readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", f), "utf8"));
    expect(workflows.length).toBe(2);
    for (const w of workflows) expect(w).not.toContain("SMOKE_ONLY");
  });
  it("a named subset returns exactly those names, in the given order, de-duplicated and trimmed", () => {
    expect(selectSmokeSuites(KNOWN, "streamTargets")).toEqual({ mode: "subset", names: ["streamTargets"] });
    expect(selectSmokeSuites(KNOWN, " v1 ,streamTargets,v1")).toEqual({ mode: "subset", names: ["v1", "streamTargets"] });
  });
  it("an UNKNOWN name fails loudly, naming it and the selectable list — never a silently shorter run", () => {
    expect(() => selectSmokeSuites(KNOWN, "streamTargets,streamTarget")).toThrow(SmokeSelectionError);
    expect(() => selectSmokeSuites(KNOWN, "streamTargets,streamTarget")).toThrow(/streamTarget\b.*Selectable: streamTargets, v1/);
  });
  it("ZERO matched is a failure: set-but-empty, whitespace, and commas only", () => {
    let checked = 0;
    for (const raw of ["", "   ", ",", " , ,"]) {
      expect(() => selectSmokeSuites(KNOWN, raw), JSON.stringify(raw)).toThrow(SmokeSelectionError);
      checked++;
    }
    expect(checked).toBe(4);
  });
  it("the registry smoke.ts passes in is the one this test assumes", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "smoke.ts"), "utf8");
    // Lazy `[\s\S]*?` so the type annotation's `=>` (`Record<string, (c: SubsetCtx) => Promise<void>>`) is skipped
    // and the match stops at `= {`; a `[^=]*` stops at that `=>` and matches nothing (re-review N1). Proven in node
    // against smoke.ts with this registry inserted: 2 names, ["streamTargets", "v1"]; captureV2 joined it (capture QR v2 T12).
    const block = /const SELECTABLE_SUITES\b[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const names = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(names.length, "the registry block was found and read").toBeGreaterThan(0);
    expect(names).toEqual([...KNOWN]);
  });
});
