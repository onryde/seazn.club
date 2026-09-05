// Spectator surface W1, Task 12 — the cricket Scorecard tab.
//
// Renders from `doc.cricket` ONLY. Nothing here re-derives a number: every
// run, ball, average and dismissal already came out of the engine fold through
// `buildMatchCentre`, and a second derivation in a component is the one thing
// guaranteed to disagree with the scorebug three inches above it.
//
// ---------------------------------------------------------------------------
// Four things that are NOT derivable from reading this file
// ---------------------------------------------------------------------------
//
// 1. NATIVE `<details>`, not a JS accordion. The panel has to work in static
//    markup (this workspace's vitest is `environment: "node"`, no jsdom) and
//    before hydration on a slow phone, which is exactly when a spectator opens
//    a scorecard. `open` is a server-rendered attribute; the browser owns the
//    toggle from there and no state of ours can fight it.
//
// 2. THE OPEN INNINGS IS ALWAYS THE LAST ONE, and that is not a shortcut for
//    "the live one". An innings in play IS the last entry in `innings[]` by
//    construction, so `doc.cricket.live` being non-null adds no information
//    about WHICH to open — writing `live ? … : …` with two identical arms
//    would be a dead conditional dressed up as a rule. A finished match opens
//    its last innings, which is the one a reader wants (the chase).
//
// 3. COLUMNS APPEAR ONLY WHEN THE DATA HAS THEM. The fidelity band decides
//    what a scorer recorded: at band 2 every row's `fours`/`sixes`/`maidens`/
//    `wides`/`noBalls` is null, and a column of nine em-dashes on a 320px
//    phone costs more than it says. The rule is per-COLUMN and per-INNINGS —
//    `anyNonNull` over that innings' own rows — never `doc.cricket.band`,
//    because the band is a property of the match and a super over can be
//    scored more coarsely than the innings before it.
//
// 4. THE TABLES ARE REACHABLE SCROLL REGIONS, NOT CLIPPED BOXES. Standing rule
//    from the phone-composition wave: an overflow whose extra content can be
//    reached is a feature, one inside `overflow-hidden` is a defect — and any
//    new scrolling region owes `tabIndex=0` + `role` + an accessible name or
//    axe reds `scrollable-region-focusable` at SERIOUS impact. `tabIndex`
//    cannot be varied by media query, so it is unconditional. Scrolling is the
//    LAST resort though: `text-[13px] px-1 tabular-nums` on the numeric cells
//    and a `table-fixed` name column (`max-w-0 truncate`) are what should keep
//    six columns inside 320 without it. PAINT IS NOT PROVABLE STATICALLY: no
//    assertion on markup can measure a rendered width, so the 320 claim rests
//    on Task 15's screenshots, not on this file's tests.
//
// CONTRACT NOTES for the task that builds `doc.cricket` (recorded here because
// nothing in this file can enforce them):
//   - `extrasLine` must carry the NUMBERS only ("12 (b 2, lb 3, w 6, nb 1)").
//     The word "Extras" is this component's label and is translated; a builder
//     that bakes it into the string would print it twice, in English.
//   - a dismissal `Msg` must supply every param its template names — `t()`
//     leaves an unmatched `{bowler}` in the string a spectator reads. The
//     run-out template takes ONE `{fielder}`, so a thrower/breaker pair is
//     composed into that one param by the builder, the way a scorebook does.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type {
  CricketViewT,
  MatchCentreDocT,
  PersonT,
  SideT,
} from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";

// Derived from `CricketViewT` rather than imported: the schema exports the view
// but not its row types, and this task's file set does not include
// `match-centre-schema.ts`. Indexing keeps them exactly in step with the schema
// — a column added there is a type error here, which a hand-copied interface
// would not be.
type CricketInningsViewT = CricketViewT["innings"][number];
type CricketBattingRowT = CricketInningsViewT["batting"][number];
type CricketBowlingRowT = CricketInningsViewT["bowling"][number];

