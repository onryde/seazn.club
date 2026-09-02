import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { sportEmoji } from "@/components/discovery-cards";
import { whenLabel } from "@/lib/division-status-line";
import type { DeskDivision } from "@/server/usecases/competition-desk";
import { PhasePill } from "./phase-pill";

export interface LedgerRow {
  id: string;
  name: string;
  slug: string;
  sportKey: string;
  logoUrl: string | null;
  /** null when getCompetitionDesk failed: the row still renders from card stats. */
  desk: DeskDivision | null;
  statusLine: string;
  menu?: ReactNode;
}

const BAR: Record<DeskDivision["phase"], string> = {
  setting_up: "bg-purple-600", scheduled: "bg-purple-600", match_day: "bg-amber-600", finished: "bg-green-700",
};

function nextLine(dict: Dict, d: DeskDivision, locale: string): string {
  if (!d.next) return t(dict, "desk.ledger.nothingNext");
  const home = d.next.home ?? "—";
  const away = d.next.away ?? "—";
  if (d.next.in_play) return t(dict, "desk.ledger.now", { home, away });
  const when = d.next.scheduled_at ? whenLabel(d.next.scheduled_at, locale, d.display_tz) : "";
  return t(dict, "desk.ledger.next", { when, home, away }).replace("  ", " ");
}

export function DivisionLedger({ dict, rows, org, comp, locale }: { dict: Dict; rows: LedgerRow[]; org: string; comp: string; locale: string }) {
  return (
    <section data-testid="desk-ledger">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-slate-600">
        {t(dict, "desk.ledger.title")} · {rows.length}
      </h2>
      <div className="card divide-y divide-purple-50">
        {rows.map((r) => {
          const d = r.desk;
          const pct = d && d.total > 0 ? Math.round((d.played / d.total) * 100) : 0;
          const href = routes.division(org, comp, r.slug);
          return (
            <div key={r.id} data-testid="desk-ledger-row" data-phase={d ? d.phase : "unknown"}
                 className="grid grid-cols-[36px_1fr_auto] items-center gap-3 px-4 py-3 md:grid-cols-[36px_1.3fr_1fr_130px_1.4fr_auto]">
              <span aria-hidden className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-purple-50 text-lg leading-none">
                {r.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded logo
                  <img src={r.logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  sportEmoji(r.sportKey)
                )}
              </span>
              <div className="min-w-0">
                <Link href={href} className="block truncate text-sm font-semibold text-slate-900">{r.name}</Link>
                <p className="truncate text-xs text-slate-600">{r.statusLine}</p>
              </div>
              <div className="hidden md:block">
                <div className="h-1.5 overflow-hidden rounded-full bg-purple-100">
                  <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                </div>
                {d && <p className="mt-1 text-[11px] text-slate-600">{t(dict, "card.progress.played", { played: d.played, total: d.total })}</p>}
              </div>
              <div className="hidden md:block">{d && <PhasePill dict={dict} phase={d.phase} attention={d.attention} />}</div>
              <p className="hidden text-xs text-slate-900 md:block">{d ? nextLine(dict, d, locale) : ""}</p>
              <div className="flex items-center gap-2">
                <Link href={href} className="btn btn-ghost px-3 py-1.5 text-xs">{t(dict, "desk.ledger.open")}</Link>
                {r.menu}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
