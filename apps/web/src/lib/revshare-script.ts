// Revshare's tracking.js: when it may be loaded, and what it can ever see.
//
// What the script does (www.revshare.so/tracking.js, read 2026-11-26; it is a third party's file and can change):
//  - it runs once, when it executes (or at DOMContentLoaded). Off a Shopify store it hooks no pushState, popstate,
//    hashchange or timer (its MutationObserver and fetch wrapper need window.Shopify);
//  - it keeps `{url: location.href, path, referrer: document.referrer, …}` in localStorage
//    `revshare_visits_<program>` (last 50) and logs each one;
//  - on a first `?via=` / `?ref=` (no first-click cookie yet) it POSTs location.href, document.referrer and that whole
//    history (`previous_visits`) to revshare.so, then clears it.
// Our URLs carry credentials (/score/<token>, /claim/<secret>, /magic-link?token=, …), so:
//  1. the history is purged on EVERY page load, script or not, flag on or off, before the script could read it;
//  2. the tag is added only on an affiliate landing: a public page (isAffiliateLandingPath) whose address and referrer
//     hold nothing credential-like. The decision runs in the browser, so the HTML stays the same for every visitor;
//  3. it reads the address when it EXECUTES, which is after step 2. So a document that has the tag never takes an
//     address it may not see: a client-side navigation there becomes a full page load, and the new document decides for
//     itself. This lasts as long as the document does, which also covers a later version of the script that hooks
//     navigation.
// Attribution needs only COOKIES: the script's own `revshare_ref_/last_/cid_/uid_/uid2_<program>` and our `rs_ref`
// (captureRevshareRef below, read by lib/revshare.ts). None of that localStorage history is needed.
import { holdsCredential } from "./scrub-score-url";
import { REVSHARE_PROGRAM_ID, isAffiliateLandingPath, revshareCookieString } from "./revshare-shared";

declare global {
  interface Window {
    revshare_metadata?: { ref_code?: string };
  }
}

export const REVSHARE_SCRIPT_SRC = "https://www.revshare.so/tracking.js";
const VISITS_PREFIX = "revshare_visits_";
/** The parameters tracking.js reads an affiliate code from. */
const AFFILIATE_PARAMS = ["via", "ref"] as const;

/**
 * A parameter no affiliate landing has a use for and which holds, or may hold, a secret or a person's address. WIDER than
 * the telemetry scrubber on purpose: that one leaves some values visible (the reusable registration `?token=`, an OAuth
 * `code=`), which is right for our own telemetry and wrong for a third party. Refusing costs one attribution; letting
 * one through sends it out. (`t=` is not here: a video offset is fine, and the scrubber knows a room token by shape.)
 */
