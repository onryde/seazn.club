// The next-match refusal's ref (fix round 2 of the knockout void un-fill): the
// server names the next match by the code the schedule board gives its round,
// sent as the DICTIONARY KEY behind that code so every reader renders it in
// their own language. These pin the two ends of that key: every key the board
// can choose is one the reader accepts, and a ref is rendered with exactly the
// board's own composition.
import { describe, expect, it } from "vitest";
import type { RoundRole } from "@seazn/engine/competition";
import { interpolate } from "@/lib/i18n-runtime";
import type { MessageKey } from "@/lib/messages";
import { roundRoleShort } from "@/lib/round-role-label";
import { matchRef } from "@/lib/slot-label";
import { ROUND_CODE_KEYS, nextMatchLabel, nextMatchRefOf } from "@/lib/next-match-started";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

/** One of every role `roundRole()` can hand back — the union, spelled out, so
 *  the compiler flags a new kind here by the `satisfies` below. */
const EVERY_ROLE = [
  { kind: "round_of", entrants: 16 },
  { kind: "quarter_final" },
  { kind: "semi_final" },
  { kind: "final" },
  { kind: "winners_final" },
  { kind: "losers_round", n: 2 },
  { kind: "losers_final" },
  { kind: "grand_final" },
  { kind: "grand_final_reset" },
  { kind: "third_place" },
  { kind: "qualifier1" },
  { kind: "eliminator" },
  { kind: "qualifier2" },
  { kind: "rung", n: 1 },
  { kind: "plain_round", n: 1 },
] as const satisfies readonly RoundRole[];

describe("the round-code keys a next-match ref may carry", () => {
  it("covers every key the board's `roundRoleShort` can name a code with — in every lane", () => {
    const kinds = new Set<string>(EVERY_ROLE.map((r) => r.kind));
    expect(kinds.size, "one of every RoundRole kind").toBe(EVERY_ROLE.length);
    const chosen = new Set<string>();
    const record = (key: MessageKey) => {
      chosen.add(key);
      return key;
    };
    for (const role of EVERY_ROLE) {
      for (const lane of [null, "WB", "LB", "GF"] as const) {
        roundRoleShort(record, role, { lane, roundInLane: 1 });
      }
    }
    expect([...chosen].sort()).toEqual([...ROUND_CODE_KEYS].sort());
  });
});

describe("nextMatchRefOf reads the code whole, or not at all", () => {
  const base = { fixture_id: "fx", round: 2, seq: 1 };

  it("keeps a code the board could have chosen, params and all", () => {
    const code = { key: "bracket.roundShort.roundOf", params: { n: 16 } };
    expect(nextMatchRefOf({ next_match: { ...base, code } })).toEqual({ ...base, code });
  });

  it("reads a ref with no code as a round the board does not code", () => {
    expect(nextMatchRefOf({ next_match: base })).toEqual(base);
  });

  it.each([
    ["a key the board never chooses", { key: "auth.signOut", params: {} }],
    ["a key with no params", { key: "bracket.roundShort.final" }],
    ["params that are a list", { key: "bracket.roundShort.final", params: [] }],
    ["a param that is not text or a number", { key: "bracket.roundShort.roundOf", params: { n: { x: 1 } } }],
    ["a param that is not a finite number", { key: "bracket.roundShort.roundOf", params: { n: Number.NaN } }],
    ["a bare string", "bracket.roundShort.final"],
    ["null", null],
  ])("refuses the whole ref for %s, so the reader falls back to the plain sentence", (_label, code) => {
    expect(nextMatchRefOf({ next_match: { ...base, code } })).toBeNull();
  });
});

describe("nextMatchLabel is the board's own label, in the reader's language", () => {
  const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;

  it.each(Object.keys(LOCALES))("%s: a coded round reads as the board prints it; an uncoded one as R{n}·{seq}", (locale) => {
    const dict = LOCALES[locale]!;
    const say = (k: MessageKey, vars?: Record<string, string | number>) => interpolate(dict[k] ?? k, vars);
    const code = { key: "bracket.roundShort.roundOf" as const, params: { n: 16 } };
    expect(nextMatchLabel({ round: 1, seq: 5, code }, say)).toBe(matchRef(1, 5, say, say(code.key, code.params)));
    expect(nextMatchLabel({ round: 2, seq: 1 }, say)).toBe(matchRef(2, 1, say));
  });
});
