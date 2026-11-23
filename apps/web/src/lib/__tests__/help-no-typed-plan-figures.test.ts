// Plan figures in help come from the plan table (`{{plan:<feature>:<plan>}}`,
// server/help-tokens.ts), never typed. Two sweeps guard that:
//  1. a percentage or a currency amount on a line that also names a plan (Community, Event Pass,
//     Pro, Enterprise) or "platform fee";
//  2. a limit spelled out in words next to a plan name or "your plan": "three competitions",
//     "a fourth", "a second one", "twelve entrants". A count in words goes stale the same way a
//     typed figure does, and an example that hard-codes one (add four divisions, the fifth is
//     refused) is a typed limit in costume.
// Either goes stale on the next pricing change.
//
// There is no excuse list: every page is converted to tokens, and a page that types a plan
// figure fails the sweep, whatever page it is. (The KNOWN backlog that used to sit here was
// emptied and deleted when the billing / registration rewrites finished.)
//
// Anti-vacuity: the sweep reports the lines it scanned, the lines that carry a plan token beside
// a plan word (the lines a typed figure would have replaced), the lines naming a plan, and the
// lines carrying a spelled count; every one must be above zero, or the detector is looking at
// nothing. The detectors' own hit and clean cases, and a planted corpus run through the same
// sweep, prove they can still fire (the end state has zero typed figures, so only those cases
// can show it).
//
// WHAT THE DETECTORS DO NOT CATCH (line scans, not readers):
//  - figures written in words ("five percent", "twelve dollars");
//  - amounts spelled "12 dollars" or "USD 12" (only %, $, £, € are recognised);
//  - a count typed in digits next to a plan ("Community allows 3 competitions"): only the
//    spelled form is swept, because help also quotes product strings that carry a live count;
//  - a spelled count beside a noun this file does not list (LIMITED_NOUN), or two or more
//    sentences away from the plan name (the window is the sentence and the one after it);
//  - a table row whose plan name sits only in the HEADER row (the line scanned
//    names no plan), e.g. "| Platform | 5% |" under a "Community" column header;
//  - plan limits and caps on a line that names no plan ("3 AI credits a month",
//    "up to 10 divisions").
// It can also FALSE-HIT: the plan words are matched case-insensitively, so a lowercase "pro" that
// is not the plan ("pro-rata 50%") hits, and so does a capitalised "Pro" in a heading. If that
// ever happens, reword the page rather than loosen the rule. This guards the plan-price,
// platform-fee and plan-limit figures a pricing change moves, not every number in help.
//
// The last describe block is a different guard on the same seam: a `{{` in
// help that is not a valid plan token ships as raw text (and its page is
// prerendered, because only a well-formed token is detected), and front-matter
// title/description are never resolved at all.
import { describe, expect, it } from "vitest";
import { allHelpArticles } from "@/server/help-content";

const FIGURE = /\d+(?:\.\d+)?\s?%|[$£€]\s?\d/;
const PLAN_WORD = /\b(?:Community|Event Pass|Pro|Enterprise)\b|platform fee/i;

