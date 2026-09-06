"use client";
// Competition Desk W3, Task 7 (design doc 2026-09-02 §"W3 — Tasks 1 and
// 6-10", Task 7): the band mounted in the slot W1 reserved between the
// masthead's tools row and "Needs you" (page.tsx). One card per in-play
// fixture across every division, plus one dashed "Up next" card, and "NO
// SCORE" in red for a fixture with an empty ledger (`event_count === 0`).
//
// SSR-first, then polled: `initial` is Task 6's `getCompetitionDesk` output,
// already awaited by the page, so the band paints on first load with no
// client fetch. From then on it polls its own endpoint
// (`GET /api/v1/competitions/{id}/desk`) every 20s WHILE something is live —
// same shape as `run-elapsed.tsx`/`live-score.tsx` (this repo has no query
// library): a plain `setInterval`, cleared (not merely skipped) once nothing
// is in play, so a competition that has gone quiet stops fetching instead of
// polling a permanently-empty band forever.
import { useCallback, useEffect, useState } from "react";
// NOT `@/lib/i18n` — that module carries `import "server-only"` and this is
// a client component (build failure, not a lint nit: found via a real
// `next build`, "You're importing a module that depends on 'server-only'…
// in the Pages Router"). `t`/`plural` are re-exported from the pure,
// server-only-free `i18n-runtime` module for exactly this reason — see its
// own header comment.
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { DeskInPlayFixture, DeskNextFixture } from "@/server/usecases/competition-desk";

const POLL_MS = 20_000;

export interface InPlayBandProps {
  competitionId: string;
  initial: { inPlay: DeskInPlayFixture[]; upNext: DeskNextFixture | null };
  dict: Dict;
}

/** The poll response's shape, narrowed to exactly the two fields this band
 *  reads. Task 6's wire note: `CompetitionDesk.divisions` is a `Map`
 *  server-side but crosses the wire as a plain object (a bare `Map`
 *  JSON-stringifies to `{}`, so the route converts it with
 *  `Object.fromEntries`) — the SSR `initial` prop and the poll response are
 *  therefore NOT the same shape on that field. Lifting only these two fields
 *  out of `json.data` here (never storing the whole payload) means this
 *  component's state never has to reconcile two incompatible `divisions`
 *  shapes behind one variable. */
interface DeskPollFields {
  in_play_fixtures?: DeskInPlayFixture[];
  up_next?: DeskNextFixture | null;
}

export function InPlayBand({ competitionId, initial, dict }: InPlayBandProps): React.ReactElement | null {
  const [inPlay, setInPlay] = useState<DeskInPlayFixture[]>(initial.inPlay);
  const [upNext, setUpNext] = useState<DeskNextFixture | null>(initial.upNext);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/competitions/${competitionId}/desk`);
      if (!res.ok) return;
      const json = (await res.json()) as { data?: DeskPollFields };
      if (!json.data) return;
      setInPlay(json.data.in_play_fixtures ?? []);
      setUpNext(json.data.up_next ?? null);
    } catch {
      // Transient network hiccup — keep the last known band rather than
      // blanking it on one failed poll.
    }
  }, [competitionId]);

  // Recomputed from STATE (not the initial prop) so a poll that empties the
  // list — the last live fixture decided — clears its OWN interval on the
  // very next render instead of continuing to fetch a dead band.
  const live = inPlay.length > 0;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  // Design doc Task 7 / this task's own mutation gate: rendered ONLY when
  // `inPlay.length > 0`, no empty state — delete this guard and exactly one
  // unit test reddens.
  if (inPlay.length === 0) return null;

  return (
    <section data-testid="desk-in-play-band" className="mb-6">
      {/* A scrolling rail owes a keyboard stop, a role and a name
          unconditionally — tabindex cannot be varied by media query, and an
          unguarded one trips axe's `scrollable-region-focusable`. */}
      <div
        className="scroll-x flex gap-3 rounded-2xl bg-slate-900 p-4"
        tabIndex={0}
        role="region"
        aria-label={t(dict, "desk.band.aria")}
      >
        {inPlay.map((fx) => (
          <InPlayCard key={fx.id} fx={fx} dict={dict} />
        ))}
        {upNext && <UpNextCard fx={upNext} dict={dict} />}
      </div>
    </section>
  );
}

function InPlayCard({ fx, dict }: { fx: DeskInPlayFixture; dict: Dict }): React.ReactElement {
  return (
    <div
      data-testid="desk-in-play-card"
      className="flex min-w-44 shrink-0 flex-col gap-1 rounded-xl bg-slate-800 px-4 py-3 text-white"
    >
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {fx.division_name}
      </p>
      <p className="truncate text-sm font-medium">{fx.home ?? "—"}</p>
      <p className="truncate text-sm font-medium">{fx.away ?? "—"}</p>
      {fx.event_count === 0 ? (
        <p className="mt-1 font-mono text-xs font-bold uppercase tracking-wide text-red-400">
          {t(dict, "desk.band.noScore")}
        </p>
      ) : (
        // "No LED-numeral component exists" (task brief) — built fresh here
        // with the repo's own `--sport-led` token (globals.css), never a
        // hand-picked green.
        <p
          className="mt-1 font-mono text-2xl font-bold tabular-nums"
          style={{ color: "var(--sport-led)" }}
        >
          {fx.event_count}
        </p>
      )}
    </div>
  );
}

function UpNextCard({ fx, dict }: { fx: DeskNextFixture; dict: Dict }): React.ReactElement {
  return (
    <div
      data-testid="desk-up-next-card"
      className="flex min-w-44 shrink-0 flex-col gap-1 rounded-xl border-2 border-dashed border-slate-700 px-4 py-3 text-slate-300"
    >
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {t(dict, "desk.band.upNext")}
      </p>
      <p className="truncate text-sm font-medium">{fx.home ?? "—"}</p>
      <p className="truncate text-sm font-medium">{fx.away ?? "—"}</p>
    </div>
  );
}
