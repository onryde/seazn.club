// W5 T14b (owner 2026-11-18) — what a finished multi-pool Groups only division shows where a champion banner sits: each
// pool's winner, "Group A · X". Same family as `DivisionTitleBanner` (court panel, fixed amber podium vocabulary outside the org
// theme, one trophy) but a LIST, because there is no single name to set in display type.
//
// Mobile-first: one column below `sm`, two from `sm`, three from `lg`; every cell is `min-w-0` and a name WRAPS
// (`[overflow-wrap:anywhere]`) rather than truncating - an ellipsis over a winner is the wrong answer, and an unbroken
// 43-character name must not widen the page at 320. A pool with no single winner says so in a muted line, so "Group A: X" is
// never read as the whole result. Pure and server-safe: the caller hands it resolved lines.
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import type { PoolWinnerLine } from "@/server/public-site/pool-winners";

export function PoolWinnersBanner({ lines, dict }: { lines: readonly PoolWinnerLine[]; dict: Dict }) {
  if (lines.length === 0) return null;
  return (
    <div
      data-testid="division-pool-winners"
      className="relative mb-6 overflow-hidden rounded-xl bg-court p-4 text-court-ink shadow-md"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-amber-400" />
      <div className="flex min-w-0 items-start gap-4 pl-2">
        <span className="animate-trophy text-4xl" aria-hidden>🏆</span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">{t(dict, "title.poolWinners")}</p>
          <ul role="list" className="mt-1 grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {lines.map((l) => (
              <li key={l.poolId} data-testid="division-pool-winner" data-pool={l.poolId} className="min-w-0">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-court-muted">{l.label}</span>
                {l.name === null ? (
                  <span data-testid="division-pool-winner-none" className="block text-sm text-court-muted">
                    {t(dict, "title.poolWinnerNone")}
                  </span>
                ) : (
                  <span className="block min-w-0 font-display text-xl font-bold leading-tight [overflow-wrap:anywhere]">{l.name}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
