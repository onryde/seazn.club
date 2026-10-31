// Match Day's scorer mark (spec 2026-10-31 §9: "`no_scorer` / `not_recording` also mark the affected court's row"; task A4): a
// small dot and words, in the colour of the Needs-you row the same fact makes (the kind's own severity, `ATTENTION_SEVERITY` —
// never chosen here), on the court's list row and beside the court's scorer QR.
import type { Severity } from "@/lib/division-phase";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { ScorerAttention } from "@/lib/match-day/types";

/** The Needs-you list's own dot colours (needs-you.tsx `DOT`), and a text colour that reads at AA on white. */
const TONE: Record<Severity, { dot: string; text: string }> = {
  red: { dot: "bg-red-600", text: "text-red-700" },
  amber: { dot: "bg-amber-600", text: "text-amber-800" },
  slate: { dot: "bg-slate-500", text: "text-slate-700" },
};

export function ScorerMark({ dict, kind, severity }: { dict: Dict; kind: ScorerAttention; severity: Severity }) {
  const tone = TONE[severity];
  return (
    <span
      data-md-scorer={kind}
      data-severity={severity}
      className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold ${tone.text}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="min-w-0 truncate">{t(dict, `matchDay.scorer.${kind}`)}</span>
    </span>
  );
}
