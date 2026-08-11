"use client";

// Constraints v2 console (Jul3/04 §6): constraint editor, bulk time shift,
// and the pre-publish wait-time report.
import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useMsg } from "@/components/i18n/dict-provider";
import { Tip } from "@/components/ui/tip";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { RestFloorNote, restFloorNoteShown } from "@/components/v2/rest-floor-note";
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

// ---------------------------------------------------------------------------
// Draft-then-commit numeric fields (restMin, max-per-day). Every OTHER
// control on this sheet commits instantly (see the module comment above
// `saveConstraints` below) — correct for a checkbox or a select, where every
// intermediate state is itself a valid value. A number typed digit-by-digit
// is not: "1" on the way to typing "12" is briefly a real, storable value,
// and until now it was briefly the LIVE constraint. PR #505 fixed WHICH of
// several concurrent writes wins; it did not stop every keystroke from being
// a write at all. An Auto-schedule kicked off, or another tab reading the
// division, while an organiser was mid-type built the board against
// whatever partial number happened to be on the wire at that instant.
//
// `DraftFieldState` is a local typing buffer that commits explicitly on blur
// or Enter instead, the same idea the blackout editor above already applies
// to a whole row (draft array + `savedBlackouts` + an explicit save button) —
// scaled down to one scalar value with no button of its own (see
// `constraints.field.saved` in the render below for why: a button per row on
// a settings LIST reads as a form).
//
// Exported and unit-tested standalone, the same way
// `readMaxFixturesPerDay`/`withMaxFixturesPerDay` above are, since this
// workspace has no jsdom to drive an `<input>` directly.
// ---------------------------------------------------------------------------

export interface DraftFieldState {
  /** What the input currently shows. */
  text: string;
  /** The last value this draft is known to agree with the committed state
   *  on — the Escape target, and the yardstick `dirty` is measured against.
   *  Moves on every commit AND on every `committedChanged`, so Escape always
   *  lands on the freshest known-good value, never a stale one. */
  seed: string;
  /** True once the organiser has typed something not yet committed (or
   *  reverted). Gates two things at the call site: an unchanged blur must
   *  not write (§ requirement 4), and an external update to the committed
   *  value must not overwrite a live edit (§ requirement 5). */
  dirty: boolean;
}

export function initDraftField(committedText: string): DraftFieldState {
  return { text: committedText, seed: committedText, dirty: false };
}

export type DraftFieldAction =
  | { type: "type"; text: string }
  | { type: "commit" }
  | { type: "revert" }
  /** Dispatched when the value this draft shadows moves for a reason OTHER
   *  than this draft's own commit — another control's save landing, a
   *  division switch. */
  | { type: "committedChanged"; text: string };

/**
 * Pure transition for one draft field. A dirty draft is left showing what
 * the organiser typed on `committedChanged` — the same "don't yank a
 * deliberate action" rule the schedule board's day-tab re-derivation uses
 * (schedule-board.tsx) — an unrelated update landing mid-edit is no reason
 * to discard it. The seed still moves, so a SUBSEQUENT Escape reverts to the
 * fresh value rather than the one that was current when the edit started.
 */
export function draftFieldReducer(state: DraftFieldState, action: DraftFieldAction): DraftFieldState {
  switch (action.type) {
    case "type":
      return { ...state, text: action.text, dirty: action.text !== state.seed };
    case "commit":
      return { text: state.text, seed: state.text, dirty: false };
    case "revert":
      return { text: state.seed, seed: state.seed, dirty: false };
    case "committedChanged":
      return state.dirty ? { ...state, seed: action.text } : initDraftField(action.text);
  }
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
  /** The three board numbers are declared, not left in the `unknown` half, for
   *  one reason: the rest floor is the MAX of four controls and only one of
   *  them lives on this tab. `perEntrantMinRest` is set on Settings, and
   *  "at least one break" resolves to `matchMinutes + gapMinutes` — so this
   *  panel cannot say what rest an entrant will actually get without reading
   *  all three. They were on the prop all along (one `getScheduleSettings` call
   *  feeds BOTH panels the same object); nothing had declared them. */
  config: Record<string, unknown> & {
    constraints?: Constraints;
    perEntrantMinRest?: number;
    matchMinutes?: number;
    gapMinutes?: number;
  };
}
interface WaitRow {
  display_name: string;
  fixtures: number;
  minGapMinutes: number | null;
  maxGapMinutes: number | null;
  spanMinutes: number;
}

