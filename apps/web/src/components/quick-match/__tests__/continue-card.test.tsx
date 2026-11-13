// "Continue" on the setup page (owner 2026-11-12: "if same browser tries to create one more, show the first one"). A guest
// whose browser holds an UNFINISHED quick match (not every match played or not played) meets it first, above the form:
// its name, how many of its matches are played, and Continue to its home. The newest unfinished one is the card; every
// other recent match stays in the strip below; a finished one is only ever in the strip. Creating another is never blocked.
//
// Here: the pure split over rows handed to it, and the card's markup. The rows' READ (the visitor cookie, played and
// total from the match's real fixtures) and the page's order (card, then "Or start a new quick match", then the form,
// then the strip) are tested through the real page against a real database,
// `app/[lang]/(marketing)/__tests__/home-quick-match-cta.test.tsx`.
//
// Expected values come from the owner's ruling and the spec, never from the card: a home is `/q/<token>` (§7.4), and a link
// that paints a home token carries `ph-no-capture` (lib/__tests__/scrub-secret-painters.test.ts).
//
// Sport: not applicable (the card reads no sport: a name and a count).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContinueCard, splitRecent } from "../continue-card";
import type { RecentQuickMatchWithCounts as RecentQuickMatch } from "../recent-strip";

/** Home-token shaped (`qm_` + 43 base64url characters), as `mintHomeToken` writes them. */
const token = (c: string) => `qm_${c.repeat(42)}x`;
/** `notPlayed`: the matches marked Not played (plan 4); absent is none. */
const row = (c: string, played: number, total: number, notPlayed = 0): RecentQuickMatch => ({
  token: token(c),
  name: `Match ${c}`,
  createdAt: "2026-11-08T10:00:00.000Z",
  played,
  notPlayed,
  total,
});
const names = (rows: readonly RecentQuickMatch[]) => rows.map((r) => r.name);

describe("splitRecent: the newest unfinished match is the card, every other row stays in the strip", () => {
  it("the empty case first: no rows, no card, an empty strip", () => {
    expect(splitRecent([])).toEqual({ resume: null, rest: [] });
  });

  it("a table of cases (rows newest first, as the read hands them): which is the card, what the strip keeps, in order", () => {
    const cases: [string, RecentQuickMatch[], string | null, string[]][] = [
      ["one unfinished: the card, and the strip empties", [row("A", 0, 1)], "Match A", []],
      ["one finished: no card, the strip keeps it", [row("A", 1, 1)], null, ["Match A"]],
      ["every one finished: no card", [row("A", 3, 3), row("B", 1, 1)], null, ["Match A", "Match B"]],
      [
        "the newest is finished, an older one is not: the older is the card, the finished one stays in the strip",
        [row("A", 1, 1), row("B", 1, 3), row("C", 0, 1)],
        "Match B",
        ["Match A", "Match C"],
      ],
      ["two unfinished: the NEWEST is the card, the other stays in the strip", [row("A", 2, 6), row("B", 0, 1)], "Match A", ["Match B"]],
      // A row with no matches at all cannot be continued (no producer makes one: a quick match has two sides at least).
      ["no matches: nothing to continue", [row("A", 0, 0)], null, ["Match A"]],
      // Plan 4 (§3, §6): a Not played match is done, so a league finished by skips is finished, and M stays the full total.
      [
        "the newest is finished by a skip (1 played, 1 not played of 2), an older one is open: the older is the card",
        [row("A", 1, 2, 1), row("B", 0, 1)],
        "Match B",
        ["Match A"],
      ],
      ["finished with nothing played (every match not played): no card", [row("A", 0, 1, 1)], null, ["Match A"]],
      ["one played, one not played, one to play: still open, the card", [row("A", 1, 3, 1)], "Match A", []],
      ["every one finished, one by skips and one by play: no card", [row("A", 1, 3, 2), row("B", 1, 1)], null, ["Match A", "Match B"]],
    ];
    let checked = 0;
    for (const [why, rows, card, strip] of cases) {
      const { resume, rest } = splitRecent(rows);
      expect(resume?.name ?? null, why).toBe(card);
      expect(names(rest), why).toEqual(strip);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBe(10);
  });
});

describe("ContinueCard", () => {
  const html = renderToStaticMarkup(
    <ContinueCard item={row("A", 2, 6)} labels={{ played: "2 of 6 matches played", action: "Continue" }} />,
  );
  const anchors = [...html.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)];

  it("one link, Continue, to the match's home `/q/<token>`; it paints the token, so it carries ph-no-capture", () => {
    expect(anchors).toHaveLength(1);
    const [tag, text] = [anchors[0]![0], anchors[0]![1]];
    expect(text).toBe("Continue");
    expect(tag).toContain(`href="/q/${token("A")}"`);
    expect(tag).toMatch(/\bclass="[^"]*\bph-no-capture\b[^"]*"/);
    // The link is described by the match's name, so "Continue" is never heard on its own.
    const nameId = /<h2\b[^>]*\bid="([^"]+)"/.exec(html)?.[1];
    expect(nameId, "the name is the card's heading").toBeDefined();
    expect(tag).toContain(`aria-describedby="${nameId}"`);
  });

  it("names the match and how many of its matches are played", () => {
    expect(html).toMatch(/<h2\b[^>]*>Match A<\/h2>/);
    expect(html).toContain(">2 of 6 matches played<");
  });
});
