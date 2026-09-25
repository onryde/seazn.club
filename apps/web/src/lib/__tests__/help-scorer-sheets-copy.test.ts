// Truth-in-copy guard for `content/help/scoring/scorer-sheets.md` (printable
// scorer sheets, help pass 2026-09-24).
//
// WHY THIS EXISTS. The scorer-sheet article describes a feature whose every
// load-bearing fact lives in code: how many cards a page holds, who may print,
// which plans carry it, what the umpire's phone says on each screen, and every
// way a printed QR stops working. The device-link article went stale three
// times over (expiry, "minting revokes", the undo bound) through a green suite
// because nothing tied the page to the product — this file is the tie for the
// sheet article from the day it ships.
//
// SHAPE, same as `help-device-links-copy.test.ts`: every label the article
// quotes is read from `dictionaries/en/ui.json`, every number and role from the
// module that enforces it (`ROWS_PER_PAGE`, `EDITOR_ROLES`, `PASS_FEATURES`),
// so a relabel or a rule change moves this test instead of leaving the page
// describing yesterday's product. Where a claim is about a CAUSE (Rebuild
// deletes the match, so the link cascades), the pin is that the article names
// the control AND says the card stops working in the same sentence.
//
// Pinned at the scorer-sheets fold: the print control's labels
// `en["sheets.day"]` and `en["sheets.print"]` (print-scorer-sheets.tsx), and
// the PDF's own lines `en["sheets.pdf.noCourt"]` and `en["sheets.pdf.checkNames"]`
// (scorer-sheet-pdf.ts), each quoted as the article shows it. The NEGATIVE pin
// below still holds too: there is no separate "Print" button to press.
//
// NOT PINNED HERE YET: the owner-approved (2026-09-24) "Not started yet" scan
// screen is being built on another branch, so its heading is pinned below as a
// LITERAL — swap it for its `en[...]` key once that key reaches this branch.
//
// The article is read lazily so a missing file reds each assertion by name
// rather than failing the whole file at collection.
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/` runs in the unit job and in
// smoke-db (.github/workflows/ci.yml), same as its siblings.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/dictionaries/en/ui.json";
import { HELP_ARTICLE_SLUGS } from "@/lib/help";
import { PASS_FEATURES } from "@/lib/pass-features";
import { ROWS_PER_PAGE } from "@/lib/scorer-sheets";
import { EDITOR_ROLES } from "@/lib/types";
import { VIEW_ONLY_COPY } from "@/lib/scan-screen";

const SLUG = "scoring/scorer-sheets";
const PATH = join(process.cwd(), `content/help/${SLUG}.md`);
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

const article = () => read(PATH);
const parts = () => {
  const [, frontmatter = "", body = ""] = article().split(/^---$/m);
  return { frontmatter, body };
};
/** Every sentence a reader sees, frontmatter and headings included, with
 *  markdown emphasis stripped so "**Start match**" reads as "Start match". */
const sentencesOf = (md: string) =>
  md
    .replace(/\*\*|__|`/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
const sentences = () => sentencesOf(article());
const withText = (needle: string) => sentences().filter((s) => s.includes(needle));

/** How these pages say a link is dead. */
const DIES = /\bstops? working\b|\bno longer works?\b/i;
const NUMBER_WORDS: Readonly<Record<number, string>> = {
  4: "four", 6: "six", 8: "eight", 9: "nine", 10: "ten", 12: "twelve", 16: "sixteen",
};

describe("scorer-sheets.md exists and is reachable", () => {
  it("is on disk, has frontmatter, and is in the help registry", () => {
    expect(article(), `${PATH} is missing`).not.toBe("");
    expect(parts().frontmatter).toMatch(/^title: \S/m);
    expect(parts().frontmatter).toMatch(/^description: \S/m);
    expect(HELP_ARTICLE_SLUGS as readonly string[]).toContain(SLUG);
  });

  it("links to the device-link article, and the device-link article links back", () => {
    expect(article()).toContain("](/help/scoring/device-links)");
    expect(read(join(process.cwd(), "content/help/scoring/device-links.md"))).toContain(`](/help/${SLUG})`);
  });

  it("the matchday-documents article points printed-paper readers at it", () => {
    // "Match sheets" there are blank paper scoresheets; a reader looking for
    // the QR cards lands on that page first.
    expect(read(join(process.cwd(), "content/help/scheduling/matchday-documents.md"))).toContain(`](/help/${SLUG})`);
  });
});

