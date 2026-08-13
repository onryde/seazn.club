"use client";
// The pad's persistent activity feed (S10/#419 W8, chassis item 3) — built
// to be handed, as-is, to pad-renderer.tsx's `timelineSlot` typed seam
// (`{props.timelineSlot}`, rendered verbatim — pad-renderer.test.tsx's own
// "timeline seam" describe block already proves that passthrough; nothing
// here changes it). No route mounts this yet (same "no routes this pass"
// boundary the renderer pass itself documented) — a future page supplies
// `events` from `GET /api/v1/fixtures/{id}/events` and wires `onVoid` to a
// `core.void` submit.
//
// DELIBERATELY MIRRORS fixture-console.tsx's established v1 activity feed
// rather than reinventing one: newest-first display, a `voids_event_id`
// cross-reference to derive "voided" (no server round trip — any OTHER
// event in the same list naming this one's id via `voids_event_id` marks
// it), struck-through-but-still-rendered for a voided row, and reusing
// `describeEvent` (event-copy.ts) for the caption so v2 never grows a
// second, independently-drifting sentence for one event type.
//
// TimelineEvent mirrors server/usecases/fixtures.ts's `EventOut` /
// fixture-console.tsx's own `EventIn` field-for-field (snake_case kept
// verbatim, matching this chassis's own `LedgerSlotEvent` in types.ts) —
// so a future page can hand this list through with the least mapping.
//
// PER-EVENT ATTRIBUTION is a second, separate line from describeEvent's own
// sentence, not a replacement for it: describeEvent's `scalars()` fallback
// explicitly SKIPS uuid-looking values (so e.g. cricket.toss's `wonBy` — an
// EntrantId — never appears in its text at all), and it has no case for
// PadAttributionItem.labelKey (S7/#427's `padLabel` vocabulary) in the
// first place. `attributionByType` is optional, best-effort enrichment:
// absent, every row still renders describeEvent's own caption in full.
import type { ReactNode } from "react";
import { ClientTime } from "@/components/client-time";
import { useMsg } from "@/components/i18n/dict-provider";
import { describeEvent, EVENT_TONE_STYLE } from "@/lib/event-copy";
import type { MsgFn } from "@/lib/scoring-vocab";
import { resolvePayloadPath } from "@seazn/engine/stats";
import type { PadAttribution } from "@seazn/engine/sport";
import { attributionItemCaption } from "./attribution-picker";

/** Mirrors server/usecases/fixtures.ts's `EventOut` / fixture-console.tsx's
 *  `EventIn` — see the module header for why the field names stay
 *  snake_case rather than the chassis's usual camelCase. */
export interface TimelineEvent {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by: string | null;
  device_link_id: string | null;
  /** Set only when THIS event IS a `core.void` — the id of the event it
   *  cancels. A DIFFERENT event's row is "voided" when some OTHER event in
   *  the list carries this pointing back at it — derived per row below,
   *  never stored redundantly on the target itself. */
  voids_event_id: string | null;
}

export interface TimelineProps {
  /** Oldest-first, e.g. straight off `GET /events?since_seq=0` — reversed
   *  for display (newest activity at the top), matching fixture-console.tsx. */
  events: readonly TimelineEvent[];
  /** recorded_by -> display name (pad-context.tsx's own `recorderNames` shape). */
  recorderNames?: Readonly<Record<string, string>>;
  /** personId -> display name, for a `kind:"person"` attribution value —
   *  the SAME map attribution-picker.tsx takes. */
  personNames?: Readonly<Record<string, string>>;
  /** Event type -> its PadAction's own attribution declarations (e.g. a
   *  module's `padSpec(cfg)`, keyed by `PadAction.type`) — optional,
   *  best-effort enrichment; see the module header. */
  attributionByType?: Readonly<Record<string, PadAttribution>>;
  /** The two side entrant ids, so a `kind:"side"` attribution value (a REAL
   *  EntrantId, never the literal "home"/"away" — see attribution-picker.tsx)
   *  renders as "Home"/"Away" instead of a raw id. */
  homeEntrantId?: string;
  awayEntrantId?: string;
  /** This viewer's own device-link id, if scoring from a linked device — a
   *  device link may only undo ITS OWN events (scoring.ts's own
   *  `assertEntitledToScore` rule, mirrored here so the control never
   *  appears where the server would 403 it). `null`/absent means a signed-
   *  in human, who may undo anything undoable. */
  deviceLinkId?: string | null;
  /** Fires a `core.void` submit for the given event id. Absent -> read-only
   *  timeline, no undo control rendered anywhere. */
  onVoid?: (eventId: string) => void;
  /** The event id currently mid-void, if any — disables just that row's
   *  control so a slow network can't double-fire it. */
  voidingId?: string | null;
}

const EMPTY_NAMES = {};
const EMPTY_ATTRIBUTION_MAP = {};

function recorderText(
  event: TimelineEvent,
  recorderNames: Readonly<Record<string, string>>,
  msg: MsgFn,
): string | null {
  if (event.device_link_id) return msg("scorepad.timeline.devicePad");
  if (event.recorded_by) return recorderNames[event.recorded_by] ?? msg("scorepad.timeline.unknownRecorder");
  return null;
}

function personOrSideText(
  item: { kind: "side" | "person" },
  raw: unknown,
  personNames: Readonly<Record<string, string>>,
  homeEntrantId: string | undefined,
  awayEntrantId: string | undefined,
  msg: MsgFn,
): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (item.kind === "side") {
    if (raw === homeEntrantId) return msg("scorepad.attribution.home");
    if (raw === awayEntrantId) return msg("scorepad.attribution.away");
    return raw;
  }
  return personNames[raw] ?? msg("eventCopy.unknownPerson");
}

