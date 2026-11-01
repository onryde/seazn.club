"use client";
// The Sponsors hub's On stream tab (R4 sponsors on stream, S12; spec 2026-10-27 §5.1). One page, top to bottom:
//   scope picker -> rotation (switch, Light/Normal/Busy dial, where it shows) -> who is in it (the tick list) -> a preview strip
//   per sport the scope plays.
//
// What it writes, and where:
//   - a tick       PATCH /orgs/{id}/sponsors/{sponsorId}            { on_stream }   (the FIRST tick also creates the org's row,
//                                                                    enabled at Normal: R12, done by the route's transaction)
//   - switch/dial  PUT   /orgs/{id}/sponsor-stream-settings         { competitionId, enabled, frequency }
// Both are editor-only (R19): the hub never mounts this for anyone else, and the routes refuse them anyway.
//
// The server's truth arrives as props. A click shows its result at once (an override), the write goes out, and `router.refresh()`
// brings the new props - at which point the override is dropped (the render-phase reset below), so what stays on screen is
// always the server's, and a failed write puts the old value back and says so.
//
// The preview is not a table of numbers someone typed: the server hands over the breaks of the org's latest FINISHED match of
// each sport (a real ledger, folded by the real engine) and `previewForSport` runs the overlay's own planner over them, live, at
// the dial position on screen (ruling R11). A sport with no finished match shows which breaks it has (the engine's declaration),
// and a sport with none (generic) says sponsors appear on scene screens.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import Link from "@/components/ui/console-link";
import { TIER_BADGE, TIER_MSG } from "@/components/sponsors/tier-labels";
import { sportLabel } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
import { SPONSOR_FREQUENCIES, SPONSOR_STYLE_BY_SIZE, sponsorMomentId, type SponsorCard, type SponsorFrequency } from "@/lib/sponsor-plan";
import { previewForSport, type SportPreviewSource } from "@/lib/sponsor-preview";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import { onStreamHref, sponsorsHref } from "@/lib/sponsors-hub";

/** The dial's default when a scope has no row (D12) - and the position a first tick switches the rotation on at (R12). */
export const DEFAULT_FREQUENCY: SponsorFrequency = "normal";

/** Typed key maps: the i18n house rule bans dynamic `msg()` keys. */
export const FREQ_MSG: Record<SponsorFrequency, MessageKey> = {
  light: "sponsors.onStream.freq.light",
  normal: "sponsors.onStream.freq.normal",
  busy: "sponsors.onStream.freq.busy",
};
const FREQ_HINT_MSG: Record<SponsorFrequency, MessageKey> = {
  light: "sponsors.onStream.freqHint.light",
  normal: "sponsors.onStream.freqHint.normal",
  busy: "sponsors.onStream.freqHint.busy",
};
/** One label per break kind the engine declares (swept against `builtinModules` in the component test). */
export const BREAK_MSG: Record<string, MessageKey> = {
  half_time: "sponsors.onStream.break.half_time",
  period_end: "sponsors.onStream.break.period_end",
  shootout_break: "sponsors.onStream.break.shootout_break",
  after_goal: "sponsors.onStream.break.after_goal",
  over_end: "sponsors.onStream.break.over_end",
  innings_break: "sponsors.onStream.break.innings_break",
  set_end: "sponsors.onStream.break.set_end",
  timeout: "sponsors.onStream.break.timeout",
  game_end: "sponsors.onStream.break.game_end",
  interval: "sponsors.onStream.break.interval",
  changeover: "sponsors.onStream.break.changeover",
  quarter_end: "sponsors.onStream.break.quarter_end",
};

export interface OnStreamSponsor {
  id: string;
  name: string;
  tier: SponsorTier;
  status: string;
  competition_id: string | null;
  on_stream: boolean;
}

export interface OnStreamTabProps {
  orgId: string;
  orgSlug: string;
  sponsors: OnStreamSponsor[];
  competitions: { id: string; name: string }[];
  /** The competition whose setting is on screen; null = the organisation-wide one. */
  scope: string | null;
  /** Does the org's plan carry sponsor tiers? Without them every sponsor is a partner, as the public board shows them. */
  hasTiers: boolean;
  /** The settings IN FORCE for the scope (the resolver's answer: the scope's row, else the org's), or null with none. */
  settings: { enabled: boolean; frequency: SponsorFrequency } | null;
  /** The scope has a row of its own. */
  ownRow: boolean;
  sports: SportPreviewSource[];
}

