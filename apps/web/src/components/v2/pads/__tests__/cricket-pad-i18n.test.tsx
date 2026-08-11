import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BallForm } from "@/components/v2/pads/cricket-pad";
import { DictProvider } from "@/components/i18n/dict-provider";
import { wicketLabel } from "@/lib/scoring-vocab";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { SideInfo } from "@/components/v2/fixture-console";
import { CricketWicket } from "@seazn/engine/sports/cricket";

// The wicket/extra <option> labels must read the wicket.*/extra.* keys from the
// active dictionary, not the raw payload enum. Sentinel values prove the wiring
// localizes independently of whether fr/es/nl are translated yet.
const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "wicket.runout": "«runout-loc»",
  "extra.wide": "«wide-loc»",
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });
const innings = {
  battingSide: "home" as const,
  runs: 0,
  wickets: 0,
  legalBalls: 0,
  closed: false,
  fine: { striker: null, nonStriker: null, currentBowler: null, dismissed: [] },
};

describe("cricket pad wicket/extra kind i18n", () => {
  it("localizes wicket + extra option labels from the dictionary", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <BallForm
          innings={innings}
          batting={side("h", "Harbor CC")}
          fielding={side("a", "Summit CC")}
          bpo={6}
          send={async () => true}
          busy={false}
        />
      </DictProvider>,
    );
    expect(html).toContain("«runout-loc»");
    expect(html).toContain("«wide-loc»");
    // No raw payload enum leaking into the option text.
    expect(html).not.toContain(">Run out<");
    expect(html).not.toContain("W: runout");
  });

  it("labels hitballtwice correctly, not a naive capitalize (S7/#427 review)", () => {
    // wicketLabel() checks ONLY WICKET_KEY, never falling through to KIND_KEY
    // the way enumLabel("kind", …) does — so adding the option to the picker
    // without also widening WICKET_KEY made it selectable but WRONG: it fell
    // to title(k) = "Hitballtwice" in every locale, not the real translation.
    // A literal expected string is required here — deriving "expected" from
    // wicketLabel() itself (as the loop below does for existence) cannot catch
    // wicketLabel() being wrong, since it would compare the function to itself.
    const html = renderToStaticMarkup(
      <DictProvider dict={uiEn as unknown as Dict} locale="en">
        <BallForm
          innings={innings}
          batting={side("h", "Harbor CC")}
          fielding={side("a", "Summit CC")}
          bpo={6}
          send={async () => true}
          busy={false}
        />
      </DictProvider>,
    );
    expect(html).toContain("W: Hit the ball twice");
    expect(html).not.toContain("W: Hitballtwice");
  });

  it("offers every dismissal kind the engine declares (S7/#427)", () => {
    // Regression: the picker's own kind list had drifted from the engine's —
    // `hitballtwice` (Law 34) was absent, so a correctly-translated label
    // existed and could never be selected. Derived from CricketWicket itself,
    // not a hand-copied list, so a future engine addition reds this too.
    // NOTE: this loop proves EXISTENCE (every kind renders as SOME option),
    // not CORRECTNESS of the label text — it derives "expected" from
    // wicketLabel() itself, so it cannot catch wicketLabel() returning the
    // wrong string. The test above pins hitballtwice's literal text instead.
    const html = renderToStaticMarkup(
      <DictProvider dict={uiEn as unknown as Dict} locale="en">
        <BallForm
          innings={innings}
          batting={side("h", "Harbor CC")}
          fielding={side("a", "Summit CC")}
          bpo={6}
          send={async () => true}
          busy={false}
        />
      </DictProvider>,
    );
    const en = (k: string) => (uiEn as Record<string, string>)[k] ?? k;
    for (const kind of CricketWicket.shape.kind.options) {
      expect(html, `wicket picker missing "${kind}"`).toContain(`W: ${wicketLabel(kind, en)}`);
    }
  });
});
