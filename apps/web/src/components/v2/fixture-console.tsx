"use client";

// THE organiser scoring surface (PROMPT-15 task 1). Sport-shaped pads feed
// POST /api/v1/fixtures/{id}/events with optimistic concurrency: every event
// carries expected_seq + an idempotency key (doc 08 §4); a 409 resyncs from
// the ledger and replays the UI.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import { AuditStrip } from "@/components/v2/audit-strip";
import { ClientTime } from "@/components/client-time";
import { ShareButton } from "@/components/share-button";
import {
  AvailabilityRoster,
  LineupEditor,
  lineupEditorApplies,
  type PositionGroupIn,
} from "@/components/v2/lineup-editor";
import { ScoringErrorBoundary } from "@/components/v2/scoring-error-boundary";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import { PadSuspensionBanner } from "@/components/discipline/pad-suspension-banner";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { scoringErrorText, decidedOutcomeText, shootoutScoreFromDetail } from "@/lib/scoring-vocab";
import { resolveSlotLabel } from "@/lib/slot-label";
import { entrantDisplayName } from "@/lib/entrant-name";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import type { MessageKey } from "@/lib/messages";
// S13/#422 W11 — the v2 scoring pad is now the only pad this console renders
// (S12/#421's flag has been removed entirely, along with the eight v1 pad
// components it used to choose between). `scorePadV2` stays nullable: a
// server-side bootstrap-resolution failure (fidelity.ts's own doc) means
// "no pad renders", never a fallback to a v1 chain that no longer exists.
import { ScorePad, type ScorePadBootstrap } from "@/components/v2/scorepad/registry";
// R7/C1 (D-4, ruling R7-1) — the ONE ledger. This console used to hand-roll
// its own `<ul>` beside the pad's panel; the two were not duplicates (the
// pad's named people in sentences, the page's carried #seq, the timestamp,
// who recorded each row and the audit controls), so the row was a MERGE and
// this is where the surviving component now mounts. The pad is told to drop
// its own copy (`hideActivity`), which keeps exactly one on the screen while
// letting this one OUTLIVE the pad — it unmounts the moment a fixture is
// decided, and a finalized fixture must still show what happened.
import { ActivityPanel, type ActivityDetailResolver, type ActivityEvent } from "@/components/v2/scorepad/v3/activity";
import { resolvePad } from "@/components/v2/scorepad/v3/registry";
import { cricketHasNoInnings } from "@/components/v2/scorepad/v3/skins/cricket";
import { genericHasNoResult } from "@/components/v2/scorepad/v3/skins/generic";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Focus-trapped, Esc-to-close single-field text prompt — replaces the native
 *  browser prompt dialog for the abandon/forfeit reason inputs below (same
 *  reasoning as prose-editor.tsx's EditorDialog: stylable, localizable,
 *  testable, consistent with the rest of the app's dialogs). */
function TextPromptDialog({
  title, initialValue, msg, onSubmit, onClose,
}: {
  title: string;
  initialValue: string;
  msg: Msg;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-purple-950/30 p-4 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-purple-100 bg-white p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = (new FormData(e.currentTarget).get("reason") as string).trim();
            if (value) onSubmit(value);
            else onClose();
          }}
        >
          <input
            name="reason"
            type="text"
            autoComplete="off"
            defaultValue={initialValue}
            className="input w-full"
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {msg("editor.cancel")}
            </button>
            <button type="submit" className="btn btn-primary">
              {msg("editor.apply")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export interface MemberIn {
  person_id: string;
  full_name: string;
  squad_number: number | null;
  default_position_key: string | null;
  is_captain: boolean;
  roles: string[];
}
export interface LineupSlotIn {
  person_id: string;
  full_name: string;
  squad_number?: number | null;
  slot: "starting" | "bench";
  position_key: string | null;
  order_no: number | null;
  roles: string[];
  /** player/coach/staff (S3/#426 ruling). Optional: `readLineup`'s SQL
   *  (server/usecases/fixtures.ts) already selects the DB column into every
   *  row, but this wire type is also hand-built in test fixtures and other
   *  call sites that predate the column, so it stays optional rather than
   *  required. Absent means "player", the same default the engine's own
   *  `LineupSlot.role` applies (S12/#421 pass B, Fix 2). */
  role?: "player" | "coach" | "staff";
  /** Doubles/pair serve order (S3/#426's engine `LineupSlot.pairOrder`) —
   *  S12/#421 pass D, V361. Optional for the same reason `role` is: nothing
   *  outside a pair-shaped entrant (tennis/badminton/tabletennis doubles, or
   *  any other sport whose entrant model allows "pair") ever sets it, and
   *  test fixtures predating the column construct this type without it. */
  pair_order?: number | null;
}
export interface SideInfo {
  id: string;
  name: string;
  /** The entrant's own declared kind — "team" | "individual" | "pair"
   *  (`entrants.kind`, spec 2026-07-18's entrantModel). Set once at
   *  registration and validated against the division's effective entrant
   *  model (server/usecases/entrants.ts's ENTRANT_KIND_NOT_ALLOWED /
   *  ENTRANT_ROSTER_TOO_BIG checks); not patchable afterward. This is the
   *  authoritative answer to "is this entrant a pair" — lineup-editor.tsx's
   *  `isPairShaped` reads it directly instead of inferring pair-shapedness
   *  from position-catalog shape + member count (S12/#421 pass E, Finding 1).
   *  Optional: existing test fixtures and callers that never render
   *  `LineupEditor` predate this field. */
  kind?: string;
  members: MemberIn[];
  lineup: LineupSlotIn[];
}

export interface SportInfo {
  key: string;
  config: Record<string, unknown>;
  scorerLabel: string;
  /** Groups of the catalog that governs THIS fixture — `lineupCatalogFor`
   *  (R7 B2), never `sportModule.positions`. Carries `min`/`max` because a
   *  competition's config moves them (hockey's optional goalkeeper). */
  positionGroups: PositionGroupIn[];
  roles: { key: string; name?: string }[];
  lineupSize: number;
  /** Resolved `lineup.benchMax` (0 when the module declares none). Required,
   *  not optional: with `lineupSize` it decides whether this sport HAS a
   *  lineup to edit at all (R7 D-1), and a bootstrap that forgot it would
   *  silently render the editor for a 1-v-1 sport again. */
  benchMax: number;
}

export interface LiveState {
  status: string;
  last_seq: number;
  summary: unknown;
  state: unknown;
  outcome: unknown;
}

export interface EventIn {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by?: string | null;
  voids_event_id: string | null;
  device_link_id?: string | null;
}

interface Props {
  fixture: {
    id: string;
    status: string;
    scheduled_at: string | null;
    /** Venue zone (schedule_settings.tz) so the kick-off shows venue time. */
    scheduled_tz?: string;
    /** P9 pass 3c-2: derived from venue_id/court_id (courts/venues), not the
     *  frozen free-text venue/court_label columns. */
    venue_name: string | null;
    court_name: string | null;
    round_no: number;
    /** D4b (P6) — {key, params} i18n pattern ref while `home`/`away` (below)
     *  is null (V360's fixtures.home/away_slot_label). */
    home_slot_label?: SlotLabel | null;
    away_slot_label?: SlotLabel | null;
  };
  sport: SportInfo;
  home: SideInfo | null;
  away: SideInfo | null;
  initialState: LiveState;
  initialEvents: EventIn[];
  canEdit: boolean;
  /** recorded_by → display name for Activity attribution. */
  recorderNames?: Record<string, string>;
  /** Public fixture path — enables the share action once decided (v3/10 #2).
   *  Null when the competition isn't shared. */
  publicPath?: string | null;
  /** Player RSVP/check-in per person (PROMPT-53) — chips in the lineup picker. */
  availability?: Record<string, PersonAvailability>;
  /** Active suspensions among this fixture's entrants (SPEC-1), joined server
   *  side into the bootstrap payload. Drives the soft pad warning banner. */
  activeSuspensions?: { personId: string; personName: string; served: number; total: number }[];
  /** Everything `<ScorePad/>` needs beyond what this component already has
   *  (fixture id, sport key, home/away), resolved server-side
   *  (`resolveScorePadBootstrap`, server/usecases/fidelity.ts). Null only on
   *  a resolution failure — the pad section then renders nothing rather
   *  than a fallback, since S13/#422 removed the v1 pad it used to fall
   *  back to. */
  scorePadV2?: ScorePadBootstrap | null;
  /**
   * Ledger chain-verification + the signed-export entitlement, resolved
   * server-side (`page.tsx`). R7/C1 moved `AuditStrip` off the page and into
   * the activity panel's footer, where the ledger it describes actually is —
   * it used to render as a loose strip below the whole console, two cards
   * away from the rows it is a verdict about. Null when there is nothing to
   * audit (no events yet), which renders no strip at all.
   */
  audit?: { verified: boolean; tamperedSeq: number | null; entitled: boolean } | null;
  /**
   * Whether this fixture may still be handed to a courtside device — the
   * page's own gate (editor, competition not frozen, fixture not finalized
   * or cancelled), passed down rather than re-derived here because only the
   * server component knows about the freeze.
   *
   * R7/C3 (D-19): `DeviceLinkPanel` used to render as the LAST card on the
   * page, below the audit strip — at 375 the console is ~2400px tall, so the
   * one control an organiser reaches for at the START of a fixture sat below
   * everything they would only read at the end. It now opens from the pad's
   * own heading row.
   */
  deviceHandover?: boolean;
  viewerPlan: ViewerPlan;
}

/** Payload keys that carry a person id across the sport modules (card, goal,
 *  sub, award). The pad warning fires when a recorded event names a suspended
 *  person via any of them. */
const ATTRIBUTION_KEYS = ["person", "scorer", "assist", "off", "on"] as const;

/** Module-level so the panel's props keep a stable identity across renders. */
const NO_OWN_EVENTS: ReadonlySet<string> = new Set();

function personIdsInEvents(events: EventIn[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    for (const k of ATTRIBUTION_KEYS) {
      const v = p[k];
      if (typeof v === "string") ids.add(v);
    }
  }
  return ids;
}

export interface PersonAvailability {
  status: "in" | "out" | "maybe";
  note: string | null;
  checked_in_at: string | null;
}

export type SendEvent = (type: string, payload: unknown) => Promise<boolean>;

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  in_play: "bg-amber-100 text-amber-700",
  decided: "bg-sky-100 text-sky-700",
  finalized: "bg-emerald-100 text-emerald-700",
  // R3.5/Task P — was text-slate-400 (2.40:1 on this chip's bg-slate-100,
  // under the WCAG AA 4.5:1 floor); text-slate-600 matches the "scheduled"
  // chip above (same bg-slate-100 background, same muted-neutral intent)
  // and clears 6.92:1. Ratio computed and pinned in
  // components/v2/__tests__/history-panel-contrast.test.tsx.
  abandoned: "bg-slate-100 text-slate-600",
  forfeited: "bg-red-50 text-red-500",
  cancelled: "bg-slate-100 text-slate-600",
};

export function FixtureConsole({
  fixture,
  sport,
  home,
  away,
  initialState,
  initialEvents,
  canEdit,
  recorderNames = {},
  publicPath = null,
  availability = {},
  activeSuspensions = [],
  scorePadV2 = null,
  audit = null,
  deviceHandover = false,
  viewerPlan,
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const [live, setLive] = useState<LiveState>(initialState);
  const [events, setEvents] = useState<EventIn[]>(initialEvents);
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while an opportunistic post-pad-event `resync()` is in flight.
   *  Separate from `busy` on purpose: `busy` means "a send of MINE is
   *  running" and its own `finally` clears it, so reusing it here would let a
   *  resync that finishes mid-send clear the send's guard. Both gate the same
   *  controls, because acting on a half-refreshed ledger is what this fix
   *  exists to prevent: without it, Undo stayed clickable during the window
   *  with a stale `expected_seq` and the server answered 409 SEQ_CONFLICT —
   *  bounded (it never voids the wrong event) but an unearned error where a
   *  clean undo was expected. Found in review (S13 follow-ups). */
  const [padSyncing, setPadSyncing] = useState(false);
  const [abandonPrompt, setAbandonPrompt] = useState(false);
  /** The row whose Void is in flight — the panel dims exactly that button. */
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const resync = useCallback(async () => {
    const [state, all] = await Promise.all([
      apiV1<LiveState>(`/api/v1/fixtures/${fixture.id}/state`),
      apiV1<EventIn[]>(`/api/v1/fixtures/${fixture.id}/events?since_seq=0`),
    ]);
    setLive(state);
    setEvents(all);
  }, [fixture.id]);

  /** Fired whenever `<ScorePad/>`'s own pipeline reports its reconciled
   *  ledger changed (a new submit, an ack, or a foreign-write merge) — the
   *  RAW event list it hands over is deliberately unused here. That
   *  pipeline stamps a CLIENT-fabricated id (the idempotency key) on every
   *  event it knows about and never learns the server's real row id —
   *  `AppendSuccess` carries no row id at all, so the id survives forever
   *  (`use-pad-pipeline.ts`'s own S12/#421 pass F/G history, fixed there via
   *  a targeted re-read before the pad's OWN void send). Trusting the
   *  pad-supplied id here directly would reintroduce that exact bug one
   *  layer out: `send()` below has no id-resolution step, so it would void
   *  an id the server has never seen. A real `resync()` — the same one
   *  `send()` itself trusts — is the only way this component learns the
   *  real id. A failed opportunistic resync is swallowed: nothing the user
   *  directly did here should surface as an error, and the next pad event
   *  (or an explicit action) catches up. */
  const handlePadEvents = useCallback(() => {
    setPadSyncing(true);
    void resync()
      .catch(() => undefined)
      .finally(() => setPadSyncing(false));
  }, [resync]);

  const send: SendEvent = useCallback(
    async (type, payload) => {
      setError(null);
      setPaywallFeature(null);
      setBusy(true);
      try {
        await apiV1(`/api/v1/fixtures/${fixture.id}/events`, {
          method: "POST",
          json: {
            expected_seq: live.last_seq,
            type,
            payload,
            idempotency_key: crypto.randomUUID(),
          },
        });
        await resync();
        router.refresh();
        return true;
      } catch (err) {
        if (err instanceof ApiV1Error && err.code === "SEQ_CONFLICT") {
          // Another scorer got there first — resync and let them retry.
          await resync().catch(() => undefined);
          setError(msg("score.seqConflict"));
        } else if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
          setPaywallFeature(String(err.extra.feature_key ?? ""));
        } else {
          // #427: an EngineError's message is the engine's own English and the
          // envelope carries it through ApiV1Error — localize by code first.
          setError(scoringErrorText(
            err instanceof ApiV1Error ? err.code : null,
            err instanceof Error ? err.message : null,
            msg,
            "score.failed",
          ));
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fixture.id, live.last_seq, resync, router],
  );

  // `detail` added (R3.5/Task G) alongside the pre-existing `headline` cast —
  // `shootoutScoreFromDetail` reads it to put a number in the decided
  // sentence below when the method is a shoot-out.
  const summary = live.summary as { headline?: string; detail?: unknown } | null;
  // R7 follow-ups item 2 — this header has no `ownsHeadline`-style guard of
  // its own (that lives on the v3 pad skin, `ScorePad` below), so a fresh
  // cricket OR generic fixture rendered `summary.headline` verbatim: both
  // modules' `sideLine` produce the literal `— — —` for a side with nothing
  // recorded yet (cricket: no innings; generic: `score`/`outcome`/`running`
  // all still at their `init()` shape) — a code-review pass on this fix
  // found the same defect reachable for "generic", the universal
  // scoring surface for every sport this engine does not model (R7/A1), not
  // a placeholder skin. The other 9 built-in sports were swept and do NOT
  // degenerate: their headlines are numeric ("0 — 0") from the first render.
  // Scoped to exactly the pre-match question — never string-matches the
  // rendered headline — by reusing each pad's own predicate off the same raw
  // `live.state` this component already threads down to `<ScorePad>`, so the
  // two surfaces cannot drift on what "before a match has produced one" means.
  const suppressHeadline =
    (sport.key === "cricket" && cricketHasNoInnings(live.state)) ||
    (sport.key === "generic" && genericHasNoResult(live.state));
  // Same widening as apps/web/src/server/public-site/data.ts's PublicFixture
  // — `live.outcome` was read only as `!== null` before this task (the
  // `decided` boolean below); `method` reached nobody. Structural, not the
  // engine's own MatchOutcome type: this component already treats `outcome`
  // as loose JSON off the wire, not an engine import.
  const outcome = live.outcome as { kind?: string; winner?: string; method?: string } | null;
  const scoring = canEdit && live.status !== "finalized" && live.status !== "cancelled";
  // Fix round 1 (Task 4) — CRITICAL: the phone hand-over icon used to be
  // gated on `deviceHandover` alone while the `DeviceLinkPanel` it opens
  // sits behind `scoring && home && away` (the Scoring section's own gate,
  // below). On a TBD fixture (home/away null, header falls back to
  // schedule.tbd) with `canEdit`, the icon rendered and opened nothing —
  // pre-match, exactly when a handover happens. `deviceHandover` also reads
  // the SERVER's `fixture.status` while `scoring` reads the CLIENT's
  // `live.status`, so the two disagreed after an in-session finalize too.
  // One predicate now drives both the phone icon, the desktop button, and
  // the panel — they cannot diverge again.
  const canHandOver = deviceHandover && scoring && !!home && !!away;
  // An ABANDONED fixture is over, and the server records that in `status` while
  // leaving `outcome` NULL — the engine's own outcome for it is
  // `{kind:"no_result"}` (core/events.test.ts), which has no winner to persist
  // into the outcome column. Reading `outcome` alone therefore called an
  // abandoned fixture undecided, and the console went on offering Abandon and
  // Forfeit on a match that had already ended.
  //
  // Both are refused by the fold, not merely redundant: `core.abandon` requires
  // `phase === "live"` and abandon has already moved it to "done", and
  // `core.forfeit` throws WRONG_PHASE ("already over") in that phase. So this
  // was the pad offering exactly what the engine will refuse — the defect class
  // the v3 programme exists to remove, on the shared console rather than in a
  // skin.
  //
  // `decidedLock` is deliberately NOT reused here: it gates whether an event
  // row may still be voided, and undoing a mistaken abandon must stay possible.
  // Over, but reversible.
  const decided = live.outcome !== null || live.status === "abandoned";
  const started = live.status !== "scheduled";
  // Task 13 finding B — the SCORING section's header row hides itself on
  // phones once `started` (below, "Owner review ... hand-over as an icon"),
  // and its ScorePad mount is gated on `scorePadV2 && !decided` (below) —
  // so a fixture that is BOTH started and decided has nothing left to show
  // inside `<section data-role="console-scoring">` on a phone, yet the
  // section's own `card p-5 max-md:p-3` wrapper (padding, border, bg-white)
  // still rendered, an empty white box between the header's "won on ..."
  // line and the Activity card (found on cricket/football/ice-hockey
  // decided-screen captures at 320, absent from the pre-branch baseline —
  // the baseline's header row had no `started`-gated max-md:hidden at all).
  // `canHandOver && handoverOpen` is the one thing that CAN still put real
  // content in the section on a phone regardless of `started`/`decided`
  // (the phone-only header icon, line ~629, opens `DeviceLinkPanel` inside
  // this section with no `max-md:hidden` of its own) — excluded here so
  // hiding the section can never hide content a scorer just asked to see.
  const consoleScoringEmptyOnPhone = started && !(scorePadV2 && !decided) && !(canHandOver && handoverOpen);

  const sides = { home, away };
  // R7/C5 (D-6) — what to CALL each side, resolved ONCE here and read by the
  // header, the ledger's sentences, the forfeit picker and the share text.
  // `display_name` is a team-sports snapshot; for an individual or a pair the
  // people are on the wire and are what a scorer recognises. See
  // `lib/entrant-name.ts`.
  const homeName = home ? entrantDisplayName(home) : null;
  const awayName = away ? entrantDisplayName(away) : null;
  // Feed name map: entrant ids AND every rostered person, so person-carrying
  // events (core.award MOTM, cards, subs) render names instead of "Unknown".
  const entrantNames: Record<string, string> = {};
  if (home) entrantNames[home.id] = homeName!;
  if (away) entrantNames[away.id] = awayName!;
  for (const side of [home, away]) {
    for (const m of side?.members ?? []) entrantNames[m.person_id] = m.full_name;
  }
  // R3.5/Task G — the v3 pad UNMOUNTS entirely once a fixture is decided
  // (the `scoring && !decided` gate below), so this is the ONE surface left
  // that can say who won and how; `msg`/`entrantNames` are exactly what
  // `decidedOutcomeText` needs and this component already has both.
  const decidedLine = decidedOutcomeText(outcome, entrantNames, msg, shootoutScoreFromDetail(summary?.detail));
  const lastVoidable = [...events]
    .reverse()
    .find((e) => e.type !== "core.void" && !events.some((v) => v.voids_event_id === e.id));

  // ---- the one ledger (R7/C1) -------------------------------------------
  //
  // Provenance is resolved HERE, not in the panel: `recorded_by` is a USER id
  // (so `personNames` cannot answer it) and `device_link_id` — the fact that
  // makes a row "the handed device" rather than a named person — never
  // survives into the pad pipeline's `EventEnvelope` at all. This component
  // is the only surface that holds both. The wording is the deleted panel's
  // own, verbatim.
  const provenanceOf = (e: EventIn): string | null =>
    e.device_link_id
      ? msg("score.courtsidePad", { scorer: sport.scorerLabel.toLowerCase() })
      : e.recorded_by
        ? (recorderNames[e.recorded_by] ?? sport.scorerLabel)
        : null;
  const activityRows: ActivityEvent[] = events.map((e) => ({
    id: e.id,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    voids: e.voids_event_id,
    recordedAt: e.recorded_at,
    recordedByLabel: provenanceOf(e),
  }));
  // The SKIN's own per-event detail, resolved the same way `pad-host.tsx`
  // resolves it. Without this the merge would silently DOWNGRADE cricket's
  // ledger back to three identical "Ball recorded" rows — the 2026-08-17
  // sign-off's D2, reintroduced by a consolidation meant to lose nothing.
  // `resolvePad` throws for a key in neither registry, which must never take
  // the console down over a caption.
  // R7-46 — the pad publishes its own `isPartial` predicate into this box (it
  // needs a live `PadHostView`, which only the pad builds). Before this, the
  // console passed `hideActivity` and rendered the ledger itself, so the
  // partial badge was wired on `/score/[token]` and INERT here — on the one
  // screen whose job is telling an organiser what the courtside scorer left
  // incomplete. See `PadHostV3Props.partialResolverRef` for why this is a
  // handoff and not a second `PadHostView` built here.
  const partialResolverRef = useRef<((eventType: string, payload: Record<string, unknown>) => boolean) | null>(null);
  const adoptPartialResolver = useCallback((resolve: (eventType: string, payload: Record<string, unknown>) => boolean) => {
    partialResolverRef.current = resolve;
  }, []);

  const partialBadge = useCallback(
    (eventType: string, payload: Record<string, unknown>) => partialResolverRef.current?.(eventType, payload) ?? false,
    [],
  );

  const padT = (key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars);
  const padPlural = useMsgPlural();
  let activityDetail: ActivityDetailResolver | undefined;
  try {
    const skin = resolvePad(sport.key, padT);
    const skinDetail = skin.activityDetail;
    if (skinDetail) {
      activityDetail = (eventType, payload, history) =>
        skinDetail({
          t: padT,
          // R7-28: the SECOND construction site of this context. `pad-host.tsx`
          // builds one for the pad's own ribbon; this one feeds the page
          // ledger, and the two drifted the moment `plural` was added to only
          // one — the console's rows kept reading "1 pts" while the pad's
          // ribbon read "1 pt". Any field added to `ActivityDetailContext`
          // has to land in BOTH or the same row says two different things on
          // one screen.
          plural: padPlural,
          eventType,
          payload,
          history,
          cfg: scorePadV2?.resolvedConfig ?? sport.config,
          state: live.state,
          personNames: entrantNames,
        });
    }
  } catch {
    activityDetail = undefined;
  }

  // Soft discipline warning (SPEC-1 / D8): a suspended player has been recorded
  // in this fixture's ledger. Never blocks — it just flags.
  const referencedPersons = personIdsInEvents(events);
  const flaggedSuspensions = activeSuspensions.filter((s) => referencedPersons.has(s.personId));

  return (
    <div className="space-y-6 max-md:space-y-3">
      {/* Scoreline header — on phones this IS the match strip (spec §3.1):
          names on one truncated line, status, a compact score, hand-over as
          an icon, and the round/venue/time line behind a details toggle. */}
      <header className="card p-5 max-md:p-3">
        <div className="flex flex-wrap items-center justify-between gap-3 max-md:flex-nowrap max-md:gap-2">
          <h1
            className={`text-lg font-semibold tracking-tight text-slate-900 max-md:min-w-0 max-md:flex-1 max-md:text-[13px] ${
              detailsOpen ? "" : "max-md:truncate"
            }`}
          >
            {homeName ?? resolveSlotLabel(fixture.home_slot_label ?? null, msg, "schedule.tbd")}{" "}
            {/* R3.5 accessibility fix — was text-slate-400 (~2.6:1 on white,
                under the WCAG AA 4.5:1 floor for normal text); text-slate-600
                is the token this codebase already uses for legible secondary
                text on white (history-panel-contrast.test.tsx's own fix, and
                the badge/label convention throughout components/v2). Ratio
                computed and pinned in
                components/v2/__tests__/history-panel-contrast.test.tsx. */}
            <span className="text-slate-600">{msg("schedule.vs")}</span>{" "}
            {awayName ?? resolveSlotLabel(fixture.away_slot_label ?? null, msg, "schedule.tbd")}
          </h1>
          <span className={`badge ${STATUS_STYLE[live.status] ?? ""}`}>
            {scoreStatusLabel(msg, live.status)}
          </span>
          {canHandOver && (
            <button
              type="button"
              data-role="device-handover-phone"
              aria-label={msg("score.handOverDevice")}
              aria-expanded={handoverOpen}
              onClick={() => setHandoverOpen((v) => !v)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 20 20"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7h11M11 4l3 3-3 3M17 13H6M9 10l-3 3 3 3" />
              </svg>
            </button>
          )}
        </div>
        <div className="max-md:mt-1 max-md:flex max-md:items-center max-md:justify-between max-md:gap-2">
          {!suppressHeadline && (
            <p className="mt-2 font-mono text-2xl text-slate-800 max-md:mt-0 max-md:min-w-0 max-md:text-lg">
              {summary?.headline ?? "—"}
            </p>
          )}
          <button
            type="button"
            data-role="match-details-toggle"
            aria-expanded={detailsOpen}
            aria-label={msg(detailsOpen ? "console.phone.hideDetails" : "console.phone.showDetails")}
            // Review fix: same `aria-controls` the activity toggle already
            // carries — points at the round/venue/time region below, which
            // is the region this button actually opens/closes. `FixtureConsole`
            // mounts once per fixture page (see `f/[no]/page.tsx`), so a
            // static id is safe — unlike `PhoneDisclosure`, which is mounted
            // several times on one page and needs `useId()`.
            aria-controls="match-details-body"
            onClick={() => setDetailsOpen((v) => !v)}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden${
              // Review fix: when the headline <p> above is suppressed
              // (cricket/generic, pre-innings) this button is the row's only
              // child, and `justify-between` on the parent leaves a lone
              // flex child flush left instead of at the end. `ml-auto` pins
              // it to the end of the row in that case; harmless when the
              // headline is present too, since `justify-between` already
              // pushes it there. No leading space before `${` above: the
              // conditional string supplies its OWN leading space so the
              // common case (`suppressHeadline` false) ends the class list
              // in exactly `md:hidden` with no trailing space — a stray
              // trailing space here broke the test's own anchored
              // `\smd:hidden"` regex (fixture-console-authority-band.test.tsx).
              suppressHeadline ? " ml-auto" : ""
            }`}
          >
            <span aria-hidden="true">{detailsOpen ? "▴" : "▾"}</span>
          </button>
        </div>
        {/* R3.5/Task G — the v3 pad unmounts once decided; this is the
            organiser console's surviving surface for "who won, and how". */}
        {decidedLine && <p className="mt-1 text-sm font-medium text-slate-700">{decidedLine}</p>}
        {/* Phone-only: the round/venue/time line sits behind
            `match-details-toggle` below md (spec §3.1) — wrapped in this div
            rather than folded into the <p>'s own className so
            history-panel-contrast.test.tsx's source-scan regex for this
            exact line (`<p className="mt-1 text-xs text-slate-(\d+)">`)
            keeps matching untouched. */}
        <div className={detailsOpen ? undefined : "max-md:hidden"} id="match-details-body">
          {/* R3.5/Task P — was text-slate-400 (2.63:1 on this .card's white,
              under the WCAG AA 4.5:1 floor); text-slate-600 clears 7.58:1,
              same fix as the "vs" separator above. */}
          <p className="mt-1 text-xs text-slate-600">
            {msg("schedule.round", { n: fixture.round_no })}
            {fixture.scheduled_at ? (
              <>
                {" · "}
                <ClientTime value={fixture.scheduled_at} mode="datetime" tz={fixture.scheduled_tz} showZone />
              </>
            ) : (
              ""
            )}
            {fixture.venue_name ? ` · ${fixture.venue_name}` : ""}
            {fixture.court_name ? ` · ${fixture.court_name}` : ""}
            {` · ${msg("score.recordedBy", { scorer: sport.scorerLabel.toLowerCase() })}`}
          </p>
        </div>
      </header>

      {paywallFeature && <UpgradeGate feature={paywallFeature} viewerPlan={viewerPlan} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Soft suspension warnings (SPEC-1) — one dismissible banner per flagged
          player recorded in this ledger. Never blocks scoring (D8). */}
      {flaggedSuspensions.length > 0 && (
        <div className="space-y-2">
          {flaggedSuspensions.map((s) => (
            <PadSuspensionBanner
              key={s.personId}
              name={s.personName}
              served={s.served}
              total={s.total}
            />
          ))}
        </div>
      )}

      {/* SCORING (R7/C2 + C3). The pad, and beside its heading the two
          controls that belong to scoring rather than to authority: `Start
          match`, the one thing to press before kick-off and the only filled
          button on this page, and `Hand over device` — which used to be the
          LAST card on the page, below the audit strip, ~1900px past the pad
          at 375. It takes the slot the bare authority row vacates.

          `data-testid="score-pad"` stays on the pad's OWN wrapper, never on
          this section: e2e reads it as "a decided fixture offers no way to
          record more", and a section that outlived the pad would answer
          that question wrong. */}
      {scoring && home && away && (
        <section
          className={`card p-5 max-md:p-3${consoleScoringEmptyOnPhone ? " max-md:hidden" : ""}`}
          data-role="console-scoring"
        >
          <div className={`mb-3 flex flex-wrap items-center justify-between gap-2${started ? " max-md:hidden" : ""}`}>
            <h2 className="text-sm font-semibold text-slate-700 max-md:hidden">{msg("score.scoring")}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {canHandOver && (
                <button
                  type="button"
                  data-role="device-handover"
                  aria-expanded={handoverOpen}
                  onClick={() => setHandoverOpen((v) => !v)}
                  className="btn btn-ghost min-h-11 max-md:hidden"
                >
                  {msg("score.handOverDevice")}
                </button>
              )}
              {!started && (
                <button
                  type="button"
                  disabled={busy || padSyncing}
                  onClick={() => send("core.start", {})}
                  className="btn btn-primary min-h-11"
                >
                  {msg("score.startMatch")}
                </button>
              )}
            </div>
          </div>

          {canHandOver && handoverOpen && (
            <div className="mb-4">
              <DeviceLinkPanel
                fixtureId={fixture.id}
                scorerLabel={sport.scorerLabel}
                embedded
                viewerPlan={viewerPlan}
              />
            </div>
          )}

          {/* Sport pad — S13/#422: the v2 registry, unconditionally (the flag
              and the eight v1 pads it used to choose between are gone).
              `scorePadV2` stays a null-guard, not a flag check: it is null
              only when server-side bootstrap resolution failed, in which case
              there is no v1 chain left to fall back to. */}
          {scorePadV2 && !decided && (
            <div data-testid="score-pad">
              <ScoringErrorBoundary fixtureId={fixture.id}>
                <ScorePad
                  fixtureId={fixture.id}
                  sportKey={sport.key}
                  moduleVersion={scorePadV2.moduleVersion}
                  resolvedConfig={scorePadV2.resolvedConfig}
                  home={home}
                  away={away}
                  initialEvents={scorePadV2.initialEvents}
                  auth={{ kind: "session" }}
                  identity={scorePadV2.identity}
                  entitlements={scorePadV2.entitlements}
                  onEvents={handlePadEvents}
                  // R7/C1 — this console mounts the one ledger itself, below.
                  hideActivity
                  // R7-46 — ...which is why the pad has to hand its partial
                  // predicate up rather than use it on a panel it no longer
                  // renders.
                  onPartialResolver={adoptPartialResolver}
                />
              </ScoringErrorBoundary>
            </div>
          )}
        </section>
      )}

      {/* THE ledger (R7/C1, D-4). One panel, one component — the same
          `ActivityPanel` `/score/[token]` mounts, here with authority:
          console-wide void rights, the provenance the deleted page panel
          carried, and the audit strip in its footer. Rendered OUTSIDE the
          `scoring && !decided` gate above on purpose: the pad unmounts the
          moment a fixture is decided and a finalized fixture must still say
          what happened. */}
      <ActivityPanel
        events={activityRows}
        // Irrelevant while `deviceLinkId` is null — `activityRowState`'s own
        // ownership rule short-circuits for the in-app scorer — and passing
        // the real thing is impossible anyway: this component never submits
        // through the pad's queue, so it owns no client-stamped ids.
        ownEventIds={NO_OWN_EVENTS}
        deviceLinkId={null}
        personNames={entrantNames}
        t={msg}
        authority
        collapsible
        resolveDetail={activityDetail}
        // R7-46. Reads through the ref at call time rather than closing over a
        // value, so the panel does not need to re-render when the pad's view
        // changes — it re-renders when `activityRows` does, which is exactly
        // when a row could newly become settled-and-partial. `?? false` covers
        // the recorded gap: a decided fixture whose pad never mounted.
        isPartial={partialBadge}
        onVoid={
          scoring && !decidedLock(live.status)
            ? (eventId) => {
                // Belt to `voidDisabled`'s braces: the button is disabled for
                // the whole window, and a click that beats a re-render (or
                // arrives from a synthetic caller) still cannot send.
                if (busy || padSyncing) return;
                setVoidingId(eventId);
                void send("core.void", { event_id: eventId }).finally(() => setVoidingId(null));
              }
            : undefined
        }
        voidingId={voidingId}
        // `busy || padSyncing` gated every row button before the merge, and for
        // a reason worth keeping: acting on a half-refreshed ledger sends a
        // stale `expected_seq` and earns a 409 where a clean void was expected
        // (see `padSyncing`'s own doc above). C1 kept the RULE but dropped the
        // affordance, leaving a bright, silent, dead button for the width of
        // every resync — review fix #1 puts the `disabled` back.
        voidDisabled={busy || padSyncing}
        footer={
          (audit || lastVoidable) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Ruling R7-5 keeps this control and renames it for what it
                  actually does: unlike the pad's take-back it can NEVER
                  cancel before send — it always writes a permanent
                  `core.void` row. It also reaches rows the per-row Void
                  cannot: `lastVoidable` skips voided rows and voids, which is
                  how a mistaken `core.abandon` stays reversible
                  (scoring.spec.ts pins that). It lives in the LEDGER's own
                  footer, not the authority band: it edits an entry, which is
                  scoring, not something that ends the match. */}
              {lastVoidable && scoring && !decidedLock(live.status) ? (
                <button
                  type="button"
                  disabled={busy || padSyncing}
                  onClick={() => send("core.void", { event_id: lastVoidable.id })}
                  className="btn btn-ghost min-h-11 text-xs"
                  title={msg("score.voidLastTitle", { type: lastVoidable.type, seq: lastVoidable.seq })}
                >
                  {msg("score.voidLast")}
                </button>
              ) : (
                <span />
              )}
              {audit && (
                <AuditStrip
                  fixtureId={fixture.id}
                  verified={audit.verified}
                  tamperedSeq={audit.tamperedSeq}
                  entitled={audit.entitled}
                />
              )}
            </div>
          )
        }
      />
      {/* Lineups (locked once the fixture starts). Gated on the module's own
          declaration as well as on the two sides: a sport that nominates one
          unit and admits no bench has no lineup to pick (R7 D-1). */}
      {home && away && lineupEditorApplies(sport) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(["home", "away"] as const).map((sideKey) => {
            const s = sides[sideKey]!;
            return (
              <PhoneDisclosure
                key={s.id}
                summary={entrantDisplayName(s)}
                aside={msg("console.phone.lineup")}
                showLabel={msg("lineup.phone.show")}
                hideLabel={msg("lineup.phone.hide")}
              >
                <LineupEditor
                  fixtureId={fixture.id}
                  // R7/C5 — the editor titles itself with `side.name`; hand it
                  // the RESOLVED one rather than the entry label. Resolved at
                  // the call site because `lineup-editor.tsx` is another wave's
                  // file this week, and because one resolution serving every
                  // reader is the point of `entrantDisplayName`.
                  side={{ ...s, name: entrantDisplayName(s) }}
                  positionGroups={sport.positionGroups}
                  roles={sport.roles}
                  lineupSize={sport.lineupSize}
                  canEdit={canEdit && live.status === "scheduled"}
                  onSaved={() => router.refresh()}
                  availability={availability}
                />
              </PhoneDisclosure>
            );
          })}
        </div>
      )}

      {/* …and where there is no lineup to pick, the ROSTER and its
          availability still show. R7/B's gate above was reasoning about the
          lineup CONTROLS; availability merely lived in the same component and
          went with them, so an organiser of any individual-entrant sport lost
          the only surface saying who had RSVP'd out. See
          `AvailabilityRoster`'s own note. */}
      {home && away && !lineupEditorApplies(sport) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(["home", "away"] as const).map((sideKey) => {
            const s = sides[sideKey]!;
            // Review fix: `AvailabilityRoster` itself renders nothing for a
            // side with no members (`lineup-editor.tsx`'s own
            // `if (side.members.length === 0) return null`). Gate the
            // wrapper on the SAME condition so a phone never shows a
            // tappable "… availability" row that opens onto an empty body —
            // matching the component's own rule rather than restating a
            // separate one (`lineup-editor.tsx` is shared with the
            // registration surfaces and is not touched here).
            if (s.members.length === 0) return null;
            return (
              <PhoneDisclosure
                key={s.id}
                summary={entrantDisplayName(s)}
                showLabel={msg("lineup.availabilityTitle", { name: entrantDisplayName(s) })}
                hideLabel={msg("lineup.availabilityTitle", { name: entrantDisplayName(s) })}
              >
                <AvailabilityRoster
                  side={{ ...s, name: entrantDisplayName(s) }}
                  availability={availability}
                />
              </PhoneDisclosure>
            );
          })}
        </div>
      )}

      {/* THE AUTHORITY BAND (R7/C2, D-12; Finalize in it per R7-3a).
          These three used to be a bare row of buttons ABOVE the scoring
          card — no container, no heading, nothing saying they end the match,
          with Abandon as the second control on the page. Now: a named
          container with a sentence saying what it costs, below the pad and
          below the ledger, and OUTLINED throughout — a filled button here
          would compete with a scoring tile for the eye, which is exactly the
          hierarchy failure D-12 is. */}
      {scoring && home && away && (
        <section
          data-role="match-actions"
          className="rounded-2xl border border-purple-100 bg-purple-50/40 p-4"
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-purple-800">
            {msg("score.matchActions")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">{msg("score.matchActionsNote")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {decided && (
              <>
                <button
                  type="button"
                  disabled={busy || padSyncing}
                  onClick={() => send("core.finalize", {})}
                  className="btn btn-ghost min-h-11"
                >
                  {msg("score.finalize")}
                </button>
                {publicPath && (
                  // v3/10 #2: result decided → one tap to the club group chat.
                  <ShareButton
                    title={`${homeName} ${msg("schedule.vs")} ${awayName}`}
                    text={msg("score.shareText", { home: homeName!, away: awayName!, headline: summary?.headline ?? msg("score.resultIn") })}
                    url={publicPath}
                    className="btn btn-ghost min-h-11"
                  />
                )}
              </>
            )}
            {!decided && (
              <>
                <ForfeitButton busy={busy} padSyncing={padSyncing} home={home} away={away} send={send} />
                <button
                  type="button"
                  disabled={busy || padSyncing}
                  onClick={() => setAbandonPrompt(true)}
                  className="btn btn-danger min-h-11"
                >
                  {msg("score.abandon")}
                </button>
              </>
            )}
          </div>
          {abandonPrompt && (
            <TextPromptDialog
              title={msg("score.abandonPrompt")}
              initialValue=""
              msg={msg}
              onClose={() => setAbandonPrompt(false)}
              onSubmit={(reason) => {
                setAbandonPrompt(false);
                void send("core.abandon", { reason });
              }}
            />
          )}
        </section>
      )}

    </div>
  );
}

function decidedLock(status: string): boolean {
  return status === "finalized" || status === "cancelled";
}

/** Localized fixture status; unknown values fall back to the raw token. */
function scoreStatusLabel(msg: Msg, status: string): string {
  const key = `score.status.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
}

function ForfeitButton({
  busy,
  padSyncing,
  home,
  away,
  send,
}: {
  busy: boolean;
  padSyncing: boolean;
  home: SideInfo;
  away: SideInfo;
  send: SendEvent;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const [forfeitPrompt, setForfeitPrompt] = useState<SideInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={busy || padSyncing}
        onClick={() => setOpen(!open)}
        className="btn btn-danger min-h-11"
      >
        {msg("score.forfeit")}
      </button>
      {open && (
        <div className="card absolute z-10 mt-1 w-56 space-y-1 p-2 shadow-lg">
          {[home, away].map((s) => (
            <button
              key={s.id}
              type="button"
              className="block min-h-11 w-full rounded px-2 py-1.5 text-left text-sm hover:bg-purple-50"
              onClick={() => {
                setOpen(false);
                setForfeitPrompt(s);
              }}
            >
              {/* R7/C5 — the person, not the entry label. */}
              {msg("score.forfeits", { name: entrantDisplayName(s) })}
            </button>
          ))}
        </div>
      )}
      {forfeitPrompt && (
        <TextPromptDialog
          // R7/C review fix #3 — the picker resolved the person and the
          // confirmation behind it did not, so a console that named Ada
          // Okonkwo everywhere else asked the organiser to confirm a forfeit
          // for "Entry 3". Same resolution, same `SideInfo`.
          title={msg("score.forfeitPrompt", { name: entrantDisplayName(forfeitPrompt) })}
          initialValue="walkover"
          msg={msg}
          onClose={() => setForfeitPrompt(null)}
          onSubmit={(reason) => {
            const by = forfeitPrompt.id;
            setForfeitPrompt(null);
            void send("core.forfeit", { by, reason });
          }}
        />
      )}
    </div>
  );
}
