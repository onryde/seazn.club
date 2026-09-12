// Spectator surface W1, Task 13 — the Sets / Periods tab: per-set points for
// the racket and set-based sports, goals by period for the period sports.
//
// ---------------------------------------------------------------------------
// Not derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. `unit` CHOOSES BOTH THE CAPTION AND THE COLUMN LABEL; `kind` chooses only
//    the table's SHAPE. `unit` is what one division of play is called in the
//    sport's own vocabulary, and badminton and table tennis score GAMES inside
//    a table whose `kind` is still "sets". Labelling a badminton column "Set 1"
//    is wrong in a way a badminton player notices immediately — and so is
//    captioning that same table "Sets", which is what this file did until the
//    R11 re-review caught it. The caption and the tab rail read one map,
//    `sets-vocabulary.ts`; `kind` survives here only as the fallback for a
//    document built before `unit` existed (note 2), which carries nothing else
//    to answer the question with.
//
// 2. `unit` IS OPTIONAL AND THE FALLBACK IS LOAD-BEARING. It was added after
//    the first documents were built, so a document without it must still
//    render — and when it is absent the raw `columns` strings are used, which
//    is exactly what those older documents carry (football's "H1"/"H2" rather
//    than "1"/"2"). This is not defensive padding; it is the only reason a
//    pre-`unit` document reads correctly.
//
// 3. THE OPEN COLUMN IS THE ONE STILL BEING PLAYED, and it is marked from the
//    ENGINE'S OWN `closedMask`, never inferred from position. A set can be
//    open at any index — a suspended match, a super over — and "the last one"
//    is a guess that is usually right, which is the worst kind.
//
// 4. `columnLabels` CARRIES THE ENGINE'S PHASE TOKEN, and it wins over the
//    ordinal. "Period 4" is not what extra time is called, and the difference
//    between regulation, extra time and overtime is most of what a spectator
//    opens this tab to see. The tokens are unbounded by construction
//    (`periodLabels` in the period kernel builds `P1..Pn`, `otLabels` builds
//    `OT1..OTk`), so a missing key is EXPECTED rather than a defect — it falls
//    through to the ordinal, which still reads correctly.
//
// 5. THE HEADER TAKES THE SHORT FORM, THE `title` TAKES THE PROSE. A period
//    column is 32px of a fixed-layout table, and the prose `term.ET_H1` is
//    "Extra time — first half" — it cannot fit, and a fixed-layout table never
//    grows to make it. So headers resolve `term.short.<phase>` ("ET1"), and
//    the full name rides in `title` plus an `sr-only` span so a screen reader
//    and a hover still get it. The prose keys are not redundant: the
//    Timeline's sentences use them.
//
// 5b. MOST OF `term.short.*` IS NOTATION AND IS IDENTICAL IN ALL FOUR LOCALES
//    — "Q3", "P1", "ET2", "SO" are written the same everywhere. THE TWO HALF
//    LABELS ARE NOT: they are ORDINALS, and every language writes its own
//    ("1st"/"2nd" en, "1re"/"2e" fr, "1.ª"/"2.ª" es, "1e"/"2e" nl). This note
//    used to claim the whole family was notation, and fr/es/nl shipped the
//    ENGLISH pair on the strength of it — a French spectator read "1st" over
//    the first half of every football match. The rule that holds: each
//    locale's short half label is the ordinal token of its own prose name
//    (`term.H1` = "1re mi-temps" -> "1re"), which is what
//    `sets-tab.test.tsx` derives its expectation from rather than typing a
//    table of four ordinals into a test.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { autoColour, monogramInk } from "@/components/ui/entity-logo";
import { setsLabelKey } from "./sets-vocabulary";
import { TabPanel } from "./tab-panel";

export interface SetsTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  /** Part of the shared panel signature; never read — see CommentaryTab. */
  data: LiveFixtureData;
}

