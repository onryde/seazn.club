// R14a — the repo is public. Every error message and evidence string passes
// through redact(); writeResults refuses a file findSecrets() still matches.
//
// Two properties the harness leans on (PF6):
//  - precise: ordinary evidence (UUIDs, slugs, `delivered+matrix-<runId>@
//    resend.dev`, "Matrix Player N", seq numbers, commit SHAs) never matches,
//    so one wordy error cannot make writeResults throw away a whole run;
//  - a fixpoint: findSecrets(redact(x)) is empty, and stays empty after
//    JSON.stringify — writeResults scans the SERIALISED body, so the open-
//    ended parts of the key=value and userinfo patterns stop at a backslash
//    (`\n` in JSON is `\` + `n`, and would otherwise stretch `token=ab` past
//    the 3-char floor). The anchored patterns need no such stop: escaping
//    only inserts backslashes, so it cannot manufacture `eyJ`, `dl_`, `sk_`
//    or `postgres://`.
//
// Order is cosmetic, not a security property (moving key=value first kept
// every results.test.ts case green): each secret shape is removed either way.
// Running key=value LAST only means `DATABASE_URL=postgres://…?a=1&b=2`
// collapses to one `[redacted]` rather than leaving the non-secret `&b=2`.
//
// The lookbehinds are load-bearing for speed, not matching: they pin where a
// match may START. Without them the lazy key prefix is retried from every
// character of a long word, and `"token_".repeat(700)` took 23 s (a 4 KB error
// body is a realistic input). results.test.ts has the timing guard.
const PATTERNS: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  // Device-link secret: `dl_` + 43 base64url chars (apps/web lib/scrub-score-url.ts).
  // Glued to a word (`x_dl_…`) there is no \b, so the 32-char floor alone guards that form.
  /\bdl_[A-Za-z0-9_-]{8,}|dl_[A-Za-z0-9_-]{32,}/g,
  /\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g, // stripe keys
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi, // DB URL
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'\\]*:[^\s/@"'\\]+@/gi, // any URL carrying a password (user:pass@)
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, // bearer token outside a header
  // key=value / key: value / "key":"value". The key may be glued or joined to a
  // prefix (access_token, PGPASSWORD, sb-x-auth-token, seazn_session) and may
  // carry a `_x` / `-x` / `.N` suffix (token_hash, session_id, a chunked
  // sb-x-auth-token.0). An auth scheme word is consumed with the value, so
  // `Authorization: Basic <creds>` loses <creds>, not just the word "Basic".
  /(?<![\w-])[\w-]*?(?:token|secret|passw(?:or)?d|api[_-]?key|authorization|cookie|[_-]session|session[_-]?id|database[_-]?url|sb-[a-z0-9]+)(?:[_.-][A-Za-z0-9]+)*["']?\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?[^"'\s&,;}\\]{3,}/gi,
];

export function findSecrets(text: string): string[] {
  return PATTERNS.flatMap((p) => [...text.matchAll(new RegExp(p.source, p.flags))].map((m) => m[0]));
}

export function redact(text: string): string {
  return PATTERNS.reduce((t, p) => t.replace(new RegExp(p.source, p.flags), "[redacted]"), text);
}