const SECRET_PARAM = /(?:^|[?&#;])(?:token|st|key|code|state|join|secret|sig|signature|otp|nonce|rid|session_id|email|password|[a-z0-9_]+_(?:token|code|secret|key))=/i;

/** The value and each further percent-decoding of it (a `next=` inside a `next=`). */
function decodings(value: string): string[] {
  const out = [value];
  for (let depth = 0; depth < 6; depth++) {
    const last = out[out.length - 1]!;
    const next = last.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === last) break;
    out.push(next);
  }
  return out;
}

/** Does this URL carry something a third party must not be told? The scrubber's own predicate, plus `SECRET_PARAM`. */
export function carriesSecret(url: string): boolean {
  return decodings(url).some((v) => holdsCredential(v) || SECRET_PARAM.test(v));
}

/** May the script be in front of this address of ours? */
function mayBeSeen(url: URL): boolean {
  return isAffiliateLandingPath(url.pathname) && !carriesSecret(url.href);
}

const parse = (value: string): URL | null => (URL.canParse(value) ? new URL(value) : null);

/** Is this page load an affiliate landing the script may run on? */
export function shouldLoadRevshare({ href, referrer }: { href: string; referrer: string }): boolean {
  const url = parse(href);
  if (!url || !AFFILIATE_PARAMS.some((p) => url.searchParams.get(p)) || !mayBeSeen(url)) return false;
  if (referrer === "") return true;
  const from = parse(referrer);
  if (!from) return false;
  // Our own referrer arrives whole, so it must be a page the script could have run on. Another site's cannot be held to
  // our routes: it is refused for what it carries.
  return from.origin === url.origin ? mayBeSeen(from) : !carriesSecret(referrer);
}

/** Remove every stored visit history. False only when a history may be left behind. */
export function purgeRevshareVisits(win: Window): boolean {
  let storage: Storage;
  try {
    storage = win.localStorage;
  } catch {
    return true; // storage is blocked: the script cannot read it either
  }
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(VISITS_PREFIX)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** The script's first-click cookie, or undefined. */
function firstClickRef(cookies: string): string | undefined {
  const prefix = `revshare_ref_${REVSHARE_PROGRAM_ID}=`;
  const pair = cookies.split("; ").find((c) => c.startsWith(prefix));
  if (!pair) return undefined;
  try {
    return decodeURIComponent(pair.slice(prefix.length));
  } catch {
    return undefined;
  }
}

/**
 * Copy the ref_code into our first-party `rs_ref` cookie: the running script's answer, else the first-click cookie it
 * left on an earlier landing (which is what it would answer here; this page does not load it). True once written.
 */
export function captureRevshareRef(win: Window): boolean {
  const code = win.revshare_metadata?.ref_code ?? firstClickRef(win.document.cookie);
  const cookie = revshareCookieString(code, win.location.protocol);
  if (cookie) win.document.cookie = cookie;
  return cookie !== null;
}

/** Step 3 of the header: from now on this document's address stays one the script may see. */
function holdAddress(win: Window): void {
  const { history } = win;
  // Next writes the same URL more than once per navigation; the second write must not restart the load. That memory is
  // only good while the load can still replace this document: kept longer, it would swallow the next click on the same
  // link, and the router would render that page HERE, under this address.
  let leavingFor: string | null = null;
  const forget = () => {
    leavingFor = null;
  };
  // Left, then restored from the back/forward cache with this memory intact.
  win.addEventListener("pageshow", (event) => {
    if (event.persisted) forget();
  });
  // A stopped load, or an answer with no page, fires nothing: the person's next press is a new request.
  for (const input of ["pointerdown", "keydown"]) win.addEventListener(input, forget, true);
  for (const [method, go] of [["pushState", "assign"], ["replaceState", "replace"]] as const) {
    const write = history[method];
    history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      if (url) {
        const next = new URL(url, win.location.href);
        // Another origin is left to the browser, which refuses it.
        if (next.origin === win.location.origin && !mayBeSeen(next)) {
          if (leavingFor !== next.href) {
            leavingFor = next.href;
            win.location[go](next.href);
          }
          return;
        }
      }
      write.call(history, data, unused, url);
    };
  }
  // Back or Forward has already changed the address. Reload it as a fresh document, and keep the event from any
  // listener added after this one (the script's would be).
  win.addEventListener("popstate", (event) => {
    forget(); // a traversal within this document overtakes a load that is under way
    if (mayBeSeen(new URL(win.location.href))) return;
    event.stopImmediatePropagation();
    win.location.reload();
  });
}

/** Run once per page load (components/revshare-capture.tsx). The purge comes first, whatever follows. */
export function mountRevshare(win: Window, enabled: boolean): void {
  const purged = purgeRevshareVisits(win);
  if (!enabled || !purged) return;
  if (!shouldLoadRevshare({ href: win.location.href, referrer: win.document.referrer })) return;
  if (win.document.querySelector(`script[src="${REVSHARE_SCRIPT_SRC}"]`)) return;
  holdAddress(win);
  const script = win.document.createElement("script");
  script.async = true;
  script.src = REVSHARE_SCRIPT_SRC;
  script.setAttribute("data-program-id", REVSHARE_PROGRAM_ID);
  script.setAttribute("data-domain", ".seazn.club");
  script.setAttribute("data-cookie-duration", "30");
  // At once, not on the next poll: a quick full navigation would lose the script's answer with the window.
  script.onload = () => {
    captureRevshareRef(win);
  };
  win.document.head.appendChild(script);
}
