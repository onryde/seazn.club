// W2c owner P-5 (fix round 1): a refused match-rules save names its problem. The wire carries CONFIG_INVALID's issues
// (server/api-v1/http.ts); this is the reader that turns them into the sentence the organiser sees, localized where this
// app owns the sentence. Expected values come from the engine's own constants and the dictionaries, never retyped.
import { describe, expect, it } from "vitest";
import {
  BO1_MATCH_TIEBREAK,
  MAX_OVERS_PER_BOWLER_EXCEEDS_INNINGS,
  MIN_OVERS_FOR_RESULT_EXCEEDS_INNINGS,
  SET_TARGET_BELOW_FLOOR,
  SHARE_NEEDS_DRAWN_GAME,
  SHARE_NEEDS_DRAWS,
  setTargetBelowFloor,
} from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { ApiV1Error } from "@/lib/client-v1";
import { msg, type MessageKey } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LOCALIZED_CONFIG_ISSUES, configIssueText, configIssuesOf, settingsSaveErrorText } from "../config-issue-copy";

const invalid = (issues: unknown) => new ApiV1Error("invalid carrom config", 422, "CONFIG_INVALID", { issues });

describe("configIssuesOf", () => {
  it("empty cases first: nothing usable is null", () => {
    for (const data of [undefined, null, 4, {}, { issues: [] }, { issues: "x" }, { issues: [{ path: ["a"] }, { message: "" }, { message: 3 }, null, "x"] }])
      expect(configIssuesOf(data), JSON.stringify(data)).toBeNull();
  });
  it("keeps path and message, drops entries with no message, and drops path segments that are not string or number", () => {
    expect(configIssuesOf({ issues: [{ path: ["abandonPolicy", 0, {}], message: "a", input: "secret" }, { message: "b" }, { path: ["x"] }] })).toEqual([
      { path: ["abandonPolicy", 0], message: "a" },
      { path: [], message: "b" },
    ]);
  });
});

// W2e Task 13 (VB-CF-1, TT-CF-1, TN-CF-1): the write-door refusals of ruling 31 and RB2A-13 join the share-on-abandon ones.
// W2e T33a adds cricket's two over-count refusals (schema messages, localized the same way).
const CRICKET_OVERS = [MAX_OVERS_PER_BOWLER_EXCEEDS_INNINGS, MIN_OVERS_FOR_RESULT_EXCEEDS_INNINGS];
const OWNED = [SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS, SET_TARGET_BELOW_FLOOR, BO1_MATCH_TIEBREAK, ...CRICKET_OVERS];

