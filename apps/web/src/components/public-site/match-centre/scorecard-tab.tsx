// Spectator surface W1, Task 12 — the cricket Scorecard tab.
//
// Renders from `doc.cricket` ONLY. Nothing here re-derives a number: every
// run, ball, average and dismissal already came out of the engine fold through
// `buildMatchCentre`, and a second derivation in a component is the one thing
// guaranteed to disagree with the scorebug three inches above it.
//
// ---------------------------------------------------------------------------
// Six things that are NOT derivable from reading this file
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
//    LAST resort, and the width budget is what should mean it never happens at
//    320: `table-fixed w-full`, every NUMERIC column sized explicitly (R/B/4s/6s
//    w-7, SR w-11; O w-8, M/W w-6, Econ w-11) at `px-0.5`, and the NAME column
//    left unsized so it takes the remainder — about 106px on the batting table
//    and 110px on the bowling one at 320 once the grid's own `px-3` and the
//    borders come off, so roughly 12-13 characters. Sizing the name column, as a
//    first
//    attempt did, starves the numerics to 16-24px each and is why they are
//    sized and it is not. Below `md` the bowling table also folds `wd`/`nb`
//    away and prints them as the bowler's sub-line (`PHONE_FOLD`).
//    PAINT IS NOT PROVABLE STATICALLY: no assertion on markup measures a
//    rendered width, so the 320 claim rests on Task 15's screenshots, not on
//    this file's tests.
//
// 5. EVERY ID IS SCOPED BY THE INNINGS' 1-BASED ARRAY POSITION, NEVER BY
//    `innings.number`. A SUPER OVER CAN REUSE A NUMBER, so `mc-innings-1`,
//    `mc-extras-1`, `mc-total-1`, `mc-dnb-1` and `mc-fow-line-1` each named
//    two different innings in the same document, and the `<details>` key
//    collided with them — React mis-reconciles `open` across two siblings
//    claiming one key, so note 2's "the last innings is open" silently landed
//    on the wrong panel. Row ids have the same problem one level down: a
//    player who bats in two innings is ONE `personId`, so the rows are
//    `mc-bat-<position>.<personId>` and `mc-bowl-<position>.<personId>`.
//    This is `commentary-tab.tsx`'s note 1b, which states the same
//    precondition and reaches the same answer — the array position cannot
//    collide by construction — applied to this panel rather than reinvented.
//    The key and the testid come from ONE expression at the call site so a
//    change to either moves both.
//    THE SAME SCOPE NAMES THE TWO SCROLL REGIONS. `role="region"` +
//    `aria-label` puts an entry in a screen reader's landmark list, and
//    `{side} — batting` alone made two of those entries identical the moment
//    a super over let one side bat twice — the accessible-name twin of the
//    id collision above, and the one this note originally missed. Both
//    templates therefore take `{position}`, not `{number}`: the DISPLAYED
//    number stays `innings.number` ("Innings 1" again, as a scorecard prints
//    it) and only the machine-facing name is scoped.
//
// 6. THE NAME CELL IS A `<th scope="row">`, NOT A `<td>`. Without it a screen
//    reader reading "62" out of the R column has no row header and cannot say
//    whose 62 it is. `<th>` is centred and bold by default, so both cells
//    carry `text-left font-normal` — the same two classes, for the same
//    reason, as `sets-tab.tsx:164`, which is the one place on this surface
//    that already got this right.
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
import { EntityLogo } from "@/components/ui/entity-logo";
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

// `px-0.5`, NOT `px-1`, and the reason is `box-sizing: border-box` (Tailwind
// preflight): padding sits INSIDE the `w-*` width, so `px-1` left `w-7` a 20px
// content box. Three digits are ~22px and "10.2" ~26px, so the commonest values
// overflowed — and under `table-fixed` an overflowing cell spills LEFT over its
// neighbour's digits rather than widening the table, so the scroll region could
// not rescue it either. `px-0.5` yields 24 / 28 / 40px content boxes for
// w-7 / w-8 / w-11. The NAME cell keeps `px-1`: it has room, and it truncates.
// Owner design round (D, extended to the Scorecard) — the figures are set in
// the mono face, like the Summary tab's live block. `tabular-nums` alone kept
// the digits on a common advance width but left them in Geist Sans, so a
// scorecard column read as prose that happened to be numbers. Only the
// FIGURES and their notation headers change face; names stay in the body face,
// which is what keeps a name and a number distinguishable at a glance.
// EXPORTED for `scorecard-tab.test.tsx`'s emphasis test, which used to spell
// this class string out three times as regex literals. That made a pure
// restyling (adding `font-mono`) red a test about BOLD-vs-NOT-BOLD, which is a
// test failing for a reason it has nothing to do with. It now derives its
// expectation from this constant, so the styling can move without dragging the
// rule's test with it.
export const NUM_CELL = "px-0.5 text-right font-mono tabular-nums";
const HEAD_CELL = "px-0.5 text-right font-mono text-[10px] font-medium uppercase tracking-wide text-ink-muted";
/** The NAME column's header — batting and bowling both use it. Kept as ONE
 *  constant because they were two identical literals and the first pass of
 *  this round changed only the batting one, leaving the bowling table's
 *  header in the old face directly beside it. */
