// S12/#421 W10 — the server↔client wire mapping for the v2 pad's bootstrap.
//
// WHY THIS IS ITS OWN FILE, and not the two lines it looks like it should be:
// `eventOutToEnvelope` lived in `registry.tsx`, which is `"use client"`, while
// BOTH server page loaders call it to build `initialEvents`:
//
//     initialEvents: events.map((e) => eventOutToEnvelope(fixture.id, e))
//
// That is a client function invoked from a server component, and React refuses
// it at runtime:
//   "Attempted to call eventOutToEnvelope() from the server but
//    eventOutToEnvelope is on the client."
//
// It shipped because `[].map(fn)` NEVER INVOKES `fn`. A fixture with no events
// yet renders perfectly; the violation is unreachable until the ledger has its
// first row — i.e. one tap after the state any screenshot or first-load check
// would be taken in. Measured against the real flag-on console: the page
// rendered, "Start match" appended `core.start` to the real ledger, and the
// `router.refresh()` that followed rendered "Try again".
//
// Nothing cheap caught it, each verified rather than assumed: `tsc --noEmit`
// EXIT=0, 3251 unit tests green, `next build` green at 237/237 static pages,
// `apps/web` lint 0 errors. A module-boundary violation behind a `.map` is
// invisible to all of them, because they all run against the empty case.
//
// Keeping the mapper in a module with NO `"use client"` directive is the fix
// that cannot regress: this file is importable from both sides by
// construction, so neither loader can reintroduce the boundary crossing.
import type { EventEnvelope } from "@seazn/engine/core";

/**
 * The subset of the server's `EventOut` this mapping needs. Declared here
 * rather than imported from `@/server/**`: this module is reachable from the
 * client bundle, and `module-client.test.ts`'s bundle-purity sweep bans any
 * `@/server/**` import from this directory. Both page loaders' `listEvents`
 * rows already satisfy this shape without a cast.
 */
export interface WireEvent {
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: string;
  recorded_by: string | null;
  voids_event_id: string | null;
}

/**
 * `EventOut` (snake_case, server wire) -> `EventEnvelope` (camelCase, engine
 * core) — the one mapping both page loaders use to build `initialEvents` for
 * `<ScorePad/>`. Drops `device_link_id`: the engine's own envelope has no such
 * field (it is sport/auth-agnostic) — see use-pad-pipeline.ts's `ownEventIds`
 * for how the pad's timeline recovers per-event device-link ownership without
 * it.
 */
export function eventOutToEnvelope(fixtureId: string, e: WireEvent): EventEnvelope {
  return {
    id: e.id,
    fixtureId,
    seq: e.seq,
    type: e.type,
    payload: e.payload,
    recordedAt: e.recorded_at,
    recordedBy: e.recorded_by,
    ...(e.voids_event_id ? { voids: e.voids_event_id } : {}),
  };
}
