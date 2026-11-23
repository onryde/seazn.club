// The staff "Seazn video" table on /admin/orgs/[id] (Seazn-hosted video Task 31): the org's last Seazn sessions, the delivered
// minutes the daily sweep measured for each (usecases/seazn-cost.ts), and each replay part's state. A server component: no state,
// no handlers. /admin is staff-only and desktop-only (AGENTS.md), so English only and no phone layout.
import type { SeaznVideoPart, SeaznVideoSession } from "@/server/usecases/seazn-cost";

const DELETED_BY: Record<string, string> = { organiser: "by organiser", org_deleted: "org deleted" };

/** An instant as staff read it on every machine alike: UTC, to the minute. */
const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function partWord(p: SeaznVideoPart): string {
  if (p.state !== "deleted") return `Part ${p.partNo}: ${p.state}`;
  const by = p.deletedReason === null ? null : (DELETED_BY[p.deletedReason] ?? p.deletedReason);
  return `Part ${p.partNo}: deleted${by ? ` (${by})` : ""}`;
}

function Minutes({ value, through }: { value: string | null; through: string | null }) {
  if (value === null) return <span className="text-slate-500">—</span>;
  return (
    <>
      <span className="font-mono text-slate-200">{value}</span>
      {through !== null && <span className="block text-xs text-slate-500">through {through}</span>}
    </>
  );
}

export function AdminSeaznVideoPanel({ rows, limit }: { rows: SeaznVideoSession[]; limit: number }) {
  return (
    <section data-testid="seazn-video-panel">
      <h2 className="mb-1 text-sm font-semibold text-slate-300">Seazn video</h2>
      <p className="mb-2 text-xs text-slate-400">
        Last {limit} Seazn sessions, newest first. Minutes are estimates, measured once a day through yesterday (UTC): Cloudflare
        samples its viewing counts, live minutes add the match feed and its recordings, and the replay host reads about a third
        below the time actually played.
      </p>
      {rows.length === 0 ? (
        <p data-testid="seazn-video-empty" className="text-xs text-slate-400">No Seazn-hosted sessions for this org.</p>
      ) : (
        <div className="rounded-lg border border-slate-800 overflow-x-auto" tabIndex={0} role="region" aria-label="Seazn video">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-xs text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left">Fixture</th>
                <th className="px-3 py-2 text-left">Ended</th>
                <th className="px-3 py-2 text-right">Live min</th>
                <th className="px-3 py-2 text-right">Replay min</th>
                <th className="px-3 py-2 text-left">Replay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {rows.map((r) => (
                <tr key={r.sessionId} data-testid="seazn-video-row" data-session-id={r.sessionId} className="hover:bg-slate-800/50">
                  <td className="px-3 py-2 text-slate-200">{r.fixture ?? <span className="text-slate-500">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
                    {r.endedAt === null ? <span className="text-slate-500">—</span> : utcMinute(r.endedAt)}
                  </td>
                  <td className="px-3 py-2 text-right"><Minutes value={r.liveMinutes} through={r.liveThrough} /></td>
                  <td className="px-3 py-2 text-right"><Minutes value={r.replayMinutes} through={r.replayThrough} /></td>
                  <td className="px-3 py-2 text-xs text-slate-300">
                    {r.parts.length === 0
                      ? <span className="text-slate-500">—</span>
                      : r.parts.map((p) => <span key={p.partNo} className="block">{partWord(p)}</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
