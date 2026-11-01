// W2c Task 20 (S4, X-SR-4 UI half) - which of the settings form's fields a started stage locks, and what the form says.
//
// The pure half: `lockLineFor` (a field's lock, by its key or by any engine key it edits), `mergeLocks` (the loader's list
// and the save response's), `lockSentence` (the dictionary's, in the reader's language) and `refusedLines` (what a save kept, one
// line per control the organiser can see). Where each expected value comes from: the refusal shapes are `RefusedField`'s own, the
// fields and the keys they edit are the SPORT_RULES table (the declaration the form renders), and every sentence is read
// from the en dictionary - none is typed here.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SPORT_RULES, SINGLE_SET_POINTS_LABEL, rulesFor, visibleRuleFields } from "@/lib/match-rules";
import { BEST_OF_ONE_PAIR } from "@/lib/match-rules/best-of-one";
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
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { appendEvent } from "@/server/engine-db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { divisionLockedFields } from "@/server/usecases/rule-locks";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";

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
  // The controls the form shows for a division at these values: `visibleRuleFields`, as the form's own grid reads it (batch-6 T20-1).
  const sayLines = (sport: string, list: RefusedField[], pointsBox = false, values: Record<string, string> = {}) =>
    refusedLines(visibleRuleFields(sport, values, {}), list, enMsg, pointsBox);

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

