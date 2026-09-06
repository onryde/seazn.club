"use client";
// `LiveScoreBody` — the score-strip/set-scoreboard/period/discipline
// rendering for the public match page (doc 09 §2), pure and hookless.
//
// Task 10 (spectator surface W1) lifted the transport (poll/realtime/
// debounce, doc 09 §4's Pro-realtime/community-poll split) out into
// `useLiveFixture` (`./match-centre/use-live-fixture.ts`), shared by the new
// `MatchCentre` root; Task 14 retired this file's own `LiveScore` wrapper
// (the transport + this body, composed for the legacy fixture page) once the
// fixture detail page switched to rendering `<MatchCentre>` directly —
// `MatchCentre` calls `useLiveFixture` itself and falls back to
// `LiveScoreBody` only for a missing/empty document (`match-centre.tsx`) or
// a non-cricket/pre-play `SummaryTab` (`summary-tab.tsx`). Both of those
// call sites import `LiveScoreBody` directly; nothing imports `LiveScore`
// any more.
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/public.json";
import {
  disciplineLabel,
  disciplineList,
  matchStrength,
  periodBreakdown,
  servingSide,
  setBreakdown,
  stripLiveSetPoints,
} from "@/lib/public-site";
import { type LiveFixtureData } from "./live-score-data";
import {
  renderDecidedOutcome,
  shootoutScoreFromDetail,
  type DecidedOutcomeTemplates,
} from "@/lib/scoring-vocab";

export type { LiveFixtureData };

interface LiveScoreBodyProps {
  data: LiveFixtureData;
  entrantNames: Record<string, string>;
  sportKey: string;
  decidedTemplates: DecidedOutcomeTemplates;
  /**
   * Task 11 review fix round 1 — now actually consumed (status text,
   * "Winner:"). Optional so a caller with no dictionary in hand (R3.5/Task
   * O's whole reason `decidedTemplates` is pre-resolved server-side instead)
   * keeps working unchanged: an absent `dict` falls back to the English
   * `public.json` import below, which is byte-for-byte what these strings
   * already were.
   */
  dict?: Dict;
  /**
   * Whether the live transport is currently receiving realtime pushes —
   * not in the dispatch's own literal prop list, added because dropping the
   * pre-existing "· realtime" indicator text below would itself have been a
   * (forbidden) behaviour change. Defaults to `false` so `LiveScoreBody` can
   * be mounted directly (e.g. from a future match-centre panel) without a
   * transport in hand.
   */
  subscribed?: boolean;
}

// Task 11 review round 2 (NEW IMPORTANT B) — the DB's `fixtures.status`
// vocabulary (apps/web/src/server/usecases/stages.ts:2142-2156) carries
// several values beyond in_play/decided/finalized/scheduled: abandoned,
// cancelled, forfeited, postponed, walkover. Round 1's fallback collapsed
// every one of these into the generic `matchCentre.status.other` ("Not
// played") on the legacy fixture page — each now gets its OWN word instead.
// Anything STILL unrecognised falls back to the RAW status word, never a
// dictionary lookup at all: `matchCentre.status.other` is reserved for
// `CourtCard`'s own "no chip" bucket (a status-ENUM concept,
// `MatchCentreHeaderT["status"]`'s `"other"` literal), not this
// loosely-typed `string` field's catch-all.
const OTHER_STATUS_KEY: Record<string, string> = {
  abandoned: "matchCentre.status.abandoned",
  cancelled: "matchCentre.status.cancelled",
  forfeited: "matchCentre.status.forfeited",
  postponed: "matchCentre.status.postponed",
  walkover: "matchCentre.status.walkover",
};

function statusText(dict: Dict, status: string, inPlay: boolean, decided: boolean): string {
  if (inPlay) return t(dict, "matchCentre.status.live");
  if (decided) return t(dict, "matchCentre.status.decided");
  if (status === "scheduled") return t(dict, "matchCentre.status.scheduled");
  const key = OTHER_STATUS_KEY[status];
  return key ? t(dict, key) : status;
}

