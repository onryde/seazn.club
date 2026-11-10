// Match Day PB2 (owner 2026-11-02, "apply rec", option A): the billing freeze — a competition over its organisation's
// `competitions.max_active` — keeps every write it guards EXCEPT scoring. This is the ledger of where the guard stands, read off
// the source, and of the behavioural test that proves each site still answers its 402:
//   - every call of `assertNotFrozen` / `assertCompetitionNotFrozen` outside the guard's own file is a SITE, named
//     `file#function` (the function the call sits in);
//   - the sites found must be exactly the ledger below — a guard dropped from a write, or a new one added without a witness,
//     reds here;
//   - scoring.ts carries none: PB2 took the freeze off the scoring door on purpose (scoring-frozen-competition.test.ts);
//   - each entry names a test file and the words of the test that drives that site into the 402, and both must exist.
// Pure: reads files, no database.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const GUARD_HOME = "server/usecases/entitlement-freeze.ts";

/** A call (never the definition, never a comment) of either guard. */
const CALL = /(?<![\w.])(assertNotFrozen|assertCompetitionNotFrozen)\(/;
/** A named scope a guard can sit in: a function declaration, or a `const`/`let` bound to an arrow function (one line). */
const NAMED_SCOPE = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/,
  /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=]+?)?=>/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "__capture__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The guard calls in one source, each named by the scope whose BODY contains it (fix round 1, m2: by brace depth, not
 *  "the last function declared above" — a guard in an arrow bound after a function is the arrow's, and one past a function's
 *  closing brace is not that function's). A scope's body opens on the first line, from its declaration on, that ENDS with
 *  `{` outside the parentheses opened since that declaration — so a parameter's object type (`opts: {`, inside the parameter list) or a return type's
 *  (`Promise<{ … }> {` ends with the body's own brace) is not taken for it — and closes when the depth falls below it. A
 *  guard in no named scope is `<module>`. Strings and comments are blanked first; a template literal's `${…}` balances. */
export function sitesIn(source: string): string[] {
  const found: string[] = [];
  const open: { name: string; body: number | null; parens: number }[] = [];
  let depth = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""').replace(/\/\/.*$/, "");
    for (const re of NAMED_SCOPE) {
      const m = re.exec(code);
      if (m) {
        open.push({ name: m[1]!, body: null, parens: 0 });
        break;
      }
    }
    if (CALL.test(code) && !/function\s+assert(?:Competition)?NotFrozen\b/.test(code)) {
      found.push(open.at(-1)?.name ?? "<module>");
    }
    const top = open.at(-1);
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (top && top.body === null && ch === "(") top.parens++;
      else if (top && top.body === null && ch === ")") top.parens--;
    }
    // Parentheses are counted from the scope's own declaration on, so nothing earlier in the file can unbalance them.
    if (top && top.body === null && top.parens === 0 && code.trimEnd().endsWith("{")) top.body = depth;
    while (open.length > 0 && open.at(-1)!.body !== null && depth < open.at(-1)!.body!) open.pop();
  }
  return found;
}

/** Every guard site in the app, as `file#function` (file relative to src/server/usecases when it lives there). */
function guardSites(): string[] {
  const sites: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path);
    if (rel === GUARD_HOME) continue;
    const file = rel.startsWith("server/usecases/") ? rel.slice("server/usecases/".length) : rel;
    for (const fn of sitesIn(readFileSync(path, "utf8"))) sites.push(`${file}#${fn}`);
  }
  return sites.sort();
}

const SWEEP = "server/usecases/__tests__/frozen-competition-writes.test.ts";
const REGISTRATIONS = "server/usecases/__tests__/registration-approval.test.ts";
const REG_SWEEP = "refuses approve, confirm, mark-paid and confirm-waived on a frozen competition";
const CALLS = "refuses a frozen competition's call, Undo and preview with the guard's own 402";

