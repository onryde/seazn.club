"use client";

// #364 Task 6 — "pick a template", the AI architect demo on /[lang]/scheduling.
//
// The section's claim is narrow and testable: what plays here is a RECORDING of
// a real run, not a mockup of one. So nothing on screen is authored twice —
// the trace comes from `buildScheduleTrace`, the change list from `AiDiffPanel`,
// the price from `quoteRun`, all fed the committed fixture's own wire response.
// If the product's referee, diff or pricing changes, this section changes with
// it or the drift guard (Task 4) reds. The only thing the marketing catalog
// contributes is the frame: the section's own copy and the three card blurbs.
//
// Three shapes, because the product has three:
//   * finals-day  — a REPAIR. The hero, first and emphasised: it is the run
//     where the machine reports what it could NOT place.
//   * club-night  — a single-division generate. Timed trace replay.
//   * northside-open — the JOINT solve. The real joint console renders no
//     referee trace, so neither does this: it gets the per-division ledger, the
//     divergent-court warning and the Σ−1 batch price instead. Inventing a
//     trace for it would be exactly the drift this section exists to disprove.
//
// The fixtures ride their own chunks (`import()` on selection; the joint one is
// 235KB) so the marketing page's initial bundle is untouched.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDict } from "@/components/i18n/dict-provider";
import { AiDiffPanel } from "@/components/v2/board/ai-diff-panel";
import { AiTrace } from "@/components/v2/board/ai-trace";
import { buildScheduleTrace } from "@/components/v2/board/ai-trace-compose";
import { blockingConflictCode, blockingConflictKey } from "@/components/v2/board/ai-diff";
import { CONFLICT_LABEL } from "@/components/v2/board/types";
import { quoteRun, type Quote, type QuoteLineInput, type Rung, type RungWeights } from "@/lib/ai-rung";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime, type TKey } from "@/lib/i18n-runtime";
import type { AiDemoFixture } from "@/demo/ai-templates/types";
import { useStartOnView } from "./use-start-on-view";
import type { AiPlanResponse } from "@/server/api-v1/schemas";

/** Hero first — the section leads with the run that admits a failure. */
const SLUGS = ["finals-day", "club-night", "northside-open"] as const;
type Slug = (typeof SLUGS)[number];

/** One thunk per template rather than a template literal `import()`: a dynamic
 *  path would make webpack bundle every JSON in that directory into one context
 *  chunk, which is the opposite of why these are lazy. */
const LOADERS: Record<Slug, () => Promise<{ default: unknown }>> = {
  "finals-day": () => import("@/demo/ai-templates/finals-day.json"),
  "club-night": () => import("@/demo/ai-templates/club-night.json"),
  "northside-open": () => import("@/demo/ai-templates/northside-open.json"),
};

/** Reveal cadence for the replay. Slightly under `AiTrace`'s own 380ms reveal,
 *  so the component the product ships stays the thing pacing the animation. */
const REPLAY_MS = 350;

/**
 * The committed responses are single-division `AiPlanResponse` or joint
 * `AiCompetitionPlanResponse`. Both are read through one view: the joint-only
 * keys are optional, and their presence is what selects the joint branch.
 *
 * `divisions` is re-declared rather than borrowed. Both response schemas spread
 * `AiRunPriceFields`, which declares its OWN `divisions` (the per-division PRICE
 * rows), and `z.infer` resolves to that one — so `AiCompetitionPlanResponse
 * ["divisions"]` has no `name` and no `movable`, the two fields the ledger is
 * made of. The recorded joint response carries them (schemas.ts documents the
 * merge as deliberate); the inferred type simply cannot see them.
 */
type DemoDivision = {
  id: string;
  name: string;
  movable: number;
  rung: Rung;
  predicted_rung: Rung;
  underfunded: boolean;
};
type DemoPlan = Omit<AiPlanResponse, "divisions"> & {
  divisions?: DemoDivision[];
  divergent_courts?: string[];
};
type ProposalRow = AiPlanResponse["proposal"][number] & { division_id?: string };

