// S13/#422 W11 cutover — re-pin of `cricket-pad-i18n.test.tsx` (v1's
// `BallForm`, deleted this session) against the v2 cricket skin's
// `ThisOverGroup` (the wicket/extra picker lives there now — cricket-skin.tsx
// header comment). Original contract (S7/#427): the wicket/extra option
// labels must read from the active dictionary, never the raw payload enum,
// and `hitballtwice` specifically must not fall through to a naive
// `title(k)` capitalize.
//
// v1's own test proved "reads from the dictionary" with a FAKE sentinel
// override. This file proves the stronger, real-production claim instead:
// rendered under the REAL French dictionary, the text is the REAL French
// translation, not the English one and not a naive capitalize — which is
// only possible if the component is actually calling `msg()`, never
// hardcoding a literal. `extra.penalty` ("Penalty" / "Pénalité") and
// `kind.hitballtwice` ("Hit the ball twice" / "Balle frappée deux fois") are
// the two keys in this component's own vocabulary that genuinely differ
// between en/fr (most cricket terms — "Run out", "Wide" — are identical
// jargon in both dictionaries, so they cannot prove a real lookup happened).
//
// `ThisOverGroup` takes `msg` as a plain parameter (cricket-skin.tsx's own
// `ThisOverProps`), never calls `useMsg()` itself — so, like
// period-skin.test.ts's own convention, no `<DictProvider>`/JSX wrapper is
// needed at all: a real `t(dict, key, vars)` closure IS the locale swap.
import { describe, expect, it } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement } from "react";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";
import frUi from "@/dictionaries/fr/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { wicketLabel } from "@/lib/scoring-vocab";
import { foldMatch } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { cricket as cricketEngine, CricketWicket } from "@seazn/engine/sports/cricket";
import { buildPadView } from "../view-model";
import { ThisOverGroup } from "../skins/cricket-skin";
import { grantAllEntitlements } from "./_cfg-space";

type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;
const enMsg: MsgFn = (key, vars) => tRuntime(messages, key, vars);
const frMsg: MsgFn = (key, vars) => tRuntime(frUi as unknown as Dict, key, vars);

const CFG = cricketEngine.configSchema.parse(cricketEngine.variants.t20);
const LINEUPS = defaultLineupPair(cricketEngine.positions);
const BPO = CFG.ballsPerOver;

/** Real fold, real spec, real view — `core.start` only, so `orders`
 *  (openers/first bowler) are populated straight off the lineup pair and
 *  `canScore` (cricket-skin.tsx) is true from mount with no interaction,
 *  which is all this file needs to reach the Wicket/Extras controls. Mirrors
 *  cricket-skin.test.ts's own `viewFor` shape. */
function island(msg: MsgFn) {
  const events = [makeEnvelope(0, { type: "core.start", payload: {} })];
  const state = foldMatch(cricketEngine, CFG, LINEUPS, events, { strictFromSeq: 0 });
  const spec = cricketEngine.padSpec!(CFG);
  const entitlements = grantAllEntitlements(spec);
  const view = buildPadView(spec, { state, summary: {}, phase: "live", band: 3, entitlements });
  return renderIsland(ThisOverGroup, {
    msg,
    view,
    state,
    bpo: BPO,
    submittingType: null,
    dispatch: async () => {},
  });
}

function find(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement {
  const el = tree.find(pred);
  if (!el) throw new Error("element not found in rendered tree");
  return el;
}
function findAll(tree: ReactElement[], pred: (el: ReactElement) => boolean): ReactElement[] {
  return tree.filter(pred);
}
const isType = (type: unknown) => (el: ReactElement) => el.type === type;

/** Opens the Wicket sub-flow (tap the toggle button, identified by its own
 *  exact caption in whatever locale `msg` is — never "the first enabled
 *  button", which would find one of the run-pad taps instead) and returns
 *  the re-rendered tree with the kind buttons visible. */
function openWicket(pad: ReturnType<typeof island>, msg: MsgFn): ReactElement[] {
  const label = msg("scorepad.skin.cricket.group.wicket");
  const tree = pad.tree();
  const toggle = find(findAll(tree, isType("button")), (el) => textOf(el) === label);
  (propsOf(toggle).onClick as () => void)();
  return pad.tree();
}

describe("cricket skin — ThisOverGroup wicket/extra i18n (re-pinned from cricket-pad-i18n.test.tsx, S7/#427)", () => {
  it("localizes wicket + extra option labels from the REAL dictionary (fr), not hardcoded English", () => {
    const pad = island(frMsg);

    // Extras chips are always visible (no toggle needed).
    const extrasButtons = findAll(pad.tree(), isType("button"));
    const penaltyBtn = find(extrasButtons, (el) => textOf(el) === "Pénalité");
    expect(textOf(penaltyBtn)).toBe("Pénalité");
    expect(textOf(penaltyBtn)).not.toBe("Penalty");

    // Wicket kinds are behind the toggle.
    const opened = openWicket(pad, frMsg);
    const hitBallTwiceBtn = find(findAll(opened, isType("button")), (el) => textOf(el) === "Balle frappée deux fois");
    expect(textOf(hitBallTwiceBtn)).toBe("Balle frappée deux fois");
    expect(textOf(hitBallTwiceBtn)).not.toContain("Hit the ball twice");
    expect(textOf(hitBallTwiceBtn)).not.toContain("Hitballtwice");
  });

  it("labels hitballtwice correctly in English, not a naive capitalize (S7/#427 review)", () => {
    // wicketLabel() checks ONLY WICKET_KEY, never falling through to KIND_KEY
    // the way enumLabel("kind", …) does — so adding the option to the picker
    // without also widening WICKET_KEY made it selectable but WRONG: it fell
    // to title(k) = "Hitballtwice" in every locale, not the real translation.
    // A literal expected string is required here — deriving "expected" from
    // wicketLabel() itself (as the test below does for existence) cannot
    // catch wicketLabel() being wrong, since it would compare the function
    // to itself.
    const pad = island(enMsg);
    const opened = openWicket(pad, enMsg);
    const btn = find(findAll(opened, isType("button")), (el) => textOf(el) === "Hit the ball twice");
    expect(textOf(btn)).toBe("Hit the ball twice");
    expect(textOf(btn)).not.toBe("Hitballtwice");
  });

  it("offers every dismissal kind the engine declares (S7/#427)", () => {
    // Regression: the picker's own kind list had drifted from the engine's —
    // `hitballtwice` (Law 34) was absent, so a correctly-translated label
    // existed and could never be selected. Derived from CricketWicket
    // itself, not a hand-copied list, so a future engine addition reds this
    // too. NOTE: proves EXISTENCE (every kind renders as SOME button), not
    // CORRECTNESS of the label text — it derives "expected" from
    // wicketLabel() itself, so it cannot catch wicketLabel() returning the
    // wrong string; the test above pins hitballtwice's literal text instead.
    const pad = island(enMsg);
    const opened = openWicket(pad, enMsg);
    const buttonTexts = new Set(findAll(opened, isType("button")).map(textOf));
    for (const kind of CricketWicket.shape.kind.options) {
      expect(buttonTexts, `wicket picker missing "${kind}"`).toContain(wicketLabel(kind, enMsg));
    }
  });
});
