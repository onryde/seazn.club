// #19 (docs/superpowers/specs/2026-08-16-registration-redesign-prompts/
// _INDEX.md): a client-side change can alter the module graph enough that
// the bundler's own manifest still lists a chunk id it never flushed to
// .next/static/chunks/. The server then answers that URL 500,
// `content-type: text/plain`; the browser refuses to execute it
// ("MIME type … is not executable"); React never hydrates; every control on
// the page is dead. The page's own HTTP status is 200, /api/health is 200,
// and every existing gate (tsc, ~3,000 unit tests, the first-chunk asset
// probe in ci.yml/seazn-env.sh) stays green, because none of them check
// MORE than the first referenced asset. Only a test that clicks something
// notices.
//
// This is the cheap gate #19 says is owed: after a production build, for
// EVERY route the build emits, confirm EVERY /_next/static/** asset that
// route's build output references was actually written to disk — and if
// not, fail loudly and name it, before a walkthrough has to find it by hand.
//
// Static check, not a server crawl. Chosen because a full route list needs
// no seeded DB rows, no auth, and no dynamic-segment values to be reachable
// this way, and because the assets a route's HTML will reference are fully
// enumerable from two build-time artifacts Next's own app-router server
// reads to build that HTML in the first place:
//   - apps/web/.next/build-manifest.json's rootMainFiles/polyfillFiles —
//     the shared framework/runtime/turbopack-entry chunks every route
//     bootstraps with, regardless of page.
//   - each route's own
//     apps/web/.next/server/app/**/page_client-reference-manifest.js —
//     clientModules[*].chunks, entryJSFiles, and entryCSSFiles. This is the
//     literal React Server Components manifest the server reads per
//     request; API route handlers (route.js) get one too but never render
//     HTML, so they're excluded — nothing serves a <script> tag for them.
// Verified against the #19 repro this file cites: this union reproduces
// the reported "18 referenced chunks" for the register page exactly,
// including the one that went missing (1e0nyjjz3x5pr.js).
//
// Checked against the STANDALONE tree, not the pre-copy one: `next build`
// (output: standalone) writes .next/static but does not copy it into
// .next/standalone on its own — ci.yml's "Start server" step and
// seazn-env.sh's rebuild/up --server both do that copy by hand before
// serving. Checking the standalone tree catches a dropped copy the same
// way it catches a chunk the bundler never wrote — either way, the file
// that HTML asks for is not where the running server would look for it.
//
// Usage (after a production build, with .next/standalone/apps/web/.next/
// static staged — same copy the two callers above already do):
//   node --experimental-strip-types scripts/check-build-chunks.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(ROOT, "apps/web");
const NEXT_DIR = join(WEB, ".next");
const STANDALONE_NEXT_DIR = join(WEB, ".next/standalone/apps/web/.next");

if (!existsSync(NEXT_DIR)) {
  console.error(`[build-chunks] no build at ${relative(ROOT, NEXT_DIR)} — run the production build first.`);
  process.exit(2);
}

// Prefer the standalone tree (what CI/production actually serves); fall
// back to the pre-copy tree for a bare `next build` with no staging step
// run yet, so this is still usable standalone locally. Loud either way —
// never silently checks the tree it did not intend to.
const usingStandalone = existsSync(join(STANDALONE_NEXT_DIR, "static"));
const CHECK_ROOT = usingStandalone ? STANDALONE_NEXT_DIR : NEXT_DIR;
if (!usingStandalone) {
  console.warn(
    `[build-chunks] ${relative(ROOT, join(STANDALONE_NEXT_DIR, "static"))} not staged yet — ` +
      `checking ${relative(ROOT, join(NEXT_DIR, "static"))} instead. This is NOT the tree a real ` +
      `server serves; stage it first for a trustworthy run:\n` +
      `  rm -rf apps/web/.next/standalone/apps/web/.next/static\n` +
      `  cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static`,
  );
}

type ClientReferenceManifest = {
  clientModules?: Record<string, { chunks?: string[] }>;
  entryJSFiles?: Record<string, string[]>;
  entryCSSFiles?: Record<string, { path: string; inlined: boolean }[]>;
};
type RSCGlobal = { __RSC_MANIFEST?: Record<string, ClientReferenceManifest> };

/** Every `page_client-reference-manifest.js` under `.next/server/app`. Only
 * `page.js` leaves get one that matters here — `route.js` (API handlers)
 * get a manifest file too, but they answer JSON/redirects, never HTML with
 * <script> tags, so they carry nothing this gate needs to check. */
const findPageManifests = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findPageManifests(full, out);
    else if (entry.name === "page_client-reference-manifest.js") out.push(full);
  }
  return out;
};

const appDir = join(NEXT_DIR, "server/app");
const manifestFiles = existsSync(appDir) ? findPageManifests(appDir) : [];
if (manifestFiles.length === 0) {
  console.error(`[build-chunks] no page manifests found under ${relative(ROOT, appDir)} — build output not where expected.`);
  process.exit(2);
}

