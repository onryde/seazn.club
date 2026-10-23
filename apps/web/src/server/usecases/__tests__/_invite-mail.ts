// The email seam of every test that opens a round or resends an invite (Task 7). The invite no longer goes through a sender
// that returns a boolean: it is RENDERED (`externalPlayInviteEmail`), written to the outbox in the open's transaction, and sent
// after commit through the outbox's one network seam (`@/server/email-outbox/transport` `deliver`). So a test now replaces two
// modules, and this file holds what both replacements share:
//
//   vi.mock("@/lib/email", async (importOriginal) => {
//     const actual = await importOriginal<typeof import("@/lib/email")>();
//     const h = await import("<path>/_invite-mail");
//     return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
//   });
//   vi.mock("@/server/email-outbox/transport", async () => {
//     const h = await import("<path>/_invite-mail");
//     return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
//   });
//   beforeEach(() => stubOutboxEnv());
//
// Each test file keeps its own `vi.hoisted` `mail` object (the shape `InviteMail` below), so a file declares only the sets it
// uses. The rendered email carries its inputs as JSON in `text`, which is how `deliverForTest` sees the link and the labels the
// invite named (the old stub read them from the sender's arguments). The REAL outbox runs around it: the row is written, the
// attempt claims it, the gate asks for an API key, the verdict is classified, the hook releases a seat that ended badly.
import { vi } from "vitest";
import type { EmailContent } from "@/lib/email";
import type { DeliverMessage } from "@/server/email-outbox/transport";

/** One email the "provider" accepted. A superset of what any one file asserts on. */
export type SentInvite = {
  to: string;
  fixtureUrl: string;
  opponentName: string;
  roundNo: number;
  deadlineLabel: string;
  opensLabel: string | undefined;
  locale: string;
};

export type InviteMail = {
  sent: SentInvite[];
  /** Addresses the provider refuses for good (a 422): the row ends `dead` and the seat is released. */
  fail: Set<string>;
  /** Addresses whose send THROWS out of the transport (the attempt reads it as a network failure and retries). */
  throws?: Set<string>;
  /** Addresses the provider answers 503 for: the row is retried later and its seat stays stamped. */
  retry?: Set<string>;
  /** Addresses the provider answers 429 for: the dispatch stops at the first one, and the seats after it are left queued. */
  rateLimit?: Set<string>;
  /** The FIRST send to this address waits on `gate` (staging for a race). */
  holdFirst?: null | { to: string; gate: Promise<void>; reached: () => void };
};

/** What `externalPlayInviteEmail` is replaced by: the arguments, as JSON in the body. */
export async function renderInviteForTest(
  to: string,
  args: { fixtureUrl: string; opponentName: string; roundNo: number; deadlineLabel: string; opensLabel?: string | undefined },
  locale: string = "en",
): Promise<EmailContent> {
  const text = JSON.stringify({ to, args, locale });
  return { subject: `test invite ${args.roundNo}`, html: `<p>${args.fixtureUrl}</p>`, text };
}

/** What the transport's `deliver` is replaced by: the provider's answer for this address. */
export async function deliverForTest(
  mail: InviteMail,
  msg: DeliverMessage,
): Promise<
  | { ok: true; providerId: string }
  | { ok: false; reason: "http"; status: number; errorName: string | null; detail: string }
> {
  const hold = mail.holdFirst;
  if (hold && hold.to === msg.to) {
    mail.holdFirst = null;
    hold.reached();
    await hold.gate;
  }
  if (mail.throws?.has(msg.to)) throw new Error("provider exploded");
  if (mail.fail.has(msg.to)) return { ok: false, reason: "http", status: 422, errorName: "validation_error", detail: "refused" };
  if (mail.retry?.has(msg.to)) return { ok: false, reason: "http", status: 503, errorName: "service_unavailable", detail: "later" };
  if (mail.rateLimit?.has(msg.to)) return { ok: false, reason: "http", status: 429, errorName: "rate_limit_exceeded", detail: "slow down" };
  const { args, locale } = JSON.parse(msg.text) as { args: SentInvite; locale: string };
  mail.sent.push({
    to: msg.to,
    fixtureUrl: args.fixtureUrl,
    opponentName: args.opponentName,
    roundNo: args.roundNo,
    deadlineLabel: args.deadlineLabel,
    opensLabel: args.opensLabel,
    locale,
  });
  // One message id per accepted email: the outbox keeps it unique per row (email_outbox_provider_idx).
  return { ok: true, providerId: `re_test_${crypto.randomUUID()}` };
}

/** For a file that only asserts WHO was mailed: its `mail.sent` holds the addresses the provider accepted, as the old sender's
 *  stub recorded them. Everything else is `deliverForTest`'s. */
export async function deliverToAddresses(
  mail: Omit<InviteMail, "sent"> & { sent: string[] },
  msg: DeliverMessage,
): ReturnType<typeof deliverForTest> {
  const accepted: InviteMail = { ...mail, sent: [] };
  const verdict = await deliverForTest(accepted, msg);
  mail.sent.push(...accepted.sent.map((m) => m.to));
  return verdict;
}

/** A key of the outbox's own and a Resend key, so the outbox seals the body and the gate lets the attempt through. */
const OUTBOX_KEK_FOR_TESTS = "cd".repeat(32);
const realFetch = globalThis.fetch;

/**
 * Stub the environment the outbox needs to queue and attempt a row: `EMAIL_OUTBOX_KEK` (the body is sealed) and a
 * `RESEND_API_KEY` (vitest strips the real one, and without one the gate ends every row `dead` / `no_api_key`).
 * With a key set, any OTHER code a test reaches that mails through `lib/email` would call Resend; global `fetch` is wrapped so
 * a request to api.resend.com answers 200 locally and every other request goes where it went before.
 */
export function stubOutboxEnv(): void {
  vi.stubEnv("EMAIL_OUTBOX_KEK", OUTBOX_KEK_FOR_TESTS);
  vi.stubEnv("RESEND_API_KEY", "re_test_invite_harness");
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url, "http://localhost").hostname === "api.resend.com") {
      return Promise.resolve(new Response(JSON.stringify({ id: `re_test_${crypto.randomUUID()}` }), { status: 200 }));
    }
    return realFetch(input, init);
  });
}
