// Task 11b: the Match Day and officials help pages (scheduling section).
//
// Four rules, each taking its expected value from the product's own declaration, never from a number typed here:
//  1. every **bold** phrase on these pages is a string the screen shows (the English dictionary), quoted whole;
//  2. the Documents table says which formats each document comes in, as the menu's own rows declare them;
//  3. the claim link lifetime and the court-stream tail are the constants the code enforces;
//  4. the call sheet page states what a call changes (the called match takes the call's court and time), the sentence
//     that replaced "planned times never move".
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COURT_AUTO_STOP_AFTER_RESULT_SECONDS } from "@/server/relay/config";

const WEB = path.join(__dirname, "../../..");
const PAGES = [
  "match-day",
  "match-day-stream",
  "matchday-documents",
  "officials",
  "officials-assign",
  "officials-my-assignments",
  "official-marks",
  "ai-officials",
] as const;
const page = (slug: string) =>
  readFileSync(path.join(WEB, "content/help/scheduling", `${slug}.md`), "utf8").replace(/^---[\s\S]*?---\n/, "");

const dictDir = path.join(WEB, "src/dictionaries/en");
const DICT_VALUES: string[] = [];
for (const f of readdirSync(dictDir).filter((n) => n.endsWith(".json"))) {
  const j = JSON.parse(readFileSync(path.join(dictDir, f), "utf8")) as Record<string, unknown>;
  for (const v of Object.values(j)) if (typeof v === "string") DICT_VALUES.push(v.replace(/’/g, "'").trim());
}
// A template that is mostly placeholder ("{count}", "{a} {b}") matches any phrase, so it cannot vouch for one: require
// enough literal text around the holes.
const TEMPLATES = DICT_VALUES.filter((v) => v.includes("{") && v.replace(/\{[A-Za-z0-9_]+\}/g, "").trim().length >= 5).map(
  (v) => new RegExp("^" + v.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[A-Za-z0-9_]+\}/g, ".+") + "$"),
);
const DICT_SET = new Set(DICT_VALUES);
/**
 * Bold phrases that are NOT a whole dictionary string, each for a stated reason. The list is closed: a new bold phrase
 * that is neither a dictionary string nor listed here fails the sweep, which is what catches a misquote.
 */
const NOT_A_SCREEN_STRING = new Set([
  // The Example callout's own label.
  "Example",
  // Bold lead-ins and questions that are the page's own words, not screen text.
  "Blackout dates.", "Booked elsewhere.", "On the board.", "On the match page.",
  "Why can't I call a match?", "Where is the Needs you list?", "AI Officials",
  // Screen text assembled from a dictionary string plus a live value (a time, a name, a count) or a glyph the screen draws.
  "4 free", "~", "~19:49", "Call to", "Called at", "Called at 19:19", "3 matches could start here now",
  "referee", "accepted", "5", "✓", "·", "✗", "⚠", "— unavailable", "booked elsewhere", "OFFICIALS", "Marta Quinn",
  "✓ Marta Quinn referee ⚠", "✗ Marta Quinn referee ⚠", "Marta Quinn — unavailable", "New officiating assignment",
  "As Referee", "19 Nov 2026, 13:23 GMT-7", "13:23 GMT-7", "20:23 GMT", "Score this match →",
  "4.0", "AVG · 3", "AVG · 2", "6/6", "5/6",
  // Names of things outside the dictionary: the app's own name in the document masthead, the phone app's screen name, the
  // claim page's heading (rendered upper case by CSS) and the claim button with the official's name.
  "SEAZN CLUB", "Live Stream", "Video ends in", "Stop streaming", "CLAIM YOUR OFFICIATING PROFILE", "This is me — claim",
  "This is me — claim Marta Quinn", "Wrong account for this invite",
]);

function isScreenString(span: string): boolean {
  const s = span.replace(/’/g, "'").trim();
  return [s, s.replace(/[.:]$/, "")].some((c) => DICT_SET.has(c)) || TEMPLATES.some((r) => r.test(s));
}

describe("Match Day and officials pages quote the screen, whole", () => {
  it("every bold phrase is a dictionary string", () => {
    let checked = 0;
    for (const slug of PAGES) {
      const spans = [...page(slug).matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!).filter((s) => !NOT_A_SCREEN_STRING.has(s));
      expect(spans.length, `${slug}: no bold phrases found, the sweep would be vacuous`).toBeGreaterThan(8);
      const missing = spans.filter((s) => !isScreenString(s));
      expect(missing, `${slug}: bold phrases the screen does not show`).toEqual([]);
      checked += spans.length;
    }
    expect(checked, "phrases checked across the eight pages").toBeGreaterThan(200);
  });
});

describe("the Documents table matches the menu's own rows", () => {
  const src = readFileSync(path.join(WEB, "src/components/v2/board/documents-menu.tsx"), "utf8");
  const dict: Record<string, string> = JSON.parse(readFileSync(path.join(dictDir, "ui.json"), "utf8"));

  // Rows are declared as `{ label: msg("documents.x"), ..., xlsx: true|false, [pdf: false] }` inside DocumentsMenu.
  const declared = [...src.matchAll(/label: msg\("(documents\.[A-Za-z]+)"\)([\s\S]*?)\n    \},/g)].map((m) => ({
    label: dict[m[1]!]!,
    pdf: !/pdf: false/.test(m[2]!),
    xlsx: /xlsx: true/.test(m[2]!),
  }));

  it("the menu declares eight rows", () => {
    expect(declared.length).toBe(8);
    for (const d of declared) expect(d.label, "a documents.* key is missing from ui.json").toBeTruthy();
  });

  it("each row's PDF and XLSX cells say what the menu offers", () => {
    const rows = [...page("matchday-documents").matchAll(/^\| \*\*([^*]+)\*\* \| (yes|no) \| (yes|no) \|$/gm)].map((m) => ({
      label: m[1]!,
      pdf: m[2] === "yes",
      xlsx: m[3] === "yes",
    }));
    expect(rows).toEqual(declared);
  });
});

describe("numbers on the pages are the code's constants", () => {
  it("the claim link lasts as many days as person-claims.ts sets", () => {
    const days = Number(/const CLAIM_DAYS = (\d+);/.exec(readFileSync(path.join(WEB, "src/server/usecases/person-claims.ts"), "utf8"))?.[1]);
    expect(Number.isInteger(days), "CLAIM_DAYS not found in person-claims.ts").toBe(true);
    expect(page("officials")).toContain(`The link lasts ${days} days.`);
    expect(page("officials")).toContain(`the newest link lasts ${days} days`);
  });

  it("the court's video ends about as many seconds after the result as the relay config sets", () => {
    expect(COURT_AUTO_STOP_AFTER_RESULT_SECONDS).toBeGreaterThan(0);
    expect(page("match-day-stream")).toContain(`About ${COURT_AUTO_STOP_AFTER_RESULT_SECONDS} seconds after the result`);
  });
});

describe("what a call changes", () => {
  it("says the called match takes the call's court and time, and that other matches keep theirs", () => {
    const md = page("match-day");
    expect(md).toContain("A call moves the match you called, and nothing else.");
    expect(md).toContain("That match takes the court you chose and the time of the call");
    expect(md).toContain("Every other match keeps its planned time.");
    expect(md).not.toMatch(/never move/i);
  });
});
