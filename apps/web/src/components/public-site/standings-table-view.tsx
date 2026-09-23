"use client";
// Spectator surface W2, Task 2 — the phone-composed standings table.
//
// `"use client"` for ONE reason: the long tail's disclosure is component
// state. Every row and every column is rendered on the SERVER first, so a
// spectator with no JS still gets the whole table from `md` up and the
// compact P W L Pts set on a phone — the button is the only thing that needs
// the client, and its absence degrades to "you see the four columns that
// matter", never to a blank tab.
//
// This is the SPECTATOR table. `standings-table.tsx` next door is the
// organiser console's and the embed's, and stays exactly as it is: it renders
// a `StandingsRow[]` straight from the engine, this one renders an
// already-formatted `TableViewT` and holds no sport vocabulary, no number
// formatting and no locale of its own. `server/public-site/standings-view.ts`
// owns all three.
//
// Composition rules carried from W1's `stat-table.tsx`, all three learned the
// expensive way there:
//
//  * `table-fixed` with an EXPLICIT width on every numeric column. Under the
//    default AUTO layout a `<td>` sizes to its content and `truncate` just
//    overflows, so the name column can never be made to clip. The name column
//    carries NO width utility at all and takes whatever the numeric columns
//    do not claim.
//  * Tailwind is border-box, so a column's CONTENT width is its `w-*` minus
//    its horizontal padding — `px-0.5` (2px a side), not `px-2`.
//  * A `<th>`'s TEXT content wins its accessible name, so a localised `title`
//    attribute alone is announced to nobody and is a hover affordance a phone
//    does not have. Each header ships the localised word as `sr-only` text
//    with the notation `aria-hidden` — a fold out of the accessibility tree,
//    never a removal.
//
// Review round 1 — THE GEOMETRY, three fixes that no test in this repo can
// witness (`apps/web` vitest is `environment: "node"`: no DOM, no cascade, no
// layout). Fixed by construction; the arithmetic below is asserted, the PAINT
// is owed by the mounting task's 320/360/390 pass.
//
//  * THE NAME COLUMN HAD NO FLOOR. Under fixed layout an auto column takes the
//    remainder, and the table only grows past `w-full` once the EXPLICIT
//    widths alone exceed the container — so the name column reaches 0 before
//    `overflow-x-auto` ever engages. A football division with the disclosure
//    open at 320 was rank 32 + 7×32 + 44 = 300px against a ~286px card: every
//    name clipped to nothing, with 14px of scroll to show for it. The table
//    now carries an explicit `min-width` = rank + `NAME_MIN_PX` + the columns
//    actually DISPLAYED, so the remainder can never fall below the floor and
//    the region scrolls instead of crushing. TWO values, because below `md`
//    the folded columns are `display:none` and claim nothing while from `md`
//    up nothing folds at all: a single value would either force a rail under
//    a collapsed phone or leave the wide state unprotected. They travel as
//    inline CUSTOM PROPERTIES read by the two utilities on the table below,
//    which is how a computed length gets to vary by media query — a plain
//    inline `min-width` cannot, and round 1 wrongly
//    (Write arbitrary-value class names out only where they are USED, never
//    abbreviated in prose: Tailwind's scanner reads comments too, and an
//    ellipsised form written here generated a real, inert min-width rule with
//    an invalid value into the bundle. Measured, not assumed.)
//    deferred the `md`+ case to the mounting task on that basis. It was not
//    a deferral but a REGRESSION: widening the rank column 32→48 took 16px
//    off the name column at every width from `md` up, and football on a
//    ~360px card at 768 — a width the e2e matrix actually runs — left 44px
//    of name and no scroll. The `md:` floor is what puts it back.
//  * THE RANK COLUMN COULD NOT HOLD ITS OWN CONTENTS. `w-8` (32px) minus
//    `pl-3` (12px) left exactly the 20px of the `h-5 w-5` chip — zero slack —
//    and the tie-break `*` beside it is an adjacent JSX expression with no
//    whitespace node between them, so it had no break opportunity and
//    overflowed into the name cell. That is the same trap
//    `stat-table.tsx:26-35` documents. The cell is now a flex row with real
//    gap, and the column is sized for chip + marker together.
//  * THE CHIP COULD NOT PAINT THREE DIGITS. `buildTableView` deliberately
//    sorts rank ≥ 100 correctly (`UNRANKED = MAX_SAFE_INTEGER`); a fixed
//    `w-5` chip then clipped it. `min-w-5 px-0.5` grows the box instead.
//    Round 2, NEW-4 — the first version said `px-1` "keeps the circle for one
//    and two digits", which its own border-box arithmetic contradicts: 20px
//    less 8px of padding leaves 12px, and two bold 12px digits are roughly
//    14px. `px-0.5` leaves 16px, so one and two digits stay inside the 20px
//    circle and only three push it to a ~25px pill. The digit width is an
//    ESTIMATE (~7px at `text-[12px] font-bold`), not something measured here
//    — see the unproven list in the task report.
//
// AGENTS.md #23 — the scroll region owes a `tabindex`, a role and an
// accessible name, and `tabindex` cannot be varied by a media query, so all
// three are unconditional. The container is `overflow-x-auto` at every width
// rather than `overflow-hidden` when collapsed: an overflow whose content is
// REACHABLE is a feature, one inside an `overflow-hidden` box is a defect,
// and a wide long tail on a narrow desktop card is exactly that case.
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { TableColumnT, TableViewT } from "@/server/public-site/competition-hub-schema";
import { StandingsPopover } from "./standings-popover";
import { QualCutRow, QualLegend, QualMarker, QualPopoverBody } from "./qualification-bits";

