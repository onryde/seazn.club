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
//    and `min-w-0 truncate` on the name cell are what should keep six columns
//    inside 320 without it.
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
import type { CricketViewT, MatchCentreDocT, PersonT } from "@/server/public-site/match-centre-schema";
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
  // prints and what fits; the localised word rides in `title` so it is
  // available to anyone who needs it. `scope` keeps the table readable to a
  // screen reader without a visible caption.
  return (
    <th scope="col" className={HEAD_CELL} title={label}>
      {abbr}
    </th>
  );
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
      <table className="w-full text-[13px] leading-tight">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-1 text-left font-medium text-ink-muted" title={t(dict, "matchCentre.col.batter")}>
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
              className="border-b border-line/50 align-top"
            >
              <td className="min-w-0 px-1 py-1">
                <span className="block truncate">{row.person.name}</span>
                {/* The dismissal is a Msg, resolved here in the viewer's own
                    locale — the document never carries pre-rendered copy. */}
                <span className="dis block truncate text-[11px] text-ink-muted">
                  {t(dict, row.dismissal.key, row.dismissal.params)}
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
      <table className="w-full text-[13px] leading-tight">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-1 text-left font-medium text-ink-muted" title={t(dict, "matchCentre.col.bowler")}>
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
              className="border-b border-line/50"
            >
              <td className="min-w-0 px-1 py-1">
                <span className="block truncate">{row.person.name}</span>
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
  open,
  dict,
}: {
  innings: CricketInningsViewT;
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
      className="rounded-xl border border-line bg-surface"
    >
      <summary className="flex cursor-pointer items-baseline justify-between gap-2 px-3 py-2.5">
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
            className="flex justify-between gap-2 border-t border-line px-1 pt-1 text-[13px] font-semibold"
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
          label={`${innings.side.name} — ${t(dict, "matchCentre.col.bowler")}`}
        />
      </div>
    </details>
  );
}

export function ScorecardTab({ doc, dict }: ScorecardTabProps): ReactNode {
  const innings = doc.cricket?.innings ?? [];
  return (
    <div
      role="tabpanel"
      id="mc-tab-panel-scorecard"
      aria-labelledby="mc-tab-scorecard"
      data-testid="mc-tab-panel-scorecard"
      className="grid gap-2"
    >
      {innings.map((entry, index) => (
        <Innings
          key={entry.number}
          innings={entry}
          // See note 2: the last innings, live or finished.
          open={index === innings.length - 1}
          dict={dict}
        />
      ))}
    </div>
  );
}
