// W5 app PR B, Task 7 (X-ADJ-2, X-ADJ-3, X-ADJ-4): the dialog's own arithmetic - the typed amount in the table's SHOWN unit becomes the
// STORED delta the server and the engine read (a half-point rule stores half-points), the phrase it echoes is the footnote's, and
// Apply waits for the server's three checks (a member, a non-zero amount, a reason). The wiring (load → apply → the table re-folds →
// the footnote) is the e2e's (`X-ADJ-4`) and points-adjustments.test.ts's on Postgres.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import type { MessageKey } from "@/lib/messages";
import { t, type TKey } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { PointsAdjustmentDialog, type AdjustmentsRead, type DialogAnswer, adjustmentAmountPhrase, adjustmentDateText, applyBlocked, shownDelta, storedDelta } from "../points-adjustment-dialog";

const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en as Dict, key as TKey, vars);

describe("the amount: shown unit in, stored delta out", () => {
  it("whole points and wins: the integer typed, a true minus or a comma read too; not a number is 0", () => {
    const cases: [string, number][] = [["-3", -3], ["−3", -3], ["2", 2], ["", 0], ["abc", 0], ["1,0", 1]];
    for (const [typed, stored] of cases) {
      expect(storedDelta(typed, "points", "whole"), typed).toBe(stored);
      expect(storedDelta(typed, "wins", "whole"), typed).toBe(stored);
    }
    expect(cases).toHaveLength(6);
  });
  it("a half-point rule stores half-points: ½ typed is 1 stored, −1 typed is −2; the field shows it back", () => {
    expect(storedDelta("0.5", "points", "half")).toBe(1);
    expect(storedDelta("-1", "points", "half")).toBe(-2);
    expect(storedDelta("1,5", "points", "half")).toBe(3);
    expect(shownDelta(-3, "points", "half")).toBe("-1.5");
    expect(shownDelta(-3, "points", "whole")).toBe("-3");
    // wins never halve, even on a half-point rule (the unit is the cascade's, not the points rule's)
    expect(storedDelta("1", "wins", "half")).toBe(1);
  });
});

describe("the phrase the dialog echoes is the footnote's", () => {
  it("−3 points, +1 point, −1 win, −½ points", () => {
    expect(adjustmentAmountPhrase(msg, "en", -3, "points", "whole")).toBe("−3 points");
    expect(adjustmentAmountPhrase(msg, "en", 1, "points", "whole")).toBe("+1 point");
    expect(adjustmentAmountPhrase(msg, "en", -1, "wins", "whole")).toBe("−1 win");
    expect(adjustmentAmountPhrase(msg, "en", -1, "points", "half")).toBe("−½ points");
  });
});

describe("B3 m-7 (ruling 5): an adjustment's date in the dialog is the footnote's - the competition's clock, never the browser's", () => {
  it("an instant late on 16 Nov UTC is 17 Nov in Auckland and 16 Nov in London; an unreadable instant shows its own date part", () => {
    // 23:30Z on 16 Nov 2026: Auckland is UTC+13 in November (NZDT), London UTC+0 (GMT) - two calendar days for one instant
    const at = "2026-11-16T23:30:00.000Z";
    expect(adjustmentDateText("en", "Pacific/Auckland", at)).toBe("17 Nov 2026");
    expect(adjustmentDateText("en", "Europe/London", at)).toBe("16 Nov 2026");
    expect(adjustmentDateText("en", "Pacific/Auckland", "not a date")).toBe("not a date");
  });
});

describe("Apply waits for the server's three checks", () => {
  it("a member, a non-zero amount and a reason; never while sending", () => {
    const ok = { entrant: "e1", delta: -3, reason: "Fielded an ineligible player", sending: false };
    expect(applyBlocked(ok)).toBe(false);
    expect(applyBlocked({ ...ok, entrant: "" })).toBe(true);
    expect(applyBlocked({ ...ok, delta: 0 })).toBe(true);
    expect(applyBlocked({ ...ok, reason: "   " })).toBe(true);
    expect(applyBlocked({ ...ok, sending: true })).toBe(true);
    // B3 ruling 4: whole steps, at most 999 either way (stored unit) - the server's fourth check, so Apply never sends a refusal
    expect(applyBlocked({ ...ok, delta: 999 })).toBe(false);
    expect(applyBlocked({ ...ok, delta: -999 })).toBe(false);
    expect(applyBlocked({ ...ok, delta: 1000 })).toBe(true);
    expect(applyBlocked({ ...ok, delta: -1000 })).toBe(true);
  });
  it("first paint, before the read lands: every field and Apply disabled, the title names the stage", () => {
    const html = renderToStaticMarkup(
      createElement(PointsAdjustmentDialog, {
        msg,
        locale: "en",
        stageName: "Group stage",
        tz: "Europe/London",
        names: {},
        load: () => new Promise<AdjustmentsRead>(() => {}),
        apply: async (): Promise<DialogAnswer> => ({ ok: true }),
        undo: async (): Promise<DialogAnswer> => ({ ok: true }),
        onClose: () => {},
      }),
    );
    expect(html).toContain("Adjust points: Group stage");
    for (const id of ["adjust-points-entrant", "adjust-points-delta", "adjust-points-reason", "adjust-points-apply"]) {
      expect(html, id).toMatch(new RegExp(`data-testid="${id}"[^>]*disabled=""|disabled=""[^>]*data-testid="${id}"`));
    }
    expect(html).toContain(en["adjustPoints.reasonHint"]);
  });
});
