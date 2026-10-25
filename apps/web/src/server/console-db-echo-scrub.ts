// What the process prints with `console.error` goes through the same database-echo strip as the logger and Sentry (FU1, PR 1009).
//
// Next logs an uncaught error in a route handler, a server component or a server action with a bare `console.error(err)` (and
// `Log.error(err)`, which calls `console.error`), and the app does the same in a dozen places (`console.error("[credits] ...", err)`).
// `console.error` prints an error with `util.inspect`, which writes every enumerable field, and a postgres.js error carries Postgres'
// `detail` (the unique key, or the WHOLE failing row), `where` and `hint` as enumerable fields whatever its `debug` option says. FU1
// cleaned pino's `err` serializer and Sentry's hooks; this is the stdout/stderr route.
//
// `installConsoleDbEchoScrub` wraps `console.error` once, from instrumentation.ts `register()`, and runs every argument through
// `stripDbEchoFromErrors` (lib/strip-db-echo.ts, FU1's own list and walk, in the mode that keeps an Error an Error). So the line is the
// line it always was, with its `PostgresError: message` head, its stack and its code, minus the dropped fields; an error with
// nothing to drop reaches `console.error` as the same object. Log levels and messages are untouched.
//
// Installed in `register()` right after Sentry's init, so it is the outer wrapper: Sentry's console breadcrumb sees the scrubbed arguments.
// Only the Node runtime has a database driver, so only it installs this. Server-only: nothing on the client imports it.
//
// Like the logger's and Sentry's hooks it strips by field name on any error-shaped value, so a non-database error's `detail` (a
// Stripe error's) goes too (lib/strip-db-echo.ts). It looks only as far as `console.error` prints: util.inspect's own depth and array
// length, read from `inspect.defaultOptions` at each call. Next patches Error.prototype's inspect in every server process
// (node-environment-extensions/error-inspect.js); that rebuilds the error from the keys it still has, so it prints the scrubbed copy.
// In `next dev` only, React's server bundle patches console AFTER register() and replays the raw arguments to the browser; production
// is not affected.
import { inspect } from "node:util";
import { stripDbEchoFromErrors } from "@/lib/strip-db-echo";

const INSTALLED = Symbol.for("seazn.consoleDbEchoScrub");

type Print = ((...args: unknown[]) => void) & { [INSTALLED]?: true };

/** Printed in place of ONE argument if the strip throws on it (a getter or a Proxy trap that throws). A secret printed is worse than a value lost. */
const WITHHELD = "[console] argument withheld: the database-echo scrub could not read it";

/**
 * `args` with every database error in them stripped of its echo fields; untouched arguments keep their identity. Fails closed PER
 * ARGUMENT: the one the strip cannot read is replaced by a note, so the message strings around it still print.
 */
export function scrubConsoleArgs(args: unknown[]): unknown[] {
  // util.inspect's own declarations of how far a print reaches; `null` there means unlimited.
  const { depth, maxArrayLength } = inspect.defaultOptions;
  const bounds = { depth: depth ?? undefined, maxItems: maxArrayLength ?? undefined };
  return args.map((arg) => {
    try {
      return stripDbEchoFromErrors(arg, bounds);
    } catch {
      return WITHHELD;
    }
  });
}

/**
 * Wrap `target.error` so everything it prints is scrubbed. Idempotent (dev re-runs `register()` when instrumentation.ts changes),
 * and returns the uninstall (a no-op for a repeat install).
 */
export function installConsoleDbEchoScrub(target: Pick<Console, "error"> = console): () => void {
  const original = target.error as Print;
  if (original[INSTALLED]) return () => {};
  const wrapped: Print = function (this: unknown, ...args: unknown[]) {
    return original.apply(this, scrubConsoleArgs(args));
  };
  wrapped[INSTALLED] = true;
  target.error = wrapped;
  return () => {
    if (target.error === wrapped) target.error = original;
  };
}
