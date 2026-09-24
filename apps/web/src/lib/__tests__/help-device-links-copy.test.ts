// Truth-in-copy guard for `content/help/scoring/device-links.md` (scorer
// sheets T3, review finding 1).
//
// WHY THIS EXISTS. Task 2 made device links durable: a sealed link has no
// expiry and lives until the match is finalized or cancelled, and asking for
// the link again (Show QR) re-shows the SAME one, so a QR printed on a scorer
// sheet keeps working. Only the explicit Revoke & reissue kills it. The help
// article kept saying the opposite of all three — "expires same day", "end of
// the fixture's local day", "minting a new link revokes the previous one" —
// through a green suite, because nothing tied the page to the product.
//
// SHAPE. Positive pins name the controls by the UI's own English labels, read
// from `dictionaries/en/ui.json`, so a relabel moves this test instead of
// leaving the article describing a button that no longer exists. Negative pins
// refuse the retired claims in ANY wording that carries them: day-scoped
// lifetime vocabulary anywhere in the page (frontmatter included — the
// description is what the help index shows), and any sentence that revokes the
// old link as a side effect of making a new one unless it names the explicit
// Revoke & reissue control.
//
// Sibling of `help-hold-window-copy.test.ts` / `help-hockey-format-copy.test.ts`
// (one article-scoped guard per file). `help-copy-truth.test.ts` is scoped to
// the BILLING articles by its own header, so this does not live there.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/` runs in the unit job and in
// smoke-db (.github/workflows/ci.yml), same as its siblings.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/dictionaries/en/ui.json";
import { PASS_FEATURES } from "@/lib/pass-features";

const ARTICLE = readFileSync(join(process.cwd(), "content/help/scoring/device-links.md"), "utf8");

/** The frontmatter block and the page body, pinned separately: the
 *  description is what the help index lists, the body is what the article
 *  page reads, and a claim in one does not stand in for the other. */
const [, FRONTMATTER = "", BODY = ""] = ARTICLE.split(/^---$/m);

/** Every sentence a reader sees, frontmatter and headings included, with
 *  markdown emphasis stripped so "**Show QR**" reads as "Show QR". */
