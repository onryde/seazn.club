// The rung-letter rule, pinned against LITERAL counts.
//
// Why this file exists separately from the surfaces that obey the rule: every
// assertion on `/upgrade` and `/pricing` derives its expectation from
// `rungNamingRequired(SELLABLE_PASS_KEYS.length)` — the same call production
// makes — so a mutation to the predicate moves the expectation with it and
// none of those tests could witness it. They prove the CALL SITES apply the
// rule; this proves the rule.
//
// Background: the L rung came off sale on 2026-09-05 and the owner approved
// dropping the size suffix from every surface that SELLS a pass. `/pricing`
// was done in the same wave; the in-app buy page kept printing "Buy the pass
// — M", "M" on the ticket stamp and "Event Pass M" as its comparison column
// header, because those three read the HOLD-side maps. Found by driving the
// page, not by grep.
import { describe, expect, it } from "vitest";
import {
  offeredRungName,
  PASS_RUNG_NAME_KEY,
  rungNamingRequired,
} from "../pass-ladder";
import { PASS_KEYS, SELLABLE_PASS_KEYS } from "@/lib/currency";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

describe("rungNamingRequired", () => {
  it("names a size only when there is another size to be confused with", () => {
    // Literal counts, deliberately: this is the one place the `> 1` is
    // asserted rather than consulted.
    expect(rungNamingRequired(0)).toBe(false);
    expect(rungNamingRequired(1)).toBe(false);
    expect(rungNamingRequired(2)).toBe(true);
    expect(rungNamingRequired(3)).toBe(true);
  });

  it("answers the same at zero as at one — an empty catalogue is not a special case", () => {
    // Stated first and on its own because an empty set satisfies a
    // "contains" ladder vacuously: with nothing on sale there is no selling
    // surface to name a rung on, so the honest answer is the same "no", not
    // an unreachable "yes" waiting for a caller that never comes.
    expect(rungNamingRequired(0)).toBe(rungNamingRequired(1));
  });
});

describe("offeredRungName", () => {
  // The two answers must DIFFER, or every assertion below is satisfied by a
  // function that ignores its count argument entirely.
  const PLAIN = t(uiEn, "upgrade.rung.plain");
  const NAMED_M = t(uiEn, PASS_RUNG_NAME_KEY.event_pass);

  it("drops the letter with one rung on sale and restores it with two", () => {
    expect(offeredRungName(uiEn, "event_pass", 1)).toBe(PLAIN);
    expect(offeredRungName(uiEn, "event_pass", 2)).toBe(NAMED_M);
    expect(PLAIN).not.toBe(NAMED_M);
    // …and the named form is the plain one PLUS something, which is what makes
    // `toContain(PLAIN)` on a rendered page unable to witness the letter's
    // return on its own. Every surface asserting the plain name owes a
    // matching negative; this is why.
    expect(NAMED_M.startsWith(PLAIN)).toBe(true);
  });

  it("keeps the hidden rung nameable — the HOLD side is untouched", () => {
    // L is off sale, and rows holding it are live. A $44.99 buyer reading
    // their own competition as the $11.99 product is the v17 #294 mis-sale,
    // so `PASS_RUNG_NAME_KEY` stays complete over every rung that can be HELD
    // even though only one can be BOUGHT.
    for (const rung of PASS_KEYS) {
      expect(t(uiEn, PASS_RUNG_NAME_KEY[rung])).not.toBe("");
    }
    expect(PASS_KEYS.length).toBeGreaterThan(SELLABLE_PASS_KEYS.length);
    // With two rungs on sale the two names differ — the property the letter
    // exists for, asserted rather than assumed.
    expect(offeredRungName(uiEn, "event_pass", 2)).not.toBe(
      offeredRungName(uiEn, "event_pass_l", 2),
    );
  });
});

describe("today's catalogue", () => {
  it("sells exactly one rung, so the surfaces' derived assertions are not vacuous", () => {
    // The anchor for every `if (rungNamingRequired(SELLABLE_PASS_KEYS.length))`
    // in the page suites: if this number moved to 2 unnoticed, those tests
    // would quietly start asserting the OTHER branch and report green either
    // way. This is the line that has to be read when it changes.
    expect(SELLABLE_PASS_KEYS.length).toBe(1);
    expect(rungNamingRequired(SELLABLE_PASS_KEYS.length)).toBe(false);
  });
});