/** Wires {@link draftFieldReducer} to one committed text value: seeds on
 *  mount, and re-seeds during render whenever `committedText` moves — the
 *  same render-time "derive from props" adjustment `useBoardActions` and the
 *  schedule board's day tab use (no effect cascade; the corrected draft
 *  renders in this same pass). Comparing by VALUE, not object identity, so
 *  an unrelated save elsewhere on this sheet (which changes `constraints`'
 *  identity but not this field's value) is not mistaken for this field
 *  changing.
 *
 *  `seen` is `useState`, not `useRef`, on purpose — matching the day tab's
 *  own choice, not an arbitrary one: refs are for event handlers and
 *  effects, and reading or writing `.current` during render (which this
 *  comparison runs in) is a lint error (react-hooks/refs) for real reasons —
 *  a discarded/retried render must not leave a mutation behind that a
 *  thrown-away state update WOULD roll back. */
function useDraftField(committedText: string) {
  const [state, dispatch] = useReducer(draftFieldReducer, committedText, initDraftField);
  const [seen, setSeen] = useState(committedText);
  if (seen !== committedText) {
    setSeen(committedText);
    dispatch({ type: "committedChanged", text: committedText });
  }
  return [state, dispatch] as const;
}

/** The transient "Saved" pulse: true for `ms`, then clears itself. Reset on
 *  every call so two commits close together do not race their own timeouts;
 *  cleared on unmount so a pulse mid-flight cannot set state after this
 *  panel is gone (switching off the Constraints tab unmounts it — the tab
 *  bar renders `{tab === "constraints" && <ConstraintsPanel .../>}`). */
