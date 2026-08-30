"use client";
// S12/#421 W10 — the SINGLE registry both real entry points (the authed
// console, `fixture-console.tsx`, and the device-link pad,
// `device-score-pad.tsx`) consult to mount the v2 scoring pad, plus the
// `<ScorePad/>` mount itself.
//
// WHY THIS EXISTS, given S11 already shipped a skin registry
// (`skins/registry.ts`) that `PadRenderer` already consults BY DEFAULT: that
// registry names the sports with a hand-crafted v2 layout (NONE, as of
// 2026-08-31 — see its own header: the last four, cricket/tennis/football/
// period, retired that day, closing out what R5 started for racquet-skin.tsx)
// and returns `null` for anything else — "null" there means "no skin for
// this sport", which is a complete answer to PadRenderer's own question. It
// is NOT a written decision for the sports with no v2 story at all
// (generic/carrom/boardgame, never skinned; the other eight, no longer
// skinned — `NO_V2_SKIN_SPORTS` below), so a brand-new engine sport shipping
// with no skin AND no row here would silently fall through to "universal"
// with nobody having asserted that was the intended choice. `resolveScorePad`'s
// table below names every `builtinModules` key that still has a v2 story,
// explicitly — today that is zero keys, but the table stays live rather than
// collapsing to a constant: `v3/registry.ts`'s `LEGACY_SPORTS` is computed
// from `builtinModules` automatically, so a 12th engine sport that ships
// without a v3 conversion lands in the legacy lane and reaches THIS table
// with no other gate in front of it — "universal" here still needs to be a
// DECISION, not a fallthrough, for a sport that has not been born yet.
// `__tests__/registry.test.tsx` is the drift guard: a 12th sport with no row
// AND no `NO_V2_SKIN_SPORTS` entry fails CI, mutation-proved there.
import { useCallback, useMemo } from "react";
import type { EventEnvelope, Lineup, LineupPair, LineupSlot } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
import type { MemberIn, SideInfo, LineupSlotIn } from "@/components/v2/fixture-console";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { resolveModuleClient } from "./module-client";
import { deviceLinkTransport, sessionTransport, type PadAuthMode } from "./transport";
import type { OwnIdentity } from "./types";
import { PadRenderer } from "./pad-renderer";
import { skinFor } from "./skins/registry";
import type { SkinDef } from "./skins/types";
import { resolvePad } from "./v3/registry";
import type { TFn } from "./v3/context-strip";
import { PadHostV3 } from "./v3/pad-host";

// ---------------------------------------------------------------------------
// resolveScorePad — the written decision table
// ---------------------------------------------------------------------------

type ResolutionKind = "skin" | "universal";

/**
 * Sports with no v2 story left AT ALL — eight of them now, all for the same
 * reason: a shared or dedicated v2 skin file existed, converted fully to its
 * own v3 skin (`v3/registry.ts`'s `V3_SKINS`, unconditionally: no flag, no
 * fallback), and was then deleted as dead code once `ScorePad` below started
 * consulting `v3/registry.ts`'s `resolvePad` FIRST and returning before
 * `resolveScorePad`/this table was ever reached for that key.
 *
 * Volleyball, badminton and tabletennis went first (R5, 2026-08-27 —
 * skins/racquet-skin.tsx, setbased/kernel.ts's common action family, one
 * shared file for all three). Cricket, tennis, football, hockey and
 * icehockey went last (2026-08-31 — skins/cricket-skin.tsx, tennis-skin.tsx,
 * football-skin.tsx and period-skin.tsx, one file each/pair): each of those
 * five kept a real "skin" row for a while after its own v3 conversion landed,
 * specifically BECAUSE nothing else shared its v2 skin file, so nothing
 * forced the deletion question until this wave finally asked it for all five
 * at once (skins/registry.ts's own header has the full per-sport record).
 *
 * That deletion is WHY a converted sport cannot simply keep a "skin" row:
 * with its v2 skin file gone, `skinFor(key)` returns null for it, so a
 * "skin" row would make `resolveScorePad` throw its own "marked skin but
 * skins/registry.ts has no skin for it" guard below if this dead path were
 * ever somehow reached. Marking it "universal" instead would be a different
 * lie — misstating WHY (that label means "not enough match volume to earn
 * hand-crafted ergonomics", skins/registry.ts's own header; all eight of
 * these have plenty, just reached through a different lane entirely). So
 * they get no row at all: a written decision that the legacy v2 table has
 * nothing left to say about them, not a silent gap. `registry.test.tsx`'s
 * own assertion over this set proves both halves of that claim — absent
 * from this table, AND genuinely skin-less — rather than merely asserting
 * it.
 */
