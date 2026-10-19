"use client";

// R2006 (owner ruling 2026-10-19, "Option C"): the fixture's stored score preferences on the organiser's panel — the
// stream mode (the score by default, "Camera only" the organiser's opt-out), the score style and the score timing.
//
//  - `useStreamPrefs` holds the three as the panel shows them: seeded from the page's read (StreamPanelContext
//    `streamPrefs`), each change shown at once and saved through the ONE settings route (PUT …/stream-settings, a body
//    naming only that field). Every page read and every save's answer is folded in by the settings row's `revision`
//    (PR #989 confirm N1): a field takes a read only when it is NEWER than the one the field last took. The panel
//    therefore converges on the server's LAST write — the value the phone's start and the automatic start will read —
//    even when that is an older save whose write happened to commit last; a refresh that left the server before a
//    save landed cannot put the older value back. Until the newest save of a field settles, the field shows the
//    organiser's own choice (m3); a newest save that fails shows what the server is known to hold now, and says so.
//  - `ScoreTiming` edits the delay before going live: 0–30 s in steps of 0.1, null = the server's default (handed in,
//    never typed), 0 a real override. `ScoreLiveSummary` is the read-only pair a running composed session shows: a
//    running session never moves, so it reads the SESSION's own copy, not the settings.
import { useReducer, useRef, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { fmtNumber } from "@/lib/format";
import { OVERLAY_DELAY_MAX_MS, type StreamPrefs, type StreamPrefsRead } from "@/lib/stream-settings";

export type PrefKey = keyof StreamPrefs;

const PREF_KEYS: readonly PrefKey[] = ["streamMode", "overlayTemplate", "overlayDelayMs"];
const NONE_IN_FLIGHT: Readonly<Record<PrefKey, number>> = { streamMode: 0, overlayTemplate: 0, overlayDelayMs: 0 };

/** What the panel knows of the stored preferences, folded from every READ it has seen — the page's reads and each save's
 *  answer (an answer is a read of the whole row) — field by field: a field takes a read's value only when that read is
 *  strictly NEWER (`revision`) than the one the field last took. PR #989 confirm N1: values alone cannot order a read
 *  against a save already settled — a refresh that left the server before a save landed can carry that field's OLDER
 *  value and still differ from the page's previous read. */
interface PrefsState {
  /** What the panel shows: `known`, except a field with a save in flight shows the organiser's own newer choice. */
  shown: StreamPrefs;
  known: { [K in PrefKey]: { value: StreamPrefs[K]; revision: number } };
  inFlight: Record<PrefKey, number>;
  /** The page read last folded in — a new one is noticed in render, against this. */
  seen: StreamPrefsRead;
}

/** A read's revision as an order: no row yet is older than any write. */
const order = (revision: number | null): number => revision ?? Number.NEGATIVE_INFINITY;

const knownFrom = (read: StreamPrefsRead): PrefsState["known"] => ({
  streamMode: { value: read.streamMode, revision: order(read.revision) },
  overlayTemplate: { value: read.overlayTemplate, revision: order(read.revision) },
  overlayDelayMs: { value: read.overlayDelayMs, revision: order(read.revision) },
});

/** Fold one read into `known`: each field it is newer for takes its value. */
function foldRead(known: PrefsState["known"], read: StreamPrefsRead): PrefsState["known"] {
  const at = order(read.revision);
  const next = { ...known };
  for (const k of PREF_KEYS) if (at > known[k].revision) (next as Record<PrefKey, unknown>)[k] = { value: read[k], revision: at };
  return next;
}

/** Show `known` for every field with no save in flight. */
function settledShown(shown: StreamPrefs, known: PrefsState["known"], inFlight: Record<PrefKey, number>): StreamPrefs {
  const next = { ...shown };
  for (const k of PREF_KEYS) if (inFlight[k] === 0) (next as Record<PrefKey, unknown>)[k] = known[k].value;
  return next;
}

type PrefsAction =
  | { type: "read"; read: StreamPrefsRead }
  | { type: "start"; key: PrefKey; value: StreamPrefs[PrefKey] }
  | { type: "settled"; key: PrefKey; newest: boolean; ok: boolean; answer: StreamPrefsRead | null };

function prefsReducer(state: PrefsState, action: PrefsAction): PrefsState {
  switch (action.type) {
    case "read": {
      const known = foldRead(state.known, action.read);
      return { ...state, seen: action.read, known, shown: settledShown(state.shown, known, state.inFlight) };
    }
    case "start": {
      const inFlight = { ...state.inFlight, [action.key]: state.inFlight[action.key] + 1 };
      return { ...state, inFlight, shown: { ...state.shown, [action.key]: action.value } };
    }
    case "settled": {
      const { key, newest, ok, answer } = action;
      const inFlight = { ...state.inFlight, [key]: state.inFlight[key] - 1 };
      const known = answer ? foldRead(state.known, answer) : state.known;
      const shown = settledShown(state.shown, known, inFlight);
      // The newest save of a field decides what it shows, even while an older one is still out. On success, that is the
      // newest the server is known to hold (its answer, or a read written after it). On failure, it is whatever the
      // server is now known to hold (the latest read, or an earlier save that landed), never the value from before the
      // save began once a newer read has arrived. A success with no answer (none in this route's contract) keeps the
      // organiser's choice on screen.
      if (newest) (shown as Record<PrefKey, unknown>)[key] = ok && answer === null ? state.shown[key] : known[key].value;
      return { ...state, inFlight, known, shown };
    }
  }
}

/** The panel's copy of the stored preferences, and one saver per field. `failed` names the field whose last save did
 *  not land (it shows the stored value again); a later save of any field clears it. */
export function useStreamPrefs(fixtureId: string, initial: StreamPrefsRead) {
  const [state, dispatch] = useReducer(prefsReducer, initial, (read): PrefsState => ({
    shown: { streamMode: read.streamMode, overlayTemplate: read.overlayTemplate, overlayDelayMs: read.overlayDelayMs },
    known: knownFrom(read),
    inFlight: NONE_IN_FLIGHT,
    seen: read,
  }));
  const [failed, setFailed] = useState<PrefKey | null>(null);
  // Each field's newest save — read only in a save's own answer, so an older answer can tell it was overtaken.
  const seq = useRef<Record<PrefKey, number>>({ ...NONE_IN_FLIGHT });
  // A newer page read is folded in render against the read last seen, never by an effect (m3).
  if (initial.revision !== state.seen.revision || PREF_KEYS.some((k) => initial[k] !== state.seen[k])) {
    dispatch({ type: "read", read: initial });
  }
  const save = <K extends PrefKey>(key: K, value: StreamPrefs[K]) => {
    // No "same value" guard here (m4): every caller offers only a change — the picker skips the selected option, Score
    // timing the delay already in force, and the mode controls exist only for the mode not in force.
    const n = ++seq.current[key];
    dispatch({ type: "start", key, value });
    setFailed(null);
    void apiV1<StreamPrefsRead>(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { [key]: value } }).then(
      (answer) => {
        const read = answer && key in answer && "revision" in answer ? answer : null;
        dispatch({ type: "settled", key, newest: seq.current[key] === n, ok: true, answer: read });
      },
      () => {
        const newest = seq.current[key] === n;
        dispatch({ type: "settled", key, newest, ok: false, answer: null });
        // An overtaken save that fails says nothing: the newer choice is the one on screen and in flight.
        if (newest) setFailed(key);
      },
    );
  };
  return { prefs: state.shown, failed, save };
}

