// Task 6 (design 2026-09-17 §T5) — `read` for the in-scope rule fields, so a
// saved override reopens showing what was saved instead of blank.
//
// This is a live defect in the division editor today, not only a prerequisite
// for the stage panel: of 53 `RuleField` entries only two implement `read`, so
// `hydrateRuleValues` returns nothing for any sets-based field and every input
// reopens empty over a config that really does carry a value.
//
// TWO PROPERTIES, and they pull in opposite directions:
//
//  1. ROUND-TRIP — `read` must be the exact inverse of `build`, for EVERY
//     value the field can produce. A single sample proves nothing here: a
//     `build` that branches (tennis's `setType` emits three different `set`
//     objects, `finalSet` four different shapes) can invert correctly for the
//     first option and wrongly for the rest, and `bestOf` reading back `3`
//     would be satisfied by any implementation that happened to answer 3.
//     So the sweep enumerates every option of every select, both bool states,
//     and BOTH ends of every number field's declared range — and it derives
//     each probe from the field's own declaration, so a change to the source
//     of truth moves this test rather than leaving it on yesterday's values.
//
//  2. FRAGMENT-ONLY — `read` must report ONLY what the config it is handed
//     actually carries, and never fall back to a default. The stage panel
//     hydrates from the stage FRAGMENT; a resolved or division config is
//     defaults-materialised, so a `read` with a fallback would fill every
//     field and the organiser's first save would pin the entire division
//     format onto the stage as an override it never asked for.
//
// Pure — no database, no DOM.
import { describe, expect, it } from "vitest";
import {
  SPORT_RULES,
  STAGE_RULES_SPORTS,
  buildRuleOverride,
  configKeysFor,
  hydrateRuleValues,
  type RuleField,
} from "@/lib/match-rules";

/** Every value this field can actually produce, derived from the field's own
 *  declaration. Numbers probe BOTH ends of the declared range: two distinct
 *  values, so no assertion can be satisfied by a constant that happens to
 *  match one of them. */
function probesFor(field: RuleField): string[] {
  if (field.kind === "select") return (field.options ?? []).map((o) => o.value);
  if (field.kind === "bool") return ["on", "off"];
  const lo = field.min ?? 1;
  const hi = field.max ?? lo + 1;
  return lo === hi ? [String(lo)] : [String(lo), String(hi)];
}

const IN_SCOPE = [...STAGE_RULES_SPORTS].sort();

