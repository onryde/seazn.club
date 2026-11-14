// The /start wizard's state, its steps and the body it posts (start-wizard redesign, plan 2026-11-13 Task 4; owner-approved
// Option B of mock swr13a01: B1 Sport → B2 Size and format → B3 Date → B4 Email, then A4 Sent). Pure and client-safe: the
// island (start-wizard.tsx) only renders this and dispatches to it, so every rule below is tested without a DOM.
//
// The cards and Best fit are T1's one format layer (`rankFormats` / `bestFitSlug`, lib/format-recommend.ts) at the sport's
// own match length (`funnelSportMatchMinutes`: the variant the claim builds) and at the FIELD the claim will build —
// min(size, the free plan's cap) — so the card the organiser picks counts the event they land on.
import { z } from "zod";
import { bestFitSlug, rankFormats, type RankedFormat } from "@/lib/format-recommend";
import { FUNNEL_SPORTS, funnelSportMatchMinutes, type FunnelSport } from "@/lib/funnel-sports";
import { funnelFormatMin, isFunnelFormat, type FunnelFormat } from "@/lib/funnel-formats";
import { funnelEarliestDay } from "@/lib/funnel-days";
import { isIsoDay } from "@/lib/sponsor-report";
import type { Locale } from "@/lib/i18n-constants";
import type { StartPrefill } from "@/app/[lang]/(marketing)/start/prefill";

/** The start route's bounds (lib/funnel.ts `funnelPayloadSchema`, server-only, so restated here; the model test parses the
 *  wizard's body at each bound and one past it through that schema). */
export const WIZARD_BOUNDS = {
  entrants: { min: 2, max: 256 },
  courts: { min: 1, max: 32 },
  hours: { min: 1, max: 72 },
} as const;
/** The schema's `name.max`. */
const NAME_MAX = 200;

/** What the wizard opens on (mock swr13a01: Badminton, 16, two courts, four hours). */
export const WIZARD_DEFAULTS = { sportKey: "badminton", entrants: 16, courts: 2, hours: 4 } as const;

export type WizardStep = "sport" | "size" | "date" | "email" | "sent";
/** The four question steps, in order (the progress bar and the answers rail). Sent is after them. */
export const WIZARD_STEPS = ["sport", "size", "date", "email"] as const satisfies readonly WizardStep[];

export interface WizardState {
  step: WizardStep;
  /** A FUNNEL_SPORTS key. */
  sportKey: string;
  name: string;
  entrants: number;
  /** The organiser has opened Courts and time (sticky: closing the fold does not take back what they saw). Only then
   *  are courts and hours posted, and only then does the claim build courts (plan D1). The cards use the courts and hours
   *  either way: closed, they are the defaults the fold's summary shows. */
  planningOpen: boolean;
  courts: number;
  hours: number;
  /** The selected card: the organiser's (or the link's) pick when `formatPicked`, otherwise Best fit, re-read after every
   *  change — null when nothing fits (plan D3: no badge, nothing preselected). */
  format: FunnelFormat | null;
  formatPicked: boolean;
  /** `YYYY-MM-DD`, on or after the page's today; null = Not sure yet. */
  date: string | null;
  email: string;
}

/** What the page knows that the state does not: the free plan's per-division cap (null = unlimited) and today. */
export interface WizardContext {
  maxEntrants: number | null;
  today: string;
}

export type WizardAction =
  | { type: "sport"; key: string }
  | { type: "name"; value: string }
  | { type: "entrants"; value: number }
  | { type: "courts"; value: number }
  | { type: "hours"; value: number }
  | { type: "planning" }
  | { type: "format"; slug: FunnelFormat }
  | { type: "date"; value: string | null }
  | { type: "email"; value: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "sent" }
  | { type: "changeEmail" };

const sportOf = (key: string): FunnelSport | undefined => FUNNEL_SPORTS.find((s) => s.key === key);

