// W2c Task 20 (S4, X-SR-4 UI half) - which of the settings form's fields a started stage locks, and what the form says.
//
// The pure half: `lockLineFor` (a field's lock, by its key or by any engine key it edits), `mergeLocks` (the loader's list
// and the save response's), `lockSentence` (the dictionary's, in the reader's language) and `refusedLines` (what a save kept, one
// line per control the organiser can see). Where each expected value comes from: the refusal shapes are `RefusedField`'s own, the
// fields and the keys they edit are the SPORT_RULES table (the declaration the form renders), and every sentence is read
// from the en dictionary - none is typed here.
import { describe, expect, it } from "vitest";
import { SPORT_RULES } from "@/lib/match-rules";
import type { RefusedField } from "@/lib/rule-errors";
import { msg as enMsg } from "@/lib/messages";
import enUi from "@/dictionaries/en/ui.json";
import {
  RULE_LOCK_KEYS,
  RULE_LOCK_PARTIAL_KEY,
  lockLineFor,
  lockSentence,
  mergeLocks,
  refusedLines,
} from "../division-settings-locks";

const topOf = (path: string): string => path.split(".")[0]!;
const refusal = (field: string, over: Partial<RefusedField> = {}): RefusedField => ({
  field,
  code: "DIVISION_FORMAT_LOCKED",
  stageId: "stage-a",
  stageName: "Pool A",
  ...over,
});

describe("lockLineFor", () => {
  it("locks the division format with its name", () => {
    const line = lockLineFor("variant_key", [refusal("variant_key")]);
    expect(line).toEqual(refusal("variant_key"));
    expect(line?.stageName).toBe("Pool A");
  });

  it("the empty case: no locked field answers undefined, whatever the field", () => {
    expect(lockLineFor("variant_key", [])).toBeUndefined();
    expect(lockLineFor("bestOf", [], ["bestOf"])).toBeUndefined();
  });

  it("another field's refusal is not this field's lock", () => {
    expect(lockLineFor("bestOf", [refusal("setTo")])).toBeUndefined();
    expect(lockLineFor("variant_key", [refusal("bestOf")])).toBeUndefined();
  });

  it("a field that edits SEVERAL keys is locked by any one of them, and by the key it is named by", () => {
    const edits = ["overtime.minutes", "shootout", "periods"];
    for (const locked of ["overtime", "shootout", "periods"]) {
      expect(lockLineFor("anything", [refusal(locked)], edits)?.field, `locked by ${locked}`).toBe(locked);
    }
    // by its own key too, with no edits named
    expect(lockLineFor("abandon", [refusal("abandon")])?.field).toBe("abandon");
    // a key it does NOT edit leaves it open - the near miss is a prefix of an edited path, not a segment of it
    expect(lockLineFor("anything", [refusal("over")], edits)).toBeUndefined();
    expect(lockLineFor("anything", [refusal("minutes")], edits)).toBeUndefined();
  });

  it("with several locks the first in the list answers (the server's own order)", () => {
    const first = refusal("setTo", { stageName: "Pool A" });
    const second = refusal("setTo", { stageName: "Pool B", stageId: "stage-b" });
    expect(lockLineFor("setTo", [first, second])).toBe(first);
    expect(lockLineFor("setTo", [second, first])).toBe(second);
  });

  it("every declared field of every sport is locked by each engine key it edits (the declaration, swept)", () => {
    let checked = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      for (const f of fields) {
        for (const edit of f.edits) {
          const hit = lockLineFor(f.key, [refusal(topOf(edit))], f.edits);
          expect(hit?.field, `${sport}/${f.key} locked via ${edit}`).toBe(topOf(edit));
          checked++;
        }
      }
    }
    expect(checked, "the sweep reached the sports' fields").toBeGreaterThan(40);
  });
});

describe("mergeLocks", () => {
  it("the loader's list and the response's, one entry per field, the loader's first", () => {
    const loader = [refusal("setTo"), refusal("cap")];
    const response = [refusal("cap", { stageName: "Pool B", stageId: "stage-b" }), refusal("winBy", { stageName: "Pool B", stageId: "stage-b" })];
    const merged = mergeLocks(loader, response);
    expect(merged.map((r) => r.field)).toEqual(["setTo", "cap", "winBy"]);
    expect(merged.find((r) => r.field === "cap")?.stageName, "the earlier entry for a field stands").toBe("Pool A");
  });

  it("empty on either side, and empty on both", () => {
    const one = [refusal("setTo")];
    expect(mergeLocks(one, [])).toEqual(one);
    expect(mergeLocks([], one)).toEqual(one);
    expect(mergeLocks([], [])).toEqual([]);
  });
});

