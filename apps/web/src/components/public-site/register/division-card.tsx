"use client";
// RS006 Step 2 — one division card (design §4 step 2). Badges: category,
// age band, fee (+payment method), capacity/waitlist, window. A
// self-ineligible-but-open division greys with the reason (design: "stay
// pickable for team entries") — every Add control below still works
// regardless, because only the CONTACT's own eligibility is in question,
// never whether the division accepts entries at all (that's `open`).
import { useT } from "@/components/i18n/dict-provider";
import { formatMinor, type Currency } from "@/lib/currency";
import { INELIGIBLE_MESSAGE_KEY, type SelfEligibility } from "./eligibility-presentation";
import { BTN_GHOST, BTN_PRIMARY } from "./styles";
import type { DivisionLike } from "./types";

const CATEGORY_KEY = {
  open: "register.entries.category.open",
  mens: "register.entries.category.mens",
  womens: "register.entries.category.womens",
  mixed: "register.entries.category.mixed",
} as const;

const BADGE = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium";

function windowDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(iso));
}

export function DivisionCard({
  division,
  locale,
  selfEligibility,
  imPlaying,
  onAddTeam,
  onAddPair,
  onAddIndividual,
  onAddSoloSignup,
}: {
  division: DivisionLike;
  locale: string;
  /** null when the contact hasn't declared they're playing — no
   *  self-ineligibility notice makes sense for a rep who isn't a player. */
  selfEligibility: SelfEligibility | null;
  imPlaying: boolean;
  onAddTeam?: () => void;
  onAddPair?: () => void;
  onAddIndividual?: () => void;
  onAddSoloSignup?: () => void;
}) {
  const t = useT();
  const categoryKey = CATEGORY_KEY[(division.category as keyof typeof CATEGORY_KEY) ?? "open"] ?? CATEGORY_KEY.open;

  const ageLabel =
    division.age_min != null && division.age_max != null
      ? t("register.entries.age.range", { min: division.age_min, max: division.age_max })
      : division.age_min != null
        ? t("register.entries.age.min", { min: division.age_min })
        : division.age_max != null
          ? t("register.entries.age.max", { max: division.age_max })
          : null;

  const feeLabel = division.fee_cents === 0 ? t("register.entries.free") : formatMinor(division.fee_cents, division.currency as Currency, locale);

  const now = new Date();
  const notYetOpen = division.closed_reason === "window" && division.opens_at && new Date(division.opens_at) > now;
  const windowClosed = division.closed_reason === "window" && !notYetOpen;

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition sm:p-5 ${
        division.open ? "border-zinc-200/80 bg-surface" : "border-zinc-200/80 bg-zinc-50"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-lg font-semibold text-ink">{division.name}</h3>
        <div className="font-display text-base font-bold text-ink">
          {feeLabel}
          {division.fee_cents > 0 && division.payment_method === "offline" && (
            <span className="ml-1 font-sans text-xs font-normal text-ink-muted">
              · {t("register.method.offline")}
            </span>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <span className={`${BADGE} bg-accent-soft text-accent-strong`}>{t(categoryKey)}</span>
        {ageLabel && <span className={`${BADGE} bg-accent-soft text-accent-strong`}>{ageLabel}</span>}
        {division.closed_reason === "full" ? (
          <span className={`${BADGE} bg-amber-100 text-amber-800`}>{t("register.entries.badge.waitlist")}</span>
        ) : (
          division.capacity != null && (
            <span className={`${BADGE} bg-zinc-100 text-ink-muted`} aria-label={t("register.capacity.taken", { taken: division.taken, capacity: division.capacity })}>
              {division.taken}/{division.capacity}
            </span>
          )
        )}
        {notYetOpen && division.opens_at && (
          <span className={`${BADGE} bg-zinc-100 text-ink-muted`}>
            {t("register.entries.window.opens", { date: windowDate(division.opens_at, locale) })}
          </span>
        )}
        {windowClosed && <span className={`${BADGE} bg-zinc-200 text-ink-muted`}>{t("register.entries.badge.closed")}</span>}
        {division.open && division.closed_reason !== "full" && division.closes_at && (
          <span className={`${BADGE} bg-zinc-100 text-ink-muted`}>
            {t("register.entries.window.closes", { date: windowDate(division.closes_at, locale) })}
          </span>
        )}
        {division.closed_reason === "payments_unavailable" && (
          <span className={`${BADGE} bg-red-50 text-red-700`}>{t("register.payments.unavailable.title")}</span>
        )}
      </div>

      {imPlaying && selfEligibility && !selfEligibility.eligible && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {selfEligibility.issues
            .map((issue) => INELIGIBLE_MESSAGE_KEY[issue.code])
            .filter((key): key is string => Boolean(key))
            .map((key) => (
              <p key={key}>{t(key)}</p>
            ))}
          {division.entrant_kind === "team" && <p className="mt-0.5 font-medium">{t("register.entries.ineligible.stillTeam")}</p>}
        </div>
      )}

      {division.open && (
        <div className="mt-3.5 flex flex-wrap gap-2">
          {division.entrant_kind === "team" && onAddTeam && (
            <button type="button" onClick={onAddTeam} className={BTN_PRIMARY}>
              {t("register.entries.add.team")}
            </button>
          )}
          {division.entrant_kind === "pair" && onAddPair && (
            <button type="button" onClick={onAddPair} className={BTN_PRIMARY}>
              {t("register.entries.add.pair")}
            </button>
          )}
          {division.entrant_kind === "individual" && onAddIndividual && (
            <button type="button" onClick={onAddIndividual} className={BTN_PRIMARY}>
              {t("register.entries.add.individual")}
            </button>
          )}
          {division.entrant_kind === "team" && division.allow_free_agents && onAddSoloSignup && (
            <button type="button" onClick={onAddSoloSignup} className={BTN_GHOST}>
              {t("register.entries.add.soloSignup")}
            </button>
          )}
        </div>
      )}
      {division.entrant_kind === "team" && division.allow_free_agents && division.open && (
        <p className="mt-1.5 text-xs text-ink-muted">{t("register.entries.soloSignup.hint")}</p>
      )}
    </div>
  );
}
