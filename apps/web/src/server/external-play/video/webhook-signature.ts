// Check-in capacity plan 1, Task 4 (spec §6.2, Global Constraints): RealtimeKit webhook signature verification and the key cache.
//
// The ONLY gate on a public, unauthenticated route (Task 7). The signature is `rtk-signature`, Base64 RSA-SHA256
// (RSASSA-PKCS1-v1_5) over the RAW request body bytes: the receiver hands in the body text exactly as read, never a
// re-serialized JSON value. The public key is never stored or configured: it is read from Cloudflare's published document when
// the vendor base is Cloudflare's own (the same gate `cfEnvelope` meters by), else from the base URL's own origin (a fixture),
// so production can never be pointed at a test key.
//
// Outbound calls are bounded because the route is public: on Cloudflare's base a forced refetch (a verification failure) and any
// attempt after a FAILED attempt happen at most once per WEBHOOK_KEY_REFETCH_MIN_MS per process, concurrent asks share one fetch,
// and every fetch has a timeout. `fetched` tells the receiver whether a fresh key was fetched for this call: a fresh key that still
// refuses is a 401; no fresh key (floored, or the fetch failed) is a retryable 503, so a delivery signed under a just-rotated key
// is retried by the vendor rather than lost (the vendor never retries a 4xx).
import "server-only";
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { log } from "@/server/logger";
import { CF_BASE, baseUrlOf } from "./realtimekit";

export const REALTIMEKIT_WEBHOOK_KEY_URL = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
export const WEBHOOK_KEY_TTL_MS = 24 * 60 * 60_000;
export const WEBHOOK_KEY_REFETCH_MIN_MS = 60_000;
/** A hanging key host must not hang the public route. */
const KEY_FETCH_TIMEOUT_MS = 5_000;

/** No key could be had for this call: none cached and the fetch failed or was floored. The receiver answers 503 (retryable). */
export class WebhookKeyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WebhookKeyUnavailableError";
  }
}

/** The served key in any of the shapes a vendor may use, as a KeyObject: a PEM (SPKI or PKCS#1, real or `\n`-escaped newlines) or bare
 *  base64 DER (SPKI). null when none of them imports. The ONE normalizer; the verifier and the staging check both use it. */
export function importWebhookPublicKey(served: string): KeyObject | null {
  if (typeof served !== "string") return null;
  const text = served.replace(/\\n/g, "\n");
  try {
    // createPublicKey reads both "PUBLIC KEY" (SPKI) and "RSA PUBLIC KEY" (PKCS#1) armour
    if (text.includes("-----BEGIN")) return createPublicKey(text);
    // bare base64 DER; garbage decodes to bytes that are not a DER key, and createPublicKey refuses them
    return createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** RSA-SHA256 over the raw body bytes, Base64 signature, against `importWebhookPublicKey(served)`. False on any malformed input
 *  (a missing header included); never throws. */
export function verifyRealtimeKitSignature(rawBody: string, signatureB64: string | null | undefined, served: string): boolean {
  const key = importWebhookPublicKey(served);
  if (key === null) return false;
  try {
    // a missing header (null), an empty or non-Base64 signature and a non-string body all throw or read false in here
    return verify("RSA-SHA256", Buffer.from(rawBody, "utf8"), key, Buffer.from(signatureB64 as string, "base64"));
  } catch {
    return false;
  }
}

const normalizeBase = (baseUrl: string) => baseUrl.replace(/\/$/, "");

/** Cloudflare's base (realtimekit.ts CF_BASE) → REALTIMEKIT_WEBHOOK_KEY_URL; any other base → `${new URL(base).origin}/.well-known/webhooks.json`. */
export function webhookKeyUrl(baseUrl: string): string {
  if (normalizeBase(baseUrl) === CF_BASE) return REALTIMEKIT_WEBHOOK_KEY_URL;
  return `${new URL(baseUrl).origin}/.well-known/webhooks.json`;
}

/** The key cached for ONE key URL: a key fetched for another base is never served for this one. */
let cached: { url: string; key: string; fetchedAt: number } | null = null;
/** When the last forced or failed attempt for a URL began: the floor window on Cloudflare's base runs from it. */
let floorFrom: { url: string; at: number } | null = null;
/** The fetch in flight for a URL, shared by every concurrent ask. */
let inflight: { url: string; promise: Promise<string> } | null = null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function fetchKeyDocument(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS) });
  // A redirect off the key host's origin is not the key host speaking: never use what it serves.
  if (res.url && new URL(res.url).origin !== new URL(url).origin) {
    throw new Error(`webhook key document answered from ${new URL(res.url).origin}, not ${new URL(url).origin}`);
  }
  if (!res.ok) throw new Error(`webhook key document: HTTP ${res.status}`);
  const doc = (await res.json()) as unknown;
  const publicKey = isRecord(doc) && isRecord(doc.data) ? doc.data.publicKey : undefined;
  if (typeof publicKey !== "string") throw new Error("webhook key document carries no data.publicKey string");
  if (importWebhookPublicKey(publicKey) === null) throw new Error("webhook key document's publicKey does not import as a public key");
  return publicKey;
}

function sharedFetch(url: string, fetchImpl: typeof fetch): Promise<string> {
  if (inflight !== null && inflight.url === url) return inflight.promise;
  const promise = fetchKeyDocument(url, fetchImpl).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { url, promise };
  return promise;
}

/** The served key string for the process's vendor base (`baseUrlOf({})` read AT CALL TIME unless `opts.baseUrl`), cached; refetched after
 *  WEBHOOK_KEY_TTL_MS, or on `force`: at most once per WEBHOOK_KEY_REFETCH_MIN_MS when the base is CF_BASE (a forced ask inside that
 *  window returns the cached key without fetching), and every time for any other base (a fixture's key changes per start). A fetch
 *  failure with a cached key returns the cached key and logs; with none it throws. `fetched` says whether THIS call fetched a fresh
 *  key: false when served from the cache (unforced inside the TTL, floor-suppressed, or a failed fetch falling back to the cache), so
 *  the receiver can tell "a fresh key still refuses" (401) from "no fresh key was fetched" (503, Global Constraints).
 *  On CF_BASE a FAILED attempt also opens the floor window, so a down key host is asked at most once a minute however many
 *  deliveries (or forgeries) arrive. */
export async function webhookPublicKey(
  opts: { fetch?: typeof fetch; baseUrl?: string; now?: number; force?: boolean } = {},
): Promise<{ key: string; fetched: boolean }> {
  const base = normalizeBase(opts.baseUrl ?? baseUrlOf({}));
  const url = webhookKeyUrl(base);
  const now = opts.now ?? Date.now();
  const have = cached !== null && cached.url === url ? cached : null;

  if (have !== null && !opts.force && now - have.fetchedAt < WEBHOOK_KEY_TTL_MS) return { key: have.key, fetched: false };

  if (base === CF_BASE && floorFrom !== null && floorFrom.url === url && now - floorFrom.at < WEBHOOK_KEY_REFETCH_MIN_MS) {
    if (have !== null) return { key: have.key, fetched: false };
    throw new WebhookKeyUnavailableError("RealtimeKit webhook key: none cached and the last attempt failed under a minute ago");
  }
  if (opts.force) floorFrom = { url, at: now };

  try {
    const key = await sharedFetch(url, opts.fetch ?? fetch);
    cached = { url, key, fetchedAt: now };
    return { key, fetched: true };
  } catch (err) {
    floorFrom = { url, at: now };
    if (have !== null) {
      log.warn({ err, url }, "RealtimeKit webhook key: refetch failed, verifying with the cached key");
      return { key: have.key, fetched: false };
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
