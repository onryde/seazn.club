// W2c batch-3 M1: the W2c rule-lock refusals (`lib/rule-errors.ts`) reach the organiser in their own language. Each code
// has a dictionary key in all four locales; the server's English IS the en dictionary (one sentence, never two that
// drift); and the client reads the refusal off its CODE and its structured `extra` — never the server's English
// message. Expected sentences are read off the dictionaries, never retyped and never taken from the reader under test.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { classifyActError, rebuildErrorText, undoRefusalMessage } from "@/components/v2/stages-panel";
import { z } from "zod";
import { pointsRuleExpressible } from "@seazn/engine/competition";
import { builtinModules } from "@seazn/engine/sports";
import {
  FIXTURE_LOCK_KEYS,
  FORMAT_FIT_REASONS,
  POINTS_SPLIT_LABEL_KEYS,
  FORMAT_FIT_REASON_KEYS,
  RULE_ERROR_KEYS,
  RULE_ERROR_STATUS,
  RULE_ERROR_SUPPORT_KEYS,
  fitReasonOf,
  ruleErrorMessage,
  ruleRefusalText,
  type RuleErrorCode,
} from "../rule-errors";

const EN = en as unknown as Record<string, string>;
const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;
/** `{name}` placeholders, sorted. */
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** The en sentence for `key` with `vars` filled — the expectation, read off the dictionary. */
const say = (key: string, vars: Record<string, string | number> = {}) =>
  EN[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));

const CODES = Object.keys(RULE_ERROR_STATUS) as RuleErrorCode[];

/** A reader in another language: es, so a pass cannot be the English wire text (whose en copy is the same sentence). */
const ES = es as unknown as Record<string, string>;
const msgEs = (key: string, vars: Record<string, string | number> = {}) =>
  ES[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));

describe("every W2c refusal code has a key, in all four locales", () => {
  it("one key per code (the code table and the key table name the same codes) and per fit reason and lock reason", () => {
    expect(CODES.length, "anti-vacuity: the code table is not empty").toBeGreaterThan(0);
    expect(Object.keys(RULE_ERROR_KEYS).sort()).toEqual([...CODES].sort());
    expect(Object.keys(FORMAT_FIT_REASON_KEYS).sort()).toEqual(Object.keys(FORMAT_FIT_REASONS).sort());
    expect(Object.keys(FIXTURE_LOCK_KEYS).sort()).toEqual(["decided", "finished"]);
  });

  it("each key is present, non-empty, translated, and carries the en placeholders in es/fr/nl (counted)", () => {
    const keys = new Set<string>([
      ...Object.values(RULE_ERROR_KEYS),
      ...Object.values(FORMAT_FIT_REASON_KEYS),
      ...Object.values(FIXTURE_LOCK_KEYS),
      ...Object.values(RULE_ERROR_SUPPORT_KEYS),
      ...Object.values(POINTS_SPLIT_LABEL_KEYS),
    ]);
    let checked = 0;
    for (const key of keys)
      for (const [loc, dict] of LOCALES) {
        const v = (dict as Record<string, string>)[key];
        expect(typeof v === "string" && v.length > 0, `${loc} ${key}`).toBe(true);
        expect(holes(v!), `${loc} ${key} placeholders`).toEqual(holes(EN[key]!));
        // A pure layout key ("{match}: {reason}") has no word to translate; every other key does.
        if (loc !== "en" && /\p{L}/u.test(EN[key]!.replace(/\{\w+\}/g, ""))) expect(v, `${loc} ${key} is translated`).not.toBe(EN[key]);
        checked++;
      }
    expect(checked, "anti-vacuity: every key in every locale").toBe(keys.size * 4);
  });

  it("the fit reasons' en copy IS the server's sentence (the server matches on it: fitReasonOf)", () => {
    let checked = 0;
    for (const [k, sentence] of Object.entries(FORMAT_FIT_REASONS)) {
      expect(EN[FORMAT_FIT_REASON_KEYS[k as keyof typeof FORMAT_FIT_REASONS]], k).toBe(sentence);
      expect(fitReasonOf(sentence), k).toBe(k);
      checked++;
    }
    expect(checked).toBe(3);
    expect(fitReasonOf("the engine's own sentence"), "an engine reason is no fit reason").toBeUndefined();
  });
});

