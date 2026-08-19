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
import { getRequestContext } from "./request-context";

export const log = pino(
  {
    name: "web",
    level: process.env.LOG_LEVEL ?? "info",
    mixin: () => getRequestContext(),
  },
  pino.destination({ sync: false }),
);
