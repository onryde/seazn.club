// Sibling of page.tsx: Next only tolerates its own fixed export set on a
// page module (see fixture-subheading.ts's own comment), so this helper the
// page needs lives here instead.

import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";

/**
 * Task 14b (task-14-review.md OWED item 3) — the WhatsApp/copy share text
 * `<ShareButton>` composes on the public fixture page (v3/10 #2) was two
 * hardcoded English templates ("Follow it live:", and a "full-time"
 * fallback when no decided sentence exists yet), unconditional in every
 * locale. Localised via `ui` — the SAME dict `ShareButton`'s own
 * "share.whatsapp"/"share.copied" labels resolve through (`page.tsx`'s
 * `<DictProvider dict={ui} .../>`) — following the exact `t(ui, "ref.share
 * TextCart", {...})` convention `(public)/r/[ref]/page.tsx` already uses.
 *
 * `result` is the ALREADY-COMPOSED "headline — decided sentence" string (or
 * just one of the two, or `undefined` if neither exists yet) that `page.tsx`
 * derives via its own `withDecidedLine` — this function's only job is the
 * decided/live branch and the localised wording around it, so it stays a
 * plain, directly-testable function (no DOM: `ShareButton`'s `text` prop
 * never touches rendered markup, only a client `onClick` closure — a
 * `renderToStaticMarkup` assertion could not see this string at all).
 */
export function shareTextFor(
  decided: boolean,
  home: string,
  away: string,
  division: string,
  competition: string,
  result: string | undefined,
  ui: Dict,
): string {
  if (decided) {
    return t(ui, "fixture.share.decided", {
      home,
      away,
      division,
      competition,
      result: result ?? t(ui, "fixture.share.fullTime"),
    });
  }
  return t(ui, "fixture.share.live", { home, away, division, competition });
}