/** The slice of the committed `pack` the price is derived from. `pack` is
 *  `unknown` in `AiDemoFixture` on purpose (its real types are server-only), so
 *  each consumer declares the half it reads. */
type DemoPack = {
  divisions?: { id: string; movableIds: string[]; settings?: { courts?: string[] } }[];
  entrants?: { id: string; division_id?: string }[];
  settings?: { courts?: string[] };
};

/**
 * The priced lines for a recorded run, derived exactly the way the SERVER
 * derives them — same fields, same source.
 *
 *   joint  → competition-schedule-ai.ts:2565, one line per solved division:
 *            `d.movableIds.length`, `pack.entrants.filter(division_id)`,
 *            `d.settings.courts.length`
 *   single → schedule-ai.ts:2680, one line: `movableIds.size`,
 *            `pack.entrants.length`, `pack.settings.courts.length`
 *
 * Read from the PACK, never from the board. The board's `courts` is the UNION
 * across divisions (5 at Northside, where the real per-division sets are 4/3/4)
 * and its entrant count is participation, not the draw (23 U15 entrants own a
 * fixture; 24 people appear in one). Both differences move `sizeScore` — Men's
 * and Women's land at 55 and 55.5 against an `s1` of 60 — so a board-derived
 * quote is one recapture away from printing a rung the run never paid.
 */

/**
 * Court NAMES for the divergent-courts note, or an empty list.
 *
 * P9: every court value in a recorded fixture is a UUID since the cutover, and
 * this component renders on the PUBLIC marketing site — so an id that cannot be
 * resolved is DROPPED rather than shown. A shorter list is a fine outcome;
 * three raw uuids in a caution box is not. Fixtures recorded before the capture
 * started writing `courtNames` resolve nothing, and the caller hides the note.
 *
 * Exported so both branches are testable: the component loads its fixtures
 * through a dynamic `import()` of the JSON, which a test cannot substitute
 * without mocking the module for the whole file.
 */
