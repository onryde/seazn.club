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
  "expired-callback": () => void;
  "timeout-callback": () => void;
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

export interface TurnstileController {
  /** Render the widget into `container`. Safe to call again after `unmount()` (React strict mode, a step that leaves and returns). */
  mount(container: HTMLElement, view: TurnstileMountView): void;
  unmount(): void;
  /** The current token. Resolves at once if there is one; otherwise waits (up to `TOKEN_WAIT_MS`) for the widget to produce one;
   *  null when there is no widget to wait for (no site key), it failed, or time ran out. Never rejects. */
  token(): Promise<string | null>;
  /** A token is single-use: forget it and have the widget fetch a fresh one (`turnstile.reset(widgetId)`). */
  reset(): void;
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
}): TurnstileController {
  const { siteKey, action, load } = opts;
  const waitMs = opts.waitMs ?? TOKEN_WAIT_MS;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;

  let api: TurnstileApi | null = null;
  let widgetId: string | null = null;
  let token: string | null = null;
  let failed = false;
  /** Bumped by every mount and unmount, so a `load()` that resolves after the widget was torn down renders nothing. */
  let generation = 0;
  const waiters = new Set<(t: string | null) => void>();

  const settle = (t: string | null) => {
    for (const w of [...waiters]) w(t);
  };

  return {
    mount(container, view) {
      if (!siteKey) return;
      const mine = ++generation;
      failed = false;
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
            callback: (t) => {
              token = t;
              failed = false;
              settle(t);
            },
            // Cloudflare retries most failures itself and calls back with a token afterwards, so an error is only "failed
            // for now": it releases anyone waiting (they send without a token) and is cleared by the next good callback.
            "error-callback": () => {
              token = null;
              failed = true;
              settle(null);
            },
            "expired-callback": () => {
              token = null;
            },
            "timeout-callback": () => {
              token = null;
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
      token = null;
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
      if (token) return Promise.resolve(token);
      if (failed) return Promise.resolve(null);
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

    reset() {
      token = null;
      failed = false;
      if (api && widgetId !== null) api.reset(widgetId);
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