describe("the config refusals this app owns are localized in all four locales (not the English wire text)", () => {
  it("every sentence this app owns maps to a key present in en/es/fr/nl, non-empty, and translated", () => {
    expect(LOCALIZED_CONFIG_ISSUES.size, "the map carries every refusal").toBe(OWNED.length);
    expect([...LOCALIZED_CONFIG_ISSUES.keys()].sort()).toEqual([...OWNED].sort());
    let checked = 0;
    for (const key of LOCALIZED_CONFIG_ISSUES.values())
      for (const [loc, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
        const v = (dict as Record<string, string>)[key];
        expect(v, `${loc} ${key}`).toBeTruthy();
        if (loc !== "en") expect(v, `${loc} ${key} is translated`).not.toBe((en as Record<string, string>)[key]);
        checked++;
      }
    expect(checked).toBe(OWNED.length * 4);
  });

  it("each sentence maps to ITS key: the English copy opens with the engine's own sentence, so the pairing cannot be swapped", () => {
    let checked = 0;
    for (const [sentence, key] of LOCALIZED_CONFIG_ISSUES) {
      if (CRICKET_OVERS.includes(sentence)) {
        // Cricket's two are schema messages written in the field's key ("maxOversPerBowler exceeds ..."): the dictionary says it in
        // words, so the pairing is witnessed by the field both name instead.
        const field = sentence.split(" ")[0]!;
        expect(key.toLowerCase(), `${key} is about ${field}`).toContain(field.toLowerCase());
        checked++;
        continue;
      }
      // The engine's sentence ends in a full stop; the dictionary copy may carry the setting to change after it.
      expect((en as Record<string, string>)[key]!.startsWith(sentence.replace(/\.$/, "")), `${key} opens with its engine sentence`).toBe(true);
      checked++;
    }
    expect(checked, "every refusal was checked").toBe(OWNED.length);
    // The engine sentences are all different, so a swapped pairing cannot satisfy every row above.
    expect(new Set(OWNED).size).toBe(OWNED.length);
  });

  it("the English carrom copy IS the owner's sentence (ruling), and both sentences name the setting to change", () => {
    expect(en["rules.err.shareNeedsDrawnGame"]).toBe(SHARE_NEEDS_DRAWN_GAME);
    expect(en["rules.err.shareNeedsDrawnGame"]).toContain("'Game tied at max boards'");
    expect(en["rules.err.shareNeedsDrawnGame"]).toContain("'Drawn game'");
    expect(en["rules.err.shareNeedsDraws"]).toContain("'Allow draws'");
  });

  it("VB-CF-1 TT-CF-1 TN-CF-1 the English write-door copy IS the engine's sentence, and every locale takes the floor from it", () => {
    expect(en["rules.err.setTargetBelowFloor"]).toBe(SET_TARGET_BELOW_FLOOR);
    expect(en["rules.err.bo1MatchTiebreak"]).toBe(BO1_MATCH_TIEBREAK);
    let checked = 0;
    for (const [loc, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
      // Fix round 1 (review M-2): the floor is a slot, never a number a translation could retype or drop.
      const copy = (dict as Record<string, string>)["rules.err.setTargetBelowFloor"]!;
      expect(copy, loc).toContain("{min}");
      expect(copy, loc).not.toMatch(/\d/);
      checked++;
    }
    expect(checked).toBe(4);
    // What a refused division save reads, through the wire's own envelope: ruling 31's sentence, as the engine says it.
    const refused = new ApiV1Error("invalid volleyball config", 422, "CONFIG_INVALID", { issues: [{ path: [], message: setTargetBelowFloor(5) }] });
    expect(settingsSaveErrorText(refused, msg, "fallback")).toBe(setTargetBelowFloor(5));
    expect(configIssueText({ path: [], message: BO1_MATCH_TIEBREAK }, msg)).toBe(msg("rules.err.bo1MatchTiebreak"));
  });

  it("the floor's number is READ from the engine's sentence, in every locale: a floor of 7 reads 7 (fix round 1, review M-2)", () => {
    const localOf = (dict: unknown) => (key: MessageKey, vars?: Record<string, string | number>) =>
      (dict as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
    let checked = 0;
    for (const [loc, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
      const local = localOf(dict);
      for (const floor of [5, 7]) {
        const text = configIssueText({ path: [], message: setTargetBelowFloor(floor) }, local);
        expect(text, `${loc} ${floor}`).toContain(String(floor));
        expect(text, `${loc} ${floor}: the slot is filled`).not.toContain("{min}");
        if (loc !== "en") expect(text, `${loc} ${floor} is translated`).not.toBe(setTargetBelowFloor(floor));
        checked++;
      }
    }
    expect(checked).toBe(8);
    // The template matches only a number in its slot; anything else is not this app's sentence and reads as the engine said
    // (read through a TRANSLATED locale: the English copy is the template, so a wrong match would read the same in en).
    const odd = SET_TARGET_BELOW_FLOOR.replace("{min}", "five");
    expect(configIssueText({ path: [], message: odd }, localOf(es))).toBe(odd);
    const longer = `${setTargetBelowFloor(5)} And more.`;
    expect(configIssueText({ path: [], message: longer }, localOf(es))).toBe(longer);
  });

  // The seam, through its real producer: the cricket schema's own refusal of each over count, read back through the wire's
  // envelope, is the sentence this app localizes - a constant matching a message the schema never emits would be inert.
  it("T33a cricket: a bowler cap or a result floor longer than the innings is refused by the REAL schema, and the refusal reads in each locale", () => {
    const cricket = builtinModules.find((m) => m.key === "cricket")!;
    const t20 = cricket.variants.t20 as Record<string, unknown>;
    const innings = (cricket.configSchema.parse(t20) as { ballsPerInnings: number; ballsPerOver: number }).ballsPerInnings / 6;
    expect(Number.isInteger(innings) && innings > 0, "premise: the t20 innings is a whole number of overs").toBe(true);
    const cases: [string, Record<string, unknown>, string][] = [
      ["maxOversPerBowler", { ...t20, maxOversPerBowler: innings + 1 }, MAX_OVERS_PER_BOWLER_EXCEEDS_INNINGS],
      ["minOversForResult", { ...t20, minOversForResult: innings + 1 }, MIN_OVERS_FOR_RESULT_EXCEEDS_INNINGS],
    ];
    const localOf = (dict: unknown) => (key: MessageKey, vars?: Record<string, string | number>) =>
      (dict as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
    let checked = 0;
    for (const [field, cfg, sentence] of cases) {
      // The positive pair: the same cfg at the innings length is accepted.
      expect(cricket.configSchema.safeParse({ ...cfg, [field]: innings }).success, `${field} at the innings length is accepted`).toBe(true);
      const parsed = cricket.configSchema.safeParse(cfg);
      expect(parsed.success, `${field} over the innings is refused`).toBe(false);
      if (parsed.success) continue;
      const wire = invalid(parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
      expect(configIssuesOf((wire as { extra?: unknown }).extra)?.map((i) => i.message), `${field}: the schema says the constant`).toContain(sentence);
      for (const [loc, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
        const text = settingsSaveErrorText(wire, localOf(dict), "fallback");
        expect(text, `${loc} ${field}`).toBe((dict as Record<string, string>)[LOCALIZED_CONFIG_ISSUES.get(sentence)!]);
        expect(text, `${loc} ${field}: not the engine's English wire text`).not.toBe(sentence);
        checked++;
      }
    }
    expect(checked, "cases x locales").toBe(8);
  });

  it("settingsSaveErrorText: a known issue reads its localized sentence; an unknown one reads the engine's own message", () => {
    const known = invalid([{ path: ["abandonPolicy"], message: SHARE_NEEDS_DRAWN_GAME }]);
    expect(settingsSaveErrorText(known, msg, "fallback")).toBe(msg("rules.err.shareNeedsDrawnGame"));
    const other = invalid([{ path: ["gameTo"], message: "gameTo must be at least 1" }]);
    expect(settingsSaveErrorText(other, msg, "fallback")).toBe("gameTo must be at least 1");
    expect(configIssueText({ path: [], message: SHARE_NEEDS_DRAWS }, msg)).toBe(msg("rules.err.shareNeedsDraws"));
  });

  it("several issues read in order, joined; sequence: a refused save then a different refusal then a success-shaped non-error", () => {
    const two = invalid([
      { path: ["abandonPolicy"], message: SHARE_NEEDS_DRAWS },
      { path: ["gameTo"], message: "gameTo must be at least 1" },
    ]);
    expect(settingsSaveErrorText(two, msg, "fallback")).toBe(`${msg("rules.err.shareNeedsDraws")} gameTo must be at least 1`);
  });

  it("no issues (or not a CONFIG_INVALID): the error's own message, then the fallback for a non-Error", () => {
    expect(settingsSaveErrorText(new ApiV1Error("invalid generic config", 422, "CONFIG_INVALID", {}), msg, "fallback")).toBe("invalid generic config");
    expect(settingsSaveErrorText(new ApiV1Error("nope", 409, "STAGE_FORMAT_LOCKED", { issues: [{ message: SHARE_NEEDS_DRAWS }] }), msg, "fallback")).toBe("nope");
    expect(settingsSaveErrorText("boom", msg, "fallback")).toBe("fallback");
    expect(settingsSaveErrorText(undefined, msg, "fallback")).toBe("fallback");
  });
});