export interface StandingsTableViewProps {
  view: TableViewT;
  dict: PublicDict;
  /** Prefix for every testid this table emits — `${testid}-row-<entrantId>`,
   *  `${testid}-more`, `${testid}-full`, `${testid}-empty`, `${testid}-scroll`.
   *  A division can publish an overall table AND one per pool on the same
   *  screen, so an entrant appears in two tables at once: a bare
   *  `mh-table-row-<id>` literal would emit duplicate ids. Nothing here is
   *  allowed to name itself outside this prefix — except the two shared
   *  qualification bits (`qual-cut`, `qual-legend`), whose fixed testids are
   *  the same on every standings surface and are found INSIDE this section's
   *  own testid, never page-wide. */
  testid: string;
  /** Render only the first N rows (the overview tab's teaser). Omitted =
   *  every row. */
  preview?: number;
  showFullLink?: boolean;
}

// Podium chips are fixed vocabulary (gold/silver/bronze) — deliberately NOT
// org-themeable, so a red-branded org still reads gold as first place. Same
// three classes `standings-table.tsx` uses; the console and the spectator
// surface must not disagree about what first place looks like.
const MEDAL: Record<number, string> = {
  1: "bg-amber-300 text-amber-950",
  2: "bg-slate-300 text-slate-900",
  3: "bg-orange-300 text-orange-950",
};

/** Width for a numeric column, from the widest thing it has to hold — its own
 *  notation or any of its cells. A single class for every column either wastes
 *  the name column's remainder or wraps a derived value: "P" over one digit
 *  needs 32px, a signed NRR ("+1.000") needs 56.
 *
 *  The class and its pixel value travel TOGETHER because the table's own
 *  `min-width` is the sum of them: two declarations of the same number are two
 *  things to drift, and the drift would be silent (a `min-width` that no
 *  longer matches the columns crushes the name column again). Literal class
 *  names so Tailwind's scanner sees all four. */
const COLUMN_SIZES = [
  { upTo: 2, cls: "w-8", px: 32 },
  { upTo: 4, cls: "w-11", px: 44 },
  { upTo: 6, cls: "w-14", px: 56 },
  { upTo: Number.POSITIVE_INFINITY, cls: "w-16", px: 64 },
] as const;

