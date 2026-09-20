// Per-stage match format on the stage card (design 2026-09-17 §T5, owner
// ruling D7 "Option A", 2026-09-18).
//
// Node env, no DOM — so these tests cover what a static render CAN settle: the
// three states and their controls, the sport gate, the viewer case, and the
// two derivations behind the row. What they deliberately do NOT claim to cover
// is the editor opening, saving, or clearing: those need a click, and a green
// suite here says nothing about them (AGENTS.md failure class 2). That half is
// proven in the browser.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  StagesPanel,
  stageFormatEditorValues,
  stageFormatHeadline,
  stageFormatSaveFragment,
} from "@/components/v2/stages-panel";
import { SPORT_RULES, buildRuleOverride, ruleOptionLabel } from "@/lib/match-rules";

// Same two mocks every `stages-panel-*.test.tsx` uses — this panel is rendered
// bare, with no provider tree.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const STAGE_ID = "11111111-1111-4111-8111-111111111111";

function panel(over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <StagesPanel
      divisionId="d1"
      competitionId="c1"
      orgSlug="o"
      compSlug="c"
      divSlug="d"
      stages={[
        {
          id: STAGE_ID,
          seq: 1,
          kind: "league",
          name: "League",
          config: {},
          progression: null,
          status: "active",
        },
      ]}
      fixtures={[]}
      entrantNames={{}}
      canEdit
      sportKey="badminton"
      divisionConfig={{ bestOf: 3 }}
      tz="UTC"
      orgTz="UTC"
      canExport={false}
      viewerPlan={{ plan: "pro", isStaff: false } as never}
      {...over}
    />,
  );
}

/** The row's own band, so an assertion cannot accidentally match copy that
 *  belongs to another part of the card. */
