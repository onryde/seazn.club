"use client";
// RS006 Step 4 — CONSENT (design §4 step 4). Privacy (required, versioned —
// carries owner ruling 5's names-public-by-default statement plainly at the
// moment of consent), media (optional, never blocks), a guardian block for a
// self-registering minor, and a captain-roster notice when the cart names
// other people.
//
// B2 T10 (spec 7.3): each consent LEADS with a Required or Optional tag, so the one that blocks is clear before an error appears; the
// long legal sentence is small print under the privacy consent's plain title; and the other-players notice is one info line (icon +
// text), not a third look-alike box. The join page reuses this step verbatim and gets the same. Owns nothing beyond wiring — `guardianRequired`/
// `cartHasOtherPlayers` (the two show/require decisions) are cart.ts/
// validation.ts's pure functions, computed once per render exactly like
// every other step's own live-feedback pieces (division-card.tsx's
// selfIneligible, entry-details.tsx's mixedUnmet).
import { useT } from "@/components/i18n/dict-provider";
import { cartHasOtherPlayers } from "./cart";
import { FIELD, FIELD_LABEL as LABEL, TAG_NEUTRAL } from "./styles";
import { guardianRequired, type ConsentValidation } from "./validation";
import { RegisterLichessCard, type RegisterLichessState } from "./register-lichess-card";
import { ConsentCameraNotes, type CameraRequirement } from "./online-play-note";
import type { CartState, ConsentState, ContactState } from "./types";

/** validation.ts's error codes don't share a naming scheme with the
 *  register.errors.* dictionary keys — same reasoning as step-who.tsx's
 *  ERROR_KEY, an explicit map avoids silently building a key that doesn't
 *  exist. */
const ERROR_KEY = {
  privacy: "register.errors.privacyConsent",
  guardianName: "register.errors.guardianName",
  guardianConsent: "register.errors.guardianConsent",
} as const;

