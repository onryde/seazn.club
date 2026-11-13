// CreateQuickMatch's League + Knockout shape (quick match plan 5 Task 1, D1; spec 2026-11-12-quick-match-league-knockout §2,
// §12): `format: "league_knockout"` takes `qualifiers`, the top 2 (League → Final) or the top 4 (League → Semi-finals →
// Final), and no other format takes one. The qualifier count lives in the stage graph only (the knockout stage's
// progression), so the create's input is its one door: a value the schema lets through becomes a bracket.
//
// The expected values come from the spec (a final is the top 2, semi-finals the top 4), never from the schema itself; the
// constants are pinned against the same numbers, so the schema, the constants and the spec cannot drift apart. The
// error-code contract the later tasks map to copy rides here too (the codes are plain strings, so nothing else pins them).
//
// DB-free: pure zod and import-free constants.
import { describe, expect, it } from "vitest";
import {
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_MIN_SIDES,
  QUICK_MATCH_QUALIFIERS,
  QUICK_MATCH_SEMIS_MIN_SIDES,
} from "@/lib/quick-match-constants";
import { CreateQuickMatch } from "@/server/api-v1/schemas";

/** A create the schema accepts as a League, but for the fields a case sets. */
const body = (over: Record<string, unknown> = {}) => ({
  name: "Club night",
  sport_key: "badminton",
  variant_key: "bwf",
  kind: "pair",
  format: "league",
  sides: ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"],
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});

/** The parse's verdict: the parsed qualifiers, or the paths its issues name. */
const verdict = (over: Record<string, unknown>) => {
  const r = CreateQuickMatch.safeParse(body(over));
  return r.success ? { ok: true as const, qualifiers: r.data.qualifiers } : { ok: false as const, paths: r.error.issues.map((i) => i.path.join(".")) };
};

describe("CreateQuickMatch: League + Knockout takes the top 2 or the top 4, and only it takes a count (D1)", () => {
  // [case, input, expected]. `qualifiers` absent means the field was not sent at all.
  const CASES: [string, Record<string, unknown>, ReturnType<typeof verdict>][] = [
    // The empty case first: a League, as every create sent it before plan 5, parses with no count.
    ["a league with no count parses, its count null", { format: "league" }, { ok: true, qualifiers: null }],
    ["a league with a null count parses", { format: "league", qualifiers: null }, { ok: true, qualifiers: null }],
    // The legacy format stays in the enum (the create refuses it, 422 FORMAT_NOT_OFFERED); the schema only says no count.
    ["a knockout with no count parses, its count null", { format: "knockout" }, { ok: true, qualifiers: null }],
    ["League → Final: league_knockout with the top 2", { format: "league_knockout", qualifiers: 2 }, { ok: true, qualifiers: 2 }],
    ["League → Semi-finals → Final: the top 4", { format: "league_knockout", qualifiers: 4 }, { ok: true, qualifiers: 4 }],
    ["league_knockout with no count is refused on qualifiers", { format: "league_knockout" }, { ok: false, paths: ["qualifiers"] }],
    ["league_knockout with a null count is refused on qualifiers", { format: "league_knockout", qualifiers: null }, { ok: false, paths: ["qualifiers"] }],
    ["a league with a count is refused on qualifiers", { format: "league", qualifiers: 4 }, { ok: false, paths: ["qualifiers"] }],
    ["a knockout with a count is refused on qualifiers", { format: "knockout", qualifiers: 2 }, { ok: false, paths: ["qualifiers"] }],
    ["a count of 3 is refused (no such knockout)", { format: "league_knockout", qualifiers: 3 }, { ok: false, paths: ["qualifiers"] }],
    ["a count sent as text is refused, never coerced", { format: "league_knockout", qualifiers: "2" }, { ok: false, paths: ["qualifiers"] }],
    ["an unknown format is refused on format", { format: "swiss" }, { ok: false, paths: ["format"] }],
  ];

  it.each(CASES)("%s", (_name, over, want) => {
    expect(verdict(over)).toEqual(want);
  });

  it("the case table is the one above (anti-vacuity)", () => {
    expect(CASES).toHaveLength(12);
    expect(CASES.filter(([, , w]) => w.ok)).toHaveLength(5);
  });

  it("the counts it takes are exactly the spec's two, swept 0..8 (counted)", () => {
    const accepted: number[] = [];
    let checked = 0;
    for (let q = 0; q <= 8; q++) {
      if (CreateQuickMatch.safeParse(body({ format: "league_knockout", qualifiers: q })).success) accepted.push(q);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(9);
    // Spec §2: League → Final is the top 2; League → Semi-finals → Final is the top 4. Typed from the spec, not the schema.
    expect(accepted).toEqual([2, 4]);
    // ...and the one constant the setup screen and the create read says the same.
    expect([...QUICK_MATCH_QUALIFIERS]).toEqual([2, 4]);
  });

  it("the format list keeps league and knockout and adds league_knockout (D1: knockout stays for its rows)", () => {
    expect([...CreateQuickMatch.shape.format.options].sort()).toEqual(["knockout", "league", "league_knockout"]);
  });
});

describe("the League + Knockout constants and codes (plan 5 Task 1)", () => {
  it("semi-finals need 4 sides (1st v 4th, 2nd v 3rd), a number the side bounds allow", () => {
    // Spec seeding: semis 1st v 4th and 2nd v 3rd, so four distinct sides. Typed from the spec.
    expect(QUICK_MATCH_SEMIS_MIN_SIDES).toBe(4);
    expect(QUICK_MATCH_SEMIS_MIN_SIDES).toBeGreaterThan(QUICK_MATCH_MIN_SIDES);
    expect(QUICK_MATCH_SEMIS_MIN_SIDES).toBeLessThanOrEqual(QUICK_MATCH_MAX_SIDES);
  });

  it("each new refusal code is its own string, named QUICK_MATCH_<key>, and every code is unique (counted)", () => {
    const NEW = {
      ALREADY_DECIDED: "QUICK_MATCH_ALREADY_DECIDED",
      TIE_NOT_OPEN: "QUICK_MATCH_TIE_NOT_OPEN",
      PICK_INVALID: "QUICK_MATCH_PICK_INVALID",
      LEAGUE_COMPLETE: "QUICK_MATCH_LEAGUE_COMPLETE",
      SEMIS_TOO_FEW_SIDES: "QUICK_MATCH_SEMIS_TOO_FEW_SIDES",
    } as const;
    let checked = 0;
    for (const [key, code] of Object.entries(NEW)) {
      expect((QUICK_MATCH_ERRORS as Record<string, string>)[key], key).toBe(code);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(5);
    const all = Object.values(QUICK_MATCH_ERRORS);
    expect(new Set(all).size, "no two keys share a code").toBe(all.length);
    for (const [key, code] of Object.entries(QUICK_MATCH_ERRORS)) expect(code, key).toBe(`QUICK_MATCH_${key}`);
  });
});