function columnSize(chars: number): (typeof COLUMN_SIZES)[number] {
  return COLUMN_SIZES.find((s) => chars <= s.upTo) ?? COLUMN_SIZES[COLUMN_SIZES.length - 1]!;
}

/** The rank column: `w-12` (48px) less `pl-2` (8px) = 40px of content box, for
 *  the chip plus the gap and whichever marker the row carries — the tie-break
 *  `*` (~6px) or the 16px qualification marker (which takes the `*`'s place,
 *  never sits beside it). Measured in Chromium on the built hub (Task 8), with
 *  the digits injected into a real chip: one or two digits 20 + 1 + 16 = 37px,
 *  three digits 21.9 + 1 + 16 = 38.9px — inside the box, at 320 and at 1280.
 *  Only a four-digit rank (27.9px) overhangs, by 4.9px. So the marker costs
 *  the column nothing, and `NAME_MIN_PX` and both floors are unchanged. */
const RANK_PX = 48;

/** The narrowest the name column may ever be. 96px holds the 20px crest, its
 *  gap and ~7 characters before the ellipsis — enough for `truncate` to do its
 *  job at 320 rather than clipping to nothing. Anything wider pushes the
 *  COLLAPSED phone table (48 + 96 + 32 + 32 + 32 + 44 = 284px) past a ~286px
 *  card and puts a rail under the compact set, which is the one thing the fold
 *  exists to prevent. */
const NAME_MIN_PX = 96;

/**
 * The columns a PREVIEW shows. Narrower than the compact set, and deliberately.
 *
 * Measured on the built page at 320: the compact set (P W L Pts) left the name
 * column **98px** — enough for "Summit…" and "Riversid…", which is a standings
 * table that cannot tell you who is top. The table did not overflow and no test
 * could see it; it was found by looking at a screenshot.
 *
 * A preview already shows only its first N ROWS, so it is a teaser rather than
 * a table, and the same argument decides its columns: played and points are the
 * two numbers that make a position mean something, and won/lost are exactly the
 * detail "Full division" exists to go and get. Dropping the two returns 64px to
 * the name — 98 → 162 at 320, which holds a real club name.
 *
 * Keys, not `compact`, because this is a SUBSET of compact and the wire carries
 * no finer flag. `standings-table-view.test.tsx` pins it against `COMPACT_KEYS`
 * (`server/public-site/standings-view.ts`) so it cannot drift into naming a
 * column the server never marks compact — a set that matched nothing would fall
 * through to the compact set below and look exactly like this working.
 */
const PREVIEW_KEYS: ReadonlySet<string> = new Set(["played", "points"]);

