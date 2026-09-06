// Spectator surface W1, Task 11 — the Summary tab: cricket's live block, top
// performers, fall of wickets and partnerships, all read STRAIGHT off
// `doc.cricket` (names, lines and detail strings are already resolved —
// consent-masked names included — so this component never re-derives a
// number or a name, only lays out what the document already carries). For
// every other sport (`doc.cricket === null`) the tab is just Task 10's
// `LiveScoreBody`, unchanged.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { CricketViewT, MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { LiveScoreBody } from "../live-score";
import { StatTable, type StatColumn } from "./stat-table";
import { Glyph } from "./glyphs";
import { EMPTY_DECIDED_TEMPLATES } from "./decided-templates";
// Task 14 (contract notes, 8b review gap) — the toss line's `elected` param
// ("bat"/"bowl", the engine's own `z.enum`) needs the SAME enum→term swap
// the Timeline already does for `colour`/`kind`/`phase`/etc.; reused rather
// than re-implemented so both tabs localise the same way.
import { localiseParams } from "./timeline-tab";

export interface SummaryTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  data: LiveFixtureData;
  /** Review fix round 2 (minor) — threaded through to `LiveScoreBody`'s
   *  "· realtime" indicator when this tab falls back to it (non-cricket,
   *  or pre-play cricket). */
  subscribed?: boolean;
}

type LiveBlockT = NonNullable<CricketViewT["live"]>;
type BattingRowT = LiveBlockT["batters"][number];
type BowlingRowT = LiveBlockT["bowling"][number];
type InningsT = CricketViewT["innings"][number];
type TopPerformerT = CricketViewT["topPerformers"][number];

/** Reshaping the document's OWN two sides into the `Record<id,name>` shape
 *  `LiveScoreBody` expects — not a re-derivation, since `header.sides[].name`
 *  is already the consent-resolved display name the document carries. */
function entrantNamesFromDoc(doc: MatchCentreDocT): Record<string, string> {
  const [home, away] = doc.header.sides;
  return { [home.entrantId]: home.name, [away.entrantId]: away.name };
}

export function SummaryTab({ doc, dict, data, subscribed }: SummaryTabProps) {
  const cricket = doc.cricket;
  // Review fix round 2 (IMPORTANT 5) — pre-play cricket (no live block, no
  // performers yet, no innings started) used to render a blank tab; the
  // scorebug (`LiveScoreBody`, "Not started"/starts-at) is exactly as
  // informative here as it is for a non-cricket fixture in the same state,
  // so both take the SAME fallback.
  const isPrePlay =
    cricket !== null && cricket.live === null && cricket.topPerformers.length === 0 && cricket.innings.length === 0;

  if (!cricket || isPrePlay) {
    return (
      <LiveScoreBody
        data={data}
        entrantNames={entrantNamesFromDoc(doc)}
        sportKey={doc.sportKey}
        decidedTemplates={EMPTY_DECIDED_TEMPLATES}
        dict={dict}
        subscribed={subscribed}
      />
    );
  }
  return (
    <div className="space-y-4">
      {cricket.live ? <LiveBlock live={cricket.live} dict={dict} /> : null}
      {/* Contract notes (Task 14, 8b review gap) — `CricketViewT.toss` was
          emitted by the builder (Task 6) but rendered by nothing. One line
          under the live block, absent when the document carries no toss
          (a super over, or a document built before a toss was recorded). */}
      {cricket.toss ? (
        <p data-testid="mc-toss" className="text-sm text-ink-muted">
          {t(dict, cricket.toss.key, localiseParams(dict, cricket.toss.params))}
        </p>
      ) : null}
      <TopPerformers performers={cricket.topPerformers} innings={cricket.innings} dict={dict} />
      {cricket.innings.map((innings) => (
        <div key={innings.number} className="space-y-4">
          <FallOfWicketsRail innings={innings} dict={dict} />
          <PartnershipsBars innings={innings} dict={dict} />
        </div>
      ))}
    </div>
  );
}

