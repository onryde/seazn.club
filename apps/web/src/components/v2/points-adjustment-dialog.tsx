"use client";

// W5 app PR B, Task 7 (C5; X-ADJ-4; owner R24 pick 15 A): the desk's "Adjust points" dialog, opened from a table stage's More menu
// (desk/stage-rail.tsx) only where the write is allowed (`pointsAdjustmentOffered`, lib/points-adjustment-offer.ts). Who → by how
// much → why → Apply; under it, the stage's adjustments in force, each with its Undo.
//
// Nothing here decides what may be written. The entrants offered are the table's MEMBERS as the server reads them (preflight C8:
// seated in a pool on a pooled stage, grouped by pool); the amount is held in the table's own unit, the one the engine ranks by
// (`unit`: points, or wins where the cascade ranks wins first, RB5-T15), in STORED steps (a half-point rule's step is ½, shown "½").
// Every refusal is the server's, said in the reader's language (the round-robin refusal table).
//
// The visual pattern is the forfeit dialog's (forfeit-dialog.tsx): a bottom sheet on phones, a centred card from `sm`, Cancel + the
// one specific action, focus trapped, Escape closes unless sending.
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/lib/messages";
import { formatPublicInstant } from "@/lib/public-date-locale";
import { adjustmentAmountText, adjustmentShownCount, type AdjustmentUnit, type PointsDisplayUnit } from "@/lib/points-adjustment-note";
import { ADJUST_DELTA_MAX, adjustDeltaInRange } from "@/lib/points-adjustment-offer";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface AdjustmentRow {
  seq: number;
  entrant_id: string;
  delta: number;
  reason: string;
  unit: AdjustmentUnit;
  points_unit: PointsDisplayUnit;
  at: string;
  held: boolean;
}

export interface AdjustmentsRead {
  unit: AdjustmentUnit;
  points_unit: PointsDisplayUnit;
  members: readonly { entrant_id: string; pool: string | null }[];
  adjustments: readonly AdjustmentRow[];
}

export type DialogAnswer = { ok: true } | { ok: false; message: string };

export interface PointsAdjustmentDialogProps {
  msg: Msg;
  locale: string;
  stageName: string;
  /** The competition's clock (`scheduleSettings.tz`) - the one the footnote under the table dates the same row in (B3 m-7). */
  tz: string;
  names: Readonly<Record<string, string>>;
  load: () => Promise<AdjustmentsRead>;
  /** Adjust points (POST): named `adjust`, not `apply`: outcome-readers.test.ts reads every call of an `apply` member as a sport module's replay. */
  adjust: (input: { entrant_id: string; delta: number; reason: string }) => Promise<DialogAnswer>;
  undo: (seq: number) => Promise<DialogAnswer>;
  onClose: () => void;
}

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const TITLE_ID = "adjust-points-title";

/** The amount's noun phrase in the reader's language: "−3 points", "+1 win", "−½ points". */
export function adjustmentAmountPhrase(msg: Msg, locale: string, delta: number, unit: AdjustmentUnit, pointsUnit: PointsDisplayUnit): string {
  const count = adjustmentShownCount(delta, unit, pointsUnit);
  let form: "one" | "other" = count === 1 ? "one" : "other";
  try {
    form = new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other";
  } catch {
    // keep the count === 1 reading
  }
  return msg(`adjustPoints.amount.${unit}.${form}` as MessageKey, { amount: adjustmentAmountText(delta, unit, pointsUnit) });
}

/** An adjustment's date as the footnote under the table prints it: day-month (owner ruling 2026-09-16, "21 Nov 2026") in the
 *  competition's clock, never the browser's (B3 m-7, ruling 5) - an organiser abroad sees the date the public sees. */
export function adjustmentDateText(locale: string, tz: string, iso: string): string {
  return formatPublicInstant(locale, tz, iso, { dateStyle: "medium" }) ?? iso.slice(0, 10);
}

/** The typed amount, in the table's shown unit, as the STORED delta (a half-point rule stores half-points). Not a number ⇒ 0. */
export function storedDelta(typed: string, unit: AdjustmentUnit, pointsUnit: PointsDisplayUnit): number {
  const v = Number(typed.replace("−", "-").replace(",", "."));
  if (typed.trim() === "" || !Number.isFinite(v)) return 0;
  return unit === "points" && pointsUnit === "half" ? Math.round(v * 2) : Math.round(v);
}

/** The stored delta as the field shows it. */
export function shownDelta(delta: number, unit: AdjustmentUnit, pointsUnit: PointsDisplayUnit): string {
  return String(unit === "points" && pointsUnit === "half" ? delta / 2 : delta);
}

