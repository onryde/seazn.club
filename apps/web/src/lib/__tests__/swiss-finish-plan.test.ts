// W3 Task 13 (RB3-20, X-SW-26) — the desk's read of a Finish plan off a refusal's details, and the confirm's sentence.
// The plan is offered ONLY with `canFinish: true` and a whole, consistent `{ after, rounds }` (THE Finish predicate's k
// and N): a door that cannot say what Finish removes offers no Finish. Expected sentences are the en dictionary's own
// copy with the values put in here, never the module's output.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import {
  swissFinishConfirm,
  swissFinishConfirmBody,
  swissFinishedNotice,
  swissFinishNotReadyText,
  swissFinishPlanOf,
} from "../swiss-finish-plan";
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

describe("the confirm (owner Q4's copy: \"The Swiss ends after round {k}. The table is recalculated as a {k}-round event. Rounds {k+1}–{N} are removed.\")", () => {
  it("many, one and no rounds removed; the barrier sentence only when rounds go", () => {
    const undo = EN["swiss.refusal.SWISS_ROUNDS_CHANGE_NOT_UNDOABLE"]!;
    expect(swissFinishConfirmBody({ after: 3, rounds: 5 }, msg)).toBe(
      `${fill("stage.finish.confirm.final", { round: 3 })} ${fill("stage.finish.confirm.removeMany", { from: 4, to: 5 })} ${undo}`,
    );
    expect(EN["stage.finish.confirm.final"]).toBe("The Swiss ends after round {round}. The table is recalculated as a {round}-round event.");
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
    // Fix round 1 (review m3): "the round in progress" only when a round past k has started (`inProgress: true`, or a
    // server that does not say); a finished round reopened by a take-back says so instead.
    const owed = fill("swiss.finish.owed", { boards: ref(1, 2) });
    const one = [{ fixtureId: "a", round: 1, board: 2 }];
    expect(swissRefusalText("SWISS_FINISH_ROUND_UNDECIDED", { inProgress: true, boards: one }, msg, plural)).toBe(`${sentence} ${owed}`);
    expect(swissRefusalText("SWISS_FINISH_ROUND_UNDECIDED", { inProgress: false, boards: one }, msg, plural)).toBe(
      `${EN["swiss.finish.reopened"]} ${owed}`,
    );
    expect(swissRefusalText("SWISS_FINISH_ROUND_UNDECIDED", { inProgress: false }, msg, plural)).toBe(EN["swiss.finish.reopened"]);
    expect(EN["swiss.finish.reopened"], "premise: two different sentences").not.toBe(sentence);
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

describe("what the panels say after a Finish (review m5, m6)", () => {
  const realPlural = (key: string, count: number, vars?: Record<string, string | number>) =>
    pluralRuntime(EN as unknown as Dict, key, count, "en", vars);
  const freed = (n: number) => fill(n === 1 ? "schedule.notice.roundsSlotsFreed.one" : "schedule.notice.roundsSlotsFreed.other", { count: n });
  it("completed: the round, plus the slots freed when any; not completed: that the stage is not complete yet", () => {
    const ROWS: [{ finished_after: number; slots_freed: number; completed: boolean }, string][] = [
      [{ finished_after: 3, slots_freed: 0, completed: true }, fill("schedule.notice.swissFinished", { round: 3 })],
      [{ finished_after: 3, slots_freed: 1, completed: true }, `${fill("schedule.notice.swissFinished", { round: 3 })} ${freed(1)}`],
      [{ finished_after: 2, slots_freed: 4, completed: true }, `${fill("schedule.notice.swissFinished", { round: 2 })} ${freed(4)}`],
      [{ finished_after: 3, slots_freed: 0, completed: false }, fill("schedule.notice.swissFinishedOpen", { round: 3 })],
      [{ finished_after: 3, slots_freed: 2, completed: false }, `${fill("schedule.notice.swissFinishedOpen", { round: 3 })} ${freed(2)}`],
    ];
    let checked = 0;
    for (const [out, expected] of ROWS) {
      expect(swissFinishedNotice(out, msg, realPlural), JSON.stringify(out)).toBe(expected);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(ROWS.length);
    expect(EN["schedule.notice.swissFinishedOpen"], "premise: not the finished sentence").not.toBe(EN["schedule.notice.swissFinished"]);
  });

  it("STAGE_NOT_READY on the Finish door is said in the reader's language; any other code is left to its own copy", () => {
    expect(swissFinishNotReadyText("STAGE_NOT_READY", msg)).toBe(EN["stage.finish.notReady"]);
    for (const code of ["SWISS_OVER", "SCHEDULE_LOCKED", "", undefined]) expect(swissFinishNotReadyText(code, msg), String(code)).toBeNull();
  });
});
