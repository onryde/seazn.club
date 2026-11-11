// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { newSession, check, html } from "../harness.ts";

/** Player payment page (plan 2026-11-11-player-payment-page, Task 4) - what only the served app can prove.
 *
 *  `GET /r/pay/<unknown token>` is the ONE opaque not-found, in the reader's language, and does not fall into `/r/[ref]`
 *  (a six-character reference lookup): the static `pay` segment must win. The "Pay on a paid entry answers 409" check moves to
 *  Task 5, the first task where a producer issues a real token (a hand-inserted token hash is forbidden).
 *
 *  Keyless-safe; no org, no Stripe. */
export async function registrationPayPageSuite() {
  const en = JSON.parse(readFileSync(new URL("../../../apps/web/src/dictionaries/en/ui.json", import.meta.url), "utf8")) as Record<string, string>;
  const body = en["regPay.notFound.body"];
  // React escapes text nodes: `isn't` is served as `isn&#x27;t`.
  const served = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
  check("pay page smoke: the not-found copy exists in en/ui.json", typeof body === "string" && body.length > 0);

  const token = randomBytes(32).toString("base64url"); // 43 characters, well-formed, unknown
  check("pay page smoke: the probe token is 43 characters", token.length === 43);
  const page = await html(newSession(), `/r/pay/${token}`);
  check("pay page smoke: an unknown token answers 404", page.status === 404);
  check("pay page smoke: the 404 carries the opaque not-found copy", page.body.includes(served(body)));
  // (The 404's flight payload does echo the visitor's own URL back to them; that leaks nothing, so it is not asserted either way.)
  check("pay page smoke: the 404 is noindex", /<meta name="robots" content="noindex/.test(page.body));
}
