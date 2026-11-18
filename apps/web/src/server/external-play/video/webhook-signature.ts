// Check-in capacity plan 1, Task 4 (spec §6.2, Global Constraints): RealtimeKit webhook signature verification and the key cache.
//
// The ONLY gate on a public, unauthenticated route (Task 7). The signature is `rtk-signature`, Base64 RSA-SHA256
// (RSASSA-PKCS1-v1_5) over the RAW request body BYTES: the receiver hands in the bytes exactly as read
// (`Buffer.from(await req.arrayBuffer())`), never `req.text()` (which strips a BOM and replaces invalid UTF-8) and never a
// re-serialized JSON value. The public key is never stored or configured: it is read from Cloudflare's published document when
// the vendor base is Cloudflare's own (the same gate `cfEnvelope` meters by), else from the base URL's own origin. So the key
// host is Cloudflare's unless the operator sets REALTIMEKIT_BASE_URL to another base (a fixture, or a proxy): that env var, not
// this module, is what keeps production on Cloudflare's key.
//
// Outbound calls are bounded because the route is public: on Cloudflare's base a forced refetch (a verification failure) and any
// attempt after a FAILED attempt happen at most once per WEBHOOK_KEY_REFETCH_MIN_MS per process, concurrent asks share one fetch,
// every fetch has a timeout and refuses any redirect. `fetched` tells the receiver whether a fresh key was fetched for this call: a fresh key that still
// refuses is a 401; no fresh key (floored, or the fetch failed) is a retryable 503, so a delivery signed under a just-rotated key
// is retried by the vendor rather than lost (the vendor never retries a 4xx).
import "server-only";
import { KeyObject, createPublicKey, verify } from "node:crypto";
import { log } from "@/server/logger";
import { CF_BASE, baseUrlOf } from "./realtimekit";

export const REALTIMEKIT_WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
export const WEBHOOK_KEY_TTL_MS = 24 * 60 * 60_000;
export const WEBHOOK_KEY_REFETCH_MIN_MS = 60_000;
/** A hanging key host must not hang the public route. */
const KEY_FETCH_TIMEOUT_MS = 5_000;

/** No key could be had for this call: none cached and the fetch failed or was floored, or the vendor base is not a URL. The
 *  receiver answers 503 (retryable). */
export class WebhookKeyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebhookKeyUnavailableError";
  }
}

/** The served key in any of the shapes a vendor may use, as a KeyObject: a PEM (SPKI or PKCS#1, real or `\n`-escaped newlines) or bare
 *  base64 DER (SPKI). null when none of them imports, or when the key is not RSA (the signature is RSASSA-PKCS1-v1_5). The ONE
 *  normalizer; the key cache and the staging check both use it. */
export function importWebhookPublicKey(served: string): KeyObject | null {
  if (typeof served !== "string") return null;
  const text = served.replace(/\\n/g, "\n");
  let key: KeyObject;
  try {
    // createPublicKey reads both "PUBLIC KEY" (SPKI) and "RSA PUBLIC KEY" (PKCS#1) armour
    if (text.includes("-----BEGIN")) key = createPublicKey(text);
    // bare base64 DER; garbage decodes to bytes that are not a DER key, and createPublicKey refuses them
    else key = createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
  } catch {
    return null;
  }
  return key.asymmetricKeyType === "rsa" ? key : null;
}

/** RSA-SHA256 over the raw body BYTES (a string is taken as its UTF-8 bytes), Base64 signature, against `served`: the cached
 *  KeyObject `webhookPublicKey` returns (no re-parse per delivery), or a served string through `importWebhookPublicKey`. False on
 *  any malformed input (a missing header included); never throws. */
export function verifyRealtimeKitSignature(
  rawBody: string | Uint8Array,
  signatureB64: string | null | undefined,
  served: string | KeyObject,
): boolean {
  const key = served instanceof KeyObject ? served : importWebhookPublicKey(served);
  if (key === null) return false;
  try {
    const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    // a missing header (null), an empty or non-Base64 signature and a body of another type all throw or read false in here
    return verify("RSA-SHA256", bytes, key, Buffer.from(signatureB64 as string, "base64"));
  } catch {
    return false;
  }
}

const normalizeBase = (baseUrl: string) => baseUrl.replace(/\/$/, "");

/** Cloudflare's base (realtimekit.ts CF_BASE) → REALTIMEKIT_WEBHOOK_KEY_URL; any other base → `${new URL(base).origin}/.well-known/webhooks.json`.
 *  Throws (TypeError) on a base that is not a URL; `webhookPublicKey` turns that into WebhookKeyUnavailableError. */
export function webhookKeyUrl(baseUrl: string): string {
  if (normalizeBase(baseUrl) === CF_BASE) return REALTIMEKIT_WEBHOOK_KEY_URL;
  return `${new URL(baseUrl).origin}/.well-known/webhooks.json`;
}