export const NO_V2_SKIN_SPORTS: ReadonlySet<string> = new Set([
  "volleyball",
  "badminton",
  "tabletennis",
  "cricket",
  "tennis",
  "football",
  "hockey",
  "icehockey",
]);

/**
 * Every `builtinModules` key WITH A V2 STORY, explicitly — see
 * `NO_V2_SKIN_SPORTS` just above for the eight that no longer have one. What
 * is left: generic/carrom/boardgame, all "universal" — a sport without the
 * match volume to earn a hand-crafted layout is better served by the
 * renderer proven across every module (skins/registry.ts's own header). No
 * row here is ever "skin" today (the type keeps that arm anyway — see this
 * file's own top-of-file note on why the table is not simplified away).
 * Exported for the drift guard (`registry.test.tsx`), which sweeps
 * `builtinModules` against this table (net of `NO_V2_SKIN_SPORTS`) in both
 * directions rather than hardcoding "3" or the key list a second time.
 */
export const RESOLUTION_KIND: Readonly<Record<string, ResolutionKind>> = {
  generic: "universal",
  carrom: "universal",
  boardgame: "universal",
};

export type ScorePadResolution = { kind: "skin"; skin: SkinDef } | { kind: "universal" };

/**
 * Resolve a sport key to its v2 pad shape. Never throws for an unknown key —
 * a sport with no row degrades to universal at RUNTIME (the safe default);
 * `registry.test.tsx` is what turns "no row" into a CI failure instead of a
 * silent fallthrough nobody notices.
 */
export function resolveScorePad(sportKey: string): ScorePadResolution {
  const kind = RESOLUTION_KIND[sportKey] ?? "universal";
  if (kind === "universal") return { kind: "universal" };
  const skin = skinFor(sportKey);
  // Structurally guaranteed by registry.test.tsx's assertion 3 (every "skin"
  // row agrees with skinFor in both directions, mutation-proved) — reachable
  // only if that guard itself has a bug, never from a normal call.
  if (!skin) {
    throw new Error(`resolveScorePad: "${sportKey}" is marked "skin" but skins/registry.ts has no skin for it`);
  }
  return { kind: "skin", skin };
}

// ---------------------------------------------------------------------------
// Server -> client shape builders both page loaders need. Collected here
// since this file is the one place both entry points already share.
// ---------------------------------------------------------------------------

/**
 * Structural, NOT `EventOut` (server/usecases/fixtures.ts) — this file ships
 * in the client bundle (module-client.test.ts's own "bundle purity" sweep
 * bans any `@/server/**` import from this directory), and both page loaders'
 * `listEvents` rows already satisfy this shape without a cast.
 */
// MOVED to ./wire (S12/#421). `WireEvent` and `eventOutToEnvelope` cannot
// live in this file: it is `"use client"`, and BOTH server page loaders call
// the mapper to build `initialEvents`. React refuses that at runtime, and
// `[].map(fn)` hid it until a fixture had its first event. See wire.ts's own
// header for the measurement. Deliberately NOT re-exported from here — a
// re-export through a `"use client"` module is still a client binding, so it
// would reintroduce exactly the crossing it looks like it fixes.

