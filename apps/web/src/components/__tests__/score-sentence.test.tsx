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

  it("both directions: the local pattern glues a string whole EXACTLY when the engine's own boardgame.tiebreak schema (its CHESS_SCORE) accepts it — every string over the score alphabet, up to 5 characters", () => {
    // The oracle is the engine's declaration (`score: z.string().regex(CHESS_SCORE)`, boardgame.ts), never this file's
    // pattern. Enumerating the alphabet catches a drift either way: a score the engine accepts that the page would let
    // break, and a string the engine refuses that the page would glue as if it were a score.
    const tiebreak = (boardgame.eventSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)["boardgame.tiebreak"]!;
    const ALPHABET = ["0", "1", "2", "½", "–", "-", ".", " "];
    let strings = [""];
    const all: string[] = [];
    for (let len = 1; len <= 5; len++) {
      strings = strings.flatMap((p) => ALPHABET.map((c) => p + c));
      all.push(...strings);
    }
    let accepted = 0;
    let refused = 0;
    const disagree: string[] = [];
    for (const s of all) {
      const engine = tiebreak.safeParse({ rung: "rapid", winner: "H", score: s }).success;
      const parts = scoreSentenceParts(s);
      const glued = parts.length === 1 && parts[0]!.score && parts[0]!.text === s;
      if (engine) accepted++;
      else refused++;
      if (engine !== glued) disagree.push(`${JSON.stringify(s)} engine=${engine} glued=${glued}`);
    }
    expect(disagree).toEqual([]);
    // Anti-vacuity, both directions reached: real scores among them ("1½–½", "10–0") and many refusals.
    expect(all.length).toBe(ALPHABET.length + ALPHABET.length ** 2 + ALPHABET.length ** 3 + ALPHABET.length ** 4 + ALPHABET.length ** 5);
    expect(all).toContain("1½–½");
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });
});
