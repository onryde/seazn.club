// Truth-in-copy guard for DURATIONS IN SECONDS in the scoring help tree
// (ScoringPad v3, R8 sweep).
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
// WHY THE RULE IS NOW "NO DURATION AT ALL" RATHER THAN "NO DURATION NEXT TO
// THE WORD UNDO". R8 review finding. The first version of this file required a
// hold-window word (undo / hold / held / soft-commit) in the SAME SENTENCE as
// the duration, and a gate built on a vocabulary is only ever as good as the
// list — so the originating defect came straight back in any phrasing nobody
// had thought to enumerate:
//
//     "You have about six seconds to change your mind."
//     "Tap again within 12 seconds to correct it."
//     "The entry stays editable for about six seconds."
//
// all passed. That set cannot be closed by adding words: it is every way
// English has of saying "you can still change this", and each new term drags
// in false positives of its own (adding `correct` reds icehockey.md's true
// sentence about **Correct the clock**). So the vocabulary is gone. A scoring
// page may describe the window's BEHAVIOUR ("while the entry is still held",
// "straight after a tap") and may not put a quantity of seconds on any page in
// this directory, whatever the sentence is about.
//
// The cost of inverting is that legitimately-true durations now need naming.
// There are exactly two in the tree and both are on `ALLOWED` below, with the
// rule or control each one describes. That is the point of the shape: the
// allowlist is short, reviewed, and a NEW duration cannot enter the tree
// without someone writing down why — where the vocabulary gate let one in
// silently. `HOLD_MS_DEFAULT` guards the allowlist itself (see the last two
// tests), which is the coupling to the constant this file previously only
// implied: before R8 the import reached the failure STRING and nothing else,
// so the constant could move without moving a single assertion.
//
// SCOPE is `content/help/scoring/` only, deliberately. Elsewhere in the tree a
// duration beside the word "undo" is legitimate and unrelated — e.g.
// `players/duplicates.md` says a merge undo "works as well next month as it
// does thirty seconds later", which is a claim about there being NO time
// limit. Widening this scan would red that true sentence.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`. The unit job runs the whole
// apps/web suite sharded four ways, and the smoke-db job additionally selects
// `src/server src/lib` (.github/workflows/ci.yml), so a scan parked here runs
// in both. (The comment here previously said the unit job SELECTS
// `src/server src/lib src/app`; it selects nothing — that path list belongs to
// smoke-db. The conclusion held, the reason did not.)
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { HOLD_MS_DEFAULT } from "@/components/v2/scorepad/queue";

const SCORING_DIR = join(process.cwd(), "content/help/scoring");

/** A quantity of seconds: "six seconds", "12 seconds", "~6s", "6 s".
 *
 *  Requires a QUANTITY. Bare "second" is the ordinal ("a second tap", "batted
 *  second", "fractional seconds") and must not match — and until R8 this
 *  regex did not honour its own docstring: `a` was in the word alternation, so
 *  "a second card", "a second yellow", "a second invite" and three more all
 *  matched. Under the old sentence-scoped rule that was invisible (none of the
 *  six sits near hold vocabulary); under the tree-wide rule below every one of
 *  them would have been a false red, and the obvious repair would have been to
 *  weaken the gate. `one second` still matches; `a second` no longer does. */
const DURATION =
  /(?:\b\d+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty))[\s-]*seconds?\b|~\s*\d+\s*s\b|\b\d+\s*s\b/i;

/** Split on sentence ends, so a fault names the sentence a reader would have
 *  read rather than a whole page. */
function sentences(markdown: string): string[] {
  return markdown.split(/(?<=[.!?])\s+/);
}

/**
 * The sentences in this tree that legitimately quote a duration in seconds.
 *
 * Each is a fixed fact about a SPORT or about a different CONTROL — never
 * about how long an entry stays changeable — and each is verified against the
 * thing it describes, not against another document:
 *
 *   - ice hockey's fine clock nudge is `CLOCK_NUDGE_FINE_SECONDS` beside the
 *     coarse `CLOCK_NUDGE_SECONDS = 60` (`v3/clock.ts`), i.e. literally "a
 *     minute or ten seconds";
 *   - badminton's interval at 11 is a rule of the sport, on the page about it.
 *
 * A row here is a decision someone has to make and write down. Adding one is
 * the whole cost of this gate, and the two tests after the scan make sure the
 * list cannot rot: a row that matches nothing is dead, and a row that quotes
 * the hold window's own duration defeats the file's purpose.
 */
const ALLOWED: readonly { slug: string; fragment: string; why: string }[] = [
  {
    slug: "scoring/icehockey",
    fragment: "nudges it by a minute or ten seconds",
    why: "the two steps **Correct the clock** moves the MATCH clock by (v3/clock.ts) — a different control, and a fixed one",
  },
  {
    slug: "scoring/badminton",
    fragment: "60-second break",
    why: "BWF's interval at 11 — a rule of the sport, nothing to do with the pad's soft commit",
  },
];

function scoringPages(): { slug: string; markdown: string }[] {
  return readdirSync(SCORING_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      slug: `scoring/${f.replace(/\.md$/, "")}`,
      markdown: readFileSync(join(SCORING_DIR, f), "utf8"),
    }));
}

/** Whether an allowlist row covers this sentence on this page. */
function allowedFor(slug: string, sentence: string): boolean {
  return ALLOWED.some((row) => row.slug === slug && sentence.includes(row.fragment));
}

const SECOND_WORDS: Readonly<Record<number, string>> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven",
  8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 15: "fifteen",
  20: "twenty", 30: "thirty", 60: "sixty",
};

