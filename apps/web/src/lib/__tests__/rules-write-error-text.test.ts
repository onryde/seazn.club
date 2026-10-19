// W2c Task 19 (fix round 1, review M2) - a failed RULES write is said in the reader's language at every control that makes
// one: the match block's Save and "Use stage rules", the stage row's Save and "Use division rules". `apps/web` vitest has no
// DOM, so a click that fails cannot be driven here; the helper is tested for what it says, and a scan of the two components
// proves every rules write they make lands its catch on the helper (the stage row's "Use division rules" `clear()` had no
// test at all, and kept a hand-copied line the Save's twin could drift from).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import { type MessageKey } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { rulesWriteErrorText } from "../config-issue-copy";
import { FORMAT_FIT_REASON_KEYS, RULE_ERROR_SUPPORT_KEYS } from "../rule-errors";

const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;
type Dict = Record<string, string>;
const reader = (dict: Dict) => (key: MessageKey, vars: Record<string, string | number> = {}): string =>
  dict[key]!.replace(/\{(\w+)\}/g, (h, name: string) => (name in vars ? String(vars[name]) : h));

describe("rulesWriteErrorText", () => {
  it("a refusal reads in the reader's language off its code, never as the wire's English (4 locales, counted)", () => {
    const wire = "Match 3: This format would change the score as it stands";
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const m = reader(dict as Dict);
      const err = new ApiV1Error(wire, 409, "FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f", fixture_no: 3, fit_reason: "score" });
      const got = rulesWriteErrorText(err, m);
      expect(got, loc).toBe(m("rules.err.matchSays", { match: m("rules.err.match", { n: 3 }), reason: m(FORMAT_FIT_REASON_KEYS.score) }));
      if (loc !== "en") expect(got, `${loc} is not the English wire text`).not.toBe(wire);
      // The engine's-own-reason shape is framed in the locale's words.
      const own = new ApiV1Error("x", 409, "FORMAT_DOES_NOT_FIT_PLAY", { fixture_id: "f" });
      expect(rulesWriteErrorText(own, m), `${loc} framed`).toBe(m(RULE_ERROR_SUPPORT_KEYS.formatDoesNotFitPlayBecause, { reason: "x" }));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("an error that is not a rule refusal keeps its message; a non-Error says the generic failure in the reader's language (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const m = reader(dict as Dict);
      expect(rulesWriteErrorText(new Error("boom"), m), loc).toBe("boom");
      expect(rulesWriteErrorText("x", m), `${loc} fallback`).toBe(m("schedule.error.failed"));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("every rules write the block and the stage row make says its failure through the helper (source scan)", () => {
  const V2 = resolve(__dirname, "../../components/v2");
  const source = (file: string): string => readFileSync(resolve(V2, file), "utf8");
  const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;
  /** A catch whose argument is `err` and whose body hands the helper that same `err` (the whole catch body, one level). */
  const CATCH_ON_HELPER = /catch \(err\) \{[^{}]*setError\(rulesWriteErrorText\(err, msg\)\)/g;

  it.each([
    ["match-rules-block.tsx", /`\/api\/v1\/fixtures\/\$\{fixtureId\}\/rules`/g, 1],
    ["stages-panel.tsx", /`\/api\/v1\/stages\/\$\{stageId\}\/rules`/g, 2],
  ] as const)("%s: each rules PUT has a catch on the helper (counted)", (file, writes, expected) => {
    const text = source(file);
    expect(count(text, writes), `${file}: the rules writes it makes (Save and the reset)`).toBe(expected);
    expect(count(text, CATCH_ON_HELPER), `${file}: catches on the helper`).toBe(expected);
    // Neither keeps the hand-copied reader that this helper replaced.
    expect(text.includes("settingsSaveErrorText("), `${file} reads a failed rules write only through the helper`).toBe(false);
  });
});
