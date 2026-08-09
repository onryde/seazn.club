"use client";

// Constraints v2 console (Jul3/04 §6): constraint editor, bulk time shift,
// and the pre-publish wait-time report.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { Tip } from "@/components/ui/tip";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { isoFromZonedDateTime, zonedDateTimeInput } from "@/lib/zoned-datetime";

/** 625 → "10h 25m"; 45 → "45m". The raw minute dumps read like debug output. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

interface HardRule {
  type: string;
  count?: number;
  scope?: { kind: string; divisionId?: string };
  [key: string]: unknown;
}

/** The one `max_fixtures_per_day` rule scoped to this whole division, if any —
 *  other hard rules (from the AI parser, per-entrant scopes, etc) are left
 *  alone by both this and {@link withMaxFixturesPerDay}. */
export function readMaxFixturesPerDay(hard: HardRule[] | undefined, divisionId: string): number | undefined {
  return hard?.find(
    (r) => r.type === "max_fixtures_per_day" && r.scope?.kind === "division" && r.scope.divisionId === divisionId,
  )?.count;
}

/** Replaces (or removes, when `count` is undefined) this division's whole-scope
 *  `max_fixtures_per_day` rule, preserving every other hard rule untouched. */
export function withMaxFixturesPerDay(
  hard: HardRule[] | undefined,
  divisionId: string,
  count: number | undefined,
): HardRule[] {
  const rest = (hard ?? []).filter(
    (r) => !(r.type === "max_fixtures_per_day" && r.scope?.kind === "division" && r.scope.divisionId === divisionId),
  );
  if (count === undefined) return rest;
  return [...rest, { type: "max_fixtures_per_day", count, scope: { kind: "division", divisionId } }];
}

// ---------------------------------------------------------------------------
// Blackout windows (date/time UX programme, Prompt 06). Until now `blackouts`
// could only be written by the AI natural-language console; this form
// supplements it rather than replacing it, and writes the SAME field.
//
// Two shapes, deliberately kept apart:
//   * `BlackoutRow` is the stored/wire shape (`schemas.ts` ScheduleConfig
//     .blackouts) — ISO datetimes with offset. The engine's own `Blackout`
//     (calendar.ts) carries epoch ms; the server converts. The panel talks to
//     the API, so it writes ISO.
//   * `BlackoutDraft` is what the form holds while it is being filled in:
//     `<input type="datetime-local">` values, either of which may be blank.
//     The stored shape cannot represent a half-typed row at all.
//
// The bridge between them is `@/lib/zoned-datetime` and it needs the VENUE zone
// (`settings.orgTz`, #448) — a `datetime-local` value carries no offset, so
// something has to say which zone the organiser's keystrokes belong to. "Court
// 2 is closed 12:00–13:00" means noon where Court 2 is. Resolving it with
// `new Date(value)` used the ORGANISER's zone instead, so anyone working from
// outside the venue's zone blacked out the wrong hour, silently: read-back went
// through the same wrong zone and showed 12:00 again, while the solver read the
// instant on `orgTz` and saw something else.
// ---------------------------------------------------------------------------

/** One blacked-out window as stored in `config.blackouts`. */
export interface BlackoutRow {
  /** Scoped to one court; ABSENT (never `undefined`) for the whole division. */
  court?: string;
  from: string;
  to: string;
}

/** One row of the editor. `court: ""` is the whole division. */
export interface BlackoutDraft {
  court: string;
  from: string;
  to: string;
}

/** Why a row cannot be stored yet, or null when it can. */
export type BlackoutRowError = "incomplete" | "order";

/**
 * `config.blackouts` → editable rows, shown on the venue clock `tz`. The config
 * arrives as `Record<string, unknown>` and the panel never re-parses the wire
 * schema, so anything malformed is dropped rather than rendered as an "Invalid
 * Date" field the organiser cannot fix.
 */
export function toBlackoutDrafts(raw: unknown, tz: string): BlackoutDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: BlackoutDraft[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as { court?: unknown; from?: unknown; to?: unknown };
    if (typeof row.from !== "string" || typeof row.to !== "string") continue;
    const from = zonedDateTimeInput(row.from, tz);
    const to = zonedDateTimeInput(row.to, tz);
    if (from === "" || to === "") continue;
    out.push({ court: typeof row.court === "string" ? row.court : "", from, to });
  }
  return out;
}