export interface ScorecardTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  /** The raw live payload. Part of the shared panel signature; this panel
   *  renders from the built document alone and deliberately never reads it. */
  data: LiveFixtureData;
}

/** Does any row in this innings carry a value for this column? See note 3. */
function anyNonNull<T>(rows: readonly T[], pick: (row: T) => number | string | null): boolean {
  return rows.some((row) => pick(row) !== null);
}

const NUM_CELL = "px-1 text-right tabular-nums";
const HEAD_CELL = "px-1 text-right font-medium text-ink-muted";

/** A numeric cell that reads as "not recorded" rather than as zero. */
function Num({ value }: { value: number | string | null }): ReactNode {
  return <td className={NUM_CELL}>{value === null ? "—" : value}</td>;
}

function Th({ label, abbr }: { label: string; abbr: string }): ReactNode {
  // The header shows NOTATION (R, B, 4s, SR) because that is what a scorecard
  // prints and what fits six columns into 320px. `title` alone was not enough:
  // it is a hover affordance, and a phone has no hover — so the localised word
  // ALSO ships as `sr-only` text, with the abbreviation hidden from the
  // accessibility tree so a screen reader reads "Strike rate" once rather than
  // "SR Strike rate".
  return (
    <th scope="col" className={HEAD_CELL} title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden>{abbr}</span>
    </th>
  );
}

/** The name column's width, and the `max-w-0` that makes truncation work.
 *
 *  `min-w-0` does nothing on a `<td>`, and an auto-layout table simply grows to
 *  fit the longest name — so `truncate` could never fire and a 43-character
 *  entrant pushed the numeric columns off a 320px screen. `table-fixed` plus an
 *  explicit width is what bounds the cell; `max-w-0` on the inner block is the
 *  standard trick that makes a percentage-width table cell actually clip. */
const NAME_CELL = "max-w-0 truncate";

/**
 * A dismissal, resolved — or the neutral "out" when the document could not
 * fill its own template.
 *
 * `interpolate` leaves an unmatched `{fielder}` VERBATIM in the string, and
 * `fielder` is optional on the engine's own wicket payload (`CricketWicket`),
 * so a caught dismissal recorded without one renders "c {fielder} b J. Bumrah"
 * to a spectator. There is no way to fix that in the template — a template that
 * omitted the fielder would be a different sentence — so a resolved string that
 * still contains a brace is treated as unusable and falls back to the one
 * dismissal key that names nobody.
 */
function dismissalText(dict: PublicDict, dismissal: CricketBattingRowT["dismissal"]): string {
  const text = t(dict, dismissal.key, dismissal.params);
  return text.includes("{") ? t(dict, "matchCentre.dismissal.out_unknown") : text;
}

function ScrollRegion({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      {children}
    </div>
  );
}

