// Spectator surface W1, Task 13 — the Sets / Periods tab: per-set points for
// the racket and set-based sports, goals by period for the period sports.
//
// ---------------------------------------------------------------------------
// Not derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. `kind` CHOOSES THE CAPTION; `unit` CHOOSES THE COLUMN LABEL. They are not
//    the same question. `kind` is the shape of the table ("Sets" or "Periods");
//    `unit` is what ONE column is called in the sport's own vocabulary, and
//    badminton and table tennis score GAMES inside a table whose `kind` is
//    still "sets". Labelling a badminton column "Set 1" is wrong in a way a
//    badminton player notices immediately.
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
//    `OT1..OTk`), so a missing `term.<label>` is EXPECTED rather than a defect
//    — it falls through to the ordinal, which still reads correctly.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { lookup, t } from "@/lib/i18n-runtime";
import type { MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
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

  const caption = t(dict, sets.kind === "periods" ? "matchCentre.periods" : "matchCentre.sets");

  // See notes 1, 2 and 4. Three tiers, in order:
  //   1. the engine's own phase token localised — "ET 2nd half", "Overtime";
  //   2. the sport's unit and the ordinal — "Period 4", "Game 2", "Set 3";
  //   3. the raw `columns` string, for a document built before `unit` existed.
  const labelFor = (i: number): string => {
    const phase = sets.columnLabels?.[i];
    if (phase !== undefined && phase !== "") {
      // `lookup`, not `t` — `t` RETURNS THE KEY on a miss, so it would answer
      // "yes, `term.OT3`" for every phase and print the key to a spectator.
      const term = lookup(dict, `term.${phase}`);
      if (typeof term === "string") return term;
    }
    if (sets.unit !== undefined) return t(dict, `matchCentre.col.${sets.unit}`, { n: i + 1 });
    return sets.columns[i] ?? String(i + 1);
  };

  return (
    <TabPanel id="sets" className="grid gap-2">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full text-[13px]">
          <caption className="pb-1 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {caption}
          </caption>
          <thead>
            <tr className="border-b border-zinc-200/80">
              <th scope="col" className="px-1 text-left font-medium text-ink-muted">
                {/* The side column needs no heading: the row header names it. */}
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
                    className={`px-1 text-right font-medium tabular-nums ${
                      open ? "text-accent" : "text-ink-muted"
                    }`}
                  >
                    {labelFor(i)}
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
                <th scope="row" className="min-w-0 px-1 py-1.5 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent/15 text-[10px] font-bold uppercase">
                      {side.short || side.name.slice(0, 3)}
                    </span>
                    <span className="truncate">{side.name}</span>
                  </span>
                </th>
                {sets.columns.map((_, i) => (
                  <td
                    key={i}
                    data-testid={`mc-sets-cell-${rowIndex}-${i}`}
                    className="px-1 text-right tabular-nums"
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
