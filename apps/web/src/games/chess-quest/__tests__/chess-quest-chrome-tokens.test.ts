// W3 acceptance criteria (Amendment 2, 2026-08-27 — tokens only, no dark:):
// docs/superpowers/specs/2026-08-26-games-board-redesign-and-new-games-design.md
// "W3 — chrome: token extraction (no dark mode — see Amendment 2)".
//
// This is the chrome-token sibling of chess-quest-css.test.ts (W1, board-only).
// That file guards .cq-board's 9 board tokens; this one guards the NEW --cq-*
// chrome tokens (headings, labels, pills, borders — everything the board test
// doesn't touch) and the purple-* -> token migration across the 14 files the
// design doc names under "W3 — chrome": every *.tsx under
// src/games/chess-quest/components/, src/app/games/page.tsx, and
// src/app/games/[slug]/page.tsx. index.tsx itself is deliberately OUT of that
// file list (the doc's own "Files:" line names components/ only) — it keeps
// its pre-existing purple-* classes; that gap is a known, reported follow-up,
// not something this test polices.
//
// Every token value below is copied verbatim from Tailwind v4's stock `purple`
// scale (apps/web/node_modules/tailwindcss/theme.css) so the refactor cannot
// shift a single rendered pixel — seeing is not enough here, since globals.css
// already documents a case (--mk-lime vs text-lime-400) where a v3-hex
// approximation of a v4 oklch stop was subtly wrong. One token per distinct
// shade actually in use, not a lossy handful-of-tokens collapse, for the same
// pixel-fidelity reason.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CQ_ROOT = path.resolve(__dirname, "..");
const cssPath = path.resolve(CQ_ROOT, "chess-quest.css");
const css = fs.readFileSync(cssPath, "utf8");
const PRINT_MARKER = "/* ---------- printable certificate ---------- */";
const printAt = css.indexOf(PRINT_MARKER);
const chromeCss = css.slice(0, printAt);
const printCss = css.slice(printAt);

// shade -> [token name, exact Tailwind v4 oklch stop]. Values pulled straight
// from theme.css; do not hand-round these.
const CHROME_TOKENS: [string, string, string][] = [
  ["950", "--cq-ink", "oklch(29.1% 0.149 302.717)"],
  ["900", "--cq-ink-muted", "oklch(38.1% 0.176 304.987)"],
  ["800", "--cq-accent-strong", "oklch(43.8% 0.218 303.724)"],
  ["700", "--cq-label", "oklch(49.6% 0.265 301.924)"],
  ["600", "--cq-accent", "oklch(55.8% 0.288 302.321)"],
  ["500", "--cq-ring", "oklch(62.7% 0.265 303.9)"],
  ["400", "--cq-accent-muted", "oklch(71.4% 0.203 305.504)"],
  ["300", "--cq-accent-line", "oklch(82.7% 0.119 306.383)"],
  ["200", "--cq-line-soft", "oklch(90.2% 0.063 306.703)"],
  ["100", "--cq-accent-soft", "oklch(94.6% 0.033 307.174)"],
  ["50", "--cq-accent-wash", "oklch(97.7% 0.014 308.299)"],
];

