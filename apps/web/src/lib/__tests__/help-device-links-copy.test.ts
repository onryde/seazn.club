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