function BattingTable({
  rows,
  dict,
  label,
}: {
  rows: readonly CricketBattingRowT[];
  dict: PublicDict;
  label: string;
}): ReactNode {
  const showFours = anyNonNull(rows, (r) => r.fours);
  const showSixes = anyNonNull(rows, (r) => r.sixes);
  const showSr = anyNonNull(rows, (r) => r.strikeRate);
  return (
    <ScrollRegion label={label}>
      <table className="w-full table-fixed text-[13px] leading-tight">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-zinc-200/80">
            <th
              scope="col"
              className="w-[44%] px-1 text-left font-medium text-ink-muted"
              title={t(dict, "matchCentre.col.batter")}
            >
              {t(dict, "matchCentre.col.batter")}
            </th>
            <Th label={t(dict, "matchCentre.col.runs")} abbr="R" />
            <Th label={t(dict, "matchCentre.col.balls")} abbr="B" />
            {showFours ? <Th label={t(dict, "matchCentre.col.fours")} abbr="4s" /> : null}
            {showSixes ? <Th label={t(dict, "matchCentre.col.sixes")} abbr="6s" /> : null}
            {showSr ? <Th label={t(dict, "matchCentre.col.strikeRate")} abbr="SR" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.person.personId}
              data-testid={`mc-bat-${row.person.personId}`}
              className="border-b border-zinc-200/60 align-top"
            >
              <td className="px-1 py-1">
                <span className={`block ${NAME_CELL}`}>{row.person.name}</span>
                {/* The dismissal is a Msg, resolved here in the viewer's own
                    locale — the document never carries pre-rendered copy. */}
                <span className={`dis block text-[11px] text-ink-muted ${NAME_CELL}`}>
                  {dismissalText(dict, row.dismissal)}
                </span>
              </td>
              <td className={`${NUM_CELL} font-semibold`}>{row.runs}</td>
              <Num value={row.balls} />
              {showFours ? <Num value={row.fours} /> : null}
              {showSixes ? <Num value={row.sixes} /> : null}
              {showSr ? <Num value={row.strikeRate} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

function BowlingTable({
  rows,
  dict,
  label,
}: {
  rows: readonly CricketBowlingRowT[];
  dict: PublicDict;
  label: string;
}): ReactNode {
  const showMaidens = anyNonNull(rows, (r) => r.maidens);
  const showEcon = anyNonNull(rows, (r) => r.economy);
  const showWides = anyNonNull(rows, (r) => r.wides);
  const showNoBalls = anyNonNull(rows, (r) => r.noBalls);
  return (
    <ScrollRegion label={label}>
      <table className="w-full table-fixed text-[13px] leading-tight">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-zinc-200/80">
            <th
              scope="col"
              className="w-[40%] px-1 text-left font-medium text-ink-muted"
              title={t(dict, "matchCentre.col.bowler")}
            >
              {t(dict, "matchCentre.col.bowler")}
            </th>
            <Th label={t(dict, "matchCentre.col.overs")} abbr="O" />
            {showMaidens ? <Th label={t(dict, "matchCentre.col.maidens")} abbr="M" /> : null}
            <Th label={t(dict, "matchCentre.col.runs")} abbr="R" />
            <Th label={t(dict, "matchCentre.col.wickets")} abbr="W" />
            {showEcon ? <Th label={t(dict, "matchCentre.col.economy")} abbr="Econ" /> : null}
            {showWides ? <Th label={t(dict, "matchCentre.col.wides")} abbr="wd" /> : null}
            {showNoBalls ? <Th label={t(dict, "matchCentre.col.noBalls")} abbr="nb" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.person.personId}
              data-testid={`mc-bowl-${row.person.personId}`}
              className="border-b border-zinc-200/60"
            >
              <td className="px-1 py-1">
                <span className={`block ${NAME_CELL}`}>{row.person.name}</span>
              </td>
              <Num value={row.overs} />
              {showMaidens ? <Num value={row.maidens} /> : null}
              <Num value={row.runs} />
              <td className={`${NUM_CELL} font-semibold`}>{row.wickets}</td>
              {showEcon ? <Num value={row.economy} /> : null}
              {showWides ? <Num value={row.wides} /> : null}
              {showNoBalls ? <Num value={row.noBalls} /> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

const names = (people: readonly PersonT[]): string => people.map((p) => p.name).join(", ");

function Innings({
  innings,
  fieldingSide,
  open,
  dict,
}: {
  innings: CricketInningsViewT;
  /** The side BOWLING in this innings — the other one. See the call site. */
  fieldingSide: SideT;
  open: boolean;
  dict: PublicDict;
}): ReactNode {
  const n = innings.number;
  const fow = innings.fallOfWickets
    .map((f) => `${f.wicket}-${f.runs} (${f.batter.name}, ${f.over})`)
    .join(" · ");
  return (
    <details
      data-testid={`mc-innings-${n}`}
      open={open}
      className="group rounded-xl border border-zinc-200/80 bg-surface"
    >
      {/* `display: flex` on a <summary> REMOVES the UA disclosure marker
          (`summary { display: list-item }`), so a closed innings showed no
          affordance at all — nothing said it could be opened. `list-none` makes
          that explicit rather than accidental, and the chevron below is the
          replacement: `aria-hidden`, because <details> already announces its
          own expanded state, and rotated from the <details> group. */}
      <summary className="flex list-none cursor-pointer items-baseline justify-between gap-2 px-3 py-2.5">
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="mt-1 h-3 w-3 shrink-0 text-ink-muted transition-transform group-open:rotate-90"
        >
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" />
        </svg>
        <span className="min-w-0">
          <span className="block truncate font-semibold">{innings.side.name}</span>
          <span className="block text-[11px] text-ink-muted">
            {t(dict, "matchCentre.innings", { number: n })}
            {innings.isSuperOver ? ` · ${t(dict, "matchCentre.superOver")}` : ""}
          </span>
        </span>
        <span className="shrink-0 tabular-nums font-semibold">
          {innings.total.runs}/{innings.total.wickets}
          <span className="ml-1 text-[11px] font-normal text-ink-muted">
            ({innings.total.overs})
          </span>
        </span>
      </summary>

      <div className="grid gap-3 px-3 pb-3 md:grid-cols-2">
        <div className="grid gap-2">
          <BattingTable
            rows={innings.batting}
            dict={dict}
            label={`${innings.side.name} — ${t(dict, "matchCentre.col.batter")}`}
          />
          {innings.extrasLine === null ? null : (
            <p data-testid={`mc-extras-${n}`} className="flex justify-between gap-2 px-1 text-[13px]">
              <span className="text-ink-muted">{t(dict, "matchCentre.extras")}</span>
              <span className="tabular-nums">{innings.extrasLine}</span>
            </p>
          )}
          <p
            data-testid={`mc-total-${n}`}
            className="flex justify-between gap-2 border-t border-zinc-200/80 px-1 pt-1 text-[13px] font-semibold"
          >
            <span>{t(dict, "matchCentre.total")}</span>
            <span className="tabular-nums">
              {innings.total.runs}/{innings.total.wickets} ({innings.total.overs})
              {innings.total.runRate === null ? "" : ` · ${innings.total.runRate}`}
            </span>
          </p>
          {innings.didNotBat.length === 0 ? null : (
            <p data-testid={`mc-dnb-${n}`} className="px-1 text-[11px] text-ink-muted">
              <span className="font-medium">{t(dict, "matchCentre.didNotBat")}</span>{" "}
              {names(innings.didNotBat)}
            </p>
          )}
          {fow === "" ? null : (
            <p data-testid={`mc-fow-line-${n}`} className="px-1 text-[11px] text-ink-muted">
              <span className="font-medium">{t(dict, "matchCentre.fallOfWickets")}</span> {fow}
            </p>
          )}
        </div>

        <BowlingTable
          rows={innings.bowling}
          dict={dict}
          // The BOWLERS ARE THE FIELDING SIDE'S. Naming this region after
          // `innings.side` labelled the away team's attack with the batting
          // team's name — the one thing a screen-reader user relies on it for.
          label={t(dict, "matchCentre.bowlingFor", { side: fieldingSide.name })}
        />
      </div>
    </details>
  );
}

export function ScorecardTab({ doc, dict }: ScorecardTabProps): ReactNode {
  const innings = doc.cricket?.innings ?? [];
  return (
    // The tabpanel role, id and label live on `MatchCentre`'s wrapper around
    // whichever panel is active — declaring them here too would nest two
    // tabpanels and duplicate an id. See `tab-panel.tsx`.
    <div data-testid="mc-scorecard" className="grid gap-2">
      {innings.map((entry, index) => (
        <Innings
          key={entry.number}
          innings={entry}
          // The side that is NOT batting is the one bowling. Matched on
          // `entrantId` rather than by index, because `innings[].side` is a
          // copy of a header side and nothing guarantees the header's order
          // matches the batting order — the side batting second is `sides[0]`
          // whenever the away team won the toss and chose to field.
          fieldingSide={
            doc.header.sides.find((s) => s.entrantId !== entry.side.entrantId) ??
            doc.header.sides[1]
          }
          // See note 2: the last innings, live or finished.
          open={index === innings.length - 1}
          dict={dict}
        />
      ))}
    </div>
  );
}
