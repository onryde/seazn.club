import { describe, expect, it } from "vitest";
import {
  configKeysFor,
  keysEmittedBy,
  STAGE_RULES_SPORTS,
  type RuleField,
} from "@/lib/match-rules";

describe("configKeysFor", () => {
  // Tennis is the case that matters: three of its five FIELD keys differ from
  // the CONFIG keys their build() writes (setType -> set, noAd -> game,
  // tiebreakWinBy -> tiebreak). A list built from field.key would reject four
  // of five tennis overrides at the endpoint.
  it("returns the keys build() emits, not the field keys, for tennis", () => {
    const keys = configKeysFor("tennis");
    expect([...keys].sort()).toEqual(["bestOf", "finalSet", "game", "set", "tiebreak"]);
    expect(keys.has("setType")).toBe(false);
    expect(keys.has("noAd")).toBe(false);
    expect(keys.has("tiebreakWinBy")).toBe(false);
  });

  it("covers winBy for all three shared-const sports", () => {
    for (const sport of ["volleyball", "badminton", "tabletennis"])
      expect(configKeysFor(sport).has("winBy")).toBe(true);
  });

  it("never admits points or the decider keys for an in-scope sport", () => {
    for (const sport of STAGE_RULES_SPORTS) {
      const keys = configKeysFor(sport);
      expect(keys.has("points")).toBe(false);
      expect(keys.has("pointsMap")).toBe(false);
      expect(keys.has("shootout")).toBe(false);
      expect(keys.has("extraTime")).toBe(false);
    }
  });

  it("is empty for a sport with no rules table", () => {
    expect(configKeysFor("nosuchsport").size).toBe(0);
  });

  // Added after Task 1: cutting probeValuesFor down to the first option left
  // every other test green, because no IN-SCOPE field branches its emitted key
  // set on its value (carrom's gameTo is the only one in the whole table, and
  // it is out of scope). Without this case the multi-probe loop is an
  // unwitnessed guard — correct, but nothing reds if someone deletes it.
  it("probes every option, so a value-branching build cannot hide a key", () => {
    const branching: RuleField = {
      key: "probe",
      label: "Probe",
      kind: "select",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      build: (v) => (v === "b" ? { onlyForB: 1 } : { always: 1 }),
    };
    expect(keysEmittedBy([branching])).toEqual(new Set(["always", "onlyForB"]));
  });
});
