// Spectator W2, Task 16 — the last two English words in `LiveScoreBody`, the
// scorebug the match centre falls back to (no document yet, and the Summary
// tab before play): the " · realtime" suffix on the live status line, and the
// serve dot's accessible name, "serving". Both were literals beside a
// dictionary the component already holds.
//
// Expectations are each locale's own dictionary VALUE (nl says "realtime" too,
// so an English-absence list would red on correct Dutch).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import type { Dict } from "@/lib/i18n-constants";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { LiveScoreBody } from "../live-score";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};
const emptyTemplates: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };
const entrantNames = { H: "Riverside FC", A: "Oakdale United" };

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const differs = (mine: string, english: string) =>
  mine !== english && !mine.includes(english) && !english.includes(mine);

const render = (d: Record<string, string>, subscribed: boolean) =>
  renderToStaticMarkup(
    <LiveScoreBody
      data={{
        status: "in_play",
        summary: {
          headline: "1 – 0",
          perSide: [
            { entrantId: "H", line: "1" },
            { entrantId: "A", line: "0" },
          ],
          detail: { serving: "home" },
        },
        outcome: null,
      }}
      entrantNames={entrantNames}
      sportKey="football"
      decidedTemplates={emptyTemplates}
      dict={d as Dict}
      subscribed={subscribed}
    />,
  );

describe("LiveScoreBody — realtime suffix and serve dot in the org's locale", () => {
  it("premise: both words differ from English in at least one of es/fr/nl", () => {
    for (const k of ["matchCentre.realtime", "matchCentre.serving"]) {
      for (const [l, d] of Object.entries(DICTS)) expect(typeof d[k], `${l} ${k}`).toBe("string");
      expect(["es", "fr", "nl"].some((l) => differs(DICTS[l]![k]!, DICTS.en![k]!)), k).toBe(true);
    }
  });

  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: a subscribed live status line ends with ${locale}'s realtime word`, () => {
      const html = render(d, true);
      expect(html).toContain(`${esc(d["matchCentre.status.live"]!)} · ${esc(d["matchCentre.realtime"]!)}`);
      if (differs(d["matchCentre.realtime"]!, DICTS.en!["matchCentre.realtime"]!)) {
        expect(html).not.toContain(` · ${DICTS.en!["matchCentre.realtime"]}`);
      }
    });

    it(`${locale}: an unsubscribed line carries no realtime word at all`, () => {
      expect(render(d, false)).not.toContain(` · ${esc(d["matchCentre.realtime"]!)}`);
    });

    it(`${locale}: the serve dot's accessible name is ${locale}'s`, () => {
      const html = render(d, false);
      expect(html).toContain(`aria-label="${esc(d["matchCentre.serving"]!)}"`);
      if (differs(d["matchCentre.serving"]!, DICTS.en!["matchCentre.serving"]!)) {
        expect(html).not.toContain(`aria-label="${DICTS.en!["matchCentre.serving"]}"`);
      }
    });
  }
});