export function SetsTab({ doc, dict }: SetsTabProps): ReactNode {
  const sets = doc.sets;
  if (sets === null) return <TabPanel id="sets" className="grid gap-2" />;

  // The caption names the same thing the tab rail names, from the same map —
  // see `sets-vocabulary.ts`. Keying it off `kind` (as this line did) printed
  // "Sets" over "Game 1" / "Game 2" columns for badminton and table tennis.
  const caption = t(dict, setsLabelKey(sets.unit, sets.kind));

  /** A TOTAL column, for period tables only.
   *
   *  Goals ACCUMULATE across periods — 1 + 1 is the 2 on the court card — so a
   *  row of per-period numbers without the sum asks the reader to add up. Sets
   *  do not work that way (6–4, 3–6 does not total to anything a spectator
   *  wants), which is why the board draws `Team | 1H | 2H | Total` for football
   *  and `Player | Set 1 | Set 2 | Set 3` for tennis.
   *
   *  Bounded at four periods, and the bound is the WIDTH BUDGET in the header
   *  comment below: each column is `w-10` and the name column takes what is
   *  left, so at 320 a fifth and sixth column starve the name to ~48px. Two
   *  halves, three periods and four quarters all fit with the total; a quarter
   *  sport that has gone to overtime keeps its columns and loses the sum, which
   *  is the right way round — the score is still the largest thing on the court
   *  card directly above. */
  const showTotal = sets.kind === "periods" && sets.columns.length >= 2 && sets.columns.length <= 4;

  /** Only cells the engine actually wrote. A missing cell is not a zero — the
   *  table prints an en dash for exactly that reason — so a row with nothing in
   *  it totals to nothing rather than to 0. */
  const totalFor = (rowIndex: number): string | null => {
    const cells = sets.rows[rowIndex] ?? [];
    let sum = 0;
    let seen = false;
    for (const cell of cells) {
      if (cell === null) continue;
      const n = Number(cell);
      if (!Number.isFinite(n)) return null;
      sum += n;
      seen = true;
    }
    return seen ? String(sum) : null;
  };

  // `lookup`, not `t`, throughout — `t` RETURNS THE KEY on a miss, so it would
  // answer "yes, `term.short.OT9`" for every phase and print the key.
  const term = (key: string): string | null => {
    const value = lookup(dict, key);
    return typeof value === "string" ? value : null;
  };

  // See notes 1, 2, 4 and 5. What a header SHOWS, in order:
  //   1. the short phase notation — "ET1", "Q3", "SO";
  //   2. the sport's unit and the ordinal — "Period 4", "Game 2", "Set 3";
  //   3. the raw `columns` string, for a document built before `unit` existed.
  const labelFor = (i: number): string => {
    const phase = sets.columnLabels?.[i];
    if (phase !== undefined && phase !== "") {
      const short = term(`term.short.${phase}`);
      if (short !== null) return short;
    }
    if (sets.unit !== undefined) return t(dict, `matchCentre.col.${sets.unit}`, { n: i + 1 });
    return sets.columns[i] ?? String(i + 1);
  };

  /** The full name, for `title` and the sr-only span — never for the visible
   *  header. Falls back to the visible label so neither is ever empty. */
  const longLabelFor = (i: number): string => {
    const phase = sets.columnLabels?.[i];
    const prose = phase === undefined || phase === "" ? null : term(`term.${phase}`);
    return prose ?? labelFor(i);
  };

  return (
    <TabPanel id="sets" className="grid gap-2">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
        {/* `table-fixed` for the same reason as the Scorecard's tables:
            `min-w-0` on a `<th>` is inert and an auto-layout table simply grows
            to its longest entrant name, so `truncate` never fires. Each
            set/period column is sized (`w-10`); the NAME column is left unsized
            and takes the remainder. */}
        <table className="w-full table-fixed text-[13px]">
          <caption className="pb-1 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {caption}
          </caption>
          <thead>
            <tr className="border-b border-zinc-200/80">
              {/* No visible heading — the row header names each side — but an
                  empty `<th>` is an axe `empty-table-header` violation, so it
                  carries one for a screen reader only. */}
              <th scope="col" className="px-1 text-left font-medium text-ink-muted">
                <span className="sr-only">{t(dict, "matchCentre.col.side")}</span>
              </th>
              {sets.columns.map((_, i) => {
                const open = sets.closedMask[i] === false;
                return (
                  <th
                    key={i}
                    scope="col"
                    data-testid={`mc-sets-col-${i}`}
                    // See note 3 — only when the engine says so, and `undefined`
                    // rather than "false" so the attribute is simply absent.
                    data-open={open ? "true" : undefined}
                    title={longLabelFor(i)}
                    // Owner design round (D) — mono, like every other figure
                    // on this surface. This tab is the SCORE TABLE for every
                    // sport that is not cricket (tennis "Sets", football
                    // "Periods", and so on), so leaving it in the body face
                    // gave four of five sports the untreated look.
                    // `text-[9px]` and NO tracking, and the width arithmetic is
                    // the reason. `w-10` less `px-0.5` leaves a 36px content
                    // box; Geist Mono advances ~0.6em, so "GAME 1" (6 glyphs)
                    // needs exactly 36px at 10px — zero slack, and the
                    // `tracking-wide` this round first shipped wrapped it onto
                    // two lines at 390. Widening the column is the wrong lever:
                    // tennis can carry five of them, and 5 × `w-12` starves the
                    // name column to ~48px at 320. Table notation is exempt
                    // from the 14px uppercase floor (_DESIGN §10), and 9px is
                    // the size the performer chip already uses.
                    className={`w-10 px-0.5 text-right font-mono text-[9px] font-medium uppercase tabular-nums ${
                      open ? "text-accent" : "text-ink-muted"
                    }`}
                  >
                    <span className="sr-only">{longLabelFor(i)}</span>
                    <span aria-hidden>{labelFor(i)}</span>
                  </th>
                );
              })}
              {showTotal && (
                <th
                  scope="col"
                  data-testid="mc-sets-col-total"
                  className="w-10 px-0.5 text-right font-mono text-[9px] font-medium uppercase tabular-nums text-ink"
                >
                  {t(dict, "matchCentre.col.total")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {doc.header.sides.map((side, rowIndex) => (
              <tr
                key={side.entrantId}
                data-testid={`mc-sets-row-${rowIndex}`}
                className="border-b border-zinc-200/60 last:border-0"
              >
                <th scope="row" className="px-1 py-1.5 text-left font-normal">
                  <span className="flex items-center gap-2">
                    {/* The same chip as `timeline-tab.tsx`'s `SideBadge`, and
                        sized the same way — `min-w-[24px] px-0.5`, so a
                        four-letter code widens the box instead of spilling out
                        of it, plus `tabular-nums` so the tie-break's `1`/`2`
                        ordinals do not make these two STACKED chips different
                        widths and start the two names at different x. See that
                        component's note for both. */}
                    {/* `font-mono`, not just `tabular-nums`. CI measured these
                        two stacked chips at 33px ("AND1") and 34px ("AND2"),
                        which is the exact defect the note above says the
                        tabular figures were there to prevent — because
                        `tabular-nums` is `font-variant-numeric`, a FEATURE a
                        font may simply not implement, and the fallback face on
                        the CI runner does not. A monospace FAMILY guarantees
                        equal advance widths whatever face resolves, including
                        the generic fallback when the webfont never loads.
                        `tabular-nums` stays: it costs nothing and is correct
                        wherever the face does support it.

                        Local runs passed this for months — the box's own font
                        fallback happened to render `1` and `2` at the same
                        width. A layout guarantee that depends on which machine
                        rendered it is not a guarantee. */}
                    {/* THE SAME COLOUR CHAIN THE COURT CARD USES, because this
                        chip names the same side a few pixels below it. Measured
                        before this: both rows painted `bg-accent/15`, one
                        identical tint for every side, while the card above
                        painted each club's own colour — two renderings of the
                        same two entities disagreeing on one screen, and the
                        lower one carrying no identity at all. Fourth finding of
                        the same `Side.colour` seam.

                        `monogramInk` picks the ink by measured contrast, so a
                        club that chose a pale colour still reads. A side with
                        no colour falls to `autoColour(name)` — which is what
                        gives an INDIVIDUAL a tile, and tennis entrants are
                        individuals and never have a club. */}
                    <span
                      data-testid={`mc-sets-badge-${rowIndex}`}
                      style={(() => {
                        const paint =
                          monogramInk(side.colour) ?? monogramInk(autoColour(side.name));
                        return paint === null
                          ? undefined
                          : { backgroundColor: paint.bg, color: paint.ink };
                      })()}
                      className="inline-flex h-6 min-w-[24px] shrink-0 items-center justify-center rounded-md bg-accent/15 px-0.5 font-mono text-[10px] font-bold uppercase tabular-nums"
                    >
                      {side.short || side.name.slice(0, 3)}
                    </span>
                    {/* `block truncate`, not `min-w-0` — see the table comment. */}
                    <span className="block truncate">{side.name}</span>
                  </span>
                </th>
                {sets.columns.map((_, i) => (
                  <td
                    key={i}
                    data-testid={`mc-sets-cell-${rowIndex}-${i}`}
                    // `px-0.5`: `box-sizing: border-box` puts padding INSIDE
                    // the `w-10`, and `px-1` left only 32px for the digits.
                    className="px-0.5 text-right font-mono tabular-nums"
                  >
                    {/* An en dash, never blank: a missing cell and a zero must
                        not look the same. */}
                    {sets.rows[rowIndex]?.[i] ?? "–"}
                  </td>
                ))}
                {showTotal && (
                  <td
                    data-testid={`mc-sets-total-${rowIndex}`}
                    className="px-0.5 text-right font-mono font-semibold tabular-nums text-ink"
                  >
                    {totalFor(rowIndex) ?? "–"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabPanel>
  );
}