/** Loads a page_client-reference-manifest.js the way Next's own server
 * does: it's a `globalThis.__RSC_MANIFEST[route] = {...}` assignment, not a
 * module with an export, so it is executed against a throwaway sandbox
 * rather than imported. */
const loadManifest = (file: string): { route: string; manifest: ClientReferenceManifest } => {
  const src = readFileSync(file, "utf8");
  const sandbox: RSCGlobal = {};
  new Function("globalThis", src)(sandbox);
  const routes = Object.keys(sandbox.__RSC_MANIFEST ?? {});
  if (routes.length !== 1) {
    throw new Error(`${file}: expected exactly one __RSC_MANIFEST route key, found ${routes.length}`);
  }
  const route = routes[0]!;
  return { route, manifest: sandbox.__RSC_MANIFEST![route]! };
};

// `/_next/static/chunks/x.js` (clientModules) and `static/chunks/x.js`
// (entryJSFiles/entryCSSFiles/build-manifest.json) both reduce to the same
// path relative to a `.next` dir.
const normalize = (p: string): string => p.replace(/^\/?_next\//, "").replace(/^\/+/, "");

const buildManifest = JSON.parse(readFileSync(join(NEXT_DIR, "build-manifest.json"), "utf8")) as {
  rootMainFiles?: string[];
  polyfillFiles?: string[];
};
const globalAssets = new Set<string>(
  [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? [])].map(normalize),
);

const perRoute = new Map<string, Set<string>>();
for (const file of manifestFiles) {
  const { route, manifest } = loadManifest(file);
  const assets = perRoute.get(route) ?? new Set<string>();
  perRoute.set(route, assets);

  for (const mod of Object.values(manifest.clientModules ?? {})) {
    for (const c of mod.chunks ?? []) assets.add(normalize(c));
  }
  for (const files of Object.values(manifest.entryJSFiles ?? {})) {
    for (const c of files) assets.add(normalize(c));
  }
  for (const entries of Object.values(manifest.entryCSSFiles ?? {})) {
    for (const e of entries) assets.add(normalize(e.path));
  }
}

// One stat per unique asset, however many routes share it — a framework
// chunk can legitimately be referenced by all 105.
const existsCache = new Map<string, boolean>();
const exists = (asset: string): boolean => {
  let cached = existsCache.get(asset);
  if (cached === undefined) {
    cached = existsSync(join(CHECK_ROOT, asset));
    existsCache.set(asset, cached);
  }
  return cached;
};

// Reported by ASSET, not by route: the shared framework/runtime chunks are
// referenced by every route, and a route-specific chunk (like the one #19
// found) is often shared by several sibling routes too — grouping by route
// would repeat the same missing filename dozens of times over.
const GLOBAL_LABEL = "GLOBAL (bootstraps every route)";
const missingAssetRoutes = new Map<string, Set<string>>();
const recordIfMissing = (asset: string, route: string): void => {
  if (exists(asset)) return;
  const routes = missingAssetRoutes.get(asset) ?? new Set<string>();
  routes.add(route);
  missingAssetRoutes.set(asset, routes);
};

let totalAssets = globalAssets.size;
for (const a of globalAssets) recordIfMissing(a, GLOBAL_LABEL);

for (const [route, assets] of [...perRoute.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const routeOnly = [...assets].filter((a) => !globalAssets.has(a));
  totalAssets += routeOnly.length;
  for (const a of routeOnly) recordIfMissing(a, route);
}

console.log(
  `[build-chunks] checked ${perRoute.size} routes, ${totalAssets} unique asset references ` +
    `(${globalAssets.size} shared + route-specific), against ${relative(ROOT, CHECK_ROOT)}`,
);

if (missingAssetRoutes.size > 0) {
  console.error(
    `\n[build-chunks] FAILED — ${missingAssetRoutes.size} referenced asset(s) were never written to the tree the server serves:\n`,
  );
  const MAX_ROUTES_SHOWN = 8;
  for (const [asset, routes] of [...missingAssetRoutes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sortedRoutes = [...routes].sort();
    console.error(`  /_next/${asset}`);
    console.error(`    referenced by ${sortedRoutes.length} route(s):`);
    for (const r of sortedRoutes.slice(0, MAX_ROUTES_SHOWN)) console.error(`      ${r}`);
    if (sortedRoutes.length > MAX_ROUTES_SHOWN) {
      console.error(`      … and ${sortedRoutes.length - MAX_ROUTES_SHOWN} more`);
    }
  }
  console.error(
    "\nThe build's own manifest names these assets; the bundler did not write them (or the " +
      "standalone copy dropped them). See #19 in " +
      "docs/superpowers/specs/2026-08-16-registration-redesign-prompts/_INDEX.md.",
  );
  process.exit(1);
}

console.log("[build-chunks] OK — every referenced /_next/static/** asset exists.");