/** The shipped window, written every way prose could write it — seconds as a
 *  numeral or an English word, and the raw millisecond figure with or without
 *  a thousands separator. Derived from the constant, so it MOVES with it: this
 *  is the coupling the old file's `HOLD_MS_DEFAULT` import only implied. */
function holdWindowSpellings(): RegExp[] {
  const secs = HOLD_MS_DEFAULT / 1000;
  const out = [new RegExp(`\\b${HOLD_MS_DEFAULT}\\s*(?:ms\\b|milliseconds?\\b)`, "i")];
  if (Number.isInteger(secs)) {
    out.push(new RegExp(`\\b${secs}\\s*(?:s\\b|secs?\\b|seconds?\\b)`, "i"));
    const word = SECOND_WORDS[secs];
    if (word !== undefined) out.push(new RegExp(`\\b${word}\\s+seconds?\\b`, "i"));
  }
  return out;
}

describe("scoring help copy ⇄ the soft-commit hold window", () => {
  it("scans the pages that actually exist (the scan is not vacuous)", () => {
    const pages = scoringPages();
    expect(pages.length).toBeGreaterThan(5);
    // The page this guard was written for must be among them.
    expect(pages.map((p) => p.slug)).toContain("scoring/cricket");
  });

  it("reads quantities of seconds, not ordinals", () => {
    // Pins DURATION's own docstring, because the regex broke that contract
    // once already and the failure was silent. Positives are the shapes the
    // originating cricket defect and its evasions used; negatives are the six
    // real sentences in this tree that a bare-ordinal probe false-reds.
    for (const yes of ["about six seconds", "within 12 seconds", "~6s", "for 8 s", "one second"]) {
      expect(DURATION.test(yes), `DURATION should match "${yes}"`).toBe(true);
    }
    for (const no of ["a second card", "a second yellow", "batted second", "a second invite"]) {
      expect(DURATION.test(no), `DURATION should NOT match the ordinal "${no}"`).toBe(false);
    }
  });

  it("no scoring page quotes a duration in seconds", () => {
    const faults: string[] = [];

    for (const { slug, markdown } of scoringPages()) {
      for (const sentence of sentences(markdown)) {
        const hit = DURATION.exec(sentence);
        if (!hit) continue;
        if (allowedFor(slug, sentence)) continue;
        faults.push(
          `${slug}: quotes "${hit[0].trim()}". No page under content/help/scoring/ may put a ` +
            `quantity of seconds in prose: the soft-commit window is ${HOLD_MS_DEFAULT}ms by ` +
            `default and environment-tunable, so a duration a reader takes for it cannot stay ` +
            `true — and this rule is deliberately not scoped to sentences that mention undoing, ` +
            `because "change your mind" / "correct it" / "still editable" all describe the same ` +
            `window. Describe the behaviour instead ("while the entry is still held"), or add ` +
            `the sentence to ALLOWED with the rule or control it describes.` +
            `\n    ...${sentence.trim().slice(0, 160)}`,
        );
      }
    }

    expect(faults, faults.join("\n\n")).toEqual([]);
  });

  it("every allowlist row still matches a real sentence", () => {
    // A row whose sentence has been reworded stops excusing anything and stops
    // being reviewed — it is a dead line that reads like live coverage. Worse,
    // the next author copies it as the template for a new exemption.
    const pages = new Map(scoringPages().map((p) => [p.slug, p.markdown]));
    const dead = ALLOWED.filter((row) => {
      const markdown = pages.get(row.slug);
      return markdown === undefined || !sentences(markdown).some((s) => s.includes(row.fragment));
    });
    expect(
      dead.map((row) => `${row.slug}: "${row.fragment}"`),
      "allowlist rows that no longer match any sentence — delete them or fix the fragment",
    ).toEqual([]);
  });

  it("no allowlisted sentence quotes the hold window's own duration", () => {
    // The allowlist is the ONE way a duration can still reach this tree, so it
    // is where the constant has to bite. If the window is 12000ms, a row
    // excusing "twelve seconds" / "12 s" / "12000ms" would reintroduce exactly
    // the defect this file exists for, wearing an exemption. Derived from
    // HOLD_MS_DEFAULT, so changing the constant changes what this forbids.
    const spellings = holdWindowSpellings();
    const pages = new Map(scoringPages().map((p) => [p.slug, p.markdown]));
    const faults: string[] = [];
    for (const row of ALLOWED) {
      for (const sentence of sentences(pages.get(row.slug) ?? "")) {
        if (!sentence.includes(row.fragment)) continue;
        const hit = spellings.find((re) => re.test(sentence));
        if (hit === undefined) continue;
        faults.push(
          `${row.slug}: an allowlisted sentence quotes the hold window itself ` +
            `(${HOLD_MS_DEFAULT}ms) — exemption reason was "${row.why}"\n    ...${sentence.trim().slice(0, 160)}`,
        );
      }
    }
    expect(faults, faults.join("\n\n")).toEqual([]);
  });

  it("the hold window's default duration appears nowhere in the tree, in any unit", () => {
    // Belt to the scan's braces: DURATION reads seconds only, so "12000ms" or
    // "12,000 milliseconds" would walk straight past it. This one is written
    // from the constant in every unit prose could use.
    const spellings = holdWindowSpellings();
    const faults: string[] = [];
    for (const { slug, markdown } of scoringPages()) {
      for (const re of spellings) {
        const hit = re.exec(markdown);
        if (hit) faults.push(`${slug}: quotes the hold window as "${hit[0].trim()}"`);
      }
    }
    expect(
      faults,
      `${faults.join("\n")}\n\nThe window is ${HOLD_MS_DEFAULT}ms by default and ` +
        `environment-tunable — help copy must describe the behaviour, never the number.`,
    ).toEqual([]);
  });
});
