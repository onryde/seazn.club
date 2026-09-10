// The bar's live cell is CAPPED at 480 px (product ruling 2026-09-10,
// `_THEMES.md` §3). Measured in a browser at 1920×1080 the cell grew with its
// context line — 225 px at "RIV won", 312 px at "Riverside won by 44 runs",
// 610 px at a full-name result sentence — taking each team cell down to 509 px.
// Nothing wrapped and nothing overflowed the page, so this is a balance
// question rather than a defect: a scorebug's job is the score, and its caption
// must never dominate the frame.
//
// `apps/web` vitest is `environment: "node"`: this can see what `globals.css`
// DECLARES and nothing about what a browser paints. It cannot witness the cap
// taking effect, the clip, or the team cells keeping their width — that is the
// visual pass's to sign off. What it can own is that the declaration exists,
// matches the sheet's number rather than a number typed in here, and was not
// implemented by truncating the team names instead.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = join(HERE, "../../../app/globals.css");
const SHEET_PATH = join(HERE, "../../../../../..", "docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");

/** Non-throwing, so a missing sheet lands on the named read below instead of
 *  collapsing collection into a vacuous green (`contrast.test.ts`'s posture). */
function sheet(): string {
  try {
    return readFileSync(SHEET_PATH, "utf8");
  } catch {
    return "";
  }
}

/** §3's inset block: `live cell: min-width 225, MAX-WIDTH 480, …`. The SHEET
 *  is the authority for both numbers — a literal typed in here would keep
 *  asserting yesterday's value the moment the ruling moves. */
function sheetLiveCell(): { min?: number; max?: number } {
  const text = sheet();
  const start = text.indexOf("\n## 3. Theme A");
  if (start < 0) return {};
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  const line = section.split("\n").find((l) => l.includes("live cell:"));
  if (line === undefined) return {};
  const min = line.match(/min-width\s+(\d+)/i)?.[1];
  const max = line.match(/max-width\s+(\d+)/i)?.[1];
  return { min: min ? Number(min) : undefined, max: max ? Number(max) : undefined };
}

const CSS = readFileSync(GLOBALS_CSS, "utf8");

/** The body of one CSS rule, by exact selector. Throws for a missing selector
 *  rather than returning "" — an absent rule must red, not silently satisfy a
 *  "does not contain" assertion. Same helper shape as
 *  `bug-clock-and-brand.test.tsx`'s. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`globals.css declares no \`${selector}\` rule`);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  if (close < 0) throw new Error(`\`${selector}\` rule is unterminated`);
  return CSS.slice(open + 1, close);
}

describe("the live cell's 480 px cap (_THEMES.md §3)", () => {
  // The empty case first: every assertion below reads a number out of the
  // sheet, and an unparsed sheet would make each of them compare undefined
  // against undefined.
  it("the sheet still declares both numbers on §3's live-cell line", () => {
    expect(() => readFileSync(SHEET_PATH, "utf8"), `_THEMES.md at ${SHEET_PATH}`).not.toThrow();
    const { min, max } = sheetLiveCell();
    expect(min, "§3's live-cell line no longer states a min-width").toBeGreaterThan(0);
    expect(max, "§3's live-cell line no longer states a MAX-WIDTH").toBeGreaterThan(0);
    expect(max, "a cap under the floor would collapse the cell").toBeGreaterThan(min!);
  });

  it("`.ovl-live-cell` declares the sheet's max-width, beside the min-width it already had", () => {
    const body = ruleBody(".ovl-live-cell");
    const { min, max } = sheetLiveCell();
    expect(body, "the cap is missing — the cell still grows with its caption").toContain(`max-width: ${max}px`);
    expect(body, "the floor moved with the cap").toContain(`min-width: ${min}px`);
  });

  it("past the cap the CONTEXT LINE clips — it does not wrap the cell taller", () => {
    // §3: "Past the cap the line clips". Without this the cap turns a
    // one-line caption into a two-line one inside a fixed 126 px band, which
    // trades one composition defect for another.
    const body = ruleBody(".ovl-context");
    expect(body).toContain("white-space: nowrap");
    expect(body).toContain("overflow: hidden");
  });

  it("team names still never truncate — the cap is on the caption, not on them", () => {
    // The negative pair. Capping the caption and truncating the names would
    // satisfy "the score is not squeezed" while breaking §1's ladder, which
    // is unchanged and applies to names.
    const body = ruleBody(".ovl-team-name");
    expect(body, "§1's ladder shrinks a long name, it never clips one").toContain("white-space: nowrap");
    expect(body).not.toContain("text-overflow");
    expect(body).not.toContain("overflow: hidden");
    // And the team cells are still the ones that absorb the width the cap
    // gives back — the whole reason the cap is worth having.
    expect(ruleBody(".ovl-team-cell")).toContain("flex: 1 1 auto");
  });
});