/** The optional secondary line: each declared attribution item this event's
 *  type has, resolved from the raw payload via the SAME dotted-path reader
 *  the engine's own gates/stats use (`resolvePayloadPath`), captioned via
 *  `attributionItemCaption` (shared with attribution-picker.tsx so a
 *  "Fielder assist" reads identically whether it is being picked or
 *  reviewed). Items whose value is absent from the payload are skipped —
 *  several are legitimately optional (a wicket with no named fielder). */
function attributionLine(
  type: string,
  payload: unknown,
  attributionByType: Readonly<Record<string, PadAttribution>>,
  personNames: Readonly<Record<string, string>>,
  homeEntrantId: string | undefined,
  awayEntrantId: string | undefined,
  msg: MsgFn,
): string {
  const attribution = attributionByType[type];
  if (!attribution || attribution.length === 0) return "";
  const root = (payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  attribution.forEach((item, index) => {
    const raw = resolvePayloadPath(root, item.path);
    const value = personOrSideText(item, raw, personNames, homeEntrantId, awayEntrantId, msg);
    if (value === null) return;
    parts.push(`${attributionItemCaption(item, index, msg)}: ${value}`);
  });
  return parts.join(" · ");
}

/** A plain function, not a JSX-invoked component — same reason as
 *  action-form.tsx's `renderField`/attribution-picker.tsx's own row
 *  renderer: this repo's node-only `_hook-harness` never invokes a nested
 *  custom component's body, so the void button and provenance text must
 *  land FLAT in Timeline's own returned tree to be reachable by `walk()`. */
function renderRow(
  event: TimelineEvent,
  voided: boolean,
  canVoid: boolean,
  voidingId: string | null | undefined,
  onVoid: ((id: string) => void) | undefined,
  recorderNames: Readonly<Record<string, string>>,
  personNames: Readonly<Record<string, string>>,
  attributionByType: Readonly<Record<string, PadAttribution>>,
  homeEntrantId: string | undefined,
  awayEntrantId: string | undefined,
  msg: MsgFn,
): ReactNode {
  // describeEvent's own `names` argument doubles as an entrant lookup for
  // whichever payload field happens to hold one (e.g. a result's winner) —
  // folding the two known entrant ids in here means EVERY name resolution
  // inside describeEvent benefits from "Home"/"Away", not only the
  // attribution breakdown below.
  const namesForDescribe: Record<string, string> = { ...personNames };
  if (homeEntrantId) namesForDescribe[homeEntrantId] = msg("scorepad.attribution.home");
  if (awayEntrantId) namesForDescribe[awayEntrantId] = msg("scorepad.attribution.away");

  const desc = describeEvent(event.type, event.payload, namesForDescribe, msg);
  const recorder = recorderText(event, recorderNames, msg);
  const attrLine = attributionLine(event.type, event.payload, attributionByType, personNames, homeEntrantId, awayEntrantId, msg);

  return (
    <li
      key={event.id}
      data-event-id={event.id}
      data-voided={voided}
      className={`flex flex-col gap-1 px-4 py-2 text-xs sm:flex-row sm:items-center sm:gap-3 ${voided ? "opacity-50" : ""}`}
    >
      <span className="w-8 shrink-0 font-mono text-slate-300">#{event.seq}</span>
      <span
        className={`badge w-24 shrink-0 break-words text-center leading-tight normal-case sm:w-32 ${EVENT_TONE_STYLE[desc.tone]}`}
      >
        {desc.label}
      </span>
      <span className="min-w-0 flex-1 text-slate-700">
        <span className={voided ? "line-through" : ""}>{desc.text}</span>
        {voided && <span className="ml-1 text-amber-600">({msg("scorepad.timeline.voided")})</span>}
        {attrLine && <span className="block text-slate-400">{attrLine}</span>}
        {recorder && <span className="text-slate-400"> ({recorder})</span>}
      </span>
      <span className="shrink-0 text-slate-400">
        <ClientTime value={event.recorded_at} mode="time" />
      </span>
      {canVoid && (
        <button
          type="button"
          data-role="void"
          disabled={voidingId === event.id}
          onClick={() => onVoid!(event.id)}
          className="min-h-11 shrink-0 rounded-full border border-red-200 px-3 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
        >
          {msg("scorepad.timeline.void")}
        </button>
      )}
    </li>
  );
}

export function Timeline(props: TimelineProps): ReactNode {
  const msg = useMsg();
  const {
    events,
    recorderNames = EMPTY_NAMES,
    personNames = EMPTY_NAMES,
    attributionByType = EMPTY_ATTRIBUTION_MAP,
    homeEntrantId,
    awayEntrantId,
    deviceLinkId = null,
    onVoid,
    voidingId = null,
  } = props;

  return (
    <section className="card overflow-hidden" data-role="timeline">
      <header className="border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">
          {msg("scorepad.timeline.heading")} <span className="font-normal text-slate-400">({events.length})</span>
        </h2>
      </header>
      {events.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-400">{msg("scorepad.timeline.empty")}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-slate-50 overflow-y-auto">
          {[...events].reverse().map((event) => {
            const voided = events.some((v) => v.voids_event_id === event.id);
            const ownedByMe = deviceLinkId === null || event.device_link_id === deviceLinkId;
            const canVoid = !!onVoid && !voided && event.type !== "core.void" && ownedByMe;
            return renderRow(
              event,
              voided,
              canVoid,
              voidingId,
              onVoid,
              recorderNames,
              personNames,
              attributionByType,
              homeEntrantId,
              awayEntrantId,
              msg,
            );
          })}
        </ul>
      )}
    </section>
  );
}
