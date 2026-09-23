// Scorer sheets §4.1 / P3: every mint now SEALS, so a server without
// DEVICE_LINK_KEK cannot hand a device over. RELAY_KEK was never wired into CI
// (its tests set it in-process); this key is needed by the SERVER under e2e and
// smoke, so every job that boots a server with AUTH_SECRET must carry it too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = ["ci.yml", "e2e.yml", "bench.yml", "help-shots.yml"];

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** Each `AUTH_SECRET:` line whose next non-comment line is NOT a `DEVICE_LINK_KEK:` at the same indent (so in the
 *  same env map). The count check alone passes with a key moved from one job to another. */
function unpaired(text: string): number[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    const indent = /^(\s+)AUTH_SECRET:/.exec(line)?.[1];
    if (indent === undefined) return [];
    let next = i + 1;
    while (next < lines.length && /^\s*#/.test(lines[next]!)) next++;
    const paired = new RegExp(`^${indent}DEVICE_LINK_KEK:\\s*[0-9a-f]{64}\\s*$`).test(lines[next] ?? "");
    return paired ? [] : [i + 1];
  });
}

describe("DEVICE_LINK_KEK reaches every server a test boots", () => {
  for (const wf of WORKFLOWS) {
    it(`${wf}: one DEVICE_LINK_KEK per AUTH_SECRET job env`, () => {
      const text = readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8");
      const auth = count(text, /^\s+AUTH_SECRET:/gm);
      expect(auth, `${wf} has no AUTH_SECRET job env — the premise of this test moved`).toBeGreaterThan(0);
      expect(count(text, /^\s+DEVICE_LINK_KEK:\s*[0-9a-f]{64}\s*$/gm)).toBe(auth);
      expect(unpaired(text), `${wf}: AUTH_SECRET lines with no DEVICE_LINK_KEK in the same env`).toEqual([]);
    });
  }

  it(".env.example documents it", () => {
    const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");
    expect(example).toMatch(/^DEVICE_LINK_KEK=$/m);
    expect(example).toMatch(/openssl rand -hex 32/); // owner ruling Q1
  });
});
