"use client";
// YouTube Connect on the Streaming page (spec 2026-10-27 §6.1; owner D3 D7 D13 D14). Four pieces the destinations panel mounts:
//
//   * the consent step (`YoutubeConnectCard`) — a plain <form method="post"> to `/api/youtube/connect` (T7), because the next hop is
//     Google's consent screen and a navigation cannot be a fetch. Visibility (Unlisted preselected), made for kids (No preselected)
//     and the required checkbox (D7): the button stays disabled until it is ticked;
//   * the landing banner (`YoutubeLandingNotice`) — the callback's outcome, `?youtube=<code>`, as this page's own sentence;
//   * the picker (`YoutubeChannelPicker`) — a Google account that manages several channels (`?youtube=pick&pending=<id>`);
//   * a connected channel's row (`YoutubeChannelRow`) — its state in words, plus the actions that exist for it.
//
// Copy: every refusal is mapped from its machine CODE to this page's dictionary (`youtubeErrorText`). The server's `message` is
// English API prose and is never rendered. Unlike a pasted-key row, a connected channel has NO Rename, Replace key or Remove —
// the server answers each with 422 YOUTUBE_USE_DISCONNECT — and Disconnect itself is T18, not here.
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import {
  STREAMING_PAGE_HREF, YOUTUBE_DISCONNECTED_LABEL, YOUTUBE_GUIDELINES_URL, YOUTUBE_PRIVACIES, YOUTUBE_TOS_URL, youtubeLanding,
  type YoutubeLandingCode, type YoutubePrivacy,
} from "@/lib/youtube";
import type { StreamTarget, YoutubeConnectionSaved, YoutubePendingChannels } from "@/server/api-v1/schemas";
import { PlatformMark } from "./stream-platform-mark";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The `status` / `code` / `extra` of an `ApiV1Error` (lib/client-v1.ts), read structurally — `null` for anything that
 *  never reached the server (a network TypeError, an abort, a non-object). */
export function wireOf(err: unknown): { status: number; code: string; extra: Record<string, unknown> } | null {
  if (typeof err !== "object" || err === null) return null;
  const { status, code, extra } = err as { status?: unknown; code?: unknown; extra?: unknown };
  if (typeof status !== "number" || typeof code !== "string") return null;
  return { status, code, extra: typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>) : {} };
}

/** The admin seat an over-quota org has frozen (auth.ts `requireOrgAuth`): a 402 PAYMENT_REQUIRED whose `feature_key` is this. */
const FROZEN_SEAT_FEATURE = "members.max";

/** A refusal of a connection call as this page's own sentence, by the route's machine code (openapi.ts documents each one).
 *  Anything unmapped is the generic retry line — never the server's English. */
export function youtubeErrorText(msg: Msg, err: unknown): string {
  const w = wireOf(err);
  if (!w) return msg("streamDest.error.generic");
  switch (w.code) {
    case "YOUTUBE_OTHER_ORG": return msg("streaming.youtube.landing.other_org");
    case "YOUTUBE_PENDING_EXPIRED": return msg("streaming.youtube.landing.expired");
    case "YOUTUBE_DIFFERENT_CHANNEL": return msg("streaming.youtube.landing.different_channel");
    case "YOUTUBE_CHANNEL_NOT_OFFERED": return msg("streaming.youtube.error.notOffered");
    case "FORBIDDEN": return msg("streamDest.error.forbidden");
    case "UNAUTHENTICATED": return msg("streamDest.error.signedOut");
    case "PAYMENT_REQUIRED": return w.extra.feature_key === FROZEN_SEAT_FEATURE ? msg("streamDest.error.seatFrozen") : msg("streamDest.error.generic");
    default:
      // A grant that is not yours / already used / gone is a bare 404 (the route is deliberately no oracle); on the pending
      // lookup that reads as an expired request, on a connection call as a channel that is no longer there.
      return w.status === 404 ? msg("streaming.youtube.error.gone") : msg("streamDest.error.generic");
  }
}

/** A destination's label as the customer reads it: the archived label of a revoked connection is a database literal in English
 *  (token-store.ts), so it is swapped for the dictionary's. Any other label is the customer's own words and passes through. */
export function youtubeTargetLabel(msg: Msg, label: string): string {
  return label === YOUTUBE_DISCONNECTED_LABEL ? msg("streaming.youtube.disconnectedLabel") : label;
}

