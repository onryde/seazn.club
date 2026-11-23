// The blog's leak guard: P1's findLeaks plus `code-identifier`. Cases are hand-written both ways, every
// allow-list entry must be hit by a real case (a stale entry hides the next leak), and the valid fixture
// posts are swept (anti-vacuity: posts and characters scanned, zero fails).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import { BLOG_LEAK_ALLOW, blogLeakText, findBlogLeaks, withoutDiagramKind } from "@/blog/leaks";
import { helpPlainText } from "@/server/help-content";

const rulesOf = (text: string) => findBlogLeaks(text).map((l) => l.rule);

describe("findBlogLeaks: hand-written cases", () => {
  const FLAGGED: [string, string, string][] = [
    ["h2h_reapply", "code-identifier", "h2h_reapply"],
    ["buchholz_cut1 breaks it", "code-identifier", "buchholz_cut1"],
    ["FEWEST_PLAYED goes last", "code-identifier", "FEWEST_PLAYED"],
    ["set topNPerGroup to 2", "code-identifier", "topNPerGroup"],
    ["Ana finishes on anaPoints", "code-identifier", "anaPoints"],
    ["h2hReapply is a tie-break", "code-identifier", "h2hReapply"],
    ["pick top2Teams", "code-identifier", "top2Teams"],
    ["the engine decides", "developer-word", "engine"],
    ["a PR #123 landed", "pr-number", "PR #123"],
  ];
  const CLEAN = [
    "head-to-head",
    "T20",
    "Buchholz Cut-1",
    "Sonneborn-Berger",
    "The _second_ round is *paired* by score.",
    "YouTube and PayPal are brand names.",
    "A 3-2 win, a 6-4 6-3 win, and a 25-23 set.",
    "match 3 of round 2",
    "Round-robin and double-elimination.",
    "",
  ];
  it("flags every flagged case with the named rule and token", () => {
    expect(FLAGGED.length, "anti-vacuity: flagged cases").toBeGreaterThan(0);
    for (const [text, rule, match] of FLAGGED) {
      const leaks = findBlogLeaks(text);
      expect(leaks.map((l) => [l.rule, l.match]), text).toContainEqual([rule, match]);
    }
  });
  it("passes every clean case", () => {
    expect(CLEAN.length, "anti-vacuity: clean cases").toBeGreaterThan(0);
    for (const text of CLEAN) expect(findBlogLeaks(text), `should not flag: ${text}`).toEqual([]);
  });
  it("reports the index of a hit, and a mixed text lists P1's rule and the blog's in order", () => {
    const text = "the engine prints h2h_reapply";
    expect(findBlogLeaks(text)).toEqual([
      { rule: "developer-word", match: "engine", index: 4 },
      { rule: "code-identifier", match: "h2h_reapply", index: 18 },
    ]);
  });
  it("an identifier before a developer word is listed first (the result is in text order)", () => {
    expect(findBlogLeaks("h2h_reapply uses the engine")).toEqual([
      { rule: "code-identifier", match: "h2h_reapply", index: 0 },
      { rule: "developer-word", match: "engine", index: 21 },
    ]);
  });
  it("P1's allow-list still applies (T20 is not a task id)", () => {
    expect(rulesOf("a T20 match")).toEqual([]);
    expect(rulesOf("a T2 match")).toEqual(["wave-id"]);
  });
  it("helpPlainText hides snake_case from the rule, which is why blogLeakText exists", () => {
    // The trap, pinned: scanning helpPlainText output misses the identifier; scanning blogLeakText finds it.
    expect(rulesOf(helpPlainText("It prints h2h_reapply here."))).toEqual([]);
    expect(rulesOf(blogLeakText("It prints h2h_reapply here."))).toEqual(["code-identifier"]);
  });
});

