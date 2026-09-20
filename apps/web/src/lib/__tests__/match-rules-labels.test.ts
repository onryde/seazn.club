// The cross-sport label BORROW, and the agreement it rests on.
//
// Two surfaces show a stored option value the sport's own picker does not
// offer:
//
//  - the stage card's summary line (`stageFormatHeadline`), and
//  - the synthetic `<option>` D9 put inside `MatchRuleFields`.
//
// Both route through ONE function, `ruleOptionLabel`, so the dropdown cannot
// read `Default · 5 · Best of 1 · Best of 3` under a summary line that says
// "Best of 5" — which is what the panel actually rendered in the browser
// before this file existed. (That original case was badminton `bestOf: 5`
// against a picker offering [1, 3]; the owner widened the picker to [1, 3, 5]
// on 2026-09-20, so the live unofferable case here is now 7 — declared by
// tabletennis and volleyball, by neither badminton nor tennis.)
//
// The borrow only works because every in-scope sport labels `bestOf`
// identically. That was TRUE but UNPINNED: the day a sport relabels the field
// or an option, the line would render another sport's noun with nothing to
// catch it. The first describe is that guard.
//
// Pure — no database, no DOM.
import { describe, expect, it } from "vitest";
import {
  SPORT_RULES,
  STAGE_RULES_SPORTS,
  borrowOptionLabel,
  ruleOptionLabel,
  type RuleField,
} from "@/lib/match-rules";

const IN_SCOPE = [...STAGE_RULES_SPORTS].sort();

function bestOfField(sport: string): RuleField {
  const field = (SPORT_RULES[sport] ?? []).find((f) => f.key === "bestOf");
  if (field === undefined) throw new Error(`${sport} declares no bestOf field`);
  return field;
}

describe("the four in-scope sports agree on how `bestOf` is labelled", () => {
  it("has four sports to compare, each declaring the field", () => {
    // Guards the sweeps below against going vacuous.
    expect(IN_SCOPE).toEqual(["badminton", "tabletennis", "tennis", "volleyball"]);
    for (const sport of IN_SCOPE) expect(bestOfField(sport).options ?? []).not.toHaveLength(0);
  });

  it("gives the FIELD one label across all four", () => {
    const labels = new Set(IN_SCOPE.map((s) => bestOfField(s).label));
    expect([...labels]).toHaveLength(1);
  });

  it("gives every SHARED option value one label across all four", () => {
    // Enumerated, not sampled: `1`, `3` and `5` are shared by all four since
    // badminton's 2026-09-20 widen, and `7` by the two that the borrow is now
    // built for (tabletennis and volleyball). A single pair would not witness
    // a relabel in the third.
    const byValue = new Map<string, Map<string, string>>();
    for (const sport of IN_SCOPE)
      for (const option of bestOfField(sport).options ?? [])
        byValue.set(option.value, (byValue.get(option.value) ?? new Map()).set(sport, option.label));

    const shared = [...byValue].filter(([, per]) => per.size > 1);
    // The premise: there really are shared values to disagree about.
    expect(shared.map(([value]) => value).sort()).toEqual(["1", "3", "5", "7"]);
    for (const [value, per] of shared)
      expect(new Set(per.values()), `bestOf="${value}" is labelled differently per sport`).toEqual(
        new Set([[...per.values()][0]]),
      );
  });
});

describe("ruleOptionLabel", () => {
  it("prefers the sport's OWN declared label", () => {
    const own = bestOfField("badminton").options!.find((o) => o.value === "3")!.label;
    expect(ruleOptionLabel("badminton", "bestOf", "3")).toBe(own);
  });

  it("borrows a peer's label for a value this sport's picker cannot offer", () => {
    // 7, not 5: badminton offers 5 itself since the 2026-09-20 widen, so a 5
    // here would be answered by the OWN branch and never reach the borrow at
    // all. 7 is declared by tabletennis and volleyball and by neither
    // badminton nor tennis, so it is the live unofferable case.
    expect(bestOfField("badminton").options!.map((o) => o.value)).not.toContain("7");
    const peer = bestOfField("tabletennis").options!.find((o) => o.value === "7")!.label;
    expect(ruleOptionLabel("badminton", "bestOf", "7")).toBe(peer);
    // Tennis is iterated before tabletennis and declares no 7 — so this also
    // walks past a label-agreeing peer that simply lacks the option, rather
    // than stopping at the first peer.
    expect(bestOfField("tennis").options!.map((o) => o.value)).not.toContain("7");
  });

  it("returns nothing when no in-scope sport offers the value at all", () => {
    // 9 is in no picker anywhere. The caller renders the bare value; inventing
    // copy here would be a second lie.
    for (const sport of IN_SCOPE) expect(ruleOptionLabel(sport, "bestOf", "9")).toBeUndefined();
  });

  it("returns nothing for a field the sport does not declare", () => {
    expect(ruleOptionLabel("badminton", "setType", "tb6")).toBeUndefined();
    expect(ruleOptionLabel("badminton", "no-such-field", "1")).toBeUndefined();
  });

  it("never borrows across the scope boundary", () => {
    // Carrom's `bestOf` is "Best of (games)" — a different field label for a
    // different concept, and carrom is not a stage-rules sport. Borrowing
    // tennis's "Best of 5" onto it, or carrom's label onto tennis, would be
    // the exact cross-sport lie this file guards against.
    expect((SPORT_RULES.carrom ?? []).some((f) => f.key === "bestOf")).toBe(true);
    expect(ruleOptionLabel("carrom", "bestOf", "7")).toBeUndefined();
    expect(ruleOptionLabel("football", "bestOf", "3")).toBeUndefined();
  });

  it("answers for a prototype sport key instead of throwing", () => {
    expect(ruleOptionLabel("constructor", "bestOf", "3")).toBeUndefined();
    expect(ruleOptionLabel("badminton", "constructor", "3")).toBeUndefined();
  });
});

describe("borrowOptionLabel refuses a peer that labels the FIELD differently", () => {
  // `ruleOptionLabel` cannot witness this: the four in-scope sports agree
  // today (pinned above), so the agreement check would be a branch nothing
  // could kill. Peers are passed in here so the disagreement is constructible.
  const field: RuleField = {
    key: "bestOf",
    label: "Best of (sets)",
    kind: "select",
    options: [{ value: "3", label: "Best of 3" }],
    build: () => ({}),
  };
  const agreeing: RuleField = {
    ...field,
    options: [{ value: "5", label: "Best of 5" }],
  };
  const disagreeing: RuleField = { ...agreeing, label: "Best of (games)" };

  it("borrows from a peer whose field label matches", () => {
    expect(borrowOptionLabel(field, [agreeing], "5")).toBe("Best of 5");
  });

  it("refuses the SAME option from a peer whose field label does not", () => {
    // Same value, same option label, different FIELD label — the day a sport
    // relabels `bestOf`, its "Best of 5" means a different thing and the line
    // must fall back to the bare value rather than render another sport's
    // noun. Only the field label differs between these two cases.
    expect(borrowOptionLabel(field, [disagreeing], "5")).toBeUndefined();
  });

  it("skips a disagreeing peer and keeps looking at the rest", () => {
    // Order matters: a refusal must `continue`, not `return`.
    expect(borrowOptionLabel(field, [disagreeing, agreeing], "5")).toBe("Best of 5");
  });

  it("returns nothing when no peer offers the value", () => {
    expect(borrowOptionLabel(field, [agreeing], "9")).toBeUndefined();
    expect(borrowOptionLabel(field, [], "5")).toBeUndefined();
  });
});
