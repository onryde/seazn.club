import type { ReactNode } from "react";
import type { TemplateId } from "@/components/overlay/template-registry";
import type { OverlaySideInput } from "@/lib/overlay-model";
import type { Currency } from "@/lib/currency";
import type { ClubStreamPrefs, StreamPrefsRead } from "@/lib/stream-settings";
import type { SeaznQr } from "@/lib/seazn-qr";
import type { CreateFailureCode, CreateErrorHolder } from "@/lib/stream-session-view";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamMode, StreamTarget } from "@/server/api-v1/schemas";

/** What the panel needs off the row. Structurally a subset of
 *  `RunSheetFixture`, declared narrowly so the panel does not import the run
 *  sheet's own shape and become un-mountable anywhere else. */
export interface StreamPanelFixture {
  id: string;
  status: string;
  outcome: unknown;
  scheduled_at: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/**
 * The per-PAGE half, resolved once on the server and threaded down
 * (`StagesPanel` → `RunSheet` → `RunSheetRow`) rather than re-resolved per row.
 *
 * `overlayDict` is the `overlay.*` slice of the active locale's PUBLIC
 * dictionary. It has to travel: the console layout provides the `ui`
 * namespace, the overlay's own copy lives in `public`, and `getDictionary` is
 * `server-only` so a client island cannot load it. Sliced to the prefix the
 * themes actually read so the RSC flight carries ~20 strings, not the whole
 * public catalogue.
 */
/** Task 14b (V426): the org's match-credit balance split by bucket — `monthly` (this month's free credits, which expire
 *  at the end of the UTC month) and `pack` (bought, never expire). `total` is the chip's number. Declared here rather than
 *  imported from the server usecase, which is `server-only`. */
export interface StreamCreditSplit {
  monthly: number;
  pack: number;
  total: number;
}

export interface StreamPanelContext {
  /** `streaming.overlay`, competition-scoped. False ⇒ no panel and no toggle
   *  at all — never an upsell here (ruling 5: the OBS-side upsell is R1's). */
  entitled: boolean;
  /** `streaming.relay`, competition-scoped — the §5.3 gate the Phone tab reads. Since V426 every plan grants it, so
   *  false means staff switched it off for this org (I4): the tab says so, and never sells a plan. */
  relayEntitled: boolean;
  /** I2 (Task 14b review): this deployment has no relay at all (R5 — drivers.ts `disabledRelayDrivers`), so every start
   *  and every pack checkout is refused. The Phone tab shows that instead of buy tiles and Go live; the stop probe
   *  stays, so a stream left over from before still has its way out. */
  relayDisabled: boolean;
  /** R2006 (owner ruling 2026-10-19, "Option C"): the score can stream on this deployment — `streaming.relay` and R2001's
   *  `composedUnavailable()` (server/stream-panel-context.ts `relayOffer`). False: Go live streams the camera only, with
   *  a one-line reason, and is never blocked. */
  composedAvailable: boolean;
  /** R2006: each listed fixture's STORED score preferences (mode, template, delay; null = the default), keyed by
   *  fixture as `overlayKeys` is. A fixture missing here reads as all defaults. */
  streamPrefs: Record<string, StreamPrefsRead>;
  /** R2006: config.ts `RELAY_OVERLAY_DELAY_DEFAULT_MS` — the delay a composed session serves when the fixture sets none.
   *  Score timing's "Default {seconds}s" and its reset value; the panel never types the number. */
  overlayDelayDefaultMs: number;
  /** Court stream device check 3 (D1): config.ts `COURT_PHONE_OVERLAY_DELAY_MS` — the delay a COURT session serves when the
   *  fixture sets none. Score timing's default while the read model names the match's court. */
  courtOverlayDelayDefaultMs: number;
  /** Task 38: the club's default Score style and timing (`org_stream_defaults`; null = none set), for the panel's "Club style: …" row
   *  and the style the picker opens on. A match's own stored choice wins over it; a COURT stream takes the style and never the timing. */
  clubStyle: ClubStreamPrefs;
  /** I3 (PR #987 review): each listed fixture's sides as the overlay AIRS them — names masked and codes disambiguated by
   *  the overlay page's own loader (server/stream-panel-context.ts `overlayPreviewSides`). The style grid's thumbnails
   *  render these, so a person pair previews the codes it airs. A fixture absent here previews the row's own names. */
  overlaySides: Record<string, [OverlaySideInput, OverlaySideInput]>;
  sportKey: string;
  overlayDict: Record<string, string>;
  /** The org the fixture belongs to — the stream-targets and relay-checkout routes address it. */
  orgId: string;
  /** C1 — the org's match-credit balance as the SERVER resolved it. The projection's `balance` only exists once a
   *  session does, so this is the idle tab's only source; without it a club that has just bought credits reads 0 and
   *  is shown the buy card again. */
  streamBalance: number;
  /** Task 14b (R4) — `streamBalance` split by bucket, as the same server read resolved it; null when the page read no
   *  credits (no relay). The tab shows the split only while it still adds up to the balance it shows. */
  streamSplit: StreamCreditSplit | null;
  /** Task 14b (R4) — the plan's free match credits per month (V426's `streaming.credits.monthly`), for the credits card's
   *  note. 0 when the page read no credits. */
  monthlyAllowance: number;
  /** P1 — the currency the relay-checkout route will CHARGE (`preferredCurrency`, resolved by the page for the same
   *  org and browser), so the tiles quote the amount the checkout's line shows — never a GBP number above a USD sheet. */
  currency: Currency;
  /** RT (lane-close fix, ruled 2026-09-29) — each listed fixture's signed overlay key (server/overlay/overlay-key.ts),
   *  minted by the page. The OBS URL this panel copies carries its row's key, and that key is what earns a community
   *  org's overlay real-time scores at the token route. A fixture missing here (no signing secret on the server) gets a
   *  keyless URL, and its overlay polls. */
  overlayKeys: Record<string, string>;
  /** Capture QR v2 (carry 2, owner 2026-10-04): the PostHog flag `capture-qr-v2` for this organiser's org — or
   *  `CAPTURE_QR_V2_ALWAYS=1` — as `server/stream-panel-context.ts` resolved it. False hides the phone-camera option
   *  (the Phone tab) and nothing else: the routes are not gated, and a stream already up keeps its Stop. */
  phoneCapture: boolean;
  /** W19 (§6.8.5): how long a live phone stream's phone may be gone (no beat AND no video) before the tick ends it
   *  `phone_lost` — config.ts `PHONE_LOST_LIVE_MINUTES` through `tunable`, as the SERVER reads it, the same expression the
   *  tick judges with. The ended chip names it; the panel never computes or defaults it. */
  phoneLostMinutes: number;
  /** PR-2 T10 (§7.1): the auto stop's delay in whole minutes (≥ 1) — config.ts `AUTO_STOP_AFTER_RESULT_SECONDS` through
   *  `tunable`, as the SERVER's tick reads it. The switch's caption and Live's read-only line name it; never a typed 3. */
  autoStopMinutes: number;
  /** Task 34: the stream code's paste field and its Copy show under the QR — config.ts `streamPasteCodeShown`
   *  (STREAM_PASTE_CODE), as the SERVER reads it: dev, e2e and smoke servers show them, stg and prod show the QR alone. */
  pasteCodeShown: boolean;
}

/** The fixture's stream code as the body shows it (capture QR v2 §6.1): asked for, refused, or its paste text — the QR's
 *  own text, `captureQrV2Text` — with the image once the browser has encoded THAT text (never the previous code's). */
export type CodeCard =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; text: string; image: SeaznQr | null };