describe("a bare URL is not a code identifier", () => {
  it("a URL with underscores or camel case passes; the same token in prose is still flagged", () => {
    const cases = [
      "Read https://example.com/help/swiss_pairing_rules for the full text.",
      "See https://example.com/guide?utm_source=newsletter&topNPerGroup=2 now.",
      "Visit http://seazn.club/live/some_club/season_one.",
      "The page is at www.example.com/a_b_c today.",
    ];
    for (const c of cases) expect(findBlogLeaks(c), c).toEqual([]);
    // The exemption is the URL only: prose around it is still scanned, and the same token outside a URL is a leak.
    expect(findBlogLeaks("Read https://example.com/swiss_pairing and then h2h_reapply.").map((l) => l.match)).toEqual(["h2h_reapply"]);
    expect(findBlogLeaks("swiss_pairing_rules").map((l) => l.match)).toEqual(["swiss_pairing_rules"]);
    // The index of a hit after a URL is still the index in the original text.
    const text = "https://example.com/a_b then h2h_reapply";
    expect(findBlogLeaks(text)[0]!.index).toBe(text.indexOf("h2h_reapply"));
  });
});

describe("BLOG_LEAK_ALLOW", () => {
  it("has a reason per entry, and each entry is the only thing standing between a real use and a flag", () => {
    expect(BLOG_LEAK_ALLOW.length, "anti-vacuity: allow entries").toBeGreaterThan(0);
    for (const a of BLOG_LEAK_ALLOW) {
      expect(a.reason.length, `reason for ${a.match}`).toBeGreaterThan(10);
      // Live: the token IS identifier-shaped (else the entry is dead weight)...
      expect(/[a-z][A-Z]|_/.test(a.match), `${a.match} looks like an identifier`).toBe(true);
      // ...and it passes in a sentence.
      expect(findBlogLeaks(`Score on your ${a.match} here.`), a.match).toEqual([]);
    }
  });
  it("an allow-listed token may be plural (iPads, iPhones), nothing else follows it", () => {
    expect(findBlogLeaks("Score on iPads and iPhones here.")).toEqual([]);
    expect(rulesOf("iPhonex")).toEqual(["code-identifier"]);
  });
  it("an allow-listed token inside a longer identifier is still flagged", () => {
    expect(rulesOf("iPhoneScoreCount")).toEqual(["code-identifier"]);
  });
});

describe("blogLeakText", () => {
  it("drops link targets, image paths and the blog's tokens; keeps underscores in prose", () => {
    const md = [
      "See [the Swiss page](/help/formats/swiss_page).",
      "![A bracket](/blog/img/swiss_bye.webp)",
      "{{example:swiss-bye}}",
      "Ana finishes on {{fact:swiss-bye.anaPoints}} points.",
    ].join("\n");
    const text = blogLeakText(md);
    expect(findBlogLeaks(text)).toEqual([]);
    expect(text).toContain("the Swiss page");
    expect(text).toContain("A bracket");
    expect(blogLeakText("a leaked_token in prose")).toContain("leaked_token");
  });

  it("keeps a picture's and a link's quoted title, which the page renders as a caption (and so scans it)", () => {
    const md = '![A bracket](/blog/img/a.webp "Caption with a_leaked_key")\n\n[page](/help/x "link_title_leak")';
    const text = blogLeakText(md);
    expect(text).toContain("Caption with a_leaked_key");
    expect(text).toContain("link_title_leak");
    expect(text).not.toContain("/blog/img");
    expect(findBlogLeaks(text).map((l) => l.match).sort()).toEqual(["a_leaked_key", "link_title_leak"]);
    // The same markup without a title still drops the target.
    expect(blogLeakText("![x](/a/b_c.webp)")).not.toContain("b_c");
  });
});

