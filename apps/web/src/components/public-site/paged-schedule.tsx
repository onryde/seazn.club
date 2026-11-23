"use client";
// W5 follow-ups C (owner 2026-11-23, "Ok" on mock 2026-11-23_w5-schedule-paging-options: Option A, "by round"). A BIG division's
// Schedule tab (`pagesByRound`): finished rounds collapse into one line, the live round and the next round are open, every other
// round is a header whose rows load when it is tapped (`rounds/route.ts`, the same grouping and words as the page). A team search
// returns that team's matches across ALL rounds, and the chips narrow to live, upcoming or finished matches. The rows are the
// small schedule's own (`ScorebugRow`); the mock is layout only, the house theme paints it.
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, ChevronRight, Search, X } from "lucide-react";
import type { PublicFixture } from "@/server/public-site/data";
import { fmtPublicZoneAbbrev } from "@/lib/format";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { unpackRows } from "@/lib/packed-rows";
import { fixtureBucket, type RoundBucket } from "@/lib/round-paging";
import {
  pagedCount,
  type PagedScheduleCopy,
  type PagedScheduleData,
  type PagedScheduleGroup,
  type ScheduleRoundsAnswer,
  type ScheduleRowExtras,
} from "@/lib/schedule-paging";
import { ScorebugRow, type ScheduleCopy, type ScheduleWatchCopy } from "./schedule";

export type PagedChip = "all" | RoundBucket;
const CHIPS: readonly PagedChip[] = ["all", "live", "upcoming", "result"];
/** A chip's word in the copy: the bucket is "result", the word is "Results". */
const copyKey = <C extends PagedChip>(c: C) => (c === "result" ? "results" : c) as C extends "result" ? "results" : C;

export interface PagedScheduleProps {
  data: PagedScheduleData;
  entrantNames: Record<string, string>;
  divisionPath: string;
  tz: string;
  copy: ScheduleCopy;
  pagedCopy: PagedScheduleCopy;
  locale: string;
  /** An online chess division's watch words; the links themselves ride each row's extras. */
  watchCopy?: ScheduleWatchCopy;
}

/** A folded round's last read: for which document (`from`), its rows, or that it failed (the rows before it kept). "Loading" is not
 *  stored: it is an open folded round with no rows yet. */
type Load = { from: PagedScheduleData; rows?: PublicFixture[]; failed?: true };

/** Row extras read later layered over what is here (a later read's word for a row wins). */
function mergeRowExtras(prev: ScheduleRowExtras, more: ScheduleRowExtras): ScheduleRowExtras {
  return {
    slotLabels: { ...prev.slotLabels, ...more.slotLabels },
    forfeit: { ...prev.forfeit, ...more.forfeit },
    ...(prev.watchLinks || more.watchLinks ? { watchLinks: { ...prev.watchLinks, ...more.watchLinks } } : {}),
    ...(prev.roundOpenedAt || more.roundOpenedAt ? { roundOpenedAt: { ...prev.roundOpenedAt, ...more.roundOpenedAt } } : {}),
  };
}

/** Where a folded round's rows, or a team's, are asked for: beside the division page, the same cached document. */
export function roundsUrl(divisionPath: string, q: { round: string } | { entrant: string }): string {
  return "round" in q
    ? `${divisionPath}/rounds?round=${encodeURIComponent(q.round)}`
    : `${divisionPath}/rounds?entrant=${encodeURIComponent(q.entrant)}`;
}

/** The count a round header says under a chip: every match under All, else that chip's own. */
export function chipCount(g: Pick<PagedScheduleGroup, "total" | RoundBucket>, chip: PagedChip): number {
  return chip === "all" ? g.total : g[chip];
}

/** The rounds a chip lists, in the order it lists them: every round under All; a chip lists only the rounds holding one of its
 *  matches, Results most recent first. */
export function roundsForChip(groups: readonly PagedScheduleGroup[], chip: PagedChip): PagedScheduleGroup[] {
  if (chip === "all") return [...groups];
  const holding = groups.filter((g) => g[chip] > 0);
  return chip === "result" ? holding.reverse() : holding;
}

/** Team-search suggestions: entrants whose name contains the query, ignoring case and accents, at most `limit`. */
export function teamSuggestions(entrantNames: Record<string, string>, query: string, limit = 8): { id: string; name: string }[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
  const q = fold(query.trim());
  if (q === "") return [];
  return Object.entries(entrantNames)
    .filter(([, name]) => fold(name).includes(q))
    .sort(([, a], [, b]) => a.localeCompare(b))
    .slice(0, limit)
    .map(([id, name]) => ({ id, name }));
}