function LiveBlock({ live, dict }: { live: LiveBlockT; dict: PublicDict }) {
  // Explicit widths — required now `StatTable`'s `<table>` is `table-fixed`;
  // the name column carries none, so it takes whatever's left over.
  const battingColumns: StatColumn<BattingRowT>[] = [
    { abbr: "R", titleKey: "matchCentre.col.runs", width: "w-7", cell: (r) => r.runs },
    { abbr: "B", titleKey: "matchCentre.col.balls", width: "w-7", cell: (r) => r.balls },
    { abbr: "4s", titleKey: "matchCentre.col.fours", width: "w-7", cell: (r) => r.fours ?? 0 },
    { abbr: "6s", titleKey: "matchCentre.col.sixes", width: "w-7", cell: (r) => r.sixes ?? 0 },
    { abbr: "SR", titleKey: "matchCentre.col.strikeRate", width: "w-11", cell: (r) => r.strikeRate ?? "—" },
  ];
  const bowlingColumns: StatColumn<BowlingRowT>[] = [
    { abbr: "O", titleKey: "matchCentre.col.overs", width: "w-8", cell: (r) => r.overs },
    { abbr: "M", titleKey: "matchCentre.col.maidens", width: "w-6", cell: (r) => r.maidens ?? 0 },
    { abbr: "R", titleKey: "matchCentre.col.runs", width: "w-7", cell: (r) => r.runs },
    { abbr: "W", titleKey: "matchCentre.col.wickets", width: "w-6", cell: (r) => r.wickets },
    { abbr: "Econ", titleKey: "matchCentre.col.economy", width: "w-11", cell: (r) => r.economy ?? "—" },
  ];
  return (
    <div
      data-testid="mc-live-block"
      className="space-y-3 rounded-2xl border border-zinc-200/80 bg-surface p-4 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.atTheCrease")}
      </p>
      {/* R11 fix round, C1 — above `md` these two tables used to render full
          width, one under the other: with only 5-6 numeric columns claiming
          their own `w-*`, the name column (which takes the remainder) ate the
          whole ~900px card, stretching a name-then-blank-space-then-numbers
          row a reader's eye had to travel edge to edge to read. Two-up at
          `md` — the SAME `md:grid-cols-2` the Scorecard tab's own innings
          panel and the top-performer cards already use (`scorecard-tab.tsx`
          Innings; `TopPerformers` below) — halves each table's width instead,
          which is what actually keeps the numbers beside the names; the
          control SET is unchanged (both tables still render, phone stacks
          them exactly as before via the default single column). */}
      <div className="grid gap-3 md:grid-cols-2">
        {live.batters.length > 0 ? (
          <StatTable<BattingRowT>
            dict={dict}
            captionKey="matchCentre.atTheCrease"
            nameTitleKey="matchCentre.col.batter"
            rows={live.batters}
            rowKey={(row) => row.person.personId}
            nameCell={(row) => row.person.name}
            // Compared against `live.striker`'s own id — the ONLY signal for
            // which row is on strike; nothing here re-derives it.
            rowAttrs={(row) => ({ "data-striker": String(row.person.personId === live.striker?.personId) })}
            columns={battingColumns}
          />
        ) : null}
        {live.bowling.length > 0 ? (
          <StatTable<BowlingRowT>
            dict={dict}
            captionKey="matchCentre.col.bowler"
            nameTitleKey="matchCentre.col.bowler"
            rows={live.bowling}
            rowKey={(row) => row.person.personId}
            nameCell={(row) => row.person.name}
            columns={bowlingColumns}
          />
        ) : null}
      </div>
      {live.thisOver.length > 0 ? (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {t(dict, "matchCentre.thisOver")}
          </p>
          <div data-testid="mc-this-over" className="flex flex-wrap gap-1.5">
            {live.thisOver.map((g, i) => (
              <Glyph key={i} g={g} />
            ))}
          </div>
        </div>
      ) : null}
      {live.partnership ? (
        // Plain string, not a `Msg` — the schema's own "no copy" convention
        // for numbers-and-names composites (same as `header.rateLine`).
        <p data-testid="mc-partnership-line" className="text-sm text-ink-muted">
          {t(dict, "matchCentre.partnership")}: {live.partnership}
        </p>
      ) : null}
      {live.lastWicket ? (
        <p data-testid="mc-last-wicket" className="text-sm text-ink-muted">
          {t(dict, "matchCentre.lastWicket")}: {t(dict, live.lastWicket.key, live.lastWicket.params)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * R11 fix round, C5 — which innings a performer belongs to is not a field on
 * `TopPerformerT` (`role`/`person`/`side`/`line`/`detail` only), so it is
 * identified the same way `ScorecardTab` identifies a bowler's fielding
 * side: by matching the performer's own `person.personId` against the rows
 * the document already carries in `innings[].batting`/`bowling` — never a
 * positional assumption ("performer 0/1 is innings 1"), which would silently
 * mislabel a document whose builder ever changed that order. `null` when no
 * innings carries a matching row (an empty/degenerate `innings[]`, which
 * some fixtures deliberately carry) — the caller renders that performer
 * without a label rather than guessing.
 */
function inningsNumberForPerformer(p: TopPerformerT, innings: readonly InningsT[]): number | null {
  const match = innings.find((inn) =>
    p.role === "batter"
      ? inn.batting.some((row) => row.person.personId === p.person.personId)
      : inn.bowling.some((row) => row.person.personId === p.person.personId),
  );
  return match?.number ?? null;
}

function TopPerformers({
  performers,
  innings,
  dict,
}: {
  performers: TopPerformerT[];
  innings: readonly InningsT[];
  dict: PublicDict;
}) {
  if (performers.length === 0) return null;
  // Four cards (batter, bowler, batter, bowler — one pair per innings) used
  // to render with nothing telling the two pairs apart beyond the small side
  // chip. Grouped by innings, in the order each group is first seen, so a
  // 2-innings match reads as two labelled pairs rather than four identical
  // cards; the existing two-up-at-md card grid is unchanged PER GROUP.
  const groups: { number: number | null; items: TopPerformerT[] }[] = [];
  for (const p of performers) {
    const number = inningsNumberForPerformer(p, innings);
    const group = groups.find((g) => g.number === number);
    if (group) group.items.push(p);
    else groups.push({ number, items: [p] });
  }
  return (
    <div data-testid="mc-top-performers" className="space-y-4">
      {groups.map((group, gi) => (
        <div key={group.number ?? `unlabelled-${gi}`}>
          {group.number !== null ? (
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {t(dict, "matchCentre.innings", { number: group.number })}
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {group.items.map((p, i) => (
              <PerformerCard key={i} p={p} dict={dict} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PerformerCard({ p, dict }: { p: TopPerformerT; dict: PublicDict }) {
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        {/* Review fix round 2 (minor) — the side's own short label, so
            "Top batter" names its TEAM, not just the person. `overflow-
            hidden` guards a `short` longer than the tile expects — the
            BUILDER is ruled to clamp `short` to 3 characters (note for
            Task 6, the view-model task; not enforced here, since this
            component never re-derives/truncates data the document
            already carries). */}
        <span
          data-testid="mc-performer-side"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft text-[9px] font-bold uppercase text-accent-strong"
        >
          {p.side.short}
        </span>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
          {t(dict, p.role === "batter" ? "matchCentre.topBatter" : "matchCentre.topBowler")}
        </p>
      </div>
      <p className="mt-1 min-w-0 truncate font-display text-base font-semibold text-ink">{p.person.name}</p>
      <p className="text-sm text-ink-muted">{p.line}</p>
      {/* Defect round 15b: the `/80` opacity on `text-ink-muted` measured
          3.45:1 on `bg-surface` (axe SERIOUS, walkthrough evidence) —
          short of WCAG AA's 4.5:1. `text-ink-muted` alone (no modifier,
          ≈4.6:1 on white per glyphs.tsx:12) clears the bar — no new
          colour, just drop the /80. */}
      {p.detail ? <p className="text-xs text-ink-muted">{p.detail}</p> : null}
    </div>
  );
}

function FallOfWicketsRail({ innings, dict }: { innings: InningsT; dict: PublicDict }) {
  if (innings.fallOfWickets.length === 0) return null;
  return (
    <div>
      {/* R11 fix round, C2 — a two-innings match rendered two identical
          "FALL OF WICKETS" headings with nothing telling them apart. The
          `{innings}` param reuses the SAME "Innings {number}" text the
          Scorecard accordion's own sub-line already renders
          (`scorecard-tab.tsx`'s `matchCentre.innings`, "Innings 1") — one
          resolved string nested inside the section heading, not a second
          label invented for this tab. */}
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.fallOfWicketsFor", {
          innings: t(dict, "matchCentre.innings", { number: innings.number }),
        })}
      </p>
      <div
        data-testid={`mc-fow-${innings.number}`}
        role="list"
        tabIndex={0}
        aria-label={t(dict, "matchCentre.fallOfWickets")}
        className="flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4"
      >
        {innings.fallOfWickets.map((fow, i) => (
          <span
            key={i}
            role="listitem"
            className="shrink-0 rounded-full border border-zinc-200 px-3 py-1 text-xs tabular-nums text-zinc-700"
          >
            {fow.wicket}-{fow.runs} · {fow.batter.name} · {fow.over}
          </span>
        ))}
      </div>
    </div>
  );
}

function PartnershipsBars({ innings, dict }: { innings: InningsT; dict: PublicDict }) {
  if (innings.partnerships.length === 0) return null;
  return (
    <div data-testid={`mc-partnerships-${innings.number}`}>
      {/* R11 fix round, C2 — same fix as the fall-of-wickets heading above:
          the innings label is nested via `{innings}`, reusing the
          `matchCentre.innings` key/params verbatim. */}
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.partnershipsFor", {
          innings: t(dict, "matchCentre.innings", { number: innings.number }),
        })}
      </p>
      <div className="space-y-2">
        {innings.partnerships.map((p, i) => {
          // Guarded — an innings with `total.runs === 0` (e.g. before a ball
          // is bowled) must render a `0%` bar, never `NaN%`.
          const pct = innings.total.runs > 0 ? Math.round((p.runs / innings.total.runs) * 100) : 0;
          return (
            <div key={i}>
              <div className="mb-1 flex items-center justify-between text-xs text-ink-muted">
                <span className="min-w-0 truncate">
                  {p.batters[0].name} &amp; {p.batters[1].name}
                </span>
                <span className="tabular-nums">{p.runs}</span>
              </div>
              <div className="h-2 rounded-full bg-zinc-100">
                <div className="h-2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
