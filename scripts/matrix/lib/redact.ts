// R14a — the repo is public. Every error message and evidence string passes
// through redact(); writeResults refuses results in which findSecrets() still
// matches any string.
//
// Two properties the harness leans on (PF6):
//  - precise: ordinary evidence (UUIDs, slugs, `delivered+matrix-<runId>@
//    resend.dev`, "Matrix Player N", seq numbers, commit SHAs) never matches,
//    so one wordy error cannot make writeResults throw away a whole run;
//  - a fixpoint: findSecrets(redact(x)) is empty.
// Both hold on RAW strings, which is what writeResults scans. They do NOT hold
// on JSON-escaped text, in either direction: escaping turns a newline into
// `\` + `n`, which ERASES the \b in front of `eyJ` / `sk_` / `dl_` /
// `postgres://` (a secret at the start of a line would pass a body scan —
// review I1) and can STRETCH an open-ended value across the `\n`. So never
// point findSecrets at serialised JSON.
//
// Order is cosmetic, not a security property (moving key=value first kept
// every results.test.ts case green): each secret shape is removed either way.
// Running key=value LAST only means `DATABASE_URL=postgres://…?a=1&b=2`
// collapses to one `[redacted]` rather than leaving the non-secret `&b=2`.
//
// Cost: every open-ended run is bounded or has a single start. The lookbehinds
// pin where a match may begin (an unanchored lazy key prefix took 23 s on
// `"token_".repeat(700)`, an unanchored JWT 3.9 s on `"eyJ-".repeat(1e4)`),
// and the key suffix is capped at three parts (uncapped, `"token.".repeat(1e4)`
// took 5 s). results.test.ts has the timing guard.

/** Keys whose value this product always MINTS: every token is randomBytes(≥24)
 *  as base64url/hex, so ≥ 32 chars. Under these a short all-letter value is an
 *  English word (`authorization: none`, `cookie_consent=granted`), not a secret. */
const MINTED_KEYS = String.raw`token|secret|api[_-]?key|authorization|cookie|[_-]session|session[_-]?id|database[_-]?url|sb-[a-z0-9]+`;
/** Keys whose value a PERSON picks: any value, even a plain word, is the secret. */
const CHOSEN_KEYS = String.raw`passw(?:or)?d`;

const VALUE_CHAR = String.raw`[^"'\s&,;}]`;

/**
 * key=value / key: value / "key":"value". The key may be glued or joined to a
 * prefix (access_token, PGPASSWORD, sb-x-auth-token, seazn_session) and may
 * carry up to three `_x` / `-x` / `.N` parts (token_hash, session_id, a chunked
 * sb-x-auth-token.0). A quoted value is taken whole, spaces included
 * (`password: 'hunter 22'`), and an unclosed one to the end of its line. An
 * auth scheme word is consumed with its value, so
 * `Authorization: Basic <creds>` loses <creds> — and the word test is skipped
 * there, because base64 credentials can be all letters.
 */
function keyValue(keys: string, wordsAreSecrets: boolean): RegExp {
  const notWord = (end: string) => (wordsAreSecrets ? "" : `(?![A-Za-z]{1,15}${end})`);
  // The closing quote is optional (parked Task 4): a truncated message can cut
  // it off, and the value then runs to the end of its line — never leaving a
  // tail after a space (`password: 'hunter 22` lost only `hunter`). The word
  // test treats the end of the line as a closing quote, so `authorization:
  // 'none` stays a word.
  const value = [
    `"${notWord('(?:"|(?![^"\\r\\n]))')}[^"\\r\\n]{3,}"?`,
    `'${notWord("(?:'|(?![^'\\r\\n]))")}[^'\\r\\n]{3,}'?`,
    `["']?(?:(?:bearer|basic)\\s+${VALUE_CHAR}{3,}|${notWord(`(?!${VALUE_CHAR})`)}${VALUE_CHAR}{3,})`,
  ].join("|");
  return new RegExp(`(?<![\\w-])[\\w-]*?(?:${keys})(?:[_.-][A-Za-z0-9]+){0,3}["']?\\s*[:=]\\s*(?:${value})`, "gi");
}

const PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  // Device-link secret: `dl_` + 43 base64url chars (apps/web lib/scrub-score-url.ts).
  // Glued to a word (`x_dl_…`) there is no \b, so the 32-char floor alone guards that form.
  /\bdl_[A-Za-z0-9_-]{8,}|dl_[A-Za-z0-9_-]{32,}/g,
  /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g, // stripe keys
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi, // DB URL
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@"']*:[^\s/@"']+@/gi, // any URL carrying a password (user:pass@)
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // bearer token outside a header
  keyValue(CHOSEN_KEYS, true),
  keyValue(MINTED_KEYS, false),
];

export function findSecrets(text: string): string[] {
  return PATTERNS.flatMap((p) => [...text.matchAll(new RegExp(p.source, p.flags))].map((m) => m[0]));
}

export function redact(text: string): string {
  return PATTERNS.reduce((t, p) => t.replace(new RegExp(p.source, p.flags), "[redacted]"), text);
}

/** T15 fix round 3 (M-7): what a committed file says in place of the local
 *  server a run drove. The repo is public, and this machine's own address and
 *  port tell a reader nothing, so the committed writers (model.ts's report,
 *  writeResults, and through it run.ts's MATRIX.md) emit this instead. A local
 *  origin is no secret: findSecrets and redact do not change. */
export const LOCAL_BASE = "[local-base]";

/** Every spelling of a loopback host in a URL or a node error message
 *  (`connect ECONNREFUSED ::1:3313`): localhost, 127/8, the IPv6 loopback
 *  bracketed and bare, and the any-address a dev server binds. */
const LOOPBACK_HOST = String.raw`localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|::1`;
const IS_LOOPBACK = new RegExp(`^(?:${LOOPBACK_HOST})$`, "i");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where a host (and its port) ends: not inside a longer name, number or port. */
const HOST_END = String.raw`(?![\w-]|\.\w|:\d)`;

/** A base that is not an http(s) URL with a host: nothing could say which text is the base. */
export class BaseNotUrl extends Error {
  constructor(base: string) {
    super(`the base '${base}' is not a URL`);
    this.name = "BaseNotUrl";
  }
}

/** Final batch FB-1: the scrub for ONE run's base, and only it. The base's
 *  origin (`http://localhost:3313`, the path after it kept) and, when it names
 *  a port, its bare authority (`localhost:3313`) become LOCAL_BASE. A loopback
 *  base matches in every loopback spelling on ITS port — node reports the
 *  server `http://localhost:3313` refused as `127.0.0.1:3313` or `::1:3313`.
 *  Nothing else moves: another port (a database on 5433, Redis on 6379 — the
 *  port the seazn-local-env red signatures key on), a bare host in prose,
 *  `user@localhost`, `localhost.example.com`. Callers scrub AFTER the secret
 *  scan, never before: `https://localhost:pw@host` scrubbed first loses its
 *  credential shape. */
export function baseScrubber(base: string): (text: string) => string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new BaseNotUrl(base);
  }
  // `localhost:3313` parses — as scheme `localhost:` with no host.
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") throw new BaseNotUrl(base);
  const host = IS_LOOPBACK.test(u.hostname) ? `(?:${LOOPBACK_HOST})` : escapeRe(u.hostname);
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const origin = String.raw`(?<![\w+.-])https?://${host}${u.port === "" ? `(?::${defaultPort})?` : `:${u.port}`}${HOST_END}`;
  // The bare host:port only when the base names a port: a bare host alone is prose.
  const authority = u.port === "" ? [] : [String.raw`(?<![\w.:\[-])${host}:${u.port}${HOST_END}`];
  const re = new RegExp([origin, ...authority].join("|"), "gi");
  return (text) => text.replace(re, LOCAL_BASE);
}

/** Every string value in a JSON value, through `f` (keys are the schema's own). */
export function mapStrings<T>(value: T, f: (s: string) => string): T {
  return JSON.parse(JSON.stringify(value), (_k, x: unknown) => (typeof x === "string" ? f(x) : x)) as T;
}
