// Best of 1 — ONE "Points to win" field (owner ruling 2026-09-25, Option A;
// brief docs/superpowers/specs/2026-09-25-bo1-points-editor-trap.md).
//
// The defect: the set-based kernel plays the LAST possible set to
// `finalSetTo`, and on best of 1 the only set is the last, so `setTo` is never
// read. The editor still offered "Points to win a set" (`setTo`) — the field
// an organiser naturally edits — and it did nothing, while the field that
// counted looked like an extra.
//
// Every "which key is played" expectation below is asked of the ENGINE by
// playing a match (`_single-game-target.ts`), never read off `kernel.ts`
// (AGENTS.md rule 19). And every sweep runs all three sports whose table
// declares the pair, derived from `SPORT_RULES` and pinned non-empty so it
// cannot pass vacuously (RULES.md: empty-set case first).
//
// Pure — no database, no DOM. The rendered half lives in
// `components/v2/__tests__/match-rules-best-of-one.test.tsx`; the endpoint and
// the scorer's ledger in `server/usecases/__tests__/stage-rules.test.ts`.
import { describe, expect, it } from "vitest";
import {
  SINGLE_SET_POINTS_LABEL,
  SPORT_RULES,
  alignBestOfOnePoints,
  buildRuleOverride,
  hydrateRuleValues,
  setRuleValue,
  showsOnePointsField,
  visibleRuleFields,
  type RuleField,
} from "@/lib/match-rules";
import { SET_BASED_MODULES, pointsTheOnlyGameIsPlayedTo } from "./_single-game-target";

/** Sports whose own table declares a best-of picker AND both points keys —
 *  the only ones the collapse can apply to. Derived, never listed. */
const PAIRED = Object.keys(SPORT_RULES)
  .filter((sport) => {
    const keys = new Set(SPORT_RULES[sport]!.map((f) => f.key));
    return keys.has("bestOf") && keys.has("setTo") && keys.has("finalSetTo");
  })
  .sort();

function field(sport: string, key: string): RuleField {
  const f = SPORT_RULES[sport]!.find((x) => x.key === key);
  if (!f) throw new Error(`${sport} has no ${key} field`);
  return f;
}

/** Two DISTINCT in-range points values for `sport`, both at or above the
 *  engine's own `winBy` so a whitewash decides at exactly that number. Derived
 *  from the field's declared range, so a range change moves this test. */
function pointsProbes(sport: string): [string, string] {
  const f = field(sport, "finalSetTo");
  const winBy = SET_BASED_MODULES[sport]!.configSchema.parse({}).winBy;
  const lo = Math.max(f.min!, winBy);
  const hi = f.max!;
  const mid = Math.ceil((lo + hi) / 2);
  return [String(mid), String(hi)];
}

/** The module's own defaults, as the stage editor's `divisionConfig` carries
 *  them (a stored division config is `configSchema.parse`d — every key). */
function divisionConfig(sport: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SET_BASED_MODULES[sport]!.configSchema.parse(over) };
}

describe("which sports collapse — derived from the table, empty case first", () => {
  it("is exactly badminton, table tennis and volleyball", () => {
    // Not empty (a vacuous sweep) and not a list typed into the collapse: the
    // three set-based presets, and neither tennis (no `setTo`) nor carrom (a
    // `bestOf` picker, no points pair).
    expect(PAIRED).toEqual(["badminton", "tabletennis", "volleyball"]);
    expect(Object.keys(SET_BASED_MODULES).sort()).toEqual(PAIRED);
  });

  it("never collapses a sport without the pair, whatever its best-of says", () => {
    for (const sport of ["tennis", "carrom", "football", "generic"]) {
      expect(showsOnePointsField(sport, { bestOf: "1" }), sport).toBe(false);
      expect(visibleRuleFields(sport, { bestOf: "1" }), sport).toEqual(SPORT_RULES[sport]);
    }
  });
});

describe("the effective best-of — the edited value, else the inherited one", () => {
  it.each(PAIRED)("%s: collapses on 1 only, from either source, value first", (sport) => {
    // Empty everything — a fresh builder — is NOT best of 1.
    expect(showsOnePointsField(sport, {})).toBe(false);
    expect(showsOnePointsField(sport, {}, {})).toBe(false);
    // The edited value.
    expect(showsOnePointsField(sport, { bestOf: "1" })).toBe(true);
    // The inherited one, when nothing is edited — and a BLANK pick ("Default")
    // is nothing edited.
    expect(showsOnePointsField(sport, {}, { bestOf: 1 })).toBe(true);
    expect(showsOnePointsField(sport, { bestOf: "" }, { bestOf: 1 })).toBe(true);
    // ORDERING differential — the value beats the inheritance, both ways. A
    // collapse that read the inherited value first passes every case above.
    expect(showsOnePointsField(sport, { bestOf: "3" }, { bestOf: 1 })).toBe(false);
    expect(showsOnePointsField(sport, { bestOf: "1" }, { bestOf: 3 })).toBe(true);
    // Every OTHER option the picker offers keeps both fields.
    for (const o of field(sport, "bestOf").options!)
      if (o.value !== "1") expect(showsOnePointsField(sport, { bestOf: o.value }), o.value).toBe(false);
  });
});

