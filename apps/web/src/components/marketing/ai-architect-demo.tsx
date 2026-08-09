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
import type { AiConsoleFixture } from "@/components/v2/board/ai-diff";
import { quoteRun, type Quote, type Rung, type RungWeights } from "@/lib/ai-rung";
import type { Locale } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime, type TKey } from "@/lib/i18n-runtime";
import type { AiDemoFixture } from "@/demo/ai-templates/types";
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
/** The capture writes the board rows straight off the fixtures table, so the
 *  entrant ids ride along even though `AiConsoleFixture` has no use for them.
 *  Needed to size a per-division quote line; if a future capture drops them the
 *  joint credits stop matching the recorded ones and the suite reds. */
type BoardRow = AiConsoleFixture & { home_entrant_id?: string; away_entrant_id?: string };

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
    (key: string, count: number) => pluralRuntime(dict, key, count, locale, { n: count }),
    [dict, locale],
  );

  const [slug, setSlug] = useState<Slug>(SLUGS[0]);
  const [fixture, setFixture] = useState<AiDemoFixture | null>(null);
  const [shown, setShown] = useState(0);
  const [replays, setReplays] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const wanted = useRef<Slug>(SLUGS[0]);
  const reduced = usePrefersReducedMotion();

  // Load the picked recording. `wanted` settles the race a fast second click
  // creates: two chunks in flight, and the slower one must not win.
  useEffect(() => {
    wanted.current = slug;
    void LOADERS[slug]()
      .then((mod) => {
        if (wanted.current !== slug) return;
        setFixture(mod.default as AiDemoFixture);
        setShown(0);
        setExcluded([]);
      })
      .catch(() => {
        // A chunk that never arrives leaves the screen on its loading line.
        // There is nothing an organiser could do about it from here.
      });
  }, [slug]);

  const plan = (fixture?.response ?? null) as DemoPlan | null;
  const joint = Boolean(plan?.divisions?.length);

  // The referee trace, composed by the console's own composer over the recorded
  // response — never a script written for the demo.
  const trace = useMemo(() => {
    if (!fixture || !plan || joint) return null;
    return buildScheduleTrace(plan, fixture.board.courts.length, t);
  }, [fixture, plan, joint, t]);

  const total = trace?.events.length ?? 0;
  const revealed = reduced ? total : Math.min(shown, total);

  useEffect(() => {
    if (reduced || shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), REPLAY_MS);
    return () => clearTimeout(id);
  }, [reduced, shown, total]);

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

  const quote: Quote | null = useMemo(() => {
    if (!fixture || !plan) return null;
    const courts = fixture.board.courts.length;
    if (plan.divisions?.length) {
      // One priced line per division, exactly as the competition endpoint
      // quotes a joint run — the Σ−1 batch discount is `quoteRun`'s, not ours.
      const entrants = new Map<string, Set<string>>();
      for (const row of fixture.board.fixtures as BoardRow[]) {
        if (!row.division_id) continue;
        const set = entrants.get(row.division_id) ?? new Set<string>();
        if (row.home_entrant_id) set.add(row.home_entrant_id);
        if (row.away_entrant_id) set.add(row.away_entrant_id);
        entrants.set(row.division_id, set);
      }
      return quoteRun(
        plan.divisions.map((d) => ({
          key: d.id,
          input: {
            movableFixtures: d.movable,
            entrants: entrants.get(d.id)?.size ?? 0,
            courts,
          },
        })),
        weights,
      );
    }
    return quoteRun(
      [
        {
          key: fixture.meta.slug,
          input: {
            movableFixtures: fixture.movableIds.length,
            entrants: fixture.board.entrants.length,
            courts,
          },
        },
      ],
      weights,
    );
  }, [fixture, plan, weights]);

  const codeOf = useCallback(
    (id: string) => fixture?.board.fixtures.find((f) => f.id === id)?.code ?? id.slice(0, 8),
    [fixture],
  );

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
        onClick={() => setSlug(s)}
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
        <div className="mt-6 overflow-hidden rounded-2xl border border-[#4a3885] bg-[var(--mk-night-2)] p-1.5">
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
                {t("scheduling.aidemo.recordedMeta", {
                  model: fixture.meta.model,
                  date: capturedOn,
                })}
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
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-slate-500">
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
                    {plan.divergent_courts && plan.divergent_courts.length > 0 && (
                      <p
                        data-ai-divergent="courts"
                        className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800"
                      >
                        {t("scheduling.aidemo.divergentCourts", {
                          courts: plan.divergent_courts.join(", "),
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
                            className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-slate-600"
                          >
                            <span className="font-mono font-semibold text-slate-700">
                              {codeOf(c.fixtureId)}
                            </span>
                            <span>{c.detail || c.reason}</span>
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
                          {t("scheduling.aidemo.price.joint", {
                            divisions: ledger.length,
                            discount: quote.discount,
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
