// Structured logging for server-side usecases — schedule-ai.ts's AI-plan
// entry point and its preview-release cleanup, plus schedule.ts's
// locked-fixture apply rejection (#pins-in-build). Not a public export (no
// barrel re-export), plain module-scope singleton like the rest of this
// directory's cross-cutting utilities.
//
// Deliberately NOT `pino({ transport: {...} })`: a transport spawns a worker
// thread that does a dynamic `require()` of the transport target, which
// Next's standalone build cannot trace statically — see next.config.js's
// `serverExternalPackages` comment for the same class of failure with a
// package that reads a data file off disk. Plain JSON-to-stdout needs no such
// tracing: `import
// pino from "pino"` is an ordinary static import.
import pino from "pino";

export const log = pino({ name: "web.scheduling", level: process.env.LOG_LEVEL ?? "info" });
