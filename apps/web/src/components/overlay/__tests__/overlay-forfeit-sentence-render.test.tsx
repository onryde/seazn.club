// W2b Task 13 fix round 1 (review M-4) — the SEAM: the forfeit sentence reaches the on-air markup through the real
// `OverlayStage`, which builds the forfeit copy from the public dictionary it already holds. `overlay-model.test.ts`
// owns the model's wording; without this file the model could be right and the stage could never pass it the copy
// (AGENTS.md class 1, the inert seam). `environment: "node"` — `renderToStaticMarkup` is this directory's precedent.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage } from "../overlay-stage";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const DICT: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));

/** The dictionary's sentence with its placeholder filled, HTML-escaped the way React serialises text. */
const sentence = (key: string, loser = ""): string =>
  DICT[key]!.replace("{loser}", loser).replace(/'/g, "&#x27;");

const render = (outcome: OverlayLiveData["outcome"], style: "bar" | "bug" = "bar"): string =>
  renderToStaticMarkup(
    <OverlayStage
      fixtureId="f1"
      initial={{ status: "forfeited", summary: { perSide: [] }, outcome, lastSeq: 2, venueTz: "UTC" } as unknown as OverlayLiveData}
      realtime={false}
      sportKey="football"
      style={style}
      sides={[
        { id: "home", name: "Milton Keynes Rovers" },
        { id: "away", name: "Northbridge Athletic" },
      ]}
      startLabel={null}
      dict={DICT}
      decidedTemplates={decidedOutcomeTemplates((k) => (k === "fixture.decidedBy.plain" ? "{winner} won" : k))}
    />,
  );

describe("the on-air frame of a credited result reads its forfeit sentence (W2b T13 review M-4)", () => {
  it("a walkover: the sentence naming the side that did not show, never '{winner} won'", () => {
    expect(DICT["forfeit.sentence.walkover"], "anti-vacuity: the dictionary holds the sentence").toContain("{loser}");
    let checked = 0;
    // The bar's context line names the side by its code; the bug's result band (its header never carries the
    // sentence) names it in full — the same split the result templates make.
    for (const [style, loser] of [["bar", "NOR"], ["bug", "Northbridge Athletic"]] as const) {
      const html = render({ kind: "award", winner: "home", loser: "away", reason: "walkover" } as never, style);
      expect(html, style).toContain(sentence("forfeit.sentence.walkover", loser));
      expect(html, style).not.toContain("won");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a double walkover says so", () => {
    expect(render({ kind: "double_walkover" } as never)).toContain(sentence("forfeit.sentence.doubleWalkover"));
  });
});
