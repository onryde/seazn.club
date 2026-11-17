// W5 T8b Part 3 (X-WDT-10, owner ruling 289's condition: "the Disqualify action, on the pad and in the organiser's menu,
// shows before confirming plain copy naming the consequence") — the three surfaces render the SAME sentences from one preview:
// the organiser's Entrants → Disqualify confirmation body, the pad's sanction sheet read-back (its confirm step's slot, fed the
// payload the Confirm would send) and the pad's pending-ending prompt. Expected English is the brief's wording, typed here.
// Node-only (no DOM): the pad's slot is read off the sheet's own tree, the bodies through renderToStaticMarkup; the browser
// half is e2e/w5-round-robin-app-a.spec.ts ("X-WDT-10 the organiser sees the consequence before disqualifying").
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { t as realT } from "@/lib/i18n-runtime";
import type { WithdrawalPreview } from "@/lib/withdrawal-consequence";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { GuidedSheet } from "../scorepad/v3/guided-sheet";
import { EndingPrompt } from "../scorepad/v3/ending-prompt";
import type { GuidedSheetSpec } from "../scorepad/v3/types";
import { WithdrawalConsequence, disqualifyConfirmBody, type ConsequenceState } from "../withdrawal-consequence";

const t = (k: string, v?: Record<string, string | number>) => realT(uiEn as Dict, k as never, v);
const NAME = "Alexandria Montgomery-Featherstonehaugh III"; // 43 characters
const PREVIEW: WithdrawalPreview = {
  entrant_id: "e-away",
  name: NAME,
  as: "disqualified",
  started: true,
  cascade: true,
  stages: [
    {
      stage_id: "s1",
      stage_kind: "league",
      mode: "expunge",
      played: 2,
      scheduled: 5,
      pending: [
        { fixture_id: "f3", opponent: "Bea", round_no: 3 },
        { fixture_id: "f4", opponent: "Cal", round_no: 4 },
        { fixture_id: "f5", opponent: "Dov", round_no: 5 },
      ],
      undo: "restores",
    },
  ],
};
const WANT = [
  "These 3 remaining matches will be withdrawn: Bea (round 3), Cal (round 4), and Dov (round 5).",
  `${NAME} has played 2 of 5. Under the 50% rule their results will be removed.`,
  "You can undo this with Reinstate.",
];
const linesOf = (html: string) => [...html.matchAll(/<li data-testid="withdrawal-consequence-line">([^<]*)<\/li>/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
const ready: ConsequenceState = { kind: "ready", preview: PREVIEW };

/** A slot feeder: the consequence of the entrant the payload names, nothing for one without a preview. What it proves is the
 *  sheet's half — the slot sits on the read-back step and is handed the payload the Confirm would send. */
function padSlot(byEntrant: Record<string, ConsequenceState>) {
  return function slotFor(payload: Record<string, unknown>): ReactNode {
    return typeof payload.by === "string" && byEntrant[payload.by] !== undefined ? createElement(WithdrawalConsequence, { state: byEntrant[payload.by]!, t }) : null;
  };
}

const sheet: GuidedSheetSpec = {
  event: "badminton.sanction",
  steps: [
    { id: "level", kind: "choice", title: "pad.badminton.sheet.sanction.level.title" as never, options: [{ id: "disqualification", label: "x" }] },
    { id: "endsMatch", kind: "confirm", title: "pad.sanction.confirm.title" as never, summary: () => `This ends the match: ${NAME} loses` },
  ],
  buildPayload: (answers) => ({ by: "e-away", level: answers.level }),
};
const views = { home: { onfield: [], bench: [] }, away: { onfield: [], bench: [] } } as never;

describe("X-WDT-10 the pad and the organiser dialog show the same copy (render both from one preview)", () => {
  it("X-WDT-10 the organiser's Disqualify body, the pad's read-back and the pad's ending prompt carry the same three sentences", () => {
    const organiser = linesOf(renderToStaticMarkup(createElement("div", null, disqualifyConfirmBody(ready, t, "en"))));
    expect(organiser, "the organiser's confirmation").toEqual(WANT);

    // The pad's sheet: pick the ending level, land on the read-back; the slot under it is fed the Confirm's own payload.
    const island = renderIsland(GuidedSheet, { spec: sheet, views, personNames: {}, t, onComplete: () => {}, confirmExtra: padSlot({ "e-away": ready }) });
    (propsOf(island.tree().find((el) => el.type === "button" && propsOf(el)["data-choice-option-id"] === "disqualification")!).onClick as () => void)();
    const tree = island.tree();
    expect(tree.some((el) => propsOf(el)["data-testid"] === "pad-sheet-confirm"), "on the read-back step").toBe(true);
    const slot = tree.find((el) => el.type === WithdrawalConsequence) as ReactElement | undefined;
    expect(slot, "the consequence sits on the read-back step").toBeDefined();
    expect(linesOf(renderToStaticMarkup(slot!)), "the pad's read-back").toEqual(WANT);

    const prompt = renderToStaticMarkup(
      createElement(EndingPrompt, { sideName: NAME, canRecord: true, canVoid: true, busy: false, onRecord: () => {}, onVoid: () => {}, t, consequence: padSlot({ "e-away": ready })({ by: "e-away" }) }),
    );
    expect(linesOf(prompt), "the pad's pending-ending prompt").toEqual(WANT);
  });

  it("X-WDT-10 the read-back's slot follows the side the Confirm names: another entrant's preview is not shown, and a scorer who may not record sees none on the prompt", () => {
    const other: ConsequenceState = { kind: "ready", preview: { ...PREVIEW, entrant_id: "e-home", name: "Home Side" } };
    const island = renderIsland(GuidedSheet, { spec: sheet, views, personNames: {}, t, onComplete: () => {}, confirmExtra: padSlot({ "e-home": other }) });
    (propsOf(island.tree().find((el) => el.type === "button" && propsOf(el)["data-choice-option-id"] === "disqualification")!).onClick as () => void)();
    expect(island.tree().some((el) => el.type === WithdrawalConsequence), "nothing for a side the Confirm does not name").toBe(false);
    const prompt = renderToStaticMarkup(
      createElement(EndingPrompt, { sideName: NAME, canRecord: false, canVoid: true, busy: false, onRecord: () => {}, onVoid: () => {}, t, consequence: padSlot({ "e-away": ready })({ by: "e-away" }) }),
    );
    expect(linesOf(prompt)).toEqual([]);
  });

  it("X-WDT-10 loading and failed say so; a preview that settles nothing beyond the match renders nothing; failed keeps ruling 260's general body", () => {
    const html = (s: ConsequenceState) => renderToStaticMarkup(createElement("div", null, createElement(WithdrawalConsequence, { state: s, t })));
    expect(html({ kind: "loading" })).toContain(t("withdrawal.consequence.loading"));
    expect(html({ kind: "failed" })).toContain(t("withdrawal.consequence.failed").replaceAll("'", "&#x27;"));
    expect(html({ kind: "ready", preview: { ...PREVIEW, cascade: false } })).toBe("<div></div>");
    const failedBody = renderToStaticMarkup(createElement("div", null, disqualifyConfirmBody({ kind: "failed" }, t, "en")));
    expect(failedBody).toContain(t("confirm.withdrawEntrant.body").replaceAll("'", "&#x27;"));
    expect(renderToStaticMarkup(createElement("div", null, disqualifyConfirmBody(ready, t, "en")))).not.toContain(
      t("confirm.withdrawEntrant.body").replaceAll("'", "&#x27;"),
    );
  });
});