/** The field the claim builds for `entrants` on a plan holding `cap` per division: the cap when the size is above it. A cap
 *  that could not hold a draw (under two) is not a cap the catalogue has; it is ignored rather than shrinking the cards to
 *  nothing. */
export function wizardField(entrants: number, cap: number | null): number {
  if (cap === null || cap < WIZARD_BOUNDS.entrants.min) return entrants;
  return Math.min(entrants, cap);
}

/** Every format card for the state, in its fixed order (T1). */
export function wizardCards(s: WizardState, ctx: WizardContext): RankedFormat[] {
  const sport = sportOf(s.sportKey) ?? sportOf(WIZARD_DEFAULTS.sportKey)!;
  return rankFormats({
    entrants: wizardField(s.entrants, ctx.maxEntrants),
    courts: s.courts,
    hours: s.hours,
    matchMinutes: funnelSportMatchMinutes(sport),
  });
}

/** The card for `slug`, available (buildable at the field) or not. */
const cardFor = (s: WizardState, ctx: WizardContext, slug: FunnelFormat | null): RankedFormat | undefined =>
  slug === null ? undefined : wizardCards(s, ctx).find((c) => c.slug === slug);

/** An unpicked selection follows Best fit. */
function settle(s: WizardState, ctx: WizardContext): WizardState {
  return s.formatPicked ? s : { ...s, format: bestFitSlug(wizardCards(s, ctx)) };
}

/** A count held inside its bounds: whole, never NaN (a cleared box keeps the last count). */
function clampCount(value: number, prev: number, { min, max }: { min: number; max: number }): number {
  if (Number.isNaN(value)) return prev;
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : value > 0 ? max : min));
}

export function initialWizardState(p: StartPrefill, ctx: WizardContext): WizardState {
  const base: WizardState = {
    step: "sport",
    sportKey: p.sportKey !== null && sportOf(p.sportKey) ? p.sportKey : WIZARD_DEFAULTS.sportKey,
    name: "",
    entrants: p.entrants ?? WIZARD_DEFAULTS.entrants,
    // Courts and time ride the wizard's own URL only once Planning was opened, so either one means it was.
    planningOpen: p.courts !== null || p.hours !== null,
    courts: p.courts ?? WIZARD_DEFAULTS.courts,
    hours: p.hours ?? WIZARD_DEFAULTS.hours,
    format: null,
    formatPicked: false,
    date: p.date !== null && validDate(p.date, ctx) ? p.date : null,
    email: "",
  };
  // The link's format wins only where it can be built (The Draw's "Make it real"); below its minimum it is dropped.
  const linked = cardFor(base, ctx, p.format);
  let s = settle(linked?.available ? { ...base, format: linked.slug, formatPicked: true } : base, ctx);
  // The URL's step, replayed as Next through the reducer: canAdvance decides how far the answers can go.
  while (p.step !== null && s.step !== p.step) {
    const next = wizardReducer(s, { type: "next" }, ctx);
    if (next.step === s.step) break;
    s = next;
  }
  return s;
}

/** The wizard's answers as its own URL's query (review-t4 (a)), for `history.replaceState`: the sport, the size, the
 *  organiser's own format pick (an unpicked selection is Best fit, which a reload re-reads), the first day, Courts and
 *  time once Planning was opened, and the step after Sport (Sent keeps the email step: it is never restored). Never the
 *  name or the address — PostHog and Sentry record page URLs. `parseStartPrefill` reads it back. */
export function wizardQuery(s: WizardState): string {
  const q = new URLSearchParams({ sport: s.sportKey, entrants: String(s.entrants) });
  if (s.formatPicked && s.format !== null) q.set("format", s.format);
  if (s.date !== null) q.set("date", s.date);
  if (s.planningOpen) {
    q.set("courts", String(s.courts));
    q.set("hours", String(s.hours));
  }
  const step = s.step === "sent" ? "email" : s.step;
  if (step !== "sport") q.set("step", step);
  return q.toString();
}

const validDate = (d: string, ctx: WizardContext) => isIsoDay(d) && d >= ctx.today;