export function resolveDivergentCourtNames(
  fixture: AiDemoFixture | null,
  divergent: readonly string[] | undefined,
): string[] {
  const names = fixture?.courtNames ?? {};
  return (divergent ?? [])
    .map((id) => names[id])
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

export function demoQuoteLines(fixture: AiDemoFixture): QuoteLineInput[] {
  const pack = fixture.pack as DemoPack;
  const fallbackCourts = fixture.board.courts.length;
  if (pack.divisions?.length) {
    const entrants = pack.entrants ?? [];
    return pack.divisions.map((d) => ({
      key: d.id,
      input: {
        movableFixtures: d.movableIds.length,
        entrants: entrants.filter((e) => e.division_id === d.id).length,
        courts: d.settings?.courts?.length ?? fallbackCourts,
      },
    }));
  }
  return [
    {
      key: fixture.meta.slug,
      input: {
        movableFixtures: fixture.movableIds.length,
        entrants: pack.entrants?.length ?? fixture.board.entrants.length,
        courts: pack.settings?.courts?.length ?? fallbackCourts,
      },
    },
  ];
}

/**
 * A conflict's primary text, resolved through the shared taxonomy — the exact
 * body of `ai-diff-panel.tsx`'s `conflictLabel` (:65), which the joint console
 * and the review panel also use.
 *
 * The engine hands back a camelCase reason token. Printing it raw would put
 * English machine vocabulary on /es, /fr and /nl, which is the one thing this
 * section cannot afford to do — it is arguing that what you see is the product.
 */
export function conflictLabelFor(dict: Dict, reason: string): string {
  const code = blockingConflictCode(reason);
  const key = blockingConflictKey(reason);
  const localized = tRuntime(dict, key);
  return localized === key ? (CONFLICT_LABEL[code] ?? code) : localized;
}

/** SSR-safe, and safe in a DOM-less test: `window` may not exist at all. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    if (!mq) return;
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

export function AiArchitectDemo({ locale, weights }: { locale: Locale; weights: RungWeights }) {
  const dict = useDict();
  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>) => tRuntime(dict, key, vars),
    [dict],
  );
  const plural = useCallback(
    (key: string, count: number, vars?: Record<string, string | number>) =>
      pluralRuntime(dict, key, count, locale, { n: count, ...vars }),
    [dict, locale],
  );

  const [slug, setSlug] = useState<Slug>(SLUGS[0]);
  const [seenSlug, setSeenSlug] = useState<Slug>(SLUGS[0]);
  const [fixture, setFixture] = useState<AiDemoFixture | null>(null);
  const [shown, setShown] = useState(0);
  const [replays, setReplays] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const wanted = useRef<Slug>(SLUGS[0]);
  const reduced = usePrefersReducedMotion();
  // The screen is below the fold. Without this the trace plays itself out on
  // mount and an organiser scrolling down meets a finished, static run.
  //
  // The observed element is the SCREEN, not the section: the section's top edge
  // is already on the first viewport at desktop, so anchoring there would start
  // the run while the part that draws it is still a thousand pixels down.
  const screenRef = useRef<HTMLDivElement | null>(null);
  const inView = useStartOnView(screenRef);
  // Picking a template is an explicit ask, and it must play whether or not the
  // screen has scrolled into view yet — at 375px a card click leaves the screen
  // itself off-screen, so a view-only gate would swallow the interaction.
  const [picked, setPicked] = useState(false);
  const started = inView || picked;

  // Drop the previous recording IN THE SAME RENDER the pick changes.
  //
  // This is a provenance surface: the REC slate names a model and a capture
  // date, and leaving the last run's on screen under a newly-selected card
  // attributes one run's receipt to another for the length of a chunk fetch.
  //
  // React's sanctioned "adjust state when something changes" pattern rather
  // than an effect — it throws this pass away and re-runs the body, so there is
  // no frame in which the stale fixture is rendered at all. Clearing it in an
  // effect would both paint that frame and trip `react-hooks/set-state-in-effect`.
  if (seenSlug !== slug) {
    setSeenSlug(slug);
    setFixture(null);
    setShown(0);
    setExcluded([]);
  }

  // Load the picked recording. `wanted` settles the race a fast second click
  // creates: two chunks in flight, and the slower one must not win.
  useEffect(() => {
    wanted.current = slug;
    void LOADERS[slug]()
      .then((mod) => {
        if (wanted.current !== slug) return;
        setFixture(mod.default as AiDemoFixture);
      })
      .catch(() => {
        // A chunk that never arrives leaves the screen on its loading line.
        // There is nothing an organiser could do about it from here.
      });
  }, [slug]);

  const plan = (fixture?.response ?? null) as DemoPlan | null;
  const joint = Boolean(plan?.divisions?.length);

  // P9: every court value in a recorded fixture is a UUID since the cutover.
  // This component renders on the PUBLIC marketing site, so an unresolved id
  // is dropped rather than shown — a shorter list is a fine outcome, three
  // raw uuids in a caution box is not. Fixtures recorded before `courtNames`
  // existed simply resolve nothing and the block hides itself.
  const divergentCourtNames = useMemo(
    () => resolveDivergentCourtNames(fixture ?? null, plan?.divergent_courts),
    [fixture, plan],
  );

  // The referee trace, composed by the console's own composer over the recorded
  // response — never a script written for the demo.
  const trace = useMemo(() => {
    if (!fixture || !plan || joint) return null;
    return buildScheduleTrace(plan, fixture.board.courts.length, t);
  }, [fixture, plan, joint, t]);

  const total = trace?.events.length ?? 0;
  const revealed = reduced ? total : Math.min(shown, total);

  // The recording is fetched on mount regardless of `started` — only the CLOCK
  // waits, so the run is ready to draw the moment the block arrives instead of
  // opening on a loading line.
  useEffect(() => {
    if (!started || reduced || shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), REPLAY_MS);
    return () => clearTimeout(id);
  }, [started, reduced, shown, total]);

  // Joint only: what each division actually got, counted off the proposal rows
  // the server stamped with a division.
  const ledger = useMemo(() => {
    if (!plan?.divisions) return [];
    const placed = new Map<string, number>();
    for (const row of plan.proposal as ProposalRow[]) {
      if (row.division_id) placed.set(row.division_id, (placed.get(row.division_id) ?? 0) + 1);
    }
    return plan.divisions.map((d) => ({ ...d, placed: placed.get(d.id) ?? 0 }));
  }, [plan]);

  // The Σ−1 batch discount is `quoteRun`'s, never ours; the inputs are the
  // server's, never the board's — see `demoQuoteLines`.
  const quote: Quote | null = useMemo(
    () => (fixture ? quoteRun(demoQuoteLines(fixture), weights) : null),
    [fixture, weights],
  );

  const codeOf = useCallback(
    (id: string) => fixture?.board.fixtures.find((f) => f.id === id)?.code ?? id.slice(0, 8),
    [fixture],
  );
  const conflictLabel = useCallback((reason: string) => conflictLabelFor(dict, reason), [dict]);

  const conflicts = plan ? [...plan.blocking, ...plan.warnings] : [];
  const capturedOn = fixture
    ? new Date(fixture.meta.capturedAt).toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "";

  const card = (s: Slug, hero: boolean) => {
    const active = s === slug;
    return (
      <button
        key={s}
        type="button"
        data-ai-template={s}
        {...(hero ? { "data-ai-hero": "true" } : {})}
        aria-pressed={active}
        onClick={() => {
          setPicked(true);
          setSlug(s);
        }}
        className={`group flex min-h-11 w-full flex-col items-start gap-1 rounded-xl border bg-[#241650] text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)] ${
          hero ? "p-4 sm:p-5" : "p-4"
        } ${
          active
            ? "border-[var(--mk-lime)] ring-1 ring-[var(--mk-lime)]"
            : "border-[#4a3885] hover:border-[#8d7fc0]"
        }`}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? "bg-[var(--mk-lime)]" : "bg-[#4a3885]"}`}
          />
          <span
            className={`mk-display font-bold leading-tight text-[var(--mk-cream)] ${
              hero ? "text-xl sm:text-2xl" : "text-base"
            }`}
          >
            {t(`scheduling.aidemo.card.${s}.name`)}
          </span>
        </span>
        <span className={`text-[#b3a4dd] ${hero ? "text-sm" : "text-[13px]"}`}>
          {t(`scheduling.aidemo.card.${s}.what`)}
        </span>
      </button>
    );
  };

  return (
    <section
      data-ai-demo="ready"
      data-ai-started={started ? "true" : "false"}
      aria-labelledby="ai-demo-title"
      className="bg-[var(--mk-night)] px-4 py-14 sm:py-16"
    >
      <div className="mx-auto max-w-4xl">
        <h2
          id="ai-demo-title"
          className="mk-display text-3xl font-bold text-[var(--mk-cream)] sm:text-4xl"
        >
          {t("scheduling.aidemo.title")}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#b3a4dd]">
          {t("scheduling.aidemo.subtitle")}
        </p>

        {/* The rail. Hero full width, the other two paired beneath it; all three
            stack at 375px. */}
        <div role="group" aria-label={t("scheduling.aidemo.pick")} className="mt-7 grid gap-3">
          {card(SLUGS[0], true)}
          <div className="grid gap-3 sm:grid-cols-2">
            {SLUGS.slice(1).map((s) => card(s, false))}
          </div>
        </div>

        {/* The screen: the product's own light chrome, dropped into the night
            page behind a slate that says where it came from. */}
        <div
          ref={screenRef}
          data-ai-screen="true"
          className="mt-6 overflow-hidden rounded-2xl border border-[#4a3885] bg-[var(--mk-night-2)] p-1.5"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
            <span className="mk-display inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.18em] text-[var(--mk-lime)]">
              <span
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-[var(--mk-lime)] motion-safe:animate-pulse"
              />
              {t("scheduling.aidemo.recordedLabel")}
            </span>
            {fixture && (
              <span
                className="font-mono text-[10px] text-[#8d7fc0]"
                title={t("scheduling.aidemo.commitAria", {
                  commit: fixture.meta.commit.slice(0, 7),
                })}
              >
                {/* Date and commit only. The served model is deliberately NOT
                    named on a public page (owner's ruling 2026-08-09) — it stays
                    in the recording as provenance, read by the capture harness
                    and the drift guard, never rendered. */}
                {t("scheduling.aidemo.recordedMeta", { date: capturedOn })}
              </span>
            )}
          </div>

          <div className="rounded-xl bg-white p-3 sm:p-4">
            {!fixture || !plan ? (
              <p className="py-8 text-center text-sm text-slate-400">
                {t("scheduling.aidemo.loading")}
              </p>
            ) : (
              <div className="space-y-3">
                {/* What was asked, verbatim — the run's actual input. */}
                <div className="rounded-lg border border-violet-100 bg-[var(--mk-light-violet)] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">
                    {t("scheduling.aidemo.instructionLabel")}
                  </p>
                  <p className="mt-1 font-mono text-[13px] leading-relaxed text-slate-700">
                    {fixture.meta.instruction}
                  </p>
                  {/* slate-600, not slate-500: 11px on the card's tinted
                      `#f6f3ff` measures 4.35:1, just under the 4.5:1 AA floor. */}
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-slate-600">
                    <span className="rounded bg-white px-1.5 py-0.5 font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">
                      {t(`scheduling.aidemo.mode.${fixture.meta.mode}`)}
                    </span>
                    {joint && (
                      <span className="rounded bg-white px-1.5 py-0.5 font-semibold text-violet-700 ring-1 ring-inset ring-violet-200">
                        {t("scheduling.aidemo.joint", { n: ledger.length })}
                      </span>
                    )}
                    <span>
                      {fixture.board.fixtures.length} {t("scheduling.aidemo.stats.fixtures")}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {fixture.board.courts.length} {t("scheduling.aidemo.stats.courts")}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {fixture.board.entrants.length} {t("scheduling.aidemo.stats.players")}
                    </span>
                  </p>
                </div>

                {/* Single division: the referee trace, replayed. */}
                {trace && (
                  <div className="overflow-x-auto">
                    <AiTrace
                      key={`${fixture.meta.slug}-${replays}`}
                      phase="schedule"
                      events={trace.events.slice(0, revealed)}
                      running={revealed < total}
                    />
                  </div>
                )}

                {/* Joint: the ledger the real joint review shows instead. */}
                {joint && (
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {t("scheduling.aidemo.ledger.title")}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {ledger.map((d) => (
                        <li
                          key={d.id}
                          data-ai-ledger="row"
                          data-division-id={d.id}
                          data-placed={String(d.placed)}
                          className="flex items-baseline justify-between gap-3 rounded-md bg-slate-50/70 px-2 py-1 text-xs"
                        >
                          <span className="min-w-0 truncate font-medium text-slate-700">
                            {d.name}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-teal-700">
                            {t("scheduling.aidemo.ledger.placed", { n: d.placed })}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {divergentCourtNames.length > 0 && (
                      <p
                        data-ai-divergent="courts"
                        className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800"
                      >
                        {t("scheduling.aidemo.divergentCourts", {
                          // P9: `divergent_courts` carries court UUIDs since the
                          // cutover. This is a PUBLIC page, so an id must never
                          // reach the DOM — resolve through the capture's own
                          // recorded name map and drop anything unresolvable
                          // rather than printing it.
                          courts: divergentCourtNames.join(", "),
                        })}
                      </p>
                    )}
                  </div>
                )}

                {/* Joint: one flat conflict list for the whole competition. */}
                {joint && (
                  <div
                    data-ai-conflicts="list"
                    data-count={String(conflicts.length)}
                    className="rounded-lg border border-slate-200 bg-white p-3"
                  >
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {t("scheduling.aidemo.conflicts.title")}
                    </p>
                    {conflicts.length === 0 ? (
                      <p className="mt-1 text-[11px] text-teal-700">
                        {t("scheduling.aidemo.conflicts.none")}
                      </p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {conflicts.map((c, i) => (
                          <li
                            key={`${c.fixtureId}-${i}`}
                            data-ai-conflict="row"
                            className="flex flex-wrap items-baseline gap-x-2 text-[11px]"
                          >
                            <span className="font-mono font-semibold text-slate-700">
                              {codeOf(c.fixtureId)}
                            </span>
                            {/* The localized taxonomy label first, the engine's
                                raw detail only as muted supplementary text —
                                the shape ai-diff-panel.tsx:156 uses. */}
                            <span className="font-medium text-red-600">
                              {conflictLabel(c.reason)}
                            </span>
                            {c.detail && <span className="text-slate-500">{c.detail}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* What the run could not place, in its own words. */}
                {plan.unschedulable.length > 0 && (
                  <div className="rounded-lg border-2 border-[var(--mk-orange)]/40 bg-orange-50/60 p-3">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-orange-800">
                      <span aria-hidden>⚠</span>
                      {t("scheduling.aidemo.unschedulable.title")}
                    </p>
                    <p className="mt-0.5 text-[11px] text-orange-800/80">
                      {t("scheduling.aidemo.unschedulable.hint")}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {plan.unschedulable.map((u) => (
                        <li
                          key={u.fixture_id}
                          data-ai-unschedulable="row"
                          data-fixture-id={u.fixture_id}
                          className="rounded-md border border-orange-200 bg-white px-2 py-1.5 text-[11px]"
                        >
                          <span className="mr-2 font-mono font-semibold text-slate-700">
                            {codeOf(u.fixture_id)}
                          </span>
                          <span className="text-slate-600">{u.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* A repair is SCOPED, but `computeAiDiff` compares the whole
                    board: any placed fixture missing from the proposal lands in
                    the unscheduled group, including the 11 already-played
                    matches the run was never allowed to move. That is the
                    product's behaviour and the panel must keep it — so the
                    section explains it rather than filtering the diff and
                    showing a demo the console would not. Suppressed when the
                    run could move everything, where there is nothing to explain. */}
                {fixture.movableIds.length < fixture.board.fixtures.length && (
                  <p
                    data-ai-scope="note"
                    className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-[11px] leading-relaxed text-slate-500"
                  >
                    {t("scheduling.aidemo.scopeNote", {
                      movable: fixture.movableIds.length,
                      total: fixture.board.fixtures.length,
                    })}
                  </p>
                )}

                {/* The product's own change list — provenance, notes and all. */}
                <div className="overflow-x-auto">
                  <AiDiffPanel
                    plan={plan}
                    fixtures={fixture.board.fixtures}
                    excluded={excluded}
                    onToggleExclude={(id) =>
                      setExcluded((prev) =>
                        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                      )
                    }
                  />
                </div>

                {/* The price, recomputed — never a number typed into the page. */}
                {quote && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                    <p
                      data-ai-price="run"
                      data-credits={String(quote.credits)}
                      data-discount={String(quote.discount)}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                    >
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {t("scheduling.aidemo.price.label")}
                      </span>
                      <span className="mk-display text-lg font-bold text-violet-700">
                        {plural("scheduling.aidemo.price.credits", quote.credits)}
                      </span>
                      {quote.discount > 0 && (
                        <span className="text-[11px] text-teal-700">
                          {plural("scheduling.aidemo.price.joint", quote.discount, {
                            divisions: ledger.length,
                          })}
                        </span>
                      )}
                    </p>
                    {trace && (
                      <button
                        type="button"
                        onClick={() => {
                          setShown(0);
                          setReplays((n) => n + 1);
                        }}
                        className="min-h-11 rounded-lg border border-violet-200 px-3 text-xs font-semibold text-violet-700 hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                      >
                        {t("scheduling.aidemo.replay")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