function toLineupSlot(s: LineupSlotIn, index: number): LineupSlot {
  return {
    personId: s.person_id,
    slot: s.slot,
    // DB order_no is nullable; fall back to this side's own append-order
    // index — the SAME fallback server/engine-db/lineups.ts's `buildLineup`
    // uses, so the client's optimistic fold never disagrees with the
    // server's fold over an unset order_no alone.
    orderNo: s.order_no ?? index + 1,
    ...(s.position_key ? { positionKey: s.position_key } : {}),
    ...(s.roles.length > 0 ? { roles: s.roles } : {}),
    // `role` (player/coach/staff, S3/#426 ruling) — S12/#421 pass B, Fix 2.
    // `readLineup`'s SQL (server/usecases/fixtures.ts) already selects the
    // real DB column into every row; the gap was purely `LineupSlotIn` never
    // declaring the field, so the client fold defaulted every slot to
    // "player" regardless of what was actually recorded. Verified end-to-end
    // (registry.test.tsx): this closes it for football's own scorer/assist
    // pool, which already filters by role via the kernel's `playingSquad`.
    // Cricket was NOT closed by this wire-shape fix alone and is now closed
    // separately: `orderFromLineup` (packages/engine/.../cricket.ts) built
    // `state.orders` off `lineup.slots` filtered only on
    // `slot === "starting"`, so a role:"coach" starting slot still opened the
    // batting even with `role` wired correctly here. Fixed in the same
    // session under owner ruling, with a regression test that puts the coach
    // at orderNo 1 and golden replay re-run at 133/133 with zero corpus files
    // dirty. Comment updated rather than left standing: a note that defers
    // work must be edited when the same session then does the work, or the
    // next reader re-diagnoses a closed gap (S11/#420 recorded this exact
    // cost).
    // Omitted for "player" itself, mirroring server/engine-db/lineups.ts's
    // own `buildLineup` convention — the engine's own `LineupSlot.role`
    // already defaults absent to "player" (core/lineup.ts), so this is a
    // wire-size choice, not a behaviour one.
    ...(s.role && s.role !== "player" ? { role: s.role } : {}),
    // `pairOrder` (doubles serve order, S3/#426's engine LineupSlot field) —
    // S12/#421 pass D, V361. Previously omitted deliberately: "no DB column
    // at all today ... carrying it through this function would be a dead,
    // always-undefined field" (this comment, pass B/C). The column, the
    // `readLineup`/`putLineup` write path and the editor's pair-order
    // control (rendered only for a pair-shaped entrant) all landed together
    // this pass, so the field is no longer dead — omitted only when
    // genuinely unset, the same "include only when meaningful" convention
    // `role`/`roles`/`positionKey` already use above.
    ...(s.pair_order != null ? { pairOrder: s.pair_order } : {}),
  };
}

function toLineup(side: SideInfo): Lineup {
  return { entrantId: side.id, slots: side.lineup.map(toLineupSlot) };
}

/**
 * `LineupPair` from the two sides' lineup slots + entrant ids — what
 * `SportModule.init`/`foldClient` need. Built identically for both entry
 * points since both hand `<ScorePad/>` the same `SideInfo` shape.
 */
export function lineupPairFrom(home: SideInfo, away: SideInfo): LineupPair {
  return { home: toLineup(home), away: toLineup(away) };
}

/**
 * personId -> display name, from both sides' rosters.
 * `PadRendererProps.personNames` has existed since S10/#419 and no caller
 * has ever passed it, so every person picker in the product has drawn a raw
 * UUID until this wave.
 */
export function personNamesFrom(home: SideInfo, away: SideInfo): Readonly<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const side of [home, away]) {
    for (const m of side.members as MemberIn[]) names[m.person_id] = m.full_name;
  }
  return names;
}

// ---------------------------------------------------------------------------
// <ScorePad/> — the single mount both dispatchers use
// ---------------------------------------------------------------------------

