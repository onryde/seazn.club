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

/** A direct module summary, in every spelling a call could take: a member call (`m.summary(`, `m?.summary(`,
 *  `m.summary?.(`, `m.summary.call(` / `.apply(` / `.bind(`), a bracket read (`m["summary"]`), and a destructured
 *  binding (`const { summary } = m`, `({ summary }) =>`). A plain member READ is not one: `state.summary` and
 *  `fold.summary.perSide` are the summary DATA a route or `foldPack` already produced. An object KEY built from
 *  `summaryOf` (`{ summary: summaryOf(m, f) }`) is the seam, not a bypass. A destructured `summary` of ANY object reds
 *  — the bench destructures none today; one that is data, not a module, is renamed or named here. */
const DIRECT = new RegExp(
  [
    String.raw`(?:\?\.|\.)\s*summary\s*(?:\?\.\s*)?\(`,
    String.raw`(?:\?\.|\.)\s*summary\s*\.\s*(?:call|apply|bind)\b`,
    String.raw`\[\s*["'\x60]summary["'\x60]\s*\]`,
    String.raw`\{[^{}]*\bsummary\b(?!\s*:\s*summaryOf\b)[^{}]*\}\s*(?::[^=;{}]*)?=(?![=>])`,
    String.raw`\(\s*\{[^{}]*\bsummary\b(?!\s*:\s*summaryOf\b)[^{}]*\}`,
  ].join("|"),
  "g",
);
const VIA = /\bsummaryOf\(/g;
/** The text, comments removed: a comment that NAMES the call it replaced is not a call. */
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (path: string): string => strip(readFileSync(path, "utf8"));
const directIn = (text: string): string[] => [...strip(text).matchAll(DIRECT)].map((m) => m[0]);

describe("W2b PF-1: the bench reads a fold's summary through the engine's summaryOf", () => {
  it("PF-1 seam: no bench source calls module.summary directly; validate-pack and reconstruct call summaryOf", () => {
    const files = sources(BENCH);
    const direct: string[] = [];
    for (const f of files) {
      for (const m of directIn(readFileSync(f, "utf8"))) direct.push(`${relative(BENCH, f)}: ${m}`);
    }
    const via = Object.fromEntries(
      ["lib/validate-pack.ts", "lib/reconstruct.ts"].map((f) => [f, [...code(join(BENCH, f)).matchAll(VIA)].length]),
    );
    expect(files.length, `bench sources scanned: ${files.length}`).toBeGreaterThan(0);
    expect(direct, "a direct module.summary call skips the PF-1 overlay").toEqual([]);
    expect(via, "each reader goes through summaryOf").toEqual({ "lib/validate-pack.ts": 1, "lib/reconstruct.ts": 1 });
  });

  it("PF-1 seam: the direct-read pattern sees every spelling of a module summary, and none of the seam's own", () => {
    const bypasses = [
      "sportModule.summary(state)",
      "sportModule?.summary(state)",
      "mod . summary (state)",
      "sportModule.summary.call(sportModule, state)",
      "sportModule.summary?.(state)",
      "const read = sportModule.summary.bind(sportModule);",
      'sportModule["summary"](state)',
      "const { summary } = sportModule;",
      "const { init, summary: read }: SportModule = sportModule;",
      "const pick = ({ summary }: SportModule) => summary(state);",
    ];
    let seen = 0;
    for (const text of bypasses) {
      expect(directIn(text), text).toHaveLength(1);
      seen++;
    }
    expect(seen).toBe(bypasses.length);
    const seam = [
      "summary: summaryOf(sportModule, facts),",
      "SetLedgerDetail.safeParse(summaryOf(sportModule, folded).detail)",
      'events.filter((e) => e.type === "badminton.game.summary")',
      '// was sportModule.summary(state)',
      'row.locator("summary").click()',
      "ScoreSummary.safeParse(state.summary)",
      "const got = fold.summary.perSide.find((s) => s.entrantId === id);",
      "`the other five (game.summary, timeout, sanction)`",
      'const url = "https://x"; // sportModule.summary(state)',
    ];
    for (const text of seam) expect(directIn(text), text).toEqual([]);
  });
});
