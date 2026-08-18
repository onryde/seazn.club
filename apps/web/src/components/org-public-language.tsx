"use client";

// The organisation's PUBLIC default language (organizations.default_locale).
//
// This column has been read by every entrant-facing surface for a long time —
// public org and competition pages, embeds, calendar.ics, OpenGraph images,
// the slideshow, and the locale frozen onto each new registration so the
// confirmation and refund mail matches the form the entrant filled in — while
// nothing anywhere could write it. A club whose members read French had no way
// to say so; every one of those surfaces fell back to English.
//
// Deliberately NOT users.locale, which sits directly above it in Preferences:
// that one is the console language for the person signed in. An English-reading
// organiser can run a French-speaking club, and before this control they had to
// choose between their own console and their entrants' pages.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { useMsg } from "@/components/i18n/dict-provider";

// Endonyms, matching locale-preference.tsx directly above it in the panel: a
// language is named in its own language or the person who needs it cannot find
// it. These are the only strings here that are deliberately NOT translated.
const LABELS: Record<Locale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  nl: "Nederlands",
};

export function OrgPublicLanguage({
  orgId,
  initialLocale,
}: {
  orgId: string;
  initialLocale: Locale;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [value, setValue] = useState<Locale>(initialLocale);
  const [saved, setSaved] = useState<Locale>(initialLocale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_locale: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? msg("settings.saveFailed"));
      }
      setSaved(value);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500">{msg("settings.org.publicLanguage.desc")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          className="input min-h-11 w-auto"
          aria-label={msg("settings.org.publicLanguage.aria")}
          value={value}
          onChange={(e) => setValue(e.target.value as Locale)}
        >
          {LOCALES.map((code) => (
            <option key={code} value={code}>
              {LABELS[code]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={value === saved || busy}
          className="btn btn-primary"
        >
          {busy ? msg("settings.saving") : msg("settings.org.save")}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