describe("the server's English is the en dictionary", () => {
  it("ruleErrorMessage reads each code's en sentence, with its params", () => {
    const table: [RuleErrorCode, Parameters<typeof ruleErrorMessage>[1], string][] = [
      ["STAGE_FORMAT_LOCKED", { stage: "Pool A" }, say(RULE_ERROR_KEYS.STAGE_FORMAT_LOCKED, { stage: "Pool A" })],
      ["DIVISION_TABLE_RULES_LOCKED", { stage: "Pool A" }, say(RULE_ERROR_KEYS.DIVISION_TABLE_RULES_LOCKED, { stage: "Pool A" })],
      ["DIVISION_FORMAT_LOCKED", { stage: "Pool A" }, say(RULE_ERROR_KEYS.DIVISION_FORMAT_LOCKED, { stage: "Pool A" })],
      ["FIXTURE_FORMAT_LOCKED", {}, say(FIXTURE_LOCK_KEYS.finished)],
      ["FIXTURE_FORMAT_LOCKED", { lock: "decided" }, say(FIXTURE_LOCK_KEYS.decided)],
      ["FORMAT_DOES_NOT_FIT_PLAY", {}, say(RULE_ERROR_KEYS.FORMAT_DOES_NOT_FIT_PLAY)],
      ["FORMAT_DOES_NOT_FIT_PLAY", { reason: FORMAT_FIT_REASONS.ends }, FORMAT_FIT_REASONS.ends],
      ["RULE_NOT_SETTABLE", { field: "bestOf" }, say(RULE_ERROR_KEYS.RULE_NOT_SETTABLE, { field: "bestOf" })],
      ["RULE_NOT_SETTABLE", { field: "bestOf", reason: "it is set per stage" }, say(RULE_ERROR_SUPPORT_KEYS.ruleNotSettableBecause, { field: "bestOf", reason: "it is set per stage" })],
      ["POINTS_RULE_INEXPRESSIBLE", { reason: "x" }, say(RULE_ERROR_KEYS.POINTS_RULE_INEXPRESSIBLE, { reason: "x" })],
      // W2c Task 13: the split keys are named by their labels, never by the raw config key.
      ["POINTS_RULE_INEXPRESSIBLE", { keys: ["otWin", "otLoss"] }, say(RULE_ERROR_KEYS.POINTS_RULE_INEXPRESSIBLE, { reason: say(RULE_ERROR_SUPPORT_KEYS.pointsSplit, { fields: [say(POINTS_SPLIT_LABEL_KEYS.otWin), say(POINTS_SPLIT_LABEL_KEYS.otLoss)].join(", ") }) })],
      ["FIXTURE_HAS_OWN_FORMAT", { match: "Match 3" }, say(RULE_ERROR_KEYS.FIXTURE_HAS_OWN_FORMAT, { match: "Match 3" })],
      ["FIXTURE_OWN_FORMAT_NO_LONGER_FITS", { match: "Match 3" }, say(RULE_ERROR_KEYS.FIXTURE_OWN_FORMAT_NO_LONGER_FITS, { match: "Match 3" })],
      // W2c Task 15: the corrected format as the describer says it; none when the describer has no line for it.
      ["FIXTURE_RULES_CHANGED", { format: "Best of 5 games" }, say(RULE_ERROR_KEYS.FIXTURE_RULES_CHANGED, { format: "Best of 5 games" })],
      ["FIXTURE_RULES_CHANGED", {}, say(RULE_ERROR_SUPPORT_KEYS.fixtureRulesChangedNoLine)],
    ];
    const seen = new Set<string>();
    for (const [code, p, want] of table) {
      expect(ruleErrorMessage(code, p), `${code} ${JSON.stringify(p)}`).toBe(want);
      seen.add(code);
    }
    expect([...seen].sort(), "anti-vacuity: every code was asked").toEqual([...CODES].sort());
  });

  it("the reviewer's case: a bye or an unreproducible award is not called finished", () => {
    expect(ruleErrorMessage("FIXTURE_FORMAT_LOCKED", { lock: "decided" })).not.toBe(ruleErrorMessage("FIXTURE_FORMAT_LOCKED", { lock: "finished" }));
    expect(ruleErrorMessage("FIXTURE_FORMAT_LOCKED", { lock: "decided" }).toLowerCase()).not.toContain("finished");
  });
});

