"use client";
// Spectator surface W2, Task 14 — the public player page's Matches section
// (owner-approved option C): the newest line as a court slab, every older line
// as a schedule-grammar row, all of it updating in place while the page is
// open (R10) through `useLivePlayerMatches`.
//
// WHICH LINE IS THE SLAB. A live line if there is one — a spectator opening a
// player's page mid-match came for that match — else the newest. "Newest" is
// the READER's order (`readPlayerMatchLines`: scheduled_at desc, nulls last):
// this component never re-sorts, so the page and the endpoint cannot disagree
// about which match leads.
//
// Every subpart is a plain function called inline rather than a component
// element. That is not style: vitest here has no DOM, and the island harness
// renders ONE component one level deep, so a `<Row/>` element would hide every
// word inside it from the test that proves a poll changed the figures.
//
// No middle-dot or dash-joined meta (§3 copy rules): the result, the division
// and the figures are separate elements. Figures arrive pre-formatted in the
// org's locale and are rendered as they are — splitting "54 (40) & 3/21" into
// batting and bowling would mean re-parsing a localised template.
import Link from "next/link";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { PlayerMatchLineT, PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";
import { useNow } from "./match-centre/use-now";
import { useLivePlayerMatches } from "./use-live-player-matches";

export interface PlayerMatchesProps {
  orgSlug: string;
  competitionSlug: string;
  personId: string;
  initial: PublicPlayerMatchesT;
  /** `playerMatchesDict(...)` — never the whole public dictionary. */
  dict: Dict;
  /** The ORG's locale, the page's own (ISR: never the viewer's). */
  locale: Locale;
}

/** The punctuation the reader emits for "no figures". Identical in every locale. */
const NO_FIGURES = "—";

/** Clock tick for the freshness line. It only shows while a line is live, so
 *  an idle page re-renders twice a minute rather than every second. */
const NOW_TICK_LIVE_MS = 1_000;
const NOW_TICK_IDLE_MS = 30_000;

/** `Intl` in the org's locale and the VENUE's zone — never the runtime's.
 *  An unknown zone falls back to UTC rather than throwing into a render
 *  (`lib/format.ts`'s rule; that module is fixed to en-GB, this page is not). */
function formatIn(locale: Locale, tz: string, iso: string | null, opts: Intl.DateTimeFormatOptions): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(ms);
  } catch {
    return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts }).format(ms);
  }
}

/** The line that leads: the newest live one, else the newest. */
export function slabIndex(lines: readonly PlayerMatchLineT[]): number {
  const live = lines.findIndex((l) => l.result === "live");
  return live === -1 ? 0 : live;
}

type Settled = Exclude<PlayerMatchLineT["result"], "live" | null>;

