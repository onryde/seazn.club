// Per-stage match format on the stage card (design 2026-09-17 §T5, owner
// ruling D7 "Option A", 2026-09-18).
//
// Node env, no DOM — so these tests cover what a static render CAN settle: the
// three states and their controls, the row for every sport (W2c Task 17 removed
// the sport gate), the deciders notice, the viewer case, and the two derivations
// behind the row. What they deliberately do NOT claim to cover
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
  stageRulesInForce,
} from "@/components/v2/stages-panel";
import { MatchRuleFields } from "@/components/v2/match-rules";
import {
  SPORT_RULES,
  buildRuleOverride,
  ruleOptionLabel,
  setRuleValue,
  visibleRuleFields,
} from "@/lib/match-rules";
import { pointsTheOnlyGameIsPlayedTo } from "@/lib/__tests__/_single-game-target";
import { badminton } from "@seazn/engine/sports/setbased";
import { BRACKET_KINDS } from "@seazn/engine/core";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { decidersOffRules, mergedStageRules, stageRulesOverlay } from "@/lib/stage-decider-off";

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

describe("the row is offered for EVERY sport (W2c Task 17: the STAGE_RULES_SPORTS gate is gone)", () => {
  it("renders the rules row for every shipped sport, on a league and on every bracket kind (counted)", () => {
    // The server used to 400 SPORT_NOT_SUPPORTED for all but four sports, and the row hid itself to match; now every
    // sport takes stage rules. The population is the engine's registry and kind list, never a list typed here.
    let rendered = 0;
    const missing: string[] = [];
    const kinds = ["league", ...BRACKET_KINDS] as const;
    for (const m of builtinModules)
      for (const kind of kinds) {
        const html = panel({
          sportKey: m.key,
          divisionConfig: {},
          stages: [{ id: STAGE_ID, seq: 1, kind, name: "Stage", config: {}, progression: null, status: "active" }],
        });
        rendered++;
        if (!html.includes(`data-testid="stage-format-row-${STAGE_ID}"`) || !html.includes('data-testid="stage-format-edit"'))
          missing.push(`${m.key}/${kind}`);
      }
    expect(missing).toEqual([]);
    expect(rendered).toBe(builtinModules.length * kinds.length);
    expect(rendered).toBeGreaterThan(builtinModules.length * 2);
  });

  // PENDING REWRITE (rebase 2026-10-23, ruling D1): main's chess test below pins the pre-W2c gate (no stage row for
  // chess). W2c Task 17 offers the row for every sport; the test is rewritten at the tip to pin D1: on a Lichess
  // division the stage row hides the clock fields, and the rungs stay editable.
  it("review of PR #986: chess - a Lichess division included - has no per-stage match format row, so no free stage clock or delay is ever offered there", () => {
    // The Match rules grid of a chess division carries the clock fields (time, increment, delay). The stage's own editor
    // mounts the same MatchRuleFields, so it must never mount for chess: the Lichess clock is the division's alone
    // (server: stage-rules.test.ts, external-play-guard.test.ts).
    const lichess = { variant: "classical", clock: { base: 600, increment: 5 }, onlinePlay: "lichess" };
    const html = panel({ sportKey: "boardgame", divisionConfig: lichess });
    expect(html).not.toContain('data-testid="stage-format"');
    expect(panel({ sportKey: "badminton" }), "the positive: the same panel for a sets-based sport DOES render the row").toContain('data-testid="stage-format"');
  });

  it("renders nothing when the page passes no sport at all, or a sport the registry does not ship", () => {
    expect(panel({ sportKey: undefined })).not.toContain('data-testid="stage-format"');
    expect(panel({ sportKey: "kabaddi-not-shipped" })).not.toContain('data-testid="stage-format"');
    // The positive pair: a shipped sport, same props, does render it.
    expect(panel({ sportKey: "football", divisionConfig: {} })).toContain('data-testid="stage-format"');
  });
});

