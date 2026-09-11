import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every address the bench, the e2e suite and the smoke scripts MINT is sent to
 * the running product, which forwards it to Resend (`apps/web/src/lib/email.ts`'s
 * `send()`). Resend rejects `@example.com` outright:
 *
 *   422 validation_error — Invalid `to` field. Please use our testing email
 *   address instead of domains like `example.com`.
 *
 * (https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing —
 * "these domains are not designed for email traffic and often reject messages,
 * leading to bounces".)
 *
 * So every minted address uses Resend's own simulator instead, labelled to stay
 * unique: `delivered+<whatever-was-there-before>@resend.dev`. Plus-addressing is
 * supported on `delivered`, `bounced` and `complained` (NOT on `suppressed`), and
 * nothing in this product canonicalises a plus tag away — `resolveOrCreateUser`
 * (`apps/web/src/lib/users.ts:23-37`) looks the raw string up, and the
 * `trim().toLowerCase()` sites never touch `+` — so two labels remain two users.
 *
 * This is belt AND braces. The braces are that no test runner sets
 * `RESEND_API_KEY` at all (CI never has; `seazn-env.sh` passes it blank so the
 * MAIN checkout's `.env.local` cannot leak a live key into a local server), and
 * `send()` short-circuits on a falsy key. This guard covers the other case: a run
 * that DOES have a key, where the address had better be one Resend accepts.
 *
 * `apps/web/src/**` unit fixtures are deliberately out of scope. They are
 * arguments to pure functions and never reach a mailer.
 *
 * --- ONE DELIBERATE EXEMPTION: `@bench.invalid` -------------------------
 *
 * Suite 11's claim invites mint `<slug>@bench.invalid`
 * (`scripts/bench/packs/build-packs/suite11.ts:960-968`), and Resend refuses
 * `.invalid` for exactly the same reason it refuses `example.com`. That is
 * allowed to stand, and the allowance is stated here rather than left as a
 * silent hole in the pattern below.
 *
 * The reason is the pack's contents. Suite 11 is built from REAL NAMED PUBLIC
 * FIGURES, and `.invalid` is reserved by RFC 2606 — it can never resolve, so
 * no configuration error, now or later, can turn one of those addresses into
 * mail at a real person. `resend.dev` is a live domain whose non-delivery is a
 * property of Resend's simulator rather than of DNS. For a pack of invented
 * names the two are equivalent; for this one the stronger guarantee is worth
 * keeping, and it costs nothing because no test runner holds a key (see
 * above), so these addresses never reach Resend to be refused.
 *
 * If that trade is ever revisited, change it HERE and in `suite11.ts`
 * together — and regenerate `scripts/bench/packs/suite11.json`, which is a
 * build artifact of that builder and carries the pack hash the bench
 * short-circuits on.
 */

const ROOTS = ["scripts", "apps/web/e2e"] as const;
const EXTS = [".ts", ".tsx", ".mts", ".js"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}

/** This file quotes a malformed address as the example of what it rejects, so
 *  scanning itself would be a guaranteed self-trip. */
const SELF = join("scripts", "__tests__", "test-email-domain.test.ts");

const FILES = ROOTS.flatMap((r) => walk(r)).filter((f) => f !== SELF);

describe("test email addresses", () => {
  it("scans a non-trivial number of files — a zero-file walk would pass vacuously", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("mints no address Resend refuses, except the declared `.invalid` one", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // `example.org`/`.net` are refused by the same rule; `test.com` is named
        // in Resend's own list. Matched on the address, not the bare domain, so
        // prose in a comment about the rule does not trip its own guard.
        //
        // `}` IS IN THE CLASS DELIBERATELY, and leaving it out is how the first
        // version of this guard let a reverted generator through its own
        // mutation sweep: the commonest address shape in this repo ends with an
        // interpolation, `` `bench-captain-${safe}-${runTag}@example.com` ``, so
        // the character immediately before the `@` is a closing brace far more
        // often than it is a letter.
        if (/[A-Za-z0-9._%+$}-]@(example\.(com|org|net)|test\.com)/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The bug this exists for, found the hard way: a bulk rewrite that inserted
   * `delivered+` at the start of the enclosing STRING rather than the start of
   * the ADDRESS produced `"delivered+SIGNIN claimant1@resend.dev"` — which
   * typechecks, lints, and is not an email address. A local part cannot contain
   * whitespace or a delimiter, so the malformed ones are detectable.
   */
  it("mints no address with a malformed local part", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/delivered\+(.*?)@resend\.dev/g)) {
          // `${...}` spans are CODE, not address text — `replace(/\s+/g, ".")`
          // inside an interpolation is legal and common. Strip them, then judge
          // what is left, which is the literal part of the local part.
          const literal = (m[1] ?? "").replace(/\$\{[^}]*\}/g, "");
          if (/[\s,;=/\\()[\]"'`]/.test(literal)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
