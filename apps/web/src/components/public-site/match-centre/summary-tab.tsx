// Spectator surface W1, Task 11 — the Summary tab: cricket's live block, top
// performers, fall of wickets and partnerships, all read STRAIGHT off
// `doc.cricket` (names, lines and detail strings are already resolved —
// consent-masked names included — so this component never re-derives a
// number or a name, only lays out what the document already carries). For
// every other sport (`doc.cricket === null`) the tab is just Task 10's
// `LiveScoreBody`, unchanged.
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { CricketViewT, MatchCentreDocT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { LiveScoreBody } from "../live-score";
import { StatTable, type StatColumn } from "./stat-table";
import { Glyph } from "./glyphs";

export interface SummaryTabProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  data: LiveFixtureData;
}

type LiveBlockT = NonNullable<CricketViewT["live"]>;
type BattingRowT = LiveBlockT["batters"][number];
type BowlingRowT = LiveBlockT["bowling"][number];
type InningsT = CricketViewT["innings"][number];
type TopPerformerT = CricketViewT["topPerformers"][number];

/**
 * `LiveScoreBody` (Task 10) requires a `decidedTemplates` prop it uses to
 * render its OWN "X won by Y" sentence — but that sentence's real templates
 * (`fixture.decidedBy.*`) live in the "ui" dictionary namespace, not
 * "public", and `SummaryTab` is only ever given a "public" `dict`. Rather
 * than reach across namespaces (a new coupling this task does not need) or
 * leak a raw, unresolvable key onto the page, this passes all-empty
 * templates: `renderDecidedOutcome`'s `interpolate("", …)` always resolves
 * to `""`, which `LiveScoreBody`'s `{decidedLine ? <p>…</p> : null}` treats
 * as falsy and renders nothing for. This is deliberate, not an oversight —
 * the match-centre document's own `header.statusLine` (rendered by
 * `CourtCard`, above every tab) already carries this exact sentence,
 * correctly localised, so `LiveScoreBody`'s copy of it would only ever be
 * redundant here.
 */
const EMPTY_DECIDED_TEMPLATES: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

export function SummaryTab({ doc, dict, data }: SummaryTabProps) {
  const cricket = doc.cricket;
  if (!cricket) {
    // Reshaping the document's OWN two sides into the `Record<id,name>` shape
    // `LiveScoreBody` expects — not a re-derivation, since `header.sides[].name`
    // is already the consent-resolved display name the document carries.
    const [home, away] = doc.header.sides;
    const entrantNames: Record<string, string> = { [home.entrantId]: home.name, [away.entrantId]: away.name };
    return (
      <LiveScoreBody
        data={data}
        entrantNames={entrantNames}
        sportKey={doc.sportKey}
        decidedTemplates={EMPTY_DECIDED_TEMPLATES}
        dict={dict}
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
  const battingColumns: StatColumn<BattingRowT>[] = [
    { abbr: "R", titleKey: "matchCentre.col.runs", cell: (r) => r.runs },
    { abbr: "B", titleKey: "matchCentre.col.balls", cell: (r) => r.balls },
    { abbr: "4s", titleKey: "matchCentre.col.fours", cell: (r) => r.fours ?? 0 },
    { abbr: "6s", titleKey: "matchCentre.col.sixes", cell: (r) => r.sixes ?? 0 },
    { abbr: "SR", titleKey: "matchCentre.col.strikeRate", cell: (r) => r.strikeRate ?? "—" },
  ];
  const bowlingColumns: StatColumn<BowlingRowT>[] = [
    { abbr: "O", titleKey: "matchCentre.col.overs", cell: (r) => r.overs },
    { abbr: "M", titleKey: "matchCentre.col.maidens", cell: (r) => r.maidens ?? 0 },
    { abbr: "R", titleKey: "matchCentre.col.runs", cell: (r) => r.runs },
    { abbr: "W", titleKey: "matchCentre.col.wickets", cell: (r) => r.wickets },
    { abbr: "Econ", titleKey: "matchCentre.col.economy", cell: (r) => r.economy ?? "—" },
  ];
  return (
    <div
      data-testid="mc-live-block"
      className="space-y-3 rounded-2xl border border-zinc-200/80 bg-surface p-4 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.atTheCrease")}
      </p>
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
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {t(dict, p.role === "batter" ? "matchCentre.topBatter" : "matchCentre.topBowler")}
          </p>
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