/** The key cached for ONE key URL: a key fetched for another base is never served for this one. */
let cached: { url: string; key: string; publicKey: KeyObject; fetchedAt: number } | null = null;
/** When the last forced or failed attempt for a URL began: the floor window on Cloudflare's base runs from it. */
let floorFrom: { url: string; at: number } | null = null;
/** The fetch in flight for a URL, shared by every concurrent ask. */
let inflight: { url: string; promise: Promise<Served> } | null = null;

type Served = { key: string; publicKey: KeyObject };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function fetchKeyDocument(url: string, fetchImpl: typeof fetch): Promise<Served> {
  // A redirect is not the key host speaking: it is refused (fetch rejects), never followed to whatever it points at.
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook key document: HTTP ${res.status}`);
  const doc = (await res.json()) as unknown;
  const publicKey = isRecord(doc) && isRecord(doc.data) ? doc.data.publicKey : undefined;
  if (typeof publicKey !== "string") throw new Error("webhook key document carries no data.publicKey string");
  const imported = importWebhookPublicKey(publicKey);
  if (imported === null) throw new Error("webhook key document's publicKey does not import as an RSA public key");
  return { key: publicKey, publicKey: imported };
}

/** The fetch in flight for `url`, or a new one. `started` is true only for the ask that began it: a joiner's fetch began BEFORE
 *  it asked, so what it brings back is not fresh for that ask (a key rotated in between is not in it). */
function sharedFetch(url: string, fetchImpl: typeof fetch): { promise: Promise<Served>; started: boolean } {
  if (inflight !== null && inflight.url === url) return { promise: inflight.promise, started: false };
  const promise = fetchKeyDocument(url, fetchImpl).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { url, promise };
  return { promise, started: true };
}

/** The served key string (and its imported KeyObject, `publicKey`, to verify with) for the process's vendor base (`baseUrlOf({})` read AT CALL TIME unless `opts.baseUrl`), cached; refetched after
 *  WEBHOOK_KEY_TTL_MS, or on `force`: at most once per WEBHOOK_KEY_REFETCH_MIN_MS when the base is CF_BASE (a forced ask inside that
 *  window returns the cached key without fetching), and every time for any other base (a fixture's key changes per start). A fetch
 *  failure with a cached key returns the cached key and logs; with none it throws. `fetched` says whether THIS call fetched a fresh
 *  key: false when served from the cache (unforced inside the TTL, floor-suppressed, or a failed fetch falling back to the cache) and
 *  for an ask that JOINED a fetch already in flight (it began before the ask, so a rotation in between is not in it), so
 *  the receiver can tell "a fresh key still refuses" (401) from "no fresh key was fetched" (503, Global Constraints).
 *  On CF_BASE a FAILED attempt also opens the floor window, so a down key host is asked at most once a minute however many
 *  deliveries (or forgeries) arrive. */
export async function webhookPublicKey(
  opts: { fetch?: typeof fetch; baseUrl?: string; now?: number; force?: boolean } = {},
): Promise<{ key: string; publicKey: KeyObject; fetched: boolean }> {
  const base = normalizeBase(opts.baseUrl ?? baseUrlOf({}));
  let url: string;
  try {
    url = webhookKeyUrl(base);
  } catch (err) {
    throw new WebhookKeyUnavailableError(`RealtimeKit webhook key: the vendor base ${JSON.stringify(base)} is not a URL`, { cause: err });
  }
  const now = opts.now ?? Date.now();
  const have = cached !== null && cached.url === url ? cached : null;

  if (have !== null && !opts.force && now - have.fetchedAt < WEBHOOK_KEY_TTL_MS) return { key: have.key, publicKey: have.publicKey, fetched: false };

  if (base === CF_BASE && floorFrom !== null && floorFrom.url === url && now - floorFrom.at < WEBHOOK_KEY_REFETCH_MIN_MS) {
    if (have !== null) return { key: have.key, publicKey: have.publicKey, fetched: false };
    throw new WebhookKeyUnavailableError("RealtimeKit webhook key: none cached and the last attempt failed under a minute ago");
  }
  if (opts.force) floorFrom = { url, at: now };

  try {
    const { promise, started } = sharedFetch(url, opts.fetch ?? fetch);
    const served = await promise;
    cached = { url, ...served, fetchedAt: now };
    return { ...served, fetched: started };
  } catch (err) {
    floorFrom = { url, at: now };
    if (have !== null) {
      log.warn({ err, url }, "RealtimeKit webhook key: refetch failed, verifying with the cached key");
      return { key: have.key, publicKey: have.publicKey, fetched: false };
    }
    throw new WebhookKeyUnavailableError(`RealtimeKit webhook key: fetch from ${url} failed and none is cached`, { cause: err });
  }
}

/** Test seam: forgets the cached key, the floor window and any fetch in flight. */
export function forgetWebhookKey(): void {
  cached = null;
  floorFrom = null;
  inflight = null;
}
