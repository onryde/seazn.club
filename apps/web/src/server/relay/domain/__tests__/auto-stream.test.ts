// Capture QR v2 PR-2 T2 (spec §7.2 auto start, §7.3 auto stop; W7, A4, A12, A15, A16). Pure predicates, `now` passed in.
//
// Every conjunct of each predicate is FALSIFIED ALONE: the verdict must name exactly that conjunct and no other. Two
// guards that cover for each other are each untested (AGENTS.md #3), so a dependent conjunct (the 180 s delay, the
// pre/post-result comparison) HOLDS vacuously while there is no result — `fixture_finished` is the one that says there
// must be one — and deleting any single conjunct flips a row below.
//
// The conjunct COUNT and the refusal vocabulary are read out of the spec's own text, never typed here.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the predicates read a fixture's status string, a few timestamps and a
// switch — nothing in them knows a sport; the status sweep below covers every status the fixtures table can hold.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_START_RETRY_SECONDS, AUTO_STOP_AFTER_RESULT_SECONDS } from "../../config";
import {
  AUTO_START_CONJUNCTS, AUTO_START_REFUSALS, AUTO_STOP_CONJUNCTS, autoStartVerdict, autoStopVerdict,
  type AutoStartFacts, type AutoStopFacts,
} from "../auto-stream";

const ROOT = resolve(import.meta.dirname, "../../../../../../..");
const SPEC = readFileSync(resolve(ROOT, "docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md"), "utf8");
const V430 = readFileSync(resolve(ROOT, "db/migration/deltas/V430__capture_stream_codes.sql"), "utf8");

/** The clauses of the spec's predicate block that opens at `head` (`auto_stream` then each `AND …` line). */
function specClauses(head: string): string[] {
  const block = SPEC.split(head)[1]?.split("```")[0] ?? "";
  return block.split("\n").map((l) => l.trim()).filter((l) => /^(AND\s|auto_stream\b)/.test(l));
}

const NOW = new Date("2026-10-07T12:00:00Z");
const ms = (seconds: number) => seconds * 1000;
const ago = (milliseconds: number) => new Date(NOW.getTime() - milliseconds);

// ---- auto start -------------------------------------------------------------------------------------------------
const START_BASE: AutoStartFacts = {
  autoStream: true, phoneMode: "automatic", phonePresent: true, fixtureStatus: "in_play", openSession: false,
  autoStartedAt: null, autoStartBlockedAt: null, anySessionHadIngest: false, autoStartAttemptedAt: null,
};
/** Each row falsifies exactly ONE conjunct; `conjunct` is the name that must be the only failure. */
const START_FALSIFY: { conjunct: string; patch: Partial<AutoStartFacts> }[] = [
  { conjunct: "switch_on", patch: { autoStream: false } },
  { conjunct: "phone_automatic", patch: { phoneMode: "operator" } },
  { conjunct: "phone_automatic", patch: { phoneMode: null } },
  { conjunct: "phone_present", patch: { phonePresent: false } },
  { conjunct: "in_play", patch: { fixtureStatus: "scheduled" } },
  { conjunct: "in_play", patch: { fixtureStatus: "decided" } },
  { conjunct: "no_open_session", patch: { openSession: true } },
  { conjunct: "not_yet_started", patch: { autoStartedAt: ago(1) } },
  { conjunct: "not_blocked", patch: { autoStartBlockedAt: ago(1) } },
  { conjunct: "no_broadcast_ran", patch: { anySessionHadIngest: true } },
  { conjunct: "retry_spacing", patch: { autoStartAttemptedAt: ago(ms(AUTO_START_RETRY_SECONDS) - 1000) } },   // 59 s
];

