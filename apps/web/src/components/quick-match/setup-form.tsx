"use client";
// The quick match setup screen's island (plan 2 Task 4; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5
// step 2, C16, C17, C22, C23; design of record docs/superpowers/specs/mockups/2026-11-03-quick-match/setup.html).
//
// Everything it shows arrives as props from the server page (`app/[lang]/(marketing)/play/page.tsx`): the offer with its
// names already resolved, the copy, and the whole preview table (`quickMatchPreviewTable`, pre-flight D1), so the match
// count and the knockout draw are lookups, never a fetch that can land stale. Server modules are reached by `import type`
// only: eslint.config.mjs refuses a value import of @/server/** in src/components/quick-match/**.
//
// The form is a real `<form method="post" action="/api/quick-match">`, so it works before the script loads. Once it
// runs, a submit is a fetch of the same fields that follows the route's 303 (ledger "CARRY to T4", decision log
// 2026-11-08): a home (`/q/<token>`) is navigated to; a refusal (`/<lang>/play?e=<code>`) is shown here, with the typed
// sides kept. The form locks on its first submit and unlocks only on a refusal (pre-flight B4f): the route has no
// server-side dedupe (decision log 2026-11-08).
//
// The create is bot-checked (Cloudflare Turnstile, action `quickmatch`; owner 2026-11-12), the way #1136's forms are: one
// widget in the form (`TurnstileWidget`, invisible unless Cloudflare needs a tap), and the enhanced submit sends its token in
// the `cf-turnstile-response` header through `withTurnstile`, which resets the spent token after. A post without the script
// carries no token, so the route refuses it with QUICK_MATCH_TURNSTILE_FAILED, which the page shows as its own line.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Pencil, X } from "lucide-react";
import type { EntrantKind } from "@seazn/engine/sport";
import type {
  QuickMatchDrawSeat,
  QuickMatchKnockoutCell,
  QuickMatchPreviewTable,
} from "@/server/usecases/quick-match-preview";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { interpolate, plural } from "@/lib/i18n-runtime";
import {
  QUICK_MATCH_EMAIL_PATTERN,
  QUICK_MATCH_ERRORS,
  QUICK_MATCH_KNOCKOUT_MIN_SIDES,
  QUICK_MATCH_MAX_ALIVE_PER_VISITOR,
  QUICK_MATCH_MAX_PLAYS,
  QUICK_MATCH_MAX_SIDES,
  QUICK_MATCH_MIN_SIDES,
  QUICK_MATCH_NAME_MAX,
  QUICK_MATCH_NON_BLANK_PATTERN,
  QUICK_MATCH_SIDE_NAME_MAX,
} from "@/lib/quick-match-constants";
import { routes } from "@/lib/routes";
import { withTurnstile } from "@/lib/turnstile-client";
import { useHydrated } from "@/lib/use-client-snapshot";
import { TurnstileWidget, useTurnstile } from "@/components/turnstile-widget";
import { fixtureLabel, winnerOfLabel, type FixtureLabel } from "./fixture-label";

/** The create route (app/api/quick-match/route.ts). It answers every post with a 303. */
const CREATE_PATH = "/api/quick-match";

export type QuickMatchFormat = "league" | "knockout";

/** One sport as the page hands it over: names resolved on the server, chips in catalog order (pre-flight B4b). */
export interface SetupSport {
  sport_key: string;
  name: string;
  /** The sport's own entrant kinds, labelled; the first is the default (D6). Never empty. */
  kinds: [{ kind: EntrantKind; label: string }, ...{ kind: EntrantKind; label: string }[]];
  /** Its system variants offered to a guest, labelled. Never empty. */
  variants: [SetupVariant, ...SetupVariant[]];
  /** `pickVariant(sport_key, variants)`: the sport's preferred rules when offered, else the first (D6). */
  defaultVariant: string;
}
export interface SetupVariant {
  key: string;
  name: string;
  knockoutAllowed: boolean;
}

