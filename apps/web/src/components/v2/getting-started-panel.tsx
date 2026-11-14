// The getting-started panel (/start "Sent stepper", owner-approved 2026-11-14, mock sss14a section 4): where the funnel claim
// lands (the division page, lib/funnel.ts createFromDraft), the organiser sees the Sent screen's five steps carried on — step 1
// ticked, each later step ticked from real state (server/usecases/getting-started.ts), the first step not done highlighted
// with its way on. Shown only for a competition a /start draft built and only until a match is scheduled
// (lib/getting-started-steps.ts landingSteps: no target, or a match on the schedule, renders nothing).
//
// An async SERVER component that does its own read, so the division page mounts it as an element: the page's tests render
// the page one level deep and never run this read (they mock the page's own usecases, not this one). The read stops at the
// draft for a competition no /start draft built (`funnelGettingStarted`, review I2), and a read that fails renders nothing
// and is logged: the panel is a helper on the division page and never takes the page down with it.
import { ListChecks } from "lucide-react";
import type { EntrantKind } from "@seazn/engine/sport";
import { GettingStartedStepper, type StepperItem } from "@/components/getting-started-stepper";
import { GETTING_STARTED_STEPS, landingSteps, scheduleHint, type GettingStartedStep } from "@/lib/getting-started-steps";
import { plural, t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { funnelGettingStarted, type GettingStarted } from "@/server/usecases/getting-started";

/** Step 3's words by what the division takes (review m2): a field of players, of teams or of pairs. Literal keys, one family
 *  per kind. */
const FIELD_WORDS: Record<EntrantKind, { title: string; progress: string; action: string }> = {
  individual: { title: "start.next.players.title", progress: "start.next.players.progress", action: "start.next.action.players" },
  team: { title: "start.next.teams.title", progress: "start.next.teams.progress", action: "start.next.action.teams" },
  pair: { title: "start.next.pairs.title", progress: "start.next.pairs.progress", action: "start.next.action.pairs" },
};

export interface GettingStartedPanelProps {
  auth: AuthCtx;
  competition: { id: string; name: string; starts_on: string | null };
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  /** The club's live courts (venues and courts not archived): step 5 names them when there are any. */
  courts: number;
  /** What the division takes by default (the engine's entrant model, as the page computes it): step 3's noun. */
  entrantKind: EntrantKind;
  dict: Dict;
  locale: Locale;
}

export async function GettingStartedPanel({
  auth,
  competition,
  orgSlug,
  compSlug,
  divSlug,
  courts,
  entrantKind,
  dict,
  locale,
}: GettingStartedPanelProps) {
  let progress: GettingStarted | null;
  try {
    progress = await funnelGettingStarted(auth, competition.id);
  } catch (err) {
    log.error({ event: "getting_started_failed", competitionId: competition.id, err }, "getting_started_failed");
    return null;
  }
  if (progress === null) return null;
  const setup = landingSteps(progress);
  if (setup === null) return null;

  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const schedule = scheduleHint(courts, competition.starts_on);
  const field = FIELD_WORDS[entrantKind];
  const words: Record<GettingStartedStep, { title: string; hint: string }> = {
    open: { title: t(dict, "start.next.open.title"), hint: t(dict, "start.next.open.hint") },
    rename: { title: t(dict, "start.next.rename.title"), hint: t(dict, "start.next.rename.hint") },
    players: {
      title: t(dict, field.title),
      // `target` is set: landingSteps shows nothing without one.
      hint: t(dict, field.progress, { count: progress.entrants.count, target: progress.entrants.target ?? 0 }),
    },
    generate: { title: t(dict, "start.next.generate.title"), hint: t(dict, "start.next.generate.hint") },
    schedule: {
      title: t(dict, "start.next.schedule.title"),
      hint: t(dict, schedule.key, {
        ...(schedule.vars.courts !== undefined ? { courts: plural(dict, "start.next.courts", schedule.vars.courts, locale) } : {}),
        ...(schedule.vars.date !== undefined ? { date: day(schedule.vars.date) } : {}),
      }),
    },
  };
  // Each step's way on: where the step is done. Step 1 is ticked here by definition (this page is past the link).
  const actions: Partial<Record<GettingStartedStep, { href: string; label: string }>> = {
    rename: { href: routes.orgSettings(orgSlug), label: t(dict, "start.next.action.rename") },
    players: { href: `${routes.division(orgSlug, compSlug, divSlug, "entrants")}#add-entrant`, label: t(dict, field.action) },
    generate: { href: routes.division(orgSlug, compSlug, divSlug, "fixtures"), label: t(dict, "start.next.action.generate") },
    schedule: { href: routes.divisionSchedule(orgSlug, compSlug, divSlug), label: t(dict, "start.next.action.schedule") },
  };
  const items: StepperItem[] = setup.steps.map((row) => {
    const action = row.state === "current" ? actions[row.key] : undefined;
    return { ...row, ...words[row.key], ...(action ? { action } : {}) };
  });

  return (
    <section aria-labelledby="getting-started-title" data-getting-started className="card mb-6 min-w-0 p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
        <ListChecks aria-hidden className="h-4 w-4 flex-none text-purple-500" />
        <h2 id="getting-started-title" className="min-w-0 flex-1 break-words text-sm font-semibold text-slate-800">
          {t(dict, "start.next.landing.title", { name: competition.name })}
        </h2>
        <span data-getting-started-done={setup.done} className="whitespace-nowrap text-[13px] text-slate-500">
          {t(dict, "start.next.landing.done", { done: setup.done, total: GETTING_STARTED_STEPS.length })}
        </span>
      </div>
      <GettingStartedStepper
        items={items}
        label={t(dict, "start.next.title")}
        nowLabel={t(dict, "start.next.now")}
        doneLabel={t(dict, "start.next.doneLabel")}
        tone="light"
        across
      />
    </section>
  );
}
