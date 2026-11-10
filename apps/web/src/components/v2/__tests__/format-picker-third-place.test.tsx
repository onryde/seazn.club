// W4 app B, Task 10 (X-TP-1; owner pick 1A): the picker's Third place control - on screen for a knockout format, absent for one
// without, the Play-off disabled (never hidden) below four entrants. The picker's own pure helpers carry the numbers.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThirdPlaceChoice } from "@/components/v2/third-place-choice";
import uiEn from "@/dictionaries/en/ui.json";
import { THIRD_PLACE_MIN } from "@/lib/third-place";
import { thirdPlaceOffer } from "@/lib/division-builder/format-choice";

const en = uiEn as Record<string, string>;
const noop = () => {};

describe("ThirdPlaceChoice", () => {
  it("the empty case first: 0 entrants disables the Play-off segment and says what unlocks it", () => {
    const h = renderToStaticMarkup(<ThirdPlaceChoice value="playoff" onChange={noop} offer={thirdPlaceOffer("knockout", { qualified: 4 }, 0)} />);
    expect(h).toMatch(/data-third-place="shared"/);
    expect(h).toContain(en["thirdPlace.hiddenBelow4"]!);
    expect(h.split('data-third-place-option="playoff"')[1]!.split("</label>")[0]).toContain('aria-disabled="true"');
  });

  it("offered: both segments are live, the picked one is checked and its hint shows", () => {
    for (const [value, hint] of [["shared", "thirdPlace.sharedHint"], ["playoff", "thirdPlace.playoffHint"]] as const) {
      const h = renderToStaticMarkup(<ThirdPlaceChoice value={value} onChange={noop} offer={thirdPlaceOffer("knockout", { qualified: 4 }, THIRD_PLACE_MIN)} />);
      expect(h).toMatch(new RegExp(`data-third-place="${value}"`));
      expect(h).not.toContain('aria-disabled="true"');
      expect(h).toContain(en[hint]!);
    }
  });

  it("read-only: the fieldset is disabled and the reason replaces the hint", () => {
    const h = renderToStaticMarkup(<ThirdPlaceChoice value="shared" onChange={noop} offer={{ offered: true, entrants: 8 }} readOnlyReason="LOCKED-REASON" />);
    expect(h).toContain("LOCKED-REASON");
    expect(h).toMatch(/<fieldset[^>]*disabled=""/);
  });
});
