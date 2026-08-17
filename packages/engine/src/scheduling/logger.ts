// Structured logging for the scheduling subsystem — build.ts's placement
// path and placement-client.ts's gRPC transport. Not part of the package's
// public surface (no "./scheduling/logger" entry in package.json exports):
// it exists so the two previously-silent failure modes on that path (an
// encoder/verifier disagreement, a placement service that never answers) are
// observable, nothing more.
//
// Deliberately NOT `pino({ transport: {...} })`: a transport spawns a worker
// thread that does a dynamic `require()` of the transport target, which a
// bundler (Next.js standalone tracing, Turbopack) cannot statically follow —
// see `apps/web/next.config.js`'s `serverExternalPackages` comment for the
// same class of failure with a package that reads a data file off disk.
// Plain JSON-to-stdout has
// no such seam: `import pino from "pino"` is an ordinary static import a
// bundler traces like any other dependency.
import pino from "pino";

export const log = pino({ name: "engine.scheduling", level: process.env.LOG_LEVEL ?? "info" });
