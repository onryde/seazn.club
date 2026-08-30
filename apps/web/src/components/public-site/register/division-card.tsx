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

/** Viewer-LOCAL date, not the organiser's (RS006 fix wave finding #2,
 *  MEDIUM) — the ORGANISER's timezone is not plumbed to this client at all
 *  today: `PublicRegistrationDivision`/`PublicRegistrationInfo`
 *  (schemas.ts:2312, :2346) carry no tz field, and `publicRegistrationInfo`'s
 *  own SQL query (registrations.ts:~1382) never selects
 *  `organizations.timezone` even though that column exists and already
 *  governs scheduling elsewhere (`settings.orgTz`, #397/#448). Inventing
 *  that plumbing is out of scope here (a server-schema change touching
 *  files this task doesn't own) — the proper fix would select `o.timezone`
 *  alongside the org fields `publicRegistrationInfo` already reads, ship it
 *  the same way `currency` already is (`currency: comp.currency`, resolved
 *  ORG-WIDE and flattened onto every division — registrations.ts:1460's own
 *  comment), and pass it down here as an explicit `timeZone` instead of
 *  leaving this function to infer one.
 *
 *  Until then: label what IS shown rather than leave it silently ambiguous.
 *  `timeZoneName: "short"` turns two viewers' bare dates that quietly
 *  DISAGREE for the same instant (Sydney's "6 Mar" vs LA's "5 Mar" for
 *  closes_at=2026-03-05T23:00:00Z) into two dates that visibly, honestly
 *  disagree ("6 Mar, GMT+11" vs "5 Mar, PST").
 *
 *  `timeZone` is a TEST-ONLY escape hatch — every production call site below
 *  omits it, so this still resolves the BROWSER's own ambient zone exactly
 *  as before this fix. It exists because this workspace's `process.env.TZ`
 *  does not move `Date`/`Intl` inside a vitest worker thread
 *  (zoned-datetime.test.ts's own header) — an explicit param is the only way
 *  a test can pin a zone deterministically instead of silently asserting
 *  whatever zone the CI box happens to run in. */
export function windowDate(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(iso));
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
  // Absolute-INSTANT comparison: `new Date(iso)` parses the server's
  // `Z`-suffixed ISO string to a fixed point on the timeline, same as `now`
  // — so, unlike `windowDate`'s DISPLAY above, this boolean does NOT vary by
  // viewer timezone (verified: two `Date` objects compare by their
  // underlying epoch millisecond, with no zone attached to either side).
  // Investigated per fix wave finding #2: the residual risk here is
  // ordinary staleness/clock-skew (division.open/closed_reason were decided
  // once, server-side, at fetch time; this re-derives freshness from the
  // VIEWER's own clock at render time) — not a timezone bug, and no
  // different from `division.open` itself already being unrevalidated
  // between fetch and render. Reconciling that needs either polling/
  // revalidation or the server splitting `closed_reason: "window"` into a
  // distinct "not yet open" vs "closed" reason (it currently sends one
  // value for both, which is WHY this client-side re-derivation exists at
  // all — the server never told us which side of `opens_at` we're on).
  // Both are out of scope here: a large change, and the second also touches
  // server files this task doesn't own.
  const notYetOpen = division.closed_reason === "window" && division.opens_at && new Date(division.opens_at) > now;
  const windowClosed = division.closed_reason === "window" && !notYetOpen;
  // De-emphasis for a division the CONTACT personally doesn't qualify for
  // (design: "grey-with-reason ... stays pickable for team entries" — the
  // card must never read as disabled). A VISUAL cue only: the title and
  // the colorful category/age badges drop to the SAME muted tone a closed
  // division's badges already use elsewhere on this card (reusing this
  // file's own existing token pairing, not inventing a new color — see the
  // fix wave report for the contrast check), and the card gets the same
  // muted background a closed card already gets. The amber reason notice
  // below stays at full weight (never dimmed — it must stay legible), and
  // every Add control keeps its normal opacity and stays enabled/keyboard-
  // reachable; only presentation changes, never interactivity.
  const selfIneligible = imPlaying && selfEligibility != null && !selfEligibility.eligible;

  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition sm:p-5 ${
        division.open && !selfIneligible ? "border-zinc-200/80 bg-surface" : "border-zinc-200/80 bg-zinc-50"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3
          className={`break-words font-display text-lg font-semibold ${selfIneligible ? "text-ink-muted" : "text-ink"}`}
        >
          {division.name}
        </h3>
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
        <span className={`${BADGE} ${selfIneligible ? "bg-zinc-100 text-ink-muted" : "bg-accent-soft text-accent-strong"}`}>
          {t(categoryKey)}
        </span>
        {ageLabel && (
          <span className={`${BADGE} ${selfIneligible ? "bg-zinc-100 text-ink-muted" : "bg-accent-soft text-accent-strong"}`}>
            {ageLabel}
          </span>
        )}
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

      {/* RS007/V380 — the retired jsonb "custom rule" note, now rendered
          (defect #3 the V380 migration's own header describes: written by
          the wizard, shown nowhere). Organiser-authored free text —
          interpolated into the translated template and rendered as a plain
          text child, never dangerouslySetInnerHTML, so it can never be
          treated as HTML/markdown. Unconditional on imPlaying/eligibility:
          it is general information about the division, not a per-viewer
          verdict. */}
      {division.eligibility_note && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("register.organiserNote", { note: division.eligibility_note })}
        </p>
      )}

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
