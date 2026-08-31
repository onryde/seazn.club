"use client";
// Client i18n context (v5 i18n cycle 47). A server feature page resolves the
// active locale's dict once (getDictionary(locale, ns), server-only) and wraps
// its island subtree in <DictProvider dict locale>. Islands read copy with
// useT()/usePlural()/useLocale() instead of taking dozens of per-string props.
// Only the ACTIVE locale's dict crosses the RSC boundary (a plain object) — no
// multi-locale bundle bloat, no server-only import in client code.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { DEFAULT_LOCALE, type Dict, type Locale } from "@/lib/i18n-constants";
import { plural as pluralRuntime, t as tRuntime, type TKey } from "@/lib/i18n-runtime";
import { messages, type MessageKey } from "@/lib/messages";

type DictContextValue = { dict: Dict; locale: Locale };

const DictContext = createContext<DictContextValue | null>(null);

export function DictProvider({
  dict,
  locale,
  children,
}: {
  dict: Dict;
  locale: Locale;
  children: ReactNode;
}) {
  const value = useMemo<DictContextValue>(() => ({ dict, locale }), [dict, locale]);
  return <DictContext.Provider value={value}>{children}</DictContext.Provider>;
}

function useDictContext(): DictContextValue {
  const ctx = useContext(DictContext);
  if (!ctx) {
    throw new Error("useT/usePlural/useLocale must be used within a <DictProvider>");
  }
  return ctx;
}

/** Bound `t(key, vars)` for the provided dict. Same lookup + interpolation as
 *  the server `t()`; falls back to the key on a miss (never throws). */
export function useT(): (key: TKey, vars?: Record<string, string | number>) => string {
  const { dict } = useDictContext();
  return useMemo(() => (key: TKey, vars?: Record<string, string | number>) => tRuntime(dict, key, vars), [dict]);
}

/** Bound `plural(key, count, vars)` using the provider's locale. */
export function usePlural(): (
  key: string,
  count: number,
  vars?: Record<string, string | number>,
) => string {
  const { dict, locale } = useDictContext();
  return useMemo(
    () => (key: string, count: number, vars?: Record<string, string | number>) =>
      pluralRuntime(dict, key, count, locale, vars),
    [dict, locale],
  );
}

/** The resolved active locale, for islands that need it directly (formatting). */
export function useLocale(): Locale {
  return useDictContext().locale;
}

/** The active locale, falling back to English OUTSIDE a provider instead of
 *  throwing — the same contract `useDict`/`useMsg` below already document,
 *  for the same reason: islands are rendered bare in this repo's component
 *  tests (renderToStaticMarkup, no provider), so an island that needs the
 *  locale only for FORMATTING (Intl.ListFormat/NumberFormat) should degrade
 *  to English there rather than red every unrelated assertion in the file.
 *  Use `useLocale` above when the locale is load-bearing and a silent English
 *  fallback would be a bug. */
export function useLocaleOrDefault(): Locale {
  return useContext(DictContext)?.locale ?? DEFAULT_LOCALE;
}

/** The raw active dict, for islands that pass it to a `t(dict, …)` child (e.g.
 *  the shared BuyCredits modal). Falls back to the English catalog outside a
 *  provider so it never throws in a bare test render. */
export function useDict(): Dict {
  const ctx = useContext(DictContext);
  return ctx?.dict ?? messages;
}

/** `usePlural`'s non-throwing sibling, and the exact counterpart of `useMsg`
 *  above: outside a DictProvider it falls back to the English catalog and the
 *  default locale rather than throwing.
 *
 *  R7-28 — added when the v3 pad host needed plural selection for a skin's
 *  activity detail ("1 pt" vs "1 pts"). `usePlural` throws bare, and this
 *  repo renders pad islands with no provider in component tests, so reaching
 *  for it there reddened 16 tests in three unrelated files that had nothing
 *  to do with plurals. Same reasoning `useLocaleOrDefault`/`useDict`/`useMsg`
 *  already document: use the throwing `usePlural` where a silent English
 *  fallback would be a bug, and this where the island must survive a bare
 *  render. */
export function useMsgPlural(): (key: string, count: number, vars?: Record<string, string | number>) => string {
  const ctx = useContext(DictContext);
  const dict = ctx?.dict ?? messages;
  const locale = ctx?.locale ?? DEFAULT_LOCALE;
  return useMemo(
    () => (key: string, count: number, vars?: Record<string, string | number>) =>
      pluralRuntime(dict, key, count, locale, vars),
    [dict, locale],
  );
}

/** Typed drop-in for the `ui` copy catalog: a console island replaces
 *  `import { msg } from "@/lib/messages"` + `msg("k")` with
 *  `const msg = useMsg()` + `msg("k")` and gets the active locale (the /o layout
 *  provides the `ui` dict). Keys stay checked against MessageKey. Outside a
 *  DictProvider it falls back to the English catalog — so islands shared with
 *  off-console surfaces (public/me/checkin) convert safely. */
export function useMsg(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const ctx = useContext(DictContext);
  const dict = ctx?.dict ?? messages;
  return useMemo(
    () => (key: MessageKey, vars?: Record<string, string | number>) => tRuntime(dict, key, vars),
    [dict],
  );
}