describe("lockSentence", () => {
  it("each code says its own dictionary sentence with the stage named", () => {
    const codes = Object.keys(RULE_LOCK_KEYS) as RefusedField["code"][];
    expect(codes.length).toBeGreaterThanOrEqual(2);
    for (const code of codes) {
      const said = lockSentence(refusal("x", { code, stageName: "Pool A" }), enMsg);
      const raw = (enUi as Record<string, string>)[RULE_LOCK_KEYS[code]]!;
      expect(said, code).toBe(raw.replace("{stage}", "Pool A"));
      expect(said, code).toContain("Pool A");
    }
    // the two codes say two different things (a table lock is not a format lock)
    expect(lockSentence(refusal("x", { code: "DIVISION_FORMAT_LOCKED" }), enMsg)).not.toBe(
      lockSentence(refusal("x", { code: "DIVISION_TABLE_RULES_LOCKED" }), enMsg),
    );
  });

  it("the partial-save line carries the count", () => {
    const line = enMsg(RULE_LOCK_PARTIAL_KEY, { n: 3 });
    expect(line).toContain("3");
    expect(line).not.toContain("{n}");
  });
});

describe("refusedLines", () => {
  const sayLines = (sport: string, list: RefusedField[], pointsBox = false) => refusedLines(sport, list, enMsg, pointsBox);

  it("the empty case: nothing refused is no line", () => {
    expect(sayLines("badminton", [])).toEqual([]);
  });

  it("the variant, a rule field by its key, a rule field by an engine key it edits - each under the control's own label, in the server's order", () => {
    const bestOf = SPORT_RULES.badminton!.find((f) => f.key === "bestOf")!;
    const lines = sayLines("badminton", [refusal("variant_key"), refusal("bestOf")]);
    expect(lines.map((l) => [l.id, l.label])).toEqual([
      ["variant_key", enMsg("divset.variant")],
      ["bestOf", bestOf.label],
    ]);
    expect(lines[0]!.lock).toEqual(refusal("variant_key"));
    // generic's "abandon" field edits `abandonPolicy`: the refusal is named by the config key, the line by the field's label
    const abandon = SPORT_RULES.generic!.find((f) => f.key === "abandon")!;
    expect(abandon.edits.map(topOf)).toContain("abandonPolicy");
    expect(sayLines("generic", [refusal("abandonPolicy")]).map((l) => [l.id, l.label])).toEqual([["abandonPolicy", abandon.label]]);
  });

  it("a key the form has no control for is NEVER named by its raw key: every such key is ONE 'other settings' line, worded by the first", () => {
    const keys = ["pointsMap", "tiebreakers", "someFutureKey"];
    const lines = sayLines("badminton", [refusal("setTo"), refusal(keys[0]!), refusal(keys[1]!, { stageName: "Pool B", stageId: "stage-b" }), refusal(keys[2]!)]);
    expect(lines.map((l) => l.id), "setTo, then ONE grouped line").toEqual(["setTo", "other"]);
    expect(lines[1]!.label).toBe(enMsg("ruleLock.otherSettings"));
    expect(lines[1]!.lock.field, "the first grouped refusal words the line").toBe("pointsMap");
    for (const l of lines) for (const k of keys) expect(l.label, `${k} is not a label`).not.toContain(k);
    // a prototype key and an unknown sport are just "no control", never a crash
    expect(sayLines("constructor", [refusal("bestOf")]).map((l) => l.id)).toEqual(["other"]);
  });

  it("a refused variant reads as the controls the organiser sees, not as the length of its cascade (M-4)", () => {
    const cascade = [refusal("variant_key"), refusal("setTo"), refusal("cap"), refusal("winBy"), refusal("pointsMap"), refusal("tiebreakers")];
    const lines = sayLines("badminton", cascade);
    // the variant picker, three rule fields, and ONE line for the two keys with no control
    expect(lines.map((l) => l.id)).toEqual(["variant_key", "setTo", "cap", "winBy", "other"]);
    expect(lines.length).toBeLessThan(cascade.length);
  });

  it("`points` is the standings-points boxes when this division has them, and 'other' when it has none", () => {
    expect(sayLines("generic", [refusal("points")], true).map((l) => [l.id, l.label])).toEqual([["points", enMsg("divset.standingsPoints")]]);
    expect(sayLines("badminton", [refusal("points")], false).map((l) => l.id)).toEqual(["other"]);
  });

  it("two refusals that name ONE control (its own key, and the config key it edits) are one line", () => {
    let found = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      for (const f of fields) {
        const top = f.edits.map(topOf).find((t) => t !== f.key);
        if (top === undefined) continue;
        // only a control that alone owns both names: another control sharing one would make "one line" ambiguous
        if (fields.some((o) => o !== f && (o.key === f.key || o.key === top || o.edits.some((e) => topOf(e) === f.key || topOf(e) === top)))) continue;
        const lines = sayLines(sport, [refusal(f.key), refusal(top)]);
        expect(lines.map((l) => l.label), `${sport}/${f.key}: refused as ${f.key} and as ${top}`).toEqual([f.label]);
        found++;
      }
    }
    expect(found, "the registry declares a control whose config key is not its own key").toBeGreaterThan(0);
  });
});
