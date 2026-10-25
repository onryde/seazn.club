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
// Stripe error's) goes too (lib/strip-db-echo.ts).
//
// How far it looks. A line made by util.inspect's DEFAULTS shows nothing past inspect's depth and array length, so for such a call the
// walk stops there (read from `inspect.defaultOptions` at each call). That is NOT true of every line: `%j` is JSON.stringify (no
// limits, calls getters) and `%o` is inspect with depth 4 and showHidden, so a call whose format string has one of them is scrubbed
// with no bounds (`formatSpecifiersReach`). And Next patches Error.prototype's inspect in every server process
// (node-environment-extensions/error-inspect.js): it rebuilds each error by READING every enumerable key, so a getter on an error is
// called whatever the bounds; the strip calls an error's getters too and strips what they return.
// In `next dev` only, React's server bundle patches console AFTER register() and replays the raw arguments to the browser; production
// is not affected.
import { inspect } from "node:util";
import { stripDbEchoFromErrors } from "@/lib/strip-db-echo";

const INSTALLED = Symbol.for("seazn.consoleDbEchoScrub");

type Print = ((...args: unknown[]) => void) & { [INSTALLED]?: true };

/** Printed in place of ONE argument if the strip throws on it (a getter or a Proxy trap that throws). A secret printed is worse than a value lost. */
const WITHHELD = "[console] argument withheld: the database-echo scrub could not read it";

/**
 * What a `console.error(...args)` call hands its operands to, when `args[0]` is a format string (`util.format`, read from Node's
 * `formatWithOptionsInternal`): only the FIRST argument is one, and only when something follows it. `%%` is a literal percent. Each
 * other recognised specifier (`s d i f j o O c`) takes the next operand, in order, until the operands run out; anything else
 * (`%x`, a trailing `%`) takes none. Of those:
 *  - `%j` is `JSON.stringify`: no depth or length limit, and it calls getters (`json`);
 *  - `%o` is inspect with `showHidden` and `depth: 4`, and `%O` is inspect (`wide`, with `%j`).
 * `wide` means the line can show more than the default inspect does, so the call is scrubbed with no bounds.
 */
export function formatSpecifiersReach(args: unknown[]): { json: boolean; wide: boolean } {
  const first = args[0];
  let json = false;
  let wide = false;
  if (typeof first !== "string" || args.length < 2) return { json, wide };
  let operands = args.length - 1;
  for (let i = 0; i < first.length - 1 && operands > 0; i++) {
    if (first[i] !== "%") continue;
    const spec = first[++i];
    if (spec === "j") {
      json = wide = true;
      operands--;
    } else if (spec === "o" || spec === "O") {
      wide = true;
      operands--;
    } else if (spec === "s" || spec === "d" || spec === "i" || spec === "f" || spec === "c") {
      operands--;
    }
  }
  return { json, wide };
}

/**
 * `args` with every database error in them stripped of its echo fields; untouched arguments keep their identity. Fails closed PER
 * ARGUMENT: the one the strip cannot read is replaced by a note, so the message strings around it still print.
 */
export function scrubConsoleArgs(args: unknown[]): unknown[] {
  // A line made by inspect's defaults shows what util.inspect's own declarations say (`null` there means unlimited). A format
  // specifier can send an operand somewhere that shows more: then no bounds, and for %j the getters are called too.
  const { wide, json } = formatSpecifiersReach(args);
  const { depth, maxArrayLength } = inspect.defaultOptions;
  const bounds = wide ? { getters: json } : { depth: depth ?? undefined, maxItems: maxArrayLength ?? undefined };
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
