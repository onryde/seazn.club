// YouTube Connect T10 (spec §6.5, plan P11): the broadcast's title and description, as pure functions.
//
// Expected values are YouTube's own rules, typed here and never imported from title.ts:
//   - liveBroadcasts.insert: "The property's value must be between 1 and 100 characters long" (`invalidTitle`), and the
//     videos resource's snippet.title may contain every UTF-8 character "except < and >" (a broadcast is one video).
//     Counted in code points, so an emoji is one character, never two UTF-16 units.
//   - the description takes the same "< and >" rule (videos `snippet.description`; carried note from T7).
// The shape is the spec's: `<Home> v <Away> · <Division> · <Competition>`, trimmed to the limit with the COMPETITION
// trimmed first. The words come from the caller (the org's locale; the locale half is pinned through prepare in
// prepare.test.ts, RF4).
//
// Sport: not applicable — a title names entrants, a division and a competition, never a sport rule.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { broadcastDescription, broadcastTitle } from "@/server/youtube/title";

/** YouTube's title limit, typed from liveBroadcasts.insert (plan P11). */
const TITLE_MAX = 100;
const SEP = " · ";
const len = (s: string) => Array.from(s).length;
/** A realistic long doubles pair name: exactly 43 characters (AGENTS.md's phone-composition finding used the same length). */
const pair = (first: string) => `${first} Fitzgerald-Okonkwo / Alexandra Whitmore`.slice(0, 43).padEnd(43, "x");
const words = { vs: "v", tbd: "TBD" };

describe("broadcastTitle (spec §6.5, plan P11)", () => {
  it("EMPTY CASE FIRST: no division and no competition → just the match; an empty part never leaves a dangling separator", () => {
    const t = broadcastTitle({ home: "Home", away: "Away", division: "", competition: "", ...words });
    expect(t).toBe("Home v Away");
    // Positive pair: both present → the spec's full shape.
    expect(broadcastTitle({ home: "Home", away: "Away", division: "Division", competition: "Competition", ...words }))
      .toBe("Home v Away · Division · Competition");
  });

  it("title: 'Home v Away · Division · Competition'; a 43-char entrant pair + long competition stays ≤ 100 and trims the competition FIRST (division intact)", () => {
    const home = pair("Jonathan");
    const away = pair("Benedict");
    expect(len(home)).toBe(43);
    expect(len(away)).toBe(43);
    const division = "Open";
    const competition = "Northern Counties Inter-Club Badminton Championship 2026 — Winter Series";
    const t = broadcastTitle({ home, away, division, competition, ...words });
    expect(len(t)).toBeLessThanOrEqual(TITLE_MAX);
    // The match and the division survive whole; it is the competition that gave way.
    expect(t.startsWith(`${home} v ${away}${SEP}${division}`)).toBe(true);
    expect(t).not.toContain(competition);
    // Positive pair: with room, the same competition is kept whole.
    const roomy = broadcastTitle({ home: "Ann", away: "Bob", division, competition, ...words });
    expect(roomy).toBe(`Ann v Bob${SEP}${division}${SEP}${competition}`);
  });

  it("a competition that only partly fits is CUT to fill the 100 (ellipsis), never dropped while it can show a word", () => {
    const home = "Riverside Rackets";
    const away = "Harbour Shuttlers";
    const division = "Mixed Doubles";
    const competition = "The Very Long Annual Regional Invitational Open Tournament of the Year 2026";
    const head = `${home} v ${away}${SEP}${division}${SEP}`;
    expect(len(head) + len(competition)).toBeGreaterThan(TITLE_MAX);   // the case really overflows
    const t = broadcastTitle({ home, away, division, competition, ...words });
    // Filled to the limit — less one when the cut lands on a space, which is dropped rather than left before the ellipsis.
    expect(len(t)).toBeLessThanOrEqual(TITLE_MAX);
    expect(len(t)).toBeGreaterThanOrEqual(TITLE_MAX - 1);
    expect(t.startsWith(head)).toBe(true);
    expect(t.endsWith("…")).toBe(true);
    expect(t.endsWith(" …")).toBe(false);
    // What is kept of the competition is its own beginning.
    expect(competition.startsWith(t.slice(len(head), -1))).toBe(true);
  });

  it("the division gives way only once the competition is gone: an over-long division is cut, the match stays whole", () => {
    const home = pair("Jonathan");
    const away = pair("Benedict");
    const division = "Under-19 Mixed Doubles Elite Group";
    const t = broadcastTitle({ home, away, division, competition: "Some Cup", ...words });
    const head = `${home} v ${away}${SEP}`;
    expect(len(head)).toBe(92);   // 43 + " v " + 43 + " · ": eight characters left for the division
    expect(t).not.toContain("Some Cup");
    expect(t).not.toContain(division);
    // CUT, not dropped: filled to exactly 100 (the cut lands on "Under-1", no space to drop), ending in the ellipsis, and what
    // is kept is the division's own beginning. A dropped division would read as the 89-character match alone.
    expect(len(t)).toBe(TITLE_MAX);
    expect(t.startsWith(head)).toBe(true);
    expect(t.endsWith("…")).toBe(true);
    const kept = t.slice(head.length, -1);
    expect(len(kept)).toBe(TITLE_MAX - len(head) - 1);
    expect(division.startsWith(kept)).toBe(true);
  });

  it("a match name longer than 100 on its own is cut to 100 (the last resort)", () => {
    const home = "H".repeat(80);
    const away = "A".repeat(80);
    const t = broadcastTitle({ home, away, division: "Open", competition: "Cup", ...words });
    expect(len(t)).toBe(TITLE_MAX);
    expect(t.startsWith("H".repeat(80))).toBe(true);
  });

  it("title: '<' and '>' are removed; TBD v TBD uses the tbd word", () => {
    const t = broadcastTitle({ home: "<script>Ace</script>", away: "B>C", division: "Div <1>", competition: "Cup>", ...words });
    expect(t).not.toMatch(/[<>]/);
    expect(t).toBe("scriptAce/script v BC · Div 1 · Cup");
    // TBD v TBD: both sides unknown read the caller's tbd word (here a non-English one, so an English default would show).
    const tbd = broadcastTitle({ home: null, away: null, division: "Open", competition: "Cup", vs: "contre", tbd: "À déterminer" });
    expect(tbd).toBe("À déterminer contre À déterminer · Open · Cup");
    // A side that is only '<>' is no name at all: it reads the tbd word too.
    expect(broadcastTitle({ home: "<>", away: "B", division: "", competition: "", ...words })).toBe("TBD v B");
  });

  it("counts code points: 100 emoji in the competition never split a surrogate pair and the title is ≤ 100 characters", () => {
    const competition = "🏸".repeat(100);
    const t = broadcastTitle({ home: "A", away: "B", division: "Open", competition, ...words });
    expect(len(t)).toBe(TITLE_MAX);
    expect(t.isWellFormed()).toBe(true);
  });

  it("is never empty and never whitespace-only (YouTube refuses both): blank names read tbd", () => {
    const t = broadcastTitle({ home: "   ", away: "", division: "  ", competition: " ", ...words });
    expect(t).toBe("TBD v TBD");
  });
});