describe("the lock line (S4) and the read-only view", () => {
  it("a locked stage says so BEFORE anyone tries: one line, a link to the fixtures, no edit control", () => {
    const html = panel({ stages: stageWith({ bestOf: 1 }), formatLockedStageIds: [STAGE_ID] });
    expect(html).toContain('data-testid="stage-format-locked"');
    expect(html).toContain("This stage has started");
    expect(html).toContain("See the fixtures");
    expect(html).toContain('data-testid="stage-format-view"'); // read the rules without being able to change them
    expect(html).not.toContain('data-testid="stage-format-edit"');
  });

  it("an unlocked stage shows no lock line, and a viewer gets the read-only view but not the lock line", () => {
    expect(panel({ stages: stageWith({ bestOf: 1 }) })).not.toContain('data-testid="stage-format-locked"');
    const viewer = panel({ canEdit: false, stages: stageWith({ bestOf: 1 }) });
    expect(viewer).not.toContain('data-testid="stage-format-locked"');
    expect(viewer).toContain('data-testid="stage-format-view"');
    expect(viewer).not.toContain('data-testid="stage-format-edit"');
  });
});

describe("the deciders notice on the row reads the RESOLVED cfg (carry G1) and the engine's declarations (M-3)", () => {
  const mod = (key: string) => builtinModules.find((m) => m.key === key)!;
  const koStage = (rules: Record<string, unknown> | null, kind = "knockout"): Record<string, unknown>[] => [
    { id: STAGE_ID, seq: 1, kind, name: "KO", config: rules === null ? {} : { rules }, progression: null, status: "active" },
  ];
  const footballDivision = { ...mod("football").configSchema.parse({}) } as Record<string, unknown>;
  const chessVariant = Object.keys(mod("boardgame").variants)[0]!;
  const chessDivision = { ...mod("boardgame").configSchema.parse(mod("boardgame").variants[chessVariant]) } as Record<string, unknown>;

  it("football: every decider off holds the match (notice); the knockout preset does not; a league never says it", () => {
    const off = decidersOffRules(mod("football"), Object.keys(mod("football").variants)[0]!);
    expect(Object.keys(off).length, "premise: football has deciders to switch off").toBeGreaterThan(0);
    const offHtml = panel({ sportKey: "football", divisionConfig: footballDivision, stages: koStage(off) });
    expect(offHtml).toContain('data-testid="stage-deciders-off"');
    expect(offHtml).not.toContain('data-testid="stage-deciders-level"');
    const preset = stageDefaultsFor(mod("football"), "knockout", null);
    expect(Object.keys(preset).length, "premise: football declares a knockout preset").toBeGreaterThan(0);
    const presetHtml = panel({ sportKey: "football", divisionConfig: footballDivision, stages: koStage(preset) });
    expect(presetHtml).not.toContain('data-testid="stage-deciders-off"');
    expect(presetHtml).not.toContain('data-testid="stage-deciders-level"');
    // a league has no knockout to hold
    expect(panel({ sportKey: "football", divisionConfig: footballDivision, stages: koStage(off, "league") })).not.toContain(
      'data-testid="stage-deciders-off"',
    );
  });

  it("football: extra time on with the shoot-out off can still end level, and the row says so (M-3, from canEndLevel)", () => {
    const rules = { ...decidersOffRules(mod("football"), Object.keys(mod("football").variants)[0]!), ...stageDefaultsFor(mod("football"), "knockout", null), shootout: false };
    const html = panel({ sportKey: "football", divisionConfig: footballDivision, stages: koStage(rules) });
    expect(html).toContain('data-testid="stage-deciders-level"');
    expect(html).not.toContain('data-testid="stage-deciders-off"');
  });

  it("chess: an EMPTY rung list holds the match; no list, or a list of one, does not (carry 3, and G1's resolved cfg)", () => {
    const empty = panel({ sportKey: "boardgame", divisionConfig: chessDivision, stages: koStage({ tiebreakRungs: [] }) });
    expect(empty).toContain('data-testid="stage-deciders-off"');
    // No stored list: the bracket overlay forces the tie-break on, so the RAW rules (which carry nothing) must not be
    // read as "off" - the stage plays the default list.
    expect(panel({ sportKey: "boardgame", divisionConfig: { ...chessDivision, tiebreak: false }, stages: koStage(null) })).not.toContain(
      'data-testid="stage-deciders-off"',
    );
    const rung = (mod("boardgame").configSchema.parse({}) as Record<string, unknown>).tiebreakRungs;
    const one = Array.isArray(rung) && rung.length > 0 ? [rung[0]] : ["armageddon"];
    expect(panel({ sportKey: "boardgame", divisionConfig: chessDivision, stages: koStage({ tiebreakRungs: one }) })).not.toContain(
      'data-testid="stage-deciders-off"',
    );
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
    // Badminton offers [1,3,5] since the 2026-09-20 widen, so 5 is answered by
    // its OWN option and cannot witness the borrow any more. 7 is the live
    // case: tabletennis and volleyball declare it, badminton and tennis do
    // not. Found in the browser with the original value: this read
    // "5 · Stage override" directly beneath "Best of 3 · Locked". The label is
    // borrowed from a sport that does offer the value — still the table, never
    // a string typed here.
    expect(
      (SPORT_RULES.badminton ?? [])
        .find((f) => f.key === "bestOf")!
        .options!.map((o) => o.value),
    ).not.toContain("7");
    const borrowed = (SPORT_RULES.tabletennis ?? [])
      .find((f) => f.key === "bestOf")!
      .options!.find((o) => o.value === "7")!.label;
    expect(stageFormatHeadline("badminton", { bestOf: 7 })).toBe(borrowed);
    expect(stageFormatHeadline("badminton", { bestOf: 7 })).toBe("Best of 7");
  });

  it("states badminton's own 5 from its own option, not a borrow (2026-09-20)", () => {
    // The widen's half of this surface: the summary line that started the
    // whole D9 thread — "Best of 5" over a picker that could not offer 5 —
    // now reads off badminton's OWN declaration, so summary and dropdown
    // agree without the borrow being involved at all.
    const own = (SPORT_RULES.badminton ?? [])
      .find((f) => f.key === "bestOf")!
      .options!.find((o) => o.value === "5")!.label;
    expect(own).toBe("Best of 5");
    expect(stageFormatHeadline("badminton", { bestOf: 5 })).toBe(own);
  });

  it("borrows through the SAME lookup the editor's synthetic option uses", () => {
    // The two halves of D9 are one screen: the summary line above the open
    // editor, and the synthetic <option> inside it. They shipped from two
    // different code paths and disagreed — the dropdown read
    // `Default · 5 · Best of 1 · Best of 3` under "Best of 5 · Stage
    // override". Anchoring both on `ruleOptionLabel` is what makes that
    // impossible; this pins the summary half to it.
    // (`match-rules-unofferable-value.test.tsx` pins the option half.)
    // 1/3/5 are badminton's own options, 7 is the borrow, 9 the bare-value
    // fallback — all three branches of `ruleOptionLabel`, through both paths.
    for (const value of ["1", "3", "5", "7", "9"]) {
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

  it("notices a field being CLEARED: it is sent as null, and the merged stored rules lose the key (the cleared field is NOT silently kept)", () => {
    const stored = { bestOf: 3, setTo: 21 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    expect(opened.setTo, "premise: the field opens filled").toBe("21");
    const cleared = { ...opened, setTo: "" };
    const fragment = stageFormatSaveFragment("badminton", stored, opened, cleared);
    expect(fragment).toEqual({ setTo: null });
    // Read the stored rules back through the endpoint's own merge: the key is gone, the sibling stays.
    expect(mergedStageRules(stored, fragment)).toEqual({ bestOf: 3 });
    // And a fragment of ONLY what changed: an unrelated edit leaves the cleared-before keys alone.
    expect(stageFormatSaveFragment("badminton", stored, opened, { ...opened, bestOf: "5" })).toEqual({ bestOf: 5 });
  });

  it("clearing the LAST field of a stage is a null for that key, not an empty fragment (which would clear the whole stage)", () => {
    const stored = { cap: 30 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    const fragment = stageFormatSaveFragment("badminton", stored, opened, { ...opened, cap: "" });
    expect(fragment).toEqual({ cap: null });
    expect(Object.keys(fragment).length).toBeGreaterThan(0);
    expect(mergedStageRules(stored, fragment)).toBeNull(); // the endpoint stores null (no rules) - the organiser's own clear
  });

  it("an edit with no net effect re-sends the stored fragment, never an empty one", () => {
    const stored = { bestOf: 3 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    const fragment = stageFormatSaveFragment("badminton", stored, opened, { ...opened, bestOf: "3", cap: "" });
    expect(fragment).toEqual(stored);
    expect(Object.keys(fragment).length).toBeGreaterThan(0);
  });

  it("a period sport's decider switched OFF is sent as false (null would mean inherit), and reads back as off", () => {
    const icehockey = builtinModules.find((m) => m.key === "icehockey")!;
    const division = icehockey.configSchema.parse({}) as Record<string, unknown>;
    expect(division.shootout, "premise: the division's shoot-out is on, so off is a real change").not.toBeNull();
    const stored = {};
    const opened = stageFormatEditorValues("icehockey", { rules: stored });
    const fragment = stageFormatSaveFragment("icehockey", stored, opened, { ...opened, shootout: "off" }, division);
    expect(fragment).toEqual({ shootout: false });
    // The overlay (the resolver's read of the stored rules) maps that false to the engine's null.
    expect(stageRulesOverlay(icehockey, division, mergedStageRules(stored, fragment))).toEqual({ shootout: null });
    // Reopening shows it as Off, and clearing the field removes the key (inherit again).
    const reopened = stageFormatEditorValues("icehockey", { rules: { shootout: false } });
    expect(reopened.shootout).toBe("off");
    expect(stageFormatSaveFragment("icehockey", { shootout: false }, reopened, { ...reopened, shootout: "" }, division)).toEqual({ shootout: null });
  });

  it("chess: saving the EMPTY rung list persists [], a reload shows it, and the next save does not bring a rung back", () => {
    const stored0 = {};
    const opened0 = stageFormatEditorValues("boardgame", { rules: stored0 });
    const token = SPORT_RULES.boardgame!.find((f) => f.kind === "sequence")!.emptyValue!;
    const fragment1 = stageFormatSaveFragment("boardgame", stored0, opened0, { ...opened0, tiebreakRungs: token });
    expect(fragment1).toEqual({ tiebreakRungs: [] });
    const stored1 = mergedStageRules(stored0, fragment1)!;
    expect(stored1).toEqual({ tiebreakRungs: [] }); // an empty list is a VALUE, not an absent key
    // reload: the editor opens on the empty token, and an untouched save re-sends the empty list
    const opened1 = stageFormatEditorValues("boardgame", { rules: stored1 });
    expect(opened1.tiebreakRungs).toBe(token);
    expect(stageFormatSaveFragment("boardgame", stored1, opened1, opened1)).toEqual({ tiebreakRungs: [] });
    // an edit to ANOTHER field omits the list entirely (the merge keeps it), so no rung comes back
    const other = SPORT_RULES.boardgame!.find((f) => f.kind === "select" && (f.options ?? []).length > 1)!;
    const edited = { ...opened1, [other.key]: other.options![0]!.value };
    const fragment2 = stageFormatSaveFragment("boardgame", stored1, opened1, edited);
    expect(Object.keys(fragment2).length, "premise: the edit really changed something").toBeGreaterThan(0);
    expect(Object.hasOwn(fragment2, "tiebreakRungs")).toBe(false);
    expect(mergedStageRules(stored1, fragment2) ?? {}).toMatchObject({ tiebreakRungs: [] });
    // and putting a rung back is a deliberate edit to the list
    const fragment3 = stageFormatSaveFragment("boardgame", stored1, opened1, { ...opened1, tiebreakRungs: "armageddon" });
    expect(fragment3).toEqual({ tiebreakRungs: ["armageddon"] });
  });
});

// W2c batch-5 review Q2 - the editor reopens over what the organiser JUST SAVED, not over the props from before the save.
// `router.refresh()` after the PUT is not awaited, so for a moment the row's props are still the pre-save ones; a reopen
// in that window used to hydrate the editor from them (an empty "Points to win" over a stored best of 1 to 15), and the
// next Save would have diffed against that blank. The row now keeps the PUT's own answer until the props move on. The
// pure half of that lives here (`stageRulesInForce`); the in-page reopen with the refresh held open is the walkthrough
// (`stage-rules-start-promotion.spec.ts`, "best of 1"), the half a node-env render cannot click.
describe("a stage's rules after a save, before the page's props catch up (batch-5 Q2)", () => {
  // Pre-save props: best of 1 with no points key (the organiser had just picked 1); the PUT's answer adds the points.
  const BEFORE = { bestOf: 1 };
  const SAVED = { bestOf: 1, setTo: 15, finalSetTo: 15 };

  it("the empty case: nothing saved reads the props, whatever they are", () => {
    expect(stageRulesInForce(null, BEFORE)).toBe(BEFORE);
    expect(stageRulesInForce(null, undefined)).toEqual({});
    expect(stageRulesInForce(null, null)).toEqual({});
    expect(stageRulesInForce(null, "nope")).toEqual({});
    expect(stageRulesInForce(null, [1])).toEqual({});
  });

  it("while the props are still the ones the save started from, the PUT's answer stands - and the editor opens over it", () => {
    const inForce = stageRulesInForce({ against: BEFORE, rules: SAVED }, BEFORE);
    expect(inForce).toBe(SAVED);
    // The reopen in that window: the number played, not the blank the stale props would hydrate.
    expect(stageFormatEditorValues("badminton", { rules: inForce })).toEqual(stageFormatEditorValues("badminton", { rules: SAVED }));
    expect(stageFormatEditorValues("badminton", { rules: inForce }).finalSetTo).toBe("15");
    expect(stageFormatEditorValues("badminton", { rules: BEFORE }).finalSetTo, "premise: the stale props really hydrate blank").toBeUndefined();
  });

  it("once the props are a different object (the refresh landed), they stand again - even when they differ from the save", () => {
    const refreshed = { bestOf: 3 }; // another editor's save arrived with the refresh
    expect(stageRulesInForce({ against: BEFORE, rules: SAVED }, refreshed)).toBe(refreshed);
    // …and the same value in a new object (the usual refresh) is the props too, not the saved object.
    const same = { ...SAVED };
    expect(stageRulesInForce({ against: BEFORE, rules: SAVED }, same)).toBe(same);
  });

  it("a stage that had no rules: a save into the empty props stands until they move on", () => {
    expect(stageRulesInForce({ against: undefined, rules: SAVED }, undefined)).toBe(SAVED);
    expect(stageRulesInForce({ against: undefined, rules: SAVED }, SAVED)).toBe(SAVED); // the props now ARE a (new) object
  });

  it("a clear: the saved empty fragment reads as inherited at once, over props that still hold the override", () => {
    expect(stageRulesInForce({ against: SAVED, rules: {} }, SAVED)).toEqual({});
    expect(Object.keys(stageRulesInForce({ against: SAVED, rules: {} }, SAVED))).toHaveLength(0);
  });

  it("a second save replaces the first: the latest answer is the one in force", () => {
    const second = { bestOf: 3 };
    expect(stageRulesInForce({ against: BEFORE, rules: second }, BEFORE)).toBe(second);
  });
});

describe("REGRESSION (2026-09-25) — best of 1: the points field an organiser edits is the one the engine plays", () => {
  // Found in review of PR #872. The kernel plays a best-of-1 match's only game
  // to `finalSetTo`; the editor offered "Points to win a set" (`setTo`) first,
  // the organiser set it, and the stage went on being played to the division's
  // deciding-game number. Owner ruling: ONE "Points to win" field that writes
  // both keys. "Which key is played" is asked of the engine by playing a match
  // (`_single-game-target.ts`), never read off `kernel.ts`.

  /** A division whose deciding game (15) differs from the number the organiser
   *  types (21), so the stage's right answer and the value it would silently
   *  inherit are different numbers — the test can tell them apart. Parsed, as
   *  every stored division config is. */
  const division: Record<string, unknown> = {
    ...badminton.configSchema.parse({ setTo: 21, finalSetTo: 15 }),
  };

  /** The points inputs the organiser SEES, read off the rendered grid. */
  function visiblePointsLabels(values: Record<string, string>): string[] {
    const html = renderToStaticMarkup(
      <MatchRuleFields sportKey="badminton" values={values} onChange={() => {}} inherited={division} />,
    );
    return [...html.matchAll(/<span class="label">(Points[^<]*)<\/span><input type="number"/g)].map(
      (m) => m[1]!,
    );
  }

  it("a Bo1 badminton stage: the visible points field set to 21 persists finalSetTo 21 and plays to 21", () => {
    // PREMISE — the trap, through the engine: the fragment the old editor
    // saved for this exact edit (`setTo` only) is played to 15, not 21.
    expect(pointsTheOnlyGameIsPlayedTo("badminton", { ...division, bestOf: 1, setTo: 21 })).toBe(15);

    const stored = { bestOf: 1 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    // ONE points input on screen — there is no second one to get wrong.
    const labels = visiblePointsLabels(opened);
    expect(labels).toHaveLength(1);

    const visible = visibleRuleFields("badminton", opened, division).find((f) => f.label === labels[0])!;
    const edited = setRuleValue("badminton", opened, visible.key, "21", division);
    const fragment = stageFormatSaveFragment("badminton", stored, opened, edited, division);
    // Only what changed (the endpoint merges it over the stored `bestOf: 1`).
    expect(fragment).toEqual({ setTo: 21, finalSetTo: 21 });
    expect(pointsTheOnlyGameIsPlayedTo("badminton", { ...division, ...stored, ...fragment })).toBe(21);
  });

  it("a stage INHERITING best of 1 gets the single field too, and pins nothing it did not edit", () => {
    const bo1Division = { ...division, bestOf: 1 };
    const opened = stageFormatEditorValues("badminton", {});
    const html = renderToStaticMarkup(
      <MatchRuleFields sportKey="badminton" values={opened} onChange={() => {}} inherited={bo1Division} />,
    );
    expect([...html.matchAll(/<span class="label">(Points[^<]*)<\/span><input type="number"/g)]).toHaveLength(1);
    // An edit to another field only: no points key rides along.
    const capOnly = setRuleValue("badminton", opened, "cap", "30", bo1Division);
    expect(stageFormatSaveFragment("badminton", {}, opened, capOnly, bo1Division)).toEqual({ cap: 30 });
    // The points edited: both keys, played at that number.
    const pts = setRuleValue("badminton", opened, "finalSetTo", "21", bo1Division);
    const fragment = stageFormatSaveFragment("badminton", {}, opened, pts, bo1Division);
    expect(fragment).toEqual({ setTo: 21, finalSetTo: 21 });
    expect(pointsTheOnlyGameIsPlayedTo("badminton", { ...bo1Division, ...fragment })).toBe(21);
  });

  it("an untouched save of a mismatched Bo1 fragment writes the played number to both keys", () => {
    // Reopen shows finalSetTo (the number played); pressing Save with nothing
    // touched is still a save, and it repairs the pair to that number.
    const stored = { bestOf: 1, setTo: 11, finalSetTo: 21 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    expect(stageFormatSaveFragment("badminton", stored, opened, opened, division)).toEqual({
      bestOf: 1,
      setTo: 21,
      finalSetTo: 21,
    });
  });

  it("a Bo3 stage keeps both fields and saves them independently", () => {
    // The positive pair: nothing collapses away from best of 1.
    const stored = { bestOf: 3 };
    const opened = stageFormatEditorValues("badminton", { rules: stored });
    expect(visiblePointsLabels(opened)).toEqual(
      ["setTo", "finalSetTo"].map((k) => SPORT_RULES.badminton!.find((f) => f.key === k)!.label),
    );
    const edited = setRuleValue("badminton", opened, "setTo", "21", division);
    expect(stageFormatSaveFragment("badminton", stored, opened, edited, division)).toEqual({ setTo: 21 });
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
