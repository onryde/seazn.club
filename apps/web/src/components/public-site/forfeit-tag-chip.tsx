// W2b Task 13 (spec §5.5, UI-2 option A) — the short tag a tight public surface shows beside a credited score ("w/o",
// "ret.", "DQ", "2× w/o", "Aband. · DLS"), with the full sentence as its tooltip AND its accessible name: a screen
// reader always gets "Harbour United didn't show up — walkover.", never the abbreviation. The words come pre-resolved
// from `forfeitWords` (lib/forfeit-tag.ts) — this component decides nothing.
//
// `role="img"` + `aria-label`: the tag is a symbol standing for the sentence (the pattern for a glyph with a meaning),
// so the sentence REPLACES the abbreviation for assistive technology rather than being read after it. `whitespace-nowrap`
// and `shrink-0`: "2× w/o" and "Aband. · DLS" never break inside themselves or squeeze the score off its row — a bracket
// tile at 320 has no room for a second line (public-copy.html). `normal-case`: the tag is lowercase on purpose ("w/o"),
// and some of its hosts are `uppercase` rows. Design audit 3.2: the public site's small neutral status tag is a pill —
// the seed chip's shape in the seed chip's colours (`matches-hub/teams-tab.tsx`), so one kind of tag has one shape.
export function ForfeitTagChip({ tag, sentence, testId, id }: { tag: string; sentence: string; testId?: string; id?: string }) {
  return (
    <span
      id={id}
      role="img"
      aria-label={sentence}
      title={sentence}
      data-testid={testId}
      className="inline-block shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold normal-case leading-tight tracking-normal text-ink-muted"
    >
      {tag}
    </span>
  );
}