export interface SetupFormProps {
  lang: Locale;
  /** Never empty: the page shows the unavailable line instead of the form when nothing is offered (Q2). */
  sports: [SetupSport, ...SetupSport[]];
  table: QuickMatchPreviewTable;
  /** The setup copy, flat `key → string` (setup-props.ts `setupCopy`). */
  copy: Readonly<Record<string, string>>;
  /** The `?e=` the server read (a refusal after a post that ran without the script), or null. */
  initialError: string | null;
}

// ---- the pure rules (exported for the tests) ----------------------------------------------------------------------

/** The Start button's count: one lookup in the server's table. `undefined` outside it (a knockout of two). */
export function matchCountOf(
  table: QuickMatchPreviewTable,
  format: QuickMatchFormat,
  sides: number,
  plays: number,
): number | undefined {
  return format === "league" ? table[`league:${sides}:${plays}`]?.matchCount : table[`knockout:${sides}:1`]?.matchCount;
}

/** What the Format row offers: nothing at two sides (C16), League alone where the rules can end level (C23, D15). */
export type FormatOffer = "hidden" | "leagueOnly" | "both";
export function formatOffer(sides: number, knockoutAllowed: boolean): FormatOffer {
  if (sides < QUICK_MATCH_KNOCKOUT_MIN_SIDES) return "hidden";
  return knockoutAllowed ? "both" : "leagueOnly";
}

/** The copy key for a refusal code, from T3's table; every other code (CREATE_FAILED, a crafted `?e=`) is generic. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  [QUICK_MATCH_ERRORS.TOO_MANY_ALIVE]: "quickMatch.errors.tooManyAlive",
  [QUICK_MATCH_ERRORS.RATE_LIMITED]: "quickMatch.errors.rateLimited",
  [QUICK_MATCH_ERRORS.SPORT_NOT_OFFERED]: "quickMatch.errors.sportNotOffered",
  [QUICK_MATCH_ERRORS.KIND_NOT_OFFERED]: "quickMatch.errors.kindNotOffered",
  [QUICK_MATCH_ERRORS.FORMAT_NOT_OFFERED]: "quickMatch.errors.formatNotOffered",
  [QUICK_MATCH_ERRORS.EMAIL_INVALID]: "quickMatch.errors.emailInvalid",
  [QUICK_MATCH_ERRORS.TURNSTILE_FAILED]: "quickMatch.errors.botCheck",
};
export function setupErrorKey(code: string): string {
  return Object.hasOwn(ERROR_KEYS, code) ? ERROR_KEYS[code]! : "quickMatch.errors.generic";
}

/** Where the followed 303 landed. Only a home's PATH is kept, so the page can never be sent to another origin, plus the one
 *  `?e=` a create's own landing carries, EMAIL_LIMITED (branch review B m3): the home prints it as information. */
export type SubmitOutcome = { kind: "home"; path: string } | { kind: "refused"; code: string };
export function submitOutcome(res: { url: string; status: number }): SubmitOutcome {
  let url: URL | null = null;
  try {
    url = new URL(res.url);
  } catch {
    url = null;
  }
  if (url?.pathname.startsWith("/q/")) {
    const limited = url.searchParams.get("e") === QUICK_MATCH_ERRORS.EMAIL_LIMITED;
    return { kind: "home", path: limited ? `${url.pathname}?e=${QUICK_MATCH_ERRORS.EMAIL_LIMITED}` : url.pathname };
  }
  const path = url?.pathname;
  const code = url !== null && LOCALES.some((l) => path === routes.quickMatchSetup(l)) ? url.searchParams.get("e") : null;
  if (code) return { kind: "refused", code };
  // The limiter's own 429 carries no code (lib/rate-limit.ts); the route names it, but a 429 reaching here unfollowed
  // (a proxy in front) is still the rate limit.
  if (res.status === 429) return { kind: "refused", code: QUICK_MATCH_ERRORS.RATE_LIMITED };
  return { kind: "refused", code: QUICK_MATCH_ERRORS.CREATE_FAILED };
}

