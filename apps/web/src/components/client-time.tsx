"use client";

import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useLocaleOrDefault } from "@/components/i18n/dict-provider";
import { fmtDate, fmtTime, fmtDateTime, fmtZoneAbbrev } from "@/lib/format";
import { useHydrated } from "@/lib/use-client-snapshot";

/**
 * Viewer timezone (spec 2026-07-14). A logged-in user's saved `users.timezone`
 * is passed down from whichever server component already loaded the user (no
 * extra query, and it keeps the resolution OUT of the root layout so that
 * layout stays static). When no pref is provided we detect the browser zone on
 * the client. Personal-lane times render in this zone; the venue lane uses it
 * only to show the viewer's local equivalent beside the authoritative venue time.
 */
const ViewerTzContext = createContext<string | null | undefined>(undefined);

export function ViewerTzProvider({
  tz,
  children,
}: {
  tz: string | null | undefined;
  children: React.ReactNode;
}) {
  return <ViewerTzContext.Provider value={tz}>{children}</ViewerTzContext.Provider>;
}

/** The browser's own zone, or null when the engine cannot resolve one. A
 *  string, so two reads compare equal and `useSyncExternalStore` is stable. */
function readBrowserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null; // → UTC
  }
}
const noBrowserZone = () => null;
const zoneNeverChanges = () => () => {};

/** The viewer's zone: saved preference if present, else browser-detected.
 *  The browser zone is read through `useSyncExternalStore` (server snapshot
 *  null → "UTC"), so the server and the hydration render agree and the
 *  detected zone arrives on the render after hydration — the same moment the
 *  old mount effect delivered it, minus the effect's extra render. */
export function useViewerTz(): string {
  const pref = useContext(ViewerTzContext);
  const detected = useSyncExternalStore(zoneNeverChanges, readBrowserZone, noBrowserZone);
  return pref || detected || "UTC";
}

/** Same wall-clock label in both zones → nothing to disambiguate. */
function zonesAgree(a: string, b: string, value: string | Date): boolean {
  return (
    fmtTime(a, value) === fmtTime(b, value) &&
    fmtZoneAbbrev(a, value) === fmtZoneAbbrev(b, value)
  );
}

/**
 * A time rendered in an explicit zone, always labelled, with the viewer's local
 * equivalent one glance (subtitle) or hover away. Superset of ClientTime:
 *  - `tz`       the zone to render the value in (venue tz, or the viewer's).
 *  - `showZone` append the zone abbrev ("19:00 IST").
 *  - `you`      "subtitle" | "hover" | "off" — expose the viewer's local time
 *               when `tz` differs from the viewer's zone (venue lane). Rendered
 *               client-side because Node ICU emits offsets where browsers emit
 *               IST/BST; the empty-until-mount span keeps SSR + client in step.
 */
export function Zoned({
  value,
  tz,
  mode = "datetime",
  showZone = false,
  you = "off",
}: {
  value: string | Date | null;
  tz: string;
  mode?: "time" | "datetime" | "date";
  showZone?: boolean;
  you?: "off" | "subtitle" | "hover";
}) {
  const viewerTz = useViewerTz();
  // Empty on the server and through hydration (Node ICU and the browser spell
  // zones differently), then derived in render — never copied into state.
  const hydrated = useHydrated();
  const { main, local } = useMemo(() => {
    if (!hydrated || !value) return { main: "", local: null };
    const fmtMain = mode === "date" ? fmtDate : mode === "time" ? fmtTime : fmtDateTime;
    const label = fmtMain(tz, value);
    const shown = showZone ? `${label} ${fmtZoneAbbrev(tz, value)}` : label;
    if (you !== "off" && viewerTz && !zonesAgree(tz, viewerTz, value)) {
      const lt = mode === "date" ? fmtDate(viewerTz, value) : fmtTime(viewerTz, value);
      return { main: shown, local: `${lt} ${fmtZoneAbbrev(viewerTz, value)}` };
    }
    return { main: shown, local: null };
  }, [hydrated, value, tz, mode, showZone, you, viewerTz]);

  if (you === "hover" && local) {
    return (
      <span className="tz-hoverable" tabIndex={0} suppressHydrationWarning>
        {main}
        <span className="tz-tip" role="tooltip">
          <span className="tz-tip-you">{local}</span>
          <span className="tz-tip-lbl">your time</span>
        </span>
      </span>
    );
  }

  return (
    <span suppressHydrationWarning>
      {main}
      {you === "subtitle" && local && (
        <span className="tz-you" aria-label={`your local time ${local}`}>
          {local}
        </span>
      )}
    </span>
  );
}

