// SPEC-1 public "Suspensions" strip — active bans under the standings table,
// one dense zebra line each (name via public_person_name consent, matches left
// to serve). Muted courtside --ps-* palette, no card-glyph colour on the public
// tier (design direction). Renders nothing when there are no active bans.
//
// Its words are the competition hub's Info tab's (`info.suspensions`,
// `info.toServe`), in the page's language: the heading and the count used to
// be English literals on every division page (Task 16 review, I1).
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";

export function SuspensionsStrip({
  suspensions,
  dict,
  locale,
}: {
  suspensions: { name: string; remaining: number }[];
  /** The PUBLIC dictionary, and the locale its plural forms are chosen in. */
  dict: Dict;
  locale: Locale;
}) {
  if (suspensions.length === 0) return null;
  return (
    <section className="mt-8" data-testid="public-suspensions">
      <h3 className="mb-3 font-display text-lg font-semibold text-ink">{t(dict, "info.suspensions")}</h3>
      <ul className="overflow-hidden rounded-xl border border-zinc-200/80">
        {suspensions.map((s, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-3 px-4 py-2 text-sm odd:bg-surface even:bg-zinc-50/60"
          >
            <span className="min-w-0 truncate text-ink">{s.name}</span>
            <span className="shrink-0 text-xs text-ink-muted">{plural(dict, "info.toServe", s.remaining, locale)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
