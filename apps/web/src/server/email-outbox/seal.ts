import "server-only";
// The body of an outbox email at rest (spec "Credentials at rest"). The html and text of a sign-in or invite email
// carry a live credential, so they are stored only as the repo's own envelope (server/relay/crypto.ts, AES-256-GCM
// with a per-row data key) sealed under EMAIL_OUTBOX_KEK, a key of the outbox's own (owner ruling R13). It is NOT the
// Lichess key and never falls back to it: rotating LICHESS_TOKEN_KEK must not strand queued email, and a leaked Lichess
// key must not open sign-in links. This module is the outbox's only user of the key.
import { hasValidKek, openWith, sealWith, type KekName } from "@/server/relay/crypto";

export type EmailBody = { html: string; text: string };

/** The outbox's key. Typed against `KekName`, so crypto.ts is the one list of envelope keys. */
export const OUTBOX_KEK = "EMAIL_OUTBOX_KEK" satisfies KekName;

/** The sample key published in apps/web/.env.example so a developer's copy can seal. It is public, so a production
 *  server holding it protects nothing: `outboxKeyProblem` refuses it under NODE_ENV=production. The example file and this
 *  constant are one fact in two places; env-example-outbox-kek.test.ts reads the file and requires them equal. */
export const SAMPLE_OUTBOX_KEK = "0123456789abcdef".repeat(4);

/** Why this box cannot seal an email body: `unset` (the key is missing or malformed while a Resend key is set, so the
 *  box can send mail it cannot protect) or `sample` (the published sample key under NODE_ENV=production). */
export type OutboxKeyProblem = "unset" | "sample";

/**
 * The ONE rule for "may this box queue an email?", shared by `sealBody` (which throws on it, per email) and the boot check
 * (which reports it once, before a user hits sign-in), so the two can never disagree. `null` means the box is fine:
 *  - a usable key that is not the production-refused sample: bodies are sealed;
 *  - no usable key AND no Resend key (local dev, CI): the box could not send the row anyway, so it may queue a row with no
 *    body, which the attempt ends `dead` with `no_api_key`.
 * A usable key that is the sample, under NODE_ENV=production, is a problem whether or not a Resend key is set.
 */
export function outboxKeyProblem(): OutboxKeyProblem | null {
  if (hasValidKek(OUTBOX_KEK)) {
    const isSample = process.env[OUTBOX_KEK]!.toLowerCase() === SAMPLE_OUTBOX_KEK;
    return isSample && process.env.NODE_ENV === "production" ? "sample" : null;
  }
  return process.env.RESEND_API_KEY ? "unset" : null;
}

const MESSAGES: Record<OutboxKeyProblem, { code: string; message: string }> = {
  unset: {
    code: "EMAIL_OUTBOX_KEK_MISSING",
    message:
      "email outbox: EMAIL_OUTBOX_KEK is unset or malformed (64 hex characters), so the email body cannot be sealed " +
      "while a RESEND_API_KEY is set; refusing to queue the email",
  },
  sample: {
    code: "EMAIL_OUTBOX_KEK_SAMPLE",
    message:
      "email outbox: EMAIL_OUTBOX_KEK is the sample key published in apps/web/.env.example, which is refused when " +
      "NODE_ENV=production; set a key of your own (openssl rand -hex 32); refusing to queue the email",
  },
};

/** Raised by `sealBody` when the box cannot protect the body (`outboxKeyProblem`). Callers let it propagate: the enqueue
 *  runs inside the caller's transaction, so the whole operation refuses instead of queueing a row that can only die. The
 *  message names the variable and never a value. */
export class OutboxKeyUnavailableError extends Error {
  readonly code: string;
  constructor(readonly problem: OutboxKeyProblem = "unset") {
    super(MESSAGES[problem].message);
    this.code = MESSAGES[problem].code;
    this.name = "OutboxKeyUnavailableError";
  }
}

/**
 * Seal `{ html, text }`. Returns null ONLY when the key is unusable AND no Resend key is set: that box (local dev, CI)
 * could not send the row anyway, and the attempt ends it `dead` with `no_api_key`. Every other unusable state throws
 * (`OutboxKeyUnavailableError`, see `outboxKeyProblem`): queueing a bodiless row where mail CAN be sent would turn a
 * configuration fault into a quiet `body_missing` on every email.
 */
export function sealBody(b: EmailBody): Buffer | null {
  const problem = outboxKeyProblem();
  if (problem) throw new OutboxKeyUnavailableError(problem);
  if (!hasValidKek(OUTBOX_KEK)) return null;
  return sealWith(OUTBOX_KEK, JSON.stringify({ html: b.html, text: b.text }));
}

/** Open a sealed body. Throws on an unusable or rotated key, damaged bytes, or an envelope that is not an
 *  `{ html, text }` pair; the attempt reads any throw as `body_unreadable`. */
export function openBody(sealed: Uint8Array): EmailBody {
  const parsed = JSON.parse(openWith(OUTBOX_KEK, sealed)) as { html?: unknown; text?: unknown } | null;
  // One check for every wrong shape: null, a number, an array and an object missing a field all fail it.
  if (typeof parsed?.html !== "string" || typeof parsed.text !== "string") throw new Error("outbox body is not an { html, text } pair");
  return { html: parsed.html, text: parsed.text };
}
