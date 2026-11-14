"use client";
// Registration redesign B2 T7 (spec §7.1 + FP10) — the closing line under the register page's heading, "Registration closes
// 30 Nov, GMT+1". Shown only when every open division shares one closing time (steps.ts `sharedClosesAt`); the page decides that.
//
// A client island because the right zone is the VIEWER's: it is `windowDate` — the very formatter each division card uses — so the
// heading and the card under it name the same day in the same zone. The server cannot know the browser's zone, so the server pass
// and the hydrating client's first pass both say UTC (named in the text, never bare); the render after hydration reads the
// browser's own. `useHydrated` is what makes that switch hydration-safe — the same shape the rest of this tree uses.
import { useT } from "@/components/i18n/dict-provider";
import { useHydrated } from "@/lib/use-client-snapshot";
import { windowDate } from "./division-card";

export function RegistrationCloses({ iso, locale }: { iso: string; locale: string }) {
  const t = useT();
  const hydrated = useHydrated();
  return (
    <p className="mt-1 text-sm text-ink-muted">
      {t("register.heading.closes", { when: windowDate(iso, locale, hydrated ? undefined : "UTC") })}
    </p>
  );
}
