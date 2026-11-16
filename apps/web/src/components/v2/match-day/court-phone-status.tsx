// A court's phone, as the desk says it (court stream spec 2026-11-14 §5.5; web plan Task 12): the status chip a linked court's list
// row and its focus both carry, and the focus's status block — the chip, the channel the court streams to, how long the link
// works, and the court's latest refused automatic start. Presentational: the read it paints is `MatchDayCourt.stream_link`.
//
// The four states differ in SHAPE as well as colour (a solid dot, a hollow ring, a dashed ring, a pulse that stills under
// reduced motion), so a reader who cannot tell amber from slate still can. Red is the existing "Live" of the court row
// (`LiveBadge`): nothing but a live stream is red, so a phone that dropped out is amber, never red.
import type { Dict, Locale } from "@/lib/i18n-constants";
import { fmtPublicTime } from "@/lib/format";
import { t } from "@/lib/i18n-runtime";
import { lastWorkingMinute, phoneKey } from "@/lib/match-day/court-stream";
import type { MatchDayCourtStream } from "@/lib/match-day/types";
import { CourtTailCountdown } from "./court-tail-countdown";

type Phone = MatchDayCourtStream["phone"];

const CHIP: Record<Phone, { box: string; dot: string }> = {
  unpaired: { box: "bg-slate-100 text-slate-700 ring-slate-200", dot: "border border-slate-400" },
  waiting: { box: "bg-emerald-50 text-emerald-800 ring-emerald-100", dot: "bg-emerald-500" },
  live: { box: "bg-red-50 text-red-700 ring-red-100", dot: "bg-red-600 motion-safe:animate-pulse" },
  offline: { box: "bg-amber-50 text-amber-800 ring-amber-100", dot: "border-2 border-dashed border-amber-600" },
};

/** The phone's status in one pill: "No phone yet", "Phone waiting", "Live" or "Phone offline". */
export function CourtPhoneChip({ dict, phone, className = "" }: { dict: Dict; phone: Phone; className?: string }) {
  const look = CHIP[phone];
  return (
    <span
      data-testid="md-cs-chip"
      data-phone={phone}
      className={`inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${look.box} ${className}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${look.dot}`} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{t(dict, phoneKey(phone))}</span>
    </span>
  );
}

/** The court focus's status block: chip, the channel, "Works until 23:59 today", and a refused automatic start in the stream
 *  panel's own words (`stream.auto.refused` + `stream.auto.refusal.*`). */
export function CourtPhoneStatus({
  dict,
  locale,
  tz,
  link,
  viewNow,
}: {
  dict: Dict;
  locale: Locale;
  tz: string;
  link: MatchDayCourtStream;
  /** The view's server `now`, which the tail countdown is anchored to (O16). */
  viewNow?: string;
}) {
  const until = fmtPublicTime(locale, tz, lastWorkingMinute(link.expires_at));
  return (
    <div data-testid="md-cs-status" className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <CourtPhoneChip dict={dict} phone={link.phone} />
        <p className="min-w-0 text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{link.target_label}</p>
      </div>
      <p className="mt-1 text-xs text-slate-600">{t(dict, "matchDay.courtStream.until", { time: until })}</p>
      {link.tail_ends_at !== null && (
        <CourtTailCountdown dict={dict} tailEndsAt={link.tail_ends_at} viewNow={viewNow} className="mt-1 text-sm font-medium text-slate-900" />
      )}
      {link.refusal !== null && (
        <p data-testid="md-cs-refusal" data-refusal={link.refusal} className="mt-2 text-xs font-medium text-amber-900 [overflow-wrap:anywhere]">
          {t(dict, "stream.auto.refused", { reason: t(dict, `stream.auto.refusal.${link.refusal}`) })}
        </p>
      )}
    </div>
  );
}