export function StepConsent({
  contact,
  onContactChange,
  consent,
  onConsentChange,
  cart,
  orgName,
  errors,
  lichess = null,
  cameraRequirements = [],
}: {
  contact: ContactState;
  onContactChange: (patch: Partial<ContactState>) => void;
  consent: ConsentState;
  onConsentChange: (patch: Partial<ConsentState>) => void;
  cart: CartState;
  /** For the GDPR data-processing sentence's `{org}` interpolation
   *  (register.consent.data) — RegisterInfo widened to carry it. */
  orgName: string;
  errors: ConsentValidation["errors"];
  /** I5 (T16 fix round 1): the Lichess link, when a selected division plays online — the stepper decides; null ⇒ none. */
  lichess?: { divisions: string[]; orgSlug: string; next: string; state: RegisterLichessState } | null;
  /** Walk-fix F4: the camera requirement of each selected online division (`selectedCameraRequirements`) - stated HERE
   *  because every competition reaches CONSENT, while a single-division one skips the ENTRIES card that also states it.
   *  Empty (the join page, an over-the-board cart) ⇒ none. */
  cameraRequirements?: readonly CameraRequirement[];
}) {
  const t = useT();
  // Same "now" convention as division-card.tsx's own live window checks —
  // computed inline, no state, re-evaluated every render. Delegates to
  // validation.ts's guardianRequired (rather than re-deriving the same
  // check here inline, which is how this and validateConsent's own gate
  // drifted out of sync with the EFFECTIVE self dob in the first place —
  // guardian-consent-bypass fix, HIGH, 2026-08-26) so the block's visibility
  // and whether "Next" is blocked can never disagree again.
  const showGuardian = guardianRequired(cart, contact, new Date());
  const showRosterNotice = cartHasOtherPlayers(cart);

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.section.consent")}
      </h2>

      {lichess !== null && (
        <RegisterLichessCard divisions={lichess.divisions} orgSlug={lichess.orgSlug} next={lichess.next} state={lichess.state} />
      )}

      <ConsentCameraNotes requirements={cameraRequirements} />

      {/* Owner ruling 5, stated plainly at the moment of consent — this IS
          the ruling's designated surface (RS006 dispatch §B), not a buried
          footnote. */}
      <p className="mt-3 text-sm text-ink">{t("register.consent.namesPublic")}</p>

      {/* The required consent. The danger border is the registrant's own failed Continue (`errors.privacy` is only set after one), the
          same red-600 FIELD gives an invalid input. The tag leads; the title is the plain ask; the legal sentence is small print under
          it, inside the same label, so a tap anywhere on the box ticks it. `min-w-0` lets a long translated sentence wrap at 320. */}
      <div
        data-testid="reg-consent-privacy-box"
        className={`mt-4 rounded-lg border bg-canvas px-3.5 py-3 ${errors.privacy ? "border-red-600" : "border-zinc-200"}`}
      >
        <label className="flex cursor-pointer items-start gap-3">
          <input
            id="reg-consent-privacy"
            data-testid="reg-consent-grant"
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            checked={consent.privacy_consent}
            onChange={(e) => onConsentChange({ privacy_consent: e.target.checked })}
            aria-invalid={errors.privacy ? true : undefined}
            aria-describedby={errors.privacy ? "reg-consent-privacy-error" : undefined}
          />
          <span className="min-w-0">
            <span className="mb-1 block">
              <span className={TAG_NEUTRAL}>{t("register.consent.required")}</span>
            </span>
            <span className="block text-sm font-medium text-ink">{t("register.consent.privacy.title")}</span>
            <span className="mt-0.5 block text-xs text-ink-muted">
              {t("register.consent.data", { org: orgName })}{" "}
              <a
                href="/legal/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-accent-strong"
              >
                {t("register.consent.privacy")}
              </a>
            </span>
          </span>
        </label>
        {errors.privacy && (
          <p id="reg-consent-privacy-error" role="alert" className="mt-1.5 text-xs text-red-600">
            {t(ERROR_KEY.privacy)}
          </p>
        )}
      </div>

      <div data-testid="reg-consent-media-box" className="mt-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            id="reg-consent-media"
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            checked={consent.media_consent}
            onChange={(e) => onConsentChange({ media_consent: e.target.checked })}
          />
          <span className="min-w-0">
            <span className="mb-1 block">
              <span className={TAG_NEUTRAL}>{t("register.field.optional")}</span>
            </span>
            <span className="block text-sm font-medium text-ink">{t("register.consent.media.label", { org: orgName })}</span>
            <span className="mt-0.5 block text-xs text-ink-muted">{t("register.consent.media.hint")}</span>
          </span>
        </label>
      </div>

      {showGuardian && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3.5">
          <h3 className="font-display text-sm font-semibold uppercase tracking-wide text-amber-900">
            {t("register.guardian.title")}
          </h3>
          <p className="mt-1 text-xs text-amber-800">{t("register.guardian.intro")}</p>

          <div className="mt-3">
            <label className={LABEL} htmlFor="reg-guardian-name">
              {t("register.guardian.name.label")}
            </label>
            <input
              id="reg-guardian-name"
              type="text"
              maxLength={120}
              className={FIELD}
              placeholder={t("register.guardian.name.placeholder")}
              value={contact.guardian_name ?? ""}
              onChange={(e) => onContactChange({ guardian_name: e.target.value || null })}
              aria-invalid={errors.guardianName ? true : undefined}
            />
            {errors.guardianName && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {t(ERROR_KEY.guardianName)}
              </p>
            )}
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-ink">
            <input
              id="reg-guardian-consent"
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
              checked={contact.guardian_consent}
              onChange={(e) => onContactChange({ guardian_consent: e.target.checked })}
              aria-invalid={errors.guardianConsent ? true : undefined}
            />
            {t("register.guardian.consent.label")}
          </label>
          {errors.guardianConsent && (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {t(ERROR_KEY.guardianConsent)}
            </p>
          )}
        </div>
      )}

      {/* One info line, not a box (B2 T10): the two consents above are the things to decide; this only tells a captain what happens to
          the people they name. The icon takes `text-accent-strong`, the colour BTN_GHOST's text already wears. */}
      {showRosterNotice && (
        <p data-testid="reg-consent-roster-notice" className="mt-4 flex items-start gap-2 text-xs text-ink-muted">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="mt-px shrink-0 text-accent-strong"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5" />
            <path d="M12 8h.01" />
          </svg>
          <span className="min-w-0">{t("register.consent.rosterNotice")}</span>
        </p>
      )}
    </div>
  );
}
