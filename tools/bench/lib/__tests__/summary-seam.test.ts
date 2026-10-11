// W2b Task 10 (loop D carry-in: "the PF-1 headline fix is INERT unless every reader goes through summaryOf") — the
// bench reads a fold's ScoreSummary in two places: validate-pack's P2 parity point (the summary a pack's `perSide` is
// compared against) and reconstruct's set ledger. Both go through the engine's `summaryOf(module, folded)`, never
// `module.summary(state)`. `summaryOf` is the one summary that agrees with `outcomeOf` when the kernel admits a
// withdrawal over a held level result (PF-1), and it is what apps/web reads since loop F.
// Pinned by SOURCE, not by a fold: neither site can reach that case through a stream the product would accept — the
// importer appends through the server's PF-2 guard, which refuses a `withdrew` forfeit from every writer but the
// withdrawal cascade, and a set-based match never ends level — so a fold-level witness would assert the bench folding
// a stream the product refuses.
// Single-sport reason: no sport is involved. This pins the call sites.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.ts` file a bench run loads: tests, their helpers and node_modules left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "__tests__") return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

/** A direct module summary: `<anything>.summary(`. The bench has no other `.summary(` method to confuse it with. */
const DIRECT = /\b\w+\.summary\(/g;
const VIA = /\bsummaryOf\(/g;
/** The code, comments removed: a comment that NAMES the call it replaced is not a call. */
const code = (path: string): string => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("W2b PF-1: the bench reads a fold's summary through the engine's summaryOf", () => {
  it("PF-1 seam: no bench source calls module.summary directly; validate-pack and reconstruct call summaryOf", () => {
    const files = sources(BENCH);
    const direct: string[] = [];
    for (const f of files) {
      for (const m of code(f).matchAll(DIRECT)) direct.push(`${relative(BENCH, f)}: ${m[0]}`);
    }
    const via = Object.fromEntries(
      ["lib/validate-pack.ts", "lib/reconstruct.ts"].map((f) => [f, [...code(join(BENCH, f)).matchAll(VIA)].length]),
    );
    expect(files.length, `bench sources scanned: ${files.length}`).toBeGreaterThan(0);
    expect(direct, "a direct module.summary call skips the PF-1 overlay").toEqual([]);
    expect(via, "each reader goes through summaryOf").toEqual({ "lib/validate-pack.ts": 1, "lib/reconstruct.ts": 1 });
  });
});
