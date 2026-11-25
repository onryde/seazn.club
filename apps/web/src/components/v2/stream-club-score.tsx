"use client";
// The Streaming page's "Score on stream" section (Seazn-hosted video, Phase 4, Task 38; mock "Option A", owner-picked 2026-11-24, layout
// only — the build is the house look). The club sets the look of the score ONCE: the style (Broadcast bar / Corner bug) and the timing
// (the delay that matches the score to the camera). Every new stream starts with it; a match may still pick its own on its Stream panel
// (fixture-stream-panel, "Club style: … — Change for this match"), and a running stream never moves (a session copies both at its start).
//
// It is the match panel's own controls, reused: the style picker (stream-template-picker.tsx) and Score timing (stream-score-settings.tsx),
// so the club's and the match's are the same widgets. The previews are the overlay's own render of the club's OWN sports in play
// (server/stream-club-score.ts), switched by a sport chip row when the club has more than one; a club with none gets one generic preview.
//
// One save per field through ONE route (`PUT /api/v1/orgs/{id}/stream-defaults`, a body naming only that field: owner / admin, a paused
// seat is refused 402 and says so). The choice shows at once and rolls back, with the refusal in words, if the save fails; the newest
// save of a field decides what it shows. A member who cannot edit sees the same facts in words with no controls.
import { useRef, useState } from "react";
import { Info } from "lucide-react";
import { OVERLAY_TEMPLATES, resolveTemplate, templatesForSport, type TemplateId } from "@/components/overlay/template-registry";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import type { OverlaySideInput } from "@/lib/overlay-model";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { ClubStreamPrefs, ClubStreamPrefsRead } from "@/lib/stream-settings";
import { seaznSwitchErrorText } from "./seazn-destination-card";
import { wireOf } from "./youtube-connect-panel";
import { fmtDelaySeconds, ScoreTiming } from "./stream-score-settings";
import { StreamTemplatePicker, type TemplatePreviewData } from "./stream-template-picker";

type ClubKey = keyof ClubStreamPrefs;

/** A refused save as this section's own sentence: the shared reader's 403 says "change streaming destinations", which is not what a style
 *  save is; every other refusal (signed out, a paused seat, the retry line) is the shared one's. */
function clubErrorText(msg: (key: MessageKey) => string, err: unknown): string {
  return wireOf(err)?.code === "FORBIDDEN" ? msg("streaming.club.error.forbidden") : seaznSwitchErrorText(msg, err);
}

/** The club's stored defaults as the page shows them: the last server answer, and the organiser's own newer choice per field while its
 *  save is out. A field takes a server answer only when its revision is NOT older than the one it holds (an older answer arriving late
 *  never puts a stale value back); the newest save of a field decides what it shows. */
function useClubPrefs(orgId: string, initial: ClubStreamPrefsRead) {
  const [known, setKnown] = useState<ClubStreamPrefsRead>(initial);
  const [pending, setPending] = useState<{ [K in ClubKey]?: { value: ClubStreamPrefs[K] } }>({});
  const [error, setError] = useState<unknown>(null);
  const seq = useRef<Record<ClubKey, number>>({ overlayTemplate: 0, overlayDelayMs: 0 });
  const save = <K extends ClubKey>(key: K, value: ClubStreamPrefs[K]) => {
    const n = ++seq.current[key];
    setPending((p) => ({ ...p, [key]: { value } }));
    setError(null);
    const settle = () => setPending((p) => (seq.current[key] === n ? { ...p, [key]: undefined } : p));
    void apiV1<ClubStreamPrefsRead>(`/api/v1/orgs/${orgId}/stream-defaults`, { method: "PUT", json: { [key]: value } }).then(
      (answer) => {
        setKnown((k) => ((answer.revision ?? Number.NEGATIVE_INFINITY) >= (k.revision ?? Number.NEGATIVE_INFINITY) ? answer : k));
        settle();
      },
      (err: unknown) => {
        // An overtaken save that fails says nothing: the newer choice is the one on screen and in flight.
        if (seq.current[key] === n) setError(err);
        settle();
      },
    );
  };
  const shown: ClubStreamPrefs = {
    overlayTemplate: pending.overlayTemplate ? pending.overlayTemplate.value : known.overlayTemplate,
    overlayDelayMs: pending.overlayDelayMs ? pending.overlayDelayMs.value : known.overlayDelayMs,
  };
  return { shown, save, error };
}