const NAME_HEAD_CELL =
  "px-1 text-left font-mono text-[10px] font-medium uppercase tracking-wide text-ink-muted";

/** A numeric cell that reads as "not recorded" rather than as zero. */
function Num({
  value,
  className = "",
}: {
  value: number | string | null;
  className?: string;
}): ReactNode {
  return <td className={`${NUM_CELL} ${className}`}>{value === null ? "—" : value}</td>;
}

/**
 * R11 fix round, C4 — the batting "R" and bowling "W" cells used to render
 * `font-semibold` unconditionally, so a bowler with zero wickets (the
 * common case — most spells take none) got a bold "0" that reads as an
 * achievement it isn't. Bold now marks "something happened": a positive
 * value gets the emphasis, a zero renders plain — applied to BOTH the R and
 * W columns identically, so the two headline numbers stay consistent with
 * each other rather than one rule for runs and another for wickets.
 */
function emphasisedNumCell(value: number): string {
  return value > 0 ? `${NUM_CELL} font-semibold` : NUM_CELL;
}

/**
 * The wides / no-balls columns are folded away below `md` and printed as the
 * bowler's sub-line instead.
 *
 * Seven numeric columns do not fit beside a readable name at 320: something has
 * to give, and two low-salience extras cost less as "wd 2 · nb 1" under the
 * name than as two more 28px columns squeezing the name to nothing. ONE DOM,
 * branched — this is a `max-md:hidden` on the existing cells, not a second
 * phone table.
 */
const PHONE_FOLD = "max-md:hidden";

/**
 * "wd 2 · nb 1" — notation, no words, so it needs no translation.
 *
 * TRUTHINESS, not `!== null`, and the difference is most of the rows on the
 * page: a bowler who conceded no wides has `wides: 0`, not `null`, so the
 * null-check version printed "wd 0 · nb 0" under nearly every bowler's name on
 * every phone. A zero here is not a fact worth a line — the COLUMN still shows
 * it at ≥md, where there is room for a grid of zeros; the sub-line exists to
 * carry the exceptions.
 */