const SENTENCES = ARTICLE.replace(/\*\*|__|`/g, "")
  .split(/(?<=[.!?])\s+|\n+/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const SHOW_QR = en["dlink.showQr"];
const REISSUE = en["dlink.reissue"];
const HAND_OVER = en["score.handOverDevice"];
const CREATE = en["dlink.create"];

describe("device-links.md says what a device link does since Task 2", () => {
  // The labels this file reads must exist, or every positive pin below would
  // be searching the article for `undefined`.
  it("reads real UI labels", () => {
    for (const label of [SHOW_QR, REISSUE, HAND_OVER, CREATE]) expect(label).toMatch(/\w/);
  });

  it("states the lifetime — until the match is finalized or cancelled — in the description AND the body", () => {
    expect(FRONTMATTER).toMatch(/^description: .*until the match is finalized or cancelled/m);
    expect(BODY).toContain("until the match is finalized or cancelled");
  });

  it("names the hand-over path by the controls the organiser actually taps", () => {
    expect(ARTICLE).toContain(HAND_OVER);
    expect(ARTICLE).toContain(CREATE);
  });

  it("says Show QR re-shows the SAME link, so a printed sheet keeps working", () => {
    const hits = SENTENCES.filter((s) => s.includes(SHOW_QR));
    expect(hits, `no sentence names ${SHOW_QR}`).not.toHaveLength(0);
    expect(hits.some((s) => /\bsame\b/i.test(s)), hits.join(" | ")).toBe(true);
    expect(SENTENCES.some((s) => /\bprinted\b/i.test(s) && /keeps? working/i.test(s))).toBe(true);
  });

  it("says Revoke & reissue is how you kill a lost sheet's link", () => {
    const hits = SENTENCES.filter((s) => s.includes(REISSUE));
    expect(hits, `no sentence names ${REISSUE}`).not.toHaveLength(0);
    expect(hits.some((s) => /\blost\b/i.test(s)), hits.join(" | ")).toBe(true);
  });
});

describe("device-links.md never brings the retired claims back", () => {
  it("no day-scoped lifetime anywhere, frontmatter included", () => {
    const offending = SENTENCES.filter((s) =>
      /\bexpir(e|es|ed|y|ing)\b|same[- ]day|local day|day-of|\btoday\b|midnight|end of the day/i.test(s),
    );
    expect(offending).toEqual([]);
  });

  it("no sentence revokes the old link as a side effect of making a new one", () => {
    // "Minting a new link … revokes the previous one" was true before Task 2.
    // Now only the explicit control does that, so a sentence pairing revocation
    // with a new link/QR must name Revoke & reissue.
    const offending = SENTENCES.filter(
      (s) => /revok/i.test(s) && /\bnew (link|QR|one)\b|\bprevious\b|\bmint/i.test(s) && !s.includes(REISSUE),
    );
    expect(offending).toEqual([]);
  });
});

// Scorer sheets §4.3 (Task 4, review I2). A device may undo its own entries only
// until the result MOVES THE COMPETITION ON — in a knockout that is the instant
// the result is entered (the winner is seated in the next match by the same
// write), in Swiss when the next round is paired, anywhere when the stage
// completes. After that every device-link write is 403 RESULT_CARRIED_FORWARD
// and corrections are the organiser's. The article said "right up until the
// match is finalized", which was the device's bound before Task 4 and is still
// a SIGNED-IN SCORER's — so corrections.md, which states both, is held to the
// same rule for its device-link sentence.
const CORRECTIONS = readFileSync(join(process.cwd(), "content/help/scoring/corrections.md"), "utf8");
const sentencesOf = (md: string) =>
  md
    .replace(/\*\*|__|`/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
/** An undo bounded by finalization: "until/before … the match is finalized". */
const UNDO_UNTIL_FINAL = (s: string) => /\bundo\b/i.test(s) && /\b(until|before)\b[^.;]*\bfinali[sz]ed\b/i.test(s);
const MOVES_ON = /moves the competition on/i;

describe("the device's undo window ends when the result moves the competition on (scorer sheets §4.3)", () => {
  it("device-links.md: the undo sentence names the real bound, and each way a result moves on", () => {
    const undo = SENTENCES.filter((s) => /\bundo\b/i.test(s) && /own entries/i.test(s));
    expect(undo, "no sentence says what the holder can undo").not.toHaveLength(0);
    expect(undo.every((s) => MOVES_ON.test(s)), undo.join(" | ")).toBe(true);
    // Each clause of the predicate, in words a reader recognises.
    expect(BODY).toMatch(/knockout[^.]*moment the result is entered[^.]*next match/i);
    expect(BODY).toMatch(/Swiss[^.;]*next round is paired/i);
    expect(BODY).toMatch(/stage is completed/i);
    expect(SENTENCES.some((s) => /corrections are the organiser's/i.test(s))).toBe(true);
  });

  it("device-links.md: no sentence bounds a device's undo by finalization any more", () => {
    expect(SENTENCES.filter(UNDO_UNTIL_FINAL)).toEqual([]);
  });

  it("corrections.md: the device-link sentence names the moved-on bound; only a signed-in scorer's undo runs to finalization", () => {
    const sentences = sentencesOf(CORRECTIONS);
    const device = sentences.filter((s) => /device link/i.test(s) && /\bundo\b/i.test(s));
    expect(device, "corrections.md no longer says what a device link can undo").not.toHaveLength(0);
    expect(device.some((s) => MOVES_ON.test(s)), device.join(" | ")).toBe(true);
    // "Either way, undo only works before the match is finalized" covered BOTH
    // actors; a finalization bound may now only speak for a signed-in scorer.
    const offending = sentences.filter(
      (s) => UNDO_UNTIL_FINAL(s) && (/device link/i.test(s) || !/signed-in scorer/i.test(s)),
    );
    expect(offending).toEqual([]);
  });
});

// Scorer sheets, help pass (2026-09-24). Three more places the device-link
// pages said something the product no longer does:
//  - device-links.md listed the ways a link ends and left out the one an
//    organiser is most likely to press: Rebuild fixtures deletes every match
//    in the stage (usecases/stages.ts rebuildStageFixtures), `device_links`
//    cascades off `fixtures` (V222), so every QR on that stage stops working —
//    the rebuild dialog itself says so (progression.rosterDrift.sheetsStop).
//  - scorer-role.md said device links are for mass scoring "on any plan".
//    The Event Pass lifts `scoring.device_links` (PASS_FEATURES), which is by
//    that set's own definition a key the Community row does NOT grant.
//  - conflicts.md told a reader to "give each court its own device link". A
//    link belongs to one MATCH (scorer sheets D1: no per-court link), and
//    since Task 2 asking again re-shows the same one — there is no second
//    link to hand a second court.
const SCORER_ROLE = readFileSync(join(process.cwd(), "content/help/scoring/scorer-role.md"), "utf8");
const CONFLICTS = readFileSync(join(process.cwd(), "content/help/scoring/conflicts.md"), "utf8");
const REBUILD = en["progression.rosterDrift.rebuildCta"];
/** "stops working" / "stop working" / "no longer works" — how these pages say a link is dead. */
const DIES = /\bstops? working\b|\bno longer works?\b/i;

describe("every way a device link ends is on the page, and no plan it lacks is claimed", () => {
  it("reads the Rebuild label, and the pass still lifts device links (the premises below)", () => {
    expect(REBUILD).toMatch(/\w/);
    expect(PASS_FEATURES.has("scoring.device_links")).toBe(true);
  });

  it("device-links.md: Rebuild fixtures is named as a way the link stops working", () => {
    const hits = SENTENCES.filter((s) => s.includes(REBUILD));
    expect(hits, `device-links.md never names ${REBUILD}`).not.toHaveLength(0);
    expect(hits.some((s) => DIES.test(s)), hits.join(" | ")).toBe(true);
  });

  it("scorer-role.md: the device-link sentence names Pro and the Event Pass, and claims no plan-free reach", () => {
    const device = sentencesOf(SCORER_ROLE).filter((s) => /device links?\b/i.test(s));
    expect(device, "scorer-role.md no longer mentions device links").not.toHaveLength(0);
    const everyPlan = /\b(?:on|for|with)\s+(?:any|every|all)\s+plans?\b|\bwhatever (?:your|the) plan\b|\bno matter (?:your|which) plan\b/i;
    expect(device.filter((s) => everyPlan.test(s))).toEqual([]);
    expect(device.some((s) => /\bPro\b/.test(s) && /\bEvent Pass\b/i.test(s)), device.join(" | ")).toBe(true);
  });

  it("event-pass.md: the pass's feature list names device links, since the pass lifts them", () => {
    // Owner-approved 2026-09-24 (relayed by the scorer-sheets controller): the
    // pass page's "What the pass includes" list left out a key PASS_FEATURES
    // holds, so an organiser deciding between Community and the pass could
    // not see that match-day phones and printed sheets come with it.
    const md = readFileSync(join(process.cwd(), "content/help/billing/event-pass.md"), "utf8");
    const section = md.split(/^## /m).find((s) => s.startsWith("What the pass includes")) ?? "";
    expect(section, "event-pass.md has no 'What the pass includes' section").not.toBe("");
    const bullets = section.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.some((b) => b.includes("](/help/scoring/device-links)")), bullets.join("\n")).toBe(true);
  });

  it("conflicts.md: no sentence gives a court its own device link", () => {
    const offending = sentencesOf(CONFLICTS).filter(
      (s) => /device link/i.test(s) && /\bcourts?\b[^.]*\bown\b|\bown\b[^.]*\bcourts?\b|\bper court\b/i.test(s),
    );
    expect(offending).toEqual([]);
  });
});

// Scorer sheets help, fix round 1. A device's undo is scoped to its LINK, not
// its phone: usecases/scoring.ts refuses a device-link `core.void` unless the
// target event's `device_link_id` equals the caller's `auth.deviceLinkId`.
// Since Task 2 re-shows the same QR, two phones that scanned one card hold the
// SAME link — so "never another device's entries" was false, and a pair of
// umpires sharing a card could undo each other's taps without being told so.
const SHEETS = readFileSync(join(process.cwd(), "content/help/scoring/scorer-sheets.md"), "utf8");
const UNDO_SCOPED_PAGES: ReadonlyArray<readonly [string, string]> = [
  ["device-links.md", ARTICLE],
  ["corrections.md", CORRECTIONS],
  ["scorer-sheets.md", SHEETS],
];

describe("a device's undo is scoped to its link, not its phone", () => {
  for (const [name, md] of UNDO_SCOPED_PAGES) {
    it(`${name}: never says a device cannot undo another device's entries`, () => {
      expect(sentencesOf(md).filter((s) => /\banother device's\b|\bother devices'/i.test(s))).toEqual([]);
    });

    it(`${name}: says phones sharing one QR can undo each other's entries`, () => {
      const hits = sentencesOf(md).filter((s) => /\b(?:each|the) other's\b/i.test(s));
      expect(hits, `${name} never says who else can undo`).not.toHaveLength(0);
      expect(hits.some((s) => /\bundo\b/i.test(s) && /\bsame (?:QR|card)\b|\bshare\b/i.test(s)), hits.join(" | ")).toBe(true);
    });
  }
});
