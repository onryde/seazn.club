import Link from "@/components/ui/console-link";
import { requireStaff } from "@/lib/admin";
import { EVENTS } from "@/lib/analytics-events";
import { QUICK_MATCH_EXPIRY_DAYS } from "@/lib/quick-match-constants";
import {
  QUICK_MATCH_ADMIN_FILTERS,
  QUICK_MATCH_ADMIN_LIST_LIMIT,
  QUICK_MATCH_ADMIN_WINDOWS,
  listQuickMatchesForAdmin,
  parseQuickMatchAdminFilter,
  quickMatchAdminCounts,
  type QuickMatchAdminCounts,
  type QuickMatchAdminFilter,
  type QuickMatchAdminWindow,
} from "@/server/usecases/quick-match-admin";

export const dynamic = "force-dynamic";

const WINDOW_LABEL: Record<QuickMatchAdminWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const COUNT_ROWS: { key: keyof QuickMatchAdminCounts; label: string; hint: string }[] = [
  { key: "created", label: "Created", hint: "still on record" },
  { key: "played", label: "Played", hint: "at least one point or result" },
  { key: "finished", label: "Finished", hint: "every match played or not played" },
  { key: "saved", label: "Saved", hint: "kept in an account" },
  { key: "expiredPending", label: "Expired, awaiting sweep", hint: "unsaved and past its expiry, not yet deleted" },
];

const FILTER_LABEL: Record<QuickMatchAdminFilter, string> = {
  all: "All",
  played: "Played",
  never: "Never played",
  saved: "Saved",
};

/** A time as staff read it in a ticket: minutes, UTC, the same on every machine. */
const utc = (d: Date | null): string => (d === null ? "—" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`);

/**
 * Quick Match usage (owner 2026-11-12). Staff-only: the page asks itself, and so does each read it calls (a Next layout does
 * not gate its segments). Desktop-only, as all of /admin.
 *
 * Never on this page: a home link or its token, a device link, the address a guest typed, or who saved a match (only that
 * someone did). A guest's link is the key to their match; staff never need it. The reads do not select any of them
 * (usecases/quick-match-admin.ts), and the page test renders it and looks.
 */
export default async function AdminQuickMatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>;
}) {
  await requireStaff();
  const filter = parseQuickMatchAdminFilter((await searchParams).filter);
  const [counts, list] = await Promise.all([quickMatchAdminCounts(), listQuickMatchesForAdmin({ filter })]);

  return (
    <div className="space-y-8">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">Admin</Link> / Quick matches
        </p>
        <h1 className="text-xl font-bold text-white">Quick matches</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          Guest-made matches in the Seazn quick matches org: how many are made, played, finished and kept.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-400">Usage, by when the match was created</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm" data-testid="qm-counts">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Quick matches</th>
                {QUICK_MATCH_ADMIN_WINDOWS.map((w) => (
                  <th key={w.key} className="px-3 py-2 text-right">{WINDOW_LABEL[w.key]}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {COUNT_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <span className="text-slate-200">{row.label}</span>
                    <span className="ml-2 text-xs text-slate-500">{row.hint}</span>
                  </td>
                  {QUICK_MATCH_ADMIN_WINDOWS.map((w) => (
                    <td
                      key={w.key}
                      className="px-3 py-2 text-right font-mono text-white"
                      data-testid={`qm-count-${row.key}-${w.key}`}
                    >
                      {counts[w.key][row.key]}
                    </td>
                  ))}
                </tr>
              ))}
              {/* A deleted match leaves no row, so the database cannot count it (controller ruling 2026-11-12): PostHog can. */}
              <tr>
                <td className="px-3 py-2">
                  <span className="text-slate-200">Deleted</span>
                  <span className="ml-2 text-xs text-slate-500">by its saver, or by the sweep after expiry</span>
                </td>
                {QUICK_MATCH_ADMIN_WINDOWS.map((w) => (
                  <td key={w.key} className="px-3 py-2 text-right text-xs text-slate-400" data-testid={`qm-count-deleted-${w.key}`}>
                    {`see PostHog: ${EVENTS.QUICK_MATCH_DELETED}`}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="max-w-3xl text-xs text-slate-500" data-testid="qm-counts-note">
          Counts cover matches still on record. A match deleted by its saver, or by the sweep {QUICK_MATCH_EXPIRY_DAYS} days
          after its last activity, leaves no row this page can read, so it is in no count here (every window counts the
          survivors; within 24 hours only a saver&apos;s Delete removes one). PostHog has every deletion as{" "}
          {EVENTS.QUICK_MATCH_DELETED}, by how it went, and every create as {EVENTS.QUICK_MATCH_CREATED}.
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-400">Recent, newest first</h2>
          <nav className="flex gap-1 text-sm" aria-label="Filter quick matches">
            {QUICK_MATCH_ADMIN_FILTERS.map((f) => (
              <Link
                key={f}
                href={f === "all" ? "/admin/quick-matches" : `/admin/quick-matches?filter=${f}`}
                aria-current={f === filter ? "page" : undefined}
                className={
                  f === filter
                    ? "rounded bg-purple-900 px-3 py-1 text-purple-200"
                    : "rounded px-3 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                }
              >
                {FILTER_LABEL[f]}
              </Link>
            ))}
          </nav>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-sm" data-testid="qm-list">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-left">Sport · format · kind</th>
                <th className="px-3 py-2 text-left">Sides</th>
                <th className="px-3 py-2 text-right">Decided</th>
                <th className="px-3 py-2 text-left">Last activity</th>
                <th className="px-3 py-2 text-left">Saved</th>
                <th className="px-3 py-2 text-left">Expires</th>
                <th className="px-3 py-2 text-left">Locale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {list.rows.map((r) => (
                <tr key={r.id} className="align-top hover:bg-slate-800/50" data-testid="qm-row">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{utc(r.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-300">
                    {[r.sportKey ?? "—", r.format, r.kinds.join("/") || "—"].join(" · ")}
                  </td>
                  <td className="max-w-md px-3 py-2 text-slate-300">
                    <span className="mr-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">{r.sides.length}</span>
                    <span className="break-words">{r.sides.join(", ")}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-200" data-testid="qm-decided">
                    {/* The guest's own count (§6 of the skip spec): the total stays every match, the Not played ones beside it. */}
                    {r.notPlayed > 0 ? `${r.decided} of ${r.total} · ${r.notPlayed} not played` : `${r.decided} of ${r.total}`}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">{utc(r.lastActivityAt)}</td>
                  <td className="px-3 py-2">
                    {r.saved ? (
                      <span className="rounded bg-emerald-900 px-2 py-0.5 text-xs text-emerald-300">yes</span>
                    ) : (
                      <span className="text-xs text-slate-500">no</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-400">
                    {r.expiresAt !== null ? utc(r.expiresAt) : r.saved ? "never (saved)" : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-400">{r.locale}</td>
                </tr>
              ))}
              {list.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-slate-500">
                    No quick matches{filter === "all" ? "" : ` under "${FILTER_LABEL[filter]}"`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {list.capped && (
          <p className="text-xs text-slate-500" data-testid="qm-list-capped">
            Showing the newest {QUICK_MATCH_ADMIN_LIST_LIMIT}.
          </p>
        )}
      </section>
    </div>
  );
}
