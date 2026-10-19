// Browser Sentry, checked against a REAL production build (owner decisions 2026-10-19: browser Sentry ON with session replay OFF,
// then ERRORS ONLY: no tracing, no logs).
//
// Why a build check and not a unit test. `@sentry/nextjs` bundles a `sentry.client.config.ts` only under WEBPACK; `next build`
// here is Turbopack, so for as long as the client Sentry.init lived in that file nothing reached a browser: no error or scrub hook,
// and every unit test of the file stayed green. tsc, eslint and ~4,000 vitest tests cannot see which modules a bundle holds; only
// the emitted chunks can. This reads them, after `next build`, and fails when:
//
//   1. the client init is not in a FIRST-LOAD chunk (the shared chunks every route bootstraps with: build-manifest.json's
//      rootMainFiles + polyfillFiles, the same pair scripts/check-build-chunks.ts treats as global). Each marker is a string only
//      the init's own wiring leaves behind, absent from the bundle before the init moved to instrumentation-client.ts: the scrub
//      processor's name (`ScrubScoreTokens`, scrubScoreTokensIntegration), the scrubber's `query_string` handling
//      (scrubSentryEvent), and the staging host of the environment mapping (`stg.seazn.club`, lib/sentry-environment). They are
//      bundled only because the init uses them, which is why they witness the init and not merely the module's presence;
//      Turbopack drops an unused export.
//   2. a FORBIDDEN marker is in ANY chunk under .next/static/chunks:
//        - `checkoutEveryNms`, rrweb's recorder option, the one string every session-replay recorder carries. Session replay is
//          off; a `replayIntegration` or `getReplay` reference anywhere reachable from a first-load module drags @sentry/replay
//          and rrweb (~23 KB gzipped) into every page.
//        - `auto.log.console`, the origin the console-to-logs forwarder stamps on every log (consoleLoggingIntegration). Log
//          capture is off.
//      Tracing cannot be pinned this way: @sentry/nextjs's client imports its BrowserTracing integration unconditionally, so
//      that code is in the bundle however the init is written (the init takes the integration out at RUNTIME, which
//      sentry-client-init.test.ts proves on the real client, and e2e/sentry-client-init.spec.ts proves on the built page).
//   3. it scanned nothing (no first-load files, or no chunks at all): zero checked is a failure, not a pass.
//
// It also prints the first-load size (raw and gzipped, rootMainFiles + polyfillFiles), so a change to what the shared chunks
// hold shows up as a number in the build log.
//
// Usage, after a production build (the Turbopack build, CI env, NEXT_PUBLIC_SENTRY_DSN blank is fine: the init is bundled
// whether or not it is enabled):
//   node --experimental-strip-types scripts/check-client-sentry.ts [path/to/.next] [--json]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isMainModule } from "./lib/main-module.ts";

/** Strings the client init leaves in a first-load chunk; each is absent from the bundle without it. See the header. */
export const INIT_MARKERS = ["ScrubScoreTokens", "query_string", "stg.seazn.club"] as const;

/** rrweb's recorder option: present in any bundle that holds a session-replay recorder. */
export const REPLAY_MARKER = "checkoutEveryNms";

/** The origin consoleLoggingIntegration stamps on every log it forwards: present in any bundle that holds the forwarder. */
export const LOG_MARKER = "auto.log.console";

/** Strings that must be in NO chunk, each with what it would mean and the usual cause. */
export const FORBIDDEN: readonly { marker: string; what: string; cause: string }[] = [
  {
    marker: REPLAY_MARKER,
    what: "a session-replay recorder: rrweb",
    cause: "session replay is off; something reachable from a first-load module references replayIntegration / getReplay",
  },
  {
    marker: LOG_MARKER,
    what: "the console-to-logs forwarder: consoleLoggingIntegration",
    cause: "log capture is off; something reachable from a first-load module calls consoleLoggingIntegration / sets enableLogs",
  },
];

export interface ClientBuildReport {
  /** rootMainFiles + polyfillFiles, relative to the .next dir. */
  firstLoadFiles: string[];
  firstLoadRawBytes: number;
  firstLoadGzipBytes: number;
  /** How many .js files under static/chunks were read (the replay search's universe). */
  chunksScanned: number;
  /** For each init marker, the first-load files that hold it. */
  initMarkers: Record<string, string[]>;
  /** For each forbidden marker, every chunk under static/chunks that holds it. */
  forbiddenChunks: Record<string, string[]>;
}

