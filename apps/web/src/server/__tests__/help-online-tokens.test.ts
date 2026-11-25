// Online Chess figures in help: `{{online:...}}` renders the price leaf's own numbers (lib/online-chess-package.ts) instead of
// having them typed into Markdown (spec 2026-11-23-online-chess-credits-design.md §15 "the help price table"; plan Task 13 carry (3)).
// The leaf is import-free and needs no database, so these tokens resolve with no plan table, anywhere help renders.
//
// Grammar: `{{online:largest}}`, `{{online:smallest}}` and `{{online:row:<1..5>:<size|price|cameras|rounds>}}` (a row of the ladder,
// counted from 1, as the table prints it). A token that is not exactly one of those THROWS naming it: a help page showing a hole
// where a price belongs is worse than a failed render.
//
// Expected values are the SPEC's, typed here (decision 5's table and P1's round rule), never read back from the leaf:
//   size   16  32  64  128  256
//   price   1   2   4    8   16   (credits, without the Fair-play camera)
//   camera  2   4   8   16   32
//   rounds  6   7   8    9   10   (log2(size) + 2)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ONLINE_SIZES } from "@/lib/online-chess-package";
import { allHelpArticles, helpPlainText, renderHelpMarkdown } from "@/server/help-content";
import { resolveOnlineTokens } from "@/server/help-tokens";
import en from "@/dictionaries/en/ui.json";

const SPEC = {
  size: [16, 32, 64, 128, 256],
  price: [1, 2, 4, 8, 16],
  cameras: [2, 4, 8, 16, 32],
  rounds: [6, 7, 8, 9, 10],
} as const;
const FIELDS = ["size", "price", "cameras", "rounds"] as const;

describe("resolveOnlineTokens: the ladder, row by row", () => {
  it("every row and field is the spec's figure (anti-vacuity: 20 cells)", () => {
    let cells = 0;
    for (let row = 1; row <= 5; row += 1) {
      for (const field of FIELDS) {
        expect(resolveOnlineTokens(`{{online:row:${row}:${field}}}`), `row ${row} ${field}`).toBe(String(SPEC[field][row - 1]));
        cells += 1;
      }
    }
    expect(cells).toBe(20);
  });

  it("the ladder has the spec's five rows: the leaf and the spec agree on its length, so the help table cannot silently lose or gain one", () => {
    expect([...ONLINE_SIZES]).toEqual([...SPEC.size]);
  });

  it("largest and smallest", () => {
    expect(resolveOnlineTokens("up to {{online:largest}} players; from {{online:smallest}}")).toBe("up to 256 players; from 16");
  });

  it("renders several tokens in one text, and the same token twice, and leaves plain text alone", () => {
    expect(resolveOnlineTokens("| {{online:row:2:size}} | {{online:row:2:price}} | {{online:row:2:price}} |")).toBe("| 32 | 2 | 2 |");
    expect(resolveOnlineTokens("No tokens {here}.")).toBe("No tokens {here}.");
  });

  it("the camera price is double the plain price on every row (the help says the camera doubles it)", () => {
    for (let row = 1; row <= 5; row += 1) {
      expect(Number(resolveOnlineTokens(`{{online:row:${row}:cameras}}`)), `row ${row}`).toBe(2 * Number(resolveOnlineTokens(`{{online:row:${row}:price}}`)));
    }
  });
});

describe("resolveOnlineTokens: a near miss throws, naming the token", () => {
  const BAD = [
    "{{online:row:0:size}}",
    "{{online:row:6:size}}",
    "{{online:row:1:colour}}",
    "{{online:row:1}}",
    "{{online:row:x:size}}",
    "{{online:}}",
    "{{online:biggest}}",
    "{{ online:largest}}",
    "{{online:Largest}}",
    "x {{online:row:1:size} y",
  ];
  it.each(BAD)("%s", (text) => {
    expect(() => resolveOnlineTokens(text)).toThrow(/online/);
  });
  it("(the cases are real: there are some, and each one is something a writer might type)", () => {
    expect(BAD.length).toBeGreaterThan(8);
  });
});