describe("scorer-sheets.md says what the sheet is and who can print it", () => {
  it(`states the page's card count as the renderer's ROWS_PER_PAGE (${ROWS_PER_PAGE})`, () => {
    const n = `(?:${ROWS_PER_PAGE}|${NUMBER_WORDS[ROWS_PER_PAGE] ?? ROWS_PER_PAGE})`;
    expect(parts().body).toMatch(new RegExp(`\\b${n}\\s+(?:cut-out\\s+)?cards\\b`, "i"));
  });

  it("groups by court across every division", () => {
    expect(sentences().some((s) => /\bcourt\b/i.test(s) && /\b(?:every|all|each) divisions?\b/i.test(s))).toBe(true);
  });

  it("names every editor role as the people who print (EDITOR_ROLES)", () => {
    const who = sentences().filter((s) => /\bprint/i.test(s) && EDITOR_ROLES.some((r) => new RegExp(`\\b${r}s?\\b`, "i").test(s)));
    expect(who, "no sentence says who can print").not.toHaveLength(0);
    for (const role of EDITOR_ROLES) {
      expect(who.some((s) => new RegExp(`\\b${role}s?\\b`, "i").test(s)), `${role} not named`).toBe(true);
    }
  });

  it("names Pro and the Event Pass, and claims no plan-free reach (the pass lifts device links)", () => {
    expect(PASS_FEATURES.has("scoring.device_links")).toBe(true);
    const plans = sentences().filter((s) => /\bPro\b/.test(s) && /\bEvent Pass\b/i.test(s));
    expect(plans, "no sentence names both Pro and the Event Pass").not.toHaveLength(0);
    const everyPlan = /\b(?:on|for|with)\s+(?:any|every|all)\s+plans?\b|\bwhatever (?:your|the) plan\b/i;
    expect(sentences().filter((s) => everyPlan.test(s))).toEqual([]);
  });

  it("quotes the print control as it is labelled: the Day select and the Print scorer sheets button", () => {
    // Bold, as the article sets every control it names: a bare "Day" matches
    // any sentence about days.
    expect(en["sheets.day"]).toMatch(/\w/);
    expect(article()).toContain(`**${en["sheets.day"]}**`);
    const press = withText(en["sheets.print"]);
    expect(press, `the article never names the ${en["sheets.print"]} button`).not.toHaveLength(0);
    expect(press.some((s) => s.includes(en["sheets.day"]) && /\bpress\b/i.test(s)), press.join(" | ")).toBe(true);
  });

  it("quotes the sheet's own lines: the courtless heading and the check-names reminder", () => {
    expect(article()).toContain(`**${en["sheets.pdf.noCourt"]}**`);
    // The reminder is WHY a Swiss card is safe to reuse after re-pairing; the
    // article quotes it word for word, so a reworded sheet moves this test.
    expect(sentencesOf(article()).join(" ")).toContain(en["sheets.pdf.checkNames"]);
  });

  it("names ONE print button — there is no bare \"Print\" to press after picking the day", () => {
    // The control is a Day select and a single button (print-scorer-sheets.tsx
    // on the print-control branch); the article once said "choose Print scorer
    // sheets, pick the day and press Print", a two-step control that never existed.
    const bare = /\b(?:press|tap|click|choose|hit)\s+Print\b(?!\s+scorer)/i;
    expect(sentences().filter((s) => bare.test(s))).toEqual([]);
  });

  it("says the control appears only once a match has a time — and the upgrade prompt only then too", () => {
    // print-scorer-sheets.tsx returns null with no printable day BEFORE its
    // UpgradeGate branch, so a Community organiser with nothing timed sees
    // neither the button nor the prompt.
    const HAS_TIME = /\bhas a time\b/i;
    expect(sentences().some((s) => /\bcontrol\b/i.test(s) && /\bshows? up\b|\bappears?\b/i.test(s) && HAS_TIME.test(s))).toBe(true);
    const prompt = sentences().filter((s) => /\bupgrade prompt\b/i.test(s));
    expect(prompt, "the upgrade prompt is never mentioned").not.toHaveLength(0);
    expect(prompt.every((s) => HAS_TIME.test(s)), prompt.join(" | ")).toBe(true);
  });

  it("links 'start the division first' to the division lifecycle, as batch-import.md does", () => {
    expect(sentences().some((s) => s.includes("](/help/divisions/lifecycle)") && /\bstart/i.test(s))).toBe(true);
  });

  it("an early scan lands on 'Not started yet', which moves on by itself once the division starts", () => {
    const NOT_STARTED = "Not started yet"; // literal until the screen's key reaches this branch
    const hits = withText(NOT_STARTED);
    expect(hits, `the article never names the ${NOT_STARTED} screen`).not.toHaveLength(0);
    expect(
      hits.some((s) => /\b(?:moves on|updates)\b[^.]*\bby itself\b|\bon its own\b/i.test(s) && /\bstart/i.test(s)),
      hits.join(" | "),
    ).toBe(true);
    // The retired claim: an early card simply "can't score", with no screen
    // and nothing that happens next.
    expect(sentences().filter((s) => /\bcan't score\.?$/i.test(s))).toEqual([]);
  });

  it("an undecided side prints as its place in the draw — the board's own 'Winner of' wording", () => {
    const winnerOf = en["slot.winner_match"].replace(/\s*\{ext\}.*$/, "");
    expect(winnerOf).toMatch(/\w/);
    expect(article()).toContain(winnerOf);
  });

  it("an unpaired Swiss board prints the board's TBD (a Swiss shell has no slot label)", () => {
    // scan-match-names.ts `boardMatchNamer`: an empty seat with no feed and no
    // stored label resolves to `schedule.tbd`.
    const tbd = en["schedule.tbd"];
    expect(tbd).toMatch(/\w/);
    const hits = sentences().filter((s) => /\bunpaired\b/i.test(s) && /\bSwiss\b/.test(s));
    expect(hits, "unpaired Swiss boards are never described").not.toHaveLength(0);
    expect(hits.some((s) => new RegExp(`\\b${tbd}\\b`).test(s)), hits.join(" | ")).toBe(true);
  });
});

describe("scorer-sheets.md quotes the umpire's screens as the phone shows them", () => {
  it("Confirm: the heading and the Start match button", () => {
    expect(article()).toContain(en["device.scan.confirmTitle"]);
    expect(article()).toContain(en["score.startMatch"]);
  });

  it("Waiting: says the page updates by itself", () => {
    expect(article()).toContain(en["device.scan.waitingHint"]);
  });

  it("View-only: quotes one of the reasons the phone gives", () => {
    const lines = Object.values(VIEW_ONLY_COPY).map((k) => en[k]);
    expect(lines.some((l) => article().includes(l)), lines.join(" | ")).toBe(true);
  });

  it("a dead card: the revoked and the not-valid screens", () => {
    expect(article()).toContain(en["device.dead.revoked"]);
    expect(article()).toContain(en["device.dead.invalid"]);
  });
});

describe("scorer-sheets.md says when a printed card stops working — and when it does not", () => {
  it("no day-scoped lifetime anywhere, frontmatter included", () => {
    const offending = sentences().filter((s) =>
      /\bexpir(e|es|ed|y|ing)\b|same[- ]day|local day|day-of|\btoday\b|midnight|end of the day/i.test(s),
    );
    expect(offending).toEqual([]);
  });

  it("a result that moves the competition on turns the card read-only, by each route", () => {
    const body = parts().body;
    // The CONSEQUENCE, in the sentence that states the cause: matching only
    // the vocabulary held with "read-only" gone from the page's claim.
    const movesOn = sentencesOf(body).filter((s) => /moves? the competition on/i.test(s));
    expect(movesOn, "the article never says a result moves the competition on").not.toHaveLength(0);
    expect(movesOn.some((s) => /\bread-only\b/i.test(s)), movesOn.join(" | ")).toBe(true);
    expect(body).toMatch(/next match/i);
    expect(body).toMatch(/next (?:Swiss )?round (?:is|was) paired/i);
    expect(body).toMatch(/stage (?:is|was) completed/i);
  });

  it("Revoke & reissue kills a printed card", () => {
    const hits = withText(en["dlink.reissue"]);
    expect(hits, `no sentence names ${en["dlink.reissue"]}`).not.toHaveLength(0);
    expect(hits.some((s) => DIES.test(s)) || sentences().some((s) => /\bold QR\b/i.test(s) && DIES.test(s))).toBe(true);
  });

  it("Rebuild fixtures kills every card on the stage", () => {
    const hits = withText(en["progression.rosterDrift.rebuildCta"]);
    expect(hits, "Rebuild fixtures is not named").not.toHaveLength(0);
    expect(hits.some((s) => DIES.test(s)), hits.join(" | ")).toBe(true);
  });

  it("deleting the stage, and a Swiss round losing a board, are named too", () => {
    // The STAGE must be the thing deleted: a looser `delet…stage` also matched
    // the Rebuild sentence ("deletes every match in the stage") and held with
    // the stage-delete clause gone.
    expect(sentences().some((s) => /\bdelet(?:e|es|ing)\s+(?:its|the)\s+stage\b/i.test(s))).toBe(true);
    expect(
      sentences().some((s) => /\bSwiss\b/.test(s) && /\b(?:loses?|losing)\s+a\s+board\b|\bremov\w*\s+(?:a\s+)?(?:boards?|match(?:es)?)\b/i.test(s)),
    ).toBe(true);
  });

  it("reprinting gives the same QR codes", () => {
    const PRINT_AGAIN = /\b(?:reprint\w*|print\w* (?:it |the day )?again|every time you print)\b/i;
    const hits = sentences().filter((s) => PRINT_AGAIN.test(s));
    expect(hits, "reprinting is never described").not.toHaveLength(0);
    // ONE sentence carries both halves. "same" + "QR" + "print" anywhere held
    // with the reprint sentence saying "a new QR", because the next clause's
    // "Show QR … shows that same code" supplied the words.
    expect(hits.some((s) => /\bsame\s+QRs?\b/i.test(s)), hits.join(" | ")).toBe(true);
    expect(hits.filter((s) => /\b(?:new|fresh|different|another)\s+(?:QRs?|codes?)\b/i.test(s))).toEqual([]);
  });

  it("a Swiss card belongs to its board: unpairing does NOT delete it", () => {
    const unpair = sentences().filter((s) => /\bunpair\w*\b/i.test(s) && /\bboards?\b/i.test(s));
    expect(unpair, "unpairing is never described").not.toHaveLength(0);
    expect(unpair.some((s) => /\b(?:does not|doesn't|never)\s+delete/i.test(s)), unpair.join(" | ")).toBe(true);
    expect(unpair.filter((s) => /\bunpair\w*\b[^.]*\b(?:deletes|removes)\b/i.test(s))).toEqual([]);
  });
});
