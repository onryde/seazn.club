"use client";

// D3 schedule health panel (design doc bench-product-value/designs/
// 2026-08-13-schedule-health-design.md) — five per-metric bars 0-100 with
// expandable offender lists. Report-only: blocks nothing, gates nothing.
//
// Unlike CapacityCard (a pure presentational component fed a client-side
// `useMemo` recompute), this panel FETCHES its own data: health scores the
// APPLIED schedule, which is server truth, not local draft state — there is
// no client-side `assessHealth` recompute to mirror here the way the
// capacity precheck mirrors the setup card's live knobs.
//
// The engine lib emits STRUCTURED explanations (`{key, params}`), never
// English prose — this component is the ONE place that turns those into
// copy, via `msg()`, exactly like CapacityCard's `suggestionLabel` owns all
// of ITS text (see health.ts's HealthExplanation doc comment).
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, HeartPulse, Info } from "lucide-react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

export type HealthMetricKey =
  | "restSpread"
  | "courtBalance"
  | "gapDispersion"
  | "homeAwayAlternation"
  | "primeSlotFairness";

export interface HealthOffenderWire {
  kind: "entrant" | "court" | "courtDay";
  id: string;
  label: string;
  value: number;
}

export interface HealthMetricWire {
  key: HealthMetricKey;
  score: number;
  explanation: { key: string; params?: Record<string, number> };
  offenders: HealthOffenderWire[];
}

export interface ScheduleHealthReportWire {
  stageId: string;
  computedAt: string;
  metrics: HealthMetricWire[];
}

const METRIC_TITLE_KEY: Record<HealthMetricKey, MessageKey> = {
  restSpread: "schedule.health.metric.restSpread",
  courtBalance: "schedule.health.metric.courtBalance",
  gapDispersion: "schedule.health.metric.gapDispersion",
  homeAwayAlternation: "schedule.health.metric.homeAwayAlternation",
  primeSlotFairness: "schedule.health.metric.primeSlotFairness",
};

/** Which unit template an offender's raw `value` renders through — each
 *  metric's value is a DIFFERENT unit (minutes, a court count, a run
 *  length, a signed deviation); see health.ts's per-metric offender
 *  comments for exactly what each number means. */
const OFFENDER_UNIT_KEY: Record<HealthMetricKey, MessageKey> = {
  restSpread: "schedule.health.unit.minutes",
  courtBalance: "schedule.health.unit.courts",
  gapDispersion: "schedule.health.unit.minutes",
  homeAwayAlternation: "schedule.health.unit.runLength",
  primeSlotFairness: "schedule.health.unit.deviation",
};

const OFFENDER_KIND_KEY: Record<HealthOffenderWire["kind"], MessageKey> = {
  entrant: "schedule.health.offenderKind.entrant",
  court: "schedule.health.offenderKind.court",
  courtDay: "schedule.health.offenderKind.courtDay",
};

/** Each bar is a different formula over a different unit, and the one-line
 *  explanation under it reports the OFFENDER COUNT, not what is being
 *  measured — so a card can read "0 entrants have long same-side runs" next
 *  to a score of 57 and look self-contradictory. It is not: that score is
 *  `100·mean(alternation rate) − 10·(longest run over 3)`, which a merely
 *  mediocre overall rate drags down without any single entrant crossing the
 *  offender threshold. These keys are where that distinction is explained.
 *
 *  The copy lives in `config/tips.ts` under `tips.schedule.health.*` and is
 *  mirrored into the four dictionaries like every other tip, so there is
 *  still exactly one source for it (dictionary-copy-truth asserts the two
 *  agree). What is NOT reused is `<Tip>`'s popover: it is a fixed `w-64`
 *  anchored to the ⓘ itself, and neither of its two alignments survives
 *  this host. `small` right-aligns, which shoved the panel off the left
 *  edge of the viewport at 1280 (verified by screenshot); centring clips
 *  the other way at 320, where the popover is nearly as wide as the screen.
 *  No static alignment can work for an icon that sits anywhere in a
 *  five-card responsive grid, and reshaping a component 32 other tips
 *  depend on is the wrong blast radius for this. Rendered inline instead —
 *  which also beats a popover that would cover the neighbouring cards. */
const METRIC_TIP_BODY_KEY: Record<HealthMetricKey, MessageKey> = {
  restSpread: "tips.schedule.health.restSpread.body",
  courtBalance: "tips.schedule.health.courtBalance.body",
  gapDispersion: "tips.schedule.health.gapDispersion.body",
  homeAwayAlternation: "tips.schedule.health.homeAwayAlternation.body",
  primeSlotFairness: "tips.schedule.health.primeSlotFairness.body",
};

function scoreTone(score: number): { bar: string; track: string; text: string } {
  if (score >= 80) return { bar: "bg-emerald-500", track: "bg-emerald-100", text: "text-emerald-700" };
  if (score >= 50) return { bar: "bg-amber-500", track: "bg-amber-100", text: "text-amber-700" };
  return { bar: "bg-red-500", track: "bg-red-100", text: "text-red-700" };
}