export function canAdvance(s: WizardState, ctx: WizardContext): boolean {
  switch (s.step) {
    case "sport":
      return sportOf(s.sportKey) !== undefined;
    case "size":
      return cardFor(s, ctx, s.format)?.available === true;
    case "date":
      return s.date === null || validDate(s.date, ctx);
    case "email":
      return plausibleEmail(s.email) === "ok";
    case "sent":
      return false;
  }
}

const NEXT: Partial<Record<WizardStep, WizardStep>> = { sport: "size", size: "date", date: "email" };
const BACK: Partial<Record<WizardStep, WizardStep>> = { size: "sport", date: "size", email: "date" };

export function wizardReducer(s: WizardState, a: WizardAction, ctx: WizardContext): WizardState {
  switch (a.type) {
    case "sport":
      return sportOf(a.key) ? settle({ ...s, sportKey: a.key }, ctx) : s;
    case "name":
      return { ...s, name: a.value.slice(0, NAME_MAX) };
    case "entrants":
    case "courts":
    case "hours":
      return settle({ ...s, [a.type]: clampCount(a.value, s[a.type], WIZARD_BOUNDS[a.type]) }, ctx);
    case "planning":
      return { ...s, planningOpen: true };
    case "format":
      // A card that cannot be built at this field is disabled: it is never picked.
      return cardFor(s, ctx, a.slug)?.available ? { ...s, format: a.slug, formatPicked: true } : s;
    case "date":
      return a.value === null || validDate(a.value, ctx) ? { ...s, date: a.value } : s;
    case "email":
      return { ...s, email: a.value };
    case "next": {
      const to = NEXT[s.step];
      return to && canAdvance(s, ctx) ? { ...s, step: to } : s;
    }
    case "back": {
      const to = BACK[s.step];
      return to ? { ...s, step: to } : s;
    }
    case "sent":
      return s.step === "email" ? { ...s, step: "sent" } : s;
    case "changeEmail":
      return s.step === "sent" ? { ...s, step: "email" } : s;
  }
}

/** What a count box holds while the organiser types: a whole number written plainly, a value above the range read as the
 *  range's top, and anything else — a cleared box, a lone digit below the range on the way to a bigger one, a sign or a
 *  letter — as no count yet (null: the wizard keeps its last count, and the box snaps back to it on blur). */
