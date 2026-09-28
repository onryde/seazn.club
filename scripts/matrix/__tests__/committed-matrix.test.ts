// R10: the committed MATRIX.md is exactly render(committed results.json).
// Hand-editing either one reds here.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderMatrix } from "../lib/render-matrix.ts";
import { parseResults } from "../lib/results.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1a-slice");

describe("committed W1a slice evidence", () => {
  const results = parseResults(JSON.parse(readFileSync(resolve(DIR, "results.json"), "utf8")));
  it("is the full slice, not an empty or partial run", () => {
    expect(results.cases.length).toBe(24);
    expect(results.cases.some((c) => c.canary)).toBe(false);
  });
  it("MATRIX.md is exactly the render of results.json", () => {
    expect(readFileSync(resolve(DIR, "MATRIX.md"), "utf8")).toBe(renderMatrix(results));
  });
});
