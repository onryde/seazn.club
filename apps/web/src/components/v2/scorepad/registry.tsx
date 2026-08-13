"use client";
// S12/#421 W10 — the SINGLE registry both real entry points (the authed
// console, `fixture-console.tsx`, and the device-link pad,
// `device-score-pad.tsx`) consult to mount the v2 scoring pad, plus the
// `<ScorePad/>` mount itself.
//
// WHY THIS EXISTS, given S11 already shipped a skin registry
// (`skins/registry.ts`) that `PadRenderer` already consults BY DEFAULT: that
// registry only names the 8 sports with a hand-crafted layout and returns
// `null` for anything else — "null" there means "no skin for this sport",
// which is a complete answer to PadRenderer's own question. It is NOT a
// written decision for the other 3 sports (generic/carrom/boardgame), so a
// brand-new engine sport shipping with no skin AND no row here would
// silently fall through to "universal" with nobody having asserted that was
// the intended choice. `resolveScorePad`'s table below names all 11
// `builtinModules` keys explicitly — "universal" is a DECISION, not a
// fallthrough — and `__tests__/registry.test.tsx` is the drift guard: a 12th
// sport with no row fails CI, mutation-proved there.
import { useMemo } from "react";
import type { EventEnvelope, Lineup, LineupPair, LineupSlot } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
import type { MemberIn, SideInfo, LineupSlotIn } from "@/components/v2/fixture-console";
import { resolveModuleClient } from "./module-client";
import { deviceLinkTransport, sessionTransport, type PadAuthMode } from "./transport";
import type { OwnIdentity } from "./types";
import { PadRenderer } from "./pad-renderer";
import { skinFor } from "./skins/registry";
import type { SkinDef } from "./skins/types";

// ---------------------------------------------------------------------------
// resolveScorePad — the written decision table
// ---------------------------------------------------------------------------

type ResolutionKind = "skin" | "universal";

/**
 * Every `builtinModules` key, explicitly. The 8 skinned sports (S11/#420)
 * name "skin"; generic/carrom/boardgame name "universal" — a sport without
 * the match volume to earn a hand-crafted layout is better served by the
 * renderer proven across every module (skins/registry.ts's own header).
 * Exported for the drift guard (`registry.test.tsx`), which sweeps
 * `builtinModules` against this table in both directions rather than
 * hardcoding "11" or the key list a second time.
 */
export const RESOLUTION_KIND: Readonly<Record<string, ResolutionKind>> = {
  cricket: "skin",
  tennis: "skin",
  volleyball: "skin",
  badminton: "skin",
  tabletennis: "skin",
  football: "skin",
  hockey: "skin",
  icehockey: "skin",
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
 * `<ScorePad/>`. Drops `device_link_id`: the engine's own envelope has no
 * such field (it is sport/auth-agnostic) — see use-pad-pipeline.ts's
 * `ownEventIds` for how the pad's timeline recovers per-event device-link
 * ownership without it.
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
    // NOTE: `role` (player/coach/staff, S3/#426 ruling) and `pairOrder` are
    // not part of `LineupSlotIn`'s wire shape (`getLineup`,
    // server/usecases/fixtures.ts) — a pre-existing gap in the v1 read path,
    // not introduced here and outside this session's file set (fixing it
    // touches server/usecases/fixtures.ts, which is not in scope). A
    // coach/staff slot folds client-side as the schema's own "absent ->
    // player" default until usePadPipeline's post-ack reconciliation adopts
    // the server's real fold, which does read the real DB column.
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
  auth: PadAuthMode;
  identity: OwnIdentity;
  entitlements: Readonly<Record<string, boolean>>;
  band: FidelityBand;
}

type ModuleResolution = { ok: true; module: AnySportModule } | { ok: false; message: string };

/**
 * The single mount both real entry points use behind the `scorepad-v2`
 * flag. Resolves the module client-side (module-client.ts — no server round
 * trip), builds the lineup/person data both loaders' `SideInfo` already
 * carries, and renders `PadRenderer` with an EXPLICIT skin decision from
 * `resolveScorePad` — never `PadRenderer`'s own default registry consult —
 * so this mount's rendering is always THIS file's decision and can never
 * silently drift from it (`registry.test.tsx` proves the two registries
 * agree; this still passes its own verdict down explicitly, both ways,
 * never `undefined`).
 */
export function ScorePad(props: ScorePadProps) {
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
    // Readable fallback rather than a blank page. Plain English, not a
    // dictionary key: this session is forbidden from touching a locale file
    // (five parallel agents cannot share four dictionaries, S11/#420's
    // ruling) — a "scorepad.v2.moduleUnavailable"-shaped key is owed and
    // reported back to the dispatching session rather than added here.
    return (
      <div className="card p-4 text-sm text-red-700" role="alert">
        Scoring is temporarily unavailable for this fixture ({resolution.message}).
      </div>
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
      queueDbName={`scorepad-v2-${props.fixtureId}`}
      personNames={personNames}
      skin={padResolution.kind === "universal" ? null : padResolution.skin}
    />
  );
}