// ─── shared bits ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal, where the action was taken. */
function errorLine(text: string): ReactNode {
  return (
    <p data-testid="youtube-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      {text}
    </p>
  );
}

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
const LINK = "font-medium text-purple-700 underline underline-offset-2";

/** A sentence with `{name}` slots filled by elements (links). `msg(key)` with no vars leaves every `{name}` in place, so the
 *  slots are found in the translated text itself — a locale may put them anywhere. */
function withSlots(text: string, slots: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={i}>{name !== undefined && name in slots ? slots[name] : part}</Fragment>;
  });
}

const PRIVACY_KEY = {
  unlisted: "streaming.youtube.privacy.unlisted",
  public: "streaming.youtube.privacy.public",
  private: "streaming.youtube.privacy.private",
} as const satisfies Record<YoutubePrivacy, MessageKey>;
const PRIVACY_HINT_KEY = {
  unlisted: "streaming.youtube.privacy.unlistedHint",
  public: "streaming.youtube.privacy.publicHint",
  private: "streaming.youtube.privacy.privateHint",
} as const satisfies Record<YoutubePrivacy, MessageKey>;

/** The consent text (spec §6.1.2) with its links, and the box. Used by the connect step and by "Review updated terms", so the
 *  wording a person ticks is one text in one place. `name="consent" value="1"` is what the connect route reads. */
export function ConsentBox({ checked, onChange, withName }: { checked: boolean; onChange: (v: boolean) => void; withName: boolean }) {
  const msg = useMsg();
  const id = useId();
  const tos = (label: string) => <a href={YOUTUBE_TOS_URL} {...EXTERNAL} className={LINK}>{label}</a>;
  const guidelines = <a href={YOUTUBE_GUIDELINES_URL} {...EXTERNAL} className={LINK}>{msg("streaming.youtube.consent.guidelines")}</a>;
  const privacy = <Link href="/legal/privacy" {...EXTERNAL} className={LINK}>{msg("streaming.youtube.consent.privacy")}</Link>;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
        <input
          id={id}
          type="checkbox"
          data-testid="youtube-consent"
          {...(withName ? { name: "consent", value: "1" } : {})}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-purple-600"
        />
        <span className="min-w-0">{withSlots(msg("streaming.youtube.consent.body"), { tos: tos(msg("streaming.youtube.consent.tos")), guidelines })}</span>
      </label>
      <p className="text-xs text-slate-600">{msg("streaming.youtube.consent.disclaimer")}</p>
      <p className="text-xs text-slate-600">{withSlots(msg("streaming.youtube.consent.bound"), { tos: tos(msg("streaming.youtube.consent.tosFull")), privacy })}</p>
    </div>
  );
}

/** A <fieldset> defaults to `min-inline-size: min-content`, so a long unbreakable channel title inside one pushes it (and the card
 *  around it) wider than a 320px screen and the title is clipped with no ellipsis. `min-w-0` alone does not reset that property;
 *  the arbitrary one does (the same pair division-settings.tsx puts on its kinds fieldset). */
const FIELDSET = "min-w-0 [min-inline-size:0]";