describe("broadcastDescription (spec §6.5)", () => {
  const url = "https://seazn.club/live/club/cup/open/fixtures/abc";
  const site = "https://seazn.club";
  const base = { line: "Live score and results:", matchUrl: url, poweredBy: "Powered by Seazn Club", siteUrl: site };

  it("two paragraphs: the line + the public match URL, a blank line, then 'Powered by …' · the site", () => {
    expect(broadcastDescription(base)).toBe(`Live score and results: ${url}\n\nPowered by Seazn Club · ${site}`);
  });

  it("'<' and '>' are removed from every part (line, match URL, powered-by words, site URL)", () => {
    const d = broadcastDescription({
      line: "Score <live> & results:",
      matchUrl: `${url}?x=<y>`,
      poweredBy: "Powered <by> Seazn Club",
      siteUrl: "https://<seazn>.club",
    });
    expect(d).not.toMatch(/[<>]/);
    expect(d).toBe(`Score live & results: ${url}?x=y\n\nPowered by Seazn Club · https://seazn.club`);
  });

  it("a match with no public page (matchUrl null) carries no live-score line: the powered-by paragraph alone, and no dead link", () => {
    const d = broadcastDescription({ ...base, matchUrl: null });
    expect(d).toBe(`Powered by Seazn Club · ${site}`);
    expect(d).not.toContain(base.line);
    expect(d).not.toContain("/live/");
  });

  it("the powered-by paragraph is present and last (exactly two paragraphs)", () => {
    const d = broadcastDescription(base);
    const paragraphs = d.split("\n\n");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]).toBe(`${base.poweredBy} · ${site}`);
  });
});