/** The org's destinations as the picker knows them (spec §3.3): a failed read is an ERROR with Retry, never "none" —
 *  "none" told an organiser with five saved destinations to go and add one. */
export type TargetsState = { status: "loading" } | { status: "error" } | { status: "ok"; list: StreamTarget[] };

export type CreateError = { code: CreateFailureCode; holder: CreateErrorHolder | null };

/**
 * R2006 (owner ruling 2026-10-19, "Option C"): what the Phone tab knows of the score — handed down by the panel, which
 * owns the stored preferences (`useStreamPrefs`) and the preview data.
 *  - `available`: the score can stream on this deployment (StreamPanelContext.composedAvailable). False: Go live streams
 *    the camera only, with a one-line reason — never blocked, never an option the API would refuse.
 *  - `stored`: the fixture's stored mode (null: never chosen — the score). The effective mode is
 *    `effectiveStreamMode(stored, available)`, the SAME rule the phone's start and the automatic start resolve.
 *  - `template`: the match's OWN stored style, resolved (null: it has none), sent as Go live's `themeId` for a score stream. Null sends
 *    NO themeId, so the server's chain (the match's, else the club's, else the sport's default) decides — Task 38: the style the
 *    picker merely SHOWS (the club's) is never sent as if the organiser had chosen it.
 *  - `delayMs`: the score timing Score timing shows (null: the server's default), sent as Go live's `overlayDelayMs` for
 *    a score stream — so a delay typed just before Go live streams even while its own save is still in flight (m2).
 *  - `editor`: Ready's score card body — the picker and Score timing (pre-live only).
 */
export interface PhoneScore {
  available: boolean;
  stored: StreamMode | null;
  template: TemplateId | null;
  delayMs: number | null;
  sportKey: string;
  editor: ReactNode;
  /** Court stream device check 3 (D1): the same body with Score timing on a COURT session's default (0 s), shown while the
   *  read model names the match's court. Absent: `editor`. */
  courtEditor?: ReactNode;
  /** The last Camera only / Add the score back did not save — the stored mode shows again, and a line says so. */
  modeFailed: boolean;
  onMode: (mode: StreamMode) => void;
}
/** D13: which sentence a refused checkout gets — keyed on the route's STATUS (`CheckoutSecretResult` has no code). */
export type CheckoutError = "owner" | "unknown";
