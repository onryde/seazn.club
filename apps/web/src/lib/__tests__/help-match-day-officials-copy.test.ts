// Task 11b: the Match Day and officials help pages (scheduling section).
//
// Four rules, each taking its expected value from the product's own declaration, never from a number typed here:
//  1. every **bold** phrase on these pages is a string the screen shows (the English dictionary), quoted whole;
//  2. the Documents table says which formats each document comes in, as the menu's own rows declare them;
//  3. the claim link lifetime and the court-stream tail are the constants the code enforces;
//  4. the call sheet page states what a call changes (the called match takes the call's court and time), the sentence
//     that replaced "planned times never move";
//  5. (fix round 1) the roles the page names are the roles the code declares, the Match Day code sheet's choices are the
//     dictionary's, the email subjects are the dictionary's, and one match move is still the only place that queues
//     the "Match moved" email.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COURT_AUTO_STOP_AFTER_RESULT_SECONDS } from "@/server/relay/config";
import { EDITOR_ROLES, ORG_ROLES } from "@/lib/types";

const WEB = path.join(__dirname, "../../..");
const PAGES = [
  "match-day",
  "match-day-scorers",
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
  // A Match Day code's list row, which the sheet composes from the scope's words or the courts' names, the day and the
  // powers' words; and the venue and court names the example gives them.
  "Always:", "Hall A", "Court 2", "Court 3", "Hall A · Today · Approves pairings and brackets", "Court 2, Court 3 · Today",
  "Whole competition · Opens Fri 20 Nov",
  // Screen text assembled from a dictionary string plus a live value (a time, a name, a count) or a glyph the screen draws.
  "3 free", "~", "~19:49", "Call to", "Called at", "Called at 19:19", "3 matches could start here now",
  "referee", "accepted", "5", "✓", "·", "✗", "⚠", "✕", "— unavailable", "booked elsewhere", "OFFICIALS", "Marta Quinn",
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
    expect(checked, "phrases checked across the nine pages").toBeGreaterThan(200);
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
    expect(md).toContain("It takes the court you chose and the time of the call");
    expect(md).toContain("Every other match keeps its planned time.");
    expect(md).not.toMatch(/never move/i);
  });
});

describe("who runs the day", () => {
  const md = page("match-day");
  const editors = [...EDITOR_ROLES];
  const others = ORG_ROLES.filter((r) => !(editors as readonly string[]).includes(r));

  it("names the roles the code declares as editors and the rest as Viewer", () => {
    expect(editors.length, "no editor roles declared: the check would be vacuous").toBeGreaterThan(0);
    expect(others.length, "no read-only role declared: the check would be vacuous").toBeGreaterThan(0);
    expect(editors.length, "the page sentence is written for exactly two editor roles").toBe(2);
    const cap = (r: string) => r[0]!.toUpperCase() + r.slice(1);
    expect(md).toContain(`${cap(editors[0]!)}s and ${editors[1]}s run the day.`);
    for (const r of others) expect(md).toContain(`A ${r[0]!.toUpperCase() + r.slice(1)} in your organisation`);
  });

  it("names no role the code does not have", () => {
    expect(md).not.toMatch(/\beditors?\b/i);
  });
});

describe("the Match Day code page quotes the sheet", () => {
  const ui: Record<string, string> = JSON.parse(readFileSync(path.join(dictDir, "ui.json"), "utf8"));
  const sc = page("match-day-scorers");

  it("names every scope and both ticks the sheet offers, in bold", () => {
    const keys = Object.keys(ui).filter((k) => /^matchDay\.code\.scope\.(competition|venue|courts)$/.test(k));
    expect(keys.length, "the sheet's three scope choices").toBe(3);
    for (const k of [...keys, "matchDay.code.approve", "matchDay.code.call", "matchDay.code.mint", "matchDay.code.list"]) {
      expect(ui[k], `${k} missing from ui.json`).toBeTruthy();
      expect(sc, `${k} not quoted`).toContain(`**${ui[k]}**`);
    }
  });

  it("states the day window the sheet's own hint states", () => {
    const hint = ui["matchDay.code.dayHint"]!;
    const window = /from (\d\d:\d\d to \d\d:\d\d)/.exec(hint)?.[1];
    expect(window, "no window in the day hint").toBeTruthy();
    expect(sc).toContain(`The code works from ${window} on its day`);
  });

  it("says a Viewer does not see the button, which the shell hides for read-only readers", () => {
    const shell = readFileSync(path.join(WEB, "src/components/v2/match-day/match-day-shell.tsx"), "utf8");
    expect(shell).toMatch(/\{!readOnly && \(\s*<button[^>]*data-testid="md-code-open"/);
    expect(sc).toContain("A Viewer does not see the **Match Day code** button.");
  });
});

describe("the officials emails", () => {
  const emails: Record<string, string> = JSON.parse(readFileSync(path.join(dictDir, "emails.json"), "utf8"));
  const org = "Riverside Club";
  const fill = (k: string) => emails[k]!.replace("{orgName}", org);

  it("quotes both subjects as the dictionary words them", () => {
    const assign = page("officials-assign");
    for (const k of ["officialAssigned.subject", "officialChanged.subject"]) {
      expect(emails[k], `${k} missing from emails.json`).toBeTruthy();
      expect(assign, `${k} not quoted`).toContain(`**${fill(k)}**`);
    }
  });

  it("one match move is the only place that queues the Match moved email, and the page says so", () => {
    const root = path.join(WEB, "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__" && e.name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(e.name) && /kind: "official_assignment_changed"/.test(readFileSync(full, "utf8"))) {
          hits.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(hits, "the sites that queue official_assignment_changed").toEqual(["server/usecases/schedule/move.ts"]);
    expect(page("officials-assign")).toContain("when you move one match to another time or court");
  });
});
