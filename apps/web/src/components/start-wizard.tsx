"use client";

// /start, the organiser's setup (start-wizard redesign, plan 2026-11-13 Task 4; owner-approved Option B of mock swr13a01):
// four questions — Sport, Size and format, Date, Email — then Sent, in the house night look of /play. One DOM: phones read
// a progress bar and "Step n of 4"; from `md` the answers pile up in a rail on the left. Every rule (what Next allows, which
// card is selected, the body posted) is start-wizard-model.ts's; this file renders it and dispatches to it.
//
// Sent (/start "Sent stepper", owner-approved 2026-11-14, mock sss14a section 1 Option A): the address, the draft's reference
// (printed in the email too), the summary of what the link builds, and the five steps ahead (lib/getting-started-steps.ts).
// "Change it" reopens Email with every answer kept and the Change-email banner (mock section 2); the resend carries the first
// answer's reference and replace key (`sendBody`), so the earlier link stops working and the reference stays.
//
// The format cards are T1's one layer (`rankFormats` at the sport's match length, at the field the claim will build), so a
// card's numbers are the event the emailed link builds. Its "≈" hours are the shortest day the schedule can reach.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Check, ChevronDown, Info, Mail, Minus, Plus } from "lucide-react";
import { api, ApiError } from "@/lib/client";
import { FUNNEL_MORE_FORMATS, funnelFormatMin, type FunnelFormat } from "@/lib/funnel-formats";
import { bestFitSlug, type RankedFormat } from "@/lib/format-recommend";
import { routes } from "@/lib/routes";
import { isTurnstileRefusal } from "@/lib/turnstile";
import { withTurnstile } from "@/lib/turnstile-client";
import { LegalNotice } from "@/components/legal-notice";
import { useLocale, usePlural, useT } from "@/components/i18n/dict-provider";
import { TurnstileWidget, useTurnstile } from "@/components/turnstile-widget";
import { GettingStartedStepper, type StepperItem } from "@/components/getting-started-stepper";
import { LOCALE_LABELS } from "@/components/i18n/locale-switcher";
import { scheduleHint, sentSteps, type GettingStartedStep } from "@/lib/getting-started-steps";
import type { StartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import {
  FORMAT_NAME_KEY,
  FORMAT_TAGLINE_KEY,
  WIZARD_BOUNDS,
  WIZARD_STEPS,
  buildFunnelBody,
  canAdvance,
  heldStart,
  keptReference,
  initialWizardState,
  nextEventDays,
  parseCount,
  plausibleEmail,
  sendBody,
  sportLabelKey,
  wizardCards,
  wizardField,
  wizardQuery,
  wizardReducer,
  type HeldStart,
  type WizardContext,
  type WizardState,
} from "./start-wizard-model";

export interface StartWizardProps {
  /** The link's prefill (start/prefill.ts `parseStartPrefill`): never a raw query value. */
  initial: StartPrefill;
  /** The free plan's entrants per division (`funnelEntrantCap`), null = unlimited. */
  maxEntrants: number | null;
  /** The page's today (`wizardToday`, the UTC day less one): the earliest first day a link or a pick may carry. */
  today: string;
  /** The server's real UTC day (`funnelUtcDay`): where the date chips and the date box begin (review-t4 m1). */
  utcDay: string;
  /** The sports /play offers a quick match of: the Sent screen's "score a quick match" shows for these only. */
  playSports: readonly string[];
}

// ---- house night tokens (as /play's setup form) --------------------------------------------------------------------
const LABEL = "block text-xs font-semibold text-[#b7aede]";
const HELP = "text-xs leading-relaxed text-[#8d7fc0]";
const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]";
const PEER_FOCUS =
  "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--mk-lime)]";
