// W2b Task 13 fix round 2 (re-review N-1) — the console's stream PREVIEW renders `OverlayStage` with the loader's
// SLICED public dictionary (`stream.overlayDict`, server/stream-panel-context.ts), not the whole namespace the
// `/overlay` page holds. The stage builds its forfeit copy from that dict, so a slice of `overlay.*` alone put the RAW
// key "forfeit.sentence.walkover" on air in the preview. The dict here is built by the loader's OWN filter
// (`overlayDictOf`), over the real en public.json — so a slice that drops a key the copy reads fails here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlayStage } from "../overlay-stage";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { overlayDictOf } from "@/lib/overlay-dict";
import { FORFEIT_SENTENCE_KEYS, FORFEIT_TAG_KEYS } from "@/lib/forfeit-tag";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC: Record<string, string> = JSON.parse(readFileSync(join(HERE, "../../../dictionaries/en/public.json"), "utf8"));
const PREVIEW_DICT = overlayDictOf(PUBLIC);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const render = (outcome: OverlayLiveData["outcome"], style: "bar" | "bug"): string =>
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
      dict={PREVIEW_DICT}
      decidedTemplates={decidedOutcomeTemplates((k) => k)}
    />,
  );

describe("the console stream preview's sliced dictionary carries the forfeit words (W2b T13 re-review N-1)", () => {
  it("every key the forfeit copy reads survives the slice, each with the public dictionary's own words", () => {
    let checked = 0;
    for (const key of [...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS]) {
      expect(PUBLIC[key], `premise: public.json has ${key}`).toBeTruthy();
      expect(PREVIEW_DICT[key], key).toBe(PUBLIC[key]);
      checked++;
    }
    expect(checked, "tag and sentence keys checked").toBeGreaterThanOrEqual(10);
    // The slice stays a slice: exactly `overlay.*` plus the copy's keys, nothing else of the public catalogue.
    const copyKeys = new Set<string>([...FORFEIT_TAG_KEYS, ...FORFEIT_SENTENCE_KEYS]);
    const stray = Object.keys(PREVIEW_DICT).filter((k) => !k.startsWith("overlay.") && !copyKeys.has(k));
    expect(stray).toEqual([]);
    expect(Object.keys(PREVIEW_DICT).filter((k) => k.startsWith("overlay.")).length, "the overlay's own words still ship").toBeGreaterThan(0);
    expect(Object.keys(PREVIEW_DICT).length).toBeLessThan(Object.keys(PUBLIC).length / 4);
  });

  it("a walkover and a double walkover read their sentences on air, and no raw `forfeit.` key, in the bar and the bug", () => {
    let frames = 0;
    for (const style of ["bar", "bug"] as const) {
      const loser = style === "bar" ? "NOR" : "Northbridge Athletic";
      const walkover = render({ kind: "award", winner: "home", loser: "away", reason: "walkover" } as never, style);
      expect(walkover, style).toContain(esc(PUBLIC["forfeit.sentence.walkover"]!.replace("{loser}", loser)));
      expect(walkover, `${style}: a raw key on air`).not.toMatch(/forfeit\.(tag|sentence)\./);
      const dw = render({ kind: "double_walkover" } as never, style);
      expect(dw, style).toContain(esc(PUBLIC["forfeit.sentence.doubleWalkover"]!));
      expect(dw, `${style}: a raw key on air`).not.toMatch(/forfeit\.(tag|sentence)\./);
      frames += 2;
    }
    expect(frames).toBe(4);
  });
});
