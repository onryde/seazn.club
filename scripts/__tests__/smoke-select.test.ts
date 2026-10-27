// SMOKE_ONLY (review R1): scripts/smoke.ts had no suite filter, so proving ONE new suite meant a full local smoke. The
// selector is pure, so its contract lives here: unset = everything (CI's smoke unchanged), a named subset runs exactly
// those, and a name nobody registered — or a set-but-empty value — fails loudly instead of running fewer suites than the
// caller believes. The last case reads smoke.ts's own registry, so this test's KNOWN list cannot drift from it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SmokeSelectionError, selectSmokeSuites } from "../smoke-select.ts";

const KNOWN = [
  "streamTargets",
  "v1",
  "captureV2",
  "captureRecord",
  "bracketFinish",
  "walkoverCredit",
  "streamOverlay",
  "matchRoom",
  "arbiter",
  "onlineChessDesk",
  "w2cStageRules",
  "divisionSettings",
  "epochFloorOverride",
  "registrationOpenFlow",
  "outboxTrialWarning",
  "w2dTables",
] as const;

describe("SMOKE_ONLY — selectSmokeSuites (review R1)", () => {
  it("UNSET means run everything, and unset is the default: CI's FULL smoke never sets SMOKE_ONLY, so it is unchanged — the two SMOKE_ONLY lines in CI are the R2004 composed step's own and the floor-override step's own, each on its own extra server", () => {
    expect(selectSmokeSuites(KNOWN, undefined)).toEqual({ mode: "all" });
    const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", f), "utf8");
    expect(read("e2e.yml")).not.toContain("SMOKE_ONLY");
    // R2004 (PR #981 review): ci.yml runs captureV2 ALONE against a second server that names a compositor image. Engine-split 5.6
    // (override review I2): it also runs epochFloorOverride ALONE against a third server that lowers the generic floor. Those two
    // steps — and nothing else in the workflow, no job env, not `Run smoke test` — carry SMOKE_ONLY.
    const ci = read("ci.yml");
    const lines = ci.split("\n");
    const at = lines.flatMap((l, i) => (l.includes("SMOKE_ONLY") ? [i] : []));
    expect(at, "exactly two SMOKE_ONLY lines in ci.yml").toHaveLength(2);
    const owner = (line: number) => {
      let i = line;
      while (i > 0 && !/^ {6}- name: /.test(lines[i]!)) i--;
      return [lines[i], lines[line]];
    };
    expect(owner(at[0]!), "the first belongs to the composed step").toEqual([
      "      - name: Run composed smoke (captureV2 against the compositor-image server)",
      "          SMOKE_ONLY: captureV2",
    ]);
    expect(owner(at[1]!), "the second belongs to the floor-override step").toEqual([
      "      - name: Run floor-override smoke (the generic floor lowered, against the third server)",
      "          SMOKE_ONLY: epochFloorOverride",
    ]);
    const full = ci.indexOf("      - name: Run smoke test\n");
    expect(full, "premise: the full smoke step").toBeGreaterThan(-1);
    expect(ci.slice(full, ci.indexOf("\n      - name: ", full + 1)), "the full smoke sets no subset").not.toContain("SMOKE_ONLY");
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
    // against smoke.ts with this registry inserted: 2 names, ["streamTargets", "v1"]; captureV2 joined it (capture QR v2 T12), captureRecord after it (capture record upload),
    // bracketFinish and walkoverCredit after that (format matrix W2b T18: their own orgs, nothing from SubsetCtx), and
    // streamOverlay after those (R2007 step 12: its own orgs too), then matchRoom (chess T14), arbiter (chess T15) and
    // onlineChessDesk (chess T16); w2cStageRules (own org) and divisionSettings (SubsetCtx.admin) after those (format
    // matrix W2c T10), then epochFloorOverride (engine-split 5.6, override review I2: its own org, nothing from SubsetCtx),
    // then registrationOpenFlow (email outbox phase 3 T13: its own org and its own sign-in, nothing from SubsetCtx),
    // then outboxTrialWarning (email outbox phase 3 wave 2 T11: its own org and its own sign-in, nothing from SubsetCtx);
    // w2dTables (own org) last (format matrix W2d A14).
    const block = /const SELECTABLE_SUITES\b[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const names = [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    expect(names.length, "the registry block was found and read").toBeGreaterThan(0);
    expect(names).toEqual([...KNOWN]);
  });
});
