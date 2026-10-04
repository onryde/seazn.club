// api-v1's response envelope — ONE authority, read by HttpDriver and by the
// browser layer's respond.ts (W1c Task 4), so a UI action and an HTTP call
// turn the product's answer into the same data or the same RefusedCall.
// Moved verbatim out of http-driver.ts (its `#unwrap` body, `errorOf` and the
// envelope shape); http-driver.test.ts pins the behaviour, `extra` included.
import { RefusedCall } from "./types.ts";

/** api-v1's envelope (server/api-v1/http.ts): `{ok:true, data}` or
 *  `{ok:false, error:{code, message, ...extra}}` — errorResponse spreads an
 *  error's extra beside code and message: `current_seq` (a SEQ_CONFLICT),
 *  `feature_key` (a 402), `next_match` (NEXT_MATCH_STARTED), and more. A
 *  non-v1 or non-JSON answer can carry a bare string `error`; it then yields
 *  no code. */
export interface Envelope { ok?: boolean; data?: unknown; error?: Record<string, unknown> | string | null }

/** The envelope's error fields RefusedCall carries as its own; every other one is its `extra` (W1b carry c). */
const OWN_ERROR_FIELDS: ReadonlySet<string> = new Set(["code", "message", "current_seq", "feature_key"]);

const errorFieldsOf = (body: unknown): Record<string, unknown> | string | null => (body as Envelope | null)?.error ?? null;

export interface EnvelopeError { code?: string; message?: string; current_seq?: number; feature_key?: string }

/** The error fields RefusedCall reads as its own, typed; absent ones stay absent. */
export function errorOf(body: unknown): EnvelopeError {
  const e = errorFieldsOf(body);
  if (typeof e === "string") return { message: e };
  if (e === null || typeof e !== "object") return {};
  const out: EnvelopeError = {};
  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.message === "string") out.message = e.message;
  if (typeof e.current_seq === "number") out.current_seq = e.current_seq;
  if (typeof e.feature_key === "string") out.feature_key = e.feature_key;
  return out;
}

export const is2xx = (status: number): boolean => status >= 200 && status < 300;

/** The envelope's `data` on a 2xx; otherwise the RefusedCall the product's
 *  answer amounts to. A 2xx with no `data` is refused too (NO_DATA): a
 *  scenario must never read `undefined` as a result. */
export function unwrapEnvelope<T>(method: string, path: string, status: number, body: unknown): T {
  if (!is2xx(status)) {
    const e = errorOf(body);
    // Every other field of the error rides on the refusal as `extra` (W1b
    // carry c: NEXT_MATCH_STARTED's `next_match`); RefusedCall redacts it.
    const fields = errorFieldsOf(body);
    const rest = typeof fields === "object" && fields !== null ? Object.entries(fields).filter(([k]) => !OWN_ERROR_FIELDS.has(k)) : [];
    throw new RefusedCall(method, path, status, e.code ?? null, e.message ?? null, e.feature_key ?? null, rest.length === 0 ? null : Object.fromEntries(rest));
  }
  const data = (body as Envelope | null)?.data;
  if (data === undefined) throw new RefusedCall(method, path, status, "NO_DATA", "response carried no data");
  return data as T;
}
