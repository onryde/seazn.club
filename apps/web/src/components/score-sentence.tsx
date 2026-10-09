// W2a fix round 1 (M1) — a result sentence whose score never splits across lines.
//
// An en dash is a line-break opportunity, so at 320 the public match page read "W2a Ana won on rapid tie-break (1½–"
// over "½)". The sentences themselves are plain strings shared with share text, OG images and the stream overlay, so the
// glue lives HERE, at the HTML surfaces, as a nowrap span — never as an invisible character inside the string, which
// would reach a satori image and every assertion on the words.
//
// SCORE restates the engine's own chess-score shape (`CHESS_SCORE`, boardgame.ts: whole points with an optional half
// either side of an en dash) unanchored, which also covers a shoot-out tally ("4–3"). It is restated rather than
// imported so a public island does not value-import an engine sport module; score-sentence.test.tsx pins it against
// what the engine's own `boardgame.tiebreak` schema accepts.
import { Fragment } from "react";

const SCORE = /((?:\d+½?|½)–(?:\d+½?|½))/;

export type SentencePart = { text: string; score: boolean };

/** The sentence cut into its words and its scores, in order; empty text is no parts. */
export function scoreSentenceParts(text: string): SentencePart[] {
  // `split` with one capture group puts every match at an odd index.
  return text
    .split(SCORE)
    .map((part, i) => ({ text: part, score: i % 2 === 1 }))
    .filter((p) => p.text !== "");
}

export function ScoreSentence({ text }: { text: string }) {
  return (
    <>
      {scoreSentenceParts(text).map((p, i) =>
        p.score ? (
          <span key={i} className="whitespace-nowrap">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