/**
 * Renders a locale/timezone-formatted time on the client only. The first
 * render (server + client hydration) is an empty span, so the markup matches
 * and React doesn't report a hydration mismatch; the formatted value fills in
 * on the render after hydration (`useHydrated`), using the viewer's local
 * timezone — and on the FIRST render of a ClientTime mounted client-side
 * later, which the old mount effect painted empty for a frame. A value that
 * goes back to null empties the span (the effect used to leave the last time
 * on screen).
 */
export function ClientTime({
  value,
  mode = "time",
  tz,
  showZone = false,
  hourCycle,
}: {
  value: string | Date | null;
  mode?: "time" | "datetime" | "date";
  /** Render in this IANA zone instead of the viewer's (v3/04 §3 — schedule
   *  pages show the competition timezone, never a browser-local surprise). */
  tz?: string;
  /** Append the zone abbrev ("19:00 IST"). No-op for date mode (no clock). */
  showZone?: boolean;
  /** Force a clock convention regardless of locale default. F9 (W2
   *  walkthrough gate 1): the run sheet's fixed 56px time column wrapped to
   *  two lines on EVERY row at EVERY width, because an English-locale
   *  "2:30 PM" does not fit a column sized for "14:30" — 5 monospace
   *  characters. Callers with a fixed-width clock cell pass `"h23"`; every
   *  other caller keeps the locale's own convention (unset). */
  hourCycle?: "h23" | "h12";
}) {
  // F8 (W2 walkthrough gate 1): `[]` as an Intl locale argument means "the
  // runtime's default locale" — the VIEWER'S BROWSER, not the app's active
  // one. A French-language page with an en-US browser printed 12-hour "2:30
  // PM" times inside otherwise-French copy. `dayLabelLong` (this row's own
  // day header, finding 13) was already fixed for the identical defect;
  // `useLocaleOrDefault` degrades to English outside a `DictProvider` (this
  // component renders bare in several component tests) rather than throwing.
  const locale = useLocaleOrDefault();
  const hydrated = useHydrated();
  const text = useMemo(() => {
    if (!hydrated || !value) return "";
    const d = value instanceof Date ? value : new Date(value);
    const zone: Intl.DateTimeFormatOptions = {
      ...(tz ? { timeZone: tz } : {}),
      ...(hourCycle ? { hourCycle } : {}),
    };
    try {
      const base =
        mode === "datetime"
          ? d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", ...zone })
          : mode === "date"
            ? d.toLocaleDateString(locale, { dateStyle: "medium", ...zone })
            : d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...zone });
      const abbrev =
        showZone && mode !== "date" ? ` ${fmtZoneAbbrev(tz ?? UTC_LOCAL(), d)}` : "";
      return base + abbrev;
    } catch {
      // Unknown zone string — fall back to the viewer's local time, still in
      // the app's own locale.
      return mode === "date" ? d.toLocaleDateString(locale) : d.toLocaleString(locale);
    }
  }, [hydrated, value, mode, tz, showZone, locale, hourCycle]);

  return <span suppressHydrationWarning>{text}</span>;
}

/** Viewer's own zone, for labelling times ClientTime renders without an
 *  explicit tz (so "showZone" still names a zone rather than guessing). */
function UTC_LOCAL(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Compact date range ("12–14 Aug" / "30 Aug – 2 Sep"), same client-only fill
 * pattern as ClientTime. Used by round headers on the division schedule
 * (v3/04 §3 item 1).
 */
export function ClientDateRange({
  from,
  to,
  tz,
}: {
  from: string | Date | null;
  to: string | Date | null;
  tz?: string;
}) {
  const hydrated = useHydrated();
  const text = useMemo(() => {
    if (!hydrated || !from) return "";
    const a = from instanceof Date ? from : new Date(from);
    const b = to ? (to instanceof Date ? to : new Date(to)) : a;
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
    if (tz) opts.timeZone = tz;
    try {
      const fa = a.toLocaleDateString([], opts);
      const fb = b.toLocaleDateString([], opts);
      return fa === fb ? fa : `${fa} – ${fb}`;
    } catch {
      return a.toLocaleDateString();
    }
  }, [hydrated, from, to, tz]);

  return <span suppressHydrationWarning>{text}</span>;
}
