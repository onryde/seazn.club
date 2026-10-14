// Scorer sheets §4.1 / P3: every mint now SEALS, so a server without
// DEVICE_LINK_KEK cannot hand a device over. Chess design §3.1 adds a second
// such key: without LICHESS_TOKEN_KEK a server cannot link a Lichess account
// or submit a move. RELAY_KEK was never wired into CI (its tests set it
// in-process); these two are needed by the SERVER under e2e and smoke, so
// every job that boots a server with AUTH_SECRET must carry both.
//
// Table-driven over the keys rather than copied per key: the claim set was
// already 60 lines, and a second copy is the duplication a list exists for.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
/** Every workflow that boots a server with an AUTH_SECRET job env.
 *  `matrix-truth.yml` is in the list because it does exactly that (two job
 *  envs, each with AUTH_SECRET) — it was simply missing from this sweep. */
const WORKFLOWS = ["ci.yml", "e2e.yml", "bench.yml", "help-shots.yml", "matrix-truth.yml"];
const KEKS = ["DEVICE_LINK_KEK", "LICHESS_TOKEN_KEK"] as const;

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** Each `AUTH_SECRET:` line whose own env map does NOT also carry `kek:` at the same indent. The count check alone
 *  passes with a key moved from one job to another. "The same env map" is read as the run of following lines that
 *  are comments or keys at that same indent — two keys cannot both be the line immediately after AUTH_SECRET. */
function unpaired(text: string, kek: string): number[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    const indent = /^(\s+)AUTH_SECRET:/.exec(line)?.[1];
    if (indent === undefined) return [];
    const wanted = new RegExp(`^${indent}${kek}:\\s*[0-9a-f]{64}\\s*$`);
    const sameMap = new RegExp(`^(${indent}#|${indent}[A-Za-z_]+:)`);
    let next = i + 1;
    while (next < lines.length && sameMap.test(lines[next] ?? "")) {
      if (wanted.test(lines[next]!)) return [];
      next++;
    }
    return [i + 1];
  });
}

/** The throwaway value each key carries across the workflows — read from the
 *  workflows, never typed here. */
const valueOf = (kek: string): Set<string> =>
  new Set(
    WORKFLOWS.flatMap((wf) =>
      [
        ...readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8").matchAll(
          new RegExp(`^\\s+${kek}:\\s*([0-9a-f]{64})\\s*$`, "gm"),
        ),
      ].map((m) => m[1]!),
    ),
  );

for (const kek of KEKS) {
  describe(`${kek} reaches every server a test boots`, () => {
    for (const wf of WORKFLOWS) {
      it(`${wf}: one ${kek} per AUTH_SECRET job env`, () => {
        const text = readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8");
        const auth = count(text, /^\s+AUTH_SECRET:/gm);
        expect(auth, `${wf} has no AUTH_SECRET job env — the premise of this test moved`).toBeGreaterThan(0);
        expect(count(text, new RegExp(`^\\s+${kek}:\\s*[0-9a-f]{64}\\s*$`, "gm"))).toBe(auth);
        expect(unpaired(text, kek), `${wf}: AUTH_SECRET lines with no ${kek} in the same env`).toEqual([]);
      });
    }

    it(`.env.example documents ${kek}`, () => {
      const example = readFileSync(resolve(ROOT, ".env.example"), "utf8");
      expect(example).toMatch(new RegExp(`^${kek}=$`, "m"));
      expect(example).toMatch(/openssl rand -hex 32/); // owner ruling Q1
    });

    // scripts/ci-local.sh mirrors these jobs locally, and its standalone server.js starts with common_env's exports
    // and nothing else: a standalone server reads only .env/.env.production, never .env.local. Without the key there,
    // every mint (and every Lichess link) in a local ci-local run fails closed.
    it(`scripts/ci-local.sh: common_env exports the workflows' own throwaway ${kek}`, () => {
      const script = readFileSync(resolve(ROOT, "scripts/ci-local.sh"), "utf8");
      const body = /^common_env\(\) \{\n([\s\S]*?)^\}/m.exec(script)?.[1];
      expect(body, "ci-local.sh has no common_env() — the premise of this test moved").toBeDefined();
      expect(body, "common_env no longer carries AUTH_SECRET — the premise of this test moved").toMatch(/^\s+export AUTH_SECRET=/m);
      const local = [...body!.matchAll(new RegExp(`^\\s+export ${kek}=([0-9a-f]{64})\\s*$`, "gm"))].map((m) => m[1]);
      // Derived from the workflows, never typed here: a key rotated in CI and not here reds this test.
      const ci = valueOf(kek);
      expect(ci.size, "the workflows disagree on the throwaway key").toBe(1);
      expect(local).toEqual([...ci]);
    });
  });
}

describe("the two envelope keys are not one key", () => {
  it("the two keys are DIFFERENT in CI — a shared value would make the separation vacuous", () => {
    const values = KEKS.map(valueOf);
    for (const v of values) expect(v.size, "the workflows disagree on a throwaway key").toBe(1);
    expect(new Set(values.flatMap((v) => [...v])).size).toBe(KEKS.length);
  });
});