describe("hydrateRuleValues round-trips every in-scope rule field", () => {
  it("covers all four sets-based sports and nine distinct field keys", () => {
    // Guards the sweep below against going vacuous: an empty SPORT_RULES entry
    // would make every `for` loop pass without asserting anything.
    expect(IN_SCOPE).toEqual(["badminton", "tabletennis", "tennis", "volleyball"]);
    const keys = new Set(IN_SCOPE.flatMap((s) => SPORT_RULES[s]!.map((f) => f.key)));
    expect([...keys].sort()).toEqual([
      "bestOf",
      "cap",
      "finalSet",
      "finalSetTo",
      "noAd",
      "setTo",
      "setType",
      "tiebreakWinBy",
      "winBy",
    ]);
  });

  it("reads back the exact value that built it, for every option of every field", () => {
    /** Probes actually run, PER FIELD. A bare total cannot see a field going
     *  dark: the old `>= 40` floor stood against an actual 46, so `finalSet`
     *  could have lost all four of its options — leaving that field entirely
     *  unprobed — and this sweep would still have passed with 42. */
    const probed: Record<string, number> = {};
    for (const sport of IN_SCOPE) {
      for (const field of SPORT_RULES[sport]!) {
        for (const probe of probesFor(field)) {
          const built = field.build(probe, {});
          // Through the real `hydrateRuleValues`, not `field.read` directly —
          // a `read` that inverted correctly but was never wired into the
          // field object would pass the direct call and fail here.
          const hydrated = hydrateRuleValues(sport, built);
          expect(
            hydrated[field.key],
            `${sport}.${field.key} did not round-trip probe "${probe}"`,
          ).toBe(probe);
          probed[`${sport}.${field.key}`] = (probed[`${sport}.${field.key}`] ?? 0) + 1;
        }
      }
    }
    // EVERY declared field contributed at least one probe. A field whose
    // options vanished produces no probes at all and simply drops out of
    // `probed`, so the comparison — not a count — is what catches it.
    const declared = IN_SCOPE.flatMap((s) => SPORT_RULES[s]!.map((f) => `${s}.${f.key}`)).sort();
    expect(declared).toHaveLength(19);
    expect(Object.keys(probed).sort()).toEqual(declared);
    for (const [name, n] of Object.entries(probed))
      expect(n, `${name} contributed no probe`).toBeGreaterThan(0);
    // And the TOTAL is pinned exactly, not floored: an option removed from a
    // field that still has others left the old lower bound green. Nineteen
    // fields across four sports, each probed at every value it can take.
    // Adding or removing an option must move this number deliberately.
    // 46 → 47 on 2026-09-20: badminton's `bestOf` gained a third option (5).
    expect(Object.values(probed).reduce((a, b) => a + b, 0)).toBe(47);
  });

  it("hydrates tennis's three renamed fields from their CONFIG keys, not their field keys", () => {
    // The divergence `configKeysFor` exists for: `setType` writes `set`, `noAd`
    // writes `game`, `tiebreakWinBy` writes `tiebreak`. A `read` written
    // against the field key returns undefined forever, and the sweep above
    // would still be green if it only covered the other three sports.
    const fields = Object.fromEntries(SPORT_RULES.tennis!.map((f) => [f.key, f]));
    for (const [fieldKey, configKey] of [
      ["setType", "set"],
      ["noAd", "game"],
      ["tiebreakWinBy", "tiebreak"],
    ] as const) {
      const built = fields[fieldKey]!.build(
        fieldKey === "noAd" ? "on" : fields[fieldKey]!.options![0]!.value,
        {},
      );
      expect(Object.keys(built)).toEqual([configKey]);
      // The CONFIG key hydrates…
      expect(hydrateRuleValues("tennis", built)[fieldKey]).toBeDefined();
      // …and the FORM key, which is what a naive inverse would have read,
      // hydrates nothing at all.
      expect(hydrateRuleValues("tennis", { [fieldKey]: "whatever" })[fieldKey]).toBeUndefined();
    }
  });
});

describe("hydrateRuleValues reads the FRAGMENT and never a default", () => {
  it("returns nothing at all for an empty override", () => {
    for (const sport of IN_SCOPE) expect(hydrateRuleValues(sport, {})).toEqual({});
  });

  it("returns nothing for null or undefined config", () => {
    expect(hydrateRuleValues("tennis", null)).toEqual({});
    expect(hydrateRuleValues("tennis", undefined)).toEqual({});
  });

  it("hydrates ONLY the keys the fragment carries, leaving its siblings absent", () => {
    // The property the stage panel depends on. A `read` that fell back to a
    // default would fill `setTo`, `finalSetTo`, `cap` and `winBy` here, and
    // the panel's first save would write all five as an override the
    // organiser never chose — turning "Best of 3 in this stage" into "this
    // stage is pinned to the whole division format".
    const hydrated = hydrateRuleValues("badminton", { bestOf: 3 });
    expect(hydrated).toEqual({ bestOf: "3" });
  });

  it("ignores a config value of the wrong type rather than showing something false", () => {
    // A hand-edited or legacy row must not surface as a confident wrong value
    // in the editor; blank is the honest answer.
    expect(hydrateRuleValues("badminton", { bestOf: "3" })).toEqual({});
    expect(hydrateRuleValues("tennis", { set: "not-an-object" })).toEqual({});
    expect(hydrateRuleValues("tennis", { game: { noAd: "yes" } })).toEqual({});
    expect(hydrateRuleValues("tennis", { tiebreak: { winBy: "2" } })).toEqual({});
  });

  it("returns undefined for a tennis set object that matches no declared option", () => {
    // `setType` has only three shapes. A `set` that is none of them (a custom
    // config written by another path) must hydrate blank rather than be
    // rounded to the nearest option.
    expect(
      hydrateRuleValues("tennis", { set: { gamesTo: 9, winBy: 2, tiebreakAt: 8, tiebreakTo: 7 } }),
    ).toEqual({});
    // Every declared key matches and one EXTRA key rides along: still not a
    // declared option. Hydrating this as `tb6` would show the organiser a
    // setting they never chose and drop the extra key on the next save.
    expect(
      hydrateRuleValues("tennis", {
        set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7, serveOrder: "alt" },
      }),
    ).toEqual({});
  });
});