/** The visibility choice, three radios with what each means. `name` ties them to the form field the route reads. */
export function PrivacyChoice({ value, onChange }: { value: YoutubePrivacy; onChange: (v: YoutubePrivacy) => void }) {
  const msg = useMsg();
  return (
    <fieldset className={FIELDSET}>
      <legend className="text-sm font-medium text-slate-800">{msg("streaming.youtube.privacy.legend")}</legend>
      <div className="mt-1.5 grid gap-2 md:grid-cols-3">
        {YOUTUBE_PRIVACIES.map((p) => (
          <label
            key={p}
            className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${value === p ? "border-purple-300 bg-purple-50" : "border-slate-200 bg-white"}`}
          >
            <input type="radio" name="privacy" value={p} data-testid={`youtube-privacy-${p}`} checked={value === p} onChange={() => onChange(p)} className="mt-0.5 h-4 w-4 shrink-0 accent-purple-600" />
            <span className="min-w-0">
              <span className="block font-medium text-slate-900">{msg(PRIVACY_KEY[p])}</span>
              <span className="block text-xs text-slate-600">{msg(PRIVACY_HINT_KEY[p])}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Made for kids: No / Yes. `name` is the form field the route reads ("0" | "1"). */
export function KidsChoice({ value, onChange }: { value: "0" | "1"; onChange: (v: "0" | "1") => void }) {
  const msg = useMsg();
  return (
    <fieldset className={FIELDSET}>
      <legend className="text-sm font-medium text-slate-800">{msg("streaming.youtube.madeForKids.label")}</legend>
      <div className="mt-1.5 flex gap-2">
        {(["0", "1"] as const).map((v) => (
          <label
            key={v}
            className={`flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm md:flex-none md:basis-32 ${value === v ? "border-purple-300 bg-purple-50" : "border-slate-200 bg-white"}`}
          >
            <input type="radio" name="madeForKids" value={v} data-testid={`youtube-kids-${v === "1" ? "yes" : "no"}`} checked={value === v} onChange={() => onChange(v)} className="h-4 w-4 shrink-0 accent-purple-600" />
            {msg(v === "1" ? "streaming.youtube.madeForKids.yes" : "streaming.youtube.madeForKids.no")}
          </label>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-slate-600">{msg("streaming.youtube.madeForKids.hint")}</p>
    </fieldset>
  );
}

// ─── the consent step ───────────────────────────────────────────────────────────────────────────────────────────────────

export function YoutubeConnectCard({ orgId, onCancel }: { orgId: string; onCancel: () => void }) {
  const msg = useMsg();
  const [privacy, setPrivacy] = useState<YoutubePrivacy>("unlisted");
  const [kids, setKids] = useState<"0" | "1">("0");
  const [consent, setConsent] = useState(false);
  const hintId = useId();
  return (
    <form
      data-testid="youtube-connect-form"
      method="post"
      action="/api/youtube/connect"
      aria-label={msg("streaming.youtube.consent.title")}
      className="card space-y-5 p-5 max-md:p-4"
      // The disabled button refuses a click; Enter inside a field is refused here, so a consent the route would answer with a
      // bare 400 never leaves the page.
      onSubmit={(e) => {
        if (!consent) e.preventDefault();
      }}
    >
      <input type="hidden" name="orgId" value={orgId} />
      <div>
        <h2 className="text-base font-semibold text-slate-900">{msg("streaming.youtube.consent.title")}</h2>
        <p className="mt-1 max-w-xl text-sm text-slate-600">{msg("streaming.youtube.consent.intro")}</p>
      </div>
      <PrivacyChoice value={privacy} onChange={setPrivacy} />
      <KidsChoice value={kids} onChange={setKids} />
      <p data-testid="youtube-settings-note" className="max-w-xl text-xs text-slate-600">{msg("streaming.youtube.settingsNote")}</p>
      <ConsentBox checked={consent} onChange={setConsent} withName />
      <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
        <button
          type="submit"
          data-testid="youtube-connect-submit"
          disabled={!consent}
          aria-describedby={consent ? undefined : hintId}
          className="btn btn-primary min-h-11"
        >
          {msg("streaming.youtube.consent.continue")}
        </button>
        <button type="button" data-testid="youtube-connect-cancel" onClick={onCancel} className="btn btn-ghost min-h-11">
          {msg("streamDest.cancel")}
        </button>
        {!consent && <p id={hintId} data-testid="youtube-consent-required" className="text-sm text-slate-600">{msg("streaming.youtube.consent.required")}</p>}
      </div>
    </form>
  );
}

// ─── the landing banner ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every landing the banner has a sentence for: all but `pick`, which opens the picker instead. */
const LANDING_KEY = {
  connected: "streaming.youtube.landing.connected",
  // The picker's own outcome (M5 ruling): the channel was already connected, so the choices made before Google were not applied.
  already_connected: "streaming.youtube.alreadyConnected",
  no_channel: "streaming.youtube.landing.no_channel",
  scope_missing: "streaming.youtube.landing.scope_missing",
  other_org: "streaming.youtube.landing.other_org",
  different_channel: "streaming.youtube.landing.different_channel",
  denied: "streaming.youtube.landing.denied",
  expired: "streaming.youtube.landing.expired",
  not_configured: "streaming.youtube.landing.not_configured",
  forbidden: "streaming.youtube.landing.forbidden",
  unavailable: "streaming.youtube.landing.unavailable",
} as const satisfies Record<Exclude<YoutubeLandingCode, "pick">, MessageKey>;
export type BannerCode = keyof typeof LANDING_KEY;

export function YoutubeLandingNotice({ code }: { code: BannerCode }) {
  const msg = useMsg();
  const router = useRouter();
  const ok = code === "connected" || code === "already_connected";
  return (
    <div
      data-testid="youtube-landing"
      data-code={code}
      role={ok ? "status" : "alert"}
      className={`flex items-start gap-3 rounded-lg border p-3 text-sm max-md:flex-col ${ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}
    >
      <p className="min-w-0 flex-1">{msg(LANDING_KEY[code])}</p>
      <button type="button" data-testid="youtube-landing-dismiss" onClick={() => router.replace(STREAMING_PAGE_HREF)} className="btn btn-ghost min-h-11 shrink-0 px-3 max-md:w-full">
        {msg("streaming.youtube.dismiss")}
      </button>
    </div>
  );
}

// ─── the channel picker ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal of the picker's lookup or pick. A request that is not found (404) is a grant that expired or was used: the same
 *  sentence the landing gives for it, rather than the connection calls' "channel is no longer there". */
function pickerRefusalText(msg: Msg, err: unknown): string {
  return wireOf(err)?.status === 404 ? msg("streaming.youtube.landing.expired") : youtubeErrorText(msg, err);
}

export function YoutubeChannelPicker({ orgId, pendingId }: { orgId: string; pendingId: string }) {
  const msg = useMsg();
  const router = useRouter();
  const [channels, setChannels] = useState<{ id: string; title: string }[] | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A second tap on the same render is refused here — `busy` state has not disabled the button yet on that render.
  const saving = useRef(false);

  useEffect(() => {
    let live = true;
    apiV1<YoutubePendingChannels>(`/api/v1/orgs/${orgId}/youtube-connections/pending/${pendingId}`)
      .then((r) => {
        if (live) setChannels(r.channels);
      })
      .catch((err: unknown) => {
        if (live) setError(pickerRefusalText(msg, err));
      });
    return () => {
      live = false;
    };
  }, [orgId, pendingId, msg]);

  const cancel = () => router.replace(STREAMING_PAGE_HREF);
  const connect = async () => {
    if (choice === null || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await apiV1<YoutubeConnectionSaved>(`/api/v1/orgs/${orgId}/youtube-connections`, { method: "POST", json: { pendingId, channelId: choice } });
      // A channel the organisation already had keeps the visibility and audience it was connected with (the choices made before
      // Google went unused), and the person is told so. Only an explicit `true` says it: an answer without the flag is plain.
      router.replace(youtubeLanding(saved.existing === true ? "already_connected" : "connected"));
    } catch (err) {
      const gone = wireOf(err)?.status;
      // The grant is gone (used, expired, not this person's): nothing here can connect any more, so the list and Connect leave and
      // Cancel is the way on - the state the lookup's own refusal leaves. Any other refusal leaves the grant alive, and the list too.
      if (gone === 404 || gone === 410) setChannels(null);
      setError(pickerRefusalText(msg, err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <section data-testid="youtube-picker" aria-label={msg("streaming.youtube.picker.title")} className="card space-y-4 p-5 max-md:p-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{msg("streaming.youtube.picker.title")}</h2>
        {channels !== null && channels.length > 0 && (
          <p className="mt-1 max-w-xl text-sm text-slate-600">{msg("streaming.youtube.picker.body", { count: channels.length })}</p>
        )}
      </div>
      {channels === null && error === null && <p data-testid="youtube-picker-loading" className="text-sm text-slate-600">{msg("streaming.youtube.picker.loading")}</p>}
      {channels !== null && channels.length === 0 && errorLine(msg("streaming.youtube.landing.no_channel"))}
      {channels !== null && channels.length > 0 && (
        <fieldset className={FIELDSET}>
          <legend className="sr-only">{msg("streaming.youtube.picker.title")}</legend>
          <div className="grid gap-2">
            {channels.map((c) => (
              <label
                key={c.id}
                className={`flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm ${choice === c.id ? "border-purple-300 bg-purple-50" : "border-slate-200 bg-white"}`}
              >
                <input type="radio" name="channel" value={c.id} data-testid="youtube-picker-channel" checked={choice === c.id} onChange={() => setChoice(c.id)} className="h-4 w-4 shrink-0 accent-purple-600" />
                <span className="min-w-0 truncate font-medium text-slate-900">{c.title}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && errorLine(error)}
      <div className="flex gap-2 max-md:flex-col">
        {channels !== null && channels.length > 0 && (
          <button type="button" data-testid="youtube-picker-connect" disabled={choice === null || busy} onClick={() => void connect()} className="btn btn-primary min-h-11">
            {msg("streaming.youtube.picker.connect")}
          </button>
        )}
        <button type="button" data-testid="youtube-picker-cancel" onClick={cancel} className="btn btn-ghost min-h-11">
          {msg("streamDest.cancel")}
        </button>
      </div>
    </section>
  );
}

// ─── a connected channel's row ──────────────────────────────────────────────────────────────────────────────────────────

type Tone = "ok" | "warn" | "bad" | "neutral";
export type ChannelStatus = { tone: Tone; pill: MessageKey; line: MessageKey; hint: MessageKey | null };

/** What a connection says about itself, in words. A channel is called connected-and-ready ONLY for `connected` + `enabled`; a
 *  `liveState` that is `unknown`, or one this build does not know (the wire may grow a value), reads as NOT CHECKED — it never
 *  claims the channel can go live (T8 M1). A `status` other than `connected` fails closed the same way: reconnect. */
export function channelStatus(y: Pick<NonNullable<StreamTarget["youtube"]>, "status" | "liveState">): ChannelStatus {
  if (y.status !== "connected") {
    return { tone: "bad", pill: "streaming.youtube.status.reconnectNeeded", line: "streaming.youtube.statusLine.reconnectNeeded", hint: null };
  }
  switch (y.liveState) {
    case "enabled":
      return { tone: "ok", pill: "streaming.youtube.status.connected", line: "streaming.youtube.statusLine.connected", hint: null };
    case "not_enabled":
      return { tone: "warn", pill: "streaming.youtube.status.notEnabled", line: "streaming.youtube.statusLine.notEnabled", hint: "streaming.youtube.notEnabledHint" };
    case "blocked":
      return { tone: "bad", pill: "streaming.youtube.status.blocked", line: "streaming.youtube.statusLine.blocked", hint: null };
    default:
      return { tone: "neutral", pill: "streaming.youtube.status.unknown", line: "streaming.youtube.statusLine.unknown", hint: null };
  }
}

const TONE: Record<Tone, { pill: string; dot: string }> = {
  ok: { pill: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  warn: { pill: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  bad: { pill: "bg-red-50 text-red-700 ring-red-200", dot: "bg-red-500" },
  neutral: { pill: "bg-slate-50 text-slate-700 ring-slate-200", dot: "bg-slate-400" },
};

const ACTION = "btn min-h-11 px-3 max-md:w-full";

export function YoutubeChannelRow({ t, canEdit, orgId, badge }: { t: StreamTarget; canEdit: boolean; orgId: string; badge: ReactNode }) {
  const msg = useMsg();
  const router = useRouter();
  const y = t.youtube;
  const [mode, setMode] = useState<"settings" | "terms" | null>(null);
  const [privacy, setPrivacy] = useState<YoutubePrivacy>(y?.privacy ?? "unlisted");
  const [kids, setKids] = useState<"0" | "1">(y?.madeForKids ? "1" : "0");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  if (!y) return null;

  const status = channelStatus(y);
  const tone = TONE[status.tone];
  const reconnect = y.status !== "connected";
  const reviewFirst = reconnect && y.termsOutdated;
  const meta = `${msg(PRIVACY_KEY[y.privacy])} · ${msg(y.madeForKids ? "streaming.youtube.row.kidsYes" : "streaming.youtube.row.kidsNo")}`;
  const changed = privacy !== y.privacy || (kids === "1") !== y.madeForKids;

  const patch = async (body: { privacy: YoutubePrivacy; madeForKids: boolean } | { consent: true }) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/orgs/${orgId}/youtube-connections/${y.connectionId}`, { method: "PATCH", json: body });
      setMode(null);
      setConsent(false);
      router.refresh();
    } catch (err) {
      // A connection that is gone (a second tab disconnected it) is the list's news, not an error to sit under a dead row.
      if (wireOf(err)?.status === 404) router.refresh();
      setError(youtubeErrorText(msg, err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const open = (which: "settings" | "terms") => {
    setError(null);
    setConsent(false);
    setPrivacy(y.privacy);
    setKids(y.madeForKids ? "1" : "0");
    setMode((m) => (m === which ? null : which));
  };

  return (
    <li data-testid="youtube-channel-row" data-connection-id={y.connectionId} data-target-id={t.id} data-tone={status.tone} className="px-4 py-3">
      <div className="flex items-start gap-3">
        <PlatformMark kind="youtube" size="md" />
        <div className="min-w-0 flex-1">
          <p data-testid="youtube-channel-title" className="truncate font-semibold text-slate-900">{y.channelTitle}</p>
          <p data-testid="youtube-channel-meta" className="truncate text-xs text-slate-600">{meta}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span data-testid="youtube-channel-status" className={`badge inline-flex items-center gap-1.5 normal-case ring-1 ${tone.pill}`}>
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
              {msg(status.pill)}
            </span>
            {y.termsOutdated && (
              <span data-testid="youtube-channel-terms" className="badge inline-flex items-center normal-case ring-1 bg-amber-50 text-amber-800 ring-amber-200">
                {msg("streaming.youtube.status.reviewTerms")}
              </span>
            )}
          </div>
          <p data-testid="youtube-channel-line" className="mt-1.5 text-sm text-slate-700">
            {msg(status.line)}
            {status.hint && <span data-testid="youtube-channel-hint">{` ${msg(status.hint)}`}</span>}
          </p>
          {y.termsOutdated && (
            <p data-testid="youtube-channel-terms-line" className="mt-1 text-sm text-slate-700">
              {msg(reviewFirst ? "streaming.youtube.statusLine.reviewFirst" : "streaming.youtube.statusLine.reviewTerms")}
            </p>
          )}
          {badge && <div className="min-w-0">{badge}</div>}
        </div>
      </div>
      {canEdit && (
        <div data-role="youtube-channel-actions" className="mt-3 flex flex-wrap gap-2 max-md:flex-col md:pl-11">
          {reconnect && !y.termsOutdated && (
            // Reconnect is a navigation to Google, so a form POST (T7). The consent on file is current: no tick (ruling T7-R2).
            <form method="post" action="/api/youtube/connect" data-testid="youtube-reconnect-form" className="max-md:w-full">
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="connectionId" value={y.connectionId} />
              <input type="hidden" name="privacy" value={y.privacy} />
              <input type="hidden" name="madeForKids" value={y.madeForKids ? "1" : "0"} />
              <button type="submit" data-testid="youtube-reconnect" className={`${ACTION} btn-primary`}>
                {msg("streaming.youtube.action.reconnect")}
              </button>
            </form>
          )}
          {y.termsOutdated && (
            <button type="button" data-testid="youtube-review-terms" aria-expanded={mode === "terms"} onClick={() => open("terms")} className={`${ACTION} ${reviewFirst ? "btn-primary" : "text-slate-700 hover:bg-purple-50"}`}>
              {msg("streaming.youtube.action.reviewTerms")}
            </button>
          )}
          <button type="button" data-testid="youtube-settings" aria-expanded={mode === "settings"} onClick={() => open("settings")} className={`${ACTION} text-slate-700 hover:bg-purple-50`}>
            {msg("streaming.youtube.action.settings")}
          </button>
        </div>
      )}
      {canEdit && mode === "settings" && (
        <form
          data-testid="youtube-settings-form"
          aria-label={msg("streaming.youtube.action.settings")}
          className="mt-3 space-y-4 md:pl-11"
          onSubmit={(e) => {
            e.preventDefault();
            if (!changed) return;
            void patch({ privacy, madeForKids: kids === "1" });
          }}
        >
          <PrivacyChoice value={privacy} onChange={setPrivacy} />
          <KidsChoice value={kids} onChange={setKids} />
          <div className="flex gap-2 max-md:flex-col">
            <button type="submit" data-testid="youtube-settings-save" disabled={!changed || busy} className="btn btn-primary min-h-11">
              {msg("streaming.youtube.settings.save")}
            </button>
            <button type="button" data-testid="youtube-settings-cancel" onClick={() => setMode(null)} className="btn btn-ghost min-h-11">
              {msg("streamDest.cancel")}
            </button>
          </div>
        </form>
      )}
      {canEdit && mode === "terms" && (
        <form
          data-testid="youtube-terms-form"
          aria-label={msg("streaming.youtube.action.reviewTerms")}
          className="mt-3 space-y-3 md:pl-11"
          onSubmit={(e) => {
            e.preventDefault();
            if (!consent) return;
            void patch({ consent: true });
          }}
        >
          <ConsentBox checked={consent} onChange={setConsent} withName={false} />
          <div className="flex gap-2 max-md:flex-col">
            <button type="submit" data-testid="youtube-terms-accept" disabled={!consent || busy} className="btn btn-primary min-h-11">
              {msg("streaming.youtube.action.acceptTerms")}
            </button>
            <button type="button" data-testid="youtube-terms-cancel" onClick={() => setMode(null)} className="btn btn-ghost min-h-11">
              {msg("streamDest.cancel")}
            </button>
          </div>
        </form>
      )}
      {error && <div className="mt-3 md:pl-11">{errorLine(error)}</div>}
    </li>
  );
}