/** Validation for one row. Localised copy for each case lives in the render. */
export function blackoutRowError(draft: BlackoutDraft, tz: string): BlackoutRowError | null {
  if (draft.from === "" || draft.to === "") return "incomplete";
  const from = isoFromZonedDateTime(draft.from, tz);
  const to = isoFromZonedDateTime(draft.to, tz);
  if (from === null || to === null) return "incomplete";
  // `to` is EXCLUSIVE in the engine (`overlaps(start, end, bo.from, bo.to)`),
  // so an equal pair blacks out nothing at all — a control that silently does
  // not work. Refused here rather than stored.
  //
  // Ordered by the INSTANTS the two halves name rather than by the strings, so
  // the refusal means the same thing inside a fall-back hour, where one wall
  // clock happens twice and string order and time order part company.
  if (Date.parse(to) <= Date.parse(from)) return "order";
  return null;
}

/**
 * Editable rows → the stored shape, or null when ANY row is still invalid.
 * All-or-nothing on purpose: writing the valid subset would silently discard
 * the row the organiser is in the middle of typing.
 *
 * Overlapping windows are allowed. The engine unions them (`courtBlocked`
 * returns on the first match), so an overlap is exactly equivalent to its
 * union, and refusing it would block a legitimate "site closed 12–13, and
 * Court 2 closed 12–15" pair.
 */
export function draftsToBlackouts(
  drafts: readonly BlackoutDraft[],
  tz: string,
): BlackoutRow[] | null {
  const out: BlackoutRow[] = [];
  for (const draft of drafts) {
    if (blackoutRowError(draft, tz) !== null) return null;
    const from = isoFromZonedDateTime(draft.from, tz);
    const to = isoFromZonedDateTime(draft.to, tz);
    if (from === null || to === null) return null;
    const court = draft.court.trim();
    out.push({ ...(court === "" ? {} : { court }), from, to });
  }
  return out;
}

interface Constraints {
  restMin?: number;
  noBackToBack?: boolean;
  fieldFairness?: "off" | "balance" | "rotate";
  parallelism?: "block" | "mixed";
  crossPersonClash?: "warn" | "hard";
  startWindows?: { target: { kind: string; id: string }; notBefore?: string; notAfter?: string }[];
  hard?: HardRule[];
}
interface Settings {
  division_id: string;
  config: Record<string, unknown> & { constraints?: Constraints };
}
interface WaitRow {
  display_name: string;
  fixtures: number;
  minGapMinutes: number | null;
  maxGapMinutes: number | null;
  spanMinutes: number;
}

