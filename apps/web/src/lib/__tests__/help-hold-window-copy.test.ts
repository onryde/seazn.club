// Truth-in-copy guard for the SOFT-COMMIT HOLD WINDOW in the scoring help
// tree (ScoringPad v3, R8 sweep).
//
// WHY THIS EXISTS. `cricket.md` told scorers the undo window lasted "about six
// seconds" for as long as it took `HOLD_MS_DEFAULT` to move 6000 -> 12000
// (owner-ruled 2026-08-31, R6 W-4). Nothing pinned the prose to the constant,
// so the page went stale the moment the constant moved and stayed wrong
// through a green suite — a scorer reading it would believe an entry had
// hard-committed while it was still freely undoable.
//
// WHY IT FORBIDS A NUMBER RATHER THAN PINNING ONE. The obvious gate — assert
// the page says "twelve seconds" while HOLD_MS_DEFAULT is 12000 — is the wrong
// shape twice over. First, the window is environment-tunable
// (`NEXT_PUBLIC_SCOREPAD_HOLD_MS`, queue.ts), so NO single number is true of
// every build, and a gate reading the LIVE value would fail in exactly the e2e
// process that legitimately runs it short. Second, help copy is not the place
// to carry a chassis constant: the durable fix is prose that stays true at any
// window, which is the convention the rest of the per-sport pages already
// follow (they quote no duration at all).
//
// So the rule is: a scoring help page may describe the hold window's BEHAVIOUR
// ("while the entry is still held", "straight after a tap") but may never
// quote its DURATION.
//
// SCOPE is `content/help/scoring/` only, deliberately. Elsewhere in the tree a
// duration beside the word "undo" is legitimate and unrelated — e.g.
// `players/duplicates.md` says a merge undo "works as well next month as it
// does thirty seconds later", which is a claim about there being NO time
// limit. Widening this scan would red that true sentence.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. CI's unit job selects
// `src/server src/lib src/app` (.github/workflows/ci.yml); a scan parked
// outside those runs in no job at all and reports pending on a green exit 0.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { HOLD_MS_DEFAULT } from "@/components/v2/scorepad/queue";

const SCORING_DIR = join(process.cwd(), "content/help/scoring");

/** A quantity of seconds: "six seconds", "12 seconds", "~6s", "6 s".
 *  Requires a QUANTITY — bare "second" is the ordinal ("a second tap",
 *  "batted second", "fractional seconds") and must not match. */
const DURATION =
  /(?:\b\d+|\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty))[\s-]*seconds?\b|~\s*\d+\s*s\b|\b\d+\s*s\b/i;

/** The window's vocabulary — the prose this rule governs. */
const HOLD_VOCAB = /\bundo\b|\bhold\b|\bheld\b|\bsoft[- ]commit/i;

/** Split on sentence ends so a duration in one sentence cannot be blamed on
 *  the word "undo" in the next. */
function sentences(markdown: string): string[] {
  return markdown.split(/(?<=[.!?])\s+/);
}

function scoringPages(): { slug: string; markdown: string }[] {
  return readdirSync(SCORING_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      slug: `scoring/${f.replace(/\.md$/, "")}`,
      markdown: readFileSync(join(SCORING_DIR, f), "utf8"),
    }));
}

describe("scoring help copy ⇄ the soft-commit hold window", () => {
  it("scans the pages that actually exist (the scan is not vacuous)", () => {
    const pages = scoringPages();
    expect(pages.length).toBeGreaterThan(5);
    // The page this guard was written for must be among them.
    expect(pages.map((p) => p.slug)).toContain("scoring/cricket");
  });

  it("no scoring page quotes a duration for the undo/hold window", () => {
    const faults: string[] = [];

    for (const { slug, markdown } of scoringPages()) {
      for (const sentence of sentences(markdown)) {
        if (!HOLD_VOCAB.test(sentence)) continue;
        const hit = DURATION.exec(sentence);
        if (!hit) continue;
        faults.push(
          `${slug}: quotes "${hit[0].trim()}" for the hold window — ` +
            `the window is ${HOLD_MS_DEFAULT}ms by default and is ` +
            `environment-tunable, so no duration in prose stays true. ` +
            `Describe the behaviour instead ("while the entry is still held").` +
            `\n    ...${sentence.trim().slice(0, 160)}`,
        );
      }
    }

    expect(faults, faults.join("\n\n")).toEqual([]);
  });
});
