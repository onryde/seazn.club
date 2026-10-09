// W2a fix round 1 (M1) — a score inside a result sentence must never break across lines: at 320 the public match page
// read "W2a Ana won on rapid tie-break (1½–" / "½)", because an en dash is a line-break opportunity. `ScoreSentence`
// wraps each score in a nowrap span at the HTML surfaces; the sentence's TEXT is unchanged (no invisible characters,
// so share text, OG images and assertions on the words are untouched).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { ScoreSentence, scoreSentenceParts } from "@/components/score-sentence";
import { decidedOutcomeText, type MsgFn } from "@/lib/scoring-vocab";
import { interpolate } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const m: MsgFn = (key, vars) => interpolate((uiEn as Record<string, string>)[key] ?? key, vars);
const NOWRAP = (s: string) => `<span class="whitespace-nowrap">${s}</span>`;

describe("ScoreSentence keeps a score on one line (fix round 1, M1)", () => {
  it("empty case first: an empty sentence renders nothing, and a sentence with no score renders no span", () => {
    expect(scoreSentenceParts("")).toEqual([]);
    expect(renderToStaticMarkup(<ScoreSentence text="" />)).toBe("");
    const plain = "Riverside FC won";
    expect(scoreSentenceParts(plain)).toEqual([{ text: plain, score: false }]);
    expect(renderToStaticMarkup(<ScoreSentence text={plain} />)).toBe(plain);
  });

  it("the REAL tie-break and shoot-out sentences (en dictionary) carry their score in one nowrap span, words unchanged", () => {
    const names = { h: "W2a Ana", a: "W2a Di" };
    const cases = [
      { text: decidedOutcomeText({ kind: "win", winner: "h", method: "tiebreak_rapid" }, names, m, null, "boardgame", "1½–½"), score: "1½–½" },
      { text: decidedOutcomeText({ kind: "win", winner: "a", method: "tiebreak_blitz" }, names, m, null, "boardgame", "2–0"), score: "2–0" },
      { text: decidedOutcomeText({ kind: "win", winner: "h", method: "shootout" }, names, m, { home: 4, away: 3 }), score: "4–3" },
    ];
    let checked = 0;
    for (const c of cases) {
      expect(c.text, "the rig must produce a sentence").toBeTypeOf("string");
      const html = renderToStaticMarkup(<ScoreSentence text={c.text!} />);
      expect(html, c.text!).toContain(NOWRAP(c.score));
      expect(html.replace(/<[^>]+>/g, ""), "the words are unchanged").toBe(c.text);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("every chess score the engine accepts (its own boardgame.tiebreak schema) is glued whole — the local pattern restates the engine's", () => {
    const tiebreak = (boardgame.eventSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)["boardgame.tiebreak"]!;
    const samples = ["1½–½", "½–1½", "2–0", "0–2", "1½–1½", "10½–9½", "½–½"];
    let checked = 0;
    for (const s of samples) {
      expect(tiebreak.safeParse({ rung: "rapid", winner: "H", score: s }).success, `${s} is a chess score the engine accepts`).toBe(true);
      expect(scoreSentenceParts(`won (${s})`), s).toEqual([
        { text: "won (", score: false },
        { text: s, score: true },
        { text: ")", score: false },
      ]);
      checked++;
    }
    expect(checked).toBe(samples.length);
  });
});
