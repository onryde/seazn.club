"use client";

// W5 app-A Task 23 (X-CU-8 desk half; Task 6 ruling I2, R24 pick 3A): the league / group stage card's "Waiting to join the table"
// strip — the knockout strip's twin for a table (`knockout-waiting-strip.tsx`, W4 T19). A player who arrives AFTER Start by an
// automatic door (a paid or confirmed registration, a waitlist promotion, an import, a Reinstate) is never placed by the app
// (RB5-L10): they wait on `entrants.table_waiting_stage_id`, and the organiser places them with ONE tap, "Add to the table" — the
// same words the Needs-you row and the RR_GENERATE_AFTER_START sentence use. A group of several pools offers the Group field on
// the row (pick 1A; default the smallest). The tap posts T6's place route and the answer is said through the one late-entry
// notice (`lateEntryNotice` → `lib/roundrobin-late-entry-notice.ts`): placed → the panel's own green / amber lines, the page
// refreshed; refused → the reason under the row, with the exits (Withdraw; the refund for an entry that paid online).
//
// An island of its own, as the knockout strip is, so its state (the tap in flight, each row's last answer, each row's pool) is
// held here and driven by the shared hook harness. One DOM at every width: the row stacks below `sm` and sits side by side from it.
// `id="table-waiting"`: the Needs-you row's "Open fixtures" lands here (a division has ONE root table, so one strip at most).
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { isRoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import { undoRefusalText } from "@/lib/undo-refusals";
import { lateEntryNotice, lateEntryNoticeText } from "@/lib/swiss-late-entry-notice";
import type { TableLateEntryResult } from "@/server/api-v1/schemas";
import type { KnockoutWaitingEntrant } from "@/server/usecases/knockout-desk";
import type { TableLatePool } from "@/server/usecases/table-desk";
import { poolPickerShown, TableLatePoolSelect } from "@/components/v2/table-late-pool-select";
import type { PlacedSaid } from "./knockout-waiting-strip";

export interface TableWaitingStripProps {
  stageId: string;
  /** The players waiting on THIS stage (`listTableWaiting`, filtered to the stage by the caller). */
  waiting: readonly KnockoutWaitingEntrant[];
  /** Every entrant of the division, id -> name. */
  names: Readonly<Record<string, string>>;
  /** The running group's pools (`readTableLatePools`); absent or one pool ⇒ no Group field. */
  pools?: readonly TableLatePool[];
  defaultPool?: string | null;
  /** The Registrations hub filtered to this division — a paid entry's refund lives there. */
  registrationsHref: string;
  /** A tap that placed the player: the sentence(s) it earned, for the panel's notice lines (they outlive this strip). */
  onPlaced: (said: PlacedSaid) => void;
}

export function TableWaitingStrip({ stageId, waiting, names, pools, defaultPool = null, registrationsHref, onPlaced }: TableWaitingStripProps) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, string[]>>>({});
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A ref, not the `busy` state: a quick second press reads the closure the first press's render has not replaced yet.
  const inFlight = useRef(false);

  if (waiting.length === 0) return null;
  const pooled = poolPickerShown(pools);
  const poolOf = (id: string) => picked[id] ?? defaultPool ?? pools?.[0]?.key ?? "";
  const setOutcome = (id: string, lines: string[] | null) =>
    setOutcomes((prev) => {
      const next = { ...prev };
      if (lines === null) delete next[id];
      else next[id] = lines;
      return next;
    });
  const nameMap: Record<string, string> = { ...names, ...Object.fromEntries(waiting.map((w) => [w.entrantId, w.name])) };
  const refusalOf = (err: unknown): string =>
    err instanceof ApiV1Error && isRoundRobinRefusalCode(err.code) ? undoRefusalText(err.code, err.extra, msg) : msg("knockout.waiting.failed");

  async function place(w: KnockoutWaitingEntrant) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(w.entrantId);
    setOutcome(w.entrantId, null);
    try {
      const result = await apiV1<TableLateEntryResult>(`/api/v1/stages/${stageId}/late-entrants/${w.entrantId}/place`, {
        method: "POST",
        json: pooled ? { pool_key: poolOf(w.entrantId) } : {},
      });
      if (result.case === "refused" || result.case === "waiting") {
        // 200, but nothing was placed: the player still waits, and the row says why.
        let lines: string[];
        try {
          lines = lateEntryNotice([result], nameMap, { locale, pooled }).map((l) => lateEntryNoticeText(l, { t: msg, plural: msgPlural }));
        } catch {
          lines = [msg("knockout.waiting.failed")];
        }
        setOutcome(w.entrantId, lines);
        return;
      }
      let said: PlacedSaid;
      try {
        const lines = lateEntryNotice([result], nameMap, { locale, pooled });
        const text = (tone: "done" | "todo") => lines.filter((l) => l.tone === tone).map((l) => lateEntryNoticeText(l, { t: msg, plural: msgPlural }));
        said = { done: text("done"), todo: text("todo") };
      } catch {
        // Placed, but the answer cannot be said truthfully (a case missing what its sentence names): say THAT it landed, in the
        // organiser's language, never the server's English.
        said = { done: [msg("roundrobin.waiting.placed", { name: w.name })], todo: [] };
      }
      onPlaced(said);
      router.refresh();
    } catch (err) {
      setOutcome(w.entrantId, [refusalOf(err)]);
      // A server answer means the desk's last read is stale (the player was placed or withdrawn meanwhile): re-read it.
      if (err instanceof ApiV1Error) router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function withdraw(w: KnockoutWaitingEntrant) {
    if (inFlight.current) return;
    const ok = await confirmDialog({
      title: msg("confirm.withdrawEntrant.title", { name: w.name }),
      body: msg("roundrobin.waiting.withdrawBody", { name: w.name }),
      confirmLabel: msg("confirm.withdrawEntrant.label"),
      tone: "danger",
    });
    if (!ok) return;
    inFlight.current = true;
    setBusy(w.entrantId);
    try {
      await apiV1(`/api/v1/entrants/${w.entrantId}/withdraw`, { method: "POST", json: {} });
      router.refresh();
    } catch (err) {
      setOutcome(w.entrantId, [refusalOf(err)]);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <div
      id="table-waiting"
      data-testid="table-waiting"
      data-stage-id={stageId}
      className="min-w-0 scroll-mt-24 border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
    >
      <p className="text-xs font-semibold text-amber-900">{msg("roundrobin.waiting.title")}</p>
      <ul className="mt-2 space-y-3">
        {waiting.map((w) => {
          const lines = outcomes[w.entrantId];
          return (
            <li key={w.entrantId} data-testid="table-waiting-row" data-entrant-id={w.entrantId} className="min-w-0">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0 sm:self-center">
                  <p className="min-w-0 break-words text-sm font-semibold text-slate-900">{w.name}</p>
                  <p className="min-w-0 text-xs text-amber-900">{msg(w.paid ? "roundrobin.waiting.subPaid" : "roundrobin.waiting.sub")}</p>
                </div>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:shrink-0">
                  {pooled && (
                    <div className="min-w-0 sm:w-auto sm:max-w-md">
                      <TableLatePoolSelect
                        id={`table-waiting-pool-${w.entrantId}`}
                        testId="table-waiting-pool"
                        pools={pools!}
                        defaultKey={defaultPool}
                        value={poolOf(w.entrantId)}
                        onChange={(key) => setPicked((prev) => ({ ...prev, [w.entrantId]: key }))}
                        disabled={busy !== null}
                        label={false}
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid="table-waiting-place"
                    disabled={busy !== null}
                    onClick={() => place(w)}
                    className="btn btn-primary min-h-11 px-4 py-1.5 text-sm max-sm:w-full sm:shrink-0"
                  >
                    {msg("roundrobin.addToTable")}
                  </button>
                </div>
              </div>
              {lines !== undefined && (
                <div role="status" data-testid="table-waiting-outcome" className="mt-2 flex min-w-0 flex-col gap-2">
                  {lines.map((line, i) => (
                    <p key={i} className="min-w-0 break-words text-xs font-medium text-amber-900">
                      {line}
                    </p>
                  ))}
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <button
                      type="button"
                      data-testid="table-waiting-withdraw"
                      disabled={busy !== null}
                      onClick={() => withdraw(w)}
                      className="btn btn-ghost min-h-11 px-3 py-1.5 text-sm"
                    >
                      {msg("entrants.row.withdraw")}
                    </button>
                    {w.paid && (
                      <Link
                        href={registrationsHref}
                        data-testid="table-waiting-refund"
                        className="inline-flex min-h-11 items-center text-sm font-medium text-purple-700 underline underline-offset-2 hover:no-underline"
                      >
                        {msg("knockout.waiting.refund")}
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