describe("ruleRefusalText — the client reads the code and its extra, in the reader's language", () => {
  const sayEs = msgEs;

  it("each code, with the extra its emitter sends (counted)", () => {
    const table: [RuleErrorCode, Record<string, unknown>, string | null][] = [
      ["STAGE_FORMAT_LOCKED", { stage_name: "Pool A" }, sayEs(RULE_ERROR_KEYS.STAGE_FORMAT_LOCKED, { stage: "Pool A" })],
      ["DIVISION_TABLE_RULES_LOCKED", { refused: [{ field: "tiebreakers", code: "DIVISION_TABLE_RULES_LOCKED", stageId: "s", stageName: "Pool A" }] }, sayEs(RULE_ERROR_KEYS.DIVISION_TABLE_RULES_LOCKED, { stage: "Pool A" })],
      ["DIVISION_FORMAT_LOCKED", { refused: [{ field: "bestOf", code: "DIVISION_FORMAT_LOCKED", stageId: "s", stageName: "Finals" }] }, sayEs(RULE_ERROR_KEYS.DIVISION_FORMAT_LOCKED, { stage: "Finals" })],
      ["FIXTURE_FORMAT_LOCKED", { fixture_id: "f", reason: "finished" }, sayEs(FIXTURE_LOCK_KEYS.finished)],
      ["FIXTURE_FORMAT_LOCKED", { fixture_id: "f", reason: "decided" }, sayEs(FIXTURE_LOCK_KEYS.decided)],
      ["FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fit_reason: "ends" }, sayEs(FORMAT_FIT_REASON_KEYS.ends)],
      ["FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fixture_no: 7, fit_reason: "result" }, sayEs(RULE_ERROR_SUPPORT_KEYS.matchSays, { match: sayEs(RULE_ERROR_SUPPORT_KEYS.match, { n: 7 }), reason: sayEs(FORMAT_FIT_REASON_KEYS.result) })],
      // The engine's own sentence (no fit reason): nothing this app can say better — the caller shows the message.
      ["FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f" }, null],
      ["RULE_NOT_SETTABLE", { fixture_id: "f", field: "bestOf" }, sayEs(RULE_ERROR_KEYS.RULE_NOT_SETTABLE, { field: "bestOf" })],
      ["POINTS_RULE_INEXPRESSIBLE", {}, null],
      // W2c Task 13: its emitter sends the split keys; a key with no label is one this app cannot say (null: the message).
      ["POINTS_RULE_INEXPRESSIBLE", { keys: ["shootoutWin", "shootoutLoss"] }, sayEs(RULE_ERROR_KEYS.POINTS_RULE_INEXPRESSIBLE, { reason: sayEs(RULE_ERROR_SUPPORT_KEYS.pointsSplit, { fields: [sayEs(POINTS_SPLIT_LABEL_KEYS.shootoutWin), sayEs(POINTS_SPLIT_LABEL_KEYS.shootoutLoss)].join(", ") }) })],
      ["POINTS_RULE_INEXPRESSIBLE", { keys: ["shootoutWin", "notAPointsKey"] }, null],
      ["POINTS_RULE_INEXPRESSIBLE", { keys: [] }, null],
      ["FIXTURE_HAS_OWN_FORMAT", { fixture_id: "f", fixture_no: 3 }, sayEs(RULE_ERROR_KEYS.FIXTURE_HAS_OWN_FORMAT, { match: sayEs(RULE_ERROR_SUPPORT_KEYS.match, { n: 3 }) })],
      ["FIXTURE_HAS_OWN_FORMAT", { fixture_id: "f", fixture_no: null }, sayEs(RULE_ERROR_KEYS.FIXTURE_HAS_OWN_FORMAT, { match: sayEs(RULE_ERROR_SUPPORT_KEYS.thisMatch) })],
      ["FIXTURE_OWN_FORMAT_NO_LONGER_FITS", { fixture_id: "f", fixture_no: 3, field: "extraTime" }, sayEs(RULE_ERROR_KEYS.FIXTURE_OWN_FORMAT_NO_LONGER_FITS, { match: sayEs(RULE_ERROR_SUPPORT_KEYS.match, { n: 3 }) })],
      // W2c Task 15: `extra.format` is the server's (en) line — never spliced into the reader's sentence; the reader's own
      // line arrives with the reload (GET /fixtures/{id}/rules).
      ["FIXTURE_RULES_CHANGED", { rules_version: 1, format: "Best of 5 games" }, sayEs(RULE_ERROR_SUPPORT_KEYS.fixtureRulesChangedNoLine)],
      ["FIXTURE_RULES_CHANGED", { rules_version: 1, format: null }, sayEs(RULE_ERROR_SUPPORT_KEYS.fixtureRulesChangedNoLine)],
    ];
    const seen = new Set<string>();
    let localized = 0;
    for (const [code, extra, want] of table) {
      const got = ruleRefusalText(code, extra, msgEs as never);
      expect(got, `${code} ${JSON.stringify(extra)}`).toBe(want);
      if (got !== null) {
        localized++;
        expect(got, `${code}: not the English`).not.toBe(say(RULE_ERROR_KEYS[code]));
      }
      seen.add(code);
    }
    expect([...seen].sort(), "anti-vacuity: every code was asked").toEqual([...CODES].sort());
    expect(localized, "both answers are witnessed").toBe(table.filter((r) => r[2] !== null).length);
    expect(localized).toBeGreaterThan(0);
  });

  it("empty case first: no code, an unknown code, or a missing param is null (the caller keeps its own copy)", () => {
    expect(ruleRefusalText(undefined, {}, msg)).toBeNull();
    expect(ruleRefusalText("PLAYED", {}, msg)).toBeNull();
    expect(ruleRefusalText("DIVISION_FORMAT_LOCKED", {}, msg)).toBeNull();
    expect(ruleRefusalText("RULE_NOT_SETTABLE", {}, msg)).toBeNull();
    expect(ruleRefusalText("STAGE_FORMAT_LOCKED", {}, msg)).toBeNull();
  });
});

describe("stages-panel reads the code, not the English (M1: undo, rebuild, and the act fallback)", () => {
  const own = (status = 409) =>
    new ApiV1Error("Match 3 has its own format, and this would delete it — set it back to its stage's format first.", status, "FIXTURE_HAS_OWN_FORMAT", {
      fixture_id: "f",
      fixture_no: 3,
    });
  // Read in es: the server's message IS the en sentence, so an en reader could not tell the code from the message.
  const want = msgEs(RULE_ERROR_KEYS.FIXTURE_HAS_OWN_FORMAT, { match: msgEs(RULE_ERROR_SUPPORT_KEYS.match, { n: 3 }) });

  it("Undo: the refusal reads its dictionary sentence", () => {
    expect(undoRefusalMessage(own(), msgEs as never)).toBe(want);
  });

  it("Rebuild: the refusal reads its dictionary sentence; an unrecognised one keeps its message, a non-Error the generic", () => {
    expect(rebuildErrorText(own(), msgEs as never)).toBe(want);
    expect(rebuildErrorText(new ApiV1Error("division is mid-solve", 409, "BUSY"), msg)).toBe("division is mid-solve");
    expect(rebuildErrorText("nope", msg)).toBe(say("schedule.error.failed"));
  });

  it("a generate/complete/delete refusal (classifyActError) reads it too, and an unrecognised one keeps its message", () => {
    expect(classifyActError(own(), msgEs as never, "es")).toMatchObject({ text: want });
    expect(classifyActError(new ApiV1Error("division is mid-solve", 409, "BUSY"), msg, "en").text).toBe("division is mid-solve");
  });
});

describe("W2c Task 13 — every split key the engine refuses a stage rule over has a label, in all four locales", () => {
  it("the label table is exactly the keys pointsRuleExpressible refuses, across every sport's declared points (counted)", () => {
    // The candidates are each sport's OWN declaration (its config schema's `points` keys, and `pointsMap` where it declares
    // one); which of them split is the engine's answer (`pointsRuleExpressible`), never a list typed here.
    const split = new Set<string>();
    let candidates = 0;
    for (const m of builtinModules) {
      const props = (z.toJSONSchema(m.configSchema as z.ZodType, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, { properties?: Record<string, unknown> }> }).properties ?? {};
      for (const k of Object.keys(props.points?.properties ?? {})) {
        candidates++;
        const got = pointsRuleExpressible({ points: { [k]: 1 } });
        if (!got.ok) for (const key of got.keys) split.add(key);
      }
      if (props.pointsMap !== undefined) {
        candidates++;
        const got = pointsRuleExpressible({ pointsMap: { "2-0": [3, 0], "2-1": [2, 1] } });
        if (!got.ok) for (const key of got.keys) split.add(key);
      }
    }
    expect(candidates, "anti-vacuity: the sports declare points").toBeGreaterThan(0);
    expect(split.size, "anti-vacuity: some declared key splits").toBeGreaterThan(0);
    expect(Object.keys(POINTS_SPLIT_LABEL_KEYS).sort(), "a label for every split key, and none for a key that never splits").toEqual([...split].sort());
  });
});
