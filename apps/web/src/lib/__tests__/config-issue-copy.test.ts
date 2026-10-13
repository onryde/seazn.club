// W2c owner P-5 (fix round 1): a refused match-rules save names its problem. The wire carries CONFIG_INVALID's issues
// (server/api-v1/http.ts); this is the reader that turns them into the sentence the organiser sees, localized where this
// app owns the sentence. Expected values come from the engine's own constants and the dictionaries, never retyped.
import { describe, expect, it } from "vitest";
import { SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS } from "@seazn/engine/sport";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
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

describe("the share-on-abandon refusals are localized in all four locales (not the English wire text)", () => {
  it("every sentence this app owns maps to a key present in en/es/fr/nl, non-empty, and translated", () => {
    expect(LOCALIZED_CONFIG_ISSUES.size, "the map carries both refusals").toBe(2);
    expect([...LOCALIZED_CONFIG_ISSUES.keys()].sort()).toEqual([SHARE_NEEDS_DRAWN_GAME, SHARE_NEEDS_DRAWS].sort());
    let checked = 0;
    for (const key of LOCALIZED_CONFIG_ISSUES.values())
      for (const [loc, dict] of [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const) {
        const v = (dict as Record<string, string>)[key];
        expect(v, `${loc} ${key}`).toBeTruthy();
        if (loc !== "en") expect(v, `${loc} ${key} is translated`).not.toBe((en as Record<string, string>)[key]);
        checked++;
      }
    expect(checked).toBe(8);
  });

  it("the English carrom copy IS the owner's sentence (ruling), and both sentences name the setting to change", () => {
    expect(en["rules.err.shareNeedsDrawnGame"]).toBe(SHARE_NEEDS_DRAWN_GAME);
    expect(en["rules.err.shareNeedsDrawnGame"]).toContain("'Game tied at max boards'");
    expect(en["rules.err.shareNeedsDrawnGame"]).toContain("'Drawn game'");
    expect(en["rules.err.shareNeedsDraws"]).toContain("'Allow draws'");
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