/**
 * Everything a server loader resolves ONCE for the pad, beyond what a
 * dispatcher already carries as an existing v1 prop (fixture id, sport key,
 * home/away). `auth` is deliberately NOT part of this bundle: it is
 * trivially known per dispatcher — `fixture-console.tsx` is always session,
 * `device-score-pad.tsx` is always device_link with the token it already
 * holds — never resolved server-side, so it stays a direct `<ScorePad/>`
 * prop instead.
 */
export interface ScorePadBootstrap {
  moduleVersion: string;
  /** Server-parsed variant cfg (`sportModule.configSchema.parse(...)`) —
   *  safe because `divisions.config`/the device-link fixture's `config` are
   *  already the resolved, schema-parsed cfg (S12/#421 decision log). */
  resolvedConfig: unknown;
  initialEvents: readonly EventEnvelope[];
  entitlements: Readonly<Record<string, boolean>>;
  band: FidelityBand;
  identity: OwnIdentity;
}

export interface ScorePadProps {
  fixtureId: string;
  sportKey: string;
  moduleVersion: string;
  resolvedConfig: unknown;
  home: SideInfo;
  away: SideInfo;
  initialEvents: readonly EventEnvelope[];
  /** Forwarded straight to `PadRenderer.onEvents` — see its docstring. The
   *  chrome around this pad (fixture console, device pad) keeps its own event
   *  list for "Undo last" and cannot otherwise see what the pad submitted. */
  onEvents?: (events: readonly EventEnvelope[]) => void;
  auth: PadAuthMode;
  /**
   * R7/C1 (D-4) — the chrome around this pad already mounts the one activity
   * ledger itself, so the pad must not mount a second. Passed by the fixture
   * console only; every other mount (the device pad) leaves it unset and the
   * pad keeps its own panel, which on `/score/[token]` is the ONLY history
   * there is. Honoured on BOTH lanes — v3's `showActivity`, and the legacy
   * lane's existing `timelineSlot` override — because the legacy lane serves
   * the sports this wave has not converted yet and it has the same panel.
   */
  hideActivity?: boolean;
  identity: OwnIdentity;
  entitlements: Readonly<Record<string, boolean>>;
  band: FidelityBand;
}

type ModuleResolution = { ok: true; module: AnySportModule } | { ok: false; message: string };

/**
 * The single mount both real entry points use (S13/#422: unconditionally —
 * the feature flag that used to gate this has been removed entirely).
 * Resolves the module client-side (module-client.ts — no server round
 * trip), builds the lineup/person data both loaders' `SideInfo` already
 * carries, and renders `PadRenderer` with an EXPLICIT skin decision from
 * `resolveScorePad` — never `PadRenderer`'s own default registry consult —
 * so this mount's rendering is always THIS file's decision and can never
 * silently drift from it (`registry.test.tsx` proves the two registries
 * agree; this still passes its own verdict down explicitly, both ways,
 * never `undefined`).
 */