/** The create's fields, exactly the nine `CreateQuickMatch` takes (C3); `sides` repeated in typed order. A knockout has no
 *  plays, so it posts 1; a blank email is posted blank and the route maps it to none (B4e). */
export function setupBody(input: {
  name: string;
  sport_key: string;
  variant_key: string;
  kind: EntrantKind;
  format: QuickMatchFormat;
  sides: readonly string[];
  plays: number;
  email: string;
  locale: Locale;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.append("name", input.name);
  body.append("sport_key", input.sport_key);
  body.append("variant_key", input.variant_key);
  body.append("kind", input.kind);
  body.append("format", input.format);
  for (const side of input.sides) body.append("sides", side);
  body.append("plays", String(input.format === "knockout" ? 1 : input.plays));
  body.append("email", input.email.trim());
  body.append("locale", input.locale);
  return body;
}

type Msg = (key: string, vars?: Record<string, string | number>) => string;

/** One card of the knockout preview: its round's name (numbered where the round has several) and its one line. */
export interface DrawCard {
  label: string;
  line: string;
}

/**
 * The knockout preview (C22) under the typed names. The table already resolved every bye feeder to its holder (T2), so a
 * round's pairs are its non-bye fixtures and a seat is a seed (the i-th typed name) or the winner of an earlier pair.
 * Card and feeder names are fixture-label.ts's (numbered among the round's fixtures, unnumbered when it has one), the
 * rule the home's draw shares. A pair whose seats are both winners is the final's "Winners meet". A blank row is named
 * by its place ("Side 3"), never blank.
 */
export function drawPreview(
  cell: QuickMatchKnockoutCell,
  names: readonly string[],
  msg: Msg,
): { sitsOut: string[]; cards: DrawCard[] } {
  const say = (l: FixtureLabel) => msg(l.key, l.params);
  const nameOf = (seed: number) => names[seed - 1]?.trim() || msg("quickMatch.setup.sideLabel", { n: seed });
  const matchNo = new Map<string, number>();
  let n = 0;
  cell.rounds.forEach((r, ri) => r.pairs.forEach((_, pi) => matchNo.set(`${ri + 1}:${pi + 1}`, ++n)));

  const seatName = (seat: QuickMatchDrawSeat): string => {
    if ("seed" in seat) return nameOf(seat.seed);
    const { round, pair } = seat.winnerOf;
    const no = matchNo.get(`${round}:${pair}`);
    const from = cell.rounds[round - 1];
    // T2 refuses a dangling feeder, but this is the screen: never print "Winner of match undefined".
    if (no === undefined || !from) {
      throw new Error(`drawPreview cannot name the winner of round ${round} pair ${pair}: not in the draw`);
    }
    return say(winnerOfLabel(from.role, from.pairs.length, pair - 1, no));
  };

  const cards = cell.rounds.flatMap((r, ri) =>
    r.pairs.map(([home, away], pi): DrawCard => {
      // Both seats are named even where the line reads "Winners meet", so a dangling feeder there is refused too.
      const [homeName, awayName] = [seatName(home), seatName(away)];
      const line =
        "winnerOf" in home && "winnerOf" in away
          ? msg("quickMatch.setup.winnersMeet")
          : `${homeName} ${msg("quickMatch.home.versus")} ${awayName}`;
      return { label: say(fixtureLabel(r.role, ri + 1, r.pairs.length, pi)), line };
    }),
  );
  const sitsOut = [...cell.byes].sort((a, b) => a - b).map((seed) => msg("quickMatch.setup.sitsOut", { name: nameOf(seed) }));
  return { sitsOut, cards };
}

// ---- the guest's date (B4h) -----------------------------------------------------------------------------------------

const subscribeToNothing = () => () => {};
/** Today in the guest's own zone, in the page's language ("Tue, Nov 3"); null on the server and during hydration, which
 *  cannot know the guest's date. A day does not change under a setup screen, so there is no subscription. */
function useGuestDate(lang: Locale): string | null {
  return useSyncExternalStore(
    subscribeToNothing,
    () => new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" }).format(new Date()),
    () => null,
  );
}

// ---- the island ---------------------------------------------------------------------------------------------------

const LABEL = "mb-1.5 block text-xs font-semibold text-[#b7aede]";
const HELP = "mt-1.5 text-xs text-[#8d7fc0]";
const SEG = "flex overflow-hidden rounded-lg border border-[#3b2a6e] bg-[#241650]";
/** A segment's face. Its 44px tap floor is `min-h-11`, never a padding that a later class could override; the text size
 *  is the caller's (`text-sm` or `text-base`), so no two size utilities ever compete on one element. */
const SEG_ITEM =
  "flex min-h-11 cursor-pointer items-center justify-center px-2 text-center text-[#b7aede] transition peer-checked:bg-[rgb(163_230_53/0.14)] peer-checked:font-semibold peer-checked:text-[var(--mk-cream)] peer-checked:shadow-[inset_0_-2px_0_var(--mk-lime)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-[var(--mk-lime)]";

interface SideRow {
  id: number;
  name: string;
}

export function QuickMatchSetupForm({ lang, sports, table, copy, initialError }: SetupFormProps) {
  const msg: Msg = (key, vars) => interpolate(copy[key] ?? key, vars);
  const count = (key: string, n: number, vars?: Record<string, string | number>) => plural(copy, key, n, lang, vars);

  const [sportKey, setSportKey] = useState(sports[0].sport_key);
  const sport = sports.find((s) => s.sport_key === sportKey) ?? sports[0];
  const [kind, setKind] = useState<EntrantKind>(sport.kinds[0].kind);
  const [variantKey, setVariantKey] = useState(sport.defaultVariant);
  const variant =
    sport.variants.find((v) => v.key === variantKey) ??
    sport.variants.find((v) => v.key === sport.defaultVariant) ??
    sport.variants[0];
  const nextId = useRef(2);
  const [rows, setRows] = useState<SideRow[]>([
    { id: 0, name: "" },
    { id: 1, name: "" },
  ]);
  const [format, setFormat] = useState<QuickMatchFormat>("league");
  const [plays, setPlays] = useState(1);
  /** null: the name follows the suggestion; a string once the guest has typed one (B4h). */
  const [typedName, setTypedName] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  // The email field's fold: opened by a refusal of the address itself, so the field at fault is in view (A-I2), and then the
  // guest's to open or close.
  const [emailOpen, setEmailOpen] = useState(initialError === QUICK_MATCH_ERRORS.EMAIL_INVALID);
  const [submitting, setSubmitting] = useState(false);
  const locked = useRef(false);
  /** False in the server's HTML and until the script runs: that page must work as a plain form post (I1). */
  const hydrated = useHydrated();
  const turnstile = useTurnstile("quickmatch");

  // Back from the home (bfcache): the page comes back exactly as it was left, locked mid-submit. Unlock it (m9).
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      locked.current = false;
      setSubmitting(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const date = useGuestDate(lang);
  const suggestion = date === null ? sport.name : msg("quickMatch.setup.suggestedName", { sport: sport.name, date });
  const name = typedName ?? suggestion;

  const offer = formatOffer(rows.length, variant.knockoutAllowed);
  const effectiveFormat: QuickMatchFormat = offer === "both" ? format : "league";
  const matches = matchCountOf(table, effectiveFormat, rows.length, plays);
  const knockoutCell = effectiveFormat === "knockout" ? table[`knockout:${rows.length}:1`] : undefined;
  const draw = knockoutCell ? drawPreview(knockoutCell, rows.map((r) => r.name), msg) : null;
  /** Per card, how many matches its round has: a round of one (a lone semi-final, the final) spans the row. */
  const roundSizes = knockoutCell ? knockoutCell.rounds.flatMap((r) => r.pairs.map(() => r.pairs.length)) : [];
  const canStart = !submitting && name.trim() !== "" && rows.every((r) => r.name.trim() !== "");

  // Pre-flight B4c: a format the screen can no longer offer resets to League, so it does not come back by itself.
  function settleFormat(sides: number, knockoutAllowed: boolean) {
    if (formatOffer(sides, knockoutAllowed) !== "both") setFormat("league");
  }
  function chooseSport(key: string) {
    const next = sports.find((s) => s.sport_key === key);
    if (!next) return;
    setSportKey(next.sport_key);
    setKind(next.kinds[0].kind);
    setVariantKey(next.defaultVariant);
    const nextVariant = next.variants.find((v) => v.key === next.defaultVariant) ?? next.variants[0];
    settleFormat(rows.length, nextVariant.knockoutAllowed);
  }
  function chooseVariant(key: string) {
    const next = sport.variants.find((v) => v.key === key);
    if (!next) return;
    setVariantKey(next.key);
    settleFormat(rows.length, next.knockoutAllowed);
  }
  function addSide() {
    if (rows.length >= QUICK_MATCH_MAX_SIDES) return;
    setRows([...rows, { id: nextId.current++, name: "" }]);
  }
  function removeSide(id: number) {
    const next = rows.filter((r) => r.id !== id);
    if (next.length < QUICK_MATCH_MIN_SIDES) return;
    setRows(next);
    settleFormat(next.length, variant.knockoutAllowed);
  }
  function renameSide(id: number, value: string) {
    setRows(rows.map((r) => (r.id === id ? { ...r, name: value } : r)));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement> | { preventDefault(): void }) {
    e.preventDefault();
    if (locked.current || !canStart) return;
    locked.current = true;
    setSubmitting(true);
    setError(null);
    let outcome: SubmitOutcome;
    try {
      const res = await withTurnstile(turnstile, (headers) =>
        fetch(CREATE_PATH, {
          method: "POST",
          headers,
          body: setupBody({
            name,
            sport_key: sport.sport_key,
            variant_key: variant.key,
            kind,
            format: effectiveFormat,
            sides: rows.map((r) => r.name),
            plays,
            email,
            locale: lang,
          }),
          redirect: "follow",
          credentials: "same-origin",
        }),
      );
      outcome = submitOutcome(res);
    } catch {
      outcome = { kind: "refused", code: QUICK_MATCH_ERRORS.CREATE_FAILED };
    }
    if (outcome.kind === "home") {
      // Stays locked: the page is leaving.
      window.location.assign(outcome.path);
      return;
    }
    locked.current = false;
    setSubmitting(false);
    setError(outcome.code);
    if (outcome.code === QUICK_MATCH_ERRORS.EMAIL_INVALID) setEmailOpen(true);
  }

  const errorLine =
    error === null ? null : msg(setupErrorKey(error), { max: QUICK_MATCH_MAX_ALIVE_PER_VISITOR });
  const playsRow =
    effectiveFormat === "league" ? (
      <fieldset className={offer === "hidden" ? "mt-5" : "mt-3 border-l-2 border-[#3b2a6e] pl-3"}>
        <legend className={LABEL}>{msg("quickMatch.setup.plays")}</legend>
        <div className={`${SEG} mt-1.5`}>
          {Array.from({ length: QUICK_MATCH_MAX_PLAYS }, (_, k) => k + 1).map((p) => (
            <label key={p} className="min-w-0 flex-1">
              <input
                type="radio"
                name="plays"
                value={String(p)}
                checked={plays === p}
                onChange={() => setPlays(p)}
                className="peer sr-only"
              />
              <span className={`${SEG_ITEM} text-sm`}>{msg(`quickMatch.setup.plays.${p}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
    ) : (
      <input type="hidden" name="plays" value="1" />
    );

  return (
    <form
      method="post"
      action={CREATE_PATH}
      onSubmit={onSubmit}
      data-testid="qm-setup-form"
      aria-busy={submitting}
      className="text-[var(--mk-cream)]"
    >
      <input type="hidden" name="locale" value={lang} />

      <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
        {msg("quickMatch.setup.title")}
      </p>
      <label className="mt-1.5 flex min-w-0 items-center gap-2 border-b border-dashed border-[#3b2a6e] pb-1.5 focus-within:border-[var(--mk-lime)]">
        <span className="sr-only">{msg("quickMatch.setup.nameLabel")}</span>
        <input
          type="text"
          name="name"
          value={name}
          maxLength={QUICK_MATCH_NAME_MAX}
          required
          pattern={QUICK_MATCH_NON_BLANK_PATTERN}
          // Review m5: the browser's own bubble for a pattern miss appends the title, so the guest reads the app's line.
          title={msg("quickMatch.errors.nameBlank")}
          autoComplete="off"
          aria-describedby="qm-name-hint"
          onChange={(e) => setTypedName(e.target.value)}
          // Inline size: the global `input { font-size: 16px }` under 640px is unlayered and outranks a utility class.
          style={{ fontSize: "clamp(1.5rem, 1.1rem + 2vw, 1.875rem)", lineHeight: 1.1 }}
          className="mk-display min-w-0 flex-1 bg-transparent font-bold text-[var(--mk-cream)] outline-none placeholder:text-[#8d7fc0]"
        />
        <Pencil aria-hidden className="h-4 w-4 shrink-0 text-[var(--mk-lime)]" strokeWidth={2.25} />
      </label>
      <p id="qm-name-hint" className={HELP}>
        {msg("quickMatch.setup.nameHint")}
      </p>

      <fieldset className="mt-6">
        <legend className={LABEL}>{msg("quickMatch.setup.sport")}</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {sports.map((s) => (
            <label key={s.sport_key}>
              <input
                type="radio"
                name="sport_key"
                value={s.sport_key}
                checked={s.sport_key === sport.sport_key}
                // Before the script runs the kinds and the rules below are the chosen sport's, so a plain form post can
                // only send that sport: another chip cannot be picked until the page is live (I1).
                disabled={!hydrated && s.sport_key !== sport.sport_key}
                onChange={() => chooseSport(s.sport_key)}
                className="peer sr-only"
              />
              <span className="flex min-h-11 cursor-pointer items-center rounded-full border border-[#3b2a6e] bg-[#241650] px-3.5 text-sm text-[var(--mk-cream)] transition hover:border-[#5b4a9e] peer-checked:border-[var(--mk-lime)] peer-checked:bg-[var(--mk-lime)] peer-checked:font-semibold peer-checked:text-[var(--mk-night)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--mk-lime)]">
                {s.name}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {sport.kinds.length > 1 ? (
        <fieldset className="mt-3">
          <legend className="sr-only">{msg("divBuilder.step.who")}</legend>
          <div className={SEG}>
            {sport.kinds.map((k) => (
              <label key={k.kind} className="min-w-0 flex-1">
                <input
                  type="radio"
                  name="kind"
                  value={k.kind}
                  checked={kind === k.kind}
                  onChange={() => setKind(k.kind)}
                  className="peer sr-only"
                />
                <span className={`${SEG_ITEM} text-sm`}>{k.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="kind" value={kind} />
      )}

      <div className="mt-6">
        <div className="flex items-baseline justify-between gap-3">
          <span id="qm-sides-label" className={LABEL}>
            {msg("quickMatch.setup.sides")}
          </span>
          <span className="text-xs text-[#8d7fc0]">
            {count("quickMatch.setup.sidesCount", rows.length, { max: QUICK_MATCH_MAX_SIDES })}
          </span>
        </div>
        <div
          role="group"
          aria-labelledby="qm-sides-label"
          className="mt-1.5 overflow-hidden rounded-2xl border border-[#3b2a6e] bg-[rgb(36_22_80/0.75)]"
        >
          {rows.map((row, k) => (
            <div key={row.id} className="flex min-w-0 items-center gap-2.5 border-b border-[#3b2a6e] px-2.5 py-2">
              <span
                aria-hidden
                className="mk-display flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--mk-lime)] text-base font-bold text-[var(--mk-night)]"
              >
                {k + 1}
              </span>
              <input
                type="text"
                name="sides"
                value={row.name}
                maxLength={QUICK_MATCH_SIDE_NAME_MAX}
                required
                pattern={QUICK_MATCH_NON_BLANK_PATTERN}
                title={msg("quickMatch.errors.nameBlank")}
                autoComplete="off"
                aria-label={msg("quickMatch.setup.sideLabel", { n: k + 1 })}
                onChange={(e) => renameSide(row.id, e.target.value)}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-[#3b2a6e] bg-[var(--mk-night)] px-2.5 py-2 text-sm text-[var(--mk-cream)] outline-none transition placeholder:text-[#8d7fc0] focus:border-[var(--mk-lime)]"
              />
              {k >= QUICK_MATCH_MIN_SIDES ? (
                <button
                  type="button"
                  aria-label={msg("quickMatch.setup.removeSide", { n: k + 1 })}
                  onClick={() => removeSide(row.id)}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[#b7aede] transition hover:bg-[rgb(245_240_232/0.08)] hover:text-[var(--mk-cream)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--mk-lime)]"
                >
                  <X aria-hidden className="h-4 w-4" />
                </button>
              ) : rows.length > QUICK_MATCH_MIN_SIDES ? (
                <span aria-hidden className="h-11 w-11 shrink-0" />
              ) : null}
            </div>
          ))}
          {rows.length < QUICK_MATCH_MAX_SIDES ? (
            <button
              type="button"
              onClick={addSide}
              // Adding a row needs the script; before it runs the button would do nothing, so it says so (I1).
              disabled={!hydrated}
              className="block min-h-11 w-full px-3 py-3 text-left text-sm font-semibold text-[var(--mk-lime)] transition hover:bg-[rgb(163_230_53/0.06)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
            >
              {msg("quickMatch.setup.addSide")}
            </button>
          ) : null}
        </div>
      </div>

      {offer === "hidden" ? (
        <input type="hidden" name="format" value="league" />
      ) : (
        <fieldset className="mt-6" data-testid="qm-format-row">
          <legend className={LABEL}>{msg("quickMatch.setup.format")}</legend>
          {offer === "both" ? (
            <div className={`${SEG} mt-1.5`}>
              {(["league", "knockout"] as const).map((f) => (
                <label key={f} className="min-w-0 flex-1">
                  <input
                    type="radio"
                    name="format"
                    value={f}
                    checked={effectiveFormat === f}
                    onChange={() => setFormat(f)}
                    className="peer sr-only"
                  />
                  <span className={`${SEG_ITEM} text-base`}>{msg(`quickMatch.format.${f}`)}</span>
                </label>
              ))}
            </div>
          ) : (
            <>
              <input type="hidden" name="format" value="league" />
              <p className="mt-1.5 rounded-lg border border-[#3b2a6e] bg-[#241650] px-3 py-2.5 text-center text-base font-semibold shadow-[inset_0_-2px_0_var(--mk-lime)]">
                {msg("quickMatch.format.league")}
              </p>
              <p className={HELP}>{msg("quickMatch.setup.knockoutUnavailable")}</p>
            </>
          )}
          <p className={HELP}>
            {msg(effectiveFormat === "league" ? "quickMatch.setup.leagueHelp" : "quickMatch.setup.knockoutHelp")}
          </p>
        </fieldset>
      )}

      {playsRow}

      {draw ? (
        <div data-testid="qm-draw" className="mt-3">
          <ol className="grid grid-cols-2 gap-1.5 text-xs">
            {draw.cards.map((c, k) => (
              <li
                key={`${c.label}-${k}`}
                className={`min-w-0 rounded-lg border border-[#3b2a6e] bg-[var(--mk-night)] px-2.5 py-2 text-[#b7aede] ${roundSizes[k] === 1 ? "col-span-2 text-center" : ""}`}
              >
                {c.label}
                <span className="mt-0.5 block break-words text-sm font-medium text-[var(--mk-cream)]">{c.line}</span>
              </li>
            ))}
          </ol>
          {draw.sitsOut.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-xs text-[#8d7fc0]">
              {/* Index keys: two sides may share a name, so two lines can be the same words. */}
              {draw.sitsOut.map((line, k) => (
                <li key={k} className="min-w-0 break-words">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <label className="mt-6 block">
        <span className={LABEL}>{msg("quickMatch.setup.rules")}</span>
        <span className="relative mt-1.5 block">
          <select
            name="variant_key"
            value={variant.key}
            onChange={(e) => chooseVariant(e.target.value)}
            className="min-h-11 w-full appearance-none rounded-lg border border-[#3b2a6e] bg-[#241650] py-2.5 pl-3 pr-9 text-sm text-[var(--mk-cream)] outline-none transition focus:border-[var(--mk-lime)]"
          >
            {sport.variants.map((v) => (
              <option key={v.key} value={v.key}>
                {v.name}
              </option>
            ))}
          </select>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--mk-lime)]">
            ⌄
          </span>
        </span>
      </label>

      <details className="mt-5" open={emailOpen} onToggle={(e) => setEmailOpen(e.currentTarget.open)}>
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-[#b7aede] underline underline-offset-2 hover:text-[var(--mk-cream)]">
          {msg("quickMatch.setup.email")}
        </summary>
        <label className="mt-2 block">
          <span className={LABEL}>{msg("quickMatch.setup.emailLabel")}</span>
          <input
            type="email"
            name="email"
            value={email}
            maxLength={254}
            pattern={QUICK_MATCH_EMAIL_PATTERN}
            title={msg("quickMatch.errors.emailInvalid")}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-[#3b2a6e] bg-[#241650] px-3 py-2.5 text-sm text-[var(--mk-cream)] outline-none transition focus:border-[var(--mk-lime)]"
          />
        </label>
      </details>

      {/* The Start bar. Below 640px it sticks to the bottom of the screen INSIDE the form, so it never covers anything
          after the form and needs no spacer; from 640px up it sits inline. While the cookie banner is open
          (cookie-consent.tsx sets `data-consent-open` on <html>) it un-docks into the page, so it neither hides under
          the banner nor covers its buttons; z-30 keeps the banner (z-40) on top either way. */}
      <div
        data-testid="qm-start-bar"
        className="z-30 -mx-4 mt-8 border-t border-[#3b2a6e] bg-[rgb(21_11_54/0.94)] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur max-sm:sticky max-sm:bottom-0 sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none [html[data-consent-open]_&]:static"
      >
        {errorLine !== null ? (
          <p
            role="alert"
            data-testid="qm-setup-error"
            className="mb-2.5 rounded-lg border border-[rgb(239_68_68/0.55)] bg-[rgb(239_68_68/0.14)] px-3 py-2 text-sm text-[var(--mk-cream)]"
          >
            {errorLine}
          </p>
        ) : null}
        {/* The bot check's widget, straight before the submit as on #1136's forms. It is invisible unless Cloudflare needs a
            tap, and then it sits in this bar, which below 640px is pinned to the screen's foot: a challenge is where the
            guest's thumb already is, never scrolled out of view. It renders nothing without a site key (dev, e2e) or before
            the script runs; `min-w-0 max-w-full` and the controller's compact size under 300px keep it inside 320px. No margin:
            an invisible widget is a 0px box that must leave the bar exactly as it was (a margin on it showed as 10px). */}
        <TurnstileWidget controller={turnstile} />
        <button
          type="submit"
          data-testid="qm-start"
          // The server's HTML leaves Start enabled: without the script, `required` on the names guards the post (I1).
          disabled={hydrated && !canStart}
          className="block w-full rounded-xl bg-[var(--mk-lime)] px-4 py-3.5 text-center text-base font-semibold text-[var(--mk-night)] transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-cream)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {msg("quickMatch.setup.start")}
          {/* Always mounted, so a screen reader hears the count change (m2). */}{" "}
          <small aria-live="polite" data-testid="qm-start-count" className="text-sm font-medium opacity-75">
            {matches !== undefined ? count("quickMatch.setup.startCount", matches) : null}
          </small>
        </button>
      </div>
    </form>
  );
}
