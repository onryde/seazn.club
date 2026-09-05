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
      <TopPerformers performers={cricket.topPerformers} dict={dict} />
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

function TopPerformers({ performers, dict }: { performers: TopPerformerT[]; dict: PublicDict }) {
  if (performers.length === 0) return null;
  return (
    <div data-testid="mc-top-performers" className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {performers.map((p, i) => (
        <div key={i} className="rounded-2xl border border-zinc-200/80 bg-surface p-4 shadow-sm">
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
          {p.detail ? <p className="text-xs text-ink-muted/80">{p.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}

function FallOfWicketsRail({ innings, dict }: { innings: InningsT; dict: PublicDict }) {
  if (innings.fallOfWickets.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.fallOfWickets")}
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
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.partnerships")}
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