function extrasSubLine(row: CricketBowlingRowT): string | null {
  const parts: string[] = [];
  if (row.wides) parts.push(`wd ${row.wides}`);
  if (row.noBalls) parts.push(`nb ${row.noBalls}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

function Th({
  label,
  abbr,
  width,
  className = "",
}: {
  label: string;
  abbr: string;
  /** Explicit under `table-fixed`, or the browser divides the remaining space
   *  evenly and the name column loses. */
  width: string;
  className?: string;
}): ReactNode {
  // The header shows NOTATION (R, B, 4s, SR) because that is what a scorecard
  // prints and what fits six columns into 320px. `title` alone was not enough:
  // it is a hover affordance, and a phone has no hover — so the localised word
  // ALSO ships as `sr-only` text, with the abbreviation hidden from the
  // accessibility tree so a screen reader reads "Strike rate" once rather than
  // "SR Strike rate".
  return (
    <th scope="col" className={`${HEAD_CELL} ${width} ${className}`} title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden>{abbr}</span>
    </th>
  );
}

/**
 * The name span. `block truncate` and NOTHING ELSE — in particular NOT
 * `max-w-0`.
 *
 * The first attempt at this put `max-w-0` here, reasoning from the trick that
 * makes a percentage-width flex child clip. On a `display:block` span it does
 * something else entirely: the used width IS zero, and `truncate`'s
 * `overflow:hidden` then clips the text away completely — every batter name,
 * every bowler name and every dismissal line rendered BLANK. The test covering
 * it asserted only that the string `max-w-0` appeared in the markup, so it was
 * green on a component that displayed nothing.
 *
 * Under `table-fixed` none of that is needed: the COLUMN width bounds the cell,
 * and `truncate` on the block inside it does the rest.
 */
const NAME_CELL = "block truncate";

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
  // Two ways the document can fail to give us a sentence, and `t()` reports
  // them differently: an unfilled `{fielder}` survives interpolation verbatim,
  // and a key NO locale carries comes back AS THE KEY. Both would print
  // machine text to a spectator.
  const unusable = text === dismissal.key || text.includes("{");
  return unusable ? t(dict, "matchCentre.dismissal.out_unknown") : text;
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
  position,
}: {
  rows: readonly CricketBattingRowT[];
  dict: PublicDict;
  label: string;
  /** The innings' 1-BASED ARRAY POSITION — see note 5. Scopes the row testids,
   *  because one person can bat in two innings of the same match. */
  position: number;
}): ReactNode {
  // An innings with NO rows of this kind renders NOTHING, never a bare header
  // row. `match-b-tab-scorecard-320.png` showed exactly that: "BOWLER  O R W"
  // with no rows under it, on a band-2 innings whose bowling was never
  // recorded. The sibling `didNotBat` and fall-of-wickets lines in this file
  // already guard the same way; this table did not.
  if (rows.length === 0) return null;
  const showFours = anyNonNull(rows, (r) => r.fours);
  const showSixes = anyNonNull(rows, (r) => r.sixes);
  const showSr = anyNonNull(rows, (r) => r.strikeRate);
  return (
    <ScrollRegion label={label}>
      <table className="w-full table-fixed text-[13px] leading-tight">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr className="border-b border-zinc-200/80">
            {/* NO width: the name column takes whatever the sized numeric
                columns leave (~120px at 320, about 15 characters). Sizing THIS
                one instead starved the numerics to 16-24px each. */}
            <th
              scope="col"
              className={NAME_HEAD_CELL}
              title={t(dict, "matchCentre.col.batter")}
            >
              {t(dict, "matchCentre.col.batter")}
            </th>
            <Th label={t(dict, "matchCentre.col.runs")} abbr="R" width="w-7" />
            <Th label={t(dict, "matchCentre.col.balls")} abbr="B" width="w-7" />
            {showFours ? <Th label={t(dict, "matchCentre.col.fours")} abbr="4s" width="w-7" /> : null}
            {showSixes ? <Th label={t(dict, "matchCentre.col.sixes")} abbr="6s" width="w-7" /> : null}
            {showSr ? <Th label={t(dict, "matchCentre.col.strikeRate")} abbr="SR" width="w-11" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${position}.${row.person.personId}`}
              data-testid={`mc-bat-${position}.${row.person.personId}`}
              className="border-b border-zinc-200/60 align-top"
            >
              {/* `<th scope="row">`, not `<td>` — see note 6. `text-left
                  font-normal` because a `<th>` is centred and bold by default
                  and this is a name, not a heading a reader is meant to weigh
                  differently; `sets-tab.tsx`'s row header carries the same two
                  for the same reason. */}
              <th scope="row" className="px-1 py-1 text-left font-normal">
                <span className={NAME_CELL}>{row.person.name}</span>
                {/* The dismissal is a Msg, resolved here in the viewer's own
                    locale — the document never carries pre-rendered copy. */}
                <span className={`dis text-[11px] text-ink-muted ${NAME_CELL}`}>
                  {dismissalText(dict, row.dismissal)}
                </span>
              </th>
              <td className={emphasisedNumCell(row.runs)}>{row.runs}</td>
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
  position,
}: {
  rows: readonly CricketBowlingRowT[];
  dict: PublicDict;
  label: string;
  /** The innings' 1-BASED ARRAY POSITION — see note 5. */
  position: number;
}): ReactNode {
  // An innings with NO rows of this kind renders NOTHING, never a bare header
  // row. `match-b-tab-scorecard-320.png` showed exactly that: "BOWLER  O R W"
  // with no rows under it, on a band-2 innings whose bowling was never
  // recorded. The sibling `didNotBat` and fall-of-wickets lines in this file
  // already guard the same way; this table did not.
  if (rows.length === 0) return null;
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
            {/* NO width — see the batting table. */}
            <th
              scope="col"
              className={NAME_HEAD_CELL}
              title={t(dict, "matchCentre.col.bowler")}
            >
              {t(dict, "matchCentre.col.bowler")}
            </th>
            <Th label={t(dict, "matchCentre.col.overs")} abbr="O" width="w-8" />
            {showMaidens ? <Th label={t(dict, "matchCentre.col.maidens")} abbr="M" width="w-6" /> : null}
            <Th label={t(dict, "matchCentre.col.runs")} abbr="R" width="w-7" />
            <Th label={t(dict, "matchCentre.col.wickets")} abbr="W" width="w-6" />
            {showEcon ? <Th label={t(dict, "matchCentre.col.economy")} abbr="Econ" width="w-11" /> : null}
            {showWides ? (
              <Th label={t(dict, "matchCentre.col.wides")} abbr="wd" width="w-7" className={PHONE_FOLD} />
            ) : null}
            {showNoBalls ? (
              <Th label={t(dict, "matchCentre.col.noBalls")} abbr="nb" width="w-7" className={PHONE_FOLD} />
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${position}.${row.person.personId}`}
              data-testid={`mc-bowl-${position}.${row.person.personId}`}
              className="border-b border-zinc-200/60"
            >
              {/* `<th scope="row">` — see the batting table and note 6. */}
              <th scope="row" className="px-1 py-1 text-left font-normal">
                <span className={NAME_CELL}>{row.person.name}</span>
                {extrasSubLine(row) === null ? null : (
                  <span
                    data-testid={`mc-bowl-extras-${position}.${row.person.personId}`}
                    className={`block text-[11px] tabular-nums text-ink-muted md:hidden`}
                  >
                    {extrasSubLine(row)}
                  </span>
                )}
              </th>
              <Num value={row.overs} />
              {showMaidens ? <Num value={row.maidens} /> : null}
              <Num value={row.runs} />
              <td className={emphasisedNumCell(row.wickets)}>{row.wickets}</td>
              {showEcon ? <Num value={row.economy} /> : null}
              {showWides ? <Num value={row.wides} className={PHONE_FOLD} /> : null}
              {showNoBalls ? <Num value={row.noBalls} className={PHONE_FOLD} /> : null}
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
  position,
}: {
  innings: CricketInningsViewT;
  /** The side BOWLING in this innings — the other one. See the call site. */
  fieldingSide: SideT;
  open: boolean;
  dict: PublicDict;
  /** 1-BASED ARRAY POSITION, which is what every id here is scoped by — see
   *  note 5. `innings.number` is the DISPLAYED number and stays that. */
  position: number;
}): ReactNode {
  // The two are deliberately separate. `n` is what a reader sees ("Innings 1"
  // again, for a super over); `position` is what the document is keyed by.
  const n = innings.number;
  const fow = innings.fallOfWickets
    .map((f) => `${f.wicket}-${f.runs} (${f.batter.name}, ${f.over})`)
    .join(" · ");
  return (
    <details
      data-testid={`mc-innings-${position}`}
      open={open}
      className="group rounded-xl border border-zinc-200/80 bg-surface"
    >
      {/* `display: flex` on a <summary> REMOVES the UA disclosure marker
          (`summary { display: list-item }`), so a closed innings showed no
          affordance at all — nothing said it could be opened. `list-none` makes
          that explicit rather than accidental, and the chevron below is the
          replacement: `aria-hidden`, because <details> already announces its
          own expanded state, and rotated from the <details> group. */}
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        {/* Chevron and name are ONE flex item. As three siblings under
            `justify-between` the name floated to the middle of the row with
            gaps either side; grouped, the name block owns the left and the
            score owns the right, which is what a scorecard looks like. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <svg
            aria-hidden
            viewBox="0 0 12 12"
            className="h-3 w-3 shrink-0 text-ink-muted transition-transform group-open:rotate-90"
          >
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" />
          </svg>
          {/* The batting side's crest, in its own colour — the same tile the
              court card now draws, from the same `Side.colour`/`badgeUrl` the
              document already carries. Side by side, two innings panels are
              told apart by their crest before their name is read. */}
          <EntityLogo
            src={innings.side.badgeUrl}
            name={innings.side.name}
            colour={innings.side.colour}
            size={24}
          />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{innings.side.name}</span>
            <span className="block text-[11px] text-ink-muted">
              {t(dict, "matchCentre.innings", { number: n })}
              {innings.isSuperOver ? ` · ${t(dict, "matchCentre.superOver")}` : ""}
            </span>
          </span>
        </span>
        <span className="shrink-0 font-mono font-semibold tabular-nums">
          {innings.total.runs}/{innings.total.wickets}
          <span className="ml-1 text-[11px] font-normal text-ink-muted">
            ({innings.total.overs})
          </span>
        </span>
      </summary>

      {/* BATTING ABOVE BOWLING, at every width — the design board's layout,
          and it corrects a false symmetry rather than just moving boxes. In
          innings 1 the batting table is Queens and the bowling table is
          Crusaders: side by side they read as two halves of ONE side's card,
          which is not what they are. Under a summary that names the batting
          side, stacked, each table is read as what it is.

          The horizontal room that frees goes to the SECOND INNINGS instead
          (the grid on the root below) — measured at 1280 the old arrangement
          was two 477px tables inside one 992px panel, with the second innings
          pushed below the fold. */}
      <div className="grid gap-3 px-3 pb-3">
        <div className="grid gap-2">
          <BattingTable
            rows={innings.batting}
            dict={dict}
            position={position}
            // The name carries the POSITION as well as the side — see note 5.
            // A super over is the same side batting again, so `{side} —
            // batting` alone put two `role="region"` landmarks with one name
            // in the document and a screen-reader user could not tell the
            // chase from the super over.
            label={t(dict, "matchCentre.battingFor", {
              side: innings.side.name,
              position,
            })}
          />
          {innings.extrasLine === null ? null : (
            <p data-testid={`mc-extras-${position}`} className="flex justify-between gap-2 px-1 text-[13px]">
              <span className="text-ink-muted">{t(dict, "matchCentre.extras")}</span>
              <span className="font-mono tabular-nums">{innings.extrasLine}</span>
            </p>
          )}
          <p
            data-testid={`mc-total-${position}`}
            className="flex justify-between gap-2 border-t border-zinc-200/80 px-1 pt-1 text-[13px] font-semibold"
          >
            <span>{t(dict, "matchCentre.total")}</span>
            {/* "83/6 (8.0 ov, RR 10.38)" — the board's shape. Both units are
                COPY ("ov", "RR"), so each comes from the dictionary rather
                than being punctuation this file invents; the parentheses and
                the comma around them are punctuation, which is why they live
                here and not in a translated sentence.

                It used to read "83/6 (8.0) · 10.38", where the bare trailing
                number had nothing saying what it was. A run rate is the one
                figure on a scorecard a reader most needs labelled — 10.38 is
                meaningless beside 8.0 without it. */}
            <span className="font-mono tabular-nums">
              {innings.total.runs}/{innings.total.wickets} (
              {t(dict, "matchCentre.oversShort", { overs: innings.total.overs })}
              {innings.total.runRate === null
                ? ""
                : `, ${t(dict, "matchCentre.runRateShort", { rate: innings.total.runRate })}`}
              )
            </span>
          </p>
          {innings.didNotBat.length === 0 ? null : (
            <p data-testid={`mc-dnb-${position}`} className="px-1 text-[11px] text-ink-muted">
              <span className="font-medium">{t(dict, "matchCentre.didNotBat")}</span>{" "}
              {names(innings.didNotBat)}
            </p>
          )}
          {fow === "" ? null : (
            <p data-testid={`mc-fow-line-${position}`} className="px-1 text-[11px] text-ink-muted">
              <span className="font-medium">{t(dict, "matchCentre.fallOfWickets")}</span> {fow}
            </p>
          )}
        </div>

        <BowlingTable
          rows={innings.bowling}
          dict={dict}
          position={position}
          // The BOWLERS ARE THE FIELDING SIDE'S. Naming this region after
          // `innings.side` labelled the away team's attack with the batting
          // team's name — the one thing a screen-reader user relies on it for.
          // `position` for the same reason as the batting region above.
          label={t(dict, "matchCentre.bowlingFor", {
            side: fieldingSide.name,
            position,
          })}
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
    // TWO INNINGS SIDE BY SIDE from `lg`, stacked below it. `lg` rather than
    // `md`: at 768 a half-width panel is ~360px, and a batting table has six
    // numeric columns plus a name — the width the innings gain has to come
    // from somewhere, and below `lg` there is none to give.
    <div data-testid="mc-scorecard" className="grid items-start gap-2 lg:grid-cols-2">
      {innings.map((entry, index) => (
        <Innings
          // KEY AND TESTID SCOPE, from ONE expression — see note 5. `index + 1`
          // is the 1-based array position; `entry.number` is NOT unique (a
          // super over reuses one), and as a key that mis-reconciled `open`
          // across two sibling `<details>`.
          key={`mc-innings-${index + 1}`}
          position={index + 1}
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
          // EVERY innings open. Note 2 used to open only the last one, which
          // is the right rule for a stacked column and the wrong one beside
          // it: from `lg` the two innings sit side by side, and a collapsed
          // panel next to an expanded one is not a composition.
          //
          // `<details open>` is an attribute, not a class — it cannot be
          // varied by media query, so "last only below `lg`, both above" is
          // not expressible without either duplicating the tree or lying to
          // the accessibility tree about the disclosure's state. Opening all
          // of them is the honest resolution: the Scorecard TAB is where a
          // spectator goes for the scorecard, so collapsing half of it is odd
          // at any width, and the disclosure remains for anyone who wants it.
          //
          // The cost, stated rather than hidden: a finished two-innings match
          // is a longer scroll on a phone than it was.
          open
          dict={dict}
        />
      ))}
    </div>
  );
}