function resultChip(result: Settled, dict: Dict) {
  return (
    <span
      data-testid={`mh-player-result-${result}`}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        result === "won" ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-600"
      }`}
    >
      {t(dict, `player.result.${result}`)}
    </span>
  );
}

function slab(line: PlayerMatchLineT, dict: Dict, locale: Locale, now: number, generatedAt: string) {
  const live = line.result === "live";
  const date = formatIn(locale, line.tz, line.scheduledAt, { weekday: "short", day: "numeric", month: "short" });
  const built = Date.parse(generatedAt);
  const seconds = Number.isFinite(built) ? Math.max(0, Math.floor((now - built) / 1000)) : 0;
  return (
    <Link
      href={line.href}
      data-testid={`mh-player-match-${line.fixtureId}`}
      data-slab="true"
      className="block min-h-11 min-w-0 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
    >
      <div className="min-w-0 p-4 sm:p-5">
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          {live ? (
            // The court card's live pill, byte for byte (`court-card.tsx`).
            <span
              data-testid="mh-player-slab-live"
              className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300"
            >
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-live-pulse" />
              {t(dict, "player.result.live")}
            </span>
          ) : line.result !== null ? (
            <span
              data-testid={`mh-player-slab-result-${line.result}`}
              className={`text-[11px] font-semibold uppercase tracking-[0.22em] ${
                line.result === "won" ? "text-emerald-300" : "text-court-muted"
              }`}
            >
              {t(dict, `player.result.${line.result}`)}
            </span>
          ) : (
            <span />
          )}
          {date !== null ? <span className="shrink-0 text-xs text-court-muted">{date}</span> : null}
        </div>
        <p className="truncate font-display text-xl font-semibold uppercase tracking-wide">
          {t(dict, "player.opponent", { opponent: line.opponentName })}
        </p>
        <p
          data-testid="mh-player-slab-figures"
          className={`mt-1 break-words font-display text-4xl font-bold leading-none tabular-nums md:text-5xl ${
            line.line === NO_FIGURES ? "text-court-muted" : ""
          }`}
        >
          {line.line}
        </p>
        {live ? (
          <p
            data-testid="mh-player-updated-at"
            // `text-court-muted` without the `/70` the brief named: the court
            // card measured that stack at 4.09:1 on `bg-court` (axe SERIOUS,
            // `court-card.tsx` defect round 15b) and dropped it.
            className="mt-3 text-[11px] text-court-muted"
            suppressHydrationWarning
          >
            {t(dict, "matchCentre.updatedAgo", { seconds })}
          </p>
        ) : null}
      </div>
      <div aria-hidden className={`h-1 ${live ? "bg-emerald-400" : "bg-accent"}`} />
    </Link>
  );
}

function row(line: PlayerMatchLineT, dict: Dict, locale: Locale, showDivision: boolean) {
  const live = line.result === "live";
  const day = formatIn(locale, line.tz, line.scheduledAt, { day: "numeric" });
  const month = formatIn(locale, line.tz, line.scheduledAt, { month: "short" });
  return (
    <li key={line.fixtureId} className="min-w-0 first:rounded-t-xl last:rounded-b-xl">
      <Link
        href={line.href}
        data-testid={`mh-player-match-${line.fixtureId}`}
        className="relative grid min-h-11 min-w-0 grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[inherit] px-3.5 py-2.5 transition-colors hover:bg-accent-soft/60"
      >
        {live ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" /> : null}
        <span className="flex min-w-0 flex-col items-start">
          {day !== null ? (
            <>
              <span className="font-display text-[18px] font-semibold leading-tight tabular-nums text-ink">{day}</span>
              <span className="text-xs text-ink-muted">{month}</span>
            </>
          ) : (
            <span className="font-display text-[18px] font-semibold leading-tight text-ink-muted">{NO_FIGURES}</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-display text-[17px] font-semibold uppercase tracking-wide text-ink">
            {t(dict, "player.opponent", { opponent: line.opponentName })}
          </span>
          {live || line.result !== null || showDivision ? (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              {live ? (
                <span
                  data-testid="mh-player-row-live"
                  className="flex shrink-0 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-600"
                >
                  <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  {t(dict, "player.result.live")}
                </span>
              ) : line.result !== null && line.result !== "live" ? (
                resultChip(line.result, dict)
              ) : null}
              {showDivision ? (
                <span
                  data-testid="mh-player-division-chip"
                  className="min-w-0 max-w-full truncate rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-strong"
                >
                  {line.divisionName}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span
          className={`max-w-[10rem] text-right font-display text-lg font-bold tabular-nums ${
            line.line === NO_FIGURES ? "text-ink-muted" : live ? "text-emerald-600" : "text-ink"
          }`}
        >
          {line.line}
        </span>
      </Link>
    </li>
  );
}

export function PlayerMatches({ orgSlug, competitionSlug, personId, initial, dict, locale }: PlayerMatchesProps) {
  const doc = useLivePlayerMatches({ orgSlug, competitionSlug, personId, initial });
  const lines = doc.matches;
  const hasLive = lines.some((l) => l.result === "live");
  const now = useNow(hasLive ? NOW_TICK_LIVE_MS : NOW_TICK_IDLE_MS);

  // R9: the empty case first.
  if (lines.length === 0) {
    return (
      <p
        data-testid="mh-player-matches-empty"
        className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted"
      >
        {t(dict, "player.matches.empty")}
      </p>
    );
  }

  const lead = slabIndex(lines);
  const rest = lines.filter((_, i) => i !== lead);
  // A division chip only earns its place when there is more than one division
  // to tell apart — on a one-division player it restates the page.
  const showDivision = new Set(lines.map((l) => l.divisionSlug)).size > 1;

  return (
    <div className="min-w-0 space-y-3">
      {slab(lines[lead]!, dict, locale, now, doc.generatedAt)}
      {rest.length > 0 ? (
        <ul className="min-w-0 divide-y divide-zinc-100 rounded-xl border border-zinc-200/80 bg-surface">
          {rest.map((l) => row(l, dict, locale, showDivision))}
        </ul>
      ) : null}
    </div>
  );
}
