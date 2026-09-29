// An oracle for "this text names a local server", independent of the scrubber
// it judges (final batch FB-1 and F-3). redact.ts's baseScrubber is a regex;
// judging its output with the same regex would share every blind spot (the
// old sweep did: it could not see `[::1]`, `0.0.0.0` or `127.0.1.1`). This is
// a typed list of literal spellings, matched as plain, case-blind substrings.
/** Every spelling of a local host this repo's runs could print: loopback in
 *  each form a URL or a node error message uses (`connect ECONNREFUSED
 *  ::1:3313`), the any-address a dev server binds, and an mDNS LAN name. */
export const LOOPBACK_LITERALS: readonly string[] = Object.freeze(["localhost", "127.0.0.1", "127.0.1.1", "[::1]", "::1:", "0.0.0.0", ".local:", ".local/"]);

/** The literals `text` contains. */
export function loopbackLiteralsIn(text: string): string[] {
  const t = text.toLowerCase();
  return LOOPBACK_LITERALS.filter((l) => t.includes(l));
}

/** Every spelling of one local server — any loopback host on `port` — that
 *  `text` still contains. For tests that keep OTHER loopback text on purpose
 *  (a database on 5433 is not the server a run drove). */
export function baseLiteralsIn(text: string, port: number): string[] {
  const t = text.toLowerCase();
  return ["localhost", "127.0.0.1", "127.0.1.1", "[::1]", "::1", "0.0.0.0"].map((h) => `${h}:${port}`).filter((l) => t.includes(l));
}
