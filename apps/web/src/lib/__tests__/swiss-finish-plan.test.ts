// W3 Task 13 (RB3-20, X-SW-26) — the desk's read of a Finish plan off a refusal's details, and the confirm's sentence.
// The plan is offered ONLY with `canFinish: true` and a whole, consistent `{ after, rounds }` (THE Finish predicate's k
// and N): a door that cannot say what Finish removes offers no Finish. Expected sentences are the en dictionary's own
// copy with the values put in here, never the module's output.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { swissFinishConfirm, swissFinishConfirmBody, swissFinishPlanOf } from "../swiss-finish-plan";
import { swissRefusalText } from "../swiss-refusal-text";

const EN = en as unknown as Record<string, string>;
const msg = (key: string, vars?: Record<string, string | number>) => tRuntime(EN as unknown as Dict, key, vars);
const plural = (key: string, _count: number, vars?: Record<string, string | number>) => msg(`${key}.other`, vars);
const fill = (key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), EN[key]!);

describe("swissFinishPlanOf", () => {
  it("a plan only with canFinish true and a whole after ≤ rounds", () => {
    const ROWS: [string, Record<string, unknown> | undefined, unknown][] = [
      ["offered", { canFinish: true, finish: { after: 3, rounds: 5 } }, { after: 3, rounds: 5 }],
      ["every round played", { canFinish: true, finish: { after: 5, rounds: 5 } }, { after: 5, rounds: 5 }],
      ["canFinish false", { canFinish: false, finish: { after: 3, rounds: 5 } }, null],
      ["canFinish absent", { finish: { after: 3, rounds: 5 } }, null],
      ["no plan sent", { canFinish: true }, null],
      ["k = 0 (nothing to finish with)", { canFinish: true, finish: { after: 0, rounds: 5 } }, null],
      ["after past rounds", { canFinish: true, finish: { after: 6, rounds: 5 } }, null],
      ["not whole", { canFinish: true, finish: { after: 2.5, rounds: 5 } }, null],
      ["a string", { canFinish: true, finish: { after: "3", rounds: 5 } }, null],
      ["no details", undefined, null],
    ];
    let checked = 0;
    for (const [name, details, want] of ROWS) {
      expect(swissFinishPlanOf(details), name).toEqual(want);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(ROWS.length);
  });
});

describe("the confirm (the brief's copy: \"Standings after round {k} become final. Rounds {k+1}–{N} are removed.\")", () => {
  it("many, one and no rounds removed; the barrier sentence only when rounds go", () => {
    const undo = EN["swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"]!;
    expect(swissFinishConfirmBody({ after: 3, rounds: 5 }, msg)).toBe(
      `${fill("stage.finish.confirm.final", { round: 3 })} ${fill("stage.finish.confirm.removeMany", { from: 4, to: 5 })} ${undo}`,
    );
    expect(EN["stage.finish.confirm.final"]).toBe("Standings after round {round} become final.");
    expect(EN["stage.finish.confirm.removeMany"]).toBe("Rounds {from}–{to} are removed.");
    expect(swissFinishConfirmBody({ after: 4, rounds: 5 }, msg)).toBe(
      `${fill("stage.finish.confirm.final", { round: 4 })} ${fill("stage.finish.confirm.removeOne", { round: 5 })} ${undo}`,
    );
    expect(swissFinishConfirmBody({ after: 5, rounds: 5 }, msg)).toBe(fill("stage.finish.confirm.final", { round: 5 }));
    expect(swissFinishConfirm({ after: 3, rounds: 5 }, msg)).toMatchObject({
      title: EN["stage.finish.confirm.title"],
      confirmLabel: EN["stage.finish.confirm.label"],
      cancelLabel: EN["schedule.cancel"],
      tone: "danger",
      size: "touch",
    });
  });
});

describe("swissRefusalText for T13's codes", () => {
  it("SWISS_FINISH_ROUND_UNDECIDED names the boards still to decide, as the abandoned-board refusal names them", () => {
    const sentence = EN["swiss.refusal.SWISS_FINISH_ROUND_UNDECIDED"]!;
    const ref = (round: number, board: number) => fill("schedule.error.swissAbandonedRef", { round, board });
    expect(
      swissRefusalText(
        "SWISS_FINISH_ROUND_UNDECIDED",
        { boards: [{ fixtureId: "a", round: 4, board: 1 }, { fixtureId: "b", round: 4, board: 2 }] },
        msg,
        plural,
      ),
    ).toBe(`${sentence} ${fill("swiss.finish.owed", { boards: `${ref(4, 1)}, ${ref(4, 2)}` })}`);
    expect(swissRefusalText("SWISS_FINISH_ROUND_UNDECIDED", { boards: [] }, msg, plural), "none named: the sentence").toBe(sentence);
    expect(swissRefusalText("SWISS_FINISH_ROUND_UNDECIDED", undefined, msg, plural)).toBe(sentence);
    expect(swissRefusalText("SWISS_FINISH_NOTHING_PLAYED", undefined, msg, plural)).toBe(EN["swiss.refusal.SWISS_FINISH_NOTHING_PLAYED"]);
  });

  it("SWISS_NO_ROUND_LEFT names Finish only when canFinish is true", () => {
    const base = EN["swiss.refusal.SWISS_NO_ROUND_LEFT"]!;
    const ROWS: [Record<string, unknown>, string][] = [
      [{ canAddRound: true, canFinish: true }, "swiss.rounds.noRoundLeft.addOrFinish"],
      [{ canAddRound: true, canFinish: false }, "swiss.rounds.noRoundLeft.add"],
      [{ canAddRound: true }, "swiss.rounds.noRoundLeft.add"],
      [{ canAddRound: false, canFinish: true }, "swiss.rounds.noRoundLeft.finish"],
      [{ canAddRound: false, canFinish: false }, "swiss.rounds.noRoundLeft.none"],
    ];
    let checked = 0;
    for (const [details, key] of ROWS) {
      expect(swissRefusalText("SWISS_NO_ROUND_LEFT", details, msg, plural), JSON.stringify(details)).toBe(`${base} ${EN[key]}`);
      checked++;
    }
    expect(checked).toBe(ROWS.length);
  });
});
