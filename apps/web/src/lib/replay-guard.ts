// Sentry Replay and the credentials in a page's URL.
//
// A replay records the page's URL in places no Sentry hook reaches (@sentry/replay 10.62, read from the installed source and
// pinned in __tests__/sentry-replay-guard.test.ts):
//  - rrweb's Meta frame (`href: window.location.href`), written at the first full snapshot and at every checkout (every 60 s in
//    buffer mode): `beforeAddRecordingEvent` only ever sees CUSTOM frames (`maybeApplyCallback` -> `isCustomEvent`);
//  - the DOM snapshot and its mutations, whose attributes (`href`, `data-*`) are masked only for `title`, `placeholder` and
//    `aria-label`.
// Two defences, one per kind of field:
//  - what a hook CAN reach is scrubbed: Custom frames by `recordingEventHook` (the same `scrubRecordingEvent`), the
//    `replay_event` (its `urls` and `request.url`) by the ScrubScoreTokens event processor;
//  - what none can reach is not recorded: an element that paints a secret carries `ph-no-capture` and the replay blocks that
//    class (`REPLAY_BLOCK_SELECTORS`), and the replay does not run on a page whose URL holds a credential (`holdsCredential`,
//    the scrubber's own predicate: a URL it would change). It is not started on such a page, it is stopped before the app
//    navigates to one (`onRouterTransitionStart`), and it is stopped when the replay's own navigation frame names one (a
//    redirect the router did not announce).
// Once stopped it stays stopped for that page load; the next load samples afresh.
import { getClient, type ReplayFrameEvent } from "@sentry/nextjs";
import { holdsCredential, scrubRecordingEvent } from "@/lib/scrub-score-url";

/** The elements the replay blocks: the class PostHog replay already blocks (components/v2/seazn-qr-image.tsx, the painters scan). */
export const REPLAY_BLOCK_SELECTORS = [".ph-no-capture"];

/** The part of Sentry's Replay integration this module drives. */
export interface StoppableReplay {
  stop(): Promise<void>;
}

// @sentry/nextjs re-exports `Integration` from neither its client nor its server entry; the client's own lookup type is the way in.
type ClientIntegration = NonNullable<ReturnType<NonNullable<ReturnType<typeof getClient>>["getIntegrationByName"]>>;

/** The name the Replay integration registers under (`replayIntegration()` returns `name: "Replay"`; pinned in sentry-replay-guard.test). */
export const REPLAY_INTEGRATION_NAME = "Replay";

/**
 * The Replay integration of the initialised client, or undefined when Sentry is not initialised (the case today: see
 * instrumentation-client.ts). This is `getReplay()`'s own body, spelled out on purpose: importing `getReplay` references
 * @sentry/replay and rrweb (~23 KB gzipped), and this module is in the first-load chunk of every page through
 * instrumentation-client.ts. `getClient` and the integration lookup pull none of it.
 */
const currentReplay = (): StoppableReplay | undefined => getClient()?.getIntegrationByName<ClientIntegration & StoppableReplay>(REPLAY_INTEGRATION_NAME);

/** May the replay run on this page? `undefined` is no page at all (the server), which never records. */
export function replayMayRunAt(href: string | undefined): boolean {
  return href === undefined || !holdsCredential(href);
}

/** Stop outside the recorder's own add path (the hook runs inside it); a failed stop must not surface. */
function stopSoon(replay: StoppableReplay | undefined): void {
  void Promise.resolve()
    .then(() => replay?.stop())
    .catch(() => undefined);
}

/** `onRouterTransitionStart`: the app is about to navigate to `href`. True when `href` holds a credential (the replay, if there is one, is asked to stop). */
export function stopReplayBeforeNavigatingTo(href: string, replay: StoppableReplay | undefined = currentReplay()): boolean {
  if (!holdsCredential(href)) return false;
  stopSoon(replay);
  return true;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined);

/**
 * The URL a navigation frame names (a history or navigation span's `description`, a navigation breadcrumb's `to`), or
 * undefined for any other frame. Tolerant of a shape it does not know: a throw inside `beforeAddRecordingEvent` makes the SDK
 * drop the frame without a word.
 */
function navigationTarget(event: ReplayFrameEvent): string | undefined {
  const data = asRecord(asRecord(event)?.data);
  const payload = asRecord(data?.payload);
  if (!payload) return undefined;
  if (data?.tag === "performanceSpan") {
    const { op, description } = payload;
    return typeof op === "string" && op.startsWith("navigation.") && typeof description === "string" ? description : undefined;
  }
  if (data?.tag === "breadcrumb" && payload.category === "navigation") {
    const to = asRecord(payload.data)?.to;
    return typeof to === "string" ? to : undefined;
  }
  return undefined;
}

/**
 * Sentry Replay `beforeAddRecordingEvent`. A navigation frame that names a credential URL stops the replay and is dropped
 * (the router can arrive on one without announcing it: a redirect); every other frame is scrubbed.
 */
export function recordingEventHook(event: ReplayFrameEvent, replay: StoppableReplay | undefined = currentReplay()): ReplayFrameEvent | null {
  const target = navigationTarget(event);
  if (target !== undefined && holdsCredential(target)) {
    stopSoon(replay);
    return null;
  }
  return scrubRecordingEvent(event);
}