export function ScorePad(props: ScorePadProps) {
  const msg = useMsg();
  // Widens useMsg()'s MessageKey-only param to the plain `string` a v3
  // skin FACTORY declares (v3/registry.ts's own header explains why
  // `V3_SKINS` holds factories, never already-built skins) — the SAME
  // adapter `pad-host.tsx` already builds for the chassis's own `t` prop,
  // duplicated here rather than threaded through as a shared export: this
  // is the "component that resolves the skin" cricket.tsx's header points
  // at, a different component from `PadHostV3` with its own `useMsg()`.
  const t: TFn = useCallback((key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars), [msg]);
  const resolution = useMemo((): ModuleResolution => {
    try {
      return { ok: true, module: resolveModuleClient(props.sportKey, props.moduleVersion) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, [props.sportKey, props.moduleVersion]);

  const lineups = useMemo(() => lineupPairFrom(props.home, props.away), [props.home, props.away]);
  const personNames = useMemo(() => personNamesFrom(props.home, props.away), [props.home, props.away]);
  const transport = useMemo(
    () => (props.auth.kind === "device_link" ? deviceLinkTransport(props.auth.token) : sessionTransport()),
    [props.auth],
  );

  if (!resolution.ok) {
    // Readable fallback rather than a blank page. The engine's own failure
    // text rides along as `reason` deliberately: a scorer courtside cannot
    // act on it, but the organiser they phone can, and it is the difference
    // between "the pad is broken" and "this division pins a module version
    // that no longer resolves".
    return (
      <div className="card p-4 text-sm text-red-700" role="alert">
        {msg("scorepad.v2.moduleUnavailable", { reason: resolution.message })}
      </div>
    );
  }

  // v3 lane consulted FIRST (R1 chassis, Task 2). `resolveModuleClient`
  // above already succeeded, which only happens for a key the engine's
  // registry actually has registered (i.e. a `builtinModules` key), so
  // `resolvePad` here is guaranteed a key `v3/registry.ts`'s `LEGACY_SPORTS`
  // (or, for cricket, `V3_SKINS`) owns and cannot throw on this path.
  //
  // R2/task B replaced what used to be a deliberate throw
  // (`"resolved to the v3 lane but no v3 renderer is wired yet"`) with the
  // REAL v3 branch, `PadHostV3` (./v3/pad-host.tsx) — R1 shipped six
  // chassis primitives with zero production import sites; this is that
  // import site. R2/task E is the first sport-by-sport flip: `V3_SKINS`
  // (v3/registry.ts) now owns "cricket", so `padLane.lane` is "v3" for
  // cricket specifically and still "legacy" for the other 10 — no
  // behavioural change for any of them, proved by
  // `__tests__/registry-totality.test.ts`'s own per-sport sweep. A later
  // wave activates the next sport by adding one entry to `V3_SKINS` (and
  // removing it from `LEGACY_SPORTS`), not by finding and replacing a
  // throw. `t` is the real, live translator built above — see
  // `v3/registry.ts`'s own header for why `resolvePad` needs one now.
  const padLane = resolvePad(props.sportKey, t);

  if (padLane.lane === "v3") {
    return (
      <PadHostV3
        module={resolution.module}
        cfg={props.resolvedConfig}
        fixtureId={props.fixtureId}
        lineups={lineups}
        identity={props.identity}
        transport={transport}
        band={props.band}
        entitlements={props.entitlements}
        initialEvents={props.initialEvents}
        onEvents={props.onEvents}
        queueDbName={`scorepad-${props.fixtureId}`}
        personNames={personNames}
        showActivity={!props.hideActivity}
        skin={padLane.skin}
      />
    );
  }

  const padResolution = resolveScorePad(props.sportKey);

  return (
    <PadRenderer
      module={resolution.module}
      cfg={props.resolvedConfig}
      fixtureId={props.fixtureId}
      lineups={lineups}
      identity={props.identity}
      transport={transport}
      band={props.band}
      entitlements={props.entitlements}
      initialEvents={props.initialEvents}
      onEvents={props.onEvents}
      // S13/#422: dropped the "-v2-" a pad/flag distinction used to need —
      // this is the only pad now, so the queue db is namespaced on the
      // fixture alone (still distinct from the harness's own
      // `scorepad-harness-${sportKey}` naming, harness-client.tsx).
      queueDbName={`scorepad-${props.fixtureId}`}
      personNames={personNames}
      // R7/C1 — the legacy lane's own history panel, suppressed through the
      // override `PadRenderer` already declares for exactly this (its
      // `timelineSlot` doc). Not a new seam and not a deletion: the sports
      // still on this lane keep their `Timeline` everywhere the chrome does
      // not supply one.
      timelineSlot={props.hideActivity ? () => null : undefined}
      skin={padResolution.kind === "universal" ? null : padResolution.skin}
    />
  );
}