describe("what the editor renders", () => {
  it.each(PAIRED)("%s at best of 1: one 'Points to win' field, bound to finalSetTo", (sport) => {
    const fields = visibleRuleFields(sport, { bestOf: "1" });
    const table = SPORT_RULES[sport]!;
    // setTo is gone; everything else keeps its declaration order.
    expect(fields.map((f) => f.key)).toEqual(
      table.map((f) => f.key).filter((k) => k !== "setTo"),
    );
    const single = fields.find((f) => f.key === "finalSetTo")!;
    expect(single.label).toBe(SINGLE_SET_POINTS_LABEL);
    expect(SINGLE_SET_POINTS_LABEL).toBe("Points to win");
    // Exactly one points label on screen — neither of the pair's own.
    const labels = fields.map((f) => f.label);
    expect(labels).not.toContain(field(sport, "setTo").label);
    expect(labels).not.toContain(field(sport, "finalSetTo").label);
    // Same range as the key it writes.
    expect([single.min, single.max]).toEqual([field(sport, "finalSetTo").min, field(sport, "finalSetTo").max]);
    // The table itself is not mutated by the relabel.
    expect(field(sport, "finalSetTo").label).not.toBe(SINGLE_SET_POINTS_LABEL);
  });

  it.each(PAIRED)("%s at any other best-of: exactly the table, both fields", (sport) => {
    // The positive pair — a collapse that fired everywhere passes the test above.
    for (const o of field(sport, "bestOf").options!) {
      if (o.value === "1") continue;
      expect(visibleRuleFields(sport, { bestOf: o.value }), o.value).toEqual(SPORT_RULES[sport]);
    }
    expect(visibleRuleFields(sport, {})).toEqual(SPORT_RULES[sport]);
  });
});

describe("editing the single field", () => {
  it.each(PAIRED)("%s: writes both keys at best of 1, and only its own otherwise", (sport) => {
    const [x] = pointsProbes(sport);
    expect(setRuleValue(sport, { bestOf: "1" }, "finalSetTo", x)).toEqual({
      bestOf: "1",
      setTo: x,
      finalSetTo: x,
    });
    // Inherited best of 1 mirrors too.
    expect(setRuleValue(sport, {}, "finalSetTo", x, { bestOf: 1 })).toEqual({
      setTo: x,
      finalSetTo: x,
    });
    // Positive pair: best of 3 keeps the two independent.
    expect(setRuleValue(sport, { bestOf: "3", setTo: "7" }, "finalSetTo", x)).toEqual({
      bestOf: "3",
      setTo: "7",
      finalSetTo: x,
    });
    // Clearing it clears both — the pair goes back to inheriting together.
    expect(setRuleValue(sport, { bestOf: "1", setTo: x, finalSetTo: x }, "finalSetTo", "")).toEqual({
      bestOf: "1",
      setTo: "",
      finalSetTo: "",
    });
    // Other fields never touch the pair.
    expect(setRuleValue(sport, { bestOf: "1", finalSetTo: x }, "winBy", "2")).toEqual({
      bestOf: "1",
      finalSetTo: x,
      winBy: "2",
    });
  });
});

