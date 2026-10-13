import { ScoreSentence } from "@/components/score-sentence";

/**
 * Design audit 4.3 — the organiser's one-line result ("Bears of Brockley won (w/o)") with its tag as the public chip
 * renders one (`public-site/forfeit-tag-chip.tsx`): a symbol whose accessible name and tooltip are the full words, so a
 * screen reader says "walkover", never "w slash o", and a hover explains "ret.". `tag` is `outcomeTagWords`' answer for
 * the SAME result and ledger the line was built from; the tag is the line's LAST copy of its word (the templates put it
 * after the name). No tag, or a line that does not carry it, renders the text as before. `scores`: the console's line
 * keeps its score spans (`ScoreSentence`) either side.
 */
export function OutcomeTagText({
  text,
  tag,
  scores = false,
}: {
  text: string;
  tag: { readonly word: string; readonly full: string } | null;
  scores?: boolean;
}) {
  const plain = (t: string) => (scores ? <ScoreSentence text={t} /> : t);
  const at = tag === null || tag.word === "" ? -1 : text.lastIndexOf(tag.word);
  if (tag === null || at === -1) return <>{plain(text)}</>;
  return (
    <>
      {plain(text.slice(0, at))}
      <span role="img" aria-label={tag.full} title={tag.full}>
        {tag.word}
      </span>
      {plain(text.slice(at + tag.word.length))}
    </>
  );
}