describe("autoStartVerdict (§7.2)", () => {
  it("the table has one conjunct per line of the spec's autoStartDue, and unique names (anti-vacuity)", () => {
    const clauses = specClauses("autoStartDue =");
    expect(clauses.length).toBe(9);
    expect(AUTO_START_CONJUNCTS.length).toBe(clauses.length);
    expect(new Set(AUTO_START_CONJUNCTS.map((c) => c.name)).size).toBe(AUTO_START_CONJUNCTS.length);
  });

  it("the base facts are due (the positive pair)", () => {
    expect(autoStartVerdict(START_BASE, NOW, AUTO_START_RETRY_SECONDS)).toEqual({ due: true, failed: [] });
  });

  it("every conjunct, falsified alone, is the only failure — and no conjunct goes unfalsified", () => {
    let checked = 0;
    for (const row of START_FALSIFY) {
      const v = autoStartVerdict({ ...START_BASE, ...row.patch }, NOW, AUTO_START_RETRY_SECONDS);
      expect(v, row.conjunct + JSON.stringify(row.patch)).toEqual({ due: false, failed: [row.conjunct] });
      checked++;
    }
    // Anti-vacuity against the SPEC's own list, not the table's length: every clause of `autoStartDue` owns at least one row
    // (two own two), so the rows run are at least the clauses read and the conjuncts they name are exactly the table's.
    const clauses = specClauses("autoStartDue =").length;
    expect(clauses).toBe(9);
    expect(new Set(START_FALSIFY.map((r) => r.conjunct)).size).toBe(clauses);
    expect(checked).toBeGreaterThanOrEqual(clauses);
    expect(new Set(START_FALSIFY.map((r) => r.conjunct))).toEqual(new Set(AUTO_START_CONJUNCTS.map((c) => c.name)));
  });

  it("only in_play starts: every other status the fixtures table holds is refused by in_play alone", () => {
    // 'scheduled' and 'in_play' are the live pair; the rest is V430's own finished set (declared, not typed here).
    const finished = /new\.status in \(([^)]*)\)/.exec(V430)?.[1]?.match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    expect(finished.length).toBe(5);
    let checked = 0;
    for (const status of ["scheduled", ...finished]) {
      expect(autoStartVerdict({ ...START_BASE, fixtureStatus: status }, NOW, AUTO_START_RETRY_SECONDS), status)
        .toEqual({ due: false, failed: ["in_play"] });
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("EMPTY: a fixture with no settings row and no phone (switch off, mode null, not present) is never due and names exactly those three conjuncts", () => {
    const v = autoStartVerdict({ ...START_BASE, autoStream: false, phoneMode: null, phonePresent: false }, NOW, AUTO_START_RETRY_SECONDS);
    expect(v.due).toBe(false);
    expect(v.failed).toEqual(["switch_on", "phone_automatic", "phone_present"]);
  });

  it("every conjunct failing at once lists ALL of them in table order — the verdict does not stop at the first", () => {
    const worst: AutoStartFacts = {
      autoStream: false, phoneMode: null, phonePresent: false, fixtureStatus: "scheduled", openSession: true,
      autoStartedAt: ago(1), autoStartBlockedAt: ago(1), anySessionHadIngest: true, autoStartAttemptedAt: ago(1000),
    };
    const v = autoStartVerdict(worst, NOW, AUTO_START_RETRY_SECONDS);
    expect(v.due).toBe(false);
    expect(v.failed).toEqual(AUTO_START_CONJUNCTS.map((c) => c.name));
    expect(v.failed.length).toBe(9);
  });

  it("retry spacing: 59 s since the last attempt is not due, exactly 60 s is, and 61 s is (boundary from AUTO_START_RETRY_SECONDS)", () => {
    const at = (secondsAgo: number) =>
      autoStartVerdict({ ...START_BASE, autoStartAttemptedAt: ago(ms(secondsAgo)) }, NOW, AUTO_START_RETRY_SECONDS);
    expect(at(AUTO_START_RETRY_SECONDS - 1)).toEqual({ due: false, failed: ["retry_spacing"] });
    expect(at(AUTO_START_RETRY_SECONDS)).toEqual({ due: true, failed: [] });
    expect(at(AUTO_START_RETRY_SECONDS + 1)).toEqual({ due: true, failed: [] });
  });

  it("retry spacing reads the PASSED seconds, not the default: with a 5 s window 4 s is not due and 5 s is (tunable() shortens it)", () => {
    expect(AUTO_START_RETRY_SECONDS).not.toBe(5);   // the case must differ from the default's answer
    const at = (secondsAgo: number) => autoStartVerdict({ ...START_BASE, autoStartAttemptedAt: ago(ms(secondsAgo)) }, NOW, 5);
    expect(at(4)).toEqual({ due: false, failed: ["retry_spacing"] });
    expect(at(5)).toEqual({ due: true, failed: [] });
  });

  it("the spec's refusal vocabulary is AUTO_START_REFUSALS (declared by §7.2, not typed here)", () => {
    const listed = /On a refusal\*\* \(([^)]*)\)/.exec(SPEC)?.[1]?.split(",").map((s) => s.trim().replace(/ /g, "_")) ?? [];
    expect(listed.length).toBe(5);
    expect([...AUTO_START_REFUSALS].sort()).toEqual([...listed].sort());
  });

  it("a second call answers the same and never mutates its facts (frozen input)", () => {
    const facts = Object.freeze({ ...START_BASE, autoStartAttemptedAt: Object.freeze(ago(ms(90))) as Date });
    const first = autoStartVerdict(facts, NOW, AUTO_START_RETRY_SECONDS);
    expect(autoStartVerdict(facts, NOW, AUTO_START_RETRY_SECONDS)).toEqual(first);
    expect(first).toEqual({ due: true, failed: [] });
  });
});

// ---- auto stop --------------------------------------------------------------------------------------------------
const FINISHED_AT = ago(ms(AUTO_STOP_AFTER_RESULT_SECONDS) + 20_000);   // 200 s ago: the delay has elapsed
const STOP_BASE: AutoStopFacts = {
  autoStream: true, phoneMode: "automatic", finishedAt: FINISHED_AT, sessionCreatedAt: new Date(FINISHED_AT.getTime() - 60_000),
};
const STOP_FALSIFY: { conjunct: string; patch: Partial<AutoStopFacts> }[] = [
  { conjunct: "switch_on", patch: { autoStream: false } },
  { conjunct: "phone_automatic", patch: { phoneMode: "operator" } },
  { conjunct: "phone_automatic", patch: { phoneMode: null } },
  { conjunct: "fixture_finished", patch: { finishedAt: null } },
  { conjunct: "delay_elapsed", patch: { finishedAt: ago(ms(AUTO_STOP_AFTER_RESULT_SECONDS) - 1000), sessionCreatedAt: ago(ms(AUTO_STOP_AFTER_RESULT_SECONDS) + 60_000) } },   // 179 s
  { conjunct: "session_predates_result", patch: { sessionCreatedAt: FINISHED_AT } },                                          // equal
  { conjunct: "session_predates_result", patch: { sessionCreatedAt: new Date(FINISHED_AT.getTime() + 1) } },                 // one ms after
];

describe("autoStopVerdict (§7.3)", () => {
  it("the table has one conjunct per line of the spec's autoStopDue, and unique names (anti-vacuity)", () => {
    const clauses = specClauses("autoStopDue(session) =");
    expect(clauses.length).toBe(5);
    expect(AUTO_STOP_CONJUNCTS.length).toBe(clauses.length);
    expect(new Set(AUTO_STOP_CONJUNCTS.map((c) => c.name)).size).toBe(AUTO_STOP_CONJUNCTS.length);
  });

  it("the base facts are due (the positive pair)", () => {
    expect(autoStopVerdict(STOP_BASE, NOW, AUTO_STOP_AFTER_RESULT_SECONDS)).toEqual({ due: true, failed: [] });
  });

  it("every conjunct, falsified alone, is the only failure — and no conjunct goes unfalsified", () => {
    let checked = 0;
    for (const row of STOP_FALSIFY) {
      const v = autoStopVerdict({ ...STOP_BASE, ...row.patch }, NOW, AUTO_STOP_AFTER_RESULT_SECONDS);
      expect(v, row.conjunct + JSON.stringify(row.patch)).toEqual({ due: false, failed: [row.conjunct] });
      checked++;
    }
    const clauses = specClauses("autoStopDue(session) =").length;
    expect(clauses).toBe(5);
    expect(new Set(STOP_FALSIFY.map((r) => r.conjunct)).size).toBe(clauses);
    expect(checked).toBeGreaterThanOrEqual(clauses);
    expect(new Set(STOP_FALSIFY.map((r) => r.conjunct))).toEqual(new Set(AUTO_STOP_CONJUNCTS.map((c) => c.name)));
  });

  it("EMPTY: a fixture with no result (finishedAt null) and no switch is never due, however old the session", () => {
    const v = autoStopVerdict({ autoStream: false, phoneMode: null, finishedAt: null, sessionCreatedAt: ago(ms(3600)) }, NOW, AUTO_STOP_AFTER_RESULT_SECONDS);
    expect(v.due).toBe(false);
    expect(v.failed).toEqual(["switch_on", "phone_automatic", "fixture_finished"]);
  });

  it("every conjunct that CAN fail together lists ALL of them in table order — all but fixture_finished, which excludes the two that read the result", () => {
    const v = autoStopVerdict(
      { autoStream: false, phoneMode: "operator", finishedAt: ago(1000), sessionCreatedAt: NOW },
      NOW, AUTO_STOP_AFTER_RESULT_SECONDS,
    );
    expect(v.due).toBe(false);
    expect(v.failed).toEqual(AUTO_STOP_CONJUNCTS.map((c) => c.name).filter((n) => n !== "fixture_finished"));
    expect(v.failed.length).toBe(4);
  });

  it("the delay: 179 s after the result is not due, exactly 180 s is, 181 s is (boundary from AUTO_STOP_AFTER_RESULT_SECONDS)", () => {
    const at = (secondsSinceResult: number) => {
      const finishedAt = ago(ms(secondsSinceResult));
      return autoStopVerdict({ ...STOP_BASE, finishedAt, sessionCreatedAt: new Date(finishedAt.getTime() - 1) }, NOW, AUTO_STOP_AFTER_RESULT_SECONDS);
    };
    expect(at(AUTO_STOP_AFTER_RESULT_SECONDS - 1)).toEqual({ due: false, failed: ["delay_elapsed"] });
    expect(at(AUTO_STOP_AFTER_RESULT_SECONDS)).toEqual({ due: true, failed: [] });
    expect(at(AUTO_STOP_AFTER_RESULT_SECONDS + 1)).toEqual({ due: true, failed: [] });
  });

  it("the delay reads the PASSED seconds, not the default: with a 5 s delay 4 s is not due and 5 s is", () => {
    expect(AUTO_STOP_AFTER_RESULT_SECONDS).not.toBe(5);
    const at = (secondsSinceResult: number) => {
      const finishedAt = ago(ms(secondsSinceResult));
      return autoStopVerdict({ ...STOP_BASE, finishedAt, sessionCreatedAt: new Date(finishedAt.getTime() - 1) }, NOW, 5);
    };
    expect(at(4)).toEqual({ due: false, failed: ["delay_elapsed"] });
    expect(at(5)).toEqual({ due: true, failed: [] });
  });

  // The ordering differential (A15): the SAME facts, every other conjunct holding, flip on the session's creation
  // relative to the result — a broadcast started after the result is the organiser's deliberate post-match one.
  it("ORDERING: a session created one ms before the result is stopped; at the same instant or one ms after it is never", () => {
    const finishedAt = ago(ms(AUTO_STOP_AFTER_RESULT_SECONDS) + 5000);
    const withSession = (offsetMs: number) =>
      autoStopVerdict({ ...STOP_BASE, finishedAt, sessionCreatedAt: new Date(finishedAt.getTime() + offsetMs) }, NOW, AUTO_STOP_AFTER_RESULT_SECONDS);
    expect(withSession(-1)).toEqual({ due: true, failed: [] });
    expect(withSession(0)).toEqual({ due: false, failed: ["session_predates_result"] });
    expect(withSession(1)).toEqual({ due: false, failed: ["session_predates_result"] });
  });

  it("a second call answers the same and never mutates its facts (frozen input)", () => {
    const facts = Object.freeze({ ...STOP_BASE });
    const first = autoStopVerdict(facts, NOW, AUTO_STOP_AFTER_RESULT_SECONDS);
    expect(autoStopVerdict(facts, NOW, AUTO_STOP_AFTER_RESULT_SECONDS)).toEqual(first);
    expect(first).toEqual({ due: true, failed: [] });
  });
});