function MetricCard({ metric, stageId }: { metric: HealthMetricWire; stageId: string }) {
  const msg = useMsg();
  const [expanded, setExpanded] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const tone = scoreTone(metric.score);
  // Scoped by STAGE as well as metric: schedule/page.tsx renders one
  // HealthPanel per stage and mounts them all at once, so a division with
  // two stages emitted two elements with id="health-about-restSpread" and
  // every aria-controls after the first pointed at the wrong stage's
  // paragraph. Invisible to a single-stage screenshot and to the
  // single-stage e2e fixture, which is why it shipped.
  const aboutId = `health-about-${stageId}-${metric.key}`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" data-health-metric={metric.key} data-health-score={metric.score}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1 text-sm font-medium text-slate-800">
          <span className="min-w-0">{msg(METRIC_TITLE_KEY[metric.key])}</span>
          <button
            type="button"
            aria-expanded={aboutOpen}
            aria-controls={aboutId}
            aria-label={msg("schedule.health.about", { metric: msg(METRIC_TITLE_KEY[metric.key]) })}
            onClick={() => setAboutOpen((v) => !v)}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 transition hover:text-purple-600"
            data-health-about={metric.key}
          >
            <Info className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </p>
        <span className={`text-sm font-semibold tabular-nums ${tone.text}`}>{metric.score}</span>
      </div>
      {aboutOpen && (
        <p
          id={aboutId}
          role="note"
          className="mt-2 rounded-lg bg-slate-50 p-2 text-xs leading-relaxed text-slate-600"
        >
          {msg(METRIC_TIP_BODY_KEY[metric.key])}
        </p>
      )}
      <div className={`mt-2 h-1.5 w-full overflow-hidden rounded-full ${tone.track}`} role="presentation">
        <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(0, Math.min(100, metric.score))}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {msg(metric.explanation.key as MessageKey, metric.explanation.params)}
      </p>
      {metric.offenders.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-xs font-medium text-purple-700 hover:underline"
            aria-expanded={expanded}
          >
            {msg(expanded ? "schedule.health.offenders.hide" : "schedule.health.offenders.show")}
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expanded && (
            <ul className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5">
              {metric.offenders.map((o) => (
                <li key={`${o.kind}:${o.id}`} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                  <span>
                    {msg(OFFENDER_KIND_KEY[o.kind])} · {o.label}
                  </span>
                  <span className="tabular-nums text-slate-400">{msg(OFFENDER_UNIT_KEY[metric.key], { value: o.value })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        // Review finding #6: this key existed in all 4 dictionaries but was
        // never read — a metric with nothing to flag rendered no offender
        // section at all, silently, rather than confirming there is
        // genuinely nothing wrong.
        <p className="mt-2 text-xs text-slate-400" data-health-offenders-empty="">
          {msg("schedule.health.offenders.empty")}
        </p>
      )}
    </div>
  );
}

/** The schedule page's tab strip is a SERVER component (Link elements, no
 *  hooks) — this is the one label on it that needs a real translation
 *  (the other five are still the raw hardcoded-English tab id via CSS
 *  `capitalize`, pre-existing and out of this session's scope). Calling
 *  `resolveLocale()`/`getDictionary()` server-side in the page itself was
 *  tried first and reds an existing page test: it calls the server
 *  component directly (no request scope), and `next/headers`' `cookies()`
 *  throws outside one. A tiny client leaf sidesteps that entirely — the
 *  page-test style here inspects the returned element tree without
 *  rendering it, so a nested client component's hooks are never invoked
 *  and the existing test stays green. */
export function HealthTabLabel() {
  const msg = useMsg();
  return <>{msg("schedule.health.tabLabel")}</>;
}

export interface HealthPanelProps {
  stageId: string;
  /** Shown above the bars — "Group stage", "Playoff bracket", etc, so a
   *  division with several stages can tell which one each panel is about. */
  stageLabel?: string;
}

export function HealthPanel({ stageId, stageLabel }: HealthPanelProps) {
  const msg = useMsg();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "empty" }
    | { status: "error" }
    | { status: "ready"; report: ScheduleHealthReportWire }
  >({ status: "loading" });

  useEffect(() => {
    // No synchronous setState("loading") here: the initial useState value
    // already is "loading", and this component is always mounted with
    // `key={stageId}` (health-panel.tsx's caller maps one panel per stage),
    // so a stageId change remounts a fresh instance rather than reusing this
    // one — there is no "loading" reset to perform mid-life.
    let live = true;
    void apiV1<ScheduleHealthReportWire>(`/api/v1/stages/${stageId}/schedule/health`)
      .then((report) => {
        if (live) setState({ status: "ready", report });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiV1Error && err.code === "SCHEDULE_NOT_APPLIED") setState({ status: "empty" });
        else setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [stageId]);

  return (
    <section className="card space-y-3 p-5" data-health-panel={stageId} data-health-status={state.status}>
      <div className="flex items-center gap-1.5">
        <HeartPulse className="h-4 w-4 text-slate-500" strokeWidth={1.75} />
        <h4 className="text-sm font-semibold text-slate-700">{msg("schedule.health.title")}</h4>
        {stageLabel && <span className="text-xs text-slate-400">· {stageLabel}</span>}
      </div>

      {state.status === "loading" && <p className="text-xs text-slate-400">{msg("schedule.health.loading")}</p>}
      {state.status === "empty" && <p className="text-xs text-slate-400">{msg("schedule.health.empty")}</p>}
      {state.status === "error" && <p className="text-xs text-red-600">{msg("schedule.health.error")}</p>}
      {state.status === "ready" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {state.report.metrics.map((m) => (
            <MetricCard key={m.key} metric={m} stageId={stageId} />
          ))}
        </div>
      )}
    </section>
  );
}