type BuildManifest = { rootMainFiles?: string[]; polyfillFiles?: string[] };

const jsFiles = (dir: string): string[] =>
  existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".js")).map((f) => join("static/chunks", f))
    : [];

/** Read a production build's output (the `.next` dir) and report what the check needs. Throws if there is no build there. */
export function inspectClientBuild(nextDir: string): ClientBuildReport {
  const manifestPath = join(nextDir, "build-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no build at ${nextDir} (no build-manifest.json): run the production build first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
  const firstLoadFiles = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];

  let firstLoadRawBytes = 0;
  let firstLoadGzipBytes = 0;
  const initMarkers: Record<string, string[]> = Object.fromEntries(INIT_MARKERS.map((m) => [m, []]));
  for (const file of firstLoadFiles) {
    const bytes = readFileSync(join(nextDir, file));
    firstLoadRawBytes += bytes.length;
    firstLoadGzipBytes += gzipSync(bytes).length;
    const text = bytes.toString("utf8");
    for (const marker of INIT_MARKERS) if (text.includes(marker)) initMarkers[marker]!.push(file);
  }

  const chunks = jsFiles(join(nextDir, "static/chunks"));
  const forbiddenChunks: Record<string, string[]> = Object.fromEntries(FORBIDDEN.map((f) => [f.marker, [] as string[]]));
  for (const file of chunks) {
    const text = readFileSync(join(nextDir, file), "utf8");
    for (const { marker } of FORBIDDEN) if (text.includes(marker)) forbiddenChunks[marker]!.push(file);
  }
  return { firstLoadFiles, firstLoadRawBytes, firstLoadGzipBytes, chunksScanned: chunks.length, initMarkers, forbiddenChunks };
}

/** What is wrong with a build, one sentence each; empty when nothing is. */
export function failures(report: ClientBuildReport): string[] {
  const out: string[] = [];
  if (report.firstLoadFiles.length === 0) out.push("no first-load files in build-manifest.json (rootMainFiles + polyfillFiles are empty): nothing was checked");
  if (report.chunksScanned === 0) out.push("no .js chunks under static/chunks: nothing was checked");
  if (report.firstLoadFiles.length > 0) {
    for (const marker of INIT_MARKERS) {
      if (report.initMarkers[marker]?.length) continue;
      out.push(`"${marker}" is in no first-load chunk: the client Sentry.init (src/instrumentation-client.ts) is not in the bundle every page loads`);
    }
  }
  for (const { marker, what, cause } of FORBIDDEN) {
    const chunks = report.forbiddenChunks[marker] ?? [];
    if (chunks.length > 0) out.push(`"${marker}" (${what}) is in ${chunks.length} chunk(s): ${chunks.join(", ")}. ${cause[0]!.toUpperCase()}${cause.slice(1)}.`);
  }
  return out;
}

function main(argv: string[]): number {
  const asJson = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const nextDir = args[0] ?? join(root, "apps/web/.next");
  let report: ClientBuildReport;
  try {
    report = inspectClientBuild(nextDir);
  } catch (error) {
    console.error(`[client-sentry] ${(error as Error).message}`);
    return 2;
  }
  const problems = failures(report);
  if (asJson) console.log(JSON.stringify({ ...report, problems }, null, 2));
  else {
    console.log(
      `[client-sentry] first-load (${report.firstLoadFiles.length} files, ${relative(root, nextDir)}): ` +
        `${report.firstLoadRawBytes} B raw, ${report.firstLoadGzipBytes} B gzip; ${report.chunksScanned} chunks scanned for ${FORBIDDEN.map((f) => f.marker).join(", ")}`,
    );
    for (const marker of INIT_MARKERS) console.log(`[client-sentry] init marker "${marker}": ${report.initMarkers[marker]!.join(", ") || "ABSENT"}`);
    for (const { marker } of FORBIDDEN) console.log(`[client-sentry] forbidden marker "${marker}": ${report.forbiddenChunks[marker]!.join(", ") || "in no chunk"}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[client-sentry] FAILED: ${problem}`);
    return 1;
  }
  if (!asJson) console.log("[client-sentry] OK: the client Sentry.init is in the first-load chunks; no replay recorder and no console-to-logs forwarder is in any chunk.");
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