describe("the hydrate/build pair — the value saved is the value played", () => {
  it.each(PAIRED)("%s: the single field's number is the number the engine plays to", (sport) => {
    for (const x of pointsProbes(sport)) {
      const division = divisionConfig(sport);
      const values = setRuleValue(sport, { bestOf: "1" }, "finalSetTo", x);
      const built = buildRuleOverride(sport, values);
      expect(built).toEqual({ bestOf: 1, setTo: Number(x), finalSetTo: Number(x) });
      expect(pointsTheOnlyGameIsPlayedTo(sport, { ...division, ...built }), `${sport} @${x}`).toBe(
        Number(x),
      );
    }
  });

  it.each(PAIRED)(
    "%s: existing best-of-1 data with setTo ≠ finalSetTo reopens showing finalSetTo and saves repaired",
    (sport) => {
      const [played, dead] = pointsProbes(sport);
      const saved = divisionConfig(sport, { bestOf: 1, setTo: Number(dead), finalSetTo: Number(played) });
      // PREMISE, from the engine: this config really is played to finalSetTo,
      // and the two differ — or the case cannot tell the keys apart.
      expect(played).not.toBe(dead);
      expect(pointsTheOnlyGameIsPlayedTo(sport, saved)).toBe(Number(played));

      const values = hydrateRuleValues(sport, saved);
      const single = visibleRuleFields(sport, values, saved).find(
        (f) => f.label === SINGLE_SET_POINTS_LABEL,
      )!;
      // What the one field SHOWS is the number actually played.
      expect(values[single.key]).toBe(played);

      // A save with nothing touched writes that number to BOTH keys.
      const built = buildRuleOverride(sport, values, saved);
      expect(built.setTo).toBe(Number(played));
      expect(built.finalSetTo).toBe(Number(played));
      expect(pointsTheOnlyGameIsPlayedTo(sport, { ...saved, ...built })).toBe(Number(played));
    },
  );

  it.each(PAIRED)(
    "%s: switching 3→1 collapses onto the DECIDING value, and 1→3 restores both",
    (sport) => {
      const [deciding, other] = pointsProbes(sport);
      const bo3 = { bestOf: "3", setTo: other, finalSetTo: deciding };
      const bo1 = setRuleValue(sport, bo3, "bestOf", "1");
      const single = visibleRuleFields(sport, bo1).find((f) => f.label === SINGLE_SET_POINTS_LABEL)!;
      // Seeded from the deciding value, never from `setTo`.
      expect(bo1[single.key]).toBe(deciding);
      expect(buildRuleOverride(sport, bo1)).toMatchObject({ setTo: Number(deciding), finalSetTo: Number(deciding) });

      // 1→3 untouched: both fields back, with their own values.
      const back = setRuleValue(sport, bo1, "bestOf", "3");
      expect(visibleRuleFields(sport, back)).toEqual(SPORT_RULES[sport]);
      expect(buildRuleOverride(sport, back)).toMatchObject({
        setTo: Number(other),
        finalSetTo: Number(deciding),
      });

      // 1→3 after typing into the single field: both fields show the number typed.
      const typed = setRuleValue(sport, bo1, "finalSetTo", other);
      const restored = setRuleValue(sport, typed, "bestOf", "3");
      expect([restored.setTo, restored.finalSetTo]).toEqual([other, other]);
    },
  );

  it.each(PAIRED)(
    "%s: a stage fragment INHERITING best of 1 pins the pair only when the points are edited",
    (sport) => {
      const division = divisionConfig(sport, { bestOf: 1 });
      // Untouched points: the fragment carries no points key at all — the
      // stage keeps inheriting both. An edit to ANOTHER field is still an edit.
      expect(buildRuleOverride(sport, {}, division)).toEqual({});
      const winByOnly = setRuleValue(sport, {}, "winBy", "1", division);
      expect(buildRuleOverride(sport, winByOnly, division)).toEqual({ winBy: 1 });
      // A stale `setTo` in the fragment, with the single field blank, is not
      // re-sent: the pair inherits together (setTo is dead at best of 1).
      expect(buildRuleOverride(sport, { setTo: "9" }, division)).toEqual({});

      // Edited: both keys, and the engine plays that number.
      const [x] = pointsProbes(sport);
      const edited = setRuleValue(sport, {}, "finalSetTo", x, division);
      const built = buildRuleOverride(sport, edited, division);
      expect(built).toEqual({ setTo: Number(x), finalSetTo: Number(x) });
      expect(pointsTheOnlyGameIsPlayedTo(sport, { ...division, ...built })).toBe(Number(x));
    },
  );

  it.each(PAIRED)("%s: at best of 3 the build is exactly the per-field build it always was", (sport) => {
    // Division builder / settings `applyFormat` paths: independent keys, blank
    // fields dropped, nothing mirrored. Expected value assembled from each
    // field's OWN build, so it is the pre-change behaviour by construction.
    const [a, b] = pointsProbes(sport);
    const values = { bestOf: "3", setTo: a, finalSetTo: b, winBy: "" };
    const expected = Object.assign(
      {},
      ...SPORT_RULES[sport]!.filter((f) => values[f.key as keyof typeof values]).map((f) =>
        f.build(values[f.key as keyof typeof values]!, values),
      ),
    );
    expect(buildRuleOverride(sport, values)).toEqual(expected);
    expect(expected).toEqual({ bestOf: 3, setTo: Number(a), finalSetTo: Number(b) });
    // Inherited best of 1 does not reach an explicit 3.
    expect(buildRuleOverride(sport, values, { bestOf: 1 })).toEqual(expected);
  });

  it("leaves a sport with buildOnBlank alone (football's shoot-out pair)", () => {
    // The blank semantics `division-settings.tsx` depends on: a blank field
    // with `buildOnBlank` still emits its delete markers, collapse or not.
    const values = { shootoutWin: "3", shootoutLoss: "" };
    expect(buildRuleOverride("football", values)).toEqual({
      points: { shootoutWin: undefined, shootoutLoss: undefined },
    });
    expect(buildRuleOverride("football", values, { bestOf: 1 })).toEqual(
      buildRuleOverride("football", values),
    );
  });
});

