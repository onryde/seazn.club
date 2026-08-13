// Client-safe pinned-module resolver + in-browser fold. Mirrors
// apps/web/src/server/engine-db/registry.ts exactly EXCEPT it drops that
// file's server-only guard — this module ships in the browser bundle
// (the S10 dispatch's pinned fact: packages/engine has no root export, only
// subpaths, and the engine itself is import-pure — a CI gate on the engine
// package bans react/next/postgres/server-only inside it — so resolving a
// module and folding it client-side needs no server round trip).
//
// registry.get(key, version) has NO fallback (sport/registry.ts): an
// unpinned (sportKey, moduleVersion) throws EngineError("MODULE_NOT_FOUND")
// rather than silently resolving `latest`. That is load-bearing here, not
// incidental — a division pinned to an older module version must render
// THAT version's contract, never whatever shipped most recently.
import { EngineError, foldMatch } from "@seazn/engine/core";
import type { EventEnvelope, FoldableModule, FoldOptions, LineupPair } from "@seazn/engine/core";
import { registry, type AnySportModule } from "@seazn/engine/sport";
import { registerBuiltins } from "@seazn/engine/sports";

let booted = false;

function bootRegistry(): typeof registry {
  if (booted) return registry;
  try {
    registerBuiltins(registry);
  } catch (err) {
    // Tolerate builtins already registered by another boot path on this same
    // process-wide registry singleton (e.g. the server resolver booting
    // first in a shared module cache) — only MODULE_DUPLICATE is benign; any
    // other registry error is a real bug and must propagate.
    if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
  }
  booted = true;
  return registry;
}

/**
 * Resolve the PINNED (sportKey, moduleVersion) module for client-side use.
 * Throws a typed EngineError("MODULE_NOT_FOUND") for an unknown pin — never
 * falls back to the latest registered version of that sport.
 */
export function resolveModuleClient(sportKey: string, moduleVersion: string): AnySportModule {
  return bootRegistry().get(sportKey, moduleVersion);
}

/**
 * Run a module's own fold in the browser — a thin wrapper over
 * packages/engine/src/core/events.ts `foldMatch`, the ONLY state-derivation
 * function in the system. Pure; no fetch. Kept as a named export (rather
 * than telling callers to import foldMatch directly) so this file is the one
 * client-safe surface the rest of scorepad/ reads the engine through.
 */
export function foldClient<Cfg, State>(
  module: FoldableModule<Cfg, State>,
  cfg: Cfg,
  lineups: LineupPair,
  events: readonly EventEnvelope[],
  opts?: FoldOptions,
): State {
  return foldMatch(module, cfg, lineups, events, opts);
}
