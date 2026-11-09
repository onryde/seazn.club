"use client";

// W4 app-A Task 19 (X-LE-10 desk half; R24 pick 1A, owner 2026-11-05): the knockout stage card's "Waiting to join the
// bracket" strip. A player who arrives AFTER the draw by an automatic door (a paid or confirmed registration, a waitlist
// promotion, an import, a Reinstate) is never seated by the app (ruling 271): they wait, and the organiser seats them with
// ONE tap, "Add to bracket" — the same name the stage rail's More item, the Needs-you row's target and the Generate
// refusal's sentence use (b6a carry B3 #3). The tap posts T11's place route and the answer is said through the Swiss
// late-entry notice block's lines (pick 2B, `lib/swiss-late-entry-notice.ts`): placed -> green sentence in the panel's own
// notice line, the page refreshed; not placed -> the reason under the row.
//
// A refused tap is never a stuck amber row (B3 review #5): the row keeps its tap and gains the exits — Withdraw (this player
// is not in the bracket, so nothing is walked over), a pointer to the refund in Registrations for an entry that paid online,
// and Rebuild fixtures when nothing in the stage has started (the answer is `rebuild_offered`; the panel's own Rebuild, with
// its own confirm of what it clears, does the work).
//
// An island of its own — never inline in the stages panel, whose tests walk the panel without invoking a nested
// component's render — so its state (the tap in flight, each row's last answer) is held here and driven by the shared
// hook harness. One DOM at every width: the row stacks (name above the button, the button full width) below `sm` and sits
// side by side from it.
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { KO_LATE_ENTRY_PLAYED_ON } from "@/lib/knockout-late-entry";
import { knockoutRefusalText } from "@/lib/knockout-refusals";
import { lateEntryNotice, lateEntryNoticeText } from "@/lib/swiss-late-entry-notice";
import type { KnockoutLateEntryResult } from "@/server/api-v1/schemas";
import type { KnockoutWaitingEntrant } from "@/server/usecases/knockout-desk";

/** What a landed tap said, split by tone for the panel's two lines (green for what happened, amber for what is still owed). */
export interface PlacedSaid {
  done: string[];
  todo: string[];
}

export interface KnockoutWaitingStripProps {
  stageId: string;
  /** The players waiting on THIS stage (`listKnockoutWaiting`, filtered to the stage by the caller). */
  waiting: readonly KnockoutWaitingEntrant[];
  /** Every entrant of the division, id -> name: the answer names the bye holder, the opponent and the withdrawn player. */
  names: Readonly<Record<string, string>>;
  /** The Registrations hub filtered to this division — a paid entry's refund lives there. */
  registrationsHref: string;
  /** The panel's own Rebuild for this stage (it confirms what it clears first). */
  onRebuild: () => void;
  /** A tap that SETTLED the player - seated them, or answered `KO_LATE_ENTRY_PLAYED_ON` (a seat holder whose place was played on; the
   *  server cleared their flag): the sentence(s) it earned, for the panel's notice lines (they outlive this strip). */
  onPlaced: (said: PlacedSaid) => void;
}

/** One row's last answer: the sentence(s) and the exits it earned. */
interface Outcome {
  /** amber sentences (a refusal's reason; a failure's text). */
  lines: string[];
  /** The refusal exits: set for a 200 `refused` / `rebuild_offered` (the player still waits and cannot be placed now). */
  exits: boolean;
  /** `rebuild_offered`: nothing has started, so Rebuild fixtures would draw the field again with them in it. */
  rebuild: boolean;
}

