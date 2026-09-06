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
//    grows to make it. So headers resolve `term.short.<phase>` ("ET1"),
//    identical in all four locales because it is notation, and the full name
//    rides in `title` plus an `sr-only` span so a screen reader and a hover
//    still get it. The prose keys are not redundant: the Timeline's sentences
//    use them.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
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
                    className={`w-10 px-0.5 text-right font-medium tabular-nums ${
                      open ? "text-accent" : "text-ink-muted"
                    }`}
                  >
                    <span className="sr-only">{longLabelFor(i)}</span>
                    <span aria-hidden>{labelFor(i)}</span>
                  </th>
                );
              })}
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
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold uppercase">
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
                    className="px-0.5 text-right tabular-nums"
                  >
                    {/* An en dash, never blank: a missing cell and a zero must
                        not look the same. */}
                    {sets.rows[rowIndex]?.[i] ?? "–"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabPanel>
  );
}