/** Lines that type a plan figure: a % or a currency amount beside a plan name or "platform fee". */
function typedPlanFigureLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  markdown.split("\n").forEach((text, i) => {
    if (FIGURE.test(text) && PLAN_WORD.test(text)) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

// A limit in words. Cardinals only count beside a noun a plan limits (so "three bills" and "all
// three" stay clean); ordinals count after an article ("a fourth", "the third"); "a second" counts
// before "one" or a limited noun ("refuses a second one"), never as "A second limit covers...".
const COUNT_WORD = "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const ORDINAL_WORD = "third|fourth|fifth|sixth|seventh|eighth|ninth|tenth";
const LIMITED_NOUN =
  "competitions?|divisions?|entrants?|organi[sz]ations?|teams?|players?|streams?|credits?|matches|dashboards?|members?|clubs?|seats?";
const SPELLED_COUNT = new RegExp(
  `\\b(?:(?:${COUNT_WORD})\\s+(?:${LIMITED_NOUN})|(?:a|an|the)\\s+(?:${ORDINAL_WORD})|a second (?:one|${LIMITED_NOUN}))\\b`,
  "i",
);
/** A plan named, or "your plan": the context in which a spelled count is a plan limit. */
const PLAN_CONTEXT = /\b(?:Community|Event Pass|Pro|Enterprise)\b|platform fee|\b(?:your|the|a) plans?\b/i;

/** A table row is one unit; prose is split into sentences. */
function unitsOf(line: string): string[] {
  return line.trimStart().startsWith("|") ? [line] : line.split(/(?<=[.!?])\s+/);
}

/**
 * Lines that spell a limit in words in the same sentence as a plan name, or in the sentence right
 * after it ("...on a Community plan. You start a third competition."). A line is one paragraph, one
 * table row or one list item.
 */
function spelledPlanCountLines(markdown: string): { line: number; text: string; count: string }[] {
  const out: { line: number; text: string; count: string }[] = [];
  markdown.split("\n").forEach((text, i) => {
    const units = unitsOf(text);
    for (let k = 0; k < units.length; k += 1) {
      const window = units.slice(k, k + 2).join(" ");
      const count = SPELLED_COUNT.exec(window);
      if (count && PLAN_CONTEXT.test(window)) {
        out.push({ line: i + 1, text: text.trim(), count: count[0] });
        return;
      }
    }
  });
  return out;
}

interface Sweep {
  problems: string[];
  linesScanned: number;
  /** Lines with a `{{plan:` token and a plan word: where a typed figure would have stood. */
  tokenPlanLines: number;
  /** Lines naming a plan (PLAN_CONTEXT): the half of the spelled-count test that needs a plan. */
  planContextLines: number;
  /** Lines carrying a spelled count whatever they sit beside: the other half. */
  spelledLines: number;
}

/** Both sweeps over a set of pages, with the counts that say it looked at something. */
function sweepPlanFigures(pages: readonly { slug: string; markdown: string }[]): Sweep {
  const sweep: Sweep = { problems: [], linesScanned: 0, tokenPlanLines: 0, planContextLines: 0, spelledLines: 0 };
  for (const page of pages) {
    for (const line of page.markdown.split("\n")) {
      if (line.trim() === "") continue;
      sweep.linesScanned += 1;
      if (line.includes("{{plan:") && PLAN_WORD.test(line)) sweep.tokenPlanLines += 1;
      if (PLAN_CONTEXT.test(line)) sweep.planContextLines += 1;
      if (SPELLED_COUNT.test(line)) sweep.spelledLines += 1;
    }
    const typed = typedPlanFigureLines(page.markdown);
    if (typed.length > 0) {
      sweep.problems.push(`TYPED FIGURE  ${page.slug}: ${typed.slice(0, 3).map((h) => `L${h.line} '${h.text.slice(0, 70)}'`).join("; ")}`);
    }
    const spelled = spelledPlanCountLines(page.markdown);
    if (spelled.length > 0) {
      sweep.problems.push(
        `SPELLED COUNT  ${page.slug}: ${spelled.slice(0, 3).map((h) => `L${h.line} '${h.count}' in '${h.text.slice(0, 70)}'`).join("; ")}`,
      );
    }
  }
  return sweep;
}

describe("typedPlanFigureLines: hand-written cases", () => {
  const HIT = [
    "| Community | 5% |",
    "Event Pass — $11.99 one-time",
    "a 3% platform fee on entry fees",
    "The Platform Fee is 2.5% here.",
    "Pro is £14.99 a month.",
    "That costs €12 on Event Pass.",
    "| Enterprise | 2.5% |",
    "Enterprise pays 2% on entry fees.",
    "Community pays 5% and {{plan:registration.fee_percent:pro}}% on Pro.", // a token beside a typed figure still hits
  ];
  const CLEAN = [
    "| Community | {{plan:registration.fee_percent:community}} |",
    "| Enterprise | {{plan:registration.fee_percent:enterprise}}% |",
    "Fee: {{plan:registration.fee_percent:pro}}%",
    "Add your 64 entrants and share the link.",
    "A 5% swing in the vote.", // a figure, but no plan named
    "The Pro Series trophy.", // "Pro" alone, no figure
    "Provider fees are 3%.", // 'Pro' only as a prefix of another word
    "Community days are free.",
    "Enterprise customers get a contact.", // Enterprise alone, no figure
    "",
  ];
  it("flags every hit case and none of the clean cases", () => {
    expect(HIT.length, "anti-vacuity: positive cases exist").toBeGreaterThan(0);
    expect(CLEAN.length, "anti-vacuity: negative cases exist").toBeGreaterThan(0);
    for (const text of HIT) expect(typedPlanFigureLines(text), `should flag: ${text}`).toHaveLength(1);
    for (const text of CLEAN) expect(typedPlanFigureLines(text), `should not flag: ${text}`).toEqual([]);
  });
  it("reports the 1-based line number", () => {
    expect(typedPlanFigureLines("ok\n\n| Pro | 2% |")).toEqual([{ line: 3, text: "| Pro | 2% |" }]);
  });
});

describe("spelledPlanCountLines: hand-written cases", () => {
  const HIT = [
    "On Community you create three competitions, all drafts.",
    "A fourth is refused on Community.",
    "On Pro you can add five divisions to one competition.",
    "Community covers two organisations.",
    "On Community the public slot is taken. You start a third competition.", // the sentence after the plan name
    "On Community, the page refuses a second one.",
    "An Event Pass lifts the limit to twelve entrants.",
    "Enterprise allows eight teams.",
    "Your plan covers four dashboards.",
    "| Community | up to six players |",
    "> You build a fifth division. Your plan has no room.", // the count BEFORE the plan sentence
  ];
  const CLEAN = [
    "On Community you create competitions until the form says the limit is reached.",
    "A second limit covers Public competitions on Community.", // "a second" is not a count before "limit"
    "Community has a seven-step tour.", // a count with no limited noun after it
    "Three bills to choose from, one on Pro.", // "bills" is not a limited noun
    "Four divisions play on one court.", // a count, no plan named
    "Community is free. It has no card. Four divisions play on one court.", // three sentences away from the plan
    "The third round starts at nine.", // an ordinal, no plan named
    "On Community the limit is {{plan:competitions.max_active:community}}.", // a token, no spelled count
    "On Community you may add 3 divisions.", // digits are not swept here (see the header)
    "",
  ];
  it("flags every hit case and none of the clean cases", () => {
    expect(HIT.length, "anti-vacuity: positive cases exist").toBeGreaterThan(0);
    expect(CLEAN.length, "anti-vacuity: negative cases exist").toBeGreaterThan(0);
    for (const text of HIT) expect(spelledPlanCountLines(text), `should flag: ${text}`).toHaveLength(1);
    for (const text of CLEAN) expect(spelledPlanCountLines(text), `should not flag: ${text}`).toEqual([]);
  });
  it("reports the 1-based line number and the word that counted", () => {
    expect(spelledPlanCountLines("ok\n\nOn Community you add four divisions.")).toEqual([
      { line: 3, text: "On Community you add four divisions.", count: "four divisions" },
    ]);
  });
});

describe("sweepPlanFigures: a planted corpus", () => {
  it("reports each planted defect once and counts what it scanned", () => {
    const planted = [
      { slug: "planted/typed", markdown: "intro\n| Enterprise | 2.5% |\nclean" },
      { slug: "planted/spelled", markdown: "intro\nOn Community you create three competitions.\nclean" },
      { slug: "planted/clean", markdown: "intro\nFee {{plan:registration.fee_percent:pro}}% on Pro.\nTwo teams play." },
    ];
    const sweep = sweepPlanFigures(planted);
    expect(sweep.problems).toHaveLength(2);
    expect(sweep.problems.join("\n")).toContain("TYPED FIGURE  planted/typed");
    expect(sweep.problems.join("\n")).toContain("SPELLED COUNT  planted/spelled");
    expect(sweep.linesScanned).toBe(9);
    expect(sweep.tokenPlanLines).toBe(1);
    expect(sweep.spelledLines).toBe(2); // "three competitions" and "Two teams", whatever they sit beside
  });
  it("is clean on a corpus with no defect", () => {
    expect(sweepPlanFigures([{ slug: "planted/ok", markdown: "Fee {{plan:registration.fee_percent:pro}}% on Pro." }]).problems).toEqual([]);
  });
});

describe("help articles type no plan figures", () => {
  it("sweeps every Markdown article; no page types a plan figure or spells a plan limit", () => {
    const articles = allHelpArticles();
    const sweep = sweepPlanFigures([...articles.values()].map((a) => ({ slug: a.slug, markdown: a.markdown })));
    console.log(
      `help-no-typed-plan-figures: articles scanned=${articles.size}, lines scanned=${sweep.linesScanned}, ` +
        `token-plan lines=${sweep.tokenPlanLines}, plan-context lines=${sweep.planContextLines}, ` +
        `spelled-count lines=${sweep.spelledLines}, problems=${sweep.problems.length}`,
    );

    expect(articles.size, "anti-vacuity: articles scanned").toBeGreaterThan(0);
    expect(sweep.linesScanned, "anti-vacuity: lines scanned").toBeGreaterThan(0);
    expect(sweep.tokenPlanLines, "anti-vacuity: lines where a plan token stands beside a plan word").toBeGreaterThan(0);
    expect(sweep.planContextLines, "anti-vacuity: lines that name a plan").toBeGreaterThan(0);
    expect(sweep.spelledLines, "anti-vacuity: lines that spell a count").toBeGreaterThan(0);
    expect(sweep.problems, `\n${sweep.problems.join("\n")}\n`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stray `{{`: only a valid `{{plan:<feature>:<plan>}}` token may contain one.
// ---------------------------------------------------------------------------
// The grammar is written out here (from the token spec), not imported from the code under test.
const VALID_TOKEN = /\{\{plan:[A-Za-z0-9_.-]+:[A-Za-z0-9_]+\}\}/g;

/** Every `{{` left once valid tokens are removed, with a little context. */
function strayBraces(text: string): string[] {
  const rest = text.replace(VALID_TOKEN, "");
  const out: string[] = [];
  for (let i = rest.indexOf("{{"); i !== -1; i = rest.indexOf("{{", i + 2)) out.push(rest.slice(i, i + 40));
  return out;
}

describe("strayBraces: hand-written cases", () => {
  it("flags malformed tokens and ignores valid ones", () => {
    const BAD = [
      "x {{Plan:registration.fee_percent:pro}} y",
      "x {{ plan:registration.fee_percent:pro}} y",
      "x {{PLAN:registration.fee_percent:pro}} y",
      "x {{plan:registration.fee_percent}} y",
      "x {{plan:}} y",
      "Fee {{plan:registration.fee_percent:pro}} and {{oops}}",
    ];
    const OK = [
      "",
      "No braces at all.",
      "Fee {{plan:registration.fee_percent:pro}}% and {{plan:registration.fee_percent:community}}%.",
      "A single { brace } is fine.",
    ];
    expect(BAD.length, "anti-vacuity: positive cases exist").toBeGreaterThan(0);
    expect(OK.length, "anti-vacuity: negative cases exist").toBeGreaterThan(0);
    for (const t of BAD) expect(strayBraces(t), `should flag: ${t}`).not.toEqual([]);
    for (const t of OK) expect(strayBraces(t), `should not flag: ${t}`).toEqual([]);
  });
  it("front matter allows no `{{` at all, even a valid token (it is never resolved)", () => {
    const frontMatterHit = (text: string) => text.includes("{{");
    expect(frontMatterHit("Fees of {{plan:registration.fee_percent:pro}}%")).toBe(true);
    expect(frontMatterHit("{{Plan:x}}")).toBe(true);
    expect(frontMatterHit("Plain description of the plans.")).toBe(false);
  });
});

/**
 * A literal `{{...}}` that help documents ON PURPOSE (shown as inline code, never a plan token).
 * Each entry must still suppress at least one real hit, or it is a stale excuse.
 */
const STRAY_ALLOW: { page: string; text: string; reason: string }[] = [
  {
    page: "registration/open-registration",
    text: "{{reference}}",
    reason: "the offline-payment instructions placeholder the organiser types; the article explains it as inline code",
  },
];

describe("help articles carry no stray `{{` and no `{{` in front matter", () => {
  it("sweeps every article body, title and description", () => {
    const articles = allHelpArticles();
    const problems: string[] = [];
    const allowUsed = new Map<number, number>();
    for (const a of articles.values()) {
      for (const s of strayBraces(a.markdown)) {
        const i = STRAY_ALLOW.findIndex((e) => e.page === a.slug && s.startsWith(e.text));
        if (i !== -1) {
          allowUsed.set(i, (allowUsed.get(i) ?? 0) + 1);
          continue;
        }
        problems.push(`STRAY {{  ${a.slug} body: '${s}'`);
      }
      if (a.title.includes("{{")) problems.push(`TOKEN IN FRONT MATTER  ${a.slug} title: '${a.title}'`);
      if (a.description.includes("{{")) problems.push(`TOKEN IN FRONT MATTER  ${a.slug} description: '${a.description}'`);
    }
    STRAY_ALLOW.forEach((e, i) => {
      if (!allowUsed.get(i)) problems.push(`STALE ALLOW  ${e.page} '${e.text}' suppressed nothing (remove it)`);
      if (e.reason.length <= 10) problems.push(`ALLOW without a reason  ${e.page}`);
    });
    console.log(
      `help-no-typed-plan-figures: stray-brace sweep articles scanned=${articles.size}, ` +
        `allowed literals=${[...allowUsed.values()].reduce((n, v) => n + v, 0)}, problems=${problems.length}`,
    );
    expect(articles.size, "anti-vacuity: articles scanned").toBeGreaterThan(0);
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
});
