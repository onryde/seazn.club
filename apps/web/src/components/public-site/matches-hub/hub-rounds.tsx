"use client";
// W5 follow-ups C (owner 2026-11-23, Option A "by round"): one BIG division's matches on the hub's Matches tab, by round. The served
// document carries the matches of its open rounds (live, next) and every other round as a header with its counts (`roundPages`,
// `lib/hub-round-paging.ts`); a folded round's cards are read on a tap from `[divisionSlug]/hub-rounds`, out of the same cached
// document, and read again whenever the polled document changes (`generatedAt`), so a loaded round keeps its live scores. The bucket
// chip above (Live / Upcoming / Results) narrows the rounds to those holding one of its matches, Results most recent first.
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { hubRoundKey, type HubRoundPage } from "@/lib/hub-round-paging";
import { pagedCount } from "@/lib/schedule-paging";
import type { CompetitionHubDocT, HubMatchT } from "@/server/public-site/competition-hub-schema";
import { MatchCard } from "./match-card";

type Bucket = HubMatchT["bucket"];

/** A round's count of one bucket (the hub's "completed" is the planner's "result"). */
export const pageCount = (p: Pick<HubRoundPage, "live" | "upcoming" | "result">, bucket: Bucket) =>
  bucket === "completed" ? p.result : p[bucket];

/** The rounds the chip lists, in the order it lists them. */
export function hubRoundsFor(pages: readonly HubRoundPage[], bucket: Bucket): HubRoundPage[] {
  const holding = pages.filter((p) => pageCount(p, bucket) > 0);
  return bucket === "completed" ? holding.reverse() : holding;
}

/** Where a folded round's cards are read. `at` names the document build (`generatedAt`): the answer is edge-cached (30 s, then 300 s
 *  stale-while-revalidate), so a URL without it could be answered with an older build's cards and marked as this build's read. */
export const hubRoundsUrl = (doc: Pick<CompetitionHubDocT, "orgSlug" | "competitionSlug" | "generatedAt">, divisionSlug: string, key: string) =>
  `/live/${encodeURIComponent(doc.orgSlug)}/${encodeURIComponent(doc.competitionSlug)}/${encodeURIComponent(divisionSlug)}/hub-rounds?key=${encodeURIComponent(key)}&at=${encodeURIComponent(doc.generatedAt)}`;

/** What a folded round last read: at which document build, its cards, or that the read failed (the cards before it kept). While a
 *  read for the current build is out there is no entry for that build yet, which is what "loading" is (derived, never stored). */
type Loaded = { at: string; rows?: HubMatchT[]; failed?: true };