// Task 5 (Seazn-hosted video plan, Phase 0): the match facts. Expected strings are typed from the brief's shape —
// facts block, blank line, match link line, blank line, ONE footer — and the dictionaries, never read back from title.ts.
describe("broadcastDescription facts (Phase 0 T5)", () => {
  const url = "https://seazn.club/live/club/cup/open/fixtures/abc";
  const site = "https://seazn.club";
  const DESC_MAX = 5000;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const facts = ["Badminton · Semi-finals", "Spring Cup", "Hall 2", "Saturday, December 5, 2026 at 2:30 PM GMT"];

  it("facts block, blank line, match link line, blank line, one footer", () => {
    const d = broadcastDescription({ line: "Live score and results:", matchUrl: url, poweredBy: "Scored live with Seazn Club", siteUrl: site, facts });
    expect(d).toBe(`${facts.join("\n")}\n\nLive score and results: ${url}\n\nScored live with Seazn Club · ${site}`);
    expect(d.split(url)).toHaveLength(2);   // exactly one match link
  });

  it("a private competition (matchUrl null): facts then the footer; no link and no line", () => {
    const d = broadcastDescription({ line: "Live score and results:", matchUrl: null, poweredBy: "Scored live with Seazn Club", siteUrl: site, facts });
    expect(d).toBe(`${facts.join("\n")}\n\nScored live with Seazn Club · ${site}`);
    expect(d).not.toContain("/live/");
  });

  it("EMPTY CASE: no facts (undefined or []) is the old two-paragraph shape, with no leading blank line", () => {
    const base = { line: "Live score and results:", matchUrl: url, poweredBy: "Scored live with Seazn Club", siteUrl: site };
    const want = `Live score and results: ${url}\n\nScored live with Seazn Club · ${site}`;
    expect(broadcastDescription(base)).toBe(want);
    expect(broadcastDescription({ ...base, facts: [] })).toBe(want);
    expect(broadcastDescription({ ...base, facts: ["  ", ""] })).toBe(want);
  });

  it("with and without a venue line, the other facts keep their order", () => {
    const withVenue = broadcastDescription({ line: "L:", matchUrl: null, poweredBy: "P", siteUrl: site, facts: ["A", "B", "Hall 2", "D"] });
    const without = broadcastDescription({ line: "L:", matchUrl: null, poweredBy: "P", siteUrl: site, facts: ["A", "B", "D"] });
    expect(withVenue.split("\n\n")[0]).toBe("A\nB\nHall 2\nD");
    expect(without.split("\n\n")[0]).toBe("A\nB\nD");
  });

  it("no '<' or '>' survives in any fact", () => {
    const d = broadcastDescription({ line: "L:", matchUrl: url, poweredBy: "P", siteUrl: site, facts: ["<b>Cup</b>", "Hall > 2"] });
    expect(d).not.toMatch(/[<>]/);
    expect(d.startsWith("bCup/b\nHall  2\n\n")).toBe(false);   // whitespace collapses: "Hall 2"
    expect(d.startsWith("bCup/b\nHall 2\n\n")).toBe(true);
  });

  it("a 300-character competition name and a flood of facts stay within 5000 (bytes and characters); the link and footer are never cut, the LAST fact goes first", () => {
    const comp = "C".repeat(300);
    const d = broadcastDescription({ line: "L:", matchUrl: url, poweredBy: "Scored live with Seazn Club", siteUrl: site, facts: ["Badminton · Final", comp, "Hall", "When"] });
    expect(Array.from(d).length).toBeLessThanOrEqual(DESC_MAX);
    expect(d).toContain(comp);   // 300 fits: nothing is cut when there is room

    const huge = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(200, "x"));   // 8000 characters of facts
    const cut = broadcastDescription({ line: "L:", matchUrl: url, poweredBy: "Scored live with Seazn Club", siteUrl: site, facts: huge });
    expect(Array.from(cut).length).toBeLessThanOrEqual(DESC_MAX);
    expect(bytes(cut)).toBeLessThanOrEqual(DESC_MAX);
    expect(cut).toContain(`L: ${url}`);
    expect(cut.endsWith(`Scored live with Seazn Club · ${site}`)).toBe(true);
    expect(cut.startsWith(huge[0]!)).toBe(true);   // the first fact survives whole
    expect(cut).not.toContain(huge[39]!);          // the last fact went first
  });

  it("multi-byte text is capped in bytes too (YouTube counts 5000 bytes)", () => {
    const wide = Array.from({ length: 30 }, () => "é".repeat(200));   // 2 bytes each: 12000 bytes
    const d = broadcastDescription({ line: "L:", matchUrl: url, poweredBy: "P", siteUrl: site, facts: wide });
    expect(bytes(d)).toBeLessThanOrEqual(DESC_MAX);
    expect(d.endsWith(`P · ${site}`)).toBe(true);
  });

  it("each of the four locales' footer words come through verbatim from the dictionaries", () => {
    let checked = 0;
    for (const dict of [en, es, fr, nl] as Record<string, string>[]) {
      const words = dict["streaming.youtube.broadcast.scoredLive"]!;
      expect(words).toBeTruthy();
      expect(words).toContain("Seazn Club");
      const d = broadcastDescription({ line: dict["streaming.youtube.broadcast.descriptionLine"]!, matchUrl: url, poweredBy: words, siteUrl: site, facts });
      expect(d.endsWith(`\n\n${words} · ${site}`)).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
    for (const dict of [es, fr, nl] as Record<string, string>[]) expect(dict["streaming.youtube.broadcast.scoredLive"]).not.toBe(en["streaming.youtube.broadcast.scoredLive"]);
  });
});
