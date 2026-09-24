"use client";

// Schedule history console (Jul3/03 §6): undo/redo buttons, history list,
// named checkpoints + restore, division freeze/scope locks, and the guarded
// "danger zone" clear — deliberately at the bottom, away from Schedule
// controls (18 May ask).
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Tip } from "@/components/ui/tip";
import { useMsg } from "@/components/i18n/dict-provider";
// Zero imports of its own, so a client component may hold it. The CODE is the
// contract between a schedule-lock refusal and this panel; the SENTENCE is not.
import { SCHEDULE_LOCKED_CODE } from "@/lib/schedule-lock";
import { PLAYED_REFUSAL_CODE } from "@/lib/played-fixture-statuses";
import type { MessageKey } from "@/lib/messages";

interface HistoryRow {
  seq: number;
  type: string;
  undoable: boolean;
  created_at: string;
  undone: boolean;
}
interface HistoryOut {
  watermark: number | null;
  seq: number;
  events: HistoryRow[];
}
interface Checkpoint {
  id: string;
  seq: number;
  label: string;
  /** V303 — "ai" anchors are created by the AI accept flow and exempt from the
   *  organiser's save-point quota. */
  kind?: "manual" | "ai";
  /** Every AI anchor except the newest. Struck through, still restorable. */
  superseded?: boolean;
  created_at: string;
  /** #382 — only ever on the row a CREATE returns: the save point this one
   *  pushed out of the plan's rolling window. */
  evicted?: { id: string; label: string };
}

/** Render order is deliberate: the organiser's own save points first, since
 *  those are the ones they created and pay for. */
const CHECKPOINT_GROUPS = [
  { kind: "manual", headingKey: "history.checkpoint.groupYours", noteKey: "history.checkpoint.usedCount" },
  { kind: "ai", headingKey: "history.checkpoint.groupAi", noteKey: "history.checkpoint.notCounted" },
] as const;

/** Event type -> the dictionary key that names it. Keyed by the event TYPE, not
 *  by the English label, so rewording a label never orphans its key. These
 *  render INSIDE the "Recent edits" list: left as literals they made a
 *  translated heading sit above a list of English event names. */
const TYPE_LABEL_KEYS: Record<string, MessageKey> = {
  schedule_applied: "history.event.scheduleApplied",
  schedule_edited: "history.event.scheduleEdited",
  schedule_cleared: "history.event.scheduleCleared",
  schedule_restored: "history.event.scheduleRestored",
  fixtures_generated: "history.event.fixturesGenerated",
  fixtures_cleared: "history.event.fixturesCleared",
  pool_entrants_cleared: "history.event.poolEntrantsCleared",
  pool_entrants_restored: "history.event.poolEntrantsRestored",
  officials_assigned: "history.event.officialsAssigned",
  participants_imported: "history.event.participantsImported",
  schedule_published: "history.event.schedulePublished",
  division_started: "history.event.divisionStarted",
};