// The 14 files the design doc's "W3 — chrome" file list names, relative to
// CQ_ROOT (src/games/chess-quest/).
const COMPONENT_FILES = [
  "components/GameShell.tsx",
  "components/quest/QuestMap.tsx",
  "components/quest/LessonCard.tsx",
  "components/quest/GrownUpsDrawer.tsx",
  "components/quest/QuestHeader.tsx",
  "components/quest/ProgressPanel.tsx",
  "components/quest/ProfilePanel.tsx",
  "components/quest/Modal.tsx",
  "components/games/RookMaze.tsx",
  "components/games/PuzzleDots.tsx",
  "components/games/CoinHop.tsx",
  "components/games/TacticTrainer.tsx",
];
const PAGE_FILES = ["../../app/games/page.tsx", "../../app/games/[slug]/page.tsx"];
const ALL_SCOPED_FILES = [...COMPONENT_FILES, ...PAGE_FILES];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("chess-quest chrome tokens (W3) — purple-* classes come from --cq-* custom properties", () => {
  it("defines all eleven chrome tokens on :root, with Tailwind's exact stock purple oklch values", () => {
    expect(printAt).toBeGreaterThan(0);
    for (const [, token, value] of CHROME_TOKENS) {
      expect(chromeCss).toContain(`${token}: ${value}`);
    }
  });

  it("scopes the chrome tokens to :root, not .cq-board (they're consumed outside the board)", () => {
    const rootBlock = chromeCss.match(/:root\s*{[^}]*}/);
    expect(rootBlock, ":root block with the chrome tokens not found").not.toBeNull();
    for (const [, token] of CHROME_TOKENS) {
      expect(rootBlock![0]).toContain(`${token}:`);
    }
  });

  it("the print certificate section carries none of the new chrome tokens (untouched by this migration)", () => {
    for (const [, token] of CHROME_TOKENS) {
      expect(printCss).not.toContain(token);
    }
    // Same literal spot-checks chess-quest-css.test.ts (W1) already pins —
    // repeated here as a cheap tripwire in case a future edit lands between
    // the two test files and only one gets updated.
    expect(printCss).toContain("#2f7d52");
    expect(printCss).toContain(".cq-cert-sheet");
  });

  for (const rel of COMPONENT_FILES) {
    it(`${rel}: zero hardcoded purple-* Tailwind classes remain`, () => {
      const text = fs.readFileSync(path.join(CQ_ROOT, rel), "utf8");
      const matches = text.match(/purple-\d+/g) ?? [];
      expect(matches, `residual purple-* classes: ${matches.join(", ")}`).toEqual([]);
    });
  }

  for (const rel of PAGE_FILES) {
    it(`${rel}: zero hardcoded purple-* Tailwind classes remain`, () => {
      const text = fs.readFileSync(path.join(CQ_ROOT, rel), "utf8");
      const matches = text.match(/purple-\d+/g) ?? [];
      expect(matches, `residual purple-* classes: ${matches.join(", ")}`).toEqual([]);
    });
  }

  it("the two app/games/** pages fall back to the identical oklch value inline (safe even if chess-quest.css hasn't loaded there yet)", () => {
    // These two pages render outside chess-quest's own dynamic-import chunk
    // (player-map.tsx loads chess-quest via next/dynamic({ ssr: false }), and
    // /games/page.tsx never reaches that chunk at all — registry.ts is pure
    // data, no component import) — see the wave's implementation notes. A
    // bare var(--cq-ink) with no fallback would render as unstyled the
    // instant chess-quest.css genuinely isn't on the page. Every var() must
    // carry a fallback, and it must be byte-identical to the token's own
    // value above, or the two silently drift apart later.
    for (const rel of PAGE_FILES) {
      const text = fs.readFileSync(path.join(CQ_ROOT, rel), "utf8");
      for (const [, token, value] of CHROME_TOKENS) {
        const used = text.includes(`var(${token},`);
        if (!used) continue; // not every token is used on every page
        const escaped = value.replace(/ /g, "_");
        expect(
          text,
          `${rel} references ${token} without the matching ${escaped} fallback`,
        ).toContain(`var(${token},${escaped})`);
      }
    }
  });

  it("no dark: Tailwind variant anywhere under src/games/chess-quest/** or the two games pages (Amendment 2 — no dark-mode infra exists yet)", () => {
    const files = [...walk(CQ_ROOT), ...PAGE_FILES.map((rel) => path.join(CQ_ROOT, rel))];
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      // Matches "dark:" only where it can start a class token (after a quote,
      // backtick or whitespace) — avoids false positives on --cq-dark /
      // .cq-dark / --cq-coord-on-dark, which are unrelated token/class names
      // that happen to end in the substring "dark".
      if (/["'`\s]dark:[a-z]/.test(text)) offenders.push(path.relative(CQ_ROOT, file));
    }
    expect(offenders, `dark: variant found in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("sanity: every occurrence of every shade is accounted for across the 14 files (regression tripwire, not a design constraint)", () => {
    // Not a spec requirement by itself — just proof this test suite would
    // have caught the pre-refactor state (88 occurrences across 57 lines,
    // per the wave's own scout pass) and will catch a partial revert.
    let total = 0;
    for (const rel of ALL_SCOPED_FILES) {
      const text = fs.readFileSync(path.join(CQ_ROOT, rel), "utf8");
      total += (text.match(/purple-\d+/g) ?? []).length;
    }
    expect(total).toBe(0);
  });
});