export function LiveScoreBody({
  data,
  entrantNames,
  sportKey,
  decidedTemplates,
  dict,
  subscribed = false,
}: LiveScoreBodyProps) {
  const activeDict = dict ?? (en as Dict);
  const inPlay = data.status === "in_play";
  const decided = data.status === "decided" || data.status === "finalized";
  const statusWord = statusText(activeDict, data.status, inPlay, decided);
  const breakdown = setBreakdown(data.summary, sportKey);
  // Kernel perSide order is [home, away]; row labels come from it.
  const sideIds = data.summary?.perSide?.map((s) => s.entrantId) ?? [];
  const showBreakdown = breakdown !== null && sideIds.length === 2;
  // Period-kernel surfaces (v6/00 §5): power-play strength while live,
  // goals-by-period once periods exist, the discipline list, tennis serve dot.
  const strength = inPlay ? matchStrength(data.summary) : null;
  const periods = periodBreakdown(data.summary);
  const discipline = disciplineList(data.summary);
  const serving = inPlay ? servingSide(data.summary) : null;
  // R3.5/Task O — recomputed from `data` on every render, so a live poll or
  // realtime push that lands a decided `outcome` updates this sentence the
  // same tick it updates the score above, with no reload. Previously this
  // sentence was rendered ONCE, server-side, by the page component itself
  // (R3.5/Task G) — correct at first paint but frozen after that, since a
  // Server Component cannot react to a client-side data change.
  const shootoutScore = shootoutScoreFromDetail(data.summary?.detail);
  const decidedLine = renderDecidedOutcome(data.outcome, entrantNames, decidedTemplates, shootoutScore);
  return (
    <div className="space-y-4">
      {decidedLine ? <p className="text-base font-semibold text-ink">{decidedLine}</p> : null}
      {/* Court-slab scorebug — the broadcast moment of the page. */}
      <div className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg">
        <div className="p-5 sm:p-6">
          {inPlay ? (
            <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300">
              <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
              {statusWord}{subscribed ? " · realtime" : ""}
              {strength ? (
                <span className="rounded-full bg-amber-400/20 px-2 py-0.5 font-mono text-[11px] font-bold tracking-normal text-amber-300">
                  {strength}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted">
              {statusWord}
            </p>
          )}
          {/* Task 11 fix round 3 — PRODUCT OWNER RULING: this headline
              fallback keeps its existing copy verbatim ("Not started"),
              on its OWN key (`matchCentre.status.notStarted`), never
              `matchCentre.status.scheduled` ("Scheduled") — round 2 briefly
              routed it through the chip's word instead, which silently
              changed what `apps/web/e2e/scorepad-v3-football.spec.ts`
              (a live, non-skipped Playwright spec) asserts a spectator
              sees on the legacy public fixture page. The status PILL/chip
              above and this HEADLINE are two different pieces of copy that
              happen to describe the same moment; they keep two different
              keys on purpose now. */}
          <p className="font-display text-5xl font-bold tabular-nums leading-none tracking-tight sm:text-6xl">
            {data.summary?.headline
              ? showBreakdown
                ? stripLiveSetPoints(data.summary.headline)
                : data.summary.headline
              : t(activeDict, "matchCentre.status.notStarted")}
          </p>
          {!showBreakdown && data.summary?.perSide ? (
            <ul className="mt-5 space-y-2">
              {data.summary.perSide.map((side, row) => {
                const isWinner = data.outcome?.winner === side.entrantId;
                const hasServe = serving !== null && (row === 0 ? "home" : "away") === serving;
                return (
                  <li
                    key={side.entrantId}
                    className={`flex items-baseline justify-between gap-3 tabular-nums ${
                      data.outcome?.winner && !isWinner ? "opacity-60" : ""
                    }`}
                  >
                    <span className="truncate font-display text-xl font-semibold uppercase tracking-wide sm:text-2xl">
                      {hasServe ? (
                        <span aria-label="serving" className="mr-1.5 text-amber-300">●</span>
                      ) : null}
                      {entrantNames[side.entrantId] ?? "—"}
                    </span>
                    <span className="shrink-0 font-display text-xl font-bold sm:text-2xl">
                      {side.line}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {data.outcome?.winner ? (
            <p className="mt-4 flex items-center gap-1.5 text-sm text-court-muted">
              <span className="animate-trophy">🏆</span>
              {t(activeDict, "matchCentre.winner")}{" "}
              <strong className="text-amber-300">
                {entrantNames[data.outcome.winner] ?? data.outcome.winner}
              </strong>
            </p>
          ) : null}
        </div>
        <div aria-hidden className={`h-1 ${inPlay ? "bg-emerald-400" : "bg-accent"}`} />
      </div>

      {showBreakdown ? (
        <SetScoreboard
          breakdown={breakdown}
          dict={activeDict}
          names={sideIds.map((id, row) => {
            const name = entrantNames[id] ?? "—";
            const hasServe = serving !== null && (row === 0 ? "home" : "away") === serving;
            return hasServe ? `● ${name}` : name;
          })}
        />
      ) : null}

      {periods && sideIds.length === 2 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
          <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {t(activeDict, "matchCentre.goalsByPeriod")}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 tabular-nums">
              <thead>
                <tr>
                  <th className="w-full" />
                  {periods.map((p) => (
                    <th
                      key={p.phase}
                      className="min-w-14 px-3 pb-2 text-center text-xs font-medium uppercase tracking-wide text-zinc-400"
                    >
                      {p.phase}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["home", "away"] as const).map((side, row) => (
                  <tr key={side}>
                    <td
                      className={`max-w-40 truncate pr-4 text-sm font-medium text-zinc-800 ${row === 0 ? "border-b border-zinc-100" : ""} py-2`}
                    >
                      {entrantNames[sideIds[row]!] ?? "—"}
                    </td>
                    {periods.map((p) => (
                      <td
                        key={p.phase}
                        className={`px-3 py-2 text-center font-display text-xl font-medium text-zinc-700 ${row === 0 ? "border-b border-zinc-100" : ""}`}
                      >
                        {p[side]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {discipline && sideIds.length === 2 ? (
        <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
          <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {t(activeDict, "matchCentre.discipline")}
          </p>
          <ul className="space-y-1.5">
            {discipline.map((entry, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-zinc-700">
                <span
                  aria-hidden
                  className={`h-3 w-2 rounded-[2px] ${
                    entry.classKey === "red" || entry.classKey === "match"
                      ? "bg-red-500"
                      : entry.classKey === "green"
                        ? "bg-emerald-500"
                        : "bg-amber-400"
                  }`}
                />
                <span className="font-medium">{disciplineLabel(entry.classKey)}</span>
                <span className="text-zinc-500">
                  — {entrantNames[sideIds[entry.side === "home" ? 0 : 1]!] ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Per-set scoreboard card: one column per played set, live set tinted.
 *  Task 14c — `dict` added so the heading and per-column labels resolve
 *  through `matchCentre.scoreByUnit`/`matchCentre.unit.<unit>`/
 *  `matchCentre.col.<unit>` instead of rendering `breakdown.unit`'s raw
 *  English word straight through. */
function SetScoreboard({
  breakdown,
  names,
  dict,
}: {
  breakdown: NonNullable<ReturnType<typeof setBreakdown>>;
  names: string[];
  dict: Dict;
}) {
  const sides = ["home", "away"] as const;
  return (
    <div className="rounded-2xl border border-zinc-200/80 bg-surface p-5 shadow-sm">
      <p className="mb-3 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "matchCentre.scoreByUnit", { unit: t(dict, `matchCentre.unit.${breakdown.unit}`) })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 tabular-nums">
          <thead>
            <tr>
              <th className="w-full" />
              {breakdown.sets.map((s, i) => (
                <th
                  key={i}
                  className={`min-w-14 rounded-t-lg px-3 pb-2 text-center text-xs font-medium uppercase tracking-wide ${
                    s.closed ? "text-zinc-400" : "bg-emerald-50 text-emerald-700"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {!s.closed && (
                      <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    )}
                    {t(dict, `matchCentre.col.${breakdown.unit}`, { n: i + 1 })}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sides.map((side, row) => (
              <tr key={side}>
                <td
                  className={`max-w-40 truncate pr-4 text-sm font-medium text-zinc-800 ${
                    row === 0 ? "border-b border-zinc-100" : ""
                  } py-2`}
                >
                  {names[row]}
                </td>
                {breakdown.sets.map((s, i) => {
                  const mine = s[side];
                  const theirs = s[side === "home" ? "away" : "home"];
                  const wonSet = s.closed && mine > theirs;
                  const liveCell = !s.closed;
                  return (
                    <td
                      key={i}
                      className={`px-3 py-2 text-center font-display text-2xl ${
                        row === 0 ? "border-b border-zinc-100" : ""
                      } ${row === 1 && liveCell ? "rounded-b-lg" : ""} ${
                        liveCell
                          ? "bg-emerald-50 font-bold text-emerald-700"
                          : wonSet
                            ? "font-bold text-ink"
                            : "font-medium text-zinc-400"
                      }`}
                    >
                      {mine}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