/** Apply is pressable once a member is chosen, the amount moves something within the bound and a reason is given (the server's own
 *  checks: B3 ruling 4 added the bound). */
export function applyBlocked(s: { entrant: string; delta: number; reason: string; sending: boolean }): boolean {
  return s.sending || s.entrant === "" || s.delta === 0 || !adjustDeltaInRange(s.delta) || s.reason.trim() === "";
}

export function PointsAdjustmentDialog(props: PointsAdjustmentDialogProps) {
  const { msg, locale } = props;
  const [read, setRead] = useState<AdjustmentsRead | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [entrant, setEntrant] = useState("");
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [said, setSaid] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [changed, setChanged] = useState(false);
  const sendingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => {
    onCloseRef.current = props.onClose;
  });
  const loadRef = useRef(props.load);

  useEffect(() => {
    let live = true;
    loadRef.current().then(
      (r) => live && setRead(r),
      (e: unknown) => live && setLoadFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  // The forfeit dialog's focus discipline: focus once on mount, give focus back on close, trap Tab, Escape closes.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("select, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sendingRef.current) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const unit = read?.unit ?? "points";
  const pointsUnit = read?.points_unit ?? "whole";
  const delta = storedDelta(typed, unit, pointsUnit);
  const blocked = applyBlocked({ entrant, delta, reason, sending });
  const nameOf = (id: string) => props.names[id] ?? id;
  const dateOf = (iso: string) => adjustmentDateText(locale, props.tz, iso);
  const step = (by: number) => setTyped(shownDelta(delta + by, unit, pointsUnit));

  const run = async (op: () => Promise<DialogAnswer>, okKey: MessageKey, after?: () => void) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSaid(null);
    const r = await op();
    if (r.ok) {
      after?.();
      setChanged(true);
      setSaid({ tone: "ok", text: msg(okKey) });
      try {
        setRead(await props.load());
      } catch {
        // the write landed; a failed re-read leaves the last list up
      }
    } else {
      setSaid({ tone: "error", text: r.message });
    }
    sendingRef.current = false;
    setSending(false);
  };

  const apply = () => {
    if (blocked) return;
    void run(() => props.adjust({ entrant_id: entrant, delta, reason: reason.trim() }), "adjustPoints.applied", () => {
      setTyped("");
      setReason("");
    });
  };

  // Pools, in the server's order; one unnamed group on an unpooled table.
  const groups: { pool: string | null; ids: string[] }[] = [];
  for (const m of read?.members ?? []) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.pool === m.pool) last.ids.push(m.entrant_id);
    else groups.push({ pool: m.pool, ids: [m.entrant_id] });
  }
  for (const g of groups) g.ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b), locale));
  const option = (id: string) => (
    <option key={id} value={id}>
      {nameOf(id)}
    </option>
  );

  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !sendingRef.current) props.onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} data-testid="adjust-points-dialog" className="modal">
        <span className="sheet-handle" aria-hidden />
        <h2 id={TITLE_ID} className="min-w-0 text-base font-semibold text-slate-900 [overflow-wrap:anywhere]">
          {msg("adjustPoints.title", { stage: props.stageName })}
        </h2>
        {loadFailed !== null && (
          <p role="alert" data-testid="adjust-points-error" className="mt-3 text-sm text-red-700 [overflow-wrap:anywhere]">
            {loadFailed}
          </p>
        )}
        <form
          className="mt-4 grid min-w-0 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <label className="grid min-w-0 gap-1">
            <span className="text-sm font-medium text-slate-700">{msg("adjustPoints.entrant")}</span>
            <select
              data-testid="adjust-points-entrant"
              value={entrant}
              disabled={read === null}
              onChange={(e) => setEntrant(e.target.value)}
              className="input min-h-11 w-full min-w-0"
            >
              <option value="">{msg("adjustPoints.choose")}</option>
              {groups.map((g) =>
                g.pool === null ? (
                  g.ids.map(option)
                ) : (
                  <optgroup key={g.pool} label={msg("adjustPoints.pool", { pool: g.pool })}>
                    {g.ids.map(option)}
                  </optgroup>
                ),
              )}
            </select>
          </label>

          <div className="grid min-w-0 gap-1">
            <label htmlFor="adjust-points-delta" className="text-sm font-medium text-slate-700">
              {msg(unit === "wins" ? "adjustPoints.field.wins" : "adjustPoints.field.points")}
            </label>
            <div className="flex min-w-0 items-stretch gap-2">
              <button
                type="button"
                data-testid="adjust-points-decrease"
                aria-label={msg("adjustPoints.decrease")}
                disabled={read === null}
                onClick={() => step(-1)}
                className="btn btn-ghost min-h-11 min-w-11 shrink-0 px-0 text-lg"
              >
                {"−"}
              </button>
              <input
                id="adjust-points-delta"
                data-testid="adjust-points-delta"
                inputMode="decimal"
                autoComplete="off"
                value={typed}
                placeholder="0"
                disabled={read === null}
                onChange={(e) => setTyped(e.target.value)}
                className="input min-h-11 w-24 min-w-0 text-center text-lg font-semibold tabular-nums"
              />
              <button
                type="button"
                data-testid="adjust-points-increase"
                aria-label={msg("adjustPoints.increase")}
                disabled={read === null}
                onClick={() => step(1)}
                className="btn btn-ghost min-h-11 min-w-11 shrink-0 px-0 text-lg"
              >
                +
              </button>
              {delta !== 0 && (
                <span
                  data-testid="adjust-points-amount"
                  aria-live="polite"
                  className={`flex min-w-0 items-center text-sm font-medium tabular-nums ${delta < 0 ? "text-red-700" : "text-emerald-700"}`}
                >
                  {adjustmentAmountPhrase(msg, locale, delta, unit, pointsUnit)}
                </span>
              )}
            </div>
            {!adjustDeltaInRange(delta) && (
              <p data-testid="adjust-points-range" role="alert" className="text-xs font-medium text-amber-800">
                {msg("roundrobin.refusal.RR_ADJUST_OUT_OF_RANGE", { max: shownDelta(ADJUST_DELTA_MAX, unit, pointsUnit) })}
              </p>
            )}
            {unit === "wins" && <p className="text-xs text-slate-500">{msg("adjustPoints.winsHint")}</p>}
            {unit === "points" && pointsUnit === "half" && <p className="text-xs text-slate-500">{msg("adjustPoints.halfHint")}</p>}
          </div>

          <label className="grid min-w-0 gap-1">
            <span className="text-sm font-medium text-slate-700">{msg("adjustPoints.reason")}</span>
            <input
              data-testid="adjust-points-reason"
              value={reason}
              maxLength={200}
              disabled={read === null}
              onChange={(e) => setReason(e.target.value)}
              className="input min-h-11 w-full min-w-0"
            />
            <span className="text-xs text-slate-500">{msg("adjustPoints.reasonHint")}</span>
          </label>

          {said !== null && (
            <p
              role={said.tone === "error" ? "alert" : "status"}
              data-testid={said.tone === "error" ? "adjust-points-error" : "adjust-points-notice"}
              className={`rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere] ${said.tone === "error" ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"}`}
            >
              {said.text}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" disabled={sending} onClick={props.onClose} data-testid="adjust-points-close" className="btn btn-ghost min-h-11">
              {msg(changed ? "adjustPoints.close" : "adjustPoints.cancel")}
            </button>
            <button type="submit" data-testid="adjust-points-apply" disabled={blocked} className="btn btn-primary min-h-11">
              {msg("adjustPoints.apply")}
            </button>
          </div>
        </form>

        {read !== null && read.adjustments.length > 0 && (
          <section className="mt-5 min-w-0 border-t border-slate-200 pt-4" aria-labelledby="adjust-points-current">
            <h3 id="adjust-points-current" className="text-sm font-semibold text-slate-900">
              {msg("adjustPoints.current")}
            </h3>
            <ul className="mt-2 grid min-w-0 gap-2">
              {read.adjustments.map((a) => (
                <li
                  key={a.seq}
                  data-testid={`adjust-points-row-${a.seq}`}
                  className="flex min-w-0 items-start justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                >
                  <div className="min-w-0 text-sm text-slate-800">
                    <p className="[overflow-wrap:anywhere]">
                      <strong className="font-semibold text-slate-900">{nameOf(a.entrant_id)}</strong>{" "}
                      <span className={`tabular-nums ${a.delta < 0 ? "text-red-700" : "text-emerald-700"}`}>
                        {adjustmentAmountPhrase(msg, locale, a.delta, a.unit, a.points_unit)}
                      </span>
                    </p>
                    <p className="text-xs text-slate-600 [overflow-wrap:anywhere]">
                      {a.reason}, {dateOf(a.at)}
                    </p>
                    {a.held && (
                      <p data-testid={`adjust-points-held-${a.seq}`} className="text-xs text-amber-800">
                        {msg("adjustPoints.held")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid={`adjust-points-undo-${a.seq}`}
                    disabled={sending}
                    onClick={() => void run(() => props.undo(a.seq), "adjustPoints.undone")}
                    className="btn btn-ghost min-h-11 shrink-0 px-3 text-xs"
                  >
                    {msg("adjustPoints.undo")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