export function KnockoutWaitingStrip({ stageId, waiting, names, registrationsHref, onRebuild, onPlaced }: KnockoutWaitingStripProps) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A ref, not the `busy` state: the guard a second tap meets is read through a closure the first tap's render has not
  // replaced yet (a state read here is the one a quick second press beats).
  const inFlight = useRef(false);

  if (waiting.length === 0) return null;

  const setOutcome = (id: string, outcome: Outcome | null) =>
    setOutcomes((prev) => {
      const next = { ...prev };
      if (outcome === null) delete next[id];
      else next[id] = outcome;
      return next;
    });
  const nameMap: Record<string, string> = { ...names, ...Object.fromEntries(waiting.map((w) => [w.entrantId, w.name])) };
  const said = (result: KnockoutLateEntryResult) =>
    lateEntryNotice([result], nameMap, { locale }).map((line) => ({ text: lateEntryNoticeText(line, { t: msg, plural: msgPlural }), tone: line.tone }));

  async function place(w: KnockoutWaitingEntrant) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(w.entrantId);
    setOutcome(w.entrantId, null);
    try {
      const result = await apiV1<KnockoutLateEntryResult>(`/api/v1/stages/${stageId}/late-entrants/${w.entrantId}/place`, {
        method: "POST",
        json: {},
      });
      let lines: { text: string; tone: "done" | "todo" }[];
      try {
        lines = said(result);
      } catch {
        // The server answered, but its reply cannot be said (the notice builder refuses a case missing a field its sentence
        // names). Never its internal English: a placed player is told so in the organiser's language and the page is
        // re-read (they are in the bracket); anything else is the generic line, with the exits.
        if (result.case === "bye" || result.case === "withdrawn_slot") {
          onPlaced({ done: [msg("knockout.waiting.placed", { name: w.name })], todo: [] });
          router.refresh();
        } else {
          setOutcome(w.entrantId, { lines: [msg("knockout.waiting.failed")], exits: true, rebuild: false });
        }
        return;
      }
      // `refused` with KO_LATE_ENTRY_PLAYED_ON is the one refusal that is a landing: the server cleared the flag (a seat holder
      // whose place was played on is no late player), so the sentence goes to the panel's amber line and the page is re-read,
      // which takes them off the card. Every other refusal leaves the player waiting.
      const stays = result.case === "rebuild_offered" || (result.case === "refused" && result.reason !== KO_LATE_ENTRY_PLAYED_ON);
      if (stays) {
        // 200, but nothing was placed: the marker stays (the player still waits), and the row says why and offers the exits.
        setOutcome(w.entrantId, { lines: lines.map((l) => l.text), exits: true, rebuild: result.case === "rebuild_offered" });
        return;
      }
      onPlaced({ done: lines.filter((l) => l.tone === "done").map((l) => l.text), todo: lines.filter((l) => l.tone === "todo").map((l) => l.text) });
      router.refresh();
    } catch (err) {
      // A knockout refusal (the player no longer waits here; the stage is a fed one) in the reader's language; anything else the
      // localized generic line - the wire's own text is English and an internal string, never the organiser's.
      const text = err instanceof ApiV1Error ? knockoutRefusalText(err.code, err.extra, msg) : null;
      setOutcome(w.entrantId, { lines: [text ?? msg("knockout.waiting.failed")], exits: false, rebuild: false });
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
      body: msg("knockout.waiting.withdrawBody", { name: w.name }),
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
      // Said by its code like the tap's refusals, else the generic line; the row keeps the exits (and the Rebuild offer it had).
      const text = err instanceof ApiV1Error ? knockoutRefusalText(err.code, err.extra, msg) : null;
      setOutcome(w.entrantId, { lines: [text ?? msg("knockout.waiting.failed")], exits: true, rebuild: outcomes[w.entrantId]?.rebuild ?? false });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <div
      data-testid="knockout-waiting"
      data-stage-id={stageId}
      className="min-w-0 border-b border-dashed border-amber-200 bg-amber-50 px-4 py-3"
    >
      <p className="text-xs font-semibold text-amber-900">{msg("knockout.waiting.title")}</p>
      <ul className="mt-2 space-y-3">
        {waiting.map((w) => {
          const outcome = outcomes[w.entrantId];
          return (
            <li key={w.entrantId} data-testid="knockout-waiting-row" data-entrant-id={w.entrantId} className="min-w-0">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="min-w-0 break-words text-sm font-semibold text-slate-900">{w.name}</p>
                  <p className="min-w-0 text-xs text-amber-900">{msg(w.paid ? "knockout.waiting.subPaid" : "knockout.waiting.sub")}</p>
                </div>
                <button
                  type="button"
                  data-testid="knockout-waiting-place"
                  disabled={busy !== null}
                  onClick={() => place(w)}
                  className="btn btn-primary min-h-11 px-4 py-1.5 text-sm max-sm:w-full sm:shrink-0"
                >
                  {msg("knockout.addToBracket")}
                </button>
              </div>
              {outcome !== undefined && (
                <div role="status" data-testid="knockout-waiting-outcome" className="mt-2 flex min-w-0 flex-col gap-2">
                  {outcome.lines.map((line, i) => (
                    <p key={i} className="min-w-0 break-words text-xs font-medium text-amber-900">
                      {line}
                    </p>
                  ))}
                  {outcome.exits && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                      {outcome.rebuild && (
                        <button
                          type="button"
                          data-testid="knockout-waiting-rebuild"
                          disabled={busy !== null}
                          onClick={() => onRebuild()}
                          className="btn btn-ghost min-h-11 px-3 py-1.5 text-sm"
                        >
                          {msg("progression.rosterDrift.rebuildCta")}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="knockout-waiting-withdraw"
                        disabled={busy !== null}
                        onClick={() => withdraw(w)}
                        className="btn btn-ghost min-h-11 px-3 py-1.5 text-sm"
                      >
                        {msg("entrants.row.withdraw")}
                      </button>
                      {w.paid && (
                        <Link
                          href={registrationsHref}
                          data-testid="knockout-waiting-refund"
                          className="inline-flex min-h-11 items-center text-sm font-medium text-purple-700 underline underline-offset-2 hover:no-underline"
                        >
                          {msg("knockout.waiting.refund")}
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
