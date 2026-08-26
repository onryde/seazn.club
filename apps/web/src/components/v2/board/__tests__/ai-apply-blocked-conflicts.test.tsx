// The apply step names the matches a blocking 409 refused over.
//
// The reported bug was the SENTENCE — every 409 said "The schedule changed
// while planning — reopen and try again", including the one where the schedule
// had not changed at all and the plan itself double-booked the board. Retrying
// that one reproduces it exactly, which is what "I get this twice without
// touching anything" looks like from the organiser's side.
//
// `aiErrorKey`'s split is pinned in ai-console-state.test.ts and the capture of
// the conflict list in ai-apply.test.ts. Neither of those can see whether the
// list ever reaches the screen: a payload threaded to a component that does not
// render it is invisible to both. This is that witness.
//
// Assertions anchor on rendered TEXT (the copy is the fix) and on the testid
// with `="`, since React serialises an omitted prop as `"$undefined"`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ApplyStep } from "../ai-console";
import { initialAiConsoleState, type AiConsoleState } from "../ai-console-state";
import type { AiConsoleFixture } from "../ai-diff";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import en from "@/dictionaries/en/ui.json";

const enDict = en as Record<string, string>;

const F = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

const fixtures: AiConsoleFixture[] = [1, 2, 3, 4, 5, 6].map((i) => ({
  id: F(i),
  stage_id: "st-1",
  scheduled_at: null,
  court_label: null,
  code: `R1·${i}`,
  matchup: `Home ${i} vs Away ${i}`,
  isFinal: false,
  isJunior: false,
  status: "scheduled",
  home_entrant_id: `en-${i}a`,
  away_entrant_id: `en-${i}b`,
})) as unknown as AiConsoleFixture[];

const plan = {
  proposal: [{ fixture_id: F(1), scheduled_at: "2026-08-01T09:00:00.000Z", court_label: "Court 1" }],
  unschedulable: [],
  warnings: [],
  blocking: [],
  assumptions: [],
  diff: { moved: [], placed: [F(1)], unscheduled: [], unchanged: [] },
  explanations: [],
  summary: "Placed one match.",
  usage: { input_tokens: 10, output_tokens: 20, repair_rounds: 0 },
  credits: 1,
} as unknown as AiPlanResponse;

function format(key: string, vars?: Record<string, string | number>): string {
  const raw = enDict[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m)) : raw;
}

function applyStep(error: AiConsoleState["error"]): string {
  const state: AiConsoleState = {
    ...initialAiConsoleState,
    step: "apply",
    run: "error",
    schedulePlan: plan,
    error,
  };
  return renderToStaticMarkup(
    <DictProvider dict={enDict as unknown as Dict} locale="en">
      <ApplyStep
        state={state}
        plan={plan}
        currency="usd"
        fixtures={fixtures}
        settingsReady
        applying={false}
        applyResult={null}
        undoing={false}
        undone={false}
        onApply={() => {}}
        onDiscard={() => {}}
        onUndo={() => {}}
        onReRunRefine={() => {}}
        msg={(k, v) => format(k as string, v as Record<string, string | number> | undefined)}
      />
    </DictProvider>,
  );
}

describe("a blocked apply names the matches it clashed with", () => {
  it("lists the blocking fixtures by code and matchup", () => {
    const html = applyStep({
      status: 409,
      message: format("board.ai.error.blocked"),
      key: "board.ai.error.blocked",
      conflicts: [
        { fixtureId: F(2), code: "court_double_booked" },
        { fixtureId: F(3), code: "entrant_double_booked" },
      ],
    });

    expect(html).toContain('data-testid="ai-blocked-fixtures"');
    // The refusal's own sentence — the one that replaced "the schedule changed
    // while planning" for this code.
    expect(html).toContain("Applying this would clash with matches already on the board");
    // …and WHICH matches, in the board's own vocabulary rather than as ids.
    expect(html).toContain("R1·2");
    expect(html).toContain("Home 2 vs Away 2");
    expect(html).toContain("R1·3");
    expect(html).not.toContain(F(2));
  });

  it("caps the list and says how many more there were", () => {
    const html = applyStep({
      status: 409,
      message: format("board.ai.error.blocked"),
      key: "board.ai.error.blocked",
      conflicts: [2, 3, 4, 5, 6].map((i) => ({ fixtureId: F(i), code: "court_double_booked" })),
    });

    expect(html).toContain("R1·2");
    expect(html).toContain("R1·5");
    // The fifth is folded into the counter rather than growing the block
    // without bound inside a dock that is already dense.
    expect(html).not.toContain("R1·6");
    expect(html).toContain("1 more");
  });

  it("says nothing extra when the refusal named no fixtures", () => {
    // A 409 whose envelope carried no usable conflict rows still gets the
    // honest sentence — but an empty list would read as "affected matches:
    // (none)", which is worse than not listing at all.
    const html = applyStep({
      status: 409,
      message: format("board.ai.error.blocked"),
      key: "board.ai.error.blocked",
    });

    expect(html).toContain("Applying this would clash with matches already on the board");
    expect(html).not.toContain('data-testid="ai-blocked-fixtures"');
  });

  it("leaves every other failure's error block exactly as it was", () => {
    // The stale-board 409 keeps its own copy AND must not sprout a list — the
    // fixtures it would name are not the point of that failure.
    const html = applyStep({
      status: 409,
      message: format("board.ai.error.conflict"),
      key: "board.ai.error.conflict",
      conflicts: [{ fixtureId: F(2), code: "court_double_booked" }],
    });

    expect(html).toContain("The schedule changed while planning");
    expect(html).not.toContain('data-testid="ai-blocked-fixtures"');
  });
});
