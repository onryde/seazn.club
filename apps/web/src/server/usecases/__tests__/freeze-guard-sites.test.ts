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
const FUNCTION = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "__capture__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every guard site in the app, as `file#function` (file relative to src/server/usecases when it lives there). */
function guardSites(): string[] {
  const sites: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path);
    if (rel === GUARD_HOME) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    let fn: string | null = null;
    for (const line of lines) {
      const declared = FUNCTION.exec(line);
      if (declared) fn = declared[1]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const code = line.replace(/\/\/.*$/, "");
      if (!CALL.test(code) || /function\s+assert(?:Competition)?NotFrozen\b/.test(code)) continue;
      const file = rel.startsWith("server/usecases/") ? rel.slice("server/usecases/".length) : rel;
      sites.push(`${file}#${fn ?? "<module>"}`);
    }
  }
  return sites.sort();
}

const SWEEP = "server/usecases/__tests__/frozen-competition-writes.test.ts";
const REGISTRATIONS = "server/usecases/__tests__/registration-approval.test.ts";
const REG_SWEEP = "refuses approve, confirm, mark-paid and confirm-waived on a frozen competition";
const CALLS = "refuses a frozen competition's call, Undo and preview with the guard's own 402";

/** site → [the test file, words that test's own title or table carries]. The sweep file names each site by its key. */
const LEDGER: Record<string, [file: string, words: string]> = {
  "competition-schedule-ai.ts#planForCompetition": [
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
  "registrations.ts#confirmRegistration": [REGISTRATIONS, REG_SWEEP],
  "registrations.ts#confirmRegistrationWaived": [REGISTRATIONS, REG_SWEEP],
  "registrations.ts#markRegistrationPaidOffline": [REGISTRATIONS, REG_SWEEP],
  "schedule-ai-preview.ts#resolveCompetitionScope": [SWEEP, '"schedule-ai-preview.ts#resolveCompetitionScope"'],
  "schedule.ts#applySchedule": [SWEEP, '"schedule.ts#applySchedule"'],
  "schedule.ts#moveFixture": [SWEEP, '"schedule.ts#moveFixture"'],
  "schedule.ts#publishSchedule": [SWEEP, '"schedule.ts#publishSchedule"'],
  "schedule.ts#putScheduleSettings": [SWEEP, '"schedule.ts#putScheduleSettings"'],
  "schedule.ts#startDivision": [SWEEP, '"schedule.ts#startDivision"'],
  "stage-rules.ts#putStageRules": [
    "server/usecases/__tests__/stage-rules.test.ts",
    "402s when the competition is frozen by the billing quota",
  ],
  "stages.ts#deleteStage": [SWEEP, '"stages.ts#deleteStage"'],
  "stages.ts#insertStageBatch": [SWEEP, '"stages.ts#insertStageBatch"'],
  // PB2 item 2: the organiser's Go live — a NEW stream — not its reads or its Stop.
  "stream-sessions.ts#createSession": [
    "app/api/v1/fixtures/[id]/stream-sessions/__tests__/routes.test.ts",
    "PB2 over HTTP: on a FROZEN competition a Go live is 402 competitions.max_active",
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
    expect(sites).toContain("schedule.ts#moveFixture");
    // And the file is still the scoring door the ruling is about (its entitlement function stands, without the freeze).
    const scoring = readFileSync(join(SRC, "server/usecases/scoring.ts"), "utf8");
    expect(scoring).toContain("async function assertEntitledToScore(");
    expect(scoring).not.toMatch(CALL);
    expect(scoring).not.toContain("frozenCompetitionIds(");
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