export function HistoryPanel({
  divisionId,
  scheduleLocked,
  canEdit,
  viewerPlan,
}: {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [history, setHistory] = useState<HistoryOut | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  /** #382 — the label the last save rolled out of the window. A NOTICE, not a
   *  paywall: the save SUCCEEDED, and undo still rewinds past the dropped
   *  bookmark. Naming it is the whole point — an organiser who is not told
   *  which label went looks for it later and finds a hole. */
  const [evicted, setEvicted] = useState<string | null>(null);
  /** How many edits the last restore actually undid.
   *
   *  `restoreCheckpoint` returns `{ steps: 0 }` — HTTP 200, nothing written —
   *  whenever the division's watermark is already at or before the checkpoint's,
   *  and the commonest way to reach that is an AI apply that FAILED: the
   *  "Before AI" anchor was saved, the apply was refused, so the anchor and the
   *  live board are the same state. Restoring then reloads a board that looks
   *  exactly as it did, which is indistinguishable from a restore that did not
   *  work. The number is kept (not a boolean) because the two cases read
   *  differently: "nothing to undo" answers a question, "undid 2 changes"
   *  confirms an action. */
  const [restored, setRestored] = useState<number | null>(null);
  /** How many matches with a result or scoring recorded the last schedule
   *  clear left in place (`skipped.decided` — the server's played set). The clear never
   *  takes them, and a live match keeping its slot on a board just cleared,
   *  with nothing said, reads as a clear that did not work. */
  const [keptPlayed, setKeptPlayed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, cps] = await Promise.all([
        apiV1<HistoryOut>(`/api/v1/divisions/${divisionId}/history`),
        apiV1<Checkpoint[]>(`/api/v1/divisions/${divisionId}/checkpoints`),
      ]);
      setHistory(h);
      setCheckpoints(cps);
    } catch {
      /* panel stays empty */
    }
  }, [divisionId]);

  useEffect(() => {
    // microtask defer keeps setState out of the synchronous effect body
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setPaywallFeature(null);
    // Cleared per action, not per save: the notice belongs to the action the
    // organiser just took, and a stale one beside an undo would be a lie.
    setEvicted(null);
    setRestored(null);
    setKeptPlayed(null);
    setBusy(true);
    try {
      await fn();
      await load();
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
        // Same rule as the freeze branch below, and the same defect before it:
        // this sentence was an English literal in a fully translated panel, on
        // a path an organiser reaches whenever a second tab or a second person
        // writes first. Branching on the CODE is already right here — only the
        // sentence was hardcoded.
        setError(msg("history.error.seqConflict"));
        await load();
      } else if (err instanceof ApiV1Error && err.code === SCHEDULE_LOCKED_CODE) {
        // A refusal this panel recognises is said in the reader's language. The
        // server's sentence is English prose (`SCHEDULE_LOCKED_MESSAGE`), and
        // painting it here put an English line in the middle of a translated
        // console. Reachable without any race: `scheduleLocked` is a prop
        // resolved when the page rendered, so a second tab or a second
        // organiser freezing the division leaves every control on this page
        // live and the 422 as the only thing that says no.
        //
        // Branch on the CODE, never on the message: matching an English
        // sentence to decide how to render it breaks the moment the sentence is
        // reworded, which is exactly what `@/lib/schedule-lock` makes cheap.
        setError(msg("history.error.frozen"));
      } else if (err instanceof ApiV1Error && err.code === PLAYED_REFUSAL_CODE) {
        // An undo/redo whose change touches a match that has started or
        // finished. The server's sentence is English; say it locally, off the
        // code, like the two refusals above.
        setError(msg("history.error.played"));
      } else {
        // Deliberately NOT blanket-suppressed. Every refusal this client can
        // recognise now has its own sentence; what is left is the unanticipated
        // failure, and that is the one an organiser most needs to be able to
        // quote. A generic "something went wrong" would trade an untranslated
        // known refusal for an unreportable unknown one.
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  /** The event's name in the reader's language, falling through to the raw type
   *  for an event this build has no key for — the same fall-through the old
   *  label map had, so a new server-side event type still reads as something. */
  const eventLabel = (type: string): string => {
    const key = TYPE_LABEL_KEYS[type];
    return key ? msg(key) : type;
  };

  const step = (direction: "undo" | "redo") =>
    run(() =>
      apiV1(`/api/v1/divisions/${divisionId}/${direction}`, {
        method: "POST",
        json: { expected_seq: history?.seq },
      }),
    );

  return (
    <section className="mt-8 space-y-4" aria-label={msg("history.aria")}>
      <div className="flex flex-wrap items-center gap-2">
        {/* Tip sits OUTSIDE the h2 — inside it would pollute the heading's
            accessible name ("History About: …"). */}
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {msg("history.title")}
          </h2>
          <Tip id="schedule.undo-watermark" />
        </div>
        {canEdit && (
          <>
            {/* The arrow stays in the JSX, OUTSIDE the dictionary value: it is
                decorative, identical in all four (LTR) locales, and part of the
                accessible name schedule-panels.spec.ts selects on ("↩ Undo") —
                a translator who dropped or reordered it would break that spec
                with no way to see why. Interpolated into ONE template literal
                rather than sitting beside the expression so the button renders
                a single text node, exactly as it did before. */}
            {/* The freeze binds the REWIND primitives too. `restoreCheckpoint`
                is a loop of `undoDivision`, so the freeze that disabled Restore
                a few hundred pixels below left the thing it is built out of
                live right here. `scheduleLocked` is the prop, NOT anything
                derived from `canEdit`: the mount site passes
                `canEdit && !billingFrozen`, the ORG's billing freeze, and
                gating on that would make this silently unreachable on a frozen
                division. Both are `.btn`, which already carries
                `disabled:cursor-not-allowed disabled:opacity-50`, so unlike the
                bare-text Restore these read as disabled without extra tokens. */}
            <button
              type="button"
              data-testid="history-undo"
              className="btn btn-ghost"
              disabled={busy || scheduleLocked}
              onClick={() => void step("undo")}
            >
              {`↩ ${msg("history.undo")}`}
            </button>
            <button
              type="button"
              data-testid="history-redo"
              className="btn btn-ghost"
              disabled={busy || scheduleLocked}
              onClick={() => void step("redo")}
            >
              {`↪ ${msg("history.redo")}`}
            </button>
            <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={scheduleLocked}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    apiV1(`/api/v1/divisions/${divisionId}/locks`, {
                      method: "PATCH",
                      json: { schedule_locked: e.target.checked },
                    }),
                  )
                }
              />
              {msg("history.freezeAll")}
            </label>
          </>
        )}
      </div>

      {/* ONE note for both controls: they are refused for the same single
          reason, and repeating the sentence beside each would be noise. It sits
          BELOW the row rather than inside it — the row is a `flex-wrap`, so a
          paragraph in it would be laid out as a third control — which also
          makes each locale's own "above" (arriba / ci-dessus / hierboven) true
          of the freeze checkbox at the end of that row. The sibling sentences
          `history.danger.body` and `history.checkpoint.frozen` already point
          the same way in the same word; three sentences in one console must not
          disagree about which direction the checkbox is in.

          `history.danger.frozen` is NOT reusable here even though the shape
          matches: it ends "to clear slots", which names a different control. */}
      {canEdit && scheduleLocked && (
        <p className="text-xs text-slate-500" data-testid="history-step-reason">
          {msg("history.step.frozen")}
        </p>
      )}

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {error && (
        <p
          data-testid="history-error"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600"
        >
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">{msg("history.recent.title")}</h3>
          {!history || history.events.length === 0 ? (
            <p className="text-sm text-slate-500">{msg("history.recent.empty")}</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {history.events.slice(0, 12).map((e) => (
                <li
                  key={e.seq}
                  className={`flex items-center gap-2 ${e.undone ? "text-slate-400 line-through" : "text-slate-700"}`}
                >
                  <span className="font-mono text-xs text-slate-400">#{e.seq}</span>
                  {eventLabel(e.type)}
                  {!e.undoable && (
                    <span className="text-xs text-slate-400">{msg("history.notUndoable")}</span>
                  )}
                  <time className="ml-auto text-xs text-slate-400">
                    {new Date(e.created_at).toLocaleTimeString()}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="card space-y-2 p-4">
          {/* Tip beside, not inside, the heading (accessible-name hygiene). */}
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-slate-900">{msg("history.savePoints.title")}</h3>
            <Tip id="schedule.save-points" />
          </div>
          {canEdit && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!label.trim()) return;
                void run(async () => {
                  const created = await apiV1<Checkpoint>(
                    `/api/v1/divisions/${divisionId}/checkpoints`,
                    { method: "POST", json: { label: label.trim() } },
                  );
                  setLabel("");
                  // #382 — the save succeeded either way; `evicted` only says
                  // whether it cost the oldest bookmark its label.
                  if (created?.evicted) setEvicted(created.evicted.label);
                });
              }}
            >
              {/* Sized down from the app-wide .input/.btn defaults on purpose.
                  The list below runs at 12.5px with 10.5px actions, so a 14px
                  solid-purple button made creating a save point look like the
                  loudest thing in the panel. Restoring is what people come here
                  for; creating is setup, so it takes the quiet ghost styling and
                  the same 12px scale as everything around it. */}
              <input
                // `.input`'s own padding loses to `py-1.5 text-xs` under
                // Tailwind's utilities layer (S13/#422 W11). `min-h-11`
                // survives it and does not disturb the density recipe the
                // sizing test above (history-panel-save-button.test.tsx)
                // still checks for.
                className="input min-h-11 py-1.5 text-xs"
                data-testid="savepoint-label"
                placeholder={msg("history.savePoints.placeholder")}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label={msg("history.savePoints.labelAria")}
              />
              <button
                type="submit"
                data-testid="savepoint-create"
                className="btn btn-ghost shrink-0 whitespace-nowrap px-2.5 py-1.5 text-xs"
                disabled={busy}
              >
                {msg("history.savePoints.create")}
              </button>
            </form>
          )}
          {/* #382 — non-blocking, and deliberately NOT an UpgradeGate: nothing
              was refused. The count is the manual group's own length, which
              after an eviction IS the plan's window width — no second read,
              and it cannot disagree with the list right below it. */}
          {/* What the restore did, including when it did nothing. Sits beside
              the eviction notice and obeys the same rule: non-blocking, cleared
              at the start of the next action, never an error — a no-op restore
              is a correct outcome that simply has to be said out loud. */}
          {restored !== null && (
            <p
              data-testid="history-restore-notice"
              className="rounded-md bg-purple-50 px-2.5 py-1.5 text-[11px] leading-snug text-purple-800"
            >
              {/* `msg` over the two plural forms, not `usePlural`: that hook
                  THROWS outside a DictProvider, and this panel is mounted in
                  node-environment tests that have no provider tree (`useMsg`
                  falls back to the English catalog there, which is the
                  production copy). All four shipped locales use one/other, so
                  picking the form here loses nothing a plural runtime would
                  give — and a fifth locale with more categories would need a
                  provider-safe plural hook anyway. */}
              {restored === 0
                ? msg("history.restore.noop")
                : restored === 1
                  ? msg("history.restore.done.one")
                  : msg("history.restore.done.other", { count: String(restored) })}
            </p>
          )}
          {evicted && (
            <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800">
              {msg("history.checkpoint.evicted", {
                name: evicted,
                count: String(checkpoints.filter((c) => (c.kind ?? "manual") === "manual").length),
              })}{" "}
              <span className="opacity-80">{msg("history.checkpoint.evictedHint")}</span>
            </p>
          )}
          {/* Grouped by kind, because the two obey different rules: a manual
              save point spends the organiser's quota, an AI anchor does not.
              Putting the counter on one group and "not counted" on the other
              makes that legible without a paragraph of explanation.

              Each group is a rewind rail — the node is the save point, the line
              is the history between them. A filled node is the live AI anchor
              (what Undo targets); hollow nodes are still restorable. */}
          {/* The freeze binds the rewind as well as the clear, and says so the
              same way the Danger zone does: the control stays on the page,
              disabled, with a reason beside it — a vanished button reads as a
              missing feature, a disabled one teaches that unfreezing is the way
              back. Restore is the WIDER of the two edits (clear empties
              unlocked slots; this rewrites every fixture's time and court back
              to the save point), so the freeze that stopped the smaller one a
              few hundred pixels below had to stop this.

              One note for the whole list rather than one per row: every Restore
              on it is disabled for the same single reason, and repeating the
              sentence down the rail would be noise. It is suppressed when there
              are no save points — a paragraph explaining a button that is not
              rendered.

              `scheduleLocked` is the prop, NOT anything derived from `canEdit`:
              the mount site passes `canEdit && !billingFrozen`, and
              `billingFrozen` is the ORG's billing freeze, a different thing
              with a confusingly similar name. */}
          {/* Names BOTH refused actions when both are on the list, and only
              Restore when they are not: Delete is offered on MANUAL save points
              alone, so on a list of AI anchors "unfreeze it to restore or
              delete" would promise a control that unfreezing does not produce.
              One note either way — every control on the rail is refused for the
              same single reason, and repeating the sentence down it would be
              noise. */}
          {canEdit && scheduleLocked && checkpoints.length > 0 && (
            <p className="text-xs text-slate-500" data-testid="checkpoint-restore-reason">
              {msg(
                checkpoints.some((c) => (c.kind ?? "manual") === "manual")
                  ? "history.checkpoint.frozenDelete"
                  : "history.checkpoint.frozen",
              )}
            </p>
          )}
          {checkpoints.length === 0 ? (
            <p className="text-sm text-slate-600">{msg("history.checkpoint.empty")}</p>
          ) : (
            <div className="space-y-4">
              {CHECKPOINT_GROUPS.map(({ kind, headingKey, noteKey }) => {
                const rows = checkpoints.filter((c) => (c.kind ?? "manual") === kind);
                if (rows.length === 0 && kind === "ai") return null;
                return (
                  <div key={kind}>
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                        {msg(headingKey)}
                      </span>
                      <span className="text-[10.5px] text-slate-600">
                        {kind === "ai"
                          ? msg(noteKey)
                          : msg(noteKey, { count: String(rows.length) })}
                      </span>
                    </div>
                    {rows.length === 0 ? (
                      <p className="pl-[18px] text-xs italic text-slate-600">
                        {msg("history.checkpoint.empty")}
                      </p>
                    ) : (
                      <ul className="relative m-0 list-none p-0 pl-[18px] before:absolute before:bottom-[9px] before:left-[4px] before:top-[9px] before:w-px before:bg-slate-200">
                        {rows.map((cp) => {
                          const live = cp.kind === "ai" && !cp.superseded;
                          return (
                            <li
                              key={cp.id}
                              data-testid="checkpoint-row"
                              data-checkpoint-id={cp.id}
                              className={`relative flex items-center gap-2 py-[5px] before:absolute before:left-[-18px] before:top-[11px] before:h-[9px] before:w-[9px] before:rounded-full before:border-[1.5px] before:content-[''] ${
                                live
                                  ? "before:border-purple-600 before:bg-purple-600"
                                  : "before:border-slate-300 before:bg-white"
                              }`}
                            >
                              <span
                                className={
                                  cp.superseded
                                    ? "text-[12.5px] text-slate-600 line-through"
                                    : "text-[12.5px] text-slate-700"
                                }
                              >
                                {cp.label}
                              </span>
                              {live && (
                                <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold text-purple-700">
                                  {msg("history.checkpoint.latestAi")}
                                </span>
                              )}
                              <time className="ml-auto whitespace-nowrap text-[10.5px] text-slate-600">
                                {new Date(cp.created_at).toLocaleString()}
                              </time>
                              {canEdit && (
                                <button
                                  type="button"
                                  data-testid="checkpoint-restore"
                                  // `enabled:hover:underline`, not
                                  // `hover:underline`: `:hover` still matches a
                                  // DISABLED button, so the bare variant keeps
                                  // painting the link affordance on a control
                                  // that does nothing. The other two are the
                                  // pair `.btn` carries (globals.css) — this is
                                  // a bare text button and inherits none of it,
                                  // so a frozen Restore would otherwise render
                                  // pixel-identical to a live one and lie about
                                  // itself while the note beside it says why.
                                  className={`text-[10.5px] enabled:hover:underline disabled:cursor-not-allowed disabled:opacity-50 ${cp.superseded ? "text-slate-600" : "text-purple-600"}`}
                                  disabled={busy || scheduleLocked}
                                  onClick={async () => {
                                    const ok = await confirmDialog({
                                      title: msg("confirm.restoreCheckpoint.title"),
                                      body: msg("confirm.restoreCheckpoint.body", { name: cp.label }),
                                      confirmLabel: msg("confirm.restoreCheckpoint.label"),
                                    });
                                    if (!ok) return;
                                    void run(async () => {
                                      const res = await apiV1<{ steps?: number }>(
                                        `/api/v1/divisions/${divisionId}/restore`,
                                        {
                                          method: "POST",
                                          json: { checkpoint_id: cp.id, confirm: true },
                                        },
                                      );
                                      // `steps` is the server's own count of
                                      // undos performed; 0 is a real answer,
                                      // not a missing field, so it is reported
                                      // rather than treated as absent.
                                      setRestored(res?.steps ?? 0);
                                    });
                                  }}
                                >
                                  {msg("history.checkpoint.restore")}
                                </button>
                              )}
                              {/* Delete is offered on manual save points only.
                                  An AI anchor costs no quota and the next apply
                                  makes a new one, so removing it achieves
                                  nothing the organiser wants. */}
                              {canEdit && (cp.kind ?? "manual") === "manual" && (
                                <button
                                  type="button"
                                  data-testid="checkpoint-delete"
                                  // `enabled:hover:text-rose-600`, and the two
                                  // disabled tokens spelled out: `:hover` still
                                  // matches a DISABLED button, and this is a
                                  // bare text button that inherits none of
                                  // `.btn`'s `disabled:*` pair (globals.css).
                                  // Without them a frozen Delete renders
                                  // pixel-identical to a live one and still
                                  // reddens under the cursor — a control lying
                                  // about itself while the note above says why.
                                  // Exactly the reasoning the Restore beside it
                                  // already carries.
                                  className="text-[11px] text-slate-400 enabled:hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                                  // Matched to the Restore ON THIS ROW. Delete
                                  // is the IRREVERSIBLE half of the pair — it
                                  // destroys the rewind the freeze exists to
                                  // protect, where Restore merely uses it — and
                                  // `deleteCheckpoint` now answers a frozen
                                  // division with a live 422, so leaving it
                                  // `disabled={busy}` offered a button that
                                  // could only fail.
                                  disabled={busy || scheduleLocked}
                                  aria-label={msg("history.checkpoint.delete")}
                                  title={msg("history.checkpoint.delete")}
                                  onClick={async () => {
                                    const ok = await confirmDialog({
                                      title: msg("confirm.deleteCheckpoint.title"),
                                      body: msg("confirm.deleteCheckpoint.body", { name: cp.label }),
                                      confirmLabel: msg("confirm.deleteCheckpoint.label"),
                                    });
                                    if (!ok) return;
                                    void run(() =>
                                      apiV1(`/api/v1/divisions/${divisionId}/checkpoints/${cp.id}`, {
                                        method: "DELETE",
                                      }),
                                    );
                                  }}
                                >
                                  ✕
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="card border-red-100 p-4">
          <h3 className="text-sm font-semibold text-red-700">{msg("history.danger.title")}</h3>
          <p className="mt-1 text-xs text-slate-500">{msg("history.danger.body")}</p>
          {/* The freeze is a REASON, not a disappearance: the control stays on
              the page and explains itself, because a vanished button reads as a
              missing feature. `scheduleLocked` is the prop the page already
              hands down (`division.schedule_locked`) — deliberately NOT
              anything derived from `canEdit`, whose value at the mount site is
              `canEdit && !billingFrozen`, the org's BILLING freeze. Gating on
              that would make this guard silently unreachable on a frozen
              division, which is the exact defect this closes: the server's 422
              was the only thing saying no. */}
          {scheduleLocked && (
            <p className="mt-1 text-xs text-slate-500" data-testid="schedule-clear-reason">
              {msg("history.danger.frozen")}
            </p>
          )}
          {/* btn-danger, not hand-rolled: `border-red-200` sets a border colour
              but no width, so this painted no border and no background — a
              destructive action that read as bare red text, its .btn padding
              showing only as a stray indent. */}
          <button
            type="button"
            data-testid="schedule-clear"
            className="btn btn-danger mt-2"
            disabled={busy || scheduleLocked}
            onClick={async () => {
              const ok = await confirmDialog({
                title: msg("confirm.clearSlots.title"),
                body: msg("confirm.clearSlots.body"),
                confirmLabel: msg("confirm.clearSlots.label"),
                tone: "danger",
              });
              if (!ok) return;
              void run(async () => {
                const out = await apiV1<{ cleared: number; skipped: { locked: number; decided: number } }>(
                  "/api/v1/schedule/clear",
                  {
                    method: "POST",
                    json: { division_id: divisionId, scope: { excludeLocked: true }, confirm: true },
                  },
                );
                setKeptPlayed(out.skipped.decided);
              });
            }}
          >
            {msg("history.danger.clear")}
          </button>
          {/* The locked ones are the danger zone's own sentence above; this
              says the played ones, which no control on this page pins. `msg`
              over the two plural forms for the reason given at the restore
              notice. */}
          {keptPlayed !== null && keptPlayed > 0 && (
            <p
              data-testid="schedule-clear-kept"
              className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800"
            >
              {keptPlayed === 1
                ? msg("history.danger.keptPlayed.one")
                : msg("history.danger.keptPlayed.other", { count: String(keptPlayed) })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
