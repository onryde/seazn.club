// Owner 2026-11-12: a guest is told plainly that an unsaved quick match is DELETED some days after its last score: one line
// above Start on the setup page, and the home's count line. The number is the sweep's own constant
// (`QUICK_MATCH_EXPIRY_DAYS`), never a 7 typed into a component, so a change to the constant moves every line with it.
//
// Witnessed by changing it: this file sets the constant to 11 (a number no copy and no default carries) and reads the
// lines a guest sees. With the real 7, a component that typed 7 would pass every other test unnoticed.
//
// The two screens are rendered as the server renders them (`renderToStaticMarkup`): the setup island with the page's own
// copy builder over the real English dictionaries, the home view with the page's copy shape.
const EXPIRY_DAYS = vi.hoisted(() => 11);
vi.mock("@/lib/quick-match-constants", async (orig) => ({
  ...(await orig<typeof import("@/lib/quick-match-constants")>()),
  QUICK_MATCH_EXPIRY_DAYS: EXPIRY_DAYS,
}));
// The bot check's widget needs a browser; a stand-in with the controller's surface (as setup-form.test.tsx stubs it).
vi.mock("@/components/turnstile-widget", () => ({
  useTurnstile: () => ({ token: async () => null, reset: () => {}, awaitingVisitor: () => false, reveal: () => {} }),
  TurnstileWidget: function TurnstileWidgetStub() {
    return null;
  },
}));

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import enMarketing from "@/dictionaries/en/marketing.json";
import enUi from "@/dictionaries/en/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import { QUICK_MATCH_EXPIRY_DAYS } from "@/lib/quick-match-constants";
import { t as tRuntime, plural as pluralRuntime } from "@/lib/i18n-runtime";
import { levelWords } from "@/lib/score/levels";
import { quickMatchPreviewTable } from "@/server/usecases/quick-match-preview";
import type { QuickMatchHome } from "@/server/usecases/quick-match-home";
import { setupCopy, setupSports } from "@/app/[lang]/(marketing)/play/setup-props";
import { QuickMatchSetupForm, type SetupFormProps } from "../setup-form";
import { QuickMatchHomeView, type QuickMatchCopy } from "../home";

/** The text of the one element carrying `data-testid="<id>"`, entities decoded, whitespace folded. */
function textOfTestId(html: string, id: string): string | null {
  const open = new RegExp(`<(\\w+)[^>]*data-testid="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const close = html.indexOf(`</${open[1]}>`, open.index);
  return html
    .slice(open.index + open[0].length, close)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the deletion lines read the sweep's constant, never a typed number (owner 2026-11-12)", () => {
  it("premise: the constant here is 11, not the shipped 7", () => {
    expect(QUICK_MATCH_EXPIRY_DAYS).toBe(11);
  });

  it("setup: the line above Start says 11 days, in the owner's words", () => {
    const sports = setupSports(
      [
        {
          sport_key: "badminton",
          labelKey: "sport.badminton",
          kinds: ["individual", "pair"],
          variants: [{ variant_key: "bwf", labelKey: "variant.badminton.bwf", knockoutAllowed: true }],
        },
      ],
      enUi,
    );
    const props: SetupFormProps = {
      lang: "en",
      sports: sports as SetupFormProps["sports"],
      table: quickMatchPreviewTable(),
      copy: setupCopy(enMarketing, enUi),
      initialError: null,
    };
    const html = renderToStaticMarkup(createElement(QuickMatchSetupForm, props));
    expect(textOfTestId(html, "qm-keep-note")).toBe("No account needed. Deleted 11 days after the last score unless you save it.");
  });

  it("home: an unsaved match's count line says 11 days; a saved one names no days", () => {
    const copy: QuickMatchCopy = {
      locale: "en",
      t: (k, v) => tRuntime(enUi, k, v),
      plural: (k, n, v) => pluralRuntime(enUi, k, n, "en", v),
      levels: levelWords(enPublic),
      pub: (k, v) => tRuntime(enPublic, k, v),
    };
    const home = (expiresAt: Date | null, savedByUserId: string | null): QuickMatchHome => ({
      row: {
        id: "qm-1", competitionId: "c-1", name: "Friday", format: "league", email: null, locale: "en",
        lastActivityAt: new Date(), expiresAt, savedByUserId, tokenEnc: new Uint8Array(),
      },
      divisionId: "d-1",
      stageId: "s-1",
      sport: { key: "badminton", labelKey: "sport.badminton" },
      kind: "pair",
      kindChosen: true,
      sides: [{ entrantId: "e-1", name: "One" }, { entrantId: "e-2", name: "Two" }],
      fixtures: [],
      next: null,
      played: 1,
      notPlayed: 0,
      total: 3,
      standings: null,
      pointsUnit: "whole",
      tableRules: null,
      metricSpecs: [],
      finished: false,
    });
    const played = (h: QuickMatchHome) =>
      textOfTestId(renderToStaticMarkup(createElement(QuickMatchHomeView, { home: h, copy })), "qm-played");
    expect(played(home(new Date("2026-11-19T10:00:00Z"), null))).toBe(
      "1 of 3 matches played · deleted 11 days after the last score unless saved",
    );
    expect(played(home(null, "u-1"))).toBe("1 of 3 matches played");
  });
});