/** Seconds as the organiser reads them: one decimal, in the page's locale. */
export function fmtDelaySeconds(locale: string, ms: number): string {
  return fmtNumber(locale, ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The input's own text for a delay: the DOM value of a number input is always `.`-decimal, whatever the locale. */
const inputText = (ms: number): string => (ms / 1000).toFixed(1);

/** What a typed delay means: whole tenths of a second within 0–30 s, or a refusal (null). */
export function parseDelayInput(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const s = Number(t);
  if (!Number.isFinite(s)) return null;
  const ms = Math.round(s * 10) * 100;
  return ms >= 0 && ms <= OVERLAY_DELAY_MAX_MS ? ms : null;
}

/** Score timing, editable — Ready only. Closed by default, its summary the effective delay ("default" while unset). */
export function ScoreTiming(p: {
  idPrefix: string;
  /** The stored override (null = the default). */
  storedMs: number | null;
  /** StreamPanelContext.overlayDelayDefaultMs — the server's. */
  defaultMs: number;
  onSave: (ms: number | null) => void;
  saveFailed: boolean;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const effective = p.storedMs ?? p.defaultMs;
  // The field's draft follows the stored value whenever that moves (a save, a revert, the reset) — adjusted in render
  // against the value it was drawn from, never by an effect.
  const [draft, setDraft] = useState(() => inputText(effective));
  const [draftFor, setDraftFor] = useState(effective);
  const [invalid, setInvalid] = useState(false);
  if (draftFor !== effective) {
    setDraftFor(effective);
    setDraft(inputText(effective));
    setInvalid(false);
  }
  /** `badInput`: the BROWSER refused what was typed (`validity.badInput` — "2,5" in an en-locale browser). The field
   *  then reports "" although the organiser typed something, so it is refused aloud, never silently put back (m8). */
  const commit = (badInput: boolean) => {
    const ms = parseDelayInput(draft);
    if (ms === null) {
      const typed = badInput || draft.trim() !== "";
      setInvalid(typed);
      if (!typed) setDraft(inputText(effective));
      return;
    }
    setInvalid(false);
    setDraft(inputText(ms));
    // The value already in force saves nothing — typing the default over an unset delay keeps it unset.
    if (ms !== effective) p.onSave(ms);
  };
  const inputId = `${p.idPrefix}-timing-input`;
  const helpId = `${p.idPrefix}-timing-help`;
  const errorId = `${p.idPrefix}-timing-error`;
  return (
    <details data-testid="stream-timing" className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm md:min-h-9 [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-slate-800">{msg("stream.timing.title")}</span>
        <span data-testid="stream-timing-value" className="ml-auto tabular-nums text-slate-700">
          {msg("stream.timing.value", { seconds: fmtDelaySeconds(locale, effective) })}
        </span>
        {p.storedMs === null && (
          <span data-testid="stream-timing-default" className="text-xs text-slate-600">
            {msg("stream.timing.default")}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          strokeWidth={1.8}
        />
      </summary>
      <div className="pb-1">
        <p id={helpId} data-testid="stream-timing-help" className="text-xs text-slate-600">
          {msg("stream.timing.help", { seconds: fmtDelaySeconds(locale, p.defaultMs) })}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              {msg("stream.timing.inputLabel")}
            </label>
            <input
              id={inputId}
              data-testid="stream-timing-input"
              type="number"
              min={0}
              max={OVERLAY_DELAY_MAX_MS / 1000}
              step={0.1}
              inputMode="decimal"
              value={draft}
              aria-describedby={invalid ? `${helpId} ${errorId}` : helpId}
              aria-invalid={invalid || undefined}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commit(e.currentTarget.validity.badInput)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit(e.currentTarget.validity.badInput);
                }
              }}
              className={`min-h-11 w-24 min-w-0 rounded-md border bg-white px-3 text-sm tabular-nums text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200 md:min-h-9 ${
                invalid ? "border-red-300" : "border-slate-200"
              }`}
            />
            <span aria-hidden className="text-sm text-slate-600">
              {msg("stream.timing.unit")}
            </span>
          </span>
          <button
            type="button"
            data-testid="stream-timing-reset"
            disabled={p.storedMs === null}
            onClick={() => p.onSave(null)}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700 disabled:cursor-not-allowed disabled:text-slate-500 disabled:no-underline md:min-h-9"
          >
            <RotateCcw aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
            {msg("stream.timing.reset")}
          </button>
        </div>
        {invalid && (
          <p id={errorId} data-testid="stream-timing-invalid" className="mt-1 text-sm text-red-700">
            {msg("stream.timing.invalid", { max: fmtNumber(locale, OVERLAY_DELAY_MAX_MS / 1000) })}
          </p>
        )}
        {p.saveFailed && (
          <p data-testid="stream-timing-error" role="alert" className="mt-1 text-sm text-red-700">
            {msg("stream.timing.saveFailed")}
          </p>
        )}
      </div>
    </details>
  );
}

/** A running composed session's style and timing, read-only: the session's own copy (`view.overlay`). */
export function ScoreLiveSummary(p: { templateLabel: string; delayMs: number }) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  return (
    <div data-testid="stream-live-score" className="min-w-0 rounded-lg bg-white px-3 text-sm ring-1 ring-purple-100">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2">
        <span className="font-medium text-slate-800">{msg("stream.template.title")}</span>
        <span data-testid="stream-live-template" className="ml-auto min-w-0 truncate text-slate-700">
          {p.templateLabel}
        </span>
      </div>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 border-t border-purple-100 py-1">
        <span className="font-medium text-slate-800">{msg("stream.timing.title")}</span>
        <span data-testid="stream-live-timing" className="ml-auto tabular-nums text-slate-700">
          {msg("stream.timing.value", { seconds: fmtDelaySeconds(locale, p.delayMs) })}
        </span>
        <span data-testid="stream-live-timing-locked" className="w-full text-xs text-slate-600 md:w-auto">
          {msg("stream.timing.lockedLive")}
        </span>
      </div>
    </div>
  );
}
