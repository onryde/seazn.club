"use client";

// R2006 (owner ruling 2026-10-19, "Option C"): the fixture's stored score preferences on the organiser's panel — the
// stream mode (the score by default, "Camera only" the organiser's opt-out), the score style and the score timing.
//
//  - `useStreamPrefs` holds the three as the panel shows them: seeded from the page's read (StreamPanelContext
//    `streamPrefs`), each change shown at once and saved through the ONE settings route (PUT …/stream-settings, a body
//    naming only that field). A save that fails puts the stored value back — the value the phone's start and the
//    automatic start will read — and says so; only the newest save of a field lands, so a slow older answer never
//    overwrites a newer choice.
//  - `ScoreTiming` edits the delay before going live: 0–30 s in steps of 0.1, null = the server's default (handed in,
//    never typed), 0 a real override. `ScoreLiveSummary` is the read-only pair a running composed session shows: a
//    running session never moves, so it reads the SESSION's own copy, not the settings.
import { useCallback, useRef, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { fmtNumber } from "@/lib/format";
import { OVERLAY_DELAY_MAX_MS, type StreamPrefs } from "@/lib/stream-settings";

export type PrefKey = keyof StreamPrefs;

/** The panel's copy of the stored preferences, and one saver per field. `failed` names the field whose last save did
 *  not land (it shows the stored value again); a later save of any field clears it. */
export function useStreamPrefs(fixtureId: string, initial: StreamPrefs) {
  const [prefs, setPrefs] = useState<StreamPrefs>(initial);
  const [failed, setFailed] = useState<PrefKey | null>(null);
  // The value each field stands at NOW, for the callbacks below (a save's answer settles against the state as it is
  // when it lands, never as it was when it was asked).
  const current = useRef<StreamPrefs>(initial);
  const seq = useRef<Record<PrefKey, number>>({ streamMode: 0, overlayTemplate: 0, overlayDelayMs: 0 });
  const put = (next: StreamPrefs) => {
    current.current = next;
    setPrefs(next);
  };
  const save = useCallback(
    <K extends PrefKey>(key: K, value: StreamPrefs[K]) => {
      const before = current.current[key];
      if (before === value) return;
      const n = ++seq.current[key];
      put({ ...current.current, [key]: value });
      setFailed(null);
      void apiV1<StreamPrefs>(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { [key]: value } }).then(
        (answer) => {
          // The server's answer is the stored value (a template it resolved, a delay it kept) — newest save only.
          if (seq.current[key] !== n || !answer || !(key in answer)) return;
          put({ ...current.current, [key]: answer[key] });
        },
        () => {
          if (seq.current[key] !== n) return;
          put({ ...current.current, [key]: before });
          setFailed(key);
        },
      );
    },
    [fixtureId],
  );
  return { prefs, failed, save };
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
  const commit = () => {
    const ms = parseDelayInput(draft);
    if (ms === null) {
      setInvalid(draft.trim() !== "");
      if (draft.trim() === "") setDraft(inputText(effective));
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
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
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