describe("the valid fixture posts carry no leak", () => {
  const dir = join(__dirname, "fixtures", "content");
  it("sweeps every post's body, title and description", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    let chars = 0;
    for (const f of files) {
      const text = blogLeakText(readFileSync(join(dir, f), "utf8"));
      chars += text.length;
      expect(findBlogLeaks(text), f).toEqual([]);
    }
    console.log(`blog-leaks: posts scanned=${files.length}, chars=${chars}`);
    expect(files.length, "anti-vacuity: posts scanned").toBeGreaterThan(0);
    expect(chars, "anti-vacuity: text scanned").toBeGreaterThan(0);
  });
  it("a post that prints an identifier IS flagged by the same sweep", () => {
    const raw = readFileSync(join(dir, "how-swiss-pairs-round-two.md"), "utf8") + "\nThe tie-break is buchholz_cut1.\n";
    expect(findBlogLeaks(blogLeakText(raw)).map((l) => l.match)).toEqual(["buchholz_cut1"]);
  });
});

describe("withoutDiagramKind: it drops a diagram's own `kind` and nothing else", () => {
  const leavesOf = (v: unknown): string[] => (typeof v === "string" ? [v] : v === null || typeof v !== "object" ? [] : Object.values(v).flatMap(leavesOf));
  // The first string leaf the tests plant a code-shaped identifier into, one leaf at a time (a path of keys and indexes).
  const paths = (v: unknown, at: (string | number)[] = []): (string | number)[][] =>
    typeof v === "string"
      ? [at]
      : v === null || typeof v !== "object"
        ? []
        : Object.entries(v).flatMap(([k, c]) => paths(c, [...at, Array.isArray(v) ? Number(k) : k]));
  const planted = (g: ExampleResult, at: (string | number)[], word: string): ExampleResult => {
    const copy = JSON.parse(JSON.stringify(g)) as ExampleResult;
    let node: unknown = copy.diagram;
    for (const k of at.slice(0, -1)) node = (node as Record<string | number, unknown>)[k];
    (node as Record<string | number, unknown>)[at[at.length - 1]!] = word;
    return copy;
  };

  it("every committed diagram keeps every string it has except its kind, and a code-shaped word planted in any other string is still found", () => {
    let diagrams = 0;
    let plantedLeaves = 0;
    for (const [id, g] of Object.entries(BLOG_GOLDENS)) {
      if (g.diagram === undefined) continue;
      diagrams++;
      const before = leavesOf(g.diagram);
      const after = leavesOf(withoutDiagramKind(g).diagram);
      // Exactly one leaf went (the kind), and it is the kind's value: a stripper that also drops a title, a caption or a nested kind fails.
      expect(after.length, `${id}: strings left of ${before.length}`).toBe(before.length - 1);
      const gone = [...before];
      for (const s of after) gone.splice(gone.indexOf(s), 1);
      expect(gone, `${id}: the one string that went`).toEqual([g.diagram.kind]);
      // Anything else a diagram says is copy: plant an identifier into each string in turn (the kind aside) and the scan must see it.
      expect(paths(g.diagram).map((p) => p.join(".")), `${id}: the kind is a top-level string`).toContain("kind");
      for (const at of paths(g.diagram)) {
        if (at.join(".") === "kind") continue;
        plantedLeaves++;
        const word = "anaTotalPoints";
        const found = leavesOf(withoutDiagramKind(planted(g, at, word)).diagram).join(" ");
        expect(findBlogLeaks(found).map((l) => l.match), `${id}: ${at.join(".")}`).toContain(word);
      }
    }
    expect(diagrams, "diagrams swept").toBeGreaterThanOrEqual(5);
    expect(plantedLeaves, "strings a word was planted into").toBeGreaterThan(50);
  });

  it("a nested field that is also called `kind` is copy: it is kept", () => {
    const g: ExampleResult = { facts: {}, text: [], diagram: { kind: "swissRound", title: "t", rounds: [{ kind: "innerKind" }] } as unknown as ExampleResult["diagram"] };
    expect(leavesOf(withoutDiagramKind(g).diagram)).toEqual(["t", "innerKind"]);
  });
});
