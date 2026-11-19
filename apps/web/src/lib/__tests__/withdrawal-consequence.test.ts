// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition) — the Disqualify confirmation's copy, from one preview, in four locales.
// Expected English is the brief's own wording of ruling 289's condition (task-8b-brief.md, Part 3 Files: the three sentences
// "These {n} remaining matches will be withdrawn: {list}.", "{name} has played {played} of {scheduled}. Under the 50% rule …",
// "The organiser can undo this with Reinstate while the stage is running."), typed here — never read back from en/ui.json, which is the thing under test.
// The numbers are the preview's (the cascade's decision, withdrawal-preview.test.ts proves that); this file proves the words.
import { describe, expect, it } from "vitest";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import {
  WITHDRAWAL_CONSEQUENCE_KEYS,
  consequenceSentences,
  previewConsequence,
  type WithdrawalPreview,
  type WithdrawalPreviewStage,
} from "../withdrawal-consequence";

const DICTS: Record<string, Dict> = { en: uiEn as Dict, es: uiEs as Dict, fr: uiFr as Dict, nl: uiNl as Dict };
const en = (lines: ReturnType<typeof previewConsequence>) => consequenceSentences(lines, (k, v) => t(DICTS.en!, k as never, v), "en");

const NAME = "Alexandra Montgomery-Fitzwilliam of Ravenscourt"; // 47 characters: a realistic long entrant name
const stage = (over: Partial<WithdrawalPreviewStage>): WithdrawalPreviewStage => ({
  stage_id: "s1",
  stage_kind: "league",
  mode: "expunge",
  played: 2,
  scheduled: 5,
  pending: [
    { fixture_id: "f3", opponent: "Bea", round_no: 3 },
    { fixture_id: "f4", opponent: "Cal", round_no: 4 },
    { fixture_id: "f5", opponent: "Dov", round_no: 5 },
  ],
  undo: "restores",
  ...over,
});
const preview = (stages: WithdrawalPreviewStage[], over: Partial<WithdrawalPreview> = {}): WithdrawalPreview => ({
  entrant_id: "e1",
  name: NAME,
  as: "disqualified",
  started: true,
  cascade: true,
  stages,
  ...over,
});