export function StreamClubScore(p: {
  orgId: string;
  /** Owner or admin — the route's write gate. Anyone else reads the club's choice in words. */
  canEdit: boolean;
  /** The org's stored defaults (`orgStreamDefaultsOf`). */
  stored: ClubStreamPrefsRead;
  /** config.ts `overlayDelayDefaultMs(false)` — the delay a match stream serves when nothing sets one; never typed here. */
  defaultMs: number;
  /** config.ts `overlayDelayDefaultMs(true)` — the delay a court stream serves (it never takes the club's timing); named in the scope line. */
  courtDefaultMs: number;
  /** The club's own sports to preview, by name; one entry draws no switch (server/stream-club-score.ts). */
  sports: { key: string; name: string }[];
  /** Each sport's live-play snapshot, keyed by sport key. */
  snapshots: Record<string, OverlayLiveData>;
  sides: [OverlaySideInput, OverlaySideInput];
  /** The `overlay.*` slice of the public dictionary (lib/overlay-dict.ts). */
  overlayDict: Record<string, string>;
}) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const { shown, save, error } = useClubPrefs(p.orgId, p.stored);
  const [sportKey, setSportKey] = useState(p.sports[0]!.key);
  // The sport the previews draw: the chosen chip, or — if the list moved under it — the first.
  const previewSport = p.sports.some((s) => s.key === sportKey) ? sportKey : p.sports[0]!.key;
  const themes = templatesForSport(previewSport);
  // The picker's selection: the club's choice as THIS sport resolves it (a template a sport does not suit reads as the sport's own), or
  // NONE while the club sets none — each sport then uses its own, and every option is offered, including the sport's default.
  const selected: TemplateId | null = shown.overlayTemplate === null ? null : resolveTemplate(shown.overlayTemplate, previewSport).id;
  const preview: TemplatePreviewData = {
    sportKey: previewSport,
    snapshot: p.snapshots[previewSport]!,
    sides: p.sides,
    startLabel: null,
    dict: p.overlayDict,
    decidedTemplates: decidedOutcomeTemplates(msg, previewSport),
  };
  // A stored id this sport cannot show: not in its picker, and not a retired id that resolves to a replacement. The picker then stands on the
  // sport's own style (resolveTemplate's fallback), so the screen says so rather than disagree with what is stored.
  const stored = shown.overlayTemplate;
  const storedDef = stored !== null && Object.hasOwn(OVERLAY_TEMPLATES, stored) ? OVERLAY_TEMPLATES[stored as TemplateId] : undefined;
  const unavailableHere = stored !== null && storedDef?.retired === undefined && !themes.some((t) => t.id === stored);
  const headingId = "club-score-heading";
  const effectiveDelay = shown.overlayDelayMs ?? p.defaultMs;
  return (
    <section data-testid="club-score" aria-labelledby={headingId} className="space-y-4 pt-4">
      <div>
        <h2 id={headingId} className="flex items-center gap-3 text-sm font-semibold text-slate-700 after:h-px after:flex-1 after:bg-slate-200 after:content-['']">
          {msg("streaming.club.heading")}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{msg("streaming.club.sub")}</p>
      </div>
      <div className="card min-w-0 space-y-4 p-4 md:p-5">
        {p.canEdit ? (
          <>
            {p.sports.length > 1 && (
              <div className="flex min-w-0 flex-col gap-1 md:flex-row md:items-center md:gap-3">
                <span id="club-score-sports-label" className="text-xs text-slate-600">{msg("streaming.club.previewAs")}</span>
                <div role="radiogroup" aria-labelledby="club-score-sports-label" data-testid="club-score-sports" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 md:w-fit">
                  {p.sports.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      role="radio"
                      aria-checked={previewSport === s.key}
                      data-testid={`club-score-sport-${s.key}`}
                      onClick={() => setSportKey(s.key)}
                      className={`min-h-11 min-w-11 rounded-md px-3 text-xs font-medium leading-tight md:min-h-9 ${
                        previewSport === s.key ? "bg-white text-purple-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <StreamTemplatePicker
              templates={themes}
              selected={selected}
              onPick={(id) => save("overlayTemplate", id)}
              preview={preview}
              idPrefix="club-score"
              saveFailed={false}
              note={msg("streaming.club.style.sub")}
            />
            {unavailableHere && (
              <p data-testid="club-score-style-unavailable" className="text-xs text-amber-800">
                {msg("streaming.club.style.unavailable", { style: stored, sport: p.sports.find((x) => x.key === previewSport)!.name })}
              </p>
            )}
            {shown.overlayTemplate === null ? (
              <p data-testid="club-score-style-none" className="text-xs text-slate-600">{msg("streaming.club.style.none")}</p>
            ) : (
              <button
                type="button"
                data-testid="club-score-style-reset"
                onClick={() => save("overlayTemplate", null)}
                className="inline-flex min-h-11 items-center text-sm font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700 md:min-h-9"
              >
                {msg("streaming.club.style.reset")}
              </button>
            )}
            <div className="border-t border-purple-100 pt-1">
              <ScoreTiming
                idPrefix="club-timing"
                storedMs={shown.overlayDelayMs}
                defaultMs={p.defaultMs}
                onSave={(ms) => save("overlayDelayMs", ms)}
                saveFailed={false}
              />
            </div>
            {error !== null && (
              <p data-testid="club-score-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {clubErrorText(msg, error)}
              </p>
            )}
          </>
        ) : (
          // The same facts in words, no controls: a member who cannot edit still learns what the club's streams will look like.
          <dl data-testid="club-score-readonly" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="font-medium text-slate-800">{msg("stream.template.title")}</dt>
            <dd data-testid="club-score-readonly-style" className="min-w-0 text-right text-slate-700">
              {shown.overlayTemplate === null ? msg("streaming.club.style.none.short") : msg(resolveTemplate(shown.overlayTemplate, previewSport).labelKey as MessageKey)}
            </dd>
            <dt className="font-medium text-slate-800">{msg("stream.timing.title")}</dt>
            <dd data-testid="club-score-readonly-timing" className="text-right tabular-nums text-slate-700">
              {msg("stream.timing.value", { seconds: fmtDelaySeconds(locale, effectiveDelay) })}
              {shown.overlayDelayMs === null && <span className="ml-1.5 text-xs text-slate-600">{msg("stream.timing.default")}</span>}
            </dd>
          </dl>
        )}
        <p data-testid="club-score-scope" className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[12.5px] text-slate-600">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" strokeWidth={1.8} />
          <span>
            <b className="font-semibold text-slate-700">{msg("streaming.club.scope.new")}</b> {msg("streaming.club.scope.rest", { seconds: fmtDelaySeconds(locale, p.courtDefaultMs) })}
          </span>
        </p>
      </div>
    </section>
  );
}
