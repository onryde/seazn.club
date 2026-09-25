// Best of 1 — the RENDERED half of owner ruling 2026-09-25 (Option A): the one
// grid all three format editors mount (stage format on the Fixture Console,
// division settings, division builder) shows ONE "Points to win" input on a
// best-of-1 format, and it shows the number the engine plays (`finalSetTo`).
//
// Node env, no DOM (`renderToStaticMarkup`, the house pattern for this grid —
// match-rules-unofferable-value.test.tsx). What a static render cannot settle —
// typing into the field and what the click writes — is pinned on the pure
// functions the grid calls (`lib/__tests__/match-rules-best-of-one.test.ts`)
// and driven in the browser (e2e/walkthrough/stage-rules-start-promotion).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MatchRuleFields } from "@/components/v2/match-rules";
import { SINGLE_SET_POINTS_LABEL, SPORT_RULES } from "@/lib/match-rules";

function render(
  sportKey: string,
  values: Record<string, string>,
  inherited?: Record<string, unknown>,
): string {
  return renderToStaticMarkup(
    <MatchRuleFields sportKey={sportKey} values={values} onChange={() => {}} inherited={inherited} />,
  );
}

/** Every number input in render order, as `label → value`. The grid renders
 *  `<label><span class="label">{label}</span><input type="number" … value=…>`. */
function numberInputs(html: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const m of html.matchAll(/<span class="label">([^<]*)<\/span><input type="number"([^>]*)>/g)) {
    const value = /\svalue="([^"]*)"/.exec(m[2]!)?.[1] ?? "";
    out.push({ label: m[1]!, value });
  }
  return out;
}

const label = (sport: string, key: string) => SPORT_RULES[sport]!.find((f) => f.key === key)!.label;
const SPORTS = ["badminton", "tabletennis", "volleyball"] as const;

describe("MatchRuleFields at best of 1", () => {
  it.each(SPORTS)("%s: one points input, labelled 'Points to win', showing finalSetTo", (sport) => {
    // setTo ≠ finalSetTo on purpose: the input must show the number PLAYED.
    const html = render(sport, { bestOf: "1", setTo: "9", finalSetTo: "15" });
    const points = numberInputs(html).filter((i) => i.label.startsWith("Points"));
    expect(points).toEqual([{ label: SINGLE_SET_POINTS_LABEL, value: "15" }]);
    expect(html).not.toContain(`>${label(sport, "setTo")}<`);
    expect(html).not.toContain(`>${label(sport, "finalSetTo")}<`);
  });

  it.each(SPORTS)("%s: an INHERITED best of 1 collapses too", (sport) => {
    // The stage editor's case: the fragment names no best-of, the division does.
    const points = numberInputs(render(sport, {}, { bestOf: 1 })).filter((i) =>
      i.label.startsWith("Points"),
    );
    expect(points).toEqual([{ label: SINGLE_SET_POINTS_LABEL, value: "" }]);
  });

  it.each(SPORTS)("%s: any other best-of keeps both fields (the positive pair)", (sport) => {
    for (const [values, inherited] of [
      [{ bestOf: "3", setTo: "9", finalSetTo: "15" }, undefined],
      [{ bestOf: "3" }, { bestOf: 1 }], // the edited value beats the inheritance
      [{}, undefined],
    ] as const) {
      const points = numberInputs(render(sport, { ...values }, inherited)).filter((i) =>
        i.label.startsWith("Points"),
      );
      expect(points.map((p) => p.label)).toEqual([label(sport, "setTo"), label(sport, "finalSetTo")]);
    }
  });

  it("leaves tennis's grid alone at best of 1", () => {
    const html = render("tennis", { bestOf: "1" });
    expect(html).not.toContain(SINGLE_SET_POINTS_LABEL);
    expect(html).toContain(`>${label("tennis", "setType")}<`);
  });
});
