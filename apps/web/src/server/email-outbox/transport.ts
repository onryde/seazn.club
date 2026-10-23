// The outbox's one network seam, and the only module the tests replace (`vi.mock("@/server/email-outbox/transport")`).
//
// Rulings R5 and R8: the attempt asks `checkSendable` FIRST (API key, suppression), opens the sealed body only if the
// answer is yes, and then calls this. So this does NOT gate again, and it does not wrap `sendWithResult`: that would
// re-check the list the attempt already consulted. The key travels as its own argument, never inside the message, so a
// message can be logged or compared in a test without carrying a credential.
import { deliver as postToResend, type DeliverResult } from "@/lib/email";
import { SEND_TIMEOUT_MS } from "./constants";

export type DeliverMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  transactional: boolean;
  /** `email-outbox/<row id>`: the same row sends under the same key on every attempt. */
  idempotencyKey: string;
  /** `{ outbox: <row id> }`: lets the webhook find a row whose 2xx carried no message id (ruling R8). */
  tags: Record<string, string>;
};

export async function deliver(m: DeliverMessage, apiKey: string): Promise<DeliverResult> {
  // logDetail: false (R8): a failed request logs its status and Resend's error name, never the raw response text.
  return postToResend({ ...m, timeoutMs: SEND_TIMEOUT_MS }, apiKey, { logDetail: false });
}