describe("cap validation still sees both keys", () => {
  it.each(PAIRED)("%s: the merged config refuses a single points value over the cap", (sport) => {
    // The server validates the MERGE through the module schema
    // (`cap >= max(setTo, finalSetTo)`), so the pair written together must
    // still be refused over a cap and accepted at it.
    const f = field(sport, "finalSetTo");
    // Table tennis declares no cap FIELD (the module still has the key), so the
    // floor falls back to one above the points minimum.
    const capField = SPORT_RULES[sport]!.find((x) => x.key === "cap");
    const cap = Math.max(capField?.min ?? f.min!, f.min! + 1);
    const division = divisionConfig(sport, { bestOf: 1, setTo: f.min, finalSetTo: f.min, cap });
    const schema = SET_BASED_MODULES[sport]!.configSchema;
    const at = buildRuleOverride(sport, setRuleValue(sport, {}, "finalSetTo", String(cap), division), division);
    expect(schema.safeParse({ ...division, ...at }).success).toBe(true);
    const over = buildRuleOverride(
      sport,
      setRuleValue(sport, {}, "finalSetTo", String(cap + 1), division),
      division,
    );
    expect(over).toEqual({ setTo: cap + 1, finalSetTo: cap + 1 });
    expect(schema.safeParse({ ...division, ...over }).success).toBe(false);
  });
});

describe("the untouched stage save repairs a mismatched pair and nothing else", () => {
  it.each(PAIRED)("%s", (sport) => {
    const [played, dead] = pointsProbes(sport);
    const division = divisionConfig(sport);
    // Both stored, mismatched, best of 1 → setTo follows finalSetTo.
    const stored = { bestOf: 1, setTo: Number(dead), finalSetTo: Number(played) };
    expect(alignBestOfOnePoints(sport, stored, division)).toEqual({
      bestOf: 1,
      setTo: Number(played),
      finalSetTo: Number(played),
    });
    // Inherited best of 1 repairs too.
    const inheritedBo1 = divisionConfig(sport, { bestOf: 1 });
    expect(
      alignBestOfOnePoints(sport, { setTo: Number(dead), finalSetTo: Number(played) }, inheritedBo1),
    ).toEqual({ setTo: Number(played), finalSetTo: Number(played) });
    // Nothing to repair → the SAME object back (the untouched path re-sends
    // the stored fragment verbatim, by identity).
    for (const same of [
      { bestOf: 1 },
      { bestOf: 1, setTo: Number(dead) }, // no finalSetTo to align to — left alone
      { bestOf: 1, finalSetTo: Number(played) }, // no setTo stored — never pinned by a verbatim save
      { bestOf: 1, setTo: Number(played), finalSetTo: Number(played) },
      { bestOf: 3, setTo: Number(dead), finalSetTo: Number(played) }, // not best of 1
    ])
      expect(alignBestOfOnePoints(sport, same, division)).toBe(same);
  });

  it("leaves tennis's fragment alone", () => {
    const stored = { bestOf: 1, set: { gamesTo: 6, winBy: 2, tiebreakAt: 6, tiebreakTo: 7 } };
    expect(alignBestOfOnePoints("tennis", stored, {})).toBe(stored);
  });
});

describe("the division builder's blank best-of never means best of 1", () => {
  it("no shipped variant of the three sports defaults to best of 1", () => {
    // The builder has no inherited config to read — its blank "Default" is the
    // VARIANT's best-of, which the client never sees. That is safe only while
    // no variant ships best of 1. Asked of the engine's own presets (the rows
    // `sync:sports` writes), so a Bo1 variant added later reds here instead of
    // shipping the dead field back into the builder.
    for (const sport of PAIRED) {
      const mod = SET_BASED_MODULES[sport]!;
      const variants = Object.entries(mod.variants);
      expect(variants.length, sport).toBeGreaterThan(0);
      for (const [key, preset] of variants)
        expect(mod.configSchema.parse(preset).bestOf, `${sport}/${key}`).not.toBe(1);
    }
  });
});
