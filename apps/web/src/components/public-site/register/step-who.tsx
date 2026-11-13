"use client";
// RS006 Step 1 — WHO (design §4 step 1). Contact fields, "I'm playing"
// toggle, dob/gender shown only when validation.ts's whoFieldRequirements
// says a division needs them or the registrant is playing themselves.
import type { Ref } from "react";
import { usePlural, useT } from "@/components/i18n/dict-provider";
import { FIELD, FIELD_LABEL as LABEL } from "./styles";
import type { ContactValidation, WhoFieldRequirements } from "./validation";
import type { ContactState, Gender } from "./types";

/** validation.ts's error codes don't share a naming scheme with the
 *  register.errors.* dictionary keys (e.g. "emailRequired" AND
 *  "emailInvalid" both read as one example-address sentence) —
 *  an explicit map avoids silently building a key that doesn't exist. */
const ERROR_KEY = {
  nameRequired: "register.errors.name",
  nameTooLong: "register.errors.nameTooLong",
  emailRequired: "register.who.email.invalid",
  emailInvalid: "register.who.email.invalid",
  dobRequired: "register.errors.dob",
  dobInvalid: "register.errors.dobInvalid",
  genderRequired: "register.errors.gender",
} as const;

/** The fields the error summary can name, in the order they sit on the page, each with the label it is named by. */
const SUMMARY_FIELDS = [
  ["name", "register.who.name.label"],
  ["email", "register.who.email.label"],
  ["dob", "register.who.dob.label"],
  ["gender", "register.who.gender.label"],
] as const;

export function StepWho({
  contact,
  onChange,
  imPlaying,
  onImPlayingChange,
  requirements,
  errors,
  summaryRef,
  showSelfToggle = true,
}: {
  contact: ContactState;
  onChange: (patch: Partial<ContactState>) => void;
  imPlaying: boolean;
  onImPlayingChange: (value: boolean) => void;
  requirements: WhoFieldRequirements;
  errors: ContactValidation["errors"];
  /** Attached to the error summary. The stepper focuses it on a failed Continue (B2 T9): it only exists while something is wrong, so
   *  the ref is handed in rather than owned here, where a ref effect could not tell a first failure from a second. */
  summaryRef?: Ref<HTMLDivElement>;
  /** RS007 join page — a joiner IS unambiguously the one playing (there is
   *  no "I'm just facilitating this for someone else" case on a join
   *  link), so this toggle has nothing to ask there. Defaults to true —
   *  RS006's own register flow (every existing caller) is unchanged. */
  showSelfToggle?: boolean;
}) {
  const t = useT();
  const plural = usePlural();
  const failing = SUMMARY_FIELDS.filter(([key]) => errors[key]);
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.section.identity")}
      </h2>

      {/* The error summary (B2 T9, spec 7.3): one alert naming every field that is wrong, so a person on a phone does not have to
          scroll the card to find out why Continue did nothing. It is THE alert on this card: the per-field messages below are plain
          text tied to their field by aria-describedby, so the same problems are not announced twice. Tokens: the red-200 / red-50 /
          red-700 box of entry-cart.tsx's own error block. `tabIndex={-1}` makes it a focus target the stepper can move to. */}
      {failing.length > 0 && (
        <div
          ref={summaryRef}
          id="reg-who-summary"
          role="alert"
          tabIndex={-1}
          data-testid="reg-who-error-summary"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700"
        >
          {plural("register.errors.summary", failing.length, { list: failing.map(([, label]) => t(label)).join(", ") })}
        </div>
      )}

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
            aria-describedby={errors.name ? "reg-who-name-error" : "reg-who-name-hint"}
          />
          {errors.name ? (
            <p id="reg-who-name-error" className="mt-1 text-xs text-red-600">
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
            aria-describedby={errors.email ? "reg-who-email-error" : "reg-who-email-hint"}
          />
          {errors.email ? (
            <p id="reg-who-email-error" className="mt-1 text-xs text-red-600">
              {t(ERROR_KEY[errors.email])}
            </p>
          ) : (
            <p id="reg-who-email-hint" className="mt-1 text-xs text-ink-muted">
              {t("register.who.email.hint")}
            </p>
          )}
        </div>
      </div>

      {/* The playing card (B2 T9, spec 7.3): ONE label wraps the checkbox and both lines, so a tap anywhere on the card toggles it,
          and the card shows the choice (accent-line border, accent-soft fill: the tokens of BTN_GHOST's hover) rather than leaving
          it to a 16px box. `min-w-0` lets a long translated sentence wrap instead of widening the card at 320. */}
      {showSelfToggle && (
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3 transition has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft">
          <input
            type="checkbox"
            data-testid="reg-who-playing"
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            checked={imPlaying}
            onChange={(e) => onImPlayingChange(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">{t("register.who.playing.title")}</span>
            <span className="mt-0.5 block text-xs text-ink-muted">{t("register.who.playing.body")}</span>
          </span>
        </label>
      )}

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
                aria-describedby={errors.dob ? "reg-who-dob-error" : "reg-who-dob-hint"}
              />
              {errors.dob ? (
                <p id="reg-who-dob-error" className="mt-1 text-xs text-red-600">
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
                aria-describedby={errors.gender ? "reg-who-gender-error" : "reg-who-gender-hint"}
              >
                <option value="" disabled>
                  {t("register.who.gender.label")}
                </option>
                <option value="m">{t("register.who.gender.m")}</option>
                <option value="f">{t("register.who.gender.f")}</option>
                <option value="x">{t("register.who.gender.x")}</option>
              </select>
              {errors.gender ? (
                <p id="reg-who-gender-error" className="mt-1 text-xs text-red-600">
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
