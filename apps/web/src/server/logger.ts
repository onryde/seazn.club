// Shared structured logger for apps/web server-side code (routes, usecases).
// Not a public export (no barrel re-export), plain module-scope singleton
// like the rest of this directory's cross-cutting utilities.
//
// Deliberately NOT `pino({ transport: {...} })`: a transport spawns a worker
// thread that does a dynamic `require()` of the transport target, which
// Next's standalone build cannot trace statically — see next.config.js's
// `serverExternalPackages` comment for the same class of failure with a
// package that reads a data file off disk. Plain JSON-to-stdout needs no such
// tracing: `import pino from "pino"` is an ordinary static import.
//
// `pino.destination({ sync: false })` makes writes explicitly non-blocking
// (sonic-boom, no worker thread) instead of leaving it to whatever Node's
// stdout sync/async split happens to be for the process's stdout (sync for a
// TTY or file, async for a pipe) — a distinction the app has no control over
// and shouldn't depend on.
//
// `mixin` merges the current request's context (requestId/orgId/userId, set
// by the route wrappers in api-v1/http.ts and lib/http.ts via
// server/request-context.ts) into every log line with no call-site changes.
import pino from "pino";
import { stripDbEcho } from "@/lib/strip-db-echo";
import { getRequestContext } from "./request-context";

// A caught error is logged as `{ err }` in ~60 places. pino's standard `err` serializer copies every enumerable field of it,
// and a database error's include the data Postgres echoes back: `detail` is the unique key or the WHOLE failing row, `where`
// and `hint` can quote a value. The line goes to stdout and, through Sentry.pinoIntegration(), to Sentry Logs. So: the standard
// serializer, then the echo fields out of the result (lib/strip-db-echo.ts). The name, message, code, constraint_name,
// table_name, column_name, schema_name and stack stay. Registered on `error` too, the other key an error is logged under.
const dbSafeErr = (err: unknown): unknown => stripDbEcho(pino.stdSerializers.err(err as Error));

//
// `redact` (capture QR v2 §10.2): a phone route never logs its Bearer, the code's tok, the descriptor's `cred` or a
// stream key or SRT passphrase. pino's `*.x` matches ONE level below the top only, so each name is also listed at the
// top level, the shape `log.warn({ tok }, …)` would take. A safety net under "never log a header or a body", not a
// licence to; logger-redact.test.ts pins each path.
export const LOGGER_OPTIONS = {
  name: "web",
  level: process.env.LOG_LEVEL ?? "info",
  mixin: () => getRequestContext(),
  serializers: { err: dbSafeErr, error: dbSafeErr },
  redact: [
    "req.headers.authorization",
    "*.tok", "*.cred", "*.streamKey", "*.passphrase",
    "tok", "cred", "streamKey", "passphrase",
  ],
} satisfies pino.LoggerOptions;

export const log = pino(LOGGER_OPTIONS, pino.destination({ sync: false }));