export function ConstraintsPanel({
  divisionId,
  initialSettings,
  canEdit,
  orgTz,
}: {
  divisionId: string;
  initialSettings: Settings;
  canEdit: boolean;
  /** The VENUE clock every absolute time on this panel is read and written on
   *  (`settings.orgTz`, #448 — NOT `settings.tz`, which a division may override
   *  for display). Required rather than defaulted: a wrong zone here stores the
   *  wrong instant and looks correct on the way back out. */
  orgTz: string;
}) {
  const msg = useMsg();
  const router = useRouter();
  const confirmDialog = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [constraints, setConstraints] = useState<Constraints>(
    initialSettings.config.constraints ?? {},
  );
  const [shiftMinutes, setShiftMinutes] = useState(15);
  const [report, setReport] = useState<{ worst: WaitRow[] } | null>(null);
  // Blackouts are edited as a DRAFT and committed with one button, unlike the
  // instant-save rows above. A datetime pair cannot be saved per keystroke, and
  // a half-typed row has no representation in the stored shape at all. `saved`
  // is what the server last acknowledged, so the commit button can appear only
  // when there is something to commit.
  const storedBlackouts = () => toBlackoutDrafts(initialSettings.config.blackouts, orgTz);
  const [blackouts, setBlackouts] = useState<BlackoutDraft[]>(storedBlackouts);
  const [savedBlackouts, setSavedBlackouts] = useState<BlackoutDraft[]>(storedBlackouts);

  async function run(fn: () => Promise<unknown>, refresh = false) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      if (refresh) router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  const maxPerDay = readMaxFixturesPerDay(constraints.hard, divisionId);

  /** Read-modify-write of ONE config key, leaving every other key as stored. */
  const savePatch = (patch: Record<string, unknown>, applied: () => void) =>
    run(async () => {
      const current = await apiV1<Settings>(`/api/v1/divisions/${divisionId}/schedule-settings`);
      await apiV1(`/api/v1/divisions/${divisionId}/schedule-settings`, {
        method: "PUT",
        // No `tz` (V305): re-sending the RESOLVED zone would pin this
        // division to it and quietly break inheritance from the org. An
        // omitted tz leaves the stored value exactly as it is.
        json: { config: { ...current.config, ...patch } },
      });
      applied();
    }, true);

  const save = (next: Constraints) => savePatch({ constraints: next }, () => setConstraints(next));

  const updateBlackout = (index: number, patch: Partial<BlackoutDraft>) =>
    setBlackouts((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const pendingBlackouts = draftsToBlackouts(blackouts, orgTz);
  const blackoutsDirty = JSON.stringify(blackouts) !== JSON.stringify(savedBlackouts);
  const courts = Array.isArray(initialSettings.config.courts)
    ? initialSettings.config.courts.filter((c): c is string => typeof c === "string")
    : [];
  // A stored window may name a court that has since been deleted. Keeping its
  // option is what stops the select falling back to the first entry and the
  // next save silently re-scoping that window to the whole division. (Prompt 08
  // owns the pinned-fixture side of court removal; an unpinned blackout naming
  // a gone court is inert in the engine — `courtBlocked` skips it everywhere.)
  const courtOptions = [
    ...courts,
    ...blackouts.map((b) => b.court).filter((c) => c !== "" && !courts.includes(c)),
  ].filter((c, i, all) => all.indexOf(c) === i);
  // The whole block is Pro: the page hands down `canEdit && !frozen &&
  // scheduling.constraints`, mirroring the server's `usesConstraints()` gate
  // (schedule.ts), which trips on a non-empty `blackouts`. Windows already
  // stored stay visible read-only so a downgrade never hides data.
  const showBlackouts = canEdit || blackouts.length > 0;

  return (
    <section className="mt-8 space-y-4" aria-label="Scheduling constraints">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">
        Constraints &amp; planning
      </h2>
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* VARIANT B — a rules sheet: each row states the rule in plain English
          on the left and puts its control on the right, so the column of
          controls scans top-to-bottom and new rules slot in without redesign. */}
      <div className="card divide-y divide-slate-100 p-0">
        <div className="px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold text-slate-900">Scheduling rules</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Auto-schedule and AI Schedule both obey these; matches you place by hand are
            checked against them too.
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              A player is never in two matches at once
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Enforced across every division. Off, a double-booking is only a warning.
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.crossPersonClash === "hard"}
            disabled={!canEdit || busy}
            onChange={(e) =>
              void save({ ...constraints, crossPersonClash: e.target.checked ? "hard" : "warn" })
            }
          />
        </label>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              At least one break between a team&apos;s matches
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              No entrant plays two rounds running.
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.noBackToBack === true}
            disabled={!canEdit || busy}
            onChange={(e) => void save({ ...constraints, noBackToBack: e.target.checked })}
          />
        </label>

        <label className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">Minimum rest</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              Breathing room between one entrant&apos;s matches.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="input w-20 text-right"
              value={constraints.restMin ?? 0}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void save({ ...constraints, restMin: Math.max(0, Number(e.target.value)) })
              }
            />
            min
          </span>
        </label>

        <label className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">{msg("constraints.maxPerDay.label")}</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.maxPerDay.hint")}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
            <input
              type="number"
              min={1}
              inputMode="numeric"
              placeholder={msg("constraints.maxPerDay.placeholder")}
              className="input w-20 text-right"
              value={maxPerDay ?? ""}
              disabled={!canEdit || busy}
              onChange={(e) => {
                const raw = e.target.value;
                const count = raw === "" ? undefined : Math.max(1, Math.trunc(Number(raw)));
                void save({ ...constraints, hard: withMaxFixturesPerDay(constraints.hard, divisionId, count) });
              }}
            />
            {msg("constraints.maxPerDay.unit")}
          </span>
        </label>

        {/* Row, not <label>: the Tip is a <button>, and a button inside a label
            both pollutes the label's accessible name and re-targets clicks at
            the select. Same reason the history panel keeps its Tip outside the
            heading. */}
        <div className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
          <span className="min-w-0">
            <label htmlFor="ff-select" className="block text-sm text-slate-800">
              Field fairness
            </label>
            <span className="mt-0.5 block text-xs text-slate-400">
              A tie-break between courts free at the same moment — never a delay.
            </span>
          </span>
          <span className="flex w-full items-center gap-2 sm:w-auto">
            <Tip id="schedule.field-fairness" className="shrink-0" small />
            <select
              id="ff-select"
              className="select w-full sm:w-44"
            value={constraints.fieldFairness ?? "off"}
            disabled={!canEdit || busy}
            onChange={(e) =>
              void save({
                ...constraints,
                fieldFairness: e.target.value as Constraints["fieldFairness"],
              })
            }
          >
              <option value="off">Off</option>
              <option value="balance">Balance courts</option>
              <option value="rotate">Rotate every game</option>
            </select>
          </span>
        </div>

        {(constraints.startWindows?.length ?? 0) > 0 && (
          <p className="px-4 py-3 text-xs text-slate-500 sm:px-5">
            {constraints.startWindows!.length} start window(s) set.
          </p>
        )}

        {/* Blackout windows. The only row of this sheet whose control is a
            COLLECTION, so it drops the left-sentence/right-control split and
            takes the full width underneath its own heading — a variable-height
            block in the control column would break the scan the sheet exists
            for. Last row on purpose, for the same reason. */}
        {showBlackouts && (
          <div className="px-4 py-3 sm:px-5">
            <span className="block text-sm text-slate-800">{msg("constraints.blackout.title")}</span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.blackout.hint")}
            </span>
            {/* Both instants below are read and written on the VENUE clock, so
                the panel has to say which one that is: an organiser in another
                zone otherwise types a time meaning their own and gets no signal
                that it was taken as the venue's. Reuses the caption the stages
                panel already shows over fixture times — same fact, same words,
                and it is already translated in all four locales. */}
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("schedule.tz.caption", { tz: orgTz })}
            </span>

            {blackouts.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-purple-200 px-3 py-4 text-center text-xs text-slate-500">
                {msg("constraints.blackout.empty")}
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {blackouts.map((row, i) => {
                  const rowError = blackoutRowError(row, orgTz);
                  return (
                    // Index key: every field is controlled from this array, so
                    // there is no per-row state for React to mis-reuse — the
                    // same choice the settings panel's court list makes.
                    <li key={i} className="rounded-lg border border-purple-100 bg-purple-50/60 p-3">
                      {/* One row of fields at `sm`; stacked on a phone with the
                          remove control tucked beside the scope select, so a
                          three-window list does not become three full-width red
                          buttons down the page. DOM order puts the button
                          second for that layout and `sm:order-last` returns it
                          to the end of the desktop row. */}
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <label className="block">
                          <span className="label">{msg("constraints.blackout.scope")}</span>
                          <select
                            className="select w-full"
                            value={row.court}
                            disabled={!canEdit || busy}
                            onChange={(e) => updateBlackout(i, { court: e.target.value })}
                          >
                            <option value="">{msg("constraints.blackout.everywhere")}</option>
                            {courtOptions.map((court) => (
                              <option key={court} value={court}>
                                {court}
                              </option>
                            ))}
                          </select>
                        </label>
                        {canEdit && (
                          // `min-h-11`/`w-11` is the 44px touch floor
                          // mobile.spec.ts asserts; `.btn` alone renders 38px.
                          <button
                            type="button"
                            aria-label={msg("constraints.blackout.remove", { n: i + 1 })}
                            className="btn btn-danger min-h-11 w-11 px-0 sm:order-last"
                            disabled={busy}
                            onClick={() => setBlackouts((rows) => rows.filter((_, j) => j !== i))}
                          >
                            ✕
                          </button>
                        )}
                        {/* DateTimeField owns its whole <label> and takes no
                            className, so the grid span lives on a wrapper.
                            Visible labels, not `labelHidden`: nothing above
                            these two names them, and a column header would
                            vanish at 375px where the row stacks. */}
                        <div className="col-span-2 sm:col-span-1">
                          <DateTimeField
                            kind="datetime-local"
                            label={msg("constraints.blackout.from")}
                            value={row.from}
                            required
                            disabled={!canEdit || busy}
                            onChange={(v) => updateBlackout(i, { from: v })}
                          />
                        </div>
                        <div className="col-span-2 sm:col-span-1">
                          <DateTimeField
                            kind="datetime-local"
                            label={msg("constraints.blackout.to")}
                            value={row.to}
                            min={row.from === "" ? undefined : row.from}
                            required
                            disabled={!canEdit || busy}
                            onChange={(v) => updateBlackout(i, { to: v })}
                          />
                        </div>
                      </div>
                      {rowError !== null && (
                        <p
                          className={`mt-2 text-xs ${
                            rowError === "order" ? "text-red-600" : "text-slate-500"
                          }`}
                        >
                          {msg(
                            rowError === "order"
                              ? "constraints.blackout.errorOrder"
                              : "constraints.blackout.errorIncomplete",
                          )}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {canEdit && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-ghost text-sm"
                  disabled={busy}
                  onClick={() => setBlackouts((rows) => [...rows, { court: "", from: "", to: "" }])}
                >
                  {msg("constraints.blackout.add")}
                </button>
                {blackoutsDirty && (
                  <button
                    type="button"
                    className="btn btn-primary text-sm"
                    disabled={busy || pendingBlackouts === null}
                    onClick={() => {
                      if (pendingBlackouts === null) return;
                      const committed = blackouts;
                      void savePatch({ blackouts: pendingBlackouts }, () =>
                        setSavedBlackouts(committed),
                      );
                    }}
                  >
                    {busy ? msg("constraints.blackout.saving") : msg("constraints.blackout.save")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* bulk shift */}
        {canEdit && (
          <div className="card space-y-3 p-4">
            <h3 className="text-sm font-semibold text-slate-900">Bulk time shift</h3>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="number"
                className="input w-24"
                value={shiftMinutes}
                onChange={(e) => setShiftMinutes(Number(e.target.value))}
                aria-label="Shift minutes"
              />
              minutes
              <button
                type="button"
                className="btn btn-primary px-3 py-1.5 text-xs"
                disabled={busy || shiftMinutes === 0}
                onClick={async () => {
                  // A whole-timetable move deserves a breath first (organiser
                  // ask) — and the honest promise that conflicts are fixable.
                  const ok = await confirmDialog({
                    title: msg("confirm.shiftAll.title", { minutes: shiftMinutes }),
                    body: msg("confirm.shiftAll.body"),
                    confirmLabel: msg("confirm.shiftAll.label"),
                  });
                  if (!ok) return;
                  void run(
                    () =>
                      apiV1("/api/v1/schedule/shift", {
                        method: "POST",
                        json: {
                          division_id: divisionId,
                          scope: { excludeLocked: true },
                          delta_minutes: shiftMinutes,
                        },
                      }),
                    true,
                  );
                }}
              >
                Shift everything
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Locked and decided fixtures stay put. Undoable from the history panel.
            </p>
          </div>
        )}

        {/* wait report */}
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Wait-time report</h3>
          <p className="text-xs text-slate-500">
            Who sits around the longest between their matches — worth a look before you publish.
          </p>
          <button
            type="button"
            className="btn btn-primary px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setReport(await apiV1(`/api/v1/divisions/${divisionId}/schedule/report`));
              })
            }
          >
            {busy ? "Checking…" : "Check waits"}
          </button>
          {report &&
            (report.worst.length === 0 ? (
              <p className="text-sm text-slate-500">No multi-game waits yet.</p>
            ) : (
              <div className="scroll-x scroll-x-fade">
                <table className="w-full text-sm" aria-label="Longest waits between matches">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500 uppercase">
                      <th className="py-1.5 pr-3 font-medium">Entrant</th>
                      <th className="py-1.5 pr-3 font-medium">Games</th>
                      <th className="py-1.5 pr-3 font-medium">Longest wait</th>
                      <th className="py-1.5 font-medium">First to last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.worst.map((r, i) => (
                      <tr key={r.display_name} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-3 font-medium text-slate-800">{r.display_name}</td>
                        <td className="py-1.5 pr-3 text-slate-600 tabular-nums">{r.fixtures}</td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-semibold ${
                              i === 0
                                ? "bg-red-100 text-red-700"
                                : (r.maxGapMinutes ?? 0) >= 120
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {fmtDuration(r.maxGapMinutes ?? 0)}
                          </span>
                        </td>
                        <td className="py-1.5 text-slate-600 tabular-nums">
                          {fmtDuration(r.spanMinutes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-slate-500">
                  Sorted worst-first. Tighten the gaps by re-flowing on the board, or raise min
                  rest and re-run.
                </p>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
