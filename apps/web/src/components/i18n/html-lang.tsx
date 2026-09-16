"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** The cookie the footer switcher and `locale-preference.tsx` write. Read
 *  here rather than imported to keep this component free of server imports. */
const LOCALE_COOKIE = /(?:^|;\s*)seazn_locale=([^;]+)/;

function cookieLocale(): string | undefined {
  try {
    const m = LOCALE_COOKIE.exec(document.cookie);
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  } catch {
    // Cookie access throws in some embedded/partitioned contexts. The
    // attribute simply stays as the server rendered it.
    return undefined;
  }
}

/** What the static root serves: `lang="en"`, corrected from the cookie. */
const ROOT_LANG = "en";

/**
 * Corrects `<html lang>` on the client.
 *
 * The root layout renders `lang="en"` unconditionally (`app/layout.tsx`), and
 * it is the only place that renders `<html>` at all — a nested layout cannot
 * change the attribute server-side. Making the root layout `async` so it could
 * `await resolveLocale()` would opt the ENTIRE app into dynamic rendering:
 * `resolve-locale.ts:17-18` says so in its own words ("this reads
 * cookies()/headers(), so any component that calls it opts into dynamic
 * rendering. The static root layout deliberately does NOT call it"), and
 * `layout.tsx` is built around staying static/ISR-eligible. That is a real
 * trade on the highest-traffic surface, so this corrects the attribute after
 * hydration instead, at no rendering cost.
 *
 * Two sources, in priority order:
 *
 * 1. `lang` prop — passed by a layout that ALREADY resolved the locale
 *    server-side and is already dynamic, so the value is authoritative.
 *    `[lang]/(marketing)` passes its route segment; `o/[orgSlug]` passes what
 *    `resolveLocale()` returned.
 * 2. The `seazn_locale` cookie — for every other tree, where nothing knows the
 *    locale without opting into dynamic rendering. Not authoritative: a user
 *    whose locale comes from `users.locale` or Accept-Language without ever
 *    touching the switcher has no cookie, and those pages keep `en`.
 *
 * What this does NOT fix: a screen reader reading the document before
 * hydration, and no-JS entirely. Closing that means a dynamic root layout —
 * an owner-level trade, not something to slip in here. This is strictly better
 * than the status quo everywhere and worse nowhere.
 *
 * Client-side navigation keeps a layout mounted, so a write made once goes
 * stale two ways, and an authoritative (`lang`) instance answers both:
 *
 * - It RE-ASSERTS on every pathname change. Moving from a page whose own
 *   `<DictProvider>` wrote another locale (/shared's register flow is in the
 *   visitor's) back to a page of the same layout leaves nothing else to write
 *   it back. The effect runs before that page's provider (an earlier sibling
 *   of the layout's children), so a page that does write its own still wins.
 * - Its cleanup puts back what the ROOT would have left — the cookie, else the
 *   server's "en" — so leaving the tree for one that claims no locale does not
 *   keep this one's. Cleanups run before the next tree's effects, so a
 *   provider there still writes over it.
 *
 * The cookie instance (no `lang`) does neither: it sits in the root layout,
 * which every tree shares, and re-writing a guess on each navigation would
 * clobber the organiser shell's authoritative provider, whose own effect does
 * not re-run.
 */
export function HtmlLang({ lang }: { lang?: string }) {
  const pathname = usePathname();
  const authoritative = lang !== undefined;
  const navigation = authoritative ? pathname : null;
  useEffect(() => {
    const next = lang ?? cookieLocale();
    // Never clobber a correct value with a guess, and never write `undefined`.
    if (next && next !== document.documentElement.lang) {
      document.documentElement.lang = next;
    }
    if (!authoritative) return;
    return () => {
      const root = cookieLocale() ?? ROOT_LANG;
      if (document.documentElement.lang !== root) document.documentElement.lang = root;
    };
  }, [lang, authoritative, navigation]);
  return null;
}