describe("X-WDT-10 the Disqualify copy (ruling 289): the fixtures withdrawn, the 50% outcome with her count, and the undo", () => {
  it("X-WDT-10 a league at 2 of 5 (under half): three matches withdrawn by name and round, her results removed, Reinstate undoes it", () => {
    expect(en(previewConsequence(preview([stage({})])))).toEqual([
      "These 3 remaining matches will be withdrawn: Bea (round 3), Cal (round 4), and Dov (round 5).",
      `${NAME} has played 2 of 5. Under the 50% rule their results will be removed.`,
      "The organiser can undo this with Reinstate while the stage is running.",
    ]);
  });

  it("X-WDT-10 a league at 3 of 5 (half or more): her results stand and the rest are walked over; one remaining match reads singular", () => {
    const one = stage({ mode: "award", played: 4, scheduled: 5, pending: [{ fixture_id: "f5", opponent: "Dov", round_no: 5 }] });
    expect(en(previewConsequence(preview([one])))).toEqual([
      "This remaining match will be withdrawn: Dov (round 5).",
      `${NAME} has played 4 of 5. Under the 50% rule their results stand and the remaining matches are walked over.`,
      "The organiser can undo this with Reinstate while the stage is running.",
    ]);
    // The rule line moves with the count: 3 of 5 is the award, the same stage at 2 of 5 the expunge (a case where the right
    // answer differs from the wrong one's constant).
    const three = en(previewConsequence(preview([stage({ mode: "award", played: 3 })])));
    expect(three[1]).toBe(`${NAME} has played 3 of 5. Under the 50% rule their results stand and the remaining matches are walked over.`);
    expect(three[1]).not.toBe(en(previewConsequence(preview([stage({})])))[1]);
  });

  it("X-WDT-10 the empty case: 0 of 0 — no remaining matches; before Start; and nothing at all when nothing beyond the match is settled", () => {
    expect(en(previewConsequence(preview([stage({ mode: "award", played: 0, scheduled: 0, pending: [] })])))).toEqual([
      `${NAME} has no remaining matches.`,
      `${NAME} has played 0 of 0. Under the 50% rule their results stand and the remaining matches are walked over.`,
      "The organiser can undo this with Reinstate while the stage is running.",
    ]);
    expect(en(previewConsequence(preview([])))).toEqual([`${NAME} has no remaining matches.`, "The organiser can undo this with Reinstate while the stage is running."]);
    expect(en(previewConsequence(preview([], { started: false })))).toEqual([
      `The event has not started: ${NAME} leaves the field and no match is touched.`,
      // m2: before Start there is no stage to scope the undo to.
      "The organiser can undo this with Reinstate.",
    ]);
    expect(previewConsequence(preview([stage({})], { cascade: false })), "a bracket match's own DQ, or an entrant already gone").toEqual([]);
  });

  it("X-WDT-10 the copy says whether it can be undone — league or group: Reinstate restores; Swiss: she rejoins; knockout: she waits for the draw", () => {
    const undoOf = (s: WithdrawalPreviewStage) => en(previewConsequence(preview([s]))).at(-1);
    let checked = 0;
    for (const [s, want] of [
      [stage({ stage_kind: "league" }), "The organiser can undo this with Reinstate while the stage is running."],
      [stage({ stage_kind: "group" }), "The organiser can undo this with Reinstate while the stage is running."],
      [stage({ stage_kind: "swiss", mode: "award", undo: "rejoins" }), "The organiser can undo this with Reinstate while the stage is running: they rejoin from the next round, and rounds they missed score nothing."],
      [stage({ stage_kind: "knockout", mode: "bracket_walkover", undo: "waits" }), "The organiser can undo this with Reinstate while the stage is running: they then wait until they are put back into the draw."],
    ] as const) {
      expect(undoOf(s), s.stage_kind).toBe(want);
      checked++;
    }
    expect(checked).toBe(4);
    // The Swiss and bracket rule lines: no 50 percent count where the rule has none.
    expect(en(previewConsequence(preview([stage({ stage_kind: "swiss", mode: "award", played: 2, undo: "rejoins" })])))[1]).toBe(
      `${NAME} has played 2. In a Swiss their results stand and the remaining matches are walked over.`,
    );
    expect(en(previewConsequence(preview([stage({ stage_kind: "knockout", mode: "bracket_walkover", undo: "waits" })])))[1]).toBe(
      // m3: the bracket's cascade may seat a lucky loser or void a final, so the copy names no walkover.
      "Their results stand. Their remaining matches are settled by the bracket's rules.",
    );
  });

  it("X-WDT-10 a seat not yet filled is named as such, never as an empty name", () => {
    const tbd = stage({ pending: [{ fixture_id: "f9", opponent: null, round_no: 2 }] });
    expect(en(previewConsequence(preview([tbd])))[0]).toBe("This remaining match will be withdrawn: an opponent still to be decided (round 2).");
  });

  it("X-WDT-10 every key is present in en, es, fr and nl, never the key itself, and each locale renders the numbers and the name", () => {
    let present = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const key of WITHDRAWAL_CONSEQUENCE_KEYS) {
        const v = (dict as Record<string, unknown>)[key];
        expect(typeof v === "string" && v.length > 0 && v !== key, `${locale} ${key}`).toBe(true);
        present++;
      }
      const lines = consequenceSentences(previewConsequence(preview([stage({})])), (k, v) => t(dict, k as never, v), locale);
      expect(lines[0], `${locale}: the count and the opponents`).toMatch(/3/);
      for (const o of ["Bea", "Cal", "Dov"]) expect(lines[0], `${locale}: ${o}`).toContain(o);
      expect(lines[1], `${locale}: her name and count`).toContain(NAME);
      expect(lines[1], locale).toMatch(/2\D+5/);
      for (const l of lines) expect(l, `${locale}: no placeholder left`).not.toMatch(/[{}]/);
    }
    expect(present, "4 locales x every key").toBe(4 * WITHDRAWAL_CONSEQUENCE_KEYS.length);
  });
});