describe("the chess help page's Online Chess section", () => {
  const article = allHelpArticles().get("sports/chess")!;
  const HEADING = "## Online Chess: sizes and credits";
  const section = (() => {
    const start = article.markdown.indexOf(HEADING);
    if (start === -1) return "";
    const next = article.markdown.indexOf("\n## ", start + HEADING.length);
    return article.markdown.slice(start, next === -1 ? undefined : next);
  })();

  it("the section exists (a missing section would let every check below pass on an empty string)", () => {
    expect(section.length, "the section's text").toBeGreaterThan(500);
  });

  it("types no number: every figure in the section is a token (or 'round 1')", () => {
    const stripped = section.replace(/\{\{online:[^}]*\}\}/g, "").replace(/\bround 1\b/gi, "").replace(/\bRound 1\b/g, "");
    const lines = section.split("\n").filter((l) => l.trim() !== "");
    const tokens = section.match(/\{\{online:[^}]*\}\}/g) ?? [];
    const typed = stripped.split("\n").filter((l) => /\d/.test(l));
    expect(lines.length, "anti-vacuity: lines scanned").toBeGreaterThan(10);
    expect(tokens.length, "anti-vacuity: tokens in the section (a 5-row, 4-column table at least)").toBeGreaterThanOrEqual(20);
    expect(typed, "lines that type a digit").toEqual([]);
  });

  it("the price table has one row per size of the ladder, every cell from the leaf", async () => {
    const html = await renderHelpMarkdown(article.markdown);
    expect(html, "no token survives rendering").not.toMatch(/\{\{/);
    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((m) => [...m[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]!.replace(/<[^>]+>/g, "").trim()))
      .filter((cells) => cells.length === 4 && /^\d+$/.test(cells[0]!));
    expect(rows, "the table's data rows").toHaveLength(SPEC.size.length);
    rows.forEach((cells, i) => {
      expect(cells, `row ${i + 1}`).toEqual([SPEC.size[i], SPEC.rounds[i], SPEC.price[i], SPEC.cameras[i]].map(String));
    });
  });

  it("says the things an organiser has to know: Swiss and knockout only, change until round 1, what a refund returns, nothing for players", () => {
    const text = helpPlainText(section);
    for (const phrase of [
      /Swiss and knockout/,
      /before round 1/i,
      /refund/i,
      /league|group/i,
      /Seazn credits/,
      /Fair.play camera/, // helpPlainText turns a hyphen into a space
      /Players, up to/,
    ]) expect(text, String(phrase)).toMatch(phrase);
    expect(section, "no 'External Play' to an organiser").not.toMatch(/external[ -]play/i);
  });

  it("every bold label in the section is a string the product shows (the English dictionary's, placeholders as wildcards)", () => {
    const values = Object.values(en as Record<string, string>).filter((v) => typeof v === "string");
    // A label is a whole string, or the start of one (a quoted line that leaves out its figures: "Online Chess not paid." begins the amber
    // line "Online Chess not paid. {held} registered, ..."). Never a fragment from the middle of a string.
    const shown = (label: string): boolean => values.some((v) => {
      if (v === label || v.startsWith(`${label} `) || v.startsWith(`${label}: `) || v.startsWith(`${label}.`)) return true;
      if (!v.includes("{")) return false;
      // A string that is all placeholders ("{label}") would match any label: only strings with real words of their own count.
      if (v.replace(/\{\w+\}/g, "").trim().length < 8) return false;
      const re = new RegExp(`^${v.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+")}$`);
      return re.test(label);
    });
    const labels = [...section.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!).filter((l) => !/^(Example|Note)\b/.test(l));
    expect(labels.length, "anti-vacuity: bold labels checked").toBeGreaterThanOrEqual(5);
    const unknown = labels.filter((l) => !shown(l.replace(/[.,;:]$/, "")));
    expect(unknown, "bold text that is not on any screen").toEqual([]);
  });
});

describe("the Seazn credits page (billing/match-credits.md) says Online Chess spends them too", () => {
  const text = readFileSync(join(__dirname, "..", "..", "..", "content", "help", "billing", "match-credits.md"), "utf8");
  it("names Online Chess, links to the chess page, and no longer says credits are only for streaming", () => {
    expect(text).toMatch(/Online Chess/);
    expect(text).toMatch(/\]\(\/help\/sports\/chess/);
    expect(text, "the title is the Seazn credits page, not 'for streaming'").not.toMatch(/^title:.*for streaming/m);
    expect(text, "the credits history rows an organiser will see").toMatch(/Online Chess: /);
    expect(text, "it has its own section for Online Chess").toMatch(/^## Online Chess/m);
    expect(text, "and says it is one balance for streams and chess").toMatch(/one balance/);
  });
});