describe("tennis's branching builds keep their fall-through", () => {
  // These two builds were chained ternaries whose final `else` caught every
  // unrecognised value; they are now table lookups. The tables are shared with
  // `read`, which is the point, but the rewrite must not have quietly turned
  // an unknown value into `undefined` config where it used to be a default.
  const fields = Object.fromEntries(SPORT_RULES.tennis!.map((f) => [f.key, f]));

  it("falls an unknown set type through to tb6", () => {
    expect(fields.setType!.build("no-such-option", {})).toEqual(fields.setType!.build("tb6", {}));
  });

  it("falls an unknown deciding set through to same", () => {
    expect(fields.finalSet!.build("no-such-option", {})).toEqual({ finalSet: "same" });
  });

  // A plain-object lookup answers for INHERITED keys too, and `?? default`
  // never fires for them because they are not `undefined`. The commit that
  // introduced these tables claimed the fall-through was "preserved and
  // pinned" while the pinning test above probed only `"no-such-option"` — a
  // claim broader than its test. Not product-reachable (values come only from
  // the rendered select), but "unknown" must mean unknown for EVERY string.
  const PROTOTYPE_KEYS = ["constructor", "toString", "hasOwnProperty", "__proto__"];

  it("falls PROTOTYPE keys through too, not just undeclared ones", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(fields.setType!.build(key, {}), `setType("${key}")`).toEqual(
        fields.setType!.build("tb6", {}),
      );
      expect(fields.finalSet!.build(key, {}), `finalSet("${key}")`).toEqual({ finalSet: "same" });
    }
  });

  it("survives JSON round-tripping for a prototype key, where a Function silently vanishes", () => {
    // The sharp edge: `TENNIS_FINAL_SET_SHAPES["constructor"]` was the Object
    // constructor — a Function, which `JSON.stringify` DROPS entirely rather
    // than erroring, so the key disappeared on its way into jsonb.
    for (const key of PROTOTYPE_KEYS) {
      const built = fields.finalSet!.build(key, {}) as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(built)), `finalSet("${key}") through JSON`).toEqual(built);
      expect(typeof built.finalSet).not.toBe("function");
      const set = fields.setType!.build(key, {}) as { set: Record<string, unknown> };
      expect(Object.keys(set.set).length, `setType("${key}") emitted an empty set`).toBeGreaterThan(
        0,
      );
    }
  });

  it("treats a prototype SPORT key as an unknown sport rather than throwing", () => {
    // Same defect one level up: `SPORT_RULES[sportKey] ?? []` answered the
    // Object constructor for "constructor", and `for (const f of <Function>)`
    // throws "function is not iterable" — a crash, not a wrong value.
    for (const key of PROTOTYPE_KEYS) {
      expect(hydrateRuleValues(key, { bestOf: 3 }), `hydrateRuleValues("${key}")`).toEqual({});
      expect(buildRuleOverride(key, { bestOf: "3" }), `buildRuleOverride("${key}")`).toEqual({});
      expect([...configKeysFor(key)], `configKeysFor("${key}")`).toEqual([]);
    }
  });

  it("hands out a fresh object each time, so one division's config cannot alias another's", () => {
    const a = fields.setType!.build("tb6", {}) as { set: Record<string, unknown> };
    const b = fields.setType!.build("tb6", {}) as { set: Record<string, unknown> };
    expect(a.set).toEqual(b.set);
    expect(a.set).not.toBe(b.set);
  });
});