function useSavedPulse(ms = 2000) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const pulse = () => {
    if (timer.current) clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => setSaved(false), ms);
  };
  return [saved, pulse] as const;
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
  // `constraints` is the LIVE state — these rows save per keystroke — so the
  // note moves with the checkbox below it. The three board numbers come off the
  // prop unchanged; this panel never edits them. `matchMinutes` is spread
  // conditionally rather than defaulted to 0: absent means "no match length
  // known", and `restFloor` then skips the no-back-to-back source instead of
  // resolving it to the gap alone.
  const restNoteConfig = {
    perEntrantMinRest: initialSettings.config.perEntrantMinRest ?? 0,
    gapMinutes: initialSettings.config.gapMinutes ?? 0,
    ...(initialSettings.config.matchMinutes !== undefined
      ? { matchMinutes: initialSettings.config.matchMinutes }
      : {}),
    constraints,
  };
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
        setError(err instanceof Error ? err.message : msg("constraints.error.failed"));
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

  // `constraints` mirrored into a ref, kept in sync ONLY where `setConstraints`
  // itself is called (`applied` below) rather than on every render — reading
  // or writing `.current` during render is a lint error (react-hooks/refs:
  // refs are for event handlers and effects, not render). The two can never
  // drift: both start from the same initial value and both change together,
  // exactly once, inside `applied`. The point of the ref rather than reading
  // `constraints` state directly is timing, not staleness: a save that had
  // to wait its turn (below) builds its patch from what the save ahead of it
  // just wrote, without waiting for a re-render to observe it.
  const constraintsRef = useRef(constraints);

  // Every control on this sheet used to call a `save(next)` built from the
  // `constraints` closure AT KEYSTROKE TIME, firing its GET-then-PUT
  // immediately — so two edits close together (typing a second digit before
  // the first digit's round trip returned; a field's own retype after
  // clearing it) started two independent GET+PUT pairs, and the LAST
  // RESPONSE TO ARRIVE won the write — not the last one SENT, and not
  // necessarily the request built from the most recent keystroke. Whichever
  // request's network happened to be slower, for any reason, silently
  // overwrote a newer value with a stale one. That is how typing "5" into
  // max-per-day was stored as 10, then 8 (division
  // 7f41f7c4-e1d6-4432-b65c-7343f504e866, Aug 2026) — confirmed by racing two
  // deliberately-delayed requests in constraints-panel-save-race.test.tsx.
  //
  // `saveConstraints` fixes this by chaining every call onto ONE promise: at
  // most one GET-then-PUT for this panel's `constraints` key is ever in
  // flight, so responses can only arrive in the order they were sent.
  // `producer` runs once it is this task's turn — reading `constraintsRef`
  // fresh at that moment, never at enqueue time — so a save queued behind
  // another sees what that one just wrote. That is what keeps
  // `withMaxFixturesPerDay`'s "every other hard rule untouched" guarantee
  // true across queued saves, not just within a single one.
  const constraintsQueue = useRef<Promise<void>>(Promise.resolve());
  const saveConstraints = (
    producer: (current: Constraints) => Constraints,
    // Fired from INSIDE `applied()`, i.e. only on this task's own genuine
    // success — `run()` swallows a failed save into `error` state and never
    // rethrows, so the queue promise itself resolves either way and cannot
    // be used to tell success from failure. Optional and additive: the three
    // instant-commit controls below don't pass one and are unaffected.
    onSaved?: () => void,
  ) => {
    constraintsQueue.current = constraintsQueue.current
      // `run()` already reports a failed save to the user and never
      // rethrows — but a defensive `.catch` here costs nothing, and without
      // it a hypothetical future rejection would permanently wedge every
      // save queued after it (a `.then` chained onto a rejected promise
      // never runs its handler), which would be a worse bug than the one
      // this file fixes.
      .catch(() => {})
      .then(() => {
        const next = producer(constraintsRef.current);
        return savePatch({ constraints: next }, () => {
          constraintsRef.current = next;
          setConstraints(next);
          onSaved?.();
        });
      });
  };

  // restMin / max-per-day: draft-then-commit (blur, Enter), not per keystroke
  // — see the module comment above `DraftFieldState`. `constraints.restMin`/
  // `maxPerDay` (both already LIVE, committed state) are what each draft
  // shadows; re-seeding on THAT rather than on `initialSettings` keeps this
  // in step with how every other control on this sheet already resolves its
  // value, including this field's own commit landing.
  const [restMinField, dispatchRestMin] = useDraftField(String(constraints.restMin ?? 0));
  const [restMinSaved, pulseRestMinSaved] = useSavedPulse();
  const commitRestMin = () => {
    if (!restMinField.dirty) return; // requirement 4: unchanged blur must not write
    const text = restMinField.text;
    dispatchRestMin({ type: "commit" });
    const restMin = Math.max(0, Number(text)); // coercion preserved exactly
    saveConstraints((current) => ({ ...current, restMin }), pulseRestMinSaved);
  };

  const [maxPerDayField, dispatchMaxPerDay] = useDraftField(maxPerDay === undefined ? "" : String(maxPerDay));
  const [maxPerDaySaved, pulseMaxPerDaySaved] = useSavedPulse();
  const commitMaxPerDay = () => {
    if (!maxPerDayField.dirty) return;
    const raw = maxPerDayField.text;
    dispatchMaxPerDay({ type: "commit" });
    const count = raw === "" ? undefined : Math.max(1, Math.trunc(Number(raw))); // coercion preserved exactly
    saveConstraints(
      (current) => ({ ...current, hard: withMaxFixturesPerDay(current.hard, divisionId, count) }),
      pulseMaxPerDaySaved,
    );
  };

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
    <section className="mt-8 space-y-4" aria-label={msg("constraints.panel.ariaLabel")}>
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">
        {msg("constraints.panel.title")}
      </h2>
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* VARIANT B — a rules sheet: each row states the rule in plain English
          on the left and puts its control on the right, so the column of
          controls scans top-to-bottom and new rules slot in without redesign. */}
      <div className="card divide-y divide-slate-100 p-0">
        <div className="px-4 py-3 sm:px-5">
          <h3 className="text-sm font-semibold text-slate-900">{msg("constraints.rules.heading")}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {msg("constraints.rules.intro")}
          </p>
        </div>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              {msg("constraints.crossPersonClash.label")}
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.crossPersonClash.hint")}
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.crossPersonClash === "hard"}
            disabled={!canEdit || busy}
            onChange={(e) => {
              const checked = e.target.checked;
              saveConstraints((current) => ({ ...current, crossPersonClash: checked ? "hard" : "warn" }));
            }}
          />
        </label>

        <label className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
          <span className="min-w-0">
            <span className="block text-sm text-slate-800">
              {msg("constraints.noBackToBack.label")}
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.noBackToBack.hint")}
            </span>
          </span>
          <input
            type="checkbox"
            className="shrink-0"
            checked={constraints.noBackToBack === true}
            disabled={!canEdit || busy}
            onChange={(e) => {
              const checked = e.target.checked;
              saveConstraints((current) => ({ ...current, noBackToBack: checked }));
            }}
          />
        </label>

        {/* A <div> with an explicit htmlFor, not a wrapping <label> — the same
            shape the field-fairness row below uses, and for the same reason:
            `Tip` renders a <button>, and a button inside a <label> forwards its
            click to the control. Association stays real via the id. */}
        <div className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <span className="min-w-0">
            <label htmlFor="rest-min" className="block text-sm text-slate-800">
              {msg("constraints.restMin.label")}
            </label>
            {/* The hint and the unit used to sit INSIDE the wrapping <label>,
                so both fed the input's accessible name. Splitting the label out
                to host the tip would have dropped them; `aria-describedby` keeps
                them, as a description rather than a name. Literal ids match the
                `ff-select` row below — this panel has one call site. */}
            <span id="rest-min-hint" className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.restMin.hint")}
            </span>
            {/* `constraints` is the LIVE state — these rows save per keystroke —
                so the note moves with the checkbox below it. The three board
                numbers come off the prop unchanged; this panel never edits them.
                `matchMinutes` is spread conditionally rather than defaulted to 0:
                absent means "no match length known", and `restFloor` then skips
                the no-back-to-back source instead of resolving it to the gap. */}
            <RestFloorNote id="rest-min-floor" field="restMin" config={restNoteConfig} />
            {/* Transient save feedback, not a per-row button — several rows
                each with a button reads as a form, not a settings list (the
                blackout editor's button works because it commits a whole
                collection, not one scalar). Always mounted, fixed height, so
                it never reflows the row when it appears; `aria-live` so it
                is announced without moving focus. */}
            <span
              id="rest-min-saved"
              aria-live="polite"
              role="status"
              className={`mt-0.5 block h-4 truncate text-xs text-emerald-600 motion-safe:transition-opacity ${
                restMinSaved ? "opacity-100" : "opacity-0"
              }`}
            >
              {restMinSaved ? msg("constraints.field.saved") : ""}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
            {/* Same tip id as the Settings tab's field: one wording for one
                idea, so the two tabs cannot drift apart. */}
            <Tip id="schedule.min-rest" className="shrink-0" small />
            <input
              id="rest-min"
              // The floor note joins the described set only when it RENDERS.
              // `aria-describedby` pointing at an absent id is a dangling
              // reference; `restFloorNoteShown` is the component's own
              // predicate, so attribute and markup cannot disagree. The
              // save-pulse is deliberately NOT in this set: it is announced
              // via `aria-live` on mutation, not read out on every focus.
              aria-describedby={
                restFloorNoteShown(restNoteConfig, "restMin")
                  ? "rest-min-hint rest-min-unit rest-min-floor"
                  : "rest-min-hint rest-min-unit"
              }
              type="number"
              min={0}
              inputMode="numeric"
              className="input w-20 text-right"
              value={restMinField.text}
              disabled={!canEdit || busy}
              onChange={(e) => dispatchRestMin({ type: "type", text: e.target.value })}
              onBlur={commitRestMin}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRestMin();
                else if (e.key === "Escape") dispatchRestMin({ type: "revert" });
              }}
            />
            <span id="rest-min-unit">{msg("constraints.restMin.unit")}</span>
          </span>
        </div>

        {/* A <div> with an explicit htmlFor, not a wrapping <label> — the
            same reason restMin above uses one: a wrapping <label> folds
            EVERY text node inside it (hint, save-pulse) into the input's
            accessible NAME, so a transient "Saved." would make the name
            change every time it appears. Association stays real via the id;
            the hint and save-pulse move to `aria-describedby` instead. */}
        <div className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5">
          <span className="min-w-0">
            <label htmlFor="max-per-day" className="block text-sm text-slate-800">
              {msg("constraints.maxPerDay.label")}
            </label>
            <span id="max-per-day-hint" className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.maxPerDay.hint")}
            </span>
            {/* Same transient-save pattern as restMin above — see its
                comment for why this is not a per-row button. */}
            <span
              id="max-per-day-saved"
              aria-live="polite"
              role="status"
              className={`mt-0.5 block h-4 truncate text-xs text-emerald-600 motion-safe:transition-opacity ${
                maxPerDaySaved ? "opacity-100" : "opacity-0"
              }`}
            >
              {maxPerDaySaved ? msg("constraints.field.saved") : ""}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-sm text-slate-500">
            <input
              id="max-per-day"
              aria-describedby="max-per-day-hint max-per-day-unit"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder={msg("constraints.maxPerDay.placeholder")}
              className="input w-20 text-right"
              value={maxPerDayField.text}
              disabled={!canEdit || busy}
              onChange={(e) => dispatchMaxPerDay({ type: "type", text: e.target.value })}
              onBlur={commitMaxPerDay}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitMaxPerDay();
                else if (e.key === "Escape") dispatchMaxPerDay({ type: "revert" });
              }}
            />
            <span id="max-per-day-unit">{msg("constraints.maxPerDay.unit")}</span>
          </span>
        </div>

        {/* Row, not <label>: the Tip is a <button>, and a button inside a label
            both pollutes the label's accessible name and re-targets clicks at
            the select. Same reason the history panel keeps its Tip outside the
            heading. */}
        <div className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5">
          <span className="min-w-0">
            <label htmlFor="ff-select" className="block text-sm text-slate-800">
              {msg("constraints.fieldFairness.label")}
            </label>
            <span className="mt-0.5 block text-xs text-slate-400">
              {msg("constraints.fieldFairness.hint")}
            </span>
          </span>
          <span className="flex w-full items-center gap-2 sm:w-auto">
            <Tip id="schedule.field-fairness" className="shrink-0" small />
            <select
              id="ff-select"
              className="select w-full sm:w-44"
            value={constraints.fieldFairness ?? "off"}
            disabled={!canEdit || busy}
            onChange={(e) => {
              const fieldFairness = e.target.value as Constraints["fieldFairness"];
              saveConstraints((current) => ({ ...current, fieldFairness }));
            }}
          >
              <option value="off">{msg("constraints.fieldFairness.off")}</option>
              <option value="balance">{msg("constraints.fieldFairness.balance")}</option>
              <option value="rotate">{msg("constraints.fieldFairness.rotate")}</option>
            </select>
          </span>
        </div>

        {(constraints.startWindows?.length ?? 0) > 0 && (
          <p className="px-4 py-3 text-xs text-slate-500 sm:px-5">
            {msg("constraints.startWindows.count", { n: constraints.startWindows!.length })}
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
            <h3 className="text-sm font-semibold text-slate-900">{msg("constraints.bulkShift.heading")}</h3>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="number"
                className="input w-24"
                value={shiftMinutes}
                onChange={(e) => setShiftMinutes(Number(e.target.value))}
                aria-label={msg("constraints.bulkShift.minutesAriaLabel")}
              />
              {msg("constraints.bulkShift.unit")}
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
                {msg("constraints.bulkShift.button")}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {msg("constraints.bulkShift.hint")}
            </p>
          </div>
        )}

        {/* wait report */}
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">{msg("constraints.waitReport.heading")}</h3>
          <p className="text-xs text-slate-500">
            {msg("constraints.waitReport.intro")}
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
            {busy ? msg("constraints.waitReport.checking") : msg("constraints.waitReport.check")}
          </button>
          {report &&
            (report.worst.length === 0 ? (
              <p className="text-sm text-slate-500">{msg("constraints.waitReport.empty")}</p>
            ) : (
              <div className="scroll-x scroll-x-fade">
                <table className="w-full text-sm" aria-label={msg("constraints.waitReport.tableAriaLabel")}>
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs tracking-wide text-slate-500 uppercase">
                      <th className="py-1.5 pr-3 font-medium">{msg("constraints.waitReport.colEntrant")}</th>
                      <th className="py-1.5 pr-3 font-medium">{msg("constraints.waitReport.colGames")}</th>
                      <th className="py-1.5 pr-3 font-medium">{msg("constraints.waitReport.colLongestWait")}</th>
                      <th className="py-1.5 font-medium">{msg("constraints.waitReport.colFirstToLast")}</th>
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
                  {msg("constraints.waitReport.footer")}
                </p>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
