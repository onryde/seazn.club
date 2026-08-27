"use client";
// RS006 Step 1 — WHO (design §4 step 1). Contact fields, "I'm playing"
// toggle, dob/gender shown only when validation.ts's whoFieldRequirements
// says a division needs them or the registrant is playing themselves.
import { useT } from "@/components/i18n/dict-provider";
import { FIELD, FIELD_LABEL as LABEL } from "./styles";
import type { ContactValidation, WhoFieldRequirements } from "./validation";
import type { ContactState, Gender } from "./types";

/** validation.ts's error codes don't share a naming scheme with the
 *  register.errors.* dictionary keys (e.g. "emailRequired" AND
 *  "emailInvalid" both read as one generic "enter a valid email" copy) —
 *  an explicit map avoids silently building a key that doesn't exist. */
const ERROR_KEY = {
  nameRequired: "register.errors.name",
  nameTooLong: "register.errors.nameTooLong",
  emailRequired: "register.errors.email",
  emailInvalid: "register.errors.email",
  dobRequired: "register.errors.dob",
  dobInvalid: "register.errors.dobInvalid",
  genderRequired: "register.errors.gender",
} as const;

export function StepWho({
  contact,
  onChange,
  imPlaying,
  onImPlayingChange,
  requirements,
  errors,
}: {
  contact: ContactState;
  onChange: (patch: Partial<ContactState>) => void;
  imPlaying: boolean;
  onImPlayingChange: (value: boolean) => void;
  requirements: WhoFieldRequirements;
  errors: ContactValidation["errors"];
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.section.identity")}
      </h2>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="reg-who-name">
            {t("register.who.name.label")}
          </label>
          <input
            id="reg-who-name"
            type="text"
            autoComplete="name"
            maxLength={120}
            className={FIELD}
            placeholder={t("register.who.name.placeholder")}
            value={contact.name}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby="reg-who-name-hint"
          />
          {errors.name ? (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {t(ERROR_KEY[errors.name])}
            </p>
          ) : (
            <p id="reg-who-name-hint" className="mt-1 text-xs text-ink-muted">
              {t("register.who.name.hint")}
            </p>
          )}
        </div>

        <div>
          <label className={LABEL} htmlFor="reg-who-email">
            {t("register.who.email.label")}
          </label>
          <input
            id="reg-who-email"
            type="email"
            autoComplete="email"
            maxLength={200}
            className={FIELD}
            placeholder={t("register.who.email.placeholder")}
            value={contact.email}
            onChange={(e) => onChange({ email: e.target.value })}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby="reg-who-email-hint"
          />
          {errors.email ? (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {t(ERROR_KEY[errors.email])}
            </p>
          ) : (
            <p id="reg-who-email-hint" className="mt-1 text-xs text-ink-muted">
              {t("register.who.email.hint")}
            </p>
          )}
        </div>
      </div>

      <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          checked={imPlaying}
          onChange={(e) => onImPlayingChange(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-ink">{t("register.self.label")}</span>
          <span className="mt-0.5 block text-xs text-ink-muted">{t("register.self.hint")}</span>
        </span>
      </label>

      {(requirements.dobRequired || requirements.genderRequired) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {requirements.dobRequired && (
            <div>
              <label className={LABEL} htmlFor="reg-who-dob">
                {t("register.who.dob.label")}
              </label>
              <input
                id="reg-who-dob"
                type="date"
                className={FIELD}
                value={contact.dob ?? ""}
                onChange={(e) => onChange({ dob: e.target.value || null })}
                aria-invalid={errors.dob ? true : undefined}
                aria-describedby="reg-who-dob-hint"
              />
              {errors.dob ? (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {t(ERROR_KEY[errors.dob])}
                </p>
              ) : (
                <p id="reg-who-dob-hint" className="mt-1 text-xs text-ink-muted">
                  {t("register.who.dob.hint")}
                </p>
              )}
            </div>
          )}

          {requirements.genderRequired && (
            <div>
              <label className={LABEL} htmlFor="reg-who-gender">
                {t("register.who.gender.label")}
              </label>
              <select
                id="reg-who-gender"
                className={FIELD}
                value={contact.gender ?? ""}
                onChange={(e) => onChange({ gender: (e.target.value || null) as Gender | null })}
                aria-invalid={errors.gender ? true : undefined}
                aria-describedby="reg-who-gender-hint"
              >
                <option value="" disabled>
                  {t("register.who.gender.label")}
                </option>
                <option value="m">{t("register.who.gender.m")}</option>
                <option value="f">{t("register.who.gender.f")}</option>
                <option value="x">{t("register.who.gender.x")}</option>
              </select>
              {errors.gender ? (
                <p role="alert" className="mt-1 text-xs text-red-600">
                  {t(ERROR_KEY[errors.gender])}
                </p>
              ) : (
                <p id="reg-who-gender-hint" className="mt-1 text-xs text-ink-muted">
                  {t("register.who.gender.hint")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
