// W2c Task 19 (carry from batch 3) - a FORMAT_DOES_NOT_FIT_PLAY refusal reaches the organiser in their own language, in
// the match block AND in the division and stage editors (they all read a failed save through `settingsSaveErrorText`).
// Two shapes: the refusal names a fit reason (`extra.fit_reason`, the sentence the app owns - batch-3 M1's
// `ruleRefusalText`), or it carries only the ENGINE's own English reason, which the app cannot say better but can frame in
// the reader's language. Expected sentences are read off the dictionaries, never retyped.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { msg as enMsg, type MessageKey } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { settingsSaveErrorText } from "../config-issue-copy";
import {
  FORMAT_FIT_REASONS,
  FORMAT_FIT_REASON_KEYS,
  RULE_ERROR_STATUS,
  RULE_ERROR_SUPPORT_KEYS,
  ruleRefusalSentence,
  ruleRefusalText,
  type FormatFitReason,
} from "../rule-errors";

const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;
type Dict = Record<string, string>;
/** A reader in a locale: the dictionary's sentence with the placeholders filled. */
const reader = (dict: Dict) => (key: MessageKey, vars: Record<string, string | number> = {}): string =>
  dict[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));

const ENGINE_REASON = "Cannot start extra time: the half-time break is still open";

describe("ruleRefusalSentence", () => {
  it("an engine's own reason is framed in the reader's language, in every locale (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const m = reader(dict as Dict);
      const got = ruleRefusalSentence("FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f" }, ENGINE_REASON, m);
      const want = m(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: ENGINE_REASON });
      expect(got, loc).toBe(want);
      expect(got, `${loc} carries the engine's reason`).toContain(ENGINE_REASON);
      // The frame is the locale's own words, not the English wire text.
      if (loc !== "en") expect(got, `${loc} is not the English frame`).not.toBe(enMsg(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: ENGINE_REASON }));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a refusal that names a fit reason is the app's own sentence in the reader's language, not the frame", () => {
    let checked = 0;
    for (const reason of Object.keys(FORMAT_FIT_REASONS) as FormatFitReason[])
      for (const [loc, dict] of LOCALES) {
        const m = reader(dict as Dict);
        const got = ruleRefusalSentence("FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fit_reason: reason }, FORMAT_FIT_REASONS[reason], m);
        expect(got, `${loc} ${reason}`).toBe(m(FORMAT_FIT_REASON_KEYS[reason]));
        expect(got, `${loc} ${reason} is not wrapped in the engine frame`).not.toContain(FORMAT_FIT_REASONS[reason] + " ");
        checked++;
      }
    expect(checked).toBe(Object.keys(FORMAT_FIT_REASONS).length * 4);
  });

  it("a stage or division save names the match: 'Match 3' leads the sentence, in the reader's language", () => {
    const m = reader(es as Dict);
    const got = ruleRefusalSentence("FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fixture_no: 3, fit_reason: "score" }, "Match 3: x", m);
    expect(got).toBe(m("rules.err.matchSays", { match: m("rules.err.match", { n: 3 }), reason: m(FORMAT_FIT_REASON_KEYS.score) }));
  });

  it("any other code keeps batch 3's answer (ruleRefusalText), and a code it does not know is null (the caller keeps its copy)", () => {
    const m = reader(es as Dict);
    expect(ruleRefusalSentence("FIXTURE_FORMAT_LOCKED", { reason: "finished" }, "x", m)).toBe(ruleRefusalText("FIXTURE_FORMAT_LOCKED", { reason: "finished" }, m));
    expect(ruleRefusalSentence("CONFIG_INVALID", {}, "invalid", m)).toBeNull();
    expect(ruleRefusalSentence(undefined, undefined, "x", m)).toBeNull();
    // The frame is for FORMAT_DOES_NOT_FIT_PLAY alone: no other rule code with no localized text borrows it.
    for (const code of Object.keys(RULE_ERROR_STATUS)) {
      if (code === "FORMAT_DOES_NOT_FIT_PLAY") continue;
      const s = ruleRefusalSentence(code, undefined, ENGINE_REASON, m);
      if (s !== null) expect(s, code).not.toContain(m(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: ENGINE_REASON }));
    }
  });

  it("the engine's reason is never dropped: an empty message falls back to the code's own sentence (null here)", () => {
    expect(ruleRefusalSentence("FORMAT_DOES_NOT_FIT_PLAY", {}, "", reader(es as Dict))).toBeNull();
  });
});

describe("the editors' failed-save text goes through it (settingsSaveErrorText)", () => {
  it("a 409 FORMAT_DOES_NOT_FIT_PLAY from a stage or division save reads in Spanish, not as the wire's English message", () => {
    const m = reader(es as Dict);
    const wire = "Match 3: This format would change the score as it stands";
    const err = new ApiV1Error(wire, 409, "FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fixture_no: 3, fit_reason: "score" });
    const got = settingsSaveErrorText(err, m, "fallback");
    expect(got).not.toBe(wire);
    expect(got).toBe(m("rules.err.matchSays", { match: m("rules.err.match", { n: 3 }), reason: m(FORMAT_FIT_REASON_KEYS.score) }));
    // And the engine's-own-reason shape: framed in Spanish around the engine's English reason.
    const own = new ApiV1Error(`Match 3: ${ENGINE_REASON}`, 409, "FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fixture_no: 3 });
    expect(settingsSaveErrorText(own, m, "fallback")).toBe(m(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: `Match 3: ${ENGINE_REASON}` }));
  });

  it("an error that is not a rule refusal still reads as before (CONFIG_INVALID issues, a plain Error, a non-Error)", () => {
    const m = reader(en as Dict);
    expect(settingsSaveErrorText(new Error("boom"), m, "fallback")).toBe("boom");
    expect(settingsSaveErrorText("x", m, "fallback")).toBe("fallback");
    expect(settingsSaveErrorText(new ApiV1Error("bad", 422, "CONFIG_INVALID", { issues: [{ path: ["a"], message: "a is wrong" }] }), m, "fallback")).toBe("a is wrong");
  });
});