async function fetchRounds(url: string): Promise<ScheduleRoundsAnswer> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`rounds ${res.status}`);
  // The v1 envelope (`{ ok, data }`, `server/api-v1/http.ts`).
  return ((await res.json()) as { data: ScheduleRoundsAnswer }).data;
}

export function PagedSchedule({ data, entrantNames, divisionPath, tz, copy, pagedCopy, locale, watchCopy }: PagedScheduleProps) {
  const dateTag = intlLocaleFor(locale);
  // The open rounds' rows, unpacked once.
  const initial = useMemo(() => {
    const m = new Map<string, PublicFixture[]>();
    for (const g of data.groups) if (g.rows) m.set(g.key, unpackRows(g.rows));
    return m;
  }, [data]);
  const [chip, setChip] = useState<PagedChip>("all");
  const [finishedShown, setFinishedShown] = useState(false);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [loads, setLoads] = useState<ReadonlyMap<string, Load>>(() => new Map());
  const [extras, setExtras] = useState<ScheduleRowExtras>(data.extras);
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState<{ id: string; name: string } | null>(null);
  const [teamLoad, setTeamLoad] = useState<{ state: "loading" } | { state: "error" } | { state: "ready"; rounds: { key: string; rows: PublicFixture[] }[] } | null>(null);
  // A new document (the page re-rendered: a poll, `router.refresh()`) brings its own extras. Review I1: what was read under the old
  // one is stale, and every OPEN folded round is read again (the effect below) - its old rows stay drawn until the new answer lands,
  // never a "Loading" line nothing will ever replace.
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    setExtras(data.extras);
  }

  const isOpen = (g: PagedScheduleGroup) => toggled.get(g.key) ?? g.open;
  // The folded rounds to read: open, nothing shipped for them, and no read under THIS document yet.
  const wanted = data.groups.filter((g) => isOpen(g) && !initial.has(g.key) && loads.get(g.key)?.from !== data).map((g) => g.key);
  const wantedKey = JSON.stringify(wanted);
  // Reads already out, by round key, with the document they were asked under: one still on its way is not asked twice.
  const reads = useRef(new Map<string, PagedScheduleData>());
  useEffect(() => {
    const from = data;
    for (const key of JSON.parse(wantedKey) as string[]) {
      if (reads.current.get(key) === from) continue;
      reads.current.set(key, from);
      fetchRounds(roundsUrl(divisionPath, { round: key }))
        .then((answer) => {
          if (answer.kind !== "round") throw new Error("rounds: not a round");
          setExtras((prev) => mergeRowExtras(prev, answer.extras));
          setLoads((prev) => new Map(prev).set(key, { from, rows: answer.rows }));
        })
        .catch(() => setLoads((prev) => new Map(prev).set(key, { from, rows: prev.get(key)?.rows, failed: true })))
        .finally(() => {
          if (reads.current.get(key) === from) reads.current.delete(key);
        });
    }
  }, [wantedKey, data, divisionPath]);
  // Try again: forget the failed read, so the round is wanted again and the effect above reads it.
  const retryRound = (key: string) =>
    setLoads((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

  // The team the search is showing: an answer for an earlier pick (a slow read overtaken by a newer one) is dropped.
  const teamPick = useRef<string | null>(null);
  const chooseTeam = (pick: { id: string; name: string }) => {
    teamPick.current = pick.id;
    setTeam(pick);
    setQuery(pick.name);
    setTeamLoad({ state: "loading" });
    fetchRounds(roundsUrl(divisionPath, { entrant: pick.id }))
      .then((answer) => {
        if (teamPick.current !== pick.id) return;
        if (answer.kind !== "entrant" || answer.entrantId !== pick.id) throw new Error("rounds: not this team");
        setExtras((prev) => mergeRowExtras(prev, answer.extras));
        setTeamLoad({ state: "ready", rounds: answer.rounds });
      })
      .catch(() => {
        if (teamPick.current === pick.id) setTeamLoad({ state: "error" });
      });
  };
  const clearTeam = () => {
    teamPick.current = null;
    setTeam(null);
    setTeamLoad(null);
    setQuery("");
  };

  const rowsOf = (key: string): PublicFixture[] | null => initial.get(key) ?? loads.get(key)?.rows ?? null;
  const failed = (key: string) => {
    const l = loads.get(key);
    return l?.failed === true && l.from === data && l.rows === undefined;
  };
  const toggle = (g: PagedScheduleGroup) => setToggled((prev) => new Map(prev).set(g.key, !isOpen(g)));
  const keep = (f: PublicFixture) => chip === "all" || fixtureBucket(f.status) === chip;
  const byKey = new Map(data.groups.map((g) => [g.key, g]));

  const rowList = (rows: readonly PublicFixture[], listId?: string) => (
    <ul id={listId} className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200/80 bg-surface shadow-sm">
      {rows.map((f) => (
        <li key={f.id}>
          <ScorebugRow
            fixture={f}
            entrantNames={entrantNames}
            href={`${divisionPath}/fixtures/${f.id}`}
            railMode="date"
            tz={tz}
            slotLabels={extras.slotLabels}
            copy={copy}
            dateTag={dateTag}
            forfeit={extras.forfeit[f.id]}
            watch={watchCopy && extras.watchLinks?.[f.id] ? { link: extras.watchLinks[f.id]!, copy: watchCopy } : null}
            roundOpenedAt={extras.roundOpenedAt?.[f.id] ?? null}
          />
        </li>
      ))}
    </ul>
  );

  const stateWord = (g: PagedScheduleGroup) => (
    <span
      data-testid="paged-round-state"
      className={
        g.state === "live"
          ? "inline-flex shrink-0 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-emerald-700"
          : g.state === "next"
            ? "shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-strong"
            : "shrink-0 text-[11px] font-medium text-ink-muted"
      }
    >
      {g.state === "live" ? <span aria-hidden className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /> : null}
      {pagedCopy.state[g.state]}
    </span>
  );

  const roundSection = (g: PagedScheduleGroup) => {
    const open = isOpen(g);
    const listId = `paged-round-${encodeURIComponent(g.key)}`;
    const rows = rowsOf(g.key);
    const shown = rows?.filter(keep) ?? null;
    return (
      <section key={g.key} data-testid="paged-round" data-round-key={g.key} data-state={g.state} data-open={open ? "true" : "false"} className="mb-4">
        <h3 className="m-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => toggle(g)}
            data-testid="paged-round-toggle"
            className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg text-left transition hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
          >
            <ChevronRight aria-hidden className={`h-4 w-4 shrink-0 text-ink-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
            <span className="min-w-0 truncate font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink">{g.label}</span>
            {stateWord(g)}
            <span data-testid="paged-round-count" className="shrink-0 text-xs tabular-nums text-ink-muted">
              {pagedCount(pagedCopy.matches, chipCount(g, chip), locale)}
            </span>
            {g.catchUp && copy.catchUp !== undefined ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-strong">{copy.catchUp}</span>
            ) : null}
            <span aria-hidden className="h-px min-w-4 flex-1 bg-zinc-200" />
          </button>
        </h3>
        {open ? (
          <div className="mt-1">
            {g.anchorAt !== null || g.sitsOut !== null ? (
              <p className="mb-2 flex flex-wrap gap-x-3 text-xs text-ink-muted">
                {g.anchorAt !== null ? <span>{copy.timesIn.replace("{zone}", fmtPublicZoneAbbrev(locale, tz, g.anchorAt))}</span> : null}
                {g.sitsOut !== null ? <span data-testid="schedule-sits-out">{g.sitsOut}</span> : null}
              </p>
            ) : null}
            {shown !== null ? (
              rowList(shown, listId)
            ) : failed(g.key) ? (
              <p id={listId} role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-surface px-4 py-3 text-sm text-ink-muted">
                {pagedCopy.loadFailed}
                <button type="button" onClick={() => retryRound(g.key)} className="min-h-11 font-semibold text-accent-strong underline-offset-2 hover:underline">
                  {pagedCopy.retry}
                </button>
              </p>
            ) : (
              <p id={listId} role="status" data-testid="paged-round-loading" className="rounded-xl border border-zinc-200/80 bg-surface px-4 py-3 text-sm text-ink-muted">
                {pagedCopy.loading}
              </p>
            )}
          </div>
        ) : null}
      </section>
    );
  };

  const suggestions = team === null ? teamSuggestions(entrantNames, query) : [];
  const listed = roundsForChip(data.groups, chip);
  const finishedFolded = chip === "all" ? listed.filter((g) => g.state === "finished" && !g.open) : [];
  const roundsShown = chip === "all" && !finishedShown ? listed.filter((g) => !(g.state === "finished" && !g.open)) : listed;

  const teamView = () => {
    if (team === null) return null;
    if (teamLoad === null || teamLoad.state === "loading")
      return <p role="status" data-testid="paged-team-loading" className="text-sm text-ink-muted">{pagedCopy.loading}</p>;
    if (teamLoad.state === "error")
      return (
        <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
          {pagedCopy.loadFailed}
          <button type="button" onClick={() => chooseTeam(team)} className="min-h-11 font-semibold text-accent-strong hover:underline">
            {pagedCopy.retry}
          </button>
        </p>
      );
    const rounds = teamLoad.rounds
      .map((r) => ({ group: byKey.get(r.key), rows: r.rows.filter(keep) }))
      .filter((r): r is { group: PagedScheduleGroup; rows: PublicFixture[] } => r.group !== undefined && r.rows.length > 0);
    const ordered = chip === "result" ? [...rounds].reverse() : rounds;
    if (ordered.length === 0)
      return <p data-testid="paged-team-empty" className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
        {chip === "all" ? pagedCopy.searchNoMatches.replace("{team}", team.name) : pagedCopy.empty[copyKey(chip)]}
      </p>;
    return (
      <div data-testid="paged-team">
        {ordered.map(({ group, rows }) => (
          <section key={group.key} data-testid="paged-team-round" data-round-key={group.key} className="mb-4">
            <h3 className="mb-2 flex min-w-0 items-center gap-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink">
              <span className="min-w-0 truncate">{group.label}</span>
              {stateWord(group)}
              <span aria-hidden className="h-px min-w-4 flex-1 bg-zinc-200" />
            </h3>
            {rowList(rows)}
          </section>
        ))}
      </div>
    );
  };

  return (
    <div data-testid="paged-schedule">
      <div className="mb-4 flex flex-col gap-3">
        <div className="relative min-w-0 sm:max-w-sm">
          <label className="sr-only" htmlFor="paged-team-search">
            {pagedCopy.searchLabel}
          </label>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            id="paged-team-search"
            data-testid="paged-team-search"
            type="search"
            autoComplete="off"
            placeholder={pagedCopy.searchLabel}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (team !== null) {
                teamPick.current = null;
                setTeam(null);
                setTeamLoad(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && suggestions[0]) {
                e.preventDefault();
                chooseTeam(suggestions[0]);
              }
            }}
            className="min-h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-surface py-2 pl-9 pr-10 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-line"
          />
          {query !== "" ? (
            <button
              type="button"
              data-testid="paged-team-clear"
              onClick={clearTeam}
              aria-label={pagedCopy.searchClear}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-ink-muted hover:text-ink"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
          {team === null && query.trim() !== "" ? (
            suggestions.length > 0 ? (
              <ul data-testid="paged-team-suggestions" className="mt-1 divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-surface shadow-sm">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => chooseTeam(s)}
                      className="flex min-h-11 w-full min-w-0 items-center px-3 text-left text-sm text-ink hover:bg-accent-soft/60"
                    >
                      <span className="min-w-0 truncate">{s.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p data-testid="paged-team-none" className="mt-1 text-sm text-ink-muted">
                {pagedCopy.searchNone.replace("{query}", query.trim())}
              </p>
            )
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={pagedCopy.filterLabel} className="flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`paged-chip-${c}`}
                aria-pressed={chip === c}
                onClick={() => setChip(c)}
                className={`min-h-11 rounded-full border px-4 text-sm font-medium transition ${
                  chip === c
                    ? "border-accent bg-accent text-accent-ink"
                    : "border-zinc-300 bg-surface text-ink-muted hover:bg-accent-soft hover:text-accent-strong"
                }`}
              >
                {pagedCopy.filter[copyKey(c)]}
              </button>
            ))}
          </div>
          <a
            href={`${divisionPath}/calendar.ics${team ? `?entrant=${team.id}` : ""}`}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent-strong underline-offset-2 hover:underline sm:ml-auto"
          >
            <CalendarPlus aria-hidden className="h-4 w-4" />
            {copy.calendar}
          </a>
        </div>
      </div>

      {team !== null ? (
        <>
          <p data-testid="paged-team-showing" className="mb-3 flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
            <span className="min-w-0 truncate">{pagedCopy.searchShowing.replace("{team}", team.name)}</span>
            <button type="button" onClick={clearTeam} className="min-h-11 shrink-0 font-semibold text-accent-strong hover:underline">
              {pagedCopy.searchClear}
            </button>
          </p>
          {teamView()}
        </>
      ) : (
        <>
          {finishedFolded.length > 0 ? (
            <div data-testid="paged-finished" className="mb-4 flex min-h-11 items-center gap-3 rounded-xl border border-zinc-200/80 bg-surface px-4 text-sm text-ink-muted">
              <span className="min-w-0 flex-1 truncate">{pagedCount(pagedCopy.finished, finishedFolded.length, locale)}</span>
              <button
                type="button"
                data-testid="paged-finished-toggle"
                aria-expanded={finishedShown}
                onClick={() => setFinishedShown((v) => !v)}
                className="min-h-11 shrink-0 font-semibold text-accent-strong hover:underline"
              >
                {finishedShown ? pagedCopy.hide : pagedCopy.show}
              </button>
            </div>
          ) : null}
          {roundsShown.map(roundSection)}
          {chip !== "all" && listed.length === 0 ? (
            <p data-testid="paged-empty" className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
              {pagedCopy.empty[copyKey(chip)]}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
