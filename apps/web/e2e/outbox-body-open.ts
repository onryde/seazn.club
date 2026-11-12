// Player payment page (plan 2026-11-11-player-payment-page, Task 5): read a chase mail's pay link out of the email outbox.
// The runner cannot import src/server/email-outbox/seal.ts (`server-only`), so the envelope is opened here, byte for byte the
// layout src/server/relay/crypto.ts writes ([0x01][wrap IV 12][wrapped DEK 32][wrap tag 16][data IV 12][data tag 16][body],
// AES-256-GCM, the DEK wrapped under EMAIL_OUTBOX_KEK) - as e2e/lichess-token-seal.ts mirrors its sealer.
// src/server/email-outbox/__tests__/e2e-outbox-opener.test.ts proves this opens what the product's `sealBody` sealed.
//
// What it needs from the environment, or it reads nothing:
//  - EMAIL_OUTBOX_KEK: the SAME 64-hex value the server under test runs with. Without it the server queues bodiless rows.
//  - a row that still HOLDS its body: the outbox drops a body the moment a row is attempted (sent, dead, suppressed - and a
//    box with no Resend key ends every attempt `dead`). So read a row the WORKER owns (the sweep's reminders, kind
//    `payment_reminder`), not one the request path attempted at once (the organiser's reminder).
// Pure node: no Playwright import, so the smoke runner can use it too.
import { createDecipheriv } from "node:crypto";

const VERSION = 0x01;
const HEADER_LEN = 89;
const KEK_HEX = /^[0-9a-f]{64}$/i;

/** Open a sealed `email_outbox.body_sealed` into its `{ html, text }` pair. Throws on a missing/malformed key, a wrong key,
 *  damaged bytes or a body that is not the pair. */
export function openOutboxBody(sealed: Uint8Array): { html: string; text: string } {
  const hex = process.env.EMAIL_OUTBOX_KEK ?? "";
  if (!KEK_HEX.test(hex)) {
    throw new Error(
      "openOutboxBody: EMAIL_OUTBOX_KEK must be 64 hex characters, and the SAME value the server under test runs with " +
        "(otherwise the server queues bodiless rows, or rows this runner cannot open)",
    );
  }
  const b = Buffer.from(sealed);
  if (b.length < HEADER_LEN) throw new Error("openOutboxBody: envelope too short");
  if (b[0] !== VERSION) throw new Error(`openOutboxBody: envelope version ${b[0]} is not supported`);
  const unwrap = createDecipheriv("aes-256-gcm", Buffer.from(hex, "hex"), b.subarray(1, 13));
  unwrap.setAuthTag(b.subarray(45, 61));
  const dek = Buffer.concat([unwrap.update(b.subarray(13, 45)), unwrap.final()]);
  const data = createDecipheriv("aes-256-gcm", dek, b.subarray(61, 73));
  data.setAuthTag(b.subarray(73, 89));
  const parsed = JSON.parse(Buffer.concat([data.update(b.subarray(89)), data.final()]).toString("utf8")) as {
    html?: unknown;
    text?: unknown;
  } | null;
  if (typeof parsed?.html !== "string" || typeof parsed.text !== "string") {
    throw new Error("openOutboxBody: the body is not an { html, text } pair");
  }
  return { html: parsed.html, text: parsed.text };
}

/** The newest row of (kind, ref), opened. Throws when there is no row, or when its body is gone (say which, with the status). */
export async function latestOutboxBody(kind: string, refType: string, refId: string): Promise<{ html: string; text: string }> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("latestOutboxBody: DATABASE_URL is required (the same DB the server under test uses)");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    const [row] = await sql<{ body_sealed: Uint8Array | null; status: string }[]>`
      select body_sealed, status from email_outbox
       where kind = ${kind} and ref_type = ${refType} and ref_id = ${refId}
       order by created_at desc, id desc
       limit 1`;
    if (!row) throw new Error(`latestOutboxBody: no ${kind} row for ${refType}/${refId}`);
    if (!row.body_sealed) {
      throw new Error(
        `latestOutboxBody: the newest ${kind} row for ${refType}/${refId} holds no body (status ${row.status}) - ` +
          "it was attempted already, or the server has no EMAIL_OUTBOX_KEK",
      );
    }
    return openOutboxBody(row.body_sealed);
  } finally {
    await sql.end();
  }
}

const PAY_HREF = /href="([^"]*\/r\/pay\/[A-Za-z0-9_-]+)"/g;

/** The one `/r/pay/<token>` link a mail's html carries (it may appear more than once: a button and its fallback). Throws when
 *  there is none, or when two different ones appear. */
export function payLinkFrom(html: string): string {
  const links = [...new Set([...html.matchAll(PAY_HREF)].map((m) => m[1]!.replace(/&amp;/g, "&")))];
  if (links.length === 0) throw new Error("payLinkFrom: no /r/pay/ link in the mail");
  if (links.length > 1) throw new Error(`payLinkFrom: ${links.length} different /r/pay/ links in the mail`);
  return links[0]!;
}