export function StandingsTableView({
  view,
  dict,
  testid,
  preview,
  showFullLink = true,
}: StandingsTableViewProps) {
  const [expanded, setExpanded] = useState(false);

  const rows = preview === undefined ? view.rows : view.rows.slice(0, preview);
  // A PREVIEW has no long tail at all — see `foldCls`. Without this the
  // disclosure renders under a preview offering to reveal columns that are
  // unconditionally hidden, which is a control that does nothing.
  const hasLongTail = preview === undefined && view.columns.some((c) => !c.compact);
  const sizes = view.columns.map((c, i) =>
    columnSize(Math.max(c.abbr.length, ...view.rows.map((r) => (r.cells[i] ?? "").length))),
  );
  // A PREVIEW narrows to `PREVIEW_KEYS`; a full table shows every compact
  // column, and a long-tail one folds below `md` until the disclosure is
  // opened. From `md` up a full table folds nothing, ever.
  //
  // The fallback is load-bearing rather than defensive: a sport whose table
  // names neither `played` nor `points` would otherwise preview as a list of
  // names with no numbers at all, which is worse than the crowding this fixes.
  // Such a table falls through to the compact set instead.
  const previewNarrows = preview !== undefined && view.columns.some((c) => PREVIEW_KEYS.has(c.key));
  const shown = (c: TableColumnT) =>
    previewNarrows ? PREVIEW_KEYS.has(c.key) : c.compact || expanded;
  // `max-md:hidden` for a full table, `hidden` for a PREVIEW — and the
  // difference was found by driving the built page, not by a test.
  //
  // The fold is keyed to the VIEWPORT ("from `md` up nothing folds, ever"),
  // which is right for a table that gets the page's width and wrong for one in
  // a box narrower than the viewport. The Overview puts previews two-up at
  // `md` and in a 320px side rail at `lg`, so from `md` the widest column set
  // renders in the narrowest container: measured at both 768 and 1280, the
  // region needed 380px and had 358 and 318, and the column pushed out of
  // sight was **Points** — the number a standings table exists for. A media
  // query cannot see its container, so the viewport answer is the wrong tool.
  //
  // A preview therefore shows its compact columns at every width, exactly as
  // it already shows only its first `preview` ROWS. The rest of the table is
  // not lost: "Full division" sits beside it and is the affordance for it.
  const foldCls = (c: TableColumnT) =>
    shown(c) ? "" : preview === undefined ? " max-md:hidden" : " hidden";
  // The floor described at the top of the file, in two flavours because the
  // column set differs by viewport. BELOW `md` a folded column is
  // `display:none` and claims nothing, so only the shown set counts — which is
  // what keeps the collapsed phone off a rail while still guaranteeing the
  // name column its 96px once the disclosure is open. From `md` UP nothing
  // folds, so every column counts.
  const floor = (px: (c: TableColumnT, i: number) => number) =>
    RANK_PX + NAME_MIN_PX + view.columns.reduce((total, c, i) => total + px(c, i), 0);
  const minPhone = floor((c, i) => (shown(c) ? sizes[i]!.px : 0));
  // The wide floor counts every column because above `md` a full table folds
  // nothing — but a PREVIEW folds at every width (see `foldCls`), so counting
  // its hidden columns reserves width for cells that are not rendered. That is
  // what kept **Points** behind a scroll after the fold fix: the columns were
  // gone and the floor still demanded 380px in a 318px rail, so the table
  // overflowed by exactly the space its invisible columns had booked.
  const minWide = floor((c, i) => (preview === undefined || shown(c) ? sizes[i]!.px : 0));

  // ── THE END GUTTER ────────────────────────────────────────────────────────
  // Every numeric column is `px-0.5` (2px a side), which is right BETWEEN
  // columns and wrong at the end of the row: measured at 320, the points value
  // sat 2px from the card's own border, so the number a standings table exists
  // for read as if it had been clipped. The `#` column has carried `pl-2` for
  // the same reason since it was written; this is its missing other half.
  //
  // WHICH column is last is a per-breakpoint question, so it cannot be one
  // class. Below `md` a full table folds its long tail, and a preview folds at
  // every width — so the last VISIBLE column there is the last compact one. At
  // `md` and up a full table folds nothing and the last column is the array's.
  //
  // Those are not the same column, and assuming `points` covers both would be
  // wrong: `standingsColumns` (`lib/public-site.ts:249-253`) pushes points and
  // THEN every derived cascade column, so a division with a cascade ends on a
  // derived column at `md` and on points below it.
  //
  // Exactly one `pr-*` is emitted per cell rather than layering `pr-2` over
  // `px-0.5` — two classes setting one property leave the winner to stylesheet
  // order, which is a class present rather than a class in effect.
  const lastPhone = view.columns.reduce((last, c, i) => (shown(c) ? i : last), -1);
  const lastWide = preview === undefined ? view.columns.length - 1 : lastPhone;
  // The box does not change — Tailwind is border-box and the floors sum
  // `sizes[i].px` — so this spends 6px of the end column's CONTENT, which the
  // widest thing it holds (a 3-digit points total, a signed 6-character rate in
  // its own wider class) has room for.
  const endPad = (i: number) => {
    if (i === lastPhone && i === lastWide) return "pr-2";
    if (i === lastPhone) return "pr-2 md:pr-0.5";
    if (i === lastWide) return "pr-0.5 md:pr-2";
    return "pr-0.5";
  };

  // ── THE CUT LINE ──────────────────────────────────────────────────────────
  // Its first cell spans rank, name and the columns shown at the narrowest
  // width; each column that folds gets an empty cell carrying that column's
  // OWN fold class, so the row spans exactly what the header shows at every
  // width. One `colSpan` over every column crushed the name column under
  // `table-fixed` (`QualCutRow` has the measurement).
  const cut = view.qualification;
  const shownCount = view.columns.filter(shown).length;
  const cutFolds = view.columns.filter((c) => !shown(c)).map((c) => foldCls(c).trim());

  const rankChip = (rank: number | null) => (
    <span
      className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-0.5 font-display text-[12px] font-bold ${
        rank !== null && MEDAL[rank] ? MEDAL[rank] : "text-ink-muted"
      }`}
    >
      {rank ?? ""}
    </span>
  );

  return (
    <section data-testid={testid} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-display text-lg font-semibold text-ink">
          {view.caption}
        </h3>
        {showFullLink ? (
          // `inline-flex min-h-11 items-center` is the 44px tap floor, the
          // same shape `match-centre/info-tab.tsx` uses. W2 contact sheet
          // img-115/116 (owner approved): this link was plain text, so its
          // box WAS its line box — 16px measured at 320 — and a class that
          // only looked bigger would not have moved it. The height has to
          // come from the box a finger meets, which is why the display goes
          // with the `min-h`: `min-height` on an inline box does nothing.
          <Link
            data-testid={`${testid}-full`}
            href={view.fullHref}
            className="inline-flex min-h-11 shrink-0 items-center text-xs font-medium uppercase tracking-wide text-accent-strong hover:underline"
          >
            {t(dict, "table.fullDivision")}
          </Link>
        ) : null}
      </div>

      {/* Round 1 fix 6: the SLICED rows decide, not `view.rows` — a
          `preview={0}` computed by a caller used to paint a header row over
          nothing instead of stating the empty case. */}
      {rows.length === 0 ? (
        <p
          data-testid={`${testid}-empty`}
          className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted"
        >
          {t(dict, "table.empty")}
        </p>
      ) : (
        <>
          {/* Round 1 fix 4: the region carries BOTH — the `id` because
              `aria-controls` needs one, and a `data-testid` because the
              downstream tasks were briefed on `${testid}-scroll` as an emitted
              testid. `role`, `tabIndex` and `aria-label` stay unconditional:
              `tabindex` cannot follow a media query (AGENTS.md #23). */}
          <div
            data-testid={`${testid}-scroll`}
            id={`${testid}-scroll`}
            role="region"
            tabIndex={0}
            // The DIVISION and the caption, not the caption alone. Found by
            // driving the built page: a two-division competition renders two of
            // these regions and both were named "League", because the caption is
            // the STAGE name and almost every competition calls its league stage
            // "League". A sighted reader can at least tell them apart by
            // position; a screen-reader user hears the same name twice with
            // nothing to distinguish them, which is the worse half of the same
            // defect. `divisionName` is already on the view, so this costs
            // nothing and fixes every consumer — the Overview's previews and the
            // Table tab's groups alike.
            aria-label={`${view.divisionName} — ${view.caption}`}
            // `relative` makes the region the containing block of the
            // `.sr-only` header words below (they are `position:absolute`).
            // Without it their containing block was `<body>`, outside this
            // region's `overflow-x` clip, so on a phone the unfolded long-tail
            // columns' labels widened the PAGE: a sideways scroll with nothing
            // visible causing it (T17 HB9b, 320 → 388px).
            className="relative overflow-x-auto rounded-xl border border-zinc-200/80 bg-surface shadow-sm"
          >
            {/* The two floors ride as custom properties so the md: variant
                can pick the wider one — a computed length has no other way to
                vary by media query. settings-nav.tsx uses the same
                CSS-var arbitrary value + md: shape. */}
            <table
              className="w-full table-fixed text-sm tabular-nums min-w-[var(--sv-min)] md:min-w-[var(--sv-min-md)]"
              style={
                { "--sv-min": `${minPhone}px`, "--sv-min-md": `${minWide}px` } as CSSProperties
              }
            >
              <caption className="sr-only">{view.caption}</caption>
              <thead>
                <tr className="border-b border-zinc-200 text-[11px] uppercase tracking-wider text-ink-muted">
                  <th scope="col" data-col="rank" className="w-12 py-2 pl-2 text-left font-semibold">
                    <span className="sr-only">{t(dict, "table.col.rank")}</span>
                    <span aria-hidden>#</span>
                  </th>
                  <th scope="col" className="py-2 pr-2 text-left font-semibold">
                    {t(dict, "table.team")}
                  </th>
                  {view.columns.map((c, i) => (
                    <th
                      key={c.key}
                      scope="col"
                      data-col={c.key}
                      title={c.title}
                      className={`${sizes[i]!.cls} pl-0.5 ${endPad(i)} py-2 text-right font-semibold${foldCls(c)}`}
                    >
                      <span className="sr-only">{c.title}</span>
                      <span aria-hidden>{c.abbr}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* A FLAT list — each entrant's row, then the cut line after
                    place N — not a Fragment per entrant: a Fragment moves every
                    row one level down the tree and shifts every popover's
                    `useId`, so the no-cut table would stop being byte-for-byte
                    what it was (the division table's M9, and the goldens in
                    `standings-table-view-qualification.test.tsx`). */}
                {rows.flatMap((r, index) => [
                  <tr
                    key={r.entrantId}
                    data-testid={`${testid}-row-${r.entrantId}`}
                    data-champion={r.champion ? "true" : "false"}
                    data-qual={r.qual?.status}
                    className={`border-b border-zinc-100 last:border-0 ${
                      r.rank === 1 ? "bg-amber-50/60" : ""
                    }`}
                  >
                    {/* A flex row, not two adjacent JSX expressions: JSX
                        strips the newline between them, so the marker had no
                        break opportunity and overflowed into the name cell on
                        every tied row. The gap is real box, and the column is
                        sized for both together. */}
                    {/* The tie note is the SAME popover the division page's
                        table uses (`standings-popover.tsx`): a tap opens it, a
                        tap anywhere else, Esc, or opening another closes it.
                        It was a `title=` here, which a phone cannot hover — the
                        sentence reached screen readers (as sr-only text) and
                        nobody else. `aria-describedby` on the trigger keeps it
                        spoken on focus without opening anything. */}
                    {/* `py-2.5` on every body cell: a 40px row, so the
                        popover triggers' `-my-2.5 py-2.5` stretch is a 40px
                        tap target that stays inside its own row. At `py-2`
                        (a 36px row) two neighbouring rows' targets overlapped
                        and the lower one took the upper one's taps. */}
                    {/* A row with a qualification status: its rank opens ONE
                        popover — status headline, what a loss would do, the
                        tie note when the row is tied, the what-if (spec §5, in
                        that order). The builder names the button ("Rank 3,
                        Needs help, show details") because the marker is
                        aria-hidden and the chip alone says only "3". The marker
                        takes the tie asterisk's place — the note is in the
                        panel — and the tied row keeps its `-tie-` test id.
                        Same hit area as the tie trigger below. */}
                    <td className="py-2.5 pl-2 align-middle tabular-nums">
                      {r.qual ? (
                        <StandingsPopover
                          testid={`${testid}-${r.tieBreakText ? "tie" : "rank"}-${r.entrantId}`}
                          ariaLabel={r.qual.ariaLabel}
                          className="-my-2.5 flex items-center gap-px py-2.5"
                          trigger={
                            <>
                              {rankChip(r.rank)}
                              <QualMarker status={r.qual.status} />
                            </>
                          }
                        >
                          <QualPopoverBody qual={r.qual} tieNote={r.tieBreakText} />
                        </StandingsPopover>
                      ) : r.tieBreakText ? (
                        <StandingsPopover
                          testid={`${testid}-tie-${r.entrantId}`}
                          className="-my-2.5 flex items-center gap-px py-2.5"
                          trigger={
                            <>
                              {rankChip(r.rank)}
                              <span aria-hidden className="shrink-0 text-[10px] leading-none text-accent">
                                *
                              </span>
                            </>
                          }
                        >
                          {r.tieBreakText}
                        </StandingsPopover>
                      ) : (
                        <span className="flex items-center gap-px">{rankChip(r.rank)}</span>
                      )}
                    </td>
                    {/* The name IS the row's header: without `scope="row"` a
                        screen reader reading "6" out of the Pts column cannot
                        say whose 6 it is. */}
                    <th scope="row" className="py-2.5 pr-2 text-left font-medium text-ink">
                      <span className="flex min-w-0 items-center gap-2">
                        {/* `colour` closes the gap `entity-logo.tsx` records as
                            "STILL GREY, KNOWINGLY": the same club rendered as a
                            coloured tile on the Teams tab and a grey one here,
                            one tab apart on the same page, because `TableRow`
                            carried no colour. It does now, off the map the hub
                            already builds for the fixture sides.

                            It also earns its keep in the 162px preview column:
                            a colour block is read before a two-letter
                            monogram. */}
                        <EntityLogo src={r.badgeUrl} name={r.name} colour={r.colour} size={20} />
                        {/* `truncate` needs `min-w-0` on the whole ancestor
                            chain, not just this span. An Out row reads muted,
                            as its marker does (spec §5). */}
                        <span
                          className={`block min-w-0 truncate${r.qual?.status === "out" ? " text-ink-muted" : ""}`}
                          title={r.name}
                        >
                          {r.name}
                        </span>
                      </span>
                    </th>
                    {view.columns.map((c, i) => {
                      // `cellNotes[i]` pairs with `cells[i]` exactly as the
                      // cell pairs with its column. Absent on a cached
                      // document from before the field, which renders the
                      // plain cell it always did.
                      const note = r.cellNotes?.[i] ?? null;
                      return (
                        <td
                          key={c.key}
                          data-col={c.key}
                          className={`pl-0.5 ${endPad(i)} py-2.5 text-right ${
                            c.key === "points"
                              ? "font-display text-base font-bold text-accent-strong"
                              : "text-zinc-600"
                          }${foldCls(c)}`}
                        >
                          {note === null ? (
                            r.cells[i]
                          ) : (
                            <StandingsPopover
                              testid={`${testid}-ratio-${c.key}-${r.entrantId}`}
                              align="end"
                              className="-my-2.5 py-2.5 text-right underline decoration-zinc-300 decoration-dotted underline-offset-4"
                              trigger={r.cells[i]}
                            >
                              {note}
                            </StandingsPopover>
                          )}
                        </td>
                      );
                    })}
                  </tr>,
                  // After place N — never under the last row SHOWN, where it
                  // says nothing and would take `tr:last-child` (the panel that
                  // opens upward) from the last entrant. So a preview that
                  // stops at or before the line draws no line.
                  ...(cut && index === cut.cutIndex - 1 && index < rows.length - 1
                    ? [<QualCutRow key="qual-cut" colSpan={2 + shownCount} label={cut.label} folds={cutFolds} />]
                    : []),
                ])}
              </tbody>
            </table>
          </div>

          {/* Under the box, outside its sideways scroll, so it wraps to the
              card's width. The full table only: the Overview's preview is a
              teaser beside a "Full division" link, and keeps its markers and
              line without the key to them (controller ruling OQ3). */}
          {view.qualification && preview === undefined ? (
            <QualLegend legend={view.qualification.legend} />
          ) : null}

          {hasLongTail ? (
            <button
              type="button"
              data-testid={`${testid}-more`}
              aria-expanded={expanded}
              aria-controls={`${testid}-scroll`}
              onClick={() => setExpanded((x) => !x)}
              className="min-h-11 w-full rounded-lg border border-zinc-200/80 bg-surface px-3 text-sm font-medium text-accent-strong md:hidden"
            >
              {t(dict, expanded ? "table.fewer" : "table.more")}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