function formatRow(html: string): string {
  const start = html.indexOf('data-testid="stage-format"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</div>", html.indexOf("</div>", start) + 1));
}

function stageWith(rules: Record<string, unknown> | null): Record<string, unknown>[] {
  return [
    {
      id: STAGE_ID,
      seq: 1,
      kind: "league",
      name: "League",
      config: rules === null ? {} : { rules },
      progression: null,
      status: "active",
    },
  ];
}

describe("the three states of the Match format row", () => {
  it("inherited — states the division's number and offers only Edit", () => {
    const html = panel();
    expect(html).toContain('data-stage-format-state="inherited"');
    const row = formatRow(html);
    expect(row).toContain("Best of 3");
    expect(row).toContain("Same as division");
    expect(row).toContain('data-testid="stage-format-edit"');
    // Nothing to reset when nothing is overridden.
    expect(row).not.toContain('data-testid="stage-format-clear"');
  });

  it("overridden — states the STAGE's number, not the division's, and offers the reset", () => {
    // The division says 3 and the stage says 1: the summary must show the one
    // the stage will actually be played at. A test where both agreed could not
    // witness the difference.
    const html = panel({ stages: stageWith({ bestOf: 1 }) });
    expect(html).toContain('data-stage-format-state="overridden"');
    const row = formatRow(html);
    expect(row).toContain("Best of 1");
    expect(row).not.toContain("Best of 3");
    expect(row).toContain("Stage override");
    expect(row).toContain('data-testid="stage-format-clear"');
  });

  it("locked — no Edit and no reset, whatever the fixtures say", () => {
    const html = panel({
      stages: stageWith({ bestOf: 1 }),
      formatLockedStageIds: [STAGE_ID],
    });
    expect(html).toContain('data-stage-format-state="locked"');
    const row = formatRow(html);
    expect(row).toContain("Locked");
    expect(row).toContain("Best of 1");
    expect(row).not.toContain('data-testid="stage-format-edit"');
    expect(row).not.toContain('data-testid="stage-format-clear"');
  });

  it("a JSON null `rules` RENDERS as inherited rather than throwing", () => {
    // `typeof null === "object"`, so a guard missing its null check lets the
    // value through and `Object.keys(null)` throws while rendering the card —
    // taking the whole fixtures tab with it. The column is nullable and the
    // clear path writes `config - 'rules'`, but a hand-edited or legacy row
    // can hold an explicit null.
    const html = panel({
      stages: [
        {
          id: STAGE_ID,
          seq: 1,
          kind: "league",
          name: "League",
          config: { rules: null },
          progression: null,
          status: "active",
        },
      ],
    });
    expect(html).toContain('data-stage-format-state="inherited"');
    expect(formatRow(html)).toContain("Same as division");
  });

  it("a viewer reads the line and gets no controls", () => {
    const html = panel({ canEdit: false, stages: stageWith({ bestOf: 1 }) });
    const row = formatRow(html);
    expect(row).toContain("Best of 1");
    expect(row).not.toContain('data-testid="stage-format-edit"');
    expect(row).not.toContain('data-testid="stage-format-clear"');
  });
});

describe("the sport gate", () => {
  it("renders nothing at all for a sport with no per-stage rules", () => {
    // The server 400s SPORT_NOT_SUPPORTED for these, so offering the row would
    // be offering a control that cannot work.
    const html = panel({ sportKey: "football", divisionConfig: {} });
    expect(html).not.toContain('data-testid="stage-format"');
  });

  it("renders nothing when the page passes no sport at all", () => {
    const html = panel({ sportKey: undefined });
    expect(html).not.toContain('data-testid="stage-format"');
  });
});

describe("the two derivations — one function, two different inputs", () => {
  it("the EDITOR hydrates the fragment and ignores the division entirely", () => {
    // The defect this guards: hydrating from the merge fills every field, and
    // the first save PUTs all of them, pinning the stage to today's division
    // format. The stage here overrides ONE key while the division sets four.
    expect(stageFormatEditorValues("badminton", { rules: { bestOf: 1 } })).toEqual({ bestOf: "1" });
    // No rules at all ⇒ an empty editor, never the division's values.
    expect(stageFormatEditorValues("badminton", {})).toEqual({});
    expect(
      stageFormatEditorValues("badminton", { setTo: 21, finalSetTo: 21, cap: 30, bestOf: 3 }),
    ).toEqual({});
  });

  it("a JSON null or a non-object `rules` reads as no override, never as a spread", () => {
    expect(stageFormatEditorValues("badminton", { rules: null })).toEqual({});
    expect(stageFormatEditorValues("badminton", { rules: "nope" })).toEqual({});
    expect(stageFormatEditorValues("badminton", { rules: [1, 2] })).toEqual({});
  });

  it("the SUMMARY reads the effective config and uses the table's own label", () => {
    const label = (SPORT_RULES.badminton ?? [])
      .find((f) => f.key === "bestOf")!
      .options!.find((o) => o.value === "3")!.label;
    // Derived from the declaration, so relabelling "Best of 3" moves this test
    // rather than leaving it asserting yesterday's string.
    expect(stageFormatHeadline("badminton", { bestOf: 3 })).toBe(label);
    expect(stageFormatHeadline("badminton", { ...{ bestOf: 3 }, ...{ bestOf: 1 } })).toBe(
      "Best of 1",
    );
  });

  it("says nothing rather than inventing a number when the config names no bestOf", () => {
    expect(stageFormatHeadline("badminton", {})).toBeNull();
  });

  it("labels a value the sport's own picker cannot offer (D9)", () => {
    // Badminton offers [1,3]; 5 is still a valid saved config, and the live
    // walkthrough stage carries exactly that. Found in the browser: this read
    // "5 · Stage override" directly beneath "Best of 3 · Locked". The label is
    // borrowed from a sport that does offer 5 — still the table, never a
    // string typed here.
    const borrowed = (SPORT_RULES.tennis ?? [])
      .find((f) => f.key === "bestOf")!
      .options!.find((o) => o.value === "5")!.label;
    expect(stageFormatHeadline("badminton", { bestOf: 5 })).toBe(borrowed);
    expect(stageFormatHeadline("badminton", { bestOf: 5 })).toBe("Best of 5");
  });

  it("borrows through the SAME lookup the editor's synthetic option uses", () => {
    // The two halves of D9 are one screen: the summary line above the open
    // editor, and the synthetic <option> inside it. They shipped from two
    // different code paths and disagreed — the dropdown read
    // `Default · 5 · Best of 1 · Best of 3` under "Best of 5 · Stage
    // override". Anchoring both on `ruleOptionLabel` is what makes that
    // impossible; this pins the summary half to it.
    // (`match-rules-unofferable-value.test.tsx` pins the option half.)
    for (const value of ["1", "3", "5", "9"]) {
      const expected = ruleOptionLabel("badminton", "bestOf", value) ?? value;
      expect(stageFormatHeadline("badminton", { bestOf: Number(value) })).toBe(expected);
    }
  });

  it("falls back to the bare value when no sport offers it at all", () => {
    // 9 is in no picker anywhere, so there is no label to borrow and the row
    // states the raw number rather than inventing copy.
    expect(stageFormatHeadline("badminton", { bestOf: 9 })).toBe("9");
  });
});

describe("what a Save actually PUTs", () => {
  it("re-sends the stored fragment verbatim when the organiser touched nothing", () => {
    const stored = { bestOf: 1 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    expect(stageFormatSaveFragment("badminton", stored, opened, opened)).toBe(stored);
  });

  it("PRESERVES a stored value no field can hydrate, on an untouched save", () => {
    // The case this guard exists for. A tennis `set` matching none of the
    // three declared shapes hydrates to nothing, so a rebuilt fragment drops
    // it — and an omitted key here means "inherit the division", i.e. the
    // override is gone. The editor showed the organiser nothing to touch, so
    // a save must not be what deletes it.
    const stored = { set: { gamesTo: 9, winBy: 2, tiebreakAt: 8, tiebreakTo: 7 } };
    const opened = stageFormatEditorValues("tennis", { rules: stored });
    expect(opened).toEqual({}); // the premise: it really is unhydratable
    expect(buildRuleOverride("tennis", opened)).toEqual({}); // …and really would be dropped
    expect(stageFormatSaveFragment("tennis", stored, opened, opened)).toEqual(stored);
  });

  it("rebuilds from the fields once the organiser actually changes one", () => {
    const stored = { bestOf: 1 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    const edited = { ...opened, bestOf: "3" };
    expect(stageFormatSaveFragment("badminton", stored, opened, edited)).toEqual({ bestOf: 3 });
  });

  it("notices a field being CLEARED, which is an edit and not an untouched save", () => {
    const stored = { bestOf: 1, setTo: 21 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    const cleared = { ...opened, setTo: "" };
    expect(stageFormatSaveFragment("badminton", stored, opened, cleared)).toEqual({ bestOf: 1 });
  });
});

describe("the card keeps its property of having no phone branch", () => {
  it("adds no width-conditional classes to the stage card", () => {
    // Option A was chosen partly because MatchRuleFields' own
    // `sm:grid-cols-3` does the phone stacking. Anchored on `\s...hidden"` —
    // `/\bmd:hidden\b/` also matches inside `max-md:hidden`, so the obvious
    // regex passes on its own inversion.
    const html = panel({ stages: stageWith({ bestOf: 1 }) });
    const row = formatRow(html);
    expect(row).not.toMatch(/\smax-md:/);
    expect(row).not.toMatch(/\smd:hidden"/);
  });
});
