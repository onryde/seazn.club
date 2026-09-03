"use client";
// RS006 Step 4 — CONSENT (design §4 step 4). Privacy (required, versioned —
// carries owner ruling 5's names-public-by-default statement plainly at the
// moment of consent), media (optional, never blocks), a guardian block for a
// self-registering minor, and a captain-roster notice when the cart names
// other people. Owns nothing beyond wiring — `guardianRequired`/
// `cartHasOtherPlayers` (the two show/require decisions) are cart.ts/
// validation.ts's pure functions, computed once per render exactly like
// every other step's own live-feedback pieces (division-card.tsx's
// selfIneligible, entry-details.tsx's mixedUnmet).
import { useT } from "@/components/i18n/dict-provider";
import { cartHasOtherPlayers } from "./cart";
import { FIELD, FIELD_LABEL as LABEL } from "./styles";
import { guardianRequired, type ConsentValidation } from "./validation";
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

      {/* Owner ruling 5, stated plainly at the moment of consent — this IS
          the ruling's designated surface (RS006 dispatch §B), not a buried
          footnote. */}
      <p className="mt-3 text-sm text-ink">{t("register.consent.namesPublic")}</p>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3">
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
          <span className="text-sm text-ink">
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
        </label>
        {errors.privacy && (
          <p id="reg-consent-privacy-error" role="alert" className="mt-1.5 text-xs text-red-600">
            {t(ERROR_KEY.privacy)}
          </p>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            id="reg-consent-media"
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            checked={consent.media_consent}
            onChange={(e) => onConsentChange({ media_consent: e.target.checked })}
          />
          <span>
            <span className="block text-sm text-ink">{t("register.consent.media.label", { org: orgName })}</span>
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

      {showRosterNotice && (
        <p className="mt-4 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3 text-xs text-ink-muted">
          {t("register.consent.rosterNotice")}
        </p>
      )}
    </div>
  );
}