export function HubRounds({
  doc,
  divisionSlug,
  divisionName,
  pages,
  matches,
  bucket,
  dict,
  locale,
  now,
  showDivision,
}: {
  doc: Pick<CompetitionHubDocT, "orgSlug" | "competitionSlug" | "generatedAt">;
  divisionSlug: string;
  divisionName: string;
  pages: readonly HubRoundPage[];
  /** This division's SERVED matches: every open round's. */
  matches: readonly HubMatchT[];
  bucket: Bucket;
  dict: PublicDict;
  locale: Locale;
  now: number;
  /** More than one division on the tab: name this one. */
  showDivision: boolean;
}) {
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Loaded>>(() => new Map());
  // Reads already out, as `key` + build: a round whose read for this build has not answered yet is still wanted, and must not be
  // read twice while another round's answer re-runs the effect.
  const inFlight = useRef(new Set<string>());
  const isOpen = (p: HubRoundPage) => toggled.get(p.key) ?? p.open;
  const listed = hubRoundsFor(pages, bucket);
  // Every OPEN folded round whose cards are not from this document yet: read (again). Keyed on the document's build, so a poll that
  // changed nothing (a 304, the same `generatedAt`) reads nothing.
  const wanted = listed.filter((p) => !p.open && isOpen(p) && loaded.get(p.key)?.at !== doc.generatedAt).map((p) => p.key);
  const wantedKey = wanted.join("\n");
  useEffect(() => {
    if (wantedKey === "") return;
    const at = doc.generatedAt;
    for (const key of wantedKey.split("\n")) {
      const ticket = `${key}\n${at}`;
      if (inFlight.current.has(ticket)) continue;
      inFlight.current.add(ticket);
      fetch(hubRoundsUrl(doc, divisionSlug, key), { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`hub-rounds ${res.status}`);
          // The v1 envelope (`server/api-v1/http.ts`).
          const rows = ((await res.json()) as { data: HubMatchT[] }).data;
          setLoaded((prev) => new Map(prev).set(key, { at, rows }));
        })
        .catch(() => setLoaded((prev) => new Map(prev).set(key, { at, rows: prev.get(key)?.rows, failed: true })))
        .finally(() => inFlight.current.delete(ticket));
    }
    // `doc` is read only for its slugs, fixed for the page; `wantedKey` carries the build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, divisionSlug]);
  if (listed.length === 0) return null;
  const stages = new Set(pages.map((p) => p.stageName));
  const title = (p: HubRoundPage) => {
    const round = p.label ?? t(dict, "matchesHub.round", { round: p.roundNo });
    return stages.size > 1 ? `${p.stageName} · ${round}` : round;
  };
  const words = (k: string) => t(dict, k);
  return (
    <section data-testid={`mh-rounds-${divisionSlug}`} className="space-y-3">
      {showDivision ? <h2 className="font-display text-sm font-semibold text-ink">{divisionName}</h2> : null}
      {listed.map((p) => {
        const open = isOpen(p);
        const listId = `mh-round-${divisionSlug}-${encodeURIComponent(p.key)}`;
        const got = loaded.get(p.key);
        const rows = (p.open ? matches.filter((m) => hubRoundKey(m) === p.key) : (got?.rows ?? null))?.filter((m) => m.bucket === bucket) ?? null;
        const failed = got?.failed === true && got.at === doc.generatedAt;
        return (
          <div key={p.key} data-testid="mh-round" data-round-key={p.key} data-state={p.state} data-open={open ? "true" : "false"}>
            <h3 className="m-0">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={listId}
                data-testid="mh-round-toggle"
                onClick={() => setToggled((prev) => new Map(prev).set(p.key, !open))}
                className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg text-left font-display text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                <ChevronRight aria-hidden className={`h-4 w-4 shrink-0 text-ink-muted transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
                <span className="min-w-0 truncate">{title(p)}</span>
                <span className="shrink-0 text-xs font-medium text-ink-muted">{words(`paging.state.${p.state}`)}</span>
                <span data-testid="mh-round-count" className="shrink-0 text-xs tabular-nums text-ink-muted">
                  {pagedCount({ one: words("paging.matches.one"), other: words("paging.matches.other") }, pageCount(p, bucket), locale)}
                </span>
                <span aria-hidden className="h-px min-w-4 flex-1 bg-zinc-200" />
              </button>
            </h3>
            {open ? (
              rows !== null ? (
                <ul id={listId} className="mt-2 grid gap-2 md:grid-cols-2" role="list">
                  {rows.map((match) => (
                    <li key={match.fixtureId} className="min-w-0">
                      <MatchCard match={match} dict={dict} locale={locale} now={now} showDivision={false} />
                    </li>
                  ))}
                </ul>
              ) : failed ? (
                <p id={listId} role="alert" className="mt-2 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
                  {words("paging.loadFailed")}
                  <button
                    type="button"
                    onClick={() => setLoaded((prev) => { const next = new Map(prev); next.delete(p.key); return next; })}
                    className="min-h-11 font-semibold text-accent-strong hover:underline"
                  >
                    {words("paging.retry")}
                  </button>
                </p>
              ) : (
                <p id={listId} role="status" data-testid="mh-round-loading" className="mt-2 text-sm text-ink-muted">
                  {words("paging.loading")}
                </p>
              )
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
