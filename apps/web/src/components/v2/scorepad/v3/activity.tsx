// R2 gap found at sign-off review (2026-08-17): flipping cricket onto the v3
// lane silently DROPPED the legacy pad's event history.
//
// `pad-renderer.tsx` (the legacy renderer, still serving the other 10 sports)
// mounts `<Timeline>` INSIDE the pad, so it appeared on the device-link
// surface too. That component did two jobs, not one:
//
//   1. listed every recorded event (timeline.tsx:251 renders `events.length`);
//   2. let a scorer VOID a past event — and on a device link, specifically
//      their OWN events (pad-renderer.tsx:244's own comment).
//
// `PadHostV3` shipped with neither: its ribbon is built from `latestEvent`
// alone (pad-host.tsx) and its single undo call site passes `latestEvent.id`.
// The normal in-app surface still has `FixtureConsole`'s "Event ledger"
// section to fall back on, but the device-link route (`/score/[token]` ->
// `DeviceScorePad`) mounts NO console chrome, so for cricket the correction
// path disappeared entirely once the ~6s soft-commit hold window elapsed.
//
// This panel restores that capability on the chassis, for every skin — not
// just cricket — so R3-R6 do not each inherit the same hole.
//
// The void RULES are ported from `timeline.tsx:258-261` verbatim rather than
// re-derived, because two of them are not obvious and getting either wrong
// over-grants a destructive action:
//
//   - "voided" is derived by looking for some OTHER event pointing back at
//     this one (`voids === id`), never stored on the target itself;
//   - a `core.void` event is itself never voidable (no un-voiding).
//
// Captions reuse `buildRibbon`, the SAME builder the ribbon already uses, so
// the panel cannot drift into a second event vocabulary — the standing
// programme ruling (no second vocabulary, v2 S2/#430).
import type { ReactNode } from "react";
import { buildRibbon, type MsgFn } from "./ribbon";

/** The subset of the pipeline's event envelope this panel reads. Deliberately
 *  structural rather than importing `EventEnvelope`: the panel needs four
 *  fields and nothing else, and a narrower prop keeps it testable without
 *  constructing a full envelope. */
export interface ActivityEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  /** Set only when THIS event IS a void — the id of the event it cancels. */
  readonly voids: string | null;
}

export interface ActivityRowState {
  readonly voided: boolean;
  readonly ownedByMe: boolean;
  readonly canVoid: boolean;
}

/**
 * Ported from `timeline.tsx:259-261`.
 *
 * `deviceLinkId === null` means "not a device link" — the in-app console
 * scorer, who may void anything. A device link may void ONLY events it
 * recorded itself, which is why `ownEventIds` (the pipeline's own set of
 * locally-submitted ids) is the authority here and not `recordedBy`: a
 * device link has no user identity to compare against.
 */
export function activityRowState(
  event: ActivityEvent,
  all: readonly ActivityEvent[],
  ownEventIds: ReadonlySet<string>,
  deviceLinkId: string | null,
  voidingEnabled: boolean,
): ActivityRowState {
  const voided = all.some((v) => v.voids === event.id);
  const ownedByMe = deviceLinkId === null || ownEventIds.has(event.id);
  return {
    voided,
    ownedByMe,
    canVoid: voidingEnabled && !voided && event.type !== "core.void" && ownedByMe,
  };
}

/** Newest first — `pipeline.events` arrives oldest-first (types.ts says so),
 *  and a scorer correcting a mistake wants the most recent ball at the top,
 *  not after scrolling past the whole innings. Copies before reversing:
 *  `pipeline.events` is the live list, and reversing it in place would
 *  scramble every other consumer's idea of "latest". */
export function orderedActivity(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].reverse();
}

/** The panel scrolls internally past this many rows instead of growing the
 *  page. Matches the legacy `max-h-96` cap (timeline.tsx:257) — about six
 *  rows at the daylight shell's row height, which is roughly one over of
 *  cricket, so a scorer sees the current over without scrolling at all. */
export const ACTIVITY_SCROLL_AFTER_ROWS = 6;

export interface ActivityPanelProps {
  events: readonly ActivityEvent[];
  ownEventIds: ReadonlySet<string>;
  deviceLinkId: string | null;
  personNames: Readonly<Record<string, string>>;
  t: MsgFn;
  /** Omitted on a read-only surface; its absence disables every void
   *  control, which `activityRowState` folds in as `voidingEnabled`. */
  onVoid?: (eventId: string) => void;
  voidingId?: string | null;
}

export function ActivityPanel({
  events,
  ownEventIds,
  deviceLinkId,
  personNames,
  t,
  onVoid,
  voidingId = null,
}: ActivityPanelProps): ReactNode {
  const rows = orderedActivity(events);
  const nameOf = (id: string) => personNames[id] ?? id;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white" data-role="v3-activity">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{t("pad.activity.heading")}</h2>
        <span className="text-sm font-medium text-slate-600 tabular-nums" data-role="v3-activity-count">
          {events.length}
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-600">{t("pad.activity.empty")}</p>
      ) : (
        // max-h-96 + overflow-y-auto: the panel scrolls INSIDE itself past
        // ACTIVITY_SCROLL_AFTER_ROWS rows so a long innings never grows the
        // page. `overscroll-contain` stops a flick at the list's end from
        // scrolling the page behind it, which on a phone reads as the pad
        // jumping while a scorer is reviewing.
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto overscroll-contain" data-role="v3-activity-list">
          {rows.map((event) => {
            const { voided, canVoid } = activityRowState(event, events, ownEventIds, deviceLinkId, !!onVoid);
            const caption = buildRibbon(event.type, (event.payload ?? {}) as Record<string, unknown>, nameOf, t);
            return (
              <li
                key={event.id}
                className="flex items-center gap-3 px-4 py-2"
                data-role="v3-activity-row"
                data-voided={voided}
              >
                <span
                  className={`min-w-0 flex-1 break-words text-sm ${voided ? "text-slate-400 line-through" : "text-slate-700"}`}
                >
                  {caption.text}
                </span>
                {canVoid ? (
                  <button
                    type="button"
                    onClick={() => onVoid?.(event.id)}
                    disabled={voidingId === event.id}
                    data-role="v3-activity-void"
                    className="min-h-11 shrink-0 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                  >
                    {voidingId === event.id ? t("pad.activity.voiding") : t("pad.activity.void")}
                  </button>
                ) : voided ? (
                  <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">
                    {t("pad.activity.voided")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