// Batch-6 T20-1: a save's "kept" lines name the controls the organiser can SEE. On best of 1 the form collapses the points
// pair to ONE field ("Points to win", bound to finalSetTo) and hides `setTo`; naming from the full SPORT_RULES table put
// the hidden control's label ("Points to win a set") on screen. One control writes both keys, so a refusal of either is
// one line under the visible control.
describe("refusedLines on best of 1 (the points pair collapses to one control)", () => {
  const sayLines = (sport: string, list: RefusedField[], values: Record<string, string>) =>
    refusedLines(visibleRuleFields(sport, values, {}), list, enMsg, false);
  /** Sports that declare the collapsing pair: derived from the table, as `best-of-one.ts` derives it. */
  const PAIR_SPORTS = Object.entries(SPORT_RULES)
    .filter(([, fs]) => ["bestOf", BEST_OF_ONE_PAIR.shown, BEST_OF_ONE_PAIR.shadow].every((k) => fs.some((f) => f.key === k)))
    .map(([sport]) => sport);

  it("the sports that collapse are found, and each hides the shadow control on best of 1 (anti-vacuity)", () => {
    expect(PAIR_SPORTS.length, "the table declares at least one pair sport").toBeGreaterThan(0);
    let checked = 0;
    for (const sport of PAIR_SPORTS) {
      const shown = visibleRuleFields(sport, { bestOf: "1" }, {});
      expect(shown.some((f) => f.key === BEST_OF_ONE_PAIR.shadow), `${sport}: the shadow is hidden on best of 1`).toBe(false);
      expect(shown.find((f) => f.key === BEST_OF_ONE_PAIR.shown)?.label, `${sport}: the shown field is relabelled`).toBe(SINGLE_SET_POINTS_LABEL);
      checked++;
    }
    expect(checked).toBe(PAIR_SPORTS.length);
  });

  it("a refusal of either key of the pair is ONE line, under the visible control's label - never the hidden control's (every pair sport, counted)", () => {
    let checked = 0;
    for (const sport of PAIR_SPORTS) {
      const hidden = SPORT_RULES[sport]!.find((f) => f.key === BEST_OF_ONE_PAIR.shadow)!;
      expect(hidden.label, `${sport}: the premise - the hidden control is named differently`).not.toBe(SINGLE_SET_POINTS_LABEL);
      for (const list of [
        [refusal(BEST_OF_ONE_PAIR.shadow), refusal(BEST_OF_ONE_PAIR.shown)],
        [refusal(BEST_OF_ONE_PAIR.shown), refusal(BEST_OF_ONE_PAIR.shadow)],
        [refusal(BEST_OF_ONE_PAIR.shadow)],
        [refusal(BEST_OF_ONE_PAIR.shown)],
      ]) {
        const lines = sayLines(sport, list, { bestOf: "1" });
        expect(lines.map((l) => l.label), `${sport} ${list.map((r) => r.field).join("+")}`).toEqual([SINGLE_SET_POINTS_LABEL]);
        expect(lines.some((l) => l.label === hidden.label), `${sport}: the hidden control is never named`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(PAIR_SPORTS.length * 4);
  });

  it("the other direction: at best of 3 the same refusals name each control by its own label, and a sport without the pair is untouched", () => {
    for (const sport of PAIR_SPORTS) {
      const labelOf = (key: string) => SPORT_RULES[sport]!.find((f) => f.key === key)!.label;
      const lines = sayLines(sport, [refusal(BEST_OF_ONE_PAIR.shadow), refusal(BEST_OF_ONE_PAIR.shown)], { bestOf: "3" });
      expect(lines.map((l) => l.label), sport).toEqual([labelOf(BEST_OF_ONE_PAIR.shadow), labelOf(BEST_OF_ONE_PAIR.shown)]);
    }
    // A sport that names `setTo` without the pair (no bestOf/finalSetTo) must not borrow the pair's shown field.
    const others = Object.keys(SPORT_RULES).filter((s) => !PAIR_SPORTS.includes(s));
    expect(others.length).toBeGreaterThan(0);
    for (const sport of others) {
      const lines = sayLines(sport, [refusal(BEST_OF_ONE_PAIR.shadow)], { bestOf: "1" });
      const own = SPORT_RULES[sport]!.find((f) => f.key === BEST_OF_ONE_PAIR.shadow);
      expect(lines.map((l) => l.id), sport).toEqual([own === undefined ? "other" : BEST_OF_ONE_PAIR.shadow]);
    }
  });

  // Match Day C2 moved the match rules, their lock and their refusal lines out of Settings into the Division rules strip
  // (`rules/division-rules-strip.tsx`); C2 fix round 1 (I1) made the lock ONE line per section, decided over the fields the
  // grid draws. So the wiring is the strip's: both of its readings - the refused-line names and the section's lock - are
  // asked over the SAME values and inherited config (and, for the lock, the same omitted fields and form state) that its
  // editing grid is handed. Asked of the source, whitespace-blind: a call site that reads another config compiles and passes
  // every helper test.
  it("the strip's call sites read the SAME values and inherited config its grid renders: the refused-line names and the section's one lock (the wiring, not the helper)", () => {
    const strip = readFileSync(new URL("../rules/division-rules-strip.tsx", import.meta.url), "utf8");
    // The refused-line names: visibleRuleFields over the grid's values and inherited config.
    expect(strip).toMatch(/refusedLines\(\s*visibleRuleFields\(\s*sportKey\s*,\s*ruleValues\s*,\s*inheritedCfg\s*\)/);
    // The section's one lock line: every field the grid draws, the grid's own list over the same four inputs.
    expect(strip).toMatch(/divisionGridFields\(\s*sportKey\s*,\s*ruleValues\s*,\s*inheritedCfg\s*,\s*omitted\s*,\s*ruleState\s*\)\.map\(\s*\(f\)\s*=>\s*lockLineFor\(/);
    // ...and the editing grid is handed exactly those: values, inherited config, omitted fields and form state.
    const grid = strip.match(/<MatchFormatEditor\s[^>]*?mode="edit"[^>]*?\/>/s)?.[0];
    expect(grid, "the strip mounts the editing grid").toBeDefined();
    expect(grid).toMatch(/\bvalues=\{ruleValues\}/);
    expect(grid, "the grid reads the same inherited config").toMatch(/\binherited=\{inheritedCfg\}/);
    expect(grid).toMatch(/\bomit=\{omitted\}/);
    expect(grid).toMatch(/\bstate=\{ruleState\}/);
    expect(strip, "no crash-trap index into the table (T20-2)").not.toMatch(/SPORT_RULES\[[^\]]+\]\s*\?\?/);
    // Settings no longer holds the wiring (the move is real, not a copy left behind), and keeps no crash trap either.
    const settings = readFileSync(new URL("../division-settings.tsx", import.meta.url), "utf8");
    expect(settings, "the refused lines left Settings with the match rules").not.toMatch(/refusedLines\(/);
    expect(settings, "no crash-trap index into the table (T20-2)").not.toMatch(/SPORT_RULES\[[^\]]+\]\s*\?\?/);
  });
});

// Batch-6 T20-2: the form reads a sport's fields through `rulesFor`, not `SPORT_RULES[key] ?? []` (a prototype key answers
// the Object constructor there, and iterating it throws).
describe("rulesFor: the crash-proof read of a sport's fields", () => {
  it("a sport the table declares answers its fields; anything else - a prototype key, an unknown sport, the empty string - answers none (counted)", () => {
    let checked = 0;
    for (const [sport, fields] of Object.entries(SPORT_RULES)) {
      expect(rulesFor(sport), sport).toBe(fields);
      checked++;
    }
    expect(checked, "anti-vacuity: the table is not empty").toBeGreaterThan(0);
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", "no-such-sport"]) {
      expect(() => [...rulesFor(key)], `${key} does not throw when iterated`).not.toThrow();
      expect(rulesFor(key), key).toEqual([]);
    }
  });
});

// W2d Task 10 (SPEC §11 item 4, PS-9e) - the page's lock list, read from the server as the form receives it. Once a stage
// starts the division's tie-break order is no longer refused (it reaches only unpinned stages, `stagesKeptPinned`), so
// the list carries no `tiebreakers` entry and the form no line for it; the points a started (pinned) stage replaces are
// open too. A board game's `scoring` also writes the game's score, so it keeps DIVISION_TABLE_RULES_LOCKED. Real Postgres;
// skipped without DATABASE_URL.
const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A division of the sport with one league stage that has started (generated: pinned; its first event recorded: locked). */
async function startedDivision(sport: string, variant: string, config: Record<string, unknown>) {
  const { auth } = await seedOrg("pro");
  const suffix = randomUUID().slice(0, 8);
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "T10l " + suffix, visibility: "private", branding: {} });
  const d = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: sport, variant_key: variant, config });
  const kind = builtinModules.find((m) => m.key === sport)?.entrantModel?.defaultKind ?? "individual";
  await createEntrants(auth, d.id, [1, 2].map((i) => ({ kind, display_name: `E${i}`, seed: i, members: [] })));
  const [s] = await createStages(auth, d.id, { seq: 1, kind: "league", name: "Pool A", config: {}, progression: null });
  await generateStageFixtures(auth, s!.id);
  const [f] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${s!.id} and home_entrant_id is not null and away_entrant_id is not null limit 1`;
  await appendEvent(auth.orgId, f!.id, 0, { type: "core.start", payload: {} });
  return divisionLockedFields(auth, d.id);
}

describe.skipIf(!HAS_DB)("W2d T10 the lock list once the pin owns a started stage's table", () => {
  it("§11 item 4 a started stage leaves the tiebreakers field open (no lock line); boardgame scoring still carries DIVISION_TABLE_RULES_LOCKED", async () => {
    const generic = await startedDivision("generic", "score", GENERIC_CONFIG);
    expect(lockLineFor("variant_key", generic)?.stageName, "premise: the stage has started (its format is locked)").toBe("Pool A");
    expect(generic.map((r) => r.field), "no tie-break entry in the list").not.toContain("tiebreakers");
    expect(lockLineFor("tiebreakers", generic), "the tie-break order carries no lock line").toBeUndefined();
    expect(lockLineFor("points", generic), "the points the pinned stage replaces are open").toBeUndefined();
    const boardgame = await startedDivision("boardgame", "classical", {});
    expect(boardgame.map((r) => r.field)).not.toContain("tiebreakers");
    const scoring = lockLineFor("scoring", boardgame);
    expect(scoring, "boardgame scoring keeps its lock").toMatchObject({ field: "scoring", code: "DIVISION_TABLE_RULES_LOCKED", stageName: "Pool A" });
    expect(lockSentence(scoring!, (k, v) => (enUi as Record<string, string>)[k]!.replace("{stage}", String(v?.stage)))).toBe(
      (enUi as Record<string, string>)["ruleLock.DIVISION_TABLE_RULES_LOCKED"]!.replace("{stage}", "Pool A"),
    );
  });
});