/** Sponsors the scope's rotation can draw on: the organisation-wide ones, plus the competition's own in a competition scope. */
export function sponsorsInScope(sponsors: readonly OnStreamSponsor[], scope: string | null): OnStreamSponsor[] {
  return scope === null ? [...sponsors] : sponsors.filter((s) => s.competition_id === null || s.competition_id === scope);
}

/** The cards the rotation would draw on: ticked and ACTIVE (a parked or inactive sponsor never airs - card-source.ts). */
export function previewCards(sponsors: readonly OnStreamSponsor[], hasTiers: boolean): SponsorCard[] {
  return sponsors
    .filter((s) => s.on_stream && s.status === "active")
    .map((s) => ({ id: s.id, sponsorId: s.id, name: s.name, logoUrl: null, tier: hasTiers ? s.tier : "partner", onStream: true }));
}

async function send(url: string, method: "PATCH" | "PUT", body: unknown, fallback: string): Promise<void> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return;
  const data = (await res.json().catch(() => ({}))) as { error?: string | { message?: string } };
  const message = typeof data.error === "string" ? data.error : data.error?.message;
  throw new Error(message ?? fallback);
}

export function OnStreamTab(props: OnStreamTabProps) {
  const { orgId, orgSlug, sponsors, competitions, scope, hasTiers, settings, ownRow, sports } = props;
  const msg = useMsg();
  const router = useRouter();

  // Overrides: a click's result, shown until the server's props catch up. Dropped when the server sends new props (the
  // sanctioned "adjust state when a prop changes" pattern, never an effect).
  const [seen, setSeen] = useState({ sponsors, settings });
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [dial, setDial] = useState<SponsorFrequency | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  if (seen.sponsors !== sponsors || seen.settings !== settings) {
    setSeen({ sponsors, settings });
    setTicks({});
    setDial(null);
    setEnabled(null);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withTicks = useMemo(() => sponsors.map((s) => ({ ...s, on_stream: ticks[s.id] ?? s.on_stream })), [sponsors, ticks]);
  const inScope = useMemo(() => sponsorsInScope(withTicks, scope), [withTicks, scope]);
  const frequency = dial ?? settings?.frequency ?? DEFAULT_FREQUENCY;
  const on = enabled ?? settings?.enabled ?? false;
  const cards = useMemo(() => previewCards(inScope, hasTiers), [inScope, hasTiers]);
  const msgPlural = useMsgPlural();

  async function write(fn: () => Promise<void>, undo: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (err) {
      undo();
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function tick(sponsor: OnStreamSponsor, next: boolean) {
    setTicks((t) => ({ ...t, [sponsor.id]: next }));
    void write(
      () => send(`/api/v1/orgs/${orgId}/sponsors/${sponsor.id}`, "PATCH", { on_stream: next }, msg("settings.saveFailed")),
      () => setTicks((t) => ({ ...t, [sponsor.id]: !next })),
    );
  }

  function saveSettings(next: { enabled: boolean; frequency: SponsorFrequency }) {
    const before = { enabled, dial };
    setEnabled(next.enabled);
    setDial(next.frequency);
    void write(
      () => send(`/api/v1/orgs/${orgId}/sponsor-stream-settings`, "PUT", { competitionId: scope, ...next }, msg("settings.saveFailed")),
      () => {
        setEnabled(before.enabled);
        setDial(before.dial);
      },
    );
  }

  const minorSeconds = SPONSOR_STYLE_BY_SIZE.minor.holdMs / 1000;
  const majorSeconds = SPONSOR_STYLE_BY_SIZE.major.holdMs / 1000;

  return (
    <div className="grid min-w-0 gap-6" data-testid="on-stream-tab">
      {competitions.length > 0 && (
        <div className="grid min-w-0 gap-1.5">
          <label htmlFor="on-stream-scope" className="text-sm font-medium text-slate-700">
            {msg("sponsors.onStream.scopeLabel")}
          </label>
          <select
            id="on-stream-scope"
            data-testid="on-stream-scope"
            className="select w-full min-w-0 sm:max-w-xs"
            value={scope ?? ""}
            onChange={(e) => router.push(onStreamHref(orgSlug, e.target.value || null))}
          >
            <option value="">{msg("sponsors.onStream.scopeOrg")}</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {scope !== null && !ownRow && (
            <p className="text-xs text-slate-500" data-testid="on-stream-inherited">
              {msg("sponsors.onStream.scopeInherited")}
            </p>
          )}
        </div>
      )}

      {error !== null && (
        <p role="alert" data-testid="on-stream-error" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <section className="grid min-w-0 gap-4" aria-labelledby="on-stream-rotation">
        <h3 id="on-stream-rotation" className="text-sm font-semibold text-slate-800">
          {msg("sponsors.onStream.rotation")}
        </h3>

        <div className="flex min-w-0 items-center justify-between gap-3">
          <span id="on-stream-switch-label" className="min-w-0 text-sm text-slate-700">
            {msg("sponsors.onStream.switchLabel")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-labelledby="on-stream-switch-label"
            data-testid="on-stream-switch"
            disabled={busy}
            onClick={() => saveSettings({ enabled: !on, frequency })}
            className={`relative inline-flex h-11 w-14 shrink-0 items-center rounded-full transition disabled:opacity-60 ${on ? "bg-purple-600" : "bg-slate-300"}`}
          >
            <span
              aria-hidden="true"
              className={`absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-white shadow transition-all ${on ? "left-[calc(100%-1.75rem)]" : "left-1"}`}
            />
          </button>
        </div>
        {!on && (
          <p className="text-xs text-slate-500" data-testid="on-stream-off-note">
            {settings !== null
              ? msg("sponsors.onStream.offPaused")
              : scope === null
                ? msg("sponsors.onStream.offNoRow")
                : msg("sponsors.onStream.offNoRowCompetition")}
          </p>
        )}

        <div className="grid min-w-0 gap-2">
          <span id="on-stream-dial-label" className="text-sm font-medium text-slate-700">
            {msg("sponsors.onStream.dialLabel")}
          </span>
          <div role="radiogroup" aria-labelledby="on-stream-dial-label" className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            {SPONSOR_FREQUENCIES.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={f === frequency}
                data-testid={`on-stream-dial-${f}`}
                disabled={busy}
                onClick={() => f !== frequency && saveSettings({ enabled: settings === null ? true : on, frequency: f })}
                className={`min-h-11 min-w-0 truncate rounded-lg px-2 text-sm font-medium transition disabled:opacity-60 ${
                  f === frequency ? "bg-white text-purple-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {msg(FREQ_MSG[f])}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500" data-testid="on-stream-dial-hint">
            {msg(FREQ_HINT_MSG[frequency])}
          </p>
        </div>

        <div className="grid min-w-0 gap-1">
          <span className="text-sm font-medium text-slate-700">{msg("sponsors.onStream.whereLabel")}</span>
          <p className="text-sm text-slate-600" data-testid="on-stream-where">
            {msg("sponsors.onStream.whereBody", { minor: minorSeconds, major: majorSeconds })}
          </p>
        </div>
      </section>

      <section className="grid min-w-0 gap-2" aria-labelledby="on-stream-checklist">
        <h3 id="on-stream-checklist" className="text-sm font-semibold text-slate-800">
          {msg("sponsors.onStream.checklistTitle")}
        </h3>
        {inScope.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="on-stream-checklist-empty">
            {msg("sponsors.onStream.checklistEmpty")}{" "}
            <Link href={sponsorsHref(orgSlug, "sponsors")} className="font-medium text-purple-700 underline">
              {msg("sponsors.onStream.checklistEmptyLink")}
            </Link>
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500" data-testid="on-stream-checklist-help">
              {msg("sponsors.onStream.checklistHelp")}
              {hasTiers && ` ${msg("sponsors.onStream.checklistTiersNote")}`}
            </p>
            <ul className="grid min-w-0 divide-y divide-slate-100 rounded-xl border border-slate-200">
              {inScope.map((s) => {
                const parked = s.status !== "active";
                return (
                  <li key={s.id} data-testid={`on-stream-sponsor-${s.id}`} className="min-w-0">
                    <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-5 w-5 shrink-0 accent-purple-600"
                        data-testid={`on-stream-tick-${s.id}`}
                        aria-label={msg("sponsors.onStream.tickLabel", { name: s.name })}
                        checked={s.on_stream}
                        disabled={busy || (parked && !s.on_stream)}
                        onChange={(e) => tick(s, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{s.name}</span>
                      {parked && <span className="shrink-0 text-xs text-slate-500">{msg("sponsors.onStream.notActive")}</span>}
                      {hasTiers && (
                        <span
                          data-testid={`on-stream-tier-${s.id}`}
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${TIER_BADGE[s.tier]}`}
                        >
                          {msg(TIER_MSG[s.tier])}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="grid min-w-0 gap-3" aria-labelledby="on-stream-preview">
        <h3 id="on-stream-preview" className="text-sm font-semibold text-slate-800">
          {msg("sponsors.onStream.previewTitle")}
        </h3>
        {!on && (
          <p className="text-xs text-slate-500" data-testid="on-stream-preview-off">
            {msg("sponsors.onStream.previewOff")}
          </p>
        )}
        {cards.length === 0 && (
          <p className="text-xs text-slate-500" data-testid="on-stream-preview-noticks">
            {msg("sponsors.onStream.previewNoTicks")}
          </p>
        )}
        {sports.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="on-stream-preview-nosports">
            {msg("sponsors.onStream.previewNoSports")}
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500">{msg("sponsors.onStream.previewLegend")}</p>
            <ul className="grid min-w-0 gap-3">
              {sports.map((src) =>
                // The cards the OVERLAY would draw on for the sample's fixture: the org-wide sponsors plus that fixture's own
                // competition's (card-source.ts) - never another competition's, whatever the picker shows.
                renderSportPreview({
                  src,
                  frequency,
                  cards: previewCards(sponsorsInScope(withTicks, src.sampleCompetitionId ?? scope), hasTiers),
                  msg,
                  msgPlural,
                }),
              )}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** One sport's row. Called as a plain function, not mounted as a component: its copy functions come in, so the tab renders (and
 *  its test walks) as one tree. `previewForSport` is cheap - one planner call per break of a single match. */
function renderSportPreview({
  src,
  frequency,
  cards,
  msg,
  msgPlural,
}: {
  src: SportPreviewSource;
  frequency: SponsorFrequency;
  cards: readonly SponsorCard[];
  msg: ReturnType<typeof useMsg>;
  msgPlural: ReturnType<typeof useMsgPlural>;
}) {
  const sport = sportLabel(src.sportKey, msg);
  const { kinds, sample } = src;
  const preview = sample === null ? null : previewForSport(frequency, sample, cards);
  const label = (kind: string) => (kind in BREAK_MSG ? msg(BREAK_MSG[kind]!) : kind);
  const kindsOf = (size: "major" | "minor") => (kinds ?? []).filter((k) => k.size === size).map((k) => label(k.kind)).join(", ");

  return (
    <li key={src.sportKey} className="grid min-w-0 gap-1.5 rounded-xl border border-slate-200 p-3" data-testid={`on-stream-preview-${src.sportKey}`}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 truncate text-sm font-medium text-slate-800">{sport}</span>
        {preview !== null && (
          <span className="text-xs font-medium text-purple-700" data-testid={`on-stream-preview-count-${src.sportKey}`}>
            {msgPlural("sponsors.onStream.previewCards", preview.cards)}
          </span>
        )}
      </div>
      {kinds === null ? (
        <p className="text-xs text-slate-500" data-testid={`on-stream-preview-scene-${src.sportKey}`}>
          {msg("sponsors.onStream.previewSceneOnly")}
        </p>
      ) : sample === null || preview === null ? (
        <div className="grid gap-0.5 text-xs text-slate-500" data-testid={`on-stream-preview-kinds-${src.sportKey}`}>
          <p>{msg("sponsors.onStream.previewNoMatch", { sport })}</p>
          {kindsOf("major") !== "" && <p>{msg("sponsors.onStream.previewKindsMajor", { kinds: kindsOf("major") })}</p>}
          {kindsOf("minor") !== "" && <p>{msg("sponsors.onStream.previewKindsMinor", { kinds: kindsOf("minor") })}</p>}
        </div>
      ) : (
        <div
          role="img"
          aria-label={msg("sponsors.onStream.previewStripLabel", { sport, breaks: sample.length, cards: preview.cards })}
          data-testid={`on-stream-strip-${src.sportKey}`}
          className="flex h-8 min-w-0 items-end gap-px overflow-hidden rounded-md bg-slate-50 px-1"
        >
          {sample.map((b) => {
            const aired = preview.aired.includes(sponsorMomentId(b.seq, b.kind));
            return (
              <span
                key={`${b.seq}:${b.kind}`}
                data-size={b.size}
                data-aired={aired ? "true" : "false"}
                className={`min-w-0 flex-1 rounded-sm ${b.size === "major" ? "h-full" : "h-1/2"} ${aired ? "bg-purple-600" : "bg-slate-300"}`}
              />
            );
          })}
        </div>
      )}
    </li>
  );
}