export function parseCount(raw: string, { min, max }: { min: number; max: number }): number | null {
  const v = raw.trim();
  if (!/^[0-9]+$/.test(v)) return null;
  const n = Number(v);
  if (n > max) return max;
  return n >= min ? n : null;
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The three date chips (mock B3): the next Saturday strictly after `today`, the Sunday after it, and the Saturday after
 *  that. */
export function nextEventDays(today: string): string[] {
  if (!isIsoDay(today)) throw new RangeError(`nextEventDays: today must be a YYYY-MM-DD calendar day, got ${JSON.stringify(today)}`);
  const t = dayOf(today);
  const toSaturday = (6 - new Date(t).getUTCDay() + 7) % 7 || 7;
  const sat = t + toSaturday * DAY_MS;
  return [isoOf(sat), isoOf(sat + DAY_MS), isoOf(sat + 7 * DAY_MS)];
}

/** The page's today: the server's UTC day less one, the earliest calendar day any visitor can still be on, so a same-day
 *  link from west of UTC is kept (review-t3 m3) — the parser's and the reducer's tolerance, which the claim refuses below
 *  (lib/funnel-days.ts). From the server clock only, never from a request. The chips and the date box begin at the real
 *  UTC day instead (`funnelUtcDay`, review-t4 m1). */
export function wizardToday(now: Date): string {
  return funnelEarliestDay(now);
}

/** The start route's own address rule (`z.string().email().max(120)`), so an address the wizard sends is never refused. */
const ROUTE_EMAIL = z.string().email().max(120);
/** One @, something on both sides, no dot after it: an address short only of its ending (`sam@harbourvale`, mock A3). */
const NO_ENDING = /^[^\s@]+@[^\s@.]+$/;

export function plausibleEmail(v: string): "ok" | "missingTld" | "invalid" {
  const trimmed = v.trim();
  if (ROUTE_EMAIL.safeParse(trimmed).success) return "ok";
  return NO_ENDING.test(trimmed) ? "missingTld" : "invalid";
}

/** The POST /api/funnel/start body (plan D6): the same keys as before, `sport` the catalogue name the claim resolves,
 *  `entrants` what the organiser asked for (the claim clamps to the claiming org's own cap), courts and hours only once
 *  Planning was opened. */
export function buildFunnelBody(s: WizardState, locale: Locale, defaultName: string): Record<string, unknown> {
  const sport = sportOf(s.sportKey) ?? sportOf(WIZARD_DEFAULTS.sportKey)!;
  const format = s.format !== null && isFunnelFormat(s.format) && s.entrants >= funnelFormatMin(s.format) ? s.format : null;
  return {
    email: s.email.trim(),
    locale,
    name: s.name.trim() || defaultName,
    sport: sport.name,
    entrants: s.entrants,
    ...(s.date !== null ? { start_date: s.date } : {}),
    ...(format !== null ? { format } : {}),
    ...(s.planningOpen ? { courts: s.courts, hours: s.hours } : {}),
  };
}

/** What a start answered that the Change-email flow needs: the draft's `reference` (SZ-XXXXXX, printed in the email too) and
 *  the opaque `replaceKey` (lib/funnel.ts createFunnelDraft). Held in the island's state only, never in the URL: PostHog and
 *  Sentry record page URLs, and the key is the proof that this browser started the draft. */
export interface HeldStart {
  reference: string;
  replaceKey: string;
}

/** The pair out of the start route's answer; null when the answer does not carry both (a resend then replaces by address). */
export function heldStart(answer: unknown): HeldStart | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { reference, replaceKey } = answer as Record<string, unknown>;
  return typeof reference === "string" && typeof replaceKey === "string" ? { reference, replaceKey } : null;
}

/** A send's body: once a start has answered, every resend carries its pair (`previousReference` + `replaceKey`), so the
 *  draft it wrote is replaced by its key — although the address changed (Change email) — and the reference in the inbox
 *  stays. Sent whether or not the address changed: the key is what keeps the reference, not the address. */
export function sendBody(body: Record<string, unknown>, held: HeldStart | null): Record<string, unknown> {
  return held === null ? body : { ...body, previousReference: held.reference, replaceKey: held.replaceKey };
}

/** Every dictionary prefix the wizard and what it mounts read: its own copy (`start.`), the sport chips (`sport.`), the
 *  format cards (`format.`), <LegalNotice/> (`legal.`) and the bot check's refusal (`turnstile.`). The page hands its island
 *  only these (review-t4 (b): the whole marketing + ui catalogue was ~600KB on every /start load). */
export const WIZARD_DICT_PREFIXES = ["start.", "sport.", "format.", "legal.", "turnstile."] as const;

/** `dict` cut to the wizard's prefixes. The island test reads its words through this same picker, so a key under a prefix
 *  it misses fails there instead of falling back to a raw key in a browser. */
export function pickWizardDict<V>(dict: Readonly<Record<string, V>>): Record<string, V> {
  return Object.fromEntries(Object.entries(dict).filter(([k]) => WIZARD_DICT_PREFIXES.some((p) => k.startsWith(p))));
}

/** The cards' words: one authority, the copy seam beside `rankFormats` (lib/format-recommend.ts). */
export { FORMAT_NAME_KEY, FORMAT_TAGLINE_KEY } from "@/lib/format-recommend";

/** A sport chip's word: the sport's own (`ui` `sport.<key>`), or for Other — which names no sport — the wizard's. */
export function sportLabelKey(key: string): string {
  return sportOf(key)?.module === "generic" ? "start.wizard.sportOther" : `sport.${key}`;
}
