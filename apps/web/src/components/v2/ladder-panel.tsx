"use client";

// Ladder console (Jul3/08 §6): the current order + a challenge form. A
// challenger picks an opponent within `challengeRange` places above; winning
// the created fixture swaps positions (the scoring hook does the reorder).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { ladderErrorMessage } from "@/lib/ladder-error";
import type { Locale } from "@/lib/i18n-constants";
import type { ViewerPlan } from "@/lib/viewer-plan";

interface Entrant {
  id: string;
  display_name: string;
  /** Left the field (`withdrawn` / `disqualified`). Still on the ladder — a
   *  withdrawal is a status flip and `config.ladder_order` is never pruned,
   *  so she keeps the rung she earned and gets it back if she is reinstated. */
  departed: boolean;
}

export function LadderPanel({
  stageId,
  order,
  entrants,
  departedEntrantIds,
  locale,
  canEdit,
  viewerPlan,
}: {
  stageId: string;
  order: string[]; // entrant ids, top first
  entrants: Record<string, string>; // id → display name
  /** Entrants no longer in the field. `issueChallenge` refuses either side
   *  with a 422 LADDER_ENTRANT_WITHDRAWN, so the pickers below must not offer
   *  them: a control that offers a choice the server will reject is a dead
   *  end wearing a menu. The refusal stays as the backstop — the ladder order
   *  can change between this render and the POST. */
  departedEntrantIds: string[];
  // An explicit prop from the division page (an RSC), never useLocale():
  // useLocale() throws outside a <DictProvider>, and this panel renders in
  // places that have none. Same contract as ProgressionPanel's own `locale`.
  locale: Locale;
  canEdit: boolean;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [challenger, setChallenger] = useState("");
  const [opponent, setOpponent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ranked list — fall back to entrants insertion order before first challenge
  const departed = new Set(departedEntrantIds);
  const ranked: Entrant[] =
    order.length > 0
      ? order.map((id) => ({ id, display_name: entrants[id] ?? id, departed: departed.has(id) }))
      : Object.entries(entrants).map(([id, display_name]) => ({
          id,
          display_name,
          departed: departed.has(id),
        }));
  // The TABLE still shows everyone, and says who has left — the rung is kept
  // on purpose (see `Entrant.departed`), so hiding the row would read as
  // "she lost her place". Only the PICKERS are narrowed.
  const selectable = ranked.filter((e) => !e.departed);

  async function submit() {
    if (!challenger || !opponent) return;
    setError(null);
    setPaywall(null);
    setBusy(true);
    try {
      await apiV1(`/api/v1/stages/${stageId}/challenges`, {
        method: "POST",
        json: { challenger_id: challenger, opponent_id: opponent },
      });
      setChallenger("");
      setOpponent("");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? "formats.advanced"));
      } else if (err instanceof ApiV1Error) {
        // A recognised LADDER_* code renders in the organiser's own language;
        // anything else falls back to the server's English message, which is
        // still better than a guess at copy nobody wrote.
        setError(ladderErrorMessage(locale, err.code, err.extra, err.message));
      } else {
        setError(err instanceof Error ? err.message : msg("ladder.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {paywall && <UpgradeGate feature={paywall} viewerPlan={viewerPlan} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">{msg("ladder.rank")}</th>
              <th className="px-4 py-2 text-left">{msg("ladder.player")}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e, i) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-sm text-slate-400">{i + 1}</td>
                <td className="px-4 py-2 text-sm font-medium text-slate-900">
                  <span className={e.departed ? "text-slate-400" : undefined}>{e.display_name}</span>
                  {e.departed && (
                    <span
                      data-ladder-withdrawn={e.id}
                      className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500"
                    >
                      {msg("ladder.withdrawn")}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            {msg("ladder.challenger")}
            <select className="input" value={challenger} onChange={(e) => setChallenger(e.target.value)}>
              <option value="">—</option>
              {selectable.map((e) => (
                <option key={e.id} value={e.id}>{e.display_name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            {msg("ladder.challenges")}
            <select className="input" value={opponent} onChange={(e) => setOpponent(e.target.value)}>
              <option value="">—</option>
              {selectable.filter((e) => e.id !== challenger).map((e) => (
                <option key={e.id} value={e.id}>{e.display_name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || !challenger || !opponent} onClick={submit}>
            {msg("ladder.issue")}
          </button>
          <p className="w-full text-xs text-slate-500">{msg("ladder.hint")}</p>
        </div>
      )}
    </div>
  );
}
