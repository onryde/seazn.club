// The getting-started panel (/start "Sent stepper", owner-approved 2026-11-14, mock sss14a section 4): where the funnel claim
// lands (the division page, lib/funnel.ts createFromDraft), the organiser sees the Sent screen's five steps carried on — step 1
// ticked, each later step ticked from real state (server/usecases/getting-started.ts), the first step not done highlighted
// with its way on. Shown only for a competition a /start draft built and only until a match is scheduled
// (lib/getting-started-steps.ts landingSteps: no target, or a match on the schedule, renders nothing).
//
// An async SERVER component that does its own read, so the division page mounts it as an element: the page's tests render
// the page one level deep and never run this read (they mock the page's own usecases, not this one).
import { ListChecks } from "lucide-react";
import { GettingStartedStepper, type StepperItem } from "@/components/getting-started-stepper";
import { GETTING_STARTED_STEPS, landingSteps, scheduleHint, type GettingStartedStep } from "@/lib/getting-started-steps";
import { plural, t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import type { AuthCtx } from "@/server/api-v1/auth";
import { gettingStarted } from "@/server/usecases/getting-started";

export interface GettingStartedPanelProps {
  auth: AuthCtx;
  competition: { id: string; name: string; starts_on: string | null };
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  /** The club's live courts (venues and courts not archived): step 5 names them when there are any. */
  courts: number;
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
  dict,
  locale,
}: GettingStartedPanelProps) {
  const progress = await gettingStarted(auth, competition.id);
  const setup = landingSteps(progress);
  if (setup === null) return null;

  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const schedule = scheduleHint(courts, competition.starts_on);
  const words: Record<GettingStartedStep, { title: string; hint: string }> = {
    open: { title: t(dict, "start.next.open.title"), hint: t(dict, "start.next.open.hint") },
    rename: { title: t(dict, "start.next.rename.title"), hint: t(dict, "start.next.rename.hint") },
    players: {
      title: t(dict, "start.next.players.title"),
      // `target` is set: landingSteps shows nothing without one.
      hint: t(dict, "start.next.players.progress", { count: progress.entrants.count, target: progress.entrants.target ?? 0 }),
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
    players: { href: `${routes.division(orgSlug, compSlug, divSlug, "entrants")}#add-entrant`, label: t(dict, "start.next.action.players") },
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
