// The fields of a database error in which Postgres or postgres.js ECHOES DATA back: the failed statement's row, key, values and
// text. A log line or a Sentry payload that carries them carries the data.
//
//   detail          "Key (email)=(a@b.c) already exists." / "Failing row contains (3, a@b.c, <token>, -1)" - the whole row
//   where           the context line; "unnamed portal parameter $1 = '<value>'" when the server logs parameters
//   hint            the server's advice, which can quote the offending value
//   internal_query  the statement text a server-side function was running
//   parameters      postgres.js: the bind values (enumerable only when `debug` is truthy - lib/db.ts keeps it off)
//   args            postgres.js: the same values, before serialisation
//   query           postgres.js: the statement text
//   types           postgres.js: the bind types
//
// What stays is what says WHAT went wrong: name, message, code, constraint_name, table_name, column_name, schema_name, stack.
//
// Used at four seams, because an error reaches the outside world by four routes: pino's `err` serializer (server/logger.ts,
// which also feeds Sentry Logs through pinoIntegration), Sentry's `beforeSend` (the console breadcrumb that Next's own
// `console.error(err)` leaves on an event, and any `extra` that carries an error) and `beforeSendLog` (a log attribute that
// holds an error), and the process's own `console.error` (server/console-db-echo-scrub.ts: Next's uncaught-error log and every
// `console.error("...", err)` in the app print an error with util.inspect, which writes every enumerable field, `detail` and
// all). That last route needs the error to stay an Error so the printed line keeps its `PostgresError: message` head and its
// stack frames: `stripDbEchoFromErrors`. Not a repair of `message`: a cast error's message quotes the value ("invalid input
// syntax for type integer: \"abc\""), which is parked.
//
// A LEAF: it imports nothing, so the logger, the Sentry configs and a test can all take it.

export const DB_ECHO_FIELDS = ["detail", "where", "hint", "internal_query", "parameters", "query", "args", "types"] as const;

const ECHO: ReadonlySet<string> = new Set(DB_ECHO_FIELDS);

/** Deep enough for an event's `breadcrumbs[].data.arguments[].inner`; a deeper branch is left as it is. */
const MAX_DEPTH = 10;

type Bag = Record<string, unknown>;

/**
 * An error as data: a message AND a stack. That is what an `Error`, the plain object pino's serializer makes of one, and the
 * normalised copy Sentry keeps of one in a breadcrumb all have in common. Asking for the stack too is what keeps an ordinary
 * `{ message, name, detail }` log attribute (not an error) from losing its `detail`.
 */
function isErrorShaped(v: object): boolean {
  const e = v as { message?: unknown; stack?: unknown };
  return typeof e.message === "string" && typeof e.stack === "string";
}

function isPlain(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `value` in which every error-shaped object, at any depth, has lost its database echo fields. Nothing is mutated;
 * a branch with nothing to strip keeps its original reference, and a thing that is not data (a string, a Date, a class
 * instance that is not an error) is left as it is. An `Error` instance comes back as a plain object carrying its name,
 * message and stack (all non-enumerable on the original, so absent from `JSON.stringify`) and its own enumerable fields.
 */
export function stripDbEcho<T>(value: T): T {
  return walk(value, new WeakMap(), 0, false) as T;
}

/**
 * The same strip, for a value about to be PRINTED. The only differences are in what the output is made of: an `Error` instance
 * comes back as an `Error` of the same class (same prototype, same message, name and stack, its `cause` and `errors` carried as
 * the non-enumerable own properties they are), not as a plain object, so `util.inspect` renders it exactly as it rendered the
 * original minus the dropped fields; and an Error with nothing to strip (nor anywhere in its cause chain) comes back as the SAME
 * object rather than a copy. Everything else, the field list, the walk, the depth limit and the cycle handling, is `stripDbEcho`'s
 * own. Nothing is mutated: code that reads `err.detail` after the line is printed still can.
 */
export function stripDbEchoFromErrors<T>(value: T): T {
  return walk(value, new WeakMap(), 0, true) as T;
}

const own = (v: object, key: string) => Object.prototype.hasOwnProperty.call(v, key);

/** An own, non-enumerable data property: how an Error keeps `message`, `stack`, `cause` and `errors`. */
function hide(target: Bag, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}

function walk(value: unknown, seen: WeakMap<object, unknown>, depth: number, keepErrors: boolean): unknown {
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    seen.set(value, value);
    let copy: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = walk(item, seen, depth + 1, keepErrors);
      if (!Object.is(next, item)) (copy ??= value.slice())[i] = next;
    });
    const out = copy ?? value;
    seen.set(value, out);
    return out;
  }

  const isError = value instanceof Error;
  const errorShaped = isError || isErrorShaped(value);
  if (!errorShaped && !isPlain(value)) return value;

  seen.set(value, value);
  const bag = value as Bag;
  // An Error kept as an Error is built on the same prototype, so it prints under its own class and name.
  const out: Bag = isError && keepErrors ? Object.create(Object.getPrototypeOf(value) as object | null) : {};
  let changed = isError && !keepErrors;
  if (isError) {
    // An Error's own name/message/stack are not enumerable; carry them, or the copy would be an empty `{}`. Kept as an Error, the
    // copy has them as non-enumerable own properties again, and is only a copy when something below it changed.
    if (keepErrors) {
      for (const key of ["name", "message", "stack"]) {
        // An own ENUMERABLE one (PostgresError sets `name` so) is copied with the other enumerable fields below.
        if (own(value, key) && !Object.prototype.propertyIsEnumerable.call(value, key)) hide(out, key, bag[key]);
      }
    } else {
      out.name = value.name;
      out.message = value.message;
      out.stack = value.stack;
    }
    // Own but non-enumerable too (`new Error(m, { cause })`, AggregateError): the chain is part of what went wrong.
    for (const key of ["cause", "errors"] as const) {
      if (!(key in value)) continue;
      const item = bag[key];
      const next = walk(item, seen, depth + 1, keepErrors);
      if (!keepErrors) {
        out[key] = next;
      } else {
        if (!Object.is(next, item)) changed = true;
        hide(out, key, next);
      }
    }
  }
  for (const key of Object.keys(bag)) {
    if (errorShaped && ECHO.has(key)) {
      changed = true;
      continue;
    }
    const item = bag[key];
    const next = walk(item, seen, depth + 1, keepErrors);
    if (!Object.is(next, item)) changed = true;
    out[key] = next;
  }
  const result = changed ? out : value;
  seen.set(value, result);
  return result;
}