const CHIP = `flex min-h-11 cursor-pointer items-center rounded-full border border-[#3b2a6e] bg-[rgb(36_22_80/0.7)] px-3.5 text-sm text-[#e8e2fb] transition hover:border-[#5b4a9e] peer-checked:border-[var(--mk-lime)] peer-checked:bg-[var(--mk-lime)] peer-checked:font-semibold peer-checked:text-[var(--mk-night)] ${PEER_FOCUS}`;
const PRIMARY = `flex min-h-[52px] flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--mk-lime)] px-5 text-base font-bold text-[var(--mk-night)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const GHOST = `flex min-h-[52px] flex-none items-center justify-center rounded-xl border border-[#3b2a6e] px-5 text-sm font-semibold text-[var(--mk-cream)] transition hover:border-[#5b4a9e] ${FOCUS}`;
const INPUT = `min-h-12 w-full min-w-0 rounded-[10px] border border-[#3b2a6e] bg-[#160c3a] px-3.5 text-[var(--mk-cream)] placeholder:text-[#7d71ad] ${FOCUS}`;
const TICKET = "rounded-2xl border border-[#3b2a6e] bg-[rgb(36_22_80/0.55)] px-4 py-3 text-left";

const MORE: ReadonlySet<FunnelFormat> = new Set(FUNNEL_MORE_FORMATS);

/** What the last send left: the dev claim link (a dev server only), the pair a resend carries back (never in the URL), and
 *  whether that send was itself a resend. Null until the first send: then Email is the first-time step, after it the
 *  Change-email one. */
type Sent = { claimUrl: string | null; held: HeldStart | null; referenceKept: boolean };

export function StartWizard({ initial, maxEntrants, today, utcDay, playSports }: StartWizardProps) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocale();
  const turnstile = useTurnstile("start");
  const ctx: WizardContext = useMemo(() => ({ maxEntrants, today }), [maxEntrants, today]);
  const [s, dispatch] = useReducer(
    (state: WizardState, action: Parameters<typeof wizardReducer>[1]) => wizardReducer(state, action, ctx),
    initial,
    (p) => initialWizardState(p, ctx),
  );
  // A reload of the wizard's own URL can arrive with Planning open (its courts and hours ride the query).
  const [foldOpen, setFoldOpen] = useState(() => s.planningOpen);
  const [moreOpen, setMoreOpen] = useState(initial.format !== null && MORE.has(initial.format));
  const [picking, setPicking] = useState(() => s.date !== null && !nextEventDays(utcDay).includes(s.date));
  const [emailTouched, setEmailTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const firstStep = useRef(true);

  // The answers ride the page's own URL (review-t4 (a)): a refresh or Back to /start restores them, and Next replays to the
  // step. Replaced, never pushed (a history entry per answer is a later change), and never the name or the address —
  // PostHog and Sentry record page URLs (`wizardQuery`). Landing leaves the URL as it came until the organiser answers.
  const query = wizardQuery(s);
  const firstQuery = useRef(true);
  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false;
      return;
    }
    if (typeof window === "undefined") return;
    window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
  }, [query]);

  // A new step moves focus to its question, so a screen reader hears where it is; the first render keeps the page's own.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [s.step]);

  const cards = wizardCards(s, ctx);
  const field = wizardField(s.entrants, maxEntrants);
  const capped = field < s.entrants;
  const selected: RankedFormat | undefined = cards.find((c) => c.slug === s.format && c.available);
  // The badge is T1's Best fit of the cards on screen, not the state's selection (which may be the organiser's own pick).
  const bestFit = bestFitSlug(cards);
  const sportName = t(sportLabelKey(s.sportKey));
  const isOther = FUNNEL_SPORTS.find((x) => x.key === s.sportKey)?.module === "generic";
  const defaultName = isOther ? t("start.wizard.compNameDefaultOther") : t("start.wizard.compNameDefault", { sport: sportName });
  const eventName = s.name.trim() || defaultName;
  const hours = (h: number) => t("start.wizard.estHours", { hours: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(h) });
  const formatLine = (c: RankedFormat) => `${t(FORMAT_NAME_KEY[c.slug])} · ${plural("start.wizard.matchesCount", c.matches)}`;
  const dayLabel = (iso: string, withYear = false) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );
  const players = (n: number) => plural("start.wizard.playersCount", n);
  const playersValue = capped ? t("start.wizard.playersCapped", { field, entrants: s.entrants }) : String(s.entrants);
  // Planning opened: the claim will build these courts (the body carries them, `buildFunnelBody`), so both summaries say so,
  // worded as the fold's own header words them (review-whole m3). Never opened: no row, and no courts built.
  const planningRow: readonly (readonly [string, string])[] = s.planningOpen
    ? [[t("start.wizard.planning"), `${plural("start.wizard.courtsCount", s.courts)} · ${plural("start.wizard.hoursCount", s.hours)}`]]
    : [];
  const emailState = plausibleEmail(s.email);
  const showEmailError = emailTouched && emailState !== "ok";

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setEmailTouched(true);
    // B4's own Next rule (canAdvance at Email: the route's address rule), the one the dictionary's errors word.
    if (!canAdvance(s, ctx)) {
      emailInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await withTurnstile(turnstile, (headers) =>
        api<{ claim_url?: unknown }>("/api/funnel/start", {
          method: "POST",
          json: sendBody(buildFunnelBody(s, locale, defaultName), sent?.held ?? null),
          headers,
        }),
      );
      const held = heldStart(res);
      setSent({
        claimUrl: typeof res?.claim_url === "string" ? res.claim_url : null,
        held,
        referenceKept: keptReference(sent?.held ?? null, held),
      });
      dispatch({ type: "sent" });
    } catch (err) {
      setError(
        isTurnstileRefusal(err)
          ? t("turnstile.error")
          : err instanceof ApiError && err.status === 429
            ? t("start.wizard.tooMany")
            : t("start.wizard.genericError"),
      );
    } finally {
      setBusy(false);
    }
  }

  // One summary for B4 and Sent, in the mock's order (sport, format, players, courts, first day, language): the change-email
  // step shows the answers the Sent screen showed. B4's format line adds the estimate; Sent's first day adds the year.
  const summaryRows = (where: "email" | "sent"): readonly (readonly [string, string])[] => [
    [t("start.wizard.sport"), sportName],
    [
      t("start.wizard.format"),
      selected ? (where === "email" ? `${formatLine(selected)} ${hours(selected.estHours)}` : formatLine(selected)) : "—",
    ],
    [t("start.wizard.summary.players"), playersValue],
    ...planningRow,
    [t("start.wizard.firstDay"), s.date ? dayLabel(s.date, where === "sent") : t("start.wizard.notSure")],
    [t("start.wizard.language"), LOCALE_LABELS[locale]],
  ];
  // Step 5 names the courts only when Planning was opened (only then does the claim build them) and the first day only when
  // one was picked.
  const schedule = scheduleHint(s.planningOpen ? s.courts : null, s.date);
  const stepWords: Record<GettingStartedStep, { title: string; hint: string }> = {
    open: { title: t("start.next.open.title"), hint: t("start.next.open.hint") },
    rename: { title: t("start.next.rename.title"), hint: t("start.next.rename.hint") },
    players: { title: t("start.next.players.title"), hint: t("start.next.players.hint", { target: field }) },
    generate: {
      title: t("start.next.generate.title"),
      hint: selected
        ? t("start.next.generate.hintFormat", { format: t(FORMAT_NAME_KEY[selected.slug]) })
        : t("start.next.generate.hint"),
    },
    schedule: {
      title: t("start.next.schedule.title"),
      hint: t(schedule.key, {
        ...(schedule.vars.courts !== undefined ? { courts: plural("start.next.courts", schedule.vars.courts) } : {}),
        ...(schedule.vars.date !== undefined ? { date: dayLabel(schedule.vars.date) } : {}),
      }),
    },
  };
  const stepItems: StepperItem[] = sentSteps().map((row) => ({ ...row, ...stepWords[row.key] }));

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    dispatch({ type: "next" });
  };
  const back = () => dispatch({ type: "back" });

  // ---- Sent (mock sss14a section 1, Option A: one column at every width) -------------------------------------------
  if (s.step === "sent") {
    const [before, after] = t("start.wizard.sentTo").split("{email}");
    const [wrongBefore, wrongAfter] = t("start.wizard.wrongAddress").split("{link}");
    const [waitBefore, waitAfter] = t("start.wizard.whileYouWait").split("{link}");
    const reference = sent?.held?.reference ?? null;
    const [refBefore, refAfter] = t("start.wizard.reference").split("{reference}");
    return (
      <div data-start-wizard data-step="sent" className="mx-auto w-full max-w-xl px-4 md:max-w-2xl">
        <h1 className="sr-only">{t("start.heading")}</h1>
        <div data-funnel-done role="status" className="text-center">
          <div aria-hidden className="mx-auto grid h-16 w-16 place-items-center rounded-[18px] bg-[rgb(163_230_53/0.14)] text-[var(--mk-lime)]">
            <Mail className="h-8 w-8" strokeWidth={1.8} />
          </div>
          <h2 ref={heading} tabIndex={-1} className="mk-display mt-4 text-4xl font-bold leading-none outline-none md:text-5xl">
            {t("start.wizard.checkEmail")}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[15px] text-[#b7aede] [overflow-wrap:anywhere]">
            {before}
            <b className="font-semibold text-[var(--mk-cream)]">{s.email.trim()}</b>
            {after}{" "}
            <span className="whitespace-nowrap">
              {wrongBefore}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  dispatch({ type: "changeEmail" });
                }}
                className={`inline-flex min-h-11 items-center font-semibold text-[var(--mk-lime)] underline underline-offset-4 ${FOCUS}`}
              >
                {t("start.wizard.changeIt")}
              </button>
              {wrongAfter}
            </span>
          </p>
          {reference ? (
            <>
              <p
                data-funnel-reference={reference}
                className="mt-2 inline-flex flex-wrap items-center justify-center gap-x-2 rounded-[10px] border border-dashed border-[#5b4b9c] px-3 py-1.5 text-[13px] text-[#b7aede]"
              >
                {refBefore}
                <b className="font-mono text-[15px] font-semibold tracking-[0.06em] text-[var(--mk-cream)]">{reference}</b>
                {refAfter}
              </p>
              <p className="mt-1.5 text-[12.5px] text-[#8d7fc0]">
                {sent?.referenceKept ? t("start.wizard.resentNote") : t("start.wizard.referenceNote")}
              </p>
            </>
          ) : null}
        </div>
        <div className="mt-6 flex flex-col gap-3.5">
          <div className={TICKET}>
            <p className="mk-display mb-2 break-words text-xl font-bold">{eventName}</p>
            <Summary rows={summaryRows("sent")} />
          </div>
          <section aria-labelledby="start-next" className={`${TICKET} py-4`}>
            <h3 id="start-next" className="mk-display mb-3 text-xl font-bold">
              {t("start.next.title")}
            </h3>
            <GettingStartedStepper
              items={stepItems}
              label={t("start.next.title")}
              nowLabel={t("start.next.now")}
              doneLabel={t("start.next.doneLabel")}
              tone="night"
            />
          </section>
        </div>
        {playSports.includes(s.sportKey) ? (
          <p className="mt-5 text-center text-sm text-[#b7aede]">
            {waitBefore}
            <a
              href={`${routes.quickMatchSetup(locale)}?sport=${encodeURIComponent(s.sportKey)}`}
              data-testid="start-play-link"
              className={`inline-flex min-h-11 items-center font-semibold text-[var(--mk-lime)] underline underline-offset-4 ${FOCUS}`}
            >
              {t("start.wizard.quickMatchLink")}
            </a>
            {waitAfter}
          </p>
        ) : null}
        {sent?.claimUrl ? (
          <p className="text-center">
            <a
              href={sent.claimUrl}
              data-claim-url={sent.claimUrl}
              className="ph-no-capture mt-2 inline-flex min-h-11 items-center text-xs text-[#8d7fc0] underline"
            >
              {t("start.wizard.openDev")}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  // ---- the four questions ----------------------------------------------------------------------------------------
  const stepIndex = WIZARD_STEPS.indexOf(s.step);
  const stepLabel = (k: (typeof WIZARD_STEPS)[number]) => t(`start.wizard.steps.${k}`);
  const answers: Record<(typeof WIZARD_STEPS)[number], string> = {
    sport: sportName,
    size: selected ? `${players(field)} · ${t(FORMAT_NAME_KEY[selected.slug])}` : players(field),
    date: s.date ? dayLabel(s.date) : t("start.wizard.notSure"),
    email: "",
  };
  const question = t(`start.wizard.q.${s.step}`);
  const help = s.step === "sport" ? t("start.wizard.help.sport") : s.step === "date" ? t("start.wizard.help.date") : null;
  const navRow = (primary: React.ReactNode) => (
    <div className="mt-7 flex gap-2">
      {s.step !== "sport" ? (
        <button type="button" onClick={back} className={GHOST}>
          ← {t("start.wizard.back")}
        </button>
      ) : null}
      {primary}
    </div>
  );
  const nextButton = (
    <button type="submit" disabled={!canAdvance(s, ctx)} className={PRIMARY}>
      {t("start.wizard.next")} →
    </button>
  );

  // md+: the heading's row is only as tall as the heading and the rail's row takes the rest, so the card spanning both never
  // stretches the heading's row and the rail sits right under the heading on every step (sign-off D1).
  return (
    <div
      data-start-wizard
      data-step={s.step}
      className="mx-auto w-full max-w-xl px-4 md:grid md:max-w-5xl md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-x-10 md:px-6 lg:grid-cols-[18rem_minmax(0,1fr)]"
    >
      <h1 className="mk-display text-xs font-bold tracking-[0.22em] text-[var(--mk-lime)] md:col-start-1 md:row-start-1">
        {t("start.heading")}
      </h1>

      {/* The answers rail (desktop): the event taking shape, one row per question. */}
      <aside aria-label={t("start.wizard.answers")} className="hidden md:col-start-1 md:row-start-2 md:block">
        <p className="mk-display mt-2 break-words text-3xl font-bold leading-tight">{eventName}</p>
        <ol className="mt-5">
          {WIZARD_STEPS.map((k, i) => {
            const state = i < stepIndex ? "done" : i === stepIndex ? "current" : "todo";
            return (
              <li
                key={k}
                data-rail-step={k}
                aria-current={state === "current" ? "step" : undefined}
                className="flex items-start gap-2.5 border-b border-[#2a1d5a] py-2.5 text-[13.5px] text-[#8d7fc0]"
              >
                <span
                  aria-hidden
                  className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-full border text-[11px] ${
                    state === "done"
                      ? "border-[var(--mk-lime)] bg-[var(--mk-lime)] text-[var(--mk-night)]"
                      : state === "current"
                        ? "border-[var(--mk-lime)] text-[var(--mk-lime)]"
                        : "border-[#3b2a6e] text-[#b7aede]"
                  }`}
                >
                  {state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0 break-words">
                  <b className="block font-semibold text-[var(--mk-cream)]">{stepLabel(k)}</b>
                  {state === "done" ? answers[k] : null}
                </span>
              </li>
            );
          })}
        </ol>
      </aside>

      <section
        aria-labelledby="start-q"
        className="mt-2 min-w-0 md:col-start-2 md:row-span-2 md:row-start-1 md:mt-0 md:rounded-[20px] md:border md:border-[#3b2a6e] md:bg-[rgb(29_17_69/0.85)] md:p-6"
      >
        <div aria-hidden className="flex gap-1.5">
          {WIZARD_STEPS.map((k, i) => (
            <i key={k} className={`h-1 flex-1 rounded-full ${i <= stepIndex ? "bg-[var(--mk-lime)]" : "bg-[#3b2a6e]"}`} />
          ))}
        </div>
        <p className="mt-2 text-xs text-[#b7aede]">
          {t("start.wizard.stepOf", { n: stepIndex + 1, total: WIZARD_STEPS.length, label: stepLabel(WIZARD_STEPS[stepIndex]!) })}
        </p>
        <h2 id="start-q" ref={heading} tabIndex={-1} className="mk-display mt-1.5 text-[1.875rem] font-bold leading-[1.05] outline-none">
          {question}
        </h2>
        {help ? <p className={`mt-1.5 ${HELP}`}>{help}</p> : null}

        {s.step === "sport" ? (
          // A real GET form: before the script runs, Next still carries the chosen sport into the URL (the page prefills it).
          <form method="get" action={`/${locale}/start`} onSubmit={next} className="mt-5">
            <fieldset>
              <legend className="sr-only">{t("start.wizard.sport")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {FUNNEL_SPORTS.map((sport) => (
                  <label key={sport.key}>
                    <input
                      type="radio"
                      name="sport"
                      value={sport.key}
                      checked={s.sportKey === sport.key}
                      onChange={() => dispatch({ type: "sport", key: sport.key })}
                      className="peer sr-only"
                    />
                    <span className={CHIP}>{t(sportLabelKey(sport.key))}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="mt-6 block">
              <span className={`${LABEL} mb-1.5`}>
                {t("start.wizard.compName")} <span className="font-normal text-[#8d7fc0]">({t("start.wizard.optional")})</span>
              </span>
              <input
                value={s.name}
                onChange={(e) => dispatch({ type: "name", value: e.target.value })}
                placeholder={defaultName}
                maxLength={200}
                autoComplete="off"
                className={INPUT}
              />
            </label>
            {navRow(nextButton)}
          </form>
        ) : null}

        {s.step === "size" ? (
          // noValidate: the count boxes' `pattern` and the date box's `min` would raise the browser's own bubble, in the
          // browser's language; the wizard's rules and its dictionary decide instead (review-t4 m5).
          <form onSubmit={next} noValidate className="mt-5">
            <span id="start-entrants" className={`${LABEL} mb-1.5`}>
              {t("start.wizard.entrants")}
            </span>
            <CountStepper
              labelId="start-entrants"
              label={t("start.wizard.entrants")}
              value={s.entrants}
              bounds={WIZARD_BOUNDS.entrants}
              onValue={(value) => dispatch({ type: "entrants", value })}
              size="large"
              describedBy={capped ? "start-cap-hint" : undefined}
            />
            {capped ? (
              <p id="start-cap-hint" className="mt-2 text-xs leading-relaxed text-[#fdba74]">
                {t("start.wizard.capHint", { cap: field })}
              </p>
            ) : null}

            <div className="mt-4 rounded-xl border border-[#3b2a6e] bg-[rgb(36_22_80/0.45)]">
              <button
                type="button"
                aria-expanded={foldOpen}
                aria-controls="start-planning"
                onClick={() => {
                  setFoldOpen(!foldOpen);
                  dispatch({ type: "planning" });
                }}
                className={`flex min-h-12 w-full min-w-0 flex-wrap items-center gap-x-2 rounded-xl px-3 text-left text-[13.5px] text-[#e8e2fb] ${FOCUS}`}
              >
                <ChevronDown aria-hidden className={`h-4 w-4 flex-none text-[var(--mk-lime)] transition ${foldOpen ? "" : "-rotate-90"}`} />
                <span className="font-semibold">{t("start.wizard.planning")}</span>
                <span className="ml-auto text-xs text-[#8d7fc0]">
                  {plural("start.wizard.courtsCount", s.courts)} · {plural("start.wizard.hoursCount", s.hours)}
                </span>
              </button>
              {foldOpen ? (
                <div id="start-planning" className="border-t border-[#3b2a6e] p-3">
                  <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                    <div className="min-w-0">
                      <span id="start-courts" className={`${LABEL} mb-1`}>
                        {t("start.wizard.courts")}
                      </span>
                      <CountStepper
                        labelId="start-courts"
                        label={t("start.wizard.courts")}
                        value={s.courts}
                        bounds={WIZARD_BOUNDS.courts}
                        onValue={(value) => dispatch({ type: "courts", value })}
                      />
                    </div>
                    <div className="min-w-0">
                      <span id="start-hours" className={`${LABEL} mb-1`}>
                        {t("start.wizard.hours")}
                      </span>
                      <CountStepper
                        labelId="start-hours"
                        label={t("start.wizard.hours")}
                        value={s.hours}
                        bounds={WIZARD_BOUNDS.hours}
                        onValue={(value) => dispatch({ type: "hours", value })}
                      />
                    </div>
                  </div>
                  <p className={`mt-3 ${HELP}`}>{t("start.wizard.planningNote")}</p>
                </div>
              ) : null}
            </div>

            <fieldset className="mt-6 min-w-0">
              <legend className="w-full">
                <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-xs font-semibold text-[#b7aede]">
                  <span>{t("start.wizard.format")}</span>
                  <span className="font-normal text-[#8d7fc0]">
                    {players(field)} · {plural("start.wizard.courtsCount", s.courts)} · {plural("start.wizard.hoursCount", s.hours)}
                  </span>
                </span>
              </legend>
              <div className="mt-2 grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                {cards
                  .filter((c) => !MORE.has(c.slug) || moreOpen || s.format === c.slug)
                  .map((c) => (
                    <FormatCard
                      key={c.slug}
                      card={c}
                      checked={s.format === c.slug && c.available}
                      best={c.slug === bestFit}
                      onPick={() => dispatch({ type: "format", slug: c.slug })}
                      name={t(FORMAT_NAME_KEY[c.slug])}
                      tagline={t(FORMAT_TAGLINE_KEY[c.slug])}
                      stats={`${plural("start.wizard.matchesCount", c.matches)} · ${hours(c.estHours)}`}
                      tag={
                        !c.available
                          ? t("start.wizard.needsAtLeast", { min: funnelFormatMin(c.slug) })
                          : c.fits
                            ? t("start.wizard.fits")
                            : t("start.wizard.runsOver")
                      }
                      bestLabel={t("start.wizard.bestFit")}
                    />
                  ))}
              </div>
              {!moreOpen && !(s.format !== null && MORE.has(s.format)) ? (
                <button
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  className={`mt-2 inline-flex min-h-11 items-center text-[13px] text-[#b7aede] underline underline-offset-[3px] ${FOCUS}`}
                >
                  {t("start.wizard.moreFormats")}
                </button>
              ) : null}
            </fieldset>
            {navRow(nextButton)}
          </form>
        ) : null}

        {s.step === "date" ? (
          <form onSubmit={next} noValidate className="mt-5">
            <fieldset>
              <legend className={`${LABEL} mb-2`}>{t("start.wizard.firstDay")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {nextEventDays(utcDay).map((d) => (
                  <label key={d}>
                    <input
                      type="radio"
                      name="date"
                      value={d}
                      checked={!picking && s.date === d}
                      onChange={() => {
                        setPicking(false);
                        dispatch({ type: "date", value: d });
                      }}
                      className="peer sr-only"
                    />
                    <span className={CHIP}>{dayLabel(d)}</span>
                  </label>
                ))}
                <label>
                  <input
                    type="radio"
                    name="date"
                    value="pick"
                    checked={picking}
                    onChange={() => setPicking(true)}
                    className="peer sr-only"
                  />
                  <span className={`${CHIP} border-dashed text-[#b7aede]`}>{t("start.wizard.pickDate")}</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="date"
                    value="none"
                    checked={!picking && s.date === null}
                    onChange={() => {
                      setPicking(false);
                      dispatch({ type: "date", value: null });
                    }}
                    className="peer sr-only"
                  />
                  <span className={CHIP}>{t("start.wizard.notSure")}</span>
                </label>
              </div>
            </fieldset>
            {picking ? (
              <label className="mt-5 block">
                <span className={`${LABEL} mb-1.5`}>{t("start.wizard.steps.date")}</span>
                <input
                  type="date"
                  min={utcDay}
                  value={s.date ?? ""}
                  onChange={(e) => dispatch({ type: "date", value: e.target.value === "" ? null : e.target.value })}
                  className={`${INPUT} [color-scheme:dark]`}
                />
              </label>
            ) : null}
            {navRow(nextButton)}
          </form>
        ) : null}

        {s.step === "email" ? (
          <form onSubmit={send} noValidate className="mt-4">
            {/* Change email (mock sss14a section 2): a link went out from this page, so sending again replaces it. */}
            {sent?.held ? <ChangeEmailBanner text={t("start.wizard.changeBanner")} reference={sent.held.reference} /> : null}
            <div className={`${TICKET} ${sent?.held ? "mt-3" : ""}`}>
              <Summary rows={summaryRows("email")} />
            </div>
            {sent ? <p className={`mt-2 ${HELP}`}>{t("start.wizard.answersKept")}</p> : null}
            <label className="mt-5 block">
              <span className={`${LABEL} mb-1.5`}>{t("start.wizard.email")}</span>
              <input
                ref={emailInput}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={s.email}
                onChange={(e) => dispatch({ type: "email", value: e.target.value })}
                onBlur={() => setEmailTouched(s.email.trim() !== "")}
                placeholder={t("start.wizard.emailPlaceholder")}
                maxLength={120}
                aria-invalid={showEmailError}
                aria-describedby={showEmailError ? "start-email-error" : "start-email-note"}
                className={`${INPUT} ${showEmailError ? "border-[#f87171] shadow-[0_0_0_3px_rgb(248_113_113/0.15)]" : ""}`}
              />
            </label>
            {showEmailError ? (
              <p id="start-email-error" className="mt-1.5 text-sm text-[#fca5a5]">
                {emailState === "missingTld" ? t("start.wizard.emailMissingTld") : t("start.wizard.emailInvalid")}
              </p>
            ) : null}
            <p id="start-email-note" className={`mt-2 ${HELP}`}>
              {t("start.wizard.emailNote")}
            </p>
            <TurnstileWidget controller={turnstile} className="mt-3" />
            <LegalNotice className="mt-3 text-left" />
            {error ? (
              <p role="alert" className="mt-3 text-sm text-[#fca5a5]">
                {error}
              </p>
            ) : null}
            {navRow(
              <button type="submit" disabled={busy} className={PRIMARY}>
                {busy ? t("start.wizard.sending") : `${sent ? t("start.wizard.sendNew") : t("start.wizard.emailMe")} →`}
              </button>,
            )}
          </form>
        ) : null}
      </section>
    </div>
  );
}

function Summary({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[#8d7fc0]">{k}</dt>
          <dd className="break-words text-[var(--mk-cream)]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The Change-email banner: the earlier link stops working on the next send, and the reference stays. */
function ChangeEmailBanner({ text, reference }: { text: string; reference: string }) {
  const [before, after] = text.split("{reference}");
  return (
    <div
      data-change-email
      className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 rounded-xl border border-[rgb(163_230_53/0.4)] bg-[rgb(163_230_53/0.08)] px-3.5 py-3 text-left text-sm text-[#e9f9cf]"
    >
      <Info aria-hidden className="mt-0.5 h-[18px] w-[18px] text-[var(--mk-lime)]" />
      <p>
        {before}
        <b className="font-mono tracking-[0.05em]">{reference}</b>
        {after}
      </p>
    </div>
  );
}

function FormatCard({
  card,
  checked,
  best,
  onPick,
  name,
  tagline,
  stats,
  tag,
  bestLabel,
}: {
  card: RankedFormat;
  checked: boolean;
  best: boolean;
  onPick: () => void;
  name: string;
  tagline: string;
  stats: string;
  tag: string;
  bestLabel: string;
}) {
  const tagTone = !card.available
    ? "bg-[rgb(183_174_222/0.12)] text-[#b7aede]"
    : card.fits
      ? "bg-[rgb(163_230_53/0.16)] text-[var(--mk-lime)]"
      : "bg-[rgb(251_146_60/0.14)] text-[#fdba74]";
  return (
    <label className="flex min-w-0" data-format-card={card.slug}>
      <input
        type="radio"
        name="format"
        value={card.slug}
        checked={checked}
        disabled={!card.available}
        onChange={onPick}
        className="peer sr-only"
      />
      <span
        className={`flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-2xl border border-[#3b2a6e] bg-[rgb(36_22_80/0.6)] p-3 transition hover:border-[#5b4a9e] peer-checked:border-[var(--mk-lime)] peer-checked:bg-[rgb(163_230_53/0.08)] peer-checked:shadow-[inset_0_0_0_1px_var(--mk-lime)] peer-disabled:cursor-not-allowed peer-disabled:opacity-60 ${PEER_FOCUS}`}
      >
        <span className="break-words text-sm font-semibold text-[var(--mk-cream)]">{name}</span>
        <span className="flex flex-wrap gap-1">
          {best ? (
            <span data-best-fit className="rounded-full bg-[var(--mk-lime)] px-2 py-0.5 text-[11px] font-bold text-[var(--mk-night)]">
              {bestLabel}
            </span>
          ) : null}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tagTone}`}>{tag}</span>
        </span>
        {card.available ? <span className="text-[13px] text-[#b7aede]">{stats}</span> : null}
        <span className="text-xs leading-snug text-[#8d7fc0]">{tagline}</span>
      </span>
    </label>
  );
}

/** A count with − and +, and a box the organiser can type into (mock B2's stepper). The box keeps what is typed until it
 *  is a count (`parseCount`): a cleared box or a lone low digit never reaches the wizard, and leaving the box shows the
 *  count again. */
export function CountStepper({
  labelId,
  label,
  value,
  bounds,
  onValue,
  size = "small",
  describedBy,
}: {
  labelId: string;
  label: string;
  value: number;
  bounds: { min: number; max: number };
  onValue: (n: number) => void;
  size?: "large" | "small";
  describedBy?: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const set = (n: number) => {
    setDraft(null);
    onValue(n);
  };
  const large = size === "large";
  const button = `grid flex-none place-items-center text-[var(--mk-lime)] transition disabled:opacity-30 ${large ? "h-[52px] w-[52px]" : "h-11 w-11"} ${FOCUS}`;
  return (
    <div className="flex min-w-0 items-stretch overflow-hidden rounded-xl border border-[#3b2a6e] bg-[#241650]">
      <button
        type="button"
        aria-label={t("start.wizard.stepper.less", { label })}
        disabled={value <= bounds.min}
        onClick={() => set(Math.max(bounds.min, value - 1))}
        className={button}
      >
        <Minus aria-hidden className={large ? "h-5 w-5" : "h-4 w-4"} />
      </button>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parseCount(e.target.value, bounds);
          if (n !== null) onValue(n);
        }}
        onBlur={() => setDraft(null)}
        // Inline size: the global `input { font-size: 16px }` under 640px is unlayered and outranks a utility class.
        style={large ? { fontSize: "1.625rem" } : undefined}
        className={`mk-display w-full min-w-0 flex-1 border-x border-[#3b2a6e] bg-transparent text-center font-bold text-[var(--mk-cream)] outline-none focus-visible:bg-[rgb(163_230_53/0.08)] ${large ? "min-h-[52px]" : "min-h-11 text-base"}`}
      />
      <button
        type="button"
        aria-label={t("start.wizard.stepper.more", { label })}
        disabled={value >= bounds.max}
        onClick={() => set(Math.min(bounds.max, value + 1))}
        className={button}
      >
        <Plus aria-hidden className={large ? "h-5 w-5" : "h-4 w-4"} />
      </button>
    </div>
  );
}
