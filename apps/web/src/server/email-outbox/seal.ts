import "server-only";
// The body of an outbox email at rest (spec "Credentials at rest"). The html and text of a sign-in or invite email
// carry a live credential, so they are stored only as the repo's own envelope (server/relay/crypto.ts, AES-256-GCM
// with a per-row data key) sealed under LICHESS_TOKEN_KEK, the application KEK that is already on stg and prod.
// This module is the outbox's only user of that key.
import { hasValidKek, openWith, sealWith } from "@/server/relay/crypto";

export type EmailBody = { html: string; text: string };

/** Raised by `sealBody` when the box can send mail but cannot protect the body. Callers let it propagate: the enqueue
 *  runs inside the caller's transaction, so the whole operation refuses instead of queueing a row that can only die. */
export class OutboxKeyUnavailableError extends Error {
  readonly code = "EMAIL_OUTBOX_KEK_MISSING";
  constructor() {
    super(
      "email outbox: LICHESS_TOKEN_KEK is unset or malformed (64 hex characters), so the email body cannot be sealed " +
        "while a RESEND_API_KEY is set; refusing to queue the email",
    );
    this.name = "OutboxKeyUnavailableError";
  }
}

/**
 * Seal `{ html, text }`. Returns null ONLY when the KEK is unusable AND no Resend key is set: that box (local dev, CI)
 * could not send the row anyway, and the attempt ends it `dead` with `no_api_key`. With a Resend key set and no usable
 * KEK this throws instead: queueing a bodiless row there would turn a configuration fault into a quiet `body_missing`
 * on every email.
 */
export function sealBody(b: EmailBody): Buffer | null {
  if (hasValidKek("LICHESS_TOKEN_KEK")) return sealWith("LICHESS_TOKEN_KEK", JSON.stringify({ html: b.html, text: b.text }));
  if (process.env.RESEND_API_KEY) throw new OutboxKeyUnavailableError();
  return null;
}

/** Open a sealed body. Throws on an unusable or rotated key, damaged bytes, or an envelope that is not an
 *  `{ html, text }` pair; the attempt reads any throw as `body_unreadable`. */
export function openBody(sealed: Uint8Array): EmailBody {
  const parsed = JSON.parse(openWith("LICHESS_TOKEN_KEK", sealed)) as { html?: unknown; text?: unknown } | null;
  // One check for every wrong shape: null, a number, an array and an object missing a field all fail it.
  if (typeof parsed?.html !== "string" || typeof parsed.text !== "string") throw new Error("outbox body is not an { html, text } pair");
  return { html: parsed.html, text: parsed.text };
}