/** site → [the test file, words that test's own title or table carries]. The sweep file names each site by its key. */
const LEDGER: Record<string, [file: string, words: string]> = {
  "competition-schedule-ai/orchestrator.ts#planForCompetition": [
    "server/usecases/__tests__/competition-schedule-ai-route.test.ts",
    "a frozen COMPETITION → 402 competitions.max_active, before any spend",
  ],
  "competition-schedule-apply.ts#applyCompetitionSchedule": [SWEEP, '"competition-schedule-apply.ts#applyCompetitionSchedule"'],
  "competitions.ts#patchCompetition": [SWEEP, '"competitions.ts#patchCompetition"'],
  "divisions.ts#createDivision": [SWEEP, '"divisions.ts#createDivision"'],
  "entrants.ts#createEntrants": [SWEEP, '"entrants.ts#createEntrants"'],
  "event-import.ts#runImport": [
    "server/usecases/__tests__/event-import-freeze.test.ts",
    "402s the whole call and writes NOTHING when the division's competition is frozen",
  ],
  "fixture-rules.ts#writeFixtureRulesOverride": [SWEEP, '"fixture-rules.ts#writeFixtureRulesOverride"'],
  "match-day-call.ts#callFixtureToCourt": ["server/usecases/__tests__/match-day-call.test.ts", CALLS],
  "match-day-call.ts#previewCall": ["server/usecases/__tests__/match-day-call.test.ts", CALLS],
  "match-day-call.ts#undoCall": ["server/usecases/__tests__/match-day-call.test.ts", CALLS],
  "registration-approval.ts#approveRegistration": [REGISTRATIONS, REG_SWEEP],
  "registration-approval.ts#promoteFromWaitlist": [REGISTRATIONS, "refuses promote on a frozen competition"],
  "registration-approval.ts#rejectRegistration": [REGISTRATIONS, "refuses reject on a frozen competition"],
  "registrations/organiser-actions.ts#confirmRegistration": [REGISTRATIONS, REG_SWEEP],
  "registrations/organiser-actions.ts#confirmRegistrationWaived": [REGISTRATIONS, REG_SWEEP],
  "registrations/organiser-actions.ts#markRegistrationPaidOffline": [REGISTRATIONS, REG_SWEEP],
  "schedule-ai-preview.ts#resolveCompetitionScope": [SWEEP, '"schedule-ai-preview.ts#resolveCompetitionScope"'],
  "schedule/apply.ts#applySchedule": [SWEEP, '"schedule/apply.ts#applySchedule"'],
  "schedule/move.ts#moveFixture": [SWEEP, '"schedule/move.ts#moveFixture"'],
  "schedule/publish.ts#publishSchedule": [SWEEP, '"schedule/publish.ts#publishSchedule"'],
  "schedule/settings.ts#putScheduleSettings": [SWEEP, '"schedule/settings.ts#putScheduleSettings"'],
  "schedule/publish.ts#startDivision": [SWEEP, '"schedule/publish.ts#startDivision"'],
  "stage-rules.ts#putStageRules": [
    "server/usecases/__tests__/stage-rules.test.ts",
    "402s when the competition is frozen by the billing quota",
  ],
  "stages/stage-graph.ts#deleteStage": [SWEEP, '"stages/stage-graph.ts#deleteStage"'],
  "stages/stage-graph.ts#insertStageBatch": [SWEEP, '"stages/stage-graph.ts#insertStageBatch"'],
  // PB2 item 2 + fix round 1 (a): the ONE start seam — the organiser's Go live, the phone's start and the automatic start
  // all come through it — so no NEW stream starts by any path; reads and Stop never pass here. The HTTP 402 of the
  // organiser's door is witnessed in routes.test.ts ("PB2 over HTTP: on a FROZEN competition a Go live is 402").
  "stream-sessions.ts#startBroadcast": [
    "server/usecases/__tests__/stream-auto.test.ts",
    "Match Day PB2 (a): a billing-frozen competition starts no new stream",
  ],
};

describe("the billing freeze's guard sites (PB2: every write but scoring)", () => {
  const sites = guardSites();

  it("the sites in the source are exactly the ledger — none dropped, none added without a witness", () => {
    expect(sites.length, "anti-vacuity: the scan found guard sites").toBeGreaterThan(0);
    expect(sites).toEqual(Object.keys(LEDGER).sort());
  });

  it("the scoring door carries no freeze guard (PB2, option A), and the scan would see one there if it did", () => {
    expect(sites.filter((s) => s.startsWith("scoring.ts#"))).toEqual([]);
    // The scan's positive control: the same rules find the guard in a sibling write that keeps it.
    expect(sites).toContain("schedule/move.ts#moveFixture");
    // And the file is still the scoring door the ruling is about (its entitlement function stands, without the freeze).
    const scoring = readFileSync(join(SRC, "server/usecases/scoring.ts"), "utf8");
    expect(scoring).toContain("async function assertEntitledToScore(");
    expect(scoring).not.toMatch(CALL);
    expect(scoring).not.toContain("frozenCompetitionIds(");
  });

  it("fix round 1 (m2): a guard is named by the scope whose BODY holds it — an arrow bound after a function is the arrow's, a guard past a function's closing brace is not that function's, a nested callback is its enclosing function's", () => {
    const cases: [string, string[]][] = [
      [["async function a() {", "  await assertNotFrozen(f, c);", "}"].join("\n"), ["a"]],
      [["async function a() {", "  return 1;", "}", "const b = async (x: string) => {", "  await assertCompetitionNotFrozen(o, c);", "};"].join("\n"), ["b"]],
      [["function a() {", "  if (x) { y(); }", "}", "await assertNotFrozen(f, c);"].join("\n"), ["<module>"]],
      [["export async function a() {", "  await list.map(async (r) => {", "    await assertNotFrozen(f, r);", "  });", "}"].join("\n"), ["a"]],
      [["function a() {", '  const s = "}";', "  // } a brace in a comment", "  assertNotFrozen(f, c);", "}"].join("\n"), ["a"]],
      [["export async function a(", "  actor: Actor,", "  opts: {", "    id: string;", "  },", "): Promise<{ id: string }> {", "  await assertCompetitionNotFrozen(o, c);", "}"].join("\n"), ["a"]],
    ];
    let checked = 0;
    for (const [source, want] of cases) {
      expect(sitesIn(source), source).toEqual(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("each site's witness test exists and carries the words that name it", () => {
    let checked = 0;
    for (const [site, [file, words]] of Object.entries(LEDGER)) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(text.includes(words), `${site}: ${file} does not carry "${words}"`).toBe(true);
      // A witness proves the 402, so it must read the freeze's own key or status.
      expect(/competitions\.max_active|402|PaymentRequiredError/.test(text), `${site}: ${file} never asserts the 402`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: witnesses checked").toBe(Object.keys(LEDGER).length);
  });
});
