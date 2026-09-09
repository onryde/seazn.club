// Spectator surface W2, Task 7 — the Matches hub's card, a W1 `CourtCard`
// (`match-centre/court-card.tsx`) variant: one DOM, `md` only widens. Every
// user-facing string that is not already resolved by the hub builder travels
// through `t()` — the document's own convention
// (`competition-hub-schema.ts`'s header comment: "every number in it is
// already FORMATTED and every name already RESOLVED before it is put here").
//
// Task 7 dispatch ruling 5 — `roundLabel` is null whenever the round has no
// role beyond its number (schema comment, `:86-89`), which is the COMMON
// case. Rendering `[stageName, roundLabel].filter(Boolean).join(" · ")`
// verbatim would silently drop the round on most fixtures and leave
// `matchesHub.round` ("Round {round}") — just translated into four
// languages — with no consumer at all. So: render `roundLabel` when present,
// and `t(dict, "matchesHub.round", { round: roundNo })` when it is null.
//
// W3's poster icon has no DOM in W2 (design ruling R4: no "coming soon").
import Link from "next/link";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { fmtDate, fmtTime } from "@/lib/format";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";

export interface MatchCardProps {
  match: HubMatchT;
  dict: PublicDict;
  locale: string;
  now: number;
  showDivision?: boolean;
  compact?: boolean;
}

export function MatchCard({ match: m, dict, locale, now, showDivision }: MatchCardProps) {
  const s0 = m.header.sides[0];
  const s1 = m.header.sides[1];

  // `Δ = scheduledAt - now`. Within 24h either side: a relative sentence
  // ("Starts in 2 hours"/"Starts in 40 minutes") via `Intl.RelativeTimeFormat`
  // in the ORG's locale. Beyond that: the venue-zone date + time. No
  // `scheduledAt` at all: Time TBD. `Math.round(Δ/3_600_000) ||
  // Math.round(Δ/60_000)` prefers the hour-rounded value unless it rounds to
  // exactly zero, in which case it falls back to minutes — so "starts in 40
  // minutes" doesn't print as "starts in 0 hours".
  function startsText(): string {
    if (!m.scheduledAt) return t(dict, "matchesHub.timeTbd");
    const delta = Date.parse(m.scheduledAt) - now;
    if (Math.abs(delta) < 24 * 3_600_000) {
      const when = new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(
        Math.round(delta / 3_600_000) || Math.round(delta / 60_000),
        Math.abs(delta) >= 3_600_000 ? "hour" : "minute",
      );
      return t(dict, "matchesHub.startsIn", { when });
    }
    return `${fmtDate(m.tz, m.scheduledAt, { weekday: "short", day: "numeric", month: "short" })} ${fmtTime(m.tz, m.scheduledAt)}`;
  }

  function sideRow(i: 0 | 1) {
    const side = m.header.sides[i];
    const isWinner = m.winnerIndex === i;
    return (
      <div
        key={side.entrantId || i}
        data-testid={`mh-match-side-${i}`}
        data-winner={isWinner ? "true" : undefined}
        className={`flex items-center gap-2 ${isWinner || m.header.battingIndex === i ? "font-semibold text-ink" : "text-ink"}`}
      >
        <EntityLogo src={side.badgeUrl} name={side.name} size={24} />
        {/* `min-w-0` is what lets `truncate` engage on a flex item — see
            AGENTS.md, "`truncate` needs `min-w-0` on the whole ancestor
            chain". */}
        <span className="min-w-0 flex-1 truncate text-[15px]" title={side.name}>
          {side.name}
        </span>
        <span className="shrink-0 font-display text-lg tabular-nums">
          {m.header.scoreLines[i] ?? ""}
          <span className="ml-1 text-xs text-ink-muted">{m.header.subLines[i] ?? ""}</span>
        </span>
      </div>
    );
  }

  return (
    <Link
      href={m.href}
      data-testid={`mh-match-${m.fixtureId}`}
      aria-label={t(dict, "matchesHub.card.label", { home: s0.name, away: s1.name })}
      className="block rounded-xl border border-zinc-200/80 bg-surface p-3 shadow-sm transition hover:border-accent-line"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-muted">
        {showDivision ? (
          <span data-testid="mh-match-division" className="rounded-full bg-accent-soft px-2 py-0.5 text-accent-strong">
            {m.divisionName}
          </span>
        ) : null}
        <span className="min-w-0 truncate">
          {[m.stageName, m.roundLabel ?? t(dict, "matchesHub.round", { round: m.roundNo })]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="ml-auto shrink-0">
          {m.bucket === "live" ? (
            <span data-testid="mh-match-live" className="flex items-center gap-1 font-bold text-emerald-600">
              <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t(dict, "matchesHub.live")}
            </span>
          ) : m.bucket === "completed" ? (
            t(dict, "matchesHub.ended")
          ) : m.scheduledAt ? (
            fmtTime(m.tz, m.scheduledAt)
          ) : (
            t(dict, "matchesHub.timeTbd")
          )}
        </span>
      </div>
      <div className="mt-2 space-y-1">{[0, 1].map((i) => sideRow(i as 0 | 1))}</div>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-xs text-ink-muted">
        <span className="min-w-0 truncate">{[m.venueName, m.courtName].filter(Boolean).join(" · ")}</span>
        {m.resultLine ? (
          <span data-testid="mh-match-result" className="shrink-0 font-medium text-ink">
            {m.resultLine}
          </span>
        ) : m.bucket === "upcoming" ? (
          <span data-testid="mh-match-starts" className="shrink-0">
            {startsText()}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
