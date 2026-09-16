"use client";
// Spectator W2, Task 15 — the org home's competitions list, as ONE client
// island that keeps every status chip truthful while the page is open (R10:
// live means live, never reload).
//
// The chip is derived from the competition's status AND how many of its public
// fixtures are in play (`competitionChip(status, in_play)`): a status is an
// organiser's setting that nothing flips when a match starts, which is how the
// org home came to read "Upcoming" on a competition with a match being played
// (W0 block II). With a match in play the pill COUNTS them — "2 live now",
// `org.live.one`/`.other` in the org's locale (owner ruling 2026-09-16); with
// none it is the status label, as before.
//
// ONE island per page, never one per card: it renders the whole `<ul>` and
// owns the single poll of `GET /api/v1/public/orgs/{orgSlug}/live` (poll-only
// by owner ruling, W2-landing.md question 3 — Realtime would need a channel per
// division of every competition). The cadence is the hub's: `HUB_POLL_MS`
// while anything is in play, `HUB_IDLE_POLL_MS` otherwise, never off — a match
// can start between ticks. It also fetches ONCE on mount: the page is ISR (30s)
// and the poll's Redis copy lives 15s, so without it the first paint could sit
// a whole idle interval stale. Like the hub's hook, it does not pause while the
// tab is hidden.
//
// The card markup is lifted unchanged from the page. Names, slugs and the date
// line arrive from the server; the date line is formatted THERE, in the org's
// locale and in UTC (page.tsx says why), so the browser's own ICU never formats
// it and cannot disagree with the server's copy at hydration.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale, Dict as PublicDict } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { chipLabelKey, competitionChip } from "@/lib/public-site";
import { fetchOrgLive } from "./org-live-data";
import { HUB_IDLE_POLL_MS, HUB_POLL_MS } from "./use-live-competition";

export interface OrgLiveCompetition {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** Public fixtures of this competition in play at render time. */
  in_play: number;
  /** "1 Sept 2026 – 13 Sept 2026", already formatted; "" when it has no dates. */
  dateLine: string;
}

export interface OrgLiveChipsProps {
  orgSlug: string;
  competitions: OrgLiveCompetition[];
  /** `orgLiveDict(dict)` (lib/hub-dict.ts) — the chip labels, the count
   *  sentence and the empty sentence only. */
  dict: PublicDict;
  /** The org's locale: the in-play count is pluralised in it. */
  locale: Locale;
}

type Live = { status: string; in_play: number };

/** Spectator-language chip. The status → chip mapping lives in
 *  lib/public-site.ts (`competitionChip`) so it unit-tests without JSX. The
 *  testid and `data-chip` sit on the pill itself, so a test reads the chip a
 *  spectator sees rather than a wrapper around it. */
function statusChip(id: string, status: string, inPlay: number, dict: PublicDict, locale: Locale) {
  const chip = competitionChip(status, inPlay);
  // A count when there is one ("1 live now"); otherwise the status label.
  // `data-chip` is "on-now" either way — only the words change.
  const label = inPlay > 0 ? plural(dict, "org.live", inPlay, locale) : t(dict, chipLabelKey(status, inPlay));
  const testid = `mh-org-chip-${id}`;
  if (chip === "on-now") {
    return (
      <span
        data-testid={testid}
        data-chip={chip}
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200"
      >
        <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {label}
      </span>
    );
  }
  if (chip === "finished") {
    return (
      <span
        data-testid={testid}
        data-chip={chip}
        className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500"
      >
        {label}
      </span>
    );
  }
  return (
    <span
      data-testid={testid}
      data-chip={chip}
      className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-strong ring-1 ring-inset ring-accent-line"
    >
      {label}
    </span>
  );
}

export function OrgLiveChips({ orgSlug, competitions, dict, locale }: OrgLiveChipsProps) {
  // The latest poll's answer per competition id; null until the first poll
  // lands, so the first paint is exactly the server's.
  const [polled, setPolled] = useState<ReadonlyMap<string, Live> | null>(null);

  // A poll in flight when the island unmounts must not set state on its way
  // back (`use-live-competition.ts`'s guard).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A competition a successful poll no longer returns is DROPPED. The poll lists
  // exactly what the org home lists, so that is a competition made private (or
  // unlisted) since this page was rendered — its card must not keep pulsing
  // "live" until the page revalidates. A failed poll never gets here, so it
  // drops nothing.
  const current = polled
    ? competitions.flatMap((c) => {
        const live = polled.get(c.id);
        return live ? [{ ...c, status: live.status, in_play: live.in_play }] : [];
      })
    : competitions;
  // Whether to poll at all follows what the SERVER listed, not what survived
  // the last poll: a competition hidden and then made public again comes back
  // on a later poll only if the poll is still running.
  const listed = competitions.length > 0;
  const anyInPlay = current.some((c) => c.in_play > 0);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchOrgLive(orgSlug);
      if (!mountedRef.current) return;
      setPolled(new Map(next.competitions.map((c) => [c.id, { status: c.status, in_play: c.in_play }])));
    } catch {
      // transient — keep the last chips (never throw to the UI)
    }
  }, [orgSlug]);

  // Once on mount, apart from the interval: a cadence change re-arms the
  // interval below and must not fire an extra fetch with it. Queued as a
  // zero-delay timer rather than called in the effect body, so the state it
  // sets always lands outside the commit (`react-hooks/set-state-in-effect`),
  // and cleared on unmount like the interval.
  useEffect(() => {
    if (!listed) return;
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [listed, refresh]);

  useEffect(() => {
    // Nothing listed, nothing to keep live: the page shows its empty sentence.
    if (!listed) return;
    const id = setInterval(refresh, anyInPlay ? HUB_POLL_MS : HUB_IDLE_POLL_MS);
    return () => clearInterval(id);
  }, [listed, anyInPlay, refresh]);

  if (current.length === 0) {
    // Listed at render, all gone since (every competition made private): the
    // page's own empty sentence, in the page's markup, so the "Competitions"
    // heading never sits over nothing until a reload. A list that was empty
    // from the start never mounts this island (the page renders the sentence).
    if (!listed) return null;
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
        {t(dict, "empty")}
      </p>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {current.map((c) => (
        <li key={c.id}>
          <Link
            href={`/shared/${orgSlug}/${c.slug}`}
            className="group flex h-full flex-col justify-between rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent-line hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="font-display text-xl font-semibold leading-tight text-ink">{c.name}</p>
              <ChevronRight
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-accent"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              {statusChip(c.id, c.status, c.in_play, dict, locale)}
              {c.dateLine ? <span>{c.dateLine}</span> : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
