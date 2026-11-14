// Cloudflare Turnstile, browser half, as plain TypeScript with no React and no DOM beyond what is handed in, so the part that
// can go wrong (a token that is single-use, a widget that is slow, a script that never loads) is unit-testable in the node
// vitest environment. `components/turnstile-widget.tsx` is the thin React shell around it.
import { TURNSTILE_HEADER, type TurnstileAction } from "@/lib/turnstile";

/** The slice of Cloudflare's `window.turnstile` this app calls (developers.cloudflare.com/turnstile/get-started/client-side-rendering). */
export interface TurnstileApi {
  render(container: HTMLElement, params: TurnstileRenderParams): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

export interface TurnstileRenderParams {
  sitekey: string;
  action: TurnstileAction;
  /** `interaction-only`: the widget is invisible unless Cloudflare needs the visitor to do something. */
  appearance: "interaction-only";
  /** `flexible` fills its container but never goes below 300px, so a narrower container (a 320px phone inside a padded card)
   *  gets `compact` (150px) instead of a widget wider than the page. */
  size: "flexible" | "compact";
  language: string;
  callback: (token: string) => void;
  "error-callback": (code?: string) => boolean | void;
  /** `auto` (Cloudflare's default, passed explicitly): the widget refreshes an expired token itself. */
  "refresh-expired": "auto";
  "expired-callback": () => void;
  "timeout-callback": () => void;
  /** Cloudflare's documented bracket around the time the widget shows the visitor a box to tick. */
  "before-interactive-callback": () => void;
  "after-interactive-callback": () => void;
}

export interface TurnstileMountView {
  language: string;
  /** The container's available width in px; below `FLEXIBLE_MIN_WIDTH` the widget renders `compact`. */
  width: number;
}

/** Cloudflare's documented floor for `size: "flexible"`. */
export const FLEXIBLE_MIN_WIDTH = 300;

/** How long `token()` waits for a widget that has not produced one yet: the invisible challenge normally takes a second or
 *  two; an interactive one needs the visitor. Past this the request goes without a token and the server answers for it. */
export const TOKEN_WAIT_MS = 20_000;

/** The oldest token `token()` hands out. Cloudflare documents a token as valid for 300 s (and single-use); this is that less a
 *  30 s margin for the request's own flight. A form that arms its widget when it OPENS (the register stepper) can hold a token
 *  for minutes before the submit, so an older one is treated as absent: the widget is re-armed and the request waits for a fresh
 *  token rather than sending one siteverify will refuse. */
export const TOKEN_MAX_AGE_MS = 270_000;

export interface TurnstileController {
  /** Render the widget into `container`. Safe to call again after `unmount()` (React strict mode, a step that leaves and returns). */
  mount(container: HTMLElement, view: TurnstileMountView): void;
  unmount(): void;
  /** The current token. Resolves at once if there is one no older than `TOKEN_MAX_AGE_MS` and not reported expired; a dead one
   *  is dropped and the widget re-armed. A widget that errored earlier is re-armed too. Otherwise waits (up to `TOKEN_WAIT_MS`) for the widget to
   *  produce one; null when there is no widget to wait for (no site key, the script never loaded), it errors again while waited
   *  on, or time ran out. Never rejects. */
  token(): Promise<string | null>;
  /** A token is single-use: forget it and have the widget fetch a fresh one (`turnstile.reset(widgetId)`). */
  reset(): void;
  /** True while the widget shows the visitor a box to tick (between Cloudflare's before- and after-interactive callbacks) and
   *  no token is held: `token()` could then only wait out `TOKEN_WAIT_MS`, so a form shows the box instead of posting. False
   *  with no widget, for the invisible check, once a token arrives, after an error, a reset or an unmount. */
  awaitingVisitor(): boolean;
  /** Bring the widget's container to the middle of the screen and focus it (the container carries `tabIndex={-1}`), so the
   *  visitor sees the box to tick. Nothing before a mount or after an unmount. */
  reveal(): void;
}

export function createTurnstileController(opts: {
  /** `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; empty means "no widget": `mount` renders nothing and `token()` is null at once. */
  siteKey: string;
  action: TurnstileAction;
  load: () => Promise<TurnstileApi>;
  waitMs?: number;
  /** Test seams. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** The clock a token's age is read on (ms). */
  now?: () => number;
}): TurnstileController {
  const { siteKey, action, load } = opts;
  const waitMs = opts.waitMs ?? TOKEN_WAIT_MS;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const now = opts.now ?? Date.now;

  let api: TurnstileApi | null = null;
  let widgetId: string | null = null;
  /** The token the widget last produced, with when it arrived. It may still be sent only while it is young (`TOKEN_MAX_AGE_MS`)
   *  and Cloudflare has not reported it expired (`expired`, set by the expired-callback). */
  let held: { token: string; at: number; expired?: true } | null = null;
  let failed = false;
  /** Inside Cloudflare's interactive phase: a box is on screen for the visitor to tick. */
  let interactive = false;
  /** The container the widget was rendered into, for `reveal`. */
  let box: HTMLElement | null = null;
  /** Bumped by every mount and unmount, so a `load()` that resolves after the widget was torn down renders nothing. */
  let generation = 0;
  const waiters = new Set<(t: string | null) => void>();

  const settle = (t: string | null) => {
    for (const w of [...waiters]) w(t);
  };
  /** Forget the token and have the widget run a fresh challenge (`turnstile.reset(widgetId)`); the next callback brings the token. */
  const rearm = () => {
    held = null;
    failed = false;
    // A fresh challenge runs; if it needs the visitor, Cloudflare says so again (before-interactive).
    interactive = false;
    if (api && widgetId !== null) api.reset(widgetId);
  };

  return {
    mount(container, view) {
      if (!siteKey) return;
      const mine = ++generation;
      failed = false;
      interactive = false;
      box = container;
      void load().then(
        (loaded) => {
          if (mine !== generation) return;
          api = loaded;
          widgetId = loaded.render(container, {
            sitekey: siteKey,
            action,
            appearance: "interaction-only",
            size: view.width < FLEXIBLE_MIN_WIDTH ? "compact" : "flexible",
            language: view.language,
            "refresh-expired": "auto",
            callback: (t) => {
              held = { token: t, at: now() };
              failed = false;
              // A token ends the interactive phase even if after-interactive never comes, so its later (invisible) refresh
              // never reads as a box to tick.
              interactive = false;
              settle(t);
            },
            // Cloudflare retries most failures itself and calls back with a token afterwards, so an error is only "failed
            // for now": it releases anyone waiting (they send without a token) and is cleared by the next good callback, or by
            // the next `token()`, which re-arms a widget still failed (B1 fix round 1, review M3).
            "error-callback": () => {
              held = null;
              failed = true;
              settle(null);
            },
            // Expired (300 s since issue): MARK the held token dead, never send it again. `refresh-expired: "auto"` has Cloudflare
            // refresh the widget itself, and its `callback` replaces the token; a reset here as well started a SECOND refresh on top
            // (B1 fix round 1, review M4). Only nulling it was not enough either: if that refresh never comes (a backgrounded tab, a
            // refresh that fails quietly) there was nothing left for `token()` to re-arm from, and a submit after a long idle waited
            // TOKEN_WAIT_MS and went tokenless into 403 (round 2, review N1). A request that finds the mark re-arms and waits.
            "expired-callback": () => {
              if (held) held = { ...held, expired: true };
            },
            "timeout-callback": () => {
              held = null;
            },
            "before-interactive-callback": () => {
              interactive = true;
            },
            "after-interactive-callback": () => {
              interactive = false;
            },
          });
        },
        () => {
          if (mine !== generation) return;
          failed = true;
          settle(null);
        },
      );
    },

    unmount() {
      const mine = ++generation;
      if (api && widgetId !== null) api.remove(widgetId);
      widgetId = null;
      held = null;
      interactive = false;
      box = null;
      // Whoever is waiting for a token is released with null only if NOTHING mounts straight after. React strict mode (dev) runs
      // an effect as mount, unmount, mount in one synchronous pass, and a click that arms the widget and asks for its token in the
      // same handler (resend) already has a `token()` waiting when that in-between unmount lands: releasing it there sent the
      // request with no token. One microtask is enough, the pass being synchronous; `mount()` bumps `generation`, which cancels this.
      // A real unmount (a step that leaves, a form that is replaced) has no mount after it, so the release still happens.
      queueMicrotask(() => {
        if (mine === generation) settle(null);
      });
    },

    token() {
      if (!siteKey) return Promise.resolve(null);
      // A dead token (reported expired, or older than TOKEN_MAX_AGE_MS) is treated as absent: re-arm, then wait below for the fresh
      // one. Cloudflare's own refresh, when it lands first, has already replaced it, so this resets only when that did not happen.
      if (held && (held.expired || now() - held.at > TOKEN_MAX_AGE_MS)) rearm();
      if (held?.token) return Promise.resolve(held.token);
      if (failed) {
        // No widget to re-arm (the script never loaded: a content blocker, no network): go without a token, at once.
        if (!api || widgetId === null) return Promise.resolve(null);
        // The widget errored and nothing has recovered it since. A form that arms at OPEN can sit in that state for minutes, and
        // answering null would send its first submit tokenless (403 TURNSTILE_FAILED, B1 fix round 1, review M3): re-arm, then wait
        // below for the fresh challenge, as bounded as any other wait. A second caller finds `failed` cleared and just waits.
        rearm();
      }
      return new Promise<string | null>((resolve) => {
        const done = (t: string | null) => {
          clearT(timer);
          waiters.delete(done);
          resolve(t);
        };
        const timer = setT(() => done(null), waitMs);
        waiters.add(done);
      });
    },

    reset: rearm,

    awaitingVisitor() {
      return interactive && held === null && !failed;
    },

    reveal() {
      if (!box) return;
      box.scrollIntoView({ block: "center" });
      box.focus({ preventScroll: true });
    },
  };
}

/** Anything `withTurnstile` can drive: the controller, or a stand-in. */
export type TurnstileTokenSource = Pick<TurnstileController, "token" | "reset">;

/**
 * Run one guarded request. Reads the widget's token, hands the request the header it travels in (none when there is no token:
 * the server answers for that), and, whatever the request did, resets the widget afterwards: the token was spent the moment it
 * was sent, success or failure, so the NEXT attempt needs a fresh one.
 *
 *     await withTurnstile(turnstile, (headers) => api("/api/auth/magic-link", { method: "POST", json, headers }));
 */
export async function withTurnstile<T>(
  source: TurnstileTokenSource | null | undefined,
  send: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const token = source ? await source.token() : null;
  try {
    return await send(token ? { [TURNSTILE_HEADER]: token } : {});
  } finally {
    source?.reset();
  }
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Load Cloudflare's script once per page, with explicit rendering. A failed load (a content blocker, no network) is not
 *  cached, so the next mount tries again. */
export function loadTurnstileApi(): Promise<TurnstileApi> {
  if (typeof window === "undefined") return Promise.reject(new Error("turnstile: no window"));
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else {
        scriptPromise = null;
        reject(new Error("turnstile: script loaded without window.turnstile"));
      }
    };
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new Error("turnstile: script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
